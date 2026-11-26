# CiaoChat-APP
Chatting app italiana con interfaccia basata su Discord e Whatsapp combianandone tutte le funzioni più richieste

## Windows

Scarica `CiaoChat-Setup.exe` dall'ultima release GitHub, oppure esegui:

```powershell
git clone https://github.com/larpsum/CiaoChat-APP.git
cd CiaoChat-APP
py -m pip install -r requirements.txt pyinstaller
py -m PyInstaller CiaoChat.spec --clean --noconfirm
.\dist\CiaoChat.exe
```

L'eseguibile avvia il server chat sulla porta `5555`, la web UI sulla porta `8080` e apre CiaoChat nel browser predefinito.

### Credenziali Firebase

Per usare l'app serve una chiave Firebase Realtime Database. Salva il file scaricato da Firebase Console come:

```text
serviceAccountKey.json
```

accanto a `server.py` durante l'esecuzione dal sorgente. Nell'installazione Windows salvalo in `%LOCALAPPDATA%\CiaoChat\serviceAccountKey.json`. In alternativa, imposta la variabile d'ambiente `PYCHAT_SERVICE_ACCOUNT` con il percorso completo del file.

## Personalizzazione del profilo

Dal pulsante **Personalizza profilo** puoi caricare immagini profilo e banner nei formati JPG, PNG, WEBP, MP4 o GIF (massimo 1,7 MB ciascuno), scegliere il colore del nome e attivare un'animazione. Il server verifica sia l'estensione sia il contenuto del file.

La registrazione richiede un indirizzo email e una password.

## Gruppi, partecipanti e tema

I gruppi sono selezionabili dalla barra laterale. Canali e directory dei partecipanti restano nella vista a tre pannelli; inviti, selezione dei ruoli, modifica dei ruoli e rimozione dei membri avvengono in linea nel pannello destro. Le operazioni sono validate dal server secondo permessi e gerarchia dei ruoli.

Il composer supporta ricerca contatti, formattazione, emoji, menzioni e invio di allegati JPG, PNG, WEBP, GIF e MP4 (massimo 1,7 MB). Le chiamate gestiscono inviti e segnalazione; il trasporto audio/video non è ancora disponibile.

Le emoji Unicode sono visualizzate con gli asset SVG Twemoji inclusi nell'app, anche nel composer e nel selettore, senza dipendere dal font emoji di Windows. Le immagini Twemoji sono distribuite secondo CC BY 4.0; il parser secondo MIT. Attribuzione e testi di licenza sono in `static/emoji/LICENSE-CC-BY-4.0` e `static/TWEMOJI-LICENSE-MIT`. Asset e parser da [Twemoji 17.0.3](https://github.com/discord/twemoji), copyright Twitter, Inc. e contributori.

Il tema chiaro è disponibile in **Impostazioni > Aspetto & Testo**. Le icone dell'interfaccia usano il foglio di stile ufficiale Phosphor Web, caricato da unpkg.

Le API HTTP locali sono disponibili sotto `/api/`. Richiedono `Authorization: Bearer <token>` e `X-CiaoChat-User: <username>`; comprendono le impostazioni utente, gruppi, ruoli, canali, inviti, membri, ban e audit log. Le richieste vengono inoltrate al server chat e usano le stesse verifiche di permesso del protocollo WebSocket.

## Crittografia end-to-end (DM)

I messaggi di testo nelle chat dirette (DM) possono essere cifrati end-to-end: il server memorizza e inoltra solo ciphertext opaco e non può leggere il contenuto.

- Ogni client genera una coppia di chiavi ECDH P-256; la chiave pubblica viene pubblicata nel profilo (`e2ee_pub`).
- La chiave simmetrica di conversazione deriva dallo scambio ECDH con la chiave pubblica del contatto (AES-256-GCM, IV casuale per messaggio).
- Cifrati: testo dei DM (inclusi invio, modifica, inoltro e cronologia). In chiaro restano: orario, mittente/destinatario, reazioni, pin, stato di lettura.
- **Non coperti**: canali community, sondaggi, allegati, messaggi vocali e preview dei link — per questi il server vede ancora i contenuti.
- Nel profilo del contatto compare la sezione "Sicurezza" con il numero di sicurezza da verificare fuori banda; ogni messaggio cifrato mostra un lucchetto nei metadati.
- Le chiavi private restano in `localStorage` del browser: cancellare i dati del sito le invalida e andranno rigenerate.

