// ============================================================
// server.js — Serveur multi-clients (Gemini) avec tableau de bord
// ============================================================
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { query, initDb } = require('./db');
const {
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  requireRole,
  requireSuperAdmin,
} = require('./auth');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.static('public'));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-3.1-flash-lite';

// Clé Groq optionnelle : sert UNIQUEMENT de secours si Gemini est en
// surcharge (erreur 503) après ses tentatives. Si elle n'est pas
// configurée (GROQ_API_KEY absente), le fallback est simplement ignoré
// et le comportement reste identique à avant (l'erreur Gemini est
// renvoyée telle quelle) — rien ne casse si la clé n'est pas encore mise.
// .trim() : évite qu'un espace ou retour à la ligne collé par erreur
// dans Render casse silencieusement l'authentification.
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim() || undefined;
const GROQ_MODEL = 'openai/gpt-oss-20b';

// Clé Resend optionnelle : sert à envoyer l'email "mot de passe oublié". Si
// elle n'est pas configurée, le lien de réinitialisation est simplement
// affiché dans les logs Render au lieu d'être envoyé par email (utile pour
// tester avant d'avoir configuré Resend, sans jamais faire planter le
// serveur si la clé manque).
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim() || undefined;
const RESEND_FROM = process.env.RESEND_FROM || 'WHATGO AI <no-reply@whatgo.ai>';
const APP_URL = (process.env.APP_URL || 'https://whatgo-server.onrender.com').replace(/\/$/, '');

// ------------------------------------------------------------
// Limiteur anti-abus (en mémoire, par IP) : le serveur tourne sur une seule
// instance (WEB_CONCURRENCY=1 sur Render), donc pas besoin d'un stockage
// partagé type Redis pour ça. Chaque compteur garde juste les horodatages
// des derniers appels dans la fenêtre de temps, et les entrées inactives
// sont nettoyées périodiquement pour ne pas accumuler de la mémoire.
const rateLimitBuckets = new Map(); // clé ("route:ip") -> [timestamps]
function isRateLimited(key, max, windowMs) {
  const now = Date.now();
  const hits = (rateLimitBuckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  rateLimitBuckets.set(key, hits);
  return hits.length > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateLimitBuckets) {
    const fresh = hits.filter((t) => now - t < 15 * 60 * 1000);
    if (fresh.length) rateLimitBuckets.set(key, fresh);
    else rateLimitBuckets.delete(key);
  }
}, 5 * 60 * 1000);

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0].trim() : null) || req.socket.remoteAddress || 'unknown';
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Envoie l'email "mot de passe oublié" via Resend (API HTTP simple, pas de
// SMTP à configurer). Ne bloque et ne casse jamais /api/auth/forgot-password
// si Resend est mal configuré ou indisponible — l'utilisateur reçoit toujours
// la même réponse générique, et l'erreur reste seulement dans les logs.
async function sendPasswordResetEmail(toEmail, resetLink) {
  if (!RESEND_API_KEY) {
    console.warn(`RESEND_API_KEY non configurée : email non envoyé. Lien de réinitialisation pour ${toEmail} : ${resetLink}`);
    return;
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [toEmail],
        subject: 'Réinitialisation de votre mot de passe WHATGO',
        html: `<p>Bonjour,</p><p>Cliquez sur ce lien pour choisir un nouveau mot de passe (valable 1 heure) :</p>
               <p><a href="${resetLink}">${resetLink}</a></p>
               <p>Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email.</p>`,
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      console.error(`Erreur envoi email Resend (HTTP ${response.status}):`, detail);
    }
  } catch (err) {
    console.error('Erreur envoi email de réinitialisation:', err.message);
  }
}

const DRAFT_REPLY =
  "Merci pour votre message ! Notre équipe finalise la configuration de cet assistant, il sera bientôt pleinement opérationnel. N'hésitez pas à nous laisser vos coordonnées, nous reviendrons vers vous rapidement.";

// ------------------------------------------------------------
// Qualification (page "Qualification" du tableau de bord) : infos à
// collecter, seuils de score, escalade vers un humain, sujets bloqués.
// Stockée en JSON dans businesses.qualification. defaultQualification()
// donne les valeurs par défaut d'une entreprise neuve (PAS des données
// fictives par entreprise — juste ce qu'on affiche tant que rien n'a
// été enregistré). Le médical/juridique/financier n'apparaît même pas
// ici : c'est codé en dur dans buildSystemPrompt, jamais désactivable.
// ------------------------------------------------------------
function defaultQualification() {
  return {
    fields: [],
    thresholds: { hot: 70, warm: 40, appointment: 55 },
    escalation: {
      askHuman: true,
      threeUnknown: true,
      angryTone: true,
      bigAmount: false,
      bigAmountValue: 5000,
      dispute: true,
      notifyEmail: '',
      notifyPhone: '',
    },
    blockedTopics: { discount: false, contract: false, custom: '' },
  };
}

// Relit le JSON stocké et complète tout champ manquant/invalide avec les
// défauts, pour rester robuste face à une config partielle ou ancienne.
function parseQualification(business) {
  const d = defaultQualification();
  let raw = {};
  try {
    raw = JSON.parse((business && business.qualification) || '{}') || {};
  } catch {
    raw = {};
  }
  return {
    fields: Array.isArray(raw.fields) ? raw.fields : d.fields,
    thresholds: Object.assign({}, d.thresholds, (raw.thresholds && typeof raw.thresholds === 'object') ? raw.thresholds : {}),
    escalation: Object.assign({}, d.escalation, (raw.escalation && typeof raw.escalation === 'object') ? raw.escalation : {}),
    blockedTopics: Object.assign({}, d.blockedTopics, (raw.blockedTopics && typeof raw.blockedTopics === 'object') ? raw.blockedTopics : {}),
  };
}

