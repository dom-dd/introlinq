(function () {
  if (window.__ilChatLoaded) return;
  window.__ilChatLoaded = true;

  var STORAGE_KEY = 'il_chat_state';
  var GREETED_KEY = 'il_chat_greeted';
  var POLL_MS = 4000;
  var GREETING_DELAY_MS = 4000;

  var state = loadState();
  var renderedIds = {};
  var pollTimer = null;
  var isPublisher = false;
  var publisherName = '';
  var publisherEmail = '';

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function isOnline() {
    try {
      var parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }).formatToParts(new Date());
      var hour = parseInt(parts.find(function (p) { return p.type === 'hour'; }).value, 10);
      return hour >= 9 && hour < 22;
    } catch (e) { return true; }
  }

  // ---- styles ----
  var css = ''
    + '#il-chat-root{position:fixed;bottom:20px;right:20px;z-index:99999;font-family:Inter,system-ui,-apple-system,sans-serif}'
    + '#il-chat-bubble{width:56px;height:56px;border-radius:50%;background:#1a1a2e;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(26,26,46,0.25);position:relative;transition:transform .15s}'
    + '#il-chat-bubble:hover{transform:scale(1.05)}'
    + '#il-chat-bubble svg{width:24px;height:24px}'
    + '.il-chat-dot{position:absolute;width:11px;height:11px;border-radius:50%;background:#8888a8;border:2px solid #fff;top:2px;right:2px}'
    + '.il-chat-dot.on{background:#3d7a5f}'
    + '.il-chat-greeting{position:absolute;bottom:68px;right:0;width:240px;background:#fff;border-radius:14px;box-shadow:0 12px 32px rgba(26,26,46,0.18);padding:14px 34px 14px 16px;font-size:0.8125rem;color:#1a1a2e;line-height:1.5;cursor:pointer}'
    + '.il-chat-greeting-close{position:absolute;top:8px;right:8px;width:20px;height:20px;border:none;background:none;color:#8888a8;font-size:0.875rem;cursor:pointer;line-height:1}'
    + '.il-chat-panel{position:absolute;bottom:68px;right:0;width:340px;max-width:92vw;height:min(520px,75vh);background:#fff;border-radius:16px;box-shadow:0 16px 48px rgba(26,26,46,0.22);display:flex;flex-direction:column;overflow:hidden}'
    + '#il-chat-panel[hidden]{display:none}'
    + '.il-chat-header{background:#1a1a2e;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}'
    + '.il-chat-header-left{display:flex;align-items:center;gap:10px}'
    + '.il-chat-avatar{position:relative;width:34px;height:34px;border-radius:50%;background:#e6a820;color:#1a1a2e;font-weight:700;font-size:0.75rem;display:flex;align-items:center;justify-content:center;font-family:Georgia,serif}'
    + '.il-chat-avatar .il-chat-dot{top:-2px;right:-2px;border-color:#1a1a2e}'
    + '.il-chat-title{color:#fff;font-weight:600;font-size:0.875rem}'
    + '.il-chat-status{color:rgba(255,255,255,0.55);font-size:0.6875rem}'
    + '.il-chat-close{background:none;border:none;color:rgba(255,255,255,0.8);font-size:1rem;cursor:pointer;padding:4px}'
    + '.il-chat-body{flex:1;display:flex;flex-direction:column;min-height:0;background:#faf8f4}'
    + '.il-chat-gate{padding:18px 16px;display:flex;flex-direction:column;gap:10px;overflow-y:auto}'
    + '.il-chat-gate input,.il-chat-gate textarea{border:1px solid rgba(26,26,46,0.14);border-radius:10px;padding:10px 12px;font-size:0.8125rem;font-family:inherit;color:#1a1a2e;resize:none;outline:none}'
    + '.il-chat-gate input:focus,.il-chat-gate textarea:focus{border-color:#3d7a5f}'
    + '.il-chat-gate textarea{min-height:70px}'
    + '.il-chat-gate button{background:#e6a820;color:#1a1a2e;border:none;border-radius:100px;padding:10px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit}'
    + '.il-chat-gate button:disabled{opacity:0.6;cursor:default}'
    + '.il-chat-hint{font-size:0.6875rem;color:#8888a8;line-height:1.5;margin:0}'
    + '.il-chat-identity{font-size:0.8125rem;color:#1a1a2e;background:#fff;border:1px solid rgba(26,26,46,0.08);border-radius:10px;padding:10px 12px;margin:0}'
    + '.il-chat-identity span{display:block;font-size:0.75rem;color:#8888a8;margin-top:2px}'
    + '.il-chat-error{font-size:0.75rem;color:#c0392b;margin:0}'
    + '.il-chat-thread{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:8px}'
    + '.il-chat-msg{max-width:80%;padding:8px 12px;border-radius:14px;font-size:0.8125rem;line-height:1.45;white-space:pre-wrap;word-break:break-word}'
    + '.il-chat-msg-visitor{align-self:flex-end;background:#1a1a2e;color:#fff;border-bottom-right-radius:4px}'
    + '.il-chat-msg-agent{align-self:flex-start;background:#fff;color:#1a1a2e;border:1px solid rgba(26,26,46,0.08);border-bottom-left-radius:4px}'
    + '.il-chat-msg-system{align-self:center;background:transparent;color:#8888a8;font-size:0.6875rem;text-align:center;max-width:95%}'
    + '.il-chat-send-form{flex-shrink:0;display:flex;gap:8px;padding:10px;border-top:1px solid rgba(26,26,46,0.08);background:#fff}'
    + '.il-chat-send-form input{flex:1;border:1px solid rgba(26,26,46,0.14);border-radius:100px;padding:9px 14px;font-size:0.8125rem;font-family:inherit;outline:none}'
    + '.il-chat-send-form input:focus{border-color:#3d7a5f}'
    + '.il-chat-send-form button{width:34px;height:34px;border-radius:50%;background:#1a1a2e;border:none;color:#fff;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center}'
    + '.il-chat-send-form button:disabled{opacity:0.5;cursor:default}'
    + '@media(max-width:420px){#il-chat-root{right:12px;bottom:12px}.il-chat-panel,.il-chat-greeting{right:-4px}}';
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ---- DOM ----
  var root = document.createElement('div');
  root.id = 'il-chat-root';
  root.innerHTML = ''
    + '<div class="il-chat-greeting" id="il-chat-greeting" hidden>'
    + '  <button class="il-chat-greeting-close" id="il-chat-greeting-close" aria-label="Close">✕</button>'
    + '  <div id="il-chat-greeting-text">Hey there 👋 Any questions? We usually reply within 5–10 minutes.</div>'
    + '</div>'
    + '<button id="il-chat-bubble" aria-label="Open chat">'
    + '  <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>'
    + '  <span class="il-chat-dot" id="il-chat-bubble-dot"></span>'
    + '</button>'
    + '<div class="il-chat-panel" id="il-chat-panel" hidden>'
    + '  <div class="il-chat-header">'
    + '    <div class="il-chat-header-left">'
    + '      <div class="il-chat-avatar">IL<span class="il-chat-dot" id="il-chat-header-dot"></span></div>'
    + '      <div><div class="il-chat-title">IntroLinq</div><div class="il-chat-status" id="il-chat-status-text">Online</div></div>'
    + '    </div>'
    + '    <button class="il-chat-close" id="il-chat-close" aria-label="Close">✕</button>'
    + '  </div>'
    + '  <div class="il-chat-body" id="il-chat-body"></div>'
    + '</div>';
  document.body.appendChild(root);

  var bubbleDot = document.getElementById('il-chat-bubble-dot');
  var headerDot = document.getElementById('il-chat-header-dot');
  var statusText = document.getElementById('il-chat-status-text');
  var panel = document.getElementById('il-chat-panel');
  var greeting = document.getElementById('il-chat-greeting');
  var body = document.getElementById('il-chat-body');

  function refreshOnlineStatus() {
    var online = isOnline();
    bubbleDot.classList.toggle('on', online);
    headerDot.classList.toggle('on', online);
    statusText.textContent = online ? 'Online now' : 'Away - leave a message';
  }
  refreshOnlineStatus();
  setInterval(refreshOnlineStatus, 60000);

  // ---- gate (pre-chat form) ----
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderGate() {
    body.innerHTML = ''
      + '<form class="il-chat-gate" id="il-chat-gate-form">'
      + (isPublisher
          ? '<p class="il-chat-identity">Chatting as ' + escapeAttr(publisherName) + '<span>' + escapeAttr(publisherEmail) + '</span></p>'
          : ''
            + '<input name="name" placeholder="Full name" value="' + escapeAttr(state.name) + '" required>'
            + '<input name="email" type="email" placeholder="Email address" value="' + escapeAttr(state.email) + '" required>')
      + '<textarea name="message" placeholder="Ask me anything..." required></textarea>'
      + '<p class="il-chat-error" id="il-chat-gate-error" hidden></p>'
      + '<button type="submit">Send</button>'
      + '<p class="il-chat-hint">Our team is online and will reply as soon as possible - this chat is answered by a real person, not AI. Feel free to close this window any time - we’ll email your answer to you.</p>'
      + '</form>';
    document.getElementById('il-chat-gate-form').addEventListener('submit', onGateSubmit);
  }

  function onGateSubmit(e) {
    e.preventDefault();
    var form = e.target;
    var btn = form.querySelector('button');
    var errorEl = document.getElementById('il-chat-gate-error');
    errorEl.hidden = true;
    var payload = {
      name: form.name ? form.name.value.trim() : undefined,
      email: form.email ? form.email.value.trim() : undefined,
      message: form.message.value.trim(),
      page_url: location.href,
    };
    if (!payload.message) return;
    btn.disabled = true;
    fetch('/api/chat?action=start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) {
        if (!res.ok) {
          errorEl.textContent = res.data.error || 'Something went wrong - please try again.';
          errorEl.hidden = false;
          btn.disabled = false;
          return;
        }
        state = { conversationId: res.data.conversationId, visitorToken: res.data.visitorToken, since: null, name: res.data.name, email: res.data.email };
        saveState();
        try { localStorage.setItem(GREETED_KEY, '1'); } catch (err) {}
        renderThread();
        fetchMessages();
        startPolling();
      })
      .catch(function () {
        errorEl.textContent = 'Something went wrong - please try again.';
        errorEl.hidden = false;
        btn.disabled = false;
      });
  }

  // ---- thread ----
  function renderThread() {
    body.innerHTML = ''
      + '<div class="il-chat-thread" id="il-chat-thread"></div>'
      + '<form class="il-chat-send-form" id="il-chat-send-form">'
      + '  <input name="message" placeholder="Ask me anything..." autocomplete="off" required>'
      + '  <button type="submit" aria-label="Send"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>'
      + '</form>';
    renderedIds = {};
    document.getElementById('il-chat-send-form').addEventListener('submit', onThreadSubmit);
  }

  function appendMessage(sender, text) {
    var thread = document.getElementById('il-chat-thread');
    if (!thread) return;
    var el = document.createElement('div');
    el.className = 'il-chat-msg il-chat-msg-' + sender;
    el.textContent = text;
    thread.appendChild(el);
    thread.scrollTop = thread.scrollHeight;
  }

  function onThreadSubmit(e) {
    e.preventDefault();
    var form = e.target;
    var input = form.message;
    var text = input.value.trim();
    if (!text) return;
    var btn = form.querySelector('button');
    btn.disabled = true;
    input.value = '';
    fetch('/api/chat?action=message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: state.conversationId, visitorToken: state.visitorToken, message: text }),
    }).then(function () { fetchMessages(); })
      .finally(function () { btn.disabled = false; });
  }

  function fetchMessages() {
    if (!state.conversationId || !state.visitorToken) return;
    var qs = 'action=poll&conversationId=' + encodeURIComponent(state.conversationId)
      + '&visitorToken=' + encodeURIComponent(state.visitorToken)
      + (state.since ? '&since=' + encodeURIComponent(state.since) : '');
    fetch('/api/chat?' + qs).then(function (r) { return r.json(); }).then(function (data) {
      if (!data.messages) return;
      data.messages.forEach(function (m) {
        if (renderedIds[m.id]) return;
        renderedIds[m.id] = true;
        appendMessage(m.sender, m.body);
        state.since = m.created_at;
      });
      saveState();
    }).catch(function () {});
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(fetchMessages, POLL_MS);
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // ---- open/close ----
  function openPanel() {
    greeting.hidden = true;
    panel.hidden = false;
    if (state.conversationId) {
      renderThread();
      fetchMessages();
      startPolling();
    } else {
      renderGate();
    }
  }
  function closePanel() {
    panel.hidden = true;
    stopPolling();
  }

  document.getElementById('il-chat-bubble').addEventListener('click', function () {
    if (panel.hidden) openPanel(); else closePanel();
  });
  document.getElementById('il-chat-close').addEventListener('click', closePanel);
  document.getElementById('il-chat-greeting-close').addEventListener('click', function (e) {
    e.stopPropagation();
    greeting.hidden = true;
    try { localStorage.setItem(GREETED_KEY, '1'); } catch (err) {}
  });
  greeting.addEventListener('click', function () {
    try { localStorage.setItem(GREETED_KEY, '1'); } catch (err) {}
    openPanel();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopPolling(); return; }
    if (!panel.hidden && state.conversationId) { fetchMessages(); startPolling(); }
  });

  // ---- init ----
  fetch('/api/auth?action=me', { credentials: 'same-origin' })
    .then(function (r) {
      isPublisher = r.ok;
      return r.ok ? r.json() : null;
    })
    .then(function (data) {
      if (data) { publisherName = data.name || ''; publisherEmail = data.email || ''; }
    })
    .catch(function () {})
    .finally(function () {
      var alreadyGreeted = false;
      try { alreadyGreeted = localStorage.getItem(GREETED_KEY) === '1'; } catch (e) {}
      if (!state.conversationId && !alreadyGreeted) {
        setTimeout(function () { if (panel.hidden) greeting.hidden = false; }, GREETING_DELAY_MS);
      }
    });
})();
