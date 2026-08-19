// Versiegeschiedenis in de UI: bewaren, vergelijken met nu, terugzetten.
// De server (server/versions.js) bewaart hele momentopnamen; terugzetten bewaart eerst
// automatisch de huidige stand, en is bovendien met ⌘Z ongedaan te maken.
import { apiGet, apiPost, toast, toastInfo } from './app.js';
import { t } from './i18n.js';

const el = (id) => document.getElementById(id);

export function initVersions() {
  const dlg = el('dlg-versions');
  el('btn-versions').onclick = async () => {
    el('ver-diff').hidden = true;
    el('ver-message').value = '';
    await vul();
    dlg.showModal();
  };
  el('ver-close').onclick = () => dlg.close();
  el('ver-message').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); bewaar(); }
  });
  el('ver-commit').onclick = bewaar;
}

async function bewaar() {
  const message = el('ver-message').value.trim();
  if (!message) return toast('Geef kort aan wat er veranderd is');
  const r = await apiPost('/api/versions/commit', { message });
  if (!r.ok) return toast(r.error);
  el('ver-message').value = '';
  toastInfo('Versie bewaard');
  vul();
}

async function vul() {
  const r = await apiGet('/api/versions?format=json');
  el('ver-project').textContent = `— project "${r.current}"`;
  const lijst = el('ver-list');
  lijst.innerHTML = '';
  if (!r.versions?.length) {
    lijst.innerHTML = '<div class="small dim" style="padding:8px">Nog geen versies bewaard. Doe dat vóór een grote ingreep, dan kun je altijd terug.</div>';
    return;
  }
  for (const v of r.versions) {
    const d = document.createElement('div');
    d.className = 'ver-item' + (v.auto ? ' auto' : '');
    const t = new Date(v.time).toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    d.innerHTML = `<div class="ver-head"><b></b><span class="dim small">${t}${v.auto ? ' · automatisch' : ''}</span></div>` +
      `<div class="dim small">${v.stats.duur.toFixed(1)}s · ${v.stats.clips} clips · ${v.stats.media} media · ${v.stats.openOpmerkingen} open opmerkingen</div>` +
      '<div class="ver-btns"></div>';
    d.querySelector('b').textContent = v.message;

    const btns = d.querySelector('.ver-btns');
    const verschil = document.createElement('button');
    verschil.textContent = 'Vergelijk met nu';
    verschil.onclick = async () => {
      const res = await fetch(`/api/versions/diff?a=${encodeURIComponent(v.id)}&b=nu`);
      const tekst = await res.text();
      el('ver-diff').hidden = false;
      el('ver-diff').textContent = `Van "${v.message}" naar nu:\n\n${tekst}`;
      el('ver-diff').scrollIntoView({ block: 'nearest' });
    };
    const terug = document.createElement('button');
    terug.textContent = 'Terugzetten';
    terug.onclick = async () => {
      if (!confirm(`Terug naar "${v.message}" (${t})?\n\nDe huidige montage wordt eerst automatisch als versie bewaard, en ⌘Z draait het terug.`)) return;
      const res = await apiPost('/api/versions/restore', { id: v.id });
      if (!res.ok) return toast(res.error);
      toastInfo(t('Teruggezet naar "%{msg}"', { msg: v.message }));
      el('ver-diff').hidden = true;
      vul();
    };
    btns.append(verschil, terug);
    lijst.appendChild(d);
  }
}
