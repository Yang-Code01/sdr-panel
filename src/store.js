'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  selectedKey: null,
  scenes: [
    { id: 'day', name: '日常', step: 70, hdr: true, per: {} },
    { id: 'movie', name: '看片', step: 35, hdr: true, per: {} },
    { id: 'night', name: '夜间', step: 20, hdr: false, per: {} },
  ],
  autoLaunch: false,
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    cache = { ...structuredClone(DEFAULTS), ...raw };
    if (!Array.isArray(cache.scenes) || !cache.scenes.length) cache.scenes = structuredClone(DEFAULTS.scenes);
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('保存设置失败', err);
  }
  return cache;
}

module.exports = { load, save, FILE };