// ------------------------------------------------------------
// Construit le prompt système envoyé à Gemini à partir des
// champs remplis dans la page "Contenu" du tableau de bord.
// ------------------------------------------------------------
function buildSystemPrompt(business) {
  let faqItems = [];
  try {
    faqItems = JSON.parse(business.faq || '[]');
  } catch {
    faqItems = [];
  }

  let prompt = `Tu es l'assistant virtuel de "${business.name}".`;
  if (business.sector) prompt += ` Secteur d'activité : ${business.sector}.`;

  if (business.intro && business.intro.trim()) {
    prompt += `\n\nÀ PROPOS DE L'ENTREPRISE :\n${business.intro.trim()}`;
  }
  if (business.pricing && business.pricing.trim()) {
    prompt += `\n\nTARIFS :\n${business.pricing.trim()}`;
  }
  if (business.hours && business.hours.trim()) {
    prompt += `\n\nHORAIRES :\n${business.hours.trim()}`;
  }
  if (faqItems.length) {
    prompt += `\n\nQUESTIONS FRÉQUENTES :\n` +
      faqItems.map((f) => `- Q : ${f.question}\n  R : ${f.answer}`).join('\n');
  }

  // Qualification : infos à collecter (page "Qualification") + sujets
  // toujours refusés. Le médical/juridique/financier est ajouté sans
  // condition, quelle que soit la config enregistrée par le client.
  const qualification = parseQualification(business);
  if (qualification.fields.length) {
    prompt += `\n\nINFORMATIONS À COLLECTER (une seule question à la fois, jamais toutes d'un coup) :\n` +
      qualification.fields.map((f) => {
        let line = `- ${f.label}`;
        if (f.when && String(f.when).trim()) line += ` : à demander ${String(f.when).trim()}`;
        if (f.required) line += ' (obligatoire)';
        return line;
      }).join('\n');
  }

  const blocked = qualification.blockedTopics || {};
  const blockedLines = ['Conseil médical', 'Conseil juridique', 'Conseil financier ou fiscal'];
  if (blocked.discount) blockedLines.push('Négociation de remise');
  if (blocked.contract) blockedLines.push('Engagement contractuel ferme');
  if (blocked.custom && String(blocked.custom).trim()) {
    String(blocked.custom).split(',').map((s) => s.trim()).filter(Boolean).forEach((topic) => blockedLines.push(topic));
  }
  prompt += `\n\nSUJETS QUE TU DOIS TOUJOURS REFUSER ET ORIENTER VERS UN HUMAIN :\n` +
    blockedLines.map((t) => `- ${t}`).join('\n');

  prompt +=
    `\n\nTON RÔLE :\n` +
    `1. Réponds UNIQUEMENT à partir des informations ci-dessus, n'invente jamais de chiffre ni de fait.\n` +
    `2. Si tu ne sais pas, dis-le plutôt que d'inventer.\n` +
    `3. Sois bref : 2 à 3 phrases maximum par réponse, pas de blabla d'introduction ni de récapitulatif.\n` +
    `4. Reste chaleureux et professionnel.`;

  return prompt.trim();
}

// Détecte une adresse email dans un message (signe qu'un visiteur devient un lead).
function extractEmail(text) {
  const match = String(text || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

// Détecte un numéro de téléphone français dans un message (mobile ou fixe,
// avec ou sans espaces/points/tirets, en format national 0X... ou +33X...).
function extractPhone(text) {
  const match = String(text || '').match(/(?:(?:\+33|0033)[\s.-]?|0)[1-9](?:[\s.-]?\d{2}){4}/);
  return match ? match[0] : null;
}

// ------------------------------------------------------------
// Proposition automatique de démo : sur le bot WHATGO lui-même (le nôtre,
// sur whatgo.ai — pas encore un réglage disponible par client), on propose
// une démo au visiteur dès son 3e message, avec une date précise calculée
// ici (jamais laissée à l'IA, qui pourrait halluciner un jour/heure faux),
// et on lui demande son email ET son téléphone pour confirmer.
// ------------------------------------------------------------
const DEMO_OFFER_SLUG = 'whatgo';
const DEMO_OFFER_AFTER_MESSAGES = 3;
const DEMO_OFFER_BUSINESS_DAYS_AHEAD = 3;
const DEMO_OFFER_HOUR = 14;

function nextBusinessDayAt(businessDaysAhead, hour) {
  const d = new Date();
  let added = 0;
  while (added < businessDaysAhead) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay(); // 0 = dimanche, 6 = samedi
    if (day !== 0 && day !== 6) added++;
  }
  d.setHours(hour, 0, 0, 0);
  return d;
}

function formatFrenchDateTime(date) {
  const dayLabel = date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  return `${dayLabel} à ${String(date.getHours()).padStart(2, '0')}h00`;
}

// Instruction de langue, ajoutée systématiquement pour TOUTES les
// entreprises : le bot détecte automatiquement la langue utilisée par le
// visiteur (à partir de ses messages) et répond dans cette même langue,
// sans jamais avoir besoin de le configurer par client. Par défaut (langue
// indétectable, premier message ambigu, etc.) on reste en français.
const LANGUAGE_INSTRUCTION =
  `\n\nINSTRUCTION DE LANGUE (permanente) : Détecte la langue utilisée par le visiteur dans ses messages ` +
  `et réponds toujours dans cette même langue, du début à la fin de la conversation. ` +
  `Si sa langue n'est pas claire (message trop court, mélange de langues...), réponds en français par défaut. ` +
  `Ne mentionne jamais explicitement que tu fais cette détection.`;

// Construit le prompt système à utiliser pour CET appel uniquement (ne
// modifie jamais business.system_prompt en base) : ajoute l'instruction de
// langue à chaque appel, puis l'instruction de proposition de démo si ce
// visiteur vient d'envoyer son 3e message (uniquement pour whatgo).
function buildSystemPromptForCall(business, messages) {
  const basePrompt = business.system_prompt + LANGUAGE_INSTRUCTION;

  if (business.slug !== DEMO_OFFER_SLUG) return basePrompt;

  const userMessageCount = messages.filter((m) => m.role === 'user').length;
  if (userMessageCount !== DEMO_OFFER_AFTER_MESSAGES) return basePrompt;

  const demoDateLabel = formatFrenchDateTime(nextBusinessDayAt(DEMO_OFFER_BUSINESS_DAYS_AHEAD, DEMO_OFFER_HOUR));
  return basePrompt +
    `\n\nINSTRUCTION POUR CETTE RÉPONSE UNIQUEMENT :\n` +
    `C'est le ${DEMO_OFFER_AFTER_MESSAGES}e message de ce visiteur. Propose-lui maintenant une démo de WHATGO AI, ` +
    `avec cette date précise : ${demoDateLabel}. Demande-lui de confirmer avec son email ET son numéro de téléphone ` +
    `pour que l'équipe puisse le recontacter et confirmer le créneau. Fais cette proposition dans la langue de la ` +
    `conversation en cours.`;
}

// Mots-clés FR laissant penser à une intention d'achat/contact forte.
const LEAD_INTENT_KEYWORDS = [
  'devis', 'tarif', 'prix', 'réserv', 'rendez-vous', 'rdv', 'disponibilité', 'urgent', 'contact',
];

// Heuristique de score v1 (PAS de machine learning) : un premier tri simple
// et honnête pour prioriser les leads, à affiner plus tard avec de vraies
// données. Base 40 (le visiteur a laissé un email = intention réelle),
// puis quelques bonus, le tout borné entre 20 et 95.
function computeLeadScore(message, isFirstUserMessage) {
  let score = 40;
  const text = String(message || '').toLowerCase();

  if (LEAD_INTENT_KEYWORDS.some((kw) => text.includes(kw))) score += 15;

  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount > 15) score += 10;

  // L'email n'est pas arrivé dès le premier message : le visiteur s'est
  // engagé un peu avant de convertir, signe d'un intérêt plus sérieux.
  if (!isFirstUserMessage) score += 10;

  return Math.max(20, Math.min(95, score));
}

