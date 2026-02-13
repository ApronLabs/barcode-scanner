/**
 * 매출지킴이 바코드 스캐너 v3 - Electron 메인 프로세스
 *
 * EC2 API 연동 + 로그인 + 매장 선택 UI
 * Global Key Listener로 포커스 없이도 바코드 감지
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
        serverUrl: 'https://no-sim.co.kr',
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

// ========================================
// Global Key Listener - 바코드 스캐너 감지
// ========================================

const BARCODE_CONFIG = {
  INPUT_THRESHOLD_MS: 50,
  MIN_LENGTH: 4,
  BUFFER_TIMEOUT_MS: 200,
};

let keyBuffer = '';
let lastKeyTime = 0;
let bufferTimeout = null;
let fastKeyCount = 0;
let keyListener = null;

function keyToChar(event) {
  const { name, state } = event;
  if (state !== 'DOWN') return null;

  if (name === 'RETURN') return '\n';
  if (name.match(/^[0-9]$/)) return name;
  if (name.match(/^NUMPAD [0-9]$/)) return name.replace('NUMPAD ', '');
  if (name.match(/^[A-Z]$/)) return name.toLowerCase();
  if (name === 'MINUS' || name === 'NUMPAD MINUS') return '-';
  if (name === 'PERIOD' || name === 'NUMPAD PERIOD') return '.';
  if (name === 'SLASH' || name === 'NUMPAD SLASH') return '/';

  return null;
}

function handleBarcodeDetected(barcode) {
  console.log(`  [SCAN] 바코드 감지됨: ${barcode}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('barcode-scanned', barcode);
  }
}

function processKeyEvent(event) {
  const char = keyToChar(event);
  if (!char) return;

  const now = Date.now();
  const timeDiff = now - lastKeyTime;
  lastKeyTime = now;

  if (bufferTimeout) clearTimeout(bufferTimeout);

  const isFastInput = timeDiff < BARCODE_CONFIG.INPUT_THRESHOLD_MS;

  if (isFastInput) {
    fastKeyCount++;
  } else {
    if (keyBuffer.length > 0 && fastKeyCount < 3) {
      keyBuffer = '';
      fastKeyCount = 0;
    }
  }

  if (char === '\n') {
    if (keyBuffer.length >= BARCODE_CONFIG.MIN_LENGTH && fastKeyCount >= 3) {
      handleBarcodeDetected(keyBuffer);
    }
    keyBuffer = '';
    fastKeyCount = 0;
    return;
  }

  keyBuffer += char;

  bufferTimeout = setTimeout(() => {
    if (keyBuffer.length > 0) {
      if (keyBuffer.length >= BARCODE_CONFIG.MIN_LENGTH && fastKeyCount >= 3) {
        handleBarcodeDetected(keyBuffer);
      }
      keyBuffer = '';
      fastKeyCount = 0;
    }
  }, BARCODE_CONFIG.BUFFER_TIMEOUT_MS);
}

function initGlobalKeyListener() {
  try {
    const { GlobalKeyboardListener } = require('node-global-key-listener');
    keyListener = new GlobalKeyboardListener();
    keyListener.addListener((event) => processKeyEvent(event));
    console.log('  [KEY] Global Key Listener 활성화');
    return true;
  } catch (err) {
    console.error('  [KEY] Global Key Listener 실패:', err.message);
    return false;
  }
}

// ========================================
// IPC Handlers
// ========================================

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

// IPC: 글로벌 키 리스너 상태
ipcMain.handle('get-key-listener-status', () => {
  return { active: keyListener !== null };
});

// ========================================
// Window & App Lifecycle
// ========================================

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
  initGlobalKeyListener();
});

app.on('window-all-closed', () => {
  if (keyListener) keyListener.kill();
  app.quit();
});

app.on('before-quit', () => {
  if (keyListener) keyListener.kill();
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
