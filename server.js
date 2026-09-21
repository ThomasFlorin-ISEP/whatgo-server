// ============================================================
// server.js — Serveur multi-clients (Gemini) avec tableau de bord
// ============================================================
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const db = require('./db');
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Appelle Gemini avec une logique de réessai automatique : si l'API répond
// une erreur 503 "UNAVAILABLE" (surcharge temporaire chez Google), on
// retente jusqu'à 2 fois avec un court délai avant d'abandonner. Les autres
// erreurs (clé API invalide, requête mal formée, etc.) ne sont PAS retentées,
// puisqu'elles ne se résoudraient pas d'elles-mêmes.
async function callGemini(systemPrompt, contents, maxRetries = 2) {
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
        await sleep(800 * (attempt + 1));
        continue;
      }
      throw networkErr;
    }

    const isOverloaded = data.error && (data.error.code === 503 || data.error.status === 'UNAVAILABLE');
    if (isOverloaded && attempt < maxRetries) {
      console.warn(`Gemini surchargé (tentative ${attempt + 1}/${maxRetries + 1}), nouvel essai dans ${800 * (attempt + 1)}ms...`);
      await sleep(800 * (attempt + 1)); // 800ms, puis 1600ms
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

    const business = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slug);
    if (!business) {
      return res.status(404).json({ error: 'Entreprise inconnue.' });
    }

    // Retrouver ou créer la conversation, pour pouvoir tout enregistrer
    let convoId = conversationId;
    if (!convoId) {
      const result = db.prepare(
        'INSERT INTO conversations (business_id, visitor_label) VALUES (?, ?)'
      ).run(business.id, 'Visiteur anonyme');
      convoId = result.lastInsertRowid;
    }

    // Enregistrer le dernier message du visiteur
    const lastUserMessage = messages[messages.length - 1];
    db.prepare(
      'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)'
    ).run(convoId, 'user', lastUserMessage.content);

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
      }
    }

    // Entreprise pas encore publiée : réponse d'attente, pas d'appel à Gemini
    // (évite d'improviser avec un contenu vide ou incomplet).
    if (business.status !== 'published') {
      db.prepare(
        'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)'
      ).run(convoId, 'assistant', DRAFT_REPLY);
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
    db.prepare(
      'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)'
    ).run(convoId, 'assistant', reply);

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
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  // On regarde d'abord côté équipe WHATGO (super-admin)
  const superAdmin = db.prepare('SELECT * FROM super_admins WHERE email = ?').get(email);
  if (superAdmin && (await verifyPassword(password, superAdmin.password_hash))) {
    const token = signToken({ id: superAdmin.id, business_id: null, role: 'super_admin' });
    res.cookie('whatgo_token', token, {
      httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    return res.json({ email: superAdmin.email, role: 'super_admin', business: 'WHATGO (équipe)' });
  }

  // Sinon, compte client classique
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
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

  const business = db.prepare('SELECT name FROM businesses WHERE id = ?').get(user.business_id);
  res.json({ email: user.email, role: user.role, business: business.name });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('whatgo_token');
  res.json({ ok: true });
});

app.put('/api/auth/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Mot de passe actuel requis, et nouveau mot de passe d\'au moins 8 caractères.' });
  }

  const table = req.user.role === 'super_admin' ? 'super_admins' : 'users';
  const account = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.user.userId);
  if (!account || !(await verifyPassword(currentPassword, account.password_hash))) {
    return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
  }

  const hash = await hashPassword(newPassword);
  db.prepare(`UPDATE ${table} SET password_hash = ? WHERE id = ?`).run(hash, req.user.userId);
  res.json({ ok: true });
});

// ============================================================
// 3) TABLEAU DE BORD CLIENT — routes protégées, filtrées par entreprise
// ============================================================
app.get('/api/dashboard/me', requireAuth, (req, res) => {
  if (req.user.role === 'super_admin') {
    return res.json({ role: 'super_admin', business: 'WHATGO (équipe)' });
  }
  const business = db.prepare('SELECT name, status FROM businesses WHERE id = ?').get(req.user.businessId);
  res.json({ role: req.user.role, business: business.name, status: business.status });
});

