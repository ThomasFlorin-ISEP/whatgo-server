/**
 * ============================================================
 * WIDGET DE CHAT — à coller sur n'importe quel site
 * ============================================================
 *   <script
 *     src="widget.js"
 *     data-server="http://localhost:3000/api/chat"
 *     data-business="whatgo"
 *     data-name="WHATGO Assistant"
 *   ></script>
 */
(function () {
  var scriptTag = document.currentScript;
  var SERVER_URL = scriptTag.getAttribute('data-server') || '/api/chat';
  var BOT_NAME = scriptTag.getAttribute('data-name') || 'Assistant';
  var BUSINESS = scriptTag.getAttribute('data-business');
  var conversationId = null;

  var style = document.createElement('style');
  style.textContent = `
    .wgt-root, .wgt-root * { box-sizing: border-box; font-family: 'Inter', -apple-system, sans-serif; }
    .wgt-bubble {
      position: fixed; bottom: 22px; right: 22px; width: 58px; height: 58px;
      border-radius: 50%; background: #1B2321; color: #F4F5F1; border: none;
      cursor: pointer; box-shadow: 0 10px 30px rgba(27,35,33,.25); z-index: 999998;
      display: flex; align-items: center; justify-content: center; transition: transform .15s;
    }
    .wgt-bubble:hover { transform: scale(1.06); }
    .wgt-bubble svg { width: 26px; height: 26px; }
    .wgt-panel {
      position: fixed; bottom: 92px; right: 22px; width: 360px; max-width: calc(100vw - 32px);
      height: 520px; max-height: calc(100vh - 140px); background: #F4F5F1; border-radius: 16px;
      box-shadow: 0 24px 60px rgba(27,35,33,.25); display: none; flex-direction: column;
      overflow: hidden; z-index: 999999; border: 1px solid #DADED8;
    }
    .wgt-panel.wgt-open { display: flex; }
    .wgt-head {
      background: #1B2321; color: #F4F5F1; padding: 16px 18px; display: flex;
      align-items: center; gap: 10px; flex-shrink: 0;
    }
    .wgt-head-av {
      width: 30px; height: 30px; border-radius: 50%; background: #1FAA59; color: #08301A;
      font-weight: 700; font-size: .78rem; display: flex; align-items: center; justify-content: center;
      font-family: 'Space Grotesk', sans-serif;
    }
    .wgt-head-txt b { font-family: 'Space Grotesk', sans-serif; font-size: .88rem; display: block; }
    .wgt-head-txt span { font-size: .7rem; opacity: .65; }
    .wgt-close {
      margin-left: auto; background: none; border: none; color: #F4F5F1; cursor: pointer;
      opacity: .7; width: 26px; height: 26px;
    }
    .wgt-close:hover { opacity: 1; }
    .wgt-log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    .wgt-msg { max-width: 82%; padding: 9px 13px; border-radius: 10px; font-size: .87rem; line-height: 1.45; }
    .wgt-msg.bot { background: #ECEDE8; color: #1B2321; align-self: flex-start; }
    .wgt-msg.user { background: #1B2321; color: #F4F5F1; align-self: flex-end; }
    .wgt-typing { align-self: flex-start; display: flex; gap: 4px; padding: 10px 13px; }
    .wgt-typing i { width: 5px; height: 5px; border-radius: 50%; background: #8A9089; animation: wgt-b 1s infinite ease-in-out; }
    .wgt-typing i:nth-child(2) { animation-delay: .15s; } .wgt-typing i:nth-child(3) { animation-delay: .3s; }
    @keyframes wgt-b { 0%,60%,100%{transform:translateY(0);opacity:.5} 30%{transform:translateY(-3px);opacity:1} }
    .wgt-form { display: flex; border-top: 1px solid #DADED8; padding: 8px; background: #fff; flex-shrink: 0; }
    .wgt-form input {
      flex: 1; border: none; outline: none; font-size: .86rem; padding: 8px 10px; background: transparent;
      font-family: inherit; color: #1B2321;
    }
    .wgt-send {
      border: none; background: #1B2321; color: #F4F5F1; width: 32px; height: 32px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0;
    }
    .wgt-send:disabled { opacity: .4; cursor: default; }
  `;
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.className = 'wgt-root';
  root.innerHTML = `
    <button class="wgt-bubble" aria-label="Ouvrir le chat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
    </button>
    <div class="wgt-panel">
      <div class="wgt-head">
        <div class="wgt-head-av">AI</div>
        <div class="wgt-head-txt"><b>${BOT_NAME}</b><span>Répond en quelques secondes</span></div>
        <button class="wgt-close" aria-label="Fermer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="wgt-log"></div>
      <form class="wgt-form">
        <input type="text" placeholder="Écrivez votre message…" autocomplete="off" />
        <button type="submit" class="wgt-send" aria-label="Envoyer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="m22 2-7 20-4-9-9-4Z"/></svg>
        </button>
      </form>
    </div>
  `;
  document.body.appendChild(root);

  var bubble = root.querySelector('.wgt-bubble');
  var panel = root.querySelector('.wgt-panel');
  var closeBtn = root.querySelector('.wgt-close');
  var log = root.querySelector('.wgt-log');
  var form = root.querySelector('.wgt-form');
  var input = root.querySelector('input');
  var sendBtn = root.querySelector('.wgt-send');

  var history = [];

  function addMessage(role, text) {
    var div = document.createElement('div');
    div.className = 'wgt-msg ' + (role === 'user' ? 'user' : 'bot');
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function showTyping() {
    var t = document.createElement('div');
    t.className = 'wgt-typing';
    t.innerHTML = '<i></i><i></i><i></i>';
    log.appendChild(t);
    log.scrollTop = log.scrollHeight;
    return t;
  }

  bubble.addEventListener('click', function () {
    panel.classList.toggle('wgt-open');
    if (panel.classList.contains('wgt-open') && log.children.length === 0) {
      addMessage('bot', "Bonjour 👋 Comment puis-je vous aider ?");
    }
  });
  closeBtn.addEventListener('click', function () { panel.classList.remove('wgt-open'); });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtn.disabled = true;

    addMessage('user', text);
    history.push({ role: 'user', content: text });

    var typing = showTyping();

    try {
      var res = await fetch(SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, business: BUSINESS, conversationId: conversationId }),
      });
      var data = await res.json();
      typing.remove();

      if (data.error) {
        addMessage('bot', "Désolé, une erreur est survenue. Réessayez dans un instant.");
      } else {
        addMessage('bot', data.reply);
        history.push({ role: 'assistant', content: data.reply });
        conversationId = data.conversationId;
      }
    } catch (err) {
      typing.remove();
      addMessage('bot', "Impossible de contacter le serveur. Vérifiez votre connexion.");
    }
    sendBtn.disabled = false;
    input.focus();
  });
})();