// Envoie le lead vers Make/Zapier/etc. sans jamais bloquer ni casser la
// réponse du chatbot si le webhook est lent, en panne, ou mal configuré.
function sendLeadToWebhook(business, payload) {
  if (!business.webhook_url) return;
  fetch(business.webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error(`Erreur envoi webhook pour "${business.name}":`, err.message);
  });
}

// Envoie un signal d'escalade vers Make/Zapier, même mécanisme que
// sendLeadToWebhook (fire-and-forget, réutilise business.webhook_url).
// L'envoi réel de l'email/SMS ("Prévenir par email/SMS") n'est PAS fait
// par ce serveur : WHATGO ne branche pas de SMTP/Twilio ici, c'est au
// founder de le câbler lui-même dans son propre scénario Make à partir
// de ce webhook — cohérent avec le fonctionnement des leads.
function sendEscalationToWebhook(business, payload) {
  if (!business.webhook_url) return;
  fetch(business.webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ type: 'escalation' }, payload)),
  }).catch((err) => {
    console.error(`Erreur envoi webhook d'escalade pour "${business.name}":`, err.message);
  });
}

// Mots-clés déclenchant chaque type d'escalade. Heuristique v1
// déterministe, par mots-clés — PAS de NLP/ML. Un premier filet de
// sécurité honnête, à affiner avec de vrais cas plutôt qu'à prétendre
// détecter l'intention ou le ton avec finesse.
const ESCALATION_HUMAN_KEYWORDS = ['humain', 'conseiller', "quelqu'un d'autre", 'une personne', 'un agent'];
const ESCALATION_ANGRY_KEYWORDS = ['inadmissible', 'scandaleux', 'en colère', 'insupportable', 'réclamation', 'plainte', 'remboursez', 'honteux'];
const ESCALATION_DISPUTE_KEYWORDS = ['litige', 'remboursement', 'avocat', 'procédure'];
const ESCALATION_UNKNOWN_MARKERS = ['je ne sais pas', "je n'ai pas cette information", 'je ne peux pas répondre à cela'];

// Détecte si l'échange qui vient d'avoir lieu doit déclencher une
// escalade vers un humain, selon ce que le client a activé dans la
// page "Qualification". Ne vérifie que le tour en cours (dernier
// message visiteur + 3 derniers messages assistant) : appelée une
// seule fois par appel à /api/chat, donc pas de risque de déclencher
// plusieurs fois la même raison pour le même échange.
async function detectEscalation(business, config, lastUserMessage, convoId) {
  const reasons = [];
  const text = String(lastUserMessage || '').toLowerCase();
  const esc = (config && config.escalation) || {};

  if (esc.askHuman && ESCALATION_HUMAN_KEYWORDS.some((kw) => text.includes(kw))) {
    reasons.push('Le visiteur demande explicitement un humain');
  }

  if (esc.angryTone && ESCALATION_ANGRY_KEYWORDS.some((kw) => text.includes(kw))) {
    reasons.push('Ton agacé ou réclamation détecté');
  }

  if (esc.dispute && ESCALATION_DISPUTE_KEYWORDS.some((kw) => text.includes(kw))) {
    reasons.push('Question sur un litige ou un remboursement');
  }

  if (esc.bigAmount) {
    const threshold = Number(esc.bigAmountValue) || 0;
    const numbers = (text.match(/\d[\d\s.,]*/g) || [])
      .map((n) => Number(n.replace(/[\s.,]/g, '')))
      .filter((n) => !Number.isNaN(n));
    if (numbers.some((n) => n > threshold)) {
      reasons.push(`Montant évoqué supérieur à ${threshold} €`);
    }
  }

  if (esc.threeUnknown && convoId) {
    const { rows: lastThree } = await query(
      `SELECT content FROM messages WHERE conversation_id = $1 AND role = 'assistant' ORDER BY created_at DESC, id DESC LIMIT 3`,
      [convoId]
    );
    if (lastThree.length === 3 && lastThree.every((m) => {
      const c = String(m.content || '').toLowerCase();
      return ESCALATION_UNKNOWN_MARKERS.some((marker) => c.includes(marker));
    })) {
      reasons.push('Trois réponses « je ne sais pas » d\'affilée');
    }
  }

  return reasons;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Appelle Gemini avec une logique de réessai automatique : si l'API répond
// une erreur 503 "UNAVAILABLE" (surcharge temporaire chez Google), on
// retente jusqu'à 2 fois avec un court délai avant d'abandonner. Les autres
// erreurs (clé API invalide, requête mal formée, etc.) ne sont PAS retentées,
// puisqu'elles ne se résoudraient pas d'elles-mêmes.
async function callGemini(systemPrompt, contents, maxRetries = 3) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let data;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
        }),
      });
      data = await response.json();
    } catch (networkErr) {
      // Erreur réseau (timeout, coupure...) : on retente pareil qu'une surcharge.
      if (attempt < maxRetries) {
        console.warn(`Gemini injoignable (tentative ${attempt + 1}/${maxRetries + 1}), nouvel essai...`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw networkErr;
    }

    const isOverloaded = data.error && (data.error.code === 503 || data.error.status === 'UNAVAILABLE');
    if (isOverloaded && attempt < maxRetries) {
      console.warn(`Gemini surchargé (tentative ${attempt + 1}/${maxRetries + 1}), nouvel essai dans ${1000 * (attempt + 1)}ms...`);
      await sleep(1000 * (attempt + 1)); // 1s, puis 2s, puis 3s
      continue;
    }

    return data; // succès, ou erreur définitive (pas une surcharge) qu'on remonte telle quelle
  }
}

