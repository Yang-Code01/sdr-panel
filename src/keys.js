'use strict';
// 物理按键状态（热键「按住连发」与注册失败时的兜底）。
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');

const VK = { CTRL: 0x11, SHIFT: 0x10, ALT: 0x12, UP: 0x26, DOWN: 0x28, DIGIT1: 0x31, DIGIT2: 0x32, DIGIT3: 0x33 };

const isDown = (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0;

// Ctrl+Alt+↑/↓ 常被显卡驱动的「屏幕旋转」占着，注册失败时切到带 Shift 的版本。
// shift = 'any' 时不管 Shift 按没按（轮询用，物理键怎么按都能命中）。
function combos({ shift = false } = {}) {
  const shiftOk = () => (shift === 'any' ? true : shift ? isDown(VK.SHIFT) : !isDown(VK.SHIFT));
  const ctrlAlt = (vk) => isDown(VK.CTRL) && isDown(VK.ALT) && shiftOk() && isDown(vk);
  const altOnly = (vk) => isDown(VK.ALT) && !isDown(VK.CTRL) && !isDown(VK.SHIFT) && isDown(vk);
  return {
    up: () => ctrlAlt(VK.UP),
    down: () => ctrlAlt(VK.DOWN),
    scene1: () => altOnly(VK.DIGIT1),
    scene2: () => altOnly(VK.DIGIT2),
    scene3: () => altOnly(VK.DIGIT3),
  };
}

module.exports = { combos, isDown, VK };
