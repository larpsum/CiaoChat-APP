#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PyChat Ultimate Messenger - SERVER

  * Server TCP multithread, protocollo a righe JSON (una riga = un pacchetto, campo "t" = comando)
  * Persistenza su Firebase Realtime Database tramite firebase_admin:
        utenti, credenziali (solo hash PBKDF2 + salt), numeri di telefono, rubrica, messaggi
  * Registrazione con verifica OTP via SMS REALE (Twilio Verify): il codice lo genera, lo invia e lo controlla Twilio
  * Rubrica: aggiunta contatto per username esatto oppure per numero di telefono (E.164)
  * Messaggi diretti in tempo reale (testo e messaggi vocali), immagini profilo/banner
  * Chiamate audio e videochiamate 1-a-1: il server fa solo da segnalazione e inoltro

Comandi client -> server (campo "t"):
    register, login, resume, logout, add_contact, dm, history, profile,
    media_put, media_get, c_invite, c_accept, c_end, c_audio, c_video

Avvio:
    pip install firebase-admin
    python server.py
Serve il file serviceAccountKey.json (Console Firebase > Impostazioni progetto > Account di servizio).

SMS reali: imposta queste variabili d'ambiente prima di avviare il server (mai scriverle nel codice):
    TWILIO_ACCOUNT_SID          (Console Twilio > Account info)
    TWILIO_AUTH_TOKEN           (Console Twilio > Account info)
    TWILIO_VERIFY_SERVICE_SID   (Console Twilio > Verify > Services > Create new, inizia con "VA")
Opzionale: PYCHAT_SMS_PREFIXES="+39,+41" limita i paesi a cui inviare SMS (consigliato contro le frodi).
Tutti i dati vengono scritti sotto il nodo /pychat del database, senza toccare altri dati del progetto.
"""

import base64
import binascii
import hashlib
import hmac
import json
import os
import queue
import re
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    import firebase_admin
    from firebase_admin import credentials, db
except ImportError:
    sys.exit("Manca il pacchetto firebase-admin. Installalo con:  pip install firebase-admin")

# ============================================================== CONFIGURAZIONE
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_HOST = "0.0.0.0"
SERVER_PORT = 5555
SERVICE_ACCOUNT_FILE = os.environ.get("PYCHAT_SERVICE_ACCOUNT", os.path.join(BASE_DIR, "serviceAccountKey.json"))
FIREBASE_DB_URL = os.environ.get(
    "PYCHAT_DB_URL", "https://ciaochat2-5ddfd-default-rtdb.europe-west1.firebasedatabase.app")
DB_ROOT = "/pychat"                  # tutti i dati dell'app vivono sotto questo nodo
MEDIA_DIR = os.path.join(BASE_DIR, "media")

SMS_MODE = os.environ.get("PYCHAT_SMS_MODE", "simulation").strip().lower()   # "twilio_verify" (reale) | "simulation" (solo sviluppo)
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "").strip()
TWILIO_VERIFY_SID = os.environ.get("TWILIO_VERIFY_SERVICE_SID", "").strip()
TWILIO_VERIFY_URL = os.environ.get("TWILIO_VERIFY_URL", "https://verify.twilio.com/v2")
SMS_ALLOWED_PREFIXES = tuple(p.strip() for p in os.environ.get("PYCHAT_SMS_PREFIXES", "").split(",") if p.strip())
SMS_MAX_PER_IP_HOUR = 5              # SMS richiedibili da uno stesso IP in un'ora
SMS_MAX_PER_PHONE_10MIN = 3          # SMS richiedibili per uno stesso numero in 10 minuti
OTP_TTL_SECONDS = 600                # come la validita' predefinita dei codici Twilio Verify (10 minuti)
OTP_MAX_TRIES = 5
PBKDF2_ITERATIONS = 200_000
MAX_TOKENS_PER_USER = 5
HISTORY_LIMIT = 200
MAX_TEXT = 2000
MAX_LINE = 2_500_000                 # byte massimi per riga JSON (un vocale in base64 sta largamente dentro)
MAX_IMAGE = 600_000                  # byte per avatar / banner
MAX_VOICE = 1_100_000                # byte per messaggio vocale (WAV)
MEDIA_RETENTION_DAYS = 90            # i file non referenziati piu' vecchi di cosi' vengono cancellati all'avvio
CALL_RING_SECONDS = 45
FAIL_WINDOW_SECONDS = 600
FAIL_MAX_PER_IP = 10

USERNAME_RE = re.compile(r"^(?=.*[A-Za-z])[A-Za-z0-9]{3,20}$")   # alfanumerico, almeno una lettera
PHONE_RE = re.compile(r"^\+[1-9]\d{7,14}$")                       # E.164
HASH_RE = re.compile(r"^[0-9a-f]{64}$")

lock = threading.RLock()
online = {}          # chiave utente -> lista di Conn
calls = {}           # id chiamata -> stato
failures = {}        # ip -> lista di timestamp di tentativi falliti
sms_log = {}         # ("ip", ip) / ("phone", numero) -> timestamp degli SMS richiesti
gateway = None       # gateway SMS attivo (creato in main)


def now():
    return int(time.time())


def log(text):
    print(time.strftime("[%H:%M:%S] ") + text, flush=True)


# ============================================================== SMS
class SmsError(Exception):
    """Errore con un messaggio adatto a essere mostrato all'utente. fatal=True: il codice va richiesto di nuovo."""

    def __init__(self, text, fatal=False):
        super().__init__(text)
        self.fatal = fatal


