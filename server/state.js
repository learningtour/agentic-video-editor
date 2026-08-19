// Project state: single source of truth voor de montage.
// Alle mutaties lopen via applyCommand() — zowel vanuit de UI als vanuit Claude (API).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
// PROJECT-env maakt een aparte testinstantie mogelijk (bijv. PROJECT=test PORT=4721)
const projectsDir = path.join(ROOT, 'projects');

// Welk project stond er open? Zonder dit valt de app na elke herstart terug op
// "project", terwijl je gisteren aan iets anders werkte.
const CONFIG = path.join(ROOT, 'config.json');
function lastProject() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).lastProject || null; } catch { return null; }
}
function rememberProject(name) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    cfg.lastProject = name;
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  } catch { /* config is optioneel */ }
}

const startName = process.env.PROJECT || lastProject() || 'project';
let PROJECT_FILE = path.join(projectsDir, `${startName}.json`);
if (!fs.existsSync(PROJECT_FILE)) PROJECT_FILE = path.join(projectsDir, 'project.json');
export const activeProjectName = () => path.basename(PROJECT_FILE, '.json');
const safeName = (n) => String(n || '').trim().replace(/[^\w\- ]/g, '').slice(0, 60);

const uid = () => Math.random().toString(36).slice(2, 9);

export function defaultProject() {
  return {
    settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000 },
    // eigenschappen van het project (los van de bestandsnaam): titel, klant, notities, soort
    meta: { title: '', client: '', description: '', kind: 'video', created: new Date().toISOString() },
    // media: { id: {id,name,path,type,duration,width,height,fps,hasAudio,thumb,filmstrip,waveform} }
    media: {},
    // tracks in weergavevolgorde: V2, V1 (video, hoogste bovenaan) daarna A1, A2 (audio)
    tracks: [
      { id: 'V2', type: 'video', clips: [] },
      { id: 'V1', type: 'video', clips: [] },
      { id: 'A1', type: 'audio', clips: [] },
      { id: 'A2', type: 'audio', clips: [] },
    ],
    playhead: 0,
    selection: [],
    markers: [],
    notes: [],          // opmerkingen bij een tijdstip (review), zie addNote
    transitions: [],
    workArea: null,
    revision: 0,
  };
}

export let project = load();
let undoStack = [];
let redoStack = [];

function load() {
  try {
    const p = JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf8'));
    if (p && p.tracks) return p;
  } catch { /* nieuw project */ }
  return defaultProject();
}

export function saveNow() {
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(PROJECT_FILE, JSON.stringify(project, null, 2));
}

// ---------- projectbeheer ----------

export function listProjects() {
  fs.mkdirSync(projectsDir, { recursive: true });
  return fs.readdirSync(projectsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const st = fs.statSync(path.join(projectsDir, f));
      return { name: f.replace(/\.json$/, ''), mtime: st.mtime.toISOString(), current: path.join(projectsDir, f) === PROJECT_FILE };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export function openProject(name) {
  const clean = safeName(name);
  const file = path.join(projectsDir, `${clean}.json`);
  if (!fs.existsSync(file)) throw new Error(`Project "${clean}" bestaat niet`);
  saveNow(); // huidig werk eerst veiligstellen
  PROJECT_FILE = file;
  rememberProject(clean);
  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(project, defaultProject(), loaded);
  undoStack = [];
  redoStack = [];
  project.revision++;
  return { name: clean };
}

export function saveProjectAs(name) {
  const clean = safeName(name);
  if (!clean) throw new Error('Geen geldige projectnaam');
  PROJECT_FILE = path.join(projectsDir, `${clean}.json`);
  rememberProject(clean);
  saveNow();
  return { name: clean };
}

// Project hernoemen: het json-bestand én alles wat aan die naam hangt (Premiere-XML,
// Audition-sessie, versiegeschiedenis, autosaves) verhuist mee — anders raak je je
// geschiedenis kwijt.
export function renameProject(newName) {
  const clean = safeName(newName);
  if (!clean) throw new Error('Geen geldige projectnaam');
  const oldName = activeProjectName();
  if (clean === oldName) return { name: clean, unchanged: true };
  const target = path.join(projectsDir, `${clean}.json`);
  if (fs.existsSync(target)) throw new Error(`Er bestaat al een project "${clean}"`);
  saveNow();
  fs.renameSync(PROJECT_FILE, target);
  for (const ext of ['.xml', '.sesx']) {
    const f = path.join(projectsDir, `${oldName}${ext}`);
    if (fs.existsSync(f)) fs.renameSync(f, path.join(projectsDir, `${clean}${ext}`));
  }
  const hOld = path.join(projectsDir, 'history', oldName);
  if (fs.existsSync(hOld)) {
    fs.renameSync(hOld, path.join(projectsDir, 'history', clean));
    // de index noemt het project bij naam
    const idx = path.join(projectsDir, 'history', clean, 'index.json');
    try {
      const list = JSON.parse(fs.readFileSync(idx, 'utf8'));
      for (const v of list) if (v.project === oldName) v.project = clean;
      fs.writeFileSync(idx, JSON.stringify(list, null, 1));
    } catch { /* index optioneel */ }
  }
  const vdir = path.join(projectsDir, 'versions');
  if (fs.existsSync(vdir)) {
    for (const f of fs.readdirSync(vdir)) {
      if (f.startsWith(oldName + '-')) fs.renameSync(path.join(vdir, f), path.join(vdir, clean + f.slice(oldName.length)));
    }
  }
  PROJECT_FILE = target;
  rememberProject(clean);
  project.revision++;
  return { name: clean, was: oldName };
}

export function newProjectFile(name) {
  const clean = safeName(name);
  if (!clean) throw new Error('Geen geldige projectnaam');
  saveNow();
  PROJECT_FILE = path.join(projectsDir, `${clean}.json`);
  rememberProject(clean);
  Object.assign(project, defaultProject());
  undoStack = [];
  redoStack = [];
  project.revision++;
  saveNow();
  return { name: clean };
}

// autosave-versies: elke 5 min een snapshot (alleen bij wijzigingen), max 20 per project
let lastVersionRev = -1;
setInterval(() => {
  try {
    if (project.revision === lastVersionRev) return;
    lastVersionRev = project.revision;
    const vdir = path.join(projectsDir, 'versions');
    fs.mkdirSync(vdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(vdir, `${activeProjectName()}-${stamp}.json`), JSON.stringify(project));
    const mine = fs.readdirSync(vdir).filter((f) => f.startsWith(activeProjectName() + '-')).sort();
    while (mine.length > 20) fs.unlinkSync(path.join(vdir, mine.shift()));
  } catch { /* versies zijn best-effort */ }
}, 5 * 60 * 1000);

let saveTimer = null;
export function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveNow();
    // Premiere Pro-compatibele kopie (xmeml) naast de json
    import('./xml.js')
      .then((m) => m.writePremiereXml(activeProjectName()))
      .catch((e) => console.error('xml-export mislukt:', e.message));
  }, 400);
}

