// Programma-player: speelt de timeline realtime af.
// Per clip een <video>/<audio>-element; bovenste videotrack is zichtbaar,
// audio wordt gemixt via WebAudio met per-clip gain.
import { S, on, setPlayhead, emit, projectDur } from './app.js';

const clipLen = (c) => (c.out - c.in) / (c.speed || 1);
const clipEnd = (c) => c.start + clipLen(c);

// volume-envelope (gain-keyframes, clip-lokale tijd) — lineair geïnterpoleerd
function envFactor(c, t) {
  const keys = c.gainKeys;
  if (!keys?.length) return 1;
  const local = t - c.start;
  if (local <= keys[0].t) return keys[0].gain;
  for (let i = 1; i < keys.length; i++) {
    if (local < keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      return a.gain + (b.gain - a.gain) * ((local - a.t) / Math.max(0.001, b.t - a.t));
    }
  }
  return keys[keys.length - 1].gain;
}

// overgangen met venster geklemd op bron-handles (zelfde logica als de server)
function transWindows() {
  const out = [];
  for (const tr of S.state?.transitions ?? []) {
    const track = S.state.tracks.find((x) => x.id === tr.trackId);
    if (!track) continue;
    let A = null, B = null;
    for (const c of track.clips) {
      if (Math.abs(clipEnd(c) - tr.time) < 0.06) A = c;
      if (Math.abs(c.start - tr.time) < 0.06) B = c;
    }
    if (!A || !B || A.id === B.id) continue;
    const mA = S.state.media[A.mediaId], mB = S.state.media[B.mediaId];
    const still = (m) => m?.type === 'image' || m?.type === 'title';
    const post = still(mA) ? Infinity : ((mA?.duration ?? 0) - A.out) / (A.speed || 1);
    const pre = still(mB) ? Infinity : B.in / (B.speed || 1);
    const half = tr.dur / 2;
    const w0 = tr.time - Math.min(half, pre), w1 = tr.time + Math.min(half, post);
    if (w1 - w0 < 0.05) continue;
    out.push({ ...tr, w0, w1, A, B, trackType: track.type });
  }
  return out;
}

// fade-factor 0..1 op timeline-tijd t voor een clip met fadeIn/fadeOut
function fadeFactor(c, t) {
  let f = 1;
  const local = t - c.start;
  const len = clipLen(c);
  if (c.fadeIn > 0 && local < c.fadeIn) f *= Math.max(0, local / c.fadeIn);
  if (c.fadeOut > 0 && local > len - c.fadeOut) f *= Math.max(0, (len - local) / c.fadeOut);
  return f;
}

export class Player {
  constructor(container) {
    this.container = container;
    this.els = new Map();      // clipId -> {el, media, gainNode, kind}
    this.playing = false;
    this.audioCtx = null;
    this._raf = null;
    on('state', () => this.syncElements());
    on('playhead', () => {
      if (!this.playing) this.showFrame(S.playhead);
      // venster bijwerken zodra de playhead een eind verplaatst is
      if (Math.abs(S.playhead - (this._lastSyncT ?? -1e9)) > 8) {
        this._lastSyncT = S.playhead;
        clearTimeout(this._syncTimer);
        this._syncTimer = setTimeout(() => this.syncElements(), 120);
      }
    });
    new ResizeObserver(() => {
      for (const [, e] of this.els) if (e.kind === 'title') this.styleTitle(e);
    }).observe(container);
    document.getElementById('prog-play').onclick = () => (this.playing ? this.pause() : this.play());
    document.getElementById('prog-tostart').onclick = () => { this.pause(); setPlayhead(0); };
    this.initScrubber();
  }

