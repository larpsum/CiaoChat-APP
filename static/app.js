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
let resumePending = false;
let selectedContact = null;
let contacts = [];
let sendQueue = [];
let registrationAwaitingOtp = false;
let pendingMediaKind = null;
const mediaCache = new Map();
const mediaRequests = new Set();
const allowedExtensions = new Set(["jpg", "png", "webp", "mp4", "gif"]);
let settingsSnapshot = null;
let communitySnapshot = null;
let communityListData = [];
let settingsBaseline = null;
let currentCommunityId = null;
let currentCommunity = null;
let currentChannelId = null;
let pendingGroupSelection = false;
let memberActionPending = null;
let memberActionTimer = null;
let selectedInviteRoles = new Set();
let pendingInvitations = [];
let quickContactPending = false;
let pendingChatAttachment = null;
let attachmentUploadPending = false;
let attachmentTimer = null;
let activeCall = null;
let pendingCommunityCreate = false;
let pendingInviteResponse = null;
let pendingInviteResponseTimer = null;
let pendingCommunityCreateTimer = null;
let quickContactTimer = null;

const DEFAULT_LOCAL_SETTINGS = {
  theme: "dark",
  density: "cozy",
  fontSize: 100,
  reducedMotion: false,
  linkPreviews: true,
  inlineImages: true,
  autoEmoji: true,
  desktopNotifications: false,
  unreadBadge: true,
  soundMessage: true,
  soundCall: true,
  soundMute: true,
  doNotDisturb: false,
  audioInput: "",
  audioOutput: "",
  videoInput: "",
  inputVolume: 100,
  outputVolume: 100,
  inputMode: "voice",
  voiceSensitivity: 50,
  echoCancel: true,
  noiseSuppress: true,
  autoGain: true,
  keybinds: { mute: "", deafen: "", ptt: "" },
};

function loadLocalSettings() {
  try {
    return { ...DEFAULT_LOCAL_SETTINGS, ...JSON.parse(localStorage.getItem("ciaochat.settings") || "{}") };
  } catch {
    return { ...DEFAULT_LOCAL_SETTINGS };
  }
}

let localSettings = loadLocalSettings();

// ---------- Connection ----------
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    console.log("[ws] connected");
    clearAuthMsg();
    if (token && me?.id) {
      resumePending = true;
      ws.send(JSON.stringify({ t: "resume", user: me.id, token }));
    }
    // flush any messages queued while connecting
    const q = sendQueue.splice(0, sendQueue.length);
    q.forEach(obj => ws.send(JSON.stringify(obj)));
  };
  ws.onmessage = onMessage;
  ws.onclose = () => {
    console.log("[ws] closed");
    sendQueue = [];
    if (activeCall) finishCall("Connessione persa. La chiamata è stata interrotta.");
    failMemberAction("Connessione persa. Riprova.");
    if (quickContactPending) {
      quickContactPending = false;
      clearTimeout(quickContactTimer);
      quickContactTimer = null;
      el("quickContactFeedback").textContent = "Connessione persa. Riprova.";
      el("quickContactFeedback").className = "error";
    }
    if (pendingCommunityCreate) {
      pendingCommunityCreate = false;
      clearTimeout(pendingCommunityCreateTimer);
      pendingCommunityCreateTimer = null;
      el("communityCreateFeedback").textContent = "Connessione persa. Riprova.";
      el("communityCreateFeedback").className = "inline-action-feedback error";
      el("createCommunityBtn").disabled = false;
    }
    if (pendingInviteResponse) {
      finishInviteResponse("Connessione persa. Riprova.", true);
    }
    if (attachmentUploadPending) {
      discardPendingAttachment();
      setComposerFeedback("Upload interrotto per la perdita della connessione. Riprova.", "error");
    }
    if (authShell.style.display !== "none") {
      setAuthMsg("Server non disponibile. Riprova tra qualche secondo.");
    } else if (me) {
      convStatus.textContent = "Connessione persa, riconnessione...";
    }
    setTimeout(connect, 2000);
  };
  ws.onerror = console.error;
}

function send(obj) {
  const data = JSON.stringify(obj);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
    return true;
  } else if (ws && ws.readyState === WebSocket.CONNECTING) {
    sendQueue.push(obj);
    return true;
  }
  if (!profileModal.classList.contains("hidden")) {
    profileStatus.textContent = "Connessione al server non disponibile. Riprova tra qualche secondo.";
    profileStatus.className = "error";
  } else if (authShell.style.display !== "none") {
    setAuthMsg("Connessione al server non disponibile. Riprova tra qualche secondo.");
  }
  return false;
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
  send({ t: "login", user: fd.get("username"), pw: fd.get("password") });
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
  const msg = {
    t: "register",
    user: fd.get("username"),
    pw: fd.get("password"),
    phone: fd.get("phone"),
  };
  if (registrationAwaitingOtp && msg.phone) msg.otp = fd.get("otp");
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
const composerFeedback = el("composerFeedback");
const attachmentInput = el("attachmentInput");
const attachButton = el("attachButton");
const attachmentPreview = el("attachmentPreview");
const logoutBtn = el("logoutBtn");
const profileModal = el("profileModal");
const profileStatus = el("profileStatus");
const nameColor = el("nameColor");
const nameAnimation = el("nameAnimation");
const profilePreviewAvatar = el("profilePreviewAvatar");
const profilePreviewBanner = el("profilePreviewBanner");
const profilePreviewName = el("profilePreviewName");
const participantSearch = el("participantSearch");
const participantDirectory = el("participantDirectory");

function renderContacts() {
  contactList.innerHTML = "";
  const query = contactSearch.value.trim().toLowerCase();
  const visibleContacts = contacts.filter(contact => [
    contact.name, contact.username, contact.id, contact.phone,
  ].some(value => String(value || "").toLowerCase().includes(query)));
  if (visibleContacts.length === 0) {
    contactList.appendChild(makeEmptyItem());
    if (query && contacts.length) contactList.lastElementChild.textContent = "Nessun contatto corrispondente.";
    return;
  }
  visibleContacts.forEach(c => {
    const username = c.id || c.username;
    const item = document.createElement("li");
    item.className = "contact-item" + (selectedContact === username ? " active" : "");
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-label", `Apri conversazione con ${c.name || c.username || username}`);
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
    item.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectContact(username);
      }
    });
    contactList.appendChild(item);
  });
}

contactSearch.addEventListener("input", renderContacts);

function makeEmptyItem() {
  const li = document.createElement("li");
  li.className = "contact-item empty";
  li.textContent = "Nessun contatto ancora. Usa 'Nuova conversazione' per aggiungerne uno.";
  return li;
}

function renderCommunityList(communities) {
  const list = el("communityList");
  list.replaceChildren();
  (communities || []).forEach(community => {
    const item = document.createElement("li");
    item.className = "community-item" + (community.id === currentCommunityId ? " active" : "");
    item.dataset.communityId = community.id;
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    const icon = document.createElement("span");
    icon.className = "community-list-icon";
    icon.textContent = (community.name || "G").slice(0, 1).toUpperCase();
    const name = document.createElement("span");
    name.textContent = community.name || "Gruppo";
    item.append(icon, name);
    item.addEventListener("click", () => selectCommunity(community.id));
    item.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectCommunity(community.id);
      }
    });
    list.appendChild(item);
  });
  if (!list.children.length) {
    const empty = document.createElement("li");
    empty.className = "community-list-empty";
    empty.textContent = "Nessun gruppo";
    list.appendChild(empty);
  }
}

function selectCommunity(communityId) {
  discardPendingAttachment();
  currentCommunityId = communityId;
  currentCommunity = null;
  currentChannelId = null;
  selectedContact = null;
  pendingGroupSelection = true;
  selectedInviteRoles.clear();
  renderContacts();
  renderCommunityList(communityListData);
  convName.textContent = "Caricamento gruppo...";
  convStatus.textContent = "";
  messageInput.disabled = true;
  updateSendButton();
  participantDirectory.replaceChildren();
  el("memberInvitePanel").classList.remove("hidden");
  el("participantIndexTitle").textContent = "Participants - Loading...";
  el("participantCount").textContent = "…";
  el("messages").replaceChildren(makePlaceholder("Caricamento dei canali..."));
  send({ t: "community_get", community: communityId });
}

function renderParticipants(community) {
  const participants = community?.participants || [];
  const roles = community?.roles || {};
  const canInvite = !!(
    community?.permissions?.create_invites ||
    community?.permissions?.administrator
  );
  const canAssignRoles = !!(
    community?.permissions?.manage_roles ||
    community?.permissions?.administrator
  );
  const canRemove = !!(
    community?.permissions?.kick_members ||
    community?.permissions?.administrator
  );
  el("memberInvitePanel").classList.toggle("hidden", !canInvite);
  el("participantIndexTitle").textContent = `Participants - ${community?.name || "Group"}`;
  el("participantCount").textContent = String(participants.length);
  el("visibleParticipantCount").textContent = `${participants.length} members`;
  el("suggestedRoles").replaceChildren();
  Object.entries(roles).forEach(([roleId, role]) => {
    if (["everyone", "owner"].includes(roleId)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggested-role";
    button.dataset.roleId = roleId;
    const isSelected = selectedInviteRoles.has(roleId);
    button.classList.toggle("selected", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    button.disabled = !canAssignRoles;
    const check = document.createElement("i");
    check.className = "ph ph-check";
    check.classList.toggle("ph-bold", isSelected);
    check.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = role.name || roleId;
    button.append(check, label);
    button.addEventListener("click", () => {
      const selected = selectedInviteRoles.has(roleId);
      if (selected) selectedInviteRoles.delete(roleId);
      else selectedInviteRoles.add(roleId);
      button.classList.toggle("selected", !selected);
      button.setAttribute("aria-pressed", String(!selected));
      check.classList.toggle("ph-bold", !selected);
    });
    el("suggestedRoles").appendChild(button);
  });
  el("invitePersonBtn").disabled = !canInvite;

  const query = participantSearch.value.trim().toLowerCase();
  participantDirectory.replaceChildren();
  const visible = participants.filter(participant => {
    const roleNames = (participant.roles || []).map(role => role.name).join(" ");
    return [
      participant.name, participant.username, participant.email, roleNames,
    ].some(value => String(value || "").toLowerCase().includes(query));
  });
  el("visibleParticipantCount").textContent = `${visible.length} of ${participants.length} members`;
  visible.forEach(participant => {
    const row = document.createElement("article");
    row.className = "participant-row";
    row.dataset.memberId = participant.id;
    row.dataset.search = [
      participant.name, participant.username, participant.email,
      (participant.roles || []).map(role => role.name).join(" "),
    ].join(" ").toLowerCase();
    const main = document.createElement("div");
    main.className = "participant-row-main";
    const avatar = document.createElement("span");
    avatar.className = "participant-avatar";
    avatar.setAttribute("aria-hidden", "true");
    const avatarMedia = mediaElement(participant.avatar, "participant-avatar-media");
    if (avatarMedia) {
      avatar.appendChild(avatarMedia);
    } else {
      avatar.innerHTML = `<i class="ph ph-user" aria-hidden="true"></i><span>${escapeHtml(avatarInitial(participant.name || participant.username))}</span>`;
    }
    const details = document.createElement("div");
    details.className = "participant-details";
    const title = document.createElement("strong");
    title.textContent = participant.name || participant.username;
    const handle = document.createElement("small");
    handle.textContent = `@${participant.username || participant.id}`;
    details.append(title, handle);
    const status = document.createElement("span");
    status.className = `participant-status-dot ${participant.online ? "online" : "offline"}`;
    status.title = participant.online ? "Online" : "Offline";
    status.setAttribute("aria-label", status.title);
    main.append(status, avatar, details);
    const badges = document.createElement("div");
    badges.className = "participant-role-badges";
    (participant.roles || []).forEach(role => {
      const badge = document.createElement("span");
      badge.className = "participant-role-badge";
      badge.textContent = role.name;
      if (/^#[0-9a-f]{6}$/i.test(role.color || "")) badge.style.setProperty("--role-color", role.color);
      badges.appendChild(badge);
    });
    row.append(main, badges);

    if (canAssignRoles || canRemove) {
      const actions = document.createElement("div");
      actions.className = "participant-row-actions";
      if (canAssignRoles && participant.id !== me?.id) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "icon-btn participant-action";
        edit.title = "Modifica ruoli";
        edit.setAttribute("aria-label", `Modifica ruoli di ${participant.name || participant.username}`);
        edit.innerHTML = '<i class="ph ph-pencil-simple" aria-hidden="true"></i>';
        edit.addEventListener("click", () => toggleInlineRoleEditor(row, participant, roles));
        actions.appendChild(edit);
      }
      if (canRemove && participant.id !== me?.id) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "icon-btn participant-action remove-action";
        remove.title = "Remove member";
        remove.setAttribute("aria-label", `Remove ${participant.name || participant.username}`);
        remove.innerHTML = '<i class="ph ph-trash" aria-hidden="true"></i>';
        remove.addEventListener("click", () => showInlineRemoveConfirmation(row, participant));
        actions.appendChild(remove);
      }
      row.appendChild(actions);
    }
    participantDirectory.appendChild(row);
  });
  Object.entries(community?.member_invites || {}).forEach(([userId, invite]) => {
    const invitedUser = (invite?.user?.username || invite?.username || userId).toLowerCase();
    const roleNames = (invite?.roles || []).map(roleId => roles[roleId]?.name || roleId).join(" ");
    if (query && !`${invitedUser} ${roleNames} invito in attesa`.toLowerCase().includes(query)) return;
    const pending = document.createElement("article");
    pending.className = "participant-row pending-member";
    const main = document.createElement("div");
    main.className = "participant-row-main";
    const icon = document.createElement("i");
    icon.className = "ph ph-paper-plane-tilt pending-member-icon";
    icon.setAttribute("aria-hidden", "true");
    const details = document.createElement("div");
    details.className = "participant-details";
    const label = document.createElement("strong");
    label.textContent = invitedUser;
    const state = document.createElement("small");
    state.textContent = "Invito in attesa";
    details.append(label, state);
    main.append(icon, details);
    pending.appendChild(main);
    if (canInvite) {
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "icon-btn participant-action remove-action";
      revoke.title = "Revoca invito";
      revoke.setAttribute("aria-label", `Revoca invito per ${invitedUser}`);
      revoke.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
      revoke.addEventListener("click", () => {
        if (memberActionPending || pendingInviteResponse || attachmentUploadPending) {
          inviteFeedback.textContent = "Termina prima l'operazione in corso.";
          inviteFeedback.className = "member-feedback error";
          return;
        }
        const success = send({
          t: "community_member_invite_revoke", community: currentCommunityId, user: userId,
        });
        if (!success) {
          inviteFeedback.textContent = "Connessione non disponibile. Riprova.";
          inviteFeedback.className = "member-feedback error";
          return;
        }
        beginMemberAction({
          type: "revoke",
          retry: () => revoke.click(),
          feedback: inviteFeedback,
        });
        inviteFeedback.textContent = "Revoca dell'invito...";
        inviteFeedback.className = "member-feedback";
      });
      pending.appendChild(revoke);
    }
    const inviteFeedback = document.createElement("div");
    inviteFeedback.className = "member-feedback";
    inviteFeedback.setAttribute("role", "status");
    pending.appendChild(inviteFeedback);
    participantDirectory.appendChild(pending);
  });
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "participant-empty";
    empty.textContent = query ? "No participants match this search."
      : "No participants yet.";
    participantDirectory.appendChild(empty);
  }
}