// ---------- helpers ----------

export function findClip(clipId) {
  for (const t of project.tracks) {
    const c = t.clips.find((c) => c.id === clipId);
    if (c) return { clip: c, track: t };
  }
  return null;
}
const clipLen = (c) => (c.out - c.in) / (c.speed || 1);
const clipEnd = (c) => c.start + clipLen(c);
export const trackById = (id) => project.tracks.find((t) => t.id === id);

function sortTrack(t) {
  t.clips.sort((a, b) => a.start - b.start);
}

// Overwrite-gedrag (Premiere-stijl): nieuw materiaal overschrijft wat eronder ligt.
function overwriteRange(track, start, end, ignoreId) {
  const keep = [];
  for (const c of track.clips) {
    if (c.id === ignoreId) { keep.push(c); continue; }
    const cEnd = clipEnd(c);
    if (cEnd <= start || c.start >= end) { keep.push(c); continue; }
    // volledig bedekt -> weg
    if (c.start >= start && cEnd <= end) continue;
    const sp = c.speed || 1;
    // nieuw clip valt midden in bestaande -> splitsen in twee
    if (c.start < start && cEnd > end) {
      const right = { ...c, id: uid(), linkId: c.linkId ? c.linkId + '_r' : undefined };
      right.in = c.in + (end - c.start) * sp;
      right.start = end;
      c.out = c.in + (start - c.start) * sp;
      keep.push(c, right);
      continue;
    }
    // linkerdeel blijft
    if (c.start < start) { c.out = c.in + (start - c.start) * sp; keep.push(c); continue; }
    // rechterdeel blijft
    c.in = c.in + (end - c.start) * sp;
    c.start = end;
    keep.push(c);
  }
  track.clips = keep;
  sortTrack(track);
}

function snapshot() {
  undoStack.push(JSON.stringify({ tracks: project.tracks, media: project.media, settings: project.settings, markers: project.markers ?? [], notes: project.notes ?? [], transitions: project.transitions ?? [] }));
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
}
function restore(json) {
  const s = JSON.parse(json);
  project.tracks = s.tracks;
  project.media = s.media;
  project.settings = s.settings;
  project.markers = s.markers ?? [];
  project.notes = s.notes ?? [];
  project.transitions = s.transitions ?? [];
}

// ---------- versies (zie versions.js) ----------

// Alles wat de montage bepaalt; media hoort erbij omdat clips ernaar verwijzen.
export function projectSnapshot() {
  return JSON.parse(JSON.stringify({
    settings: project.settings,
    media: project.media,
    tracks: project.tracks,
    markers: project.markers ?? [],
    notes: project.notes ?? [],
    transitions: project.transitions ?? [],
    workArea: project.workArea ?? null,
  }));
}

// Een bewaarde versie terugzetten. Gaat via de undo-stack, dus ⌘Z draait het terug.
export function applySnapshot(snap) {
  if (!snap || !snap.tracks) throw new Error('Ongeldige versie (geen tracks)');
  snapshot();
  const s = JSON.parse(JSON.stringify(snap));
  project.settings = s.settings ?? project.settings;
  project.media = s.media ?? {};
  project.tracks = s.tracks;
  project.markers = s.markers ?? [];
  project.notes = s.notes ?? [];
  project.transitions = s.transitions ?? [];
  project.workArea = s.workArea ?? null;
  project.selection = [];
  project.revision++;
  scheduleSave();
  return { ok: true };
}

// ---------- commands ----------

const MUTATING = new Set([
  'addClip', 'moveClip', 'moveClips', 'trimClip', 'splitClip', 'splitAt', 'deleteClip',
  'setClipGain', 'setClipLabel', 'setClipFade', 'addTrack', 'removeTrack', 'setSettings',
  'removeMedia', 'newProject', 'rippleDelete', 'addTitle', 'editTitle', 'setClipProps',
  'setTrackFlags', 'duplicateClips', 'addMarker', 'removeMarker', 'editMarker',
  'setClipGainKeys', 'addTransition', 'removeTransition', 'editTransition', 'closeGap',
  'addNote', 'editNote', 'removeNote',
  'cutRange', 'cutRanges', 'setTrackName', 'setMediaSpeaker', 'setProjectMeta', 'replaceMedia', 'setMediaText',
]);

// geluid/beeld actief? (mute + solo-logica per tracktype)
export function trackAudible(track) {
  const peers = project.tracks.filter((t) => t.type === track.type);
  const anySolo = peers.some((t) => t.solo);
  return !track.muted && (!anySolo || !!track.solo);
}

function assertUnlocked(track) {
  if (track?.locked) throw new Error(`Track ${track.id} is vergrendeld`);
}