class TwilioVerifyGateway:
    """SMS reali con Twilio Verify: Twilio genera il codice, lo spedisce e lo controlla
    (scadenza, numero di tentativi e protezione antifrode inclusi). Il server non conosce mai il codice."""

    # codici di errore Twilio -> messaggio per l'utente
    SEND_ERRORS = {
        60200: "Numero di telefono non valido.",
        60203: "Troppi SMS inviati a questo numero. Riprova piu' tardi.",
        60205: "Questo numero non puo' ricevere SMS (ad esempio e' una linea fissa).",
        60410: "Numero bloccato dalla protezione antifrode di Twilio.",
        21608: "Account Twilio di prova: gli SMS arrivano solo ai numeri verificati nella console Twilio.",
        21211: "Numero di telefono non valido.",
    }

    def __init__(self, sid, token, service):
        self.sid, self.token, self.service = sid, token, service
        self.auth = "Basic " + base64.b64encode(f"{sid}:{token}".encode()).decode()

    def _post(self, path, fields):
        req = urllib.request.Request(f"{TWILIO_VERIFY_URL}/Services/{self.service}/{path}",
                                     data=urllib.parse.urlencode(fields).encode(), method="POST")
        req.add_header("Authorization", self.auth)
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode("utf-8") or "{}")
            except ValueError:
                return e.code, {}
        except (urllib.error.URLError, OSError, ValueError) as e:
            log(f"Twilio non raggiungibile: {e!r}")
            raise SmsError("Servizio SMS non raggiungibile. Riprova tra poco.")

    def start(self, phone):
        """Chiede a Twilio di inviare l'SMS. Non restituisce mai il codice."""
        status, body = self._post("Verifications", {"To": phone, "Channel": "sms"})
        if status in (200, 201):
            log(f"SMS di verifica inviato a {phone}")
            return None
        log(f"Twilio ha rifiutato l'invio a {phone}: HTTP {status} {body}")
        if status in (401, 403):
            raise SmsError("Servizio SMS non configurato correttamente. Contatta l'amministratore.")
        if status == 429:
            raise SmsError("Troppe richieste. Riprova tra qualche minuto.")
        raise SmsError(self.SEND_ERRORS.get(body.get("code"), "Impossibile inviare l'SMS. Riprova piu' tardi."))

    def check(self, phone, code):
        """True se Twilio approva il codice, False se e' sbagliato."""
        status, body = self._post("VerificationCheck", {"To": phone, "Code": code})
        if status == 200:
            return body.get("status") == "approved"
        log(f"Twilio VerificationCheck per {phone}: HTTP {status} {body}")
        if status == 404:
            raise SmsError("Il codice e' scaduto o gia' usato. Richiedine uno nuovo.", fatal=True)
        if status == 429:
            raise SmsError("Troppi tentativi errati. Richiedi un nuovo codice.", fatal=True)
        raise SmsError("Verifica non riuscita. Riprova.")


class SimulatedGateway:
    """Solo per sviluppo (PYCHAT_SMS_MODE=simulation): NESSUN SMS viene inviato e il codice viene
    restituito al client. Non verifica il telefono: non usarlo in produzione."""

    def __init__(self):
        self.codes = {}

    def start(self, phone):
        code = f"{secrets.randbelow(10 ** 6):06d}"
        self.codes[phone] = code
        log(f"[SMS simulato] a {phone}: codice {code}")
        return code

    def check(self, phone, code):
        expected = self.codes.get(phone)
        return expected is not None and hmac.compare_digest(expected, code)