function showCommunityInChat(community) {
  currentCommunity = community;
  pendingGroupSelection = false;
  currentChannelId = community.channels?.[0]?.id || null;
  convName.textContent = community.name || "Gruppo";
  convStatus.textContent = currentChannelId
    ? `# ${community.channels[0].name}`
    : "Nessun canale accessibile";
  renderCommunityList(communityListData);
  renderParticipants(community);

  const channelBar = el("communityChannelBar");
  channelBar.replaceChildren();
  channelBar.classList.toggle("hidden", !community.channels?.length);
  (community.channels || []).forEach(channel => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "community-channel-button";
    button.dataset.channelId = channel.id;
    button.classList.toggle("active", channel.id === currentChannelId);
    button.textContent = `# ${channel.name}`;
    button.addEventListener("click", () => selectCommunityChannel(channel.id));
    channelBar.appendChild(button);
  });
  if (currentChannelId) {
    messageInput.disabled = false;
    updateSendButton();
    send({ t: "community_channel_history", community: community.id, channel: currentChannelId });
  } else {
    messageInput.disabled = true;
    updateSendButton();
    el("messages").replaceChildren(makePlaceholder("Nessun canale accessibile in questo gruppo."));
  }
}

function selectCommunityChannel(channelId) {
  if (!currentCommunity || !currentCommunity.channels?.some(channel => channel.id === channelId)) return;
  discardPendingAttachment();
  currentChannelId = channelId;
  const channel = currentCommunity.channels.find(item => item.id === channelId);
  convStatus.textContent = `# ${channel.name}`;
  el("communityChannelBar").querySelectorAll(".community-channel-button").forEach(button => {
    button.classList.toggle("active", button.dataset.channelId === channelId);
  });
  messageInput.disabled = false;
  updateSendButton();
  send({ t: "community_channel_history", community: currentCommunityId, channel: channelId });
}

function renderCommunityHistory(items) {
  messages.replaceChildren();
  if (!items.length) messages.appendChild(makePlaceholder("Nessun messaggio in questo canale."));
  items.forEach(item => appendCommunityMessage(item));
  scrollBottom();
}

function appendRichText(parent, text) {
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|(https?:\/\/[^\s<>]+)/g;
  const value = String(text || "");
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parent.appendChild(document.createTextNode(value.slice(cursor, index)));
    if (match[1]) {
      const link = document.createElement("a");
      link.href = match[2];
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = match[1];
      parent.appendChild(link);
    } else if (match[3]) {
      const strong = document.createElement("strong");
      strong.textContent = match[3];
      parent.appendChild(strong);
    } else if (match[4]) {
      const emphasis = document.createElement("em");
      emphasis.textContent = match[4];
      parent.appendChild(emphasis);
    } else {
      const link = document.createElement("a");
      link.href = match[5];
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = match[5];
      parent.appendChild(link);
    }
    cursor = index + match[0].length;
  }
  if (cursor < value.length) parent.appendChild(document.createTextNode(value.slice(cursor)));
}

function renderMessageAttachment(attachment) {
  if (!attachment?.hash) return null;
  const source = mediaCache.get(attachment.hash);
  if (!source) {
    const load = document.createElement("button");
    load.type = "button";
    load.className = "message-attachment-loading";
    load.dataset.attachmentHash = attachment.hash;
    load.innerHTML = '<i class="ph ph-download-simple" aria-hidden="true"></i> Carica allegato';
    load.addEventListener("click", () => {
      if (send({ t: "media_get", hash: attachment.hash })) {
        load.disabled = true;
        load.textContent = "Caricamento...";
        setTimeout(() => {
          if (load.isConnected) {
            load.disabled = false;
            load.innerHTML = '<i class="ph ph-arrow-clockwise" aria-hidden="true"></i> Riprova';
          }
        }, 10000);
      }
    });
    return load;
  }
  const media = source.startsWith("data:video/")
    ? document.createElement("video") : document.createElement("img");
  media.className = "message-attachment";
  media.dataset.attachmentHash = attachment.hash;
  media.src = source;
  if (media instanceof HTMLVideoElement) {
    media.controls = true;
    media.playsInline = true;
  } else {
    media.alt = attachment.name || "Allegato";
  }
  return media;
}

