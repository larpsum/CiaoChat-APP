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
