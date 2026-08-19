// Bronmonitor: preview van bin-media, in/uit-punten zetten, plaatsen op de timeline.
import { S, api, on, fmtTC, setPlayhead } from './app.js';

const src = {
  media: null,
  in: null,
  out: null,
};
export const getSource = () => src;

let video, image, empty, nameEl, tcEl, scrubber, scrubHead, inoutEl;

export function initSource() {
  video = document.getElementById('source-video');
  image = document.getElementById('source-image');
  empty = document.getElementById('source-empty');
  nameEl = document.getElementById('source-name');
  tcEl = document.getElementById('source-tc');
  scrubber = document.getElementById('source-scrubber');
  scrubHead = document.getElementById('source-scrubhead');
  inoutEl = document.getElementById('source-inout');

  document.getElementById('src-play').onclick = togglePlay;
  document.getElementById('src-in').onclick = () => mark('in');
  document.getElementById('src-out').onclick = () => mark('out');
  document.getElementById('src-insert').onclick = insert;

  video.addEventListener('timeupdate', renderScrub);
  let dragging = false;
  const seek = (e) => {
    if (!src.media || src.media.type === 'image') return;
    const r = scrubber.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    video.currentTime = frac * (src.media.duration || 0);
    renderScrub();
  };
  scrubber.addEventListener('pointerdown', (e) => { dragging = true; scrubber.setPointerCapture(e.pointerId); seek(e); });
  scrubber.addEventListener('pointermove', (e) => dragging && seek(e));
  scrubber.addEventListener('pointerup', () => (dragging = false));
}

export function loadSource(media) {
  src.media = media;
  src.in = null;
  src.out = null;
  // bij gegenereerde media: de ingesproken tekst / prompt erbij, zodat je niet hoeft te luisteren
  const gen = media?.gen?.text || media?.gen?.prompt || '';
  nameEl.textContent = media ? `— ${media.name}${gen ? ` · "${gen.length > 90 ? `${gen.slice(0, 90)}…` : gen}"` : ''}` : '';
  nameEl.title = gen || '';
  empty.style.display = media ? 'none' : '';
  if (!media) { video.removeAttribute('src'); image.hidden = true; return; }
  if (media.type === 'image') {
    video.style.display = 'none';
    video.pause();
    video.removeAttribute('src');
    image.hidden = false;
    image.src = `/mediafile/${media.id}`;
  } else {
    image.hidden = true;
    video.style.display = '';
    video.src = `/mediafile/${media.id}`;
    video.currentTime = 0;
  }
  renderScrub();
}

function togglePlay() {
  if (!src.media || src.media.type === 'image') return;
  if (video.paused) { video.play(); document.getElementById('src-play').textContent = '❚❚'; }
  else { video.pause(); document.getElementById('src-play').textContent = '▶'; }
}

function mark(which) {
  if (!src.media || src.media.type === 'image') return;
  src[which] = video.currentTime;
  if (src.in != null && src.out != null && src.out <= src.in) {
    if (which === 'in') src.out = null; else src.in = null;
  }
  renderScrub();
}

async function insert() {
  if (!src.media) return;
  const m = src.media;
  const isVideo = m.type === 'video' || m.type === 'image';
  const trackId = pickTrack(isVideo);
  const args = { mediaId: m.id, trackId, start: S.playhead };
  if (src.in != null) args.in = src.in;
  if (src.out != null) args.out = src.out;
  await api('addClip', args);
  const len = (args.out ?? m.duration ?? 5) - (args.in ?? 0);
  setPlayhead(S.playhead + len);
}
function pickTrack(isVideo) {
  // laagste video-track (V1) resp. eerste audiotrack
  const list = S.state.tracks.filter((t) => t.type === (isVideo ? 'video' : 'audio'));
  return isVideo ? list.at(-1)?.id : list[0]?.id;
}

function renderScrub() {
  if (!src.media || src.media.type === 'image') {
    scrubHead.style.left = '0';
    inoutEl.style.display = 'none';
    tcEl.textContent = fmtTC(0);
    return;
  }
  const d = src.media.duration || 1;
  scrubHead.style.left = `${(video.currentTime / d) * 100}%`;
  tcEl.textContent = fmtTC(video.currentTime, src.media.fps || 30);
  if (src.in != null || src.out != null) {
    const a = ((src.in ?? 0) / d) * 100;
    const b = ((src.out ?? d) / d) * 100;
    inoutEl.style.display = '';
    inoutEl.style.left = `${a}%`;
    inoutEl.style.width = `${b - a}%`;
  } else inoutEl.style.display = 'none';
}

// sneltoetsen vanuit app.js: i / o / , (plaatsen)
export function sourceKey(key) {
  if (key === 'i') mark('in');
  else if (key === 'o') mark('out');
  else if (key === ',') insert();
}