function appendCommunityMessage(item) {
  if (!item || (!item.text && !item.attachment)) return;
  const div = document.createElement("div");
  div.className = `msg ${item.from === me?.id ? "self" : "other"}`;
  if (item.from !== me?.id) {
    const author = document.createElement("strong");
    author.className = "message-author";
    const participant = currentCommunity?.participants?.find(person => person.id === item.from);
    author.textContent = participant?.name || participant?.username || item.from;
    div.appendChild(author);
  }
  appendRichText(div, item.text);
  const attachment = renderMessageAttachment(item.attachment);
  if (attachment) div.appendChild(attachment);
  const metadata = document.createElement("span");
  metadata.className = "meta";
  metadata.textContent = item.timestamp
    ? new Date(item.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  div.appendChild(metadata);
  const placeholder = messages.querySelector(".msg-placeholder");
  if (placeholder) placeholder.remove();
  messages.appendChild(div);
  scrollBottom();
}

function toggleInlineRoleEditor(row, participant, roles) {
  const existing = row.querySelector(".inline-member-editor");
  if (existing) {
    existing.remove();
    return;
  }
  const editor = document.createElement("div");
  editor.className = "inline-member-editor";
  const title = document.createElement("strong");
  title.textContent = "Ruoli del membro";
  const choices = document.createElement("div");
  choices.className = "suggested-roles";
  const selected = new Set((participant.roles || []).map(role => role.id));
  Object.entries(roles).forEach(([roleId, role]) => {
    if (roleId === "owner") return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggested-role";
    button.setAttribute("aria-pressed", String(selected.has(roleId)));
    button.classList.toggle("selected", selected.has(roleId));
    const check = document.createElement("i");
    check.className = "ph ph-check";
    check.classList.toggle("ph-bold", selected.has(roleId));
    check.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = role.name || roleId;
    button.append(check, label);
    button.addEventListener("click", () => {
      if (selected.has(roleId)) selected.delete(roleId);
      else selected.add(roleId);
      button.classList.toggle("selected", selected.has(roleId));
      button.setAttribute("aria-pressed", String(selected.has(roleId)));
      check.classList.toggle("ph-bold", selected.has(roleId));
    });
    choices.appendChild(button);
  });
  const feedback = document.createElement("div");
  feedback.className = "member-feedback";
  const actions = document.createElement("div");
  actions.className = "inline-editor-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn btn-primary small-btn";
  save.textContent = "Salva ruoli";
  save.addEventListener("click", () => {
    if (memberActionPending || pendingInviteResponse || attachmentUploadPending) {
      feedback.textContent = "Termina prima l'operazione in corso.";
      feedback.className = "member-feedback error";
      return;
    }
    const success = send({
      t: "community_member_roles",
      community: currentCommunityId,
      user: participant.username || participant.id,
      roles: Array.from(selected),
    });
    if (!success) {
      feedback.textContent = "Connessione non disponibile. Riprova.";
      feedback.className = "member-feedback error";
      return;
    }
    beginMemberAction({
      type: "roles",
      retry: () => save.click(),
      feedback,
    });
    feedback.textContent = "Salvataggio ruoli...";
    feedback.className = "member-feedback";
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-outline small-btn";
  cancel.textContent = "Annulla";
  cancel.addEventListener("click", () => editor.remove());
  actions.append(save, cancel);
  editor.append(title, choices, actions, feedback);
  row.appendChild(editor);
}

function showInlineRemoveConfirmation(row, participant) {
  if (row.querySelector(".inline-remove-confirm")) return;
  const confirmation = document.createElement("div");
  confirmation.className = "inline-remove-confirm";
  const feedback = document.createElement("div");
  feedback.className = "member-feedback";
  feedback.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = `Remove ${participant.name || participant.username}?`;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-danger small-btn";
  remove.innerHTML = '<i class="ph ph-trash" aria-hidden="true"></i> Remove';
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-outline small-btn";
  cancel.textContent = "Annulla";
  cancel.addEventListener("click", () => confirmation.remove());
  remove.addEventListener("click", () => {
    if (memberActionPending || pendingInviteResponse || attachmentUploadPending) {
      feedback.textContent = "Termina prima l'operazione in corso.";
      feedback.className = "member-feedback error";
      return;
    }
    const success = send({
      t: "community_kick",
      community: currentCommunityId,
      user: participant.username || participant.id,
    });
    if (!success) {
      confirmation.classList.add("error");
      text.textContent = "Connessione non disponibile. Riprova.";
      return;
    }
    beginMemberAction({
      type: "remove",
      retry: () => remove.click(),
      feedback,
    });
    row.classList.add("removing");
    text.textContent = "Rimozione in corso...";
  });
  confirmation.append(text, remove, cancel, feedback);
  row.appendChild(confirmation);
}

function renderPendingInvitations(invitations) {
  pendingInvitations = invitations || [];
  const panel = el("pendingInvitations");
  const list = el("pendingInvitationList");
  list.replaceChildren();
  panel.classList.toggle("hidden", !pendingInvitations.length);
  pendingInvitations.forEach(invitation => {
    const row = document.createElement("article");
    row.className = "pending-invitation-row";
    const message = document.createElement("span");
    message.textContent = `${invitation.inviter} ti ha invitato in ${invitation.name}`;
    const actions = document.createElement("div");
    const feedback = document.createElement("div");
    feedback.className = "member-feedback";
    feedback.setAttribute("role", "status");
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "btn btn-primary small-btn";
    accept.innerHTML = '<i class="ph ph-check" aria-hidden="true"></i> Accetta';
    accept.addEventListener("click", () => respondToInvite(invitation, "accept", accept, feedback));
    const decline = document.createElement("button");
    decline.type = "button";
    decline.className = "btn btn-outline small-btn";
    decline.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i> Rifiuta';
    decline.addEventListener("click", () => respondToInvite(invitation, "decline", decline, feedback));
    actions.append(accept, decline);
    row.append(message, actions, feedback);
    list.appendChild(row);
  });
}

function respondToInvite(invitation, action, button, feedback) {
  if (pendingInviteResponse || memberActionPending || attachmentUploadPending) {
    feedback.textContent = "Termina prima l'operazione in corso.";
    feedback.className = "member-feedback error";
    return;
  }
  if (!send({
    t: "community_invite_response",
    community: invitation.community,
    action,
  })) {
    feedback.textContent = "Connessione non disponibile. Riprova.";
    feedback.className = "member-feedback error";
    return;
  }
  pendingInviteResponse = { invitation, action, button, feedback };
  button.disabled = true;
  feedback.textContent = action === "accept" ? "Accettazione..." : "Rifiuto...";
  feedback.className = "member-feedback";
  pendingInviteResponseTimer = setTimeout(() => {
    finishInviteResponse("Il server non ha risposto. Riprova.", true);
  }, 20000);
}

function finishInviteResponse(message = "", isError = false) {
  if (!pendingInviteResponse) return;
  const pending = pendingInviteResponse;
  clearTimeout(pendingInviteResponseTimer);
  pendingInviteResponseTimer = null;
  pendingInviteResponse = null;
  pending.button.disabled = false;
  pending.feedback.textContent = message;
  pending.feedback.className = `member-feedback${isError ? " error" : ""}`;
  if (isError) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "member-retry";
    retry.textContent = "Riprova";
    retry.addEventListener("click", () => respondToInvite(
      pending.invitation, pending.action, pending.button, pending.feedback
    ));
    pending.feedback.append(" ", retry);
  }
}

let callTimer = null;
function renderCallPanel(message, actions = []) {
  const panel = el("callPanel");
  panel.classList.toggle("hidden", !message);
  el("callStatus").textContent = message || "";
  const container = el("callActions");
  container.replaceChildren();
  actions.forEach(({ label, icon, run, style = "btn-outline" }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn ${style} small-btn`;
    button.innerHTML = `<i class="ph ph-${icon}" aria-hidden="true"></i> ${escapeHtml(label)}`;
    button.addEventListener("click", run);
    container.appendChild(button);
  });
}

function finishCall(message = "") {
  clearTimeout(callTimer);
  callTimer = null;
  activeCall = null;
  renderCallPanel(message);
  if (message) {
    callTimer = setTimeout(() => renderCallPanel(""), 5000);
  }
}

function endActiveCall() {
  const call = activeCall;
  if (!call) return;
  if (call.id && !send({ t: "c_end", call: call.id })) {
    finishCall("Connessione non disponibile. La chiamata potrebbe essere ancora attiva.");
    return;
  }
  finishCall("Chiamata terminata.");
}

function startCall(video) {
  clearTimeout(callTimer);
  callTimer = null;
  if (!selectedContact) {
    renderCallPanel("Seleziona un contatto per avviare una chiamata.");
    return;
  }
  if (activeCall) {
    renderCallPanel("È già in corso una chiamata.", [{
      label: "Termina",
      icon: "phone-x",
      style: "btn-danger",
      run: endActiveCall,
    }]);
    return;
  }
  activeCall = { to: selectedContact, video, state: "outgoing" };
  if (!send({ t: "c_invite", to: selectedContact, video })) {
    finishCall("Connessione non disponibile. Riprova.");
    return;
  }
  renderCallPanel(`Chiamata ${video ? "video" : "vocale"} a ${selectedContact}...`, [{
    label: "Annulla",
    icon: "phone-x",
    style: "btn-danger",
    run: endActiveCall,
  }]);
  callTimer = setTimeout(() => {
    if (activeCall?.state === "outgoing" && !activeCall.id) {
      finishCall("Il server non ha risposto alla richiesta di chiamata.");
    }
  }, 20000);
}

function acceptCall() {
  if (!activeCall?.id || !send({ t: "c_accept", call: activeCall.id })) {
    finishCall("Impossibile rispondere alla chiamata. Riprova.");
    return;
  }
  clearTimeout(callTimer);
  activeCall.state = "active";
  renderCallPanel("Chiamata accettata. Audio/video non disponibile in questa sessione.", [{
    label: "Termina",
    icon: "phone-x",
    style: "btn-danger",
    run: endActiveCall,
  }]);
}

function avatarInitial(name) {
  return (name || "?").charAt(0).toUpperCase();
}

function beginMemberAction(action) {
  if (memberActionPending || pendingInviteResponse || attachmentUploadPending) return false;
  memberActionPending = action;
  memberActionTimer = setTimeout(() => {
    failMemberAction("Il server non ha risposto. Controlla la connessione e riprova.");
  }, 20000);
  return true;
}

function finishMemberAction() {
  clearTimeout(memberActionTimer);
  memberActionTimer = null;
  memberActionPending = null;
}

function failMemberAction(message) {
  if (!memberActionPending) return;
  const pending = memberActionPending;
  finishMemberAction();
  const feedback = pending.feedback || el("memberInviteFeedback");
  feedback.replaceChildren();
  feedback.textContent = message || "Operazione non riuscita.";
  feedback.className = "member-feedback error";
  if (pending.type === "invite") el("invitePersonBtn").disabled = false;
  if (/connessione|riprova|timeout|server|risposto/i.test(feedback.textContent)) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "member-retry";
    retry.textContent = "Riprova";
    retry.addEventListener("click", pending.retry);
    feedback.append(" ", retry);
  }
  if (pending.type === "remove") {
    const row = participantDirectory.querySelector(".participant-row.removing");
    row?.classList.remove("removing");
  }
}

function selectContact(username) {
  discardPendingAttachment();
  currentCommunityId = null;
  currentCommunity = null;
  currentChannelId = null;
  selectedInviteRoles.clear();
  el("memberInvitePanel").classList.add("hidden");
  el("participantIndexTitle").textContent = "Participants - Direct message";
  el("participantCount").textContent = "0";
  el("visibleParticipantCount").textContent = "0 members";
  participantDirectory.replaceChildren();
  el("communityChannelBar").classList.add("hidden");
  renderCommunityList(communityListData);
  selectedContact = username;
  convStatus.textContent = username;
  renderSelectedContact();
  renderContacts();
  messages.innerHTML = "";
  messages.appendChild(makePlaceholder("Seleziona un contatto per iniziare a chattare."));
  send({ t: "history", with: username });
  messageInput.disabled = false;
  updateSendButton();
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
  node.classList.remove(
    "name-glow", "name-pulse", "name-rainbow", "name-bounce", "name-shake", "name-wave", "name-flicker",
  );
  const animationClass = {
    glow: "name-glow",
    pulse: "name-pulse",
    rainbow: "name-rainbow",
    bounce: "name-bounce",
    shake: "name-shake",
    wave: "name-wave",
    flicker: "name-flicker",
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

function mediaElement(hash, className, previewSrc = null) {
  const mediaSrc = previewSrc || mediaCache.get(hash);
  if (!mediaSrc) {
    if (hash && !mediaRequests.has(hash)) {
      mediaRequests.add(hash);
      send({ t: "media_get", hash });
    }
    return null;
  }
  const video = mediaSrc.startsWith("data:video/");
  const media = document.createElement(video ? "video" : "img");
  media.className = className;
  media.src = mediaSrc;
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
  const avatar = mediaElement(me?.avatar, "avatar-media", me?.avatar_preview);
  if (avatar) profilePreviewAvatar.replaceChildren(avatar);
  profilePreviewBanner.replaceChildren();
  const banner = mediaElement(me?.banner, "preview-banner-media", me?.banner_preview);
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
  send({ t: "settings_get" });
  send({ t: "community_list" });
  populateLocalSettings();
}

function closeProfileModal() {
  profileModal.classList.add("hidden");
}

function switchSettingsSection(section) {
  document.querySelectorAll("[data-settings-section]").forEach(button => {
    button.classList.toggle("active", button.dataset.settingsSection === section);
  });
  document.querySelectorAll("[data-settings-panel]").forEach(panel => {
    panel.classList.toggle("active", panel.dataset.settingsPanel === section);
  });
  const titles = {
    account: "Gestisci il tuo profilo e account.",
    privacy: "Controlla chi può contattarti e cosa puoi vedere.",
    voice: "Configura dispositivi, volume e elaborazione audio.",
    notifications: "Scegli quali avvisi e suoni ricevere.",
    appearance: "Personalizza tema, testo e densità.",
    keybinds: "Assegna combinazioni rapide.",
    community: "Configura gruppi e canali amministrabili.",
  };
  el("settingsSubtitle").textContent = titles[section] || "Gestisci le impostazioni.";
}

function populateLocalSettings() {
  el("themeSelect").value = localSettings.theme;
  el("fontSize").value = localSettings.fontSize;
  el("fontSizeOut").textContent = `${localSettings.fontSize}%`;
  el("reducedMotion").checked = localSettings.reducedMotion;
  el("linkPreviews").checked = localSettings.linkPreviews;
  el("inlineImages").checked = localSettings.inlineImages;
  el("autoEmoji").checked = localSettings.autoEmoji;
  el("desktopNotifications").checked = localSettings.desktopNotifications;
  el("unreadBadge").checked = localSettings.unreadBadge;
  el("soundMessage").checked = localSettings.soundMessage;
  el("soundCall").checked = localSettings.soundCall;
  el("soundMute").checked = localSettings.soundMute;
  el("doNotDisturb").checked = localSettings.doNotDisturb;
  el("inputVolume").value = localSettings.inputVolume;
  el("outputVolume").value = localSettings.outputVolume;
  el("inputVolumeOut").textContent = `${localSettings.inputVolume}%`;
  el("outputVolumeOut").textContent = `${localSettings.outputVolume}%`;
  el("voiceSensitivity").value = localSettings.voiceSensitivity;
  el("voiceSensitivityOut").textContent = localSettings.voiceSensitivity;
  el("echoCancel").checked = localSettings.echoCancel;
  el("noiseSuppress").checked = localSettings.noiseSuppress;
  el("autoGain").checked = localSettings.autoGain;
  el("voiceActivity").checked = localSettings.inputMode === "voice";
  el("pushToTalk").checked = localSettings.inputMode === "ptt";
  document.querySelectorAll("[data-density]").forEach(button => {
    button.classList.toggle("active", button.dataset.density === localSettings.density);
  });
  document.querySelectorAll("[data-keybind]").forEach(button => {
    const value = localSettings.keybinds[button.dataset.keybind];
    button.textContent = value || "Non impostato";
  });
  applyLiveAppearance();
  enumerateMediaDevices();
}

function collectLocalSettings() {
  return {
    theme: el("themeSelect").value,
    density: document.querySelector("[data-density].active")?.dataset.density || "cozy",
    fontSize: Number(el("fontSize").value),
    reducedMotion: el("reducedMotion").checked,
    linkPreviews: el("linkPreviews").checked,
    inlineImages: el("inlineImages").checked,
    autoEmoji: el("autoEmoji").checked,
    desktopNotifications: el("desktopNotifications").checked,
    unreadBadge: el("unreadBadge").checked,
    soundMessage: el("soundMessage").checked,
    soundCall: el("soundCall").checked,
    soundMute: el("soundMute").checked,
    doNotDisturb: el("doNotDisturb").checked,
    audioInput: el("audioInput").value,
    audioOutput: el("audioOutput").value,
    videoInput: el("videoInput").value,
    inputVolume: Number(el("inputVolume").value),
    outputVolume: Number(el("outputVolume").value),
    inputMode: el("pushToTalk").checked ? "ptt" : "voice",
    voiceSensitivity: Number(el("voiceSensitivity").value),
    echoCancel: el("echoCancel").checked,
    noiseSuppress: el("noiseSuppress").checked,
    autoGain: el("autoGain").checked,
    keybinds: { ...localSettings.keybinds },
  };
}

function applyLiveAppearance() {
  document.body.classList.remove("theme-oled", "theme-light", "message-compact", "reduced-motion");
  if (localSettings.theme === "oled") document.body.classList.add("theme-oled");
  if (localSettings.theme === "light") document.body.classList.add("theme-light");
  if (localSettings.density === "compact") document.body.classList.add("message-compact");
  if (localSettings.reducedMotion) document.body.classList.add("reduced-motion");
  document.documentElement.style.fontSize = `${localSettings.fontSize}%`;
  if ("setAppBadge" in navigator && localSettings.unreadBadge) navigator.setAppBadge(0).catch(() => {});
  if ("clearAppBadge" in navigator && !localSettings.unreadBadge) navigator.clearAppBadge().catch(() => {});
}

function markUnsaved() {
  el("unsavedBar").classList.remove("hidden");
}

function saveSettings() {
  localSettings = collectLocalSettings();
  localStorage.setItem("ciaochat.settings", JSON.stringify(localSettings));
  applyLiveAppearance();

  send({
    t: "account_update",
    username: el("accountUsername").value.trim(),
    display_name: el("accountDisplayName").value.trim(),
    email: el("accountEmail").value.trim(),
    bio: el("accountBio").value.trim(),
    status: el("accountStatus").value.trim(),
    status_expires_in: Number(el("accountStatusExpiration").value),
    current_password: el("currentPassword").value,
  });
  send({
    t: "privacy_update",
    dm_policy: el("dmPolicy").value,
    friend_request_policy: el("friendPolicy").value,
    media_filter: el("mediaFilter").checked,
  });
  send({
    t: "settings_update",
    notifications: {
      desktop: localSettings.desktopNotifications,
      badge: localSettings.unreadBadge,
      incoming_message: localSettings.soundMessage,
      call_ring: localSettings.soundCall,
      mute_unmute: localSettings.soundMute,
      dnd: localSettings.doNotDisturb,
    },
    appearance: {
      theme: localSettings.theme,
      message_density: localSettings.density,
      font_scale: localSettings.fontSize,
      reduced_motion: localSettings.reducedMotion,
      link_previews: localSettings.linkPreviews,
      inline_embeds: localSettings.inlineImages,
      auto_emoji: localSettings.autoEmoji,
    },
    keybinds: localSettings.keybinds,
  });
  send({ t: "profile_customization", name_color: el("nameColor").value, name_animation: el("nameAnimation").value });
  el("unsavedBar").classList.add("hidden");
  el("profileStatus").textContent = "Salvataggio...";
  el("profileStatus").className = "settings-status";
}

function resetSettings() {
  populateSettingsSnapshot(settingsSnapshot);
  populateLocalSettings();
  el("unsavedBar").classList.add("hidden");
}

function populateSettingsSnapshot(snapshot) {
  if (!snapshot) return;
  settingsSnapshot = snapshot;
  const account = snapshot.account || {};
  el("accountUsername").value = account.username || "";
  el("accountDisplayName").value = account.display_name || account.username || "";
  el("accountEmail").value = account.email || "";
  el("accountPhone").value = account.phone || "";
  el("accountBio").value = account.bio || "";
  el("accountStatus").value = account.status || "";
  el("accountStatusExpiration").value = "0";
  el("nameColor").value = me?.name_color || "#f1f5f9";
  el("nameAnimation").value = me?.name_animation || "none";
  el("dmPolicy").value = snapshot.privacy?.dm_policy || "everyone";
  const friendPolicy = snapshot.privacy?.friend_request_policy || "everyone";
  el("friendPolicy").value = friendPolicy === "friends_of_friends" ? "mutuals" : friendPolicy;
  el("mediaFilter").checked = snapshot.privacy?.media_filter !== false;
  el("twoFactorBtn").textContent = snapshot.two_factor_enabled ? "Disattiva 2FA" : "Configura 2FA";
  renderSessions(snapshot.sessions || []);
  renderBlocked(snapshot.blocked || []);
  renderProfilePreview();
}

function renderSessions(sessions) {
  const container = el("sessionsList");
  container.innerHTML = "";
  if (!sessions.length) {
    container.innerHTML = '<div class="settings-list-item muted">Nessuna sessione registrata.</div>';
    return;
  }
  sessions.forEach(session => {
    const item = document.createElement("div");
    item.className = "settings-list-item";
    item.innerHTML = `<span>${session.current ? "<strong>Questa sessione</strong>" : "Sessione"}<br><small class=\"muted\">${new Date((session.created || 0) * 1000).toLocaleString()}</small></span>`;
    const button = document.createElement("button");
    button.className = "btn btn-outline";
    button.textContent = "Disconnetti";
    button.onclick = () => send({ t: "session_revoke", session: session.id });
    item.appendChild(button);
    container.appendChild(item);
  });
}

function renderBlocked(blocked) {
  const container = el("blockedUsersList");
  container.innerHTML = "";
  if (!blocked.length) {
    container.innerHTML = '<div class="settings-list-item muted">Nessun utente bloccato.</div>';
    return;
  }
  blocked.forEach(profile => {
    const item = document.createElement("div");
    item.className = "settings-list-item";
    item.innerHTML = `<span><strong>${profile.name || profile.username}</strong><small class="muted">@${profile.username}</small></span>`;
    const button = document.createElement("button");
    button.className = "btn btn-outline";
    button.textContent = "Sblocca";
    button.onclick = () => send({ t: "block_update", user: profile.username, action: "unblock" });
    item.appendChild(button);
    container.appendChild(item);
  });
}

async function enumerateMediaDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    ["audioInput", "audioOutput", "videoInput"].forEach(id => el(id).innerHTML = "");
    devices.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `${device.kind} ${index + 1}`;
      if (device.kind === "audioinput") el("audioInput").appendChild(option);
      if (device.kind === "audiooutput") el("audioOutput").appendChild(option);
      if (device.kind === "videoinput") el("videoInput").appendChild(option);
    });
    if (localSettings.audioInput) el("audioInput").value = localSettings.audioInput;
    if (localSettings.audioOutput) el("audioOutput").value = localSettings.audioOutput;
    if (localSettings.videoInput) el("videoInput").value = localSettings.videoInput;
  } catch {
    el("profileStatus").textContent = "Consenti l'accesso ai dispositivi per visualizzarne l'elenco.";
  }
}

