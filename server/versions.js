// Versiegeschiedenis van de montage — "git voor de edit".
// Een versie is een volledige momentopname van het project (tracks, clips, media, markers,
// opmerkingen, overgangen) met een bericht erbij. Je kunt versies teruglezen, vergelijken en
// terugzetten; terugzetten bewaart eerst automatisch de huidige stand, dus je raakt nooit iets kwijt.
//
// Opslag: projects/history/<projectnaam>/<id>.json  +  index.json met de korte meta.
// Los van de 5-minuten-autosaves in projects/versions/ (die zijn een vangnet, dit is bedoeld werk).
import fs from 'fs';
import path from 'path';
import { ROOT, activeProjectName, projectSnapshot, applySnapshot, clipLen } from './state.js';

const uid = () => Math.random().toString(36).slice(2, 9);

function dir() {
  const d = path.join(ROOT, 'projects', 'history', activeProjectName());
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const indexFile = () => path.join(dir(), 'index.json');

function readIndex() {
  try { return JSON.parse(fs.readFileSync(indexFile(), 'utf8')); } catch { return []; }
}
function writeIndex(list) {
  fs.writeFileSync(indexFile(), JSON.stringify(list, null, 2));
}

// Korte kentallen zodat je in de lijst ziet wat een versie voorstelt
function stats(snap) {
  const perTrack = {};
  let eind = 0, clips = 0;
  for (const t of snap.tracks || []) {
    perTrack[t.id] = t.clips.length;
    clips += t.clips.length;
    for (const c of t.clips) eind = Math.max(eind, c.start + clipLen(c));
  }
  return {
    duur: +eind.toFixed(2),
    clips,
    perTrack,
    media: Object.keys(snap.media || {}).length,
    opmerkingen: (snap.notes || []).length,
    openOpmerkingen: (snap.notes || []).filter((n) => !n.done).length,
  };
}

export function listVersions() {
  return readIndex().slice().sort((a, b) => b.time.localeCompare(a.time));
}

export function readVersion(id) {
  const f = path.join(dir(), `${path.basename(String(id))}.json`);
  if (!fs.existsSync(f)) throw new Error(`Versie ${id} bestaat niet`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

export function commitVersion({ message, auto = false } = {}) {
  const bericht = String(message || '').trim() || (auto ? 'automatisch' : 'zonder bericht');
  const snap = projectSnapshot();
  const versie = {
    id: `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${uid()}`,
    time: new Date().toISOString(),
    message: bericht,
    auto,
    project: activeProjectName(),
    stats: stats(snap),
  };
  fs.writeFileSync(path.join(dir(), `${versie.id}.json`), JSON.stringify({ ...versie, snapshot: snap }));
  const idx = readIndex();
  idx.push(versie);
  writeIndex(idx);
  return versie;
}

// Terugzetten: eerst de huidige stand bewaren (auto), dan de gekozen versie laden.
export function restoreVersion(id) {
  const v = readVersion(id);
  const terug = commitVersion({ message: `automatisch bewaard vóór terugzetten naar "${v.message}"`, auto: true });
  applySnapshot(v.snapshot);
  return { hersteld: { id: v.id, message: v.message, time: v.time }, bewaardAls: terug.id };
}

export function removeVersion(id) {
  const f = path.join(dir(), `${path.basename(String(id))}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  writeIndex(readIndex().filter((v) => v.id !== id));
  return { ok: true };
}

// ---------- vergelijken ----------

function clipsById(snap) {
  const m = new Map();
  for (const t of snap.tracks || []) for (const c of t.clips) m.set(c.id, { ...c, trackId: t.id });
  return m;
}

const bijna = (a, b, tol = 0.011) => Math.abs((a ?? 0) - (b ?? 0)) < tol;

// Verschil tussen twee momentopnamen, in gewone taal.
export function diffSnapshots(a, b) {
  const A = clipsById(a), B = clipsById(b);
  const naamA = (c) => a.media?.[c.mediaId]?.name || c.mediaId;
  const naamB = (c) => b.media?.[c.mediaId]?.name || c.mediaId;

  const toegevoegd = [], verwijderd = [], verplaatst = [], getrimd = [], anders = [];
  for (const [id, c] of B) if (!A.has(id)) toegevoegd.push(c);
  for (const [id, c] of A) if (!B.has(id)) verwijderd.push(c);
  for (const [id, cb] of B) {
    const ca = A.get(id);
    if (!ca) continue;
    if (ca.trackId !== cb.trackId || !bijna(ca.start, cb.start)) verplaatst.push({ ca, cb });
    if (!bijna(ca.in, cb.in) || !bijna(ca.out, cb.out)) getrimd.push({ ca, cb });
    const eig = ['gain', 'speed', 'opacity', 'fadeIn', 'fadeOut', 'label'];
    if (eig.some((k) => JSON.stringify(ca[k] ?? null) !== JSON.stringify(cb[k] ?? null))
      || JSON.stringify(ca.gainKeys ?? null) !== JSON.stringify(cb.gainKeys ?? null)) anders.push({ ca, cb });
  }

  const tc = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  const regels = [];
  const sa = stats(a), sb = stats(b);
  regels.push(`Duur ${tc(sa.duur)} → ${tc(sb.duur)} · clips ${sa.clips} → ${sb.clips} · opmerkingen ${sa.opmerkingen} → ${sb.opmerkingen}`);
  for (const c of toegevoegd) regels.push(`+ toegevoegd  ${c.trackId} ${tc(c.start)}  ${naamB(c)}`);
  for (const c of verwijderd) regels.push(`− verwijderd  ${c.trackId} ${tc(c.start)}  ${naamA(c)}`);
  for (const { ca, cb } of verplaatst) {
    const track = ca.trackId !== cb.trackId ? ` (${ca.trackId} → ${cb.trackId})` : '';
    regels.push(`→ verplaatst  ${tc(ca.start)} → ${tc(cb.start)}${track}  ${naamB(cb)}`);
  }
  for (const { ca, cb } of getrimd) regels.push(`✂ getrimd     ${cb.trackId} ${tc(cb.start)}  bron ${ca.in.toFixed(2)}–${ca.out.toFixed(2)} → ${cb.in.toFixed(2)}–${cb.out.toFixed(2)}  ${naamB(cb)}`);
  for (const { cb } of anders) regels.push(`± aangepast   ${cb.trackId} ${tc(cb.start)}  volume/snelheid/fade  ${naamB(cb)}`);
  const mediaErbij = Object.keys(b.media || {}).filter((k) => !(a.media || {})[k]);
  const mediaEraf = Object.keys(a.media || {}).filter((k) => !(b.media || {})[k]);
  for (const id of mediaErbij) regels.push(`+ media       ${b.media[id].name}`);
  for (const id of mediaEraf) regels.push(`− media       ${a.media[id].name}`);
  if (regels.length === 1) regels.push('(geen verschillen in de montage)');

  return {
    tekst: regels.join('\n'),
    telling: {
      toegevoegd: toegevoegd.length, verwijderd: verwijderd.length,
      verplaatst: verplaatst.length, getrimd: getrimd.length, aangepast: anders.length,
    },
  };
}

// a en b zijn versie-ids; 'nu' betekent de huidige montage.
export function diffVersions(a, b = 'nu') {
  const snapA = a === 'nu' ? projectSnapshot() : readVersion(a).snapshot;
  const snapB = b === 'nu' ? projectSnapshot() : readVersion(b).snapshot;
  return diffSnapshots(snapA, snapB);
}