def build_gateway():
    if SMS_MODE == "simulation":
        log("ATTENZIONE: modalita' SMS SIMULATO - nessun SMS reale, il codice viene mostrato al client.")
        return SimulatedGateway()
    if SMS_MODE != "twilio_verify":
        sys.exit(f"PYCHAT_SMS_MODE '{SMS_MODE}' non riconosciuto. Valori ammessi: twilio_verify, simulation.")
    missing = [n for n, v in (("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID), ("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN),
                              ("TWILIO_VERIFY_SERVICE_SID", TWILIO_VERIFY_SID)) if not v]
    if missing:
        sys.exit("Per inviare SMS reali mancano queste variabili d'ambiente: " + ", ".join(missing) + "\n"
                 "  1. Crea un account su twilio.com e copia Account SID e Auth Token dalla console.\n"
                 "  2. Console > Verify > Services > Create new service, poi copia il Service SID (inizia con VA).\n"
                 "  3. Impostale prima di avviare il server, ad esempio in PowerShell:\n"
                 "       $env:TWILIO_ACCOUNT_SID='AC...'; $env:TWILIO_AUTH_TOKEN='...'; $env:TWILIO_VERIFY_SERVICE_SID='VA...'\n"
                 "     (oppure, su Linux/macOS: export TWILIO_ACCOUNT_SID=AC... ecc.)")
    log("SMS reali attivi tramite Twilio Verify." + (f" Prefissi ammessi: {', '.join(SMS_ALLOWED_PREFIXES)}." if SMS_ALLOWED_PREFIXES else ""))
    return TwilioVerifyGateway(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID)


def sms_send_allowed(ip, phone):
    """Limita gli SMS richiedibili per IP e per numero: ogni SMS costa e puo' essere sfruttato dai bot."""
    t = time.time()
    with lock:
        ip_hist = [x for x in sms_log.get(("ip", ip), []) if x > t - 3600]
        ph_hist = [x for x in sms_log.get(("phone", phone), []) if x > t - 600]
        if len(ip_hist) >= SMS_MAX_PER_IP_HOUR or len(ph_hist) >= SMS_MAX_PER_PHONE_10MIN:
            return False
        sms_log[("ip", ip)] = ip_hist + [t]
        sms_log[("phone", phone)] = ph_hist + [t]
        if len(sms_log) > 5000:                               # pulizia delle chiavi ormai vecchie
            for k in [k for k, v in sms_log.items() if not v or v[-1] < t - 3600]:
                del sms_log[k]
        return True


# ============================================================== Firebase
def firebase_ref(path):
    return db.reference(f"{DB_ROOT}/{path}")


def fb_get(path):
    return firebase_ref(path).get()


def fb_set(path, value):
    firebase_ref(path).set(value)


def fb_update(path, values):
    firebase_ref(path).update(values)


def fb_delete(path):
    firebase_ref(path).delete()


def fb_claim(path, value):
    """Riserva atomicamente un nodo: True se il nodo era libero ed ora contiene `value`."""
    def update(current):
        return value if current is None else current
    return firebase_ref(path).transaction(update) == value


def fb_last(path, limit):
    """Ultimi `limit` figli del nodo, ordinati per chiave (le chiavi push sono cronologiche)."""
    data = firebase_ref(path).order_by_key().limit_to_last(limit).get()
    if not data:
        return []
    if isinstance(data, list):
        data = {str(i): v for i, v in enumerate(data) if v is not None}
    return [(k, data[k]) for k in sorted(data)]


def init_firebase():
    if not os.path.exists(SERVICE_ACCOUNT_FILE):
        sys.exit(f"File credenziali non trovato: {SERVICE_ACCOUNT_FILE}\n"
                 "Scaricalo da Console Firebase > Impostazioni progetto > Account di servizio > "
                 "Genera nuova chiave privata, poi salvalo come serviceAccountKey.json accanto a server.py.")
    cred = credentials.Certificate(SERVICE_ACCOUNT_FILE)
    firebase_admin.initialize_app(cred, {"databaseURL": FIREBASE_DB_URL})
    fb_get("users")  # prova di connessione: fallisce subito se URL o permessi sono sbagliati
    log(f"Firebase connesso: {FIREBASE_DB_URL}{DB_ROOT}")


