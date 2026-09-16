// ============================================================
// seed.js — Crée une nouvelle entreprise cliente + son 1er compte
// ============================================================
// Utilisation dans le terminal :
//   node seed.js "WHATGO AI" whatgo admin@whatgo.ai motdepasse123
//
const db = require('./db');
const { hashPassword } = require('./auth');

async function main() {
  const [, , name, slug, email, password] = process.argv;

  if (!name || !slug || !email || !password) {
    console.log('Utilisation : node seed.js "Nom Entreprise" identifiant-url email mot-de-passe');
    console.log('Exemple     : node seed.js "WHATGO AI" whatgo admin@whatgo.ai motdepasse123');
    process.exit(1);
  }

  const defaultPrompt = `Tu es l'assistant virtuel de "${name}". Réponds uniquement à partir des informations que l'équipe WHATGO ajoutera ici. Si tu ne sais pas, dis-le plutôt que d'inventer.`;

  const insertBusiness = db.prepare(
    'INSERT INTO businesses (slug, name, system_prompt) VALUES (?, ?, ?)'
  );
  const result = insertBusiness.run(slug, name, defaultPrompt);
  const businessId = result.lastInsertRowid;

  const passwordHash = await hashPassword(password);
  const insertUser = db.prepare(
    'INSERT INTO users (business_id, email, password_hash, role) VALUES (?, ?, ?, ?)'
  );
  insertUser.run(businessId, email, passwordHash, 'admin');

  console.log(`✅ Entreprise "${name}" créée (identifiant : ${slug})`);
  console.log(`✅ Compte admin créé : ${email}`);
  console.log(`\nPour te connecter : va sur /dashboard.html avec cet email et ce mot de passe.`);
  console.log(`\nBalise à coller sur le site :`);
  console.log(`<script src="widget.js" data-server="URL-DU-SERVEUR/api/chat" data-business="${slug}"></script>`);
}

main();
