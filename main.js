/**
 * 매출지킴이 바코드 스캐너 v3 - Electron 메인 프로세스
 *
 * EC2 API 연동 + 로그인 + 매장 선택 UI
 */

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');

let Store = null;
let store = null;

function initStore() {
  if (!Store) {
    Store = require('electron-store');
    store = new Store({
      name: 'barcode-scanner-config',
      defaults: {
        lastStoreId: null,
        lastStoreName: null,
        serverUrl: 'http://13.210.110.218',
      },
    });
  }
  return store;
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let mainWindow = null;

app.setName('매출지킴이 바코드 스캐너');

// IPC: 로그인
ipcMain.handle('login', async (event, { email, password }) => {
  const s = initStore();
  const serverUrl = s.get('serverUrl');
  try {
    const response = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json();
    if (!response.ok) {
      return { success: false, message: data.error || '로그인 실패' };
    }
    // Extract session-token from Set-Cookie header
    const setCookie = response.headers.getSetCookie?.() || [];
    let sessionToken = null;
    for (const cookie of setCookie) {
      const match = cookie.match(/session-token=([^;]+)/);
      if (match) {
        sessionToken = match[1];
        break;
      }
    }
    if (sessionToken) {
      // Store cookie in Electron session for subsequent requests
      await session.defaultSession.cookies.set({
        url: serverUrl,
        name: 'session-token',
        value: sessionToken,
        path: '/',
      });
    }
    return { success: true, user: data.user, token: sessionToken };
  } catch (err) {
    return { success: false, message: '서버 연결 실패: ' + err.message };
  }
});

// IPC: 매장 목록 조회
ipcMain.handle('get-stores', async () => {
  const s = initStore();
  const serverUrl = s.get('serverUrl');
  try {
    const cookies = await session.defaultSession.cookies.get({ url: serverUrl, name: 'session-token' });
    const token = cookies.length > 0 ? cookies[0].value : '';
    const response = await fetch(`${serverUrl}/api/stores`, {
      headers: { Cookie: `session-token=${token}` },
    });
    if (!response.ok) {
      return { success: false, message: '매장 목록 조회 실패' };
    }
    const data = await response.json();
    return { success: true, stores: data.data || [] };
  } catch (err) {
    return { success: false, message: '서버 연결 실패: ' + err.message };
  }
});

// IPC: 바코드 조회
ipcMain.handle('lookup-barcode', async (event, { barcode, storeId }) => {
  const s = initStore();
  const serverUrl = s.get('serverUrl');
  try {
    const cookies = await session.defaultSession.cookies.get({ url: serverUrl, name: 'session-token' });
    const token = cookies.length > 0 ? cookies[0].value : '';
    const response = await fetch(
      `${serverUrl}/api/inventory/barcode?barcode=${encodeURIComponent(barcode)}&storeId=${encodeURIComponent(storeId)}`,
      { headers: { Cookie: `session-token=${token}` } }
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { success: false, message: err.error || '조회 실패' };
    }
    const data = await response.json();
    return { success: true, item: data.item };
  } catch (err) {
    return { success: false, message: '서버 연결 실패: ' + err.message };
  }
});

// IPC: 재고 변경
ipcMain.handle('update-inventory', async (event, payload) => {
  const s = initStore();
  const serverUrl = s.get('serverUrl');
  try {
    const cookies = await session.defaultSession.cookies.get({ url: serverUrl, name: 'session-token' });
    const token = cookies.length > 0 ? cookies[0].value : '';
    const response = await fetch(`${serverUrl}/api/inventory`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session-token=${token}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { success: false, message: err.error || '재고 변경 실패' };
    }
    const data = await response.json();
    return { success: true, ...data };
  } catch (err) {
    return { success: false, message: '서버 연결 실패: ' + err.message };
  }
});

// IPC: 화면 전환
ipcMain.on('navigate', (event, page) => {
  if (!mainWindow) return;
  const filePath = path.join(__dirname, 'renderer', `${page}.html`);
  mainWindow.loadFile(filePath);
});

// IPC: 설정 저장/조회
ipcMain.handle('get-config', () => {
  const s = initStore();
  return {
    serverUrl: s.get('serverUrl'),
    lastStoreId: s.get('lastStoreId'),
    lastStoreName: s.get('lastStoreName'),
  };
});

ipcMain.handle('save-config', (event, config) => {
  const s = initStore();
  if (config.lastStoreId !== undefined) s.set('lastStoreId', config.lastStoreId);
  if (config.lastStoreName !== undefined) s.set('lastStoreName', config.lastStoreName);
  if (config.serverUrl !== undefined) s.set('serverUrl', config.serverUrl);
  return { success: true };
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 750,
    resizable: true,
    title: '매출지킴이 바코드 스캐너',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  console.log('========================================');
  console.log('  매출지킴이 바코드 스캐너 v' + app.getVersion());
  console.log('========================================');
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
