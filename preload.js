const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  login: (email, password) => ipcRenderer.invoke('login', { email, password }),
  getStores: () => ipcRenderer.invoke('get-stores'),
  lookupBarcode: (barcode, storeId) => ipcRenderer.invoke('lookup-barcode', { barcode, storeId }),
  updateInventory: (data) => ipcRenderer.invoke('update-inventory', data),
  navigate: (page) => ipcRenderer.send('navigate', page),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getKeyListenerStatus: () => ipcRenderer.invoke('get-key-listener-status'),
  getSerialStatus: () => ipcRenderer.invoke('get-serial-status'),
  serialReconnect: () => ipcRenderer.invoke('serial-reconnect'),
  listSerialPorts: () => ipcRenderer.invoke('list-serial-ports'),
  onBarcodeScanned: (callback) => ipcRenderer.on('barcode-scanned', (_, barcode) => callback(barcode)),
  onSerialStatus: (callback) => ipcRenderer.on('serial-status', (_, status) => callback(status)),
  onSessionExpired: (callback) => ipcRenderer.on('session-expired', () => callback()),
});
