/**
 * ============================================================
 * WIDGET DE CHAT WHATGO — à coller sur n'importe quel site
 * ============================================================
 *   <script
 *     src="https://whatgo-server.onrender.com/widget.js"
 *     data-server="https://whatgo-server.onrender.com/api/chat"
 *     data-business="whatgo"
 *     data-name="WHATGO Assistant"
 *   ></script>
 *
 * Options facultatives (toutes ont une valeur par défaut) :
 *   data-color="#B5122B"          couleur principale (bouton, en-tête, messages du visiteur)
 *   data-subtitle="Votre conseiller"   petite ligne sous le nom
 *   data-welcome="Bonjour et bienvenue chez WHATGO, puis-je vous renseigner ?"
 *   data-avatar="https://.../photo.jpg"   photo du conseiller (sinon pastille "AI")
 *   data-position="right"         "right" (défaut) ou "left"
 *   data-autoopen="true"          ouvre la fenêtre toute seule ("false" pour désactiver)
 *   data-delay="1500"             délai avant l'ouverture automatique, en millisecondes
 *   data-nudge="true"             relance automatique si le visiteur n'a jamais écrit ("false" pour désactiver)
 *   data-nudge-delay="180000"     délai avant la relance, en millisecondes (3 min par défaut)
 *   data-nudge-message="Vous avez besoin d'un renseignement ?"   message affiché lors de la relance
 * ============================================================
 */
