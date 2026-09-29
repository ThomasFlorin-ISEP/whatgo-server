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
 *
 * Prise de rendez-vous : si l'entreprise a activé la réservation en ligne
 * dans son tableau de bord (page Rendez-vous), le widget propose tout seul
 * un bouton « Prendre rendez-vous » et affiche les vrais créneaux libres.
 * Rien à changer dans la ligne d'installation.
 *
 * E-commerce : si l'entreprise a un catalogue (page Catalogue du tableau de
 * bord), l'assistant affiche des fiches produits avec « Ajouter au panier ».
 * Pour que ce bouton remplisse le VRAI panier du site, le site peut définir :
 *   window.WHATGO_onAddToCart = function (item) { ... }   // item = { id, name, price, priceCents, variant, url, image }
 * Sans cette fonction, le bouton ouvre la page du produit (champ « Lien »).
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
  // Adresse du serveur déduite de data-server (".../api/chat" → "...").
  var API_BASE = SERVER_URL.replace(/\/api\/chat\/?$/, '');
  var BOOKING_URL = API_BASE + '/api/booking/' + encodeURIComponent(BUSINESS || '');
  var bookingServices = null; // null = réservation non activée pour cette entreprise
  var bookingLink = '';       // mode "lien" : page de réservation externe (Calendly…)
  var SHOP_URL = API_BASE + '/api/shop/' + encodeURIComponent(BUSINESS || '');
  var shopConfig = null; // { enabled, tracking } si l'entreprise a un catalogue

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

    /* ---------- Réservation ---------- */
    .wgt-quick { display: flex; flex-wrap: wrap; gap: 8px; padding-left: 40px; }
    .wgt-chip {
      border: 1.5px solid var(--wgt-color); color: var(--wgt-color); background: #fff; border-radius: 999px;
      padding: 8px 14px; font-size: .85rem; font-weight: 600; cursor: pointer; line-height: 1.2;
    }
    .wgt-chip:hover { background: var(--wgt-color); color: #fff; }
    .wgt-bk { align-self: stretch; margin-left: 40px; border: 1px solid #E3E7EC; border-radius: 16px; padding: 14px; background: #FAFBFC; }
    .wgt-bk h4 { margin: 0 0 10px; font-size: .88rem; font-weight: 700; color: #1B2321; }
    .wgt-bk-sel { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: .8rem; color: #5B6570; margin-bottom: 10px; }
    .wgt-bk-sel b { color: #1B2321; }
    .wgt-link { background: none; border: none; color: var(--wgt-color); font-weight: 600; font-size: .8rem; cursor: pointer; padding: 0; text-decoration: underline; }
    .wgt-svc { display: flex; justify-content: space-between; align-items: center; gap: 10px; width: 100%; text-align: left;
      border: 1px solid #E3E7EC; background: #fff; border-radius: 12px; padding: 10px 12px; margin-bottom: 7px; cursor: pointer; }
    .wgt-svc:hover { border-color: var(--wgt-color); }
    .wgt-svc b { font-size: .86rem; color: #1B2321; font-weight: 600; }
    .wgt-svc span { font-size: .76rem; color: #6B7580; white-space: nowrap; }
    .wgt-days { display: flex; gap: 7px; overflow-x: auto; padding-bottom: 6px; margin-bottom: 8px; scrollbar-width: thin; }
    .wgt-day { flex-shrink: 0; border: 1px solid #E3E7EC; background: #fff; border-radius: 12px; padding: 7px 10px; cursor: pointer;
      font-size: .76rem; color: #1B2321; text-align: center; line-height: 1.25; min-width: 64px; }
    .wgt-day small { display: block; color: #6B7580; font-size: .7rem; }
    .wgt-day.is-on { background: var(--wgt-color); border-color: var(--wgt-color); color: #fff; }
    .wgt-day.is-on small { color: rgba(255,255,255,.85); }
    .wgt-slots { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .wgt-slot { border: 1px solid #E3E7EC; background: #fff; border-radius: 10px; padding: 8px 0; font-size: .8rem; font-weight: 600; cursor: pointer; color: #1B2321; }
    .wgt-slot:hover { border-color: var(--wgt-color); color: var(--wgt-color); }
    .wgt-bk input { width: 100%; border: 1px solid #DDE2E7; border-radius: 10px; padding: 10px 12px; font-size: 16px; margin-bottom: 8px; background: #fff; color: #1B2321; }
    .wgt-bk input:focus { outline: 2px solid var(--wgt-color); outline-offset: -1px; }
    .wgt-cta { width: 100%; border: none; background: var(--wgt-color); color: #fff; border-radius: 12px; padding: 11px; font-size: .9rem; font-weight: 700; cursor: pointer; margin-top: 2px; }
    .wgt-cta:disabled { opacity: .5; cursor: default; }
    .wgt-bk-err { color: #B42318; font-size: .8rem; margin: 6px 0 0; }
    .wgt-bk-muted { color: #6B7580; font-size: .8rem; }
.wgt-bk-legal { color: #8A939C; font-size: .7rem; margin-top: 8px; line-height: 1.35; }

    /* ---------- Fiches produits ---------- */
    .wgt-prods { display: flex; gap: 10px; overflow-x: auto; padding: 2px 2px 8px 40px; scroll-snap-type: x mandatory; scrollbar-width: thin; flex-shrink: 0; }
    .wgt-prod { flex: 0 0 188px; scroll-snap-align: start; border: 1px solid #E3E7EC; border-radius: 16px; background: #fff; overflow: hidden; display: flex; flex-direction: column; }
    .wgt-prod img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block; background: #F3F5F7; }
    .wgt-prod-b { padding: 10px 11px 11px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
    .wgt-prod-n { font-size: .84rem; font-weight: 700; color: #1B2321; line-height: 1.25; }
    .wgt-prod-p { font-size: .86rem; font-weight: 700; color: var(--wgt-color); }
    .wgt-prod-out { font-size: .72rem; font-weight: 700; color: #B42318; }
    .wgt-prod select { width: 100%; border: 1px solid #DDE2E7; border-radius: 9px; padding: 6px 8px; font-size: 14px; background: #fff; color: #1B2321; }
    .wgt-prod .wgt-cta { font-size: .8rem; padding: 9px; margin-top: auto; }
    .wgt-prod .wgt-link { align-self: center; font-size: .76rem; }
    .wgt-added { font-size: .76rem; font-weight: 700; color: #1E7A46; text-align: center; }
    .wgt-order dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: .8rem; }
    .wgt-order dt { color: #6B7580; }
    .wgt-order dd { margin: 0; color: #1B2321; font-weight: 600; }
    .wgt-status { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: .74rem; font-weight: 700; background: #E7F5EC; color: #1E7A46; margin-bottom: 8px; }

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
  loadBookingConfig();
  loadShopConfig();

  var history = [];
  var welcomed = false;
  var welcomeShown = false; // message d'accueil réellement affiché
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

  // ------------------------------------------------------------
  // RÉSERVATION : services → jour → créneau → coordonnées → confirmé.
  // Les créneaux viennent toujours du serveur (agenda réel), jamais de l'IA.
  // ------------------------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function todayStr(offset) {
    var d = new Date();
    d.setDate(d.getDate() + (offset || 0));
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function dayDate(dateStr) { return new Date(dateStr + 'T12:00:00'); }
  function shortDay(dateStr) {
    if (dateStr === todayStr(0)) return "Aujourd'hui";
    if (dateStr === todayStr(1)) return 'Demain';
    var s = dayDate(dateStr).toLocaleDateString('fr-FR', { weekday: 'short' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function shortDate(dateStr) { return dayDate(dateStr).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); }
  function longLabel(dateStr, time) {
    var d = dayDate(dateStr).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    return d + ' à ' + time.replace(':', 'h');
  }
  function svcMeta(s) { return s.duration + ' min' + (s.price ? ' · ' + s.price : ''); }

  async function getJson(url) {
    var res = await fetch(url);
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur');
    return data;
  }

  function loadBookingConfig() {
    if (!BUSINESS) return;
    fetch(BOOKING_URL + '/config').then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.enabled && data.mode === 'link' && data.linkUrl) {
        bookingLink = data.linkUrl;
        bookingServices = data.services || [];
        if (welcomeShown) showQuickReplies();
      } else if (data && data.enabled && data.services && data.services.length) {
        bookingServices = data.services;
        // Si le message d'accueil est déjà affiché, on ajoute le bouton.
        if (welcomeShown) showQuickReplies();
      }
    }).catch(function () {});
  }

  function loadShopConfig() {
    if (!BUSINESS) return;
    fetch(SHOP_URL + '/config').then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.enabled) {
        shopConfig = data;
        if (welcomeShown) { removeQuickReplies(); showQuickReplies(); }
      }
    }).catch(function () {});
  }

  // Boutons rapides sous le message d'accueil, selon ce que l'entreprise
  // propose (réservation, boutique, suivi de commande).
  var quickRow = null;
  function showQuickReplies() {
    if (quickRow || hasInteracted) return;
    var chips = [];
    if (bookingServices) {
      chips.push(['📅 Prendre rendez-vous', function () {
        addMessage('user', 'Je souhaite prendre rendez-vous');
        history.push({ role: 'user', content: 'Je souhaite prendre rendez-vous' });
        addMessage('bot', bookingIntro());
        history.push({ role: 'assistant', content: bookingIntro() });
        startBooking();
      }]);
    }
    if (shopConfig) {
      chips.push(['🛍️ Trouver un produit', function () { sendText('Je cherche un produit, pouvez-vous me conseiller ?'); }]);
      if (shopConfig.tracking) {
        chips.push(['📦 Suivre ma commande', function () {
          addMessage('user', 'Je veux suivre ma commande');
          history.push({ role: 'user', content: 'Je veux suivre ma commande' });
          addMessage('bot', 'Bien sûr ! Indiquez votre numéro de commande et votre email :');
          history.push({ role: 'assistant', content: 'Bien sûr ! Indiquez votre numéro de commande et votre email :' });
          showOrderForm();
        }]);
      }
      chips.push(['🚚 Livraison & retours', function () { sendText('Quels sont vos délais de livraison et vos conditions de retour ?'); }]);
    }
    if (!chips.length) return;
    quickRow = el('div', 'wgt-quick');
    chips.forEach(function (c) {
      var b = el('button', 'wgt-chip', c[0]);
      b.type = 'button';
      b.addEventListener('click', function () { removeQuickReplies(); hasInteracted = true; c[1](); });
      quickRow.appendChild(b);
    });
    log.appendChild(quickRow);
    log.scrollTop = log.scrollHeight;
  }
  function removeQuickReplies() { if (quickRow) { quickRow.remove(); quickRow = null; } }

  var activeCard = null;
  function bookingIntro() {
    return bookingLink ? 'Avec plaisir ! Voici notre page de réservation :' : 'Avec plaisir ! Choisissez votre prestation :';
  }

  // Mode "lien" : une carte avec un bouton vers la page de réservation du client.
  function showBookingLink() {
    var card = el('div', 'wgt-bk');
    card.appendChild(el('h4', null, 'Réservez votre rendez-vous'));
    card.appendChild(el('p', 'wgt-bk-muted', 'Choisissez votre créneau en quelques clics sur notre page de réservation.'));
    var a = el('a', 'wgt-cta', '📅 Voir les disponibilités');
    a.href = bookingLink; a.target = '_blank'; a.rel = 'noopener';
    a.style.display = 'block'; a.style.textAlign = 'center'; a.style.textDecoration = 'none'; a.style.marginTop = '10px';
    a.addEventListener('click', function () {
      fetch(BOOKING_URL + '/click', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: conversationId }),
      }).catch(function () {});
      history.push({ role: 'user', content: '📅 A ouvert la page de réservation' });
    });
    card.appendChild(a);
    log.appendChild(card);
    scrollDown();
  }

  function startBooking() {
    if (!bookingServices) return;
    if (bookingLink) { showBookingLink(); return; }
    if (activeCard) activeCard.remove();
    activeCard = el('div', 'wgt-bk');
    log.appendChild(activeCard);
    renderServices(activeCard);
  }

  function scrollDown() { log.scrollTop = log.scrollHeight; }

  function renderServices(card) {
    card.innerHTML = '';
    card.appendChild(el('h4', null, 'Quelle prestation ?'));
    bookingServices.forEach(function (s) {
      var b = el('button', 'wgt-svc');
      b.type = 'button';
      b.appendChild(el('b', null, s.name));
      b.appendChild(el('span', null, svcMeta(s)));
      b.addEventListener('click', function () { renderDays(card, s); });
      card.appendChild(b);
    });
    scrollDown();
  }

  function selectionHeader(card, text, onChange) {
    var sel = el('div', 'wgt-bk-sel');
    var t = el('span');
    t.appendChild(el('b', null, text));
    sel.appendChild(t);
    var change = el('button', 'wgt-link', 'Modifier');
    change.type = 'button';
    change.addEventListener('click', onChange);
    sel.appendChild(change);
    card.appendChild(sel);
  }

  async function renderDays(card, service) {
    card.innerHTML = '';
    selectionHeader(card, service.name + ' · ' + svcMeta(service), function () { renderServices(card); });
    card.appendChild(el('h4', null, 'Quel jour ?'));
    var daysWrap = el('div', 'wgt-days');
    var slotsWrap = el('div');
    card.appendChild(daysWrap);
    card.appendChild(slotsWrap);
    daysWrap.appendChild(el('span', 'wgt-bk-muted', 'Chargement des disponibilités…'));
    scrollDown();
    try {
      var data = await getJson(BOOKING_URL + '/days?service=' + encodeURIComponent(service.id));
      daysWrap.innerHTML = '';
      if (!data.days.length) {
        daysWrap.appendChild(el('span', 'wgt-bk-muted', 'Aucun créneau disponible pour le moment. Laissez-nous votre numéro dans la discussion, nous vous rappelons.'));
        return;
      }
      data.days.forEach(function (d, idx) {
        var b = el('button', 'wgt-day');
        b.type = 'button';
        b.appendChild(document.createTextNode(shortDay(d.date)));
        b.appendChild(el('small', null, shortDate(d.date)));
        b.addEventListener('click', function () {
          Array.prototype.forEach.call(daysWrap.children, function (c) { c.classList.remove('is-on'); });
          b.classList.add('is-on');
          renderSlots(card, slotsWrap, service, d.date);
        });
        daysWrap.appendChild(b);
        if (idx === 0) b.click();
      });
    } catch (e) {
      daysWrap.innerHTML = '';
      daysWrap.appendChild(el('span', 'wgt-bk-err', 'Impossible de charger les disponibilités. Réessayez dans un instant.'));
    }
  }

  async function renderSlots(card, wrap, service, dateStr) {
    wrap.innerHTML = '';
    wrap.appendChild(el('span', 'wgt-bk-muted', 'Chargement…'));
    try {
      var data = await getJson(BOOKING_URL + '/slots?service=' + encodeURIComponent(service.id) + '&date=' + dateStr);
      wrap.innerHTML = '';
      if (!data.slots.length) { wrap.appendChild(el('span', 'wgt-bk-muted', 'Plus de créneau ce jour-là.')); return; }
      var grid = el('div', 'wgt-slots');
      data.slots.forEach(function (time) {
        var b = el('button', 'wgt-slot', time.replace(':', 'h'));
        b.type = 'button';
        b.addEventListener('click', function () { renderContact(card, service, dateStr, time); });
        grid.appendChild(b);
      });
      wrap.appendChild(grid);
      scrollDown();
    } catch (e) {
      wrap.innerHTML = '';
      wrap.appendChild(el('span', 'wgt-bk-err', 'Impossible de charger les créneaux.'));
    }
  }

  function renderContact(card, service, dateStr, time) {
    card.innerHTML = '';
    selectionHeader(card, service.name + ' — ' + longLabel(dateStr, time), function () { renderDays(card, service); });
    card.appendChild(el('h4', null, 'Vos coordonnées'));
    var name = el('input'); name.placeholder = 'Prénom et nom'; name.autocomplete = 'name';
    var phone = el('input'); phone.placeholder = 'Téléphone'; phone.type = 'tel'; phone.autocomplete = 'tel';
    var email = el('input'); email.placeholder = 'Email (facultatif, pour la confirmation)'; email.type = 'email'; email.autocomplete = 'email';
    var btn = el('button', 'wgt-cta', 'Confirmer le rendez-vous'); btn.type = 'button';
    var err = el('p', 'wgt-bk-err'); err.style.display = 'none';
    [name, phone, email, btn, err].forEach(function (n) { card.appendChild(n); });
    card.appendChild(el('p', 'wgt-bk-legal', 'Vos coordonnées servent uniquement à la gestion de ce rendez-vous par l\'établissement.'));
    scrollDown();
    setTimeout(function () { name.focus(); }, 50);

    btn.addEventListener('click', async function () {
      err.style.display = 'none';
      if (!name.value.trim()) { err.textContent = 'Merci d\'indiquer votre nom.'; err.style.display = 'block'; return; }
      if (phone.value.replace(/\D/g, '').length < 9) { err.textContent = 'Merci d\'indiquer un numéro de téléphone valide.'; err.style.display = 'block'; return; }
      btn.disabled = true; btn.textContent = 'Réservation…';
      try {
        var res = await fetch(BOOKING_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serviceId: service.id, date: dateStr, time: time,
            name: name.value.trim(), phone: phone.value.trim(), email: email.value.trim(),
            conversationId: conversationId,
          }),
        });
        var data = await res.json();
        if (!res.ok) {
          err.textContent = data.error || 'La réservation a échoué.'; err.style.display = 'block';
          btn.disabled = false; btn.textContent = 'Confirmer le rendez-vous';
          if (res.status === 409) setTimeout(function () { renderDays(card, service); }, 1800);
          return;
        }
        conversationId = data.conversationId;
        card.remove();
        activeCard = null;
        var userLine = 'Réservation : ' + service.name + ', ' + data.label;
        addMessage('user', userLine);
        history.push({ role: 'user', content: userLine });
        addMessage('bot', data.confirmation + (email.value.trim() ? '\nUn email de confirmation vous a été envoyé.' : ''));
        history.push({ role: 'assistant', content: data.confirmation });
      } catch (e) {
        err.textContent = 'Impossible de contacter le serveur.'; err.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Confirmer le rendez-vous';
      }
    });
  }

  // ------------------------------------------------------------
  // E-COMMERCE : fiches produits + suivi de commande
  // ------------------------------------------------------------
  function absUrl(u) { return u && u.charAt(0) === '/' ? API_BASE + u : u; }

  function trackShop(type, productId, variant) {
    fetch(SHOP_URL + '/event', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: type, productId: productId, variant: variant || '', conversationId: conversationId }),
    }).catch(function () {});
  }

  function showProducts(items) {
    var row = el('div', 'wgt-prods');
    items.forEach(function (p) {
      var card = el('div', 'wgt-prod');
      if (p.image) { var img = el('img'); img.src = absUrl(p.image); img.alt = p.name; img.loading = 'lazy'; card.appendChild(img); }
      var body = el('div', 'wgt-prod-b');
      body.appendChild(el('div', 'wgt-prod-n', p.name));
      body.appendChild(el('div', 'wgt-prod-p', p.price));
      var select = null;
      if (p.variants && p.variants.length) {
        select = el('select');
        select.setAttribute('aria-label', 'Option');
        p.variants.forEach(function (v) { var o = el('option', null, v); o.value = v; select.appendChild(o); });
        body.appendChild(select);
      }
      if (!p.inStock) {
        body.appendChild(el('div', 'wgt-prod-out', 'Bientôt de retour'));
      } else {
        var add = el('button', 'wgt-cta', 'Ajouter au panier');
        add.type = 'button';
        add.addEventListener('click', function () {
          var variant = select ? select.value : '';
          var item = { id: p.id, name: p.name, price: p.price, priceCents: p.priceCents, variant: variant, url: absUrl(p.url), image: absUrl(p.image) };
          trackShop('add_to_cart', p.id, variant);
          var handled = false;
          if (typeof window.WHATGO_onAddToCart === 'function') {
            try { handled = window.WHATGO_onAddToCart(item) !== false; } catch (e) { handled = false; }
          }
          if (!handled && item.url) window.open(item.url, '_blank');
          add.replaceWith(el('div', 'wgt-added', handled ? '✓ Ajouté au panier' : '✓ Ouvert dans un nouvel onglet'));
          var line = '🛒 Ajouté au panier : ' + p.name + (variant ? ' (' + variant + ')' : '');
          history.push({ role: 'user', content: line });
        });
        body.appendChild(add);
      }
      if (p.url) {
        var view = el('a', 'wgt-link', 'Voir le produit');
        view.href = absUrl(p.url); view.target = '_blank'; view.rel = 'noopener';
        view.addEventListener('click', function () { trackShop('view_product', p.id); });
        body.appendChild(view);
      }
      card.appendChild(body);
      row.appendChild(card);
    });
    log.appendChild(row);
    scrollDown();
  }

  function showOrderForm() {
    var card = el('div', 'wgt-bk wgt-order');
    card.appendChild(el('h4', null, 'Suivi de commande'));
    var num = el('input'); num.placeholder = 'Numéro de commande (ex : 1042)'; num.inputMode = 'numeric';
    var mail = el('input'); mail.placeholder = 'Email utilisé pour la commande'; mail.type = 'email'; mail.autocomplete = 'email';
    var btn = el('button', 'wgt-cta', 'Voir ma commande'); btn.type = 'button';
    var err = el('p', 'wgt-bk-err'); err.style.display = 'none';
    [num, mail, btn, err].forEach(function (n) { card.appendChild(n); });
    log.appendChild(card);
    scrollDown();
    setTimeout(function () { num.focus(); }, 50);

    btn.addEventListener('click', async function () {
      err.style.display = 'none';
      if (!num.value.trim() || mail.value.indexOf('@') < 1) { err.textContent = 'Indiquez le numéro de commande et votre email.'; err.style.display = 'block'; return; }
      btn.disabled = true; btn.textContent = 'Recherche…';
      try {
        var res = await fetch(SHOP_URL + '/order-status', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ number: num.value.trim(), email: mail.value.trim(), conversationId: conversationId }),
        });
        var data = await res.json();
        if (!res.ok) { err.textContent = data.error || 'Commande introuvable.'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Voir ma commande'; return; }
        card.innerHTML = '';
        card.appendChild(el('h4', null, 'Commande n°' + data.number));
        card.appendChild(el('span', 'wgt-status', data.statusLabel));
        var dl = el('dl');
        [['Livraison', data.eta], ['Transporteur', data.carrier], ['Articles', data.items], ['Total', data.total]].forEach(function (r) {
          if (!r[1]) return;
          dl.appendChild(el('dt', null, r[0])); dl.appendChild(el('dd', null, r[1]));
        });
        card.appendChild(dl);
        if (data.trackingUrl) {
          var a = el('a', 'wgt-cta', 'Suivre le colis');
          a.href = data.trackingUrl; a.target = '_blank'; a.rel = 'noopener';
          a.style.display = 'block'; a.style.textAlign = 'center'; a.style.textDecoration = 'none'; a.style.marginTop = '10px';
          card.appendChild(a);
        }
        var summary = 'Commande n°' + data.number + ' : ' + data.statusLabel + (data.eta ? ' — ' + data.eta : '');
        history.push({ role: 'assistant', content: summary });
        scrollDown();
      } catch (e) {
        err.textContent = 'Impossible de contacter le serveur.'; err.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Voir ma commande';
      }
    });
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
      welcomeShown = true;
      showQuickReplies();
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

  // Petite API pour le site du client : un bouton « Réserver » de sa page
  // peut ouvrir directement le parcours de réservation du widget.
  //   <button onclick="WHATGO.book()">Réserver</button>
  window.WHATGO = {
    open: function () { openPanel(true); },
    book: function () {
      openPanel(false);
      if (!bookingServices) return;
      removeQuickReplies();
      hasInteracted = true;
      setTimeout(function () {
        if (!activeCard) {
          addMessage('bot', bookingIntro());
          history.push({ role: 'assistant', content: bookingIntro() });
        }
        startBooking();
      }, welcomeShown ? 0 : 1000);
    },
  };

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

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendText(text);
  });

  async function sendText(text) {
    sendBtn.disabled = true;
    hasInteracted = true;
    removeQuickReplies();

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
        // Le serveur demande d'afficher un module : réservation, fiches
        // produits ou suivi de commande.
        if (data.ui && data.ui.type === 'booking' && bookingServices) startBooking();
        if (data.ui && data.ui.type === 'products' && data.ui.items && data.ui.items.length) showProducts(data.ui.items);
        if (data.ui && data.ui.type === 'order') showOrderForm();
      }
    } catch (err) {
      typing.remove();
      addMessage('bot', "Impossible de contacter le serveur. Vérifiez votre connexion.");
    }
    sendBtn.disabled = false;
    input.focus();
  }
})();
