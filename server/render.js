// Export-pipeline: bouwt één ffmpeg filter_complex uit de timeline en encodeert
// met h264_videotoolbox (Apple Silicon hardware-encoder).
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { project, projectDuration, clipEnd, clipLen, trackAudible, trackById, cutPairAt, ROOT } from './state.js';

export const renderStatus = { running: false, progress: 0, out: null, error: null, log: '' };

// Overgangsvenster op een cut, geklemd op beschikbare bron-handles van A (post-roll) en B (pre-roll)
export function transWindow(tr) {
  const track = trackById(tr.trackId);
  if (!track) return null;
  const pair = cutPairAt(track, tr.time);
  if (!pair) return null; // cut bestaat niet meer
  const { A: a, B: b } = pair;
  const mA = project.media[a.mediaId], mB = project.media[b.mediaId];
  const spA = a.speed || 1, spB = b.speed || 1;
  const still = (m) => m?.type === 'image' || m?.type === 'title';
  const post = still(mA) ? Infinity : ((mA?.duration ?? 0) - a.out) / spA; // A kan zoveel s doorlopen
  const pre = still(mB) ? Infinity : b.in / spB;                            // B kan zoveel s eerder starten
  const half = tr.dur / 2;
  const w0 = tr.time - Math.min(half, pre);
  const w1 = tr.time + Math.min(half, post);
  if (w1 - w0 < 0.05) return null;
  return { ...tr, w0, w1, A: a, B: b };
}

function videoTransitions() {
  return (project.transitions ?? [])
    .filter((tr) => trackById(tr.trackId)?.type === 'video' && trackAudible(trackById(tr.trackId)))
    .map(transWindow)
    .filter(Boolean);
}

// Segmenten: stukken waar de zichtbare videoclip + actieve titels constant zijn.
// Titels tellen niet als "basis" maar worden er als drawtext overheen gelegd.
function videoSegments() {
  const trans = videoTransitions();
  const points = new Set([0]);
  for (const t of project.tracks) {
    if (t.type !== 'video' || !trackAudible(t)) continue;
    for (const c of t.clips) { points.add(c.start); points.add(clipEnd(c)); }
  }
  for (const tr of trans) { points.add(tr.w0); points.add(tr.w1); }
  const dur = projectDuration();
  points.add(dur);
  // punten bínnen een overgangsvenster weghalen: het venster is één atomair segment
  const sorted = [...points]
    .filter((p) => p <= dur + 1e-6)
    .filter((p) => !trans.some((tr) => p > tr.w0 + 1e-6 && p < tr.w1 - 1e-6))
    .sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const t0 = sorted[i], t1 = sorted[i + 1];
    if (t1 - t0 < 0.001) continue;
    const tw = trans.find((tr) => Math.abs(tr.w0 - t0) < 1e-6 && Math.abs(tr.w1 - t1) < 1e-6);
    if (tw) { segs.push({ t0, t1, trans: tw, layers: [], titles: [] }); continue; }
    const layers = []; // wordt onder->boven
    const titles = [];
    for (const t of project.tracks) {
      if (t.type !== 'video' || !trackAudible(t)) continue;
      const c = t.clips.find((c) => t0 >= c.start - 1e-6 && t0 < clipEnd(c) - 1e-6);
      if (!c) continue;
      const m = project.media[c.mediaId];
      if (m?.type === 'title') titles.push(c);
      else layers.push(c);
    }
    layers.reverse(); // tracks staan boven-eerst opgeslagen
    segs.push({ t0, t1, layers, titles });
  }
  return segs;
}

