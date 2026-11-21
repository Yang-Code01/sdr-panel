'use strict';
const path = require('path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  nativeTheme,
  globalShortcut,
  shell,
} = require('electron');

const display = require('./display');
const store = require('./store');
const { combos } = require('./keys');

const PANEL_SIZE = { width: 380, height: 516 };
const HUD_SIZE = { width: 258, height: 62 };

const state = {
  displays: [],
  selectedKey: null,
  scenes: [],
  hudTimer: null,
  hotkeyLabel: 'Ctrl + Alt + ↑↓',
};

let activeCombos = combos({ shift: 'any' });

let panelWin = null;
let hudWin = null;
let tray = null;
let panelFocused = false;

const current = () => state.displays.find((d) => d.key === state.selectedKey) || state.displays[0] || null;

function refresh() {
  try {
    state.displays = display.listDisplays();
  } catch (err) {
    console.error('枚举显示器失败', err);
    state.displays = [];
  }
  const cfg = store.load();
  state.scenes = cfg.scenes || [];
  const exists = state.displays.some((d) => d.key === state.selectedKey);
  if (!exists) {
    state.selectedKey =
      (cfg.selectedKey && state.displays.find((d) => d.key === cfg.selectedKey)?.key) ||
      state.displays.find((d) => d.hdrEnabled)?.key ||
      state.displays[0]?.key ||
      null;
  }
}

function viewState() {
  return {
    displays: state.displays.map((d) => ({
      key: d.key,
      name: d.name,
      gdiName: d.gdiName,
      step: display.stepFromLevel(d.sdrLevel ?? display.LEVEL_MIN),
      nits: display.nits(d.sdrLevel ?? display.LEVEL_MIN),
      hdrEnabled: d.hdrEnabled,
      hdrSupported: d.hdrSupported,
      hdrForcedOff: d.hdrForcedOff,
      bitsPerColor: d.bitsPerColor,
      selected: d.key === state.selectedKey,
    })),
    selectedKey: state.selectedKey,
    scenes: state.scenes,
    dark: nativeTheme.shouldUseDarkColors,
    hotkeyLabel: state.hotkeyLabel,
  };
}

