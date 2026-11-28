const WS_URL = (window.CIAOCHAT_CONFIG && window.CIAOCHAT_CONFIG.wsUrl) ||
  ((window.location.protocol === "https:" ? "wss:" : "ws:") + "//" + window.location.host + "/ws");

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
let profileBeingViewed = null;
let requestedProfileId = null;
let pendingCommunityCreate = false;
let pendingInviteResponse = null;
let pendingInviteResponseTimer = null;
let pendingCommunityCreateTimer = null;
let quickContactTimer = null;

// ---------- Messaggistica avanzata ----------
const convoCaches = new Map();        // scopeKey -> [msg, ...] ordinati per ts
const typingUsers = new Map();        // scopeKey -> Set(userId)
const linkPreviewRequested = new Set();
let replyTarget = null;               // {scopeKey, kind, with?, community?, channel?, id, from, text}
let forwardSource = null;             // messaggio da inoltrare
const peerReadTs = {};                 // DM: user -> ts fino a cui ha letto i miei messaggi
let activeReadTs = 0;                 // read_ts dell'ultima cronologia renderizzata
let lastTypingSentAt = 0;
const historyState = new Map();        // scopeKey -> {hasMore, oldest}
const historyLoading = new Set();      // scopeKey con una pagina piu' vecchia in caricamento
const bookmarkedMsgs = new Set();      // "scopeKey:msgId" salvati come preferiti
let pendingPoll = null;                // {q, options:[], multiple} in attesa di invio
let pendingScheduleAt = 0;             // send_at (secondi) del prossimo messaggio
let voiceRec = null;                   // registrazione vocale in corso
let voiceUploadPending = false;
let voiceUploadTimer = null;

function peerReadTsFor(user) {
  return peerReadTs[String(user || "").toLowerCase()] || 0;
}

function msgTs(m) {
  const ts = Number(m?.ts ?? m?.timestamp ?? 0);
  return ts > 1e12 ? ts : ts * 1000;   // normalizza secondi -> millisecondi
}

function activeScope() {
  if (currentCommunityId && currentChannelId) {
    return rememberScope({
      kind: "community",
      community: currentCommunityId,
      channel: currentChannelId,
      key: `c:${currentCommunityId}:${currentChannelId}`,
    });
  }
  if (selectedContact) {
    const user = String(selectedContact).toLowerCase();
    return rememberScope({ kind: "dm", with: user, key: `dm:${user}` });
  }
  return null;
}

function scopeFields(scope) {
  if (!scope) return {};
  return scope.kind === "community"
    ? { community: scope.community, channel: scope.channel }
    : { with: scope.with };
}

function convoCache(key) {
  if (!convoCaches.has(key)) convoCaches.set(key, []);
  return convoCaches.get(key);
}

function upsertCachedMessage(scopeKey, msg) {
  const list = convoCache(scopeKey);
  const index = list.findIndex(item => item.id === msg.id);
  if (index >= 0) list[index] = { ...list[index], ...msg };
  else {
    list.push(msg);
    list.sort((a, b) => msgTs(a) - msgTs(b));
  }
  return list;
}

function patchCachedMessage(scopeKey, id, patch) {
  const list = convoCaches.get(scopeKey);
  const item = list?.find(entry => entry.id === id);
  if (item) Object.assign(item, patch);
  return item;
}

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
    if (voiceUploadPending || pendingVoiceSend) {
      voiceUploadPending = false;
      pendingVoiceSend = null;
      clearTimeout(voiceUploadTimer);
      voiceUploadTimer = null;
      messageInput.disabled = false;
      updateSendButton();
      setComposerFeedback("Messaggio vocale non inviato: connessione persa.", "error");
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
  } else if (!contactProfileModal.classList.contains("hidden")) {
    contactProfileError.textContent = "Connessione al server non disponibile. Riprova tra qualche secondo.";
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
  revealMotionItems(messenger);
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

const loginPassword = el("loginPassword");
const loginPasswordToggle = el("loginPasswordToggle");
let loginPasswordVisible = false;

loginPasswordToggle.addEventListener("click", () => {
  loginPasswordVisible = loginPassword.type === "password";
  loginPassword.type = loginPasswordVisible ? "text" : "password";
  loginPasswordToggle.textContent = loginPasswordVisible ? "Nascondi" : "Mostra";
  loginPasswordToggle.setAttribute("aria-pressed", String(loginPasswordVisible));
  loginPassword.focus();
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
    email: fd.get("email"),
  };
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
const openContactProfileButton = el("openContactProfile");
const contactProfileModal = el("contactProfileModal");
const contactProfileBanner = el("contactProfileBanner");
const contactProfileAvatar = el("contactProfileAvatar");
const contactProfilePresence = el("contactProfilePresence");
const contactProfileName = el("contactProfileName");
const contactProfileUsername = el("contactProfileUsername");
const contactProfileStatus = el("contactProfileStatus");
const contactProfileBio = el("contactProfileBio");
const contactProfileError = el("contactProfileError");
const contactProfileBadges = el("contactProfileBadges");
const contactProfileAboutSection = el("contactProfileAboutSection");
const contactProfileDatesSection = el("contactProfileDatesSection");
const contactProfileDates = el("contactProfileDates");
const contactProfileRolesSection = el("contactProfileRolesSection");
const contactProfileRoles = el("contactProfileRoles");
const contactProfileMessageInput = el("contactProfileMessageInput");
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
const profilePreviewName = el("profilePreviewName");
const participantSearch = el("participantSearch");
const participantDirectory = el("participantDirectory");
const bookmarkButton = el("bookmarkButton");
const bookmarkPanel = el("bookmarkPanel");
const bookmarkClose = el("bookmarkClose");
const bookmarkList = el("bookmarkList");
const pollButton = el("pollButton");
const pollPanel = el("pollPanel");
const pollQuestion = el("pollQuestion");
const pollOptions = el("pollOptions");
const pollAddOption = el("pollAddOption");
const pollMultiple = el("pollMultiple");
const pollCreateBtn = el("pollCreateBtn");
const scheduleButton = el("scheduleButton");
const schedulePanel = el("schedulePanel");
const scheduleInput = el("scheduleInput");
const scheduleSetBtn = el("scheduleSetBtn");
const scheduleChip = el("scheduleChip");
const voiceRecordButton = el("voiceRecordButton");
const voiceRecorder = el("voiceRecorder");
const voiceRecorderTime = el("voiceRecorderTime");
const voiceRecorderCancel = el("voiceRecorderCancel");
const voiceRecorderStop = el("voiceRecorderStop");

function renderContacts() {
  contactList.innerHTML = "";
  const query = contactSearch.value.trim().toLowerCase();
  const visibleContacts = contacts.filter(contact => [
    contact.name, contact.username, contact.id, contact.phone,
  ].some(value => String(value || "").toLowerCase().includes(query)));
  if (visibleContacts.length === 0) {
    contactList.appendChild(makeEmptyItem());
    if (query && contacts.length) contactList.lastElementChild.textContent = "Nessun contatto corrispondente.";
    revealMotionItems(contactList);
    return;
  }
  visibleContacts.forEach(c => {
    const username = c.id || c.username;
    const item = document.createElement("li");
    item.className = "contact-item" + (selectedContact === username ? " active" : "")
      + (hasActiveStatus(username) ? " has-status" : "");
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
    appendVerificationBadge(name, c);
    const status = document.createElement("div");
    status.className = "contact-status";
    status.textContent = c.online ? "Online"
      : c.last_seen ? `Ultimo accesso ${new Date(msgTs({ ts: c.last_seen })).toLocaleDateString([], { day: "2-digit", month: "2-digit" })}`
      : "Offline";
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
  revealMotionItems(contactList);
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
  revealMotionItems(list);
}

function selectCommunity(communityId) {
  discardPendingAttachment();
  resetComposerExtras();
  replyTarget = null;
  renderReplyPreview();
  closeForwardPicker();
  toggleMsgSearch(false);
  currentCommunityId = communityId;
  currentCommunity = null;
  currentChannelId = null;
  selectedContact = null;
  openContactProfileButton.disabled = true;
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
  revealMotionItems(participantDirectory);
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
    el("pinnedBar").classList.add("hidden");
    updateTypingIndicator();
    restoreDraft();
    updateConvStatus();
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
  resetComposerExtras();
  replyTarget = null;
  renderReplyPreview();
  closeForwardPicker();
  toggleMsgSearch(false);
  currentChannelId = channelId;
  clearUnread(`cmsg:${currentCommunityId}:${channelId}`);
  const channel = currentCommunity.channels.find(item => item.id === channelId);
  el("communityChannelBar").querySelectorAll(".community-channel-button").forEach(button => {
    button.classList.toggle("active", button.dataset.channelId === channelId);
  });
  messageInput.disabled = false;
  el("pinnedBar").classList.add("hidden");
  updateTypingIndicator();
  restoreDraft();
  updateConvStatus();
  updateSendButton();
  send({ t: "community_channel_history", community: currentCommunityId, channel: channelId });
  send({ t: "bookmark_list", scope: "community", community: currentCommunityId, channel: channelId });
}

function renderCommunityHistory(items, readTs = 0, meta = {}) {
  const scope = activeScope()?.kind === "community"
    ? activeScope()
    : { kind: "community", community: currentCommunityId, channel: currentChannelId,
        key: `c:${currentCommunityId}:${currentChannelId}` };
  rememberHistory(scope, meta.hasMore, meta.oldest);
  renderConvoList(scope, items || [], readTs);
}

function appendRichText(parent, text) {
  const pattern = /```([\s\S]+?)```|\|\|([^|\n]+)\|\||`([^`\n]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|(https?:\/\/[^\s<>]+)/g;
  const value = String(text || "");
  const content = document.createElement("span");
  content.className = "message-body";
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) content.appendChild(document.createTextNode(value.slice(cursor, index)));
    if (match[1] !== undefined) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = match[1].replace(/^\n+|\n+$/g, "");
      pre.appendChild(code);
      content.appendChild(pre);
    } else if (match[2] !== undefined) {
      const spoiler = document.createElement("span");
      spoiler.className = "spoiler";
      spoiler.textContent = match[2];
      spoiler.title = "Clicca per rivelare";
      spoiler.addEventListener("click", () => spoiler.classList.toggle("revealed"));
      content.appendChild(spoiler);
    } else if (match[3] !== undefined) {
      const code = document.createElement("code");
      code.className = "inline-code";
      code.textContent = match[3];
      content.appendChild(code);
    } else if (match[4]) {
      if (!localSettings.linkPreviews) {
        content.appendChild(document.createTextNode(match[4]));
      } else {
        const link = document.createElement("a");
        link.href = match[5];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = match[4];
        content.appendChild(link);
      }
    } else if (match[6]) {
      const strong = document.createElement("strong");
      strong.textContent = match[6];
      content.appendChild(strong);
    } else if (match[7]) {
      const emphasis = document.createElement("em");
      emphasis.textContent = match[7];
      content.appendChild(emphasis);
    } else {
      if (!localSettings.linkPreviews) {
        content.appendChild(document.createTextNode(match[8]));
      } else {
        const link = document.createElement("a");
        link.href = match[8];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = match[8];
        content.appendChild(link);
      }
    }
    cursor = index + match[0].length;
  }
  if (cursor < value.length) content.appendChild(document.createTextNode(value.slice(cursor)));
  renderEmoji(content);
  parent.appendChild(content);
}

function renderEmoji(element) {
  if (!localSettings.autoEmoji) return;
  if (!window.twemoji || !element) return;
  window.twemoji.parse(element, {
    className: "chat-emoji",
    callback: icon => `static/emoji/${icon}.svg`,
  });
  element.querySelectorAll("img.chat-emoji").forEach(image => {
    image.addEventListener("error", () => {
      image.replaceWith(document.createTextNode(image.alt || ""));
    }, { once: true });
  });
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
  const mime = String(attachment.mime || "");
  if (mime.startsWith("audio/")) {
    const audio = document.createElement("audio");
    audio.className = "message-attachment-audio";
    audio.controls = true;
    audio.preload = "none";
    audio.src = source;
    return audio;
  }
  if (!mime.startsWith("image/") && !mime.startsWith("video/")) {
    const file = document.createElement("a");
    file.className = "message-attachment-file";
    file.href = source;
    file.download = attachment.name || "allegato";
    const icon = document.createElement("i");
    icon.className = "ph ph-file-arrow-down";
    icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "message-attachment-name";
    name.textContent = attachment.name || "Allegato";
    const meta = document.createElement("span");
    meta.className = "message-attachment-meta";
    meta.textContent = [
      attachment.size ? `${Math.max(1, Math.round(attachment.size / 1024))} KB` : "",
      mime.split("/")[1]?.toUpperCase() || "",
    ].filter(Boolean).join(" · ");
    file.append(icon, name, meta);
    return file;
  }
  if (!localSettings.inlineImages && mime.startsWith("image/")) {
    const download = document.createElement("a");
    download.className = "message-attachment-download";
    download.href = source;
    download.download = attachment.name || "allegato";
    download.innerHTML = `<i class="ph ph-download-simple" aria-hidden="true"></i> ${escapeHtml(attachment.name || "Immagine")}`;
    return download;
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

// ---------- Renderer messaggi (DM e community) ----------
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

function msgSeconds(msg) {
  return Number(msg?.ts ?? msg?.timestamp ?? 0);
}

function isSelfMessage(msg) {
  return String(msg?.from || "").toLowerCase() === String(me?.id || "").toLowerCase();
}

function authorLabel(userId) {
  const participant = currentCommunity?.participants?.find(person => person.id === userId);
  const profile = participant || contactProfile(userId);
  return profile?.name || profile?.username || userId || "";
}

function unreadDividerEl() {
  const div = document.createElement("div");
  div.className = "unread-divider";
  div.innerHTML = "<span>Nuovi messaggi</span>";
  return div;
}

function replyQuoteEl(reply, scope) {
  const quote = document.createElement("button");
  quote.type = "button";
  quote.className = "msg-reply";
  const author = document.createElement("span");
  author.className = "msg-reply-author";
  author.textContent = authorLabel(reply.from);
  const text = document.createElement("span");
  text.className = "msg-reply-text";
  text.textContent = reply.text || "";
  quote.append(author, text);
  quote.addEventListener("click", () => jumpToMessage(scope, reply.id));
  return quote;
}

const TTL_PRESETS = [
  { label: "Tra 1 ora", ttl: 3600 },
  { label: "Tra 24 ore", ttl: 86400 },
  { label: "Tra 7 giorni", ttl: 7 * 86400 },
  { label: "Nessuna scadenza", ttl: 0 },
];

function openTtlPicker(msg, scope, anchor) {
  document.getElementById("ttlPanel")?.remove();
  const panel = document.createElement("div");
  panel.className = "ttl-panel";
  panel.id = "ttlPanel";
  const title = document.createElement("div");
  title.className = "ttl-panel-title";
  title.textContent = "Auto-eliminazione";
  panel.appendChild(title);
  TTL_PRESETS.forEach(preset => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ttl-option";
    button.textContent = preset.label;
    button.addEventListener("click", () => {
      panel.remove();
      send({ t: "msg_expire", scope: scope.kind, ...scopeFields(scope), id: msg.id, ttl: preset.ttl });
    });
    panel.appendChild(button);
  });
  document.body.appendChild(panel);
  const rect = anchor.getBoundingClientRect();
  panel.style.left = `${Math.min(rect.left, window.innerWidth - panel.offsetWidth - 12)}px`;
  panel.style.top = `${Math.max(8, rect.top - panel.offsetHeight - 8)}px`;
  const close = event => {
    if (!panel.contains(event.target)) {
      panel.remove();
      document.removeEventListener("click", close, true);
    }
  };
  setTimeout(() => document.addEventListener("click", close, true), 0);
}

function renderPollMessage(poll, msg, scope) {
  if (!poll || typeof poll !== "object" || !Array.isArray(poll.options)) return null;
  const box = document.createElement("div");
  box.className = "msg-poll";
  const question = document.createElement("div");
  question.className = "msg-poll-question";
  question.textContent = poll.q || "Sondaggio";
  box.appendChild(question);
  const options = poll.options.slice(0, 10);
  const total = options.reduce((sum, option) => sum + (Array.isArray(option?.votes) ? option.votes.length : 0), 0);
  const mine = new Set();
  options.forEach((option, index) => {
    (option?.votes || []).forEach(user => { if (user === me?.id) mine.add(index); });
  });
  options.forEach((option, index) => {
    const votes = Array.isArray(option?.votes) ? option.votes : [];
    const voted = mine.has(index);
    const pct = total ? Math.round((votes.length / total) * 100) : 0;
    const row = document.createElement("button");
    row.type = "button";
    row.className = `msg-poll-option${voted ? " voted" : ""}`;
    row.disabled = !!msg.deleted;
    const bar = document.createElement("span");
    bar.className = "msg-poll-bar";
    bar.style.width = `${pct}%`;
    const label = document.createElement("span");
    label.className = "msg-poll-label";
    label.textContent = option?.text || "";
    const count = document.createElement("span");
    count.className = "msg-poll-count";
    count.textContent = `${votes.length} · ${pct}%`;
    row.append(bar, label, count);
    row.addEventListener("click", event => {
      event.stopPropagation();
      if (msg.deleted) return;
      send({ t: "msg_vote", scope: scope.kind, ...scopeFields(scope), id: msg.id, option: index });
    });
    box.appendChild(row);
  });
  const footer = document.createElement("div");
  footer.className = "msg-poll-footer";
  footer.textContent = poll.multiple
    ? `Scelta multipla · ${total} voti`
    : `${total} voti`;
  box.appendChild(footer);
  return box;
}

function renderReactionChips(parent, msg, scope) {
  const reactions = msg.reactions && typeof msg.reactions === "object" ? msg.reactions : {};
  const entries = Object.entries(reactions)
    .filter(([, users]) => Array.isArray(users) && users.length > 0);
  if (!entries.length) return;
  const row = document.createElement("div");
  row.className = "msg-reactions";
  for (const [emoji, users] of entries) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "msg-reaction";
    if (users.includes(me?.id)) chip.classList.add("mine");
    chip.textContent = `${emoji} ${users.length}`;
    chip.title = "Reazione";
    chip.addEventListener("click", event => {
      event.stopPropagation();
      send({ t: "msg_react", scope: scope.kind, ...scopeFields(scope), id: msg.id, emoji });
    });
    row.appendChild(chip);
  }
  parent.appendChild(row);
}

