#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PyChat Ultimate Messenger - SERVER

  * Server TCP multithread, protocollo a righe JSON (una riga = un pacchetto, campo "t" = comando)
  * Persistenza su Firebase Realtime Database tramite firebase_admin:
        utenti, credenziali (solo hash PBKDF2 + salt), numeri di telefono, rubrica, messaggi
  * Registrazione con OTP simulato: il codice viene mostrato al client, non viene inviato via SMS
  * Rubrica: aggiunta contatto per username esatto oppure per numero di telefono (E.164)
  * Messaggi diretti in tempo reale (testo e messaggi vocali), immagini profilo/banner
  * Chiamate audio e videochiamate 1-a-1: il server fa solo da segnalazione e inoltro

Comandi client -> server (campo "t"):
    register, login, resume, logout, add_contact, dm, history, profile,
    media_put, media_get, c_invite, c_accept, c_end, c_audio, c_video,
    msg_edit, msg_delete, msg_react, msg_pin, typing, msg_read, msg_search, msg_get, link_preview,
    e2ee_pub, admin, community_*, bookmark_*, msg_schedule, msg_expire, msg_vote,
    status_post, status_delete, status_list, badge_update, relationship_update, block_update

Crittografia end-to-end (DM di testo):
    I messaggi DM di testo possono portare il campo "enc" con payload cifrato
    "e1.<iv>.<ct>" (AES-256-GCM, chiave derivata da ECDH P-256 tra le chiavi
    pubbliche degli utenti, pubblicate in profilo come "e2.<pubkey>"). Il server
    tratta "enc" come dato opaco: lo memorizza e lo inoltra senza decifrarlo.
    Non copre: canali community, sondaggi, allegati, messaggi vocali e metadati.

Amministrazione:
    Imposta PYCHAT_ADMIN_TOKEN e invia {"t":"admin","key":<token>,"action":...}.
    Azioni: stats, user (con "user":<username>), logout (force-disconnect),
    broadcast (con "text"). Vedi admin.py per un client a riga di comando.

Avvio:
    pip install firebase-admin
    python server.py
Serve il file serviceAccountKey.json (Console Firebase > Impostazioni progetto > Account di servizio).

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
SERVER_HOST = os.environ.get("PYCHAT_HOST", "127.0.0.1")
SERVER_PORT = int(os.environ.get("PYCHAT_PORT", "5555"))
SERVICE_ACCOUNT_FILE = os.environ.get("PYCHAT_SERVICE_ACCOUNT", os.path.join(BASE_DIR, "serviceAccountKey.json"))
SERVICE_ACCOUNT_JSON = os.environ.get("PYCHAT_SERVICE_ACCOUNT_JSON", "")
FIREBASE_DB_URL = os.environ.get(
    "PYCHAT_DB_URL", "https://ciaochat2-5ddfd-default-rtdb.europe-west1.firebasedatabase.app")
DB_ROOT = "/pychat"                  # tutti i dati dell'app vivono sotto questo nodo
MEDIA_DIR = os.path.join(BASE_DIR, "media")

# SMS in modalita simulata: nessun provider esterno, il codice viene mostrato al client.
# Non usare in produzione.
SMS_ALLOWED_PREFIXES = tuple(p.strip() for p in os.environ.get("PYCHAT_SMS_PREFIXES", "").split(",") if p.strip())
SMS_MAX_PER_IP_HOUR = 5              # SMS richiedibili da uno stesso IP in un'ora
SMS_MAX_PER_PHONE_10MIN = 3          # SMS richiedibili per uno stesso numero in 10 minuti
OTP_TTL_SECONDS = 600                # come la validita' predefinita dei codici Twilio Verify (10 minuti)
OTP_MAX_TRIES = 5
PBKDF2_ITERATIONS = 200_000
MAX_TOKENS_PER_USER = 5
HISTORY_LIMIT = 200
PAGE_SIZE = 50                     # dimensione di una pagina di cronologia (carica altri)
MAX_TEXT = 2000
MAX_ENC = 16_000                   # byte massimi di un payload E2EE (base64url)
MAX_SCHEDULE_SECONDS = 30 * 86400  # un messaggio puo' essere programmato al massimo tra 30 giorni
MAX_TTL_SECONDS = 30 * 86400       # auto-eliminazione automatica di un messaggio
MAX_LINE = 2_500_000                 # byte massimi per riga JSON (un vocale in base64 sta largamente dentro)
MAX_IMAGE = 600_000                  # byte per avatar / banner
MAX_PROFILE_MEDIA = 1_700_000         # keeps base64 uploads below MAX_LINE
MAX_VOICE = 1_100_000                # byte per messaggio vocale (WAV)
MEDIA_RETENTION_DAYS = 90            # i file non referenziati piu' vecchi di cosi' vengono cancellati all'avvio
CALL_RING_SECONDS = 45
FAIL_WINDOW_SECONDS = 600
FAIL_MAX_PER_IP = 10

USERNAME_RE = re.compile(r"^(?=.*[A-Za-z])[A-Za-z0-9]{3,20}$")   # alfanumerico, almeno una lettera
PHONE_RE = re.compile(r"^\+[1-9]\d{7,14}$")                       # E.164
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s.]+(?:\.[^@\s.]+)+$")
NAME_ANIMATIONS = {"none", "glow", "pulse", "rainbow", "bounce", "shake", "wave", "flicker"}
DM_POLICIES = {"everyone", "friends_group", "friends"}
FRIEND_REQUEST_POLICIES = {"everyone", "friends_of_friends", "group_members", "none"}
STATUS_EXPIRATIONS = {0, 3600, 14400, 86400, 604800}
COMMUNITY_PERMISSIONS = {
    "view_channels", "send_messages", "attach_files", "manage_messages", "manage_channels",
    "manage_roles", "manage_community", "kick_members", "ban_members", "administrator",
    "create_invites", "view_audit_log",
}
PERMISSION_BITS = {
    "VIEW_CHANNELS": 1 << 0,
    "SEND_MESSAGES": 1 << 1,
    "ATTACH_FILES": 1 << 2,
    "MANAGE_MESSAGES": 1 << 3,
    "KICK_MEMBERS": 1 << 4,
    "BAN_MEMBERS": 1 << 5,
    "MANAGE_ROLES": 1 << 6,
    "MANAGE_CHANNELS": 1 << 7,
    "ADMINISTRATOR": 1 << 8,
    "MANAGE_COMMUNITY": 1 << 9,
    "CREATE_INVITES": 1 << 10,
    "VIEW_AUDIT_LOG": 1 << 11,
}
PERMISSION_NAME_BY_LOWER = {
    "view_channels": "VIEW_CHANNELS",
    "send_messages": "SEND_MESSAGES",
    "attach_files": "ATTACH_FILES",
    "manage_messages": "MANAGE_MESSAGES",
    "manage_roles": "MANAGE_ROLES",
    "manage_channels": "MANAGE_CHANNELS",
    "kick_members": "KICK_MEMBERS",
    "ban_members": "BAN_MEMBERS",
    "administrator": "ADMINISTRATOR",
    "manage_community": "MANAGE_COMMUNITY",
    "create_invites": "CREATE_INVITES",
    "view_audit_log": "VIEW_AUDIT_LOG",
}
CHANNEL_SLOWMODES = {0, 5, 10, 30, 60, 300, 3600}

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


class SimulatedGateway:
    """Solo per sviluppo (PYCHAT_SMS_MODE=simulation): NESSUN SMS viene inviato e il codice viene
    restituito al client. Non verifica il telefono: non usarlo in produzione."""

    def __init__(self):
        self.codes = {}

    def start(self, phone):
        code = f"{secrets.randbelow(10 ** 6):06d}"
        self.codes[phone] = code
        log("[SMS simulato] codice di verifica generato.")
        return code

    def check(self, phone, code):
        expected = self.codes.get(phone)
        return expected is not None and hmac.compare_digest(expected, code)


def build_gateway():
    # SMS in modalita simulata: nessun provider esterno, il codice viene mostrato al client.
    # Non usare in produzione.
    return SimulatedGateway()


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


def fb_page(path, before=None, limit=PAGE_SIZE):
    """Pagina di cronologia. Senza `before` restituisce gli ultimi `limit` messaggi;
    con `before` (chiave di un messaggio) quelli precedenti. Ritorna (items, has_more, oldest_key)."""
    query = firebase_ref(path).order_by_key()
    if before:
        query = query.end_at(str(before))
    data = query.limit_to_last(limit + 2).get()
    if not data:
        return [], False, None
    if isinstance(data, list):
        data = {str(i): v for i, v in enumerate(data) if v is not None}
    keys = sorted(k for k in data if k != str(before or ""))
    has_more = len(keys) > limit
    keys = keys[-limit:]
    return [(k, data[k]) for k in keys], has_more, (keys[0] if keys else None)


def fb_due(node, field, limit=50):
    """Figli di `node` il cui campo `field` e' <= now, ordinati per quel campo.
    Legge tutto il nodo e filtra in locale: le code `scheduled`/`expiring` sono
    piccole e cosi' non servono indici `.indexOn` nelle regole RTDB."""
    data = firebase_ref(node).get()
    if not isinstance(data, dict):
        return []
    due = [(k, v) for k, v in data.items()
           if isinstance(v, dict) and isinstance(v.get(field), (int, float))
           and v[field] <= now()]
    due.sort(key=lambda item: item[1][field])
    return due[:limit]


def init_firebase():
    cred_source = SERVICE_ACCOUNT_JSON or (
        SERVICE_ACCOUNT_FILE if os.path.exists(SERVICE_ACCOUNT_FILE) else None)
    if not cred_source:
        sys.exit(f"File credenziali non trovato: {SERVICE_ACCOUNT_FILE}\n"
                 "Scaricalo da Console Firebase > Impostazioni progetto > Account di servizio > "
                 "Genera nuova chiave privata, poi salvalo come serviceAccountKey.json accanto a server.py, "
                 "oppure imposta la variabile d'ambiente PYCHAT_SERVICE_ACCOUNT_JSON col contenuto del file.")
    try:
        cred = credentials.Certificate(
            json.loads(cred_source) if isinstance(cred_source, str) and cred_source.startswith("{")
            else cred_source)
    except Exception as exc:
        sys.exit(f"File credenziali non valido: {exc}\n"
                 "Rigenera serviceAccountKey.json da Console Firebase > Impostazioni progetto > "
                 "Account di servizio > Genera nuova chiave privata.")
    firebase_admin.initialize_app(cred, {"databaseURL": FIREBASE_DB_URL})
    fb_get("users")  # prova di connessione: fallisce subito se URL o permessi sono sbagliati
    log(f"Firebase connesso: {FIREBASE_DB_URL}{DB_ROOT}")


# ============================================================== sicurezza
def hash_password(password, salt_hex):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex),
                               PBKDF2_ITERATIONS).hex()


