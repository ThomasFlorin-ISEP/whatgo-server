// ============================================================
// server.js — Serveur multi-clients (Gemini) avec tableau de bord
// ============================================================
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
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

    // Lead qualifié : le visiteur vient de laisser un email pour la première
    // fois dans cette conversation → on l'envoie une seule fois vers Make/Zapier.
    const newEmail = extractEmail(lastUserMessage.content);
    if (newEmail) {
      const priorUserMessages = messages.slice(0, -1).filter((m) => m.role === 'user');
      const alreadyHadEmail = priorUserMessages.some((m) => extractEmail(m.content));
      if (!alreadyHadEmail) {
        sendLeadToWebhook(business, {
          business: business.name,
          slug: business.slug,
          conversationId: convoId,
          email: newEmail,
          message: lastUserMessage.content,
          date: new Date().toISOString(),
        });

        // Enregistré localement dans tous les cas, même si aucun webhook
        // Make/Zapier n'est configuré pour cette entreprise.
        const score = computeLeadScore(lastUserMessage.content, priorUserMessages.length === 0);
        await query(
          `INSERT INTO leads (business_id, conversation_id, email, message, score, status)
           VALUES ($1, $2, $3, $4, $5, 'nouveau')`,
          [business.id, convoId, newEmail, lastUserMessage.content, score]
        );
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

    const data = await callGemini(business.system_prompt, contents);

    if (data.error) {
      console.error('Erreur API Gemini:', data.error);
      return res.status(500).json({ error: data.error.message });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text
      || "Désolé, je n'ai pas pu répondre.";

    // Enregistrer la réponse de l'IA aussi
    await query(
      'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
      [convoId, 'assistant', reply]
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
      SELECT id, email, message, score, status, conversation_id, created_at
      FROM leads
      WHERE business_id = $1
      ORDER BY created_at DESC
    `, [req.user.businessId]);

    res.json(leads.map((l) => ({
      id: l.id,
      email: l.email,
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