let micLoopbackStream = null;
async function toggleMicLoopback(enabled) {
  if (!enabled) {
    micLoopbackStream?.getTracks().forEach(track => track.stop());
    micLoopbackStream = null;
    el("micLoopbackAudio").pause();
    el("micLoopbackAudio").srcObject = null;
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) return;
  try {
    micLoopbackStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: el("audioInput").value ? { exact: el("audioInput").value } : undefined,
        echoCancellation: el("echoCancel").checked,
        noiseSuppression: el("noiseSuppress").checked,
        autoGainControl: el("autoGain").checked,
      },
      video: false,
    });
    el("micLoopbackAudio").srcObject = micLoopbackStream;
    el("micLoopbackAudio").muted = false;
    await el("micLoopbackAudio").play();
  } catch {
    el("micLoopback").checked = false;
    el("profileStatus").textContent = "Impossibile avviare il test del microfono.";
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function renderCommunityNav(communities) {
  const nav = el("communitySettingsNav");
  nav.innerHTML = "";
  (communities || []).filter(community => community.can_manage).forEach(community => {
    const button = document.createElement("button");
    button.className = "settings-nav";
    button.dataset.settingsSection = "community";
    button.dataset.communityId = community.id;
    button.textContent = community.name || "Community";
    button.onclick = () => {
      switchSettingsSection("community");
      send({ t: "community_get", community: community.id });
    };
    nav.appendChild(button);
  });
  if (!nav.children.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.padding = "8px 10px";
    empty.style.fontSize = "0.78rem";
    empty.textContent = "Nessun gruppo amministrabile";
    nav.appendChild(empty);
  }
}

function renderCommunitySnapshot(data) {
  communitySnapshot = data;
  const permissions = data.permissions || {};
  if (!permissions.manage_community && !permissions.administrator) {
    el("communitySettingsContent").innerHTML = '<h3>Accesso negato</h3><p class="muted">Non hai i permessi per modificare questa community.</p>';
    return;
  }
  const channels = data.channels || [];
  const roles = data.roles || {};
  const invites = data.invites || {};
  const bans = data.bans || {};
  const audit = data.audit || [];
  const roleEntries = Object.entries(roles).sort((a, b) => (b[1].position || 0) - (a[1].position || 0));
  const permissionNames = [
    "view_channels", "send_messages", "attach_files", "manage_messages", "manage_channels",
    "manage_roles", "manage_community", "kick_members", "ban_members", "administrator",
  ];

  el("communitySettingsContent").innerHTML = `
    <h3>${escapeHtml(data.name)}</h3>
    <div class="community-tabs">
      <button class="community-tab active" data-community-sub="overview">Panoramica</button>
      ${permissions.manage_roles || permissions.administrator ? '<button class="community-tab" data-community-sub="roles">Ruoli</button>' : ""}
      ${permissions.manage_channels || permissions.administrator ? '<button class="community-tab" data-community-sub="channels">Canali</button>' : ""}
      ${permissions.create_invites || permissions.administrator ? '<button class="community-tab" data-community-sub="invites">Inviti &amp; ban</button>' : ""}
      ${permissions.view_audit_log || permissions.administrator ? '<button class="community-tab" data-community-sub="audit">Audit log</button>' : ""}
    </div>
    <div class="community-subpanel active" data-community-panel="overview">
      <div class="settings-grid">
        <div class="setting-field"><label>Nome gruppo</label><input id="communityName" value="${escapeHtml(data.name)}" maxlength="64"></div>
        <div class="setting-field"><label>Notifiche predefinite</label><select id="communityNotification"><option value="all" ${data.default_notification === "all" ? "selected" : ""}>Tutti i messaggi</option><option value="mentions" ${data.default_notification === "mentions" ? "selected" : ""}>Solo menzioni</option></select></div>
        <div class="setting-field"><label>Icona</label><input id="communityIconFile" type="file" accept=".jpg,.png,.webp,.gif"></div>
        <div class="setting-field"><label>Banner</label><input id="communityBannerFile" type="file" accept=".jpg,.png,.webp,.mp4,.gif"></div>
        <div class="setting-field full"><label>Canale di benvenuto</label><select id="communityWelcome">${channels.map(channel => `<option value="${escapeHtml(channel.id)}" ${channel.id === data.welcome_channel ? "selected" : ""}>${escapeHtml(channel.name)}</option>`).join("")}</select></div>
      </div>
      <button class="btn btn-primary small-btn" id="saveCommunityOverview" type="button">Salva panoramica</button>
    </div>
    <div class="community-subpanel" data-community-panel="roles">
      <div class="role-list" id="communityRoleList">${roleEntries.map(([id, role]) => id !== "everyone" && id !== "owner" ? `
        <div class="role-item" draggable="true" data-role-id="${escapeHtml(id)}">
          <span class="role-dot" style="background:${escapeHtml(role.color)}"></span>
          <strong>${escapeHtml(role.name)}</strong>
          <button class="btn btn-outline small-btn role-edit" type="button" data-role-id="${escapeHtml(id)}">Modifica</button>
          <button class="btn btn-outline small-btn role-delete" type="button" data-role-id="${escapeHtml(id)}">Elimina</button>
        </div>` : "").join("")}</div>
      <button class="btn btn-outline small-btn" id="createRoleBtn" type="button" style="margin-top:10px">Crea ruolo</button>
      <div id="roleEditor" class="settings-card"></div>
    </div>
    <div class="community-subpanel" data-community-panel="channels">
      ${channels.map(channel => `
        <div class="settings-card">
          <div class="settings-grid">
            <div class="setting-field"><label>Nome canale</label><input class="channel-name" data-channel="${escapeHtml(channel.id)}" value="${escapeHtml(channel.name)}"></div>
            <div class="setting-field"><label>Argomento</label><input class="channel-topic" data-channel="${escapeHtml(channel.id)}" value="${escapeHtml(channel.topic || "")}"></div>
          </div>
          <label class="range-row"><span>Slowmode: <output class="slowmode-output">${channel.slowmode || 0}s</output></span><input class="channel-slowmode" data-channel="${escapeHtml(channel.id)}" type="range" min="0" max="3600" step="1" value="${channel.slowmode || 0}"></label>
          <button class="btn btn-primary small-btn save-channel" data-channel="${escapeHtml(channel.id)}" type="button">Salva canale</button>
          <button class="btn btn-outline small-btn delete-channel" data-channel="${escapeHtml(channel.id)}" type="button">Elimina</button>
          <h4 style="margin-top:14px">Override ruoli</h4>
          ${roleEntries.filter(([id]) => id !== "everyone").map(([roleId, role]) => {
            const override = (channel.overrides && channel.overrides[roleId]) || {};
            return `<div class="setting-row"><strong style="color:${escapeHtml(role.color)}">${escapeHtml(role.name)}</strong><div class="tri-toggle" data-role="${escapeHtml(roleId)}" data-channel="${escapeHtml(channel.id)}">${permissionNames.slice(0, 5).map(permission => `<button type="button" data-permission="${permission}" data-state="${override[permission] || "inherit"}" title="${permission}">${permission.replace(/_/g," ").replace("messages","msg.")}</button>`).join("")}</div></div>`;
          }).join("")}
          <button class="btn btn-outline small-btn apply-overrides" data-channel="${escapeHtml(channel.id)}" type="button">Applica override</button>
        </div>`).join("")}
      <button class="btn btn-outline small-btn" id="createChannelBtn" type="button" style="margin-top:10px">Crea canale</button>
    </div>
    <div class="community-subpanel" data-community-panel="invites">
      <button class="btn btn-outline small-btn" id="createInviteBtn" type="button">Crea invito</button>
      <div class="table-wrap" style="margin-top:12px"><table class="settings-table"><thead><tr><th>Codice</th><th>Utilizzi</th><th>Scadenza</th><th></th></tr></thead><tbody>${Object.entries(invites).map(([code, invite]) => `<tr><td>${escapeHtml(code)}</td><td>${invite.uses || 0}/${invite.max_uses || "∞"}</td><td>${invite.expires ? new Date(invite.expires * 1000).toLocaleString() : "Mai"}</td><td><button class="btn btn-outline small-btn revoke-invite" data-code="${escapeHtml(code)}">Revoca</button></td></tr>`).join("")}</tbody></table></div>
      <h4 style="margin-top:18px">Utenti bannati</h4>
      <div class="settings-list">${Object.entries(bans).map(([user, ban]) => `<div class="settings-list-item"><span><strong>${escapeHtml(user)}</strong><small class="muted">${escapeHtml(ban.reason || "")}</small></span><button class="btn btn-outline small-btn unban-user" data-user="${escapeHtml(user)}">Rimuovi ban</button></div>`).join("") || '<span class="muted">Nessun utente bannato.</span>'}</div>
    </div>
    <div class="community-subpanel" data-community-panel="audit">
      <input id="auditFilter" type="search" placeholder="Filtra azioni..." style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;margin-bottom:10px">
      <div class="settings-list">${audit.map(event => `<div class="settings-list-item audit-event" data-action="${escapeHtml(event.action)}"><span><strong>${escapeHtml(event.action)}</strong><small class="muted">${escapeHtml(event.actor)} · ${new Date((event.timestamp || 0) * 1000).toLocaleString()}</small></span></div>`).join("") || '<span class="muted">Nessuna attività registrata.</span>'}</div>
    </div>
  `;
  bindCommunityControls(data);
}

function bindCommunityControls(data) {
  document.querySelectorAll("[data-community-sub]").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll("[data-community-sub]").forEach(item => item.classList.toggle("active", item === tab));
      document.querySelectorAll("[data-community-panel]").forEach(panel => {
        panel.classList.toggle("active", panel.dataset.communityPanel === tab.dataset.communitySub);
      });
    };
  });

  el("saveCommunityOverview")?.addEventListener("click", () => {
    send({
      t: "community_update",
      community: data.id,
      name: el("communityName").value,
      default_notification: el("communityNotification").value,
      welcome_channel: el("communityWelcome").value,
    });
  });
  ["communityIconFile", "communityBannerFile"].forEach(id => {
    el(id)?.addEventListener("change", event => {
      const file = event.target.files[0];
      if (!file) return;
      const rawExtension = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase();
      const extension = rawExtension === "jpeg" ? "jpg" : rawExtension;
      if (!extension) return;
      const reader = new FileReader();
      reader.onload = () => send({
        t: "media_put",
        community: data.id,
        kind: id === "communityIconFile" ? "community_icon" : "community_banner",
        extension,
        data: String(reader.result).split(",", 2)[1],
      });
      reader.readAsDataURL(file);
    });
  });

  el("createChannelBtn")?.addEventListener("click", () => {
    const name = prompt("Nome del nuovo canale:");
    if (name) send({ t: "community_channel_create", community: data.id, name });
  });
  document.querySelectorAll(".save-channel").forEach(button => {
    button.onclick = () => {
      const channelId = button.dataset.channel;
      send({
        t: "community_channel_update",
        community: data.id,
        channel: channelId,
        name: document.querySelector(`.channel-name[data-channel="${channelId}"]`).value,
        topic: document.querySelector(`.channel-topic[data-channel="${channelId}"]`).value,
        slowmode: Number(document.querySelector(`.channel-slowmode[data-channel="${channelId}"]`).value),
      });
    };
  });
  document.querySelectorAll(".channel-slowmode").forEach(slider => {
    slider.oninput = () => {
      slider.closest(".settings-card").querySelector(".slowmode-output").textContent = `${slider.value}s`;
    };
  });
  document.querySelectorAll(".delete-channel").forEach(button => {
    button.onclick = () => {
      if (confirm("Eliminare questo canale?")) send({
        t: "community_channel_delete", community: data.id, channel: button.dataset.channel,
      });
    };
  });

  document.querySelectorAll(".tri-toggle").forEach(toggle => {
    toggle.querySelectorAll("button").forEach(button => {
      const states = ["inherit", "allow", "deny"];
      const stateIndex = states.indexOf(button.dataset.state);
      if (stateIndex >= 0) button.classList.add("active", states[stateIndex]);
      button.onclick = () => {
        button.dataset.state = button.dataset.state === "inherit"
          ? "allow"
          : button.dataset.state === "allow"
            ? "deny"
            : "inherit";
        toggle.querySelectorAll("button").forEach(item => item.classList.remove("active", "allow", "deny", "inherit"));
        button.classList.add("active", button.dataset.state);
      };
    });
  });
  document.querySelectorAll(".apply-overrides").forEach(button => {
    button.onclick = () => {
      const toggles = document.querySelectorAll(`.tri-toggle[data-channel="${button.dataset.channel}"]`);
      toggles.forEach(toggle => {
        const overrides = {};
        toggle.querySelectorAll("button").forEach(permission => {
          overrides[permission.dataset.permission] = permission.dataset.state;
        });
        send({
          t: "community_override_update",
          community: data.id,
          channel: button.dataset.channel,
          role: toggle.dataset.role,
          overrides,
        });
      });
    };
  });

  el("createRoleBtn")?.addEventListener("click", () => {
    el("roleEditor").innerHTML = `
      <div class="settings-grid">
        <div class="setting-field"><label>Nome ruolo</label><input id="newRoleName"></div>
        <div class="setting-field"><label>Colore</label><input id="newRoleColor" type="color" value="#5865f2"></div>
        <label class="toggle-row full"><span><strong>Mostra separatamente</strong></span><input id="newRoleSeparate" type="checkbox"><span class="toggle"></span></label>
      </div>
      <button class="btn btn-primary small-btn" id="saveNewRole" type="button">Crea</button>`;
    el("saveNewRole").onclick = () => {
      const permissions = {};
      [
        "view_channels", "send_messages", "attach_files", "manage_messages", "manage_channels",
        "manage_roles", "manage_community", "kick_members", "ban_members", "administrator",
      ].forEach(permission => { permissions[permission] = false; });
      send({
        t: "community_role_create",
        community: data.id,
        name: el("newRoleName").value,
        color: el("newRoleColor").value,
        display_separately: el("newRoleSeparate").checked,
        permissions,
      });
    };
  });
  document.querySelectorAll(".role-edit").forEach(button => {
    button.onclick = () => {
      const role = data.roles[button.dataset.roleId];
      const permissionNames = [
        "view_channels", "send_messages", "attach_files", "manage_messages", "manage_channels",
        "manage_roles", "manage_community", "kick_members", "ban_members", "administrator",
      ];
      el("roleEditor").innerHTML = `
        <div class="settings-grid">
          <div class="setting-field"><label>Nome ruolo</label><input id="editRoleName" value="${escapeHtml(role.name)}"></div>
          <div class="setting-field"><label>Colore</label><input id="editRoleColor" type="color" value="${escapeHtml(role.color)}"></div>
        </div>
        <label class="toggle-row"><span><strong>Mostra separatamente</strong></span><input id="editRoleSeparate" type="checkbox" ${role.display_separately ? "checked" : ""}><span class="toggle"></span></label>
        <div class="permission-grid">${permissionNames.map(permission => `<label><input type="checkbox" class="role-permission" value="${permission}" ${role.permissions?.[permission] ? "checked" : ""}>${permission.replace(/_/g, " ")}</label>`).join("")}</div>
        <button class="btn btn-primary small-btn" id="saveRoleEdit" type="button" style="margin-top:12px">Salva ruolo</button>`;
      el("saveRoleEdit").onclick = () => {
        const permissions = {};
        permissionNames.forEach(permission => {
          permissions[permission] = !!document.querySelector(`.role-permission[value="${permission}"]`)?.checked;
        });
        send({
          t: "community_role_update",
          community: data.id,
          role: button.dataset.roleId,
          name: el("editRoleName").value,
          color: el("editRoleColor").value,
          display_separately: el("editRoleSeparate").checked,
          permissions,
        });
      };
    };
  });
  document.querySelectorAll(".role-delete").forEach(button => {
    button.onclick = () => {
      if (confirm("Eliminare questo ruolo?")) send({
        t: "community_role_delete", community: data.id, role: button.dataset.roleId,
      });
    };
  });

  const roleList = el("communityRoleList");
  roleList?.querySelectorAll(".role-item").forEach(item => {
    item.addEventListener("dragstart", () => item.classList.add("dragging"));
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      const roles = Array.from(roleList.querySelectorAll(".role-item")).map(entry => entry.dataset.roleId);
      send({ t: "community_roles_reorder", community: data.id, roles });
    });
  });
  roleList?.addEventListener("dragover", event => {
    event.preventDefault();
    const dragging = roleList.querySelector(".dragging");
    const target = event.target.closest(".role-item");
    if (!dragging || !target || target === dragging) return;
    const rect = target.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) {
      roleList.insertBefore(dragging, target);
    } else {
      roleList.insertBefore(dragging, target.nextSibling);
    }
  });

  el("createInviteBtn")?.addEventListener("click", () => {
    send({ t: "community_invite_create", community: data.id, max_uses: 0, expires_in: 604800 });
  });
  document.querySelectorAll(".revoke-invite").forEach(button => {
    button.onclick = () => send({
      t: "community_invite_revoke", community: data.id, code: button.dataset.code,
    });
  });
  document.querySelectorAll(".unban-user").forEach(button => {
    button.onclick = () => send({
      t: "community_unban", community: data.id, user: button.dataset.user,
    });
  });
  el("auditFilter")?.addEventListener("input", event => {
    const filter = event.target.value.toLowerCase();
    document.querySelectorAll(".audit-event").forEach(row => {
      row.style.display = row.dataset.action.toLowerCase().includes(filter) ? "" : "none";
    });
  });
}

