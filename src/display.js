'use strict';
// 与 Windows 显示栈直连的薄封装：全部基于 user32!QueryDisplayConfig + DisplayConfig*DeviceInfo。
// 读 SDR 白点用公开枚举 11；写用未公开的私有枚举 0xFFFFFFEE（Twinkle Tray / HDRTray 同款做法）。
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const QueryDisplayConfig = user32.func(
  'long __stdcall QueryDisplayConfig(uint32 flags, _Inout_ uint32 *numPaths, uint8_t *paths, ' +
    '_Inout_ uint32 *numModes, uint8_t *modes, void *topology)'
);
const DisplayConfigGetDeviceInfo = user32.func('long __stdcall DisplayConfigGetDeviceInfo(void *info)');
const DisplayConfigSetDeviceInfo = user32.func('long __stdcall DisplayConfigSetDeviceInfo(void *info)');

const QDC_ALL_PATHS = 0x1;
const QDC_VIRTUAL_MODE_AWARE = 0x10;
const PATH_ACTIVE = 0x1;

const TYPE = {
  GET_TARGET_NAME: 2,
  GET_SOURCE_NAME: 1,
  GET_ADVANCED_COLOR_INFO: 9,
  SET_ADVANCED_COLOR_STATE: 10,
  GET_SDR_WHITE_LEVEL: 11,
  SET_HDR_STATE: 16,
  SET_SDR_WHITE_LEVEL: 0xffffffee, // 私有枚举，签名必须按 int32 写
};

const SIZE = {
  header: 20,
  targetName: 420,
  sourceName: 84,
  sdrWhiteLevel: 24,
  setSdrWhiteLevel: 28, // header + ULONG + BYTE，按 4 字节对齐
  advancedColorInfo: 32,
  setAdvancedColorState: 24,
};

// 滑块 0..100 ↔ white level 1000..6000（80..480 nits，50 一跳）
const LEVEL_MIN = 1000;
const LEVEL_STEP = 50;
const LEVEL_MAX = LEVEL_MIN + 100 * LEVEL_STEP;

const CAPACITY = 1024;

function queryActivePaths() {
  const nPaths = [CAPACITY];
  const nModes = [CAPACITY];
  const paths = Buffer.alloc(72 * CAPACITY);
  const modes = Buffer.alloc(64 * CAPACITY);
  const rc = QueryDisplayConfig(QDC_ALL_PATHS | QDC_VIRTUAL_MODE_AWARE, nPaths, paths, nModes, modes, null);
  if (rc !== 0) throw new Error('QueryDisplayConfig 失败 rc=' + rc);

  const out = [];
  for (let i = 0; i < nPaths[0]; i++) {
    const p = i * 72;
    const flags = paths.readUInt32LE(p + 68);
    const t = p + 20;
    const targetAvailable = paths.readInt32LE(t + 40);
    if (!(flags & PATH_ACTIVE) || !targetAvailable) continue;
    out.push({
      source: {
        low: paths.readUInt32LE(p),
        high: paths.readInt32LE(p + 4),
        id: paths.readUInt32LE(p + 8),
      },
      target: {
        low: paths.readUInt32LE(t),
        high: paths.readInt32LE(t + 4),
        id: paths.readUInt32LE(t + 8),
      },
    });
  }
  return out;
}

function packet(type, size, luid, id) {
  const buf = Buffer.alloc(size);
  buf.writeUInt32LE(type >>> 0, 0); // 私有枚举 0xFFFFFFEE 超出 int32 正范围
  buf.writeUInt32LE(size, 4);
  buf.writeUInt32LE(luid.low, 8);
  buf.writeInt32LE(luid.high, 12);
  buf.writeUInt32LE(id, 16);
  return buf;
}

function getTargetName(target) {
  const buf = packet(TYPE.GET_TARGET_NAME, SIZE.targetName, target, target.id);
  if (DisplayConfigGetDeviceInfo(buf) !== 0) return { friendly: null, devicePath: null };
  const readWstr = (offset, maxBytes) => {
    let end = offset;
    const limit = offset + maxBytes;
    while (end < limit && buf.readUInt16LE(end) !== 0) end += 2;
    return buf.toString('utf16le', offset, end);
  };
  return {
    friendly: readWstr(36, 128),
    devicePath: readWstr(164, 256),
  };
}