function renderVoiceMessage(voice) {
  if (!voice?.hash) return null;
  const wrap = document.createElement("div");
  wrap.className = "msg-voice";
  const source = mediaCache.get(voice.hash);
  if (!source) {
    const load = document.createElement("button");
    load.type = "button";
    load.className = "message-attachment-loading";
    load.dataset.voiceHash = voice.hash;
    load.innerHTML = '<i class="ph ph-download-simple" aria-hidden="true"></i> Carica vocale';
    load.addEventListener("click", () => {
      if (send({ t: "media_get", hash: voice.hash })) {
        load.disabled = true;
        load.textContent = "Caricamento...";
      }
    });
    wrap.appendChild(load);
    return wrap;
  }
  const audio = document.createElement("audio");
  audio.className = "msg-voice-audio";
  audio.controls = true;
  audio.preload = "none";
  audio.src = source;
  wrap.appendChild(audio);
  return wrap;
}

function canPinMessages(scope) {
  if (scope?.kind !== "community") return true;
  const p = currentCommunity?.permissions || {};
  return Boolean(p.manage_messages || p.administrator);
}

function canDeleteOthers(scope) {
  if (scope?.kind !== "community") return false;
  const p = currentCommunity?.permissions || {};
  return Boolean(p.manage_messages || p.administrator);
}

function attachMessageActions(div, msg, scope) {
  if (!msg.id || msg.deleted) return;
  const isMine = isSelfMessage(msg);
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  QUICK_REACTIONS.forEach(emoji => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "msg-action msg-react-quick";
    button.textContent = emoji;
    button.title = "Reazione";
    button.setAttribute("aria-label", `Reagisci con ${emoji}`);
    button.addEventListener("click", event => {
      event.stopPropagation();
      send({ t: "msg_react", scope: scope.kind, ...scopeFields(scope), id: msg.id, emoji });
    });
    bar.appendChild(button);
  });
  const add = (icon, title, run) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "msg-action";
    button.innerHTML = `<i class="ph ${icon}" aria-hidden="true"></i>`;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", event => {
      event.stopPropagation();
      run(button);
    });
    bar.appendChild(button);
  };
  add("ph-arrow-bend-up-left", "Rispondi", () => startReply(msg, scope));
  add("ph-share-forward", "Inoltra", () => openForwardPicker(msg));
  add(isBookmarked(scope, msg.id) ? "ph-bookmark-simple-fill" : "ph-bookmark-simple",
      isBookmarked(scope, msg.id) ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti",
      button => toggleBookmark(msg, scope, button));
  if (canPinMessages(scope)) {
    add(msg.pinned ? "ph-push-pin-slash" : "ph-push-pin",
        msg.pinned ? "Rimuovi fissaggio" : "Fissa messaggio",
        () => send({ t: "msg_pin", scope: scope.kind, ...scopeFields(scope), id: msg.id, pinned: !msg.pinned }));
  }
  if (isMine && !msg.deleted) {
    add("ph-pencil-simple", "Modifica", () => startMessageEdit(div, msg, scope));
  }
  if ((isMine || canDeleteOthers(scope)) && !msg.deleted) {
    add("ph-hourglass", "Scadenza automatica", button => openTtlPicker(msg, scope, button));
  }
  if (isMine || canDeleteOthers(scope)) {
    add("ph-trash", "Elimina", () => {
      if (confirm("Eliminare questo messaggio?")) {
        send({ t: "msg_delete", scope: scope.kind, ...scopeFields(scope), id: msg.id });
      }
    });
  }
  div.appendChild(bar);
}

function buildMessageEl(msg, scope) {
  const div = document.createElement("div");
  const isSelf = isSelfMessage(msg);
  div.className = `msg ${isSelf ? "self" : "other"}`;
  if (msg.id) div.dataset.msgId = msg.id;
  if (scope?.key) div.dataset.scopeKey = scope.key;
  if (msg.pinned) div.classList.add("is-pinned");
  if (!isSelf) {
    const author = document.createElement("strong");
    author.className = "message-author name-style";
    author.textContent = authorLabel(msg.from);
    const profile = contactProfile(msg.from) ||
      currentCommunity?.participants?.find(person => person.id === msg.from);
    styleName(author, profile);
    appendVerificationBadge(author, profile);
    div.appendChild(author);
  }
  if (msg.reply_to?.id) div.appendChild(replyQuoteEl(msg.reply_to, scope));
  if (msg.forwarded) {
    const fwd = document.createElement("div");
    fwd.className = "message-forwarded";
    fwd.textContent = `Inoltrato da ${authorLabel(msg.forwarded_from)}`;
    div.appendChild(fwd);
  }
  if (msg.deleted) {
    const del = document.createElement("p");
    del.className = "msg-deleted";
    del.textContent = "Messaggio eliminato";
    div.appendChild(del);
  } else {
    appendRichText(div, msg.text || "");
    const renderedAttachment = renderMessageAttachment(msg.attachment);
    if (renderedAttachment) div.appendChild(renderedAttachment);
    const renderedVoice = renderVoiceMessage(msg.voice);
    if (renderedVoice) div.appendChild(renderedVoice);
    const renderedPoll = renderPollMessage(msg.poll, msg, scope);
    if (renderedPoll) div.appendChild(renderedPoll);
    renderReactionChips(div, msg, scope);
  }
  const metadata = document.createElement("span");
  metadata.className = "meta";
  const ts = msgTs(msg);
  let metaText = ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  if (msg.edited && !msg.deleted) metaText += metaText ? " · modificato" : "modificato";
  const expiresAt = Number(msg.expires_at || 0);
  if (expiresAt > 0 && !msg.deleted) {
    const remaining = expiresAt * 1000 - Date.now();
    if (remaining > 0) {
      const hours = Math.floor(remaining / 3600000);
      const minutes = Math.floor((remaining % 3600000) / 60000);
      const label = hours > 0 ? `tra ${hours}h ${minutes}m` : `tra ${Math.max(1, minutes)}m`;
      metaText += metaText ? ` · ⌛ ${label}` : `⌛ ${label}`;
      const expiryMsg = msg;
      setTimeout(() => {
        const node = messages.querySelector(`.msg[data-msg-id="${CSS.escape(String(expiryMsg.id))}"]`);
        if (node && isExpiredMessage(expiryMsg)) node.remove();
      }, remaining + 500);
    }
  }
  if (isSelf && scope?.kind === "dm" && peerReadTsFor(scope.with) >= msgSeconds(msg)) {
    metaText += metaText ? " · Letto" : "Letto";
  }
  metadata.textContent = metaText;
  if (msg.e2ee && !msg.deleted) {
    const lock = document.createElement("i");
    lock.className = "ph ph-lock-simple msg-e2ee-lock";
    lock.title = "Crittografato end-to-end";
    lock.setAttribute("aria-label", "Crittografato end-to-end");
    metadata.prepend(lock);
  }
  div.appendChild(metadata);
  if (Array.isArray(msg.edits) && msg.edits.length && !msg.deleted) {
    const details = document.createElement("details");
    details.className = "msg-edits";
    const summary = document.createElement("summary");
    summary.textContent = `Cronologia modifiche (${msg.edits.length})`;
    details.appendChild(summary);
    msg.edits.slice().reverse().forEach(entry => {
      const line = document.createElement("div");
      line.className = "msg-edit-entry";
      const when = entry.ts ? new Date(entry.ts * 1000).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      line.textContent = `${when} — ${entry.text || ""}`;
      details.appendChild(line);
    });
    div.appendChild(details);
  }
  attachMessageActions(div, msg, scope);
  return div;
}

function renderPinnedBar(scope) {
  const bar = el("pinnedBar");
  if (!bar) return;
  const pinned = (convoCaches.get(scope.key) || []).filter(item => item.pinned && !item.deleted);
  bar.replaceChildren();
  if (!pinned.length) {
    bar.classList.add("hidden");
    return;
  }
  const latest = pinned[pinned.length - 1];
  const icon = document.createElement("i");
  icon.className = "ph ph-push-pin";
  icon.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "pinned-bar-text";
  text.textContent = pinned.length > 1
    ? `${pinned.length} messaggi fissati — ultimo: ${authorLabel(latest.from)}: ${(latest.text || "[allegato]").slice(0, 80)}`
    : `${authorLabel(latest.from)}: ${(latest.text || "[allegato]").slice(0, 120)}`;
  bar.append(icon, text);
  bar.classList.remove("hidden");
  bar.onclick = () => jumpToMessage(scope, latest.id);
}

function appendToMessages(div) {
  const placeholder = messages.querySelector(".msg-placeholder");
  if (placeholder) placeholder.remove();
  messages.appendChild(div);
  revealMotionItems(div);
}

function appendCommunityMessage(item) {
  if (!item || (!item.text && !item.attachment && !item.voice && !item.poll && !item.deleted)) return;
  const scope = activeScope()?.kind === "community"
    ? activeScope()
    : { kind: "community", community: currentCommunityId, channel: currentChannelId,
        key: `c:${currentCommunityId}:${currentChannelId}` };
  appendToMessages(buildMessageEl(item, scope));
  scrollBottom();
}

// ---------- Risposta, inoltro, modifica, eliminazione ----------
function startReply(msg, scope) {
  replyTarget = {
    scopeKey: scope.key, kind: scope.kind, ...scopeFields(scope),
    id: msg.id, from: msg.from,
    text: (msg.text || "").slice(0, 140) || (msg.poll ? "[Sondaggio]" : msg.attachment ? "[allegato]" : msg.voice ? "[Messaggio vocale]" : "[messaggio]"),
  };
  renderReplyPreview();
  messageInput.focus();
}

function renderReplyPreview() {
  const bar = el("replyPreview");
  bar.replaceChildren();
  if (!replyTarget) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  const label = document.createElement("span");
  label.className = "reply-preview-label";
  label.textContent = `Risposta a ${authorLabel(replyTarget.from)}`;
  const text = document.createElement("span");
  text.className = "reply-preview-text";
  text.textContent = replyTarget.text || "";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "icon-btn";
  cancel.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
  cancel.title = "Annulla risposta";
  cancel.setAttribute("aria-label", "Annulla risposta");
  cancel.addEventListener("click", () => {
    replyTarget = null;
    renderReplyPreview();
    messageInput.focus();
  });
  bar.append(label, text, cancel);
}

function replyPayload() {
  if (!replyTarget) return null;
  return { id: replyTarget.id, from: replyTarget.from, text: replyTarget.text };
}

const communityDataCache = new Map();

function openForwardPicker(msg) {
  forwardSource = msg;
  closeForwardPicker();
  const panel = document.createElement("div");
  panel.className = "forward-panel";
  panel.id = "forwardPanel";
  const title = document.createElement("div");
  title.className = "forward-panel-title";
  title.textContent = "Inoltra a...";
  panel.appendChild(title);
  const list = document.createElement("div");
  list.className = "forward-panel-list";
  contacts.forEach(contact => {
    const target = contact.id || contact.username;
    if (!target) return;
    list.appendChild(forwardTargetButton(
      contact.name || contact.username || target, "ph-user",
      () => forwardMessageTo({ t: "dm", to: target })));
  });
  communityListData.forEach(community => {
    const cached = communityDataCache.get(community.id);
    const channels = cached?.channels || [];
    if (!channels.length) {
      list.appendChild(forwardTargetButton(
        `${community.name} (carica canali...)`, "ph-users",
        () => {
          send({ t: "community_get", community: community.id });
          setTimeout(openForwardPicker, 800, msg);
        }));
      return;
    }
    channels.forEach(channel => {
      list.appendChild(forwardTargetButton(
        `${community.name} › #${channel.name}`, "ph-hash",
        () => forwardMessageTo({
          t: "community_channel_send", community: community.id, channel: channel.id,
        })));
    });
  });
  if (!list.children.length) {
    const empty = document.createElement("div");
    empty.className = "forward-panel-empty";
    empty.textContent = "Nessuna destinazione disponibile.";
    list.appendChild(empty);
  }
  panel.appendChild(list);
  document.body.appendChild(panel);
  const close = event => {
    if (!panel.contains(event.target)) closeForwardPicker();
  };
  setTimeout(() => document.addEventListener("click", close), 0);
  panel._outsideClose = close;
}

function forwardTargetButton(label, icon, run) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "forward-target";
  button.innerHTML = `<i class="ph ${icon}" aria-hidden="true"></i><span></span>`;
  button.querySelector("span").textContent = label;
  button.addEventListener("click", run);
  return button;
}

function closeForwardPicker() {
  const panel = el("forwardPanel");
  if (panel) {
    if (panel._outsideClose) document.removeEventListener("click", panel._outsideClose);
    panel.remove();
  }
  forwardSource = null;
}

async function forwardMessageTo(target) {
  const src = forwardSource;
  if (!src) return;
  const text = String(src.text || "").trim()
    || (src.poll ? "[Sondaggio]" : "")
    || (src.attachment ? "[Allegato]" : "")
    || (src.voice ? "[Messaggio vocale]" : "");
  if (!text) {
    closeForwardPicker();
    return;
  }
  const payload = { ...target, text, forwarded_from: me?.username || me?.id };
  if (src.attachment && typeof src.attachment === "object") {
    payload.attachment = { hash: src.attachment.hash, name: src.attachment.name };
  }
  if (src.voice && typeof src.voice === "object") {
    payload.voice = src.voice;
  }
  if (target.t === "dm" && await e2eeActiveFor(String(target.to).toLowerCase())) {
    const enc = await encryptForPeer(String(target.to).toLowerCase(), { text });
    if (enc) { payload.enc = enc; payload.text = ""; }
  }
  if (src.poll && typeof src.poll === "object") {
    payload.poll = {
      q: String(src.poll.q || "").slice(0, 200),
      options: (src.poll.options || []).slice(0, 10).map(option => ({
        text: String(option?.text || "").slice(0, 80),
      })),
      multiple: !!src.poll.multiple,
    };
  }
  if (send(payload)) {
    const scope = activeScope();
    const sameTarget = target.t === "dm"
      ? scope?.kind === "dm" && scope.with === String(target.to).toLowerCase()
      : scope?.kind === "community" && scope.community === target.community && scope.channel === target.channel;
    if (sameTarget) setComposerFeedback("Messaggio inoltrato.", "success");
  }
  closeForwardPicker();
}

function startMessageEdit(div, msg, scope) {
  if (div.querySelector(".msg-edit-box")) return;
  const body = div.querySelector(".message-body");
  const box = document.createElement("div");
  box.className = "msg-edit-box";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "msg-edit-input";
  input.value = msg.text || "";
  input.maxLength = 2000;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn btn-primary btn-sm";
  save.textContent = "Salva";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-outline btn-sm";
  cancel.textContent = "Annulla";
  const submit = async () => {
    const text = input.value.trim();
    if (text && text !== msg.text) {
      const edit = { t: "msg_edit", scope: scope.kind, ...scopeFields(scope), id: msg.id, text };
      if (scope?.kind === "dm" && await e2eeActiveFor(scope.with)) {
        const enc = await encryptForPeer(scope.with, { text });
        if (enc) { edit.enc = enc; edit.text = ""; }
      }
      send(edit);
    }
    box.remove();
  };
  save.addEventListener("click", submit);
  cancel.addEventListener("click", () => box.remove());
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") submit();
    if (event.key === "Escape") box.remove();
  });
  box.append(input, save, cancel);
  div.insertBefore(box, body ? body.nextSibling : div.firstChild);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// ---------- Jump, cache, aggiornamenti in tempo reale ----------
const scopeByKey = new Map();

function rememberScope(scope) {
  if (scope?.key) scopeByKey.set(scope.key, scope);
  return scope;
}

function scopeFromKey(key) {
  if (scopeByKey.has(key)) return scopeByKey.get(key);
  if (key?.startsWith("c:")) {
    const [, community, channel] = key.split(":");
    return rememberScope({ kind: "community", community, channel, key });
  }
  if (key?.startsWith("dm:")) {
    return rememberScope({ kind: "dm", with: key.slice(3), key });
  }
  return null;
}

function trimCache(key) {
  const list = convoCaches.get(key);
  if (list && list.length > 400) convoCaches.set(key, list.slice(-400));
}

function jumpToMessage(scope, id) {
  if (!scope || !id) return;
  const msg = (convoCaches.get(scope.key) || []).find(item => item.id === id);
  if (!msg) {
    send({ t: "msg_get", scope: scope.kind, ...scopeFields(scope), id });
    return;
  }
  const node = messages.querySelector(`.msg[data-msg-id="${CSS.escape(String(id))}"]`);
  if (node) {
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("msg-flash");
    setTimeout(() => node.classList.remove("msg-flash"), 1600);
  }
}

function refreshMessageElement(scopeKey, id) {
  const scope = scopeFromKey(scopeKey);
  const msg = (convoCaches.get(scopeKey) || []).find(item => item.id === id);
  const node = messages.querySelector(`.msg[data-msg-id="${CSS.escape(String(id))}"]`);
  if (!scope || !msg || !node) return;
  node.replaceWith(buildMessageEl(msg, scope));
}

function isExpiredMessage(msg) {
  const expires = Number(msg?.expires_at || 0);
  return expires > 0 && expires * 1000 <= Date.now() && !msg.deleted;
}

