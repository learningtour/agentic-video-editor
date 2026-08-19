// Meertalige interface: Nederlands is de bron, Engels en Duits zijn vertalingen.
//
// Werkwijze — dit is bewust simpel gehouden zodat het bij elke uitbreiding
// vanzelf goed blijft gaan:
//   • De NEDERLANDSE TEKST IS DE SLEUTEL. Er zijn dus geen aparte keys te verzinnen:
//     nieuwe UI-tekst schrijf je gewoon in het Nederlands, en `tool/i18n-check.mjs`
//     meldt daarna welke teksten nog geen Engelse/Duitse vertaling hebben.
//   • Alles wat in index.html staat (teksten, title-tooltips, placeholders, options)
//     wordt automatisch vertaald bij het laden. Ook nieuw toegevoegde HTML.
//   • Wat JavaScript later in de pagina zet, vangt een MutationObserver op: staat de
//     tekst in het woordenboek, dan wordt hij vertaald. Strings met variabelen gaan
//     via t('… %{n} …', {n}) — het woordenboek bevat de tekst mét placeholder.
//   • Zonder vertaling blijft het Nederlands staan; er breekt nooit iets.
//
// Taal kiezen: ⚙︎ Instellingen (bewaard in config.json als uiLanguage, en lokaal).

const dictionaries = { nl: null, en: null, de: null };
let lang = 'nl';
let dict = null; // actieve vertaaltabel (null = Nederlands)
const missing = new Set();

export const LANGS = { nl: 'Nederlands', en: 'English', de: 'Deutsch' };
export const currentLang = () => lang;

// door JS opgebouwde delen die géén interfacetekst zijn (gebruikersinhoud): daar
// vertalen we niets, ook al zou een woord toevallig in het woordenboek staan
const SKIP_SELECTOR = '.pod-script, .ts-words, .bin-name, #tl-tracks .clip, .note-text, #ver-diff, .rep-row, #pod-gap-list, .vim-list, #hud3d .label3d, code, pre, textarea, input';

export function t(nl, vars) {
  let s = (dict && dict[nl]) || nl;
  if (dict && !dict[nl] && !missing.has(nl)) { missing.add(nl); }
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`%{${k}}`).join(String(v));
  return s;
}

// Wat we zelf al geschreven hebben, onthouden we: een MutationObserver ziet ook
// onze eigen schrijfacties (zelfs als de waarde gelijk blijft), en zonder deze
// vangnetten draait hij eindeloos rond bij vertalingen als "Mute" → "Mute".
const written = new WeakMap(); // node -> laatst door ons gezette waarde

function translateText(node) {
  if (!dict) return;
  const raw = node.nodeValue;
  if (written.get(node) === raw) return;   // dit is onze eigen schrijfactie
  const key = raw.trim();
  if (!key) return;
  const tr = dict[key];
  if (!tr) return; // geen of lege vertaling: Nederlands laten staan
  // witruimte eromheen bewaren
  const lead = raw.match(/^\s*/)[0], tail = raw.match(/\s*$/)[0];
  const next = lead + tr + tail;
  written.set(node, next);
  if (next !== raw) node.nodeValue = next;  // identieke waarde niet terugschrijven
}

function translateAttrs(el) {
  if (!dict || !el.getAttribute) return;
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    const v = el.getAttribute(attr);
    if (!v) continue;
    const tr = dict[v];
    if (!tr || tr === v) continue;
    el.setAttribute(attr, tr);
  }
}

function translateTree(root) {
  if (!dict || !root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    if (!root.parentElement?.closest(SKIP_SELECTOR)) translateText(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  if (root.matches?.(SKIP_SELECTOR) || root.closest?.(SKIP_SELECTOR)) {
    // wél tooltips van knoppen binnen zulke gebieden (bijv. ✎-knop op een opmerking)
    return;
  }
  translateAttrs(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (!n.parentElement?.closest(SKIP_SELECTOR)) translateText(n);
    } else translateAttrs(n);
  }
}

let observer = null;
function observe() {
  if (observer || !dict) return;
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') for (const n of m.addedNodes) translateTree(n);
      else if (m.type === 'characterData') translateText(m.target);
      else if (m.type === 'attributes') translateAttrs(m.target);
    }
  });
  observer.observe(document.body, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['title', 'placeholder'],
  });
}

export async function initI18n() {
  // config.json is de waarheid (dan werkt een wissel via de API of vanuit een andere
  // browser ook); localStorage is alleen het vangnet als de server niet antwoordt
  let chosen = null;
  try { chosen = (await (await fetch('/api/config')).json()).uiLanguage; } catch { /* offline */ }
  if (!chosen) chosen = localStorage.getItem('uiLanguage');
  chosen = LANGS[chosen] ? chosen : 'nl';
  await setLanguage(chosen, { reload: false });
}

export async function setLanguage(code, { reload = true } = {}) {
  if (!LANGS[code]) code = 'nl';
  localStorage.setItem('uiLanguage', code);
  if (reload && code !== lang) { location.reload(); return; }
  lang = code;
  document.documentElement.lang = code;
  if (code === 'nl') { dict = null; return; }
  if (!dictionaries[code]) {
    try { dictionaries[code] = await (await fetch(`/i18n/${code}.json`)).json(); }
    catch { dictionaries[code] = {}; }
  }
  dict = dictionaries[code];
  translateTree(document.body);
  observe();
}

// voor het checkscript en debuggen: welke Nederlandse teksten miste de vertaling
export const missingKeys = () => [...missing];
if (typeof window !== 'undefined') window.__i18nMissing = missingKeys;
