// Opmerkingen bij een tijdstip (review), in de geest van Vimeo Review:
// N pauzeert en zet een opmerking op de playhead; klikken op een opmerking springt erheen.
// Claude leest ze via GET /api/notes en verwerkt ze.
import { S, api, on, setPlayhead, fmtTC } from './app.js';

export function initNotes() {
  const input = document.getElementById('note-text');
  const knop = document.getElementById('note-add');
  const tijd = document.getElementById('note-time');

  const toon = () => { tijd.textContent = fmtTC(S.playhead, S.state?.settings.fps || 30); };
  on('playhead', toon);
  on('state', renderNotes);
  toon();

  const plaats = async () => {
    const text = input.value.trim();
    if (!text) return;
    await api('addNote', { time: S.playhead, text });
    input.value = '';
    input.blur();
  };
  knop.onclick = plaats;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); plaats(); }
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
    e.stopPropagation();   // sneltoetsen van de editor niet laten meeluisteren
  });

  document.getElementById('note-filter').onchange = renderNotes;
}

// Opmerking beginnen op de huidige positie (sneltoets N): pauzeren en tab openen
export function startNote() {
  S.player?.pause();
  document.querySelector('[data-tab="notes"]')?.click();
  const input = document.getElementById('note-text');
  input.focus();
}

// id van de opmerking die nu bewerkt wordt (null = geen), plus het concept en de cursorpositie
// zodat een tussentijdse state-update (WebSocket) het typen niet weggooit
let bewerkt = null;
let concept = null;
let caret = null;

export function renderNotes() {
  const lijst = document.getElementById('note-list');
  if (!lijst || !S.state) return;
  const alleen = document.getElementById('note-filter').checked;
  const notes = (S.state.notes ?? []).filter((n) => !alleen || !n.done);
  const open = (S.state.notes ?? []).filter((n) => !n.done).length;
  document.getElementById('note-count').textContent =
    (S.state.notes ?? []).length ? `${open} open · ${(S.state.notes ?? []).length} totaal` : 'nog geen opmerkingen';

  lijst.innerHTML = '';
  for (const n of notes) {
    const el = document.createElement('div');
    el.className = 'note' + (n.done ? ' done' : '');

    const vink = document.createElement('input');
    vink.type = 'checkbox';
    vink.checked = !!n.done;
    vink.title = 'Afgehandeld';
    vink.onclick = (e) => { e.stopPropagation(); api('editNote', { noteId: n.id, done: vink.checked }); };

    const body = document.createElement('div');
    body.className = 'note-body';
    body.innerHTML = `<div class="note-head"><b>${fmtTC(n.time, S.state.settings.fps)}</b>` +
      `<span class="dim small">${n.author || ''}</span></div>` +
      `<div class="note-text"></div>` +
      (n.antwoord ? `<div class="note-answer">↳ ${escapeHtml(n.antwoord)}</div>` : '');
    body.querySelector('.note-text').textContent = n.text;
    body.onclick = () => { S.player?.pause(); setPlayhead(n.time); };
    body.ondblclick = (e) => { e.stopPropagation(); startEdit(n.id); };

    const wijzig = document.createElement('button');
    wijzig.className = 'note-edit';
    wijzig.textContent = '✎';
    wijzig.title = 'Bewerk opmerking (of dubbelklik op de tekst)';
    wijzig.onclick = (e) => { e.stopPropagation(); startEdit(n.id); };

    const del = document.createElement('button');
    del.className = 'note-del';
    del.textContent = '✕';
    del.title = 'Verwijder opmerking';
    del.onclick = (e) => { e.stopPropagation(); api('removeNote', { noteId: n.id }); };

    if (bewerkt === n.id) maakBewerkvorm(el, body, n);
    el.append(vink, body, wijzig, del);
    lijst.appendChild(el);
  }
  if (!notes.length) {
    lijst.innerHTML = '<div class="dim small" style="padding:10px">Geen opmerkingen. Druk op <b>N</b> tijdens het kijken om er een te plaatsen op de huidige tijd.</div>';
  }
}

function startEdit(id) {
  bewerkt = id;
  concept = null;   // concept van een vorige opmerking niet meenemen
  caret = null;
  renderNotes();
}

// Bewerkvorm binnen een opmerking: tekst aanpassen, tijd naar playhead, bewaren/annuleren.
// Het concept blijft staan als de state ondertussen ververst (WebSocket → renderNotes).
function maakBewerkvorm(el, body, n) {
  el.classList.add('editing');
  body.onclick = (e) => e.stopPropagation();
  body.ondblclick = null;

  const veld = document.createElement('textarea');
  veld.className = 'note-editor';
  veld.rows = 3;
  veld.value = concept ?? n.text;
  veld.spellcheck = true;
  body.querySelector('.note-text').replaceWith(veld);

  let tijd = null;   // nieuwe tijd als de gebruiker die verzet

  const bewaar = async () => {
    const text = veld.value.trim();
    const args = { noteId: n.id };
    if (text && text !== n.text) args.text = text;
    if (tijd !== null) args.time = tijd;
    stop();
    if (args.text !== undefined || args.time !== undefined) await api('editNote', args);
    else renderNotes();
  };
  const stop = () => { bewerkt = null; concept = null; caret = null; };

  const onthoud = () => { concept = veld.value; caret = veld.selectionStart; };
  veld.oninput = onthoud;
  veld.onkeyup = onthoud;
  veld.onclick = (e) => { e.stopPropagation(); onthoud(); };
  veld.addEventListener('keydown', (e) => {
    e.stopPropagation();   // sneltoetsen van de editor niet laten meeluisteren
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); bewaar(); }
    if (e.key === 'Escape') { e.preventDefault(); stop(); renderNotes(); }
  });

  const rij = document.createElement('div');
  rij.className = 'note-edit-row';

  const ok = document.createElement('button');
  ok.className = 'accent';
  ok.textContent = 'Bewaar';
  ok.onclick = (e) => { e.stopPropagation(); bewaar(); };

  const nee = document.createElement('button');
  nee.textContent = 'Annuleer';
  nee.onclick = (e) => { e.stopPropagation(); stop(); renderNotes(); };

  const naar = document.createElement('button');
  naar.textContent = '⏱ playhead';
  naar.title = 'Zet deze opmerking op de huidige playhead-positie';
  naar.onclick = (e) => {
    e.stopPropagation();
    tijd = S.playhead;
    body.querySelector('.note-head b').textContent = fmtTC(tijd, S.state.settings.fps);
    naar.textContent = '⏱ verzet';
  };

  rij.append(ok, nee, naar);
  body.appendChild(rij);

  // focus terugzetten na een her-render (state-update tijdens het typen)
  requestAnimationFrame(() => {
    veld.focus();
    const p = caret ?? veld.value.length;
    veld.setSelectionRange(p, p);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
