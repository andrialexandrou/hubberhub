const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  fetchNotifications: () => ipcRenderer.invoke('fetch-notifications'),
  markAllRead: () => ipcRenderer.invoke('mark-all-read'),
  markThreadRead: (id) => ipcRenderer.invoke('mark-thread-read', id),
});
