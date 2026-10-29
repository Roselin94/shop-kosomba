const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const ROOT = __dirname;
const DATA_DIR = process.env.SHOP_DATA_DIR || path.join(ROOT, '.data');
const DB_PATH = path.join(DATA_DIR, 'shop-kosomba.sqlite');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const APP_ORIGIN = process.env.APP_ORIGIN || '';
const PERMISSIONS = new Set(['Ventes', 'Stock', 'Factures', 'Utilisateurs']);
const ROLES = new Set(['Administratrice', 'Vendeur', 'Gestionnaire de stock', 'Comptable', 'Personnalisé']);
const COOKIE = 'shopkosomba_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 7 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const IMAGE_DIR = path.join(DATA_DIR, 'images');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credentials (
    user_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, salt TEXT NOT NULL, password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, document_id TEXT NOT NULL, type TEXT NOT NULL,
    client TEXT NOT NULL, total REAL NOT NULL, item_count INTEGER NOT NULL, sold_by TEXT NOT NULL,
    created_at TEXT NOT NULL, read_at TEXT, UNIQUE (user_id, document_id)
  );
  CREATE INDEX IF NOT EXISTS notifications_user_unread ON notifications (user_id, read_at, created_at);
`);

if (!db.prepare('SELECT id FROM app_state WHERE id = 1').get()) {
  const initial = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed.json'), 'utf8'));
  initial.documents = initial.documents.map(({ dateOffsetDays, ...doc }) => ({
    ...doc,
    date: new Date(Date.now() - dateOffsetDays * 86400000).toISOString()
  }));
  initial.activity = initial.activity.map(item => ({ ...item, date: new Date().toISOString() }));
  db.prepare('INSERT INTO app_state (id, revision, payload) VALUES (1, 1, ?)').run(JSON.stringify(initial));
}

const getStateRow = () => db.prepare('SELECT revision, payload FROM app_state WHERE id = 1').get();
const getState = () => JSON.parse(getStateRow().payload);
const hashToken = value => crypto.createHash('sha256').update(value).digest('hex');
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt,
  hash: crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex')
});
const safeUser = user => ({ id: user.id, name: user.name, email: user.email, role: user.role, permissions: user.permissions });
const stateFor = (user, state) => user.permissions.includes('Utilisateurs') ? state : { ...state, users: [] };

function send(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
function fail(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.extra = extra;
  throw error;
}
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail(413, 'Requête trop volumineuse.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { fail(400, 'Corps JSON invalide.'); }
}
function getCookie(req) {
  const entry = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='));
  return entry ? decodeURIComponent(entry.slice(COOKIE.length + 1)) : '';
}
function setSession(res, token, req) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}
function currentUser(req) {
  const token = getCookie(req);
  if (!token) return null;
  const session = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token));
  if (!session || session.expires_at < Date.now()) return null;
  const user = getState().users.find(item => item.id === session.user_id && item.active);
  return user || null;
}
function requireUser(req) {
  const user = currentUser(req);
  if (!user) fail(401, 'Connexion requise.');
  return user;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch { fail(403, 'Origine refusée.'); }
  if (parsed.host !== req.headers.host && parsed.origin !== APP_ORIGIN) fail(403, 'Origine refusée.');
}
function startSession(userId, res, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, Date.now() + SESSION_MS);
  setSession(res, token, req);
}
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function cleanState(input) {
  if (!input || !Array.isArray(input.products) || !Array.isArray(input.users) || !Array.isArray(input.documents) || !Array.isArray(input.activity)) fail(400, 'Format de données invalide.');
  if (input.products.length > 10000 || input.users.length > 1000 || input.documents.length > 100000 || (Array.isArray(input.clients) && input.clients.length > 20000)) fail(400, 'Limite de données dépassée.');
  const products = input.products.map(product => {
    if (!product.id || !product.name?.trim() || !product.sku?.trim() || !product.category?.trim()) fail(400, 'Produit invalide.');
    for (const field of ['price', 'cost', 'stock', 'threshold']) if (!Number.isFinite(Number(product[field])) || Number(product[field]) < 0) fail(400, 'Valeur de produit invalide.');
    const photo = String(product.photo || '');
    if (photo && !/^\/images\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(photo)) fail(400, 'Photo de produit invalide.');
    return { id: String(product.id), name: String(product.name).trim(), sku: String(product.sku).trim(), category: String(product.category).trim(), price: Number(product.price), cost: Number(product.cost), stock: Number(product.stock), threshold: Number(product.threshold), barcode: String(product.barcode || ''), photo };
  });
  if (new Set(products.map(p => p.id)).size !== products.length || new Set(products.map(p => p.sku.toLowerCase())).size !== products.length) fail(409, 'Identifiant ou référence produit déjà utilisé.');
  const users = input.users.map(user => {
    if (!user.id || !user.name?.trim() || !user.email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) || !ROLES.has(user.role) || typeof user.active !== 'boolean' || !Array.isArray(user.permissions) || user.permissions.some(p => !PERMISSIONS.has(p))) fail(400, 'Membre ou permissions invalides.');
    return { id: String(user.id), name: String(user.name).trim(), email: String(user.email).trim().toLowerCase(), role: user.role, permissions: [...new Set(user.permissions)], active: user.active };
  });
  if (new Set(users.map(u => u.id)).size !== users.length || new Set(users.map(u => u.email)).size !== users.length) fail(409, 'Identifiant ou adresse e-mail déjà utilisé.');
  if (users.filter(u => u.active && u.permissions.includes('Utilisateurs')).length === 0) fail(400, 'Au moins un compte actif doit conserver la permission Utilisateurs.');
  const documents = input.documents.map(doc => {
    if (!doc.id || !['Facture', 'Ticket', 'Proforma', 'Avoir'].includes(doc.type) || !Array.isArray(doc.items) || !Number.isFinite(Number(doc.total))) fail(400, 'Document invalide.');
    return { id: String(doc.id), type: doc.type, originalDocumentId: String(doc.originalDocumentId || ''), date: String(doc.date), client: String(doc.client || ''), clientPhone: String(doc.clientPhone || ''), clientAddress: String(doc.clientAddress || ''), total: Number(doc.total), discount: Number(doc.discount || 0), status: String(doc.status || ''), payment: String(doc.payment || ''), items: doc.items.map(item => ({ name: String(item.name), qty: Number(item.qty), price: Number(item.price) })) };
  });
  const clients = Array.isArray(input.clients) ? input.clients.map(c => ({
    id: String(c.id || ('c' + Date.now())),
    name: String(c.name || '').trim(),
    phone: String(c.phone || '').trim(),
    whatsapp: String(c.whatsapp || c.phone || '').trim(),
    email: String(c.email || '').trim().toLowerCase(),
    address: String(c.address || '').trim(),
    notes: String(c.notes || '').trim(),
    createdAt: String(c.createdAt || new Date().toISOString())
  })).filter(c => c.name.length > 0) : [];
  const expenses = Array.isArray(input.expenses) ? input.expenses.map(e => {
    if (!e.nature || !String(e.nature).trim()) fail(400, 'La nature de la dépense est obligatoire.');
    return {
      id: String(e.id || ('exp_' + Date.now())),
      nature: String(e.nature).trim(),
      amount: Math.abs(Number(e.amount) || 0),
      date: String(e.date || new Date().toISOString()),
      payment: String(e.payment || 'Espèce'),
      description: String(e.description || '').trim(),
      recordedBy: String(e.recordedBy || '')
    };
  }) : [];
  const activity = input.activity.slice(0, 100).map(item => ({ text: String(item.text || '').replace(/<[^>]*>/g, '').slice(0, 500), date: String(item.date || new Date().toISOString()), icon: String(item.icon || 'circle-dot') }));
  return { products, users, documents, clients, expenses, activity };
}

const loginAttempts = new Map();
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/logo.png' || url.pathname === '/favicon.ico' || url.pathname === '/robots.txt' || url.pathname === '/chart.umd.min.js')) {
      let targetPath = path.join(ROOT, url.pathname.slice(1));
      if (!fs.existsSync(targetPath)) {
        targetPath = path.join(ROOT, 'dist', url.pathname.slice(1));
      }
      if (fs.existsSync(targetPath)) {
        const ext = path.extname(targetPath).toLowerCase();
        const mime = { '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain', '.js': 'application/javascript; charset=utf-8' }[ext] || 'application/octet-stream';
        const fileContent = fs.readFileSync(targetPath);
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': fileContent.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
        res.end(fileContent);
        return;
      }
    }
    const imageMatch = /^\/images\/([a-f0-9]{64})\.(jpg|png|webp)$/.exec(url.pathname);
    if (req.method === 'GET' && imageMatch) {
      requireUser(req);
      const imagePath = path.join(IMAGE_DIR, `${imageMatch[1]}.${imageMatch[2]}`);
      if (!fs.existsSync(imagePath)) fail(404, 'Photo introuvable.');
      const image = fs.readFileSync(imagePath);
      const mime = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[imageMatch[2]];
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': image.length, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
      res.end(image);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') sameOrigin(req);
      if (req.method === 'GET' && url.pathname === '/api/health') {
        send(res, 200, { status: 'ok', uptime: process.uptime() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/setup-status') {
        send(res, 200, { required: db.prepare('SELECT COUNT(*) AS count FROM credentials').get().count === 0 });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/images') {
        const actor = requireUser(req);
        if (actor.role !== 'Administratrice' || !actor.permissions.includes('Stock')) fail(403, 'Seule l’administratrice disposant de la permission Stock peut ajouter une photo.');
        const body = await readJson(req);
        const dataUrl = String(body.dataUrl || '');
        const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
        if (!match) fail(400, 'Format d’image invalide. Utilisez JPG, PNG ou WebP.');
        const image = Buffer.from(match[2], 'base64');
        if (!image.length || image.length > MAX_IMAGE) fail(413, 'La photo ne doit pas dépasser 5 Mo.');
        const signatureValid = match[1] === 'jpeg' ? image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
          : match[1] === 'png' ? image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : image.subarray(0, 4).toString() === 'RIFF' && image.subarray(8, 12).toString() === 'WEBP';
        if (!signatureValid) fail(400, 'Le contenu du fichier ne correspond pas à son format image.');
        const digest = crypto.createHash('sha256').update(image).digest('hex');
        const extension = { jpeg: 'jpg', png: 'png', webp: 'webp' }[match[1]];
        fs.mkdirSync(IMAGE_DIR, { recursive: true });
        const imagePath = path.join(IMAGE_DIR, `${digest}.${extension}`);
        if (!fs.existsSync(imagePath)) fs.writeFileSync(imagePath, image, { flag: 'wx' });
        send(res, 201, { photo: `/images/${digest}.${extension}` });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/setup') {
        const body = await readJson(req);
        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (db.prepare('SELECT COUNT(*) AS count FROM credentials').get().count !== 0) fail(409, 'Le compte administrateur est déjà créé.');
        if (name.length < 2 || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128) fail(400, 'Nom, e-mail valide et mot de passe de 12 caractères minimum requis.');
        const state = getState();
        const admin = state.users.find(user => user.id === 'u1');
        if (!admin) fail(500, 'Compte initial introuvable.');
        admin.name = name;
        admin.email = email;
        const credentials = hashPassword(password);
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT INTO credentials (user_id, email, salt, password_hash) VALUES (?, ?, ?, ?)').run(admin.id, email, credentials.salt, credentials.hash);
          db.prepare('UPDATE app_state SET payload = ?, revision = revision + 1 WHERE id = 1').run(JSON.stringify(state));
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        startSession(admin.id, res, req);
        send(res, 201, { user: safeUser(admin) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const body = await readJson(req);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const ip = req.socket.remoteAddress || 'local';
        const attempt = loginAttempts.get(ip) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
        if (attempt.until < Date.now()) { attempt.count = 0; attempt.until = Date.now() + 15 * 60 * 1000; }
        if (attempt.count >= 8) fail(429, 'Trop de tentatives. Réessayez dans 15 minutes.');
        // Clean up expired sessions
        db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
        const row = db.prepare('SELECT user_id, salt, password_hash FROM credentials WHERE email = ? COLLATE NOCASE').get(email);
        const candidate = row ? hashPassword(password, row.salt).hash : crypto.pbkdf2Sync(password, 'shop-kosomba-login-padding', 210000, 32, 'sha256').toString('hex');
        const valid = row && crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(row.password_hash, 'hex'));
        const user = valid ? getState().users.find(item => item.id === row.user_id && item.active) : null;
        if (!user) { attempt.count++; loginAttempts.set(ip, attempt); fail(401, 'E-mail ou mot de passe incorrect.'); }
        loginAttempts.delete(ip);
        // Automatically replace any existing session for this user so they don't get locked out
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
        startSession(user.id, res, req);
        send(res, 200, { user: safeUser(user) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        const token = getCookie(req);
        if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
        clearSessionCookie(res);
        send(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/me') {
        const user = requireUser(req);
        send(res, 200, { user: safeUser(user) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/notifications') {
        const user = requireUser(req);
        if (user.role !== 'Administratrice') fail(403, 'Notifications réservées aux comptes administrateurs.');
        const notifications = db.prepare('SELECT id, document_id AS documentId, type, client, total, item_count AS itemCount, sold_by AS soldBy, created_at AS createdAt, read_at AS readAt FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(user.id);
        const unread = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id).count;
        send(res, 200, { notifications, unread });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/notifications/read') {
        const user = requireUser(req);
        if (user.role !== 'Administratrice') fail(403, 'Notifications réservées aux comptes administrateurs.');
        const body = await readJson(req);
        if (body.all === true) db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(new Date().toISOString(), user.id);
        else {
          if (!Array.isArray(body.ids) || body.ids.length > 100) fail(400, 'Liste de notifications invalide.');
          const markOne = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL');
          const readAt = new Date().toISOString();
          for (const id of body.ids) markOne.run(readAt, String(id), user.id);
        }
        const unread = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id).count;
        send(res, 200, { unread });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/reset-business') {
        const actor = requireUser(req);
        if (actor.role !== 'Administratrice') fail(403, 'La réinitialisation est réservée aux comptes administrateurs.');
        const body = await readJson(req);
        const row = getStateRow();
        if (Number(body.revision) !== row.revision) fail(409, 'Les données ont changé dans une autre session. Actualisez avant de réessayer.', { revision: row.revision });
        const existing = JSON.parse(row.payload);
        const resetState = cleanState({
          ...existing,
          products: (existing.products || []).map(product => ({ ...product, stock: 0 })),
          documents: [],
          expenses: [],
          activity: [{ text: 'Réinitialisation des ventes, dépenses et stocks', date: new Date().toISOString(), icon: 'rotate-ccw' }, ...(existing.activity || [])]
        });
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = getStateRow();
          if (current.revision !== row.revision) fail(409, 'Les données ont changé dans une autre session. Actualisez avant de réessayer.', { revision: current.revision });
          db.prepare('UPDATE app_state SET payload = ?, revision = revision + 1 WHERE id = 1').run(JSON.stringify(resetState));
          db.prepare('DELETE FROM notifications').run();
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        const saved = getStateRow();
        send(res, 200, { state: stateFor(actor, JSON.parse(saved.payload)), revision: saved.revision });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const user = requireUser(req);
        const row = getStateRow();
        send(res, 200, { state: stateFor(user, JSON.parse(row.payload)), revision: row.revision });
        return;
      }
      if (req.method === 'PUT' && url.pathname === '/api/state') {
        const actor = requireUser(req);
        const body = await readJson(req);
        const row = getStateRow();
        if (Number(body.revision) !== row.revision) fail(409, 'Les données ont changé dans une autre session. Actualisez avant de réessayer.', { revision: row.revision });
        const existing = JSON.parse(row.payload);
        if (!actor.permissions.includes('Utilisateurs')) {
          const requestedUsers = body.state?.users;
          if (Array.isArray(requestedUsers) && requestedUsers.length === 0) body.state.users = existing.users;
          else if (!deepEqual(requestedUsers, existing.users)) fail(403, 'Permission Utilisateurs requise.');
        }
        const incoming = cleanState(body.state);
        const changes = {
          products: !deepEqual(incoming.products, existing.products),
          documents: !deepEqual(incoming.documents, existing.documents),
          users: !deepEqual(incoming.users, existing.users),
          clients: !deepEqual(incoming.clients, existing.clients || [])
        };
        if (changes.products && !actor.permissions.includes('Stock')) fail(403, 'Permission Stock requise.');
        if (changes.documents && !actor.permissions.includes('Ventes')) fail(403, 'Permission Ventes requise.');
        if (changes.users && !actor.permissions.includes('Utilisateurs')) fail(403, 'Permission Utilisateurs requise.');
        if (changes.clients && !actor.permissions.includes('Factures') && !actor.permissions.includes('Ventes')) fail(403, 'Permission Factures ou Ventes requise.');
        const passwords = body.passwords || {};
        const oldById = new Map(existing.users.map(user => [user.id, user]));
        const newById = new Map(incoming.users.map(user => [user.id, user]));
        const actorAfterUpdate = newById.get(actor.id);
        if (!actorAfterUpdate || !actorAfterUpdate.active) fail(400, 'Vous ne pouvez pas supprimer ou désactiver votre propre compte.');
        for (const user of incoming.users) {
          const oldUser = oldById.get(user.id);
          const password = typeof passwords[user.id] === 'string' ? passwords[user.id] : '';
          if (!oldUser && (password.length < 12 || password.length > 128)) fail(400, `Un mot de passe initial de 12 caractères minimum est requis pour ${user.name}.`);
          if (password && (password.length < 12 || password.length > 128)) fail(400, 'Le mot de passe doit contenir de 12 à 128 caractères.');
        }
        const authIds = new Set(db.prepare('SELECT user_id FROM credentials').all().map(row => row.user_id));
        for (const user of incoming.users) {
          if (oldById.has(user.id) && !authIds.has(user.id)) fail(400, `Aucun compte de connexion n’existe pour ${user.name}; supprimez ce membre et recréez-le avec un mot de passe.`);
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = getStateRow();
          if (current.revision !== row.revision) fail(409, 'Les données ont changé dans une autre session.', { revision: current.revision });
          for (const oldUser of existing.users) {
            const next = newById.get(oldUser.id);
            if (!next || !next.active) {
              db.prepare('DELETE FROM sessions WHERE user_id = ?').run(oldUser.id);
              db.prepare('DELETE FROM credentials WHERE user_id = ?').run(oldUser.id);
              continue;
            }
            const password = passwords[next.id];
            if (password) {
              const credentials = hashPassword(password);
              db.prepare('UPDATE credentials SET email = ?, salt = ?, password_hash = ? WHERE user_id = ?').run(next.email, credentials.salt, credentials.hash, next.id);
            } else {
              db.prepare('UPDATE credentials SET email = ? WHERE user_id = ?').run(next.email, next.id);
            }
          }
          for (const user of incoming.users) {
            if (!oldById.has(user.id)) {
              const credentials = hashPassword(passwords[user.id]);
              db.prepare('INSERT INTO credentials (user_id, email, salt, password_hash) VALUES (?, ?, ?, ?)').run(user.id, user.email, credentials.salt, credentials.hash);
            }
          }
          const existingDocumentIds = new Set(existing.documents.map(document => document.id));
          const newSales = incoming.documents.filter(document => !existingDocumentIds.has(document.id));
          if (actor.role !== 'Administratrice' && newSales.length) {
            const administrators = incoming.users.filter(user => user.active && user.role === 'Administratrice');
            const addNotification = db.prepare('INSERT OR IGNORE INTO notifications (id, user_id, document_id, type, client, total, item_count, sold_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
            for (const document of newSales) {
              for (const administrator of administrators) {
                if (administrator.id === actor.id) continue;
                addNotification.run(crypto.randomUUID(), administrator.id, document.id, document.type, document.client, document.total, document.items.reduce((sum, item) => sum + item.qty, 0), actor.name, document.date);
              }
            }
          }
          db.prepare('UPDATE app_state SET payload = ?, revision = revision + 1 WHERE id = 1').run(JSON.stringify(incoming));
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        const saved = getStateRow();
        send(res, 200, { state: stateFor(actor, JSON.parse(saved.payload)), revision: saved.revision });
        return;
      }
      send(res, 404, { error: 'Route API introuvable.' });
      return;
    }
    send(res, 404, { error: 'Page introuvable.' });
  } catch (error) {
    const status = error.status || (error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 500);
    if (status >= 500) console.error(error);
    if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Erreur serveur.' : error.message, ...(error.extra || {}) });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Shop Kosomba disponible sur http://${HOST}:${PORT}`);
  if (db.prepare('SELECT COUNT(*) AS count FROM credentials').get().count === 0) console.log('Au premier accès, créez le compte administrateur.');
});
process.on('SIGINT', () => { server.close(() => { db.close(); process.exit(0); }); });
process.on('SIGTERM', () => { server.close(() => { db.close(); process.exit(0); }); });
