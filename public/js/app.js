// Kern: store, WebSocket-sync, API-helpers, sneltoetsen.
import { initTimeline, renderTimeline } from './timeline.js';
import { Player } from './player.js';
import { initSource, loadSource, sourceKey } from './source.js';
import { initBin, renderBin, initDialogs } from './mediabin.js';
import { initNotes, renderNotes, startNote } from './notes.js';
import { initVersions } from './versions.js';
import { t, initI18n } from './i18n.js';

export const S = {
  state: null,
  pxPerSec: 60,
  tool: 'select',
  playhead: 0,
  selection: [],
  player: null,
  clipboard: [],
};

const bus = new EventTarget();
export const on = (ev, fn) => bus.addEventListener(ev, fn);
export const emit = (ev, detail) => bus.dispatchEvent(new CustomEvent(ev, { detail }));

// ---------- API ----------
export async function api(cmd, args = {}) {
  const res = await fetch('/api/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, args }),
  });
  const data = await res.json();
  if (!data.ok) { toast(data.error); throw new Error(data.error); }
  return data.result;
}
export async function apiGet(path) { return (await fetch(path)).json(); }
export async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}


// Vraag om tekst in een eigen dialoog (window.prompt bestaat niet in Electron). Geeft null bij annuleren.
export function askText({ title = '', label = '', value = '', multiline = false, ok = 'OK', cancel = 'Annuleer' } = {}) {
  return new Promise((resolve) => {
    let dlg = document.getElementById('dlg-ask');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'dlg-ask';
      dlg.innerHTML = '<h3 id="ask-title"></h3><label id="ask-label"></label><input type="text" id="ask-input"><textarea id="ask-area" rows="7" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:6px;font:inherit;resize:vertical" hidden></textarea><div class="dlg-actions"><button id="ask-cancel"></button><button id="ask-ok" class="accent"></button></div>';
      document.body.appendChild(dlg);
      for (const id of ['ask-input', 'ask-area']) document.getElementById(id).addEventListener('keydown', (e) => e.stopPropagation());
    }
    const inp = document.getElementById('ask-input');
    const area = document.getElementById('ask-area');
    document.getElementById('ask-title').textContent = title;
    document.getElementById('ask-title').hidden = !title;
    document.getElementById('ask-label').textContent = label;
    document.getElementById('ask-cancel').textContent = cancel;
    document.getElementById('ask-ok').textContent = ok;
    inp.hidden = multiline; area.hidden = !multiline;
    (multiline ? area : inp).value = value ?? '';
    let done = false;
    const finish = (v) => { if (done) return; done = true; dlg.close(); resolve(v); };
    document.getElementById('ask-ok').onclick = () => finish((multiline ? area : inp).value);
    document.getElementById('ask-cancel').onclick = () => finish(null);
    dlg.oncancel = (e) => { e.preventDefault(); finish(null); };
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(inp.value); } if (e.key === 'Escape') finish(null); };
    dlg.showModal();
    setTimeout(() => (multiline ? area : inp).focus(), 30);
  });
}

export function toastInfo(msg) {
  toast(msg);
  const el = document.getElementById('toast');
  if (el) el.style.background = '#2c6e49';
}

export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#b33;color:#fff;padding:8px 16px;border-radius:6px;z-index:99;font-size:13px;max-width:70vw';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = '#b33';
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.style.display = 'none'), 4000);
}

// ---------- WebSocket ----------
let ws;
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => document.getElementById('conn-dot').classList.add('ok');
  ws.onclose = () => {
    document.getElementById('conn-dot').classList.remove('ok');
    setTimeout(connect, 1500);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state') {
      const first = !S.state;
      S.state = msg.state;
      // playhead van de server volgen, maar nooit vlak na eigen scrub/afspelen
      // (anders zet een late broadcast de playhead terug)
      const recentLocal = Date.now() - lastLocalPlayhead < 800;
      if (first || (!S.player?.playing && !recentLocal && Math.abs((msg.state.playhead ?? 0) - S.playhead) > 0.001)) {
        S.playhead = msg.state.playhead ?? 0;
        emit('playhead');
      }
      S.selection = msg.state.selection || [];
      emit('state');
    } else if (msg.type === 'playhead') {
      if (!S.player?.playing) { S.playhead = msg.time; emit('playhead'); }
    } else if (msg.type === 'selection') {
      S.selection = msg.clipIds || [];
      emit('selection');
    } else if (msg.type === 'render') {
      emit('render', msg.status);
    }
  };
}
export function sendVolatile(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }

// playhead lokaal zetten + syncen
let phTimer = null;
let lastLocalPlayhead = 0;
export function setPlayhead(t, { commit = true } = {}) {
  lastLocalPlayhead = Date.now();
  S.playhead = Math.max(0, t);
  emit('playhead');
  sendVolatile({ type: 'playhead', time: S.playhead });
  if (commit) {
    clearTimeout(phTimer);
    phTimer = setTimeout(() => api('setPlayhead', { time: S.playhead }).catch(() => {}), 300);
  }
}

export function setSelection(ids) {
  S.selection = ids;
  sendVolatile({ type: 'selection', clipIds: ids });
  api('setSelection', { clipIds: ids }).catch(() => {});
  emit('selection'); // alleen selectie-classes bijwerken, géén timeline-rebuild
}

export const fmtTC = (t, fps = 30) => {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * fps);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
};

export function findClipLocal(clipId) {
  for (const t of S.state.tracks) {
    const c = t.clips.find((c) => c.id === clipId);
    if (c) return { clip: c, track: t };
  }
  return null;
}

// ---------- sneltoetsen ----------
function initKeys() {
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const mod = e.metaKey || e.ctrlKey;


    // in 3D-modus alleen afspelen/undo/navigatie doorlaten; de rest regelt de 3D-module
    if (document.body.classList.contains('mode-3d')) {
      const allowed = e.code === 'Space' || mod || e.key.startsWith('Arrow') || e.key === 'Home';
      if (!allowed) return;
    }

    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); api('undo'); }
    else if (mod && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); api('redo'); }
    else if (mod && e.key === 'k') { e.preventDefault(); api('splitAt', { time: S.playhead }); }
    else if (mod && e.key === 'a') {
      e.preventDefault();
      setSelection(S.state.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    }
    else if (mod && e.key === 'c') {
      e.preventDefault();
      S.clipboard = [...S.selection];
      if (S.clipboard.length) toastInfo(t('%{n} clip(s) gekopieerd', { n: S.clipboard.length }));
    }
    else if (mod && e.key === 'v') {
      e.preventDefault();
      if (S.clipboard.length) api('duplicateClips', { clipIds: S.clipboard, atTime: S.playhead });
    }
    else if (mod && e.key === 'd') {
      e.preventDefault();
      if (S.selection.length) api('duplicateClips', { clipIds: S.selection, atTime: S.playhead });
    }
    else if (e.key === 'm') { api('addMarker', { time: S.playhead }); }
    else if (e.key === 'n') { e.preventDefault(); startNote(); }
    else if (e.key === 'M') { api('removeMarker', { nearTime: S.playhead }).catch(() => {}); }
    else if (e.key === 'v') setTool('select');
    else if (e.key === 'c') setTool('razor');
    else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      deleteSelection(e.shiftKey);
    }
    else if (e.key === '=' || e.key === '+') zoom(1.3);
    else if (e.key === '-') zoom(1 / 1.3);
    else if (e.key === 'Z') zoomFit();
    else if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(e.shiftKey ? -1 : -1 / (S.state?.settings.fps || 30)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(e.shiftKey ? 1 : 1 / (S.state?.settings.fps || 30)); }
    else if (e.key === 'Home') { e.preventDefault(); S.player?.pause(); setPlayhead(0); }
    else if (e.key === 'Escape') { setSelection([]); setTool('select'); }
    else if (e.key === 'i' || e.key === 'o' || e.key === ',') sourceKey(e.key);
  });
}

function nudge(d) { S.player?.pause(); setPlayhead(S.playhead + d); }

export function setTool(tool) {
  S.tool = tool;
  document.body.classList.toggle('tool-razor', tool === 'razor');
  document.getElementById('tool-select').classList.toggle('active', tool === 'select');
  document.getElementById('tool-razor').classList.toggle('active', tool === 'razor');
}

export function togglePlay() {
  if (!S.player) return;
  if (S.player.playing) S.player.pause();
  else S.player.play();
}

