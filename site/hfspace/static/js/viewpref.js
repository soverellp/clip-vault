// Per-viewer convenience (D47): the "Post info" switch. Stored in this browser only, key 'cv.postmode' = '1' | '0'. Works without storage; default ON.
const PM_KEY = 'cv.postmode';
export function readPostMode() { try { return localStorage.getItem(PM_KEY) !== '0'; } catch { return true; } }
export function writePostMode(on) { try { localStorage.setItem(PM_KEY, on ? '1' : '0'); } catch { /* storage blocked: the switch still works for this visit */ } }
// Post mode (the swipe feed) opens on first load unless the viewer turned it off. Key 'cv.feed' = '1' | '0'; default ON, works without storage.
const FEED_KEY = 'cv.feed';
export function readFeedDefault() { try { return localStorage.getItem(FEED_KEY) !== '0'; } catch { return true; } }
export function writeFeedDefault(on) { try { localStorage.setItem(FEED_KEY, on ? '1' : '0'); } catch { /* storage blocked: the switch still works for this visit */ } }
// Playlist add memory (D51): last playlists, unticked versions, chosen mode. Key 'cv.pl' = JSON text (see parsePref in playlists.js). Works without storage (kept in memory for the visit).
import { parsePref, prefText } from './playlists.js';
const PL_KEY = 'cv.pl';
let plMem = null;
export function readPlPref() { if (plMem) return plMem; let s = null; try { s = localStorage.getItem(PL_KEY); } catch { /* storage blocked */ } return (plMem = parsePref(s)); }
export function writePlPref(patch) { plMem = parsePref({ ...readPlPref(), ...patch }); const s = prefText(plMem); try { localStorage.setItem(PL_KEY, s); } catch { /* storage blocked: kept for this visit */ } return plMem; }