function getSourceName(source) {
  const buf = packet(TYPE.GET_SOURCE_NAME, SIZE.sourceName, source, source.id);
  if (DisplayConfigGetDeviceInfo(buf) !== 0) return null;
  let end = 20;
  while (end < 84 && buf.readUInt16LE(end) !== 0) end += 2;
  return buf.toString('utf16le', 20, end);
}

function readSdr(target) {
  const buf = packet(TYPE.GET_SDR_WHITE_LEVEL, SIZE.sdrWhiteLevel, target, target.id);
  if (DisplayConfigGetDeviceInfo(buf) !== 0) return null;
  return buf.readUInt32LE(20);
}

function writeSdr(target, level, final) {
  const clamped = Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, Math.round(level / LEVEL_STEP) * LEVEL_STEP));
  const buf = packet(TYPE.SET_SDR_WHITE_LEVEL, SIZE.setSdrWhiteLevel, target, target.id);
  buf.writeUInt32LE(clamped, 20);
  buf.writeUInt8(final ? 1 : 0, 24);
  const rc = DisplayConfigSetDeviceInfo(buf);
  return { rc, level: clamped };
}

function readAdvancedColor(target) {
  const buf = packet(TYPE.GET_ADVANCED_COLOR_INFO, SIZE.advancedColorInfo, target, target.id);
  if (DisplayConfigGetDeviceInfo(buf) !== 0) return null;
  const flags = buf.readUInt32LE(20);
  return {
    supported: !!(flags & 0x1),
    enabled: !!(flags & 0x2),
    wideColorEnforced: !!(flags & 0x4),
    forcedOff: !!(flags & 0x8),
    bitsPerColor: buf.readUInt32LE(28),
  };
}

function writeHdr(target, on) {
  // 优先用 Win10 1903+ 的 SET_HDR_STATE(16)，失败退回 SET_ADVANCED_COLOR_STATE(10)
  let buf = packet(TYPE.SET_HDR_STATE, SIZE.setAdvancedColorState, target, target.id);
  buf.writeUInt32LE(on ? 1 : 0, 20);
  let rc = DisplayConfigSetDeviceInfo(buf);
  if (rc !== 0) {
    buf = packet(TYPE.SET_ADVANCED_COLOR_STATE, SIZE.setAdvancedColorState, target, target.id);
    buf.writeUInt32LE(on ? 1 : 0, 20);
    rc = DisplayConfigSetDeviceInfo(buf);
  }
  return rc;
}

function listDisplays() {
  const paths = queryActivePaths();
  const seen = new Set();
  const out = [];
  paths.forEach((p, index) => {
    const { friendly, devicePath } = getTargetName(p.target);
    const key = devicePath || `${p.target.low}:${p.target.id}:${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    const color = readAdvancedColor(p.target);
    out.push({
      key,
      index: out.length,
      name: friendly || '显示器',
      gdiName: getSourceName(p.source),
      target: p.target,
      targetId: p.target.id,
      sdrLevel: readSdr(p.target),
      hdrSupported: !!(color && color.supported),
      hdrEnabled: !!(color && color.enabled),
      hdrForcedOff: !!(color && color.forcedOff),
      bitsPerColor: color ? color.bitsPerColor : null,
    });
  });
  return out;
}

function nits(level) {
  return level == null ? null : Math.round((level * 80) / 1000);
}

module.exports = {
  LEVEL_MIN,
  LEVEL_STEP,
  LEVEL_MAX,
  listDisplays,
  readSdr,
  writeSdr,
  readAdvancedColor,
  writeHdr,
  nits,
  stepFromLevel: (level) => Math.round((level - LEVEL_MIN) / LEVEL_STEP),
  levelFromStep: (step) => LEVEL_MIN + Math.max(0, Math.min(100, step)) * LEVEL_STEP,
};
