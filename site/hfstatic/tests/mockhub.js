// A MOCK of the parts of the Hugging Face Hub that the static Clip Vault uses. Everything here is mocked: it proves the client's
// request shapes and flows, NOT the real Hub (see README: PROVEN vs UNTESTED). Tokens are fakes.
const crypto = require('crypto');
const DS = 'Soverellp/clip-vault';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'ETag,X-Repo-Commit,Content-Length,X-Linked-Size' };

class MockHub {
  constructor({ read, writeOk, extra = {} }) {
    this.read = read; this.writeOk = writeOk; this.extra = extra; // extra: token -> whoami body
    this.files = new Map(); this.lfsStore = new Map(); this.pending = new Map(); this.parts = new Map();
    this.head = 'c0'.padEnd(40, '0'); this.n = 0;
    this.commits = []; this.requests = []; this.violations = []; this.preuploads = []; this.lfsBatches = []; this.puts = []; this.completions = []; this.verifies = [];
    this.injectConflict = 0; this.multipart = false; this.chunk = 2000; this.badHost = false; this.rejectCommitToken = false; this.whoamiCalls = [];
  }
  put(path, buf, lfs) { buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf); this.files.set(path, buf); if (lfs) this.lfsStore.set(sha(buf), buf); }
  text(path) { return this.files.get(path)?.toString('utf8'); }
  index() { return JSON.parse(this.text('index.json')); }
  auditLines() { return [...this.files.entries()].filter(([p]) => p.startsWith('_audit/')).flatMap(([, b]) => b.toString().split('\n').filter(Boolean).map(l => JSON.parse(l))); }
  bump() { this.n++; this.head = crypto.createHash('sha1').update('c' + this.n).digest('hex'); }
  auth(req) { const a = req.headers()['authorization'] || ''; return a.startsWith('Bearer ') ? a.slice(7) : null; }
  json(route, status, body, extra = {}) { return route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) }); }

  async handle(route) {
    const req = route.request(), u = new URL(req.url()), tok = this.auth(req), m = req.method();
    this.requests.push({ url: req.url(), method: m, host: u.hostname, auth: tok }); if (process.env.DBG) console.log('  [req] ' + m + ' ' + req.url().slice(0, 110));
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (u.hostname !== 'huggingface.co') return this.other(route, req, u, tok, m);
    const p = u.pathname;
    if (p === '/api/whoami-v2') {
      this.whoamiCalls.push(tok);
      if (tok === this.writeOk) return this.json(route, 200, { type: 'user', name: 'Soverellp', auth: { type: 'access_token', accessToken: { displayName: 'vault-write', role: 'fineGrained', fineGrained: { canReadGatedRepos: false, global: [], scoped: [{ entity: { type: 'dataset', name: DS }, permissions: ['repo.content.read', 'repo.write'] }] } } } });
      if (this.extra[tok]) return this.json(route, 200, this.extra[tok]);
      return this.json(route, 401, { error: 'Invalid username or password.' });
    }
    const isWrite = tok === this.writeOk, isRead = tok === this.read || isWrite;
    if (!isRead) return this.json(route, 401, { error: 'Invalid username or password.' }, { 'x-error-message': 'Invalid username or password.' });
    let mm;
    if ((mm = p.match(new RegExp(`^/datasets/${DS}/resolve/([^/]+)/(.+)$`)))) {
      const path = decodeURIComponent(mm[2]), buf = this.files.get(path);
      if (!buf) return route.fulfill({ status: 404, headers: CORS, body: 'not found' });
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream', 'x-repo-commit': this.head, 'content-length': String(buf.length) }, body: buf });
    }
    if (p === `/api/datasets/${DS}/revision/main`) { this.headCalls = (this.headCalls || 0) + 1; if (this.failHead) return this.json(route, 500, { error: 'boom' }); }
    if (p === `/api/datasets/${DS}/revision/main`) return this.json(route, 200, { id: DS, sha: this.head });
    if (p === `/api/datasets/${DS}/paths-info/${this.head}` || p.startsWith(`/api/datasets/${DS}/paths-info/`)) {
      const paths = JSON.parse(req.postData() || '{}').paths || [];
      return this.json(route, 200, paths.filter(x => this.files.has(x)).map(x => { const b = this.files.get(x), lfs = x.endsWith('.mp4'); return { type: 'file', path: x, size: b.length, oid: sha(b).slice(0, 40), ...(lfs ? { lfs: { oid: sha(b), size: b.length, pointerSize: 134 } } : {}) }; }));
    }
    if (p === `/api/datasets/${DS}/preupload/main`) {
      const files = JSON.parse(req.postData()).files; this.preuploads.push(files);
      return this.json(route, 200, { files: files.map(f => ({ path: f.path, uploadMode: f.path.endsWith('.mp4') ? 'lfs' : 'regular', shouldIgnore: false })), commitOid: this.head });
    }
    if (p === `/datasets/${DS}.git/info/lfs/objects/batch`) {
      const ct = req.headers()['content-type'] || '';
      if (!ct.includes('application/vnd.git-lfs+json') || !isWrite) return this.json(route, 401, { message: 'no' });
      const body = JSON.parse(req.postData()); this.lfsBatches.push(body);
      const objects = body.objects.map(o => {
        if (this.lfsStore.has(o.oid)) return { oid: o.oid, size: o.size };
        const verify = { href: `https://huggingface.co/api/datasets/${DS}/lfs-verify`, header: {} };
        if (this.badHost) return { oid: o.oid, size: o.size, actions: { upload: { href: `https://bucket.s3.amazonaws.com/put/${o.oid}`, header: {} }, verify } };
        if (this.multipart) {
          const header = { chunk_size: String(this.chunk) }; const n = Math.ceil(o.size / this.chunk);
          for (let i = 1; i <= n; i++) header[String(i).padStart(5, '0')] = `https://upload.hf.co/part/${o.oid}/${i}`;
          return { oid: o.oid, size: o.size, actions: { upload: { href: `https://huggingface.co/api/datasets/${DS}/lfs-complete/${o.oid}`, header }, verify } };
        }
        return { oid: o.oid, size: o.size, actions: { upload: { href: `https://upload.hf.co/put/${o.oid}`, header: {} }, verify } };
      });
      return this.json(route, 200, { transfer: this.multipart ? 'multipart' : 'basic', objects }, { 'content-type': 'application/vnd.git-lfs+json' });
    }
    if ((mm = p.match(new RegExp(`^/api/datasets/${DS}/lfs-complete/([0-9a-f]{64})$`)))) {
      const body = JSON.parse(req.postData()); this.completions.push(body);
      const ps = this.parts.get(mm[1]) || []; const ok = body.parts.every((x, i) => x.partNumber === i + 1 && x.etag === `"etag-${i + 1}"`) && body.parts.length === ps.length;
      if (!ok) return this.json(route, 400, { error: 'bad parts' });
      this.pending.set(mm[1], Buffer.concat(ps)); return this.json(route, 200, {});
    }
    if (p === `/api/datasets/${DS}/lfs-verify`) {
      if (!isWrite) return this.json(route, 401, {});
      const body = JSON.parse(req.postData()); this.verifies.push(body); const b = this.pending.get(body.oid);
      if (!b || sha(b) !== body.oid || b.length !== body.size) return this.json(route, 400, { error: 'verify failed' });
      this.lfsStore.set(body.oid, b); return this.json(route, 200, {});
    }
    if (p === `/api/datasets/${DS}/commit/main`) return this.commit(route, req, isWrite);
    return this.json(route, 404, { error: 'unmocked ' + p });
  }
  other(route, req, u, tok, m) {
    // CDN download host and upload host: they must NEVER see a Hub token
    if (tok) this.violations.push(`Authorization sent to ${u.hostname}`);
    let mm;
    if (u.hostname === 'us.aws.cdn.hf.co' && (mm = u.pathname.match(/^\/xet-bridge-us\/(\w+)$/))) return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream', 'content-length': String(this.cdn.get(mm[1]).length) }, body: this.cdn.get(mm[1]) });
    if (u.hostname === 'upload.hf.co' && (mm = u.pathname.match(/^\/put\/([0-9a-f]{64})$/)) && m === 'PUT') { const b = req.postDataBuffer(); this.puts.push({ oid: mm[1], size: b.length }); this.pending.set(mm[1], b); return route.fulfill({ status: 200, headers: CORS, body: '' }); }
    if (u.hostname === 'upload.hf.co' && (mm = u.pathname.match(/^\/part\/([0-9a-f]{64})\/(\d+)$/)) && m === 'PUT') {
      const b = req.postDataBuffer(), list = this.parts.get(mm[1]) || []; list[Number(mm[2]) - 1] = b; this.parts.set(mm[1], list); this.puts.push({ oid: mm[1], part: Number(mm[2]), size: b.length });
      return route.fulfill({ status: 200, headers: { ...CORS, etag: `"etag-${mm[2]}"` }, body: '' });
    }
    return route.fulfill({ status: 404, headers: CORS, body: 'no' });
  }
  async commit(route, req, isWrite) {
    if (this.rejectCommitToken) return this.json(route, 401, { error: 'token revoked' });
    if (!isWrite) return this.json(route, 403, { error: 'read token cannot write' });
    const lines = req.postData().split('\n').filter(Boolean).map(l => JSON.parse(l)), header = lines[0];
    if (header.key !== 'header') return this.json(route, 400, { error: 'no header' });
    const rec = { message: header.value.summary, parent: header.value.parentCommit, ops: lines.slice(1), headBefore: this.head, ok: false };
    this.commits.push(rec);
    if (this.injectConflict > 0) { // somebody else commits first: change a hook in index.json, then reject ours
      this.injectConflict--; const idx = this.index(); idx.clips[idx.clips.length - 1].hook = 'foreign edit'; this.put('index.json', JSON.stringify(idx)); this.bump(); this.lastForeignHead = this.head;
      return this.json(route, 412, { error: 'Parent commit does not match' });
    }
    if (rec.parent !== this.head) return this.json(route, 412, { error: 'Parent commit does not match' });
    const staged = new Map(this.files);
    for (const l of rec.ops) {
      const v = l.value;
      if (l.key === 'file') staged.set(v.path, Buffer.from(v.content, 'base64'));
      else if (l.key === 'lfsFile') { const b = this.lfsStore.get(v.oid); if (!b) return this.json(route, 400, { error: 'lfs object missing ' + v.oid }); staged.set(v.path, b); }
      else if (l.key === 'deletedFile') { if (!staged.has(v.path)) return this.json(route, 400, { error: 'delete of missing ' + v.path }); staged.delete(v.path); }
      else return this.json(route, 400, { error: 'unknown op ' + l.key });
    }
    this.files = staged; this.bump(); rec.ok = true;
    return this.json(route, 200, { success: true, commitOid: this.head, commitUrl: 'x' });
  }
}
module.exports = { MockHub, sha, DS };