# ============================================================== sicurezza
def hash_password(password, salt_hex):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex),
                               PBKDF2_ITERATIONS).hex()


def token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_phone(raw):
    cleaned = re.sub(r"[\s\-().]", "", str(raw or ""))
    return cleaned if PHONE_RE.match(cleaned) else None


def phone_key(phone):
    return phone[1:]


def pair_key(a, b):
    return "_".join(sorted((a, b)))


def too_many_failures(ip):
    cutoff = time.time() - FAIL_WINDOW_SECONDS
    with lock:
        recent = [t for t in failures.get(ip, []) if t > cutoff]
        failures[ip] = recent
        return len(recent) >= FAIL_MAX_PER_IP


def record_failure(ip):
    with lock:
        failures.setdefault(ip, []).append(time.time())


# ============================================================== connessioni
class Conn:
    """Una connessione client. Le scritture passano da una coda e da un thread dedicato,
    cosi' un client lento non blocca gli altri; i frame audio/video si possono scartare."""

    def __init__(self, sock, addr):
        self.sock = sock
        self.ip = addr[0]
        self.user = None            # chiave utente (username in minuscolo) dopo l'accesso
        self.name = ""
        self.pending = None         # registrazione in attesa di OTP
        self.alive = True
        self.outq = queue.Queue()
        threading.Thread(target=self._writer, daemon=True).start()

    def send(self, obj, droppable=False):
        if not self.alive:
            return
        if droppable and self.outq.qsize() > 12:
            return
        self.outq.put((json.dumps(obj) + "\n").encode("utf-8"))

    def _writer(self):
        while True:
            data = self.outq.get()
            if data is None:
                return
            try:
                self.sock.sendall(data)
            except OSError:
                self.alive = False
                return

    def close(self):
        self.alive = False
        self.outq.put(None)
        try:
            self.sock.close()
        except OSError:
            pass


def send_to(user, obj, droppable=False):
    with lock:
        conns = list(online.get(user, []))
    for c in conns:
        c.send(obj, droppable)


def broadcast(obj):
    with lock:
        conns = [c for lst in online.values() for c in lst]
    for c in conns:
        c.send(obj)


# ============================================================== profili e rubrica
def public_profile(key):
    rec = fb_get(f"users/{key}")
    if not isinstance(rec, dict):
        return None
    return {"id": key, "name": rec.get("username", key), "avatar": rec.get("avatar"),
            "banner": rec.get("banner"), "online": key in online}


def contacts_of(key):
    raw = fb_get(f"contacts/{key}") or {}
    if isinstance(raw, list):
        raw = {str(i): v for i, v in enumerate(raw) if v}
    result = []
    for ckey in sorted(raw):
        prof = public_profile(ckey)
        if prof:
            result.append(prof)
    return result


def add_contact_link(owner, contact):
    fb_set(f"contacts/{owner}/{contact}", now())


# ============================================================== autenticazione
def finish_login(conn, key, rec, token):
    conn.user, conn.name = key, rec["username"]
    with lock:
        first = key not in online
        online.setdefault(key, []).append(conn)
    conn.send({"t": "ok", "id": key, "user": rec["username"], "phone": rec.get("phone"), "token": token,
               "avatar": rec.get("avatar"), "banner": rec.get("banner"), "contacts": contacts_of(key)})
    log(f"{rec['username']} connesso da {conn.ip}")
    if first:
        broadcast({"t": "status", "id": key, "online": True})


def issue_token(key):
    token = secrets.token_hex(24)
    fb_set(f"users/{key}/tokens/{token_hash(token)}", now())
    tokens = fb_get(f"users/{key}/tokens") or {}
    if len(tokens) > MAX_TOKENS_PER_USER:
        for old in sorted(tokens, key=lambda k: tokens[k])[:len(tokens) - MAX_TOKENS_PER_USER]:
            fb_delete(f"users/{key}/tokens/{old}")
    return token


