// Amigo Secreto da Família — servidor sem dependências externas (Node 22.13+).
// Rodar: node server.js  →  http://localhost:3000   (admin em /admin)
//
// Como funciona:
//  1) O admin cadastra os participantes e as exclusões (A não tira B, e vice-versa).
//  2) Ao "iniciar", o servidor calcula o sorteio COMPLETO de uma vez (backtracking com CSPRNG),
//     garantindo que ninguém tire a si mesmo, que ninguém seja tirado duas vezes e que as
//     exclusões sejam respeitadas. Por isso o sorteio nunca "trava" no último participante.
//  3) Cada pessoa abre o link, escolhe o próprio nome e vê quem tirou UMA ÚNICA vez:
//     o servidor marca o nome como "revelado" e nunca mais devolve o resultado.
//  4) Quando todos revelaram, o servidor gera o arquivo .txt de auditoria.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_PARTICIPANTS = 60;
const SESSION_DAYS = 3;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const AUDIT_DIR = path.join(DATA_DIR, 'auditoria');
fs.mkdirSync(AUDIT_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'amigo.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  grp TEXT NOT NULL DEFAULT 'adultos',            -- grupo do sorteio: adultos | criancas
  gives_to INTEGER REFERENCES participants(id),   -- preenchido ao iniciar o sorteio
  claimed_at TEXT                                 -- quando a pessoa viu o resultado
);
CREATE TABLE IF NOT EXISTS exclusions (
  a INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  b INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// migração: bancos criados antes dos grupos ganham a coluna (todo mundo vira "adultos")
if (!db.prepare('PRAGMA table_info(participants)').all().some((c) => c.name === 'grp'))
  db.exec("ALTER TABLE participants ADD COLUMN grp TEXT NOT NULL DEFAULT 'adultos'");
if (!db.prepare('PRAGMA table_info(participants)').all().some((c) => c.name === 'note'))
  db.exec('ALTER TABLE participants ADD COLUMN note TEXT'); // observação mostrada a quem TIRAR esta pessoa
const GROUPS = { adultos: 'Adultos', criancas: 'Crianças' };
// nome da "modalidade" que cada grupo vê na hora de revelar
const TIPO = { adultos: 'Amigo Xícara', criancas: 'Amigo Doce' };
const MIN_GROUP = 3;
const groupOf = (g) => { if (!GROUPS[g]) throw new HttpError(400, 'Grupo inválido'); return g; };

const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
const setSetting = (k, v) => db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
const phase = () => getSetting('phase') || 'setup'; // setup | open

// ---------- utilidades ----------
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64), Buffer.from(hashHex, 'hex'));
}
const DUMMY_HASH = hashPassword('dummy');

function makeLimiter(max, windowMs, msg) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    const rec = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (rec.length >= max) throw new HttpError(429, msg);
    rec.push(now); hits.set(ip, rec);
  };
}
const loginLimit = makeLimiter(10, 15 * 60_000, 'Muitas tentativas. Aguarde alguns minutos.');
// a família pode estar toda no mesmo Wi-Fi (mesmo IP): limite generoso
const claimLimit = makeLimiter(120, 15 * 60_000, 'Muitas tentativas. Aguarde alguns minutos.');

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const secureFlag = (ctx) => (TRUST_PROXY && ctx.proto === 'https' ? '; Secure' : '');

function isAdmin(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); return null; }
  return token;
}
function startSession(res, ctx) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 86400;
  db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?,?)').run(token, Date.now() + maxAge * 1000);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureFlag(ctx)}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) { reject(new HttpError(413, 'Requisição grande demais')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// ---------- o sorteio ----------