  ctx() {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext();
      this.masterIn = this.audioCtx.createGain();
      // Meting per kanaal: een aftakking naar een channel-splitter met een analyser op L en R.
      // De weg naar de speakers loopt er los langs, zodat de meter nooit in het signaalpad zit.
      const splitter = this.audioCtx.createChannelSplitter(2);
      this.analyserL = this.audioCtx.createAnalyser();
      this.analyserR = this.audioCtx.createAnalyser();
      for (const a of [this.analyserL, this.analyserR]) a.fftSize = 2048;
      this.masterIn.connect(splitter);
      splitter.connect(this.analyserL, 0);
      splitter.connect(this.analyserR, 1);
      this.masterIn.connect(this.audioCtx.destination);
      this.startVU();
    }
    return this.audioCtx;
  }

  // Stereo piekmeter: per kanaal RMS (vloeiend) en peak-hold, getekend op #vu-meter.
  // Skala −48 dB tot 0; boven −0,2 dB wordt de peak-streep rood (clipping).
  startVU() {
    const canvas = document.getElementById('vu-meter');
    if (!canvas || this._vuRunning || !this.analyserL) return;
    this._vuRunning = true;
    const ctx2d = canvas.getContext('2d');
    const bufL = new Float32Array(this.analyserL.fftSize);
    const bufR = new Float32Array(this.analyserR.fftSize);
    const kanaal = [
      { analyser: this.analyserL, buf: bufL, smooth: 0, peakHold: 0, peakAge: 0, label: 'L' },
      { analyser: this.analyserR, buf: bufR, smooth: 0, peakHold: 0, peakAge: 0, label: 'R' },
    ];
    const db = (v) => Math.max(0, 1 + (20 * Math.log10(Math.max(v, 1e-4))) / 48); // −48..0 dB → 0..1
    // interval i.p.v. rAF: blijft ook lopen zonder venster-focus
    const draw = () => {
      if (!this.analyserL) return;
      const H = canvas.height, W = canvas.width;
      const gap = Math.max(2, Math.round(W * 0.12));
      const bw = Math.floor((W - gap) / 2);
      ctx2d.clearRect(0, 0, W, H);
      for (let i = 0; i < kanaal.length; i++) {
        const k = kanaal[i];
        k.analyser.getFloatTimeDomainData(k.buf);
        let sum = 0, peak = 0;
        for (let j = 0; j < k.buf.length; j++) { const v = Math.abs(k.buf[j]); sum += v * v; if (v > peak) peak = v; }
        const rms = Math.sqrt(sum / k.buf.length);
        k.rms = rms;
        k.smooth = Math.max(rms, k.smooth * 0.9);
        if (peak >= k.peakHold) { k.peakHold = peak; k.peakAge = 0; } else if (++k.peakAge > 60) k.peakHold *= 0.95;
        const x = i * (bw + gap);
        const h = db(k.smooth) * H;
        const grad = ctx2d.createLinearGradient(0, H, 0, 0);
        grad.addColorStop(0, '#2dd07f'); grad.addColorStop(0.72, '#e8d44d'); grad.addColorStop(0.9, '#e05555');
        ctx2d.fillStyle = grad;
        ctx2d.fillRect(x, H - h, bw, h);
        const ph = db(k.peakHold) * H;
        ctx2d.fillStyle = k.peakHold > 0.977 ? '#ff3333' : '#dfe6ff';   // > −0,2 dBFS = clip
        ctx2d.fillRect(x, H - ph - 1, bw, 2);
      }
      const [l, r] = kanaal;
      // vuLevel houdt de gecombineerde waarden (de 3D-ruimte gebruikt die) plus per kanaal
      this.vuLevel = {
        rms: Math.max(l.smooth, r.smooth), peak: Math.max(l.peakHold, r.peakHold),
        l: { rms: l.smooth, peak: l.peakHold }, r: { rms: r.smooth, peak: r.peakHold },
      };
    };
    setInterval(draw, 50);
  }

  // Elementen aanmaken/opruimen. Alleen clips in een venster rond de playhead krijgen
  // een media-element: browsers staan maar een beperkt aantal tegelijk toe, en bij lange
  // montages (honderden clips) laden ze anders niet of te laat.
  syncElements() {
    if (!S.state) return;
    const NEAR = 25, KEEP = 70;                   // seconden vóór/na de playhead
    const t0 = S.playhead;
    const liveIds = new Set();
    for (const t of S.state.tracks) {
      for (const c of t.clips) {
        const cs = c.start, ce = c.start + (c.out - c.in) / (c.speed || 1);
        if (ce < t0 - KEEP || cs > t0 + KEEP) continue;      // ver weg: opruimen
        liveIds.add(c.id);
        if (ce < t0 - NEAR || cs > t0 + NEAR) continue;      // in de marge: niet nieuw aanmaken
        const m = S.state.media[c.mediaId];
        if (!m) continue;
        let entry = this.els.get(c.id);
        if (entry && entry.media.id !== m.id) { entry.el.remove(); this.els.delete(c.id); entry = null; }
        if (!entry) {
          let el, kind;
          if (m.type === 'title') {
            el = document.createElement('div');
            el.className = 'pv-el pv-title';
            el.innerHTML = '<span></span>';
            kind = 'title';
          } else if (m.type === 'image') {
            el = document.createElement('img');
            el.src = m.filmstrip ? `/mediafile/${m.id}` : `/mediafile/${m.id}`;
            kind = 'image';
          } else {
            el = document.createElement(m.type === 'audio' || t.type === 'audio' ? 'audio' : 'video');
            el.src = `/mediafile/${m.id}`;
            el.preload = 'auto';
            kind = el.tagName === 'VIDEO' ? 'video' : 'audio';
          }
          el.className = kind === 'title' ? 'pv-el pv-title' : 'pv-el';
          el.style.display = 'none';
          this.container.appendChild(el);
          entry = { el, media: m, kind, trackType: t.type, clip: c };
          // audio-routing: audiotrack-clips via WebAudio (gain); videotrack-clips altijd muted
          if (kind !== 'image' && kind !== 'title') {
            if (t.type === 'audio') {
              try {
                const src = this.ctx().createMediaElementSource(el);
                const gain = this.ctx().createGain();
                src.connect(gain).connect(this.masterIn);
                entry.gainNode = gain;
              } catch { /* al verbonden */ }
            } else {
              el.muted = true;
            }
          }
          this.els.set(c.id, entry);
        }
        entry.clip = c;
        entry.trackType = t.type;
        entry.media = m;
        if (entry.gainNode) entry.gainNode.gain.value = c.gain ?? 1;
        if (entry.kind === 'title') this.styleTitle(entry);
      }
    }
    for (const [id, entry] of this.els) {
      if (!liveIds.has(id)) { entry.el.remove(); this.els.delete(id); }
    }
    if (!this.playing) this.showFrame(S.playhead);
    document.getElementById('program-empty').style.display = projectDur() > 0 ? 'none' : '';
  }

  // titel-overlay stylen; uitgelijnd op het werkelijke videobeeld (letterbox-correct)
  styleTitle(entry) {
    const m = entry.media;
    const span = entry.el.querySelector('span');
    if (!span) return;
    if (span.textContent !== m.text) span.textContent = m.text;
    entry.el.dataset.pos = m.pos || 'onder';
    const cw = this.container.clientWidth || 640, ch = this.container.clientHeight || 360;
    const ar = (S.state?.settings.width || 16) / (S.state?.settings.height || 9);
    let w = cw, h = cw / ar;
    if (h > ch) { h = ch; w = ch * ar; }
    Object.assign(entry.el.style, {
      inset: 'auto',
      left: `${(cw - w) / 2}px`, top: `${(ch - h) / 2}px`,
      width: `${w}px`, height: `${h}px`,
    });
    span.style.fontSize = `${((m.size ?? 64) / 1080) * h}px`;
    span.style.color = m.color || '#fff';
    span.style.background = m.bg !== false ? 'rgba(0,0,0,.45)' : 'none';
    span.style.padding = m.bg !== false ? '0.15em 0.5em' : '0';
  }

  activeClips(t) {
    const act = [];
    // mute/solo per tracktype
    const audible = (track) => {
      const peers = S.state.tracks.filter((x) => x.type === track.type);
      const anySolo = peers.some((x) => x.solo);
      return !track.muted && (!anySolo || !!track.solo);
    };
    // z-orde: onderste videotrack laag, hogere tracks erboven, titels helemaal boven
    const videoTracks = S.state.tracks.filter((x) => x.type === 'video');
    for (const track of S.state.tracks) {
      if (!audible(track)) continue;
      for (const c of track.clips) {
        if (t >= c.start && t < clipEnd(c)) {
          if (track.type === 'video') {
            const z = 10 + (videoTracks.length - videoTracks.indexOf(track));
            if (S.state.media[c.mediaId]?.type === 'title') {
              act.push({ c, visible: true, audible: false, z: 30 });
            } else {
              act.push({ c, visible: true, audible: false, z });
            }
          } else {
            act.push({ c, visible: false, audible: true });
          }
        }
      }
    }
    // overgangen: in het venster zijn beide clips actief (A blijft doorlopen, B start eerder)
    for (const tr of transWindows()) {
      if (t < tr.w0 || t >= tr.w1) continue;
      const p = (t - tr.w0) / (tr.w1 - tr.w0);
      if (tr.trackType === 'video') {
        let aA = act.find((x) => x.c.id === tr.A.id);
        if (!aA) { aA = { c: tr.A, visible: true, audible: false, z: 24 }; act.push(aA); }
        aA.visible = true;
        aA.trans = { role: 'A', type: tr.type, p };
        let aB = act.find((x) => x.c.id === tr.B.id);
        if (!aB) { aB = { c: tr.B, visible: true, audible: false }; act.push(aB); }
        aB.visible = true;
        aB.z = 25; // boven A
        aB.trans = { role: 'B', type: tr.type, p };
      } else {
        let aA = act.find((x) => x.c.id === tr.A.id);
        if (!aA) { aA = { c: tr.A, visible: false, audible: true }; act.push(aA); }
        aA.audible = true; aA.transGain = 1 - p;
        let aB = act.find((x) => x.c.id === tr.B.id);
        if (!aB) { aB = { c: tr.B, visible: false, audible: true }; act.push(aB); }
        aB.audible = true; aB.transGain = p;
      }
    }
    return act;
  }

  // opacity/transform/z toepassen op een zichtbare laag
  applyLayerStyle(entry, a, t) {
    const { c } = a;
    const el = entry.el;
    el.style.zIndex = a.z ?? 10;
    let op = (a.trans ? 1 : fadeFactor(c, t)) * (c.opacity ?? 1);
    let clipPath = '';
    if (a.trans) {
      const { role, type, p } = a.trans;
      if (type === 'crossfade') { if (role === 'B') op *= p; }
      else if (type === 'wipe') { if (role === 'B') clipPath = `inset(0 ${(100 - p * 100).toFixed(2)}% 0 0)`; }
      else if (type === 'dip') { op *= role === 'A' ? Math.max(0, 1 - 2 * p) : Math.max(0, 2 * p - 1); }
    }
    el.style.opacity = op;
    el.style.clipPath = clipPath;
    const tr = c.transform;
    el.style.transform = tr
      ? `translate(${(tr.x ?? 0) * 100}%, ${(tr.y ?? 0) * 100}%) scale(${tr.scale ?? 1})`
      : '';
  }

  showFrame(t) {
    if (!S.state) return;
    const act = this.activeClips(t);
    const activeIds = new Set(act.map((a) => a.c.id));
    for (const [id, entry] of this.els) {
      const a = act.find((x) => x.c.id === id);
      if (!a) {
        entry.el.style.display = 'none';
        if (entry.kind !== 'image' && entry.kind !== 'title' && !entry.el.paused) entry.el.pause();
        continue;
      }
      const { c } = a;
      entry.el.style.display = a.visible ? '' : 'none';
      if (a.visible) this.applyLayerStyle(entry, a, t);
      if (entry.gainNode) entry.gainNode.gain.value = (c.gain ?? 1) * envFactor(c, t) * (a.transGain !== undefined ? a.transGain : fadeFactor(c, t));
      if (entry.kind === 'image' || entry.kind === 'title') continue;
      const sp = c.speed || 1;
      const desired = c.in + (t - c.start) * sp;
      if ((a.visible || a.audible) && Math.abs(entry.el.currentTime - desired) > 0.06 * sp && entry.el.readyState >= 1) {
        entry.el.currentTime = desired;
      }
      if (!this.playing && !entry.el.paused) entry.el.pause();
    }
  }

  // Een stuk beluisteren: speelt van t0 tot t1 en pauzeert dan vanzelf.
  // Handig om te horen wat je op het punt staat weg te knippen.
  playRange(t0, t1) {
    this.pause();
    setPlayhead(Math.max(0, t0), { commit: false });
    this.stopAt = t1;
    this.play();
  }

  play() {
    if (!S.state || this.playing) return;
    if (projectDur() <= 0) return;
    if (S.playhead >= projectDur() - 0.05) setPlayhead(0, { commit: false });
    this.ctx().resume();
    this.playing = true;
    document.getElementById('prog-play').textContent = '❚❚';
    const startT = performance.now() / 1000;
    const base = S.playhead;
    const tick = () => {
      if (!this.playing) return;
      const t = base + (performance.now() / 1000 - startT);
      if (t >= projectDur()) { this.pause(); setPlayhead(projectDur()); return; }
      if (this.stopAt !== undefined && t >= this.stopAt) { const at = this.stopAt; this.stopAt = undefined; this.pause(); setPlayhead(at); return; }
      S.playhead = t;
      emit('playhead');
      this.step(t);
    };
    // interval i.p.v. requestAnimationFrame: blijft lopen als het venster geen focus heeft
    this._timer = setInterval(tick, 33);
    tick();
  }

  step(t) {
    const act = this.activeClips(t);
    for (const [id, entry] of this.els) {
      const a = act.find((x) => x.c.id === id);
      if (!a) {
        entry.el.style.display = 'none';
        if (entry.kind !== 'image' && entry.kind !== 'title' && !entry.el.paused) entry.el.pause();
        continue;
      }
      const { c } = a;
      entry.el.style.display = a.visible ? '' : 'none';
      if (a.visible) this.applyLayerStyle(entry, a, t);
      if (entry.gainNode) entry.gainNode.gain.value = (c.gain ?? 1) * envFactor(c, t) * (a.transGain !== undefined ? a.transGain : fadeFactor(c, t));
      if (entry.kind === 'image' || entry.kind === 'title') continue;
      const sp = c.speed || 1;
      if (entry.el.playbackRate !== sp) entry.el.playbackRate = sp;
      const desired = c.in + (t - c.start) * sp;
      const needsAV = a.visible || a.audible;
      if (needsAV) {
        if (entry.el.paused) {
          // net actief geworden: eerst positioneren, dan starten (ook bij nog ladende media)
          if (entry.el.readyState >= 1) entry.el.currentTime = desired;
          else entry.el.addEventListener('loadedmetadata', () => { entry.el.currentTime = desired; }, { once: true });
          entry.el.play().catch(() => {});
        } else if (Math.abs(entry.el.currentTime - desired) > 0.15 * sp && entry.el.readyState >= 2) {
          entry.el.currentTime = desired;
        }
      } else if (!entry.el.paused) entry.el.pause();
    }
  }

  pause() {
    this.stopAt = undefined;
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this._timer);
    document.getElementById('prog-play').textContent = '▶';
    for (const [, entry] of this.els) if (entry.kind !== 'image' && entry.kind !== 'title' && !entry.el.paused) entry.el.pause();
    setPlayhead(S.playhead);
  }

  initScrubber() {
    const bar = document.getElementById('program-scrubber');
    const head = document.getElementById('program-scrubhead');
    const update = () => {
      const d = projectDur() || 1;
      head.style.left = `${Math.min(100, (S.playhead / d) * 100)}%`;
    };
    on('playhead', update);
    on('state', update);
    let dragging = false;
    const seek = (e) => {
      const r = bar.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      this.pause();
      setPlayhead(frac * projectDur(), { commit: !dragging });
    };
    bar.addEventListener('pointerdown', (e) => { dragging = true; bar.setPointerCapture(e.pointerId); seek(e); });
    bar.addEventListener('pointermove', (e) => dragging && seek(e));
    bar.addEventListener('pointerup', (e) => { dragging = false; seek(e); });
  }
}
