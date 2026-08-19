// Agentic Video Editor — desktop-app (Electron).
// Start de server (als die nog niet draait) en opent het editorvenster.
const { app, BrowserWindow, Menu, clipboard, screen, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 4720;
const URL = `http://localhost:${PORT}`;
let serverProc = null; // alleen killen wat we zelf gestart hebben

function ping(cb) {
  http.get(`${URL}/api/state`, (res) => { res.resume(); cb(res.statusCode === 200); })
    .on('error', () => cb(false));
}

// kleine POST naar de eigen server (schermopname aansturen, toegangsstatus melden)
function postJson(pathname, body, cb) {
  const data = JSON.stringify(body || {});
  const req = http.request(`${URL}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
    let out = '';
    res.on('data', (d) => { out += d; });
    res.on('end', () => { try { cb?.(null, JSON.parse(out)); } catch { cb?.(null, {}); } });
  });
  req.on('error', (e) => cb?.(e));
  req.end(data);
}

function ensureServer(done) {
  ping((ok) => {
    if (ok) return done();
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT) },
      stdio: 'ignore',
    });
    const t0 = Date.now();
    (function wait() {
      ping((ok2) => {
        if (ok2) return done();
        if (Date.now() - t0 > 15000) return done(); // venster toont dan zelf de fout
        setTimeout(wait, 300);
      });
    })();
  });
}

function createWindow() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;

  const win = new BrowserWindow({
    x, y, width, height,
    backgroundColor: '#141414',
    title: 'Agentic Video Editor',
    show: false,
    webPreferences: { spellcheck: true },
  });

  // macOS gebruikt de spellingchecker van het systeem (taal volgt de systeeminstelling)
  if (process.platform !== 'darwin') {
    try { win.webContents.session.setSpellCheckerLanguages(['nl', 'en-US']); } catch { /* taal niet beschikbaar */ }
  }
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.loadURL(URL);

  // links (zoals de export-download) buiten de app openen
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  contextMenu(win.webContents);
}

// Electron heeft géén ingebouwd rechtermuismenu: zelf bouwen, inclusief de
// spellingsuggesties achter het rode kringellijntje.
function contextMenu(webContents) {
  webContents.on('context-menu', (_e, params) => {
    const items = [];
    const f = params.editFlags;

    if (params.misspelledWord) {
      for (const woord of params.dictionarySuggestions) {
        items.push({ label: woord, click: () => webContents.replaceMisspelling(woord) });
      }
      if (!params.dictionarySuggestions.length) {
        items.push({ label: 'Geen spellingsuggesties', enabled: false });
      }
      items.push({ type: 'separator' });
      items.push({
        label: 'Leer spelling',
        click: () => webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      items.push({ type: 'separator' });
    }

    if (params.isEditable || params.selectionText) {
      items.push(
        { role: 'cut', enabled: params.isEditable && f.canCut },
        { role: 'copy', enabled: f.canCopy },
        { role: 'paste', enabled: params.isEditable && f.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: params.isEditable },
      );
    }

    if (params.linkURL) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ label: 'Link openen in browser', click: () => shell.openExternal(params.linkURL) });
      items.push({ label: 'Link kopiëren', click: () => clipboard.writeText(params.linkURL) });
    }

    if (items.length) items.push({ type: 'separator' });
    items.push({ label: 'Inspecteren', click: () => webContents.inspectElement(params.x, params.y) });

    Menu.buildFromTemplate(items).popup();
  });
}

// menu zónder Undo/Redo-accelerators: ⌘Z/⇧⌘Z moeten naar de editor zelf
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Agentic Video Editor',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Bewerken',
      submenu: [
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'Beeld',
      submenu: [
        { role: 'reload' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      ],
    },
    { label: 'Venster', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ]));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    buildMenu();
    ensureServer(() => {
      createWindow();
    });
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
}

app.on('window-all-closed', () => app.quit());
app.on('quit', () => { if (serverProc) serverProc.kill(); });