function loadOlderButton(scope) {
  const state = historyState.get(scope.key) || {};
  const button = document.createElement("button");
  button.type = "button";
  button.className = "load-older";
  const loading = historyLoading.has(scope.key);
  button.disabled = loading || !state.oldest;
  button.innerHTML = loading
    ? '<i class="ph ph-circle-notch" aria-hidden="true"></i> Caricamento...'
    : '<i class="ph ph-arrow-up" aria-hidden="true"></i> Carica messaggi precedenti';
  button.addEventListener("click", () => requestOlderMessages(scope));
  return button;
}

function refreshLoadOlder(scope) {
  messages.querySelector(".load-older")?.remove();
  const state = historyState.get(scope.key);
  if (state?.hasMore) {
    const placeholder = messages.querySelector(".msg-placeholder");
    const button = loadOlderButton(scope);
    if (placeholder) messages.insertBefore(button, placeholder);
    else messages.prepend(button);
  }
}

function requestOlderMessages(scope) {
  const state = historyState.get(scope.key);
  if (!scope || !state?.oldest || historyLoading.has(scope.key)) return;
  historyLoading.add(scope.key);
  refreshLoadOlder(scope);
  if (scope.kind === "community") {
    send({ t: "community_channel_history", community: scope.community,
           channel: scope.channel, before: state.oldest });
  } else {
    send({ t: "history", with: scope.with, before: state.oldest });
  }
}

async function prependHistory(scope, msgs, hasMore, oldest) {
  msgs = await decryptMessageList(scope, msgs);
  const fresh = (msgs || []).filter(msg => msg?.id && !isExpiredMessage(msg));
  fresh.forEach(msg => upsertCachedMessage(scope.key, msg));
  trimCache(scope.key);
  const first = messages.querySelector(".msg");
  fresh.sort((a, b) => msgTs(a) - msgTs(b)).forEach(msg => {
    const div = buildMessageEl(msg, scope);
    if (first) messages.insertBefore(div, first);
    else appendToMessages(div);
    maybeRequestLinkPreview(div, msg);
  });
  historyLoading.delete(scope.key);
  const prev = historyState.get(scope.key) || {};
  historyState.set(scope.key, { hasMore: !!hasMore, oldest: oldest || prev.oldest });
  refreshLoadOlder(scope);
  renderPinnedBar(scope);
}

function rememberHistory(scope, hasMore, oldest) {
  historyState.set(scope.key, { hasMore: !!hasMore, oldest: oldest || null });
  historyLoading.delete(scope.key);
}

function renderConvoList(scope, list, readTs = 0) {
  activeReadTs = readTs || 0;
  convoCaches.set(scope.key, list.slice());
  trimCache(scope.key);
  messages.innerHTML = "";
  if (!list.length) {
    messages.appendChild(makePlaceholder(
      scope.kind === "community" ? "Nessun messaggio in questo canale." : "Nessun messaggio ancora."));
  }
  const meId = String(me?.id || "").toLowerCase();
  let dividerDone = !activeReadTs;
  list.forEach(msg => {
    if (isExpiredMessage(msg)) return;
    if (!dividerDone && String(msg.from || "").toLowerCase() !== meId && msgSeconds(msg) > activeReadTs) {
      messages.appendChild(unreadDividerEl());
      dividerDone = true;
    }
    const div = buildMessageEl(msg, scope);
    appendToMessages(div);
    maybeRequestLinkPreview(div, msg);
  });
  refreshLoadOlder(scope);
  renderPinnedBar(scope);
  scrollBottom();
  reportRead(scope);
}

function reportRead(scope, ts) {
  if (!scope || !ws || ws.readyState !== WebSocket.OPEN) return;
  let value = ts;
  if (!value) {
    const meId = String(me?.id || "").toLowerCase();
    value = 0;
    for (const msg of convoCaches.get(scope.key) || []) {
      if (String(msg.from || "").toLowerCase() === meId) continue;
      const seconds = msgSeconds(msg);
      if (seconds > value) value = seconds;
    }
  }
  if (!value) return;
  send({ t: "msg_read", ...scopeFields(scope), ts: Math.floor(value) });
}

// ---------- Indicatore "sta scrivendo" ----------
function typingScopeKey(m) {
  return m.community && m.channel
    ? `c:${m.community}:${m.channel}`
    : `dm:${String(m.from || "").toLowerCase()}`;
}

function updateTypingIndicator() {
  let indicator = el("typingIndicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "typingIndicator";
    indicator.className = "typing-indicator hidden";
    messages.appendChild(indicator);
  }
  const scope = activeScope();
  const users = scope ? [...(typingUsers.get(scope.key) || [])].filter(user => user !== me?.id) : [];
  if (!users.length) {
    indicator.classList.add("hidden");
    indicator.textContent = "";
    return;
  }
  const names = users.slice(0, 3).map(authorLabel);
  indicator.textContent = users.length === 1
    ? `${names[0]} sta scrivendo...`
    : `${names.join(", ")}${users.length > 3 ? ` +${users.length - 3}` : ""} scrivono...`;
  indicator.classList.remove("hidden");
  scrollBottom();
}

function showTyping(m) {
  const key = typingScopeKey(m);
  if (!typingUsers.has(key)) typingUsers.set(key, new Set());
  typingUsers.get(key).add(m.from);
  updateTypingIndicator();
}

function expireTyping(key, user) {
  setTimeout(() => {
    typingUsers.get(key)?.delete(user);
    if (!typingUsers.get(key)?.size) typingUsers.delete(key);
    updateTypingIndicator();
  }, 5000);
}

function maybeSendTyping() {
  const scope = activeScope();
  if (!scope || !messageInput.value.trim()) return;
  const nowMs = Date.now();
  if (nowMs - lastTypingSentAt < 3000) return;
  lastTypingSentAt = nowMs;
  send({ t: "typing", ...scopeFields(scope) });
}

// ---------- Bozze, presenza, ricerca messaggi, anteprime link ----------
function draftKey(scope) {
  return scope ? `ciaochat.draft.${scope.key}` : null;
}

function saveDraft() {
  const scope = activeScope();
  const key = draftKey(scope);
  if (!key) return;
  const value = messageInput.value;
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
  syncDraftToServer(scope);
}

function restoreDraft() {
  const key = draftKey(activeScope());
  messageInput.value = key ? (localStorage.getItem(key) || "") : "";
  renderComposerEmoji();
  updateSendButton();
}

function clearDraft(scope) {
  const resolved = scope || activeScope();
  const key = draftKey(resolved);
  if (key) localStorage.removeItem(key);
  if (resolved?.key) send({ t: "draft_save", scope_key: resolved.key, text: "" });
}

function updateConvStatus() {
  if (currentCommunityId) {
    const channel = currentCommunity?.channels?.find(item => item.id === currentChannelId);
    convStatus.textContent = channel ? `# ${channel.name}` : "";
    return;
  }
  if (!selectedContact) {
    convStatus.textContent = "Seleziona una conversazione";
    return;
  }
  const profile = contactProfile(selectedContact);
  if (profile?.online) {
    convStatus.textContent = "Online";
  } else if (profile?.last_seen) {
    const seen = msgTs({ ts: profile.last_seen });
    convStatus.textContent = `Ultimo accesso ${new Date(seen).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
  } else {
    convStatus.textContent = selectedContact;
  }
}

function toggleMsgSearch(open) {
  const panel = el("msgSearchPanel");
  const show = open ?? panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !show);
  el("searchButton").classList.toggle("active", show);
  if (show) {
    el("msgSearchResults").replaceChildren();
    el("msgSearchInput").focus();
  }
}

function runMsgSearch() {
  const query = el("msgSearchInput").value.trim();
  el("msgSearchResults").replaceChildren();
  if (query.length < 2) return;
  if (msgSearchGlobalMode) {
    send({ t: "global_search", q: query });
    return;
  }
  const scope = activeScope();
  if (!scope) return;
  send({ t: "msg_search", q: query, scope: scope.kind, ...scopeFields(scope) });
}

function renderSearchResults(m) {
  const scope = activeScope();
  const results = el("msgSearchResults");
  results.replaceChildren();
  const items = m.results || [];
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "msg-search-empty";
    empty.textContent = "Nessun risultato.";
    results.appendChild(empty);
    return;
  }
  items.forEach(item => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "msg-search-result";
    const author = document.createElement("span");
    author.className = "msg-search-author";
    author.textContent = authorLabel(item.from);
    const snippet = document.createElement("span");
    snippet.className = "msg-search-snippet";
    const q = (m.q || "").toLowerCase();
    const text = item.text || (item.enc ? "[Messaggio cifrato]" : "");
    const idx = text.toLowerCase().indexOf(q);
    if (idx >= 0) {
      snippet.append(
        document.createTextNode(text.slice(0, idx)),
        Object.assign(document.createElement("mark"), { textContent: text.slice(idx, idx + q.length) }),
        document.createTextNode(text.slice(idx + q.length)),
      );
    } else {
      snippet.textContent = text.slice(0, 140);
    }
    const time = document.createElement("span");
    time.className = "msg-search-time";
    const ts = msgTs({ ts: item.ts });
    time.textContent = ts ? new Date(ts).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    button.append(author, snippet, time);
    button.addEventListener("click", () => {
      if (scope) jumpToMessage(scope, item.id);
      toggleMsgSearch(false);
    });
    results.appendChild(button);
  });
}

function maybeRequestLinkPreview(div, msg) {
  if (!localSettings.linkPreviews || msg.deleted) return;
  const link = div.querySelector(".message-body a[href^='http']");
  const url = link?.href;
  if (!url || linkPreviewRequested.has(url)) return;
  linkPreviewRequested.add(url);
  send({ t: "link_preview", url });
}

function onLinkPreview(m) {
  if (!m.preview || !m.url) return;
  const node = messages.querySelector(`.msg a[href="${CSS.escape(m.url)}"]`);
  const msgEl = node?.closest(".msg");
  if (!msgEl || msgEl.querySelector(".link-preview-card")) return;
  const card = document.createElement("a");
  card.className = "link-preview-card";
  card.href = m.url;
  card.target = "_blank";
  card.rel = "noopener noreferrer";
  if (m.preview.image) {
    const img = document.createElement("img");
    img.src = m.preview.image;
    img.alt = "";
    img.loading = "lazy";
    card.appendChild(img);
  }
  const body = document.createElement("span");
  body.className = "link-preview-body";
  const title = document.createElement("strong");
  title.textContent = m.preview.title || m.url;
  body.appendChild(title);
  if (m.preview.description) {
    const desc = document.createElement("small");
    desc.textContent = m.preview.description;
    body.appendChild(desc);
  }
  card.appendChild(body);
  msgEl.appendChild(card);
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
  cleanupCall();
  clearTimeout(callTimer);
  callTimer = null;
  activeCall = null;
  renderCallPanel(message);
  el("callMedia").classList.add("hidden");
  el("callMedia").replaceChildren();
  if (message) {
    callTimer = setTimeout(() => renderCallPanel(""), 5000);
  }
}

/* ============================ WebRTC call engine ============================ */

let peer = null;
let localStream = null;
let remoteStream = null;
let callStartedAt = 0;
let callTicker = null;
let callMuted = false;
let callDeafened = false;
let callCameraOn = true;
let pttHeld = false;
let voiceGate = true;
let vadAnimation = null;
let callAudioCtx = null;
let callGainNode = null;
let remoteAudioEl = null;
let remoteVideoEl = null;
let localVideoEl = null;
let signalChain = Promise.resolve();

const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function callMediaConstraints(video) {
  const audio = {
    echoCancellation: !!localSettings.echoCancel,
    noiseSuppression: !!localSettings.noiseSuppress,
    autoGainControl: !!localSettings.autoGain,
  };
  if (localSettings.audioInput) audio.deviceId = { ideal: localSettings.audioInput };
  const constraints = { audio, video: false };
  if (video) {
    constraints.video = localSettings.videoInput
      ? { deviceId: { ideal: localSettings.videoInput }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { width: { ideal: 1280 }, height: { ideal: 720 } };
  }
  return constraints;
}

function ensureCallAudioCtx() {
  if (!callAudioCtx) {
    callAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (callAudioCtx.state === "suspended") callAudioCtx.resume();
  return callAudioCtx;
}

function micShouldTransmit() {
  if (callMuted) return false;
  if (localSettings.inputMode === "ptt") return pttHeld;
  return voiceGate;
}

function applyMicState() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (track) track.enabled = micShouldTransmit();
}

function setCallMuted(muted) {
  callMuted = muted;
  applyMicState();
  playSound("mute");
  renderCallControls();
}

function setCallDeafened(deafened) {
  callDeafened = deafened;
  if (remoteAudioEl) remoteAudioEl.muted = deafened;
  playSound("mute");
  renderCallControls();
}

function toggleCallCamera() {
  callCameraOn = !callCameraOn;
  if (localStream) {
    localStream.getVideoTracks().forEach(track => { track.enabled = callCameraOn; });
  }
  renderCallControls();
}

function applyCallAudioSettings() {
  if (callGainNode) {
    callGainNode.gain.value = Math.max(0, Math.min(1, localSettings.inputVolume / 100));
  }
  if (remoteAudioEl) {
    remoteAudioEl.volume = Math.max(0, Math.min(1, localSettings.outputVolume / 100));
    if (localSettings.audioOutput && typeof remoteAudioEl.setSinkId === "function") {
      remoteAudioEl.setSinkId(localSettings.audioOutput).catch(() => {});
    }
  }
}

async function acquireLocalMedia(video) {
  localStream = await navigator.mediaDevices.getUserMedia(callMediaConstraints(video));
  // Input volume via a GainNode -> MediaStreamDestination replacement track.
  const inputVol = Math.max(0, Math.min(1, localSettings.inputVolume / 100));
  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack && inputVol !== 1) {
    try {
      const ctx = ensureCallAudioCtx();
      const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
      callGainNode = ctx.createGain();
      callGainNode.gain.value = inputVol;
      const dest = ctx.createMediaStreamDestination();
      source.connect(callGainNode);
      callGainNode.connect(dest);
      const processed = dest.stream.getAudioTracks()[0];
      localStream.removeTrack(audioTrack);
      localStream.addTrack(processed);
      audioTrack.stop();
    } catch {
      callGainNode = null;
    }
  }
  applyMicState();
  startVoiceActivityGate();
}

function startVoiceActivityGate() {
  stopVoiceActivityGate();
  if (localSettings.inputMode !== "voice" || !localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  try {
    const ctx = ensureCallAudioCtx();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const sensitivity = Math.max(0, Math.min(100, Number(localSettings.voiceSensitivity) || 50));
    // Higher sensitivity -> lower threshold. Kept low so normal speech
    // always passes; the hangover below decides when to close the gate.
    const threshold = 0.002 + ((100 - sensitivity) / 100) * 0.035;
    let lastVoiceAt = 0;
    const tick = () => {
      if (!localStream) { vadAnimation = null; return; }
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (rms > threshold) lastVoiceAt = now;
      // Open instantly on voice, close only after ~400 ms of silence.
      const gate = now - lastVoiceAt < 400;
      if (gate !== voiceGate) {
        voiceGate = gate;
        applyMicState();
      }
      vadAnimation = requestAnimationFrame(tick);
    };
    vadAnimation = requestAnimationFrame(tick);
  } catch {
    voiceGate = true;
  }
}

function stopVoiceActivityGate() {
  if (vadAnimation) cancelAnimationFrame(vadAnimation);
  vadAnimation = null;
  voiceGate = true;
}

function buildPeerConnection() {
  peer = new RTCPeerConnection(RTC_CONFIG);
  peer.onicecandidate = event => {
    if (event.candidate && activeCall?.id) {
      sendSignal("ice", {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      });
    }
  };
  peer.ontrack = event => {
    remoteStream = event.streams[0] || new MediaStream([event.track]);
    attachRemoteMedia();
    if (activeCall?.state === "active" && !callStartedAt) callConnected();
  };
  peer.onconnectionstatechange = () => {
    if (!peer) return;
    if (peer.connectionState === "connected" && activeCall?.state === "active" && !callStartedAt) {
      callConnected();
    }
    if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
      if (activeCall?.state === "active") finishCall("Connessione alla chiamata persa.");
    }
  };
  if (localStream) {
    localStream.getTracks().forEach(track => peer.addTrack(track, localStream));
  }
}

function sendSignal(kind, payload) {
  if (!activeCall?.id) return;
  const d = JSON.stringify(payload);
  // SDP can be large -> c_video (600KB). ICE candidates are tiny -> c_audio (8KB).
  send(kind === "sdp"
    ? { t: "c_video", call: activeCall.id, d }
    : { t: "c_audio", call: activeCall.id, d });
}

async function processSignal(message) {
  if (!peer || !activeCall?.id || message.call !== activeCall.id) return;
  let payload;
  try { payload = JSON.parse(message.d); } catch { return; }
  try {
    if (payload.sdp !== undefined && payload.type) {
      await peer.setRemoteDescription({ type: payload.type, sdp: payload.sdp });
      if (payload.type === "offer") {
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        sendSignal("sdp", { type: "answer", sdp: answer.sdp });
      }
    } else if (payload.candidate) {
      await peer.addIceCandidate({
        candidate: payload.candidate,
        sdpMid: payload.sdpMid,
        sdpMLineIndex: payload.sdpMLineIndex,
      });
    }
  } catch (error) {
    console.warn("[call] signaling error", error);
  }
}

function queueSignal(message) {
  signalChain = signalChain.then(() => processSignal(message));
}

function attachRemoteMedia() {
  const wrap = el("callMedia");
  wrap.classList.remove("hidden");
  wrap.replaceChildren();
  if (activeCall?.video) {
    remoteVideoEl = document.createElement("video");
    remoteVideoEl.autoplay = true;
    remoteVideoEl.playsInline = true;
    remoteVideoEl.className = "call-remote-video";
    remoteVideoEl.srcObject = remoteStream;
    wrap.appendChild(remoteVideoEl);
  }
  remoteAudioEl = document.createElement("audio");
  remoteAudioEl.autoplay = true;
  remoteAudioEl.srcObject = remoteStream;
  remoteAudioEl.muted = callDeafened;
  applyCallAudioSettings();
  remoteAudioEl.play().catch(() => {
    // Autoplay may be blocked until a user gesture: resume on next click.
    const resume = () => {
      remoteAudioEl?.play().catch(() => {});
      window.removeEventListener("pointerdown", resume);
    };
    window.addEventListener("pointerdown", resume);
  });
  wrap.appendChild(remoteAudioEl);
  if (localStream?.getVideoTracks().length) {
    localVideoEl = document.createElement("video");
    localVideoEl.autoplay = true;
    localVideoEl.playsInline = true;
    localVideoEl.muted = true;
    localVideoEl.className = "call-local-video";
    localVideoEl.srcObject = localStream;
    wrap.appendChild(localVideoEl);
  }
}

function renderCallControls() {
  const container = el("callActions");
  container.replaceChildren();
  if (!activeCall || activeCall.state !== "active") return;
  const add = (label, icon, run, active = false, danger = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn ${danger ? "btn-danger" : active ? "btn-primary" : "btn-outline"} small-btn`;
    button.innerHTML = `<i class="ph ph-${icon}" aria-hidden="true"></i> ${escapeHtml(label)}`;
    button.addEventListener("click", run);
    container.appendChild(button);
  };
  add(callMuted ? "Riattiva mic" : "Muto", callMuted ? "microphone-slash" : "microphone", () => setCallMuted(!callMuted), callMuted);
  if (activeCall.video) {
    add(callCameraOn ? "Video off" : "Video on", callCameraOn ? "video-camera-slash" : "video-camera", toggleCallCamera, !callCameraOn);
  }
  add(callDeafened ? "Riattiva audio" : "Scollega audio", callDeafened ? "speaker-high" : "speaker-slash", () => setCallDeafened(!callDeafened), callDeafened);
  add("Termina", "phone-x", endActiveCall, false, true);
}

