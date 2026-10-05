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
 *   data-avatar="https://.../photo.jpg"   photo du conseiller (sinon petit personnage illustré)
 *   data-position="right"         "right" (défaut), "left" ou "center" — le visiteur peut aussi le changer dans le menu « … "
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
  var hotelEnabled = false; // hôtel : recherche de séjour + chambres
  var HOTEL_URL = API_BASE + '/api/hotel/' + encodeURIComponent(BUSINESS || '');

  var style = document.createElement('style');
  // Polices hébergées sur notre serveur (pas de Google Fonts : rapide et
  // sans transfert d'adresse IP des visiteurs). Licence OFL dans /fonts.
  style.textContent = `
    @font-face { font-family: 'WG Figtree'; src: url('${API_BASE}/fonts/figtree.woff') format('woff'); font-weight: 300 900; font-display: swap; }
    @font-face { font-family: 'WG Serif'; src: url('${API_BASE}/fonts/sourceserif4.woff') format('woff'); font-weight: 400 700; font-display: swap; }
    .wgt-root, .wgt-root * { box-sizing: border-box; font-family: 'WG Figtree', -apple-system, 'Segoe UI', sans-serif; }
    .wgt-root .wgt-name, .wgt-root .wgt-hero b { font-family: 'WG Serif', Georgia, serif; font-weight: 600; letter-spacing: -.005em; }
    .wgt-root .wgt-name { font-size: 1.2rem; line-height: 1.15; }

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
    .wgt-center .wgt-bubble { right: auto; left: calc(50% - 29px); }
    .wgt-center .wgt-panel { right: auto; left: max(16px, calc(50% - 180px)); }
    .wgt-center .wgt-panel.wgt-expanded { left: max(16px, calc(50% - 280px)); }
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
    .wgt-av img { width: 100%; height: 100%; object-fit: cover; object-position: center 30%; display: block; }
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
    .wgt-msg.bot { white-space: normal; }
    .wgt-msg.bot p { margin: 0 0 8px; } .wgt-msg.bot p:last-child { margin-bottom: 0; }
    .wgt-msg.bot ul, .wgt-msg.bot ol { margin: 4px 0 8px; padding-left: 20px; } .wgt-msg.bot li { margin: 2px 0; }
    .wgt-msg.bot ul:last-child, .wgt-msg.bot ol:last-child { margin-bottom: 0; }
    .wgt-msg.bot strong { font-weight: 700; }
    .wgt-msg.bot a { color: var(--wgt-color); text-decoration: underline; font-weight: 600; word-break: break-word; }
    .wgt-msg.bot { background: #EEF1F5; color: #1B2321; border-bottom-left-radius: 6px; }
    .wgt-msg.user { background: var(--wgt-color); color: #fff; align-self: flex-end; max-width: 82%; border-bottom-right-radius: 6px; }
    .wgt-meta { font-size: .7rem; color: #9AA3AD; padding-left: 4px; }

    .wgt-typing-row { align-self: flex-start; display: flex; flex-direction: column; gap: 4px; padding-left: 40px; }
    .wgt-typing-row small { font-size: .7rem; color: #9AA3AD; padding-left: 4px; }
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
.wgt-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .wgt-lbl { display: block; font-size: .72rem; font-weight: 600; color: #6B7580; margin: 0 0 3px 2px; }
    .wgt-bk select.wgt-sel { width: 100%; border: 1px solid #DDE2E7; border-radius: 10px; padding: 10px 12px; font-size: 16px; margin-bottom: 8px; background: #fff; color: #1B2321; }
    .wgt-prod-cap { font-size: .74rem; color: #6B7580; }
    .wgt-prod-tot { font-size: .74rem; color: #1B2321; font-weight: 600; }
    .wgt-status { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: .74rem; font-weight: 700; background: #E7F5EC; color: #1E7A46; margin-bottom: 8px; }

    /* ---------- En-tête : avatar, pastille « en ligne », menu … ---------- */
    .wgt-av-wrap { position: relative; flex-shrink: 0; }
    .wgt-av.wgt-av-svg { background: #fff; }
    .wgt-av.wgt-av-svg svg { width: 100%; height: 100%; display: block; }
    .wgt-row .wgt-av.wgt-av-svg { background: #fff; box-shadow: 0 0 0 1px #E3E7EC; }
    .wgt-dot { position: absolute; right: 0; bottom: 1px; width: 12px; height: 12px; border-radius: 50%;
      background: #22C55E; border: 2px solid #fff; }
    .wgt-dot::after { content: ''; position: absolute; inset: -2px; border-radius: 50%; border: 2px solid #22C55E; opacity: .6; animation: wgt-pulse 2s infinite; }
    @keyframes wgt-pulse { 0% { transform: scale(1); opacity: .6; } 100% { transform: scale(1.9); opacity: 0; } }
    .wgt-head-txt { min-width: 0; }
    .wgt-title { display: flex; align-items: center; gap: 7px; }
    .wgt-title b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wgt-ia { font-size: .62rem; font-weight: 800; letter-spacing: .04em; background: rgba(255,255,255,.22); border-radius: 999px; padding: 2px 7px; flex-shrink: 0; }
    .wgt-head-txt .wgt-sub { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wgt-head-btns { margin-left: auto; display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
    .wgt-head-btns .wgt-close { margin-left: 0; }
    .wgt-more { background: none; border: none; color: #fff; cursor: pointer; opacity: .85; width: 30px; height: 30px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center; }
    .wgt-more:hover, .wgt-more[aria-expanded="true"] { opacity: 1; background: rgba(255,255,255,.16); }
    .wgt-menu { position: absolute; top: 62px; right: 12px; z-index: 5; background: #fff; border-radius: 14px; min-width: 232px; padding: 6px;
      box-shadow: 0 16px 40px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.04); animation: wgt-in .15s ease-out; }
    .wgt-menu[hidden] { display: none; }
    .wgt-menu button { display: flex; align-items: center; gap: 10px; width: 100%; background: none; border: none; border-radius: 9px;
      padding: 9px 10px; font-size: .86rem; color: #1B2321; cursor: pointer; text-align: left; }
    .wgt-menu button:hover { background: #F2F4F7; }
    .wgt-menu button svg { width: 17px; height: 17px; flex-shrink: 0; color: #5B6570; }
    .wgt-menu .wgt-grow { flex: 1; }
    .wgt-check { color: var(--wgt-color); font-weight: 800; visibility: hidden; }
    .wgt-menu .is-on .wgt-check { visibility: visible; }
    .wgt-switch { width: 30px; height: 18px; border-radius: 999px; background: #CBD2D9; position: relative; flex-shrink: 0; transition: background .15s; }
    .wgt-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
    .wgt-menu .is-on .wgt-switch { background: var(--wgt-color); }
    .wgt-menu .is-on .wgt-switch::after { transform: translateX(12px); }
    .wgt-menu { min-width: 272px; }
    .wgt-pos-row { display: flex; align-items: center; gap: 10px; padding: 7px 10px; font-size: .86rem; color: #1B2321; }
    .wgt-pos-row svg { width: 17px; height: 17px; flex-shrink: 0; color: #5B6570; }
    .wgt-seg { display: flex; background: #EEF1F5; border-radius: 8px; padding: 2px; gap: 2px; }
    .wgt-menu .wgt-seg button { width: auto; padding: 4px 8px; font-size: .74rem; font-weight: 600; color: #5B6570; border-radius: 6px; }
    .wgt-menu .wgt-seg button:hover { background: #fff; }
    .wgt-menu .wgt-seg button.is-on { background: #fff; color: var(--wgt-color); box-shadow: 0 1px 3px rgba(0,0,0,.12); }
    .wgt-sep { height: 1px; background: #EEF1F5; margin: 4px 6px; }
    .wgt-panel.wgt-expanded { width: 560px; height: calc(100vh - 120px); max-height: 820px; }
    .wgt-bk textarea { width: 100%; border: 1px solid #DDE2E7; border-radius: 10px; padding: 10px 12px; font-size: 16px; margin-bottom: 8px;
      background: #fff; color: #1B2321; font-family: inherit; resize: vertical; }

    /* ---------- Boutons d'action toujours visibles au-dessus du champ ---------- */
    .wgt-actions { display: flex; gap: 6px; overflow-x: auto; padding: 8px 14px 2px; background: #fff; flex-shrink: 0; scrollbar-width: none; }
    .wgt-actions::-webkit-scrollbar { display: none; }
    .wgt-actions[hidden] { display: none; }
    .wgt-actions .wgt-chip { flex-shrink: 0; white-space: nowrap; font-size: .76rem; padding: 6px 11px; border-width: 1px; }
    @media (hover: none) { .wgt-chip:hover { background: #fff; color: var(--wgt-color); } }

    /* ---------- 👍 / 👎 sous les réponses ---------- */
    .wgt-metarow { display: flex; align-items: center; gap: 8px; }
    .wgt-fb { display: inline-flex; gap: 2px; opacity: .7; transition: opacity .15s; }
    .wgt-row:hover .wgt-fb, .wgt-fb.has-vote { opacity: 1; }
    .wgt-fb button { background: none; border: none; cursor: pointer; padding: 2px 3px; border-radius: 6px; color: #A7AFB8; line-height: 0; }
    .wgt-fb button:hover { color: #5B6570; background: #F2F4F7; }
    .wgt-fb button.is-on { color: var(--wgt-color); }
    .wgt-fb svg { width: 14px; height: 14px; }

    /* ---------- Micro ---------- */
    .wgt-mic { border: none; background: #EEF1F5; color: #5B6570; width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background .15s, color .15s; }
    .wgt-mic[hidden] { display: none; }
    .wgt-mic:hover { color: var(--wgt-color); }
    .wgt-mic.is-rec { background: #E5383B; color: #fff; animation: wgt-recpulse 1.4s infinite; }
    .wgt-mic.is-busy { opacity: .5; cursor: default; }
    @keyframes wgt-recpulse { 0% { box-shadow: 0 0 0 0 rgba(229,56,59,.45); } 100% { box-shadow: 0 0 0 10px rgba(229,56,59,0); } }

    /* ---------- Questions de suite sous une réponse ---------- */
    .wgt-follow { display: flex; flex-wrap: wrap; gap: 6px; padding-left: 40px; margin-top: -4px; }
    .wgt-follow .wgt-chip { font-size: .78rem; padding: 6px 11px; border-width: 1px; }

    /* ---------- Pastille « messages non lus » sur la bulle ---------- */
    .wgt-badge { position: absolute; top: -3px; right: -3px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 999px;
      background: #E5383B; color: #fff; font-size: .72rem; font-weight: 800; display: flex; align-items: center; justify-content: center;
      border: 2px solid #fff; animation: wgt-pop .3s ease-out; }
    .wgt-badge[hidden] { display: none; }
    @keyframes wgt-pop { from { transform: scale(0); } to { transform: scale(1); } }

    /* ---------- Écran d'accueil ---------- */
    .wgt-hero { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 10px 0 6px; gap: 4px; }
    .wgt-hero .wgt-av-wrap .wgt-av { width: 72px; height: 72px; }
    .wgt-hero .wgt-dot { width: 15px; height: 15px; right: 2px; bottom: 3px; }
    .wgt-hero b { font-size: 1.75rem; line-height: 1.1; color: #1B2321; margin-top: 6px; }
    .wgt-hero span { font-size: .78rem; color: #6B7580; }
    .wgt-cards { display: flex; flex-direction: column; gap: 7px; padding-left: 40px; }
    .wgt-card { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; text-align: left; cursor: pointer;
      background: #fff; border: 1px solid #E3E7EC; border-radius: 14px; padding: 11px 14px; font-size: .86rem; font-weight: 600; color: #1B2321;
      box-shadow: 0 1px 2px rgba(0,0,0,.04); transition: border-color .15s, transform .15s; }
    .wgt-card:hover { border-color: var(--wgt-color); transform: translateY(-1px); }
    .wgt-card i { font-style: normal; color: var(--wgt-color); font-size: 1.1rem; line-height: 1; }

    @media (max-width: 480px) {
      .wgt-root .wgt-panel { left: 16px; right: 16px; width: auto; }
      .wgt-root.wgt-center .wgt-panel { left: 16px; }
      /* Téléphone : plein écran, le champ de saisie reste au-dessus du clavier. */
      .wgt-root .wgt-panel.wgt-open, .wgt-root .wgt-panel.wgt-open.wgt-expanded {
        top: 0; left: 0; right: 0; bottom: auto; width: 100%; max-width: none; height: 100vh; height: 100dvh; max-height: none; border-radius: 0; }
      .wgt-root.wgt-is-open .wgt-bubble { display: none; }
      .wgt-head { padding-top: max(14px, env(safe-area-inset-top)); }
      .wgt-form { padding-bottom: max(14px, env(safe-area-inset-bottom)); }
      html.wgt-lock, html.wgt-lock body { overflow: hidden; }
    }
  `;
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.className = 'wgt-root';
  root.style.setProperty('--wgt-color', COLOR);
  // Position : choix du visiteur (menu « … ») s'il en a fait un, sinon celle du site.
  var currentPos = POSITION === 'left' || POSITION === 'center' ? POSITION : 'right';
  try {
    var savedPos = localStorage.getItem('wgt-pos');
    if (savedPos === 'left' || savedPos === 'center' || savedPos === 'right') currentPos = savedPos;
  } catch (e) {}
  function applyPosition(pos) {
    currentPos = pos;
    root.classList.toggle('wgt-left', pos === 'left');
    root.classList.toggle('wgt-center', pos === 'center');
  }
  applyPosition(currentPos);
  root.innerHTML = `
    <button class="wgt-bubble" aria-label="Ouvrir le chat"><span class="wgt-badge" hidden></span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
    </button>
    <div class="wgt-panel">
      <div class="wgt-head">
        <div class="wgt-head-txt"><div class="wgt-title"><b class="wgt-name"></b><span class="wgt-ia">IA</span></div><span class="wgt-sub"></span></div>
        <div class="wgt-head-btns">
          <button class="wgt-more" type="button" aria-label="Options" aria-haspopup="true" aria-expanded="false">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
          </button>
          <button class="wgt-close" aria-label="Réduire">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg>
          </button>
        </div>
      </div>
      <div class="wgt-menu" role="menu" hidden>
        <button type="button" role="menuitem" data-act="new"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span class="wgt-grow">Nouvelle conversation</span></button>
        <button type="button" role="menuitem" data-act="expand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg><span class="wgt-grow">Mode agrandi</span><span class="wgt-check">✓</span></button>
        <button type="button" role="menuitem" data-act="sound"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg><span class="wgt-grow">Son des réponses</span><span class="wgt-switch"></span></button>
        <div class="wgt-pos-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M13 15h5"/></svg><span class="wgt-grow">Position</span>
          <div class="wgt-seg"><button type="button" data-act="pos" data-pos="left">Gauche</button><button type="button" data-act="pos" data-pos="center">Centre</button><button type="button" data-act="pos" data-pos="right">Droite</button></div>
        </div>
        <div class="wgt-sep"></div>
        <button type="button" role="menuitem" data-act="human"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg><span class="wgt-grow">Parler à un humain</span></button>
      </div>
      <div class="wgt-log"></div>
      <div class="wgt-actions" hidden></div>
      <div class="wgt-powered">Propulsé par <b>WHATGO</b></div>
      <form class="wgt-form">
        <input type="text" placeholder="Tapez votre message ici…" autocomplete="off" />
        <button type="button" class="wgt-mic" aria-label="Dicter un message" title="Dicter un message" hidden>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
        </button>
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
  root.querySelector('.wgt-sub').textContent = 'En ligne · ' + SUBTITLE;
  var moreBtn = root.querySelector('.wgt-more');
  var menu = root.querySelector('.wgt-menu');
  var actionsBar = root.querySelector('.wgt-actions');

  // Petit personnage illustré (couleur de la marque) quand aucune photo
  // n'est fournie via data-avatar.
  var SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,\s%]+\))$/.test(COLOR) ? COLOR : '#1FAA59';
  var AVATAR_SVG = '<svg viewBox="0 0 40 40" aria-hidden="true">' +
    '<circle cx="20" cy="20" r="20" fill="#fff"/>' +
    '<path d="M20 6.5v4" stroke="' + SAFE_COLOR + '" stroke-width="2" stroke-linecap="round"/>' +
    '<circle cx="20" cy="5.8" r="2.2" fill="' + SAFE_COLOR + '"/>' +
    '<rect x="8" y="10.5" width="24" height="20" rx="9" fill="' + SAFE_COLOR + '" opacity=".14"/>' +
    '<ellipse cx="15" cy="19" rx="2.3" ry="2.8" fill="' + SAFE_COLOR + '"/>' +
    '<ellipse cx="25" cy="19" rx="2.3" ry="2.8" fill="' + SAFE_COLOR + '"/>' +
    '<circle cx="15.8" cy="18" r=".85" fill="#fff"/><circle cx="25.8" cy="18" r=".85" fill="#fff"/>' +
    '<circle cx="11.3" cy="23.8" r="1.9" fill="#FF8FA3" opacity=".55"/><circle cx="28.7" cy="23.8" r="1.9" fill="#FF8FA3" opacity=".55"/>' +
    '<path d="M15.5 24.3q4.5 3.8 9 0" stroke="' + SAFE_COLOR + '" stroke-width="2" fill="none" stroke-linecap="round"/>' +
    '</svg>';

  function makeAvatar() {
    var av = document.createElement('div');
    av.className = 'wgt-av';
    if (AVATAR) {
      var img = document.createElement('img');
      img.src = AVATAR;
      img.alt = '';
      av.appendChild(img);
    } else {
      av.classList.add('wgt-av-svg');
      av.innerHTML = AVATAR_SVG;
    }
    return av;
  }
  var headAv = document.createElement('div');
  headAv.className = 'wgt-av-wrap';
  headAv.appendChild(makeAvatar());
  var onlineDot = document.createElement('span');
  onlineDot.className = 'wgt-dot';
  onlineDot.title = 'En ligne';
  headAv.appendChild(onlineDot);
  head.insertBefore(headAv, head.firstChild);
  loadBookingConfig();
  loadShopConfig();
  loadLook();

  // Prénom et photo de l'assistante réglés côté serveur (ils priment sur
  // data-name / data-avatar, pour pouvoir les changer sans toucher au site).
  var suggestions = []; // questions fréquentes cliquables (réglées côté serveur)
  function loadLook() {
    if (!BUSINESS) return;
    fetch(API_BASE + '/api/widget/' + encodeURIComponent(BUSINESS) + '/look').then(function (r) { return r.json(); }).then(function (data) {
      if (!data) return;
      if (data.name) {
        BOT_NAME = data.name;
        root.querySelector('.wgt-name').textContent = BOT_NAME;
        if (log.querySelector('.wgt-hero')) renderHero();
        Array.prototype.forEach.call(log.querySelectorAll('.wgt-meta'), function (m) {
          m.textContent = BOT_NAME + ' • ' + m.textContent.split(' • ').slice(1).join(' • ');
        });
      }
      if (data.mic) setupMic();
      if (data.suggestions) {
        // Soit une liste, soit { fr: [...], en: [...] } selon la langue de la page.
        var list = data.suggestions;
        if (!Array.isArray(list)) {
          var lang = ((document.documentElement.lang || navigator.language || 'fr') + '').slice(0, 2).toLowerCase();
          list = list[lang] || list.fr || list.en || [];
        }
        suggestions = (Array.isArray(list) ? list : []).slice(0, 6).map(function (q) {
          // Un emoji en début de libellé n'est pas envoyé à l'assistant.
          if (typeof q === 'string') return { label: q, text: q.replace(/^[^0-9A-Za-zÀ-ÿ¿¡]+/, '') || q };
          return { label: q.label || q.text, text: q.text || q.label };
        }).filter(function (q) { return q.label && q.text; });
        if (welcomeShown) showQuickReplies();
      }
      if (data.avatar) {
        AVATAR = absUrl(data.avatar);
        headAv.replaceChild(makeAvatar(), headAv.firstChild);
        if (log.querySelector('.wgt-hero')) renderHero();
        Array.prototype.forEach.call(log.querySelectorAll('.wgt-row > .wgt-av'), function (a) {
          a.parentNode.replaceChild(makeAvatar(), a);
        });
      }
    }).catch(function () {});
  }

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

  // --- Mise en forme légère des réponses : **gras**, listes, liens cliquables ---
  function escHtml(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtInline(t) {
    var toks = [];
    function tok(h) { toks.push(h); return '\u0000' + (toks.length - 1) + '\u0000'; }
    function link(u, label) { return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'; }
    t = escHtml(t);
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (m, l, u) { return tok(link(u, l)); });
    t = t.replace(/https?:\/\/[^\s<]*[^\s<.,;:!?)\]]/g, function (u) { return tok(link(u, u.replace(/^https?:\/\//, ''))); });
    t = t.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, function (e) { return tok('<a href="mailto:' + e + '">' + e + '</a>'); });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return t.replace(/\u0000(\d+)\u0000/g, function (m, i) { return toks[+i]; });
  }
  function formatText(text) {
    var lines = String(text || '').replace(/\r/g, '').split('\n');
    var html = '', para = [], list = null;
    function flushPara() { if (para.length) { html += '<p>' + para.join('<br>') + '</p>'; para = []; } }
    function flushList() { if (list) { html += '<' + list.tag + '>' + list.items.join('') + '</' + list.tag + '>'; list = null; } }
    lines.forEach(function (line) {
      var ul = line.match(/^\s*[-•*]\s+(.*)$/);
      var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        var tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag: tag, items: [] }; }
        list.items.push('<li>' + fmtInline((ul || ol)[1]) + '</li>');
      } else if (!line.trim()) {
        flushPara(); flushList();
      } else {
        flushList(); para.push(fmtInline(line));
      }
    });
    flushPara(); flushList();
    return html;
  }

  // Affichage progressif (mot à mot) d'une réponse déjà mise en forme.
  function reveal(node, done) {
    var reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    var texts = [], n, total = 0;
    while ((n = walker.nextNode())) { texts.push({ n: n, full: n.nodeValue }); total += n.nodeValue.length; }
    if (reduce || total < 40) { if (done) done(); return; }
    texts.forEach(function (t) { t.n.nodeValue = ''; });
    var links = node.querySelectorAll('li, a, strong');
    var step = Math.max(3, Math.ceil(total / 55)), shown = 0, idx = 0;
    var timer = setInterval(function () {
      var budget = step;
      while (budget > 0 && idx < texts.length) {
        var t = texts[idx], cur = t.n.nodeValue.length, left = t.full.length - cur;
        var take = Math.min(left, budget);
        // On avance jusqu'à la fin du mot pour ne pas couper les mots.
        var end = cur + take;
        while (end < t.full.length && /\S/.test(t.full.charAt(end))) end++;
        t.n.nodeValue = t.full.slice(0, end);
        budget -= (end - cur); shown += (end - cur);
        if (end >= t.full.length) idx++;
      }
      log.scrollTop = log.scrollHeight;
      if (idx >= texts.length) { clearInterval(timer); if (done) done(); }
    }, 22);
  }

  var transcript = []; // messages affichés, gardés pendant la visite (changement de page)
  var unread = 0;
  var badge = root.querySelector('.wgt-badge');
  function setUnread(n) {
    unread = n;
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.hidden = n <= 0;
  }

  function addMessage(role, text, opts) {
    opts = opts || {};
    if (!opts.restore) {
      transcript.push({ r: role, t: text, d: nowStr(), mid: opts.mid || null, f: 0 });
      if (transcript.length > 80) transcript = transcript.slice(-80);
      saveStateSoon();
      if (role !== 'user' && !panel.classList.contains('wgt-open')) setUnread(unread + 1);
    }
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
      m.innerHTML = formatText(text);
      var meta = document.createElement('div');
      meta.className = 'wgt-meta';
      meta.textContent = BOT_NAME + ' • ' + (opts.time || nowStr());
      col.appendChild(m);
      if (opts.mid) {
        var mr = el('div', 'wgt-metarow');
        mr.appendChild(meta);
        mr.appendChild(feedbackButtons(opts.mid, opts.f || 0));
        col.appendChild(mr);
      } else {
        col.appendChild(meta);
      }
      row.appendChild(col);
      log.appendChild(row);
      if (opts.animate) { log.scrollTop = log.scrollHeight; reveal(m, opts.done); return m; }
    }
    log.scrollTop = log.scrollHeight;
    if (opts.done) opts.done();
    return null;
  }

  // --- 👍 / 👎 : l'avis du visiteur remonte dans « Questions à améliorer » ---
  var THUMB_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11H4V10zM7 10l4-8a2.5 2.5 0 0 1 2.5 2.5V8h5.3a2 2 0 0 1 2 2.3l-1.4 9A2 2 0 0 1 17.4 21H7"/></svg>';
  var THUMB_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(180deg)"><path d="M7 10v11H4V10zM7 10l4-8a2.5 2.5 0 0 1 2.5 2.5V8h5.3a2 2 0 0 1 2 2.3l-1.4 9A2 2 0 0 1 17.4 21H7"/></svg>';
  function feedbackButtons(mid, current) {
    var box = el('span', 'wgt-fb');
    var up = el('button'); up.type = 'button'; up.innerHTML = THUMB_UP; up.setAttribute('aria-label', 'Réponse utile'); up.title = 'Réponse utile';
    var down = el('button'); down.type = 'button'; down.innerHTML = THUMB_DOWN; down.setAttribute('aria-label', 'Réponse pas utile'); down.title = 'Pas utile';
    box.appendChild(up); box.appendChild(down);
    function paint(v) {
      up.classList.toggle('is-on', v === 1);
      down.classList.toggle('is-on', v === -1);
      box.classList.toggle('has-vote', v !== 0);
    }
    var value = current || 0;
    paint(value);
    function vote(v) {
      value = value === v ? 0 : v;
      paint(value);
      transcript.forEach(function (t) { if (t.mid === mid) t.f = value; });
      saveStateSoon();
      fetch(API_BASE + '/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business: BUSINESS, conversationId: conversationId, messageId: mid, value: value }),
      }).catch(function () {});
    }
    up.addEventListener('click', function () { vote(1); });
    down.addEventListener('click', function () { vote(-1); });
    return box;
  }

  // --- Micro : enregistrement, puis transcription par le serveur (Groq Whisper) ---
  var micBtn = root.querySelector('.wgt-mic');
  var micReady = false;
  function setupMic() {
    if (micReady) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return;
    micReady = true;
    micBtn.hidden = false;
    var rec = null, chunks = [], stream = null, timer = null, started = 0, busy = false;
    var basePlaceholder = input.placeholder;
    function hint(t, ms) {
      input.placeholder = t;
      if (ms) setTimeout(function () { if (!rec && !busy) input.placeholder = basePlaceholder; }, ms);
    }
    function stopTracks() { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    function stop() { if (rec && rec.state !== 'inactive') rec.stop(); }
    micBtn.addEventListener('click', async function () {
      unlockAudio();
      if (busy) return;
      if (rec) { stop(); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        hint('Micro refusé : autorisez-le dans votre navigateur.', 4000);
        return;
      }
      var mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].filter(function (m) {
        return window.MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m);
      })[0] || '';
      try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch (e) { stopTracks(); hint('Micro indisponible sur ce navigateur.', 4000); return; }
      chunks = [];
      rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.onstop = async function () {
        clearInterval(timer);
        stopTracks();
        micBtn.classList.remove('is-rec');
        var type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
        rec = null;
        var blob = new Blob(chunks, { type: type });
        if (Date.now() - started < 700 || blob.size < 800) { hint('Maintenez un peu plus longtemps…', 2500); return; }
        busy = true;
        micBtn.classList.add('is-busy');
        input.disabled = true;
        hint('Transcription…');
        try {
          var res = await fetch(API_BASE + '/api/transcribe?business=' + encodeURIComponent(BUSINESS || ''), {
            method: 'POST', headers: { 'Content-Type': type }, body: blob,
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || '');
          input.value = (input.value ? input.value + ' ' : '') + (data.text || '');
          input.placeholder = basePlaceholder;
        } catch (e) {
          hint((e && e.message) || 'Transcription impossible, réessayez.', 4000);
        }
        busy = false;
        micBtn.classList.remove('is-busy');
        input.disabled = false;
        input.focus();
      };
      rec.start();
      started = Date.now();
      micBtn.classList.add('is-rec');
      hint('🔴 0:00 · touchez ■ pour arrêter');
      timer = setInterval(function () {
        var sec = Math.floor((Date.now() - started) / 1000);
        hint('🔴 0:' + (sec < 10 ? '0' : '') + sec + ' · touchez ■ pour arrêter');
        if (sec >= 60) stop();
      }, 500);
    });
  }

  // --- Conversation gardée pendant toute la visite, même en changeant de page ---
  var STATE_KEY = 'wgt-state-' + (BUSINESS || '');
  var saveTimer = null;
  function saveStateSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 0);
  }
  function saveState() {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify({
        c: conversationId, h: history.slice(-40), m: transcript, o: panel.classList.contains('wgt-open'),
        i: hasInteracted, u: unread,
      }));
    } catch (e) {}
  }
  function clearState() { try { sessionStorage.removeItem(STATE_KEY); } catch (e) {} }

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
      } else if (data && data.hotel) {
        hotelEnabled = true;
        if (welcomeShown) { removeQuickReplies(); showQuickReplies(); }
      }
    }).catch(function () {});
  }

  // Boutons rapides sous le message d'accueil, selon ce que l'entreprise
  // propose (réservation, boutique, suivi de commande).
  // Ils restent affichés en permanence au-dessus du champ de saisie.
  function showQuickReplies() {
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
    if (hotelEnabled) {
      chips.push(['🛏️ Voir les disponibilités', function () {
        addMessage('user', 'Je voudrais réserver une chambre');
        history.push({ role: 'user', content: 'Je voudrais réserver une chambre' });
        addMessage('bot', 'Avec plaisir ! Indiquez vos dates et le nombre de personnes :');
        history.push({ role: 'assistant', content: 'Avec plaisir ! Indiquez vos dates et le nombre de personnes :' });
        showStayForm();
      }]);
      chips.push(["🍳 Services de l'hôtel", function () { sendText("Quels services propose l'hôtel (petit-déjeuner, parking, spa…) ?"); }]);
      chips.push(['📍 Accès & horaires', function () { sendText("Comment venir à l'hôtel, et à quelle heure puis-je arriver ?"); }]);
    }
    suggestions.forEach(function (q) {
      chips.push([q.label, function () { sendText(q.text); }]);
    });
    function run(c) { hasInteracted = true; showQuickReplies(); c[1](); }
    actionsBar.innerHTML = '';
    if (cardsBox) { cardsBox.remove(); cardsBox = null; }
    if (!hasInteracted && welcomeShown && chips.length) {
      // Avant le premier message : les questions en cartes sous l'accueil.
      cardsBox = el('div', 'wgt-cards');
      chips.forEach(function (c) {
        var b = el('button', 'wgt-card');
        b.type = 'button';
        b.appendChild(el('span', null, c[0]));
        b.appendChild(el('i', null, '›'));
        b.addEventListener('click', function () { run(c); });
        cardsBox.appendChild(b);
      });
      var anchor = log.querySelector('.wgt-row');
      if (anchor && anchor.nextSibling) log.insertBefore(cardsBox, anchor.nextSibling); else log.appendChild(cardsBox);
      actionsBar.hidden = true;
      return;
    }
    // Ensuite : une barre compacte toujours visible au-dessus du champ.
    chips.forEach(function (c) {
      var b = el('button', 'wgt-chip', c[0]);
      b.type = 'button';
      b.addEventListener('click', function () { run(c); });
      actionsBar.appendChild(b);
    });
    actionsBar.hidden = !chips.length || !welcomeShown;
  }
  var cardsBox = null;
  // Les boutons d'action restent visibles : plus rien à retirer.
  function removeQuickReplies() {}

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

  // ------------------------------------------------------------
  // HÔTEL : dates + personnes → chambres adaptées → moteur de réservation
  // ------------------------------------------------------------
  function isoDay(offset) { return todayStr(offset); }

  function showStayForm() {
    var card = el('div', 'wgt-bk');
    card.appendChild(el('h4', null, 'Votre séjour'));
    var grid = el('div', 'wgt-2col');
    var c1 = el('div'); c1.appendChild(el('label', 'wgt-lbl', 'Arrivée'));
    var inDate = el('input'); inDate.type = 'date'; inDate.min = isoDay(0); inDate.value = isoDay(7); c1.appendChild(inDate);
    var c2 = el('div'); c2.appendChild(el('label', 'wgt-lbl', 'Départ'));
    var outDate = el('input'); outDate.type = 'date'; outDate.min = isoDay(1); outDate.value = isoDay(9); c2.appendChild(outDate);
    grid.appendChild(c1); grid.appendChild(c2);
    card.appendChild(grid);
    card.appendChild(el('label', 'wgt-lbl', 'Personnes'));
    var guests = el('select', 'wgt-sel');
    for (var i = 1; i <= 6; i++) { var o = el('option', null, i + (i > 1 ? ' personnes' : ' personne')); o.value = String(i); if (i === 2) o.selected = true; guests.appendChild(o); }
    card.appendChild(guests);
    var btn = el('button', 'wgt-cta', 'Voir les chambres'); btn.type = 'button';
    var err = el('p', 'wgt-bk-err'); err.style.display = 'none';
    card.appendChild(btn); card.appendChild(err);
    log.appendChild(card);
    scrollDown();
    inDate.addEventListener('change', function () {
      if (outDate.value <= inDate.value) {
        var d = new Date(inDate.value + 'T12:00:00'); d.setDate(d.getDate() + 1);
        outDate.value = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      }
    });

    btn.addEventListener('click', async function () {
      err.style.display = 'none';
      btn.disabled = true; btn.textContent = 'Recherche…';
      try {
        var url = HOTEL_URL + '/rooms?arrivee=' + inDate.value + '&depart=' + outDate.value + '&personnes=' + guests.value +
          (conversationId ? '&conversationId=' + conversationId : '');
        var data = await getJson(url);
        btn.disabled = false; btn.textContent = 'Modifier la recherche';
        var label = 'du ' + shortDate(inDate.value) + ' au ' + shortDate(outDate.value) + ', ' + guests.value + ' pers.';
        history.push({ role: 'user', content: 'Recherche de séjour ' + label });
        if (!data.rooms.length) {
          addMessage('bot', "Aucune de nos chambres ne peut accueillir " + guests.value + " personnes. Écrivez-nous, nous trouverons une solution !");
          return;
        }
        addMessage('bot', 'Voici nos chambres pour ' + data.nights + ' nuit' + (data.nights > 1 ? 's' : '') + ' (' + label + ') :');
        showRooms(data.rooms, label);
      } catch (e) {
        err.textContent = e.message || 'Recherche impossible.'; err.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Voir les chambres';
      }
    });
  }

  function showRooms(rooms, label) {
    var row = el('div', 'wgt-prods');
    rooms.forEach(function (r) {
      var card = el('div', 'wgt-prod');
      if (r.image) { var img = el('img'); img.src = absUrl(r.image); img.alt = r.name; img.loading = 'lazy'; card.appendChild(img); }
      var body = el('div', 'wgt-prod-b');
      body.appendChild(el('div', 'wgt-prod-n', r.name));
      if (r.capacity) body.appendChild(el('div', 'wgt-prod-cap', "Jusqu'à " + r.capacity + ' personne' + (r.capacity > 1 ? 's' : '')));
      body.appendChild(el('div', 'wgt-prod-p', r.price + ' / nuit'));
      body.appendChild(el('div', 'wgt-prod-tot', 'Total ' + r.total + ' · ' + r.nights + ' nuit' + (r.nights > 1 ? 's' : '')));
      if (r.bookingUrl) {
        var a = el('a', 'wgt-cta', 'Réserver');
        a.href = absUrl(r.bookingUrl); a.target = '_blank'; a.rel = 'noopener';
        a.style.display = 'block'; a.style.textAlign = 'center'; a.style.textDecoration = 'none';
        a.addEventListener('click', function () {
          trackShop('book_room', r.id, label);
          history.push({ role: 'user', content: '🛏️ A cliqué sur « Réserver » : ' + r.name + ' (' + label + ')' });
        });
        body.appendChild(a);
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
    var wrap = el('div', 'wgt-typing-row');
    var t = el('div', 'wgt-typing');
    t.innerHTML = '<i></i><i></i><i></i>';
    wrap.appendChild(t);
    wrap.appendChild(el('small', null, BOT_NAME + ' écrit…'));
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    return wrap;
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

  // Écran d'accueil : grande photo, prénom, « répond en quelques secondes ».
  function renderHero() {
    var old = log.querySelector('.wgt-hero');
    var hero = el('div', 'wgt-hero');
    var w = el('div', 'wgt-av-wrap');
    w.appendChild(makeAvatar());
    w.appendChild(el('span', 'wgt-dot'));
    hero.appendChild(w);
    hero.appendChild(el('b', null, BOT_NAME));
    hero.appendChild(el('span', null, 'Assistant IA · Répond en quelques secondes'));
    if (old) old.parentNode.replaceChild(hero, old); else log.insertBefore(hero, log.firstChild);
  }

  function showWelcome(instant) {
    if (welcomed) return;
    welcomed = true;
    renderHero();
    function done() {
      addMessage('bot', WELCOME);
      welcomeShown = true;
      showQuickReplies();
    }
    if (instant) return done();
    var t = showTyping();
    setTimeout(function () { t.remove(); done(); }, 900);
  }

  function isPhone() { return window.matchMedia && window.matchMedia('(max-width: 480px)').matches; }
  // Téléphone : la fenêtre suit la hauteur visible (clavier ouvert compris).
  function fitViewport() {
    if (!panel.classList.contains('wgt-open') || !isPhone() || !window.visualViewport) { panel.style.height = ''; panel.style.top = ''; return; }
    panel.style.height = window.visualViewport.height + 'px';
    panel.style.top = window.visualViewport.offsetTop + 'px';
    log.scrollTop = log.scrollHeight;
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitViewport);
    window.visualViewport.addEventListener('scroll', fitViewport);
  }

  // Compte une ouverture du chat par visite (entonnoir du tableau de bord).
  function trackOpen() {
    if (!BUSINESS) return;
    try { if (sessionStorage.getItem('wgt-open-' + BUSINESS)) return; sessionStorage.setItem('wgt-open-' + BUSINESS, '1'); } catch (e) {}
    fetch(API_BASE + '/api/widget/' + encodeURIComponent(BUSINESS) + '/open', { method: 'POST' }).catch(function () {});
  }

  function openPanel(byUser) {
    panel.classList.add('wgt-open');
    root.classList.add('wgt-is-open');
    if (isPhone()) document.documentElement.classList.add('wgt-lock');
    fitViewport();
    setUnread(0);
    markSeen();
    trackOpen();
    showWelcome();
    saveStateSoon();
    if (byUser && !isPhone()) setTimeout(function () { input.focus(); }, 50);
  }

  function closePanel() {
    closeMenu();
    panel.classList.remove('wgt-open');
    root.classList.remove('wgt-is-open');
    document.documentElement.classList.remove('wgt-lock');
    panel.style.height = ''; panel.style.top = '';
    markSeen();
    saveStateSoon();
  }

  // Relance : ré-ouvre la fenêtre avec un message proactif, comme à
  // l'arrivée sur le site, mais plus tard dans la visite — uniquement si
  // le visiteur n'a jamais écrit et n'a pas déjà été relancé cette visite.
  function showNudge() {
    if (isPhone()) { showWelcome(true); addMessage('bot', NUDGE_MESSAGE); return; }
    panel.classList.add('wgt-open');
    root.classList.add('wgt-is-open');
    markSeen();
    var t = showTyping();
    setTimeout(function () {
      t.remove();
      addMessage('bot', NUDGE_MESSAGE);
    }, 900);
  }

  // ------------------------------------------------------------
  // MENU « … » : nouvelle conversation, mode agrandi, son, parler à un humain.
  // ------------------------------------------------------------
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var soundOn = lsGet('wgt-sound') !== 'off';
  var audioCtx = null;
  function unlockAudio() {
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }
  // Petit « ding » doux à deux notes quand l'assistant répond.
  function ding() {
    if (!soundOn || !audioCtx) return;
    try {
      var t = audioCtx.currentTime;
      [660, 880].forEach(function (f, i) {
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        var s0 = t + i * 0.09;
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, s0);
        g.gain.exponentialRampToValueAtTime(0.12, s0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, s0 + 0.22);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(s0); o.stop(s0 + 0.25);
      });
    } catch (e) {}
  }
  root.addEventListener('pointerdown', unlockAudio);

  var expandItem = menu.querySelector('[data-act="expand"]');
  var soundItem = menu.querySelector('[data-act="sound"]');
  function syncMenu() {
    expandItem.classList.toggle('is-on', panel.classList.contains('wgt-expanded'));
    soundItem.classList.toggle('is-on', soundOn);
    Array.prototype.forEach.call(menu.querySelectorAll('[data-pos]'), function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-pos') === currentPos);
    });
  }
  function openMenu() { syncMenu(); menu.hidden = false; moreBtn.setAttribute('aria-expanded', 'true'); }
  function closeMenu() { menu.hidden = true; moreBtn.setAttribute('aria-expanded', 'false'); }
  moreBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else closeMenu();
  });
  document.addEventListener('click', function (e) {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== moreBtn) closeMenu();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

  var convGen = 0; // change à chaque « Nouvelle conversation »
  function resetConversation() {
    convGen++;
    log.innerHTML = '';
    cardsBox = null;
    transcript = [];
    clearState();
    history = [];
    conversationId = null;
    activeCard = null;
    hasInteracted = false;
    welcomed = false;
    welcomeShown = false;
    actionsBar.hidden = true;
    input.value = '';
    showWelcome();
  }

  function showHandoffForm() {
    var card = el('div', 'wgt-bk');
    card.appendChild(el('h4', null, 'Être recontacté par un conseiller'));
    var nameIn = el('input'); nameIn.placeholder = 'Votre nom'; nameIn.autocomplete = 'name';
    var contactIn = el('input'); contactIn.placeholder = 'Email ou téléphone'; contactIn.autocomplete = 'email';
    var noteIn = el('textarea'); noteIn.placeholder = 'Votre message (facultatif)'; noteIn.rows = 2;
    var err = el('p', 'wgt-bk-err'); err.style.display = 'none';
    var btn = el('button', 'wgt-cta', 'Envoyer ma demande'); btn.type = 'button';
    [nameIn, contactIn, noteIn, btn, err].forEach(function (n) { card.appendChild(n); });
    card.appendChild(el('p', 'wgt-bk-legal', 'Vos coordonnées servent uniquement à vous recontacter.'));
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
    setTimeout(function () { nameIn.focus(); }, 50);

    btn.addEventListener('click', async function () {
      err.style.display = 'none';
      var name = nameIn.value.trim();
      var contact = contactIn.value.trim();
      if (!name || !contact) { err.textContent = 'Indiquez votre nom et un email ou un téléphone.'; err.style.display = 'block'; return; }
      btn.disabled = true; btn.textContent = 'Envoi…';
      try {
        var res = await fetch(API_BASE + '/api/handoff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ business: BUSINESS, conversationId: conversationId, name: name, contact: contact, message: noteIn.value.trim() }),
        });
        var data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Erreur');
        if (!card.isConnected) return;
        conversationId = data.conversationId || conversationId;
        card.remove();
        addMessage('bot', data.confirmation);
        history.push({ role: 'assistant', content: data.confirmation });
        ding();
      } catch (e) {
        err.textContent = (e && e.message && e.message !== 'Failed to fetch') ? e.message : 'Impossible de contacter le serveur.';
        err.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Envoyer ma demande';
      }
    });
  }

  menu.addEventListener('click', function (e) {
    var item = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!item) return;
    var act = item.getAttribute('data-act');
    if (act === 'new') { closeMenu(); resetConversation(); }
    else if (act === 'pos') { applyPosition(item.getAttribute('data-pos')); lsSet('wgt-pos', currentPos); syncMenu(); }
    else if (act === 'expand') { panel.classList.toggle('wgt-expanded'); syncMenu(); log.scrollTop = log.scrollHeight; }
    else if (act === 'sound') { soundOn = !soundOn; lsSet('wgt-sound', soundOn ? 'on' : 'off'); syncMenu(); if (soundOn) { unlockAudio(); ding(); } }
    else if (act === 'human') {
      closeMenu();
      hasInteracted = true;
      showQuickReplies();
      var intro = "Bien sûr ! Laissez-moi vos coordonnées et un membre de l'équipe vous recontacte rapidement :";
      addMessage('bot', intro);
      history.push({ role: 'assistant', content: intro });
      showHandoffForm();
    }
  });

  // Petite API pour le site du client : un bouton « Réserver » de sa page
  // peut ouvrir directement le parcours de réservation du widget.
  //   <button onclick="WHATGO.book()">Réserver</button>
  window.WHATGO = {
    open: function () { openPanel(true); },
    // Hôtel : ouvre directement la recherche de séjour.
    stay: function () {
      openPanel(false);
      if (!hotelEnabled) return;
      hasInteracted = true;
      showQuickReplies();
      setTimeout(function () {
        addMessage('bot', 'Avec plaisir ! Indiquez vos dates et le nombre de personnes :');
        history.push({ role: 'assistant', content: 'Avec plaisir ! Indiquez vos dates et le nombre de personnes :' });
        showStayForm();
      }, welcomeShown ? 0 : 1000);
    },
    book: function () {
      openPanel(false);
      if (!bookingServices) return;
      hasInteracted = true;
      showQuickReplies();
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

  // --- Reprise de la conversation après un changement de page ---
  (function restoreState() {
    var st = null;
    try { st = JSON.parse(sessionStorage.getItem(STATE_KEY) || 'null'); } catch (e) { st = null; }
    if (!st || !st.m || !st.m.length) return;
    conversationId = st.c || null;
    history = Array.isArray(st.h) ? st.h : [];
    transcript = st.m;
    hasInteracted = !!st.i;
    welcomed = true;
    welcomeShown = true;
    renderHero();
    transcript.forEach(function (m) { addMessage(m.r, m.t, { restore: true, time: m.d || '', mid: m.mid, f: m.f }); });
    showQuickReplies();
    if (st.o && !isPhone()) openPanel(false);
    else setUnread(st.u || 0);
  })();

  // --- Ouverture automatique à l'arrivée sur la page (une fois par visite).
  // Sur téléphone, on n'ouvre pas en plein écran : le message d'accueil
  // arrive avec une pastille sur la bulle. ---
  if (AUTO_OPEN && !alreadySeen()) {
    setTimeout(function () {
      if (alreadySeen() || panel.classList.contains('wgt-open')) return;
      if (isPhone()) { markSeen(); showWelcome(true); }
      else openPanel(false);
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

  function clearFollowups() {
    Array.prototype.forEach.call(log.querySelectorAll('.wgt-follow'), function (f) { f.remove(); });
  }
  function showFollowups(list) {
    if (!list || !list.length) return;
    var box = el('div', 'wgt-follow');
    list.forEach(function (q) {
      var b = el('button', 'wgt-chip', q);
      b.type = 'button';
      b.addEventListener('click', function () { sendText(q); });
      box.appendChild(b);
    });
    log.appendChild(box);
    log.scrollTop = log.scrollHeight;
  }

  // Formulaire de coordonnées : envoie un message clair à l'assistant, ce qui
  // crée le lead (nom, email, téléphone) exactement comme s'il les avait tapés.
  function showContactForm() {
    if (log.querySelector('.wgt-contact')) return;
    var card = el('div', 'wgt-bk wgt-contact');
    card.appendChild(el('h4', null, 'Vos coordonnées'));
    var nameIn = el('input'); nameIn.placeholder = 'Prénom et nom'; nameIn.autocomplete = 'name';
    var emailIn = el('input'); emailIn.placeholder = 'Email'; emailIn.type = 'email'; emailIn.autocomplete = 'email';
    var phoneIn = el('input'); phoneIn.placeholder = 'Téléphone'; phoneIn.type = 'tel'; phoneIn.autocomplete = 'tel';
    var err = el('p', 'wgt-bk-err'); err.style.display = 'none';
    var btn = el('button', 'wgt-cta', 'Envoyer'); btn.type = 'button';
    [nameIn, emailIn, phoneIn, btn, err].forEach(function (n) { card.appendChild(n); });
    card.appendChild(el('p', 'wgt-bk-legal', "Vos coordonnées servent uniquement à vous recontacter."));
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
    btn.addEventListener('click', function () {
      var name = nameIn.value.trim(), email = emailIn.value.trim(), phone = phoneIn.value.trim();
      err.style.display = 'none';
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = "L'email ne semble pas valide."; err.style.display = 'block'; return; }
      if (phone && phone.replace(/\D/g, '').length < 8) { err.textContent = 'Le numéro de téléphone ne semble pas valide.'; err.style.display = 'block'; return; }
      if (!email && !phone) { err.textContent = 'Indiquez au moins un email ou un téléphone.'; err.style.display = 'block'; return; }
      var parts = [];
      if (name) parts.push("Je m'appelle " + name + '.');
      if (email) parts.push('Mon email : ' + email + '.');
      if (phone) parts.push('Mon téléphone : ' + phone + '.');
      card.remove();
      sendText(parts.join(' '));
    });
  }

  async function sendText(text) {
    sendBtn.disabled = true;
    hasInteracted = true;
    showQuickReplies();
    clearFollowups();
    var oldContact = log.querySelector('.wgt-contact');
    if (oldContact) oldContact.remove();

    addMessage('user', text);
    history.push({ role: 'user', content: text });

    var typing = showTyping();
    var gen = convGen;

    try {
      var res = await fetch(SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, business: BUSINESS, conversationId: conversationId }),
      });
      var data = await res.json();
      typing.remove();
      // Réponse d'une conversation effacée entre-temps : on l'ignore.
      if (gen !== convGen) { sendBtn.disabled = false; return; }

      if (data.error) {
        addMessage('bot', "Désolé, une erreur est survenue. Réessayez dans un instant.");
      } else {
        history.push({ role: 'assistant', content: data.reply });
        conversationId = data.conversationId;
        ding();
        // Réponse affichée mot à mot, puis les modules demandés par le
        // serveur (réservation, fiches produits, suivi de commande, séjour,
        // formulaire de coordonnées) et les questions de suite.
        addMessage('bot', data.reply, { animate: true, mid: data.messageId || null, done: function () {
          if (gen !== convGen) return;
          if (data.ui && data.ui.type === 'booking' && bookingServices) startBooking();
          if (data.ui && data.ui.type === 'products' && data.ui.items && data.ui.items.length) showProducts(data.ui.items);
          if (data.ui && data.ui.type === 'order') showOrderForm();
          if (data.ui && data.ui.type === 'stay' && hotelEnabled) showStayForm();
          if (data.contactForm) showContactForm();
          showFollowups(data.followups);
          saveStateSoon();
        } });
      }
    } catch (err) {
      typing.remove();
      if (gen === convGen) addMessage('bot', "Impossible de contacter le serveur. Vérifiez votre connexion.");
    }
    sendBtn.disabled = false;
    saveStateSoon();
    if (!isPhone()) input.focus();
  }
})();
