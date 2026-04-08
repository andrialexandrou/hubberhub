const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  fetchNotifications: () => ipcRenderer.invoke('fetch-notifications'),
  markAllRead: () => ipcRenderer.invoke('mark-all-read'),
  markThreadRead: (id) => ipcRenderer.invoke('mark-thread-read', id),
  updateTrayBadge: (count) => ipcRenderer.invoke('update-tray-badge', count),
  unsubscribeThread: (id) => ipcRenderer.invoke('unsubscribe-thread', id),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  showNotifMenu: (url, threadId) => ipcRenderer.invoke('show-notif-menu', url, threadId),
  onRefresh: (callback) => ipcRenderer.on('refresh-notifications', callback),
  onThreadRemoved: (callback) => ipcRenderer.on('thread-removed', (_event, threadId) => callback(threadId)),
});
