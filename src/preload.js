'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  setStep: (step, final) => ipcRenderer.invoke('sdr:set', step, final),
  selectDisplay: (key) => ipcRenderer.invoke('display:select', key),
  toggleHdr: (key) => ipcRenderer.invoke('hdr:toggle', key),
  applyScene: (id) => ipcRenderer.invoke('scene:apply', id),
  saveScene: (name) => ipcRenderer.invoke('scene:save', name),
  deleteScene: (id) => ipcRenderer.invoke('scene:delete', id),
  hidePanel: () => ipcRenderer.invoke('panel:hide'),
  hideHud: () => ipcRenderer.invoke('hud:hide'),
  onState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('state:changed', handler);
    return () => ipcRenderer.removeListener('state:changed', handler);
  },
  onHud: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('hud:show', handler);
    return () => ipcRenderer.removeListener('hud:show', handler);
  },
});