// Vindt het clip-paar rond een cut op een track (A eindigt, B begint op time ±tol)
export function cutPairAt(track, time, tol = 0.06) {
  let A = null, B = null;
  for (const c of track.clips) {
    if (Math.abs(clipEnd(c) - time) < tol) A = c;
    if (Math.abs(c.start - time) < tol) B = c;
  }
  return A && B && A.id !== B.id ? { A, B } : null;
}

// stilstaande mediatypes: geen eigen tijdbasis, trimmen = duur veranderen
const isStill = (m) => m?.type === 'image' || m?.type === 'title';

export function applyCommand(cmd, args = {}) {
  if (MUTATING.has(cmd) && cmd !== 'undo' && cmd !== 'redo') snapshot();
  const result = commands[cmd]
    ? commands[cmd](args)
    : (() => { throw new Error(`Onbekend commando: ${cmd}`); })();
  project.revision++;
  scheduleSave();
  return result === undefined ? { ok: true } : result;
}

const commands = {
  newProject({ settings } = {}) {
    const fresh = defaultProject();
    if (settings) Object.assign(fresh.settings, settings);
    fresh.media = project.media; // media bin blijft behouden
    Object.assign(project, fresh);
  },

  setSettings({ settings }) {
    Object.assign(project.settings, settings);
  },

  // Eigenschappen: titel, klant, omschrijving, soort (video|podcast). Onbekende velden
  // worden genegeerd; lege string wist een veld.
  setProjectMeta({ meta }) {
    if (!project.meta) project.meta = defaultProject().meta;
    const allowed = ['title', 'client', 'description', 'kind'];
    for (const k of allowed) {
      if (meta?.[k] === undefined) continue;
      project.meta[k] = String(meta[k] ?? '').trim().slice(0, k === 'description' ? 2000 : 120);
    }
    if (project.meta.kind !== 'podcast') project.meta.kind = 'video';
    return { meta: project.meta };
  },

  addTrack({ type, name }) {
    const prefix = type === 'video' ? 'V' : 'A';
    const nums = project.tracks.filter((t) => t.type === type).map((t) => parseInt(t.id.slice(1)) || 0);
    const id = prefix + (Math.max(0, ...nums) + 1);
    const track = { id, type, clips: [] };
    if (name) track.name = String(name).trim().slice(0, 40);
    if (type === 'video') project.tracks.unshift(track);
    else project.tracks.push(track);
    return { track };
  },

  // Mute (M), solo (S), lock (🔒) en magnetisch snappen (🧲, standaard aan) per track
  setTrackFlags({ trackId, muted, solo, locked, magnetic }) {
    const t = trackById(trackId);
    if (!t) throw new Error(`Track ${trackId} bestaat niet`);
    if (muted !== undefined) { if (muted) t.muted = true; else delete t.muted; }
    if (solo !== undefined) { if (solo) t.solo = true; else delete t.solo; }
    if (locked !== undefined) { if (locked) t.locked = true; else delete t.locked; }
    if (magnetic !== undefined) { if (magnetic) delete t.magnetic; else t.magnetic = false; }
    return { track: { id: t.id, muted: !!t.muted, solo: !!t.solo, locked: !!t.locked, magnetic: t.magnetic !== false } };
  },

  removeTrack({ trackId }) {
    const t = trackById(trackId);
    if (!t) throw new Error(`Track ${trackId} bestaat niet`);
    if (t.clips.length) throw new Error(`Track ${trackId} is niet leeg`);
    project.tracks = project.tracks.filter((x) => x.id !== trackId);
  },

  // Voegt clip toe (overwrite). Video met audio krijgt automatisch een gelinkte audioclip op een audiotrack.
  addClip({ mediaId, trackId, start, in: inP, out: outP, linkAudio = true, audioTrackId }) {
    const m = project.media[mediaId];
    if (!m) throw new Error(`Media ${mediaId} niet gevonden`);
    const track = trackById(trackId);
    if (!track) throw new Error(`Track ${trackId} bestaat niet`);
    const isVideoMedia = m.type === 'video' || isStill(m);
    if (track.type === 'video' && !isVideoMedia) throw new Error('Audio hoort op een audiotrack');
    if (track.type === 'audio' && isStill(m)) throw new Error('Afbeelding/titel hoort op een videotrack');
    assertUnlocked(track);

    // afbeeldingen/titels: 5 s standaard, of de gevraagde lengte (out) als die groter is
    const dur = m.duration ?? (isStill(m) && outP > 0 ? outP : 5);
    const cin = Math.max(0, inP ?? 0);
    const cout = Math.min(dur, outP ?? dur);
    if (cout <= cin) throw new Error('out moet groter zijn dan in');
    start = Math.max(0, start ?? project.playhead);

    const clip = { id: uid(), mediaId, start, in: cin, out: cout, gain: 1 };
    const created = [clip];

    if (track.type === 'video' && m.type === 'video' && m.hasAudio && linkAudio) {
      const at = audioTrackId ? trackById(audioTrackId) : project.tracks.find((t) => t.type === 'audio' && !t.locked);
      if (at && !at.locked) {
        const linkId = uid();
        clip.linkId = linkId;
        const aclip = { id: uid(), mediaId, start, in: cin, out: cout, gain: 1, linkId };
        overwriteRange(at, start, start + (cout - cin), null);
        at.clips.push(aclip);
        sortTrack(at);
        created.push(aclip);
      }
    }
    overwriteRange(track, start, start + (cout - cin), null);
    track.clips.push(clip);
    sortTrack(track);
    return { clips: created };
  },

  moveClip({ clipId, trackId, start, withLinked = true }) {
    const found = findClip(clipId);
    if (!found) throw new Error(`Clip ${clipId} niet gevonden`);
    const { clip, track } = found;
    assertUnlocked(track);
    if (trackId) assertUnlocked(trackById(trackId));
    const delta = start - clip.start;
    const targets = [{ clip, from: track, to: trackId ? trackById(trackId) : track }];

    if (withLinked && clip.linkId) {
      for (const t of project.tracks) {
        if (t.locked) continue; // vergrendeld: gelinkte clip blijft staan
        for (const c of t.clips) {
          if (c.linkId === clip.linkId && c.id !== clip.id) targets.push({ clip: c, from: t, to: t });
        }
      }
    }
    for (const { to, from } of targets) {
      if (!to) throw new Error(`Track ${trackId} bestaat niet`);
      if (to.type !== from.type) throw new Error('Clip kan niet naar een ander tracktype');
    }
    for (const { clip: c, from } of targets) {
      from.clips = from.clips.filter((x) => x.id !== c.id);
    }
    for (const { clip: c, to } of targets) {
      c.start = Math.max(0, c.start + delta);
      overwriteRange(to, c.start, clipEnd(c), null);
      to.clips.push(c);
      sortTrack(to);
    }
  },

  // Groep clips samen verschuiven met dezelfde delta (tracks blijven gelijk).
  moveClips({ clipIds, delta, withLinked = true }) {
    const set = new Set(clipIds);
    if (withLinked) {
      const links = new Set();
      for (const t of project.tracks) {
        for (const c of t.clips) if (set.has(c.id) && c.linkId) links.add(c.linkId);
      }
      for (const t of project.tracks) {
        for (const c of t.clips) if (c.linkId && links.has(c.linkId)) set.add(c.id);
      }
    }
    const items = [];
    for (const t of project.tracks) {
      if (t.locked) continue;
      for (const c of t.clips) if (set.has(c.id)) items.push({ c, t });
    }
    if (!items.length) throw new Error('Geen clips gevonden (of tracks vergrendeld)');
    const minStart = Math.min(...items.map(({ c }) => c.start));
    const d = Math.max(delta, -minStart); // niet voorbij 0
    // eerst allemaal weghalen zodat ze elkaar niet overschrijven, dan terugplaatsen
    for (const { c, t } of items) t.clips = t.clips.filter((x) => x.id !== c.id);
    for (const { c, t } of items) {
      c.start += d;
      overwriteRange(t, c.start, clipEnd(c), null);
      t.clips.push(c);
      sortTrack(t);
    }
  },

  // edge: 'in' (linkerkant) of 'out' (rechterkant); time = nieuwe timeline-positie van die kant
  trimClip({ clipId, edge, time, withLinked = true }) {
    const found = findClip(clipId);
    if (!found) throw new Error(`Clip ${clipId} niet gevonden`);
    assertUnlocked(found.track);
    const list = [found];
    if (withLinked && found.clip.linkId) {
      for (const t of project.tracks) {
        if (t.locked) continue;
        for (const c of t.clips) {
          if (c.linkId === found.clip.linkId && c.id !== found.clip.id) list.push({ clip: c, track: t });
        }
      }
    }
    for (const { clip, track } of list) {
      const m = project.media[clip.mediaId];
      const isImage = isStill(m);
      const sp = clip.speed || 1;
      if (edge === 'in') {
        const maxIn = clip.start + clipLen(clip) - 0.04;
        const lowerBound = isImage ? 0 : clip.start - clip.in / sp; // niet voorbij mediabegin
        const t = Math.min(Math.max(time, lowerBound), maxIn);
        const d = t - clip.start;
        clip.start = t;
        if (isImage) clip.out -= d; // afbeelding: alleen duur wijzigt
        else clip.in = Math.max(0, clip.in + d * sp);
      } else {
        const maxOut = isImage ? Infinity : clip.start + ((m?.duration ?? Infinity) - clip.in) / sp;
        const t = Math.max(Math.min(time, maxOut), clip.start + 0.04);
        clip.out = clip.in + (t - clip.start) * sp;
      }
      overwriteRange(track, clip.start, clipEnd(clip), clip.id);
    }
  },

  splitClip({ clipId, time }) {
    const found = findClip(clipId);
    if (!found) throw new Error(`Clip ${clipId} niet gevonden`);
    assertUnlocked(found.track);
    return doSplit(found, time);
  },

  // Splits alle clips (of alleen opgegeven tracks) op tijdstip t — de "razor over alles"
  splitAt({ time, trackIds }) {
    const made = [];
    for (const t of project.tracks) {
      if (trackIds && !trackIds.includes(t.id)) continue;
      if (t.locked) continue;
      for (const c of [...t.clips]) {
        if (time > c.start + 0.02 && time < clipEnd(c) - 0.02) {
          made.push(doSplit({ clip: c, track: t }, time));
        }
      }
    }
    return { splits: made };
  },

  deleteClip({ clipId, withLinked = true, ripple = false }) {
    const found = findClip(clipId);
    if (!found) throw new Error(`Clip ${clipId} niet gevonden`);
    assertUnlocked(found.track);
    const ids = [clipId];
    if (withLinked && found.clip.linkId) {
      for (const t of project.tracks) {
        if (t.locked) continue;
        for (const c of t.clips) if (c.linkId === found.clip.linkId) ids.push(c.id);
      }
    }
    const start = found.clip.start;
    const len = clipEnd(found.clip) - start;
    for (const t of project.tracks) t.clips = t.clips.filter((c) => !ids.includes(c.id));
    if (ripple) {
      for (const t of project.tracks) {
        if (t.locked) continue;
        for (const c of t.clips) if (c.start >= start + len - 0.001) c.start -= len;
        sortTrack(t);
      }
    }
    project.selection = project.selection.filter((id) => !ids.includes(id));
  },

  rippleDelete({ clipId }) {
    return commands.deleteClip({ clipId, ripple: true });
  },

  // Snijd een tijdvak uit de montage: razor op beide randen, alles ertussen weg.
  // Met ripple sluit het gat en schuift alles erachter op (ook markers, opmerkingen
  // en overgangen, die anders op een absolute tijd blijven hangen).
  cutRange({ start, end, trackIds, ripple = true }) {
    return commands.cutRanges({ ranges: [{ start, end }], trackIds, ripple });
  },

  // Meerdere tijdvakken in één keer (en dus één undo-stap): denk aan stiltes
  // wegsnijden of een reeks stopwoorden verwijderen. Van achter naar voren
  // verwerkt, zodat de tijden van de eerdere vakken blijven kloppen.
  cutRanges({ ranges, trackIds, ripple = true }) {
    const clean = (ranges || [])
      .map((r) => ({ start: Math.max(0, +r.start), end: +r.end }))
      .filter((r) => r.end > r.start + 0.001)
      .sort((a, b) => a.start - b.start);
    if (!clean.length) throw new Error('Geen geldige tijdvakken opgegeven');

    // overlappende vakken samenvoegen
    const merged = [clean[0]];
    for (const r of clean.slice(1)) {
      const last = merged[merged.length - 1];
      if (r.start <= last.end + 0.001) last.end = Math.max(last.end, r.end);
      else merged.push(r);
    }

    const targets = () => project.tracks.filter((t) => !t.locked && (!trackIds || trackIds.includes(t.id)));
    let removed = 0;
    let closed = 0;

    for (const r of [...merged].reverse()) {
      for (const t of targets()) {
        // per knippunt opnieuw langs de clips: de eerste razor maakt een nieuwe clip
        // die zelf ook nog op het tweede punt geknipt moet worden.
        for (const time of [r.start, r.end]) {
          for (const c of [...t.clips]) {
            if (time > c.start + 0.02 && time < clipEnd(c) - 0.02) doSplit({ clip: c, track: t }, time);
          }
        }
        const before = t.clips.length;
        t.clips = t.clips.filter((c) => !(c.start >= r.start - 0.001 && clipEnd(c) <= r.end + 0.001));
        removed += before - t.clips.length;
        sortTrack(t);
      }
      if (ripple) {
        const len = r.end - r.start;
        closed += len;
        // Alleen de tracks die we ook echt geknipt hebben schuiven op; anders zou
        // "alleen deze track" de rest van de montage uit de pas laten lopen.
        for (const t of targets()) {
          for (const c of t.clips) if (c.start >= r.end - 0.001) c.start = +(c.start - len).toFixed(4);
          sortTrack(t);
        }
        if (!trackIds) {
          const shift = (x) => (x >= r.end - 0.001 ? +(x - len).toFixed(4) : x);
          for (const tr of project.transitions ?? []) tr.time = shift(tr.time);
          for (const mk of project.markers ?? []) mk.time = shift(mk.time);
          for (const n of project.notes ?? []) n.time = shift(n.time);
        }
      }
    }
    project.selection = [];
    return { ranges: merged.length, clipsRemoved: removed, secondsClosed: +closed.toFixed(3) };
  },

  // Een track een leesbare naam geven ("Silvan", "Voice-over", "Muziek").
  setTrackName({ trackId, name }) {
    const t = trackById(trackId);
    if (!t) throw new Error(`Track ${trackId} bestaat niet`);
    const clean = String(name ?? '').trim().slice(0, 40);
    if (clean) t.name = clean; else delete t.name;
    return { track: { id: t.id, name: t.name ?? null } };
  },

  // Alle clips van het ene mediabestand laten wijzen naar het andere (zelfde in/out).
  // Werkpatroon: audio verbeteren met ✨, dan het origineel op de tijdlijn vervangen.
  // De vervanger moet minstens even lang zijn, anders sneuvelt materiaal.
  replaceMedia({ fromMediaId, toMediaId, trackIds }) {
    const from = project.media[fromMediaId], to = project.media[toMediaId];
    if (!from) throw new Error(`Media ${fromMediaId} niet gevonden`);
    if (!to) throw new Error(`Media ${toMediaId} niet gevonden`);
    if (fromMediaId === toMediaId) throw new Error('Bron en vervanger zijn hetzelfde bestand');
    if ((to.duration ?? 0) + 0.05 < (from.duration ?? 0)) {
      throw new Error(`Vervanger is korter (${(to.duration ?? 0).toFixed(1)}s) dan het origineel (${(from.duration ?? 0).toFixed(1)}s)`);
    }
    let n = 0;
    for (const t of project.tracks) {
      if (t.locked) continue;
      if (trackIds && !trackIds.includes(t.id)) continue;
      for (const c of t.clips) if (c.mediaId === fromMediaId) { c.mediaId = toMediaId; n++; }
    }
    return { replaced: n, from: from.name, to: to.name };
  },

  // Spreker koppelen aan een mediabestand (mic-spoor) — de tijdlijn en het
  // transcriptpaneel tonen die naam bij elke clip van dat spoor.
  setMediaSpeaker({ mediaId, speaker }) {
    const m = project.media[mediaId];
    if (!m) throw new Error(`Media ${mediaId} niet gevonden`);
    const clean = String(speaker ?? '').trim().slice(0, 40);
    if (clean) m.speaker = clean; else delete m.speaker;
    return { mediaId, speaker: m.speaker ?? null };
  },

  // De brontekst/prompt van een media-item vastleggen (of corrigeren). Gegenereerde media
  // krijgen dit automatisch mee; met dit commando vul je het aan voor ouder materiaal —
  // bijvoorbeeld na transcriberen, of als je de tekst van een ingesproken zin wilt bewaren.
  setMediaText({ mediaId, text, prompt, kind, voiceId, clear }) {
    const m = project.media[mediaId];
    if (!m) throw new Error(`Media ${mediaId} niet gevonden`);
    if (clear) { delete m.gen; return { mediaId, gen: null }; }
    const gen = { ...(m.gen || {}) };
    if (text !== undefined) gen.text = String(text ?? '').trim();
    if (prompt !== undefined) gen.prompt = String(prompt ?? '').trim();
    if (voiceId !== undefined) gen.voiceId = voiceId || null;
    gen.kind = kind || gen.kind || (m.type === 'audio' ? 'voiceover' : m.type === 'image' ? 'image' : 'media');
    if (!gen.at) gen.at = Date.now();
    m.gen = gen;
    return { mediaId, gen };
  },

  setClipGain({ clipId, gain }) {
    const found = findClip(clipId);
    if (!found) throw new Error(`Clip ${clipId} niet gevonden`);
    assertUnlocked(found.track);
    found.clip.gain = Math.max(0, Math.min(4, gain));
  },

  // Volume-envelope: keyframes [{t, gain}] met t in timeline-seconden binnen de clip
  // (0 = clipbegin). Werkt bovenop de vlakke gain. Lege lijst = envelope weg.
  setClipGainKeys({ clipId, keys }) {
    const found = findClip(clipId);
    if (!found) throw new Error(`Clip ${clipId} niet gevonden`);
    assertUnlocked(found.track);
    const len = clipLen(found.clip);
    if (!keys || !keys.length) {
      delete found.clip.gainKeys;
      return { clip: found.clip };
    }
    found.clip.gainKeys = keys
      .map((k) => ({ t: Math.max(0, Math.min(len, +k.t || 0)), gain: Math.max(0, Math.min(4, +k.gain ?? 1)) }))
      .sort((a, b) => a.t - b.t);
    return { clip: found.clip };
  },

  // Fade in/uit in seconden (video: van/naar zwart; audio: volume-ramp).
  // Werkt ook op de gelinkte clip zodat beeld en geluid samen faden.
  setClipFade({ clipId, fadeIn, fadeOut, withLinked = true }) {
    const found = findClip(clipId);
    if (!found) throw new Error(`Clip ${clipId} niet gevonden`);
    assertUnlocked(found.track);
    const list = [found.clip];
    if (withLinked && found.clip.linkId) {
      for (const t of project.tracks) {
        if (t.locked) continue;
        for (const c of t.clips) if (c.linkId === found.clip.linkId && c.id !== found.clip.id) list.push(c);
      }
    }
    for (const c of list) {
      const len = clipLen(c);
      if (fadeIn !== undefined) c.fadeIn = Math.max(0, Math.min(len, fadeIn)) || undefined;
      if (fadeOut !== undefined) c.fadeOut = Math.max(0, Math.min(len, fadeOut)) || undefined;
      // samen nooit langer dan de clip
      if ((c.fadeIn ?? 0) + (c.fadeOut ?? 0) > len) {
        if (fadeIn !== undefined) c.fadeOut = Math.max(0, len - c.fadeIn) || undefined;
        else c.fadeIn = Math.max(0, len - c.fadeOut) || undefined;
      }
    }
  },

  setClipLabel({ clipId, label }) {
    const found = findClip(clipId);
    if (!found) throw new Error(`Clip ${clipId} niet gevonden`);
    assertUnlocked(found.track);
    found.clip.label = label;
  },

  // Titelclip aanmaken (in de bin; daarna met addClip op een videotrack plaatsen)
  addTitle({ text, size, color, bg, pos, name }) {
    if (!text || !text.trim()) throw new Error('Geen titeltekst opgegeven');
    const id = uid();
    const media = {
      id,
      name: name || text.trim().slice(0, 30),
      type: 'title',
      text: text.trim(),
      size: size ?? 64,          // px op 1080p-basis
      color: color || '#ffffff',
      bg: bg !== false,          // donker balkje achter de tekst
      pos: pos || 'onder',       // 'onder' | 'midden' | 'boven'
      duration: null,
      hasAudio: false,
    };
    project.media[id] = media;
    return { media };
  },

  editTitle({ mediaId, text, size, color, bg, pos }) {
    const m = project.media[mediaId];
    if (!m || m.type !== 'title') throw new Error('Geen titel-media');
    if (text !== undefined) { m.text = text; m.name = text.trim().slice(0, 30); }
    if (size !== undefined) m.size = size;
    if (color !== undefined) m.color = color;
    if (bg !== undefined) m.bg = bg;
    if (pos !== undefined) m.pos = pos;
    return { media: m };
  },

  // Snelheid (0.25–4, verandert cliplengte op de timeline; gelinkte audio volgt),
  // opacity (0–1) en transform (scale 0.05–3, x/y als fractie van het beeld, PiP).
  setClipProps({ clipId, speed, opacity, scale, x, y, withLinked = true }) {
    const found = findClip(clipId);
    if (!found) throw new Error(`Clip ${clipId} niet gevonden`);
    assertUnlocked(found.track);
    const group = [found];
    if (withLinked && found.clip.linkId && speed !== undefined) {
      for (const t of project.tracks) {
        if (t.locked) continue;
        for (const c of t.clips) {
          if (c.linkId === found.clip.linkId && c.id !== found.clip.id) group.push({ clip: c, track: t });
        }
      }
    }
    if (speed !== undefined) {
      const sp = Math.max(0.25, Math.min(4, speed));
      for (const { clip, track } of group) {
        if (isStill(project.media[clip.mediaId])) continue;
        clip.speed = sp === 1 ? undefined : sp;
        overwriteRange(track, clip.start, clipEnd(clip), clip.id); // nieuwe lengte kan buren raken
      }
    }
    const c = found.clip;
    if (opacity !== undefined) {
      const op = Math.max(0, Math.min(1, opacity));
      if (op >= 1) delete c.opacity; else c.opacity = op;
    }
    if (scale !== undefined || x !== undefined || y !== undefined) {
      const tr = { ...(c.transform || {}) };
      if (scale !== undefined) tr.scale = Math.max(0.05, Math.min(3, scale));
      if (x !== undefined) tr.x = Math.max(-1, Math.min(1, x));
      if (y !== undefined) tr.y = Math.max(-1, Math.min(1, y));
      if ((tr.scale ?? 1) === 1 && !(tr.x ?? 0) && !(tr.y ?? 0)) delete c.transform;
      else c.transform = tr;
    }
    return { clip: c };
  },

  removeMedia({ mediaId }) {
    for (const t of project.tracks) t.clips = t.clips.filter((c) => c.mediaId !== mediaId);
    delete project.media[mediaId];
  },

  // Kopieert clips (met alle eigenschappen) naar atTime; onderlinge afstand en tracks blijven.
  duplicateClips({ clipIds, atTime }) {
    const items = [];
    for (const t of project.tracks) {
      for (const c of t.clips) if (clipIds.includes(c.id)) items.push({ c, t });
    }
    if (!items.length) throw new Error('Geen clips gevonden om te dupliceren');
    const minStart = Math.min(...items.map(({ c }) => c.start));
    const base = Math.max(0, atTime ?? project.playhead);
    const linkMap = new Map(); // oude linkId -> nieuwe
    const made = [];
    for (const { c, t } of items) {
      assertUnlocked(t);
      const copy = { ...c, id: uid() };
      copy.start = base + (c.start - minStart);
      if (c.linkId) {
        if (!linkMap.has(c.linkId)) linkMap.set(c.linkId, uid());
        copy.linkId = linkMap.get(c.linkId);
      }
      overwriteRange(t, copy.start, clipEnd(copy), null);
      t.clips.push(copy);
      sortTrack(t);
      made.push({ id: copy.id, trackId: t.id, start: copy.start });
    }
    return { clips: made };
  },

  // Gat op een track dichttrekken: alles ná het gat schuift naar links (ripple over
  // alle onvergrendelde tracks, zodat sync behouden blijft).
  closeGap({ trackId, time }) {
    const track = trackById(trackId);
    if (!track) throw new Error(`Track ${trackId} bestaat niet`);
    assertUnlocked(track);
    let prevEnd = 0, nextStart = Infinity;
    for (const c of track.clips) {
      const e = clipEnd(c);
      if (e <= time + 1e-6 && e > prevEnd) prevEnd = e;
      if (c.start >= time - 1e-6 && c.start < nextStart) nextStart = c.start;
    }
    if (!isFinite(nextStart)) throw new Error('Geen clip na het gat');
    const gap = nextStart - prevEnd;
    if (gap < 0.01) throw new Error('Geen gat op deze plek');
    for (const t of project.tracks) {
      if (t.locked) continue;
      for (const c of t.clips) if (c.start >= nextStart - 1e-6) c.start -= gap;
      sortTrack(t);
    }
    return { closed: Math.round(gap * 100) / 100 };
  },

  // Overgang op een cut: type 'crossfade' | 'wipe' | 'dip' (audiotracks: alleen crossfade).
  // withLinked: zelfde overgang ook op de gelinkte audio-cut (crossfade daar).
  addTransition({ trackId, time, type = 'crossfade', dur = 1, withLinked = true }) {
    const track = trackById(trackId);
    if (!track) throw new Error(`Track ${trackId} bestaat niet`);
    assertUnlocked(track);
    const pair = cutPairAt(track, time);
    if (!pair) throw new Error(`Geen cut (twee aansluitende clips) rond t=${time.toFixed(2)} op ${trackId}`);
    if (track.type === 'audio') type = 'crossfade';
    if (!['crossfade', 'wipe', 'dip'].includes(type)) throw new Error(`Onbekend overgangstype: ${type}`);
    const cut = clipEnd(pair.A); // exact snappen op de cut
    project.transitions = project.transitions ?? [];
    // maximaal één overgang per cut per track
    project.transitions = project.transitions.filter((tr) => !(tr.trackId === trackId && Math.abs(tr.time - cut) < 0.06));
    const trans = { id: uid(), trackId, time: cut, type, dur: Math.max(0.2, Math.min(5, dur)) };
    project.transitions.push(trans);
    const made = [trans];
    // gelinkte audio-cut: automatisch audio-crossfade
    if (withLinked && track.type === 'video' && (pair.A.linkId || pair.B.linkId)) {
      for (const at of project.tracks) {
        if (at.type !== 'audio' || at.locked) continue;
        const apair = cutPairAt(at, cut);
        if (apair && apair.A.linkId === pair.A.linkId && apair.B.linkId === pair.B.linkId) {
          project.transitions = project.transitions.filter((tr) => !(tr.trackId === at.id && Math.abs(tr.time - cut) < 0.06));
          const atr = { id: uid(), trackId: at.id, time: cut, type: 'crossfade', dur: trans.dur };
          project.transitions.push(atr);
          made.push(atr);
          break;
        }
      }
    }
    return { transitions: made };
  },

  removeTransition({ transitionId, nearTime, trackId }) {
    project.transitions = project.transitions ?? [];
    let target = transitionId ? project.transitions.find((t) => t.id === transitionId) : null;
    if (!target && nearTime !== undefined) {
      target = project.transitions
        .filter((t) => (!trackId || t.trackId === trackId) && Math.abs(t.time - nearTime) < 1)
        .sort((a, b) => Math.abs(a.time - nearTime) - Math.abs(b.time - nearTime))[0];
    }
    if (!target) throw new Error('Overgang niet gevonden');
    project.transitions = project.transitions.filter((t) => t !== target);
    return { removed: target.id };
  },

  editTransition({ transitionId, dur, type }) {
    const t = (project.transitions ?? []).find((x) => x.id === transitionId);
    if (!t) throw new Error('Overgang niet gevonden');
    if (dur !== undefined) t.dur = Math.max(0.2, Math.min(5, dur));
    if (type !== undefined && ['crossfade', 'wipe', 'dip'].includes(type)) t.type = type;
    return { transition: t };
  },

  // Opmerkingen (review): een notitie op een tijdstip, zoals in Vimeo Review.
  // Claude leest ze via GET /api/notes en verwerkt ze; done=true = afgehandeld.
  addNote({ time, text, author = 'jij' }) {
    if (!text || !text.trim()) throw new Error('Lege opmerking');
    project.notes = project.notes ?? [];
    const note = {
      id: uid(),
      time: Math.max(0, time ?? project.playhead),
      text: text.trim(),
      author,
      done: false,
      created: new Date().toISOString(),
    };
    project.notes.push(note);
    project.notes.sort((a, b) => a.time - b.time);
    return { note };
  },

  editNote({ noteId, text, time, done, antwoord }) {
    const n = (project.notes ?? []).find((x) => x.id === noteId);
    if (!n) throw new Error('Opmerking niet gevonden');
    if (text !== undefined) n.text = text;
    if (time !== undefined) n.time = Math.max(0, time);
    if (done !== undefined) n.done = !!done;
    if (antwoord !== undefined) n.antwoord = antwoord;   // reactie van Claude
    project.notes.sort((a, b) => a.time - b.time);
    return { note: n };
  },

  removeNote({ noteId }) {
    const voor = (project.notes ?? []).length;
    project.notes = (project.notes ?? []).filter((n) => n.id !== noteId);
    if (project.notes.length === voor) throw new Error('Opmerking niet gevonden');
  },

  addMarker({ time, name, color }) {
    project.markers = project.markers ?? [];
    const marker = { id: uid(), time: Math.max(0, time ?? project.playhead), name: name || '', color: color || '#2dd07f' };
    project.markers.push(marker);
    project.markers.sort((a, b) => a.time - b.time);
    return { marker };
  },

  removeMarker({ markerId, nearTime }) {
    project.markers = project.markers ?? [];
    let target = markerId ? project.markers.find((m) => m.id === markerId) : null;
    if (!target && nearTime !== undefined) {
      target = project.markers
        .filter((m) => Math.abs(m.time - nearTime) < 1)
        .sort((a, b) => Math.abs(a.time - nearTime) - Math.abs(b.time - nearTime))[0];
    }
    if (!target) throw new Error('Marker niet gevonden');
    project.markers = project.markers.filter((m) => m !== target);
    return { removed: target.id };
  },

  editMarker({ markerId, time, name, color }) {
    const m = (project.markers ?? []).find((x) => x.id === markerId);
    if (!m) throw new Error('Marker niet gevonden');
    if (time !== undefined) m.time = Math.max(0, time);
    if (name !== undefined) m.name = name;
    if (color !== undefined) m.color = color;
    project.markers.sort((a, b) => a.time - b.time);
    return { marker: m };
  },

  setPlayhead({ time }) {
    project.playhead = Math.max(0, time);
  },

  // Werkgebied: deel van de timeline voor render/preview-doeleinden
  setWorkArea({ start, end }) {
    const cur = project.workArea || { start: 0, end: projectDuration() };
    const a = start ?? cur.start;
    const b = end ?? cur.end;
    if (b <= a) throw new Error('Werkgebied-einde moet na het begin liggen');
    project.workArea = { start: Math.max(0, a), end: b };
    return { workArea: project.workArea };
  },

  clearWorkArea() {
    project.workArea = null;
  },

  setSelection({ clipIds }) {
    project.selection = clipIds || [];
  },

  undo() {
    if (!undoStack.length) return { ok: false, reason: 'niets om ongedaan te maken' };
    redoStack.push(JSON.stringify({ tracks: project.tracks, media: project.media, settings: project.settings, markers: project.markers ?? [], notes: project.notes ?? [], transitions: project.transitions ?? [] }));
    restore(undoStack.pop());
  },

  redo() {
    if (!redoStack.length) return { ok: false, reason: 'niets om opnieuw te doen' };
    undoStack.push(JSON.stringify({ tracks: project.tracks, media: project.media, settings: project.settings, markers: project.markers ?? [], notes: project.notes ?? [], transitions: project.transitions ?? [] }));
    restore(redoStack.pop());
  },
};