// drawtext-filter voor een titelclip binnen een segment (met alpha-fades)
function titleFilter(c, t0, W, H, textFiles) {
  const m = project.media[c.mediaId];
  const size = Math.round((m.size ?? 64) * (H / 1080));
  const yExpr = m.pos === 'boven' ? 'h*0.10' : m.pos === 'midden' ? '(h-text_h)/2' : 'h-text_h-h*0.12';
  const box = m.bg !== false ? `:box=1:boxcolor=black@0.45:boxborderw=${Math.round(size / 3.5)}` : '';
  const off = t0 - c.start;              // segment-lokale t → clip-lokale t + off
  const len = c.out - c.in;
  const fi = c.fadeIn ?? 0, fo = c.fadeOut ?? 0;
  let alpha = '';
  if (fi > 0 || fo > 0) {
    const tt = `(t+${off.toFixed(4)})`;
    const inE = fi > 0 ? `if(lt(${tt},${fi}),${tt}/${fi},` : '';
    const outE = fo > 0 ? `if(gt(${tt},${(len - fo).toFixed(4)}),max(0,(${len.toFixed(4)}-${tt})/${fo}),1)` : '1';
    alpha = `:alpha='${inE}${outE}${fi > 0 ? ')' : ''}'`;
  }
  return `drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:textfile='${textFiles.get(m.id)}'` +
    `:fontsize=${size}:fontcolor=${m.color || 'white'}:x=(w-text_w)/2:y=${yExpr}${box}${alpha}`;
}

// Export-presets: encoderinstellingen + extensie
const PRESETS = {
  mp4:    { ext: '.mp4', video: (b) => ['-c:v', 'h264_videotoolbox', '-b:v', `${b || 14}M`, '-allow_sw', '1'], audio: ['-c:a', 'aac', '-b:a', '192k'], faststart: true },
  mp4_hq: { ext: '.mp4', video: (b) => ['-c:v', 'h264_videotoolbox', '-b:v', `${b || 40}M`, '-allow_sw', '1'], audio: ['-c:a', 'aac', '-b:a', '320k'], faststart: true },
  prores: { ext: '.mov', video: () => ['-c:v', 'prores_videotoolbox', '-profile:v', '2'], audio: ['-c:a', 'pcm_s16le'] },
  wav:    { ext: '.wav', audioOnly: true, audio: ['-c:a', 'pcm_s16le'] },
  mp3:    { ext: '.mp3', audioOnly: true, audio: ['-c:a', 'libmp3lame', '-b:a', '256k'] },
  // Podcast-master: naar -16 LUFS (podcaststandaard) met true-peak-limiter.
  // Twee passes: eerst meten, dan exact normaliseren — dat klinkt strakker dan
  // loudnorm in één keer, die alleen schat.
  podcast:     { ext: '.wav', audioOnly: true, audio: ['-c:a', 'pcm_s24le'], loudnorm: { I: -16, TP: -1.5, LRA: 11 } },
  podcast_mp3: { ext: '.mp3', audioOnly: true, audio: ['-c:a', 'libmp3lame', '-b:a', '256k'], loudnorm: { I: -16, TP: -1.5, LRA: 11 } },
};