function expireSession(message) {
  token = null;
  me = null;
  selectedContact = null;
  contacts = [];
  pendingMediaKind = null;
  resumePending = false;
  closeProfileModal();
  renderContacts();
  showAuth();
  setAuthMsg(message || "Sessione scaduta: accedi di nuovo.");
}

function uploadProfileMedia(kind, file) {
  if (pendingMediaKind) {
    profileStatus.textContent = "Attendi il completamento del caricamento corrente.";
    profileStatus.className = "error";
    return;
  }
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
    const dataUrl = String(reader.result);
    const base64 = dataUrl.split(",", 2)[1];
    me = { ...me, [`${kind}_preview`]: dataUrl };
    pendingMediaKind = kind;
    renderProfilePreview();
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

document.querySelectorAll("[data-settings-section]").forEach(button => {
  button.addEventListener("click", () => switchSettingsSection(button.dataset.settingsSection));
});
el("saveSettingsBtn").addEventListener("click", saveSettings);
el("resetSettingsBtn").addEventListener("click", resetSettings);
el("unsavedBar").addEventListener("input", markUnsaved);
el("unsavedBar").closest(".settings-main").addEventListener("input", markUnsaved);
el("unsavedBar").closest(".settings-main").addEventListener("change", markUnsaved);

el("changePasswordBtn").addEventListener("click", () => {
  send({
    t: "password_change",
    current_password: el("currentPassword").value,
    new_password: el("newPassword").value,
  });
});
el("twoFactorBtn").addEventListener("click", () => {
  if (settingsSnapshot?.two_factor_enabled) {
    const password = prompt("Password attuale:");
    const code = prompt("Codice 2FA a 6 cifre:");
    if (password && code) send({ t: "two_factor_disable", password, code });
  } else {
    send({ t: "two_factor_setup" });
  }
});
el("micLoopback").addEventListener("change", event => toggleMicLoopback(event.target.checked));

el("desktopNotifications").addEventListener("change", async event => {
  if (event.target.checked && "Notification" in window && Notification.permission !== "granted") {
    try { await Notification.requestPermission(); } catch {}
  }
});
el("themeSelect").addEventListener("change", () => {
  localSettings = collectLocalSettings();
  applyLiveAppearance();
});
el("fontSize").addEventListener("input", () => {
  el("fontSizeOut").textContent = `${el("fontSize").value}%`;
  localSettings = collectLocalSettings();
  applyLiveAppearance();
});
el("inputVolume").addEventListener("input", () => {
  el("inputVolumeOut").textContent = `${el("inputVolume").value}%`;
});
el("outputVolume").addEventListener("input", () => {
  el("outputVolumeOut").textContent = `${el("outputVolume").value}%`;
});
el("voiceSensitivity").addEventListener("input", () => {
  el("voiceSensitivityOut").textContent = el("voiceSensitivity").value;
});
document.querySelectorAll("[data-density]").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-density]").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    markUnsaved();
  });
});
document.querySelectorAll("[data-keybind]").forEach(button => {
  button.addEventListener("click", () => {
    button.classList.add("recording");
    button.textContent = "Premi una combinazione...";
    const capture = event => {
      event.preventDefault();
      event.stopPropagation();
      if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;
      const keys = [];
      if (event.ctrlKey) keys.push("Ctrl");
      if (event.shiftKey) keys.push("Shift");
      if (event.altKey) keys.push("Alt");
      if (event.metaKey) keys.push("Meta");
      keys.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
      localSettings.keybinds[button.dataset.keybind] = keys.join("+");
      button.textContent = keys.join("+");
      button.classList.remove("recording");
      markUnsaved();
      window.removeEventListener("keydown", capture, true);
    };
    window.addEventListener("keydown", capture, true);
  });
});
nameColor.addEventListener("input", () => {
  styleName(profilePreviewName, { ...me, name_color: nameColor.value });
});
nameAnimation.addEventListener("change", () => {
  styleName(profilePreviewName, { ...me, name_animation: nameAnimation.value });
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

newChatBtn.onclick = () => el("quickContactInput").focus();

function submitQuickContact() {
  const input = el("quickContactInput");
  const identifier = input.value.trim();
  const feedback = el("quickContactFeedback");
  if (!identifier) {
    feedback.textContent = "Inserisci uno username o un numero.";
    feedback.className = "error";
    input.focus();
    return;
  }
  if (!send({ t: "add_contact", query: identifier })) {
    feedback.textContent = "Connessione non disponibile. Riprova.";
    feedback.className = "error";
    return;
  }
  quickContactPending = true;
  feedback.textContent = "Ricerca contatto...";
  feedback.className = "";
  clearTimeout(quickContactTimer);
  quickContactTimer = setTimeout(() => {
    if (!quickContactPending) return;
    quickContactPending = false;
    feedback.textContent = "Il server non ha risposto. Riprova.";
    feedback.className = "error";
  }, 20000);
}

el("quickContactAddBtn").addEventListener("click", submitQuickContact);
el("quickContactInput").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitQuickContact();
  }
});
el("createCommunityBtn").addEventListener("click", () => {
  const input = el("newCommunityName");
  const name = input.value.trim();
  const feedback = el("communityCreateFeedback");
  if (!name) {
    input.setCustomValidity("Inserisci il nome del gruppo.");
    input.reportValidity();
    return;
  }
  input.setCustomValidity("");
  if (pendingCommunityCreate) return;
  if (!send({ t: "community_create", name })) {
    feedback.textContent = "Connessione non disponibile. Riprova.";
    feedback.className = "inline-action-feedback error";
    return;
  }
  pendingCommunityCreate = true;
  el("createCommunityBtn").disabled = true;
  feedback.textContent = "Creazione del gruppo...";
  feedback.className = "inline-action-feedback";
  pendingCommunityCreateTimer = setTimeout(() => {
    if (!pendingCommunityCreate) return;
    pendingCommunityCreate = false;
    el("createCommunityBtn").disabled = false;
    feedback.textContent = "Il server non ha risposto. Riprova.";
    feedback.className = "inline-action-feedback error";
  }, 20000);
});
el("newCommunityName").addEventListener("input", event => event.target.setCustomValidity(""));
el("newCommunityName").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    el("createCommunityBtn").click();
  }
});

