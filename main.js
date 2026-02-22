/**
 * 매출지킴이 바코드 스캐너 v3 - Electron 메인 프로세스
 *
 * EC2 API 연동 + 로그인 + 매장 선택 UI
 * Global Key Listener로 포커스 없이도 바코드 감지
 */

const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
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

// Authenticated fetch helper - handles cookie + 401 detection
async function authenticatedFetch(url, options = {}) {
  const s = initStore();
  const serverUrl = s.get('serverUrl');
  const cookies = await session.defaultSession.cookies.get({ url: serverUrl, name: 'session-token' });
  const token = cookies.length > 0 ? cookies[0].value : '';

  const mergedOptions = {
    ...options,
    headers: {
      ...options.headers,
      Cookie: `session-token=${token}`,
    },
  };

  const response = await fetch(url, mergedOptions);

  if (response.status === 401) {
    // Clear cookie
    try {
      await session.defaultSession.cookies.remove(serverUrl, 'session-token');
    } catch (e) { /* ignore */ }
    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session-expired');
    }
    return { unauthorized: true, response };
  }

  return { unauthorized: false, response };
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
  INPUT_THRESHOLD_MS: 100,
  MIN_LENGTH: 4,
  BUFFER_TIMEOUT_MS: 300,
};

let keyBuffer = '';
let lastKeyTime = 0;
let bufferTimeout = null;
let fastKeyCount = 0;
let keyListener = null;

// ========================================
// Serial Port - CH340 바코드 리더기
// ========================================

const SERIAL_CONFIG = {
  BAUD_RATES: [9600, 115200],
  CH340_VENDOR_ID: '1A86',
  POLL_INTERVAL_MS: 5000,
};

