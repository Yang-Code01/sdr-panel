'use strict';

// 这块和 Windows 的一个怪脾气有关：
// DisplayConfigSetDeviceInfo(SET_HDR_STATE) 生效之后，DisplayConfigGetDeviceInfo(
// GET_ADVANCED_COLOR_INFO) 并不会跟着刷新 —— 实测关掉 HDR 后等 30s，GET 仍然报
// enabled=1、bitsPerColor=10（同期注册表 MonitorDataStore\<id>\HDREnabled 已经是 0）。
//
// 所以「上一次我们自己写进去的值」比 GET 更可靠：只要还有记录，就以记录为准；
// 等 GET 哪天自己追上了（通常是重启后重新枚举），记录就自动作废。
function resolve(apiEnabled, hint) {
  const hasHint = typeof hint === 'boolean';
  const api = !!apiEnabled;
  return {
    enabled: hasHint ? hint : api,
    clearHint: hasHint && hint === api,
  };
}

module.exports = { resolve };
