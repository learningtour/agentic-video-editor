// Agentic Video Editor — server.
// De browser-UI en een API-client (curl, een agent) praten met dezelfde state;
// state.js is de bron van waarheid en regelt undo/redo.
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import multer from 'multer';
import {
  project, applyCommand, projectDuration, videoClipAt, listProjects, openProject,
  saveProjectAs, newProjectFile, renameProject, activeProjectName, ROOT,
} from './state.js';
import { importFile, onAssetsReady, extractFrame } from './media.js';
import { startRender, renderStatus, onRenderDone } from './render.js';
import { listVersions, commitVersion, restoreVersion, removeVersion, diffVersions } from './versions.js';

const PORT = process.env.PORT || 4720;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/thumbs', express.static(path.join(ROOT, 'media', 'thumbs')));
app.use('/waveforms', express.static(path.join(ROOT, 'media', 'waveforms')));
app.use('/renders', express.static(path.join(ROOT, 'renders')));
// mediabestanden streamen (met range-support via express static op basis van id)
app.get('/mediafile/:id', (req, res) => {
  const m = project.media[req.params.id];
  if (!m || !fs.existsSync(m.path)) return res.status(404).send('media niet gevonden');
  res.sendFile(m.path);
});


// ---------- broadcast ----------
function broadcast(msg, except) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1 && c !== except) c.send(data);
}

const withName = () => ({ ...project, projectName: activeProjectName() });
const broadcastState = () => broadcast({ type: 'state', state: withName() });
onAssetsReady(broadcastState);
onRenderDone((st) => broadcast({ type: 'render', status: st }));
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', state: withName() }));
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      // volatiele updates (playhead/selectie tijdens slepen) — geen undo, wel doorsturen
      if (msg.type === 'playhead') {
        project.playhead = msg.time;
        broadcast(msg, ws);
      } else if (msg.type === 'selection') {
        project.selection = msg.clipIds || [];
        broadcast(msg, ws);
      }
    } catch { /* negeren */ }
  });
});

// ---------- API ----------

app.get('/api/state', (req, res) => {
  res.json({ ...withName(), duration: projectDuration(), render: renderStatus });
});

// Compacte, leesbare samenvatting van de montage (handig voor Claude)
app.get('/api/summary', (req, res) => {
  const lines = [];
  const s = project.settings;
  const meta = project.meta ?? {};
  lines.push(`Project "${activeProjectName()}"${meta.title ? ` — ${meta.title}` : ''}${meta.client ? ` (${meta.client})` : ''}${meta.kind === 'podcast' ? ' [podcast]' : ''}: ${s.width}x${s.height} @ ${s.fps}fps — duur ${projectDuration().toFixed(2)}s — playhead ${project.playhead.toFixed(2)}s${project.workArea ? ` — werkgebied ${project.workArea.start.toFixed(2)}–${project.workArea.end.toFixed(2)}s` : ''}`);
  if (meta.description) lines.push(`Omschrijving: ${meta.description}`);
  const openNotes = (project.notes ?? []).filter((n) => !n.done);
  if (openNotes.length) lines.push(`⚠ ${openNotes.length} open opmerking(en) — zie /api/notes`);
  lines.push(`Media bin (${Object.keys(project.media).length}):`);
  for (const m of Object.values(project.media)) {
    lines.push(`  [${m.id}] ${m.name} — ${m.type}${m.duration ? ` ${m.duration.toFixed(2)}s` : ''}${m.width ? ` ${m.width}x${m.height}` : ''}${m.hasAudio ? ' +audio' : ''}`);
    // gegenereerd? dan staat de brontekst/prompt erbij — zo hoef je een voice-over niet terug te luisteren
    if (m.gen?.text) lines.push(`        ${m.gen.kind === 'voiceover' ? 'gesproken' : 'tekst'}: "${m.gen.text}"`);
    if (m.gen?.prompt) lines.push(`        prompt: "${m.gen.prompt.slice(0, 300)}"`);
  }
  for (const t of project.tracks) {
    const flags = [t.muted && 'MUTED', t.solo && 'SOLO', t.locked && 'LOCKED'].filter(Boolean).join(' ');
    lines.push(`Track ${t.id} (${t.type})${flags ? ` [${flags}]` : ''}, ${t.clips.length} clips:`);
    for (const c of t.clips) {
      const m = project.media[c.mediaId];
      const sel = project.selection.includes(c.id) ? ' *GESELECTEERD*' : '';
      const props = [];
      if (c.speed && c.speed !== 1) props.push(`speed=${c.speed}`);
      if (c.opacity !== undefined) props.push(`opacity=${c.opacity}`);
      if (c.transform) props.push(`transform=${JSON.stringify(c.transform)}`);
      if (c.fadeIn) props.push(`fadeIn=${c.fadeIn}`);
      if (c.fadeOut) props.push(`fadeOut=${c.fadeOut}`);
      const end = c.start + (c.out - c.in) / (c.speed || 1);
      lines.push(`  [${c.id}] ${m?.name ?? '?'} — timeline ${c.start.toFixed(2)}–${end.toFixed(2)}s (bron ${c.in.toFixed(2)}–${c.out.toFixed(2)}s)${c.gain !== 1 ? ` gain=${c.gain}` : ''}${props.length ? ' ' + props.join(' ') : ''}${c.linkId ? ` link=${c.linkId}` : ''}${sel}`);
    }
  }
  res.type('text/plain').send(lines.join('\n'));
});