// 다중 시리얼 포트 지원: { path: { port, parser } }
const serialPorts = {};
let serialPollTimer = null;

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
    if (keyBuffer.length > 0 && fastKeyCount < 2) {
      keyBuffer = '';
      fastKeyCount = 0;
    }
  }

  if (char === '\n') {
    if (keyBuffer.length >= BARCODE_CONFIG.MIN_LENGTH && fastKeyCount >= 2) {
      handleBarcodeDetected(keyBuffer);
    }
    keyBuffer = '';
    fastKeyCount = 0;
    return;
  }

  keyBuffer += char;

  bufferTimeout = setTimeout(() => {
    if (keyBuffer.length > 0) {
      if (keyBuffer.length >= BARCODE_CONFIG.MIN_LENGTH && fastKeyCount >= 2) {
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
    const listener = new GlobalKeyboardListener();
    listener.addListener((event) => processKeyEvent(event));
    keyListener = listener;
    console.log('  [KEY] Global Key Listener 활성화');
    return true;
  } catch (err) {
    console.error('  [KEY] Global Key Listener 실패:', err.message);
    keyListener = null;
    return false;
  }
}

// ========================================
// Serial Port Functions (다중 포트 지원)
// ========================================

function isCH340Port(p) {
  const vid = (p.vendorId || '').toUpperCase();
  const mfr = (p.manufacturer || '').toUpperCase();
  const pnp = (p.pnpId || '').toUpperCase();
  return vid === SERIAL_CONFIG.CH340_VENDOR_ID
    || mfr.includes('CH340') || mfr.includes('WCH')
    || pnp.includes('CH340') || pnp.includes('WCH');
}

async function findAllCH340Ports() {
  try {
    const ports = await SerialPort.list();
    const all = ports.map(p => `${p.path}(${p.manufacturer || 'N/A'})`).join(', ');
    console.log(`  [SERIAL] 전체 포트: ${all || '없음'}`);
    return ports.filter(isCH340Port);
  } catch (err) {
    console.error('  [SERIAL] 포트 목록 조회 실패:', err.message);
    return [];
  }
}

function sendSerialStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const connectedPorts = Object.keys(serialPorts).filter(p => serialPorts[p].port && serialPorts[p].port.isOpen);
  mainWindow.webContents.send('serial-status', {
    connected: connectedPorts.length > 0,
    ports: connectedPorts,
    count: connectedPorts.length,
  });
}

function tryOpenPort(portPath, baudRate) {
  return new Promise((resolve) => {
    try {
      const port = new SerialPort({
        path: portPath,
        baudRate: baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false,
      });

      const parser = port.pipe(new ReadlineParser({ delimiter: '\r' }));

      parser.on('data', (data) => {
        const barcode = data.trim();
        if (barcode.length >= BARCODE_CONFIG.MIN_LENGTH) {
          console.log(`  [SERIAL ${portPath}] 바코드 수신: ${barcode}`);
          handleBarcodeDetected(barcode);
        }
      });

      port.on('error', (err) => {
        console.error(`  [SERIAL ${portPath}] 오류:`, err.message);
      });

      port.on('close', () => {
        console.log(`  [SERIAL ${portPath}] 포트 닫힘`);
        delete serialPorts[portPath];
        sendSerialStatus();
      });

      port.open((err) => {
        if (err) {
          console.error(`  [SERIAL ${portPath}] 열기 실패 (${baudRate}):`, err.message);
          resolve(null);
        } else {
          console.log(`  [SERIAL ${portPath}] 연결됨 @ ${baudRate} baud`);
          resolve({ port, parser });
        }
      });
    } catch (err) {
      console.error(`  [SERIAL ${portPath}] 연결 오류:`, err.message);
      resolve(null);
    }
  });
}

async function connectOnePort(portPath) {
  if (serialPorts[portPath] && serialPorts[portPath].port && serialPorts[portPath].port.isOpen) {
    return true;
  }

  for (const baudRate of SERIAL_CONFIG.BAUD_RATES) {
    const result = await tryOpenPort(portPath, baudRate);
    if (result) {
      serialPorts[portPath] = result;
      sendSerialStatus();
      return true;
    }
  }
  return false;
}

function closeOnePort(portPath) {
  const entry = serialPorts[portPath];
  if (entry && entry.port && entry.port.isOpen) {
    try { entry.port.close(); } catch (e) { /* ignore */ }
  }
  delete serialPorts[portPath];
}

function closeAllSerialPorts() {
  for (const portPath of Object.keys(serialPorts)) {
    closeOnePort(portPath);
  }
}

async function autoDetectAndConnect() {
  try {
    const availablePorts = await SerialPort.list();
    const availablePaths = new Set(availablePorts.map(p => p.path));

    // 분리된 포트 정리
    for (const connectedPath of Object.keys(serialPorts)) {
      if (!availablePaths.has(connectedPath)) {
        console.log(`  [SERIAL ${connectedPath}] 장치 분리 감지`);
        closeOnePort(connectedPath);
        sendSerialStatus();
      }
    }

    // 새 CH340 포트 연결
    const ch340Ports = availablePorts.filter(isCH340Port);
    for (const p of ch340Ports) {
      if (!serialPorts[p.path]) {
        await connectOnePort(p.path);
      }
    }
  } catch (e) {
    // ignore
  }
}

function startSerialPolling() {
  autoDetectAndConnect();
  serialPollTimer = setInterval(() => autoDetectAndConnect(), SERIAL_CONFIG.POLL_INTERVAL_MS);
}

function stopSerialPolling() {
  if (serialPollTimer) {
    clearInterval(serialPollTimer);
    serialPollTimer = null;
  }
  closeAllSerialPorts();
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
    const { unauthorized, response } = await authenticatedFetch(`${serverUrl}/api/stores`);
    if (unauthorized) {
      return { success: false, code: 'UNAUTHORIZED', message: '세션이 만료되었습니다' };
    }
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
    const { unauthorized, response } = await authenticatedFetch(
      `${serverUrl}/api/inventory/barcode?barcode=${encodeURIComponent(barcode)}&storeId=${encodeURIComponent(storeId)}`
    );
    if (unauthorized) {
      return { success: false, code: 'UNAUTHORIZED', message: '세션이 만료되었습니다' };
    }
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
    const { unauthorized, response } = await authenticatedFetch(`${serverUrl}/api/inventory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (unauthorized) {
      return { success: false, code: 'UNAUTHORIZED', message: '세션이 만료되었습니다' };
    }
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

// IPC: 시리얼 포트 상태
ipcMain.handle('get-serial-status', () => {
  const connectedPorts = Object.keys(serialPorts).filter(p => serialPorts[p].port && serialPorts[p].port.isOpen);
  return {
    connected: connectedPorts.length > 0,
    ports: connectedPorts,
    count: connectedPorts.length,
  };
});

// IPC: 시리얼 포트 재연결
ipcMain.handle('serial-reconnect', async () => {
  closeAllSerialPorts();
  await autoDetectAndConnect();
  const connectedPorts = Object.keys(serialPorts);
  return {
    success: connectedPorts.length > 0,
    ports: connectedPorts,
    count: connectedPorts.length,
  };
});

// IPC: 시리얼 포트 목록
ipcMain.handle('list-serial-ports', async () => {
  try {
    const ports = await SerialPort.list();
    return { success: true, ports };
  } catch (err) {
    return { success: false, message: err.message };
  }
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
  startSerialPolling();

  // Auto updater
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log('  [UPDATE] 업데이트 발견:', info.version);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '업데이트 알림',
      message: `새 버전 (v${info.version})이 있습니다.\n업데이트를 다운로드할까요?`,
      buttons: ['업데이트', '나중에'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.downloadUpdate();
      }
    });
  });

  autoUpdater.on('update-downloaded', () => {
    console.log('  [UPDATE] 다운로드 완료');
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '업데이트 준비 완료',
      message: '업데이트가 다운로드되었습니다.\n지금 재시작하여 설치할까요?',
      buttons: ['지금 재시작', '나중에'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (err) => {
    console.log('  [UPDATE] 에러:', err.message);
  });

  // Check for updates after 3 seconds
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.log('  [UPDATE] 체크 실패:', err.message);
    });
  }, 3000);
});

app.on('window-all-closed', () => {
  stopSerialPolling();
  try {
    if (keyListener) {
      keyListener.kill();
      keyListener = null;
    }
  } catch (e) {
    console.error('  [KEY] Listener 종료 오류:', e.message);
  }
  app.quit();
});

app.on('before-quit', () => {
  stopSerialPolling();
  try {
    if (keyListener) {
      keyListener.kill();
      keyListener = null;
    }
  } catch (e) {
    console.error('  [KEY] Listener 종료 오류:', e.message);
  }
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