def handle_register(conn, m):
    username = str(m.get("user", "")).strip()
    phone = normalize_phone(m.get("phone"))
    password = str(m.get("pw", ""))
    otp = str(m.get("otp", "")).strip()

    def err(text):
        conn.send({"t": "err", "text": text})

    if too_many_failures(conn.ip):
        return err("Troppi tentativi. Riprova tra qualche minuto.")
    if not USERNAME_RE.match(username):
        return err("Username non valido: 3-20 caratteri alfanumerici, con almeno una lettera.")
    if phone is None:
        return err("Numero di telefono non valido. Usa il formato internazionale, es. +393331234567.")
    if not 8 <= len(password) <= 128:
        return err("La password deve avere almeno 8 caratteri.")
    key = username.lower()
    if fb_get(f"usernames/{key}") is not None:
        return err("Questo username e' gia' in uso.")
    if fb_get(f"phones/{phone_key(phone)}") is not None:
        return err("Questo numero di telefono e' gia' registrato.")

    if not otp:                                    # fase 1: invio dell'SMS con il codice
        if SMS_ALLOWED_PREFIXES and not phone.startswith(SMS_ALLOWED_PREFIXES):
            return err("Per ora sono supportati solo numeri con prefisso: " + ", ".join(SMS_ALLOWED_PREFIXES) + ".")
        if not sms_send_allowed(conn.ip, phone):
            return err("Hai richiesto troppi codici. Riprova tra qualche minuto.")
        try:
            revealed = gateway.start(phone)        # None con SMS reali: il codice non passa dal server
        except SmsError as e:
            return err(str(e))
        conn.pending = {"user": key, "phone": phone, "exp": time.time() + OTP_TTL_SECONDS, "tries": 0}
        conn.send({"t": "otp_required", "phone": phone, "ttl": OTP_TTL_SECONDS, "sim_code": revealed})
        return

    pend = conn.pending                            # fase 2: verifica del codice e creazione account
    if not pend or pend["user"] != key or pend["phone"] != phone:
        return err("Richiedi prima un nuovo codice di verifica.")
    if time.time() > pend["exp"]:
        conn.pending = None
        return err("Il codice e' scaduto. Richiedine uno nuovo.")
    if pend["tries"] >= OTP_MAX_TRIES:
        conn.pending = None
        return err("Troppi tentativi errati. Richiedi un nuovo codice.")
    try:
        approved = gateway.check(phone, otp)       # il controllo lo fa Twilio
    except SmsError as e:
        if e.fatal:
            conn.pending = None
        return err(str(e))
    if not approved:
        pend["tries"] += 1
        record_failure(conn.ip)
        return err("Codice non corretto.")

    if not fb_claim(f"usernames/{key}", key):      # prenotazione atomica di username e telefono
        return err("Questo username e' gia' in uso.")
    if not fb_claim(f"phones/{phone_key(phone)}", key):
        fb_delete(f"usernames/{key}")
        return err("Questo numero di telefono e' gia' registrato.")
    salt = secrets.token_hex(16)
    rec = {"username": username, "phone": phone, "salt": salt, "hash": hash_password(password, salt),
           "created": now()}
    fb_set(f"users/{key}", rec)
    conn.pending = None
    log(f"Nuovo utente registrato: {username} ({phone})")
    finish_login(conn, key, rec, issue_token(key))


def handle_login(conn, m):
    key = str(m.get("user", "")).strip().lower()
    password = str(m.get("pw", ""))
    if too_many_failures(conn.ip):
        return conn.send({"t": "err", "text": "Troppi tentativi. Riprova tra qualche minuto."})
    rec = fb_get(f"users/{key}") if USERNAME_RE.match(key) else None
    # l'hash viene calcolato anche per utenti inesistenti: tempi di risposta uguali
    computed = hash_password(password, rec["salt"] if isinstance(rec, dict) else "00" * 16)
    if not isinstance(rec, dict) or not hmac.compare_digest(computed, rec.get("hash", "")):
        record_failure(conn.ip)
        time.sleep(0.5)
        return conn.send({"t": "err", "text": "Username o password errati."})
    finish_login(conn, key, rec, issue_token(key))


def handle_resume(conn, m):
    key = str(m.get("user", "")).strip().lower()
    token = str(m.get("token", ""))
    if too_many_failures(conn.ip):
        return conn.send({"t": "err", "text": "Troppi tentativi. Riprova tra qualche minuto."})
    rec = fb_get(f"users/{key}") if USERNAME_RE.match(key) else None
    tokens = rec.get("tokens", {}) if isinstance(rec, dict) else {}
    if not token or token_hash(token) not in tokens:
        record_failure(conn.ip)
        return conn.send({"t": "err", "text": "Sessione scaduta: accedi di nuovo."})
    finish_login(conn, key, rec, token)