def token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_totp_secret():
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def totp_code(secret, timestamp=None):
    timestamp = time.time() if timestamp is None else timestamp
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    counter = int(timestamp // 30)
    digest = hmac.new(key, counter.to_bytes(8, "big"), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = int.from_bytes(digest[offset:offset + 4], "big") & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def verify_totp(secret, code, timestamp=None):
    if not isinstance(code, str) or not re.fullmatch(r"\d{6}", code):
        return False
    timestamp = time.time() if timestamp is None else timestamp
    return any(
        hmac.compare_digest(totp_code(secret, timestamp + offset * 30), code)
        for offset in (-1, 0, 1)
    )


def resolve_user_key(username):
    value = str(username or "").strip().lower()
    if not USERNAME_RE.match(value):
        return None
    indexed = fb_get(f"usernames/{value}")
    if isinstance(indexed, str) and USERNAME_RE.match(indexed):
        return indexed.lower()
    rec = fb_get(f"users/{value}")
    return value if isinstance(rec, dict) else None


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
        self.token_hash = None
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
    return len(conns)


# ============================================================== profili e rubrica
def public_profile(key):
    rec = fb_get(f"users/{key}")
    if not isinstance(rec, dict):
        return None
    status_expiry = rec.get("status_expires")
    if status_expiry and status_expiry <= now():
        fb_update(f"users/{key}", {"status": None, "status_expires": None, "custom_status": None})
        rec["status"] = None
        rec["status_expires"] = None
        rec["custom_status"] = None
    status = rec.get("status")
    return {"id": key, "name": rec.get("display_name") or rec.get("username", key),
            "username": rec.get("username", key), "bio": rec.get("bio", ""), "status": status,
            "custom_status": rec.get("custom_status", {
                "text": status or "", "emoji": "", "expires_at": rec.get("status_expires"),
            }),
            "created": rec.get("created"),
            "avatar": rec.get("avatar"),
            "avatar_type": rec.get("avatar_type"), "banner": rec.get("banner"),
            "banner_type": rec.get("banner_type"), "name_color": rec.get("name_color", "#f1f5f9"),
            "name_animation": rec.get("name_animation", "none"), "online": key in online,
            "last_seen": rec.get("last_seen"), "e2ee_pub": rec.get("e2ee_pub"),
            "verification": (rec.get("verification") or {}).get("tier")
                            if isinstance(rec.get("verification"), dict) else None}


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
def touch_last_seen(key):
    if key:
        try:
            fb_update(f"users/{key}", {"last_seen": now()})
        except Exception:
            pass


def finish_login(conn, key, rec, token):
    conn.user, conn.name, conn.token_hash = key, rec["username"], token_hash(token)
    touch_last_seen(key)
    with lock:
        first = key not in online
        online.setdefault(key, []).append(conn)
    conn.send({"t": "ok", "id": key, "user": rec["username"], "display_name": rec.get("display_name"),
               "phone": rec.get("phone"), "email": rec.get("email"), "bio": rec.get("bio", ""),
               "status": rec.get("status"), "status_expires": rec.get("status_expires"), "token": token,
               "avatar": rec.get("avatar"), "avatar_type": rec.get("avatar_type"),
               "banner": rec.get("banner"), "banner_type": rec.get("banner_type"),
               "name_color": rec.get("name_color", "#f1f5f9"),
               "name_animation": rec.get("name_animation", "none"), "contacts": contacts_of(key)})
    log(f"{rec['username']} connesso da {conn.ip}")
    if first:
        broadcast({"t": "status", "id": key, "online": True})


def issue_token(key, conn=None):
    token = secrets.token_hex(24)
    session_id = token_hash(token)
    metadata = {
        "created": now(),
        "device_info": (getattr(conn, "user_agent", "") if conn else ""),
        "ip_address": getattr(conn, "ip", "") if conn else "",
        "last_active_at": now(),
    }
    fb_set(f"users/{key}/tokens/{session_id}", metadata)
    tokens = fb_get(f"users/{key}/tokens") or {}
    if len(tokens) > MAX_TOKENS_PER_USER:
        def session_time(item):
            value = item[1]
            return value if isinstance(value, int) else value.get("created", 0) if isinstance(value, dict) else 0
        for old in sorted(tokens.items(), key=session_time)[:len(tokens) - MAX_TOKENS_PER_USER]:
            old = old[0]
            fb_delete(f"users/{key}/tokens/{old}")
    return token


def handle_register(conn, m):
    username = str(m.get("user", "")).strip()
    email = str(m.get("email") or "").strip().lower()
    password = str(m.get("pw", ""))

    def err(text):
        conn.send({"t": "err", "text": text})

    if too_many_failures(conn.ip):
        return err("Troppi tentativi. Riprova tra qualche minuto.")
    if not USERNAME_RE.match(username):
        return err("Username non valido: 3-20 caratteri alfanumerici, con almeno una lettera.")
    if len(email) > 254 or not EMAIL_RE.fullmatch(email):
        return err("Indirizzo email non valido.")
    if not 8 <= len(password) <= 128:
        return err("La password deve avere almeno 8 caratteri.")
    key = username.lower()
    if fb_get(f"usernames/{key}") is not None:
        return err("Questo username e' gia' in uso.")
    email_key = hashlib.sha256(email.encode("utf-8")).hexdigest()
    if fb_get(f"email_index/{email_key}") is not None:
        return err("Questo indirizzo email e' gia' registrato.")

    if not fb_claim(f"usernames/{key}", key):
        return err("Questo username e' gia' in uso.")
    if not fb_claim(f"email_index/{email_key}", key):
        fb_delete(f"usernames/{key}")
        return err("Questo indirizzo email e' gia' registrato.")
    salt = secrets.token_hex(16)
    rec = {"username": username, "email": email, "salt": salt, "hash": hash_password(password, salt), "created": now()}
    fb_set(f"users/{key}", rec)
    conn.pending = None
    log(f"Nuovo utente registrato: {username}")
    finish_login(conn, key, rec, issue_token(key, conn))


def handle_login(conn, m):
    password = str(m.get("pw", ""))
    if too_many_failures(conn.ip):
        return conn.send({"t": "err", "text": "Troppi tentativi. Riprova tra qualche minuto."})
    identifier = str(m.get("user", "")).strip()
    normalized_email = identifier.lower()
    if EMAIL_RE.fullmatch(normalized_email):
        email_key = hashlib.sha256(normalized_email.encode("utf-8")).hexdigest()
        indexed_user = fb_get(f"email_index/{email_key}")
        key = indexed_user.lower() if isinstance(indexed_user, str) and USERNAME_RE.fullmatch(indexed_user) else None
    else:
        key = resolve_user_key(identifier)
    rec = fb_get(f"users/{key}") if key else None
    # l'hash viene calcolato anche per utenti inesistenti: tempi di risposta uguali
    computed = hash_password(password, rec["salt"] if isinstance(rec, dict) else "00" * 16)
    if not isinstance(rec, dict) or not hmac.compare_digest(computed, rec.get("hash", "")):
        record_failure(conn.ip)
        time.sleep(0.5)
        return conn.send({"t": "err", "text": "Username o password errati."})
    if rec.get("two_factor_enabled"):
        if not verify_totp(str(rec.get("two_factor_secret", "")), str(m.get("otp", ""))):
            if not m.get("otp"):
                return conn.send({"t": "auth_challenge", "method": "totp"})
            record_failure(conn.ip)
            return conn.send({"t": "err", "text": "Codice di autenticazione non valido."})
    finish_login(conn, key, rec, issue_token(key, conn))


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
    session_id = token_hash(token)
    existing = tokens.get(session_id)
    session_metadata = existing if isinstance(existing, dict) else {"created": existing if isinstance(existing, int) else now()}
    session_metadata["last_active_at"] = now()
    session_metadata["ip_address"] = conn.ip
    fb_set(f"users/{key}/tokens/{session_id}", session_metadata)
    finish_login(conn, key, rec, token)


def handle_logout(conn, m):
    token = str(m.get("token", ""))
    key = conn.user
    if not key:
        return
    if token:
        fb_delete(f"users/{key}/tokens/{token_hash(token)}")
    close_user_session(conn, key)


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
        target = resolve_user_key(query.lstrip("@"))
    if not target:
        return conn.send({"t": "err", "text": "Nessun utente trovato con questi dati."})
    if target == conn.user:
        return conn.send({"t": "err", "text": "Non puoi aggiungere te stesso."})
    if is_blocked(conn.user, target):
        return conn.send({"t": "err", "text": "Non puoi interagire con questo utente perché uno dei due lo ha bloccato."})
    target_record = fb_get(f"users/{target}") or {}
    target_policy = privacy_settings(target_record)["friend_request_policy"]
    if target_policy == "none":
        return conn.send({"t": "err", "text": "Questo utente non accetta richieste di contatto."})
    if target_policy == "friends_of_friends":
        mine = fb_get(f"contacts/{conn.user}") or {}
        theirs = fb_get(f"contacts/{target}") or {}
        if not set(mine).intersection(theirs):
            return conn.send({"t": "err", "text": "Questo utente accetta richieste solo da amici di amici."})
    if target_policy == "group_members" and not share_community(conn.user, target):
        return conn.send({"t": "err", "text": "Questo utente accetta richieste solo da membri di gruppi condivisi."})
    add_contact_link(conn.user, target)
    timestamp = now()
    fb_set(f"user_relationships/{conn.user}/{target}", {"status": "friend", "updated_at": timestamp})
    fb_set(f"user_relationships/{target}/{conn.user}", {"status": "friend", "updated_at": timestamp})
    conn.send({"t": "contact_added", "contact": public_profile(target)})


def clean_reply_to(value):
    if not isinstance(value, dict):
        return None
    mid = str(value.get("id", ""))[:80]
    if not mid:
        return None
    sender = resolve_user_key(value.get("from")) or str(value.get("from", ""))[:40]
    return {"id": mid, "from": sender, "text": str(value.get("text", ""))[:300]}


def clean_forwarded_from(value):
    sender = resolve_user_key(value) or str(value or "")[:40]
    return sender or None


def clean_poll(value):
    """Sonda di un messaggio: domanda + 2-10 opzioni. I voti partono vuoti."""
    if not isinstance(value, dict):
        return None
    question = str(value.get("q", "")).strip()[:200]
    raw = value.get("options")
    if not question or not isinstance(raw, list):
        return None
    options = []
    for entry in raw[:10]:
        text = (entry.get("text") if isinstance(entry, dict) else entry)
        text = str(text or "").strip()[:80]
        if text:
            options.append({"text": text, "votes": []})
    if len(options) < 2:
        return None
    return {"q": question, "options": options, "multiple": bool(value.get("multiple"))}


def clean_send_at(value):
    """Timestamp di programmazione (secondi): tra adesso e MAX_SCHEDULE_SECONDS."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        ts = int(value)
        if now() < ts <= now() + MAX_SCHEDULE_SECONDS:
            return ts
    return None


def clean_ttl(value):
    """TTL in secondi per l'auto-eliminazione di un messaggio (60s .. 30 giorni)."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        ttl = int(value)
        if 60 <= ttl <= MAX_TTL_SECONDS:
            return ttl
    return None


def clean_enc(value):
    """Payload cifrato E2EE: 'e1.<iv>.<ct>' o 'e4.<eph>.<iv>.<ct>.<iv2>.<ct2>'
    in base64url. Opaco per il server."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if len(value) > MAX_ENC or not re.fullmatch(r"e[14](?:\.[A-Za-z0-9_-]+){2,5}", value):
        return None
    return value


def expiry_node_id(path, mid):
    return hashlib.sha256(f"{path}/{mid}".encode("utf-8")).hexdigest()[:32]


def register_expiry(kind, path, mid, expires_at, info):
    """Registra in `expiring/` la scadenza di un messaggio: lo sweeper lo elimina anche dopo un riavvio."""
    node_id = expiry_node_id(path, mid)
    fb_set(f"expiring/{node_id}", {
        "kind": kind, "path": path, "id": mid, "expires_at": expires_at, **info,
    })


def clear_expiry(path, mid):
    fb_delete(f"expiring/{expiry_node_id(path, mid)}")


def store_message(frm, to, text, voice=None, attachment=None, reply_to=None,
                  forwarded_from=None, poll=None, expires_at=None, enc=None):
    """Salva un messaggio su Firebase e lo recapita a tutti i dispositivi dei due utenti."""
    msg = {"from": frm, "to": to, "text": text, "ts": now()}
    if enc:
        msg["enc"] = enc
    if voice:
        msg["voice"] = voice
    if attachment:
        msg["attachment"] = attachment
    if reply_to:
        msg["reply_to"] = reply_to
    if forwarded_from:
        msg["forwarded"] = True
        msg["forwarded_from"] = forwarded_from
    if poll:
        msg["poll"] = poll
    if expires_at:
        msg["expires_at"] = expires_at
    pushed = firebase_ref(f"messages/{pair_key(frm, to)}").push(msg)
    path = f"messages/{pair_key(frm, to)}"
    if expires_at:
        register_expiry("dm", path, pushed.key, expires_at, {"a": frm, "b": to})
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


def clean_attachment(value):
    if not isinstance(value, dict):
        return None
    media_hash = value.get("hash")
    if (not isinstance(media_hash, str) or not HASH_RE.fullmatch(media_hash)
            or not os.path.exists(media_path(media_hash))):
        return None
    try:
        with open(media_path(media_hash), "rb") as media_file:
            data = media_file.read(MAX_PROFILE_MEDIA + 1)
    except OSError:
        return None
    if len(data) > MAX_PROFILE_MEDIA:
        return None
    mime = stored_media_mime(media_hash, data)
    if mime not in ATTACHMENT_MIMES:
        return None
    name = str(value.get("name", "")).replace("\\", "/").split("/")[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()[:128]
    if not name:
        return None
    return {"hash": media_hash, "name": name, "mime": mime, "size": len(data)}


def dm_policy_error(frm, to):
    """Controlli di invio DM (blocco + policy privacy del destinatario). None se ammesso."""
    if is_blocked(frm, to):
        return "Non puoi inviare messaggi a questo utente."
    target_rec = fb_get(f"users/{to}")
    if not isinstance(target_rec, dict):
        return "Utente non trovato."
    dm_policy = privacy_settings(target_rec)["dm_policy"]
    is_friend = fb_get(f"contacts/{to}/{frm}") is not None
    if dm_policy == "friends" and not is_friend:
        return "Questo utente accetta messaggi solo dai contatti."
    if dm_policy == "friends_group" and not is_friend and not share_community(frm, to):
        return "Questo utente accetta messaggi solo da contatti o membri degli stessi gruppi."
    return None


def handle_dm(conn, m):
    to = str(m.get("to", "")).strip().lower()
    text = str(m.get("text", "")).strip()[:MAX_TEXT]
    enc = clean_enc(m.get("enc"))
    voice = clean_voice(m.get("voice"))
    attachment = clean_attachment(m.get("attachment"))
    poll = clean_poll(m.get("poll"))
    if m.get("attachment") is not None and attachment is None:
        return conn.send({"t": "err", "text": "Allegato non valido o non più disponibile."})
    if m.get("enc") is not None and enc is None:
        return conn.send({"t": "err", "text": "Messaggio cifrato non valido."})
    if voice and not text and not poll and not enc:
        text = "\U0001F3A4 Messaggio vocale"
    if to == conn.user or not USERNAME_RE.match(to):
        return
    err = dm_policy_error(conn.user, to)
    if err:
        return conn.send({"t": "err", "text": err})
    if not text and not voice and not attachment and not poll and not enc:
        return
    reply_to = clean_reply_to(m.get("reply_to"))
    forwarded_from = clean_forwarded_from(m.get("forwarded_from"))
    send_at = clean_send_at(m.get("send_at"))
    ttl = clean_ttl(m.get("ttl")) or conv_dm_ttl(conn.user, to)
    expires_at = now() + ttl if ttl else None
    if send_at:
        fb_set(f"scheduled/{secrets.token_hex(8)}", {
            "kind": "dm", "from": conn.user, "to": to, "text": text,
            "voice": voice, "attachment": attachment, "reply_to": reply_to,
            "forwarded_from": forwarded_from, "poll": poll,
            "expires_at": expires_at, "send_at": send_at, "enc": enc,
        })
        return conn.send({"t": "msg_scheduled", "scope": "dm", "with": to, "send_at": send_at})
    store_message(conn.user, to, text, voice, attachment,
                  reply_to=reply_to, forwarded_from=forwarded_from,
                  poll=poll, expires_at=expires_at, enc=enc)


def handle_history(conn, m):
    other = str(m.get("with", "")).strip().lower()
    if not USERNAME_RE.match(other):
        return
    if is_blocked(conn.user, other):
        return conn.send({"t": "err", "text": "Cronologia non disponibile per questa relazione."})
    before = str(m.get("before", ""))[:80] or None
    msgs = []
    items, has_more, oldest = fb_page(f"messages/{pair_key(conn.user, other)}", before)
    for k, v in items:
        if isinstance(v, dict):
            msgs.append(dict(v, id=k))
    read_ts = fb_get(f"read_markers/{conn.user}/dm/{other}")
    conn.send({"t": "history", "with": other, "msgs": msgs,
               "has_more": has_more, "oldest": oldest,
               "read_ts": read_ts if isinstance(read_ts, (int, float)) else 0,
               "conv_ttl": conv_dm_ttl(conn.user, other),
               **({"before": before} if before else {})})


def handle_profile(conn, m):
    key = resolve_user_key(m.get("user"))
    prof = public_profile(key) if key else None
    if not prof:
        return conn.send({"t": "err", "text": "Profilo non trovato."})
    if key == conn.user:
        prof["phone"] = (fb_get(f"users/{key}/phone") or "")      # il numero lo vede solo il proprietario
    conn.send({"t": "profile", "profile": prof})


def account_settings(key, rec=None):
    rec = rec if isinstance(rec, dict) else fb_get(f"users/{key}") or {}
    return {
        "id": key,
        "username": rec.get("username", key),
        "display_name": rec.get("display_name", rec.get("username", key)),
        "email": rec.get("email", ""),
        "phone": rec.get("phone", ""),
        "bio": rec.get("bio", ""),
        "status": rec.get("status", ""),
        "status_expires": rec.get("status_expires"),
        "custom_status": rec.get("custom_status", {
            "text": rec.get("status", ""),
            "emoji": "",
            "expires_at": rec.get("status_expires"),
        }),
        "avatar": rec.get("avatar"),
        "banner": rec.get("banner"),
        "verification": (rec.get("verification") or {}).get("tier")
                        if isinstance(rec.get("verification"), dict) else None,
        "two_factor_enabled": bool(rec.get("two_factor_enabled")),
    }


def privacy_settings(rec):
    saved = rec.get("privacy", {}) if isinstance(rec, dict) else {}
    return {
        "dm_policy": saved.get("dm_policy", "everyone"),
        "friend_request_policy": saved.get("friend_request_policy", "everyone"),
        "media_filter": saved.get("media_filter", True),
    }


DEFAULT_USER_SETTINGS = {
    "dm_privacy": "everyone",
    "friend_request_privacy": "everyone",
    "explicit_media_filter": True,
    "notifications": {
        "desktop": False,
        "badge": True,
        "incoming_message": True,
        "call_ring": True,
        "mute_unmute": True,
        "dnd": False,
    },
    "appearance": {
        "theme": "dark",
        "message_density": "cozy",
        "font_scale": 100,
        "reduced_motion": False,
        "link_previews": True,
        "inline_embeds": True,
        "auto_emoji": True,
    },
    "keybinds": {"mute": "", "deafen": "", "ptt": ""},
}


def user_settings(key):
    saved = fb_get(f"user_settings/{key}")
    if not isinstance(saved, dict):
        saved = {}
    notifications = dict(DEFAULT_USER_SETTINGS["notifications"])
    notifications.update(saved.get("notifications", {}) if isinstance(saved.get("notifications"), dict) else {})
    appearance = dict(DEFAULT_USER_SETTINGS["appearance"])
    appearance.update(saved.get("appearance", {}) if isinstance(saved.get("appearance"), dict) else {})
    keybinds = dict(DEFAULT_USER_SETTINGS["keybinds"])
    keybinds.update(saved.get("keybinds", {}) if isinstance(saved.get("keybinds"), dict) else {})
    dm_privacy = saved.get("dm_privacy", saved.get("dm_policy", "everyone"))
    friend_privacy = saved.get(
        "friend_request_privacy",
        saved.get("friend_request_policy", "everyone"),
    )
    return {
        "user_id": key,
        "dm_privacy": dm_privacy,
        "friend_request_privacy": friend_privacy,
        "explicit_media_filter": bool(saved.get("explicit_media_filter", saved.get("media_filter", True))),
        "notifications": notifications,
        "appearance": appearance,
        "keybinds": keybinds,
    }


def is_blocked(first, second):
    return (
        fb_get(f"users/{first}/blocks/{second}") is not None
        or fb_get(f"users/{second}/blocks/{first}") is not None
    )


def relationship_status(user_id, target_id):
    direct = fb_get(f"user_relationships/{user_id}/{target_id}")
    if isinstance(direct, dict):
        return direct
    if fb_get(f"contacts/{user_id}/{target_id}") is not None:
        return {"status": "friend", "updated_at": now()}
    return None


def relationships_for_user(user_id):
    raw = fb_get(f"user_relationships/{user_id}") or {}
    if not isinstance(raw, dict):
        return []
    result = []
    for target_id, relationship in raw.items():
        if not isinstance(relationship, dict):
            continue
        profile = public_profile(target_id)
        result.append({
            "user_id": user_id,
            "target_user_id": target_id,
            "status": relationship.get("status"),
            "updated_at": relationship.get("updated_at"),
            "profile": profile,
        })
    return result


def share_community(first, second):
    mine = fb_get(f"users/{first}/communities") or {}
    theirs = fb_get(f"users/{second}/communities") or {}
    return bool(set(mine).intersection(theirs)) if isinstance(mine, dict) and isinstance(theirs, dict) else False


def settings_snapshot(conn):
    key = conn.user
    rec = fb_get(f"users/{key}") or {}
    tokens = rec.get("tokens", {}) if isinstance(rec, dict) else {}
    sessions = []
    if isinstance(tokens, dict):
        for token_id, value in tokens.items():
            if not HASH_RE.match(token_id):
                continue
            if isinstance(value, dict):
                created = value.get("created", value.get("last_active_at", 0))
                session = dict(value)
            else:
                created = value if isinstance(value, int) else 0
                session = {"created": created}
            sessions.append({
                "id": token_id,
                "created": created,
                "device_info": session.get("device_info", ""),
                "ip_address": session.get("ip_address", ""),
                "last_active_at": session.get("last_active_at", created),
                "current": token_id == getattr(conn, "token_hash", None),
            })
    sessions.sort(key=lambda session: session["created"], reverse=True)
    raw_blocks = fb_get(f"users/{key}/blocks") or {}
    blocked = [
        profile for blocked_id in raw_blocks
        if (profile := public_profile(blocked_id)) is not None
    ] if isinstance(raw_blocks, dict) else []
    return {
        "t": "settings_data",
        "account": account_settings(key, rec),
        "privacy": privacy_settings(rec),
        "user_settings": user_settings(key),
        "relationships": relationships_for_user(key),
        "sessions": sessions,
        "blocked": blocked,
        "two_factor_enabled": bool(rec.get("two_factor_enabled")),
        "communities": communities_for_user(key),
    }


def handle_settings_get(conn, m):
    conn.send(settings_snapshot(conn))


def handle_account_update(conn, m):
    key = conn.user
    rec = fb_get(f"users/{key}")
    if not isinstance(rec, dict):
        return conn.send({"t": "err", "text": "Account non trovato."})

    username = str(m.get("username", rec.get("username", ""))).strip()
    display_name = str(m.get("display_name", rec.get("display_name", username))).strip()
    email = str(m.get("email", rec.get("email", ""))).strip().lower()
    bio = str(m.get("bio", rec.get("bio", ""))).strip()
    custom_status = m.get("custom_status")
    status = str(
        m.get("status", custom_status.get("text", "") if isinstance(custom_status, dict) else rec.get("status", ""))
    ).strip()
    status_emoji = str(custom_status.get("emoji", "") if isinstance(custom_status, dict) else "").strip()
    expiration = m.get("status_expires_in", 0)
    if not USERNAME_RE.fullmatch(username):
        return conn.send({"t": "err", "text": "Username non valido."})
    if not display_name or len(display_name) > 32:
        return conn.send({"t": "err", "text": "Il nome visualizzato deve contenere da 1 a 32 caratteri."})
    if email and (len(email) > 254 or not EMAIL_RE.fullmatch(email)):
        return conn.send({"t": "err", "text": "Indirizzo email non valido."})
    tier = verification_tier(key)
    bio_max = {"blue": 240, "black": 320, "rainbow": 500}.get(tier, 160)
    if len(bio) > bio_max or len(status) > 80:
        return conn.send({"t": "err", "text": f"La biografia o lo stato supera il limite consentito ({bio_max} caratteri per la bio)."})
    if isinstance(expiration, bool) or not isinstance(expiration, int) or expiration not in STATUS_EXPIRATIONS:
        return conn.send({"t": "err", "text": "Scadenza dello stato non valida."})
    if status and expiration:
        status_expires = now() + expiration
    else:
        status_expires = None

    old_username = rec.get("username", key)
    old_email = str(rec.get("email", "")).strip().lower()
    username_changed = username.lower() != old_username.lower()
    email_changed = email != old_email
    current_password = str(m.get("current_password", ""))
    if (username_changed or email_changed) and not hmac.compare_digest(
        hash_password(current_password, rec.get("salt", "00" * 16)), rec.get("hash", "")
    ):
        return conn.send({"t": "err", "text": "Password attuale non corretta."})

    new_username_key = username.lower()
    claimed_username = False
    if username_changed:
        claimed_username = fb_claim(f"usernames/{new_username_key}", key)
        if not claimed_username:
            return conn.send({"t": "err", "text": "Questo username è già in uso."})

    old_email_key = hashlib.sha256(old_email.encode("utf-8")).hexdigest() if old_email else None
    new_email_key = hashlib.sha256(email.encode("utf-8")).hexdigest() if email else None
    if email_changed and new_email_key:
        if not fb_claim(f"email_index/{new_email_key}", key):
            if claimed_username:
                fb_delete(f"usernames/{new_username_key}")
            return conn.send({"t": "err", "text": "Questo indirizzo email è già in uso."})

    updates = {
        "username": username,
        "display_name": display_name,
        "bio": bio,
        "status": status or None,
        "status_expires": status_expires,
        "custom_status": {
            "text": status or "",
            "emoji": status_emoji,
            "expires_at": status_expires,
        },
    }
    if email:
        updates["email"] = email
    fb_update(f"users/{key}", updates)
    if email_changed and not email:
        fb_delete(f"users/{key}/email")
    if username_changed:
        fb_delete(f"usernames/{old_username.lower()}")
    if email_changed and old_email_key:
        fb_delete(f"email_index/{old_email_key}")
    conn.name = username
    profile = public_profile(key)
    broadcast({"t": "profile_update", "profile": profile})
    broadcast({"t": "USER_UPDATED", "id": key, "profile": profile})
    conn.send({"t": "account_saved", "account": account_settings(key), "profile": profile})


def handle_privacy_update(conn, m):
    dm_policy = m.get("dm_policy")
    request_policy = m.get("friend_request_policy")
    media_filter = m.get("media_filter")
    dm_aliases = {
        "everyone": "everyone",
        "friends_and_groups": "friends_group",
        "friends_group": "friends_group",
        "friends_only": "friends",
        "friends": "friends",
    }
    friend_aliases = {
        "everyone": "everyone",
        "mutuals": "friends_of_friends",
        "friends_of_friends": "friends_of_friends",
        "group_members": "group_members",
        "none": "none",
    }
    if dm_policy not in dm_aliases or request_policy not in friend_aliases:
        return conn.send({"t": "err", "text": "Impostazioni privacy non valide."})
    dm_policy = dm_aliases[dm_policy]
    request_policy = friend_aliases[request_policy]
    if dm_policy not in DM_POLICIES or request_policy not in FRIEND_REQUEST_POLICIES or not isinstance(media_filter, bool):
        return conn.send({"t": "err", "text": "Impostazioni privacy non valide."})
    privacy = {
        "dm_policy": dm_policy,
        "friend_request_policy": request_policy,
        "media_filter": media_filter,
    }
    fb_set(f"users/{conn.user}/privacy", privacy)
    fb_update(f"user_settings/{conn.user}", {
        "dm_privacy": "friends_and_groups" if dm_policy == "friends_group" else ("friends_only" if dm_policy == "friends" else "everyone"),
        "friend_request_privacy": "mutuals" if request_policy == "friends_of_friends" else request_policy,
        "explicit_media_filter": media_filter,
    })
    conn.send({"t": "privacy_saved", "privacy": privacy, "user_settings": user_settings(conn.user)})


def handle_user_settings_update(conn, m):
    dm_privacy = m.get("dm_privacy")
    friend_request_privacy = m.get("friend_request_privacy")
    explicit_media_filter = m.get("explicit_media_filter")
    notifications = m.get("notifications")
    appearance = m.get("appearance")
    keybinds = m.get("keybinds")

    updates = {}
    if dm_privacy is not None:
        allowed = {"everyone", "friends_and_groups", "friends_only"}
        if dm_privacy not in allowed:
            return conn.send({"t": "err", "text": "Privacy messaggi diretti non valida."})
        updates["dm_privacy"] = dm_privacy
        old_dm = {
            "everyone": "everyone",
            "friends_and_groups": "friends_group",
            "friends_only": "friends",
        }[dm_privacy]
        fb_set(f"users/{conn.user}/privacy/dm_policy", old_dm)
    if friend_request_privacy is not None:
        allowed = {"everyone", "mutuals", "group_members"}
        if friend_request_privacy not in allowed:
            return conn.send({"t": "err", "text": "Privacy richieste di amicizia non valida."})
        updates["friend_request_privacy"] = friend_request_privacy
        fb_set(
            f"users/{conn.user}/privacy/friend_request_policy",
            "friends_of_friends" if friend_request_privacy == "mutuals" else friend_request_privacy,
        )
    if explicit_media_filter is not None:
        if not isinstance(explicit_media_filter, bool):
            return conn.send({"t": "err", "text": "Filtro contenuti non valido."})
        updates["explicit_media_filter"] = explicit_media_filter
        fb_set(f"users/{conn.user}/privacy/media_filter", explicit_media_filter)
    if notifications is not None:
        if not isinstance(notifications, dict):
            return conn.send({"t": "err", "text": "Impostazioni notifiche non valide."})
        notifications_allowed = set(DEFAULT_USER_SETTINGS["notifications"])
        if set(notifications) - notifications_allowed or any(
            not isinstance(value, bool) for value in notifications.values()
        ):
            return conn.send({"t": "err", "text": "Impostazioni notifiche non valide."})
        updates["notifications"] = dict(DEFAULT_USER_SETTINGS["notifications"], **notifications)
    if appearance is not None:
        if not isinstance(appearance, dict):
            return conn.send({"t": "err", "text": "Impostazioni aspetto non valide."})
        allowed_themes = {"dark", "oled", "light", "glass"}
        allowed_density = {"cozy", "compact"}
        normalized = dict(DEFAULT_USER_SETTINGS["appearance"])
        normalized.update(appearance)
        if normalized["theme"] not in allowed_themes or normalized["message_density"] not in allowed_density:
            return conn.send({"t": "err", "text": "Impostazioni aspetto non valide."})
        if isinstance(normalized["font_scale"], bool) or not isinstance(normalized["font_scale"], int):
            return conn.send({"t": "err", "text": "Dimensione testo non valida."})
        for key in ("reduced_motion", "link_previews", "inline_embeds", "auto_emoji"):
            if not isinstance(normalized[key], bool):
                return conn.send({"t": "err", "text": "Impostazioni aspetto non valide."})
        updates["appearance"] = normalized
    if keybinds is not None:
        if not isinstance(keybinds, dict):
            return conn.send({"t": "err", "text": "Tasti rapidi non validi."})
        if set(keybinds) - set(DEFAULT_USER_SETTINGS["keybinds"]):
            return conn.send({"t": "err", "text": "Tasti rapidi non validi."})
        if any(not isinstance(value, str) or len(value) > 64 for value in keybinds.values()):
            return conn.send({"t": "err", "text": "Tasti rapidi non validi."})
        updates["keybinds"] = dict(DEFAULT_USER_SETTINGS["keybinds"], **keybinds)
    if updates:
        fb_update(f"user_settings/{conn.user}", updates)
    conn.send({"t": "settings_saved", "user_settings": user_settings(conn.user)})


def handle_relationship_update(conn, m):
    target = resolve_user_key(m.get("user"))
    action = str(m.get("action", "")).strip()
    if not target:
        return conn.send({"t": "err", "text": "Utente non trovato."})
    if target == conn.user:
        return conn.send({"t": "err", "text": "Non puoi modificare te stesso."})
    if action == "block":
        fb_set(f"users/{conn.user}/blocks/{target}", now())
        fb_set(f"user_relationships/{conn.user}/{target}", {"status": "blocked", "updated_at": now()})
        fb_set(f"user_relationships/{target}/{conn.user}", {"status": "blocked", "updated_at": now()})
        fb_delete(f"contacts/{conn.user}/{target}")
        fb_delete(f"contacts/{target}/{conn.user}")
    elif action == "unblock":
        fb_delete(f"users/{conn.user}/blocks/{target}")
        fb_delete(f"user_relationships/{conn.user}/{target}")
        fb_delete(f"user_relationships/{target}/{conn.user}")
    elif action == "friend_request":
        if is_blocked(conn.user, target):
            return conn.send({"t": "err", "text": "Una relazione è bloccata."})
        target_rec = fb_get(f"users/{target}") or {}
        policy = privacy_settings(target_rec)["friend_request_policy"]
        if policy == "none":
            return conn.send({"t": "err", "text": "Questo utente non accetta richieste di contatto."})
        if policy == "friends_of_friends":
            mine = fb_get(f"contacts/{conn.user}") or {}
            theirs = fb_get(f"contacts/{target}") or {}
            if not set(mine).intersection(theirs):
                return conn.send({"t": "err", "text": "Accettate solo richieste da amici in comune."})
        if policy == "group_members" and not share_community(conn.user, target):
            return conn.send({"t": "err", "text": "Accettate solo richieste da membri di gruppi condivisi."})
        timestamp = now()
        fb_set(f"user_relationships/{conn.user}/{target}", {"status": "pending_outgoing", "updated_at": timestamp})
        fb_set(f"user_relationships/{target}/{conn.user}", {"status": "pending_incoming", "updated_at": timestamp})
    elif action == "accept":
        incoming = relationship_status(conn.user, target)
        if not incoming or incoming.get("status") != "pending_incoming":
            return conn.send({"t": "err", "text": "Richiesta non trovata."})
        timestamp = now()
        fb_set(f"user_relationships/{conn.user}/{target}", {"status": "friend", "updated_at": timestamp})
        fb_set(f"user_relationships/{target}/{conn.user}", {"status": "friend", "updated_at": timestamp})
        add_contact_link(conn.user, target)
        add_contact_link(target, conn.user)
    elif action == "decline" or action == "cancel":
        fb_delete(f"user_relationships/{conn.user}/{target}")
        fb_delete(f"user_relationships/{target}/{conn.user}")
    else:
        return conn.send({"t": "err", "text": "Azione relazione non valida."})
    broadcast({"t": "USER_UPDATED", "id": conn.user, "relationships": relationships_for_user(conn.user)})
    conn.send(settings_snapshot(conn))


def handle_block_update(conn, m):
    target = resolve_user_key(m.get("user"))
    if not target:
        return conn.send({"t": "err", "text": "Utente non trovato."})
    if target == conn.user:
        return conn.send({"t": "err", "text": "Non puoi bloccare te stesso."})
    action = m.get("action")
    if action == "block":
        fb_set(f"users/{conn.user}/blocks/{target}", now())
    elif action == "unblock":
        fb_delete(f"users/{conn.user}/blocks/{target}")
    else:
        return conn.send({"t": "err", "text": "Azione blocco non valida."})
    conn.send(settings_snapshot(conn))


def close_user_session(conn, key):
    went_offline = False
    with lock:
        connections = online.get(key, [])
        if conn in connections:
            connections.remove(conn)
        if not connections:
            online.pop(key, None)
            went_offline = True
    conn.user = None
    conn.name = ""
    conn.token_hash = None
    conn.pending = None
    if went_offline:
        broadcast({"t": "status", "id": key, "online": False})


def handle_session_revoke(conn, m):
    session_id = str(m.get("session", ""))
    if not HASH_RE.fullmatch(session_id):
        return conn.send({"t": "err", "text": "Sessione non valida."})
    if fb_get(f"users/{conn.user}/tokens/{session_id}") is None:
        return conn.send({"t": "err", "text": "Sessione non trovata."})
    fb_delete(f"users/{conn.user}/tokens/{session_id}")
    with lock:
        targets = [
            active for active in online.get(conn.user, [])
            if getattr(active, "token_hash", None) == session_id
        ]
    for active in targets:
        active.send({"t": "SESSION_REVOKED", "current": active is conn})
        if active is conn:
            close_user_session(active, conn.user)
        timer = threading.Timer(0.25, active.close)
        timer.daemon = True
        timer.start()
    if conn.user:
        conn.send(settings_snapshot(conn))


def handle_password_change(conn, m):
    rec = fb_get(f"users/{conn.user}")
    current = str(m.get("current_password", ""))
    new = str(m.get("new_password", ""))
    if not isinstance(rec, dict) or not hmac.compare_digest(
        hash_password(current, rec.get("salt", "00" * 16)), rec.get("hash", "")
    ):
        return conn.send({"t": "err", "text": "Password attuale non corretta."})
    if not 8 <= len(new) <= 128:
        return conn.send({"t": "err", "text": "La nuova password deve avere almeno 8 caratteri."})
    salt = secrets.token_hex(16)
    fb_update(f"users/{conn.user}", {"salt": salt, "hash": hash_password(new, salt)})
    tokens = rec.get("tokens", {})
    current_session = getattr(conn, "token_hash", None)
    if isinstance(tokens, dict):
        for session_id in tokens:
            if session_id != current_session:
                fb_delete(f"users/{conn.user}/tokens/{session_id}")
    conn.send({"t": "password_changed"})


def handle_two_factor_setup(conn, m):
    rec = fb_get(f"users/{conn.user}") or {}
    if rec.get("two_factor_enabled"):
        return conn.send({"t": "err", "text": "L'autenticazione a due fattori è già attiva."})
    secret = generate_totp_secret()
    fb_set(f"users/{conn.user}/two_factor_pending", {"secret": secret, "expires": now() + 600})
    label = urllib.parse.quote(f"CiaoChat:{rec.get('username', conn.user)}")
    uri = f"otpauth://totp/{label}?secret={secret}&issuer=CiaoChat&algorithm=SHA1&digits=6&period=30"
    conn.send({"t": "two_factor_setup", "secret": secret, "otpauth_uri": uri})


def handle_two_factor_enable(conn, m):
    pending = fb_get(f"users/{conn.user}/two_factor_pending")
    if not isinstance(pending, dict) or pending.get("expires", 0) < now():
        return conn.send({"t": "err", "text": "Configurazione 2FA scaduta. Riprova."})
    if not verify_totp(str(pending.get("secret", "")), str(m.get("code", ""))):
        return conn.send({"t": "err", "text": "Codice 2FA non valido."})
    fb_update(f"users/{conn.user}", {
        "two_factor_secret": pending["secret"],
        "two_factor_enabled": True,
    })
    fb_delete(f"users/{conn.user}/two_factor_pending")
    conn.send({"t": "two_factor_saved", "enabled": True})


def handle_two_factor_disable(conn, m):
    rec = fb_get(f"users/{conn.user}")
    if not isinstance(rec, dict) or not hmac.compare_digest(
        hash_password(str(m.get("password", "")), rec.get("salt", "00" * 16)), rec.get("hash", "")
    ):
        return conn.send({"t": "err", "text": "Password non corretta."})
    if not rec.get("two_factor_enabled") or not verify_totp(
        str(rec.get("two_factor_secret", "")), str(m.get("code", ""))
    ):
        return conn.send({"t": "err", "text": "Codice 2FA non valido."})
    fb_update(f"users/{conn.user}", {"two_factor_enabled": False})
    fb_delete(f"users/{conn.user}/two_factor_secret")
    conn.send({"t": "two_factor_saved", "enabled": False})


COMMUNITY_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def valid_community_id(value):
    value = str(value or "")
    return value if COMMUNITY_ID_RE.fullmatch(value) else None


def community_record(community_id):
    if not valid_community_id(community_id):
        return None
    value = fb_get(f"communities/{community_id}/meta")
    return value if isinstance(value, dict) else None


def community_member(community_id, user_id):
    value = fb_get(f"communities/{community_id}/members/{user_id}")
    return value if isinstance(value, dict) else None


def member_role_ids(member):
    roles = member.get("roles", []) if isinstance(member, dict) else []
    return [role_id for role_id in roles if valid_community_id(role_id)] if isinstance(roles, list) else []


def role_permissions_bitmask(role):
    bitmask = 0
    if not isinstance(role, dict):
        return bitmask
    permissions = role.get("permissions", {})
    if isinstance(permissions, dict):
        for permission, enabled in permissions.items():
            if enabled:
                name = PERMISSION_NAME_BY_LOWER.get(permission)
                if name:
                    bitmask |= PERMISSION_BITS[name]
    return bitmask


def computeChannelPermissions(userId, groupId, channelId=None):
    """Discord-style base role permissions followed by everyone, role and member overrides."""
    community = community_record(groupId)
    if not community:
        return 0
    if community.get("owner") == userId:
        return sum(PERMISSION_BITS.values())
    member = community_member(groupId, userId)
    if not member:
        return 0
    roles = fb_get(f"communities/{groupId}/roles") or {}
    base = 0
    role_ids = member_role_ids(member)
    for role_id in role_ids:
        base |= role_permissions_bitmask(roles.get(role_id, {}))
    if base & PERMISSION_BITS["ADMINISTRATOR"]:
        return sum(PERMISSION_BITS.values())
    if not channelId:
        return base
    overrides = fb_get(f"communities/{groupId}/channels/{channelId}/overrides") or {}
    if not isinstance(overrides, dict):
        overrides = {}

    def apply_overrides(target_id):
        entry = overrides.get(target_id)
        if not isinstance(entry, dict):
            return
        allow = deny = 0
        for permission, state in entry.items():
            bit = PERMISSION_BITS.get(PERMISSION_NAME_BY_LOWER.get(permission))
            if not bit:
                continue
            if state == "allow":
                allow |= bit
            elif state == "deny":
                deny |= bit
        return allow, deny

    allow, deny = 0, 0
    everyone_override = apply_overrides("everyone")
    if everyone_override:
        allow |= everyone_override[0]
        deny |= everyone_override[1]
    for role_id in role_ids:
        override = apply_overrides(role_id)
        if override:
            allow |= override[0]
            deny |= override[1]
    base = (base & ~deny) | allow
    member_override = apply_overrides(userId)
    if member_override:
        base = (base & ~member_override[1]) | member_override[0]
    return base


def community_permissions(community_id, user_id, channel_id=None):
    bitmask = computeChannelPermissions(user_id, community_id, channel_id)
    return {
        permission: bool(bitmask & PERMISSION_BITS.get(PERMISSION_NAME_BY_LOWER.get(permission), 0))
        for permission in COMMUNITY_PERMISSIONS
    }


def community_highest_role(community_id, user_id):
    community = community_record(community_id)
    member = community_member(community_id, user_id)
    if not community or not member:
        return -1
    if community.get("owner") == user_id:
        return 10_000
    roles = fb_get(f"communities/{community_id}/roles") or {}
    positions = [
        role.get("position", 0) for role_id in member_role_ids(member)
        if isinstance((role := roles.get(role_id)), dict)
        and isinstance(role.get("position", 0), int)
    ]
    return max(positions, default=-1)


def community_can_manage_target(community_id, actor_id, target_id):
    community = community_record(community_id)
    if not community or actor_id == target_id or community.get("owner") == target_id:
        return False
    return community_highest_role(community_id, actor_id) > community_highest_role(community_id, target_id)


def require_community_permission(conn, community_id, permission, channel_id=None):
    permissions = community_permissions(community_id, conn.user, channel_id)
    if not permissions.get(permission) and not permissions.get("administrator"):
        conn.send({"t": "err", "text": "Non hai i permessi necessari per questa operazione."})
        return None
    return permissions


def audit_community(community_id, actor_id, action, details=None):
    event = {"actor": actor_id, "action": action, "details": details or {}, "timestamp": now()}
    firebase_ref(f"communities/{community_id}/audit").push(event)


def communities_for_user(user_id):
    memberships = fb_get(f"users/{user_id}/communities") or {}
    if not isinstance(memberships, dict):
        return []
    result = []
    for community_id in memberships:
        community = community_record(community_id)
        member = community_member(community_id, user_id)
        if not community or not member:
            continue
        permissions = community_permissions(community_id, user_id)
        result.append({
            "id": community_id,
            "name": community.get("name", ""),
            "icon": community.get("icon"),
            "role": member_role_ids(member),
            "can_manage": bool(permissions.get("manage_community") or permissions.get("administrator")),
        })
    return result


def community_invitations_for_user(user_id):
    raw = fb_get(f"users/{user_id}/community_invites") or {}
    if not isinstance(raw, dict):
        return []
    invitations = []
    for community_id, invite in raw.items():
        if not isinstance(invite, dict):
            continue
        community = community_record(community_id)
        if not community:
            continue
        inviter = public_profile(invite.get("invited_by", "")) or {}
        invitations.append({
            "community": community_id,
            "name": community.get("name", "Community"),
            "inviter": inviter.get("name", inviter.get("username", "")),
        })
    return invitations


def community_snapshot(community_id, user_id):
    community = community_record(community_id)
    member = community_member(community_id, user_id)
    if not community or not member:
        return None
    permissions = community_permissions(community_id, user_id)
    channels_raw = fb_get(f"communities/{community_id}/channels") or {}
    channels = []
    if isinstance(channels_raw, dict):
        for channel_id, channel in channels_raw.items():
            if not isinstance(channel, dict):
                continue
            channel_permissions = community_permissions(community_id, user_id, channel_id)
            if channel_permissions.get("view_channels") or permissions.get("administrator"):
                channels.append(dict(channel, id=channel_id))
    data = {
        "id": community_id,
        "name": community.get("name", ""),
        "icon": community.get("icon"),
        "banner": community.get("banner"),
        "default_notification": community.get("default_notification", "all"),
        "welcome_channel": community.get("welcome_channel"),
        "permissions": permissions,
        "channels": channels,
        "participants": [],
    }
    roles = fb_get(f"communities/{community_id}/roles") or {}
    members = fb_get(f"communities/{community_id}/members") or {}
    data["roles"] = roles if isinstance(roles, dict) else {}
    if isinstance(members, dict):
        for member_id, member_data in members.items():
            profile = public_profile(member_id)
            if not profile:
                continue
            role_ids = member_role_ids(member_data)
            data["participants"].append({
                "id": member_id,
                "username": profile.get("username", member_id),
                "name": profile.get("name", profile.get("username", member_id)),
                "avatar": profile.get("avatar"),
                "online": profile.get("online", False),
                "email": (fb_get(f"users/{member_id}/email") or "") if permissions.get("manage_community") else "",
                "roles": [
                    {"id": role_id, "name": data["roles"].get(role_id, {}).get("name", role_id),
                     "color": data["roles"].get(role_id, {}).get("color", "#64748b")}
                    for role_id in role_ids if isinstance(data["roles"].get(role_id), dict)
                ],
            })
    if permissions.get("manage_roles") or permissions.get("administrator"):
        data["members"] = members if isinstance(members, dict) else {}
    if permissions.get("create_invites") or permissions.get("manage_community") or permissions.get("administrator"):
        data["member_invites"] = fb_get(f"communities/{community_id}/member_invites") or {}
    if permissions.get("create_invites") or permissions.get("administrator"):
        data["invites"] = fb_get(f"communities/{community_id}/invites") or {}
    if permissions.get("ban_members") or permissions.get("administrator"):
        data["bans"] = fb_get(f"communities/{community_id}/bans") or {}
    if permissions.get("view_audit_log") or permissions.get("administrator"):
        data["audit"] = [dict(event, id=key) for key, event in fb_last(
            f"communities/{community_id}/audit", 100
        ) if isinstance(event, dict)]
    return data


def send_community_snapshot(conn, community_id):
    data = community_snapshot(community_id, conn.user)
    if not data:
        return conn.send({"t": "err", "text": "Gruppo non trovato o accesso negato."})
    conn.send({"t": "community_data", "community": data})


def handle_community_create(conn, m):
    name = str(m.get("name", "")).strip()
    if not 1 <= len(name) <= 64:
        return conn.send({"t": "err", "text": "Il nome del gruppo deve contenere da 1 a 64 caratteri."})
    community_id = secrets.token_hex(16)
    all_permissions = {permission: True for permission in COMMUNITY_PERMISSIONS}
    default_permissions = {permission: permission in {
        "view_channels", "send_messages", "attach_files", "create_invites",
    } for permission in COMMUNITY_PERMISSIONS}
    community = {
        "owner": conn.user,
        "name": name,
        "default_notification": "all",
        "welcome_channel": "general",
        "created": now(),
    }
    fb_set(f"communities/{community_id}", {
        "meta": community,
        "roles": {
            "everyone": {"name": "Everyone", "color": "#99aab5", "position": 0,
                         "display_separately": False, "permissions": default_permissions},
            "owner": {"name": "Owner", "color": "#f0b232", "position": 1000,
                      "display_separately": True, "permissions": all_permissions},
        },
        "channels": {
            "general": {"name": "general", "topic": "", "slowmode": 0, "created": now()},
        },
        "members": {conn.user: {"roles": ["owner"], "joined": now()}},
    })
    fb_set(f"groups/{community_id}", {
        "name": community["name"],
        "icon_url": "",
        "banner_url": "",
        "owner_id": conn.user,
        "default_notification_level": "all",
        "system_welcome_channel_id": "general",
        "roles": {
            "everyone": {"name": "Everyone", "color_hex": "#99aab5", "position": 0,
                         "hoist": False, "permissions": default_permissions},
            "owner": {"name": "Owner", "color_hex": "#f0b232", "position": 1000,
                      "hoist": True, "permissions": all_permissions},
        },
        "channels": {
            "general": {"name": "general", "topic": "", "type": "text",
                        "slowmode_seconds": 0, "created": now()},
        },
    })
    fb_set(f"users/{conn.user}/communities/{community_id}", True)
    audit_community(community_id, conn.user, "community_created", {"name": name})
    conn.send({"t": "community_created", "id": community_id})
    send_community_snapshot(conn, community_id)


def handle_community_update(conn, m):
    community_id = valid_community_id(m.get("community"))
    if not community_id or not require_community_permission(conn, community_id, "manage_community"):
        return
    community = community_record(community_id)
    if not community:
        return conn.send({"t": "err", "text": "Gruppo non trovato."})
    updates = {}
    if "name" in m:
        name = str(m.get("name", "")).strip()
        if not 1 <= len(name) <= 64:
            return conn.send({"t": "err", "text": "Il nome del gruppo deve contenere da 1 a 64 caratteri."})
        updates["name"] = name
    if "default_notification" in m:
        level = m["default_notification"]
        if level not in ("all", "mentions"):
            return conn.send({"t": "err", "text": "Livello notifiche non valido."})
        updates["default_notification"] = level
    if "welcome_channel" in m:
        channel_id = valid_community_id(m.get("welcome_channel"))
        if not channel_id or not isinstance(fb_get(f"communities/{community_id}/channels/{channel_id}"), dict):
            return conn.send({"t": "err", "text": "Canale di benvenuto non valido."})
        updates["welcome_channel"] = channel_id
    if updates:
        fb_update(f"communities/{community_id}/meta", updates)
        audit_community(community_id, conn.user, "community_updated", updates)
    broadcast({"t": "GROUP_UPDATED", "group": community_id, "changes": updates})
    send_community_snapshot(conn, community_id)


def normalized_role_permissions(raw):
    if isinstance(raw, int) and not isinstance(raw, bool):
        raw = {
            permission: bool(raw & PERMISSION_BITS[PERMISSION_NAME_BY_LOWER[permission]])
            for permission in COMMUNITY_PERMISSIONS
            if permission in PERMISSION_NAME_BY_LOWER
        }
    if not isinstance(raw, dict) or set(raw) - COMMUNITY_PERMISSIONS:
        return None
    if any(not isinstance(value, bool) for value in raw.values()):
        return None
    return {permission: bool(raw.get(permission, False)) for permission in COMMUNITY_PERMISSIONS}


def handle_community_role(conn, m, action):
    community_id = valid_community_id(m.get("community"))
    if not community_id or not require_community_permission(conn, community_id, "manage_roles"):
        return
    roles_path = f"communities/{community_id}/roles"
    roles = fb_get(roles_path) or {}
    if not isinstance(roles, dict):
        return conn.send({"t": "err", "text": "Ruoli non disponibili."})
    role_id = valid_community_id(m.get("role"))
    if action == "create":
        name = str(m.get("name", "")).strip()
        color = str(m.get("color", "#99aab5"))
        permissions = normalized_role_permissions(m.get("permissions", {}))
        if not 1 <= len(name) <= 32 or not re.fullmatch(r"#[0-9a-fA-F]{6}", color) or permissions is None:
            return conn.send({"t": "err", "text": "Dati del ruolo non validi."})
        if any(permissions[p] and not community_permissions(community_id, conn.user).get(p)
               for p in COMMUNITY_PERMISSIONS):
            return conn.send({"t": "err", "text": "Non puoi assegnare permessi che non possiedi."})
        role_id = secrets.token_hex(8)
        position = max((r.get("position", 0) for r in roles.values() if isinstance(r, dict)), default=0) + 1
        fb_set(f"{roles_path}/{role_id}", {
            "name": name, "color": color.lower(), "position": position,
            "display_separately": bool(m.get("display_separately")),
            "permissions": permissions,
        })
        audit_community(community_id, conn.user, "role_created", {"role": role_id, "name": name})
    elif action == "update":
        role = roles.get(role_id) if role_id else None
        if not isinstance(role, dict) or role_id in ("everyone", "owner"):
            return conn.send({"t": "err", "text": "Ruolo non valido."})
        if role.get("position", 0) >= community_highest_role(community_id, conn.user):
            return conn.send({"t": "err", "text": "Non puoi modificare questo ruolo."})
        updates = {}
        if "name" in m:
            name = str(m.get("name", "")).strip()
            if not 1 <= len(name) <= 32:
                return conn.send({"t": "err", "text": "Il nome del ruolo non è valido."})
            updates["name"] = name
        if "color" in m:
            color = str(m.get("color", ""))
            if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
                return conn.send({"t": "err", "text": "Colore del ruolo non valido."})
            updates["color"] = color.lower()
        if "display_separately" in m:
            if not isinstance(m["display_separately"], bool):
                return conn.send({"t": "err", "text": "Impostazione di visualizzazione non valida."})
            updates["display_separately"] = m["display_separately"]
        if "permissions" in m:
            permissions = normalized_role_permissions(m["permissions"])
            if permissions is None:
                return conn.send({"t": "err", "text": "Permessi del ruolo non validi."})
            actor_permissions = community_permissions(community_id, conn.user)
            if any(permissions[p] and not actor_permissions.get(p) for p in COMMUNITY_PERMISSIONS):
                return conn.send({"t": "err", "text": "Non puoi assegnare permessi che non possiedi."})
            updates["permissions"] = permissions
        if updates:
            fb_update(f"{roles_path}/{role_id}", updates)
            audit_community(community_id, conn.user, "role_updated", {"role": role_id})
    elif action == "delete":
        role = roles.get(role_id) if role_id else None
        if not isinstance(role, dict) or role_id in ("everyone", "owner"):
            return conn.send({"t": "err", "text": "Questo ruolo non può essere eliminato."})
        if role.get("position", 0) >= community_highest_role(community_id, conn.user):
            return conn.send({"t": "err", "text": "Non puoi eliminare questo ruolo."})
        members = fb_get(f"communities/{community_id}/members") or {}
        if isinstance(members, dict):
            for user_id, member in members.items():
                if isinstance(member, dict) and role_id in member_role_ids(member):
                    fb_set(f"communities/{community_id}/members/{user_id}/roles",
                           [item for item in member_role_ids(member) if item != role_id])
        channels = fb_get(f"communities/{community_id}/channels") or {}
        if isinstance(channels, dict):
            for channel_id in channels:
                fb_delete(f"communities/{community_id}/channels/{channel_id}/overrides/{role_id}")
        fb_delete(f"{roles_path}/{role_id}")
        audit_community(community_id, conn.user, "role_deleted", {"role": role_id})
    elif action == "reorder":
        ordered = m.get("roles")
        managed_roles = {
            key for key, role in roles.items()
            if key not in ("everyone", "owner") and isinstance(role, dict)
        }
        if not isinstance(ordered, list) or set(ordered) != managed_roles or len(ordered) != len(managed_roles):
            return conn.send({"t": "err", "text": "Ordine dei ruoli non valido."})
        for position, ordered_id in enumerate(ordered, start=1):
            role = roles[ordered_id]
            if role.get("position", 0) >= community_highest_role(community_id, conn.user):
                return conn.send({"t": "err", "text": "Non puoi riordinare questo ruolo."})
        for position, ordered_id in enumerate(ordered, start=1):
            fb_set(f"{roles_path}/{ordered_id}/position", position)
        audit_community(community_id, conn.user, "roles_reordered")
    else:
        return
    broadcast({"t": "ROLE_UPDATED", "group": community_id, "role": role_id, "action": action})
    send_community_snapshot(conn, community_id)


def handle_community_assign_role(conn, m):
    community_id = valid_community_id(m.get("community"))
    if not community_id or not require_community_permission(conn, community_id, "manage_roles"):
        return
    target_id = resolve_user_key(m.get("user"))
    role_id = valid_community_id(m.get("role"))
    role = fb_get(f"communities/{community_id}/roles/{role_id}") if role_id else None
    if not target_id or not role or not community_member(community_id, target_id):
        return conn.send({"t": "err", "text": "Utente o ruolo non trovato."})
    if not community_can_manage_target(community_id, conn.user, target_id):
        return conn.send({"t": "err", "text": "Non puoi modificare i ruoli di questo membro."})
    if role_id in ("everyone", "owner") or role.get("position", 0) >= community_highest_role(community_id, conn.user):
        return conn.send({"t": "err", "text": "Non puoi assegnare questo ruolo."})
    member = community_member(community_id, target_id)
    roles = member_role_ids(member)
    action = m.get("action")
    if action == "add" and role_id not in roles:
        roles.append(role_id)
    elif action == "remove":
        roles = [item for item in roles if item != role_id]
    else:
        return conn.send({"t": "err", "text": "Azione ruolo non valida."})
    fb_set(f"communities/{community_id}/members/{target_id}/roles", roles)
    audit_community(community_id, conn.user, "member_role_updated", {"user": target_id, "role": role_id})
    send_community_snapshot(conn, community_id)


def handle_community_member_roles(conn, m):
    community_id = valid_community_id(m.get("community"))
    target_id = resolve_user_key(m.get("user"))
    role_ids = m.get("roles")
    if not community_id or not require_community_permission(conn, community_id, "manage_roles"):
        return
    if not target_id or not community_member(community_id, target_id):
        return conn.send({"t": "err", "text": "Membro non trovato."})
    if not community_can_manage_target(community_id, conn.user, target_id):
        return conn.send({"t": "err", "text": "Non puoi modificare i ruoli di questo membro."})
    if not isinstance(role_ids, list) or len(role_ids) > 20 or any(not valid_community_id(role_id) for role_id in role_ids):
        return conn.send({"t": "err", "text": "Selezione dei ruoli non valida."})
    role_ids = list(dict.fromkeys(role_ids))
    if "owner" in role_ids:
        return conn.send({"t": "err", "text": "Il ruolo proprietario non è assegnabile."})
    roles = fb_get(f"communities/{community_id}/roles") or {}
    actor_highest = community_highest_role(community_id, conn.user)
    actor_permissions = community_permissions(community_id, conn.user)
    for role_id in role_ids:
        role = roles.get(role_id) if isinstance(roles, dict) else None
        if not isinstance(role, dict):
            return conn.send({"t": "err", "text": "Uno dei ruoli selezionati non esiste più."})
        if role_id != "everyone" and role.get("position", 0) >= actor_highest:
            return conn.send({"t": "err", "text": "Non puoi assegnare un ruolo pari o superiore al tuo."})
        role_permissions = role.get("permissions", {})
        if isinstance(role_permissions, dict) and any(
            enabled and not actor_permissions.get(permission)
            for permission, enabled in role_permissions.items()
        ):
            return conn.send({"t": "err", "text": "Non puoi assegnare permessi che non possiedi."})
    normalized = ["everyone"] + [role_id for role_id in role_ids if role_id != "everyone"]
    fb_set(f"communities/{community_id}/members/{target_id}/roles", normalized)
    audit_community(community_id, conn.user, "member_roles_updated", {
        "user": target_id, "roles": normalized,
    })
    broadcast({"t": "MEMBER_UPDATED", "group": community_id, "member": target_id})
    conn.send({"t": "member_roles_saved", "community": community_id, "user": target_id})
    send_community_snapshot(conn, community_id)


def handle_community_channel(conn, m, action):
    community_id = valid_community_id(m.get("community"))
    if not community_id or not require_community_permission(conn, community_id, "manage_channels"):
        return
    channel_id = valid_community_id(m.get("channel"))
    channels_path = f"communities/{community_id}/channels"
    if action == "create":
        name = str(m.get("name", "")).strip()
        if not 1 <= len(name) <= 64:
            return conn.send({"t": "err", "text": "Il nome del canale deve contenere da 1 a 64 caratteri."})
        channel_id = secrets.token_hex(8)
        fb_set(f"{channels_path}/{channel_id}", {"name": name, "topic": "", "slowmode": 0, "created": now()})
        audit_community(community_id, conn.user, "channel_created", {"channel": channel_id, "name": name})
    elif action == "update":
        channel = fb_get(f"{channels_path}/{channel_id}") if channel_id else None
        if not isinstance(channel, dict):
            return conn.send({"t": "err", "text": "Canale non trovato."})
        updates = {}
        if "name" in m:
            name = str(m.get("name", "")).strip()
            if not 1 <= len(name) <= 64:
                return conn.send({"t": "err", "text": "Nome canale non valido."})
            updates["name"] = name
        if "topic" in m:
            topic = str(m.get("topic", "")).strip()
            if len(topic) > 256:
                return conn.send({"t": "err", "text": "L'argomento supera 256 caratteri."})
            updates["topic"] = topic
        if "slowmode" in m:
            slowmode = m.get("slowmode")
            if isinstance(slowmode, bool) or not isinstance(slowmode, int) or slowmode not in CHANNEL_SLOWMODES:
                return conn.send({"t": "err", "text": "Intervallo slowmode non valido."})
            updates["slowmode"] = slowmode
        if updates:
            fb_update(f"{channels_path}/{channel_id}", updates)
            audit_community(community_id, conn.user, "channel_updated", {"channel": channel_id, **updates})
    elif action == "delete":
        if not channel_id or not isinstance(fb_get(f"{channels_path}/{channel_id}"), dict):
            return conn.send({"t": "err", "text": "Canale non trovato."})
        community = community_record(community_id)
        if community.get("welcome_channel") == channel_id:
            return conn.send({"t": "err", "text": "Scegli un altro canale di benvenuto prima di eliminarlo."})
        fb_delete(f"{channels_path}/{channel_id}")
        audit_community(community_id, conn.user, "channel_deleted", {"channel": channel_id})
    else:
        return
    broadcast({"t": "CHANNEL_UPDATED", "group": community_id, "channel": channel_id, "action": action})
    send_community_snapshot(conn, community_id)


def handle_community_override(conn, m):
    community_id = valid_community_id(m.get("community"))
    channel_id = valid_community_id(m.get("channel"))
    role_id = valid_community_id(m.get("role"))
    member_id = resolve_user_key(m.get("member")) if m.get("member") else None
    target_id = role_id or member_id
    if not community_id or not channel_id or not target_id:
        return conn.send({"t": "err", "text": "Canale o ruolo non valido."})
    if not require_community_permission(conn, community_id, "manage_channels"):
        return
    if not isinstance(fb_get(f"communities/{community_id}/channels/{channel_id}"), dict):
        return conn.send({"t": "err", "text": "Canale o ruolo non trovato."})
    if role_id and not isinstance(fb_get(f"communities/{community_id}/roles/{role_id}"), dict):
        return conn.send({"t": "err", "text": "Canale o ruolo non trovato."})
    if member_id and not community_member(community_id, member_id):
        return conn.send({"t": "err", "text": "Canale o membro non trovato."})
    overrides = m.get("overrides")
    if not isinstance(overrides, dict) or set(overrides) - COMMUNITY_PERMISSIONS:
        return conn.send({"t": "err", "text": "Override non validi."})
    if any(value not in ("allow", "deny", "inherit") for value in overrides.values()):
        return conn.send({"t": "err", "text": "Override non validi."})
    path = f"communities/{community_id}/channels/{channel_id}/overrides/{target_id}"
    fb_delete(path)
    saved = {permission: value for permission, value in overrides.items() if value != "inherit"}
    if saved:
        fb_set(path, saved)
    audit_community(community_id, conn.user, "channel_overrides_updated", {
        "channel": channel_id, "target": target_id,
    })
    broadcast({"t": "CHANNEL_UPDATED", "group": community_id, "channel": channel_id,
               "permission_overrides": True})
    send_community_snapshot(conn, community_id)


def handle_community_invite_create(conn, m):
    community_id = valid_community_id(m.get("community"))
    if not community_id or not require_community_permission(conn, community_id, "create_invites"):
        return
    uses = m.get("max_uses", 0)
    expires_in = m.get("expires_in", 0)
    if isinstance(uses, bool) or not isinstance(uses, int) or not 0 <= uses <= 10_000:
        return conn.send({"t": "err", "text": "Limite utilizzi invito non valida."})
    if isinstance(expires_in, bool) or not isinstance(expires_in, int) or expires_in not in (0, 3600, 86400, 604800):
        return conn.send({"t": "err", "text": "Scadenza invito non valida."})
    code = secrets.token_urlsafe(9)
    invite = {
        "creator": conn.user, "created": now(), "uses": 0, "max_uses": uses,
        "expires": now() + expires_in if expires_in else 0,
    }
    fb_set(f"communities/{community_id}/invites/{code}", invite)
    audit_community(community_id, conn.user, "invite_created", {"code": code})
    send_community_snapshot(conn, community_id)


def resolve_invite_identifier(value):
    identifier = str(value or "").strip()
    if "@" in identifier:
        email = identifier.lower()
        if not EMAIL_RE.fullmatch(email):
            return None
        user_id = fb_get(f"email_index/{hashlib.sha256(email.encode('utf-8')).hexdigest()}")
        return user_id if isinstance(user_id, str) else None
    return resolve_user_key(identifier.lstrip("@"))


def handle_community_member_invite(conn, m):
    community_id = valid_community_id(m.get("community"))
    if not community_id or not require_community_permission(conn, community_id, "create_invites"):
        return
    identifier = str(m.get("identifier", m.get("email", m.get("username", "")))).strip()
    if not identifier:
        return conn.send({"t": "err", "text": "Inserisci email o username."})
    target_id = resolve_invite_identifier(identifier)
    if not target_id:
        return conn.send({"t": "err", "text": "Utente non trovato. Controlla email o username."})
    if target_id == conn.user:
        return conn.send({"t": "err", "text": "Non puoi invitare te stesso."})
    if community_member(community_id, target_id):
        return conn.send({"t": "err", "text": "Questo utente è già un membro attivo."})
    if fb_get(f"communities/{community_id}/bans/{target_id}") is not None:
        return conn.send({"t": "err", "text": "Questo utente è bannato da questa community."})
    pending_path = f"communities/{community_id}/member_invites/{target_id}"
    if fb_get(pending_path) is not None:
        return conn.send({"t": "err", "text": "Esiste già un invito in attesa per questo utente."})
    role_ids = m.get("roles", [])
    if not isinstance(role_ids, list) or len(role_ids) > 20 or any(not valid_community_id(role_id) for role_id in role_ids):
        return conn.send({"t": "err", "text": "Selezione dei ruoli non valida."})
    role_ids = list(dict.fromkeys(role_ids))
    if "everyone" in role_ids or "owner" in role_ids:
        return conn.send({"t": "err", "text": "Ruolo non assegnabile nell'invito."})
    if role_ids and not require_community_permission(conn, community_id, "manage_roles"):
        return
    inviter_highest = community_highest_role(community_id, conn.user)
    roles = fb_get(f"communities/{community_id}/roles") or {}
    actor_permissions = community_permissions(community_id, conn.user)
    for role_id in role_ids:
        role = roles.get(role_id) if isinstance(roles, dict) else None
        if not isinstance(role, dict):
            return conn.send({"t": "err", "text": "Uno dei ruoli selezionati non esiste più."})
        if role.get("position", 0) >= inviter_highest:
            return conn.send({"t": "err", "text": "Non puoi assegnare un ruolo pari o superiore al tuo."})
        role_permissions = role.get("permissions", {})
        if isinstance(role_permissions, dict) and any(
            enabled and not actor_permissions.get(permission)
            for permission, enabled in role_permissions.items()
        ):
            return conn.send({"t": "err", "text": "Non puoi assegnare permessi che non possiedi."})
    invite = {
        "group": community_id,
        "invited_by": conn.user,
        "roles": role_ids,
        "username": (fb_get(f"users/{target_id}") or {}).get("username", target_id),
        "created": now(),
    }
    fb_set(pending_path, invite)
    fb_set(f"users/{target_id}/community_invites/{community_id}", {
        "invited_by": conn.user, "created": invite["created"],
    })
    audit_community(community_id, conn.user, "member_invited", {
        "user": target_id, "roles": role_ids,
    })
    inviter = public_profile(conn.user) or {}
    send_to(target_id, {
        "t": "community_invite_received",
        "invite": dict(invite, name=(community_record(community_id) or {}).get("name", ""),
                       inviter=inviter.get("name", inviter.get("username", conn.user))),
    })
    conn.send({
        "t": "member_invited",
        "community": community_id,
        "user": target_id,
        "username": (fb_get(f"users/{target_id}") or {}).get("username", target_id),
    })
    broadcast({"t": "GROUP_UPDATED", "group": community_id, "member_invites": True})
    send_community_snapshot(conn, community_id)


def handle_community_invite_response(conn, m):
    community_id = valid_community_id(m.get("community"))
    action = m.get("action")
    if not community_id or action not in ("accept", "decline"):
        return conn.send({"t": "err", "text": "Invito o azione non valida."})
    path = f"communities/{community_id}/member_invites/{conn.user}"
    invite = fb_get(path)
    if not isinstance(invite, dict):
        return conn.send({"t": "err", "text": "Invito non trovato o già scaduto."})
    if action == "decline":
        fb_delete(path)
        fb_delete(f"users/{conn.user}/community_invites/{community_id}")
        send_to(invite.get("invited_by"), {
            "t": "community_invite_response", "community": community_id,
            "user": conn.user, "accepted": False,
        })
        return conn.send({"t": "community_invite_removed", "community": community_id})
    if community_member(community_id, conn.user):
        fb_delete(path)
        fb_delete(f"users/{conn.user}/community_invites/{community_id}")
        return conn.send({"t": "err", "text": "Sei già membro di questa community."})
    if fb_get(f"communities/{community_id}/bans/{conn.user}") is not None:
        return conn.send({"t": "err", "text": "Non puoi accettare l'invito perché sei bannato."})
    roles = fb_get(f"communities/{community_id}/roles") or {}
    selected_roles = invite.get("roles", [])
    if not isinstance(selected_roles, list) or any(
        role_id not in roles for role_id in selected_roles
    ):
        return conn.send({"t": "err", "text": "I ruoli dell'invito non sono più disponibili."})
    member_roles = ["everyone"] + [role_id for role_id in selected_roles if role_id != "everyone"]
    fb_set(f"communities/{community_id}/members/{conn.user}", {"roles": member_roles, "joined": now()})
    fb_set(f"users/{conn.user}/communities/{community_id}", True)
    fb_delete(path)
    audit_community(community_id, conn.user, "member_joined_by_invite", {
        "invited_by": invite.get("invited_by"),
    })
    inviter = invite.get("invited_by")
    send_to(inviter, {
        "t": "community_invite_response", "community": community_id,
        "user": conn.user, "accepted": True,
    })
    broadcast({"t": "GROUP_UPDATED", "group": community_id, "member": conn.user})
    conn.send({"t": "community_invite_accepted", "community": community_id})
    send_community_snapshot(conn, community_id)


def handle_community_member_invite_revoke(conn, m):
    community_id = valid_community_id(m.get("community"))
    target_id = resolve_user_key(m.get("user"))
    if not community_id or not target_id:
        return conn.send({"t": "err", "text": "Invito o utente non valido."})
    if not require_community_permission(conn, community_id, "create_invites"):
        return
    path = f"communities/{community_id}/member_invites/{target_id}"
    invite = fb_get(path)
    if not isinstance(invite, dict):
        return conn.send({"t": "err", "text": "Invito non trovato o già accettato."})
    permissions = community_permissions(community_id, conn.user)
    if invite.get("invited_by") != conn.user and not (
        permissions.get("manage_community") or permissions.get("administrator")
    ):
        return conn.send({"t": "err", "text": "Puoi revocare solo i tuoi inviti."})
    fb_delete(path)
    fb_delete(f"users/{target_id}/community_invites/{community_id}")
    audit_community(community_id, conn.user, "member_invite_revoked", {"user": target_id})
    conn.send({"t": "member_invite_revoked", "community": community_id, "user": target_id})
    send_to(target_id, {"t": "community_invite_removed", "community": community_id})
    send_community_snapshot(conn, community_id)


def handle_community_invite_revoke(conn, m):
    community_id = valid_community_id(m.get("community"))
    code = str(m.get("code", ""))
    if not community_id or not code or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", code):
        return conn.send({"t": "err", "text": "Invito non valido."})
    if not require_community_permission(conn, community_id, "create_invites"):
        return
    invite = fb_get(f"communities/{community_id}/invites/{code}")
    if not isinstance(invite, dict):
        return conn.send({"t": "err", "text": "Invito non trovato."})
    permissions = community_permissions(community_id, conn.user)
    if invite.get("creator") != conn.user and not (
        permissions.get("manage_community") or permissions.get("administrator")
    ):
        return conn.send({"t": "err", "text": "Puoi revocare solo i tuoi inviti."})
    fb_delete(f"communities/{community_id}/invites/{code}")
    audit_community(community_id, conn.user, "invite_revoked", {"code": code})
    send_community_snapshot(conn, community_id)


def handle_community_join(conn, m):
    community_id = valid_community_id(m.get("community"))
    code = str(m.get("code", ""))
    if not community_id or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", code):
        return conn.send({"t": "err", "text": "Invito non valido."})
    if community_member(community_id, conn.user):
        return send_community_snapshot(conn, community_id)
    if fb_get(f"communities/{community_id}/bans/{conn.user}") is not None:
        return conn.send({"t": "err", "text": "Sei stato escluso da questo gruppo."})
    nonce = secrets.token_hex(8)

    def claim_invite(current):
        if not isinstance(current, dict):
            return current
        expiry = current.get("expires", 0)
        used = current.get("uses", 0)
        max_uses = current.get("max_uses", 0)
        if expiry and expiry < now() or max_uses and used >= max_uses:
            return current
        updated = dict(current)
        updated["uses"] = used + 1
        updated["_claim"] = nonce
        return updated

    invite_ref = firebase_ref(f"communities/{community_id}/invites/{code}")
    claimed = invite_ref.transaction(claim_invite)
    if not isinstance(claimed, dict) or claimed.get("_claim") != nonce:
        return conn.send({"t": "err", "text": "Invito scaduto, revocato o esaurito."})
    invite_ref.update({"_claim": None})
    community = community_record(community_id)
    if not community:
        return conn.send({"t": "err", "text": "Gruppo non trovato."})
    fb_set(f"communities/{community_id}/members/{conn.user}", {"roles": ["everyone"], "joined": now()})
    fb_set(f"users/{conn.user}/communities/{community_id}", True)
    audit_community(community_id, conn.user, "member_joined")
    send_community_snapshot(conn, community_id)


def handle_community_member_action(conn, m, action):
    community_id = valid_community_id(m.get("community"))
    target_id = resolve_user_key(m.get("user"))
    permission = "ban_members" if action == "ban" else "kick_members"
    if not community_id or not require_community_permission(conn, community_id, permission):
        return
    target = community_member(community_id, target_id) if target_id else None
    if not target:
        return conn.send({"t": "err", "text": "Membro non trovato."})
    if not community_can_manage_target(community_id, conn.user, target_id):
        return conn.send({"t": "err", "text": "Non puoi gestire questo membro per via della gerarchia dei ruoli."})
    if action == "ban":
        reason = str(m.get("reason", "")).strip()[:256]
        fb_set(f"communities/{community_id}/bans/{target_id}", {
            "by": conn.user, "at": now(), "reason": reason,
        })
    fb_delete(f"communities/{community_id}/members/{target_id}")
    fb_delete(f"users/{target_id}/communities/{community_id}")
    audit_community(community_id, conn.user, "member_banned" if action == "ban" else "member_kicked", {
        "user": target_id,
    })
    send_to(target_id, {"t": "community_removed", "community": community_id})
    broadcast({"t": "MEMBER_REMOVED", "group": community_id, "member": target_id})
    conn.send({"t": "member_removed", "community": community_id, "user": target_id})
    send_community_snapshot(conn, community_id)


def handle_community_unban(conn, m):
    community_id = valid_community_id(m.get("community"))
    target_id = resolve_user_key(m.get("user"))
    if not community_id or not require_community_permission(conn, community_id, "ban_members"):
        return
    if not target_id or fb_get(f"communities/{community_id}/bans/{target_id}") is None:
        return conn.send({"t": "err", "text": "Ban non trovato."})
    fb_delete(f"communities/{community_id}/bans/{target_id}")
    audit_community(community_id, conn.user, "member_unbanned", {"user": target_id})
    send_community_snapshot(conn, community_id)


def handle_community_audit(conn, m):
    community_id = valid_community_id(m.get("community"))
    if not community_id or not require_community_permission(conn, community_id, "view_audit_log"):
        return
    action_filter = str(m.get("action", "")).strip()
    actor_filter = str(m.get("actor", "")).strip()
    limit = m.get("limit", 200)
    if isinstance(limit, bool) or not isinstance(limit, int):
        limit = 200
    limit = min(200, max(1, limit))
    page = m.get("page", 1)
    if isinstance(page, bool) or not isinstance(page, int):
        page = 1
    page = max(1, page)
    events = []
    all_events = [
        dict(event, id=event_id)
        for event_id, event in fb_last(f"communities/{community_id}/audit", 200)
        if isinstance(event, dict)
    ]
    for event in all_events:
        if action_filter and action_filter not in str(event.get("action", "")):
            continue
        if actor_filter and event.get("actor") != actor_filter:
            continue
        events.append(event)
    start = (page - 1) * limit
    conn.send({"t": "community_audit", "community": community_id, "events": events[start:start + limit],
               "page": page, "limit": limit, "total": len(events)})


def handle_community_channel_send(conn, m):
    community_id = valid_community_id(m.get("community"))
    channel_id = valid_community_id(m.get("channel"))
    text = str(m.get("text", "")).strip()[:MAX_TEXT]
    voice = clean_voice(m.get("voice"))
    attachment = clean_attachment(m.get("attachment"))
    poll = clean_poll(m.get("poll"))
    if m.get("attachment") is not None and attachment is None:
        return conn.send({"t": "err", "text": "Allegato non valido o non più disponibile."})
    if not community_id or not channel_id:
        return
    permissions = require_community_permission(conn, community_id, "view_channels", channel_id)
    if not permissions:
        return
    if not permissions.get("send_messages") and not permissions.get("administrator"):
        return conn.send({"t": "err", "text": "Non puoi inviare messaggi in questo canale."})
    if not text and not voice and not attachment and not poll:
        return
    if voice and not text and not poll:
        text = "\U0001F3A4 Messaggio vocale"
    channel = fb_get(f"communities/{community_id}/channels/{channel_id}")
    if not isinstance(channel, dict):
        return conn.send({"t": "err", "text": "Canale non trovato."})
    reply_to = clean_reply_to(m.get("reply_to"))
    forwarded_from = clean_forwarded_from(m.get("forwarded_from"))
    send_at = clean_send_at(m.get("send_at"))
    ttl = clean_ttl(m.get("ttl"))
    expires_at = now() + ttl if ttl else None
    if send_at:
        fb_set(f"scheduled/{secrets.token_hex(8)}", {
            "kind": "community", "from": conn.user, "community": community_id,
            "channel": channel_id, "text": text, "voice": voice,
            "attachment": attachment, "reply_to": reply_to,
            "forwarded_from": forwarded_from, "poll": poll,
            "expires_at": expires_at, "send_at": send_at,
        })
        return conn.send({"t": "msg_scheduled", "scope": "community",
                          "community": community_id, "channel": channel_id,
                          "send_at": send_at})
    slowmode = channel.get("slowmode", 0)
    bypass_slowmode = permissions.get("manage_messages") or permissions.get("administrator")
    if slowmode and not bypass_slowmode:
        marker = f"{now()}:{secrets.token_hex(6)}"
        ref = firebase_ref(f"communities/{community_id}/slowmode/{channel_id}/{conn.user}")

        def claim_slowmode(current):
            try:
                previous = int(str(current).split(":", 1)[0])
            except (TypeError, ValueError):
                previous = 0
            return marker if now() - previous >= slowmode else current

        if ref.transaction(claim_slowmode) != marker:
            current = ref.get()
            try:
                previous = int(str(current).split(":", 1)[0])
            except (TypeError, ValueError):
                previous = 0
            remaining = max(0, slowmode - (now() - previous))
            return conn.send({
                "t": "err",
                "text": f"Attendi ancora {remaining} secondi prima di inviare un altro messaggio.",
                "slowmode_remaining": remaining,
            })
    community_deliver(community_id, channel_id, conn.user, {
        "text": text, "voice": voice, "attachment": attachment, "poll": poll,
        "reply_to": reply_to, "forwarded_from": forwarded_from,
        "expires_at": expires_at,
    })


def community_deliver(community_id, channel_id, sender, fields):
    """Pubblica un messaggio in un canale community e lo recapita ai membri."""
    message = {"from": sender, "text": fields.get("text", ""), "timestamp": now()}
    for key in ("voice", "attachment", "poll", "reply_to", "expires_at"):
        if fields.get(key):
            message[key] = fields[key]
    if fields.get("forwarded_from"):
        message["forwarded"] = True
        message["forwarded_from"] = fields["forwarded_from"]
    path = f"communities/{community_id}/messages/{channel_id}"
    message_id = firebase_ref(path).push(message).key
    if message.get("expires_at"):
        register_expiry("community", path, message_id, message["expires_at"],
                        {"community": community_id, "channel": channel_id})
    payload = {"t": "community_message", "community": community_id, "channel": channel_id,
               "message": dict(message, id=message_id)}
    members = fb_get(f"communities/{community_id}/members") or {}
    if isinstance(members, dict):
        for user_id in members:
            send_to(user_id, payload)


def handle_community_channel_history(conn, m):
    community_id = valid_community_id(m.get("community"))
    channel_id = valid_community_id(m.get("channel"))
    if not community_id or not channel_id:
        return
    permissions = require_community_permission(conn, community_id, "view_channels", channel_id)
    if not permissions:
        return
    before = str(m.get("before", ""))[:80] or None
    items, has_more, oldest = fb_page(
        f"communities/{community_id}/messages/{channel_id}", before)
    messages = [
        dict(message, id=message_id)
        for message_id, message in items
        if isinstance(message, dict)
    ]
    read_ts = fb_get(f"read_markers/{conn.user}/c/{community_id}/{channel_id}")
    conn.send({"t": "community_history", "community": community_id, "channel": channel_id,
               "messages": messages, "has_more": has_more, "oldest": oldest,
               "read_ts": read_ts if isinstance(read_ts, (int, float)) else 0,
               **({"before": before} if before else {})})


E2EE_PUB_RE = re.compile(r"^e2\.[A-Za-z0-9_-]{80,200}$")


def handle_e2ee_pub(conn, m):
    """Pubblica la chiave pubblica ECDH P-256 (punto non compresso, base64url)."""
    pub = str(m.get("pub", "")).strip()
    if not E2EE_PUB_RE.match(pub):
        return conn.send({"t": "err", "text": "Chiave pubblica non valida."})
    fb_update(f"users/{conn.user}", {"e2ee_pub": pub})
    profile = public_profile(conn.user)
    broadcast({"t": "profile_update", "profile": profile})
    broadcast({"t": "USER_UPDATED", "id": conn.user, "profile": profile})
    conn.send({"t": "e2ee_pub_ok"})


# ============================================================== admin (backend)

ADMIN_TOKEN = os.environ.get("PYCHAT_ADMIN_TOKEN", "")


def admin_stats():
    users = fb_get("users") or {}
    communities = fb_get("communities") or {}
    scheduled = fb_get("scheduled") or {}
    expiring = fb_get("expiring") or {}
    media_bytes = 0
    media_files = 0
    try:
        for entry in os.scandir(MEDIA_DIR):
            if entry.is_file():
                media_files += 1
                media_bytes += entry.stat().st_size
    except OSError:
        pass
    return {
        "users": len(users) if isinstance(users, dict) else 0,
        "online": len(online),
        "conversations_pairs": len(fb_get("messages") or {}),
        "communities": len(communities) if isinstance(communities, dict) else 0,
        "scheduled_pending": len(scheduled) if isinstance(scheduled, dict) else 0,
        "expiring_pending": len(expiring) if isinstance(expiring, dict) else 0,
        "media_files": media_files,
        "media_mb": round(media_bytes / 1_048_576, 1),
        "calls_active": len(calls),
    }


def handle_admin(conn, m):
    """Comandi admin: richiedono PYCHAT_ADMIN_TOKEN e la chiave nel messaggio."""
    if not ADMIN_TOKEN:
        return conn.send({"t": "err", "text": "Admin disabilitato su questo server."})
    if not hmac.compare_digest(str(m.get("key", "")), ADMIN_TOKEN):
        log(f"Admin: tentativo fallito da {conn.name}")
        return conn.send({"t": "err", "text": "Non autorizzato."})
    action = str(m.get("action", ""))
    if action == "stats":
        return conn.send({"t": "admin_stats", **admin_stats()})
    target = resolve_user_key(m.get("user"))
    if action == "user":
        if not target:
            return conn.send({"t": "err", "text": "Utente non trovato."})
        rec = fb_get(f"users/{target}") or {}
        contacts = fb_get(f"contacts/{target}") or {}
        return conn.send({"t": "admin_user", "user": target,
                          "username": rec.get("username"),
                          "display_name": rec.get("display_name"),
                          "created": rec.get("created"),
                          "last_seen": rec.get("last_seen"),
                          "online": target in online,
                          "contacts": len(contacts) if isinstance(contacts, dict) else 0,
                          "two_factor": bool(rec.get("two_factor_enabled"))})
    if action == "logout":
        if not target:
            return conn.send({"t": "err", "text": "Utente non trovato."})
        conns = list(online.get(target, []))
        for other in conns:
            other.send({"t": "err", "text": "Sessione terminata dall'amministratore."})
            other.close()
        online.pop(target, None)
        return conn.send({"t": "admin_logout", "user": target, "closed": len(conns)})
    if action == "broadcast":
        text = str(m.get("text", "")).strip()[:MAX_TEXT]
        if not text:
            return conn.send({"t": "err", "text": "Testo non valido."})
        sent = broadcast({"t": "admin_notice", "text": text})
        return conn.send({"t": "admin_broadcast", "delivered": sent})
    conn.send({"t": "err", "text": "Azione admin sconosciuta."})


# ============================================================== messaggi: reazioni, modifica, eliminazione, pin, stato di lettura, ricerca

def community_broadcast(community_id, payload):
    members = fb_get(f"communities/{community_id}/members") or {}
    if isinstance(members, dict):
        for user_id in members:
            send_to(user_id, payload)


def message_scope(conn, m):
    """Risolve l'ambito di un messaggio (DM o canale community) con i controlli di accesso.
    Ritorna (kind, path, info, permissions) o None."""
    if m.get("scope") == "community" or (m.get("community") and m.get("channel")):
        community_id = valid_community_id(m.get("community"))
        channel_id = valid_community_id(m.get("channel"))
        if not community_id or not channel_id:
            return None
        permissions = require_community_permission(conn, community_id, "view_channels", channel_id)
        if not permissions:
            return None
        return ("community", f"communities/{community_id}/messages/{channel_id}",
                {"community": community_id, "channel": channel_id}, permissions)
    other = str(m.get("with", "")).strip().lower()
    if not USERNAME_RE.match(other) or is_blocked(conn.user, other):
        return None
    return ("dm", f"messages/{pair_key(conn.user, other)}", {"with": other}, None)


def scope_notify(kind, info, payload):
    base = {"t": payload.pop("t"), "scope": kind}
    base.update(info)
    base.update(payload)
    return base


def message_update_notify(conn, kind, info, payload):
    """Notifica un aggiornamento messaggio. Nei DM ogni destinatario deve ricevere
    `with` = l'altro partecipante della conversazione (non sempre `info["with"]`)."""
    if kind == "community":
        community_broadcast(info["community"], scope_notify(kind, info, dict(payload)))
        return
    peer = info["with"]
    for recipient, other in ((conn.user, peer), (peer, conn.user)):
        send_to(recipient, scope_notify(kind, {"with": other}, dict(payload)))


def handle_msg_edit(conn, m):
    target = message_scope(conn, m)
    if not target:
        return
    kind, path, info, _ = target
    mid = str(m.get("id", ""))[:80]
    text = str(m.get("text", "")).strip()[:MAX_TEXT]
    enc = clean_enc(m.get("enc"))
    if m.get("enc") is not None and enc is None:
        return conn.send({"t": "err", "text": "Messaggio cifrato non valido."})
    if kind != "dm" and enc:
        return conn.send({"t": "err", "text": "La cifratura end-to-end è disponibile solo nei messaggi diretti."})
    if not mid or (not text and not enc):
        return
    msg = fb_get(f"{path}/{mid}")
    if not isinstance(msg, dict) or msg.get("from") != conn.user or msg.get("deleted"):
        return conn.send({"t": "err", "text": "Puoi modificare solo i tuoi messaggi."})
    edits = push_edit_history(msg)
    update = {"edited": True, "edits": edits}
    if kind == "dm" and enc:
        update["text"] = ""
        update["enc"] = enc
    elif kind == "dm":
        update["text"] = text
        update["enc"] = None
    else:
        update["text"] = text
    fb_update(f"{path}/{mid}", update)
    message_update_notify(conn, kind, info,
                          {"t": "msg_updated", "id": mid, "text": text, "enc": enc,
                           "edited": True, "edits": edits})


def handle_msg_delete(conn, m):
    target = message_scope(conn, m)
    if not target:
        return
    kind, path, info, permissions = target
    mid = str(m.get("id", ""))[:80]
    if not mid:
        return
    msg = fb_get(f"{path}/{mid}")
    if not isinstance(msg, dict) or msg.get("deleted"):
        return conn.send({"t": "err", "text": "Messaggio non trovato."})
    allowed = msg.get("from") == conn.user
    if kind == "community" and not allowed:
        allowed = bool(permissions.get("manage_messages") or permissions.get("administrator"))
    if not allowed:
        return conn.send({"t": "err", "text": "Non puoi eliminare questo messaggio."})
    fb_update(f"{path}/{mid}", {"deleted": True, "text": "", "voice": None,
                                "attachment": None, "poll": None})
    clear_expiry(path, mid)
    message_update_notify(conn, kind, info, {"t": "msg_deleted", "id": mid})


def handle_msg_react(conn, m):
    target = message_scope(conn, m)
    if not target:
        return
    kind, path, info, _ = target
    mid = str(m.get("id", ""))[:80]
    emoji = str(m.get("emoji", "")).strip()[:16]
    if not mid or not emoji:
        return
    msg = fb_get(f"{path}/{mid}")
    if not isinstance(msg, dict) or msg.get("deleted"):
        return conn.send({"t": "err", "text": "Messaggio non trovato."})
    reactions = msg.get("reactions") if isinstance(msg.get("reactions"), dict) else {}
    reactions = {k: [u for u in (v if isinstance(v, list) else []) if isinstance(u, str)]
                 for k, v in reactions.items()}
    users = reactions.get(emoji, [])
    if conn.user in users:
        users = [u for u in users if u != conn.user]
    else:
        users = users + [conn.user]
    if users:
        reactions[emoji] = users
    else:
        reactions.pop(emoji, None)
    fb_update(f"{path}/{mid}", {"reactions": reactions})
    message_update_notify(conn, kind, info,
                          {"t": "msg_reactions", "id": mid, "reactions": reactions})


def handle_msg_pin(conn, m):
    target = message_scope(conn, m)
    if not target:
        return
    kind, path, info, permissions = target
    mid = str(m.get("id", ""))[:80]
    pinned = bool(m.get("pinned", True))
    if not mid:
        return
    msg = fb_get(f"{path}/{mid}")
    if not isinstance(msg, dict) or msg.get("deleted"):
        return conn.send({"t": "err", "text": "Messaggio non trovato."})
    if kind == "community" and not (permissions.get("manage_messages") or permissions.get("administrator")):
        return conn.send({"t": "err", "text": "Non puoi fissare messaggi in questo canale."})
    fb_update(f"{path}/{mid}", {"pinned": True} if pinned else {"pinned": None})
    message_update_notify(conn, kind, info, {"t": "msg_pinned", "id": mid, "pinned": pinned})


def handle_msg_vote(conn, m):
    """Voto su una sonda: `option` = indice. Scelta singola sposta il voto,
    scelta multipla aggiunge/toglie."""
    target = message_scope(conn, m)
    if not target:
        return
    kind, path, info, _ = target
    mid = str(m.get("id", ""))[:80]
    try:
        index = int(m.get("option"))
    except (TypeError, ValueError):
        return
    if not mid:
        return
    msg = fb_get(f"{path}/{mid}")
    poll = msg.get("poll") if isinstance(msg, dict) else None
    if not isinstance(poll, dict) or not isinstance(poll.get("options"), list):
        return conn.send({"t": "err", "text": "Messaggio non trovato."})
    options = []
    for entry in poll["options"][:10]:
        if not isinstance(entry, dict):
            continue
        votes = [u for u in (entry.get("votes") or []) if isinstance(u, str)]
        options.append({"text": str(entry.get("text", ""))[:80], "votes": votes})
    if not (0 <= index < len(options)):
        return
    multiple = bool(poll.get("multiple"))
    mine = [i for i, o in enumerate(options) if conn.user in o["votes"]]
    if conn.user in options[index]["votes"]:
        options[index]["votes"] = [u for u in options[index]["votes"] if u != conn.user]
    else:
        if not multiple:
            for i in mine:
                options[i]["votes"] = [u for u in options[i]["votes"] if u != conn.user]
        options[index]["votes"].append(conn.user)
    clean_poll_data = {"q": str(poll.get("q", ""))[:200], "options": options,
                       "multiple": multiple}
    fb_update(f"{path}/{mid}", {"poll": clean_poll_data})
    message_update_notify(conn, kind, info, {"t": "msg_poll", "id": mid, "poll": clean_poll_data})


def handle_msg_expire(conn, m):
    """Auto-eliminazione: `ttl` in secondi (0 = disattiva). Solo l'autore o un
    moderatore community puo' impostarla."""
    target = message_scope(conn, m)
    if not target:
        return
    kind, path, info, permissions = target
    mid = str(m.get("id", ""))[:80]
    ttl = m.get("ttl")
    ttl = int(ttl) if isinstance(ttl, (int, float)) and not isinstance(ttl, bool) else 0
    if not mid:
        return
    msg = fb_get(f"{path}/{mid}")
    if not isinstance(msg, dict) or msg.get("deleted"):
        return conn.send({"t": "err", "text": "Messaggio non trovato."})
    allowed = msg.get("from") == conn.user
    if kind == "community" and not allowed:
        allowed = bool(permissions.get("manage_messages") or permissions.get("administrator"))
    if not allowed:
        return conn.send({"t": "err", "text": "Non puoi modificare questo messaggio."})
    if ttl:
        if not (60 <= ttl <= MAX_TTL_SECONDS):
            return conn.send({"t": "err", "text": "Scadenza non valida."})
        expires_at = now() + ttl
        fb_update(f"{path}/{mid}", {"expires_at": expires_at})
        if kind == "community":
            register_expiry("community", path, mid, expires_at,
                            {"community": info["community"], "channel": info["channel"]})
        else:
            register_expiry("dm", path, mid, expires_at,
                            {"a": msg.get("from"), "b": msg.get("to") or info["with"]})
    else:
        expires_at = None
        fb_update(f"{path}/{mid}", {"expires_at": None})
        clear_expiry(path, mid)
    message_update_notify(conn, kind, info,
                          {"t": "msg_expire", "id": mid, "expires_at": expires_at})


def handle_typing(conn, m):
    if m.get("community") and m.get("channel"):
        community_id = valid_community_id(m.get("community"))
        channel_id = valid_community_id(m.get("channel"))
        if not community_id or not channel_id:
            return
        permissions = community_permissions(community_id, conn.user, channel_id)
        if not (permissions.get("view_channels") or permissions.get("administrator")):
            return
        community_broadcast(community_id, {"t": "typing", "community": community_id,
                                           "channel": channel_id, "from": conn.user})
        return
    other = str(m.get("with", "")).strip().lower()
    if USERNAME_RE.match(other) and not is_blocked(conn.user, other):
        send_to(other, {"t": "typing", "from": conn.user})


def read_marker_set(user, scope_path, ts):
    path = f"read_markers/{user}/{scope_path}"
    current = fb_get(path)
    if not isinstance(current, (int, float)) or ts > current:
        fb_set(path, ts)


def handle_msg_read(conn, m):
    ts = m.get("ts")
    ts = int(ts) if isinstance(ts, (int, float)) and not isinstance(ts, bool) else now()
    ts = max(0, min(ts, now()))
    if m.get("community") and m.get("channel"):
        community_id = valid_community_id(m.get("community"))
        channel_id = valid_community_id(m.get("channel"))
        if not community_id or not channel_id:
            return
        read_marker_set(conn.user, f"c/{community_id}/{channel_id}", ts)
        return
    other = str(m.get("with", "")).strip().lower()
    if not USERNAME_RE.match(other):
        return
    read_marker_set(conn.user, f"dm/{other}", ts)
    if not is_blocked(conn.user, other):
        send_to(other, {"t": "read_receipt", "from": conn.user, "ts": ts})


def handle_msg_search(conn, m):
    query = str(m.get("q", "")).strip().lower()[:100]
    if len(query) < 2:
        return conn.send({"t": "msg_search", "q": query, "results": []})
    target = message_scope(conn, m)
    if not target:
        return conn.send({"t": "msg_search", "q": query, "results": []})
    kind, path, info, _ = target
    matches = []
    for key, value in fb_last(path, 500):
        if not isinstance(value, dict) or value.get("deleted"):
            continue
        text = str(value.get("text", ""))
        if query in search_haystack(value):
            poll = value.get("poll") if isinstance(value.get("poll"), dict) else None
            att = value.get("attachment") if isinstance(value.get("attachment"), dict) else None
            snippet = text[:200] or (
                f"[Sondaggio] {str(poll.get('q', ''))[:120]}" if poll
                else f"[Allegato] {str(att.get('name', ''))[:120]}" if att else "")
            matches.append({
                "id": key, "from": value.get("from"), "text": snippet,
                "ts": value.get("ts") or value.get("timestamp"),
            })
    matches = matches[-50:][::-1]
    conn.send({"t": "msg_search", "q": query, "results": matches, "scope": kind, **info})


def handle_msg_get(conn, m):
    target = message_scope(conn, m)
    if not target:
        return conn.send({"t": "err", "text": "Messaggio non trovato."})
    kind, path, info, _ = target
    mid = str(m.get("id", ""))[:80]
    msg = fb_get(f"{path}/{mid}")
    if not isinstance(msg, dict):
        return conn.send({"t": "err", "text": "Messaggio non trovato."})
    conn.send({"t": "msg_result", "scope": kind, **info,
               "message": dict(msg, id=mid)})


# ============================================================== preferiti (bookmark)

def bookmark_base(kind, info):
    return f"dm/{info['with']}" if kind == "dm" else f"c/{info['community']}/{info['channel']}"


def handle_bookmark(conn, m, action):
    target = message_scope(conn, m)
    if not target:
        return conn.send({"t": "err", "text": "Conversazione non trovata."})
    kind, path, info, _ = target
    base = f"bookmarks/{conn.user}/{bookmark_base(kind, info)}"
    if action == "list":
        raw = fb_get(base) or {}
        items = [dict(v, id=k) for k, v in raw.items() if isinstance(v, dict)] \
            if isinstance(raw, dict) else []
        items.sort(key=lambda item: item.get("ts", 0), reverse=True)
        conn.send({"t": "bookmark_list", "scope": kind, **info,
                   "items": items[:100]})
        return
    mid = str(m.get("id", ""))[:80]
    if not mid:
        return
    if action == "add":
        msg = fb_get(f"{path}/{mid}")
        if not isinstance(msg, dict) or msg.get("deleted"):
            return conn.send({"t": "err", "text": "Messaggio non trovato."})
        snap = {
            "from": msg.get("from"), "text": str(msg.get("text", ""))[:200],
            "enc": msg.get("enc"),
            "ts": msg.get("ts") or msg.get("timestamp") or now(),
            "has_attachment": bool(msg.get("attachment")),
            "has_voice": bool(msg.get("voice")),
            "has_poll": bool(msg.get("poll")),
        }
        fb_set(f"{base}/{mid}", snap)
        conn.send({"t": "bookmark_saved", "scope": kind, **info, "id": mid})
    else:
        fb_delete(f"{base}/{mid}")
        conn.send({"t": "bookmark_removed", "scope": kind, **info, "id": mid})


# ============================================================== messaggi programmati: lista/cancellazione

def scheduled_item_public(item, sid):
    kind = item.get("kind")
    return {
        "id": sid, "kind": kind, "send_at": item.get("send_at"),
        "text": str(item.get("text", ""))[:80],
        "with": item.get("to") if kind == "dm" else None,
        "community": item.get("community") if kind == "community" else None,
        "channel": item.get("channel") if kind == "community" else None,
        "has_poll": bool(item.get("poll")),
        "has_attachment": bool(item.get("attachment")),
        "has_voice": bool(item.get("voice")),
    }


def handle_scheduled_list(conn, m):
    raw = fb_get("scheduled") or {}
    items = [scheduled_item_public(v, k) for k, v in raw.items()
             if isinstance(v, dict) and v.get("from") == conn.user]
    items.sort(key=lambda item: item.get("send_at") or 0)
    conn.send({"t": "scheduled_list", "items": items[:100]})


def handle_scheduled_cancel(conn, m):
    sid = str(m.get("id", ""))[:80]
    item = fb_get(f"scheduled/{sid}")
    if not isinstance(item, dict) or item.get("from") != conn.user:
        return conn.send({"t": "err", "text": "Messaggio programmato non trovato."})
    fb_delete(f"scheduled/{sid}")
    conn.send({"t": "scheduled_cancelled", "id": sid})


# ============================================================== bozze sincronizzate tra dispositivi

DRAFT_TEXT_MAX = 4000
DRAFT_KEY_RE = re.compile(r"^[A-Za-z0-9:_.\-]{1,120}$")


def draft_scope_key(m):
    key = str(m.get("scope_key", ""))
    return key if DRAFT_KEY_RE.match(key) else None


def handle_draft_save(conn, m):
    scope_key = draft_scope_key(m)
    if not scope_key:
        return conn.send({"t": "err", "text": "Bozza non valida."})
    text = str(m.get("text", ""))[:DRAFT_TEXT_MAX]
    if text.strip():
        fb_set(f"drafts/{conn.user}/{scope_key}", {"text": text, "ts": now()})
    else:
        fb_delete(f"drafts/{conn.user}/{scope_key}")
    conn.send({"t": "draft_saved", "scope_key": scope_key})


def handle_draft_list(conn, m):
    raw = fb_get(f"drafts/{conn.user}") or {}
    drafts = {k: v.get("text", "") for k, v in raw.items()
              if isinstance(v, dict) and isinstance(v.get("text"), str)} \
        if isinstance(raw, dict) else {}
    conn.send({"t": "draft_list", "drafts": drafts})


# ============================================================== TTL di conversazione (DM)

def conv_dm_ttl(a, b):
    value = fb_get(f"dm_ttl/{pair_key(a, b)}")
    if isinstance(value, (int, float)) and not isinstance(value, bool) \
            and 60 <= int(value) <= MAX_TTL_SECONDS:
        return int(value)
    return None


def handle_conv_ttl(conn, m):
    other = str(m.get("with", "")).strip().lower()
    if not USERNAME_RE.match(other):
        return conn.send({"t": "err", "text": "Conversazione non valida."})
    ttl = m.get("ttl")
    ttl = int(ttl) if isinstance(ttl, (int, float)) and not isinstance(ttl, bool) else 0
    if ttl:
        if not (60 <= ttl <= MAX_TTL_SECONDS):
            return conn.send({"t": "err", "text": "Scadenza non valida."})
        fb_set(f"dm_ttl/{pair_key(conn.user, other)}", ttl)
    else:
        fb_delete(f"dm_ttl/{pair_key(conn.user, other)}")
    conn.send({"t": "conv_ttl", "with": other, "ttl": ttl or None})


# ============================================================== ricerca globale

def search_haystack(value):
    """Testo ricercabile di un messaggio: corpo + poll + allegato."""
    parts = [str(value.get("text", ""))]
    poll = value.get("poll")
    if isinstance(poll, dict):
        parts.append(str(poll.get("q", "")))
        parts.extend(str(o.get("text", "")) for o in poll.get("options") or []
                     if isinstance(o, dict))
    att = value.get("attachment")
    if isinstance(att, dict):
        parts.append(str(att.get("name", "")))
    return " ".join(parts).lower()


def global_search_matches(path, query, limit=40):
    out = []
    for key, value in fb_last(path, 200):
        if not isinstance(value, dict) or value.get("deleted"):
            continue
        hay = search_haystack(value)
        if query in hay:
            poll = value.get("poll") if isinstance(value.get("poll"), dict) else None
            out.append({
                "id": key, "from": value.get("from"),
                "text": str(value.get("text", ""))[:200] or (f"[Sondaggio] {poll.get('q','')[:120]}" if poll else ""),
                "ts": value.get("ts") or value.get("timestamp"),
                "has_poll": bool(poll),
            })
    return out[-limit:][::-1]


def handle_global_search(conn, m):
    query = str(m.get("q", "")).strip().lower()[:100]
    if len(query) < 2:
        return conn.send({"t": "global_search", "q": query, "results": []})
    results = []
    contacts = fb_get(f"contacts/{conn.user}") or {}
    if isinstance(contacts, dict):
        for cid in list(contacts)[:60]:
            for hit in global_search_matches(f"messages/{pair_key(conn.user, cid)}", query, 15):
                results.append({"scope": "dm", "with": cid, **hit})
    mine = fb_get(f"users/{conn.user}/communities") or {}
    member_of = list(mine)[:40] if isinstance(mine, dict) else []
    for cid in member_of:
        channels = fb_get(f"communities/{cid}/channels") or {}
        if not isinstance(channels, dict):
            continue
        for chan in list(channels)[:30]:
            for hit in global_search_matches(
                    f"communities/{cid}/messages/{chan}", query, 10):
                results.append({"scope": "community", "community": cid,
                                "channel": chan, **hit})
    results.sort(key=lambda r: r.get("ts") or 0, reverse=True)
    conn.send({"t": "global_search", "q": query, "results": results[:50]})


# ============================================================== storico delle modifiche

MAX_EDIT_HISTORY = 5


def push_edit_history(msg):
    """Aggiunge la versione precedente del testo allo storico (max 5 voci)."""
    prev = str(msg.get("text") or "")
    if not prev and msg.get("enc"):
        prev = "[messaggio cifrato]"
    history = list(msg.get("edits") or [])
    if isinstance(history, list):
        history.append({"text": prev[:MAX_TEXT], "ts": now()})
        return history[-MAX_EDIT_HISTORY:]
    return [{"text": prev[:MAX_TEXT], "ts": now()}]


# ============================================================== stati temporanei (24h) e badge verificati

STATUS_TTL = 24 * 3600
STATUS_TEXT_MAX = 200
STATUS_MAX_PER_USER = 10
VERIFICATION_TIERS = {"blue": 10, "black": 25, "rainbow": 50}   # €/mese, simulato


def verification_tier(key):
    rec = fb_get(f"users/{key}/verification")
    tier = rec.get("tier") if isinstance(rec, dict) else None
    return tier if tier in VERIFICATION_TIERS else None


def active_statuses(user_id):
    """Stati non scaduti di un utente (max STATUS_MAX_PER_USER, i piu' recenti)."""
    raw = fb_get(f"statuses/{user_id}") or {}
    if not isinstance(raw, dict):
        return []
    now_ts = now()
    out = [dict(item, id=sid) for sid, item in raw.items()
           if isinstance(item, dict) and item.get("expires_at", 0) > now_ts]
    out.sort(key=lambda item: item.get("ts", 0), reverse=True)
    return out[:STATUS_MAX_PER_USER]


def status_contacts(key):
    """Contatti dell'utente con almeno uno stato attivo: {user_id: [stati]}."""
    raw = fb_get(f"contacts/{key}") or {}
    result = {}
    if isinstance(raw, dict):
        for cid in raw:
            sts = active_statuses(cid)
            if sts:
                result[cid] = sts
    return result


def notify_status_contacts(user_id):
    for cid in (fb_get(f"contacts/{user_id}") or {}):
        send_to(cid, {"t": "status_update", "user": user_id})


def handle_status_post(conn, m):
    text = str(m.get("text", "")).strip()[:STATUS_TEXT_MAX]
    if not text:
        return conn.send({"t": "err", "text": "Testo dello stato non valido."})
    ref = firebase_ref(f"statuses/{conn.user}").push({
        "text": text, "ts": now(), "expires_at": now() + STATUS_TTL})
    notify_status_contacts(conn.user)
    conn.send({"t": "status_posted", "id": ref.key})


def handle_status_delete(conn, m):
    mid = str(m.get("id", ""))[:80]
    if not mid or fb_get(f"statuses/{conn.user}/{mid}") is None:
        return conn.send({"t": "err", "text": "Stato non trovato."})
    fb_delete(f"statuses/{conn.user}/{mid}")
    notify_status_contacts(conn.user)
    conn.send({"t": "status_deleted", "id": mid})


def handle_status_list(conn, m):
    # purge pigra degli stati scaduti del proprio account
    raw = fb_get(f"statuses/{conn.user}") or {}
    if isinstance(raw, dict):
        for sid, item in raw.items():
            if isinstance(item, dict) and item.get("expires_at", 0) <= now():
                fb_delete(f"statuses/{conn.user}/{sid}")
    conn.send({"t": "status_list", "mine": active_statuses(conn.user),
               "contacts": status_contacts(conn.user)})


def handle_badge_update(conn, m):
    """Badge verificato a pagamento (simulato): blue 10€, black 25€, rainbow 50€/mese."""
    action = m.get("action")
    if action == "cancel":
        fb_delete(f"users/{conn.user}/verification")
    else:
        tier = str(m.get("tier", ""))
        if tier not in VERIFICATION_TIERS:
            return conn.send({"t": "err", "text": "Livello badge non valido."})
        fb_set(f"users/{conn.user}/verification", {"tier": tier, "since": now()})
    profile = public_profile(conn.user)
    broadcast({"t": "profile_update", "profile": profile})
    broadcast({"t": "USER_UPDATED", "id": conn.user, "profile": profile})
    conn.send(settings_snapshot(conn))


# ============================================================== scheduled messages & scadenze

def deliver_scheduled(item):
    """Recapita un messaggio programmato, riverificando i permessi all'invio."""
    kind = item.get("kind")
    sender = item.get("from")
    if not sender:
        return
    if kind == "dm":
        to = str(item.get("to", "")).strip().lower()
        err = dm_policy_error(sender, to) if USERNAME_RE.match(to or "") else "Utente non trovato."
        if err:
            send_to(sender, {"t": "err", "text": f"Messaggio programmato non inviato: {err}"})
            return
        conv_ttl = conv_dm_ttl(sender, to)
        expires_at = item.get("expires_at") or (now() + conv_ttl if conv_ttl else None)
        store_message(sender, to, str(item.get("text", ""))[:MAX_TEXT],
                      voice=item.get("voice"), attachment=item.get("attachment"),
                      reply_to=item.get("reply_to"),
                      forwarded_from=item.get("forwarded_from"),
                      poll=item.get("poll"), expires_at=expires_at,
                      enc=item.get("enc"))
        send_to(sender, {"t": "msg_scheduled_sent", "scope": "dm", "with": to})
    elif kind == "community":
        community_id = valid_community_id(item.get("community"))
        channel_id = valid_community_id(item.get("channel"))
        if not community_id or not channel_id:
            return
        permissions = community_permissions(community_id, sender, channel_id)
        if not (permissions.get("view_channels") or permissions.get("administrator")) \
                or not (permissions.get("send_messages") or permissions.get("administrator")):
            send_to(sender, {"t": "err", "text": "Messaggio programmato non inviato: permessi revocati."})
            return
        community_deliver(community_id, channel_id, sender, {
            "text": str(item.get("text", ""))[:MAX_TEXT],
            "voice": item.get("voice"), "attachment": item.get("attachment"),
            "poll": item.get("poll"), "reply_to": item.get("reply_to"),
            "forwarded_from": item.get("forwarded_from"),
            "expires_at": item.get("expires_at"),
        })
        send_to(sender, {"t": "msg_scheduled_sent", "scope": "community",
                         "community": community_id, "channel": channel_id})


def expire_message(item):
    """Elimina un messaggio scaduto e notifica i partecipanti."""
    path, mid = item.get("path"), str(item.get("id", ""))[:80]
    if not path or not mid or "/" in mid or mid.startswith("."):
        return
    if not (path.startswith("messages/") or path.startswith("communities/")):
        return
    msg = fb_get(f"{path}/{mid}")
    if not isinstance(msg, dict) or msg.get("deleted"):
        return
    fb_update(f"{path}/{mid}", {"deleted": True, "text": "", "voice": None,
                                "attachment": None, "poll": None})
    if item.get("kind") == "community":
        community_broadcast(item.get("community"), {
            "t": "msg_deleted", "scope": "community",
            "community": item.get("community"), "channel": item.get("channel"),
            "id": mid})
    else:
        a, b = item.get("a"), item.get("b")
        if a and b:
            for recipient, other in ((a, b), (b, a)):
                send_to(recipient, {"t": "msg_deleted", "scope": "dm", "with": other, "id": mid})


def maintenance_loop():
    """Sweeper: consegna i messaggi programmati e applica le scadenze. Gira ogni 10s."""
    while True:
        try:
            for key, item in fb_due("scheduled", "send_at"):
                fb_delete(f"scheduled/{key}")
                try:
                    deliver_scheduled(item)
                except Exception as e:
                    log(f"Consegna programmata fallita: {e!r}")
            for key, item in fb_due("expiring", "expires_at"):
                fb_delete(f"expiring/{key}")
                try:
                    expire_message(item)
                except Exception as e:
                    log(f"Scadenza messaggio fallita: {e!r}")
        except Exception as e:
            log(f"Manutenzione fallita: {e!r}")
        time.sleep(10)


# ============================================================== anteprime link

link_preview_cache = {}
LINK_PREVIEW_TTL = 3600
LINK_PREVIEW_MAX = 50


def meta_content(html, prop):
    for match in re.finditer(r"<meta\b[^>]*>", html, re.I):
        tag = match.group(0).lower()
        if prop not in tag:
            continue
        content = re.search(r"content=[\"']([^\"']*)", tag, re.I)
        if content:
            return content.group(1).strip()[:300]
    return None


def fetch_link_preview(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    host = parsed.hostname.lower()
    if host == "localhost" or host.endswith(".local") or host.endswith(".internal"):
        return None
    try:
        request = urllib.request.Request(url, headers={
            "User-Agent": "CiaoChatLinkPreview/1.0", "Accept": "text/html",
        })
        with urllib.request.urlopen(request, timeout=6) as response:
            if "html" not in (response.headers.get("Content-Type") or ""):
                return None
            html = response.read(400_000).decode("utf-8", "replace")
    except (OSError, ValueError, urllib.error.URLError):
        return None
    title = (meta_content(html, "og:title") or meta_content(html, "twitter:title")
             or (re.search(r"<title[^>]*>([^<]+)", html, re.I) or [None, ""])[1].strip())
    description = (meta_content(html, "og:description") or meta_content(html, "description")
                   or meta_content(html, "twitter:description"))
    image = meta_content(html, "og:image") or meta_content(html, "twitter:image")
    if image and image.startswith("/"):
        image = urllib.parse.urljoin(url, image)
    if not title and not description:
        return None
    return {"title": title[:300] if title else "", "description": (description or "")[:500],
            "image": image[:1000] if image else None}


def handle_link_preview(conn, m):
    url = str(m.get("url", ""))[:2000].strip()
    if not url.startswith(("http://", "https://")):
        return
    cached = link_preview_cache.get(url)
    if cached and time.time() - cached[0] < LINK_PREVIEW_TTL:
        return conn.send({"t": "link_preview", "url": url, "preview": cached[1]})
    preview = fetch_link_preview(url)
    if len(link_preview_cache) >= LINK_PREVIEW_MAX:
        link_preview_cache.clear()
    link_preview_cache[url] = (time.time(), preview)
    conn.send({"t": "link_preview", "url": url, "preview": preview})


def handle_profile_customization(conn, m):
    color = str(m.get("name_color", ""))
    animation = str(m.get("name_animation", ""))
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", color) or animation not in NAME_ANIMATIONS:
        return conn.send({"t": "err", "text": "Stile del nome non valido."})
    if animation == "rainbow" and verification_tier(conn.user) not in ("black", "rainbow"):
        return conn.send({"t": "err", "text": "L'animazione arcobaleno richiede il badge Nero o Arcobaleno."})
    fb_update(f"users/{conn.user}", {"name_color": color.lower(), "name_animation": animation})
    profile = public_profile(conn.user)
    broadcast({"t": "profile_update", "profile": profile})
    broadcast({"t": "USER_UPDATED", "id": conn.user, "profile": profile})


# ============================================================== file multimediali
def media_path(h):
    return os.path.join(MEDIA_DIR, h + ".bin")


PROFILE_MEDIA_MIMES = {
    "jpg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
    "mp4": "video/mp4",
    "gif": "image/gif",
}

# Documenti e audio scaricabili: l'estensione dichiara il tipo, i magic byte lo verificano.
FILE_ATTACHMENT_MIMES = {
    "pdf": "application/pdf",
    "txt": "text/plain",
    "md": "text/markdown",
    "csv": "text/csv",
    "json": "application/json",
    "zip": "application/zip",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "mp3": "audio/mpeg",
    "ogg": "audio/ogg",
    "wav": "audio/wav",
}
ZIP_FAMILY = {"zip", "docx", "xlsx", "pptx"}
ATTACHMENT_MIMES = frozenset(PROFILE_MEDIA_MIMES.values()) | frozenset(FILE_ATTACHMENT_MIMES.values())


def profile_media_mime(data):
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return "video/mp4"
    return None


def looks_like_wav(data):
    return data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def file_attachment_mime(data, extension):
    """Mime di un allegato generico, verificato sui magic byte (None se non corrisponde)."""
    mime = FILE_ATTACHMENT_MIMES.get(extension)
    if mime is None or not data:
        return None
    if extension == "pdf":
        return mime if data.startswith(b"%PDF") else None
    if extension in ZIP_FAMILY:
        return mime if data.startswith(b"PK\x03\x04") else None
    if extension == "mp3":
        return mime if data.startswith(b"ID3") or data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2") else None
    if extension == "ogg":
        return mime if data.startswith(b"OggS") else None
    if extension == "wav":
        return mime if looks_like_wav(data) else None
    if extension in ("txt", "md", "csv", "json"):
        if b"\x00" in data[:4096]:
            return None
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            return None
        return mime
    return None


def sniff_media_mime(data):
    """Mime di un file memorizzato senza estensione: media noti, poi WAV."""
    mime = profile_media_mime(data)
    if mime:
        return mime
    if looks_like_wav(data):
        return "audio/wav"
    if data.startswith(b"%PDF"):
        return "application/pdf"
    if data.startswith(b"PK\x03\x04"):
        return "application/zip"
    if data.startswith(b"ID3") or data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "audio/mpeg"
    if data.startswith(b"OggS"):
        return "audio/ogg"
    return None


def stored_media_mime(media_hash, data):
    """Mime registrato all'upload in media_meta/, altrimenti ricavato dal contenuto."""
    meta = fb_get(f"media_meta/{media_hash}")
    if isinstance(meta, dict) and isinstance(meta.get("mime"), str):
        return meta["mime"]
    return sniff_media_mime(data)


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
    community_media = fb_get("community_media") or {}
    if isinstance(community_media, dict):
        for rec in community_media.values():
            if isinstance(rec, dict):
                keep.update(x for x in rec.values() if x)
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
        return conn.send({"t": "media", "hash": h, "mime": stored_media_mime(h, data),
                          "data": base64.b64encode(data).decode("ascii")})

    kind = m.get("kind")
    community_id = valid_community_id(m.get("community")) if kind in (
        "community_icon", "community_banner"
    ) else None
    if kind in ("community_icon", "community_banner"):
        if not community_id or not require_community_permission(conn, community_id, "manage_community"):
            return
        if not community_record(community_id):
            return conn.send({"t": "err", "text": "Gruppo non trovato."})
    elif kind not in ("avatar", "banner", "voice", "attachment", "enc"):
        return conn.send({"t": "err", "text": "Tipo di file non supportato."})
    try:
        data = base64.b64decode(str(m.get("data", "")), validate=True)
    except (binascii.Error, ValueError):
        return conn.send({"t": "err", "text": "File non leggibile."})
    extension = str(m.get("extension", "")).lower().removeprefix(".")
    mime = None
    if kind == "voice":
        valid = bool(data) and len(data) <= MAX_VOICE and looks_like_wav(data)
        mime = "audio/wav" if valid else None
    elif extension in PROFILE_MEDIA_MIMES:
        expected_mime = PROFILE_MEDIA_MIMES[extension]
        valid = (
            bool(data) and len(data) <= MAX_PROFILE_MEDIA
            and profile_media_mime(data) == expected_mime
        )
        mime = expected_mime if valid else None
    elif kind == "attachment" and extension in FILE_ATTACHMENT_MIMES:
        mime = file_attachment_mime(data, extension)
        valid = bool(mime) and len(data) <= MAX_PROFILE_MEDIA
    elif kind == "enc":
        # Blob cifrato end-to-end: nessun magic byte, nessuna estensione.
        valid = bool(data) and len(data) <= MAX_PROFILE_MEDIA
        mime = "application/octet-stream" if valid else None
    else:
        valid = False
    if not valid:
        return conn.send({"t": "err", "text": "File rifiutato: immagini, video, documenti o audio (max 1,7 MB)."})
    h = store_media(data)
    if kind in ("avatar", "banner", "voice", "attachment", "enc"):
        fb_set(f"media_meta/{h}", {"mime": mime})
    if kind in ("avatar", "banner"):
        fb_update(f"users/{conn.user}", {kind: h, kind + "_type": extension})
        conn.send({"t": "media_ok", "kind": kind, "hash": h, "extension": extension})
        broadcast({"t": "profile_update", "profile": public_profile(conn.user)})
    elif kind in ("community_icon", "community_banner"):
        field = "icon" if kind == "community_icon" else "banner"
        fb_set(f"communities/{community_id}/meta/{field}", h)
        fb_set(f"community_media/{community_id}/{field}", h)
        audit_community(community_id, conn.user, "community_media_updated", {"field": field})
        conn.send({"t": "media_ok", "kind": kind, "hash": h, "extension": extension})
        send_community_snapshot(conn, community_id)
    else:
        conn.send({"t": "media_ok", "kind": kind, "hash": h, "mime": mime})


def handle_clear_media(conn, m):
    kind = m.get("kind")
    if kind in ("avatar", "banner"):
        fb_delete(f"users/{conn.user}/{kind}")
        fb_delete(f"users/{conn.user}/{kind}_type")
        broadcast({"t": "profile_update", "profile": public_profile(conn.user)})
    elif kind in ("community_icon", "community_banner"):
        community_id = valid_community_id(m.get("community"))
        if community_id and require_community_permission(conn, community_id, "manage_community"):
            field = "icon" if kind == "community_icon" else "banner"
            fb_delete(f"communities/{community_id}/meta/{field}")
            fb_delete(f"community_media/{community_id}/{field}")
            audit_community(community_id, conn.user, "community_media_removed", {"field": field})
            send_community_snapshot(conn, community_id)


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
        to = resolve_user_key(m.get("to"))
        if not to or to == me:
            return err("Non puoi chiamare questo utente.")
        if is_blocked(me, to):
            return err("Non puoi chiamare questo utente.")
        target_rec = fb_get(f"users/{to}") or {}
        policy = privacy_settings(target_rec)["dm_policy"]
        if policy == "friends" and fb_get(f"contacts/{to}/{me}") is None:
            return err("Questo utente accetta chiamate solo dai contatti.")
        if policy == "friends_group" and fb_get(f"contacts/{to}/{me}") is None and not share_community(me, to):
            return err("Questo utente accetta chiamate solo da contatti o membri degli stessi gruppi.")
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
    if conn.user:
        last_touch = getattr(conn, "_last_seen_touch", 0)
        if now() - last_touch > 60:
            conn._last_seen_touch = now()
            touch_last_seen(conn.user)
    if not conn.user:
        if t == "register":
            handle_register(conn, m)
        elif t == "login":
            handle_login(conn, m)
        elif t == "resume":
            handle_resume(conn, m)
        elif t == "admin":
            handle_admin(conn, m)
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
    elif t == "settings_get":
        handle_settings_get(conn, m)
    elif t == "account_update":
        handle_account_update(conn, m)
    elif t == "privacy_update":
        handle_privacy_update(conn, m)
    elif t == "settings_update":
        handle_user_settings_update(conn, m)
    elif t == "relationship_update":
        handle_relationship_update(conn, m)
    elif t == "block_update":
        handle_block_update(conn, m)
    elif t == "session_revoke":
        handle_session_revoke(conn, m)
    elif t == "password_change":
        handle_password_change(conn, m)
    elif t == "two_factor_setup":
        handle_two_factor_setup(conn, m)
    elif t == "two_factor_enable":
        handle_two_factor_enable(conn, m)
    elif t == "two_factor_disable":
        handle_two_factor_disable(conn, m)
    elif t == "profile_customization":
        handle_profile_customization(conn, m)
    elif t in ("media_put", "media_get"):
        handle_media(conn, m)
    elif t == "media_clear":
        handle_clear_media(conn, m)
    elif t == "community_list":
        conn.send({
            "t": "community_list",
            "communities": communities_for_user(conn.user),
            "invitations": community_invitations_for_user(conn.user),
        })
    elif t == "community_create":
        handle_community_create(conn, m)
    elif t == "community_get":
        community_id = valid_community_id(m.get("community"))
        if community_id:
            send_community_snapshot(conn, community_id)
    elif t == "community_update":
        handle_community_update(conn, m)
    elif t == "community_role_create":
        handle_community_role(conn, m, "create")
    elif t == "community_role_update":
        handle_community_role(conn, m, "update")
    elif t == "community_role_delete":
        handle_community_role(conn, m, "delete")
    elif t == "community_roles_reorder":
        handle_community_role(conn, m, "reorder")
    elif t == "community_role_assign":
        handle_community_assign_role(conn, m)
    elif t == "community_channel_create":
        handle_community_channel(conn, m, "create")
    elif t == "community_channel_update":
        handle_community_channel(conn, m, "update")
    elif t == "community_channel_delete":
        handle_community_channel(conn, m, "delete")
    elif t == "community_override_update":
        handle_community_override(conn, m)
    elif t == "community_invite_create":
        handle_community_invite_create(conn, m)
    elif t == "community_member_invite":
        handle_community_member_invite(conn, m)
    elif t == "community_invite_response":
        handle_community_invite_response(conn, m)
    elif t == "community_member_invite_revoke":
        handle_community_member_invite_revoke(conn, m)
    elif t == "community_member_roles":
        handle_community_member_roles(conn, m)
    elif t == "community_invite_revoke":
        handle_community_invite_revoke(conn, m)
    elif t == "community_join":
        handle_community_join(conn, m)
    elif t == "community_ban":
        handle_community_member_action(conn, m, "ban")
    elif t == "community_kick":
        handle_community_member_action(conn, m, "kick")
    elif t == "community_unban":
        handle_community_unban(conn, m)
    elif t == "community_audit_get":
        handle_community_audit(conn, m)
    elif t == "community_channel_send":
        handle_community_channel_send(conn, m)
    elif t == "community_channel_history":
        handle_community_channel_history(conn, m)
    elif t == "msg_edit":
        handle_msg_edit(conn, m)
    elif t == "msg_delete":
        handle_msg_delete(conn, m)
    elif t == "msg_react":
        handle_msg_react(conn, m)
    elif t == "msg_pin":
        handle_msg_pin(conn, m)
    elif t == "msg_vote":
        handle_msg_vote(conn, m)
    elif t == "msg_expire":
        handle_msg_expire(conn, m)
    elif t == "bookmark_add":
        handle_bookmark(conn, m, "add")
    elif t == "bookmark_remove":
        handle_bookmark(conn, m, "remove")
    elif t == "bookmark_list":
        handle_bookmark(conn, m, "list")
    elif t == "typing":
        handle_typing(conn, m)
    elif t == "msg_read":
        handle_msg_read(conn, m)
    elif t == "msg_search":
        handle_msg_search(conn, m)
    elif t == "msg_get":
        handle_msg_get(conn, m)
    elif t == "link_preview":
        handle_link_preview(conn, m)
    elif t == "e2ee_pub":
        handle_e2ee_pub(conn, m)
    elif t == "scheduled_list":
        handle_scheduled_list(conn, m)
    elif t == "scheduled_cancel":
        handle_scheduled_cancel(conn, m)
    elif t == "draft_save":
        handle_draft_save(conn, m)
    elif t == "draft_list":
        handle_draft_list(conn, m)
    elif t == "conv_ttl":
        handle_conv_ttl(conn, m)
    elif t == "global_search":
        handle_global_search(conn, m)
    elif t == "status_post":
        handle_status_post(conn, m)
    elif t == "status_delete":
        handle_status_delete(conn, m)
    elif t == "status_list":
        handle_status_list(conn, m)
    elif t == "badge_update":
        handle_badge_update(conn, m)
    elif t == "admin":
        handle_admin(conn, m)
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
        touch_last_seen(conn.user)
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
        broadcast({"t": "status", "id": conn.user, "online": False, "last_seen": now()})


def main():
    global gateway
    gateway = build_gateway()
    init_firebase()
    cleanup_media()
    threading.Thread(target=maintenance_loop, daemon=True).start()
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