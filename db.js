// ============================================================
// db.js — Connexion et schéma de la base de données PostgreSQL
// ============================================================
// La base de données vit maintenant sur un serveur PostgreSQL séparé
// (une base Render Postgres), plus dans un fichier sur le disque du
// serveur web. Les données ne disparaissent donc plus quand le service
// web s'endort/se réveille (disque éphémère) — seule la connexion
// réseau vers cette base compte.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  ATTENTION : DATABASE_URL n\'est pas défini. La connexion à la base va échouer.');
}

// En local (tests), pas besoin de SSL. Sur Render, la base l'exige.
const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

// Petit raccourci utilisé partout dans server.js : query(sql, params)
// renvoie directement le résultat pg ({ rows, rowCount, ... }).
function query(text, params = []) {
  return pool.query(text, params);
}

// ------------------------------------------------------------
// Création du schéma. PostgreSQL sait faire "ADD COLUMN IF NOT EXISTS"
// nativement : plus besoin du bricolage try/catch qu'il fallait faire
// avec SQLite (addColumnIfMissing) pour ajouter des colonnes sans
// jamais toucher aux données déjà là.
// ------------------------------------------------------------
async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS businesses (
      id            SERIAL PRIMARY KEY,
      slug          TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      business_id   INTEGER NOT NULL REFERENCES businesses(id),
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('admin', 'lecture')),
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id            SERIAL PRIMARY KEY,
      business_id   INTEGER NOT NULL REFERENCES businesses(id),
      visitor_label TEXT,
      started_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id              SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content         TEXT NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Comptes super-admin (l'équipe WHATGO) : totalement séparés des comptes
  // clients, pour ne jamais toucher aux contraintes de la table "users".
  await query(`
    CREATE TABLE IF NOT EXISTS super_admins (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Leads réels captés depuis le chat : un visiteur qui laisse son email.
  await query(`
    CREATE TABLE IF NOT EXISTS leads (
      id              SERIAL PRIMARY KEY,
      business_id     INTEGER NOT NULL,
      conversation_id INTEGER,
      email           TEXT NOT NULL,
      message         TEXT,
      score           INTEGER NOT NULL DEFAULT 40,
      status          TEXT NOT NULL DEFAULT 'nouveau',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Colonnes ajoutées à "businesses" au fil des évolutions du produit.
  await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'`);
  await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS sector TEXT DEFAULT ''`);
  await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS intro TEXT DEFAULT ''`);
  await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS faq TEXT DEFAULT '[]'`);
  await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pricing TEXT DEFAULT ''`);
  await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS hours TEXT DEFAULT ''`);
  await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS webhook_url TEXT DEFAULT ''`);
  // Règles de qualification (infos à collecter, seuils de score, escalade,
  // sujets bloqués) : un blob JSON, pour éviter une migration multi-tables
  // tant que cette structure est encore amenée à évoluer.
  await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS qualification TEXT DEFAULT '{}'`);

  // Mot de passe oublié : jeton (haché) + expiration, sur les deux tables de
  // comptes (clients et équipe WHATGO). Le jeton n'est jamais stocké en clair.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ`);
  await query(`ALTER TABLE super_admins ADD COLUMN IF NOT EXISTS reset_token_hash TEXT`);
  await query(`ALTER TABLE super_admins ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ`);

  // Téléphone du lead — demandé notamment quand le bot propose une démo
  // (email + téléphone pour confirmer). Toujours optionnel : un lead "email
  // seul" reste valide, le téléphone se rajoute si/quand le visiteur le donne.
  await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone TEXT`);

  console.log('✅ Schéma PostgreSQL prêt.');
}

module.exports = { query, pool, initDb };