def handle_logout(conn, m):
    token = str(m.get("token", ""))
    if conn.user and token:
        fb_delete(f"users/{conn.user}/tokens/{token_hash(token)}")


# ============================================================== rubrica, messaggi, profili
def handle_add_contact(conn, m):
    query = str(m.get("query", "")).strip()
    if not query:
        return conn.send({"t": "err", "text": "Inserisci uno username o un numero di telefono."})
    digits_only = re.sub(r"[\s\-().+]", "", query).isdigit()
    if query.startswith("+") or digits_only:
        phone = normalize_phone(query if query.startswith("+") else "+" + query)
        if phone is None:
            return conn.send({"t": "err", "text": "Numero non valido. Usa il formato internazionale, es. +393331234567."})
        target = fb_get(f"phones/{phone_key(phone)}")
    else:
        key = query.lstrip("@").lower()
        target = key if USERNAME_RE.match(key) and fb_get(f"usernames/{key}") is not None else None
    if not target:
        return conn.send({"t": "err", "text": "Nessun utente trovato con questi dati."})
    if target == conn.user:
        return conn.send({"t": "err", "text": "Non puoi aggiungere te stesso."})
    add_contact_link(conn.user, target)
    conn.send({"t": "contact_added", "contact": public_profile(target)})


def store_message(frm, to, text, voice=None):
    """Salva un messaggio su Firebase e lo recapita a tutti i dispositivi dei due utenti."""
    msg = {"from": frm, "to": to, "text": text, "ts": now()}
    if voice:
        msg["voice"] = voice
    pushed = firebase_ref(f"messages/{pair_key(frm, to)}").push(msg)
    out = dict(msg, t="dm", id=pushed.key)
    send_to(frm, out)
    if to != frm:
        if fb_get(f"contacts/{to}/{frm}") is None:          # il mittente entra nella rubrica del destinatario
            add_contact_link(to, frm)
            send_to(to, {"t": "contact_added", "contact": public_profile(frm)})
        send_to(to, out)
    return out


def clean_voice(v):
    if not isinstance(v, dict):
        return None
    h, dur = v.get("hash"), v.get("dur")
    if (not isinstance(h, str) or not HASH_RE.match(h) or not os.path.exists(media_path(h))
            or isinstance(dur, bool) or not isinstance(dur, (int, float))):
        return None
    return {"hash": h, "dur": round(max(0.0, min(float(dur), 60.0)), 1)}


def handle_dm(conn, m):
    to = str(m.get("to", "")).strip().lower()
    text = str(m.get("text", "")).strip()[:MAX_TEXT]
    voice = clean_voice(m.get("voice"))
    if voice and not text:
        text = "\U0001F3A4 Messaggio vocale"
    if not text or to == conn.user or fb_get(f"usernames/{to}") is None:
        return
    store_message(conn.user, to, text, voice)


def handle_history(conn, m):
    other = str(m.get("with", "")).strip().lower()
    if not USERNAME_RE.match(other):
        return
    msgs = []
    for k, v in fb_last(f"messages/{pair_key(conn.user, other)}", HISTORY_LIMIT):
        if isinstance(v, dict):
            msgs.append(dict(v, id=k))
    conn.send({"t": "history", "with": other, "msgs": msgs})


def handle_profile(conn, m):
    key = str(m.get("user", "")).strip().lower()
    prof = public_profile(key) if USERNAME_RE.match(key) else None
    if not prof:
        return conn.send({"t": "err", "text": "Profilo non trovato."})
    if key == conn.user:
        prof["phone"] = (fb_get(f"users/{key}/phone") or "")      # il numero lo vede solo il proprietario
    conn.send({"t": "profile", "profile": prof})


# ============================================================== file multimediali
def media_path(h):
    return os.path.join(MEDIA_DIR, h + ".bin")


def looks_like_image(data):
    return data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n"


def looks_like_wav(data):
    return data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def store_media(data):
    os.makedirs(MEDIA_DIR, exist_ok=True)
    h = hashlib.sha256(data).hexdigest()
    path = media_path(h)
    if not os.path.exists(path):
        with open(path + ".tmp", "wb") as f:
            f.write(data)
        os.replace(path + ".tmp", path)
    else:
        os.utime(path)
    return h


