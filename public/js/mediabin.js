// Media bin en dialogen (projecten, projecteigenschappen, instellingen, export).
import { S, api, apiGet, apiPost, on, toast, toastInfo, setPlayhead } from './app.js';
import { loadSource } from './source.js';
import { t, currentLang, setLanguage } from './i18n.js';

let activeMediaId = null;

export function initBin() {
  const fileInput = document.getElementById('file-input');
  document.getElementById('btn-import').onclick = () => fileInput.click();
  document.getElementById('btn-title').onclick = () => openTitleDialog(null);
  fileInput.onchange = () => uploadFiles(fileInput.files);
  initTitleDialog();

  // drag & drop uit Finder
  document.body.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      document.body.classList.add('dragover');
    }
  });
  document.body.addEventListener('dragleave', (e) => {
    if (e.target === document.body) document.body.classList.remove('dragover');
  });
  document.body.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files?.length) return;
    e.preventDefault();
    document.body.classList.remove('dragover');
    uploadFiles(e.dataTransfer.files);
  });

  // tabs
  const pages = ['bin', 'vo', 'podcast', 'screenrec', 'studio', 'verheug', 'eaa', 'notes'];
  for (const tab of document.querySelectorAll('.tab')) {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      for (const p of pages) document.getElementById(`tab-${p}`).hidden = tab.dataset.tab !== p;
      // het transcript, de studio en de opname lezen prettiger op een breder paneel
      document.getElementById('left-panel').classList.toggle('wide', ['podcast', 'screenrec', 'studio', 'verheug', 'eaa'].includes(tab.dataset.tab));
      if (tab.dataset.tab === 'podcast') {
        import('./podcast.js').then((m) => m.onPodcastTabOpen()).catch(() => {});
      }
      if (tab.dataset.tab === 'screenrec') {
        import('./screenrec.js').then((m) => m.onScreenrecTabOpen()).catch(() => {});
      }
      if (tab.dataset.tab === 'studio') {
        import('./studio.js').then((m) => m.onStudioTabOpen()).catch(() => {});
      }
      if (tab.dataset.tab === 'verheug') {
        import('./verheug.js').then((m) => m.onVerheugTabOpen()).catch(() => {});
      }
      if (tab.dataset.tab === 'eaa') {
        import('./eaa.js').then((m) => m.onEaaTabOpen()).catch(() => {});
      }
    };
  }
}

async function uploadFiles(files) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const data = await res.json();
  if (!data.ok) toast(data.error);
}