function startCallTicker() {
  stopCallTicker();
  callStartedAt = Date.now();
  const tick = () => {
    const secs = Math.floor((Date.now() - callStartedAt) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    el("callStatus").textContent = `Chiamata in corso — ${mm}:${ss}`;
  };
  tick();
  callTicker = setInterval(tick, 1000);
}

function stopCallTicker() {
  if (callTicker) clearInterval(callTicker);
  callTicker = null;
}

function cleanupCall() {
  stopCallTicker();
  stopVoiceActivityGate();
  stopRingSound();
  if (peer) {
    try { peer.onicecandidate = null; peer.ontrack = null; peer.close(); } catch {}
    peer = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  remoteStream = null;
  remoteAudioEl = null;
  remoteVideoEl = null;
  localVideoEl = null;
  callAudioCtx = null;
  callGainNode = null;
  callMuted = false;
  callDeafened = false;
  callCameraOn = true;
  pttHeld = false;
  voiceGate = true;
  el("callMedia").classList.add("hidden");
  el("callMedia").replaceChildren();
}

async function startOutgoingCall() {
  if (!localStream) {
    try {
      await acquireLocalMedia(activeCall?.video);
    } catch {
      send({ t: "c_end", call: activeCall?.id });
      finishCall("Impossibile accedere a microfono" + (activeCall?.video ? " o camera" : "") + ". Controlla i permessi del browser.");
      return;
    }
  }
  try {
    buildPeerConnection();
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    sendSignal("sdp", { type: "offer", sdp: offer.sdp });
    el("callStatus").textContent = `Chiamata ${activeCall.video ? "video" : "vocale"} in corso — negoziazione in corso...`;
    renderCallControls();
  } catch (error) {
    console.warn("[call] offer failed", error);
    send({ t: "c_end", call: activeCall?.id });
    finishCall("Impossibile avviare la chiamata.");
  }
}

async function startIncomingCall() {
  try {
    await acquireLocalMedia(activeCall?.video);
  } catch {
    send({ t: "c_end", call: activeCall?.id });
    finishCall("Impossibile accedere a microfono" + (activeCall?.video ? " o camera" : "") + ".");
    return;
  }
  buildPeerConnection();
  // L'offerta del chiamante arrivera' via c_video: la coda dei segnali la processa.
  el("callStatus").textContent = "Chiamata connessa — negoziazione in corso...";
  renderCallControls();
}

function callConnected() {
  startCallTicker();
  attachRemoteMedia();
  renderCallControls();
}

function endActiveCall() {
  const call = activeCall;
  if (!call) return;
  if (call.id && !send({ t: "c_end", call: call.id })) {
    finishCall("Connessione non disponibile. La chiamata potrebbe essere ancora attiva.");
    cleanupCall();
    return;
  }
  cleanupCall();
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
  // Chiedi subito l'accesso a microfono/fotocamera: il prompt del browser
  // parte dal gesto dell'utente, prima ancora che l'altro risponda.
  acquireLocalMedia(video).then(() => {
    if (activeCall?.state !== "outgoing") return;
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
  }).catch(() => {
    activeCall = null;
    renderCallPanel("Impossibile accedere a microfono" + (video ? " o camera" : "") + ". Consenti il permesso nel browser e riprova.", [{
      label: "Chiudi",
      icon: "x",
      run: () => renderCallPanel(""),
    }]);
  });
}

function acceptCall() {
  if (!activeCall?.id || !send({ t: "c_accept", call: activeCall.id })) {
    finishCall("Impossibile rispondere alla chiamata. Riprova.");
    return;
  }
  clearTimeout(callTimer);
  callTimer = null;
  stopRingSound();
  activeCall.state = "active";
  startIncomingCall();
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
  resetComposerExtras();
  replyTarget = null;
  renderReplyPreview();
  closeForwardPicker();
  toggleMsgSearch(false);
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
  el("pinnedBar").classList.add("hidden");
  renderCommunityList(communityListData);
  selectedContact = username;
  convTtl = 0;
  refreshConvTtlButton();
  clearUnread(`dm:${String(username).toLowerCase()}`);
  openContactProfileButton.disabled = false;
  renderSelectedContact();
  renderContacts();
  messages.innerHTML = "";
  updateTypingIndicator();
  messages.appendChild(makePlaceholder("Seleziona un contatto per iniziare a chattare."));
  send({ t: "history", with: username });
  send({ t: "bookmark_list", scope: "dm", with: String(username).toLowerCase() });
  messageInput.disabled = false;
  restoreDraft();
  updateConvStatus();
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
  scrambleText(convName);
  styleName(convName, profile);
  appendVerificationBadge(convName, profile);
  convAvatar.replaceChildren();
  convAvatar.textContent = avatarInitial(name);
  const avatar = profile && mediaElement(profile.avatar, "conv-avatar-media");
  if (avatar) convAvatar.replaceChildren(avatar);
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

function renderContactProfile() {
  const profile = profileBeingViewed;
  if (!profile) return;
  contactProfileAvatar.replaceChildren();
  contactProfileAvatar.textContent = avatarInitial(profile.name || profile.username || profile.id);
  const avatar = mediaElement(profile.avatar, "avatar-media");
  if (avatar) contactProfileAvatar.replaceChildren(avatar);

  contactProfileBanner.replaceChildren();
  const banner = mediaElement(profile.banner, "contact-profile-banner-media");
  if (banner) contactProfileBanner.appendChild(banner);

  contactProfileName.textContent = profile.name || profile.username || profile.id;
  styleName(contactProfileName, profile);
  appendVerificationBadge(contactProfileName, profile);
  const username = profile.username || profile.id;
  contactProfileUsername.textContent = `@${username}${profile.pronouns ? ` | ${profile.pronouns}` : ""}`;
  const online = profile.online === true;
  contactProfilePresence.classList.toggle("online", online);
  contactProfilePresence.setAttribute("aria-label", online ? "Online" : "Offline");

  const customStatus = profile.custom_status && typeof profile.custom_status === "object"
    ? profile.custom_status : {};
  const statusText = typeof profile.status === "string" ? profile.status : customStatus.text;
  contactProfileStatus.replaceChildren();
  if (statusText) {
    if (customStatus.emoji) {
      const emoji = document.createElement("span");
      emoji.className = "contact-profile-status-emoji";
      emoji.textContent = customStatus.emoji;
      contactProfileStatus.appendChild(emoji);
    }
    contactProfileStatus.append(document.createTextNode(statusText));
  }

  contactProfileBio.textContent = profile.bio || "";
  contactProfileAboutSection.classList.toggle("hidden", !profile.bio);
  renderContactProfileDates(profile);
  renderContactProfileBadges(profile.badges);
  renderContactProfileRoles(profile.roles);
  contactProfileMessageInput.placeholder = `Messaggia @${username}`;

  const blockBtn = el("blockContactBtn");
  if (blockBtn) {
    blockBtn.classList.toggle("hidden", profile.id === me?.id);
    blockBtn.dataset.user = username;
  }
  renderContactEphemeralStatus(username);

  const e2eePeer = username.toLowerCase();
  const e2eeRow = el("contactProfileE2ee");
  if (e2eeRow) {
    e2eeRow.classList.add("hidden");
    e2eeRow.replaceChildren();
    if (profile.id !== me?.id) {
      e2eeActiveFor(e2eePeer).then(active => {
        if (!active || profileBeingViewed !== profile) return;
        e2eeRow.classList.remove("hidden");
        const lock = document.createElement("i");
        lock.className = "ph ph-lock-simple";
        lock.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.textContent = "Cifratura end-to-end attiva";
        const number = document.createElement("code");
        number.className = "e2ee-safety-number";
        e2eeRow.append(lock, label, number);
        safetyNumber(e2eePeer).then(num => { number.textContent = num || ""; });
      });
    }
  }
}

function renderContactProfileBadges(badges) {
  contactProfileBadges.replaceChildren();
  if (!Array.isArray(badges)) return;
  badges.forEach(badge => {
    const label = typeof badge === "string" ? badge : badge?.label;
    if (!label || typeof label !== "string") return;
    const pill = document.createElement("span");
    pill.className = "contact-profile-badge";
    pill.textContent = label;
    contactProfileBadges.appendChild(pill);
  });
}

function renderContactProfileDates(profile) {
  contactProfileDates.replaceChildren();
  const dates = [
    ["Account", profile.created],
    ["Server", profile.joined],
  ].filter(([, timestamp]) => Number.isFinite(Number(timestamp)) && Number(timestamp) > 0);
  dates.forEach(([label, timestamp]) => {
    const item = document.createElement("div");
    item.className = "contact-profile-date";
    const date = document.createElement("strong");
    date.textContent = new Intl.DateTimeFormat("it-IT", {
      day: "numeric", month: "short", year: "numeric",
    }).format(new Date(Number(timestamp) * 1000));
    const caption = document.createElement("span");
    caption.textContent = label;
    item.append(date, caption);
    contactProfileDates.appendChild(item);
  });
  contactProfileDatesSection.classList.toggle("hidden", dates.length === 0);
}

function renderContactProfileRoles(roles) {
  contactProfileRoles.replaceChildren();
  if (!Array.isArray(roles)) {
    contactProfileRolesSection.classList.add("hidden");
    return;
  }
  roles.forEach(role => {
    const label = typeof role === "string" ? role : role?.name;
    if (!label || typeof label !== "string") return;
    const pill = document.createElement("span");
    pill.className = "contact-profile-role";
    pill.textContent = label;
    if (typeof role === "object" && /^#[0-9a-f]{6}$/i.test(role.color || "")) {
      pill.style.setProperty("--role-color", role.color);
    }
    contactProfileRoles.appendChild(pill);
  });
  contactProfileRolesSection.classList.toggle("hidden", contactProfileRoles.childElementCount === 0);
}

function openContactProfile() {
  if (!selectedContact || currentCommunityId) return;
  requestedProfileId = selectedContact;
  profileBeingViewed = contactProfile(selectedContact) || {
    id: selectedContact,
    username: selectedContact,
    name: selectedContact,
  };
  contactProfileError.textContent = "";
  renderContactProfile();
  contactProfileModal.classList.remove("hidden");
  send({ t: "profile", user: selectedContact });
  contactProfileMessageInput.focus();
}

function closeContactProfile() {
  requestedProfileId = null;
  profileBeingViewed = null;
  contactProfileModal.classList.add("hidden");
  openContactProfileButton.focus();
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
  renderCustomThemePreview();
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
    customTheme: localSettings.customTheme || null,
    autoGain: el("autoGain").checked,
    keybinds: { ...localSettings.keybinds },
  };
}

function applyLiveAppearance() {
  document.body.classList.remove("theme-oled", "theme-light", "theme-glass", "theme-custom", "message-compact", "reduced-motion");
  if (localSettings.theme === "oled") document.body.classList.add("theme-oled");
  if (localSettings.theme === "light") document.body.classList.add("theme-light");
  if (localSettings.theme === "glass") document.body.classList.add("theme-glass");
  if (localSettings.theme === "custom") {
    document.body.classList.add("theme-custom");
    applyCustomThemeVars(localSettings.customTheme);
  } else {
    applyCustomThemeVars(null);
  }
  if (localSettings.density === "compact") document.body.classList.add("message-compact");
  if (localSettings.reducedMotion) document.body.classList.add("reduced-motion");
  document.documentElement.style.fontSize = `${localSettings.fontSize}%`;
  revealMotionItems(document);
  renderComposerEmoji();
  applyCallAudioSettings();
  updateUnreadBadge();
}

// ---------- Tema personalizzato da immagine/video ----------

const CUSTOM_THEME_VARS = [
  "--bg-app", "--bg-surface", "--bg-surface-muted", "--border-subtle",
  "--border-strong", "--surface", "--surface-hover", "--border",
  "--accent-primary", "--accent-hover", "--accent", "--text-primary",
  "--text-secondary", "--text-muted", "--accent-2",
];

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function hslToHex(h, s, l) {
  s = Math.min(1, Math.max(0, s)); l = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = v => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function extractThemePalette(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width: w, height: ch } = canvas;
  const data = ctx.getImageData(0, 0, w, ch).data;
  const buckets = new Map();   // hue -> {weight, r, g, b, n}
  for (let i = 0; i < data.length; i += 16) {
    const a = data[i + 3];
    if (a < 128) continue;
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const { h: hue, s, l } = hexToHsl(`#${[r, g, b].map(v =>
      Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`);
    if (s < 0.18 || l < 0.06 || l > 0.94) continue;
    const key = Math.round(hue / 30) * 30 % 360;
    const bucket = buckets.get(key) || { weight: 0, r: 0, g: 0, b: 0, n: 0 };
    bucket.weight += s * (1 - Math.abs(l - 0.5) * 1.4);
    bucket.r += data[i]; bucket.g += data[i + 1]; bucket.b += data[i + 2];
    bucket.n++;
    buckets.set(key, bucket);
  }
  const ranked = [...buckets.values()]
    .filter(b => b.n > 8)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);
  if (!ranked.length) return null;
  const toHex = b => `#${[b.r / b.n, b.g / b.n, b.b / b.n]
    .map(v => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const primary = ranked[0];
  const { h } = hexToHsl(toHex(primary));
  const secondary = ranked[1] || primary;
  const { h: h2 } = hexToHsl(toHex(secondary));
  return {
    primary: hslToHex(h, 0.72, 0.62),
    secondary: hslToHex(h2, 0.6, 0.55),
    bg: hslToHex(h, 0.32, 0.05),
    surface: hslToHex(h, 0.26, 0.11),
    surfaceHover: hslToHex(h, 0.24, 0.16),
    border: hslToHex(h, 0.18, 0.24),
    borderStrong: hslToHex(h, 0.2, 0.38),
  };
}

function canvasFromVideoFrame(video) {
  const canvas = document.createElement("canvas");
  canvas.width = 96; canvas.height = 96;
  const ctx = canvas.getContext("2d");
  const vw = video.videoWidth || 320, vh = video.videoHeight || 240;
  const scale = Math.min(canvas.width / vw, canvas.height / vh);
  const dw = vw * scale, dh = vh * scale;
  ctx.drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  return canvas;
}

async function themeFromFile(file) {
  if (file.type.startsWith("video/")) {
    const paid = !!(me?.verification || settingsSnapshot?.account?.verification);
    if (!paid) throw new Error("I video richiedono un badge verificato a pagamento.");
    const url = URL.createObjectURL(file);
    try {
      const video = document.createElement("video");
      video.muted = true; video.playsInline = true; video.preload = "auto";
      video.src = url;
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error("Video non leggibile."));
        setTimeout(() => reject(new Error("Video non leggibile.")), 8000);
      });
      video.currentTime = Math.min(1, (video.duration || 2) / 3);
      await new Promise(resolve => { video.onseeked = resolve; setTimeout(resolve, 3000); });
      return extractThemePalette(canvasFromVideoFrame(video));
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 96; canvas.height = 96;
    const ctx = canvas.getContext("2d");
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const dw = bitmap.width * scale, dh = bitmap.height * scale;
    ctx.drawImage(bitmap, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
    return extractThemePalette(canvas);
  } finally {
    bitmap.close();
  }
}

function applyCustomThemeVars(theme) {
  const style = document.body.style;
  CUSTOM_THEME_VARS.forEach(name => style.removeProperty(name));
  if (!theme) return;
  const map = {
    "--bg-app": theme.bg, "--bg-surface": theme.surface,
    "--bg-surface-muted": theme.bg, "--surface": theme.surface,
    "--surface-hover": theme.surfaceHover, "--border": theme.border,
    "--border-subtle": theme.border, "--border-strong": theme.borderStrong,
    "--accent-primary": theme.primary, "--accent": theme.primary,
    "--accent-hover": theme.secondary, "--accent-2": theme.secondary,
    "--text-primary": "#f2f4fb", "--text-secondary": "#d5dbea",
    "--text-muted": "#9aa5bd", "--text": "#f2f4fb",
  };
  Object.entries(map).forEach(([name, value]) => style.setProperty(name, value));
}

function renderCustomThemePreview() {
  const box = el("customThemePreview");
  if (!box) return;
  const theme = localSettings.customTheme;
  box.classList.toggle("hidden", !theme);
  if (!theme) { box.replaceChildren(); return; }
  box.replaceChildren();
  [theme.primary, theme.secondary, theme.bg, theme.surface].forEach(color => {
    const chip = document.createElement("span");
    chip.className = "custom-theme-swatch";
    chip.style.background = color;
    chip.title = color;
    box.appendChild(chip);
  });
}

el("customThemeFile")?.addEventListener("change", async event => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const palette = await themeFromFile(file);
    if (!palette) throw new Error("Nessun colore dominante trovato.");
    localSettings = { ...localSettings, customTheme: palette };
    localStorage.setItem("ciaochat.settings", JSON.stringify(localSettings));
    renderCustomThemePreview();
    if (localSettings.theme !== "custom") {
      el("themeSelect").value = "custom";
      localSettings.theme = "custom";
      localStorage.setItem("ciaochat.settings", JSON.stringify(localSettings));
    }
    applyLiveAppearance();
    el("profileStatus").textContent = "Tema personalizzato applicato.";
  } catch (error) {
    el("profileStatus").textContent = error.message || "Impossibile generare il tema.";
    el("profileStatus").className = "settings-status error";
  }
});
el("customThemeRemove")?.addEventListener("click", () => {
  localSettings = { ...localSettings, customTheme: null };
  localStorage.setItem("ciaochat.settings", JSON.stringify(localSettings));
  renderCustomThemePreview();
  applyLiveAppearance();
});

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let glassPointerFrame = null;
  window.addEventListener("pointermove", event => {
    if (!document.body.classList.contains("theme-glass")) return;
    if (glassPointerFrame) cancelAnimationFrame(glassPointerFrame);
    glassPointerFrame = requestAnimationFrame(() => {
      document.documentElement.style.setProperty("--glass-x", `${(event.clientX / window.innerWidth) * 100}%`);
      document.documentElement.style.setProperty("--glass-y", `${(event.clientY / window.innerHeight) * 100}%`);
    });
  }, { passive: true });
}

const scrambleFrames = new WeakMap();

function scrambleText(element, duration = 620) {
  if (!element || document.body.classList.contains("reduced-motion")) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const finalText = element.textContent || "";
  if (!finalText) return;
  const previousFrame = scrambleFrames.get(element);
  if (previousFrame) cancelAnimationFrame(previousFrame);
  element.dataset.scrambling = "true";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/+_-#";
  const start = performance.now();
  let frame = null;

  const tick = now => {
    const progress = Math.min((now - start) / duration, 1);
    const resolved = Math.floor(progress * finalText.length);
    let output = "";
    for (let index = 0; index < finalText.length; index++) {
      if (/\s/.test(finalText[index])) {
        output += finalText[index];
      } else if (index < resolved) {
        output += finalText[index];
      } else {
        output += chars[Math.floor(Math.random() * chars.length)];
      }
    }
    element.textContent = output;
    if (progress < 1) {
      frame = requestAnimationFrame(tick);
      scrambleFrames.set(element, frame);
    } else {
      element.textContent = finalText;
      delete element.dataset.scrambling;
      scrambleFrames.delete(element);
    }
  };

  frame = requestAnimationFrame(tick);
  scrambleFrames.set(element, frame);
}

function revealMotionItems(root = document) {
  if (document.body.classList.contains("reduced-motion")) return;

  const targets = [
    ...(root instanceof HTMLElement && root.matches(".auth-card, .sidebar-header, .conv-header, .composer, .contact-item, .community-item, .participant-row, .msg") ? [root] : []),
    ...root.querySelectorAll(
      ".auth-card, .sidebar-header, .conv-header, .composer, .contact-item, .community-item, .participant-row, .msg"
    ),
  ];
  targets.forEach((target, index) => {
    if (target.classList.contains("motion-reveal")) return;
    const isMessage = target.classList.contains("msg");
    target.style.setProperty("--motion-delay", `${isMessage ? 0 : Math.min(index * 24, 180)}ms`);
    target.classList.add("motion-reveal");
  });
}

function applyMotionTilt(element, event) {
  if (document.body.classList.contains("reduced-motion")) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const pointerX = (event?.clientX ?? rect.left + rect.width / 2) - rect.left;
  const pointerY = (event?.clientY ?? rect.top + rect.height / 2) - rect.top;
  const rotateY = ((pointerX / rect.width) - 0.5) * 3;
  const rotateX = ((pointerY / rect.height) - 0.5) * -3;
  element.style.transform = `perspective(700px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-1px)`;
}

document.addEventListener("pointermove", event => {
  const element = event.target.closest(
    ".contact-item, .community-item, .participant-row, .icon-btn, .btn"
  );
  if (!element) return;
  if (element.matches(":disabled")) return;
  if (element.dataset.tiltFrame) cancelAnimationFrame(Number(element.dataset.tiltFrame));
  element.dataset.tiltFrame = String(requestAnimationFrame(() => {
    applyMotionTilt(element, event);
    delete element.dataset.tiltFrame;
  }));
}, { passive: true });

document.addEventListener("pointerout", event => {
  const element = event.target.closest(
    ".contact-item, .community-item, .participant-row, .icon-btn, .btn"
  );
  if (element && event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
  if (element) element.style.transform = "";
});

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
  renderBadgeTiers(account.verification || me?.verification || null);
  renderFriendRequests(snapshot.relationships || []);
  renderMyStatuses();
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

/* ====================== sounds, notifications, unread ====================== */

let soundCtx = null;
let ringInterval = null;
const unreadConvos = new Map();

function ensureSoundCtx() {
  if (!soundCtx) {
    soundCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (soundCtx.state === "suspended") soundCtx.resume();
  return soundCtx;
}

function tone(freq, dur = 0.12, type = "sine", gain = 0.08, delay = 0) {
  try {
    const ctx = ensureSoundCtx();
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const t0 = ctx.currentTime + delay;
    osc.type = type;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(env);
    env.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  } catch {}
}

function ringPattern() {
  // Dual-tone ring, ~1.2s pattern like a classic phone ring.
  tone(440, 0.9, "sine", 0.05);
  tone(480, 0.9, "sine", 0.05);
}

function startRingSound() {
  if (ringInterval || localSettings.doNotDisturb || !localSettings.soundCall) return;
  ringPattern();
  ringInterval = setInterval(ringPattern, 2600);
}

function stopRingSound() {
  if (ringInterval) clearInterval(ringInterval);
  ringInterval = null;
}

function playSound(name) {
  if (localSettings.doNotDisturb) return;
  switch (name) {
    case "message":
      if (!localSettings.soundMessage) return;
      tone(740, 0.09, "sine", 0.07);
      tone(988, 0.12, "sine", 0.07, 0.09);
      break;
    case "call":
      if (!localSettings.soundCall) return;
      tone(620, 0.14, "triangle", 0.09);
      tone(930, 0.2, "triangle", 0.09, 0.14);
      break;
    case "mute":
      if (!localSettings.soundMute) return;
      tone(1250, 0.05, "square", 0.035);
      break;
  }
}

function desktopNotify(title, body, convoKey) {
  if (!localSettings.desktopNotifications || localSettings.doNotDisturb) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    const note = new Notification(title, { body, tag: convoKey || "ciaochat" });
    note.onclick = () => {
      window.focus();
      if (convoKey) openConvoByKey(convoKey);
    };
  } catch {}
}

function openConvoByKey(key) {
  if (key.startsWith("dm:")) selectContact(key.slice(3));
  else if (key.startsWith("cmsg:")) {
    const [, communityId, channelId] = key.split(":");
    selectCommunity(communityId);
    if (channelId) selectCommunityChannel(channelId);
  }
}

function markUnread(key, label) {
  if (!unreadConvos.has(key)) unreadConvos.set(key, label);
  updateUnreadBadge();
}

function clearUnread(key) {
  if (unreadConvos.delete(key)) updateUnreadBadge();
}

function updateUnreadBadge() {
  const count = unreadConvos.size;
  const baseTitle = "CiaoChat";
  document.title = count ? `(${count}) ${baseTitle}` : baseTitle;
  if (localSettings.unreadBadge) {
    if (count > 0 && "setAppBadge" in navigator) navigator.setAppBadge(count).catch(() => {});
    else if ("clearAppBadge" in navigator) navigator.clearAppBadge().catch(() => {});
  } else if ("clearAppBadge" in navigator) {
    navigator.clearAppBadge().catch(() => {});
  }
}

function onIncomingMessage(convoKey, label, title, preview, isSelf) {
  playSound("message");
  const viewing =
    (convoKey.startsWith("dm:") && String(selectedContact || "").toLowerCase() === convoKey.slice(3).toLowerCase()) ||
    (convoKey.startsWith("cmsg:") && currentCommunityId === convoKey.split(":")[1] && currentChannelId === convoKey.split(":")[2]);
  if (!viewing && !isSelf) markUnread(convoKey, label);
  desktopNotify(title, preview, convoKey);
}

/* ================================ keybinds ================================ */

function eventCombo(event) {
  const keys = [];
  if (event.ctrlKey) keys.push("Ctrl");
  if (event.shiftKey) keys.push("Shift");
  if (event.altKey) keys.push("Alt");
  if (event.metaKey) keys.push("Meta");
  keys.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return keys.join("+");
}

function handleKeybind(action, down) {
  if (action === "mute") {
    if (down) setCallMuted(!callMuted);
  } else if (action === "deafen") {
    if (down) setCallDeafened(!callDeafened);
  } else if (action === "ptt") {
    pttHeld = down;
    applyMicState();
  }
}

window.addEventListener("keydown", event => {
  if (event.repeat) return;
  if (event.target?.matches?.("input, textarea, select, [contenteditable='true']")) return;
  const combo = eventCombo(event);
  for (const [action, binding] of Object.entries(localSettings.keybinds || {})) {
    if (binding && binding === combo) {
      event.preventDefault();
      handleKeybind(action, true);
      return;
    }
  }
});
window.addEventListener("keyup", event => {
  const combo = eventCombo(event);
  for (const [action, binding] of Object.entries(localSettings.keybinds || {})) {
    if (binding && binding === combo) {
      handleKeybind(action, false);
      return;
    }
  }
});

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
openContactProfileButton.addEventListener("click", openContactProfile);
el("closeContactProfile").addEventListener("click", closeContactProfile);
el("contactProfileMessageForm").addEventListener("submit", event => {
  event.preventDefault();
  const text = contactProfileMessageInput.value.trim();
  const recipient = profileBeingViewed?.id;
  if (!text || !recipient) return;
  if (send({ t: "dm", to: recipient, text })) {
    contactProfileMessageInput.value = "";
    contactProfileError.textContent = "";
  }
});
contactProfileModal.addEventListener("click", event => {
  if (event.target === contactProfileModal) closeContactProfile();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !contactProfileModal.classList.contains("hidden")) {
    closeContactProfile();
  }
});
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
  localSettings.inputVolume = Number(el("inputVolume").value);
  applyCallAudioSettings();
});
el("outputVolume").addEventListener("input", () => {
  el("outputVolumeOut").textContent = `${el("outputVolume").value}%`;
  localSettings.outputVolume = Number(el("outputVolume").value);
  applyCallAudioSettings();
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
  const hasPoll = !!pendingPoll;
  sendBtn.disabled = messageInput.disabled || attachmentUploadPending ||
    voiceUploadPending || (!messageInput.value.trim() && !hasAttachment && !hasPoll);
}

let composerEmojiText = null;

function renderComposerEmoji() {
  const overlay = el("messageInputEmojiOverlay");
  const content = el("messageInputEmojiContent");
  const enabled = !!localSettings.autoEmoji;
  messageInput.classList.toggle("emoji-rendering-enabled", enabled);
  overlay.classList.toggle("hidden", !enabled);
  if (!enabled) {
    composerEmojiText = null;
    return;
  }
  if (composerEmojiText !== messageInput.value) {
    content.textContent = messageInput.value;
    renderEmoji(content);
    composerEmojiText = messageInput.value;
  }
  syncComposerEmojiScroll();
}

function syncComposerEmojiScroll() {
  el("messageInputEmojiContent").style.transform = `translateX(${-messageInput.scrollLeft}px)`;
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
    pdf: "application/pdf", txt: "text/plain", md: "text/markdown",
    csv: "text/csv", json: "application/json", zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
  };
  if (!extension || !mimeByExtension[extension]) {
    setComposerFeedback("Formato non supportato. Usa immagini, video, documenti o audio.", "error");
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

// ---------- Sondaggi, invio programmato, preferiti, messaggi vocali ----------

function pollOptionRow(value = "") {
  const row = document.createElement("div");
  row.className = "poll-option-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "poll-option-input";
  input.placeholder = "Opzione";
  input.maxLength = 80;
  input.value = value;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-btn poll-option-remove";
  remove.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
  remove.title = "Rimuovi opzione";
  remove.setAttribute("aria-label", "Rimuovi opzione");
  remove.addEventListener("click", () => {
    row.remove();
    pollAddOption.disabled = pollOptions.querySelectorAll(".poll-option-row").length >= 10;
  });
  row.append(input, remove);
  return row;
}

function resetPollComposer() {
  pendingPoll = null;
  pollPanel.classList.add("hidden");
  pollButton.classList.remove("active");
  pollButton.setAttribute("aria-expanded", "false");
  pollOptions.replaceChildren();
  pollQuestion.value = "";
  pollMultiple.checked = false;
  pollAddOption.disabled = false;
  document.getElementById("pollChip")?.remove();
}

function renderPollChip() {
  document.getElementById("pollChip")?.remove();
  if (!pendingPoll) return;
  const chip = document.createElement("div");
  chip.className = "attachment-preview";
  chip.id = "pollChip";
  const label = document.createElement("span");
  label.innerHTML = '<i class="ph ph-chart-bar" aria-hidden="true"></i> ';
  label.append(document.createTextNode(
    `Sondaggio: ${pendingPoll.q} · ${pendingPoll.options.length} opzioni${pendingPoll.multiple ? " · multipla" : ""}`
  ));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-btn";
  remove.setAttribute("aria-label", "Rimuovi sondaggio");
  remove.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
  remove.addEventListener("click", resetPollComposer);
  chip.append(label, remove);
  scheduleChip.insertAdjacentElement("afterend", chip);
}

function togglePollPanel(open) {
  const show = open ?? pollPanel.classList.contains("hidden");
  pollPanel.classList.toggle("hidden", !show);
  pollButton.classList.toggle("active", show);
  pollButton.setAttribute("aria-expanded", String(show));
  if (show && !pollOptions.children.length) {
    pollOptions.append(pollOptionRow(), pollOptionRow());
    pollQuestion.focus();
  }
}

function createPoll() {
  const q = pollQuestion.value.trim();
  const options = [...pollOptions.querySelectorAll(".poll-option-input")]
    .map(input => input.value.trim()).filter(Boolean).slice(0, 10);
  if (!q) {
    setComposerFeedback("Scrivi la domanda del sondaggio.", "error");
    pollQuestion.focus();
    return;
  }
  if (options.length < 2) {
    setComposerFeedback("Servono almeno due opzioni.", "error");
    return;
  }
  pendingPoll = { q, options, multiple: pollMultiple.checked };
  togglePollPanel(false);
  renderPollChip();
  updateSendButton();
  setComposerFeedback("Sondaggio pronto: premi Invia per pubblicarlo.", "success");
}

function clearScheduleChip() {
  scheduleChip.replaceChildren();
  scheduleChip.classList.add("hidden");
}

function renderScheduleChip() {
  clearScheduleChip();
  if (!pendingScheduleAt) return;
  scheduleChip.classList.remove("hidden");
  const label = document.createElement("span");
  label.innerHTML = '<i class="ph ph-clock" aria-hidden="true"></i> ';
  label.append(document.createTextNode(
    `Invio programmato: ${new Date(pendingScheduleAt * 1000).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`
  ));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-btn";
  remove.setAttribute("aria-label", "Annulla invio programmato");
  remove.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
  remove.addEventListener("click", () => {
    pendingScheduleAt = 0;
    clearScheduleChip();
    schedulePanel.classList.add("hidden");
    scheduleButton.classList.remove("active");
    scheduleButton.setAttribute("aria-expanded", "false");
    updateSendButton();
  });
  scheduleChip.append(label, remove);
}

function toggleSchedulePanel(open) {
  const show = open ?? schedulePanel.classList.contains("hidden");
  schedulePanel.classList.toggle("hidden", !show);
  scheduleButton.classList.toggle("active", show);
  scheduleButton.setAttribute("aria-expanded", String(show));
  if (show) {
    const pad = n => String(n).padStart(2, "0");
    const localValue = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const min = new Date(Date.now() + 60000);
    scheduleInput.min = localValue(min);
    if (!scheduleInput.value) scheduleInput.value = localValue(min);
    scheduleInput.focus();
  }
}

function setSchedule() {
  const value = scheduleInput.value;
  const ts = value ? Math.floor(new Date(value).getTime() / 1000) : 0;
  const now = Math.floor(Date.now() / 1000);
  if (!ts || ts <= now) {
    setComposerFeedback("Scegli una data e un'ora future.", "error");
    return;
  }
  if (ts > now + 30 * 86400) {
    setComposerFeedback("Massimo 30 giorni in anticipo.", "error");
    return;
  }
  pendingScheduleAt = ts;
  toggleSchedulePanel(false);
  renderScheduleChip();
  updateSendButton();
  setComposerFeedback("Invio programmato. Premi Invia per confermare.", "success");
}

function resetComposerExtras() {
  resetPollComposer();
  pendingScheduleAt = 0;
  clearScheduleChip();
  schedulePanel.classList.add("hidden");
  scheduleButton.classList.remove("active");
  scheduleButton.setAttribute("aria-expanded", "false");
  bookmarkPanel.classList.add("hidden");
  bookmarkButton.classList.remove("active");
  cancelVoiceRecording(true);
}

// ---------- Preferiti ----------

function bookmarkScopeKey(scope) {
  return scope?.kind === "community"
    ? `c:${scope.community}:${scope.channel}`
    : `dm:${String(scope?.with || "").toLowerCase()}`;
}

function isBookmarked(scope, id) {
  return bookmarkedMsgs.has(`${bookmarkScopeKey(scope)}:${id}`);
}

function toggleBookmarkPanel(open) {
  const show = open ?? bookmarkPanel.classList.contains("hidden");
  bookmarkPanel.classList.toggle("hidden", !show);
  bookmarkButton.classList.toggle("active", show);
  if (show) {
    const scope = activeScope();
    bookmarkList.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "msg-search-empty";
    empty.textContent = "Caricamento preferiti...";
    bookmarkList.appendChild(empty);
    if (scope) send({ t: "bookmark_list", scope: scope.kind, ...scopeFields(scope) });
    else bookmarkList.replaceChildren();
  }
}

async function renderBookmarkList(m) {
  bookmarkList.replaceChildren();
  const items = m.items || [];
  const scope = scopeFromKey(
    m.scope === "community" ? `c:${m.community}:${m.channel}` : `dm:${String(m.with || "").toLowerCase()}`
  ) || activeScope();
  if (scope?.kind === "dm") {
    await Promise.all(items.map(item => decryptMessage(item, scope)));
  }
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "msg-search-empty";
    empty.textContent = "Nessun preferito in questa conversazione.";
    bookmarkList.appendChild(empty);
    return;
  }
  items.forEach(item => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "msg-search-result bookmark-result";
    const author = document.createElement("span");
    author.className = "msg-search-author";
    author.textContent = authorLabel(item.from);
    const snippet = document.createElement("span");
    snippet.className = "msg-search-snippet";
    snippet.textContent = item.text ||
      (item.has_poll ? "[Sondaggio]" : item.has_voice ? "[Messaggio vocale]" : "[Allegato]");
    const time = document.createElement("span");
    time.className = "msg-search-time";
    const ts = msgTs({ ts: item.ts });
    time.textContent = ts ? new Date(ts).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    button.append(author, snippet, time);
    button.addEventListener("click", () => {
      if (scope) {
        toggleBookmarkPanel(false);
        jumpToMessage(scope, item.id);
      }
    });
    bookmarkList.appendChild(button);
  });
}

function toggleBookmark(msg, scope, button) {
  const marked = isBookmarked(scope, msg.id);
  send({
    t: marked ? "bookmark_remove" : "bookmark_add",
    scope: scope.kind, ...scopeFields(scope), id: msg.id,
  });
  const key = `${bookmarkScopeKey(scope)}:${msg.id}`;
  if (marked) bookmarkedMsgs.delete(key);
  else bookmarkedMsgs.add(key);
  if (button) {
    button.classList.toggle("active", !marked);
    button.title = marked ? "Aggiungi ai preferiti" : "Rimuovi dai preferiti";
    button.setAttribute("aria-label", button.title);
    button.querySelector("i")?.classList.toggle("ph-bookmark-simple", marked);
    button.querySelector("i")?.classList.toggle("ph-bookmark-simple-fill", !marked);
  }
}

// ---------- Messaggi vocali (registrazione WAV) ----------

const VOICE_SAMPLE_RATE = 8000;   // 16 bit mono: 60s sta sotto MAX_VOICE (1,1 MB)
const VOICE_MAX_SECONDS = 60;

function formatVoiceTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function startVoiceRecording() {
  if (voiceRec || voiceUploadPending) return;
  if (!selectedContact && !(currentCommunityId && currentChannelId)) {
    setComposerFeedback("Apri una conversazione prima di registrare un vocale.", "error");
    return;
  }
  if (memberActionPending || pendingInviteResponse || attachmentUploadPending) {
    setComposerFeedback("Attendi il completamento dell'operazione in corso.", "error");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setComposerFeedback("Registrazione non supportata da questo browser.", "error");
    return;
  }
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    processor.onaudioprocess = event => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(audioCtx.destination);
    const startedAt = Date.now();
    voiceRec = {
      stream, audioCtx, source, processor, chunks, startedAt,
      timer: null, autoStop: null,
    };
    voiceRecorder.classList.remove("hidden");
    messageInput.disabled = true;
    updateSendButton();
    const tick = () => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      voiceRecorderTime.textContent = formatVoiceTime(elapsed);
      voiceRec.timer = setTimeout(tick, 500);
    };
    tick();
    voiceRec.autoStop = setTimeout(() => finishVoiceRecording(), VOICE_MAX_SECONDS * 1000);
  }).catch(() => {
    setComposerFeedback("Microfono non disponibile o permesso negato.", "error");
  });
}

function cancelVoiceRecording(silent = false) {
  if (!voiceRec) return;
  clearTimeout(voiceRec.timer);
  clearTimeout(voiceRec.autoStop);
  voiceRec.stream.getTracks().forEach(track => track.stop());
  voiceRec.source.disconnect();
  voiceRec.processor.disconnect();
  voiceRec.audioCtx.close().catch(() => {});
  voiceRec = null;
  voiceRecorder.classList.add("hidden");
  messageInput.disabled = false;
  updateSendButton();
  if (!silent) setComposerFeedback("Registrazione annullata.", "");
}

function floatTo16BitWav(chunks, sourceRate) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const ratio = sourceRate / VOICE_SAMPLE_RATE;
  const outLength = Math.floor(total / ratio);
  const pcm = new Int16Array(outLength);
  const starts = new Float64Array(chunks.length + 1);
  for (let i = 0; i < chunks.length; i++) starts[i + 1] = starts[i] + chunks[i].length;
  let read = 0;
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio;
    while (read + 1 < chunks.length && position >= starts[read + 1]) read++;
    const chunk = chunks[read];
    const offset = position - starts[read];
    const value = chunk[Math.min(chunk.length - 1, Math.floor(offset))] || 0;
    pcm[i] = Math.max(-1, Math.min(1, value)) * (value < 0 ? 0x8000 : 0x7fff);
  }
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, VOICE_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return buffer;
}

function wavToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function finishVoiceRecording() {
  if (!voiceRec) return;
  const rec = voiceRec;
  clearTimeout(rec.timer);
  clearTimeout(rec.autoStop);
  rec.stream.getTracks().forEach(track => track.stop());
  voiceRec = null;
  voiceRecorder.classList.add("hidden");
  const duration = Math.min(VOICE_MAX_SECONDS, Math.max(1, Math.round((Date.now() - rec.startedAt) / 1000)));
  try {
    const wav = floatTo16BitWav(rec.chunks, rec.audioCtx.sampleRate);
    rec.source.disconnect();
    rec.processor.disconnect();
    rec.audioCtx.close().catch(() => {});
    if (wav.byteLength > 1_100_000 || wav.byteLength <= 44) {
      messageInput.disabled = false;
      updateSendButton();
      setComposerFeedback("Registrazione non valida o troppo lunga.", "error");
      return;
    }
    voiceUploadPending = true;
    updateSendButton();
    voiceUploadTimer = setTimeout(() => {
      if (!voiceUploadPending) return;
      voiceUploadPending = false;
      pendingVoiceSend = null;
      messageInput.disabled = false;
      updateSendButton();
      setComposerFeedback("Upload del vocale scaduto. Riprova.", "error");
    }, 20000);
    const scope = activeScope();
    const scheduled = pendingScheduleAt > Math.floor(Date.now() / 1000) ? pendingScheduleAt : 0;
    pendingVoiceSend = {
      duration,
      scheduled,
      target: scope?.kind === "community"
        ? { t: "community_channel_send", community: scope.community, channel: scope.channel }
        : { t: "dm", to: scope?.with || selectedContact },
    };
    if (!send({ t: "media_put", kind: "voice", extension: "wav", data: wavToBase64(wav) })) {
      voiceUploadPending = false;
      pendingVoiceSend = null;
      messageInput.disabled = false;
      updateSendButton();
      setComposerFeedback("Upload non avviato. Controlla la connessione e riprova.", "error");
    }
  } catch {
    messageInput.disabled = false;
    updateSendButton();
    setComposerFeedback("Impossibile elaborare la registrazione.", "error");
  }
}

let pendingVoiceSend = null;

// ---------- Crittografia end-to-end (DM di testo) ----------
// ECDH P-256: ogni utente ha una coppia di chiavi; la pubblica e' in profilo.
// La chiave simmetrica di conversazione deriva dallo shared secret ECDH.
// Il server vede solo ciphertext (`enc`); meta-dati (istante, hashed media,
// reazioni, pin) restano in chiaro. Sondaggi/allegati/vocali NON sono cifrati.

const E2EE_PRIV_LS = "ciaochat.e2ee.priv";
const E2EE_PUB_LS = "ciaochat.e2ee.pub";
let e2eeIdentity = null;                    // {privateKey, publicKey, pubRaw}
const e2eePeerKeys = new Map();             // peer -> {key: CryptoKey, pubRaw: Uint8Array}
const e2eePending = [];                     // peer le cui chiavi sono in derivazione

function b64urlEncode(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function b64urlDecode(text) {
  const padded = String(text).replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function ensureE2EEIdentity() {
  if (e2eeIdentity) return e2eeIdentity;
  try {
    const storedPriv = localStorage.getItem(E2EE_PRIV_LS);
    const storedPub = localStorage.getItem(E2EE_PUB_LS);
    if (storedPriv && storedPub) {
      const privateKey = await crypto.subtle.importKey(
        "jwk", JSON.parse(storedPriv), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      const publicKey = await crypto.subtle.importKey(
        "jwk", JSON.parse(storedPub.jwk), { name: "ECDH", namedCurve: "P-256" }, false, []);
      e2eeIdentity = { privateKey, publicKey, pubRaw: storedPub.raw };
      return e2eeIdentity;
    }
    const pair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const privJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const pubJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
    const pubRaw = b64urlEncode(raw);
    localStorage.setItem(E2EE_PRIV_LS, JSON.stringify(privJwk));
    localStorage.setItem(E2EE_PUB_LS, JSON.stringify({ jwk: pubJwk, raw: pubRaw }));
    e2eeIdentity = { privateKey: pair.privateKey, publicKey: pair.publicKey, pubRaw: `e2.${pubRaw}` };
    return e2eeIdentity;
  } catch {
    e2eeIdentity = null;
    return null;
  }
}

function publishE2EEKey() {
  const identity = e2eeIdentity;
  if (identity?.pubRaw) send({ t: "e2ee_pub", pub: identity.pubRaw });
}

function peerE2EEPub(peer) {
  const p = String(peer || "").toLowerCase();
  if (p === String(me?.id || "").toLowerCase()) {
    const pub = me?.e2ee_pub;
    return typeof pub === "string" && pub.startsWith("e2.") ? pub : null;
  }
  for (const profile of [contactProfile(peer), profileBeingViewed]) {
    if (!profile) continue;
    const ids = [profile.id, profile.username].filter(Boolean).map(x => String(x).toLowerCase());
    if (!ids.includes(p)) continue;
    const pub = profile.e2ee_pub;
    if (typeof pub === "string" && pub.startsWith("e2.")) return pub;
  }
  return null;
}

function e2eePeerKey(peer) {
  return e2eePeerKeys.get(String(peer || "").toLowerCase()) || null;
}

async function ensurePeerKey(peer) {
  const key = String(peer || "").toLowerCase();
  if (e2eePeerKeys.has(key)) return e2eePeerKeys.get(key);
  if (e2eePending.includes(key)) return null;
  const identity = await ensureE2EEIdentity();
  const pub = peerE2EEPub(peer);
  if (!identity || !pub) return null;
  e2eePending.push(key);
  try {
    const peerRaw = b64urlDecode(pub.slice(3));
    const peerPub = await crypto.subtle.importKey(
      "raw", peerRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const bits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: peerPub }, identity.privateKey, 256);
    const aes = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
    const entry = { key: aes, pubRaw: peerRaw };
    e2eePeerKeys.set(key, entry);
    return entry;
  } catch {
    return null;
  } finally {
    e2eePending.splice(e2eePending.indexOf(key), 1);
  }
}

async function encryptForPeer(peer, payload) {
  const entry = await ensurePeerKey(peer);
  if (!entry) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, entry.key, data);
  return `e1.${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}

async function decryptFromPeer(peer, enc) {
  const entry = await ensurePeerKey(peer);
  if (!entry || typeof enc !== "string") return null;
  const parts = enc.split(".");
  if (parts.length !== 3 || parts[0] !== "e1") return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(parts[1]) }, entry.key, b64urlDecode(parts[2]));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

function dmPeerOf(msg, scope) {
  if (scope?.kind === "dm") return scope.with;
  const from = String(msg?.from || "").toLowerCase();
  return from === String(me?.id || "").toLowerCase() ? String(msg?.to || "").toLowerCase() : from;
}

async function decryptMessage(msg, scope) {
  if (!msg?.enc || msg.text) return msg;
  const peer = dmPeerOf(msg, scope);
  const payload = await decryptFromPeer(peer, msg.enc);
  if (payload && typeof payload === "object") {
    msg.text = String(payload.text || "");
    if (payload.reply && typeof payload.reply === "object") msg.reply_to = payload.reply;
  } else {
    msg.text = "[Messaggio cifrato non leggibile]";
  }
  msg.e2ee = true;
  delete msg.enc;
  return msg;
}

async function decryptMessageList(scope, msgs) {
  if (scope?.kind !== "dm") return msgs || [];
  return Promise.all((msgs || []).map(msg => decryptMessage(msg, scope)));
}

async function e2eeActiveFor(peer) {
  if (!peer || peer === String(me?.id || "").toLowerCase()) return false;
  await ensureE2EEIdentity();
  return !!(e2eeIdentity && peerE2EEPub(peer) && await ensurePeerKey(peer));
}

function safetyNumber(peer) {
  const mine = e2eeIdentity?.pubRaw;
  const theirs = peerE2EEPub(peer);
  if (!mine || !theirs) return null;
  const a = b64urlDecode(mine.slice(3));
  const b = b64urlDecode(theirs.slice(3));
  const concat = new Uint8Array(a.length + b.length);
  concat.set(a); concat.set(b, a.length);
  return crypto.subtle.digest("SHA-256", concat).then(hash =>
    [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("")
      .replace(/(.{5})/g, "$1 ").trim().slice(0, 35));
}

// ---------- Stati temporanei, badge verificati, richieste, blocchi ----------

const statusCache = new Map();          // user_id -> [stati attivi]
let statusRefreshTimer = null;

const VERIFICATION_TIERS = [
  { id: "blue",    label: "Blu",       price: "10€/mese", perks: "Badge blu · Bio fino a 240 caratteri" },
  { id: "black",   label: "Nero",      price: "25€/mese", perks: "Badge nera · Bio 320 · Animazione nome arcobaleno" },
  { id: "rainbow", label: "Arcobaleno",price: "50€/mese", perks: "Badge animata · Bio 500 · Animazione arcobaleno" },
];

function verificationBadgeEl(profile) {
  const tier = profile?.verification;
  if (!tier || !VERIFICATION_TIERS.some(t => t.id === tier)) return null;
  const icon = document.createElement("i");
  icon.className = `ph ph-seal-check verified-badge verified-${tier}`;
  icon.title = `Account verificato (${tier})`;
  return icon;
}

function appendVerificationBadge(target, profile) {
  const badge = verificationBadgeEl(profile);
  if (badge && target) target.appendChild(badge);
}

function hasActiveStatus(username) {
  const id = String(username || "").toLowerCase();
  const list = statusCache.get(id) || statusCache.get(username);
  return Array.isArray(list) && list.length > 0;
}

function contactStatuses(username) {
  const id = String(username || "").toLowerCase();
  return statusCache.get(id) || statusCache.get(username) || [];
}

function requestStatusList() {
  send({ t: "status_list" });
}

function queueStatusRefresh() {
  clearTimeout(statusRefreshTimer);
  statusRefreshTimer = setTimeout(requestStatusList, 400);
}

function renderMyStatuses() {
  const container = el("myStatusesList");
  if (!container) return;
  const mine = statusCache.get(String(me?.id || "").toLowerCase()) || [];
  container.replaceChildren();
  if (!mine.length) {
    container.innerHTML = '<div class="settings-list-item muted">Nessuno stato attivo.</div>';
    return;
  }
  mine.forEach(item => {
    const row = document.createElement("div");
    row.className = "settings-list-item";
    const left = document.createElement("span");
    left.innerHTML = `<strong></strong><small class="muted"></small>`;
    left.querySelector("strong").textContent = item.text || "";
    const leftTs = item.expires_at ? new Date(item.expires_at * 1000) : null;
    left.querySelector("small").textContent = leftTs
      ? `Scade il ${leftTs.toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`
      : "";
    const button = document.createElement("button");
    button.className = "btn btn-outline";
    button.textContent = "Elimina";
    button.onclick = () => send({ t: "status_delete", id: item.id });
    row.append(left, button);
    container.appendChild(row);
  });
}

function renderBadgeTiers(current) {
  const container = el("badgeTierList");
  if (!container) return;
  container.replaceChildren();
  VERIFICATION_TIERS.forEach(tier => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `badge-tier${current === tier.id ? " active" : ""}`;
    const icon = document.createElement("i");
    icon.className = `ph ph-seal-check verified-badge verified-${tier.id}`;
    const title = document.createElement("strong");
    title.textContent = `${tier.label} · ${tier.price}`;
    const perks = document.createElement("small");
    perks.textContent = tier.perks;
    button.append(icon, title, perks);
    button.onclick = () => send({ t: "badge_update", tier: tier.id });
    container.appendChild(button);
  });
  if (current) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-outline small-btn";
    cancel.textContent = "Annulla abbonamento";
    cancel.onclick = () => send({ t: "badge_update", action: "cancel" });
    container.appendChild(cancel);
  }
}

function renderFriendRequests(relationships) {
  const container = el("friendRequestsList");
  if (!container) return;
  container.replaceChildren();
  const list = (relationships || []).filter(r =>
    ["pending_incoming", "pending_outgoing"].includes(r.status));
  if (!list.length) {
    container.innerHTML = '<div class="settings-list-item muted">Nessuna richiesta.</div>';
    return;
  }
  list.forEach(rel => {
    const profile = rel.profile || {};
    const name = profile.name || profile.username || rel.target_user_id;
    const row = document.createElement("div");
    row.className = "settings-list-item";
    const left = document.createElement("span");
    left.innerHTML = `<strong></strong><small class="muted"></small>`;
    left.querySelector("strong").textContent = name;
    left.querySelector("small").textContent = rel.status === "pending_incoming"
      ? "Vuole aggiungerti ai contatti" : "Richiesta inviata";
    row.appendChild(left);
    if (rel.status === "pending_incoming") {
      const accept = document.createElement("button");
      accept.className = "btn btn-primary small-btn";
      accept.textContent = "Accetta";
      accept.onclick = () => send({ t: "relationship_update", user: rel.target_user_id, action: "accept" });
      const decline = document.createElement("button");
      decline.className = "btn btn-outline small-btn";
      decline.textContent = "Rifiuta";
      decline.onclick = () => send({ t: "relationship_update", user: rel.target_user_id, action: "decline" });
      row.append(accept, decline);
    }
    container.appendChild(row);
  });
}

function renderContactEphemeralStatus(username) {
  const section = el("contactProfileEphemeral");
  const body = el("contactProfileEphemeralBody");
  if (!section || !body) return;
  const list = contactStatuses(username);
  section.classList.toggle("hidden", !list.length);
  body.replaceChildren();
  list.forEach(item => {
    const row = document.createElement("div");
    row.className = "ephemeral-status-item";
    const text = document.createElement("span");
    text.textContent = item.text || "";
    const time = document.createElement("small");
    const left = item.expires_at ? item.expires_at - Math.floor(Date.now() / 1000) : 0;
    const hours = Math.max(1, Math.ceil(left / 3600));
    time.textContent = `tra ${hours}h`;
    row.append(text, time);
    body.appendChild(row);
  });
}

// ---------- Messaggi programmati: lista e cancellazione ----------

const scheduledList = el("scheduledList");
const scheduledPanel = el("scheduledPanel");
let scheduledItems = [];

function fmtScheduleTime(ts) {
  return ts ? new Date(ts * 1000).toLocaleString([], {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
}

function scheduledTargetLabel(item) {
  if (item.kind === "community") {
    const comm = (communityListData || []).find(c => c.id === item.community);
    return `#${item.channel} · ${comm?.name || item.community}`;
  }
  return contactProfile(item.with)?.name || `@${item.with || "?"}`;
}

function renderScheduledList() {
  if (!scheduledList) return;
  scheduledList.replaceChildren();
  if (!scheduledItems.length) {
    scheduledList.innerHTML = '<div class="msg-search-empty">Nessun messaggio programmato.</div>';
    return;
  }
  scheduledItems.forEach(item => {
    const row = document.createElement("div");
    row.className = "msg-search-result bookmark-result";
    const main = document.createElement("span");
    main.className = "msg-search-snippet";
    main.textContent = item.text
      || (item.has_poll ? "[Sondaggio]" : item.has_voice ? "[Messaggio vocale]" : "[Allegato]");
    const meta = document.createElement("span");
    meta.className = "msg-search-time";
    meta.textContent = `${scheduledTargetLabel(item)} · ${fmtScheduleTime(item.send_at)}`;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-outline btn-sm";
    cancel.textContent = "Annulla";
    cancel.addEventListener("click", () =>
      send({ t: "scheduled_cancel", id: item.id }));
    row.append(main, meta, cancel);
    scheduledList.appendChild(row);
  });
}

function toggleScheduledPanel(force) {
  const show = force ?? scheduledPanel.classList.contains("hidden");
  scheduledPanel.classList.toggle("hidden", !show);
  if (show) {
    bookmarkPanel?.classList.add("hidden");
    send({ t: "scheduled_list" });
  }
}

// ---------- Scadenza TTL per conversazione (DM) ----------

let convTtl = 0;   // secondi; 0 = disattivata

function convTtlLabel(ttl) {
  if (!ttl) return "disattivata";
  const h = Math.floor(ttl / 3600), d = Math.floor(ttl / 86400);
  if (d >= 1) return `${d}g`;
  if (h >= 1) return `${h}h`;
  return `${Math.max(1, Math.round(ttl / 60))}m`;
}

function refreshConvTtlButton() {
  const btn = el("convTtlButton");
  if (!btn) return;
  btn.classList.toggle("active", !!convTtl);
  btn.title = convTtl ? `Scadenza messaggi: ${convTtlLabel(convTtl)}` : "Scadenza conversazione";
}

function openConvTtlPicker(anchor) {
  document.getElementById("convTtlPanel")?.remove();
  const panel = document.createElement("div");
  panel.className = "ttl-panel";
  panel.id = "convTtlPanel";
  const title = document.createElement("div");
  title.className = "ttl-panel-title";
  title.textContent = "Scadenza per tutti i messaggi";
  panel.appendChild(title);
  const presets = [
    { label: "1 ora", ttl: 3600 }, { label: "24 ore", ttl: 86400 },
    { label: "7 giorni", ttl: 604800 }, { label: "Nessuna", ttl: 0 },
  ];
  presets.forEach(preset => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ttl-option" + (convTtl === preset.ttl ? " active" : "");
    button.textContent = preset.label;
    button.addEventListener("click", () => {
      panel.remove();
      send({ t: "conv_ttl", with: selectedContact, ttl: preset.ttl });
    });
    panel.appendChild(button);
  });
  document.body.appendChild(panel);
  const rect = anchor.getBoundingClientRect();
  panel.style.left = `${Math.min(rect.left, window.innerWidth - panel.offsetWidth - 12)}px`;
  panel.style.top = `${Math.max(8, rect.bottom + 6)}px`;
  const close = event => {
    if (!panel.contains(event.target)) {
      panel.remove();
      document.removeEventListener("click", close, true);
    }
  };
  setTimeout(() => document.addEventListener("click", close, true), 0);
}

// ---------- Ricerca globale ----------

let msgSearchGlobalMode = false;

function toggleMsgSearchGlobal() {
  msgSearchGlobalMode = !msgSearchGlobalMode;
  const btn = el("msgSearchGlobal");
  btn?.classList.toggle("active", msgSearchGlobalMode);
  el("msgSearchInput").placeholder = msgSearchGlobalMode
    ? "Cerca in tutte le conversazioni..." : "Cerca nei messaggi...";
  el("msgSearchInput").dispatchEvent(new Event("input"));
}

function globalResultScope(item) {
  if (item.scope === "community") {
    return rememberScope({
      kind: "community", community: item.community, channel: item.channel,
      key: `c:${item.community}:${item.channel}`,
    });
  }
  const peer = String(item.with || "").toLowerCase();
  return rememberScope({ kind: "dm", with: peer, key: `dm:${peer}` });
}

function globalResultLabel(item) {
  if (item.scope === "community") {
    const comm = (communityListData || []).find(c => c.id === item.community);
    return `#${item.channel} · ${comm?.name || item.community}`;
  }
  return contactProfile(item.with)?.name || `@${item.with || "?"}`;
}

function renderGlobalSearchResults(m) {
  const results = el("msgSearchResults");
  results.replaceChildren();
  const items = m.results || [];
  if (!items.length) {
    results.innerHTML = '<div class="msg-search-empty">Nessun risultato.</div>';
    return;
  }
  items.forEach(item => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "msg-search-result";
    const author = document.createElement("span");
    author.className = "msg-search-author";
    author.textContent = globalResultLabel(item);
    const snippet = document.createElement("span");
    snippet.className = "msg-search-snippet";
    snippet.textContent = item.text || "";
    const time = document.createElement("span");
    time.className = "msg-search-time";
    const ts = msgTs({ ts: item.ts });
    time.textContent = ts ? new Date(ts).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    button.append(author, snippet, time);
    button.addEventListener("click", () => {
      toggleMsgSearch(false);
      const scope = globalResultScope(item);
      if (!scope) return;
      if (scope.kind === "dm") selectContact(scope.with);
      else {
        selectCommunity(scope.community);
        setTimeout(() => selectCommunityChannel(scope.channel), 800);
      }
      setTimeout(() => jumpToMessage(scope, item.id), 1600);
    });
    results.appendChild(button);
  });
}

// ---------- Bozze sincronizzate ----------

let draftSyncTimer = null;

function syncDraftToServer(scope) {
  if (!scope) return;
  clearTimeout(draftSyncTimer);
  draftSyncTimer = setTimeout(() => {
    send({ t: "draft_save", scope_key: scope.key, text: messageInput.value });
  }, 800);
}

function applyServerDrafts(drafts) {
  Object.entries(drafts || {}).forEach(([key, text]) => {
    if (typeof text === "string" && text)
      localStorage.setItem(`ciaochat.draft.${key}`, text);
  });
}

async function sendChatMessage() {
  const text = messageInput.value.trim();
  if (attachmentUploadPending) {
    setComposerFeedback("Attendi il completamento dell'upload.", "error");
    return;
  }
  const attachment = pendingChatAttachment?.hash ? {
    hash: pendingChatAttachment.hash,
    name: pendingChatAttachment.name,
  } : null;
  const poll = pendingPoll ? {
    q: pendingPoll.q,
    options: pendingPoll.options.map(option => ({ text: option })),
    multiple: !!pendingPoll.multiple,
  } : null;
  if (!text && !attachment && !poll) return;
  const target = attachment
    ? pendingChatAttachment.target
    : currentCommunityId && currentChannelId
      ? { community: currentCommunityId, channel: currentChannelId }
      : selectedContact
        ? { to: selectedContact }
        : null;
  const reply = replyPayload();
  const scheduled = pendingScheduleAt > Math.floor(Date.now() / 1000) ? pendingScheduleAt : 0;
  let enc = null;
  let replyField = reply;
  if (!target?.community && text) {
    const peer = String(target?.to || selectedContact || "").toLowerCase();
    if (await e2eeActiveFor(peer)) {
      enc = await encryptForPeer(peer, { text, reply: reply || null });
      if (enc) replyField = null;   // la risposta viaggia dentro il payload cifrato
      else {
        setComposerFeedback("Crittografia non disponibile per questo contatto.", "error");
        return;
      }
    }
  }
  const payload = target?.community
    ? { t: "community_channel_send", ...target, text,
        ...(attachment ? { attachment } : {}), ...(poll ? { poll } : {}),
        ...(replyField ? { reply_to: replyField } : {}), ...(scheduled ? { send_at: scheduled } : {}) }
    : { t: "dm", to: target?.to || selectedContact, text: enc ? "" : text,
        ...(enc ? { enc } : {}),
        ...(attachment ? { attachment } : {}), ...(poll ? { poll } : {}),
        ...(replyField ? { reply_to: replyField } : {}), ...(scheduled ? { send_at: scheduled } : {}) };
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
  const sentScope = activeScope();
  messageInput.value = "";
  replyTarget = null;
  renderReplyPreview();
  clearDraft(sentScope);
  renderComposerEmoji();
  discardPendingAttachment();
  resetPollComposer();
  pendingScheduleAt = 0;
  clearScheduleChip();
  setComposerFeedback(scheduled ? "Messaggio programmato." : "", "");
  updateSendButton();
}

function insertAtCursor(value, selectFromEnd = 0) {
  const start = messageInput.selectionStart;
  const end = messageInput.selectionEnd;
  const text = messageInput.value;
  messageInput.value = text.slice(0, start) + value + text.slice(end);
  const cursor = start + value.length - selectFromEnd;
  messageInput.setSelectionRange(cursor, cursor);
  renderComposerEmoji();
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
  renderComposerEmoji();
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

const emojiCatalog = window.emojiCatalog || [];
let emojiPickerBuilt = false;

el("emojiButton").addEventListener("click", () => {
  toggleComposerPicker(el("emojiButton"), el("emojiPicker"), () => {
    const panel = el("emojiPicker");
    if (emojiPickerBuilt) return;
    const search = document.createElement("input");
    search.type = "search";
    search.className = "emoji-picker-search";
    search.placeholder = "Cerca emoji...";
    search.setAttribute("aria-label", "Cerca emoji");
    const buttons = [];
    const fragment = document.createDocumentFragment();
    emojiCatalog.forEach(([emoji, icon, name]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "emoji-choice";
      button.title = emoji;
      button.setAttribute("aria-label", name || emoji || icon);
      button.dataset.search = `${name || ""} ${emoji} ${icon}`.toLowerCase();
      const image = document.createElement("img");
      image.className = "chat-emoji";
      image.src = `static/emoji/${icon}.svg`;
      image.alt = "";
      image.draggable = false;
      image.setAttribute("loading", "lazy");
      image.setAttribute("decoding", "async");
      image.addEventListener("error", () => {
        button.textContent = emoji;
        image.remove();
      }, { once: true });
      button.appendChild(image);
      button.addEventListener("click", () => {
        insertAtCursor(emoji);
        panel.classList.add("hidden");
        el("emojiButton").setAttribute("aria-expanded", "false");
      });
      buttons.push(button);
      fragment.appendChild(button);
    });
    search.addEventListener("input", () => {
      const query = search.value.trim().toLowerCase();
      buttons.forEach(button => {
        button.hidden = !!query && !button.dataset.search.includes(query);
      });
    });
    panel.appendChild(search);
    panel.appendChild(fragment);
    emojiPickerBuilt = true;
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
    renderComposerEmoji();
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
  renderComposerEmoji();
  updateSendButton();
  saveDraft();
  maybeSendTyping();
});
messageInput.addEventListener("scroll", syncComposerEmojiScroll);
messageInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendChatMessage();
  }
});
sendBtn.addEventListener("click", sendChatMessage);

bookmarkButton.addEventListener("click", () => toggleBookmarkPanel());
bookmarkClose.addEventListener("click", () => toggleBookmarkPanel(false));

pollButton.addEventListener("click", () => togglePollPanel());
pollAddOption.addEventListener("click", () => {
  const rows = pollOptions.querySelectorAll(".poll-option-row");
  if (rows.length >= 10) return;
  pollOptions.appendChild(pollOptionRow());
  pollAddOption.disabled = pollOptions.querySelectorAll(".poll-option-row").length >= 10;
  pollOptions.querySelector(".poll-option-row:last-child input")?.focus();
});
pollCreateBtn.addEventListener("click", createPoll);

scheduleButton.addEventListener("click", () => toggleSchedulePanel());
scheduleSetBtn.addEventListener("click", setSchedule);

voiceRecordButton.addEventListener("click", () => {
  if (voiceRec) cancelVoiceRecording();
  else startVoiceRecording();
});
voiceRecorderCancel.addEventListener("click", () => cancelVoiceRecording());
voiceRecorderStop.addEventListener("click", finishVoiceRecording);

el("statusPostBtn")?.addEventListener("click", () => {
  const text = el("statusText").value.trim();
  if (!text) return;
  send({ t: "status_post", text });
  el("statusText").value = "";
});
el("statusText")?.addEventListener("keydown", event => {
  if (event.key === "Enter") el("statusPostBtn")?.click();
});
el("blockContactBtn")?.addEventListener("click", () => {
  const user = el("blockContactBtn").dataset.user;
  if (!user) return;
  if (!confirm(`Bloccare @${user}? Non potrà più scriverti e tu non potrai più scrivergli.`)) return;
  send({ t: "block_update", user, action: "block" });
  contactProfileModal.classList.add("hidden");
});
el("scheduledButton")?.addEventListener("click", () => toggleScheduledPanel());
el("scheduledClose")?.addEventListener("click", () => toggleScheduledPanel(false));
el("convTtlButton")?.addEventListener("click", event => {
  if (activeScope()?.kind !== "dm" || !selectedContact) return;
  openConvTtlPicker(event.currentTarget);
});
el("msgSearchGlobal")?.addEventListener("click", toggleMsgSearchGlobal);
el("searchButton").addEventListener("click", () => toggleMsgSearch());
el("msgSearchClose").addEventListener("click", () => toggleMsgSearch(false));
let msgSearchDebounce = null;
el("msgSearchInput").addEventListener("input", () => {
  clearTimeout(msgSearchDebounce);
  msgSearchDebounce = setTimeout(runMsgSearch, 350);
});
el("msgSearchInput").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    clearTimeout(msgSearchDebounce);
    runMsgSearch();
  }
  if (event.key === "Escape") toggleMsgSearch(false);
});
el("microphoneButton").title = "Apri test microfono";
el("microphoneButton").setAttribute("aria-label", "Apri test microfono");