def cleanup_media():
    """All'avvio elimina i file vecchi che non sono ne' un avatar ne' un banner in uso."""
    if not os.path.isdir(MEDIA_DIR):
        return
    users = fb_get("users") or {}
    keep = set()
    for rec in users.values():
        if isinstance(rec, dict):
            keep.update(x for x in (rec.get("avatar"), rec.get("banner")) if x)
    limit = time.time() - MEDIA_RETENTION_DAYS * 86400
    for fn in os.listdir(MEDIA_DIR):
        path = os.path.join(MEDIA_DIR, fn)
        try:
            if fn.endswith(".bin") and fn[:-4] not in keep and os.path.getmtime(path) < limit:
                os.remove(path)
        except OSError:
            pass


def handle_media(conn, m):
    t = m["t"]
    if t == "media_get":
        h = str(m.get("hash", ""))
        if not HASH_RE.match(h) or not os.path.exists(media_path(h)):
            return
        try:
            with open(media_path(h), "rb") as f:
                data = f.read()
        except OSError:
            return
        return conn.send({"t": "media", "hash": h, "data": base64.b64encode(data).decode("ascii")})

    kind = m.get("kind")
    if kind not in ("avatar", "banner", "voice"):
        return conn.send({"t": "err", "text": "Tipo di file non supportato."})
    try:
        data = base64.b64decode(str(m.get("data", "")), validate=True)
    except (binascii.Error, ValueError):
        return conn.send({"t": "err", "text": "File non leggibile."})
    if kind == "voice":
        valid = bool(data) and len(data) <= MAX_VOICE and looks_like_wav(data)
    else:
        valid = bool(data) and len(data) <= MAX_IMAGE and looks_like_image(data)
    if not valid:
        return conn.send({"t": "err", "text": "File rifiutato: formato o dimensione non validi."})
    h = store_media(data)
    if kind in ("avatar", "banner"):
        fb_update(f"users/{conn.user}", {kind: h})
        conn.send({"t": "media_ok", "kind": kind, "hash": h})
        broadcast({"t": "profile_update", "id": conn.user, "avatar": fb_get(f"users/{conn.user}/avatar"),
                   "banner": fb_get(f"users/{conn.user}/banner")})
    else:
        conn.send({"t": "media_ok", "kind": kind, "hash": h})


def handle_clear_media(conn, m):
    kind = m.get("kind")
    if kind in ("avatar", "banner"):
        fb_delete(f"users/{conn.user}/{kind}")
        broadcast({"t": "profile_update", "id": conn.user, "avatar": fb_get(f"users/{conn.user}/avatar"),
                   "banner": fb_get(f"users/{conn.user}/banner")})


# ============================================================== chiamate (segnalazione + inoltro)
def user_busy(user):
    with lock:
        return any(user in (c["caller_user"], c["callee_user"]) for c in calls.values())


def end_call(cid, reason, only_if_ringing=False):
    with lock:
        c = calls.get(cid)
        if not c or (only_if_ringing and c["state"] != "ringing"):
            return
        del calls[cid]
    msg = {"t": "c_ended", "call": cid, "reason": reason}
    c["caller"].send(msg)
    if c["callee"]:
        c["callee"].send(msg)
    for o in list(online.get(c["callee_user"], [])):         # smette di squillare sugli altri dispositivi
        if o is not c["callee"]:
            o.send(msg)
    label = "Videochiamata" if c["video"] else "Chiamata vocale"
    if c["t0"]:
        secs = int(time.time() - c["t0"])
        text = f"\U0001F4DE {label} \u00b7 {secs // 60}:{secs % 60:02d}"
    elif reason == "declined":
        text = f"\U0001F4DE {label} rifiutata"
    else:
        text = f"\U0001F4DE {label} persa"
    try:
        store_message(c["caller_user"], c["callee_user"], text)
    except Exception as e:                                   # il registro chiamate non deve mai rompere la chiusura
        log(f"Impossibile salvare il registro chiamata: {e}")