// Embaralha com CSPRNG (Fisher-Yates).
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// Devolve Map(presenteador -> presenteado) ou null se for impossível.
// forbidden: Set de "a>b" (a não pode tirar b). avoidSwap: proíbe A tirar B e B tirar A.
function computeAssignment(ids, forbidden, avoidSwap) {
  const givers = shuffle(ids);
  const assign = new Map();
  const taken = new Set();
  let steps = 0;
  const LIMIT = 3_000_000;
  function dfs(i) {
    if (i === givers.length) return true;
    if (++steps > LIMIT) throw new HttpError(422, 'Restrições complexas demais para resolver. Reduza as exclusões.');
    const g = givers[i];
    for (const t of shuffle(ids)) {
      if (t === g || taken.has(t) || forbidden.has(`${g}>${t}`)) continue;
      if (avoidSwap && assign.get(t) === g) continue;
      assign.set(g, t); taken.add(t);
      if (dfs(i + 1)) return true;
      assign.delete(g); taken.delete(t);
    }
    return false;
  }
  return dfs(0) ? assign : null;
}

function startDraw(avoidSwap) {
  const all = db.prepare('SELECT id, grp FROM participants').all();
  if (!all.length) throw new HttpError(400, 'Cadastre os participantes');
  const exclusions = db.prepare('SELECT a, b FROM exclusions').all();
  const final = new Map();
  let relaxed = false;
  // cada grupo é sorteado separadamente: criança só tira criança, adulto só tira adulto
  for (const [g, label] of Object.entries(GROUPS)) {
    const ids = all.filter((p) => p.grp === g).map((p) => p.id);
    if (!ids.length) continue; // grupo opcional (ex.: sem crianças)
    if (ids.length < MIN_GROUP)
      throw new HttpError(400, `${label}: cadastre ao menos ${MIN_GROUP} participantes (hoje: ${ids.length}) ou remova todos do grupo`);
    const set = new Set(ids), forbidden = new Set();
    for (const e of exclusions) {
      if (set.has(e.a) && set.has(e.b)) { forbidden.add(`${e.a}>${e.b}`); forbidden.add(`${e.b}>${e.a}`); }
    }
    let assign = avoidSwap ? computeAssignment(ids, forbidden, true) : null;
    if (!assign) { assign = computeAssignment(ids, forbidden, false); if (assign && avoidSwap) relaxed = true; }
    if (!assign) throw new HttpError(422, `${label}: não existe sorteio possível com essas exclusões. Remova alguma regra.`);
    for (const [k, v] of assign) final.set(k, v);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const upd = db.prepare('UPDATE participants SET gives_to = ?, claimed_at = NULL WHERE id = ?');
    for (const [g, t] of final) upd.run(t, g);
    setSetting('phase', 'open');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { relaxed };
}

// ---------- auditoria ----------
function auditText() {
  const rows = db.prepare(
    `SELECT g.name AS giver, r.name AS receiver, g.claimed_at, g.grp FROM participants g
     JOIN participants r ON r.id = g.gives_to ORDER BY g.name COLLATE NOCASE`).all();
  const ex = db.prepare(
    `SELECT pa.name AS a, pb.name AS b FROM exclusions e
     JOIN participants pa ON pa.id = e.a JOIN participants pb ON pb.id = e.b`).all();
  const out = [
    'AMIGO SECRETO DA FAMÍLIA — AUDITORIA',
    `Gerado em: ${new Date().toISOString()}`,
    `Participantes: ${rows.length}`,
    `Exclusões configuradas: ${ex.length ? ex.map((e) => `${e.a} <-> ${e.b}`).join('; ') : 'nenhuma'}`,
  ];
  for (const [g, label] of Object.entries(GROUPS)) {
    const list = rows.filter((r) => r.grp === g);
    if (!list.length) continue;
    const w = Math.max(...list.map((r) => r.giver.length));
    out.push('', `GRUPO: ${label.toUpperCase()} (${list.length})`,
      'quem presenteia -> quem recebe | momento em que viu o resultado, UTC', '-'.repeat(72),
      ...list.map((r) => `${r.giver.padEnd(w)}  ->  ${r.receiver}   | ${r.claimed_at}`));
  }
  return out.join('\n') + '\n';
}
function maybeWriteAudit() {
  const left = db.prepare('SELECT COUNT(*) c FROM participants WHERE claimed_at IS NULL').get().c;
  if (phase() !== 'open' || left > 0) return null;
  const file = `auditoria-amigo-secreto-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  fs.writeFileSync(path.join(AUDIT_DIR, file), auditText(), 'utf8');
  console.log(`Auditoria gerada: ${file}`);
  return file;
}
const latestAudit = () => fs.readdirSync(AUDIT_DIR).filter((f) => f.endsWith('.txt')).sort().pop() || null;

// ---------- rotas ----------
const routes = [];
const route = (method, pattern, opts, handler) =>
  routes.push({ method, regex: new RegExp(`^${pattern}$`), admin: opts.admin === true, handler });

// --- públicas (participantes) ---
route('GET', '/api/state', {}, (ctx) => {
  const ph = phase();
  // lista única: adultos e crianças aparecem no mesmo lugar (o grupo só define com quem cada um sorteia)
  const total = db.prepare('SELECT COUNT(*) c FROM participants').get().c;
  const pending = ph === 'open'
    ? db.prepare('SELECT id, name FROM participants WHERE claimed_at IS NULL ORDER BY name COLLATE NOCASE').all() : [];
  const meId = Number(parseCookies(ctx.req).me) || null;
  const me = meId && db.prepare('SELECT name, claimed_at FROM participants WHERE id = ?').get(meId);
  return { phase: ph, total, pending, finished: ph === 'open' && pending.length === 0 && total > 0,
    me: me && me.claimed_at ? { name: me.name } : null };
});

// Revela o resultado UMA vez. Atômico: dois cliques/duas abas nunca revelam duas vezes.
route('POST', '/api/claim', {}, (ctx, res) => {
  claimLimit(ctx.ip);
  if (phase() !== 'open') throw new HttpError(409, 'O sorteio ainda não começou.');
  const id = Number(ctx.body.participant_id);
  let result;
  db.exec('BEGIN IMMEDIATE');
  try {
    const p = db.prepare('SELECT id, name, grp, gives_to, claimed_at FROM participants WHERE id = ?').get(id);
    if (!p) throw new HttpError(404, 'Participante não encontrado');
    if (p.claimed_at) throw new HttpError(409, 'Esse nome já viu o resultado e não pode consultar de novo.');
    db.prepare("UPDATE participants SET claimed_at = datetime('now') WHERE id = ? AND claimed_at IS NULL").run(id);
    const f = db.prepare('SELECT name, note FROM participants WHERE id = ?').get(p.gives_to);
    result = { you: p.name, tipo: TIPO[p.grp], friend: f.name, note: f.note || null };
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* já finalizada */ } throw e; }
  // lembra neste navegador que "eu" já sorteei (só para mostrar a mensagem certa; não guarda o resultado)
  res.setHeader('Set-Cookie', `me=${id}; SameSite=Strict; Path=/; Max-Age=${60 * 86400}${secureFlag(ctx)}`);
  maybeWriteAudit();
  return result;
});

// --- admin ---
route('GET', '/api/admin/me', {}, (ctx) => ({
  needsSetup: !db.prepare('SELECT 1 FROM admin').get(), loggedIn: !!isAdmin(ctx.req) }));

route('POST', '/api/admin/setup', {}, (ctx, res) => {
  if (db.prepare('SELECT 1 FROM admin').get()) throw new HttpError(403, 'Já configurado');
  const pw = String(ctx.body.password ?? '');
  if (pw.length < 8) throw new HttpError(400, 'A senha precisa de ao menos 8 caracteres');
  db.prepare('INSERT INTO admin (id, password_hash) VALUES (1, ?)').run(hashPassword(pw));
  startSession(res, ctx);
  return { ok: true };
});

route('POST', '/api/admin/login', {}, (ctx, res) => {
  loginLimit(ctx.ip);
  const row = db.prepare('SELECT password_hash FROM admin WHERE id = 1').get();
  const ok = verifyPassword(String(ctx.body.password ?? ''), row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) throw new HttpError(401, 'Senha incorreta');
  startSession(res, ctx);
  return { ok: true };
});

route('POST', '/api/admin/logout', { admin: true }, (ctx, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(ctx.token);
  res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureFlag(ctx)}`);
  return { ok: true };
});