(function () {
  var scriptTag = document.currentScript;

  function attr(name, fallback) {
    var v = scriptTag && scriptTag.getAttribute('data-' + name);
    return v ? v : fallback;
  }

  var SERVER_URL = attr('server', '/api/chat');
  var BOT_NAME = attr('name', 'Assistant');
  var SUBTITLE = attr('subtitle', 'Répond en quelques secondes');
  var WELCOME = attr('welcome', 'Bonjour et bienvenue, puis-je vous renseigner ?');
  var AVATAR = attr('avatar', '');
  var COLOR = attr('color', '#B5122B');
  var POSITION = attr('position', 'right');
  var AUTO_OPEN = attr('autoopen', 'true') !== 'false';
  var AUTO_DELAY = parseInt(attr('delay', '1500'), 10) || 1500;
  var NUDGE_ENABLED = attr('nudge', 'true') !== 'false';
  var NUDGE_DELAY = parseInt(attr('nudge-delay', '180000'), 10) || 180000;
  var NUDGE_MESSAGE = attr('nudge-message', "Vous avez besoin d'un renseignement ?");
  var BUSINESS = scriptTag ? scriptTag.getAttribute('data-business') : null;
  var conversationId = null;

  var style = document.createElement('style');
  style.textContent = `
    .wgt-root, .wgt-root * { box-sizing: border-box; font-family: 'Inter', -apple-system, 'Segoe UI', sans-serif; }

    .wgt-bubble {
      position: fixed; bottom: 22px; right: 22px; width: 58px; height: 58px;
      border-radius: 50%; background: var(--wgt-color); color: #fff; border: none;
      cursor: pointer; box-shadow: 0 10px 30px rgba(0,0,0,.25); z-index: 999998;
      display: flex; align-items: center; justify-content: center; transition: transform .15s;
    }
    .wgt-bubble:hover { transform: scale(1.06); }
    .wgt-bubble svg { width: 26px; height: 26px; }
    .wgt-left .wgt-bubble { right: auto; left: 22px; }

    .wgt-panel {
      position: fixed; bottom: 92px; right: 22px; width: 360px; max-width: calc(100vw - 32px);
      height: 520px; max-height: calc(100vh - 120px); background: #fff; border-radius: 22px 22px 16px 16px;
      box-shadow: 0 24px 60px rgba(0,0,0,.28); display: none; flex-direction: column;
      overflow: hidden; z-index: 999999;
    }
    .wgt-left .wgt-panel { right: auto; left: 22px; }
    .wgt-panel.wgt-open { display: flex; animation: wgt-in .25s ease-out; }
    @keyframes wgt-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }

    .wgt-head {
      background: var(--wgt-color); color: #fff; padding: 14px 16px; display: flex;
      align-items: center; gap: 12px; flex-shrink: 0;
    }
    .wgt-av {
      width: 42px; height: 42px; border-radius: 50%; background: rgba(255,255,255,.22); color: #fff;
      font-weight: 700; font-size: .85rem; display: flex; align-items: center; justify-content: center;
      overflow: hidden; flex-shrink: 0;
    }
    .wgt-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .wgt-head-txt b { font-size: 1rem; font-weight: 700; display: block; }
    .wgt-head-txt span { font-size: .8rem; opacity: .85; }
    .wgt-close {
      margin-left: auto; background: none; border: none; color: #fff; cursor: pointer;
      opacity: .85; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
    }
    .wgt-close:hover { opacity: 1; }

    .wgt-log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; background: #fff; }
    .wgt-row { display: flex; align-items: flex-end; gap: 8px; max-width: 90%; align-self: flex-start; }
    .wgt-row .wgt-av { width: 32px; height: 32px; font-size: .65rem; background: var(--wgt-color); }
    .wgt-col { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .wgt-msg { padding: 10px 14px; border-radius: 16px; font-size: .9rem; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
    .wgt-msg.bot { background: #EEF1F5; color: #1B2321; border-bottom-left-radius: 6px; }
    .wgt-msg.user { background: var(--wgt-color); color: #fff; align-self: flex-end; max-width: 82%; border-bottom-right-radius: 6px; }
    .wgt-meta { font-size: .7rem; color: #9AA3AD; padding-left: 4px; }

    .wgt-typing { align-self: flex-start; display: flex; gap: 4px; padding: 12px 14px; background: #EEF1F5; border-radius: 16px; }
    .wgt-typing i { width: 6px; height: 6px; border-radius: 50%; background: #8A9089; animation: wgt-b 1s infinite ease-in-out; }
    .wgt-typing i:nth-child(2) { animation-delay: .15s; } .wgt-typing i:nth-child(3) { animation-delay: .3s; }
    @keyframes wgt-b { 0%,60%,100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-3px); opacity: 1; } }

    .wgt-powered { text-align: center; font-size: .68rem; color: #B0B7BF; padding: 4px 0 2px; background: #fff; flex-shrink: 0; }
    .wgt-powered b { font-weight: 700; color: #9AA3AD; }

    .wgt-form { display: flex; align-items: center; gap: 8px; padding: 8px 14px 14px; background: #fff; flex-shrink: 0; }
    .wgt-form input {
      flex: 1; min-width: 0; border: none; outline: none; font-size: 16px; padding: 12px 16px;
      border-radius: 999px; background: #EEF1F5; font-family: inherit; color: #1B2321;
    }
    .wgt-send {
      border: none; background: var(--wgt-color); color: #fff; width: 40px; height: 40px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0;
    }
    .wgt-send:disabled { opacity: .4; cursor: default; }

    @media (max-width: 480px) {
      .wgt-root .wgt-panel { left: 16px; right: 16px; width: auto; }
    }
  `;
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.className = 'wgt-root';
  root.style.setProperty('--wgt-color', COLOR);
  if (POSITION === 'left') root.classList.add('wgt-left');
  root.innerHTML = `
    <button class="wgt-bubble" aria-label="Ouvrir le chat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
    </button>
    <div class="wgt-panel">
      <div class="wgt-head">
        <div class="wgt-head-txt"><b class="wgt-name"></b><span class="wgt-sub"></span></div>
        <button class="wgt-close" aria-label="Réduire">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg>
        </button>
      </div>
      <div class="wgt-log"></div>
      <div class="wgt-powered">Propulsé par <b>WHATGO</b></div>
      <form class="wgt-form">
        <input type="text" placeholder="Tapez votre message ici…" autocomplete="off" />
        <button type="submit" class="wgt-send" aria-label="Envoyer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="17" height="17"><path d="m22 2-7 20-4-9-9-4Z"/></svg>
        </button>
      </form>
    </div>
  `;
  document.body.appendChild(root);

  var bubble = root.querySelector('.wgt-bubble');
  var panel = root.querySelector('.wgt-panel');
  var head = root.querySelector('.wgt-head');
  var closeBtn = root.querySelector('.wgt-close');
  var log = root.querySelector('.wgt-log');
  var form = root.querySelector('.wgt-form');
  var input = root.querySelector('input');
  var sendBtn = root.querySelector('.wgt-send');

  root.querySelector('.wgt-name').textContent = BOT_NAME;
  root.querySelector('.wgt-sub').textContent = SUBTITLE;

  function makeAvatar() {
    var av = document.createElement('div');
    av.className = 'wgt-av';
    if (AVATAR) {
      var img = document.createElement('img');
      img.src = AVATAR;
      img.alt = '';
      av.appendChild(img);
    } else {
      av.textContent = 'AI';
    }
    return av;
  }
  head.insertBefore(makeAvatar(), head.firstChild);

  var history = [];
  var welcomed = false;
  var hasInteracted = false; // true dès que le visiteur envoie un premier message

  function nowStr() {
    try {
      return new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  function addMessage(role, text) {
    if (role === 'user') {
      var u = document.createElement('div');
      u.className = 'wgt-msg user';
      u.textContent = text;
      log.appendChild(u);
    } else {
      var row = document.createElement('div');
      row.className = 'wgt-row';
      row.appendChild(makeAvatar());
      var col = document.createElement('div');
      col.className = 'wgt-col';
      var m = document.createElement('div');
      m.className = 'wgt-msg bot';
      m.textContent = text;
      var meta = document.createElement('div');
      meta.className = 'wgt-meta';
      meta.textContent = BOT_NAME + ' • ' + nowStr();
      col.appendChild(m);
      col.appendChild(meta);
      row.appendChild(col);
      log.appendChild(row);
    }
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

  // --- Mémoire "déjà ouvert pendant cette visite" (pour ne pas rouvrir la fenêtre à chaque page) ---
  function alreadySeen() {
    try { return sessionStorage.getItem('wgt-seen') === '1'; } catch (e) { return false; }
  }
  function markSeen() {
    try { sessionStorage.setItem('wgt-seen', '1'); } catch (e) {}
  }

  // --- Mémoire "déjà relancé pendant cette visite" (une seule relance par visite) ---
  function alreadyNudged() {
    try { return sessionStorage.getItem('wgt-nudged') === '1'; } catch (e) { return false; }
  }
  function markNudged() {
    try { sessionStorage.setItem('wgt-nudged', '1'); } catch (e) {}
  }

  function showWelcome() {
    if (welcomed) return;
    welcomed = true;
    var t = showTyping();
    setTimeout(function () {
      t.remove();
      addMessage('bot', WELCOME);
    }, 900);
  }

  function openPanel(byUser) {
    panel.classList.add('wgt-open');
    markSeen();
    showWelcome();
    if (byUser) setTimeout(function () { input.focus(); }, 50);
  }

  function closePanel() {
    panel.classList.remove('wgt-open');
    markSeen();
  }

  // Relance : ré-ouvre la fenêtre avec un message proactif, comme à
  // l'arrivée sur le site, mais plus tard dans la visite — uniquement si
  // le visiteur n'a jamais écrit et n'a pas déjà été relancé cette visite.
  function showNudge() {
    panel.classList.add('wgt-open');
    markSeen();
    var t = showTyping();
    setTimeout(function () {
      t.remove();
      addMessage('bot', NUDGE_MESSAGE);
    }, 900);
  }

  bubble.addEventListener('click', function () {
    if (panel.classList.contains('wgt-open')) closePanel();
    else openPanel(true);
  });
  closeBtn.addEventListener('click', closePanel);

  // --- Ouverture automatique à l'arrivée sur la page (ordinateur et mobile, une fois par visite) ---
  if (AUTO_OPEN && !alreadySeen()) {
    setTimeout(function () {
      if (!alreadySeen() && !panel.classList.contains('wgt-open')) openPanel(false);
    }, AUTO_DELAY);
  }

  // --- Relance après un moment sur le site (3 min par défaut) si le visiteur
  // n'a jamais écrit et n'a pas fermé la fenêtre sur un vrai échange. Une
  // seule relance par visite, jamais si le visiteur discute déjà. ---
  if (NUDGE_ENABLED) {
    setTimeout(function () {
      if (hasInteracted || alreadyNudged()) return;
      if (panel.classList.contains('wgt-open')) return; // déjà en train de regarder le chat
      markNudged();
      showNudge();
    }, NUDGE_DELAY);
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtn.disabled = true;
    hasInteracted = true;

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