export function renderBin() {
  const list = document.getElementById('bin-list');
  list.innerHTML = '';
  const media = Object.values(S.state.media);
  for (const m of media) {
    const item = document.createElement('div');
    item.className = 'bin-item' + (m.id === activeMediaId ? ' active' : '');
    item.draggable = true;

    const thumb = document.createElement('div');
    thumb.className = 'bin-thumb';
    if (m.type === 'title') { thumb.textContent = 'T'; thumb.style.fontFamily = 'Georgia, serif'; thumb.style.fontSize = '20px'; }
    else if (m.filmstrip) thumb.style.backgroundImage = `url(${m.filmstrip})`;
    else thumb.textContent = m.type === 'audio' ? '🎵' : '🎞';

    const meta = document.createElement('div');
    meta.className = 'bin-meta';
    const sub = [m.type];
    if (m.duration) sub.push(`${m.duration.toFixed(1)}s`);
    if (m.width) sub.push(`${m.width}×${m.height}`);
    if (m.label) sub.push(m.label);
    // gegenereerd item: toon de ingesproken tekst of de prompt (in plaats van de bestandsnaam)
    const genText = m.gen?.text || m.gen?.prompt || '';
    meta.innerHTML = `<div class="bin-name">${m.name}</div><div class="bin-sub">${sub.join(' · ')}</div>` +
      (genText ? `<div class="bin-gen" title="${genText.replace(/"/g, '&quot;')}">${m.gen.kind === 'voiceover' ? '🗣' : m.gen.kind === 'music' ? '🎵' : '✎'} ${genText}</div>` : '');
    if (genText) item.title = genText;

    const del = document.createElement('button');
    del.className = 'bin-del';
    del.textContent = '✕';
    del.title = 'Verwijder uit project (clips op de timeline verdwijnen ook)';
    del.onclick = (e) => { e.stopPropagation(); api('removeMedia', { mediaId: m.id }); };

    item.append(thumb, meta);
    // verbeterd item: het origineel op de tijdlijn in één klik vervangen (en terug)
    if (m.sourceId && S.state.media[m.sourceId]) {
      const src = S.state.media[m.sourceId];
      const swap = document.createElement('button');
      swap.className = 'bin-del bin-swap';
      swap.textContent = '↩';
      swap.title = t('Vervang "%{src}" op de tijdlijn door dit verbeterde bestand', { src: src.name });
      swap.onclick = async (e) => {
        e.stopPropagation();
        const r = await api('replaceMedia', { fromMediaId: m.sourceId, toMediaId: m.id }).catch(() => null);
        if (r) toastInfo(t('%{n} clip(s) gebruiken nu "%{name}" — ⌘Z draait het terug', { n: r.replaced, name: m.name }));
      };
      item.append(swap);
    }
    item.append(del);
    item.onclick = () => { activeMediaId = m.id; if (m.type !== 'title') loadSource(m); renderBin(); };
    if (m.type === 'title') item.ondblclick = () => openTitleDialog(m);
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-media-id', m.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    list.appendChild(item);
  }
  if (!media.length) {
    list.innerHTML = '<div class="dim small" style="padding:12px">Nog geen media.<br>Sleep video/audio/afbeeldingen hierheen of klik Importeer.</div>';
  }
}

// ---------- titels ----------
let editingTitleId = null;

function initTitleDialog() {
  const dlg = document.getElementById('dlg-title');
  document.getElementById('title-cancel').onclick = () => dlg.close();
  document.getElementById('title-save').onclick = async () => {
    const args = {
      text: document.getElementById('title-text').value,
      pos: document.getElementById('title-pos').value,
      size: +document.getElementById('title-size').value,
      color: document.getElementById('title-color').value,
      bg: document.getElementById('title-bg').checked,
    };
    if (!args.text.trim()) return toast('Typ eerst tekst');
    if (editingTitleId) await api('editTitle', { mediaId: editingTitleId, ...args });
    else await api('addTitle', args);
    dlg.close();
  };
}

function openTitleDialog(media) {
  editingTitleId = media?.id ?? null;
  document.getElementById('title-dlg-head').textContent = media ? 'Titel bewerken' : 'Titel maken';
  document.getElementById('title-text').value = media?.text ?? '';
  document.getElementById('title-pos').value = media?.pos ?? 'onder';
  document.getElementById('title-size').value = media?.size ?? 64;
  document.getElementById('title-color').value = media?.color ?? '#ffffff';
  document.getElementById('title-bg').checked = media ? media.bg !== false : true;
  document.getElementById('dlg-title').showModal();
}

