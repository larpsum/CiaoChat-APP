const WS_URL = (window.location.protocol === "https:" ? "wss:" : "ws:") + "//" + window.location.host + "/ws";

const el = id => document.getElementById(id);
const authShell = el("authShell");
const messenger = el("messenger");
const authMsg = el("authMsg");
const loginForm = el("loginForm");
const registerForm = el("registerForm");
const tabs = el("tabs") ? el("tabs").querySelectorAll(".tab") : document.querySelectorAll(".tab");
const loginPanel = el("loginForm");
const registerPanel = el("registerForm");

let ws = null;
let token = null;
let me = null;
let selectedContact = null;
let contacts = [];
let sendQueue = [];
const mediaCache = new Map();
const mediaRequests = new Set();
const allowedExtensions = new Set(["jpg", "png", "webp", "mp4", "gif"]);

// ---------- Connection ----------
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    console.log("[ws] connected");
    // flush any messages queued while connecting
    const q = sendQueue.splice(0, sendQueue.length);
    q.forEach(obj => ws.send(JSON.stringify(obj)));
  };
  ws.onmessage = onMessage;
  ws.onclose = () => {
    console.log("[ws] closed");
    setTimeout(connect, 2000);
  };
  ws.onerror = console.error;
}

function send(obj) {
  const data = JSON.stringify(obj);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  } else {
    sendQueue.push(obj);
  }
}

// ---------- UI helpers ----------
function showAuth() {
  authShell.style.display = "grid";
  messenger.style.display = "none";
}
function showMessenger() {
  authShell.style.display = "none";
  messenger.style.display = "flex";
}

function setAuthMsg(text, type = "error") {
  authMsg.textContent = text;
  authMsg.className = "msg " + type;
}

function clearAuthMsg() { authMsg.textContent = ""; }

// ---------- Auth ----------
function switchTab(tab) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".form-panel").forEach(p => p.classList.remove("active"));
  el(tab + "Form").classList.add("active");
  el(tab + "Form").querySelector(".tab") && el(tab).classList.add("active");
  // mark button active
  Array.from(document.querySelectorAll(".tab")).forEach(b => {
    if (b.dataset.tab === tab) b.classList.add("active");
  });
  clearAuthMsg();
}

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

loginForm.addEventListener("submit", e => {
  e.preventDefault();
  clearAuthMsg();
  const btn = loginForm.querySelector('button[type="submit"]');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Accedi...";
  const fd = new FormData(loginForm);
  send({ t: "login", username: fd.get("username"), password: fd.get("password") });
  // restore button after a short delay; server "ok" response switches views anyway
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = originalText;
  }, 2000);
});

registerForm.addEventListener("submit", e => {
  e.preventDefault();
  clearAuthMsg();
  const btn = registerForm.querySelector('button[type="submit"]');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Creazione...";
  const fd = new FormData(registerForm);
  const msg = { t: "register", username: fd.get("username"), password: fd.get("password") };
  const phone = fd.get("phone");
  if (phone) msg.phone = phone;
  send(msg);
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = originalText;
  }, 2000);
});

// ---------- Messenger UI ----------
const newChatBtn = el("newChatBtn");
const contactSearch = el("contactSearch");
const contactList = el("contactList");
const convAvatar = el("convAvatar");
const convName = el("convName");
const convStatus = el("convStatus");
const convBanner = el("convBanner");
const messages = el("messages");
const messageInput = el("messageInput");
const sendBtn = el("sendBtn");
const logoutBtn = el("logoutBtn");
const profileModal = el("profileModal");
const profileStatus = el("profileStatus");
const nameColor = el("nameColor");
const nameAnimation = el("nameAnimation");
const profilePreviewAvatar = el("profilePreviewAvatar");
const profilePreviewBanner = el("profilePreviewBanner");
const profilePreviewName = el("profilePreviewName");