function submitMemberInvite() {
  const input = el("memberIdentifier");
  const identifier = input.value.trim();
  const feedback = el("memberInviteFeedback");
  feedback.replaceChildren();
  feedback.className = "member-feedback";
  if (memberActionPending || pendingInviteResponse || attachmentUploadPending) {
    feedback.textContent = "Termina prima l'operazione in corso.";
    feedback.classList.add("error");
    return;
  }
  if (!currentCommunityId || !currentCommunity) {
    feedback.textContent = "Seleziona prima un gruppo.";
    feedback.classList.add("error");
    return;
  }
  if (!identifier) {
    feedback.textContent = "Enter an email or username.";
    feedback.classList.add("error");
    input.focus();
    return;
  }
  const looksLikeEmail = identifier.includes("@");
  const validIdentifier = looksLikeEmail
    ? /^[^@\s]{1,64}@[^@\s.]+(?:\.[^@\s.]+)+$/.test(identifier)
    : /^(?=.*[A-Za-z])[A-Za-z0-9]{3,20}$/.test(identifier.replace(/^@/, ""));
  if (!validIdentifier) {
    feedback.textContent = "Enter a valid email or a 3-20 character username.";
    feedback.classList.add("error");
    input.focus();
    return;
  }
  const roleMap = currentCommunity.roles || {};
  const invalidRole = Array.from(selectedInviteRoles).some(roleId => !roleMap[roleId]);
  if (invalidRole) {
    feedback.textContent = "Aggiorna la selezione: uno dei ruoli non è più disponibile.";
    feedback.classList.add("error");
    send({ t: "community_get", community: currentCommunityId });
    return;
  }
  const payload = {
    t: "community_member_invite",
    community: currentCommunityId,
    identifier,
    roles: Array.from(selectedInviteRoles),
  };
  if (!send(payload)) {
    feedback.textContent = "Connessione non disponibile. Riprova.";
    feedback.classList.add("error");
    return;
  }
  beginMemberAction({
    type: "invite",
    retry: () => submitMemberInvite(),
    feedback,
  });
  el("invitePersonBtn").disabled = true;
  feedback.textContent = "Invio dell'invito...";
}

el("invitePersonBtn").addEventListener("click", submitMemberInvite);
el("memberIdentifier").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitMemberInvite();
  }
});
el("memberIdentifier").addEventListener("input", event => {
  el("clearMemberIdentifier").classList.toggle("hidden", !event.target.value);
});
el("clearMemberIdentifier").addEventListener("click", () => {
  el("memberIdentifier").value = "";
  el("memberIdentifier").focus();
  el("clearMemberIdentifier").classList.add("hidden");
});
participantSearch.addEventListener("input", () => {
  el("clearParticipantSearch").classList.toggle("hidden", !participantSearch.value);
  if (currentCommunity) renderParticipants(currentCommunity);
});
el("clearParticipantSearch").addEventListener("click", () => {
  participantSearch.value = "";
  participantSearch.dispatchEvent(new Event("input"));
  participantSearch.focus();
});
el("participantIndexToggle").addEventListener("click", () => {
  const expanded = el("participantIndexToggle").getAttribute("aria-expanded") === "true";
  el("participantIndexToggle").setAttribute("aria-expanded", String(!expanded));
  el("participantIndex").classList.toggle("collapsed", expanded);
  el("participantIndexChevron").className = expanded ? "ph ph-caret-up" : "ph ph-caret-down";
});
el("participantOverflow").addEventListener("click", () => {
  el("participantOverflowMenu").classList.toggle("hidden");
});
el("refreshParticipantsBtn").addEventListener("click", () => {
  el("participantOverflowMenu").classList.add("hidden");
  if (currentCommunityId) send({ t: "community_get", community: currentCommunityId });
});
el("openGroupSettingsBtn").addEventListener("click", () => {
  el("participantOverflowMenu").classList.add("hidden");
  if (currentCommunityId) {
    openProfileModal();
    switchSettingsSection("community");
    send({ t: "community_get", community: currentCommunityId });
  }
});

