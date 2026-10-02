'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('app:state'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  importIcs: () => ipcRenderer.invoke('schedule:import'),
  reload: () => ipcRenderer.invoke('schedule:reload'),
  getWeek: (offset) => ipcRenderer.invoke('week:get', offset),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  clearSchedule: () => ipcRenderer.invoke('schedule:clear'),
  revealDataDir: () => ipcRenderer.invoke('app:reveal-data'),
  setCollapsed: (collapsed) => ipcRenderer.invoke('window:set-collapsed', collapsed),
  hide: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onState: (callback) => {
    ipcRenderer.on('app:state', (_event, payload) => callback(payload));
  },
  onNotice: (callback) => {
    ipcRenderer.on('app:notice', (_event, payload) => callback(payload));
  },
});
