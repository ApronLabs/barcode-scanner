const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  login: (email, password) => ipcRenderer.invoke('login', { email, password }),
  getStores: () => ipcRenderer.invoke('get-stores'),
  lookupBarcode: (barcode, storeId) => ipcRenderer.invoke('lookup-barcode', { barcode, storeId }),
  updateInventory: (data) => ipcRenderer.invoke('update-inventory', data),
  navigate: (page) => ipcRenderer.send('navigate', page),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
});