// Tweetraps loudness-normalisatie op een gemixte WAV.
function loudnorm2Pass(src, dst, sr, target, audioArgs, onProgress) {
  return new Promise((resolve, reject) => {
    const af = (extra) => `loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}${extra}`;
    const measure = spawn('ffmpeg', ['-hide_banner', '-i', src, '-af', `${af('')}:print_format=json`, '-f', 'null', '-']);
    let out = '';
    measure.stderr.on('data', (d) => { out += d; });
    measure.on('error', reject);
    measure.on('close', (code) => {
      if (code !== 0) return reject(new Error('loudnorm-meting faalde:\n' + out.slice(-1500)));
      let m;
      try { m = JSON.parse(out.slice(out.lastIndexOf('{'), out.lastIndexOf('}') + 1)); }
      catch (e) { return reject(new Error('loudnorm-meting onleesbaar: ' + e.message)); }
      onProgress?.(0.9);
      const filter = af(`:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
        `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`) +
        ',alimiter=limit=-1.0dB:level=false';
      const pass2 = spawn('ffmpeg', ['-y', '-i', src, '-af', filter, '-ar', String(sr), ...audioArgs, dst]);
      let err2 = '';
      pass2.stderr.on('data', (d) => { err2 += d; });
      pass2.on('error', reject);
      pass2.on('close', (c2) => {
        if (c2 !== 0) return reject(new Error('loudnorm-normalisatie faalde:\n' + err2.slice(-1500)));
        resolve({ measured: m });
      });
    });
  });
}

export function startRender(opts = {}) {
  if (typeof opts === 'string') opts = { name: opts }; // backwards compat
  const { name: outName, preset: presetName = 'mp4', bitrateM, range } = opts;
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`Onbekende preset: ${presetName} (${Object.keys(PRESETS).join(', ')})`);
  if (renderStatus.running) throw new Error('Er loopt al een render');
  const dur = projectDuration();
  if (dur <= 0) throw new Error('Timeline is leeg');

  // bereik (werkgebied): alleen [A, B] renderen
  const A = Math.max(0, range?.start ?? 0);
  const B = Math.min(dur, range?.end ?? dur);
  if (B - A < 0.05) throw new Error('Renderbereik is (vrijwel) leeg');
  const effDur = B - A;

  const { width: W, height: H, fps: FPS, sampleRate: SR } = project.settings;
  fs.mkdirSync(path.join(ROOT, 'renders'), { recursive: true });
  let base = (outName || `export-${Date.now()}`).replace(/\.(mp4|mov|wav|mp3|m4a)$/i, '');
  const out = path.join(ROOT, 'renders', base + preset.ext);

  const eps = 1e-4;
  const segs = videoSegments()
    .filter((s) => s.t1 > A + eps && s.t0 < B - eps)
    .map((s) => ({ ...s, t0: Math.max(s.t0, A), t1: Math.min(s.t1, B) }));
  const audioClips = [];
  for (const t of project.tracks) {
    if (t.type !== 'audio' || !trackAudible(t)) continue;
    for (const c of t.clips) {
      if (clipEnd(c) > A + eps && c.start < B - eps) audioClips.push(c);
    }
  }
  if (preset.audioOnly && !audioClips.length) throw new Error('Geen audio in het renderbereik');

  // inputs verzamelen (elk mediabestand één keer)
  const inputs = [];
  const inputIdx = new Map();
  const getInput = (mediaId) => {
    if (!inputIdx.has(mediaId)) {
      inputIdx.set(mediaId, inputs.length);
      inputs.push(project.media[mediaId]);
    }
    return inputIdx.get(mediaId);
  };

  // titelteksten naar tijdelijke bestanden (geen escaping-gedoe in filtergraph)
  const textFiles = new Map();
  const tmpDir = path.join(os.tmpdir(), 'cve-titles');
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const s of segs) {
    for (const c of s.titles ?? []) {
      const m = project.media[c.mediaId];
      if (!textFiles.has(m.id)) {
        const f = path.join(tmpDir, `${m.id}.txt`);
        fs.writeFileSync(f, m.text);
        textFiles.set(m.id, f);
      }
    }
  }

  const fc = [];
  const buildVideo = !preset.audioOnly;
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p`;

  // fades naar segment-lokale tijd; alpha=true voor overlay-lagen (fade van/naar transparant)
  const fadeFilters = (c, t0, segLen, alpha) => {
    const suffix = alpha ? ':alpha=1' : '';
    let f = '';
    if (c.fadeIn > 0) {
      const st = c.start - t0;
      if (st + c.fadeIn > 0) f += `,fade=t=in:st=${Math.max(0, st).toFixed(4)}:d=${(c.fadeIn + Math.min(0, st)).toFixed(4)}${suffix}`;
    }
    if (c.fadeOut > 0) {
      const st = (c.start + clipLen(c) - c.fadeOut) - t0;
      if (st < segLen) f += `,fade=t=out:st=${Math.max(0, st).toFixed(4)}:d=${c.fadeOut.toFixed(4)}${suffix}`;
    }
    return f;
  };

  // video-segmenten
  const vLabels = [];
  const even = (n) => 2 * Math.round(n / 2);
  if (buildVideo) segs.forEach((s, i) => {
    const label = `vs${i}`;
    const len = s.t1 - s.t0;
    const titleF = (s.titles ?? []).slice().reverse().map((c) => ',' + titleFilter(c, s.t0, W, H, textFiles)).join('');
    const layers = s.layers ?? [];
    const simple = layers.length === 1 && !layers[0].opacity && !layers[0].transform;

    if (s.trans) {
      // overgang: A- en B-stream over het hele venster + xfade
      const { A: a, B: b, type } = s.trans;
      const mA = project.media[a.mediaId], mB = project.media[b.mediaId];
      const spA = a.speed || 1, spB = b.speed || 1;
      const mkStream = (c, m, sp, lbl) => {
        const idx = getInput(c.mediaId);
        if (m.type === 'image' || m.type === 'title') {
          fc.push(`[${idx}:v]loop=loop=-1:size=1,trim=duration=${len.toFixed(4)},${fit}[${lbl}]`);
        } else {
          const srcIn = Math.max(0, c.in + (s.t0 - c.start) * sp);
          fc.push(`[${idx}:v]trim=start=${srcIn.toFixed(4)}:end=${(srcIn + len * sp).toFixed(4)},setpts=(PTS-STARTPTS)/${sp.toFixed(4)},${fit}[${lbl}]`);
        }
      };
      mkStream(a, mA, spA, `ta${i}`);
      mkStream(b, mB, spB, `tb${i}`);
      const xtype = type === 'wipe' ? 'wipeleft' : type === 'dip' ? 'fadeblack' : 'fade';
      fc.push(`[ta${i}][tb${i}]xfade=transition=${xtype}:duration=${len.toFixed(4)}:offset=0${titleF}[${label}]`);
    } else if (!layers.length) {
      fc.push(`color=black:s=${W}x${H}:r=${FPS}:d=${len.toFixed(4)},format=yuv420p${titleF}[${label}]`);
    } else if (simple) {
      const c = layers[0];
      const m = project.media[c.mediaId];
      const idx = getInput(c.mediaId);
      const sp = c.speed || 1;
      const fadeF = fadeFilters(c, s.t0, len, false);
      if (m.type === 'image') {
        fc.push(`[${idx}:v]loop=loop=-1:size=1,trim=duration=${len.toFixed(4)},${fit}${fadeF}${titleF}[${label}]`);
      } else {
        const srcIn = c.in + (s.t0 - c.start) * sp;
        fc.push(`[${idx}:v]trim=start=${srcIn.toFixed(4)}:end=${(srcIn + len * sp).toFixed(4)},setpts=(PTS-STARTPTS)/${sp.toFixed(4)},${fit}${fadeF}${titleF}[${label}]`);
      }
    } else {
      // composite: zwart doek + elke laag (met speed/schaal/positie/opacity/alpha-fades) eroverheen
      fc.push(`color=black:s=${W}x${H}:r=${FPS}:d=${len.toFixed(4)},format=yuv420p[cb${i}]`);
      let acc = `cb${i}`;
      layers.forEach((c, li) => {
        const m = project.media[c.mediaId];
        const idx = getInput(c.mediaId);
        const sp = c.speed || 1;
        const tr = c.transform || {};
        const sc = tr.scale ?? 1;
        const bw = even(W * sc), bh = even(H * sc);
        const lyl = `ly${i}_${li}`;
        const op = c.opacity ?? 1;
        const opF = op < 1 ? `,colorchannelmixer=aa=${op.toFixed(3)}` : '';
        const fadeF = fadeFilters(c, s.t0, len, true);
        const common = `fps=${FPS},scale=${bw}:${bh}:force_original_aspect_ratio=decrease,setsar=1,format=yuva420p${opF}${fadeF}`;
        if (m.type === 'image') {
          fc.push(`[${idx}:v]loop=loop=-1:size=1,trim=duration=${len.toFixed(4)},${common}[${lyl}]`);
        } else {
          const srcIn = c.in + (s.t0 - c.start) * sp;
          fc.push(`[${idx}:v]trim=start=${srcIn.toFixed(4)}:end=${(srcIn + len * sp).toFixed(4)},setpts=(PTS-STARTPTS)/${sp.toFixed(4)},${common}[${lyl}]`);
        }
        const tx = Math.round((tr.x ?? 0) * W), ty = Math.round((tr.y ?? 0) * H);
        const next = li === layers.length - 1 ? `cp${i}` : `ov${i}_${li}`;
        fc.push(`[${acc}][${lyl}]overlay=x=(main_w-overlay_w)/2+${tx}:y=(main_h-overlay_h)/2+${ty}:shortest=1[${next}]`);
        acc = next;
      });
      fc.push(`[${acc}]format=yuv420p${titleF}[${label}]`);
    }
    vLabels.push(`[${label}]`);
  });
  if (buildVideo) fc.push(`${vLabels.join('')}concat=n=${segs.length}:v=1:a=0[vout]`);

  // audio-mix
  let aOut = null;
  if (audioClips.length) {
    const aLabels = [];
    // stuksgewijs-lineaire volume-expressie uit gain-keyframes (t = clip-lokale uitvoertijd)
    const gainExpr = (keys, off) => {
      const tt = `(t+${off.toFixed(4)})`;
      let expr = keys[keys.length - 1].gain.toFixed(3);
      for (let i = keys.length - 1; i > 0; i--) {
        const a = keys[i - 1], b = keys[i];
        const dt = Math.max(0.001, b.t - a.t);
        const seg = `${a.gain.toFixed(3)}+${(b.gain - a.gain).toFixed(3)}*(${tt}-${a.t.toFixed(3)})/${dt.toFixed(3)}`;
        expr = `if(lt(${tt}\\,${b.t.toFixed(3)})\\,${seg}\\,${expr})`;
      }
      return `if(lt(${tt}\\,${keys[0].t.toFixed(3)})\\,${keys[0].gain.toFixed(3)}\\,${expr})`;
    };
    // audio-overgangen: A loopt door met fade-out, B start eerder met fade-in
    const audioTransMods = new Map();
    for (const tr of (project.transitions ?? [])) {
      const track = trackById(tr.trackId);
      if (!track || track.type !== 'audio' || !trackAudible(track)) continue;
      const w = transWindow(tr);
      if (!w) continue;
      audioTransMods.set(w.A.id, { ...(audioTransMods.get(w.A.id) || {}), extendTo: w.w1, xfOutDur: w.w1 - w.w0 });
      audioTransMods.set(w.B.id, { ...(audioTransMods.get(w.B.id) || {}), startFrom: w.w0, xfInDur: w.w1 - w.w0 });
    }
    const atempoChain = (sp) => {
      if (!sp || sp === 1) return '';
      const stages = [];
      let r = sp;
      while (r > 2) { stages.push(2); r /= 2; }
      while (r < 0.5) { stages.push(0.5); r /= 0.5; }
      stages.push(r);
      return stages.map((v) => `,atempo=${v.toFixed(4)}`).join('');
    };
    audioClips.forEach((c, i) => {
      const idx = getInput(c.mediaId);
      const sp = c.speed || 1;
      const cLen = clipLen(c);
      const mod = audioTransMods.get(c.id);
      // clip op het bereik [A,B] clippen (incl. overgangs-verlenging/vervroeging)
      const tStart = Math.max(mod?.startFrom ?? c.start, A);
      const tEnd = Math.min(mod?.extendTo ?? clipEnd(c), B);
      const srcIn = c.in + (tStart - c.start) * sp;
      const srcOut = c.in + (tEnd - c.start) * sp;
      const delayMs = Math.round((tStart - A) * 1000);
      let fadeF = '';
      if (c.fadeIn > 0 && tStart === c.start) fadeF += `,afade=t=in:st=0:d=${c.fadeIn.toFixed(4)}`;
      if (c.fadeOut > 0 && tEnd >= clipEnd(c) - eps && !mod?.xfOutDur) {
        fadeF += `,afade=t=out:st=${((tEnd - tStart) - c.fadeOut).toFixed(4)}:d=${c.fadeOut.toFixed(4)}`;
      }
      // crossfade-rampen van een overgang
      if (mod?.xfInDur) fadeF += `,afade=t=in:st=0:d=${mod.xfInDur.toFixed(4)}`;
      if (mod?.xfOutDur) fadeF += `,afade=t=out:st=${((tEnd - tStart) - mod.xfOutDur).toFixed(4)}:d=${mod.xfOutDur.toFixed(4)}`;
      // envelope: keyframe-tijden zijn clip-lokaal; bij werkgebied-clipping verschuiven met offset
      const envF = c.gainKeys?.length
        ? `,volume=volume='${gainExpr(c.gainKeys, tStart - c.start)}':eval=frame`
        : '';
      fc.push(
        `[${idx}:a]atrim=start=${srcIn.toFixed(4)}:end=${srcOut.toFixed(4)},asetpts=PTS-STARTPTS,` +
        `aresample=${SR}${atempoChain(c.speed)},volume=${(c.gain ?? 1).toFixed(3)}${envF}${fadeF},adelay=${delayMs}|${delayMs}[as${i}]`
      );
      aLabels.push(`[as${i}]`);
    });
    fc.push(`anullsrc=r=${SR}:cl=stereo,atrim=duration=${effDur.toFixed(4)}[abase]`);
    fc.push(`[abase]${aLabels.join('')}amix=inputs=${audioClips.length + 1}:normalize=0:duration=first[aout]`);
    aOut = '[aout]';
  }

  // Bij loudness-normalisatie mixen we eerst naar een 24-bits premix; die wordt
  // daarna gemeten en exact op niveau gezet.
  const premix = preset.loudnorm ? out.replace(/\.[^.]+$/, '.premix.wav') : null;
  const target = premix || out;

  const args = ['-y'];
  for (const m of inputs) args.push('-i', m.path);
  args.push('-filter_complex', fc.join(';'));
  if (!preset.audioOnly) {
    args.push('-map', '[vout]');
    args.push(...preset.video(bitrateM));
  }
  if (aOut) args.push('-map', aOut, ...(premix ? ['-c:a', 'pcm_s24le'] : preset.audio));
  if (preset.faststart) args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:1', '-nostats', target);

  Object.assign(renderStatus, { running: true, progress: 0, out, error: null, log: '' });
  const ff = spawn('ffmpeg', args);
  let stderr = '';
  ff.stderr.on('data', (d) => { stderr += d; if (stderr.length > 40000) stderr = stderr.slice(-20000); });
  const mixShare = premix ? 0.8 : 1; // laatste 20% is de loudness-pass
  ff.stdout.on('data', (d) => {
    const mMatch = String(d).match(/out_time_ms=(\d+)/);
    if (mMatch) renderStatus.progress = Math.min(mixShare, ((+mMatch[1] / 1e6) / effDur) * mixShare);
  });
  ff.on('close', (code) => {
    renderStatus.log = stderr.slice(-3000);
    if (code !== 0) {
      renderStatus.running = false;
      renderStatus.error = 'ffmpeg faalde:\n' + stderr.slice(-3000);
      return notifyDone(renderStatus);
    }
    if (!premix) {
      renderStatus.running = false;
      renderStatus.progress = 1;
      return notifyDone(renderStatus);
    }
    renderStatus.progress = mixShare;
    loudnorm2Pass(premix, out, SR, preset.loudnorm, preset.audio, (p) => { renderStatus.progress = p; })
      .then(({ measured }) => {
        renderStatus.loudness = { doel: preset.loudnorm.I, gemeten: +parseFloat(measured.input_i).toFixed(1) };
        renderStatus.progress = 1;
      })
      .catch((e) => { renderStatus.error = e.message; })
      .finally(() => {
        fs.rmSync(premix, { force: true });
        renderStatus.running = false;
        notifyDone(renderStatus);
      });
  });
  return { out };
}

let notifyDone = () => {};
export function onRenderDone(fn) { notifyDone = fn; }