el("searchButton").addEventListener("click", () => {
  const search = currentCommunity ? participantSearch : contactSearch;
  search.focus();
  search.select?.();
});
el("microphoneButton").addEventListener("click", () => {
  openProfileModal();
  switchSettingsSection("voice");
  el("micLoopback").focus();
});
el("voiceCallButton").addEventListener("click", () => startCall(false));
el("callButton").addEventListener("click", () => startCall(true));

function setComposerFeedback(message, state = "") {
  composerFeedback.textContent = message;
  composerFeedback.className = `composer-feedback${state ? ` ${state}` : ""}`;
}

function updateSendButton() {
  const hasAttachment = !!pendingChatAttachment?.hash;
  sendBtn.disabled = messageInput.disabled || attachmentUploadPending ||
    (!messageInput.value.trim() && !hasAttachment);
}

function discardPendingAttachment() {
  clearTimeout(attachmentTimer);
  attachmentTimer = null;
  attachmentUploadPending = false;
  pendingChatAttachment = null;
  attachButton.disabled = false;
  attachmentInput.value = "";
  attachmentPreview.replaceChildren();
  attachmentPreview.classList.add("hidden");
  updateSendButton();
}

function renderPendingAttachment() {
  attachmentPreview.replaceChildren();
  attachmentPreview.classList.toggle("hidden", !pendingChatAttachment);
  if (!pendingChatAttachment) return;
  const label = document.createElement("span");
  label.innerHTML = `<i class="ph ph-${attachmentUploadPending ? "circle-notch" : "paperclip"}" aria-hidden="true"></i> `;
  label.append(document.createTextNode(
    `${pendingChatAttachment.name}${attachmentUploadPending ? " · Caricamento..." : " · Pronto per l'invio"}`
  ));
  attachmentPreview.appendChild(label);
  if (!attachmentUploadPending) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.setAttribute("aria-label", "Rimuovi allegato");
    remove.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
    remove.addEventListener("click", discardPendingAttachment);
    attachmentPreview.appendChild(remove);
  }
}

function uploadChatAttachment(file) {
  if (!selectedContact && !(currentCommunityId && currentChannelId)) {
    setComposerFeedback("Apri una conversazione prima di allegare un file.", "error");
    return;
  }
  const rawExtension = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase();
  const extension = rawExtension === "jpeg" ? "jpg" : rawExtension;
  const mimeByExtension = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    webp: "image/webp", gif: "image/gif", mp4: "video/mp4",
  };
  if (!extension || !mimeByExtension[extension]) {
    setComposerFeedback("Sono supportati solo JPG, PNG, WEBP, GIF e MP4.", "error");
    return;
  }
  if (!file.size || file.size > 1_700_000) {
    setComposerFeedback("L'allegato deve essere inferiore a 1,7 MB.", "error");
    return;
  }
  if (attachmentUploadPending) {
    setComposerFeedback("Attendi il completamento dell'upload corrente.", "error");
    return;
  }
  if (memberActionPending || pendingInviteResponse) {
    setComposerFeedback("Attendi il completamento dell'operazione in corso.", "error");
    return;
  }
  pendingChatAttachment = {
    name: file.name,
    mime: file.type || mimeByExtension[extension],
    target: currentCommunityId && currentChannelId
      ? { community: currentCommunityId, channel: currentChannelId }
      : { to: selectedContact },
  };
  attachmentUploadPending = true;
  attachButton.disabled = true;
  setComposerFeedback("", "");
  renderPendingAttachment();
  updateSendButton();
  const upload = pendingChatAttachment;
  const reader = new FileReader();
  reader.onerror = () => {
    if (pendingChatAttachment !== upload) return;
    discardPendingAttachment();
    setComposerFeedback("Impossibile leggere il file selezionato.", "error");
  };
  reader.onload = () => {
    if (pendingChatAttachment !== upload) return;
    const data = String(reader.result).split(",", 2)[1];
    if (!data || !send({ t: "media_put", kind: "attachment", extension, data })) {
      discardPendingAttachment();
      setComposerFeedback("Upload non avviato. Controlla la connessione e riprova.", "error");
      return;
    }
    attachmentTimer = setTimeout(() => {
      if (!attachmentUploadPending) return;
      discardPendingAttachment();
      setComposerFeedback("Upload scaduto. Seleziona di nuovo il file.", "error");
    }, 20000);
  };
  reader.readAsDataURL(file);
}

function sendChatMessage() {
  const text = messageInput.value.trim();
  if (attachmentUploadPending) {
    setComposerFeedback("Attendi il completamento dell'upload.", "error");
    return;
  }
  const attachment = pendingChatAttachment?.hash ? {
    hash: pendingChatAttachment.hash,
    name: pendingChatAttachment.name,
  } : null;
  if (!text && !attachment) return;
  const target = attachment
    ? pendingChatAttachment.target
    : currentCommunityId && currentChannelId
      ? { community: currentCommunityId, channel: currentChannelId }
      : selectedContact
        ? { to: selectedContact }
        : null;
  const payload = target?.community
    ? { t: "community_channel_send", ...target, text, ...(attachment ? { attachment } : {}) }
    : { t: "dm", to: target?.to || selectedContact, text, ...(attachment ? { attachment } : {}) };
  if (!payload.to && !payload.community) {
    setComposerFeedback("Seleziona una conversazione o un canale.", "error");
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setComposerFeedback("Connessione non disponibile. Il messaggio è ancora qui: riprova.", "error");
    return;
  }
  if (!send(payload)) {
    setComposerFeedback("Messaggio non inviato: connessione non disponibile.", "error");
    return;
  }
  messageInput.value = "";
  discardPendingAttachment();
  setComposerFeedback("", "");
  updateSendButton();
}

function insertAtCursor(value, selectFromEnd = 0) {
  const start = messageInput.selectionStart;
  const end = messageInput.selectionEnd;
  const text = messageInput.value;
  messageInput.value = text.slice(0, start) + value + text.slice(end);
  const cursor = start + value.length - selectFromEnd;
  messageInput.setSelectionRange(cursor, cursor);
  messageInput.focus();
  updateSendButton();
}

function wrapSelection(marker) {
  const start = messageInput.selectionStart;
  const end = messageInput.selectionEnd;
  const selected = messageInput.value.slice(start, end);
  const replacement = selected
    ? `${marker}${selected}${marker}`
    : `${marker}${marker}`;
  const caret = start + marker.length + (selected ? selected.length : 0);
  messageInput.setRangeText(replacement, start, end, "end");
  if (!selected) messageInput.setSelectionRange(caret, caret);
  messageInput.focus();
  updateSendButton();
}

function toggleComposerPicker(button, panel, render) {
  const opening = panel.classList.contains("hidden");
  el("emojiPicker").classList.add("hidden");
  el("mentionPicker").classList.add("hidden");
  el("emojiButton").setAttribute("aria-expanded", "false");
  el("mentionButton").setAttribute("aria-expanded", "false");
  if (opening) {
    render();
    panel.classList.remove("hidden");
    button.setAttribute("aria-expanded", "true");
  }
}

const commonEmoji = ["😀", "😂", "😊", "😍", "👍", "👏", "🎉", "❤️", "🙏", "🔥"];
el("emojiButton").addEventListener("click", () => {
  toggleComposerPicker(el("emojiButton"), el("emojiPicker"), () => {
    const panel = el("emojiPicker");
    panel.replaceChildren();
    commonEmoji.forEach(emoji => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "emoji-choice";
      button.textContent = emoji;
      button.setAttribute("aria-label", emoji);
      button.addEventListener("click", () => {
        insertAtCursor(emoji);
        panel.classList.add("hidden");
        el("emojiButton").setAttribute("aria-expanded", "false");
      });
      panel.appendChild(button);
    });
  });
});
el("boldButton").addEventListener("click", () => wrapSelection("**"));
el("italicButton").addEventListener("click", () => wrapSelection("*"));
el("linkButton").addEventListener("click", () => {
  const start = messageInput.selectionStart;
  const end = messageInput.selectionEnd;
  const selected = messageInput.value.slice(start, end);
  if (selected) {
    const replacement = `[${selected}](https://)`;
    messageInput.setRangeText(replacement, start, end, "end");
    const cursor = start + selected.length + 3;
    messageInput.setSelectionRange(cursor, cursor + 8);
    messageInput.focus();
    updateSendButton();
  } else {
    insertAtCursor("https://");
  }
});
el("mentionButton").addEventListener("click", () => {
  toggleComposerPicker(el("mentionButton"), el("mentionPicker"), () => {
    const panel = el("mentionPicker");
    panel.replaceChildren();
    const candidates = currentCommunity?.participants || (
      selectedContact ? [contactProfile(selectedContact)].filter(Boolean) : []
    );
    if (!candidates.length) {
      const empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = "Seleziona una conversazione per menzionare qualcuno.";
      panel.appendChild(empty);
      return;
    }
    candidates.forEach(person => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mention-choice";
      button.textContent = `@${person.username || person.id}`;
      button.addEventListener("click", () => {
        insertAtCursor(`${button.textContent} `);
        panel.classList.add("hidden");
        el("mentionButton").setAttribute("aria-expanded", "false");
      });
      panel.appendChild(button);
    });
  });
});
attachButton.addEventListener("click", () => attachmentInput.click());
attachmentInput.addEventListener("change", event => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) uploadChatAttachment(file);
});

logoutBtn.onclick = () => {
  send({ t: "logout", token });
  closeProfileModal();
  token = null;
  me = null;
  selectedContact = null;
  contacts = [];
  resumePending = false;
  finishCall();
  discardPendingAttachment();
  showAuth();
};

messageInput.addEventListener("input", () => {
  updateSendButton();
});
messageInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendChatMessage();
  }
});
sendBtn.addEventListener("click", sendChatMessage);
el("searchButton").setAttribute("aria-label", "Cerca contatti o partecipanti");
el("microphoneButton").title = "Apri test microfono";
el("microphoneButton").setAttribute("aria-label", "Apri test microfono");