// ---------- Incoming messages ----------
function onMessage(event) {
  let m;
  try { m = JSON.parse(event.data); } catch { return; }

  switch (m.t) {
    case "ok":
      resumePending = false;
      token = m.token;
      me = {
        id: m.id, username: m.user, email: m.email, avatar: m.avatar,
        avatar_type: m.avatar_type, banner: m.banner, banner_type: m.banner_type,
        name_color: m.name_color, name_animation: m.name_animation,
      };
      contacts = m.contacts || [];
      renderContacts();
      showMessenger();
      convStatus.textContent = "Connesso";
      send({ t: "community_list" });
      send({ t: "status_list" });
      send({ t: "draft_list" });
      ensureE2EEIdentity().then(() => {
        publishE2EEKey();
        if (selectedContact) e2eeActiveFor(selectedContact);
      });
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
        startRingSound();
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
      signalChain = Promise.resolve();
      startRingSound();
      desktopNotify("Chiamata in arrivo", `${caller} ti sta chiamando${m.video ? " in video" : ""}`, `dm:${m.from}`);
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
        stopRingSound();
        startOutgoingCall();
      }
      break;

    case "c_video":
    case "c_audio":
      if (activeCall?.id === m.call && m.d) queueSignal(m);
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
        cleanupCall();
        finishCall(reasons[m.reason] || "Chiamata terminata.");
      }
      break;

    case "c_taken":
      if (activeCall?.id === m.call) {
        cleanupCall();
        finishCall("La chiamata è stata risposta su un altro dispositivo.");
      }
      break;

    case "community_list":
      communityListData = m.communities || [];
      renderCommunityList(communityListData);
      renderCommunityNav(m.communities || []);
      renderPendingInvitations(m.invitations || []);
      break;

    case "community_data":
      if (m.community?.id) communityDataCache.set(m.community.id, m.community);
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
        const scope = rememberScope({
          kind: "community", community: m.community, channel: m.channel,
          key: `c:${m.community}:${m.channel}`,
        });
        if (m.before) {
          prependHistory(scope, m.messages || [], m.has_more, m.oldest);
        } else {
          renderCommunityHistory(m.messages || [], m.read_ts || 0,
                                 { hasMore: m.has_more, oldest: m.oldest });
        }
      }
      break;

    case "community_message": {
      const msg = m.message;
      const isSelf = msg?.from === me?.id;
      const senderName = isSelf ? "Tu" : (contactProfile(msg?.from)?.name || msg?.from || "Qualcuno");
      const communityName = currentCommunity?.name || m.community || "Community";
      onIncomingMessage(
        `cmsg:${m.community}:${m.channel}`,
        `${communityName} · ${senderName}`,
        communityName,
        `${senderName}: ${String(msg?.text || (msg?.poll ? "[Sondaggio]" : "") || (msg?.attachment ? "[allegato]" : "") || (msg?.voice ? "[vocale]" : "")).slice(0, 120)}`,
        isSelf,
      );
      const scope = rememberScope({
        kind: "community", community: m.community, channel: m.channel,
        key: `c:${m.community}:${m.channel}`,
      });
      if (msg?.id) {
        upsertCachedMessage(scope.key, msg);
        trimCache(scope.key);
      }
      if (m.community === currentCommunityId && m.channel === currentChannelId && msg?.id && !isExpiredMessage(msg)) {
        const node = messages.querySelector(`.msg[data-msg-id="${CSS.escape(String(msg.id))}"]`);
        if (!node) {
          const div = buildMessageEl(msg, scope);
          appendToMessages(div);
          maybeRequestLinkPreview(div, msg);
          renderPinnedBar(scope);
          scrollBottom();
        }
        reportRead(scope);
        updateTypingIndicator();
      }
      break;
    }

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

    case "e2ee_pub_ok":
      // Chiave pubblica di cifratura pubblicata.
      break;

    case "status_list": {
      statusCache.clear();
      const meId = String(me?.id || "").toLowerCase();
      (m.mine || []).length && statusCache.set(meId, m.mine);
      Object.entries(m.contacts || {}).forEach(([uid, list]) => {
        statusCache.set(String(uid).toLowerCase(), list);
      });
      renderContacts();
      renderMyStatuses();
      if (selectedContact) renderContactEphemeralStatus(selectedContact);
      break;
    }

    case "status_update":
      queueStatusRefresh();
      break;

    case "status_posted":
    case "status_deleted":
      requestStatusList();
      break;

    case "admin_notice":
      appendSystemMessage(`Avviso: ${m.text || ""}`);
      break;

    case "scheduled_list":
      scheduledItems = m.items || [];
      renderScheduledList();
      break;

    case "scheduled_cancelled":
      scheduledItems = scheduledItems.filter(item => item.id !== m.id);
      renderScheduledList();
      break;

    case "draft_list":
      applyServerDrafts(m.drafts);
      if (activeScope()) restoreDraft();
      break;

    case "conv_ttl":
      if (m.with === selectedContact) {
        convTtl = m.ttl || 0;
        refreshConvTtlButton();
      }
      break;

    case "global_search":
      renderGlobalSearchResults(m);
      break;

    case "history": {
      const scope = activeScope()?.kind === "dm"
        ? activeScope()
        : { kind: "dm", with: String(m.with || "").toLowerCase(),
            key: `dm:${String(m.with || "").toLowerCase()}` };
      if (m.before && scope.key === activeScope()?.key) {
        prependHistory(scope, m.msgs || [], m.has_more, m.oldest);
      } else if (!m.before) {
        renderHistory(m.msgs || [], m.with, m.read_ts || 0,
                      { hasMore: m.has_more, oldest: m.oldest });
        if (typeof m.conv_ttl !== "undefined" && scope.kind === "dm") {
          convTtl = m.conv_ttl || 0;
          refreshConvTtlButton();
        }
      }
      break;
    }

    case "dm": {
      (async () => {
      const from = m.from || "";
      const isSelf = String(from).toLowerCase() === String(me?.id || "").toLowerCase();
      const peer = isSelf ? String(m.to || "").toLowerCase() : String(from).toLowerCase();
      await decryptMessage(m, { kind: "dm", with: peer });
      onIncomingMessage(
        `dm:${peer}`,
        contactProfile(from)?.name || from || "Sconosciuto",
        contactProfile(from)?.name || from || "CiaoChat",
        String(m.text || (m.poll ? "[Sondaggio]" : "") || (m.attachment ? "[allegato]" : "") || (m.voice ? "[vocale]" : "")).slice(0, 120),
        isSelf,
      );
      if (m.id && peer) {
        const scope = rememberScope({ kind: "dm", with: peer, key: `dm:${peer}` });
        upsertCachedMessage(scope.key, m);
        trimCache(scope.key);
        const active = activeScope();
        if (active?.kind === "dm" && active.with === peer && !isExpiredMessage(m)) {
          const node = messages.querySelector(`.msg[data-msg-id="${CSS.escape(String(m.id))}"]`);
          if (!node) {
            const div = buildMessageEl(m, scope);
            appendToMessages(div);
            maybeRequestLinkPreview(div, m);
            renderPinnedBar(scope);
            scrollBottom();
          }
          reportRead(scope);
          updateTypingIndicator();
        }
      }
      })();
      break;
    }

    case "msg_updated": {
      const scopeKey = m.scope === "community" ? `c:${m.community}:${m.channel}` : `dm:${String(m.with || "").toLowerCase()}`;
      if (m.enc && m.scope !== "community") {
        decryptFromPeer(String(m.with || "").toLowerCase(), m.enc).then(payload => {
          patchCachedMessage(scopeKey, m.id, {
            text: payload && typeof payload === "object" ? String(payload.text || "") : "[Messaggio cifrato non leggibile]",
            edited: true, e2ee: true, enc: null, edits: m.edits || null,
          });
          refreshMessageElement(scopeKey, m.id);
        });
      } else {
        patchCachedMessage(scopeKey, m.id, { text: m.text, edited: true, edits: m.edits || null });
        refreshMessageElement(scopeKey, m.id);
      }
      break;
    }

    case "msg_deleted": {
      const scopeKey = m.scope === "community" ? `c:${m.community}:${m.channel}` : `dm:${String(m.with || "").toLowerCase()}`;
      patchCachedMessage(scopeKey, m.id, { deleted: true, text: "", attachment: null, voice: null, poll: null, reactions: {}, enc: null });
      const node = messages.querySelector(`.msg[data-msg-id="${CSS.escape(String(m.id))}"]`);
      if (node) node.replaceWith(buildMessageEl(
        (convoCaches.get(scopeKey) || []).find(item => item.id === m.id) || { id: m.id, deleted: true },
        scopeFromKey(scopeKey) || activeScope()));
      renderPinnedBar(scopeFromKey(scopeKey) || activeScope());
      break;
    }

    case "msg_reactions": {
      const scopeKey = m.scope === "community" ? `c:${m.community}:${m.channel}` : `dm:${String(m.with || "").toLowerCase()}`;
      patchCachedMessage(scopeKey, m.id, { reactions: m.reactions || {} });
      refreshMessageElement(scopeKey, m.id);
      break;
    }

    case "msg_pinned": {
      const scopeKey = m.scope === "community" ? `c:${m.community}:${m.channel}` : `dm:${String(m.with || "").toLowerCase()}`;
      patchCachedMessage(scopeKey, m.id, { pinned: !!m.pinned });
      refreshMessageElement(scopeKey, m.id);
      const scope = scopeFromKey(scopeKey);
      if (scope && activeScope()?.key === scope.key) renderPinnedBar(scope);
      break;
    }

    case "msg_poll": {
      const scopeKey = m.scope === "community" ? `c:${m.community}:${m.channel}` : `dm:${String(m.with || "").toLowerCase()}`;
      patchCachedMessage(scopeKey, m.id, { poll: m.poll });
      refreshMessageElement(scopeKey, m.id);
      break;
    }

    case "msg_expire": {
      const scopeKey = m.scope === "community" ? `c:${m.community}:${m.channel}` : `dm:${String(m.with || "").toLowerCase()}`;
      patchCachedMessage(scopeKey, m.id, { expires_at: m.expires_at || 0 });
      refreshMessageElement(scopeKey, m.id);
      break;
    }

    case "msg_scheduled":
      setComposerFeedback("Messaggio programmato correttamente.", "success");
      if (!scheduledPanel.classList.contains("hidden")) send({ t: "scheduled_list" });
      break;

    case "msg_scheduled_sent": {
      const scopeKey = m.scope === "community"
        ? `c:${m.community}:${m.channel}`
        : `dm:${String(m.with || "").toLowerCase()}`;
      const scope = scopeFromKey(scopeKey);
      if (scope && activeScope()?.key === scope.key) {
        appendSystemMessage("Messaggio programmato inviato.");
      }
      break;
    }

    case "bookmark_list": {
      const scopeKey = m.scope === "community"
        ? `c:${m.community}:${m.channel}`
        : `dm:${String(m.with || "").toLowerCase()}`;
      (m.items || []).forEach(item => {
        if (item?.id) bookmarkedMsgs.add(`${scopeKey}:${item.id}`);
      });
      if (!bookmarkPanel.classList.contains("hidden")) renderBookmarkList(m);
      break;
    }

    case "bookmark_saved":
    case "bookmark_removed": {
      const scopeKey = m.scope === "community"
        ? `c:${m.community}:${m.channel}`
        : `dm:${String(m.with || "").toLowerCase()}`;
      const key = `${scopeKey}:${m.id}`;
      if (m.t === "bookmark_saved") bookmarkedMsgs.add(key);
      else bookmarkedMsgs.delete(key);
      if (!bookmarkPanel.classList.contains("hidden")) {
        send({
          t: "bookmark_list", scope: m.scope,
          ...(m.scope === "community"
            ? { community: m.community, channel: m.channel }
            : { with: m.with }),
        });
      }
      break;
    }

    case "typing":
      if (m.from && m.from !== me?.id) {
        showTyping(m);
        expireTyping(typingScopeKey(m), m.from);
      }
      break;

    case "read_receipt": {
      const key = String(m.from || "").toLowerCase();
      if (key && (peerReadTs[key] || 0) < (m.ts || 0)) {
        peerReadTs[key] = m.ts || 0;
        const scope = activeScope();
        if (scope?.kind === "dm" && scope.with === key) {
          messages.querySelectorAll(".msg.self").forEach(node => {
            const id = node.dataset.msgId;
            const msg = (convoCaches.get(scope.key) || []).find(item => item.id === id);
            if (msg && msgSeconds(msg) <= peerReadTs[key]) {
              const meta = node.querySelector(".meta");
              if (meta && !meta.textContent.includes("Letto")) {
                meta.textContent += meta.textContent ? " · Letto" : "Letto";
              }
            }
          });
        }
      }
      break;
    }

    case "msg_search":
      if (activeScope()) renderSearchResults(m);
      break;

    case "msg_result": {
      const scopeKey = m.scope === "community" ? `c:${m.community}:${m.channel}` : `dm:${String(m.with || "").toLowerCase()}`;
      const scope = scopeFromKey(scopeKey);
      (async () => {
      if (m.message?.id) {
        if (m.message.enc && m.scope !== "community") {
          await decryptMessage(m.message, { kind: "dm", with: String(m.with || "").toLowerCase() });
        }
        upsertCachedMessage(scopeKey, m.message);
        trimCache(scopeKey);
        const active = activeScope();
        if (scope && active?.key === scope.key) {
          renderConvoList(scope, convoCaches.get(scope.key) || [], activeReadTs);
          jumpToMessage(scope, m.message.id);
        }
      }
      })();
      break;
    }

    case "link_preview":
      onLinkPreview(m);
      break;

    case "profile":
      if (m.profile?.id === requestedProfileId) {
        profileBeingViewed = m.profile;
        requestedProfileId = null;
        renderContactProfile();
      }
      break;

    case "profile_update":
      updateProfile(m.profile);
      if (profileBeingViewed?.id === m.profile?.id) {
        profileBeingViewed = { ...profileBeingViewed, ...m.profile };
        renderContactProfile();
      }
      break;

    case "media":
      mediaRequests.delete(m.hash);
      if (typeof m.data === "string" && typeof m.mime === "string" && m.mime) {
        mediaCache.set(m.hash, `data:${m.mime};base64,${m.data}`);
        messages.querySelectorAll("[data-attachment-hash]").forEach(node => {
          if (node.dataset.attachmentHash !== m.hash) return;
          const replacement = renderMessageAttachment({ hash: m.hash, mime: m.mime });
          if (replacement) node.replaceWith(replacement);
        });
        messages.querySelectorAll("[data-voice-hash]").forEach(node => {
          if (node.dataset.voiceHash !== m.hash) return;
          const replacement = renderVoiceMessage({ hash: m.hash });
          if (replacement) node.closest(".msg-voice")?.replaceWith(replacement);
        });
        renderContacts();
        renderSelectedContact();
        if (!contactProfileModal.classList.contains("hidden")) renderContactProfile();
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
      } else if (m.kind === "voice" && pendingVoiceSend) {
        clearTimeout(voiceUploadTimer);
        voiceUploadTimer = null;
        voiceUploadPending = false;
        messageInput.disabled = false;
        const pending = pendingVoiceSend;
        pendingVoiceSend = null;
        const voicePayload = {
          ...pending.target,
          voice: { hash: m.hash, dur: pending.duration },
          ...(pending.scheduled ? { send_at: pending.scheduled } : {}),
        };
        if (pending.scheduled) {
          pendingScheduleAt = 0;
          clearScheduleChip();
        }
        if (!send(voicePayload)) {
          setComposerFeedback("Messaggio vocale non inviato: connessione non disponibile.", "error");
        } else if (pending.scheduled) {
          setComposerFeedback("Messaggio vocale programmato.", "success");
        }
        updateSendButton();
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
      if (requestedProfileId && !contactProfileModal.classList.contains("hidden")) {
        contactProfileError.textContent = m.text || "Impossibile caricare il profilo.";
        requestedProfileId = null;
        break;
      }
      if (!contactProfileModal.classList.contains("hidden")) {
        contactProfileError.textContent = m.text || "Operazione non riuscita.";
        break;
      }
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
      if (voiceUploadPending || pendingVoiceSend) {
        voiceUploadPending = false;
        pendingVoiceSend = null;
        clearTimeout(voiceUploadTimer);
        voiceUploadTimer = null;
        messageInput.disabled = false;
        updateSendButton();
        setComposerFeedback(m.text || "Invio del messaggio vocale non riuscito.", "error");
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
      contacts = contacts.map(c => (c.id || c.username) === m.id
        ? { ...c, online: m.online, ...(m.last_seen ? { last_seen: m.last_seen } : {}) }
        : c);
      renderContacts();
      updateConvStatus();
      if (currentCommunity?.participants?.some(person => person.id === m.id)) {
        currentCommunity.participants = currentCommunity.participants.map(person =>
          person.id === m.id ? { ...person, online: m.online } : person
        );
        renderParticipants(currentCommunity);
      }
      if (profileBeingViewed?.id === m.id) {
        profileBeingViewed = { ...profileBeingViewed, online: m.online };
        contactProfilePresence.classList.toggle("online", m.online === true);
        contactProfilePresence.setAttribute("aria-label", m.online ? "Online" : "Offline");
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

async function renderHistory(msgs, withUser, readTs = 0, meta = {}) {
  const scope = activeScope()?.kind === "dm"
    ? activeScope()
    : { kind: "dm", with: String(withUser || "").toLowerCase(),
        key: `dm:${String(withUser || "").toLowerCase()}` };
  msgs = await decryptMessageList(scope, msgs);
  rememberHistory(scope, meta.hasMore, meta.oldest);
  renderConvoList(scope, msgs || [], readTs);
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
const brandIntro = document.getElementById("brandIntro");
const appRoot = document.getElementById("app");
const reducedIntroMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const introMorphDuration = reducedIntroMotion ? 1 : 2000;
const introFadeDuration = reducedIntroMotion ? 160 : 300;
window.setTimeout(() => {
  brandIntro.classList.add("is-fading");
  appRoot.removeAttribute("aria-hidden");
  appRoot.removeAttribute("inert");
}, introMorphDuration);
window.setTimeout(() => brandIntro.remove(), introMorphDuration + introFadeDuration);

function restoreAuthHandoff() {
  const handoffKey = "ciaochat.auth-handoff";
  try {
    const raw = sessionStorage.getItem(handoffKey);
    if (!raw) return;
    sessionStorage.removeItem(handoffKey);
    const handoff = JSON.parse(raw);
    if (typeof handoff.id !== "string" || typeof handoff.token !== "string") {
      console.warn("[auth] Ignoring an invalid standalone login handoff.");
      return;
    }
    token = handoff.token;
    me = { id: handoff.id };
  } catch (error) {
    console.error("[auth] Could not restore the standalone login session.", error);
  }
}

applyLiveAppearance();
restoreAuthHandoff();
connect();