// Appelle Groq (API compatible OpenAI) en secours, uniquement quand
// Gemini a échoué. Reprend le même "contents" (format Gemini) et le
// convertit au format attendu par Groq. Si GROQ_API_KEY n'est pas
// configurée, on ne tente rien et on laisse l'appelant gérer l'échec
// Gemini normalement (comme avant l'ajout du fallback).
async function callGroqFallback(systemPrompt, contents) {
  if (!GROQ_API_KEY) return null;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...contents.map((c) => ({
      role: c.role === 'model' ? 'assistant' : 'user',
      content: c.parts?.[0]?.text || '',
    })),
  ];

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({ model: GROQ_MODEL, messages }),
  });
  const data = await response.json();

  if (data.error) {
    // On loggue le statut HTTP + l'objet d'erreur complet (pas juste le
    // message) pour distinguer un souci de clé (401) d'un souci de modèle.
    console.error(`Détail erreur Groq (HTTP ${response.status}):`, JSON.stringify(data.error));
    throw new Error(data.error.message || 'Erreur inconnue côté Groq');
  }

  return data.choices?.[0]?.message?.content || null;
}

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ============================================================
// 1) ROUTE PUBLIQUE — le widget parle ici (une entreprise à la fois)
// ============================================================
app.post('/api/chat', async (req, res) => {
  try {
    // Anti-abus : évite qu'un visiteur (ou un script) fasse exploser la
    // facture Gemini/Groq en spammant le chat. 20 messages/minute/IP laisse
    // large pour un vrai visiteur, tout en bloquant un usage automatisé.
    if (isRateLimited(`chat:${clientIp(req)}`, 20, 60 * 1000)) {
      return res.status(429).json({ error: 'Trop de messages envoyés trop rapidement. Merci de patienter une minute.' });
    }

    const { messages, business: slug, conversationId } = req.body;

    if (!slug) {
      return res.status(400).json({ error: 'Aucune entreprise spécifiée (data-business manquant sur le widget).' });
    }

    const { rows: businessRows } = await query('SELECT * FROM businesses WHERE slug = $1', [slug]);
    const business = businessRows[0];
    if (!business) {
      return res.status(404).json({ error: 'Entreprise inconnue.' });
    }

    // Retrouver ou créer la conversation, pour pouvoir tout enregistrer
    let convoId = conversationId;
    if (!convoId) {
      const { rows } = await query(
        'INSERT INTO conversations (business_id, visitor_label) VALUES ($1, $2) RETURNING id',
        [business.id, 'Visiteur anonyme']
      );
      convoId = rows[0].id;
    }

    // Enregistrer le dernier message du visiteur
    const lastUserMessage = messages[messages.length - 1];
    await query(
      'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
      [convoId, 'user', lastUserMessage.content]
    );

    // Lead qualifié : le visiteur vient de laisser un email et/ou un
    // téléphone. Les deux arrivent souvent en 2 messages séparés (email
    // d'abord, puis téléphone quand le bot le demande pour confirmer une
    // démo — ou l'inverse). On regarde d'abord s'il existe déjà un lead
    // pour CETTE conversation : si oui on complète les champs manquants,
    // si non on en crée un — avec ce qu'on a, même si c'est le téléphone
    // seul (avant, un téléphone seul sans email préalable n'était jamais
    // enregistré : c'était le bug).
    const newEmail = extractEmail(lastUserMessage.content);
    const newPhone = extractPhone(lastUserMessage.content);
    if (newEmail || newPhone) {
      const { rows: existingLeadRows } = await query(
        `SELECT id, email, phone FROM leads WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [convoId]
      );
      const existingLead = existingLeadRows[0];

      if (!existingLead) {
        // Premier email et/ou téléphone de cette conversation : nouveau lead.
        const priorUserMessages = messages.slice(0, -1).filter((m) => m.role === 'user');
        const score = computeLeadScore(lastUserMessage.content, priorUserMessages.length === 0);
        await query(
          `INSERT INTO leads (business_id, conversation_id, email, phone, message, score, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'nouveau')`,
          [business.id, convoId, newEmail || null, newPhone || null, lastUserMessage.content, score]
        );
        sendLeadToWebhook(business, {
          business: business.name,
          slug: business.slug,
          conversationId: convoId,
          email: newEmail || '',
          phone: newPhone || '',
          message: lastUserMessage.content,
          date: new Date().toISOString(),
        });
      } else {
        // Lead déjà existant pour cette conversation : on ne complète que
        // les champs qui manquaient encore (jamais on n'écrase un email ou
        // un téléphone déjà enregistré).
        const fieldsToUpdate = [];
        const params = [];
        let i = 1;
        if (newEmail && !existingLead.email) { fieldsToUpdate.push(`email = $${i++}`); params.push(newEmail); }
        if (newPhone && !existingLead.phone) { fieldsToUpdate.push(`phone = $${i++}`); params.push(newPhone); }

        if (fieldsToUpdate.length) {
          params.push(existingLead.id);
          await query(`UPDATE leads SET ${fieldsToUpdate.join(', ')}, updated_at = NOW() WHERE id = $${i}`, params);
          sendLeadToWebhook(business, {
            business: business.name,
            slug: business.slug,
            conversationId: convoId,
            email: newEmail || existingLead.email || '',
            phone: newPhone || existingLead.phone || '',
            message: lastUserMessage.content,
            date: new Date().toISOString(),
            type: 'lead_updated',
          });
        }
      }
    }

    // Entreprise pas encore publiée : réponse d'attente, pas d'appel à Gemini
    // (évite d'improviser avec un contenu vide ou incomplet).
    if (business.status !== 'published') {
      await query(
        'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
        [convoId, 'assistant', DRAFT_REPLY]
      );
      return res.json({ reply: DRAFT_REPLY, conversationId: convoId });
    }

    // Gemini attend "contents" avec des "parts", et le rôle de l'IA
    // s'appelle "model", pas "assistant".
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    // Prompt enrichi pour CET appel seulement (ex : proposition de démo au
    // 3e message sur le bot WHATGO) — business.system_prompt en base ne
    // change jamais.
    const systemPromptForCall = buildSystemPromptForCall(business, messages);
    const data = await callGemini(systemPromptForCall, contents);

    let reply;
    let usedFallback = false;
    if (data.error) {
      console.error('Erreur API Gemini:', data.error);
      // Gemini a échoué après ses tentatives (souvent une surcharge 503) :
      // on tente le fallback Groq avant d'abandonner, pour que le visiteur
      // ait quand même une réponse plutôt qu'un message d'erreur.
      let fallbackReply = null;
      try {
        fallbackReply = await callGroqFallback(systemPromptForCall, contents);
      } catch (fallbackErr) {
        console.error('Erreur fallback Groq:', fallbackErr.message);
      }

      if (fallbackReply) {
        console.warn(`Bascule sur Groq réussie pour "${business.name}".`);
        reply = fallbackReply;
        usedFallback = true;
      } else {
        return res.status(500).json({ error: data.error.message });
      }
    } else {
      reply = data.candidates?.[0]?.content?.parts?.[0]?.text
        || "Désolé, je n'ai pas pu répondre.";
    }

    // Enregistrer la réponse de l'IA aussi (avec le marqueur used_fallback,
    // visible seulement côté équipe WHATGO, pour suivre à quel point ce
    // secours est réellement sollicité en production).
    await query(
      'INSERT INTO messages (conversation_id, role, content, used_fallback) VALUES ($1, $2, $3, $4)',
      [convoId, 'assistant', reply, usedFallback]
    );

    // Escalade vers un humain (page "Qualification") : uniquement sur les
    // entreprises publiées, une fois l'échange complet enregistré.
    const qualification = parseQualification(business);
    const escalationReasons = await detectEscalation(business, qualification, lastUserMessage.content, convoId);
    if (escalationReasons.length) {
      sendEscalationToWebhook(business, {
        business: business.name,
        slug: business.slug,
        conversationId: convoId,
        reason: escalationReasons,
        notifyEmail: qualification.escalation.notifyEmail,
        notifyPhone: qualification.escalation.notifyPhone,
        lastMessage: lastUserMessage.content,
        date: new Date().toISOString(),
      });
    }

    res.json({ reply, conversationId: convoId });

  } catch (err) {
    console.error('Erreur /api/chat:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// ============================================================
// 2) CONNEXION — un employé d'une entreprise, OU un super-admin WHATGO
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  try {
    // Anti-abus : ralentit le brute-force de mot de passe (8 tentatives
    // toutes les 15 minutes par IP), sans jamais bloquer un vrai utilisateur
    // qui se trompe une ou deux fois.
    if (isRateLimited(`login:${clientIp(req)}`, 8, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Trop de tentatives de connexion. Réessayez dans quelques minutes.' });
    }

    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis.' });
    }

    // On regarde d'abord côté équipe WHATGO (super-admin)
    const { rows: superAdmins } = await query('SELECT * FROM super_admins WHERE email = $1', [email]);
    const superAdmin = superAdmins[0];
    if (superAdmin && (await verifyPassword(password, superAdmin.password_hash))) {
      const token = signToken({ id: superAdmin.id, business_id: null, role: 'super_admin' });
      res.cookie('whatgo_token', token, {
        httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      return res.json({ email: superAdmin.email, role: 'super_admin', business: 'WHATGO (équipe)' });
    }

    // Sinon, compte client classique
    const { rows: users } = await query('SELECT * FROM users WHERE email = $1', [email]);
    const user = users[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    }

    const token = signToken(user);
    res.cookie('whatgo_token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    const { rows: businessRows } = await query('SELECT name FROM businesses WHERE id = $1', [user.business_id]);
    res.json({ email: user.email, role: user.role, business: businessRows[0].name });
  } catch (err) {
    console.error('Erreur /api/auth/login:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('whatgo_token');
  res.json({ ok: true });
});

// Mot de passe oublié : demande le lien par email. Répond TOUJOURS pareil,
// que l'email corresponde à un compte ou non — sinon on révèle quels
// comptes existent à quiconque essaie des adresses au hasard.
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    if (isRateLimited(`forgot:${clientIp(req)}`, 5, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Trop de demandes. Réessayez plus tard.' });
    }

    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email requis.' });

    const { rows: userRows } = await query('SELECT id FROM users WHERE email = $1', [email]);
    const { rows: adminRows } = await query('SELECT id FROM super_admins WHERE email = $1', [email]);
    const account = userRows[0] || adminRows[0];
    const table = userRows[0] ? 'users' : 'super_admins';

    if (account) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(token);
      const expires = new Date(Date.now() + 60 * 60 * 1000); // valable 1h
      await query(`UPDATE ${table} SET reset_token_hash = $1, reset_token_expires = $2 WHERE id = $3`, [tokenHash, expires, account.id]);

      const resetLink = `${APP_URL}/reset-password.html?token=${token}&email=${encodeURIComponent(email)}`;
      await sendPasswordResetEmail(email, resetLink);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur /api/auth/forgot-password:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// Choix du nouveau mot de passe à partir du lien reçu par email.
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;
    if (!email || !token || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Lien invalide ou mot de passe trop court (8 caractères minimum).' });
    }

    const emailLower = String(email).trim().toLowerCase();
    const tokenHash = hashResetToken(token);

    const { rows: userRows } = await query('SELECT * FROM users WHERE email = $1', [emailLower]);
    const { rows: adminRows } = await query('SELECT * FROM super_admins WHERE email = $1', [emailLower]);
    const account = userRows[0] || adminRows[0];
    const table = userRows[0] ? 'users' : 'super_admins';

    const valid = account
      && account.reset_token_hash === tokenHash
      && account.reset_token_expires
      && new Date(account.reset_token_expires) > new Date();

    if (!valid) {
      return res.status(400).json({ error: 'Ce lien de réinitialisation est invalide ou a expiré. Refaites une demande.' });
    }

    const hash = await hashPassword(newPassword);
    await query(`UPDATE ${table} SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = $2`, [hash, account.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur /api/auth/reset-password:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.put('/api/auth/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Mot de passe actuel requis, et nouveau mot de passe d\'au moins 8 caractères.' });
    }

    const table = req.user.role === 'super_admin' ? 'super_admins' : 'users';
    const { rows } = await query(`SELECT * FROM ${table} WHERE id = $1`, [req.user.userId]);
    const account = rows[0];
    if (!account || !(await verifyPassword(currentPassword, account.password_hash))) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
    }

    const hash = await hashPassword(newPassword);
    await query(`UPDATE ${table} SET password_hash = $1 WHERE id = $2`, [hash, req.user.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur /api/auth/password:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// ============================================================
// 3) TABLEAU DE BORD CLIENT — routes protégées, filtrées par entreprise
// ============================================================
app.get('/api/dashboard/me', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'super_admin') {
      return res.json({ role: 'super_admin', business: 'WHATGO (équipe)' });
    }
    const { rows } = await query('SELECT name, status FROM businesses WHERE id = $1', [req.user.businessId]);
    const business = rows[0];
    res.json({ role: req.user.role, business: business.name, status: business.status });
  } catch (err) {
    console.error('Erreur /api/dashboard/me:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.get('/api/dashboard/conversations', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const { rows: conversations } = await query(`
      SELECT c.id, c.visitor_label, c.started_at,
             COUNT(m.id) as message_count
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.business_id = $1
      GROUP BY c.id
      ORDER BY c.started_at DESC
      LIMIT 200
    `, [req.user.businessId]);

    res.json(conversations);
  } catch (err) {
    console.error('Erreur /api/dashboard/conversations:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.get('/api/dashboard/conversations/:id', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const { rows: convoRows } = await query('SELECT * FROM conversations WHERE id = $1', [req.params.id]);
    const convo = convoRows[0];

    if (!convo || convo.business_id !== req.user.businessId) {
      return res.status(404).json({ error: 'Conversation introuvable.' });
    }

    const { rows: messages } = await query(
      'SELECT role, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );

    res.json({ conversation: convo, messages });
  } catch (err) {
    console.error('Erreur /api/dashboard/conversations/:id:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// Page "Leads" : les contacts qualifiés captés via le chat (email laissé).
const LEAD_STATUSES = ['nouveau', 'contacte', 'rdv_pris', 'gagne', 'perdu'];

app.get('/api/dashboard/leads', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const { rows: leads } = await query(`
      SELECT id, email, phone, message, score, status, conversation_id, created_at
      FROM leads
      WHERE business_id = $1
      ORDER BY created_at DESC
    `, [req.user.businessId]);

    res.json(leads.map((l) => ({
      id: l.id,
      email: l.email,
      phone: l.phone || '',
      message: l.message,
      score: l.score,
      status: l.status,
      conversationId: l.conversation_id,
      createdAt: l.created_at,
    })));
  } catch (err) {
    console.error('Erreur /api/dashboard/leads:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// Export CSV des leads de l'entreprise connectée — ouvre/télécharge
// directement un fichier .csv (Excel, Google Sheets, etc. l'ouvrent nativement).
// Simple échappement CSV : on double les guillemets internes et on entoure
// chaque champ de guillemets, ce qui suffit à gérer virgules/retours à la ligne.
function csvField(value) {
  return '"' + String(value ?? '').replace(/"/g, '""') + '"';
}

app.get('/api/dashboard/leads/export.csv', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const { rows: leads } = await query(`
      SELECT email, phone, message, score, status, created_at
      FROM leads
      WHERE business_id = $1
      ORDER BY created_at DESC
    `, [req.user.businessId]);

    const header = ['Email', 'Téléphone', 'Message', 'Score', 'Statut', 'Date'].map(csvField).join(',');
    const lines = leads.map((l) => [
      csvField(l.email),
      csvField(l.phone || ''),
      csvField(l.message || ''),
      csvField(l.score),
      csvField(l.status),
      csvField(new Date(l.created_at).toLocaleString('fr-FR')),
    ].join(','));

    // ﻿ (BOM) devant : évite que les accents s'affichent mal quand le
    // fichier est ouvert directement dans Excel.
    const csv = '﻿' + [header, ...lines].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Erreur /api/dashboard/leads/export.csv:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.put('/api/dashboard/leads/:id/status', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!LEAD_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Statut invalide.' });
    }

    const { rows } = await query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    const lead = rows[0];
    if (!lead || lead.business_id !== req.user.businessId) {
      return res.status(404).json({ error: 'Lead introuvable.' });
    }

    await query('UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2', [status, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur /api/dashboard/leads/:id/status:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// Statistiques pour la vue d'ensemble du tableau de bord
app.get('/api/dashboard/stats', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const businessId = req.user.businessId;

    const { rows: totalsRows } = await query(`
      SELECT
        (SELECT COUNT(*) FROM conversations WHERE business_id = $1) as total_conversations,
        (SELECT COUNT(*) FROM conversations WHERE business_id = $1 AND started_at >= NOW() - INTERVAL '30 days') as conversations_30d,
        (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.business_id = $1) as total_messages
    `, [businessId]);
    const totals = totalsRows[0];

    const { rows: perDayRows } = await query(`
      SELECT date(started_at) as day, COUNT(*) as count
      FROM conversations
      WHERE business_id = $1 AND started_at >= NOW() - INTERVAL '13 days'
      GROUP BY day
      ORDER BY day ASC
    `, [businessId]);

    // On complète les jours sans conversation avec un compteur à 0,
    // pour que le graphique ait toujours 14 barres alignées sur les 14 derniers jours.
    const perDay = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const found = perDayRows.find((r) => {
        const rowKey = (r.day instanceof Date) ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
        return rowKey === key;
      });
      perDay.push({ day: key, count: found ? Number(found.count) : 0 });
    }

    const totalConversations = Number(totals.total_conversations);
    const totalMessages = Number(totals.total_messages);
    const avgMessages = totalConversations
      ? Math.round((totalMessages / totalConversations) * 10) / 10
      : 0;

    res.json({
      totalConversations,
      conversations30d: Number(totals.conversations_30d),
      avgMessagesPerConversation: avgMessages,
      perDay,
    });
  } catch (err) {
    console.error('Erreur /api/dashboard/stats:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// Page "Contenu" : lecture et modification de la FAQ, tarifs, horaires...
app.get('/api/dashboard/content', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM businesses WHERE id = $1', [req.user.businessId]);
    const b = rows[0];
    let faq = [];
    try { faq = JSON.parse(b.faq || '[]'); } catch { faq = []; }
    res.json({
      name: b.name,
      slug: b.slug,
      sector: b.sector || '',
      status: b.status,
      intro: b.intro || '',
      faq,
      pricing: b.pricing || '',
      hours: b.hours || '',
    });
  } catch (err) {
    console.error('Erreur GET /api/dashboard/content:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.put('/api/dashboard/content', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { sector, intro, faq, pricing, hours } = req.body;
    const faqArr = Array.isArray(faq)
      ? faq.filter((f) => f && f.question && f.answer)
      : [];

    const { rows } = await query('SELECT * FROM businesses WHERE id = $1', [req.user.businessId]);
    const business = rows[0];
    const updated = {
      ...business,
      sector: sector || '',
      intro: intro || '',
      faq: JSON.stringify(faqArr),
      pricing: pricing || '',
      hours: hours || '',
    };
    const newSystemPrompt = buildSystemPrompt(updated);

    await query(`
      UPDATE businesses
      SET sector = $1, intro = $2, faq = $3, pricing = $4, hours = $5, system_prompt = $6
      WHERE id = $7
    `, [sector || '', intro || '', JSON.stringify(faqArr), pricing || '', hours || '', newSystemPrompt, req.user.businessId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur PUT /api/dashboard/content:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// Page "Qualification" : infos à collecter, seuils de score, escalade
// vers un humain, sujets bloqués. Influence directement le prompt envoyé
// à Gemini (buildSystemPrompt) et la détection d'escalade dans /api/chat.
app.get('/api/dashboard/qualification', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const { rows } = await query('SELECT qualification FROM businesses WHERE id = $1', [req.user.businessId]);
    res.json(parseQualification(rows[0]));
  } catch (err) {
    console.error('Erreur GET /api/dashboard/qualification:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.put('/api/dashboard/qualification', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const defaults = defaultQualification();

    const fields = Array.isArray(body.fields)
      ? body.fields
          .filter((f) => f && String(f.label || '').trim())
          .map((f) => ({
            id: String(f.id || ('f' + Math.random().toString(36).slice(2, 9))),
            label: String(f.label).trim(),
            when: String(f.when || '').trim(),
            points: Math.max(0, Math.min(100, Math.round(Number(f.points)) || 0)),
            required: !!f.required,
          }))
      : [];

    const thresholdsIn = (body.thresholds && typeof body.thresholds === 'object') ? body.thresholds : {};
    const clampPct = (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : fallback;
    };
    const thresholds = {
      hot: clampPct(thresholdsIn.hot, defaults.thresholds.hot),
      warm: clampPct(thresholdsIn.warm, defaults.thresholds.warm),
      appointment: clampPct(thresholdsIn.appointment, defaults.thresholds.appointment),
    };

    const escIn = (body.escalation && typeof body.escalation === 'object') ? body.escalation : {};
    const escalation = {
      askHuman: !!escIn.askHuman,
      threeUnknown: !!escIn.threeUnknown,
      angryTone: !!escIn.angryTone,
      bigAmount: !!escIn.bigAmount,
      bigAmountValue: Math.max(0, Number(escIn.bigAmountValue) || 0) || defaults.escalation.bigAmountValue,
      dispute: !!escIn.dispute,
      notifyEmail: String(escIn.notifyEmail || '').trim(),
      notifyPhone: String(escIn.notifyPhone || '').trim(),
    };

    // Sujets bloqués : le médical/juridique/financier n'est même pas
    // accepté ici, il est codé en dur dans buildSystemPrompt.
    const blockedIn = (body.blockedTopics && typeof body.blockedTopics === 'object') ? body.blockedTopics : {};
    const blockedTopics = {
      discount: !!blockedIn.discount,
      contract: !!blockedIn.contract,
      custom: String(blockedIn.custom || '').trim().slice(0, 500),
    };

    const qualification = { fields, thresholds, escalation, blockedTopics };

    const { rows } = await query('SELECT * FROM businesses WHERE id = $1', [req.user.businessId]);
    const business = rows[0];
    const updated = { ...business, qualification: JSON.stringify(qualification) };
    const newSystemPrompt = buildSystemPrompt(updated);

    await query(`
      UPDATE businesses
      SET qualification = $1, system_prompt = $2
      WHERE id = $3
    `, [JSON.stringify(qualification), newSystemPrompt, req.user.businessId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur PUT /api/dashboard/qualification:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// Page "Intégrations" : où envoyer les leads qualifiés (via Make/Zapier...)
app.get('/api/dashboard/webhook', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const { rows } = await query('SELECT webhook_url FROM businesses WHERE id = $1', [req.user.businessId]);
    res.json({ webhookUrl: rows[0].webhook_url || '' });
  } catch (err) {
    console.error('Erreur GET /api/dashboard/webhook:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.put('/api/dashboard/webhook', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { webhookUrl } = req.body;
    const value = (webhookUrl || '').trim();
    if (value && !/^https:\/\//.test(value)) {
      return res.status(400).json({ error: 'L\'adresse doit commencer par https://' });
    }
    await query('UPDATE businesses SET webhook_url = $1 WHERE id = $2', [value, req.user.businessId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur PUT /api/dashboard/webhook:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// ============================================================
// 4) ESPACE ÉQUIPE WHATGO — création et pilotage des clients
// ============================================================
app.get('/api/superadmin/clients', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { rows: clients } = await query(`
      SELECT b.id, b.slug, b.name, b.status, b.sector, b.created_at,
             COUNT(c.id) as conversation_count
      FROM businesses b
      LEFT JOIN conversations c ON c.business_id = b.id
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `);
    res.json(clients);
  } catch (err) {
    console.error('Erreur GET /api/superadmin/clients:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// Taux d'utilisation du secours Groq, tous clients confondus — réservé à
// l'équipe WHATGO (les clients n'ont aucune raison de savoir qu'un secours
// existe, encore moins à quelle fréquence il est déclenché).
app.get('/api/superadmin/stats/fallback', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as total_30d,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND used_fallback) as fallback_30d,
        COUNT(*) as total_all,
        COUNT(*) FILTER (WHERE used_fallback) as fallback_all
      FROM messages
      WHERE role = 'assistant'
    `);
    const r = rows[0];
    res.json({
      total30d: Number(r.total_30d),
      fallback30d: Number(r.fallback_30d),
      totalAll: Number(r.total_all),
      fallbackAll: Number(r.fallback_all),
    });
  } catch (err) {
    console.error('Erreur GET /api/superadmin/stats/fallback:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.post('/api/superadmin/clients', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { name, sector, adminEmail, adminPassword } = req.body;
    if (!name || !adminEmail || !adminPassword) {
      return res.status(400).json({ error: 'Nom de l\'entreprise, email et mot de passe admin sont requis.' });
    }
    if (adminPassword.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }

    let slug = slugify(name);
    if (!slug) slug = 'client';
    let finalSlug = slug;
    let attempt = 1;
    while (true) {
      const { rows } = await query('SELECT id FROM businesses WHERE slug = $1', [finalSlug]);
      if (!rows[0]) break;
      attempt += 1;
      finalSlug = `${slug}-${attempt}`;
    }

    const placeholderPrompt = `Tu es l'assistant virtuel de "${name}". Le contenu n'a pas encore été renseigné par l'équipe WHATGO.`;

    const { rows: insertedBusiness } = await query(`
      INSERT INTO businesses (slug, name, system_prompt, status, sector)
      VALUES ($1, $2, $3, 'draft', $4)
      RETURNING id
    `, [finalSlug, name, placeholderPrompt, sector || '']);
    const businessId = insertedBusiness[0].id;

    try {
      const hash = await hashPassword(adminPassword);
      await query(`
        INSERT INTO users (business_id, email, password_hash, role) VALUES ($1, $2, $3, 'admin')
      `, [businessId, adminEmail, hash]);
    } catch (err) {
      await query('DELETE FROM businesses WHERE id = $1', [businessId]);
      if (err.code === '23505') { // unique_violation (Postgres)
        return res.status(409).json({ error: 'Cet email est déjà utilisé par un autre compte.' });
      }
      throw err;
    }

    res.status(201).json({
      id: businessId,
      slug: finalSlug,
      name,
      status: 'draft',
      snippet: `<script src="https://whatgo-server.onrender.com/widget.js" data-server="https://whatgo-server.onrender.com/api/chat" data-business="${finalSlug}" data-name="${name}"></script>`,
    });
  } catch (err) {
    console.error('Erreur POST /api/superadmin/clients:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.put('/api/superadmin/clients/:id/status', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['draft', 'published'].includes(status)) {
      return res.status(400).json({ error: 'Statut invalide.' });
    }
    const { rows } = await query('SELECT * FROM businesses WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Entreprise introuvable.' });

    await query('UPDATE businesses SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur PUT /api/superadmin/clients/:id/status:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

const PORT = process.env.PORT || 3000;

// ============================================================
// AUTO-CRÉATION : s'assure que "WHATGO AI" et un compte admin
// existent toujours, même sur un serveur tout neuf (comme Render)
// ============================================================
async function ensureWhatgoBusiness() {
  const { rows } = await query('SELECT * FROM businesses WHERE slug = $1', ['whatgo']);
  const existing = rows[0];

  if (!existing) {
    const prompt = `
Tu es l'assistant virtuel de WHATGO AI, sur le site whatgo.ai. Tu réponds aux
visiteurs qui découvrent le produit et se posent des questions avant de s'inscrire.

INFORMATIONS SUR WHATGO AI :
- Ce que c'est : un chatbot IA installé directement sur le site web d'une entreprise,
  entraîné sur son catalogue/FAQ, qui répond aux visiteurs et qualifie chaque contact
  dans son CRM.
- Différence avec les autres outils : la configuration est faite par l'équipe WHATGO,
  pas par le client lui-même.
- Secteurs ciblés : hôtellerie, services locaux, e-commerce.
- Tarifs : Starter 40€/mois (~100 conversations), Growth 149€/mois (~600 conversations),
  Scale sur devis.
- Mise en place gratuite, faite par l'équipe, généralement sous 24 à 48h.
- Essai : 14 jours gratuits, sans carte bancaire.
- Options à venir : WhatsApp et IA vocale.

TON RÔLE :
1. Réponds UNIQUEMENT à partir des informations ci-dessus, n'invente jamais de chiffre.
2. Si le visiteur semble intéressé, propose de laisser son email ou de démarrer l'essai.
3. Sois TRÈS bref : 2 phrases maximum par réponse (3 seulement si vraiment nécessaire).
   Va droit au but, pas de blabla d'introduction ni de récapitulatif à la fin.
4. Reste chaleureux et professionnel, mais sans formules de politesse superflues.
`.trim();

    const { rows: inserted } = await query(
      "INSERT INTO businesses (slug, name, system_prompt, status, sector) VALUES ($1, $2, $3, 'published', $4) RETURNING id",
      ['whatgo', 'WHATGO AI', prompt, 'SaaS']
    );

    const hash = await hashPassword('motdepasse123');
    await query(
      'INSERT INTO users (business_id, email, password_hash, role) VALUES ($1, $2, $3, $4)',
      [inserted[0].id, 'admin@whatgo.ai', hash, 'admin']
    );

    console.log('✅ Entreprise WHATGO créée automatiquement (admin@whatgo.ai / motdepasse123)');
  } else {
    console.log('ℹ️  Entreprise WHATGO déjà présente, rien à faire.');
  }
}

// ============================================================
// AUTO-CRÉATION : compte super-admin par défaut pour l'équipe WHATGO
// (identifiants personnalisables via variables d'environnement Render)
// ============================================================
async function ensureSuperAdmin() {
  const email = process.env.SUPERADMIN_EMAIL || 'equipe@whatgo.ai';
  const password = process.env.SUPERADMIN_PASSWORD || 'whatgo-superadmin-2026';

  const { rows } = await query('SELECT * FROM super_admins WHERE email = $1', [email]);
  const existing = rows[0];
  if (!existing) {
    const hash = await hashPassword(password);
    await query('INSERT INTO super_admins (email, password_hash) VALUES ($1, $2)', [email, hash]);
    console.log(`✅ Compte super-admin créé (${email} / ${password}) — pensez à changer ce mot de passe depuis le tableau de bord.`);
  } else {
    console.log('ℹ️  Compte super-admin déjà présent, rien à faire.');
  }
}

// ============================================================
// DÉMARRAGE : on attend que la base soit prête (schéma créé) et que
// les comptes par défaut existent avant d'ouvrir le port. Si la base
// n'est pas joignable (DATABASE_URL manquant/erroné), le serveur ne
// démarre pas silencieusement à moitié cassé — l'erreur s'affiche.
// ============================================================
async function start() {
  try {
    await initDb();
    await ensureWhatgoBusiness();
    await ensureSuperAdmin();
    app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT} (Gemini + tableau de bord)`));
  } catch (err) {
    console.error('❌ Impossible de démarrer le serveur (problème de connexion à la base ?) :', err);
    process.exit(1);
  }
}

start();