// ---------- Incoming messages ----------
function onMessage(event) {
  let m;
  try { m = JSON.parse(event.data); } catch { return; }

  switch (m.t) {
    case "ok":
      resumePending = false;
      registrationAwaitingOtp = false;
      el("otpField").classList.add("hidden");
      el("registerOtp").required = false;
      el("registerOtp").value = "";
      el("registerSubmit").textContent = "Crea account";
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
      send({ t: "community_list" });
      break;

    case "settings_data":
      populateSettingsSnapshot(m);
      break;

    case "account_saved":
      if (m.account) populateSettingsSnapshot({ ...(settingsSnapshot || {}), account: m.account });
      el("profileStatus").textContent = "Impostazioni account salvate.";
      el("profileStatus").className = "settings-status success";
      break;

    case "SESSION_REVOKED":
      if (m.current) expireSession("Questa sessione è stata disconnessa.");
      break;

    case "privacy_saved":
      el("profileStatus").textContent = "Impostazioni privacy salvate.";
      el("profileStatus").className = "settings-status success";
      break;

    case "password_changed":
      el("profileStatus").textContent = "Password modificata.";
      el("profileStatus").className = "settings-status success";
      break;

    case "two_factor_setup": {
      const uri = m.otpauth_uri || "";
      const code = prompt(`Configurazione 2FA\nSecret: ${m.secret}\nInserisci il codice a 6 cifre:`);
      if (code) send({ t: "two_factor_enable", code });
      break;
    }

    case "two_factor_saved":
      el("profileStatus").textContent = m.enabled ? "Autenticazione a due fattori attivata." : "Autenticazione a due fattori disattivata.";
      el("profileStatus").className = "settings-status success";
      send({ t: "settings_get" });
      break;

    case "c_ringing":
      if (activeCall?.state === "outgoing") {
        activeCall.id = m.call;
        clearTimeout(callTimer);
        callTimer = null;
        renderCallPanel(`Chiamata ${activeCall.video ? "video" : "vocale"} in attesa di risposta...`, [{
          label: "Annulla",
          icon: "phone-x",
          style: "btn-danger",
          run: endActiveCall,
        }]);
      }
      break;

    case "c_incoming": {
      if (activeCall) {
        send({ t: "c_end", call: m.call });
        break;
      }
      const caller = contactProfile(m.from)?.name || m.from;
      activeCall = { id: m.call, from: m.from, video: !!m.video, state: "incoming" };
      renderCallPanel(`${caller} ti sta chiamando${m.video ? " in video" : ""}.`, [
        {
          label: "Rispondi",
          icon: "phone",
          style: "btn-primary",
          run: acceptCall,
        },
        {
          label: "Rifiuta",
          icon: "phone-x",
          style: "btn-danger",
          run: () => {
            send({ t: "c_end", call: activeCall?.id });
            finishCall("Chiamata rifiutata.");
          },
        },
      ]);
      break;
    }

    case "c_accepted":
      if (activeCall?.id === m.call) {
        activeCall.state = "active";
        renderCallPanel("Chiamata accettata. Audio/video non disponibile in questa sessione.", [{
          label: "Termina",
          icon: "phone-x",
          style: "btn-danger",
          run: endActiveCall,
        }]);
      }
      break;

    case "c_ended":
      if (activeCall?.id === m.call) {
        const reasons = {
          no_answer: "Nessuna risposta.",
          declined: "Chiamata rifiutata.",
          cancelled: "Chiamata annullata.",
          dropped: "Connessione alla chiamata interrotta.",
          ended: "Chiamata terminata.",
        };
        finishCall(reasons[m.reason] || "Chiamata terminata.");
      }
      break;

    case "c_taken":
      if (activeCall?.id === m.call) finishCall("La chiamata è stata risposta su un altro dispositivo.");
      break;

    case "community_list":
      communityListData = m.communities || [];
      renderCommunityList(communityListData);
      renderCommunityNav(m.communities || []);
      renderPendingInvitations(m.invitations || []);
      break;

    case "community_data":
      renderCommunitySnapshot(m.community);
      if (m.community && (
        pendingGroupSelection ||
        (currentCommunityId && m.community.id === currentCommunityId)
      )) {
        currentCommunityId = m.community.id;
        showCommunityInChat(m.community);
      }
      break;

    case "community_history":
      if (m.community === currentCommunityId && m.channel === currentChannelId) {
        renderCommunityHistory(m.messages || []);
      }
      break;

    case "community_message":
      if (m.community === currentCommunityId && m.channel === currentChannelId) {
        appendCommunityMessage(m.message);
      }
      break;

    case "community_invite_received":
      if (m.invite) {
        const current = pendingInvitations.filter(item => item.community !== m.invite.group);
        current.push({
          community: m.invite.group,
          name: m.invite.name,
          inviter: m.invite.inviter,
        });
        renderPendingInvitations(current);
      }
      break;

    case "community_invite_accepted":
    case "community_invite_removed":
      finishInviteResponse();
      pendingInvitations = pendingInvitations.filter(item => item.community !== m.community);
      renderPendingInvitations(pendingInvitations);
      send({ t: "community_list" });
      if (m.t === "community_invite_accepted") selectCommunity(m.community);
      break;

    case "community_invite_response":
      if (currentCommunityId === m.community) send({ t: "community_get", community: m.community });
      break;

    case "member_roles_saved":
      finishMemberAction();
      el("memberInviteFeedback").textContent = "Ruoli aggiornati.";
      el("memberInviteFeedback").className = "member-feedback success";
      send({ t: "community_get", community: m.community });
      break;

    case "member_removed":
      finishMemberAction();
      el("memberInviteFeedback").textContent = "Membro rimosso dalla community.";
      el("memberInviteFeedback").className = "member-feedback success";
      send({ t: "community_get", community: m.community });
      break;

    case "member_invite_revoked":
      finishMemberAction();
      el("memberInviteFeedback").textContent = "Invito revocato.";
      el("memberInviteFeedback").className = "member-feedback success";
      send({ t: "community_get", community: m.community });
      break;

    case "community_removed":
      if (currentCommunityId === m.community) {
        currentCommunityId = null;
        currentCommunity = null;
        currentChannelId = null;
        convName.textContent = "Seleziona un contatto";
        convStatus.textContent = "Seleziona una conversazione";
        el("participantIndexTitle").textContent = "Participants - Select a group";
        el("participantCount").textContent = "0";
        el("participantDirectory").replaceChildren();
        el("communityChannelBar").classList.add("hidden");
        el("messages").replaceChildren(makePlaceholder("Seleziona un contatto per iniziare a chattare."));
        send({ t: "community_list" });
      }
      break;

    case "member_invited": {
      const feedback = el("memberInviteFeedback");
      finishMemberAction();
      el("invitePersonBtn").disabled = false;
      el("memberIdentifier").value = "";
      el("clearMemberIdentifier").classList.add("hidden");
      selectedInviteRoles.clear();
      el("suggestedRoles").querySelectorAll(".suggested-role").forEach(button => {
        button.classList.remove("selected");
        button.setAttribute("aria-pressed", "false");
      });
      feedback.innerHTML = `<i class="ph ph-check-circle" aria-hidden="true"></i> Invited ${escapeHtml(m.username || m.user)}.`;
      feedback.className = "member-feedback success";
      if (currentCommunityId === m.community) send({ t: "community_get", community: m.community });
      break;
    }

    case "MEMBER_UPDATED":
    case "MEMBER_REMOVED":
    case "GROUP_UPDATED":
    case "ROLE_UPDATED":
    case "CHANNEL_UPDATED":
      if (currentCommunityId && m.group === currentCommunityId) {
        send({ t: "community_get", community: currentCommunityId });
      }
      break;

    case "community_created":
      pendingCommunityCreate = false;
      clearTimeout(pendingCommunityCreateTimer);
      pendingCommunityCreateTimer = null;
      el("createCommunityBtn").disabled = false;
      el("newCommunityName").value = "";
      el("communityCreateFeedback").textContent = "Gruppo creato.";
      el("communityCreateFeedback").className = "inline-action-feedback success";
      selectCommunity(m.id);
      send({ t: "community_list" });
      break;

    case "otp_required": {
      registrationAwaitingOtp = true;
      const otpField = el("otpField");
      otpField.classList.remove("hidden");
      const otpInput = el("registerOtp");
      otpInput.required = true;
      otpInput.focus();
      const codeMessage = m.sim_code
        ? `Codice di verifica simulato: ${m.sim_code}.`
        : "Ti abbiamo inviato un codice di verifica via SMS.";
      setAuthMsg(`${codeMessage} Inseriscilo per completare la registrazione.`, "success");
      const registerButton = el("registerSubmit");
      registerButton.textContent = "Verifica e crea account";
      break;
    }

    case "contact_added":
      if (quickContactPending) {
        clearTimeout(quickContactTimer);
        quickContactTimer = null;
      }
      quickContactPending = false;
      contacts.push(m.contact);
      renderContacts();
      el("quickContactInput").value = "";
      el("quickContactFeedback").textContent = `Contatto aggiunto: ${m.contact?.name || m.contact?.username || ""}`;
      el("quickContactFeedback").className = "success";
      break;

    case "history":
      renderHistory(m.msgs || [], m.with);
      break;

    case "dm":
      appendMessage(m.from || m.id, m.text, (m.from || m.id)?.toLowerCase() === me?.id ? "self" : "other", m.ts, false, m.attachment);
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
        messages.querySelectorAll("[data-attachment-hash]").forEach(node => {
          if (node.dataset.attachmentHash !== m.hash) return;
          const replacement = renderMessageAttachment({ hash: m.hash, mime: m.mime });
          if (replacement) node.replaceWith(replacement);
        });
        renderContacts();
        renderSelectedContact();
        if (currentCommunity) renderParticipants(currentCommunity);
        if (!profileModal.classList.contains("hidden")) renderProfilePreview();
      }
      break;

    case "media_ok":
      if (m.kind === "attachment" && pendingChatAttachment && attachmentUploadPending) {
        clearTimeout(attachmentTimer);
        attachmentTimer = null;
        attachmentUploadPending = false;
        pendingChatAttachment.hash = m.hash;
        pendingChatAttachment.mime = m.mime || pendingChatAttachment.mime;
        attachButton.disabled = false;
        renderPendingAttachment();
        updateSendButton();
        setComposerFeedback("Allegato pronto. Premi Invia per spedirlo.", "success");
      } else if (me && (m.kind === "avatar" || m.kind === "banner")) {
        const preview = me[`${m.kind}_preview`];
        if (preview) mediaCache.set(m.hash, preview);
        me = { ...me, [m.kind]: m.hash, [`${m.kind}_type`]: m.extension };
        delete me[`${m.kind}_preview`];
        pendingMediaKind = null;
        profileStatus.textContent = "Caricamento completato.";
        profileStatus.className = "success";
        renderProfilePreview();
      }
      break;

    case "err":
      if (pendingCommunityCreate) {
        pendingCommunityCreate = false;
        clearTimeout(pendingCommunityCreateTimer);
        pendingCommunityCreateTimer = null;
        el("createCommunityBtn").disabled = false;
        el("communityCreateFeedback").textContent = m.text || "Impossibile creare il gruppo.";
        el("communityCreateFeedback").className = "inline-action-feedback error";
        break;
      }
      if (pendingInviteResponse) {
        finishInviteResponse(m.text || "Impossibile rispondere all'invito.", true);
        break;
      }
      if (activeCall && activeCall.state !== "active") {
        finishCall(m.text || "Impossibile avviare la chiamata.");
        break;
      }
      if (attachmentUploadPending || pendingChatAttachment?.hash) {
        if (attachmentUploadPending) {
          discardPendingAttachment();
        }
        setComposerFeedback(m.text || "Invio dell'allegato non riuscito.", "error");
        updateSendButton();
        break;
      }
      if (quickContactPending) {
        quickContactPending = false;
        clearTimeout(quickContactTimer);
        quickContactTimer = null;
        el("quickContactFeedback").textContent = m.text || "Impossibile aggiungere il contatto.";
        el("quickContactFeedback").className = "error";
        break;
      }
      if (memberActionPending || pendingInviteResponse || attachmentUploadPending) {
        failMemberAction(m.text || "Operazione non riuscita.");
        break;
      }
      if (resumePending) {
        expireSession(m.text);
        break;
      }
      if (m.text === "Effettua prima l'accesso.") {
        expireSession("Sessione scaduta: accedi di nuovo.");
        break;
      }
      if (!profileModal.classList.contains("hidden")) {
        if (pendingMediaKind && me) {
          delete me[`${pendingMediaKind}_preview`];
          pendingMediaKind = null;
          renderProfilePreview();
        }
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
      if (currentCommunity?.participants?.some(person => person.id === m.id)) {
        currentCommunity.participants = currentCommunity.participants.map(person =>
          person.id === m.id ? { ...person, online: m.online } : person
        );
        renderParticipants(currentCommunity);
      }
      break;

    case "USER_UPDATED":
      if (currentCommunity?.participants?.some(person => person.id === m.id) && m.profile) {
        currentCommunity.participants = currentCommunity.participants.map(person =>
          person.id === m.id ? { ...person, ...m.profile } : person
        );
        renderParticipants(currentCommunity);
      }
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
  msgs.forEach(m => appendMessage(m.from, m.text, m.from?.toLowerCase() === me?.id ? "self" : "other", m.ts, true, m.attachment));
  scrollBottom();
}

function appendMessage(from, text, kind, ts, silent, attachment = null) {
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
  appendRichText(div, text || "");
  const renderedAttachment = renderMessageAttachment(attachment);
  if (renderedAttachment) div.appendChild(renderedAttachment);
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
  const icon = document.createElement("i");
  icon.className = "ph ph-chat-circle-dots placeholder-icon";
  icon.setAttribute("aria-hidden", "true");
  const message = document.createElement("p");
  message.textContent = text;
  div.append(icon, message);
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

// Bootstrap
applyLiveAppearance();
connect();
