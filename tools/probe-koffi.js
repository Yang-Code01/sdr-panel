'use strict';
// 探针：用 koffi 直连 user32.dll，读/写每块屏的 SDR 白点与 HDR 状态
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const QueryDisplayConfig = user32.func(
  'long __stdcall QueryDisplayConfig(uint32 flags, _Inout_ uint32 *numPaths, uint8_t *paths, _Inout_ uint32 *numModes, uint8_t *modes, void *topology)'
);
const DisplayConfigGetDeviceInfo = user32.func('long __stdcall DisplayConfigGetDeviceInfo(void *info)');
const DisplayConfigSetDeviceInfo = user32.func('long __stdcall DisplayConfigSetDeviceInfo(void *info)');

const QDC_ALL_PATHS = 0x1, QDC_VIRTUAL_MODE_AWARE = 0x10;
const PATH_SIZE = 72, MODE_SIZE = 64;

function queryPaths() {
  const nPaths = [1024], nModes = [1024];
  const paths = Buffer.alloc(PATH_SIZE * 1024);
  const modes = Buffer.alloc(MODE_SIZE * 1024);
  const rc = QueryDisplayConfig(QDC_ALL_PATHS | QDC_VIRTUAL_MODE_AWARE, nPaths, paths, nModes, modes, null);
  if (rc !== 0) throw new Error('QueryDisplayConfig rc=' + rc);

  const out = [];
  for (let i = 0; i < nPaths[0]; i++) {
    const p = i * PATH_SIZE;
    // source: LUID(8) id(4) modeInfoIdx(4) statusFlags(4)
    const t = p + 20; // target
    const flags = paths.readUInt32LE(p + 68);
    const targetAvailable = paths.readInt32LE(t + 40);
    if (!targetAvailable) continue;
    if (!(flags & 0x1)) continue; // DISPLAYCONFIG_PATH_ACTIVE
    out.push({
      source: { low: paths.readUInt32LE(p), high: paths.readInt32LE(p + 4), id: paths.readUInt32LE(p + 8) },
      target: { low: paths.readUInt32LE(t), high: paths.readInt32LE(t + 4), id: paths.readUInt32LE(t + 8) },
    });
  }
  return out;
}

function header(type, size, luid, id) {
  const b = Buffer.alloc(size);
  b.writeUInt32LE(type, 0);
  b.writeUInt32LE(size, 4);
  b.writeUInt32LE(luid.low, 8);
  b.writeInt32LE(luid.high, 12);
  b.writeUInt32LE(id, 16);
  return b;
}

function targetName(p) {
  const b = header(2, 420, p.target, p.target.id);
  const rc = DisplayConfigGetDeviceInfo(b);
  if (rc !== 0) return { rc, name: null };
  let end = 36;
  while (end < 164 && b.readUInt16LE(end) !== 0) end += 2;
  return { rc, name: b.toString('utf16le', 36, end) };
}

function getSdr(p) {
  const b = header(11, 24, p.target, p.target.id);
  const rc = DisplayConfigGetDeviceInfo(b);
  return { rc, value: rc === 0 ? b.readUInt32LE(20) : null };
}

function setSdr(p, value) {
  const b = header(12, 24, p.target, p.target.id);
  b.writeUInt32LE(value, 20);
  return DisplayConfigSetDeviceInfo(b);
}

function getHdr(p) {
  const b = header(9, 32, p.target, p.target.id);
  const rc = DisplayConfigGetDeviceInfo(b);
  if (rc !== 0) return { rc };
  const v = b.readUInt32LE(20);
  return { rc, supported: !!(v & 1), enabled: !!(v & 2), forcedOff: !!(v & 8), bits: b.readUInt32LE(28) };
}

function setHdr(p, on) {
  const b = header(10, 24, p.target, p.target.id);
  b.writeUInt32LE(on ? 1 : 0, 20);
  return DisplayConfigSetDeviceInfo(b);
}

const mode = process.argv[2] || 'read';
const paths = queryPaths();
console.log('active paths:', paths.length);
paths.forEach((p, i) => {
  const n = targetName(p);
  console.log(`[${i}] target id=${p.target.id} name=${JSON.stringify(n.name)} nameRc=${n.rc}`,
    'sdr=', JSON.stringify(getSdr(p)), 'hdr=', JSON.stringify(getHdr(p)));
});

if (mode === 'set') {
  const p = paths[0];
  const before = getSdr(p);
  const next = before.value + 500;
  console.log('--- set test: before', before.value, '-> ', next);
  console.log('set rc =', setSdr(p, next));
  console.log('read back =', getSdr(p).value);
  setSdr(p, before.value);
  console.log('restored =', getSdr(p).value);
}
if (mode === 'hdr') {
  const p = paths[0];
  const cur = getHdr(p);
  console.log('--- hdr toggle: cur', cur);
  console.log('set rc=', setHdr(p, !cur.enabled));
  console.log('after', getHdr(p));
  setHdr(p, cur.enabled);
  console.log('restored', getHdr(p));
}