function renderContacts() {
  contactList.innerHTML = "";
  if (contacts.length === 0) {
    contactList.appendChild(makeEmptyItem());
    return;
  }
  contacts.forEach(c => {
    const username = c.id || c.username;
    const item = document.createElement("li");
    item.className = "contact-item" + (selectedContact === username ? " active" : "");
    const avatar = makeAvatar(c, "contact-avatar");
    const details = document.createElement("div");
    details.className = "contact-details";
    const name = document.createElement("div");
    name.className = "contact-name name-style";
    name.textContent = c.name || c.username || username;
    styleName(name, c);
    const status = document.createElement("div");
    status.className = "contact-status";
    status.textContent = c.online ? "Online" : "Offline";
    details.append(name, status);
    item.append(avatar, details);
    item.onclick = () => selectContact(username);
    contactList.appendChild(item);
  });
}

function makeEmptyItem() {
  const li = document.createElement("li");
  li.className = "contact-item empty";
  li.textContent = "Nessun contatto ancora. Usa 'Nuova conversazione' per aggiungerne uno.";
  return li;
}

function avatarInitial(name) {
  return (name || "?").charAt(0).toUpperCase();
}

function selectContact(username) {
  selectedContact = username;
  convStatus.textContent = username;
  renderSelectedContact();
  renderContacts();
  messages.innerHTML = "";
  messages.appendChild(makePlaceholder("Seleziona un contatto per iniziare a chattare."));
  send({ t: "history", with: username });
  messageInput.disabled = false;
  sendBtn.disabled = true;
  messageInput.focus();
}

function contactProfile(username) {
  return contacts.find(c => (c.id || c.username) === username);
}

function renderSelectedContact() {
  const profile = contactProfile(selectedContact);
  const name = profile?.name || profile?.username || selectedContact || "Scegli un contatto";
  convName.textContent = name;
  styleName(convName, profile);
  convAvatar.replaceChildren();
  convAvatar.textContent = avatarInitial(name);
  const avatar = profile && mediaElement(profile.avatar, "conv-avatar-media");
  if (avatar) convAvatar.replaceChildren(avatar);
  convBanner.replaceChildren();
  const banner = profile && mediaElement(profile.banner, "conv-banner-media");
  if (banner) convBanner.appendChild(banner);
}

function styleName(node, profile) {
  node.style.color = /^#[0-9a-f]{6}$/i.test(profile?.name_color || "")
    ? profile.name_color : "";
  node.classList.remove("name-glow", "name-pulse", "name-rainbow");
  const animationClass = {
    glow: "name-glow",
    pulse: "name-pulse",
    rainbow: "name-rainbow",
  }[profile?.name_animation];
  if (animationClass) node.classList.add(animationClass);
}

function makeAvatar(profile, className) {
  const avatar = document.createElement("div");
  avatar.className = className;
  avatar.textContent = avatarInitial(profile.name || profile.username || profile.id);
  const image = mediaElement(profile.avatar, "avatar-media");
  if (image) avatar.replaceChildren(image);
  return avatar;
}

function mediaElement(hash, className) {
  if (!hash) return null;
  const src = mediaCache.get(hash);
  if (!src) {
    if (!mediaRequests.has(hash)) {
      mediaRequests.add(hash);
      send({ t: "media_get", hash });
    }
    return null;
  }
  const video = src.startsWith("data:video/");
  const media = document.createElement(video ? "video" : "img");
  media.className = className;
  media.src = src;
  if (video) {
    media.autoplay = true;
    media.loop = true;
    media.muted = true;
    media.playsInline = true;
  } else {
    media.alt = "";
  }
  return media;
}

function renderProfilePreview() {
  profilePreviewAvatar.textContent = avatarInitial(me?.username);
  profilePreviewName.textContent = me?.username || "Il tuo nome";
  styleName(profilePreviewName, me);
  profilePreviewAvatar.replaceChildren();
  profilePreviewAvatar.textContent = avatarInitial(me?.username);
  const avatar = mediaElement(me?.avatar, "avatar-media");
  if (avatar) profilePreviewAvatar.replaceChildren(avatar);
  profilePreviewBanner.replaceChildren();
  const banner = mediaElement(me?.banner, "preview-banner-media");
  if (banner) profilePreviewBanner.appendChild(banner);
  nameColor.value = me?.name_color || "#f1f5f9";
  nameAnimation.value = me?.name_animation || "none";
}