// Estado do admin. NUNCA inclui quem tirou quem (evita spoiler); isso só sai no .txt final.
route('GET', '/api/admin/state', { admin: true }, () => {
  const people = db.prepare('SELECT id, name, grp, note, claimed_at FROM participants ORDER BY name COLLATE NOCASE').all();
  const exclusions = db.prepare(
    `SELECT e.a, e.b, pa.name AS aName, pb.name AS bName FROM exclusions e
     JOIN participants pa ON pa.id = e.a JOIN participants pb ON pb.id = e.b`).all();
  const claimed = people.filter((p) => p.claimed_at).length;
  return { phase: phase(), groups: GROUPS, tipos: TIPO, minGroup: MIN_GROUP, people, exclusions, claimed, max: MAX_PARTICIPANTS,
    finished: phase() === 'open' && people.length > 0 && claimed === people.length,
    audit: latestAudit() };
});

function needSetupPhase() { if (phase() !== 'setup') throw new HttpError(409, 'O sorteio já foi iniciado; a lista está travada.'); }

route('POST', '/api/admin/participants', { admin: true }, (ctx) => {
  needSetupPhase();
  // uma pessoa por linha; opcionalmente "Nome | observação" (a observação aparece para quem tirar essa pessoa)
  const lines = (Array.isArray(ctx.body.names) ? ctx.body.names : String(ctx.body.names ?? '').split(/\r?\n/))
    .map((l) => String(l).split('|')).map(([n, ...o]) => ({ name: clean(n), note: clean(o.join('|')).slice(0, 300) || null }))
    .filter((p) => p.name);
  if (!lines.length) throw new HttpError(400, 'Informe ao menos um nome');
  if (lines.some((p) => p.name.length > 40)) throw new HttpError(400, 'Nome com mais de 40 caracteres');
  const count = db.prepare('SELECT COUNT(*) c FROM participants').get().c;
  if (count + lines.length > MAX_PARTICIPANTS) throw new HttpError(409, `Limite de ${MAX_PARTICIPANTS} participantes`);
  const grp = groupOf(ctx.body.grupo || 'adultos');
  const ins = db.prepare('INSERT INTO participants (name, grp, note) VALUES (?, ?, ?)');
  const skipped = [];
  for (const p of lines) {
    try { ins.run(p.name, grp, p.note); } catch { skipped.push(p.name); }
  }
  return { skipped };
});

