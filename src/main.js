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
  // 已经真的在输出 HDR 的屏，之前记下的「切不过去」记录就过期了
  const broken = cfg.hdrBroken || {};
  const stale = Object.keys(broken).filter((k) => state.displays.some((d) => d.key === k && d.hdrEnabled));
  if (stale.length) {
    for (const k of stale) delete broken[k];
    store.save({ hdrBroken: broken });
  }
  const exists = state.displays.some((d) => d.key === state.selectedKey);
  if (!exists) {
    state.selectedKey =
      (cfg.selectedKey && state.displays.find((d) => d.key === cfg.selectedKey)?.key) ||
      state.displays.find((d) => d.hdrEnabled)?.key ||
      state.displays[0]?.key ||
      null;
  }
}

// 一块屏的「亮度」有两种来源：HDR 开着时是 SDR 白点（影响 HDR 信号里的 SDR 内容），
// 没开 HDR（或根本是 SDR 屏）时是 DDC/CI 的硬件亮度。滑块统一用 0–100 表示。
function stepOf(d) {
  if (!d) return 0;
  if (d.control === 'ddc') return d.ddc?.percent ?? 100;
  return display.stepFromLevel(d.sdrLevel ?? display.LEVEL_MIN);
}

function applyStep(d, step, final = true) {
  if (!d) return null;
  if (d.control === 'ddc') {
    const pct = Math.max(0, Math.min(100, Math.round(step)));
    if (!display.writeDdc(d.gdiName, pct)) {
      console.error('DDC 亮度写入失败: ' + d.name);
      return null;
    }
    // 拖拽的中间帧不回读（DDC 一次回读又要 ~130ms），先按写入值显示
    if (!final) {
      d.ddc = { ...(d.ddc || { min: 0, max: 100 }), raw: pct, percent: pct };
      return pct;
    }
    const ddc = display.readDdc(d.gdiName);
    if (ddc) d.ddc = ddc;
    return ddc?.percent ?? pct;
  }
  if (d.control === 'none') return null;
  const { rc, level } = display.writeSdr(d.target, display.levelFromStep(step), final);
  if (rc !== 0) {
    console.error('写入 SDR 白点失败 rc=' + rc + '，目标 ' + d.name);
    return null;
  }
  d.sdrLevel = display.readSdr(d.target) ?? level;
  return display.stepFromLevel(d.sdrLevel);
}

function hudLine(d) {
  if (!d) return '';
  if (d.control === 'ddc') return `${d.name} · 硬件亮度`;
  return `${d.name} · ${display.nits(d.sdrLevel ?? display.LEVEL_MIN)} nits`;
}

function viewState() {
  return {
    displays: state.displays.map((d) => ({
      key: d.key,
      name: d.name,
      gdiName: d.gdiName,
      step: stepOf(d),
      nits: display.nits(d.sdrLevel ?? display.LEVEL_MIN),
      control: d.control,
      hdrEnabled: d.hdrEnabled,
      hdrSupported: d.hdrSupported,
      hdrBlocked: !!store.load().hdrBroken?.[d.key],
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
  const shown = applyStep(d, step, final);
  if (shown === null) return;
  broadcast();
  showHud(hudLine(d));
  return shown;
}

function nudge(delta) {
  const d = current();
  if (!d) return;
  setStep(stepOf(d) + delta, true);
}

function applyScene(id) {
  const scene = state.scenes.find((s) => s.id === id);
  if (!scene) return;
  if (!state.displays.length) refresh();
  for (const d of state.displays) {
    const v = scene.per?.[d.key] || scene;
    if (typeof v.step === 'number') applyStep(d, v.step, true);
    if (typeof v.hdr === 'boolean' && d.hdrSupported && !d.hdrBlocked && d.hdrEnabled !== v.hdr) setHdr(d, v.hdr);
  }
  setTimeout(() => {
    refresh();
    broadcast();
    showHud(`场景 · ${scene.name}`);
  }, 1400);
}

// 写 HDR 之后回头验一次：有些显示器 EDID 声称支持 HDR，实际切不过去。
// 验出来的屏记进 settings.hdrBroken，面板就把开关禁掉，不再假报。
function setHdr(d, want) {
  if (!d || !d.hdrSupported) return;
  const rc = display.writeHdr(d.target, want);
  if (rc !== 0) console.error('切换 HDR 失败 rc=' + rc);
  showHud(`${d.name} · HDR ${want ? '开' : '关'}`);
  setTimeout(() => {
    refresh();
    const after = state.displays.find((x) => x.key === d.key);
    // 有些屏 EDID 声称支持 HDR，但开了之后链路仍是 8-bit：读回说「已开启」，画面其实没变。
    // 两个信号任一命中就记进 hdrBroken，面板把开关禁掉（旁边留一个「重试」）。
    const looksFake = after && after.hdrEnabled && (after.bitsPerColor ?? 8) <= 8;
    if (want && after && (!after.hdrEnabled || looksFake)) {
      const cfg = store.load();
      store.save({ hdrBroken: { ...(cfg.hdrBroken || {}), [d.key]: true } });
      after.hdrBlocked = true;
      // 假 HDR 不开着不关：直接撤销，让这块屏回到 DDC 硬件亮度那条路
      if (looksFake) {
        display.writeHdr(after.target, false);
        showHud(`${d.name} · 没有真正切到 HDR，已回退`);
        setTimeout(() => {
          refresh();
          broadcast();
        }, 1800);
      } else {
        showHud(`${d.name} · 未能切换到 HDR`);
      }
    }
    broadcast();
  }, 1600);
}

function toggleHdr(key = state.selectedKey) {
  const d = state.displays.find((x) => x.key === key);
  if (!d || !d.hdrSupported || d.hdrBlocked) return;
  setHdr(d, !d.hdrEnabled);
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
      label: `${d.name} · HDR ${d.hdrEnabled ? '开' : '关'}${d.hdrBlocked ? '（切换无效）' : ''}`,
      type: 'checkbox',
      checked: d.hdrEnabled,
      enabled: d.hdrSupported && !d.hdrBlocked,
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
  ipcMain.handle('hdr:retry', (_e, key) => {
    const cfg = store.load();
    if (cfg.hdrBroken?.[key]) {
      const next = { ...cfg.hdrBroken };
      delete next[key];
      store.save({ hdrBroken: next });
    }
    refresh();
    const d = state.displays.find((x) => x.key === key);
    if (d) setHdr(d, !d.hdrEnabled);
    broadcast();
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
        step: stepOf(d),
        hdr: d.hdrEnabled,
      };
    }
    const first = current();
    const scenes = [
      ...cfg.scenes,
      {
        id: 'scene-' + Date.now(),
        name: name || '场景 ' + (cfg.scenes.length + 1),
        step: stepOf(first),
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
    if (process.env.SDR_DEV_CLICK) {
      await panelWin.webContents.executeJavaScript(`document.getElementById('${process.env.SDR_DEV_CLICK}').click()`);
      await new Promise((r) => setTimeout(r, 3000));
      await shot(panelWin, `panel-after-${process.env.SDR_DEV_CLICK}.png`);
    }
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

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (display.releaseDdc) display.releaseDdc();
  });
}
