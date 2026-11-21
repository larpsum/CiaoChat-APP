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

accanto a `CiaoChat.exe` oppure imposta la variabile d'ambiente `PYCHAT_SERVICE_ACCOUNT` con il percorso completo del file.

## Personalizzazione del profilo

Dal pulsante **Personalizza profilo** puoi caricare immagini profilo e banner nei formati JPG, PNG, WEBP, MP4 o GIF (massimo 1,7 MB ciascuno), scegliere il colore del nome e attivare un'animazione. Il server verifica sia l'estensione sia il contenuto del file.
