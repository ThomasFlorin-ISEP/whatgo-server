// ============================================================
// db.js — Connexion et schéma de la base de données SQLite
// ============================================================
// SQLite stocke tout dans UN SEUL fichier (whatgo.db), créé
// automatiquement au premier lancement. Aucun serveur de base
// de données séparé à installer.

const Database = require('better-sqlite3');
const db = new Database('whatgo.db');

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slug          TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id   INTEGER NOT NULL REFERENCES businesses(id),
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'lecture')),
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id   INTEGER NOT NULL REFERENCES businesses(id),
    visitor_label TEXT,
    started_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  -- Comptes super-admin (l'équipe WHATGO) : totalement séparés des comptes
  -- clients, pour ne jamais toucher aux contraintes de la table "users".
  CREATE TABLE IF NOT EXISTS super_admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  -- Leads réels captés depuis le chat : un visiteur qui laisse son email.
  -- Table toute neuve, pas de migration à faire (contrairement aux colonnes
  -- ajoutées à "businesses" via addColumnIfMissing() plus bas).
  CREATE TABLE IF NOT EXISTS leads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id     INTEGER NOT NULL,
    conversation_id INTEGER,
    email           TEXT NOT NULL,
    message         TEXT,
    score           INTEGER NOT NULL DEFAULT 40,
    status          TEXT NOT NULL DEFAULT 'nouveau',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ------------------------------------------------------------
// Migrations douces : on ajoute des colonnes à "businesses" sans
// jamais toucher aux données déjà là. addColumnIfMissing() renvoie
// true seulement la toute première fois qu'elle ajoute la colonne
// (utile pour ne lancer un ajustement ponctuel qu'une seule fois).
// ------------------------------------------------------------
function addColumnIfMissing(table, columnDef) {
  const columnName = columnDef.trim().split(/\s+/)[0];
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    return true;
  } catch (err) {
    if (err.message && err.message.includes('duplicate column name')) {
      return false;
    }
    throw err;
  }
}

const statusJustAdded = addColumnIfMissing('businesses', "status TEXT NOT NULL DEFAULT 'draft'");
addColumnIfMissing('businesses', "sector TEXT DEFAULT ''");
addColumnIfMissing('businesses', "intro TEXT DEFAULT ''");
addColumnIfMissing('businesses', "faq TEXT DEFAULT '[]'");
addColumnIfMissing('businesses', "pricing TEXT DEFAULT ''");
addColumnIfMissing('businesses', "hours TEXT DEFAULT ''");
addColumnIfMissing('businesses', "webhook_url TEXT DEFAULT ''");
// Règles de qualification (infos à collecter, seuils de score, escalade,
// sujets bloqués) : un blob JSON, pour éviter une migration multi-tables
// tant que cette structure est encore amenée à évoluer.
addColumnIfMissing('businesses', "qualification TEXT DEFAULT '{}'");

// Les entreprises qui existaient déjà avant l'introduction du statut
// brouillon/publié fonctionnaient déjà en direct : on les considère
// "publiées" d'office, une seule fois, au moment où la colonne apparaît.
if (statusJustAdded) {
  db.exec("UPDATE businesses SET status = 'published' WHERE status = 'draft'");
}

module.exports = db;