def handle_call(conn, m):
    t, me = m["t"], conn.user

    def err(text):
        conn.send({"t": "err", "text": text})

    if t == "c_invite":
        to = str(m.get("to", "")).strip().lower()
        if to == me or not USERNAME_RE.match(to) or fb_get(f"usernames/{to}") is None:
            return err("Non puoi chiamare questo utente.")
        if user_busy(me):
            return err("Sei gia' in una chiamata.")
        if to not in online:
            return err("L'utente e' offline.")
        if user_busy(to):
            return err("L'utente e' occupato in un'altra chiamata.")
        cid = secrets.token_hex(6)
        video = bool(m.get("video"))
        with lock:
            calls[cid] = {"caller": conn, "callee": None, "caller_user": me, "callee_user": to,
                          "state": "ringing", "t0": None, "video": video}
        conn.send({"t": "c_ringing", "call": cid, "to": to, "video": video})
        send_to(to, {"t": "c_incoming", "call": cid, "from": me, "video": video})
        timer = threading.Timer(CALL_RING_SECONDS, end_call, args=(cid, "no_answer", True))
        timer.daemon = True
        timer.start()
        return

    c = calls.get(str(m.get("call", "")))
    if not c:
        return
    cid = str(m.get("call"))
    if t == "c_accept":
        if c["state"] != "ringing" or me != c["callee_user"]:
            return
        with lock:
            c["callee"], c["state"], c["t0"] = conn, "active", time.time()
        c["caller"].send({"t": "c_accepted", "call": cid})
        for o in list(online.get(me, [])):
            if o is not conn:
                o.send({"t": "c_taken", "call": cid})
    elif t == "c_end":
        if conn is c["caller"]:
            reason = "cancelled" if c["state"] == "ringing" else "ended"
        elif me == c["callee_user"] and (c["state"] == "ringing" or conn is c["callee"]):
            reason = "declined" if c["state"] == "ringing" else "ended"
        else:
            return
        end_call(cid, reason)
    elif t in ("c_audio", "c_video"):
        d = m.get("d")
        limit = 8000 if t == "c_audio" else 600_000
        if c["state"] != "active" or not isinstance(d, str) or len(d) > limit:
            return
        other = c["callee"] if conn is c["caller"] else c["caller"] if conn is c["callee"] else None
        if other:
            other.send({"t": t, "call": cid, "d": d}, droppable=True)


# ============================================================== ciclo di vita della connessione
def serve(conn):
    try:
        f = conn.sock.makefile("r", encoding="utf-8")
        for line in iter(lambda: f.readline(MAX_LINE), ""):
            try:
                m = json.loads(line)
            except ValueError:
                continue
            t = m.get("t") if isinstance(m, dict) else None
            if not isinstance(t, str):
                continue
            try:
                dispatch(conn, m, t)
            except Exception as e:                            # un errore su un comando non deve abbattere la connessione
                log(f"Errore nel comando '{t}' ({conn.name or conn.ip}): {e!r}")
                conn.send({"t": "err", "text": "Errore interno del server. Riprova."})
    except (OSError, ValueError):
        pass
    finally:
        disconnect(conn)


def dispatch(conn, m, t):
    if not conn.user:
        if t == "register":
            handle_register(conn, m)
        elif t == "login":
            handle_login(conn, m)
        elif t == "resume":
            handle_resume(conn, m)
        else:
            conn.send({"t": "err", "text": "Effettua prima l'accesso."})
    elif t == "add_contact":
        handle_add_contact(conn, m)
    elif t == "dm":
        handle_dm(conn, m)
    elif t == "history":
        handle_history(conn, m)
    elif t == "profile":
        handle_profile(conn, m)
    elif t in ("media_put", "media_get"):
        handle_media(conn, m)
    elif t == "media_clear":
        handle_clear_media(conn, m)
    elif t.startswith("c_"):
        handle_call(conn, m)
    elif t == "logout":
        handle_logout(conn, m)


def disconnect(conn):
    for cid, c in list(calls.items()):                        # chiude le chiamate in cui era coinvolta
        if c["caller"] is conn or c["callee"] is conn:
            end_call(cid, "dropped")
    went_offline = False
    if conn.user:
        with lock:
            lst = online.get(conn.user, [])
            if conn in lst:
                lst.remove(conn)
            if not lst:
                online.pop(conn.user, None)
                went_offline = True
        log(f"{conn.name} disconnesso")
    conn.close()
    if went_offline:
        broadcast({"t": "status", "id": conn.user, "online": False})


def main():
    global gateway
    gateway = build_gateway()
    init_firebase()
    cleanup_media()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((SERVER_HOST, SERVER_PORT))
    srv.listen()
    log(f"Server in ascolto sulla porta {SERVER_PORT}. Ctrl+C per fermarlo.")
    try:
        while True:
            sock, addr = srv.accept()
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            threading.Thread(target=serve, args=(Conn(sock, addr),), daemon=True).start()
    except KeyboardInterrupt:
        log("Arresto del server.")
    finally:
        srv.close()


if __name__ == "__main__":
    main()