// ---------- voice-over ----------
function initProjectsDialog() {
  const dlg = document.getElementById('dlg-projects');
  document.getElementById('btn-projects').onclick = async () => {
    const data = await apiGet('/api/projects');
    document.getElementById('proj-current').textContent = t('— actief: %{name}', { name: data.current });
    const list = document.getElementById('proj-list');
    list.innerHTML = '';
    for (const p of data.projects) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;background:var(--bg2)';
      const when = new Date(p.mtime).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      row.innerHTML = `<b style="flex:1">${p.name}</b><span class="dim small">${when}</span>`;
      const btn = document.createElement('button');
      btn.textContent = p.current ? t('actief') : t('Open');
      btn.disabled = p.current;
      btn.onclick = async () => {
        const r = await apiPost('/api/projects/open', { name: p.name });
        if (!r.ok) return toast(r.error);
        dlg.close();
      };
      row.appendChild(btn);
      list.appendChild(row);
    }
    dlg.showModal();
  };
  document.getElementById('proj-close').onclick = () => dlg.close();
  document.getElementById('proj-saveas').onclick = async () => {
    const name = document.getElementById('proj-name').value.trim();
    if (!name) return toast('Geef een projectnaam op');
    const r = await apiPost('/api/projects/saveAs', { name });
    if (!r.ok) return toast(r.error);
    dlg.close();
  };
  document.getElementById('proj-new').onclick = async () => {
    const name = document.getElementById('proj-name').value.trim();
    if (!name) return toast('Geef een projectnaam op');
    const r = await apiPost('/api/projects/new', { name });
    if (!r.ok) return toast(r.error);
    dlg.close();
  };
  document.getElementById('proj-props').onclick = () => { dlg.close(); openProjectProps(); };
  initProjectProps();
}

// ---------- projecteigenschappen ----------
const PRESETS = { '1920x1080': [1920, 1080], '3840x2160': [3840, 2160], '1280x720': [1280, 720], '1080x1920': [1080, 1920], '1080x1080': [1080, 1080] };

async function openProjectProps() {
  const dlg = document.getElementById('dlg-props-project');
  const info = await apiGet('/api/projects/info');
  if (!info.ok) return toast('Kon projectinfo niet ophalen');
  const g = (id) => document.getElementById(id);
  g('pp-file').textContent = `— ${info.name}.json`;
  g('pp-name').value = info.name;
  g('pp-kind').value = info.meta.kind || 'video';
  g('pp-title').value = info.meta.title || '';
  g('pp-client').value = info.meta.client || '';
  g('pp-desc').value = info.meta.description || '';
  const s = info.settings;
  g('pp-w').value = s.width; g('pp-h').value = s.height;
  const key = `${s.width}x${s.height}`;
  g('pp-preset').value = PRESETS[key] ? key : 'custom';
  g('pp-fps').value = String(s.fps);
  if (![...g('pp-fps').options].some((o) => o.value === String(s.fps))) {
    const o = document.createElement('option'); o.value = String(s.fps); o.textContent = String(s.fps); g('pp-fps').appendChild(o); g('pp-fps').value = String(s.fps);
  }
  g('pp-sr').value = String(s.sampleRate || 48000);
  const st = info.stats;
  const fmtDur = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const when = (iso) => iso ? new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–';
  g('pp-stats').innerHTML = [
    [t('Duur'), fmtDur(st.duur)], [t('Clips'), `${st.clips} (${st.videoClips} video)`], [t('Media'), st.media],
    [t('Tracks'), st.tracks], [t('Open opmerkingen'), st.opmerkingenOpen], [t('Versies'), st.versies],
    [t('Aangemaakt'), when(info.meta.created)], [t('Gewijzigd'), when(st.gewijzigd)],
  ].map(([k, v]) => `<div><span class="dim">${k}</span><b>${v}</b></div>`).join('');
  dlg.showModal();
}

function initProjectProps() {
  const dlg = document.getElementById('dlg-props-project');
  const g = (id) => document.getElementById(id);
  g('pp-preset').onchange = () => {
    const p = PRESETS[g('pp-preset').value];
    if (p) { g('pp-w').value = p[0]; g('pp-h').value = p[1]; }
  };
  const custom = () => { g('pp-preset').value = PRESETS[`${g('pp-w').value}x${g('pp-h').value}`] ? `${g('pp-w').value}x${g('pp-h').value}` : 'custom'; };
  g('pp-w').oninput = custom; g('pp-h').oninput = custom;
  g('pp-cancel').onclick = () => dlg.close();
  g('pp-save').onclick = async () => {
    await api('setProjectMeta', { meta: {
      title: g('pp-title').value, client: g('pp-client').value,
      description: g('pp-desc').value, kind: g('pp-kind').value,
    } });
    await api('setSettings', { settings: {
      width: +g('pp-w').value || 1920, height: +g('pp-h').value || 1080,
      fps: +g('pp-fps').value || 30, sampleRate: +g('pp-sr').value || 48000,
    } });
    const newName = g('pp-name').value.trim();
    if (newName && newName !== S.state.projectName) {
      const r = await apiPost('/api/projects/rename', { name: newName });
      if (!r.ok) return toast(r.error);
      toastInfo(t('Project hernoemd naar "%{name}"', { name: r.name }));
    }
    dlg.close();
  };
  // ook via dubbelklik op de projectknop in de topbalk
  document.getElementById('btn-projects').ondblclick = (e) => { e.preventDefault(); openProjectProps(); };
}