app.get('/api/dashboard/conversations', requireAuth, requireRole(['admin', 'lecture']), (req, res) => {
  const conversations = db.prepare(`
    SELECT c.id, c.visitor_label, c.started_at,
           COUNT(m.id) as message_count
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    WHERE c.business_id = ?
    GROUP BY c.id
    ORDER BY c.started_at DESC
    LIMIT 200
  `).all(req.user.businessId);

  res.json(conversations);
});

app.get('/api/dashboard/conversations/:id', requireAuth, requireRole(['admin', 'lecture']), (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);

  if (!convo || convo.business_id !== req.user.businessId) {
    return res.status(404).json({ error: 'Conversation introuvable.' });
  }

  const messages = db.prepare(
    'SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(req.params.id);

  res.json({ conversation: convo, messages });
});

// Statistiques pour la vue d'ensemble du tableau de bord
app.get('/api/dashboard/stats', requireAuth, requireRole(['admin', 'lecture']), (req, res) => {
  const businessId = req.user.businessId;

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM conversations WHERE business_id = ?) as total_conversations,
      (SELECT COUNT(*) FROM conversations WHERE business_id = ? AND started_at >= datetime('now', '-30 days')) as conversations_30d,
      (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.business_id = ?) as total_messages
  `).get(businessId, businessId, businessId);

  const perDayRows = db.prepare(`
    SELECT date(started_at) as day, COUNT(*) as count
    FROM conversations
    WHERE business_id = ? AND started_at >= datetime('now', '-13 days')
    GROUP BY day
    ORDER BY day ASC
  `).all(businessId);

  // On complète les jours sans conversation avec un compteur à 0,
  // pour que le graphique ait toujours 14 barres alignées sur les 14 derniers jours.
  const perDay = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const found = perDayRows.find((r) => r.day === key);
    perDay.push({ day: key, count: found ? found.count : 0 });
  }

  const avgMessages = totals.total_conversations
    ? Math.round((totals.total_messages / totals.total_conversations) * 10) / 10
    : 0;

  res.json({
    totalConversations: totals.total_conversations,
    conversations30d: totals.conversations_30d,
    avgMessagesPerConversation: avgMessages,
    perDay,
  });
});

// Page "Contenu" : lecture et modification de la FAQ, tarifs, horaires...
app.get('/api/dashboard/content', requireAuth, requireRole(['admin', 'lecture']), (req, res) => {
  const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.user.businessId);
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
});

app.put('/api/dashboard/content', requireAuth, requireRole('admin'), (req, res) => {
  const { sector, intro, faq, pricing, hours } = req.body;
  const faqArr = Array.isArray(faq)
    ? faq.filter((f) => f && f.question && f.answer)
    : [];

  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.user.businessId);
  const updated = {
    ...business,
    sector: sector || '',
    intro: intro || '',
    faq: JSON.stringify(faqArr),
    pricing: pricing || '',
    hours: hours || '',
  };
  const newSystemPrompt = buildSystemPrompt(updated);

  db.prepare(`
    UPDATE businesses
    SET sector = ?, intro = ?, faq = ?, pricing = ?, hours = ?, system_prompt = ?
    WHERE id = ?
  `).run(sector || '', intro || '', JSON.stringify(faqArr), pricing || '', hours || '', newSystemPrompt, req.user.businessId);

  res.json({ ok: true });
});

// Page "Intégrations" : où envoyer les leads qualifiés (via Make/Zapier...)
app.get('/api/dashboard/webhook', requireAuth, requireRole(['admin', 'lecture']), (req, res) => {
  const b = db.prepare('SELECT webhook_url FROM businesses WHERE id = ?').get(req.user.businessId);
  res.json({ webhookUrl: b.webhook_url || '' });
});

app.put('/api/dashboard/webhook', requireAuth, requireRole('admin'), (req, res) => {
  const { webhookUrl } = req.body;
  const value = (webhookUrl || '').trim();
  if (value && !/^https:\/\//.test(value)) {
    return res.status(400).json({ error: 'L\'adresse doit commencer par https://' });
  }
  db.prepare('UPDATE businesses SET webhook_url = ? WHERE id = ?').run(value, req.user.businessId);
  res.json({ ok: true });
});

// ============================================================
// 4) ESPACE ÉQUIPE WHATGO — création et pilotage des clients
// ============================================================
app.get('/api/superadmin/clients', requireAuth, requireSuperAdmin, (req, res) => {
  const clients = db.prepare(`
    SELECT b.id, b.slug, b.name, b.status, b.sector, b.created_at,
           COUNT(c.id) as conversation_count
    FROM businesses b
    LEFT JOIN conversations c ON c.business_id = b.id
    GROUP BY b.id
    ORDER BY b.created_at DESC
  `).all();
  res.json(clients);
});

app.post('/api/superadmin/clients', requireAuth, requireSuperAdmin, async (req, res) => {
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
  while (db.prepare('SELECT id FROM businesses WHERE slug = ?').get(finalSlug)) {
    attempt += 1;
    finalSlug = `${slug}-${attempt}`;
  }

  const placeholderPrompt = `Tu es l'assistant virtuel de "${name}". Le contenu n'a pas encore été renseigné par l'équipe WHATGO.`;

  const result = db.prepare(`
    INSERT INTO businesses (slug, name, system_prompt, status, sector)
    VALUES (?, ?, ?, 'draft', ?)
  `).run(finalSlug, name, placeholderPrompt, sector || '');
  const businessId = result.lastInsertRowid;

  try {
    const hash = await hashPassword(adminPassword);
    db.prepare(`
      INSERT INTO users (business_id, email, password_hash, role) VALUES (?, ?, ?, 'admin')
    `).run(businessId, adminEmail, hash);
  } catch (err) {
    db.prepare('DELETE FROM businesses WHERE id = ?').run(businessId);
    if (err.message && err.message.includes('UNIQUE')) {
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
});

app.put('/api/superadmin/clients/:id/status', requireAuth, requireSuperAdmin, (req, res) => {
  const { status } = req.body;
  if (!['draft', 'published'].includes(status)) {
    return res.status(400).json({ error: 'Statut invalide.' });
  }
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  if (!business) return res.status(404).json({ error: 'Entreprise introuvable.' });

  db.prepare('UPDATE businesses SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

// ============================================================
// AUTO-CRÉATION : s'assure que "WHATGO AI" et un compte admin
// existent toujours, même sur un serveur tout neuf (comme Render)
// ============================================================
async function ensureWhatgoBusiness() {
  const existing = db.prepare('SELECT * FROM businesses WHERE slug = ?').get('whatgo');

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

    const result = db.prepare(
      "INSERT INTO businesses (slug, name, system_prompt, status, sector) VALUES (?, ?, ?, 'published', 'SaaS')"
    ).run('whatgo', 'WHATGO AI', prompt);

    const hash = await hashPassword('motdepasse123');
    db.prepare(
      'INSERT INTO users (business_id, email, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run(result.lastInsertRowid, 'admin@whatgo.ai', hash, 'admin');

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

  const existing = db.prepare('SELECT * FROM super_admins WHERE email = ?').get(email);
  if (!existing) {
    const hash = await hashPassword(password);
    db.prepare('INSERT INTO super_admins (email, password_hash) VALUES (?, ?)').run(email, hash);
    console.log(`✅ Compte super-admin créé (${email} / ${password}) — pensez à changer ce mot de passe depuis le tableau de bord.`);
  } else {
    console.log('ℹ️  Compte super-admin déjà présent, rien à faire.');
  }
}

ensureWhatgoBusiness();
ensureSuperAdmin();

app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT} (Gemini + tableau de bord)`));