function doSplit({ clip, track }, time) {
  if (time <= clip.start || time >= clipEnd(clip)) throw new Error('Splitspunt valt buiten de clip');
  const m = project.media[clip.mediaId];
  const right = { ...clip, id: uid() };
  const offset = time - clip.start;
  const spd = clip.speed || 1;
  right.start = time;
  if (isStill(m)) {
    right.out = clip.out - offset;
  } else {
    right.in = clip.in + offset * spd;
  }
  clip.out = isStill(m) ? offset : clip.in + offset * spd;
  // fades: linkerdeel houdt de fade-in, rechterdeel de fade-out
  delete clip.fadeOut;
  delete right.fadeIn;
  // gelinkte clips krijgen nieuwe link-groepen zodat linker/rechter delen apart gelinkt blijven
  if (clip.linkId) {
    const other = [];
    for (const t of project.tracks) {
      if (t.locked) continue; // vergrendeld: gelinkte clip niet mee-splitsen
      for (const c of t.clips) {
        if (c.linkId === clip.linkId && c.id !== clip.id && c.id !== right.id) other.push({ c, t });
      }
    }
    const newLink = uid();
    right.linkId = newLink;
    for (const { c, t } of other) {
      if (time > c.start && time < clipEnd(c)) {
        const r2 = { ...c, id: uid(), linkId: newLink };
        const off2 = (time - c.start) * (c.speed || 1);
        r2.start = time;
        r2.in = c.in + off2;
        c.out = c.in + off2;
        t.clips.push(r2);
        sortTrack(t);
      }
    }
  }
  track.clips.push(right);
  sortTrack(track);
  return { left: clip.id, right: right.id };
}

// Duur van de hele montage
export function projectDuration() {
  let d = 0;
  for (const t of project.tracks) for (const c of t.clips) d = Math.max(d, clipEnd(c));
  return d;
}

// Welke clip is zichtbaar op tijdstip t (bovenste videotrack wint; titels tellen niet mee)
export function videoClipAt(time) {
  for (const t of project.tracks) {
    if (t.type !== 'video') continue;
    const c = t.clips.find((c) => time >= c.start && time < clipEnd(c) && project.media[c.mediaId]?.type !== 'title');
    if (c) return { clip: c, track: t };
  }
  return null;
}

export { uid, clipEnd, clipLen };