// ---------- dialogen ----------
export function initDialogs() {
  initProjectsDialog();
  const dlgSet = document.getElementById('dlg-settings');
  document.getElementById('btn-settings').onclick = async () => {
    const s = S.state.settings;
    document.getElementById('set-w').value = s.width;
    document.getElementById('set-h').value = s.height;
    document.getElementById('set-fps').value = s.fps;
    document.getElementById('set-lang').value = currentLang();
    dlgSet.showModal();
  };
  document.getElementById('set-cancel').onclick = () => dlgSet.close();
  document.getElementById('set-save').onclick = async () => {
    await api('setSettings', {
      settings: {
        width: +document.getElementById('set-w').value,
        height: +document.getElementById('set-h').value,
        fps: +document.getElementById('set-fps').value,
      },
    });
    dlgSet.close();
    // taal als laatste: bij een wissel herlaadt de pagina
    const newLang = document.getElementById('set-lang').value;
    if (newLang !== currentLang()) {
      await apiPost('/api/config', { uiLanguage: newLang });
      setLanguage(newLang);
    }
  };

  const dlgExp = document.getElementById('dlg-export');
  document.getElementById('btn-export').onclick = () => {
    document.getElementById('exp-status').textContent = '';
    const presetEl = document.getElementById('exp-preset');
    if (!presetEl.dataset.touched) presetEl.value = 'mp4';
    presetEl.onchange = () => { presetEl.dataset.touched = '1'; };
    document.getElementById('exp-progress').hidden = true;
    const hasWA = !!S.state?.workArea;
    const waEl = document.getElementById('exp-workarea');
    waEl.disabled = !hasWA;
    if (!hasWA) waEl.checked = false;
    dlgExp.showModal();
  };
  document.getElementById('exp-close').onclick = () => dlgExp.close();
  document.getElementById('exp-start').onclick = async () => {
    const name = document.getElementById('exp-name').value.trim() || 'montage';
    const preset = document.getElementById('exp-preset').value;
    const bitrateM = +document.getElementById('exp-bitrate').value || undefined;
    const useWorkArea = document.getElementById('exp-workarea').checked;
    const res = await apiPost('/api/render', { name, preset, bitrateM, useWorkArea });
    if (!res.ok) return toast(res.error);
    document.getElementById('exp-progress').hidden = false;
    document.getElementById('exp-status').textContent = 'Renderen…';
    pollRender();
  };
  on('render', (e) => showRender(e.detail));
}

async function pollRender() {
  const st = await apiGet('/api/render/status');
  showRender(st);
  if (st.running) setTimeout(pollRender, 800);
}

function showRender(st) {
  const fill = document.getElementById('exp-fill');
  const status = document.getElementById('exp-status');
  document.getElementById('exp-progress').hidden = false;
  fill.style.width = `${Math.round((st.progress || 0) * 100)}%`;
  if (st.running) status.textContent = t('Renderen… %{p}%', { p: Math.round((st.progress || 0) * 100) });
  else if (st.error) status.textContent = `❌ ${st.error.split('\n')[0]}`;
  else if (st.out && st.progress >= 1) {
    const file = st.out.split('/').pop();
    status.innerHTML = `${t('✓ Klaar:')} <a href="/renders/${file}" target="_blank" style="color:var(--accent2)">${file}</a>`;
  }
}
