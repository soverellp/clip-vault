// Per-viewer convenience (D47): the "Post info" switch. Stored in this browser only, key 'cv.postmode' = '1' | '0'. Works without storage; default ON.
const PM_KEY = 'cv.postmode';
export function readPostMode() { try { return localStorage.getItem(PM_KEY) !== '0'; } catch { return true; } }
export function writePostMode(on) { try { localStorage.setItem(PM_KEY, on ? '1' : '0'); } catch { /* storage blocked: the switch still works for this visit */ } }