function broadcast() {
  for (const win of [panelWin, hudWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('state:changed', viewState());
  }
  refreshTrayMenu();
}

// ---------------------------------------------------------------- HUD
function hudDisplay() {
  const point = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(point);
}

function showHud(text) {
  const d = current();
  if (!hudWin) return;
  const area = hudDisplay().bounds;
  hudWin.setBounds({
    x: Math.round(area.x + (area.width - HUD_SIZE.width) / 2),
    y: area.y + 18,
    width: HUD_SIZE.width,
    height: HUD_SIZE.height,
  });
  hudWin.webContents.send('hud:show', {
    ...viewState(),
    line: text,
  });
  if (!hudWin.isVisible()) hudWin.showInactive();
  clearTimeout(state.hudTimer);
  state.hudTimer = setTimeout(() => {
    if (hudWin && !hudWin.isDestroyed()) hudWin.hide();
  }, 1500);
  if (d) hudWin.webContents.send('state:changed', viewState());
}

// ---------------------------------------------------------------- actions
function setStep(step, final = true) {
  const d = current();
  if (!d) return;
  const { rc, level } = display.writeSdr(d.target, display.levelFromStep(step), final);
  if (rc !== 0) {
    console.error('写入 SDR 白点失败 rc=' + rc + '，目标 ' + d.name);
    return;
  }
  d.sdrLevel = display.readSdr(d.target) ?? level;
  const shown = display.stepFromLevel(d.sdrLevel);
  broadcast();
  showHud(`${d.name} · ${display.nits(d.sdrLevel)} nits`);
  return shown;
}

function nudge(delta) {
  const d = current();
  if (!d) return;
  const step = display.stepFromLevel(d.sdrLevel ?? display.LEVEL_MIN);
  setStep(step + delta, true);
}

function applyScene(id) {
  const scene = state.scenes.find((s) => s.id === id);
  if (!scene) return;
  if (!state.displays.length) refresh();
  for (const d of state.displays) {
    const v = scene.per?.[d.key] || scene;
    if (typeof v.step === 'number') display.writeSdr(d.target, display.levelFromStep(v.step), true);
    if (typeof v.hdr === 'boolean' && d.hdrSupported && d.hdrEnabled !== v.hdr) display.writeHdr(d.target, v.hdr);
  }
  setTimeout(() => {
    refresh();
    broadcast();
    showHud(`场景 · ${scene.name}`);
  }, 1400);
}

function toggleHdr(key = state.selectedKey) {
  const d = state.displays.find((x) => x.key === key);
  if (!d || !d.hdrSupported) return;
  const rc = display.writeHdr(d.target, !d.hdrEnabled);
  if (rc !== 0) console.error('切换 HDR 失败 rc=' + rc);
  showHud(`${d.name} · HDR ${d.hdrEnabled ? '关' : '开'}`);
  setTimeout(() => {
    refresh();
    broadcast();
  }, 1600);
}

// ---------------------------------------------------------------- windows
function createPanel() {
  panelWin = new BrowserWindow({
    ...PANEL_SIZE,
    show: false,
    alwaysOnTop: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    roundedCorners: true,
    backgroundColor: process.env.SDR_PLAIN ? '#2b2b2e' : '#00000000',
    backgroundMaterial: !process.env.SDR_PLAIN && process.platform === 'win32' ? 'acrylic' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  panelWin.loadFile(path.join(__dirname, 'renderer', 'panel.html'));
  panelWin.on('blur', () => {
    if (process.env.SDR_NO_AUTOHIDE === '1') return;
    // 只有真的拿到过焦点才自动收起：自动弹出（前台锁定）时不该一显示就消失
    if (!panelFocused) return;
    panelFocused = false;
    if (!panelWin.webContents.isDevToolsOpened()) panelWin.hide();
  });
  panelWin.on('focus', () => {
    panelFocused = true;
  });
  panelWin.on('closed', () => {
    panelWin = null;
  });
}

function createHud() {
  hudWin = new BrowserWindow({
    ...HUD_SIZE,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  hudWin.setAlwaysOnTop(true, 'screen-saver');
  hudWin.setIgnoreMouseEvents(true);
  hudWin.loadFile(path.join(__dirname, 'renderer', 'hud.html'));
  hudWin.on('closed', () => {
    hudWin = null;
  });
}

function positionPanel() {
  if (process.env.SDR_PANEL_AT) {
    const [px, py] = process.env.SDR_PANEL_AT.split(',').map(Number);
    panelWin.setBounds({ x: px, y: py, ...PANEL_SIZE });
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const x = Math.round(area.x + area.width - PANEL_SIZE.width - 14);
  const y = Math.round(area.y + area.height - PANEL_SIZE.height - 14);
  panelWin.setBounds({ x, y, ...PANEL_SIZE });
}

function togglePanel() {
  if (!panelWin) createPanel();
  if (panelWin.isVisible()) {
    panelWin.hide();
    return;
  }
  refresh();
  positionPanel();
  panelFocused = false;
  panelWin.showInactive();
  panelWin.focus();
  panelWin.webContents.send('state:changed', viewState());
}

function refreshTrayMenu() {
  if (!tray) return;
  const template = [
    { label: '打开控制面板', click: () => togglePanel() },
    { type: 'separator' },
  ];
  for (const d of state.displays) {
    template.push({
      label: `${d.name} · HDR ${d.hdrEnabled ? '开' : '关'}`,
      type: 'checkbox',
      checked: d.hdrEnabled,
      enabled: d.hdrSupported,
      click: () => toggleHdr(d.key),
    });
  }
  template.push({ type: 'separator' }, { label: '场景', enabled: false });
  for (const s of state.scenes) {
    template.push({ label: s.name, click: () => applyScene(s.id) });
  }
  template.push(
    { type: 'separator' },
    { label: 'Windows HDR 设置', click: () => shell.openExternal('ms-settings:display-advanced') },
    { label: '退出', click: () => app.quit() }
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const iconFile = nativeTheme.shouldUseDarkColors ? 'tray-dark.png' : 'tray-light.png';
  tray = new Tray(path.join(__dirname, '..', 'build', iconFile));
  tray.setToolTip('SDR 亮度');
  refreshTrayMenu();
  tray.on('click', () => togglePanel());
  nativeTheme.on('updated', () => {
    const next = nativeTheme.shouldUseDarkColors ? 'tray-dark.png' : 'tray-light.png';
    try {
      tray.setImage(path.join(__dirname, '..', 'build', next));
    } catch (err) {
      console.error(err);
    }
    broadcast();
  });
}

// ---------------------------------------------------------------- hotkeys
const poll = {};
for (const name of ['up', 'down', 'scene1', 'scene2', 'scene3']) poll[name] = { held: false, fired: false, next: 0 };

function act(name) {
  if (process.env.SDR_TRACE === '1') console.log('[act]', name, 'sel', state.selectedKey);
  if (name === 'up') nudge(5);
  else if (name === 'down') nudge(-5);
  else if (name.startsWith('scene')) applyScene(state.scenes[Number(name.slice(5)) - 1]?.id);
}

// 加速器和轮询都会看到同一次按下，用 60ms 去重让「先到的那一个」生效。
const lastFire = {};
function fire(name) {
  const now = Date.now();
  if (now - (lastFire[name] || 0) < 60) return;
  lastFire[name] = now;
  act(name);
}

function bindAccelerators(map) {
  let ok = true;
  for (const [accel, name] of Object.entries(map)) {
    const registered = globalShortcut.register(accel, () => {
      const st = poll[name];
      st.held = true;
      st.fired = true;
      st.next = Date.now() + 380;
      fire(name);
    });
    if (!registered) {
      console.warn('热键注册失败', accel);
      ok = false;
    }
  }
  return ok;
}

function pollKeys() {
  const now = Date.now();
  for (const name of Object.keys(poll)) {
    const down = activeCombos[name]();
    const st = poll[name];
    if (down && !st.held) {
      if (process.env.SDR_TRACE === '1') console.log('[poll] down', name);
      st.held = true;
      st.fired = true;
      st.next = now + 380;
      fire(name);
    } else if (!down && st.held) {
      st.held = false;
      st.fired = false;
    } else if (down && st.held && st.fired && now > st.next) {
      st.next = now + 90;
      act(name);
    }
  }
}

function registerHotkeys() {
  const scenes = { 'Alt+1': 'scene1', 'Alt+2': 'scene2', 'Alt+3': 'scene3' };
  const primary = { 'Control+Alt+Up': 'up', 'Control+Alt+Down': 'down', ...scenes };
  const fallback = { 'Control+Shift+Alt+Up': 'up', 'Control+Shift+Alt+Down': 'down', ...scenes };
  if (!bindAccelerators(primary)) {
    globalShortcut.unregisterAll();
    state.hotkeyLabel = 'Ctrl + Shift + Alt + ↑↓';
    bindAccelerators(fallback);
  }
  setInterval(pollKeys, 55);
}

// ---------------------------------------------------------------- ipc
function registerIpc() {
  ipcMain.handle('state:get', () => {
    refresh();
    return viewState();
  });
  ipcMain.handle('sdr:set', (_e, step, final) => {
    const shown = setStep(step, final !== false);
    return { step: shown, state: viewState() };
  });
  ipcMain.handle('display:select', (_e, key) => {
    state.selectedKey = key;
    store.save({ selectedKey: key });
    broadcast();
    return viewState();
  });
  ipcMain.handle('hdr:toggle', (_e, key) => {
    toggleHdr(key);
    return true;
  });
  ipcMain.handle('scene:apply', (_e, id) => {
    applyScene(id);
    return true;
  });
  ipcMain.handle('scene:save', (_e, name) => {
    const cfg = store.load();
    const per = {};
    for (const d of state.displays) {
      per[d.key] = {
        step: display.stepFromLevel(d.sdrLevel ?? display.LEVEL_MIN),
        hdr: d.hdrEnabled,
      };
    }
    const first = current();
    const scenes = [
      ...cfg.scenes,
      {
        id: 'scene-' + Date.now(),
        name: name || '场景 ' + (cfg.scenes.length + 1),
        step: display.stepFromLevel(first?.sdrLevel ?? display.LEVEL_MIN),
        hdr: !!first?.hdrEnabled,
        per,
      },
    ];
    store.save({ scenes });
    refresh();
    broadcast();
    return viewState();
  });
  ipcMain.handle('scene:delete', (_e, id) => {
    const cfg = store.load();
    store.save({ scenes: cfg.scenes.filter((s) => s.id !== id) });
    refresh();
    broadcast();
    return viewState();
  });
  ipcMain.handle('panel:hide', () => {
    if (panelWin) panelWin.hide();
  });
  ipcMain.handle('hud:hide', () => {
    if (hudWin) hudWin.hide();
  });
}


// ---------------------------------------------------------------- dev harness
// SDR_DEV=1：把面板和 HUD 各自截图到临时目录，方便在没有第二个屏幕的环境里看效果。
function devHarness() {
  const fs = require('fs');
  const os = require('os');
  const shot = async (win, name) => {
    const img = await win.webContents.capturePage();
    const file = path.join(os.tmpdir(), name);
    fs.writeFileSync(file, img.toPNG());
    console.log('[dev] wrote', file, JSON.stringify(img.getSize()));
  };
  setTimeout(() => togglePanel(), 900);
  setTimeout(async () => {
    console.log('[dev] displays', JSON.stringify(screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, sf: d.scaleFactor }))));
    if (process.env.SDR_DEV_BG === '1') {
      await panelWin.webContents.executeJavaScript(
        "document.documentElement.style.background='linear-gradient(150deg,#20303f 0%,#48546b 42%,#8a6b5a 72%,#c2a07a 100%)'"
      );
    }
    if (process.env.SDR_DEV_THEME) {
      const dark = process.env.SDR_DEV_THEME === 'dark';
      await panelWin.webContents.executeJavaScript(`document.body.classList.toggle('dark', ${dark})`);
      await new Promise((r) => setTimeout(r, 120));
      await shot(panelWin, `panel-${process.env.SDR_DEV_THEME}.png`);
    } else {
      console.log('[dev] n-style', await panelWin.webContents.executeJavaScript("(() => { const el = document.querySelector('.n'); const cs = getComputedStyle(el); return JSON.stringify({ c: cs.color, w: cs.fontWeight, f: cs.fontSize, body: getComputedStyle(document.body).color, cls: document.body.className }); })()"));
    await shot(panelWin, 'panel-self.png');
    }
    showHud();
    setTimeout(() => shot(hudWin, 'hud-self.png'), 350);
  }, 2200);
}

// ---------------------------------------------------------------- lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => togglePanel());

  app.whenReady().then(() => {
    app.setAppUserModelId('com.yqm.sdrpanel');
    refresh();
    registerIpc();
    createTray();
    createPanel();
    createHud();
    registerHotkeys();
    nativeTheme.on('updated', broadcast);
    if (process.env.SDR_SHOW_PANEL === '1') setTimeout(() => togglePanel(), 900);
    if (process.env.SDR_DEV === '1') devHarness();
  });

  app.on('window-all-closed', (e) => {
    e.preventDefault?.();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}
