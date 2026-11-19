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
const messages = el("messages");
const messageInput = el("messageInput");
const sendBtn = el("sendBtn");
const logoutBtn = el("logoutBtn");

function renderContacts() {
  contactList.innerHTML = "";
  if (contacts.length === 0) {
    contactList.appendChild(makeEmptyItem());
    return;
  }
  contacts.forEach(c => {
    const item = document.createElement("li");
    item.className = "contact-item" + (selectedContact === c.username ? " active" : "");
    item.innerHTML = `
      <div class="contact-avatar">${avatarInitial(c.username)}</div>
      <div style="flex:1; min-width:0;">
        <div style="font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(c.username)}</div>
        <div style="font-size:0.78rem; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${c.online ? "Online" : "Offline"}</div>
      </div>
    `;
    item.onclick = () => selectContact(c.username, c.name || c.username);
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

function selectContact(username, name) {
  selectedContact = username;
  convName.textContent = name;
  convStatus.textContent = username;
  convAvatar.textContent = avatarInitial(name);
  renderContacts();
  messages.innerHTML = "";
  messages.appendChild(makePlaceholder("Seleziona un contatto per iniziare a chattare."));
  send({ t: "history", with: username });
  messageInput.disabled = false;
  sendBtn.disabled = true;
  messageInput.focus();
}

newChatBtn.onclick = () => {
  const username = prompt("Username del contatto da aggiungere:");
  if (!username) return;
  send({ t: "add_contact", username });
};

logoutBtn.onclick = () => {
  send({ t: "logout" });
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
      me = { id: m.id, username: m.user, phone: m.phone };
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
      appendMessage(m.from || m.id, m.text, m.from === me?.username ? "self" : "other", m.ts);
      break;

    case "profile":
      break;

    case "err":
      if (selectedContact) {
        appendSystemMessage(m.text || "Errore");
      } else {
        setAuthMsg(m.text || "Errore");
      }
      break;

    case "status":
      contacts = contacts.map(c => c.id === m.id ? { ...c, online: m.online } : c);
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
  msgs.forEach(m => appendMessage(m.from, m.text, m.from === me?.username ? "self" : "other", m.ts, true));
  scrollBottom();
}

function appendMessage(from, text, kind, ts, silent) {
  const div = document.createElement("div");
  div.className = "msg " + kind;
  const escaped = escapeHtml(text || "");
  const meta = ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  div.innerHTML = kind === "self"
    ? `${escaped}<span class="meta">${meta}</span>`
    : `<strong style="font-size:0.78rem; color:var(--text-muted); display:block; margin-bottom:4px;">${escapeHtml(from || "")}</strong>${escaped}<span class="meta">${meta}</span>`;
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
