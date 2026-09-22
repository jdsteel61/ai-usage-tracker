'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Renderer bridge. Context isolation is on, node integration is off, and the
 * surface is deliberately tiny: read snapshots, request refreshes, manage
 * non-secret settings, and guarded Z.ai key operations (which trigger their
 * own confirmation dialogs in the main process).
 */
contextBridge.exposeInMainWorld('tracker', {
  onSnapshot: (cb) => {
    const listener = (_e, snapshot) => cb(snapshot);
    ipcRenderer.on('snapshot', listener);
    return () => ipcRenderer.removeListener('snapshot', listener);
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partials) => ipcRenderer.invoke('settings:patch', partials),
  refresh: () => ipcRenderer.send('refresh'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  quitApp: () => ipcRenderer.send('app-quit'),
  hideWindow: () => ipcRenderer.send('window-hide'),
  reportError: (message) => ipcRenderer.send('renderer-error', { message: String(message).slice(0, 300) }),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('launch-at-login', enabled),
  // Generic per-provider key management (zai kept for older callers).
  zaiKeyExists: () => ipcRenderer.invoke('provider:keyExists', 'zai'),
  zaiSaveKey: (key) => ipcRenderer.invoke('provider:saveKey', 'zai', key),
  zaiTestKey: () => ipcRenderer.invoke('provider:testKey', 'zai'),
  zaiRemoveKey: () => ipcRenderer.invoke('provider:removeKey', 'zai'),
  providerKeyExists: (id) => ipcRenderer.invoke('provider:keyExists', id),
  providerSaveKey: (id, key) => ipcRenderer.invoke('provider:saveKey', id, key),
  providerTestKey: (id) => ipcRenderer.invoke('provider:testKey', id),
  providerRemoveKey: (id) => ipcRenderer.invoke('provider:removeKey', id),
});
