// Tiny mock of the Clip Vault API contract + static file server (sends the production CSP). Node only, no deps.
// Seed data is anchored at ANCHOR so tests can pin the clock and check exact local-time text.
const zlib = require('zlib');
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const ANCHOR = '2026-03-10T12:00:00Z';
const CSP = "default-src 'none'; script-src 'self' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; style-src 'self' https://accounts.google.com/gsi/style; img-src 'self' data: blob: https://*.googleusercontent.com; media-src 'self' blob:; worker-src 'self' blob:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const iso = (ms) => new Date(ms).toISOString().replace('.000', '');
const A = Date.parse(ANCHOR), H = 3600e3, D = 24 * H;

const POST1 = `## YouTube Shorts

**Title** (52 characters): Bumrah ki wapsi: yaar ye toh kamaal ho gaya #shorts

**Description**
Aaj ka sabse bada moment. Poora match live dekho aur batao kaisa laga.
Credit neeche diya hai.

**Tags:** cricket, bumrah, ind vs aus, hinglish

## Instagram Reels

**Caption**
Bumrah is back and the stadium knows it. Kaisa laga yeh spell? Comment karo.

**Hashtags:** #cricket #bumrah #indvsaus #reels

## Credit
Stream: Live Cricket Official

## Rights
Fair-use commentary, rights.status = cleared
`;

function seed() {
  const c = (id, o) => ({ id, stream: '2026-03-01_ind-vs-aus-live', title: 'Clip ' + id, hook: null, desc: null, post: null, tags: [], dur: 47, score: null, size: 28400000, width: 1080, height: 1920, fps: 30, codec: 'h264', bitrate: 4800000, sha256: crypto.createHash('sha256').update(id).digest('hex'), added_at: iso(A - 5 * D), updated_at: iso(A - 5 * D), video: `clips/${id}.mp4`, poster: `clips/${id}.jpg`, trashed_at: null, purge_after: null, ...o });
  const clips = [
    c('c1', { posted: { youtube: iso(A - 1 * H), instagram: null }, notes: 'Posted the Short at 5pm. Reel waits for the music fix.', title: 'Yaar ye toh kamaal ho gaya - Bumrah ki wapsi', hook: 'Bumrah ka comeback spell', desc: 'Poora over ek hi saans mein.', post: POST1, tags: ['cricket', 'bumrah', 'hinglish'], score: 8.4, added_at: iso(A - 3 * H), updated_at: iso(A - 2 * H), dur: 47, size: 28400000 }),
    c('c2', { posted: { youtube: iso(A - 20 * H), instagram: iso(A - 19 * H) }, title: 'भारत बनाम ऑस्ट्रेलिया: आखिरी ओवर का रोमांच जो आप कभी नहीं भूलेंगे', hook: 'आखिरी ओवर', tags: ['cricket', 'हिंदी'], score: 9.1, added_at: iso(Date.parse('2026-03-09T04:11:00Z')), dur: 52, size: 41200000 }),
    c('c3', { title: 'Bhai tu sun toh sahi, yeh wala moment poore stream ka sabse zyada pagal kar dene wala tha aur chat bhi hil gayi thi poori tarah se, dekho zaroor', stream: '2026-02-20_gaming-night', tags: ['gaming', 'funny'], score: 6.2, added_at: iso(A - 2 * D), dur: 41, size: 20100000 }),
    // v1-style record: almost every field missing
    { id: 'c4', title: 'Old clip without metadata', stream: '2026-02-20_gaming-night', dur: 44, size: 25000000, video: 'clips/c4.mp4', poster: null },
    c('c5', { title: 'Podcast: why friends matter', stream: '2026-01-15_podcast-ep-12', tags: ['podcast'], score: 7.7, added_at: iso(A - 20 * D), dur: 55, size: 43000000, post: 'Just a plain caption without any headings.' }),
    c('c6', { posted: { youtube: null, instagram: iso(A - 6 * D) }, title: 'Ace in the last round', stream: '2026-02-20_gaming-night', tags: ['gaming'], score: 8.8, added_at: iso(A - 9 * D), dur: 40, size: 22000000 }),
    c('c7', { title: 'Sunset drive vlog', stream: '2026-01-15_podcast-ep-12', tags: [], score: 5.5, added_at: iso(A - 30 * D), dur: 48, size: 30000000 }),
    c('c8', { title: 'Second innings highlights', stream: '2026-03-01_ind-vs-aus-live', tags: ['cricket'], score: 7.0, added_at: iso(A - 1 * D), dur: 50, size: 33000000 }),
  ];
  const trash = [c('t1', { title: 'Deleted blooper reel', stream: '2026-02-20_gaming-night', trashed_at: iso(Date.parse('2026-03-08T10:00:00Z')), purge_after: iso(Date.parse('2026-04-07T10:00:00Z')), video: 'clips/t1.mp4', poster: 'clips/t1.jpg' })];
  return { clips, trash };
}

