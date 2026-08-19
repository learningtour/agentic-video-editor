// Timeline: multitrack weergave + alle muisinteracties
// (selecteren, slepen, trimmen, razor, snapping, scrubben, drag & drop uit de bin).
import { S, api, on, setPlayhead, setSelection, findClipLocal, projectDur, toast as toastImport } from './app.js';

const clipLen = (c) => (c.out - c.in) / (c.speed || 1);
const clipEnd = (c) => c.start + clipLen(c);
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SNAP_PX = 12;
const stripCache = new Map(); // mediaId -> Image
const waveCache = new Map();  // mediaId -> peaks

let scroll, tracksEl, headersEl, ruler, playheadEl, snapline;

// Tijdens een sleep/trim géén rebuilds: de state-broadcast van de server zou anders
// het element onder de muis vervangen en de interactie breken.
let dragActive = false, renderPending = false;
function setDragActive(v) {
  dragActive = v;
  if (!v && renderPending) { renderPending = false; renderTimeline(); }
}

// Auto-scroll wanneer de aanwijzer tijdens een interactie tegen de rand van de
// timeline duwt; blijft scrollen zolang de muis daar stilstaat (via rAF-lus).
function makeEdgeScroller(onTick) {
  let raf = null, lastX = 0;
  const step = () => {
    const r = scroll.getBoundingClientRect();
    let dx = 0;
    if (lastX > r.right - 40) dx = Math.min(30, (lastX - (r.right - 40)) * 0.4);
    else if (lastX < r.left + 12) dx = -Math.min(30, ((r.left + 12) - lastX) * 0.4);
    if (dx) {
      const before = scroll.scrollLeft;
      scroll.scrollLeft += dx;
      if (scroll.scrollLeft !== before) onTick?.();
    }
    raf = requestAnimationFrame(step);
  };
  return {
    update(x) { lastX = x; if (raf == null) raf = requestAnimationFrame(step); },
    stop() { if (raf != null) cancelAnimationFrame(raf); raf = null; },
  };
}

// selectie-classes bijwerken zonder de timeline te herbouwen
export function applySelection() {
  for (const el of tracksEl.querySelectorAll('.clip')) {
    el.classList.toggle('selected', S.selection.includes(el.dataset.clipId));
  }
}

export function initTimeline() {
  scroll = document.getElementById('tl-scroll');
  tracksEl = document.getElementById('tl-tracks');
  headersEl = document.getElementById('tl-headers');
  ruler = document.getElementById('tl-ruler');
  playheadEl = document.getElementById('tl-playhead');

  snapline = document.createElement('div');
  snapline.className = 'snapline';
  snapline.style.display = 'none';
  scroll.appendChild(snapline);

  on('playhead', positionPlayhead);
  on('selection', applySelection);
  scroll.addEventListener('scroll', () => drawRuler());
  new ResizeObserver(() => { drawRuler(); }).observe(scroll);

  // Zoomen met het muiswiel (rond de aanwijzer). Trackpad-scrollen (kleine/horizontale
  // delta's) blijft pannen; ⌘/ctrl+scroll of pinch zoomt altijd. Shift+wiel = pannen.
  scroll.addEventListener('wheel', (e) => {
    const discreteWheel = !e.shiftKey && e.deltaX === 0 && Math.abs(e.deltaY) >= 40; // los muiswiel-klikje
    if (!(e.metaKey || e.ctrlKey || discreteWheel)) return;
    e.preventDefault();
    const px = e.clientX - scroll.getBoundingClientRect().left;
    const t = (scroll.scrollLeft + px) / S.pxPerSec;
    const f = Math.exp(-Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 60) * 0.004);
    S.pxPerSec = Math.min(400, Math.max(0.5, S.pxPerSec * f));
    document.getElementById('zoom-slider').value = S.pxPerSec;
    renderTimeline();
    scroll.scrollLeft = t * S.pxPerSec - px;
  }, { passive: false });

  // middelste muisknop ingedrukt houden = timeline pannen
  scroll.addEventListener('pointerdown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, sl = scroll.scrollLeft, st = scroll.scrollTop;
    const onMove = (ev) => {
      scroll.scrollLeft = sl - (ev.clientX - sx);
      scroll.scrollTop = st - (ev.clientY - sy);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  scroll.addEventListener('auxclick', (e) => e.preventDefault()); // geen middenklik-acties van de browser

  // scrubben op de ruler (met autoscroll tegen de randen)
  let scrubbing = false, lastScrubX = 0;
  const scrub = (x) => {
    const r = scroll.getBoundingClientRect();
    const t = Math.max(0, (x - r.left + scroll.scrollLeft) / S.pxPerSec);
    S.player?.pause();
    setPlayhead(t, { commit: false });
  };
  const scrubScroller = makeEdgeScroller(() => scrub(lastScrubX));
  ruler.addEventListener('pointerdown', (e) => {
    scrubbing = true; lastScrubX = e.clientX;
    ruler.setPointerCapture(e.pointerId);
    scrub(e.clientX);
  });
  ruler.addEventListener('pointermove', (e) => {
    if (!scrubbing) return;
    lastScrubX = e.clientX;
    scrubScroller.update(e.clientX);
    scrub(e.clientX);
  });
  ruler.addEventListener('pointerup', (e) => {
    scrubbing = false;
    scrubScroller.stop();
    scrub(e.clientX);
    setPlayhead(S.playhead);
  });

  // selectiekader (marquee) op lege ruimte; klik zonder slepen = deselecteren
  tracksEl.addEventListener('pointerdown', startMarquee);

  // dubbelklik op een gat = gat dichttrekken (ripple op alle onvergrendelde tracks)
  tracksEl.addEventListener('dblclick', (e) => {
    if (!e.target.classList.contains('tl-track')) return;
    const trackId = e.target.dataset.trackId;
    const t = (e.clientX - tracksEl.getBoundingClientRect().left) / S.pxPerSec;
    api('closeGap', { trackId, time: t }).catch(() => {});
  });

  // overgang-chips uit de toolbar slepen
  for (const chip of document.querySelectorAll('.trans-chip')) {
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-transition', chip.dataset.type);
      e.dataTransfer.effectAllowed = 'copy';
    });
  }
}