// Move alguém de grupo (só antes de liberar o sorteio). Exclusões da pessoa são removidas, pois valem só dentro do grupo.
route('POST', '/api/admin/participants/(\\d+)/group', { admin: true }, (ctx) => {
  needSetupPhase();
  const grp = groupOf(ctx.body.grupo);
  const id = Number(ctx.params[0]);
  const r = db.prepare('UPDATE participants SET grp = ? WHERE id = ?').run(grp, id);
  if (!r.changes) throw new HttpError(404, 'Participante não encontrado');
  db.prepare('DELETE FROM exclusions WHERE a = ? OR b = ?').run(id, id);
  return { ok: true };
});

// Observação de uma pessoa (ex.: restrição alimentar). Não é segredo; pode ser editada a qualquer hora,
// mas só aparece para quem revelar o resultado DEPOIS da edição.
route('POST', '/api/admin/participants/(\\d+)/note', { admin: true }, (ctx) => {
  const note = clean(ctx.body.note).slice(0, 300) || null;
  const r = db.prepare('UPDATE participants SET note = ? WHERE id = ?').run(note, Number(ctx.params[0]));
  if (!r.changes) throw new HttpError(404, 'Participante não encontrado');
  return { ok: true };
});

route('DELETE', '/api/admin/participants/(\\d+)', { admin: true }, (ctx) => {
  needSetupPhase();
  const r = db.prepare('DELETE FROM participants WHERE id = ?').run(Number(ctx.params[0]));
  if (!r.changes) throw new HttpError(404, 'Participante não encontrado');
  return { ok: true };
});