## Amministrazione (backend)

Avvia il server con `PYCHAT_ADMIN_TOKEN` impostato, poi usa `admin.py` (richiede accesso diretto alla porta TCP del server, default `127.0.0.1:5555`):

```bash
export PYCHAT_ADMIN_TOKEN=una-stringa-lunga-e-casuale
python admin.py stats                          # utenti, online, community, media, chiamate
python admin.py user --user mario              # dettagli account
python admin.py logout --user mario            # forza la disconnessione di tutte le sessioni
python admin.py broadcast --text "Avviso"      # invia admin_notice a tutti i connessi
```

Senza `PYCHAT_ADMIN_TOKEN` i comandi admin rispondono "Admin disabilitato". Le azioni sono validate con confronto a tempo costante (`hmac.compare_digest`).

## Stati temporanei (24 ore)

Ogni utente può pubblicare stati testuali visibili solo ai propri contatti per 24 ore (max 10 alla volta, 200 caratteri). Si pubblicano dalla sezione "Stato temporaneo" nelle Impostazioni > Account. I contatti con stati attivi mostrano un anello verde sull'avatar; il contenuto si legge nel profilo del contatto. Gli stati scadono automaticamente (purge pigra alla lettura).

## Badge verificati a pagamento (simulato)

Tre livelli opzionali, attivabili da Impostazioni > Account > "Badge verificato" (nessun pagamento reale viene elaborato):

| Livello | Prezzo | Vantaggi |
|---|---|---|
| Blu | 10€/mese | Badge blu, bio fino a 240 caratteri |
| Nero | 25€/mese | Badge nera, bio 320, animazione nome arcobaleno esclusiva |
| Arcobaleno | 50€/mese | Badge arcobaleno animata, bio 500, animazione arcobaleno |

Il badge appare accanto al nome in contatti, messaggi e profilo. L'animazione nome "Scintillio" (rainbow) è riservata ai livelli Nero e Arcobaleno.

## Richieste di contatto e blocchi

- Le richieste di amicizia in arrivo/in attesa sono gestibili in Impostazioni > Privacy > "Richieste di contatto" (accetta/rifiuta). Il server applica le policy privacy (`friend_request_policy`).
- Si può bloccare un utente dal suo profilo (pulsante "Blocca utente") e sbloccarlo in Impostazioni > Privacy > "Utenti bloccati".

## Altri miglioramenti

- **Messaggi programmati**: pannello "Programmati" nell'header per vedere e annullare i invii in sospeso (`scheduled_list`/`scheduled_cancel`).
- **Inoltro completo**: inoltrare un messaggio trasferisce anche allegati, vocali e sondaggi.
- **Bozze sincronizzate**: la bozza di ogni conversazione è salvata sul server (`drafts/`) e riappare su ogni dispositivo (`draft_save`/`draft_list`, sync debounced).
- **Scadenza per conversazione**: nelle DM il timer ⏱ nell'header imposta una scadenza per tutti i messaggi (`dm_ttl/`); vale per i nuovi messaggi, anche programmati.
- **Ricerca globale**: la lente nel pannello di ricerca offre la modalità globale (tutte le conversazioni DM e canali community); la ricerca copre anche sondaggi e nomi allegati.
- **Storico modifiche**: ogni messaggio modificato conserva le ultime 5 versioni precedenti (`edits`), visibili da "Cronologia modifiche" sotto il messaggio. Per i messaggi E2EE le versioni cifrate appaiono come "[messaggio cifrato]".
- **Markup esteso**: ```` ```codice``` ```` (blocchi), `` `codice` `` (inline) e `||spoiler||` (clicca per rivelare) oltre a grassetto/corsivo/link/emoji.
