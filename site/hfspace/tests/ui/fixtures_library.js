// Library fixtures shared by the hfspace mock (server mode) and the hfstatic mock hub: 2 streams, 3 moments as with-streamer / clean (c3 keeps the older 'with-girl' spelling) pairs,
// and one clip with none of the new fields. Plain data, no secrets. Same shape as clip-vault-project/API-CONTRACT.md section 0.
const S1 = '2026-11-18_night-stream-ranked-grind', S2 = '2026-11-16_just-chatting-qna';
const iso = (d) => d + 'T10:00:00Z';
const base = (id, o) => ({ id, stream: S1, title: 'Clip ' + id, hook: 'hook ' + id, desc: '', post: '', tags: [], dur: 45, score: 8, size: 20000000, width: 1080, height: 1920, fps: 30, codec: 'h264', bitrate: 3000000, sha256: null,
  added_at: iso('2026-11-18'), updated_at: iso('2026-11-18'), video: `clips/${id}.mp4`, poster: `clips/${id}.jpg`, posted: { youtube: null, instagram: null }, notes: '', trashed_at: null, purge_after: null, ...o });
const pair = (g, stream, title, f) => [
  base(g + '-w', { stream, title, group: g, variant: g === 'c3' ? 'with-girl' : 'with-streamer', ...f }),
  base(g + '-c', { stream, title, group: g, variant: 'clean', ...f, size: 18000000 }),
];
const clips = [
  ...pair('a1', S1, 'He screams when the boss dies', { reaction: 'strong', reaction_note: 'jumps out of the chair', kind: 'reaction', tier: 'A', rank: 1, why: 'Streamer jumps and screams at the surprise boss kill' }),
  ...pair('b2', S1, 'Insane clutch 1v4 on the roof', { reaction: 'none', kind: 'game', tier: 'B', rank: 2, why: 'Four enemies in a row with one health bar left', score: 7 }),
  ...pair('c3', S2, 'Reading the funniest chat message', { reaction: 'mild', kind: 'reaction', tier: 'C', rank: 1, why: 'Laughs quietly and reads the donation out loud', score: 6 }),
  base('x1', { stream: S2, title: 'Old clip without any new field', score: 5, added_at: iso('2026-11-16') }),
];
const streams = [
  { id: S1, title: 'Night stream: ranked grind until sunrise', channel: 'StreamerX', date: '2026-11-18', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', thumb: `streams/${S1}/thumb.jpg`, clip_count: 4 },
  { id: S2, title: 'Just chatting Q and A', channel: 'StreamerX', date: '2026-11-16', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', thumb: `streams/${S2}/thumb.jpg`, clip_count: 3 },
];
// D40 variant: stream 2 has the OLDER YouTube date but was CLIPPED later; two languages; tags and a posted clip for the Filter tests.
// S1 (en): a1 tier A reaction clipped 14 Nov 09:00, b2 game tier B clipped 14 Nov 12:00. S2 (hi): c3 game tier C and x1 clipped 19 Nov 16:30 / 15:00.
function indexClipped({ lang = true } = {}) {
  const j = JSON.parse(JSON.stringify({ version: 2, streams, clips }));
  const at = { a1: '2026-11-14T09:00:00Z', b2: '2026-11-14T12:00:00Z', c3: '2026-11-19T16:30:00Z', x1: '2026-11-19T15:00:00Z' };
  for (const c of j.clips) {
    const g = c.group || c.id; c.clipped_at = at[g]; if (lang) c.lang = c.stream === S1 ? 'en' : 'hi';
    if (g === 'a1') c.tags = ['boss']; if (g === 'a1' && c.variant === 'with-streamer') c.posted = { youtube: '2026-11-15T10:00:00Z', instagram: null };
    if (g === 'c3') { c.kind = 'game'; c.reaction = 'none'; }
  }
  j.streams[0].clipped_at = '2026-11-14T12:00:00Z'; j.streams[1].clipped_at = '2026-11-19T16:30:00Z';
  if (lang) { j.streams[0].lang = 'en'; j.streams[0].lang_name = 'English'; j.streams[1].lang = 'hi'; j.streams[1].lang_name = 'Hindi'; }
  return j;
}
module.exports = { S1, S2, clips, streams, index: () => JSON.parse(JSON.stringify({ version: 2, streams, clips })), indexClipped };