export async function deleteSelection(ripple = false) {
  for (const id of [...S.selection]) {
    await api(ripple ? 'rippleDelete' : 'deleteClip', { clipId: id }).catch(() => {});
  }
  setSelection([]);
}

export function zoom(factor, centerT) {
  const scroll = document.getElementById('tl-scroll');
  const cT = centerT ?? (scroll.scrollLeft + scroll.clientWidth / 2) / S.pxPerSec;
  S.pxPerSec = Math.min(400, Math.max(0.5, S.pxPerSec * factor));
  document.getElementById('zoom-slider').value = S.pxPerSec;
  emit('zoom');
  scroll.scrollLeft = cT * S.pxPerSec - scroll.clientWidth / 2;
}

// hele montage passend in beeld
export function zoomFit() {
  const scroll = document.getElementById('tl-scroll');
  const d = Math.max(projectDur(), 1);
  S.pxPerSec = Math.min(400, Math.max(0.5, (scroll.clientWidth - 60) / d));
  document.getElementById('zoom-slider').value = S.pxPerSec;
  emit('zoom');
  scroll.scrollLeft = 0;
}

// ---------- init ----------
// taal eerst: dan zijn de statische teksten al vertaald vóór de rest de UI opbouwt
await initI18n();
connect();
initKeys();
initTimeline();
initSource();
initBin();
initDialogs();
initNotes();
initVersions();
document.getElementById('prog-note').onclick = () => startNote();
S.player = new Player(document.getElementById('program-view'));

document.getElementById('btn-undo').onclick = () => api('undo');
document.getElementById('btn-redo').onclick = () => api('redo');
document.getElementById('tool-select').onclick = () => setTool('select');
document.getElementById('tool-razor').onclick = () => setTool('razor');
document.getElementById('btn-split').onclick = () => api('splitAt', { time: S.playhead });
document.getElementById('btn-delete').onclick = () => deleteSelection(false);
document.getElementById('btn-ripple').onclick = () => deleteSelection(true);
document.getElementById('btn-wa-in').onclick = () => api('setWorkArea', { start: S.playhead });
document.getElementById('btn-wa-out').onclick = () => api('setWorkArea', { end: S.playhead });
document.getElementById('btn-wa-clear').onclick = () => api('clearWorkArea');
document.getElementById('btn-addvtrack').onclick = () => api('addTrack', { type: 'video' });
document.getElementById('btn-addatrack').onclick = () => api('addTrack', { type: 'audio' });
document.getElementById('zoom-in').onclick = () => zoom(1.3);
document.getElementById('zoom-out').onclick = () => zoom(1 / 1.3);
document.getElementById('zoom-fit').onclick = () => zoomFit();
document.getElementById('zoom-slider').oninput = (e) => { S.pxPerSec = +e.target.value; emit('zoom'); };

on('state', () => {
  renderTimeline(); renderBin(); renderNotes(); updateHeader(); updateTC();
  const open = (S.state?.notes ?? []).filter((n) => !n.done).length;
  const badge = document.getElementById('note-badge');
  badge.hidden = !open;
  badge.textContent = open;
});
on('playhead', updateTC);
on('zoom', renderTimeline);

function updateHeader() {
  const s = S.state.settings;
  const proj = document.getElementById('topbar-project');
  if (proj && S.state.projectName) {
    const title = S.state.meta?.title;
    proj.textContent = S.state.projectName;
    proj.title = title && title !== S.state.projectName ? title : '';
    document.title = `${title || S.state.projectName} — Agentic Video Editor`;
  }
  document.getElementById('program-res').textContent = `${s.width}×${s.height} @ ${s.fps}fps`;
  document.getElementById('program-dur').textContent = fmtTC(S.state.duration ?? dur(), s.fps);
}
function dur() {
  let d = 0;
  for (const t of S.state.tracks) for (const c of t.clips) d = Math.max(d, c.start + c.out - c.in);
  return d;
}
export const projectDur = dur;

function updateTC() {
  const fps = S.state?.settings.fps || 30;
  document.getElementById('tl-tc').textContent = fmtTC(S.playhead, fps);
  document.getElementById('program-tc').textContent = fmtTC(S.playhead, fps);
}
