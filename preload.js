const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  fetchNotifications: () => ipcRenderer.invoke('fetch-notifications'),
  markAllRead: () => ipcRenderer.invoke('mark-all-read'),
  markThreadRead: (id) => ipcRenderer.invoke('mark-thread-read', id),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  showLinkMenu: (url) => ipcRenderer.invoke('show-link-menu', url),
});
