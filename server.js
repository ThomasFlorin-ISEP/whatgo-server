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
app.use(express.json({ limit: '7mb' })); // photos envoyées dans le chat
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
// Construit le prompt système envoyé à Gemini à partir des champs du
// tableau de bord. Les anciens champs de la page "Contenu" (supprimée du
// dashboard) restent pris en compte pour ne rien perdre chez les clients
// existants ; les "Instructions spécifiques" (Base de connaissances) s'y
// ajoutent.
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
  if (business.instructions && business.instructions.trim()) {
    prompt += `\n\nINSTRUCTIONS SPÉCIFIQUES DE L'ENTREPRISE (à respecter en priorité sur les informations ci-dessus, ` +
      `sauf si elles contredisent les sujets interdits ou les règles de sécurité) :\n${business.instructions.trim()}`;
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
// Fiche lead : nom détecté + résumé du besoin généré par l'IA.
// ------------------------------------------------------------
// Détecte un prénom (et éventuellement un nom) quand le visiteur se présente
// ("je m'appelle Marc", "moi c'est Julie Martin", "mon nom est...", "my name
// is..."). Volontairement prudent : mieux vaut ne rien détecter (l'équipe
// peut toujours saisir le nom à la main dans la fiche) que d'enregistrer
// "Pour" à partir de "moi c'est pour un devis".
const NAME_INTRO_REGEX = /(?:je\s+m['’]\s*appelle|moi\s*,?\s*c['’]\s*est|mon\s+(?:pr[ée]nom|nom)\s+(?:est|c['’]est)|my\s+name\s+is)\s+([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’-]*(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’-]*)?)/i;
const NAME_STOPWORDS = new Set([
  'pour', 'un', 'une', 'le', 'la', 'les', 'pas', 'bien', 'ok', 'juste', 'que', 'qui', 'au', 'aux', 'du', 'de',
  'des', 'en', 'sur', 'avec', 'a', 'à', 'très', 'tres', 'vraiment', 'moi', 'toi', 'nous', 'vous', 'ça', 'ca',
  'cela', 'intéressé', 'interesse', 'intéressée', 'désolé', 'desole', 'normal', 'possible', 'urgent', 'simple',
  'client', 'cliente', 'monsieur', 'madame', 'mr', 'mme', 'the', 'not', 'just', 'et', 'je', 'mais', 'donc',
  'car', 'ou', 'and', 'from', 'bonjour', 'salut', 'hello',
]);
function capitalizeName(word) {
  return word.split(/([-'’])/).map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join('');
}
function extractName(text) {
  const match = String(text || '').match(NAME_INTRO_REGEX);
  if (!match) return null;
  const words = match[1].trim().split(/\s+/);
  if (NAME_STOPWORDS.has(words[0].toLowerCase()) || words[0].length < 2) return null;
  const kept = [words[0]];
  // Un 2e mot n'est gardé que s'il commence par une majuscule ("Julie
  // Martin") — sinon c'est la suite de la phrase ("marc et j'ai besoin").
  if (words[1] && /^[A-ZÀ-ÖØ-Þ]/.test(words[1]) && !NAME_STOPWORDS.has(words[1].toLowerCase())) kept.push(words[1]);
  return kept.map(capitalizeName).join(' ').slice(0, 120);
}

// Cherche un nom dans TOUS les messages du visiteur (il se présente souvent
// au 1er message, bien avant de laisser son email) — le plus récent gagne.
function extractNameFromMessages(messages) {
  let found = null;
  (messages || []).forEach((m) => {
    if (m.role !== 'user') return;
    const n = extractName(m.content);
    if (n) found = n;
  });
  return found;
}

// Résumé du besoin en une phrase, généré par l'IA à partir de la
// conversation. Appelé en arrière-plan APRÈS la réponse au visiteur : il ne
// ralentit donc jamais le chat, et s'il échoue, le dashboard affiche
// simplement le message brut comme avant.
async function generateLeadSummary(transcriptMessages) {
  const transcript = transcriptMessages
    .map((m) => (m.role === 'user' ? 'Visiteur' : 'Assistant') + ' : ' + String(m.content || '').slice(0, 1500))
    .join('\n')
    .slice(-8000);

  const summaryPrompt =
    `Tu résumes des conversations commerciales pour une équipe de vente. ` +
    `Résume en UNE seule phrase courte (25 mots maximum), en français, le besoin ou la demande du visiteur ` +
    `(ce qu'il cherche, pour quand, contexte utile). Ne mentionne ni son email ni son téléphone. ` +
    `Réponds uniquement avec la phrase, sans guillemets ni préambule.`;
  const contents = [{ role: 'user', parts: [{ text: 'Conversation :\n' + transcript }] }];

  let text = null;
  try {
    const data = await callGemini(summaryPrompt, contents, 1);
    if (!data.error) text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (e) { /* on tente le secours juste en dessous */ }
  if (!text) {
    try { text = await callGroqFallback(summaryPrompt, contents); } catch (e) { text = null; }
  }
  if (!text) return null;
  return text.replace(/^["«\s]+|["»\s]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
}

// Met à jour le nom (s'il n'est pas déjà connu) et le résumé du lead lié à
// une conversation. Ne remplace JAMAIS un nom déjà présent (détecté plus tôt
// ou corrigé à la main par l'équipe).
async function refreshLeadNameOnly(convoId, transcriptMessages) {
  const name = extractNameFromMessages(transcriptMessages);
  if (!name) return;
  await query(
    'UPDATE leads SET name = $1, updated_at = NOW() WHERE conversation_id = $2 AND name IS NULL',
    [name, convoId]
  );
}

async function refreshLeadCard(convoId, transcriptMessages) {
  const { rows } = await query(
    'SELECT id, name FROM leads WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1',
    [convoId]
  );
  const lead = rows[0];
  if (!lead) return; // pas encore de lead pour cette conversation : rien à faire

  if (!lead.name) {
    const name = extractNameFromMessages(transcriptMessages);
    if (name) {
      await query('UPDATE leads SET name = $1, updated_at = NOW() WHERE id = $2 AND name IS NULL', [name, lead.id]);
    }
  }

  const summary = await generateLeadSummary(transcriptMessages);
  if (summary) {
    await query('UPDATE leads SET summary = $1, updated_at = NOW() WHERE id = $2', [summary, lead.id]);
  }
}

// ------------------------------------------------------------
// Proposition automatique de démo : sur le bot WHATGO lui-même (le nôtre,
// sur whatgo.ai — pas encore un réglage disponible par client), on propose
// une démo au visiteur dès son 3e message, avec une date précise calculée
// ici (jamais laissée à l'IA, qui pourrait halluciner un jour/heure faux),
// et on lui demande son email ET son téléphone pour confirmer.
// ------------------------------------------------------------
const APPOINTMENT_OFFER_BUSINESS_DAYS_AHEAD = 3;
const APPOINTMENT_OFFER_HOUR = 14;

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

// Marqueur que le bot doit ajouter (et JAMAIS commenter au visiteur) dès
// que le rendez-vous est vraiment confirmé — avec la date/heure exacte, au
// cas où le visiteur négocie une autre date que celle proposée au départ.
// Un format rigide, qu'on valide nous-mêmes avant de l'utiliser (voir
// parseAppointmentConfirmation) : pas de "deviner la date" côté serveur à
// partir de texte libre, seulement lire ce que l'IA a été instruite d'écrire.
const RDV_CONFIRM_REGEX = /\[RDV_CONFIRME:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\]/;

function parseAppointmentConfirmation(replyText) {
  const match = String(replyText || '').match(RDV_CONFIRM_REGEX);
  if (!match) return { cleanedReply: replyText, confirmedDate: null };

  const [full, dd, mm, yyyy, hh, min] = match;
  const candidate = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), 0, 0);
  const confirmedDate = Number.isNaN(candidate.getTime()) ? null : candidate;
  const cleanedReply = replyText.replace(full, '').trim();
  return { cleanedReply, confirmedDate };
}

// Construit le prompt système à utiliser pour CET appel uniquement (ne
// modifie jamais business.system_prompt en base) : ajoute l'instruction de
// langue à chaque appel, puis — pour TOUS les clients, pas seulement WHATGO
// — l'instruction de proposition de rendez-vous quand ce visiteur vient de
// franchir le seuil "Proposer un RDV" réglé dans la page Qualification de
// cette entreprise, et/ou l'instruction de confirmation tant que le
// rendez-vous de cette conversation n'est pas encore acté (calculé par
// l'appelant, voir /api/chat). hasContactInfo indique si on a déjà l'email
// et/ou le téléphone du visiteur : sans ça, un "rendez-vous confirmé" ne
// sert à rien (personne à recontacter), donc le bot n'a pas le droit de
// valider la date avant d'avoir obtenu au moins l'un des deux.
// ------------------------------------------------------------
// Confort du chat : mise en forme, questions de suite, formulaire de
// coordonnées. Les marqueurs sont retirés avant affichage et enregistrement.
// ------------------------------------------------------------
const FOLLOWUPS_MARKER_REGEX = /\[\s*SUITES?\s*:\s*([^\]]*)\]/gi;
const CONTACT_FORM_MARKER = '[FORMULAIRE_CONTACT]';
const CONTACT_ASK_REGEX = /\b(votre|vos|ton|tes|your)\s+(adresse\s+)?(e-?mail|mail|num[ée]ro|t[ée]l[ée]phone|portable|coordonn[ée]es|phone|contact details)/i;
const CHAT_UX_INSTRUCTION =
  `\n\nMISE EN FORME : réponses courtes et aérées. Tu peux mettre en **gras** les points clés et faire des listes ` +
  `avec des tirets ("- ") quand il y a plusieurs éléments. Écris les liens en entier (https://...).` +
  `\n\nQUESTIONS DE SUITE : termine CHAQUE réponse par une dernière ligne, seule, au format exact ` +
  `[SUITES: question 1 | question 2 | question 3] avec 2 ou 3 questions très courtes (6 mots maximum) que le visiteur ` +
  `pourrait vouloir poser ensuite, écrites de son point de vue et dans la langue de la conversation. Ne les annonce pas ` +
  `et ne les répète pas dans le texte.` +
  `\n\nPHOTOS ET FICHIERS : le visiteur peut joindre une photo ou un PDF. Décris en une phrase ce que tu vois, puis aide-le ` +
  `selon les règles de l'entreprise (retour, échange, réclamation, devis…). Ne promets jamais un remboursement, un échange ` +
  `ou un geste commercial que les documents de l'entreprise ne prévoient pas : propose plutôt de transmettre la demande à ` +
  `l'équipe avec la photo, et demande ses coordonnées (et le numéro de commande si utile). La photo est déjà enregistrée ` +
  `et sera transmise : ne demande pas de la renvoyer par email.`;
const CONTACT_FORM_INSTRUCTION =
  `\n\nFORMULAIRE DE COORDONNÉES : quand tu demandes au visiteur son email ou son téléphone, ajoute le marqueur ` +
  `[FORMULAIRE_CONTACT] juste avant la ligne [SUITES: ...] : un petit formulaire s'affichera sous ton message.`;
function extractChatExtras(reply, hasContactInfo) {
  let followups = [];
  let text = String(reply || '').replace(FOLLOWUPS_MARKER_REGEX, (m, list) => {
    followups = String(list).split('|').map((q) => q.replace(/^[\s"«»“”-]+|[\s"«»“”]+$/g, '').slice(0, 60))
      .filter((q) => q.length > 1).slice(0, 3);
    return '';
  });
  // Filet de sécurité : ligne « SUITES : a | b » écrite sans crochets.
  text = text.replace(/^[ \t*_]*SUITES?[ \t*_]*:[ \t]*(.+)$/gim, (m, list) => {
    if (!followups.length) {
      followups = String(list).split('|').map((q) => q.replace(/^[\s"«»“”*-]+|[\s"«»“”*\]]+$/g, '').slice(0, 60))
        .filter((q) => q.length > 1).slice(0, 3);
    }
    return '';
  });
  const hadMarker = text.includes(CONTACT_FORM_MARKER);
  text = text.split(CONTACT_FORM_MARKER).join('').trim();
  const contactForm = !hasContactInfo && (hadMarker || CONTACT_ASK_REGEX.test(text));
  return { text, followups, contactForm };
}

// Réponse où l'IA reconnaît ne pas savoir : remontée dans « Questions à améliorer ».
const UNANSWERED_REGEX = /je ne (sais|connais) pas|je n['’]ai pas (cette|d['’]|l['’]|ces|les)\s*informations?|je ne dispose pas|je n['’]ai pas acc[eè]s|pas en mesure de (vous )?(r[ée]pondre|donner|pr[ée]ciser)|je ne trouve pas|i don['’]t (know|have (that|this|any) information)|i do not have (that|this) information|i['’]m not able to (answer|tell)|i can['’]t find/i;

// Assistante par défaut de tous les chatbots WHATGO : Victoria et sa photo.
// Un client peut la renommer ou changer la photo (Paramètres) ; un champ
// vidé volontairement ('') n'est pas remplacé par la valeur par défaut.
const DEFAULT_BOT_NAME = 'Victoria';
const DEFAULT_BOT_AVATAR = '/avatars/victoria.jpg';
function botNameOf(b) { return b.bot_name == null ? DEFAULT_BOT_NAME : b.bot_name; }
function botAvatarOf(b) { return b.bot_avatar == null ? DEFAULT_BOT_AVATAR : b.bot_avatar; }

function buildSystemPromptForCall(business, shouldOfferAppointment, appointmentDateLabel, appointmentInProgress, hasContactInfo) {
  let prompt = business.system_prompt + LANGUAGE_INSTRUCTION + CHAT_UX_INSTRUCTION +
    (hasContactInfo ? '' : CONTACT_FORM_INSTRUCTION);
  if (business.learned_answers && business.learned_answers.trim()) {
    prompt += `\n\nRÉPONSES VALIDÉES PAR L'ÉQUIPE (prioritaires sur tout le reste) :\n${business.learned_answers.trim()}`;
  }
  if (botNameOf(business)) {
    prompt += `\n\nTON PRÉNOM : tu t'appelles ${botNameOf(business)}, et tu es l'intelligence artificielle qui répond ` +
      `aux visiteurs de "${business.name}". Si on te demande ton nom, présente-toi ainsi. Tu restes transparent(e) : ` +
      `si on te demande si tu es un humain, réponds que tu es une IA et propose de mettre le visiteur en relation avec l'équipe.`;
  }

  if (shouldOfferAppointment) {
    prompt += `\n\nINSTRUCTION POUR CETTE RÉPONSE UNIQUEMENT :\n` +
      `Ce visiteur montre assez d'intérêt pour qu'on lui propose un rendez-vous. Propose-lui maintenant un rendez-vous, ` +
      `avec cette date précise : ${appointmentDateLabel}. Demande-lui de confirmer avec son email ET son numéro de téléphone ` +
      `pour que l'équipe puisse le recontacter et confirmer le créneau. Fais cette proposition dans la langue de la ` +
      `conversation en cours.`;
  }

  if (appointmentInProgress) {
    if (hasContactInfo) {
      prompt += `\n\nINSTRUCTION DE CONFIRMATION DE RENDEZ-VOUS (permanente pour cette conversation) :\n` +
        `Si le visiteur accepte une date de rendez-vous, ou en propose/confirme une autre précise (même différente de celle ` +
        `annoncée au départ), termine ta réponse par ce marqueur exact, sur sa propre ligne, sans jamais l'expliquer ni le ` +
        `commenter au visiteur : [RDV_CONFIRME: JJ/MM/AAAA HH:MM] (heure locale, format 24h). N'ajoute ce marqueur QUE si la ` +
        `date et l'heure sont vraiment confirmées, jamais sur une simple proposition ou une hésitation.`;
    } else {
      prompt += `\n\nINSTRUCTION DE CONFIRMATION DE RENDEZ-VOUS (permanente pour cette conversation) :\n` +
        `IMPORTANT : ce visiteur n'a PAS encore laissé son email ni son numéro de téléphone. Un rendez-vous confirmé sans ` +
        `aucun moyen de le recontacter ne sert à rien. Donc, tant que tu n'as pas obtenu au moins l'un des deux (email OU ` +
        `téléphone), tu ne dois JAMAIS ajouter le marqueur [RDV_CONFIRME: ...] — même si le visiteur accepte ou confirme ` +
        `une date précise. Dans ce cas, confirme la date verbalement mais demande-lui explicitement son email ou son ` +
        `numéro de téléphone pour valider le rendez-vous, et n'ajoute le marqueur que dans une réponse suivante, une fois ` +
        `ce contact obtenu.`;
    }
  }

  return prompt;
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
  // Joint les liens des photos/fichiers envoyés dans la conversation.
  if (payload && payload.conversationId && payload.attachments === undefined) {
    attachmentUrlsFor(payload.conversationId).then((urls) => {
      sendLeadToWebhook(business, { ...payload, attachments: urls.join(' ') });
    });
    return;
  }
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
// ------------------------------------------------------------
// « Parler à un humain » (menu … du chat) : le visiteur laisse son nom et
// un moyen de le recontacter. On l'enregistre comme un lead prioritaire
// (visible dans le tableau de bord) et on l'envoie vers Make → CRM, avec
// les mêmes champs qu'un lead classique (type "handoff").
// ------------------------------------------------------------
// Apparence du chatbot (prénom + photo) lue par le widget au chargement :
// permet de la changer sans toucher au code installé sur le site du client.
app.get('/api/widget/:slug/look', async (req, res) => {
  try {
    const { rows } = await query('SELECT bot_name, bot_avatar, bot_suggestions FROM businesses WHERE slug = $1', [req.params.slug]);
    if (!rows[0]) return res.status(404).json({ error: 'Entreprise inconnue.' });
    let suggestions = null;
    try { suggestions = rows[0].bot_suggestions ? JSON.parse(rows[0].bot_suggestions) : null; } catch (e) { suggestions = null; }
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ name: botNameOf(rows[0]), avatar: botAvatarOf(rows[0]), suggestions, mic: Boolean(GROQ_API_KEY) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Tableau de bord → Paramètres → « Apparence du chatbot » : prénom, photo
// et questions fréquentes cliquables.
function parseSuggestions(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
app.get('/api/dashboard/bot-look', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const { rows } = await query('SELECT bot_name, bot_avatar, bot_suggestions FROM businesses WHERE id = $1', [req.user.businessId]);
    const b = rows[0] || {};
    const sugg = parseSuggestions(b.bot_suggestions);
    const list = Array.isArray(sugg) ? sugg : (sugg && (sugg.fr || sugg.en)) || [];
    res.json({
      name: botNameOf(b),
      avatar: botAvatarOf(b),
      suggestions: list.map((q) => (typeof q === 'string' ? q : q.text || q.label)).filter(Boolean),
    });
  } catch (err) {
    console.error('Erreur GET /api/dashboard/bot-look:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});
app.put('/api/dashboard/bot-look', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 40);
    let avatar = String(body.avatar || '').trim();
    const okAvatar = !avatar ||
      /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar) && avatar.length < 150000 ||
      /^\/avatars\/[a-z0-9-]+\.(jpg|png|svg)$/.test(avatar) ||
      /^https:\/\/[^\s"'<>]+$/.test(avatar) && avatar.length < 500;
    if (!okAvatar) return res.status(400).json({ error: 'Photo invalide (JPG ou PNG, 100 Ko maximum).' });
    const list = (Array.isArray(body.suggestions) ? body.suggestions : [])
      .map((q) => String(q || '').trim().slice(0, 80)).filter(Boolean).slice(0, 6);

    const { rows } = await query('SELECT bot_suggestions FROM businesses WHERE id = $1', [req.user.businessId]);
    const prev = parseSuggestions(rows[0] && rows[0].bot_suggestions);
    let stored;
    // Suggestions multilingues (ex. site WHATGO fr/en) : on ne remplace que le français.
    if (prev && !Array.isArray(prev) && typeof prev === 'object') {
      const prevFr = (prev.fr || []).map((q) => (typeof q === 'string' ? q : q.text));
      const same = prevFr.length === list.length && prevFr.every((t, i) => t === list[i]);
      stored = same ? prev : Object.assign({}, prev, { fr: list });
    } else {
      stored = list;
    }
    await query('UPDATE businesses SET bot_name = $1, bot_avatar = $2, bot_suggestions = $3 WHERE id = $4',
      // Chaînes vides (pas NULL) : un réglage vidé volontairement n'est jamais re-rempli au redémarrage.
      [name, avatar, JSON.stringify(stored), req.user.businessId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur PUT /api/dashboard/bot-look:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// ------------------------------------------------------------
// 👍 / 👎 du visiteur sur une réponse de l'assistant.
// ------------------------------------------------------------
app.post('/api/feedback', async (req, res) => {
  try {
    if (isRateLimited(`feedback:${clientIp(req)}`, 30, 60 * 1000)) return res.status(429).json({ error: 'Trop de requêtes.' });
    const body = req.body || {};
    const value = Number(body.value);
    if (![1, -1, 0].includes(value)) return res.status(400).json({ error: 'Valeur invalide.' });
    const { rowCount } = await query(
      `UPDATE messages m SET feedback = $1, reviewed_at = NULL
       FROM conversations c, businesses b
       WHERE m.id = $2 AND m.conversation_id = $3 AND m.role = 'assistant'
         AND c.id = m.conversation_id AND b.id = c.business_id AND b.slug = $4`,
      [value || null, Number(body.messageId) || 0, Number(body.conversationId) || 0, String(body.business || '')]
    );
    if (!rowCount) return res.status(404).json({ error: 'Message introuvable.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur /api/feedback:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ------------------------------------------------------------
// Micro du chat : l'audio du visiteur est transcrit en texte par Groq
// (Whisper). Rien n'est conservé : le texte revient dans le champ de saisie.
// ------------------------------------------------------------
const AUDIO_EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a' };
app.post('/api/transcribe', express.raw({ type: () => true, limit: '6mb' }), async (req, res) => {
  try {
    if (!GROQ_API_KEY) return res.status(503).json({ error: 'Micro indisponible.' });
    if (isRateLimited(`transcribe:${clientIp(req)}`, 12, 60 * 1000)) return res.status(429).json({ error: 'Trop de requêtes, patientez une minute.' });
    const slug = String((req.query && req.query.business) || '');
    const { rows } = await query('SELECT id FROM businesses WHERE slug = $1', [slug]);
    if (!rows[0]) return res.status(404).json({ error: 'Entreprise inconnue.' });
    const audio = req.body;
    if (!Buffer.isBuffer(audio) || audio.length < 800) return res.status(400).json({ error: 'Enregistrement trop court.' });
    const mime = String(req.headers['content-type'] || 'audio/webm').split(';')[0].trim().toLowerCase();
    const ext = AUDIO_EXT[mime] || 'webm';
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime }), 'audio.' + ext);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    const lang = String((req.query && req.query.lang) || '').slice(0, 2).toLowerCase();
    if (/^[a-z]{2}$/.test(lang)) form.append('language', lang);
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('Erreur transcription Groq:', r.status, data && data.error);
      return res.status(502).json({ error: 'Transcription impossible, réessayez.' });
    }
    res.json({ text: String(data.text || '').trim() });
  } catch (err) {
    console.error('Erreur /api/transcribe:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ------------------------------------------------------------
// Tableau de bord → « Questions à améliorer ».
// ------------------------------------------------------------
app.get('/api/dashboard/improve', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const bid = req.user.businessId;
    const { rows } = await query(
      `SELECT m.id, m.content AS answer, m.feedback, m.unanswered, m.created_at, m.conversation_id,
              (SELECT u.content FROM messages u WHERE u.conversation_id = m.conversation_id AND u.role = 'user' AND u.id < m.id
               ORDER BY u.id DESC LIMIT 1) AS question
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.business_id = $1 AND m.role = 'assistant' AND m.reviewed_at IS NULL
         AND (m.feedback = -1 OR m.unanswered = true)
       ORDER BY m.created_at DESC LIMIT 100`, [bid]);
    const { rows: st } = await query(
      `SELECT COUNT(*) FILTER (WHERE m.feedback = 1) AS up, COUNT(*) FILTER (WHERE m.feedback = -1) AS down,
              COUNT(*) FILTER (WHERE m.unanswered) AS unknown, COUNT(*) AS total
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.business_id = $1 AND m.role = 'assistant' AND m.created_at > NOW() - INTERVAL '30 days'`, [bid]);
    const { rows: b } = await query('SELECT learned_answers FROM businesses WHERE id = $1', [bid]);
    res.json({
      items: rows.map((r) => ({
        id: r.id, conversationId: r.conversation_id, question: r.question || '', answer: r.answer,
        reason: r.feedback === -1 ? 'down' : 'unknown', date: r.created_at,
      })),
      stats: { up: Number(st[0].up), down: Number(st[0].down), unknown: Number(st[0].unknown), total: Number(st[0].total) },
      learned: (b[0] && b[0].learned_answers) || '',
    });
  } catch (err) {
    console.error('Erreur GET /api/dashboard/improve:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.post('/api/dashboard/improve/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const bid = req.user.businessId;
    const { rows } = await query(
      `SELECT m.id, (SELECT u.content FROM messages u WHERE u.conversation_id = m.conversation_id AND u.role = 'user' AND u.id < m.id
               ORDER BY u.id DESC LIMIT 1) AS question
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = $1 AND c.business_id = $2`, [Number(req.params.id) || 0, bid]);
    if (!rows[0]) return res.status(404).json({ error: 'Introuvable.' });
    const answer = String((req.body && req.body.answer) || '').trim().slice(0, 1500);
    if (req.body && req.body.action === 'answer') {
      if (!answer) return res.status(400).json({ error: 'Écrivez la bonne réponse.' });
      const question = String((req.body && req.body.question) || rows[0].question || '').trim().slice(0, 300);
      const entry = `- Question : ${question.replace(/\s+/g, ' ')}\n  Réponse : ${answer.replace(/\s+/g, ' ')}`;
      await query(
        `UPDATE businesses SET learned_answers = LEFT(CONCAT_WS(E'\n', NULLIF(learned_answers, ''), $1::text), 20000) WHERE id = $2`,
        [entry, bid]);
    }
    await query('UPDATE messages SET reviewed_at = NOW() WHERE id = $1', [rows[0].id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur POST /api/dashboard/improve:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.put('/api/dashboard/learned', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const text = typeof (req.body && req.body.learned) === 'string' ? req.body.learned.trim().slice(0, 20000) : '';
    await query('UPDATE businesses SET learned_answers = $1 WHERE id = $2', [text, req.user.businessId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur PUT /api/dashboard/learned:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// ------------------------------------------------------------
// Ouverture du chat (une fois par visite) : première étape de l'entonnoir
// de la Vue d'ensemble.
// ------------------------------------------------------------
app.post('/api/widget/:slug/open', async (req, res) => {
  try {
    if (isRateLimited(`open:${clientIp(req)}`, 20, 60 * 1000)) return res.status(429).json({ error: 'Trop de requêtes.' });
    const { rows } = await query('SELECT id FROM businesses WHERE slug = $1', [req.params.slug]);
    if (!rows[0]) return res.status(404).json({ error: 'Entreprise inconnue.' });
    await query("INSERT INTO chat_events (business_id, type) VALUES ($1, 'open')", [rows[0].id]).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ------------------------------------------------------------
// Vue d'ensemble : tout est calculé en heure de Paris, sur une période
// (7, 30 ou 90 jours) comparée à la période précédente de même durée.
// ------------------------------------------------------------
const OVERVIEW_TOPICS = [
  ['Prix & tarifs', /\b(prix|tarifs?|co[uû]te?s?|combien|price|pricing|cost|budget|devis|€)/i],
  ['Rendez-vous & démo', /(rendez|rdv|d[ée]mo|r[ée]serv|booking|book|cr[ée]neau|appointment)/i],
  ['Horaires & accès', /(horaires?|ouvert|ferm[ée]|adresse|o[uù] (se trouve|[êe]tes)|acc[eè]s|parking|venir|opening|hours|address)/i],
  ['Disponibilités', /(dispo|chambre|stock|places?\b|available|availability|room)/i],
  ['Livraison & commandes', /(livr|commande|retour|colis|exp[ée]di|delivery|order|shipping|refund|rembours)/i],
  ['Fonctionnement & intégrations', /(comment (ça|ca|cela) (marche|fonctionne)|fonctionn|int[ée]gr|crm|install|how (does|do) it work|integrat)/i],
  ['Parler à quelqu\'un', /(humain|conseiller|quelqu['’]un d['’]autre|parler à quelqu|appelez|m['’]appeler|rappel|human|call me|speak to)/i],
];

app.get('/api/dashboard/overview', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const bid = req.user.businessId;
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const safe = async (sql, params, fallback) => {
      try { return (await query(sql, params)).rows; } catch (e) { return fallback; }
    };
    const TODAY = `(NOW() AT TIME ZONE 'Europe/Paris')::date`;
    const D = (col) => `(${col} AT TIME ZONE 'Europe/Paris')::date`;
    const CUR = (col) => `${D(col)} > ${TODAY} - $2::int`;
    const PREV = (col) => `${D(col)} <= ${TODAY} - $2::int AND ${D(col)} > ${TODAY} - 2 * $2::int`;
    const P = [bid, days];
    const pair = (r) => ({ cur: Number((r && r.cur) || 0), prev: Number((r && r.prev) || 0) });

    const [conv] = await safe(`SELECT COUNT(*) FILTER (WHERE ${CUR('started_at')}) AS cur, COUNT(*) FILTER (WHERE ${PREV('started_at')}) AS prev
      FROM conversations WHERE business_id = $1`, P, [{}]);
    const [leads] = await safe(`SELECT COUNT(*) FILTER (WHERE ${CUR('created_at')}) AS cur, COUNT(*) FILTER (WHERE ${PREV('created_at')}) AS prev
      FROM leads WHERE business_id = $1`, P, [{}]);
    const [rdv] = await safe(`SELECT COUNT(*) FILTER (WHERE ${CUR('created_at')}) AS cur, COUNT(*) FILTER (WHERE ${PREV('created_at')}) AS prev
      FROM leads WHERE business_id = $1 AND (appointment_at IS NOT NULL OR status = 'rdv_pris')`, P, [{}]);
    const [opens] = await safe(`SELECT COUNT(*) FILTER (WHERE ${CUR('created_at')}) AS cur, COUNT(*) FILTER (WHERE ${PREV('created_at')}) AS prev
      FROM chat_events WHERE business_id = $1 AND type = 'open'`, P, [{}]);
    const [fb] = await safe(`SELECT COUNT(*) FILTER (WHERE m.feedback = 1 AND ${CUR('m.created_at')}) AS up,
        COUNT(*) FILTER (WHERE m.feedback = -1 AND ${CUR('m.created_at')}) AS down,
        COUNT(*) FILTER (WHERE m.feedback = 1 AND ${PREV('m.created_at')}) AS pup,
        COUNT(*) FILTER (WHERE m.feedback = -1 AND ${PREV('m.created_at')}) AS pdown
      FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.business_id = $1 AND m.role = 'assistant'`, P, [{}]);

    // À faire
    const hot = await safe(`SELECT id, name, email, phone, score, conversation_id FROM leads
      WHERE business_id = $1 AND status = 'nouveau' ORDER BY score DESC NULLS LAST, created_at DESC LIMIT 200`, [bid], []);
    const hotLeads = hot.filter((l) => Number(l.score) >= 70);
    const [today] = await safe(`SELECT COUNT(*) AS n FROM leads WHERE business_id = $1 AND ${D('appointment_at')} = ${TODAY}`, [bid], [{}]);
    const [impr] = await safe(`SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.business_id = $1 AND m.role = 'assistant' AND m.reviewed_at IS NULL AND (m.feedback = -1 OR m.unanswered = true)`, [bid], [{}]);

    // Courbe par jour (heure de Paris, jours sans activité à 0)
    const series = await safe(`WITH d AS (
        SELECT generate_series(${TODAY} - ($2::int - 1), ${TODAY}, interval '1 day')::date AS day)
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
        (SELECT COUNT(*) FROM conversations c WHERE c.business_id = $1 AND ${D('c.started_at')} = d.day) AS conv,
        (SELECT COUNT(*) FROM leads l WHERE l.business_id = $1 AND ${D('l.created_at')} = d.day) AS leads
      FROM d ORDER BY d.day`, P, []);

    // Sujets les plus demandés (une conversation compte une fois par sujet)
    const texts = await safe(`SELECT m.conversation_id, string_agg(m.content, ' ') AS t
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.business_id = $1 AND m.role = 'user' AND ${CUR('m.created_at')}
      GROUP BY m.conversation_id LIMIT 3000`, P, []);
    const topicCounts = OVERVIEW_TOPICS.map(([label, re]) => ({
      label, count: texts.filter((r) => re.test((typeof r === 'string' ? r : r.t) || '')).length,
    })).filter((t) => t.count > 0).sort((a, b) => b.count - a.count).slice(0, 6);

    res.json({
      days,
      kpis: {
        conversations: pair(conv), leads: pair(leads), rdv: pair(rdv), opens: pair(opens),
        satisfaction: {
          up: Number(fb.up || 0), down: Number(fb.down || 0), prevUp: Number(fb.pup || 0), prevDown: Number(fb.pdown || 0),
        },
      },
      todo: {
        newLeads: hot.length,
        hotLeads: hotLeads.length,
        hotNames: hotLeads.slice(0, 3).map((l) => l.name || l.email || l.phone || 'Visiteur'),
        rdvToday: Number(today.n || 0),
        improve: Number(impr.n || 0),
      },
      series: series.map((r) => ({ day: r.day, conv: Number(r.conv), leads: Number(r.leads) })),
      topics: topicCounts,
      topicsTotal: texts.length,
    });
  } catch (err) {
    console.error('Erreur GET /api/dashboard/overview:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// ============================================================
// BASE DE CONNAISSANCES : import de documents et lecture de sites web.
// Le texte extrait est stocké en base puis donné à l'assistant à chaque
// question (documents de taille raisonnable : cartes, tarifs, FAQ…).
// ============================================================
const DOCS_MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 Mo par fichier
const DOCS_MAX_DOC_CHARS = 150000;              // ≈ 40 pages par document
const DOCS_MAX_TOTAL_CHARS = 300000;            // ≈ 80 pages au total par client
const DOCS_FALLBACK_CHARS = 24000;              // version courte pour le secours Groq
const docsCache = new Map();                    // business_id -> { at, full, short }

function decodeEntities(t) {
  return String(t)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)));
}
function cleanText(t) {
  return String(t).replace(/\r/g, '').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// --- Word (.docx) : un .docx est un zip ; on lit word/document.xml. ---
function unzipEntry(buf, wanted) {
  const zlib = require('zlib');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    if (name === wanted) {
      const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
      const data = buf.slice(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
      return method === 8 ? zlib.inflateRawSync(data) : data;
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}
function docxToText(buf) {
  const xml = unzipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('docx');
  return cleanText(decodeEntities(xml.toString('utf8')
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, ' | ').replace(/<\/w:tr>/g, '\n')
    .replace(/<[^>]+>/g, '')));
}

// --- PDF : Gemini lit le PDF et renvoie son texte (pas de bibliothèque à installer). ---
async function pdfToText(buf) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [
        { inline_data: { mime_type: 'application/pdf', data: buf.toString('base64') } },
        { text: "Recopie fidèlement TOUT le texte de ce document, dans l'ordre, sans le résumer ni le commenter. " +
                'Garde les titres, listes, prix et horaires. Écris les tableaux ligne par ligne avec des « | » entre les colonnes.' },
      ] }],
      generationConfig: { temperature: 0, maxOutputTokens: 60000 },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error((data.error && data.error.message) || 'Lecture du PDF impossible');
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return cleanText(parts.map((x) => x.text || '').join(''));
}

// --- Pages web : lecture sécurisée (pas d'adresse interne) ---
function isPrivateIp(ip) {
  return /^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fc|fd|fe80)/i.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}
async function safeFetchPage(rawUrl) {
  const dns = require('dns').promises;
  let current = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(current);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Adresse invalide');
    if (!process.env.ALLOW_PRIVATE_FETCH) {
      if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) throw new Error('Adresse non autorisée');
      const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
      if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Site introuvable');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let r;
    try {
      r = await fetch(u.toString(), { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'WHATGO-Bot/1.0 (+https://whatgo.ai)', Accept: 'text/html,*/*' } });
    } finally { clearTimeout(timer); }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { current = new URL(r.headers.get('location'), u).toString(); continue; }
    if (!r.ok) throw new Error('Page inaccessible (' + r.status + ')');
    const type = String(r.headers.get('content-type') || '');
    if (!/html|text\/plain/i.test(type)) throw new Error('Pas une page web');
    const html = (await r.text()).slice(0, 2 * 1024 * 1024);
    return { url: u.toString(), html };
  }
  throw new Error('Trop de redirections');
}
function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const body = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head[\s\S]*?<\/head>/i, ' ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|ul|ol|table|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  return { title: cleanText(decodeEntities(title)), text: cleanText(decodeEntities(body)) };
}
function sameSiteLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const out = [];
  const re = /<a\s[^>]*href\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(decodeEntities(m[1]), base);
      u.hash = '';
      if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
      if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?)$/i.test(u.pathname)) continue;
      if (/(login|connexion|panier|cart|checkout|account|compte|wp-admin|mentions|cgv|cookies?|privacy|confidentialit)/i.test(u.pathname)) continue;
      const s = u.toString();
      if (s !== base.toString() && !out.includes(s)) out.push(s);
    } catch (e) { /* lien invalide */ }
  }
  return out;
}
async function readWebsite(startUrl) {
  const first = await safeFetchPage(startUrl);
  const pages = [];
  const p0 = htmlToText(first.html);
  pages.push({ url: first.url, title: p0.title, text: p0.text });
  const links = sameSiteLinks(first.html, first.url).slice(0, 12);
  for (const link of links) {
    if (pages.length >= 10) break;
    try {
      const pg = await safeFetchPage(link);
      const t = htmlToText(pg.html);
      if (t.text.length > 80) pages.push({ url: pg.url, title: t.title, text: t.text });
    } catch (e) { /* page ignorée */ }
  }
  // Retire les lignes répétées sur toutes les pages (menus, pieds de page).
  const lineCount = new Map();
  pages.forEach((pg) => new Set(pg.text.split('\n')).forEach((l) => lineCount.set(l, (lineCount.get(l) || 0) + 1)));
  const repeated = (l) => pages.length > 2 && l.length < 120 && lineCount.get(l) >= Math.ceil(pages.length * 0.7);
  const text = pages.map((pg, i) => {
    const lines = pg.text.split('\n').filter((l) => i === 0 || !repeated(l));
    return `## ${pg.title || pg.url}\n(${pg.url})\n${lines.join('\n')}`;
  }).join('\n\n');
  return { text: cleanText(text), pages: pages.length, title: p0.title };
}

async function loadDocsBlock(businessId) {
  const hit = docsCache.get(businessId);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit;
  let rows = [];
  try {
    rows = (await query('SELECT name, content FROM knowledge_docs WHERE business_id = $1 ORDER BY created_at ASC', [businessId])).rows;
  } catch (e) { rows = []; }
  const body = rows.map((r) => `### ${r.name}\n${r.content}`).join('\n\n');
  const head = `\n\nDOCUMENTS DE L'ENTREPRISE (source officielle : appuie-toi dessus pour répondre ; ` +
    `si l'information n'y figure pas, ne l'invente pas) :\n`;
  const out = {
    at: Date.now(),
    full: body ? head + body : '',
    short: body ? head + body.slice(0, DOCS_FALLBACK_CHARS) : '',
  };
  docsCache.set(businessId, out);
  return out;
}

async function docsUsage(businessId, exceptId) {
  const { rows } = await query('SELECT COALESCE(SUM(chars), 0) AS n FROM knowledge_docs WHERE business_id = $1 AND id <> $2', [businessId, exceptId || 0]);
  return Number(rows[0].n || 0);
}
async function saveDoc(businessId, replaceId, doc) {
  let content = doc.text || '';
  if (!content.trim()) throw Object.assign(new Error('Aucun texte trouvé dans ce document.'), { status: 422 });
  let truncated = false;
  if (content.length > DOCS_MAX_DOC_CHARS) { content = content.slice(0, DOCS_MAX_DOC_CHARS); truncated = true; }
  const used = await docsUsage(businessId, replaceId);
  if (used + content.length > DOCS_MAX_TOTAL_CHARS) {
    throw Object.assign(new Error("Limite atteinte : supprimez un document avant d'en ajouter un autre."), { status: 413 });
  }
  let id;
  if (replaceId) {
    const { rows } = await query(
      `UPDATE knowledge_docs SET kind = $1, name = $2, source_url = $3, mime = $4, chars = $5, pages = $6, content = $7, truncated = $8, updated_at = NOW()
       WHERE id = $9 AND business_id = $10 RETURNING id`,
      [doc.kind, doc.name, doc.url || null, doc.mime || null, content.length, doc.pages || null, content, truncated, replaceId, businessId]);
    if (!rows[0]) throw Object.assign(new Error('Document introuvable.'), { status: 404 });
    id = rows[0].id;
  } else {
    const { rows } = await query(
      `INSERT INTO knowledge_docs (business_id, kind, name, source_url, mime, chars, pages, content, truncated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [businessId, doc.kind, doc.name, doc.url || null, doc.mime || null, content.length, doc.pages || null, content, truncated]);
    id = rows[0].id;
  }
  docsCache.delete(businessId);
  return { id, chars: content.length, truncated };
}

app.get('/api/dashboard/docs', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, kind, name, source_url, mime, chars, pages, truncated, created_at, updated_at, LEFT(content, 220) AS excerpt
       FROM knowledge_docs WHERE business_id = $1 ORDER BY created_at DESC`, [req.user.businessId]);
    const used = rows.reduce((a, r) => a + Number(r.chars || 0), 0);
    res.json({ docs: rows, used, limit: DOCS_MAX_TOTAL_CHARS, maxFileMb: DOCS_MAX_FILE_BYTES / 1024 / 1024 });
  } catch (err) {
    console.error('Erreur GET /api/dashboard/docs:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.get('/api/dashboard/docs/:id', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const { rows } = await query('SELECT id, name, kind, source_url, content FROM knowledge_docs WHERE id = $1 AND business_id = $2',
      [Number(req.params.id) || 0, req.user.businessId]);
    if (!rows[0]) return res.status(404).json({ error: 'Document introuvable.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.post('/api/dashboard/docs/upload', requireAuth, requireRole('admin'),
  express.raw({ type: () => true, limit: DOCS_MAX_FILE_BYTES }), async (req, res) => {
  try {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Fichier vide.' });
    if (buf.length > DOCS_MAX_FILE_BYTES) return res.status(413).json({ error: 'Fichier trop lourd (10 Mo maximum).' });
    const name = String((req.query && req.query.name) || 'Document').slice(0, 160);
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1] ? name.match(/\.([a-z0-9]+)$/i)[1].toLowerCase() : '';
    const mime = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
    let text;
    let kind = 'file';
    if (ext === 'pdf' || mime === 'application/pdf' || buf.slice(0, 4).toString() === '%PDF') {
      text = await pdfToText(buf);
    } else if (ext === 'docx' || /wordprocessingml/.test(mime)) {
      try { text = docxToText(buf); } catch (e) { return res.status(422).json({ error: 'Fichier Word illisible.' }); }
    } else if (['txt', 'md', 'csv'].includes(ext) || /^text\//.test(mime)) {
      text = cleanText(buf.toString('utf8'));
    } else if (ext === 'doc') {
      return res.status(415).json({ error: 'Ancien format Word (.doc) : enregistrez-le en .docx ou en PDF.' });
    } else {
      return res.status(415).json({ error: 'Format non pris en charge : PDF, Word (.docx) ou texte.' });
    }
    const replaceId = Number(req.query && req.query.replace) || null;
    const saved = await saveDoc(req.user.businessId, replaceId, { kind, name, mime: mime || ext, text });
    res.json({ ok: true, ...saved });
  } catch (err) {
    console.error('Erreur import de document:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : "Impossible de lire ce document. Réessayez ou essayez un autre format." });
  }
});

app.post('/api/dashboard/docs/url', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    if (isRateLimited(`docs-url:${req.user.businessId}`, 10, 10 * 60 * 1000)) return res.status(429).json({ error: 'Trop de lectures, réessayez dans quelques minutes.' });
    let raw = String((req.body && req.body.url) || '').trim();
    if (!raw) return res.status(400).json({ error: "Indiquez l'adresse du site." });
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    let site;
    try { site = await readWebsite(raw); }
    catch (e) { return res.status(422).json({ error: 'Impossible de lire ce site : ' + (e.message || 'erreur') + '.' }); }
    const host = new URL(raw).hostname.replace(/^www\./, '');
    const replaceId = Number(req.body && req.body.replace) || null;
    const saved = await saveDoc(req.user.businessId, replaceId, {
      kind: 'url', name: 'Site ' + host, url: raw, mime: 'text/html', text: site.text, pages: site.pages,
    });
    res.json({ ok: true, pages: site.pages, ...saved });
  } catch (err) {
    console.error('Erreur lecture de site:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Erreur interne du serveur.' });
  }
});

app.delete('/api/dashboard/docs/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await query('DELETE FROM knowledge_docs WHERE id = $1 AND business_id = $2', [Number(req.params.id) || 0, req.user.businessId]);
    docsCache.delete(req.user.businessId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// ------------------------------------------------------------
// Photos et fichiers envoyés par le visiteur (ex. photo d'un produit abîmé).
// L'IA les voit (Gemini lit images et PDF), ils sont enregistrés avec la
// conversation, visibles dans le tableau de bord et envoyés vers le CRM.
// ------------------------------------------------------------
const ATTACH_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const ATTACH_MAX_BYTES = 4.5 * 1024 * 1024;
const ATTACH_MAX_PER_CONVO = 10;
function parseChatAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mime = String(raw.mime || '').toLowerCase();
  const data = String(raw.data || '').replace(/^data:[^;]+;base64,/, '');
  if (!ATTACH_MIMES.includes(mime) || !/^[A-Za-z0-9+/=]+$/.test(data)) return null;
  const size = Math.floor(data.length * 3 / 4);
  if (size > ATTACH_MAX_BYTES || size < 100) return null;
  const name = String(raw.name || (mime === 'application/pdf' ? 'document.pdf' : 'photo.jpg')).replace(/[^\w.\- ()àâäéèêëîïôöùûüç]/gi, '_').slice(0, 80);
  return { mime, data, size, name, isImage: mime.startsWith('image/') };
}
function attachmentToken(id) {
  return require('crypto').createHmac('sha256', String(process.env.JWT_SECRET || 'whatgo')).update('att:' + id).digest('hex').slice(0, 24);
}
function attachmentPublicUrl(id) {
  const base = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  return `${base}/api/attachments/${id}/${attachmentToken(id)}`;
}
async function attachmentUrlsFor(convoId) {
  try {
    const { rows } = await query('SELECT id FROM chat_attachments WHERE conversation_id = $1 ORDER BY id ASC LIMIT 10', [convoId]);
    return rows.map((r) => attachmentPublicUrl(r.id));
  } catch (e) { return []; }
}
function sendAttachment(res, row) {
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', `inline; filename="${String(row.name || 'fichier').replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(Buffer.from(row.data, 'base64'));
}
// Lien signé (pour le CRM / Make) : pas besoin d'être connecté.
app.get('/api/attachments/:id/:token', async (req, res) => {
  try {
    const id = Number(req.params.id) || 0;
    if (req.params.token !== attachmentToken(id)) return res.status(404).json({ error: 'Introuvable.' });
    const { rows } = await query('SELECT mime, name, data FROM chat_attachments WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Introuvable.' });
    sendAttachment(res, rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur.' }); }
});
app.get('/api/dashboard/attachments/:id', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const { rows } = await query('SELECT mime, name, data FROM chat_attachments WHERE id = $1 AND business_id = $2',
      [Number(req.params.id) || 0, req.user.businessId]);
    if (!rows[0]) return res.status(404).json({ error: 'Introuvable.' });
    sendAttachment(res, rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur.' }); }
});

app.post('/api/handoff', async (req, res) => {
  try {
    if (isRateLimited(`handoff:${clientIp(req)}`, 5, 10 * 60 * 1000)) {
      return res.status(429).json({ error: 'Trop de demandes. Merci de patienter quelques minutes.' });
    }
    const body = req.body || {};
    const slug = String(body.business || '');
    const name = String(body.name || '').trim().slice(0, 120);
    const contact = String(body.contact || '').trim().slice(0, 200);
    const note = String(body.message || '').trim().slice(0, 1000);
    const email = extractEmail(contact);
    const phone = email ? null : extractPhone(contact);
    if (!name) return res.status(400).json({ error: 'Indiquez votre nom.' });
    if (!email && !phone) return res.status(400).json({ error: 'Indiquez un email ou un numéro de téléphone valide.' });

    const { rows: bRows } = await query('SELECT * FROM businesses WHERE slug = $1', [slug]);
    const business = bRows[0];
    if (!business) return res.status(404).json({ error: 'Entreprise inconnue.' });

    let convoId = Number(body.conversationId) || null;
    if (convoId) {
      const { rows: c } = await query('SELECT id FROM conversations WHERE id = $1 AND business_id = $2', [convoId, business.id]);
      if (!c[0]) convoId = null;
    }
    if (!convoId) {
      const { rows: c } = await query(
        'INSERT INTO conversations (business_id, visitor_label) VALUES ($1, $2) RETURNING id',
        [business.id, name]
      );
      convoId = c[0].id;
    } else {
      await query('UPDATE conversations SET visitor_label = $1 WHERE id = $2', [name, convoId]);
    }

    const summary = 'Demande à parler à un humain' + (note ? ' : ' + note : '');
    const { rows: leadRows } = await query(
      'SELECT id FROM leads WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1', [convoId]
    );
    let leadId;
    if (leadRows[0]) {
      leadId = leadRows[0].id;
      await query(
        `UPDATE leads SET name = COALESCE(name, $1), email = COALESCE(email, $2), phone = COALESCE(phone, $3),
           summary = $4, score = GREATEST(score, 85), updated_at = NOW()
         WHERE id = $5`,
        [name, email || null, phone || null, summary, leadId]
      );
    } else {
      const { rows: ins } = await query(
        `INSERT INTO leads (business_id, conversation_id, email, phone, name, message, summary, score, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 85, 'nouveau') RETURNING id`,
        [business.id, convoId, email || null, phone || null, name, note || summary, summary]
      );
      leadId = ins[0].id;
    }

    await query('INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
      [convoId, 'user', `Demande de contact humain — ${name}, ${email || phone}${note ? ' — ' + note : ''}`]);
    const confirmation = `Merci ${name.split(' ')[0]} ! Un membre de l'équipe ${business.name} vous recontacte très vite.`;
    await query('INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)', [convoId, 'assistant', confirmation]);

    res.json({ ok: true, conversationId: convoId, confirmation });

    const parts = name.split(/\s+/).filter(Boolean);
    sendLeadToWebhook(business, {
      type: 'handoff',
      business: business.name,
      slug: business.slug,
      conversationId: convoId,
      email: email || '',
      phone: phone || '',
      message: note || summary,
      date: new Date().toISOString(),
      name,
      firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || ''),
      lastName: parts.length > 1 ? parts[parts.length - 1] : (parts[0] || 'Visiteur du chat'),
      summary,
      score: 85,
      status: 'nouveau',
      leadId,
    });
  } catch (err) {
    console.error('Erreur /api/handoff:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur serveur.' });
  }
});

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

    // Chargée une seule fois pour cet appel : sert à la fois au seuil
    // "Proposer un RDV" (plus bas) et à l'escalade (plus loin, après la
    // réponse de l'IA).
    const qualification = parseQualification(business);

    // Retrouver ou créer la conversation, pour pouvoir tout enregistrer.
    // Pour une conversation déjà existante, on regarde aussi si un
    // rendez-vous a déjà été proposé dessus (pour ne jamais le repropose
    // deux fois — voir plus bas).
    let convoId = conversationId;
    let rdvAlreadyOffered = false;
    let existingAppointmentAt = null;
    if (!convoId) {
      const { rows } = await query(
        'INSERT INTO conversations (business_id, visitor_label) VALUES ($1, $2) RETURNING id',
        [business.id, 'Visiteur anonyme']
      );
      convoId = rows[0].id;
    } else {
      const { rows: convoFlagRows } = await query('SELECT rdv_offered, appointment_at FROM conversations WHERE id = $1', [convoId]);
      rdvAlreadyOffered = convoFlagRows[0] ? convoFlagRows[0].rdv_offered : false;
      existingAppointmentAt = convoFlagRows[0] ? convoFlagRows[0].appointment_at : null;
    }

    // Enregistrer le dernier message du visiteur
    const lastUserMessage = messages[messages.length - 1];
    // Photo ou fichier joint au message (facultatif).
    let attachment = parseChatAttachment(req.body.attachment);
    if (attachment) {
      const { rows: cnt } = await query('SELECT COUNT(*)::int AS n FROM chat_attachments WHERE conversation_id = $1', [convoId]);
      if (cnt[0] && cnt[0].n >= ATTACH_MAX_PER_CONVO) attachment = null;
    }
    if (attachment && !String(lastUserMessage.content || '').trim()) {
      lastUserMessage.content = attachment.isImage ? 'Voici une photo.' : 'Voici un document.';
    }
    const storedUserText = attachment
      ? `${lastUserMessage.content}\n[📎 ${attachment.isImage ? 'Photo jointe' : 'Fichier joint'} : ${attachment.name}]`
      : lastUserMessage.content;
    const { rows: userMsgRows } = await query(
      'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id',
      [convoId, 'user', storedUserText]
    );
    if (attachment) {
      await query(
        'INSERT INTO chat_attachments (business_id, conversation_id, message_id, mime, name, size, data) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [business.id, convoId, userMsgRows[0] ? userMsgRows[0].id : null, attachment.mime, attachment.name, attachment.size, attachment.data]
      ).catch((e) => { console.error('Enregistrement pièce jointe:', e.message); });
    }

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
        // Le RDV a pu être proposé à un tour précédent, avant que ce lead
        // n'existe (visiteur intéressé mais pas encore d'email/téléphone) :
        // on reporte alors cette date sur le lead qu'on crée maintenant.
        await query(
          `INSERT INTO leads (business_id, conversation_id, email, phone, message, score, status, appointment_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'nouveau', $7)`,
          [business.id, convoId, newEmail || null, newPhone || null, lastUserMessage.content, score, existingAppointmentAt]
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
      res.json({ reply: DRAFT_REPLY, conversationId: convoId });
      // Brouillon : pas d'appel à l'IA pour le résumé, mais on capte quand
      // même le nom si le visiteur s'est présenté.
      refreshLeadNameOnly(convoId, messages).catch((e) => console.error('Nom lead (brouillon):', e.message));
      return;
    }

    // Gemini attend "contents" avec des "parts", et le rôle de l'IA
    // s'appelle "model", pas "assistant".
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    // L'IA voit la photo / le PDF joint au dernier message.
    if (attachment && contents.length) {
      contents[contents.length - 1].parts.push({ inline_data: { mime_type: attachment.mime, data: attachment.data } });
    }

    // A-t-on déjà un moyen de recontacter ce visiteur (email ou téléphone,
    // laissé maintenant ou lors d'un tour précédent) ? Sert à interdire au
    // bot de confirmer un rendez-vous tant que ce n'est pas le cas — voir
    // buildSystemPromptForCall.
    const { rows: contactCheckRows } = await query(
      'SELECT email, phone FROM leads WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1',
      [convoId]
    );
    const existingContact = contactCheckRows[0] || null;
    const hasContactInfo = Boolean(
      newEmail || newPhone || (existingContact && (existingContact.email || existingContact.phone))
    );

    // Score de qualification de CETTE conversation (pas juste du dernier
    // message) : le plus haut score atteint par un message du visiteur
    // jusqu'ici, avec la même heuristique que le score des leads. Dès qu'il
    // franchit le seuil "Proposer un RDV" réglé par le client (page
    // Qualification), et si ce n'est pas déjà fait pour cette conversation,
    // le prompt de CET appel propose un rendez-vous.
    const userMessagesSoFar = messages.filter((m) => m.role === 'user');
    const conversationScore = userMessagesSoFar.reduce(
      (max, m, idx) => Math.max(max, computeLeadScore(m.content, idx === 0)),
      0
    );
    const shouldOfferAppointment = !rdvAlreadyOffered && conversationScore >= qualification.thresholds.appointment;

    // Calculée une seule fois ici (pas dans buildSystemPromptForCall) pour
    // pouvoir à la fois l'écrire dans le prompt ET l'enregistrer plus bas
    // sur la conversation/le lead — les deux doivent être exactement la
    // même date que celle que le bot vient d'annoncer au visiteur.
    const appointmentDate = shouldOfferAppointment
      ? nextBusinessDayAt(APPOINTMENT_OFFER_BUSINESS_DAYS_AHEAD, APPOINTMENT_OFFER_HOUR)
      : null;
    const appointmentDateLabel = appointmentDate ? formatFrenchDateTime(appointmentDate) : null;

    // Tant qu'un rendez-vous a été proposé (ce tour-ci OU un tour précédent
    // pour cette conversation) et qu'aucune date n'a encore été confirmée
    // par le visiteur, on garde l'instruction de confirmation active — pour
    // capter une date renégociée ("plutôt vendredi 13h") aussi bien qu'une
    // simple confirmation de la date proposée au départ.
    const appointmentInProgress = shouldOfferAppointment || rdvAlreadyOffered;

    // Prompt enrichi pour CET appel seulement — business.system_prompt en
    // base ne change jamais.
    const systemPromptForCall = buildSystemPromptForCall(
      business, shouldOfferAppointment, appointmentDateLabel, appointmentInProgress, hasContactInfo
    );
    // Documents de la base de connaissances (version courte pour le secours Groq).
    const docsBlock = await loadDocsBlock(business.id);
    const data = await callGemini(systemPromptForCall + docsBlock.full, contents);

    let reply;
    let usedFallback = false;
    if (data.error) {
      console.error('Erreur API Gemini:', data.error);
      // Gemini a échoué après ses tentatives (souvent une surcharge 503) :
      // on tente le fallback Groq avant d'abandonner, pour que le visiteur
      // ait quand même une réponse plutôt qu'un message d'erreur.
      let fallbackReply = null;
      try {
        fallbackReply = await callGroqFallback(systemPromptForCall + docsBlock.short, contents);
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

    // Si l'IA a confirmé un rendez-vous dans sa réponse (marqueur
    // [RDV_CONFIRME: ...]), on extrait la date et on retire le marqueur —
    // le visiteur ne doit jamais le voir. C'est la SEULE source pour une
    // date de rendez-vous : jamais de "deviner" une date depuis le texte
    // libre du visiteur, seulement lire ce que l'IA a été explicitement
    // instruite d'écrire (voir buildSystemPromptForCall).
    const parsedConfirmation = parseAppointmentConfirmation(reply);
    reply = parsedConfirmation.cleanedReply;
    const chatExtras = extractChatExtras(reply, hasContactInfo);
    reply = chatExtras.text || "Avec plaisir !";
    // Filet de sécurité : même si l'IA a émis le marqueur malgré la
    // consigne, on n'enregistre jamais un rendez-vous "confirmé" sans
    // aucun moyen de recontacter le visiteur (ça ne servirait à rien).
    const confirmedDate = hasContactInfo ? parsedConfirmation.confirmedDate : null;

    // Enregistrer la réponse de l'IA aussi (avec le marqueur used_fallback,
    // visible seulement côté équipe WHATGO, pour suivre à quel point ce
    // secours est réellement sollicité en production).
    const { rows: assistantRows } = await query(
      'INSERT INTO messages (conversation_id, role, content, used_fallback, unanswered) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [convoId, 'assistant', reply, usedFallback, UNANSWERED_REGEX.test(reply)]
    );
    const assistantMessageId = assistantRows[0] ? assistantRows[0].id : null;

    // Le rendez-vous vient d'être proposé dans cette réponse : on le note
    // pour cette conversation (pour ne jamais le reproposer une 2e fois),
    // avec la date exacte annoncée au visiteur. Si un lead existe déjà pour
    // cette conversation, on la reporte aussi dessus, pour qu'elle
    // s'affiche dans l'onglet "Rendez-vous" du dashboard.
    if (shouldOfferAppointment) {
      await query(
        'UPDATE conversations SET rdv_offered = true, appointment_at = $1 WHERE id = $2',
        [appointmentDate, convoId]
      );
      await query('UPDATE leads SET appointment_at = $1 WHERE conversation_id = $2', [appointmentDate, convoId]);
    }

    // Le visiteur a confirmé (ou renégocié) une date précise dans ce tour :
    // elle prime toujours sur la date initialement proposée, qu'il s'agisse
    // du même rendez-vous ou d'un nouveau créneau. On l'enregistre même si
    // "shouldOfferAppointment" est faux ce tour-ci (le rendez-vous a pu être
    // proposé plusieurs messages plus tôt).
    if (confirmedDate) {
      await query(
        'UPDATE conversations SET rdv_offered = true, appointment_at = $1 WHERE id = $2',
        [confirmedDate, convoId]
      );

      const { rows: leadForConfirmRows } = await query(
        'SELECT id FROM leads WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1',
        [convoId]
      );
      if (leadForConfirmRows[0]) {
        // Lead déjà existant (email et/ou téléphone déjà laissés) : on met
        // à jour la date ET on passe directement le statut à "RDV pris" —
        // plus besoin de le faire à la main dans l'onglet Leads.
        await query(
          `UPDATE leads SET appointment_at = $1, status = 'rdv_pris', updated_at = NOW() WHERE id = $2`,
          [confirmedDate, leadForConfirmRows[0].id]
        );
      } else {
        // Le visiteur a confirmé une date SANS jamais donner d'email ni de
        // téléphone : on crée quand même un lead (contact vide), sinon ce
        // rendez-vous n'apparaîtrait jamais dans le dashboard. L'équipe
        // pourra ouvrir la conversation pour essayer d'identifier qui
        // c'est, ou attendre qu'il laisse un contact à un tour suivant.
        const priorUserMessagesForConfirm = messages.slice(0, -1).filter((m) => m.role === 'user');
        const confirmScore = computeLeadScore(lastUserMessage.content, priorUserMessagesForConfirm.length === 0);
        await query(
          `INSERT INTO leads (business_id, conversation_id, email, phone, message, score, status, appointment_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'rdv_pris', $7)`,
          [business.id, convoId, newEmail || null, newPhone || null, lastUserMessage.content, confirmScore, confirmedDate]
        );
      }
    }

    // Escalade vers un humain (page "Qualification") : uniquement sur les
    // entreprises publiées, une fois l'échange complet enregistré.
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

    res.json({ reply, conversationId: convoId, messageId: assistantMessageId, followups: chatExtras.followups, contactForm: chatExtras.contactForm });

    // Fiche lead (nom + résumé du besoin) : en arrière-plan, APRÈS avoir
    // répondu au visiteur — jamais bloquant, jamais visible dans le chat.
    refreshLeadCard(convoId, [...messages, { role: 'assistant', content: reply }])
      .catch((e) => console.error('Erreur mise à jour fiche lead:', e.message));

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
      'SELECT id, role, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    let attachments = [];
    try {
      attachments = (await query('SELECT id, message_id, mime, name FROM chat_attachments WHERE conversation_id = $1 ORDER BY id ASC',
        [req.params.id])).rows;
    } catch (e) { attachments = []; }

    res.json({ conversation: convo, messages, attachments });
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
      SELECT id, email, phone, message, score, status, conversation_id, created_at, appointment_at,
             name, summary, notes
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
      appointmentAt: l.appointment_at,
      name: l.name || '',
      summary: l.summary || '',
      notes: l.notes || '',
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
      SELECT name, email, phone, summary, message, notes, score, status, created_at
      FROM leads
      WHERE business_id = $1
      ORDER BY created_at DESC
    `, [req.user.businessId]);

    const header = ['Nom', 'Email', 'Téléphone', 'Résumé du besoin', 'Message', 'Notes internes', 'Score', 'Statut', 'Date']
      .map(csvField).join(',');
    const lines = leads.map((l) => [
      csvField(l.name || ''),
      csvField(l.email),
      csvField(l.phone || ''),
      csvField(l.summary || ''),
      csvField(l.message || ''),
      csvField(l.notes || ''),
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

// Fiche lead : nom (corrigible à la main) et notes internes de l'équipe.
// Le résumé n'est pas modifiable ici : il est généré par l'IA à partir de la
// conversation. Les notes ne sont jamais envoyées au bot.
app.put('/api/dashboard/leads/:id/details', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
    const notes = typeof req.body.notes === 'string' ? req.body.notes.trim().slice(0, 4000) : '';

    const { rows } = await query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    const lead = rows[0];
    if (!lead || lead.business_id !== req.user.businessId) {
      return res.status(404).json({ error: 'Lead introuvable.' });
    }

    await query(
      'UPDATE leads SET name = $1, notes = $2, updated_at = NOW() WHERE id = $3',
      [name || null, notes || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur /api/dashboard/leads/:id/details:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// Modifier manuellement la date d'un rendez-vous — secours quand la
// détection automatique (marqueur [RDV_CONFIRME: ...] dans les réponses du
// bot) n'a pas capté la bonne date, ou pour la renseigner à la main.
// appointmentAt: null efface la date (redevient "Proposée hors chat").
app.put('/api/dashboard/leads/:id/appointment', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { appointmentAt } = req.body;

    let parsedDate = null;
    if (appointmentAt) {
      parsedDate = new Date(appointmentAt);
      if (Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({ error: 'Date invalide.' });
      }
    }

    const { rows } = await query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    const lead = rows[0];
    if (!lead || lead.business_id !== req.user.businessId) {
      return res.status(404).json({ error: 'Lead introuvable.' });
    }

    await query('UPDATE leads SET appointment_at = $1, updated_at = NOW() WHERE id = $2', [parsedDate, req.params.id]);
    if (lead.conversation_id) {
      await query('UPDATE conversations SET appointment_at = $1 WHERE id = $2', [parsedDate, lead.conversation_id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur /api/dashboard/leads/:id/appointment:', err);
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

// Base de connaissances : instructions spécifiques du client, en texte libre.
app.get('/api/dashboard/instructions', requireAuth, requireRole(['admin', 'lecture']), async (req, res) => {
  try {
    const { rows } = await query('SELECT instructions FROM businesses WHERE id = $1', [req.user.businessId]);
    res.json({ instructions: (rows[0] && rows[0].instructions) || '' });
  } catch (err) {
    console.error('Erreur GET /api/dashboard/instructions:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.put('/api/dashboard/instructions', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const instructions = typeof req.body.instructions === 'string' ? req.body.instructions.trim().slice(0, 8000) : '';
    const { rows } = await query('SELECT * FROM businesses WHERE id = $1', [req.user.businessId]);
    const business = rows[0];
    if (!business) return res.status(404).json({ error: 'Entreprise introuvable.' });

    const newSystemPrompt = buildSystemPrompt({ ...business, instructions });
    await query('UPDATE businesses SET instructions = $1, system_prompt = $2 WHERE id = $3',
      [instructions, newSystemPrompt, req.user.businessId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur PUT /api/dashboard/instructions:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// Ancienne page "Contenu" (retirée du dashboard) : routes gardées pour
// compatibilité, elles ne sont plus appelées par l'interface.
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

// Conversations suspectes, tous clients confondus — réservé à l'équipe
// WHATGO. Deux cas détectés :
//  1) "no_reply" : le visiteur a écrit mais AUCUNE réponse assistant n'a
//     jamais été enregistrée (Gemini ET Groq ont échoué avant qu'une
//     réponse puisse être sauvegardée — voir /api/chat).
//  2) "generic_failure" : une réponse a bien été enregistrée, mais c'est le
//     texte de repli générique ("Désolé, je n'ai pas pu répondre.") plutôt
//     qu'une vraie réponse de l'IA.
const GENERIC_FAILURE_TEXT = "Désolé, je n'ai pas pu répondre.";

app.get('/api/superadmin/diagnostics/broken-conversations', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        c.id as conversation_id,
        c.visitor_label,
        c.started_at,
        b.name as business_name,
        b.slug as business_slug,
        COUNT(m.id) as message_count,
        COUNT(m.id) FILTER (WHERE m.role = 'assistant') as assistant_count,
        COUNT(m.id) FILTER (WHERE m.role = 'assistant' AND m.content = $1) as generic_failure_count,
        MAX(m.content) FILTER (WHERE m.role = 'user') as last_user_message
      FROM conversations c
      JOIN businesses b ON b.id = c.business_id
      LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id, b.name, b.slug
      HAVING
        COUNT(m.id) FILTER (WHERE m.role = 'assistant') = 0
        OR COUNT(m.id) FILTER (WHERE m.role = 'assistant' AND m.content = $1) > 0
      ORDER BY c.started_at DESC
      LIMIT 200
    `, [GENERIC_FAILURE_TEXT]);

    res.json(rows.map((r) => ({
      conversationId: r.conversation_id,
      visitorLabel: r.visitor_label,
      startedAt: r.started_at,
      businessName: r.business_name,
      businessSlug: r.business_slug,
      messageCount: Number(r.message_count),
      reason: Number(r.assistant_count) === 0 ? 'no_reply' : 'generic_failure',
      lastUserMessage: r.last_user_message,
    })));
  } catch (err) {
    console.error('Erreur GET /api/superadmin/diagnostics/broken-conversations:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// Détail d'une conversation, pour l'équipe WHATGO — sans restriction de
// business_id (contrairement à /api/dashboard/conversations/:id, réservée
// au client propriétaire), puisque l'équipe doit pouvoir inspecter la
// conversation de n'importe quel client pour diagnostiquer un problème.
app.get('/api/superadmin/conversations/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { rows: convoRows } = await query(
      `SELECT c.*, b.name as business_name FROM conversations c JOIN businesses b ON b.id = c.business_id WHERE c.id = $1`,
      [req.params.id]
    );
    const convo = convoRows[0];
    if (!convo) {
      return res.status(404).json({ error: 'Conversation introuvable.' });
    }

    const { rows: messages } = await query(
      'SELECT role, content, used_fallback, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );

    res.json({ conversation: convo, messages });
  } catch (err) {
    console.error('Erreur GET /api/superadmin/conversations/:id:', err);
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
  // Assistante du site whatgo.ai : Victoria (une seule fois, sans écraser un
  // réglage fait ensuite).
  await query(
    `UPDATE businesses SET bot_name = 'Victoria', bot_avatar = '/avatars/victoria.jpg'
     WHERE slug = 'whatgo' AND bot_name IS NULL AND bot_avatar IS NULL`
  ).catch(() => {});
  // Questions fréquentes cliquables du site whatgo.ai (une seule fois).
  await query(
    `UPDATE businesses SET bot_suggestions = '{"fr": [{"label": "📅 Obtenir une démo", "text": "Je souhaite obtenir une démo"}, {"label": "💶 Voir les tarifs", "text": "Quels sont vos tarifs ?"}, {"label": "⚙️ Comment ça marche", "text": "Comment fonctionne WHATGO AI ?"}, {"label": "🔗 Intégration CRM", "text": "Est-ce que WHATGO se connecte à mon CRM ?"}], "en": [{"label": "📅 Book a demo", "text": "I would like to book a demo"}, {"label": "💶 See pricing", "text": "What are your prices?"}, {"label": "⚙️ How it works", "text": "How does WHATGO AI work?"}, {"label": "🔗 CRM integration", "text": "Does WHATGO connect to my CRM?"}]}'
     WHERE slug = 'whatgo' AND bot_suggestions IS NULL`
  ).catch(() => {});
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