function startMarquee(e) {
  if (!e.target.classList.contains('tl-track') && e.target !== tracksEl) return;
  if (S.tool !== 'select') return;
  e.preventDefault();
  setDragActive(true);
  const base0 = tracksEl.getBoundingClientRect();
  const x0 = e.clientX - base0.left, y0 = e.clientY - base0.top;
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  const before = additive ? [...S.selection] : [];
  let dragged = false;
  let lastEv = e;

  const box = document.createElement('div');
  box.className = 'marquee';
  tracksEl.appendChild(box);

  const hitIds = (x1, y1, x2, y2) => {
    const ids = [];
    for (const tEl of tracksEl.querySelectorAll('.tl-track')) {
      const ty = tEl.offsetTop, th = tEl.offsetHeight;
      if (ty >= y2 || ty + th <= y1) continue;
      for (const cEl of tEl.querySelectorAll('.clip')) {
        const cx = cEl.offsetLeft, cw = cEl.offsetWidth;
        if (cx < x2 && cx + cw > x1) ids.push(cEl.dataset.clipId);
      }
    }
    return ids;
  };

  const scroller = makeEdgeScroller(() => onMove(lastEv, true));
  const onMove = (ev, fromScroll = false) => {
    lastEv = ev;
    if (!fromScroll) scroller.update(ev.clientX);
    const base = tracksEl.getBoundingClientRect(); // opnieuw: verschuift bij scroll
    const x = ev.clientX - base.left, y = ev.clientY - base.top;
    if (!dragged && Math.abs(x - x0) < 4 && Math.abs(y - y0) < 4) return;
    dragged = true;
    const x1 = Math.min(x0, x), x2 = Math.max(x0, x);
    const y1 = Math.min(y0, y), y2 = Math.max(y0, y);
    Object.assign(box.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px`, display: '' });
    // live voorvertoning van de selectie
    const ids = [...new Set([...before, ...hitIds(x1, y1, x2, y2)])];
    for (const el of tracksEl.querySelectorAll('.clip')) {
      el.classList.toggle('selected', ids.includes(el.dataset.clipId));
    }
    box._ids = ids;
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    scroller.stop();
    box.remove();
    setSelection(dragged ? (box._ids || before) : before);
    if (!dragged) {
      // klik zonder slepen op leeg trackdeel: playhead springt ernaartoe
      S.player?.pause();
      setPlayhead(Math.max(0, x0 / S.pxPerSec));
    }
    setDragActive(false);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

export function renderTimeline() {
  if (!S.state) return;
  if (dragActive) { renderPending = true; return; }
  const pps = S.pxPerSec;
  const width = Math.max((projectDur() + 30) * pps, scroll.clientWidth);

  tracksEl.style.width = `${width}px`;
  ruler.style.width = `${width}px`;

  // track headers
  headersEl.innerHTML = '';
  tracksEl.innerHTML = '';
  tracksEl.appendChild(snapline);

  for (const track of S.state.tracks) {
    const h = document.createElement('div');
    h.className = 'tl-header';
    h.style.height = track.type === 'video' ? '58px' : '46px';
    const magnetOn = track.magnetic !== false; // standaard aan
    // naam is optioneel; dubbelklik erop hernoemt de track (handig bij podcasts:
    // "Silvan", "Voice-over", "Muziek" leest prettiger dan A2/A3/A5)
    h.innerHTML = `<b>${track.id}</b>` +
      `<span class="th-name" title="Dubbelklik om te hernoemen">${track.name ? escapeHtml(track.name) : ''}</span>` +
      `<span class="th-btns">` +
      `<button class="th-btn ${track.muted ? 'on mute' : ''}" data-f="muted" title="Mute">M</button>` +
      `<button class="th-btn ${track.solo ? 'on solo' : ''}" data-f="solo" title="Solo">S</button>` +
      `<button class="th-btn ${track.locked ? 'on lock' : ''}" data-f="locked" title="Vergrendel">🔒</button>` +
      `<button class="th-btn ${magnetOn ? 'on magnet' : ''}" data-f="magnetic" title="Magnetisch snappen">🧲</button>` +
      `</span>`;
    for (const btn of h.querySelectorAll('.th-btn')) {
      btn.onclick = () => {
        const cur = btn.dataset.f === 'magnetic' ? track.magnetic !== false : !!track[btn.dataset.f];
        api('setTrackFlags', { trackId: track.id, [btn.dataset.f]: !cur });
      };
    }
    h.querySelector('.th-name').ondblclick = () => {
      const name = prompt(`Naam voor track ${track.id}:`, track.name || '');
      if (name !== null) api('setTrackName', { trackId: track.id, name });
    };
    headersEl.appendChild(h);

    const tEl = document.createElement('div');
    tEl.className = `tl-track ${track.type}` + (track.locked ? ' locked' : '') + (track.muted ? ' muted' : '');
    tEl.dataset.trackId = track.id;
    tEl.style.width = `${width}px`;
    tracksEl.appendChild(tEl);

    for (const clip of track.clips) tEl.appendChild(makeClipEl(clip, track, pps));
    for (const tr of (S.state.transitions ?? []).filter((x) => x.trackId === track.id)) {
      tEl.appendChild(makeTransBadge(tr, pps));
    }

    // drop uit de bin
    tEl.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-media-id')) {
        e.preventDefault();
        tEl.classList.add('droptarget');
      } else if (e.dataTransfer.types.includes('application/x-transition')) {
        e.preventDefault();
        tEl.classList.add('transdrop');
      }
    });
    tEl.addEventListener('dragleave', () => tEl.classList.remove('droptarget', 'transdrop'));
    tEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      tEl.classList.remove('droptarget', 'transdrop');
      const transType = e.dataTransfer.getData('application/x-transition');
      if (transType) {
        const rect = tEl.getBoundingClientRect();
        const dropT = (e.clientX - rect.left) / pps;
        // dichtstbijzijnde cut op deze track zoeken
        let cut = null, bestD = 1.5;
        const sortedClips = [...track.clips].sort((a, b) => a.start - b.start);
        for (let ci = 0; ci < sortedClips.length - 1; ci++) {
          const cend = clipEnd(sortedClips[ci]);
          if (Math.abs(sortedClips[ci + 1].start - cend) < 0.06 && Math.abs(cend - dropT) < bestD) {
            bestD = Math.abs(cend - dropT);
            cut = cend;
          }
        }
        if (cut == null) return void toastImport('Geen cut in de buurt — overgangen horen op een cut tussen twee aansluitende clips');
        await api('addTransition', { trackId: track.id, time: cut, type: transType, dur: 1 });
        return;
      }
      const mediaId = e.dataTransfer.getData('application/x-media-id');
      if (!mediaId) return;
      const m = S.state.media[mediaId];
      const isVideoMedia = m.type === 'video' || m.type === 'image' || m.type === 'title';
      if ((track.type === 'video') !== isVideoMedia && !(track.type === 'audio' && m.hasAudio)) return;
      const rect = tEl.getBoundingClientRect();
      let t = Math.max(0, (e.clientX - rect.left) / pps);
      t = snapTime(t, null, 0, track.id);
      await api('addClip', { mediaId, trackId: track.id, start: t, linkAudio: track.type === 'video' });
    });
  }
  positionPlayhead();
  drawRuler();
}

// Overgang-badge op een cut: randen slepen = duur, ⌥-klik = verwijderen
function makeTransBadge(tr, pps) {
  const el = document.createElement('div');
  el.className = 'transbadge';
  const icon = tr.type === 'wipe' ? '◧' : tr.type === 'dip' ? '⬛' : '⤬';
  const setBounds = (dur) => {
    el.style.left = `${(tr.time - dur / 2) * pps}px`;
    el.style.width = `${Math.max(14, dur * pps)}px`;
  };
  setBounds(tr.dur);
  el.textContent = `${icon} ${tr.dur.toFixed(1)}s`;
  el.title = `${tr.type} (${tr.dur.toFixed(1)}s) — randen slepen = duur, ⌥-klik = verwijderen`;
  for (const side of ['l', 'r']) {
    const edge = document.createElement('div');
    edge.className = `tb-edge ${side}`;
    el.appendChild(edge);
    edge.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(true);
      let dur = tr.dur;
      const onMove = (ev) => {
        const half = Math.abs(((ev.clientX - tracksEl.getBoundingClientRect().left) / S.pxPerSec) - tr.time);
        dur = Math.min(5, Math.max(0.2, half * 2));
        setBounds(dur);
      };
      const onUp = async () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        try { await api('editTransition', { transitionId: tr.id, dur: Math.round(dur * 10) / 10 }); }
        finally { setDragActive(false); renderTimeline(); }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }
  el.addEventListener('pointerdown', (e) => {
    if (e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      api('removeTransition', { transitionId: tr.id });
    } else {
      e.stopPropagation(); // niet marquee'n vanaf een badge
    }
  });
  return el;
}

function makeClipEl(clip, track, pps) {
  const m = S.state.media[clip.mediaId];
  const el = document.createElement('div');
  el.className = `clip ${track.type}` + (m?.type === 'title' ? ' title' : '') + (S.selection.includes(clip.id) ? ' selected' : '');
  el.dataset.clipId = clip.id;
  const x = clip.start * pps;
  const w = clipLen(clip) * pps;
  el.style.left = `${x}px`;
  el.style.width = `${Math.max(2, w)}px`;

  const label = document.createElement('div');
  label.className = 'clip-label';
  const badges = [];
  if (clip.speed && clip.speed !== 1) badges.push(`×${clip.speed}`);
  if (clip.opacity !== undefined || clip.transform) badges.push('fx');
  label.textContent = (badges.length ? `[${badges.join(' ')}] ` : '') + (clip.label || m?.name || '?');
  el.appendChild(label);
  el.addEventListener('dblclick', (e) => { e.stopPropagation(); openPropsDialog(clip); });

  const canvas = document.createElement('canvas');
  el.appendChild(canvas);
  requestAnimationFrame(() => drawClipCanvas(canvas, clip, track, m));

  {
    const eL = document.createElement('div'); eL.className = 'edge l';
    const eR = document.createElement('div'); eR.className = 'edge r';
    el.append(eL, eR);
    eL.addEventListener('pointerdown', (e) => startTrim(e, clip, 'in'));
    eR.addEventListener('pointerdown', (e) => startTrim(e, clip, 'out'));
  }
  if (track.type === 'audio') {
    addGainLine(el, clip);
    addGainKeyDots(el, clip);
    // ⌥+dubbelklik = keyframe toevoegen op die plek
    el.addEventListener('dblclick', (e) => {
      if (!e.altKey) return;
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const t = ((e.clientX - r.left) / S.pxPerSec);
      const g = Math.min(2, Math.max(0, (1 - (e.clientY - r.top) / r.height) * 2));
      const keys = [...(clip.gainKeys ?? []), { t: Math.round(t * 100) / 100, gain: Math.round(g * 100) / 100 }];
      api('setClipGainKeys', { clipId: clip.id, keys });
    }, true);
  }
  addFadeHandles(el, clip);

  el.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('edge')) return;
    if (S.tool === 'razor') {
      const rect = el.getBoundingClientRect();
      const t = clip.start + (e.clientX - rect.left) / S.pxPerSec;
      api('splitClip', { clipId: clip.id, time: t });
      return;
    }
    startMove(e, clip, el);
  });
  return el;
}

// Volumelijn (rubber band) op audioclips: slepen = gain aanpassen; midden = 0 dB.
// gain (amplitude 0–2 over de cliphoogte): boven = +6 dB, midden = 0 dB, onder = stil.
function addGainLine(el, clip) {
  const line = document.createElement('div');
  line.className = 'gainline';
  const setPos = (gain) => { line.style.top = `${Math.min(97, Math.max(2, (1 - gain / 2) * 100))}%`; };
  setPos(clip.gain ?? 1);
  el.appendChild(line);

  const toDb = (g) => (g <= 0.001 ? '-∞' : (20 * Math.log10(g)).toFixed(1));

  line.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
    const label = document.createElement('div');
    label.className = 'gainlabel';
    el.appendChild(label);
    let gain = clip.gain ?? 1;

    const onMove = (ev) => {
      const r = el.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      gain = Math.round((1 - frac) * 2 * 100) / 100; // 0 (onder) … 2 (boven)
      setPos(gain);
      label.textContent = `${toDb(gain)} dB`;
      label.style.top = `${Math.min(80, Math.max(0, frac * 100 - 12))}%`;
    };
    const onUp = async () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      label.remove();
      try {
        await api('setClipGain', { clipId: clip.id, gain });
      } finally {
        setDragActive(false);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

// Keyframe-dots op de volume-envelope: slepen = verplaatsen, ⌥+klik = verwijderen.
function addGainKeyDots(el, clip) {
  const keys = clip.gainKeys ?? [];
  keys.forEach((k, idx) => {
    const dot = document.createElement('div');
    dot.className = 'gainkey';
    dot.style.left = `${k.t * S.pxPerSec}px`;
    dot.style.top = `${(1 - k.gain / 2) * 100}%`;
    dot.title = `${k.t.toFixed(2)}s · ${k.gain <= 0.001 ? '-∞' : (20 * Math.log10(k.gain)).toFixed(1)} dB — sleep of ⌥-klik om te verwijderen`;
    el.appendChild(dot);
    dot.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.altKey) {
        const rest = keys.filter((_, i) => i !== idx);
        api('setClipGainKeys', { clipId: clip.id, keys: rest });
        return;
      }
      setDragActive(true);
      const len = clipLen(clip);
      let cur = { ...k };
      const onMove = (ev) => {
        const r = el.getBoundingClientRect();
        cur.t = Math.min(len, Math.max(0, (ev.clientX - r.left) / S.pxPerSec));
        cur.gain = Math.min(2, Math.max(0, (1 - (ev.clientY - r.top) / r.height) * 2));
        dot.style.left = `${cur.t * S.pxPerSec}px`;
        dot.style.top = `${(1 - cur.gain / 2) * 100}%`;
      };
      const onUp = async () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const next = keys.map((kk, i) => (i === idx ? { t: Math.round(cur.t * 100) / 100, gain: Math.round(cur.gain * 100) / 100 } : kk));
        try { await api('setClipGainKeys', { clipId: clip.id, keys: next }); }
        finally { setDragActive(false); renderTimeline(); }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  });
}

// Fade-hendels (rondjes linksboven/rechtsboven): horizontaal slepen = fadelengte.
function addFadeHandles(el, clip) {
  for (const side of ['in', 'out']) {
    const h = document.createElement('div');
    h.className = `fadehandle ${side}`;
    const cur = (side === 'in' ? clip.fadeIn : clip.fadeOut) ?? 0;
    h.style[side === 'in' ? 'left' : 'right'] = `${cur * S.pxPerSec}px`;
    h.title = side === 'in' ? 'Fade-in slepen' : 'Fade-uit slepen';
    el.appendChild(h);
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(true);
      const len = clip.out - clip.in;
      let fade = cur;
      const onMove = (ev) => {
        const r = el.getBoundingClientRect();
        fade = side === 'in'
          ? Math.min(len, Math.max(0, (ev.clientX - r.left) / S.pxPerSec))
          : Math.min(len, Math.max(0, (r.right - ev.clientX) / S.pxPerSec));
        h.style[side === 'in' ? 'left' : 'right'] = `${fade * S.pxPerSec}px`;
      };
      const onUp = async () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        try {
          await api('setClipFade', {
            clipId: clip.id,
            [side === 'in' ? 'fadeIn' : 'fadeOut']: Math.round(fade * 100) / 100,
          });
        } finally {
          setDragActive(false);
          renderTimeline();
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }
}

function drawClipCanvas(canvas, clip, track, m) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  const ctx = canvas.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);

  if (track.type === 'video' && m?.filmstrip) {
    let img = stripCache.get(m.id);
    if (!img) {
      img = new Image();
      img.src = m.filmstrip;
      img.onload = () => drawClipCanvas(canvas, clip, track, m);
      stripCache.set(m.id, img);
      return;
    }
    if (img.complete && img.naturalWidth) {
      const frames = m.filmstripFrames || 1;
      const fw = img.naturalWidth / frames;
      const dur = m.duration || 1;
      const thumbW = (fw / img.naturalHeight) * h;
      for (let x = 0; x < w; x += thumbW) {
        const t = clip.in + ((x + thumbW / 2) / S.pxPerSec) * (clip.speed || 1);
        const fi = Math.min(frames - 1, Math.max(0, Math.floor((t / dur) * frames)));
        ctx.drawImage(img, fi * fw, 0, fw, img.naturalHeight, x, 0, thumbW, h);
      }
      ctx.fillStyle = 'rgba(0,0,0,.25)';
      ctx.fillRect(0, 0, w, 14);
    }
  }

  // fade-ramps als donkere driehoeken
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.strokeStyle = 'rgba(255,255,255,.5)';
  if (clip.fadeIn > 0) {
    const fw = clip.fadeIn * S.pxPerSec;
    ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(fw, 0); ctx.lineTo(0, 0); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(fw, 0); ctx.stroke();
  }
  if (clip.fadeOut > 0) {
    const fw = clip.fadeOut * S.pxPerSec;
    ctx.beginPath(); ctx.moveTo(w, h); ctx.lineTo(w - fw, 0); ctx.lineTo(w, 0); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(w, h); ctx.lineTo(w - fw, 0); ctx.stroke();
  }

  // volume-envelope als gele lijn
  if (clip.gainKeys?.length) {
    ctx.strokeStyle = '#ffd66b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const yOf = (g) => (1 - g / 2) * h;
    ctx.moveTo(0, yOf(clip.gainKeys[0].gain));
    for (const k of clip.gainKeys) ctx.lineTo(k.t * S.pxPerSec, yOf(k.gain));
    ctx.lineTo(w, yOf(clip.gainKeys[clip.gainKeys.length - 1].gain));
    ctx.stroke();
  }

  if (track.type === 'audio' && (m?.waveform)) {
    drawWave(ctx, clip, m, w, h);
  } else if (track.type === 'video' && m?.hasAudio && m?.waveform) {
    // dun waveform-strookje onderin videoclips
    ctx.save();
    ctx.translate(0, h - 12);
    drawWave(ctx, clip, m, w, 12, true);
    ctx.restore();
  }
}

async function drawWave(ctx, clip, m, w, h, mini = false) {
  let peaks = waveCache.get(m.id);
  if (!peaks) {
    try {
      const data = await (await fetch(m.waveform)).json();
      peaks = data;
      waveCache.set(m.id, peaks);
    } catch { return; }
  }
  const { pps: peaksPerSec, peaks: arr } = peaks;
  ctx.fillStyle = mini ? 'rgba(255,255,255,.45)' : 'rgba(180,255,205,.6)';
  const mid = h / 2;
  for (let x = 0; x < w; x += 2) {
    const t = clip.in + (x / S.pxPerSec) * (clip.speed || 1);
    const i = Math.floor(t * peaksPerSec);
    const v = (arr[i] || 0) / 100;
    const bh = Math.max(1, v * (h - 2));
    ctx.fillRect(x, mid - bh / 2, 1.5, bh);
  }
}

// ---------- eigenschappen-dialoog (dubbelklik op clip) ----------
function openPropsDialog(clip) {
  const dlg = document.getElementById('dlg-props');
  const m = S.state.media[clip.mediaId];
  const isStillM = m?.type === 'image' || m?.type === 'title';
  document.getElementById('prop-speed').value = clip.speed ?? 1;
  document.getElementById('prop-speed').disabled = isStillM;
  document.getElementById('prop-opacity').value = clip.opacity ?? 1;
  document.getElementById('prop-scale').value = clip.transform?.scale ?? 1;
  document.getElementById('prop-x').value = clip.transform?.x ?? 0;
  document.getElementById('prop-y').value = clip.transform?.y ?? 0;
  document.getElementById('prop-name').textContent = m?.name ?? '';
  dlg.showModal();
  document.getElementById('prop-reset').onclick = async () => {
    await api('setClipProps', { clipId: clip.id, speed: 1, opacity: 1, scale: 1, x: 0, y: 0 });
    dlg.close();
  };
  document.getElementById('prop-save').onclick = async () => {
    await api('setClipProps', {
      clipId: clip.id,
      speed: +document.getElementById('prop-speed').value,
      opacity: +document.getElementById('prop-opacity').value,
      scale: +document.getElementById('prop-scale').value,
      x: +document.getElementById('prop-x').value,
      y: +document.getElementById('prop-y').value,
    });
    dlg.close();
  };
  document.getElementById('prop-cancel').onclick = () => dlg.close();
}

// ---------- snapping ----------
function snapPoints(exclude) {
  // exclude: Set van clipIds die meebewegen (incl. gelinkte partners) — die snappen niet
  const pts = [0, S.playhead];
  for (const mk of S.state?.markers ?? []) pts.push(mk.time);
  const linkIds = new Set();
  for (const t of S.state.tracks) {
    for (const c of t.clips) if (exclude.has(c.id) && c.linkId) linkIds.add(c.linkId);
  }
  for (const t of S.state.tracks) {
    for (const c of t.clips) {
      if (exclude.has(c.id)) continue;
      if (c.linkId && linkIds.has(c.linkId)) continue;
      pts.push(c.start, clipEnd(c));
    }
  }
  return pts;
}
const isMagnetic = (trackId) => {
  const tr = S.state?.tracks.find((x) => x.id === trackId);
  return !tr || tr.magnetic !== false; // standaard aan
};

// dichtstbijzijnde snap-punt binnen de magneetradius, of null
function nearestSnap(x, exclude) {
  if (!(exclude instanceof Set)) exclude = new Set(exclude ? [exclude] : []);
  const thr = SNAP_PX / S.pxPerSec;
  let best = null;
  for (const p of snapPoints(exclude)) {
    const d = Math.abs(p - x);
    if (d < thr && (!best || d < best.d)) best = { p, d };
  }
  return best;
}

function snapTime(t, excludeClipId, extraOffset = 0, trackId = null) {
  if (trackId && !isMagnetic(trackId)) { showSnap(null); return Math.max(0, t); }
  const hit = nearestSnap(t + extraOffset, excludeClipId);
  showSnap(hit ? hit.p : null);
  return Math.max(0, hit ? hit.p - extraOffset : t);
}
function showSnap(t) {
  if (t == null) { snapline.style.display = 'none'; return; }
  snapline.style.display = '';
  snapline.style.left = `${t * S.pxPerSec}px`;
}

// ---------- slepen ----------
function startMove(e, clip, el) {
  e.preventDefault();
  setDragActive(true);
  const startX = e.clientX, startY = e.clientY;
  const origStart = clip.start;
  const origTrackEl = el.parentElement;
  let moved = false;
  let targetTrackId = origTrackEl.dataset.trackId;

  const addMod = e.shiftKey || e.metaKey || e.ctrlKey;
  if (!S.selection.includes(clip.id)) {
    setSelection(addMod ? [...S.selection, clip.id] : [clip.id]);
  } else if (addMod) {
    // ⌘/⇧-klik op geselecteerde clip: uit de selectie halen, niet slepen
    setSelection(S.selection.filter((id) => id !== clip.id));
    setDragActive(false);
    return;
  }

  // groepssleep: meerdere geselecteerde clips bewegen samen (zelfde tijdsverschuiving)
  const multi = S.selection.length > 1 && S.selection.includes(clip.id);
  const group = multi
    ? S.selection.map((id) => {
        const gEl = tracksEl.querySelector(`.clip[data-clip-id="${id}"]`);
        return gEl ? { el: gEl, left: gEl.offsetLeft } : null;
      }).filter(Boolean)
    : null;
  let pendingDelta = 0;
  // pak-offset in de clip, zodat slepen ook klopt terwijl de timeline meescrollt
  const grabOffset = e.clientX - el.getBoundingClientRect().left;
  let lastEv = e;
  const scroller = makeEdgeScroller(() => onMove(lastEv, true));

  const onMove = (ev, fromScroll = false) => {
    lastEv = ev;
    if (!fromScroll) scroller.update(ev.clientX);
    if (!moved && Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return;
    moved = true;
    const contentX = ev.clientX - tracksEl.getBoundingClientRect().left;
    let t = (contentX - grabOffset) / S.pxPerSec;
    // magneet: begin- én eindrand proberen; de dichtstbijzijnde wint
    if (isMagnetic(targetTrackId)) {
      const len = clipLen(clip);
      const exclude = multi ? new Set(S.selection) : new Set([clip.id]);
      const s1 = nearestSnap(t, exclude);
      const s2 = nearestSnap(t + len, exclude);
      if (s1 && (!s2 || s1.d <= s2.d)) { t = s1.p; showSnap(s1.p); }
      else if (s2) { t = s2.p - len; showSnap(s2.p); }
      else showSnap(null);
    } else showSnap(null);
    t = Math.max(0, t);

    if (multi) {
      pendingDelta = t - origStart;
      for (const g of group) g.el.style.left = `${Math.max(0, g.left + pendingDelta * S.pxPerSec)}px`;
      return; // geen trackwissel bij groepssleep
    }
    el.style.left = `${t * S.pxPerSec}px`;
    el.dataset.pendingStart = t;

    // verticaal: naar andere track van hetzelfde type
    for (const tEl of tracksEl.querySelectorAll('.tl-track')) {
      const r = tEl.getBoundingClientRect();
      if (ev.clientY >= r.top && ev.clientY < r.bottom) {
        const target = S.state.tracks.find((x) => x.id === tEl.dataset.trackId);
        const orig = S.state.tracks.find((x) => x.id === origTrackEl.dataset.trackId);
        if (target && target.type === orig.type && tEl !== el.parentElement) {
          tEl.appendChild(el);
          targetTrackId = target.id;
        }
      }
    }
  };
  const onUp = async (ev) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    scroller.stop();
    showSnap(null);
    if (!moved) { setDragActive(false); return; }
    try {
      if (multi) {
        await api('moveClips', { clipIds: S.selection, delta: pendingDelta, withLinked: !ev.altKey });
      } else {
        const newStart = parseFloat(el.dataset.pendingStart ?? origStart);
        await api('moveClip', {
          clipId: clip.id,
          trackId: targetTrackId,
          start: newStart,
          withLinked: !ev.altKey,
        });
      }
    } finally {
      setDragActive(false);
      renderTimeline();
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// ---------- trimmen ----------
function startTrim(e, clip, edge) {
  e.preventDefault();
  e.stopPropagation();
  setDragActive(true);
  const el = e.target.closest('.clip');
  const origStart = clip.start, origIn = clip.in, origOut = clip.out;
  const m = S.state.media[clip.mediaId];
  let pendingT = null;
  let lastEv = e;
  const scroller = makeEdgeScroller(() => onMove(lastEv, true));

  const onMove = (ev, fromScroll = false) => {
    lastEv = ev;
    if (!fromScroll) scroller.update(ev.clientX);
    // positie van de rand onder de aanwijzer, in timeline-tijd (scroll-bestendig)
    const pointerT = (ev.clientX - tracksEl.getBoundingClientRect().left) / S.pxPerSec;
    if (edge === 'in') {
      let t = pointerT;
      const spd = clip.speed || 1;
      const minT = (m?.type === 'image' || m?.type === 'title') ? -Infinity : origStart - origIn / spd; // niet vóór bron-begin
      t = Math.max(t, minT);
      t = Math.min(t, origStart + (origOut - origIn) / (clip.speed || 1) - 0.04);
      t = snapTime(t, clip.id, 0, findClipLocal(clip.id)?.track.id);
      pendingT = t;
      el.style.left = `${t * S.pxPerSec}px`;
      el.style.width = `${(origStart + (origOut - origIn) - t) * S.pxPerSec}px`;
    } else {
      let end = pointerT;
      const maxEnd = (m?.type === 'image' || m?.type === 'title' || !m?.duration) ? Infinity : origStart + (m.duration - origIn) / (clip.speed || 1);
      end = Math.min(end, maxEnd);
      end = Math.max(end, origStart + 0.04);
      end = snapTime(end, clip.id, 0, findClipLocal(clip.id)?.track.id);
      pendingT = end;
      el.style.width = `${(end - origStart) * S.pxPerSec}px`;
    }
    const canvas = el.querySelector('canvas');
    if (canvas) drawClipCanvas(canvas, clip, { type: el.classList.contains('audio') ? 'audio' : 'video' }, m);
  };
  const onUp = async (ev) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    scroller.stop();
    showSnap(null);
    if (pendingT == null) { setDragActive(false); return; }
    try {
      await api('trimClip', { clipId: clip.id, edge, time: pendingT, withLinked: !ev.altKey });
    } finally {
      setDragActive(false);
      renderTimeline();
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// ---------- ruler & playhead ----------
function positionPlayhead() {
  // playhead staat ín de scroller en scrollt dus mee met de content
  playheadEl.style.left = `${S.playhead * S.pxPerSec}px`;
  // auto-scroll tijdens afspelen
  if (S.player?.playing) {
    const x = S.playhead * S.pxPerSec;
    if (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth - 40) {
      scroll.scrollLeft = x - 60;
    }
  }
}

function drawRuler() {
  const w = scroll.clientWidth;
  ruler.width = w * devicePixelRatio;
  ruler.height = 26 * devicePixelRatio;
  ruler.style.width = `${w}px`;
  const ctx = ruler.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, w, 26);
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, w, 26);

  const pps = S.pxPerSec;
  // werkgebied als blauwe balk bovenin de ruler
  const wa = S.state?.workArea;
  if (wa) {
    const x1 = wa.start * pps - scroll.scrollLeft;
    const x2 = wa.end * pps - scroll.scrollLeft;
    ctx.fillStyle = 'rgba(45,140,235,.55)';
    ctx.fillRect(x1, 0, x2 - x1, 5);
  }
  // opmerkingen als vlaggetjes (oranje = open, groen = afgehandeld)
  for (const n of S.state?.notes ?? []) {
    const x = n.time * pps - scroll.scrollLeft;
    if (x < -10 || x > w + 10) continue;
    ctx.fillStyle = n.done ? '#4a8a5a' : '#e0894a';
    ctx.fillRect(x - 1, 14, 2, 12);
    ctx.beginPath();
    ctx.moveTo(x, 14); ctx.lineTo(x + 9, 17); ctx.lineTo(x, 20);
    ctx.closePath(); ctx.fill();
  }

  // markers als gekleurde ruitjes
  for (const mk of S.state?.markers ?? []) {
    const x = mk.time * pps - scroll.scrollLeft;
    if (x < -8 || x > w + 8) continue;
    ctx.fillStyle = mk.color || '#2dd07f';
    ctx.beginPath();
    ctx.moveTo(x, 6); ctx.lineTo(x + 4, 10); ctx.lineTo(x, 14); ctx.lineTo(x - 4, 10);
    ctx.closePath(); ctx.fill();
    if (mk.name && pps > 8) {
      ctx.fillStyle = '#9fd8b8';
      ctx.font = '9px -apple-system, sans-serif';
      ctx.fillText(mk.name.slice(0, 20), x + 6, 13);
    }
  }
  // tick-interval kiezen: 1/2/5/10/30/60s afhankelijk van zoom
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];
  const step = steps.find((s) => s * pps >= 60) || 600;
  const t0 = Math.floor(scroll.scrollLeft / pps / step) * step;

  ctx.fillStyle = '#888';
  ctx.font = '10px Menlo, monospace';
  ctx.strokeStyle = '#4a4a4a';
  for (let t = t0; t * pps < scroll.scrollLeft + w; t += step) {
    const x = t * pps - scroll.scrollLeft;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 15);
    ctx.lineTo(x + 0.5, 26);
    ctx.stroke();
    const mm = Math.floor(t / 60), ss = (t % 60).toFixed(step < 1 ? 1 : 0).padStart(2, '0');
    ctx.fillText(`${mm}:${ss}`, x + 3, 12);
    // sub-ticks
    for (let i = 1; i < 5; i++) {
      const sx = (t + (step * i) / 5) * pps - scroll.scrollLeft;
      ctx.beginPath();
      ctx.moveTo(sx + 0.5, 21);
      ctx.lineTo(sx + 0.5, 26);
      ctx.stroke();
    }
  }
  positionPlayhead();
}