function updateProfile(profile) {
  if (!profile) return;
  contacts = contacts.map(c => (c.id || c.username) === profile.id ? { ...c, ...profile } : c);
  if (me?.id === profile.id) me = { ...me, ...profile };
  renderContacts();
  if (selectedContact === profile.id) renderSelectedContact();
  if (!profileModal.classList.contains("hidden") && me?.id === profile.id) {
    renderProfilePreview();
    profileStatus.textContent = "Profilo aggiornato.";
    profileStatus.className = "success";
  }
}

function openProfileModal() {
  profileStatus.textContent = "";
  profileStatus.className = "";
  renderProfilePreview();
  profileModal.classList.remove("hidden");
}

function closeProfileModal() {
  profileModal.classList.add("hidden");
}

function uploadProfileMedia(kind, file) {
  const extension = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase() || "";
  if (!allowedExtensions.has(extension)) {
    profileStatus.textContent = "Formato non consentito. Usa JPG, PNG, WEBP, MP4 o GIF.";
    profileStatus.className = "error";
    return;
  }
  if (file.size > 1_700_000) {
    profileStatus.textContent = "Il file supera il limite di 1,7 MB.";
    profileStatus.className = "error";
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => {
    profileStatus.textContent = "Impossibile leggere il file selezionato.";
    profileStatus.className = "error";
  };
  reader.onload = () => {
    const base64 = String(reader.result).split(",", 2)[1];
    send({ t: "media_put", kind, extension, data: base64 });
    profileStatus.textContent = "Caricamento...";
    profileStatus.className = "";
  };
  reader.readAsDataURL(file);
}

el("profileSettingsBtn").addEventListener("click", openProfileModal);
el("profileSettingsHeaderBtn").addEventListener("click", openProfileModal);
el("closeProfileModal").addEventListener("click", closeProfileModal);
profileModal.addEventListener("click", event => {
  if (event.target === profileModal) closeProfileModal();
});
nameColor.addEventListener("input", () => {
  styleName(profilePreviewName, { ...me, name_color: nameColor.value });
});
nameAnimation.addEventListener("change", () => {
  styleName(profilePreviewName, { ...me, name_animation: nameAnimation.value });
});
el("saveProfileStyle").addEventListener("click", () => {
  send({ t: "profile_customization", name_color: nameColor.value, name_animation: nameAnimation.value });
  profileStatus.textContent = "Salvataggio...";
  profileStatus.className = "";
});
el("avatarFile").addEventListener("change", event => {
  const file = event.target.files[0];
  if (file) uploadProfileMedia("avatar", file);
  event.target.value = "";
});
el("bannerFile").addEventListener("change", event => {
  const file = event.target.files[0];
  if (file) uploadProfileMedia("banner", file);
  event.target.value = "";
});
document.querySelectorAll("[data-clear-media]").forEach(button => {
  button.addEventListener("click", () => {
    send({ t: "media_clear", kind: button.dataset.clearMedia });
    profileStatus.textContent = "Rimozione...";
    profileStatus.className = "";
  });
});

newChatBtn.onclick = () => {
  const username = prompt("Username del contatto da aggiungere:");
  if (!username) return;
  send({ t: "add_contact", username });
};

logoutBtn.onclick = () => {
  send({ t: "logout" });
  closeProfileModal();
  token = null;
  me = null;
  selectedContact = null;
  contacts = [];
  showAuth();
};

messageInput.addEventListener("input", () => {
  sendBtn.disabled = !messageInput.value.trim();
});

sendBtn.onclick = () => {
  const text = messageInput.value.trim();
  if (!text || !selectedContact) return;
  send({ t: "dm", to: selectedContact, text });
  messageInput.value = "";
  sendBtn.disabled = true;
};

// ---------- Incoming messages ----------
function onMessage(event) {
  let m;
  try { m = JSON.parse(event.data); } catch { return; }

  switch (m.t) {
    case "ok":
      token = m.token;
      me = {
        id: m.id, username: m.user, phone: m.phone, avatar: m.avatar,
        avatar_type: m.avatar_type, banner: m.banner, banner_type: m.banner_type,
        name_color: m.name_color, name_animation: m.name_animation,
      };
      contacts = m.contacts || [];
      renderContacts();
      showMessenger();
      convStatus.textContent = "Connesso";
      break;

    case "contact_added":
      contacts.push(m.contact);
      renderContacts();
      break;

    case "history":
      renderHistory(m.msgs || [], m.with);
      break;

    case "dm":
      appendMessage(m.from || m.id, m.text, (m.from || m.id)?.toLowerCase() === me?.id ? "self" : "other", m.ts);
      break;

    case "profile":
      break;

    case "profile_update":
      updateProfile(m.profile);
      break;

    case "media":
      mediaRequests.delete(m.hash);
      if (typeof m.data === "string" && [
        "image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4",
      ].includes(m.mime)) {
        mediaCache.set(m.hash, `data:${m.mime};base64,${m.data}`);
        renderContacts();
        renderSelectedContact();
        if (!profileModal.classList.contains("hidden")) renderProfilePreview();
      }
      break;

    case "media_ok":
      if (me && (m.kind === "avatar" || m.kind === "banner")) {
        me = { ...me, [m.kind]: m.hash, [`${m.kind}_type`]: m.extension };
        profileStatus.textContent = "Caricamento completato.";
        profileStatus.className = "success";
        renderProfilePreview();
      }
      break;

    case "err":
      if (!profileModal.classList.contains("hidden")) {
        profileStatus.textContent = m.text || "Errore";
        profileStatus.className = "error";
      } else if (selectedContact) {
        appendSystemMessage(m.text || "Errore");
      } else {
        setAuthMsg(m.text || "Errore");
      }
      break;

    case "status":
      contacts = contacts.map(c => (c.id || c.username) === m.id ? { ...c, online: m.online } : c);
      renderContacts();
      break;

    default:
      // ignore unknown
  }
}

function renderHistory(msgs, withUser) {
  messages.innerHTML = "";
  if (msgs.length === 0) {
    messages.appendChild(makePlaceholder("Nessun messaggio ancora."));
  }
  msgs.forEach(m => appendMessage(m.from, m.text, m.from?.toLowerCase() === me?.id ? "self" : "other", m.ts, true));
  scrollBottom();
}

function appendMessage(from, text, kind, ts, silent) {
  const div = document.createElement("div");
  div.className = "msg " + kind;
  const profile = contacts.find(c => (c.id || c.username) === from);
  const meta = ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  if (kind !== "self") {
    const author = document.createElement("strong");
    author.className = "message-author name-style";
    author.textContent = profile?.name || profile?.username || from || "";
    styleName(author, profile);
    div.appendChild(author);
  }
  div.append(document.createTextNode(text || ""));
  const metadata = document.createElement("span");
  metadata.className = "meta";
  metadata.textContent = meta;
  div.appendChild(metadata);
  if (!silent) messages.appendChild(div);
  else {
    // insert before placeholder if present
    const placeholder = messages.querySelector(".msg-placeholder");
    if (placeholder) messages.insertBefore(div, placeholder);
    else messages.appendChild(div);
  }
  if (!silent) scrollBottom();
}

function makePlaceholder(text) {
  const div = document.createElement("div");
  div.className = "msg-placeholder";
  div.innerHTML = `<svg width="40" height="40" fill="none" stroke="#94a3b8" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><polyline points="22 12 18 12 15 15 9 4 6 4"/><rect width="18" height="18" x="3" y="11"/></svg><p>${text}</p>`;
  return div;
}

function appendSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "msg-placeholder";
  div.style.justifyContent = "center";
  div.style.color = "var(--danger)";
  div.innerHTML = `<p style="font-size:0.85rem;">${escapeHtml(text)}</p>`;
  messages.appendChild(div);
  scrollBottom();
}

function scrollBottom() { messages.scrollTop = messages.scrollHeight; }

// ---------- Helpers ----------
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// Bootstrap
connect();
