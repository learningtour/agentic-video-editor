// Analyse-hulpjes voor Claude: scene-wissels en stiltes in bronmateriaal.
// Beide draaien ffmpeg over het bestand en parsen de stderr-uitvoer.
import { spawn } from 'child_process';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('close', () => resolve(err));
    ff.on('error', reject);
  });
}

// Scene-wissels: tijdstippen (s) waar het beeld hard verandert. threshold 0..1 (0.3 = normaal).
export async function detectScenes(filePath, { threshold = 0.3, start, duration } = {}) {
  const args = ['-hide_banner'];
  if (start) args.push('-ss', String(start));
  args.push('-i', filePath);
  if (duration) args.push('-t', String(duration));
  args.push('-vf', `select='gt(scene,${threshold})',showinfo`, '-an', '-f', 'null', '-');
  const err = await runFfmpeg(args);
  const times = [];
  for (const m of err.matchAll(/pts_time:([\d.]+)/g)) {
    const t = parseFloat(m[1]) + (start ? +start : 0);
    if (!times.length || t - times[times.length - 1] > 0.1) times.push(Math.round(t * 100) / 100);
  }
  return times;
}

// Stiltes: [{start, end, dur}] waar het geluid onder noise (dB) blijft voor >= minDur s.
export async function detectSilence(filePath, { noise = -35, minDur = 0.6 } = {}) {
  const err = await runFfmpeg([
    '-hide_banner', '-i', filePath,
    '-af', `silencedetect=noise=${noise}dB:d=${minDur}`, '-vn', '-f', 'null', '-',
  ]);
  const silences = [];
  let cur = null;
  for (const line of err.split('\n')) {
    const s = line.match(/silence_start: ([\d.]+)/);
    const e = line.match(/silence_end: ([\d.]+)/);
    if (s) cur = { start: Math.round(+s[1] * 100) / 100 };
    if (e && cur) {
      cur.end = Math.round(+e[1] * 100) / 100;
      cur.dur = Math.round((cur.end - cur.start) * 100) / 100;
      silences.push(cur);
      cur = null;
    }
  }
  if (cur) silences.push({ ...cur, end: null, dur: null }); // stilte tot einde bestand
  return silences;
}