app.post('/api/command', (req, res) => {
  try {
    const { cmd, args } = req.body;
    const result = applyCommand(cmd, args);
    broadcastState();
    res.json({ ok: true, result, revision: project.revision });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// import via pad (Claude / scripts)
app.post('/api/import', async (req, res) => {
  try {
    const paths = req.body.paths || [req.body.path];
    const media = [];
    for (const p of paths) media.push(await importFile(p));
    project.revision++;
    broadcastState();
    res.json({ ok: true, media });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// import via upload (drag & drop in de browser)
const upload = multer({ dest: path.join(ROOT, 'media', 'uploads') });
app.post('/api/upload', upload.array('files'), async (req, res) => {
  try {
    const media = [];
    for (const f of req.files) {
      // originele naam terugzetten
      const dest = path.join(ROOT, 'media', 'uploads', f.originalname);
      fs.renameSync(f.path, dest);
      media.push(await importFile(dest));
    }
    project.revision++;
    broadcastState();
    res.json({ ok: true, media });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// frame van het programma op tijdstip t — Claude's "ogen" op de montage
app.get('/api/frame', async (req, res) => {
  try {
    const t = parseFloat(req.query.t ?? project.playhead) || 0;
    const found = videoClipAt(t);
    const out = path.join(os.tmpdir(), `cve-frame-${Date.now()}.jpg`);
    if (!found) return res.status(404).json({ ok: false, error: `Geen videoclip op t=${t}` });
    const m = project.media[found.clip.mediaId];
    const seek = m.type === 'image' ? 0 : found.clip.in + (t - found.clip.start) * (found.clip.speed || 1);
    await extractFrame(m.path, seek, out);
    res.sendFile(out, () => fs.unlink(out, () => {}));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Opmerkingen (review) — leesbaar overzicht voor Claude
app.get('/api/notes', (req, res) => {
  const notes = project.notes ?? [];
  const open = notes.filter((n) => !n.done);
  const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  const lines = [`${notes.length} opmerking(en), ${open.length} open:`];
  for (const n of notes) {
    lines.push(`  [${n.id}] ${fmt(n.time)} (${n.time.toFixed(2)}s) ${n.done ? '✓ afgehandeld' : '• open'} — ${n.text}`);
    if (n.antwoord) lines.push(`        ↳ ${n.antwoord}`);
  }
  if (req.query.format === 'json') return res.json({ ok: true, notes });
  res.type('text/plain').send(lines.join('\n'));
});

// ---------- projectbeheer ----------
app.get('/api/projects', (req, res) => {
  res.json({ ok: true, current: activeProjectName(), projects: listProjects().filter((p) => p.name !== 'versions') });
});
app.post('/api/projects/open', (req, res) => {
  try { const r = openProject(req.body?.name); broadcastState(); res.json({ ok: true, ...r }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/projects/saveAs', (req, res) => {
  try { const r = saveProjectAs(req.body?.name); res.json({ ok: true, ...r }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/projects/rename', (req, res) => {
  try { const r = renameProject(req.body?.name); broadcastState(); res.json({ ok: true, ...r }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// eigenschappen + statistieken van het actieve project (voor de dialoog)
app.get('/api/projects/info', (req, res) => {
  let st = null;
  try { st = fs.statSync(path.join(ROOT, 'projects', `${activeProjectName()}.json`)); } catch { /* nieuw */ }
  const clips = project.tracks.flatMap((t) => t.clips);
  const versions = (() => { try { return listVersions().length; } catch { return 0; } })();
  res.json({
    ok: true,
    name: activeProjectName(),
    meta: project.meta ?? {},
    settings: project.settings,
    stats: {
      duur: +projectDuration().toFixed(2),
      clips: clips.length,
      videoClips: project.tracks.filter((t) => t.type === 'video').reduce((n, t) => n + t.clips.length, 0),
      media: Object.keys(project.media).length,
      tracks: project.tracks.length,
      opmerkingenOpen: (project.notes ?? []).filter((n) => !n.done).length,
      versies: versions,
      gewijzigd: st ? st.mtime.toISOString() : null,
    },
  });
});
app.post('/api/projects/new', (req, res) => {
  try { const r = newProjectFile(req.body?.name); broadcastState(); res.json({ ok: true, ...r }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ---------- versies (git voor de montage) ----------
const versieRegel = (v) => `  [${v.id}] ${new Date(v.time).toLocaleString('nl-NL')}${v.auto ? ' (auto)' : ''} — ${v.message}\n` +
  `        duur ${v.stats.duur}s · ${v.stats.clips} clips · ${v.stats.media} media · ${v.stats.openOpmerkingen} open opmerkingen`;

app.get('/api/versions', (req, res) => {
  const versions = listVersions();
  if (req.query.format === 'json') return res.json({ ok: true, current: activeProjectName(), versions });
  res.type('text/plain').send(
    [`${versions.length} versie(s) van "${activeProjectName()}" (nieuwste eerst):`, ...versions.map(versieRegel)].join('\n'),
  );
});

app.post('/api/versions/commit', (req, res) => {
  try { res.json({ ok: true, version: commitVersion({ message: req.body?.message }) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/versions/restore', (req, res) => {
  try {
    const r = restoreVersion(req.body?.id);
    broadcastState();
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/versions/remove', (req, res) => {
  try { res.json({ ok: true, ...removeVersion(req.body?.id) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Vergelijken: a en b zijn versie-ids, 'nu' = de huidige montage (standaard b=nu)
app.get('/api/versions/diff', (req, res) => {
  try {
    const d = diffVersions(req.query.a || 'nu', req.query.b || 'nu');
    if (req.query.format === 'json') return res.json({ ok: true, ...d });
    res.type('text/plain').send(d.tekst);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Analyse: scene-wissels en stiltes (voor slimme montage door Claude)
app.get('/api/analyze/scenes', async (req, res) => {
  try {
    const m = project.media[req.query.mediaId];
    if (!m || !m.path) return res.status(404).json({ ok: false, error: 'Media niet gevonden' });
    const { detectScenes } = await import('./analyze.js');
    const scenes = await detectScenes(m.path, {
      threshold: req.query.threshold ? +req.query.threshold : undefined,
      start: req.query.start, duration: req.query.duration,
    });
    res.json({ ok: true, mediaId: m.id, scenes });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/analyze/silence', async (req, res) => {
  try {
    const m = project.media[req.query.mediaId];
    if (!m || !m.path) return res.status(404).json({ ok: false, error: 'Media niet gevonden' });
    const { detectSilence } = await import('./analyze.js');
    const silences = await detectSilence(m.path, {
      noise: req.query.noise ? +req.query.noise : undefined,
      minDur: req.query.minDur ? +req.query.minDur : undefined,
    });
    res.json({ ok: true, mediaId: m.id, silences });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Premiere Pro-compatibele XML van het project (FCP7 xmeml)
app.get('/api/export.xml', async (req, res) => {
  const { buildPremiereXml } = await import('./xml.js');
  res.type('application/xml')
    .set('Content-Disposition', 'attachment; filename="montage.xml"')
    .send(buildPremiereXml());
});

// Adobe Audition-sessie (.sesx) — voor het fijnslijpen van de audio
app.get('/api/export.sesx', async (req, res) => {
  const { buildSesx } = await import('./sesx.js');
  res.type('application/xml')
    .set('Content-Disposition', `attachment; filename="${activeProjectName()}.sesx"`)
    .send(buildSesx());
});


// ---------- render ----------
app.post('/api/render', (req, res) => {
  try {
    const { name, preset, bitrateM, range, useWorkArea } = req.body || {};
    const effRange = range ?? (useWorkArea && project.workArea ? project.workArea : undefined);
    const { out } = startRender({ name, preset, bitrateM, range: effRange });
    broadcast({ type: 'render', status: renderStatus });
    res.json({ ok: true, out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});
app.get('/api/render/status', (req, res) => res.json(renderStatus));


// ---------- instellingen ----------
// config.json bewaart alleen voorkeuren (taal, laatst geopende project). Geen sleutels of tokens.
const CONFIG_FILE = path.join(ROOT, 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } };
const writeConfig = (patch) => {
  const cfg = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
};

app.get('/api/config', (req, res) => {
  res.json({ uiLanguage: readConfig().uiLanguage || 'nl' });
});
app.post('/api/config', (req, res) => {
  const patch = {};
  if (['nl', 'en', 'de'].includes(req.body.uiLanguage)) patch.uiLanguage = req.body.uiLanguage;
  writeConfig(patch);
  res.json({ ok: true });
});

server.listen(PORT, () => {
  console.log(`Agentic Video Editor draait op http://localhost:${PORT}`);
});