route('POST', '/api/admin/exclusions', { admin: true }, (ctx) => {
  needSetupPhase();
  const a = Number(ctx.body.a), b = Number(ctx.body.b);
  if (!a || !b || a === b) throw new HttpError(400, 'Escolha duas pessoas diferentes');
  const pair = db.prepare('SELECT grp FROM participants WHERE id IN (?, ?)').all(a, b);
  if (pair.length !== 2) throw new HttpError(404, 'Participante não encontrado');
  if (pair[0].grp !== pair[1].grp) throw new HttpError(400, 'Só faz sentido excluir pessoas do mesmo grupo (grupos diferentes já não se sorteiam).');
  const [x, y] = a < b ? [a, b] : [b, a];
  db.prepare('INSERT OR IGNORE INTO exclusions (a, b) VALUES (?, ?)').run(x, y);
  return { ok: true };
});

route('DELETE', '/api/admin/exclusions/(\\d+)/(\\d+)', { admin: true }, (ctx) => {
  needSetupPhase();
  db.prepare('DELETE FROM exclusions WHERE a = ? AND b = ?').run(Number(ctx.params[0]), Number(ctx.params[1]));
  return { ok: true };
});

route('POST', '/api/admin/start', { admin: true }, (ctx) => {
  needSetupPhase();
  return startDraw(ctx.body.avoidSwap !== false);
});

// Voltar para a fase de cadastro: só se ninguém viu o resultado ainda.
route('POST', '/api/admin/reset', { admin: true }, () => {
  if (db.prepare('SELECT 1 FROM participants WHERE claimed_at IS NOT NULL').get())
    throw new HttpError(409, 'Alguém já viu o resultado; não dá para refazer o sorteio.');
  db.exec("UPDATE participants SET gives_to = NULL; INSERT INTO settings (key,value) VALUES ('phase','setup') ON CONFLICT(key) DO UPDATE SET value='setup'");
  return { ok: true };
});

// Se alguém perdeu a tela (celular travou etc.), libera a MESMA pessoa para ver o MESMO resultado de novo.
route('POST', '/api/admin/release/(\\d+)', { admin: true }, (ctx) => {
  const r = db.prepare('UPDATE participants SET claimed_at = NULL WHERE id = ? AND gives_to IS NOT NULL').run(Number(ctx.params[0]));
  if (!r.changes) throw new HttpError(404, 'Participante não encontrado');
  return { ok: true };
});

route('GET', '/api/admin/audit', { admin: true }, (ctx, res) => {
  const f = latestAudit();
  if (!f) throw new HttpError(404, 'A auditoria só existe depois que todos revelarem o resultado.');
  res.__raw = { type: 'text/plain; charset=utf-8', body: fs.readFileSync(path.join(AUDIT_DIR, f), 'utf8'),
    headers: { 'Content-Disposition': `attachment; filename="${f}"` } };
});

// ---------- servidor ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin.html';  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('Não encontrado');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function clientInfo(req) {
  let ip = req.socket.remoteAddress || '?', proto = 'http';
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (xff.length) ip = xff[xff.length - 1];
    proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  }
  return { ip, proto };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
    const r = routes.find((x) => x.method === req.method && x.regex.test(url.pathname));
    if (!r) throw new HttpError(404, 'Rota não encontrada');
    if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json'))
      throw new HttpError(415, 'Content-Type deve ser application/json');
    const token = isAdmin(req);
    if (r.admin && !token) throw new HttpError(401, 'Não autenticado');
    const body = req.method === 'POST' ? await readBody(req) : {};
    const params = url.pathname.match(r.regex).slice(1);
    const { ip, proto } = clientInfo(req);
    const result = await r.handler({ req, token, body, params, ip, proto }, res);
    if (res.__raw) {
      res.writeHead(200, { 'Content-Type': res.__raw.type, 'Cache-Control': 'no-store', ...res.__raw.headers });
      return res.end(res.__raw.body);
    }
    send(res, 200, result);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Erro interno' });
  }
});

server.listen(PORT, HOST, () => console.log(`Amigo Secreto em http://localhost:${PORT}/ (admin em /admin)`));
