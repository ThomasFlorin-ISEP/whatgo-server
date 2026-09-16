// ============================================================
// server.js — Serveur multi-clients (Gemini) avec tableau de bord
// ============================================================
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const db = require('./db');
const { verifyPassword, signToken, requireAuth, requireRole } = require('./auth');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.static('../public'));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-3.1-flash-lite';

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

    // Gemini attend "contents" avec des "parts", et le rôle de l'IA
    // s'appelle "model", pas "assistant".
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: business.system_prompt }] },
        contents: contents,
      }),
    });

    const data = await response.json();

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
// 2) CONNEXION — un employé d'une entreprise se connecte
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }

  const token = signToken(user);
  res.cookie('whatgo_token', token, {
    httpOnly: true,
    secure: false,
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

// ============================================================
// 3) TABLEAU DE BORD — routes protégées, filtrées par entreprise
// ============================================================
app.get('/api/dashboard/me', requireAuth, (req, res) => {
  const business = db.prepare('SELECT name FROM businesses WHERE id = ?').get(req.user.businessId);
  res.json({ role: req.user.role, business: business.name });
});

app.get('/api/dashboard/conversations', requireAuth, (req, res) => {
  const conversations = db.prepare(`
    SELECT c.id, c.visitor_label, c.started_at,
           COUNT(m.id) as message_count
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    WHERE c.business_id = ?
    GROUP BY c.id
    ORDER BY c.started_at DESC
  `).all(req.user.businessId);

  res.json(conversations);
});

app.get('/api/dashboard/conversations/:id', requireAuth, (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);

  if (!convo || convo.business_id !== req.user.businessId) {
    return res.status(404).json({ error: 'Conversation introuvable.' });
  }

  const messages = db.prepare(
    'SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(req.params.id);

  res.json({ conversation: convo, messages });
});

app.put('/api/dashboard/business', requireAuth, requireRole('admin'), (req, res) => {
  const { system_prompt } = req.body;
  db.prepare('UPDATE businesses SET system_prompt = ? WHERE id = ?').run(system_prompt, req.user.businessId);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT} (Gemini + tableau de bord)`));
