// Media-import: ffprobe-metadata, filmstrip-thumbnails en waveform-peaks.
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { project, uid, ROOT, scheduleSave } from './state.js';

const execFileP = promisify(execFile);
const THUMB_DIR = path.join(ROOT, 'media', 'thumbs');
const WAVE_DIR = path.join(ROOT, 'media', 'waveforms');

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mts', '.mxf']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.aiff', '.aif', '.flac', '.ogg']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.tiff']);

export async function importFile(filePath) {
  filePath = path.resolve(filePath);
  if (!fs.existsSync(filePath)) throw new Error(`Bestand niet gevonden: ${filePath}`);
  // al geïmporteerd?
  const existing = Object.values(project.media).find((m) => m.path === filePath);
  if (existing) return existing;

  const ext = path.extname(filePath).toLowerCase();
  let type = VIDEO_EXT.has(ext) ? 'video' : AUDIO_EXT.has(ext) ? 'audio' : IMAGE_EXT.has(ext) ? 'image' : null;
  if (!type) throw new Error(`Onbekend bestandstype: ${ext}`);

  const id = uid();
  const m = { id, name: path.basename(filePath), path: filePath, type };

  if (type === 'image') {
    const { stdout } = await execFileP('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath]);
    const s = JSON.parse(stdout).streams?.[0] || {};
    m.width = s.width; m.height = s.height; m.duration = null; m.hasAudio = false;
  } else {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath,
    ]);
    const info = JSON.parse(stdout);
    const v = info.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    const a = info.streams.find((s) => s.codec_type === 'audio');
    m.duration = parseFloat(info.format.duration) || 0;
    m.hasAudio = !!a;
    if (v && type === 'video') {
      m.width = v.width; m.height = v.height;
      const [n, d] = (v.avg_frame_rate || '30/1').split('/').map(Number);
      m.fps = d ? +(n / d).toFixed(3) : 30;
    }
    if (type === 'video' && !v) { type = 'audio'; m.type = 'audio'; }
  }

  project.media[id] = m;
  scheduleSave();

  // thumbnails/waveform async genereren; state wordt bijgewerkt zodra klaar
  generateAssets(m).catch((e) => console.error('asset-generatie mislukt:', m.name, e.message));
  return m;
}

async function generateAssets(m) {
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  fs.mkdirSync(WAVE_DIR, { recursive: true });

  if (m.type === 'video' || m.type === 'image') {
    const strip = path.join(THUMB_DIR, `${m.id}.jpg`);
    if (m.type === 'image') {
      await execFileP('ffmpeg', ['-y', '-i', m.path, '-vf', 'scale=-2:90', '-frames:v', '1', strip]);
      m.filmstripFrames = 1;
    } else {
      // filmstrip: max 16 frames naast elkaar in één jpg
      const frames = Math.max(2, Math.min(16, Math.ceil(m.duration / 2)));
      const fps = frames / Math.max(m.duration, 0.1);
      await execFileP('ffmpeg', ['-y', '-i', m.path,
        '-vf', `fps=${fps},scale=-2:90,tile=${frames}x1`, '-frames:v', '1', '-q:v', '5', strip]);
      m.filmstripFrames = frames;
    }
    m.filmstrip = `/thumbs/${m.id}.jpg`;
    m.thumb = m.filmstrip;
  }

  if (m.hasAudio || m.type === 'audio') {
    m.waveform = await generateWaveform(m);
  }
  project.revision++;
  scheduleSave();
  notifyChange();
}

function generateWaveform(m) {
  // 50 peaks per seconde uit mono 8kHz s16le PCM
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'quiet', '-i', m.path, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', reject);
    ff.on('close', () => {
      const buf = Buffer.concat(chunks);
      const samplesPerPeak = 160; // 8000/50
      const n = Math.floor(buf.length / 2 / samplesPerPeak);
      const peaks = new Array(n);
      for (let i = 0; i < n; i++) {
        let max = 0;
        for (let j = 0; j < samplesPerPeak; j++) {
          const v = Math.abs(buf.readInt16LE((i * samplesPerPeak + j) * 2));
          if (v > max) max = v;
        }
        peaks[i] = Math.round((max / 32768) * 100);
      }
      const file = path.join(WAVE_DIR, `${m.id}.json`);
      fs.writeFileSync(file, JSON.stringify({ pps: 50, peaks }));
      resolve(`/waveforms/${m.id}.json`);
    });
  });
}

// Wordt door index.js gezet zodat asset-updates naar de UI gepusht worden
let notifyChange = () => {};
export function onAssetsReady(fn) { notifyChange = fn; }

// Herkomst van gegenereerde media vastleggen op het media-item zelf: de tekst die is
// ingesproken, de prompt waarmee een beeld/video is gemaakt, welke stem/welk model.
// Zonder dit is achteraf niet meer te zien wát een voice-over zegt (dan moet je hem
// terugluisteren of transcriberen) en is een prompt niet te hergebruiken.
//   m.gen = { kind, text?, prompt?, voice?, model?, engine?, params?, at }
export function tagGenerated(media, info = {}) {
  if (!media || !info.kind) return media;
  const gen = { kind: info.kind, at: Date.now() };
  for (const k of ['text', 'prompt', 'voice', 'voiceId', 'model', 'engine', 'source', 'run', 'params', 'language']) {
    if (info[k] !== undefined && info[k] !== null && info[k] !== '') gen[k] = info[k];
  }
  media.gen = { ...(media.gen || {}), ...gen };
  // de eerste zin als leesbaar label, zodat de bin en de tijdlijn iets zinnigs tonen
  if (!media.label && info.label) media.label = info.label;
  scheduleSave();
  return media;
}

// Frame-extractie: JPEG van het programma op tijdstip t (voor Claude's "ogen")
export async function extractFrame(mediaPath, seekTime, outPath, width = 960) {
  // let op: '-ss' vóór een stilstaand beeld levert bij ffmpeg een léég bestand op (met exit 0);
  // bij seek 0 (afbeeldingen, begin van een video) dus geen -ss meegeven
  const seek = seekTime > 0 ? ['-ss', String(seekTime)] : [];
  await execFileP('ffmpeg', ['-y', ...seek, '-i', mediaPath,
    '-vf', `scale=${width}:-2`, '-frames:v', '1', '-q:v', '4', outPath]);
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) throw new Error(`Geen frame uit ${path.basename(mediaPath)} op ${seekTime}s`);
  return outPath;
}