const USERS = [
  { email: 'root@example.com', role: 'admin', root: true, source: 'secret', added_at: iso(A - 90 * D), added_by: 'env' },
  { email: 'admin2@example.com', role: 'admin', root: false, source: 'site', added_at: iso(A - 10 * D), added_by: 'root@example.com' },
  { email: 'friend@example.com', role: 'viewer', root: false, source: 'site', added_at: iso(A - 5 * D), added_by: 'root@example.com' },
  { email: 'secretfriend@example.com', role: 'viewer', root: false, source: 'secret', added_at: iso(A - 40 * D), added_by: 'env' },
];
const PERSONAS = {
  'FAKE-admin': { email: 'root@example.com', name: 'Root Admin', role: 'admin', can_write: true, root: true },
  'FAKE-admin2': { email: 'admin2@example.com', name: 'Second Admin', role: 'admin', can_write: true, root: false },
  'FAKE-viewer': { email: 'friend@example.com', name: 'Friend Viewer', role: 'viewer', can_write: false, root: false },
  'FAKE-readonly': { email: 'root@example.com', name: 'Root Admin', role: 'admin', can_write: false, root: true },
};

function createMock({ staticDir, mp4, jpgs, port = 0 }) {
  const S = { ...seed(), users: JSON.parse(JSON.stringify(USERS)), audit: [], sessions: new Map(), log: [], inject: [], nonce: 0, uploadDelay: 35, seq: 0, reauths: 0 };
  const audit = (actor, action, clip_id, detail) => S.audit.push({ at: iso(Date.now()), actor_email: actor, action, clip_id: clip_id || null, detail: detail || '' });
  const send = (res, code, obj, extra = {}) => { const b = obj == null ? '' : JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }); res.end(b); };
  const err = (res, code, error, message, extra) => send(res, code, { error, message: message || error, ...(extra || {}) });
  const body = (req) => new Promise((r) => { const a = []; req.on('data', (d) => a.push(d)); req.on('end', () => r(Buffer.concat(a))); });
  const json = async (req) => { try { return JSON.parse((await body(req)).toString() || '{}'); } catch { return {}; } };
  const sess = (req) => { const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || ''); return m ? S.sessions.get(m[1]) : null; };

  async function api(req, res, u) {
    const p = u.pathname, m = req.method;
    S.log.push({ method: m, path: p + u.search, range: req.headers.range || '', t: Date.now() });
    // one-shot error injection
    const ix = S.inject.findIndex((i) => i.method === m && p.startsWith(i.match));
    if (ix >= 0) { const i = S.inject.splice(ix, 1)[0]; await body(req); return err(res, i.status, i.error, i.message, i.extra); }
    if (p === '/__ctl') {
      const c = await json(req);
      if (c.action === 'reset') { Object.assign(S, seed(), { users: JSON.parse(JSON.stringify(USERS)), audit: [], log: [], inject: [], sessions: new Map(), reauths: 0, rejectPosted: false, dropPosted: false }); }
      if (c.action === 'inject') S.inject.push(c.rule);
      if (c.action === 'flags') Object.assign(S, c.flags || {});
      if (c.action === 'addclips') for (let i = 0; i < (c.n || 1); i++) { const id = 'x' + ++S.seq; S.clips.push({ ...S.clips[0], id, title: 'Extra clip ' + id, stream: c.stream, hook: null, post: null, tags: [], posted: null, notes: null, score: 5 + i / 10, video: `clips/${id}.mp4`, poster: `clips/${id}.jpg` }); }
      if (c.action === 'library') { const F = require('./fixtures_library'); S.clips = F.clips.map((x) => ({ ...x })); S.trash = []; }
      if (c.action === 'expire') S.sessions.clear();
      if (c.action === 'age') for (const s of S.sessions.values()) s.iat = Date.now() - c.seconds * 1000;
      if (c.action === 'log') return send(res, 200, { log: S.log, audit: S.audit, users: S.users, clips: S.clips.length, trash: S.trash.length, reauths: S.reauths });
      if (c.action === 'clearlog') S.log = [];
      return send(res, 200, { ok: true });
    }
    if (p === '/api/auth/config' && m === 'GET') return send(res, 200, { client_id: 'fake-client.apps.googleusercontent.com', nonce: 'n' + ++S.nonce });
    if (p === '/api/auth/google' && m === 'POST') {
      const b = await json(req), persona = PERSONAS[b.credential];
      if (!persona) return err(res, 403, 'forbidden', 'Forbidden');
      const sid = crypto.randomBytes(12).toString('hex');
      S.sessions.set(sid, { ...persona, sub: 'sub-' + persona.email, csrf: crypto.randomBytes(8).toString('hex'), iat: Date.now() });
      res.writeHead(204, { 'Set-Cookie': `sid=${sid}; HttpOnly; Path=/; SameSite=Strict` }); return res.end();
    }
    const s = sess(req);
    if (p === '/api/me' && m === 'GET') {
      if (!s) return err(res, 401, 'unauthorized');
      return send(res, 200, { email: s.email, name: s.name, picture: null, role: s.role, csrf: s.csrf, can_write: s.can_write, sub: s.sub, root: s.root, session_age_seconds: Math.round((Date.now() - s.iat) / 1000) });
    }
    if (!s) { await body(req); return err(res, 401, 'unauthorized'); }
    if (m !== 'GET' && req.headers['x-csrf-token'] !== s.csrf) { await body(req); return err(res, 403, 'csrf'); }
    const admin = s.role === 'admin', fresh = Date.now() - s.iat <= 5 * 60e3;
    if (p === '/logout' && m === 'POST') { await body(req); for (const [k, v] of S.sessions) if (v === s) S.sessions.delete(k); res.writeHead(303, { Location: '/' }); return res.end(); }
    if (p === '/api/auth/reauth' && m === 'POST') {
      const b = await json(req), persona = PERSONAS[b.credential];
      if (!persona || persona.email !== s.email) return err(res, 403, 'forbidden');
      s.iat = Date.now(); S.reauths++; res.writeHead(204); return res.end();
    }
    if (p === '/api/clips' && m === 'GET') {
      if (u.searchParams.get('trash') === '1') { if (!admin) return err(res, 403, 'forbidden'); return send(res, 200, { clips: S.trash, counts: { active: S.clips.length, trash: S.trash.length }, updated_at: iso(Date.now()), can_write: s.can_write }); }
      return send(res, 200, { clips: S.clips, counts: { active: S.clips.length, trash: S.trash.length }, updated_at: iso(Date.now()), can_write: s.can_write });
    }
    const fm = /^\/api\/files\/(trash\/)?clips\/([^/]+)\.(mp4|jpg)$/.exec(p);
    if (fm && m === 'GET') {
      if (fm[1] && !admin) return err(res, 403, 'forbidden');
      let data, type;
      if (fm[3] === 'mp4') { data = mp4; type = 'video/mp4'; } else { data = jpgs[[...fm[2]].reduce((a, ch) => a + ch.charCodeAt(0), 0) % jpgs.length]; type = 'image/jpeg'; }
      const rg = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (rg) { const a = rg[1] ? +rg[1] : 0, b = rg[2] ? Math.min(+rg[2], data.length - 1) : data.length - 1; res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }); return res.end(data.subarray(a, b + 1)); }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }); return res.end(data);
    }
    const writeOk = () => { if (!admin) { err(res, 403, 'forbidden'); return false; } if (!s.can_write) { err(res, 503, 'read_only', 'Read only'); return false; } return true; };
    const needFresh = () => { if (!fresh) { err(res, 403, 'reauth_required', 'Please sign in again'); return false; } return true; };
    if (p === '/api/audit' && m === 'GET') { if (!admin) return err(res, 403, 'forbidden'); return send(res, 200, { entries: [...S.audit].reverse().concat([{ at: iso(A - 2 * D), actor_email: 'root@example.com', action: 'clip_add', clip_id: 'c8', detail: 'seed entry' }]) }); }
    if (p === '/api/clips' && m === 'POST') {
      if (!writeOk()) { await body(req); return; }
      const chunks = []; let n = 0;
      await new Promise((r) => { req.on('data', (d) => { chunks.push(d); n += d.length; if (S.uploadDelay) { req.pause(); setTimeout(() => req.resume(), S.uploadDelay); } }); req.on('end', r); });
      const raw = Buffer.concat(chunks).toString('latin1');
      const field = (k) => { const mm = new RegExp(`name="${k}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(raw); return mm ? Buffer.from(mm[1], 'latin1').toString('utf8') : ''; };
      const title = field('title');
      const magic = /^ERR(\d{3})$/.exec(title);
      if (magic) { const code = +magic[1]; return err(res, code, { 413: 'too_large', 415: 'unsupported', 429: 'rate_limited', 503: 'read_only' }[code] || 'error'); }
      if (title === 'DUP') return err(res, 409, 'duplicate', 'Already there', { clip_id: 'c1' });
      const id = 'n' + ++S.seq;
      const clip = { id, stream: field('stream') || null, title, hook: field('hook') || null, desc: field('desc') || null, post: field('post') || null, tags: field('tags').split(',').map((x) => x.trim()).filter(Boolean), dur: 45, score: null, size: n, width: 1080, height: 1920, fps: 30, codec: 'h264', bitrate: 4e6, sha256: crypto.randomBytes(32).toString('hex'), added_at: iso(Date.now()), updated_at: iso(Date.now()), video: `clips/${id}.mp4`, poster: raw.includes('name="poster"') ? `clips/${id}.jpg` : null, trashed_at: null, purge_after: null };
      S.clips.unshift(clip); audit(s.email, 'clip_add', id, title); return send(res, 201, { ok: true, clip });
    }
    const cm = /^\/api\/clips\/([^/]+)(\/trash|\/restore)?$/.exec(p);
    if (cm) {
      const id = decodeURIComponent(cm[1]);
      if (!writeOk()) { await body(req); return; }
      const ai = S.clips.findIndex((c) => c.id === id), ti = S.trash.findIndex((c) => c.id === id);
      if (m === 'PATCH' && !cm[2]) {
        const b = await json(req); if (ai < 0) return err(res, 404, 'not_found');
        const OK = ['title', 'hook', 'desc', 'post', 'stream', 'tags', 'posted', 'notes'];
        // S.rejectPosted simulates an older server that does not know the posting fields; S.dropPosted one that silently ignores them
        if (!Object.keys(b).length || Object.keys(b).some((k) => !OK.includes(k)) || (S.rejectPosted && ('posted' in b || 'notes' in b))) return err(res, 422, 'invalid', 'Unknown or empty fields');
        if ('title' in b && (!b.title || !String(b.title).trim())) return err(res, 422, 'invalid', 'Title is required');
        if (b.title === 'FAIL429') return err(res, 429, 'rate_limited');
        const isoOrNull = (v) => v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));
        if ('posted' in b && !(b.posted && typeof b.posted === 'object' && Object.keys(b.posted).every((k) => ['youtube', 'instagram'].includes(k) && isoOrNull(b.posted[k])))) return err(res, 422, 'invalid', 'posted must be {youtube, instagram} ISO or null');
        if ('notes' in b && (typeof b.notes !== 'string' || b.notes.length > 500)) return err(res, 422, 'invalid', 'notes max 500 characters');
        if (S.dropPosted) { delete b.posted; delete b.notes; }
        for (const k of OK) if (k in b) S.clips[ai][k] = b[k];
        S.clips[ai].updated_at = iso(Date.now());
        audit(s.email, 'clip_edit', id, Object.keys(b).join(',')); return send(res, 200, { ok: true, clip: S.clips[ai] });
      }
      if (m === 'POST' && cm[2] === '/trash') { await body(req); if (ai < 0) return err(res, 404, 'not_found'); const c = S.clips.splice(ai, 1)[0]; c.trashed_at = iso(Date.now()); c.purge_after = iso(Date.now() + 30 * D); S.trash.unshift(c); audit(s.email, 'clip_trash', id, c.title); return send(res, 200, { ok: true }); }
      if (m === 'POST' && cm[2] === '/restore') { await body(req); if (ti < 0) return err(res, 404, 'not_found'); const c = S.trash.splice(ti, 1)[0]; c.trashed_at = null; c.purge_after = null; S.clips.unshift(c); audit(s.email, 'clip_restore', id, c.title); return send(res, 200, { ok: true }); }
      if (m === 'DELETE' && !cm[2]) {
        const b = await json(req); if (!needFresh()) return; if (ti < 0) return err(res, 404, 'not_found');
        if (b.confirm !== S.trash[ti].title) return err(res, 422, 'confirm_mismatch', 'Title does not match');
        const c = S.trash.splice(ti, 1)[0]; audit(s.email, 'clip_purge', id, c.title); return send(res, 200, { ok: true });
      }
    }
    if (p === '/api/trash/empty' && m === 'POST') {
      if (!writeOk()) { await body(req); return; } const b = await json(req); if (!needFresh()) return;
      if (b.confirm !== 'EMPTY TRASH') return err(res, 422, 'confirm_mismatch');
      const n = S.trash.length; S.trash = []; audit(s.email, 'trash_empty', null, `${n} purged, all=${!!b.all}`); return send(res, 200, { ok: true, purged: n });
    }
    if (p === '/api/users' || p.startsWith('/api/users/')) {
      if (!admin) { await body(req); return err(res, 403, 'forbidden'); }
      const em = p.startsWith('/api/users/') ? decodeURIComponent(p.slice(11)) : null;
      if (m === 'GET') return send(res, 200, { users: S.users, root_admins: S.users.filter((x) => x.root).map((x) => x.email) });
      if (!s.can_write) { await body(req); return err(res, 503, 'read_only'); }
      const b = await json(req); if (!needFresh()) return;
      if (m === 'POST' && !em) {
        if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(b.email || '') || b.email !== (b.email || '').toLowerCase()) return err(res, 422, 'invalid_email', 'Invalid email');
        if (S.users.length >= 50) return err(res, 422, 'too_many');
        if (S.users.some((x) => x.email === b.email)) return err(res, 409, 'exists', 'Already on the list');
        const nu = { email: b.email, role: b.role, root: false, source: 'site', added_at: iso(Date.now()), added_by: s.email }; S.users.push(nu); audit(s.email, 'user_add', null, b.email + ' ' + b.role); return send(res, 201, { ok: true, user: nu });
      }
      const u2 = S.users.find((x) => x.email === em); if (!u2) return err(res, 404, 'not_found');
      if (u2.root) return err(res, 403, 'root_admin'); if (u2.source === 'secret') return err(res, 403, 'managed_by_secret'); if (em === s.email) return err(res, 403, 'self');
      if (m === 'PATCH') { u2.role = b.role; audit(s.email, 'user_role', null, em + ' ' + b.role); return send(res, 200, { ok: true, user: u2 }); }
      if (m === 'DELETE') { if (b.confirm !== em) return err(res, 422, 'confirm_mismatch'); S.users = S.users.filter((x) => x !== u2); audit(s.email, 'user_remove', null, em); return send(res, 200, { ok: true }); }
    }
    return err(res, 404, 'not_found');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      if (u.pathname.startsWith('/api/') || u.pathname === '/logout' || u.pathname === '/__ctl') return await api(req, res, u);
      let f = path.normalize(path.join(staticDir, u.pathname === '/' ? 'index.html' : u.pathname));
      if (!f.startsWith(staticDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, { 'Content-Security-Policy': CSP }); return res.end('not found'); }
      let data = fs.readFileSync(f); const ext = path.extname(f), gz = /gzip/.test(req.headers['accept-encoding'] || '') && /\.(js|css|html|svg)$/.test(ext);
      if (gz) data = zlib.gzipSync(data, { level: 6 });
      res.writeHead(200, { ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}), 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, S, url: `http://127.0.0.1:${server.address().port}` })));
}
module.exports = { createMock, ANCHOR, CSP, POST1 };
if (require.main === module) {
  const root = path.resolve(__dirname, '../../static');
  const fx = path.join(require('os').tmpdir(), 'cv-fixtures');
  createMock({ staticDir: root, mp4: fs.readFileSync(path.join(fx, 'v.mp4')), jpgs: [0, 1, 2, 3].map((i) => fs.readFileSync(path.join(fx, `p${i}.jpg`))), port: +process.env.PORT || 8099 }).then(({ url }) => console.log('mock at', url));
}
