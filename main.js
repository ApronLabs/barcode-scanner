/**
 * 매출지킴이 바코드 스캐너 - Electron 메인 프로세스
 *
 * 트레이 아이콘으로 백그라운드 실행
 * 자동 업데이트 지원
 * 첫 실행 시 매장 설정 UI 제공
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain } = require('electron');
const path = require('path');
const { fork } = require('child_process');

// electron-store와 autoUpdater는 앱 준비 후 lazy-load
let Store = null;
let store = null;

// Supabase 설정 (하드코딩 - 모든 매장 동일)
const SUPABASE_CONFIG = {
  url: 'https://kjfnhwhgsznhizibxiwj.supabase.co',
  serviceKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZm5od2hnc3puaGl6aWJ4aXdqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczNjc2NTY0MCwiZXhwIjoyMDUyMzQxNjQwfQ.JS2gL2znmPRCPxN66aQCoWKNuzWMaZtYdmxo6ZoZKrI'
};

// 설정 저장소 초기화 함수
function initStore() {
  if (!Store) {
    Store = require('electron-store');
    store = new Store({
      name: 'barcode-scanner-config',
      defaults: {
        storeId: null,
        storeName: null,
        isConfigured: false
      }
    });
  }
  return store;
}

// autoUpdater는 앱 준비 후 lazy-load (electron-updater가 app.getVersion() 필요)
let autoUpdater = null;

// 단일 인스턴스 잠금
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let tray = null;
let serverProcess = null;
let setupWindow = null;
let isQuitting = false;

// 앱 이름 설정
app.setName('매출지킴이 바코드 스캐너');

// 자동 업데이트 설정
function setupAutoUpdater() {
  // 앱이 준비된 후에 electron-updater 로드
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[UPDATE] 업데이트 확인 중...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[UPDATE] 새 버전 발견:', info.version);
    showNotification('업데이트 발견', `새 버전 ${info.version}을 다운로드합니다.`);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[UPDATE] 최신 버전입니다.');
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[UPDATE] 다운로드 중: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[UPDATE] 업데이트 다운로드 완료:', info.version);
    showNotification('업데이트 준비 완료', '앱 재시작 시 새 버전이 설치됩니다.');
  });

  autoUpdater.on('error', (err) => {
    console.error('[UPDATE] 업데이트 오류:', err.message);
  });

  // 앱 시작 시 업데이트 확인
  autoUpdater.checkForUpdatesAndNotify();
}

// 알림 표시
function showNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// 설정 창 표시
function showSetupWindow() {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 450,
    height: 500,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '매장 설정',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // 메뉴바 숨기기
  setupWindow.setMenuBarVisibility(false);

  const setupPath = app.isPackaged
    ? path.join(process.resourcesPath, 'public', 'setup.html')
    : path.join(__dirname, 'public', 'setup.html');

  setupWindow.loadFile(setupPath);

  setupWindow.on('closed', () => {
    setupWindow = null;
  });
}

// IPC 핸들러: 매장 목록 조회
ipcMain.handle('get-stores', async () => {
  try {
    const response = await fetch(
      `${SUPABASE_CONFIG.url}/rest/v1/stores?select=id,name&order=name`,
      {
        headers: {
          'apikey': SUPABASE_CONFIG.serviceKey,
          'Authorization': `Bearer ${SUPABASE_CONFIG.serviceKey}`
        }
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    console.error('[CONFIG] 매장 목록 조회 실패:', err);
    return null;
  }
});

// IPC 핸들러: 현재 설정 조회
ipcMain.handle('get-current-config', async () => {
  const s = initStore();
  return {
    storeId: s.get('storeId'),
    storeName: s.get('storeName'),
    isConfigured: s.get('isConfigured')
  };
});

// IPC 핸들러: 설정 저장
ipcMain.handle('save-config', async (event, config) => {
  const s = initStore();
  s.set('storeId', config.storeId);
  s.set('storeName', config.storeName);
  s.set('isConfigured', true);

  console.log('[CONFIG] 설정 저장됨:', config.storeName);

  if (setupWindow) {
    setupWindow.close();
  }

  // 기존 서버가 있으면 종료 후 재시작
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }

  // 앱 시작 (트레이가 없으면 생성)
  if (!tray) {
    createTray();
  }
  startServer();

  showNotification('설정 완료', `${config.storeName} 매장으로 설정되었습니다.`);
});

// 서버 프로세스 시작
function startServer() {
  const serverPath = app.isPackaged
    ? path.join(process.resourcesPath, 'server.js')
    : path.join(__dirname, 'server.js');

  const s = initStore();
  const storeId = s.get('storeId');
  if (!storeId) {
    console.error('[SERVER] 매장 ID가 설정되지 않음');
    return;
  }

  serverProcess = fork(serverPath, [], {
    env: {
      ...process.env,
      SUPABASE_URL: SUPABASE_CONFIG.url,
      SUPABASE_SERVICE_KEY: SUPABASE_CONFIG.serviceKey,
      STORE_ID: storeId,
      ELECTRON_RUN_AS_NODE: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  });

  serverProcess.stdout.on('data', (data) => {
    console.log(data.toString());
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(data.toString());
  });

  serverProcess.on('message', (msg) => {
    // 서버에서 IPC 메시지 수신 (바코드 스캔 알림 등)
    if (msg.type === 'scan') {
      const actionText = msg.mode === 'output' ? '출고' : '입고';
      showNotification(`${actionText} 완료`, `${msg.item} ${msg.change}개`);
    }
  });

  serverProcess.on('error', (err) => {
    console.error('[SERVER] 서버 오류:', err);
  });

  serverProcess.on('exit', (code) => {
    console.log('[SERVER] 서버 종료:', code);
    if (!isQuitting) {
      // 비정상 종료 시 재시작
      console.log('[SERVER] 서버 재시작...');
      setTimeout(startServer, 1000);
    }
  });

  console.log('[SERVER] 서버 시작됨');
}

// 트레이 아이콘 생성
function createTray() {
  // 아이콘 경로 (패키징 여부에 따라 다름)
  let iconPath;
  if (app.isPackaged) {
    iconPath = path.join(process.resourcesPath, 'assets', 'icon.png');
  } else {
    iconPath = path.join(__dirname, 'assets', 'icon.png');
  }

  // 아이콘이 없으면 기본 아이콘 사용
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      // 16x16 기본 아이콘 생성
      trayIcon = nativeImage.createEmpty();
    }
  } catch (e) {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('매출지킴이 바코드 스캐너');

  const s = initStore();
  const storeName = s.get('storeName') || '미설정';

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '매출지킴이 바코드 스캐너 v' + app.getVersion(),
      enabled: false
    },
    { type: 'separator' },
    {
      label: `현재 매장: ${storeName}`,
      enabled: false
    },
    {
      label: '서버 상태: 실행 중',
      enabled: false
    },
    { type: 'separator' },
    {
      label: '매장 변경',
      click: () => {
        showSetupWindow();
      }
    },
    {
      label: '업데이트 확인',
      click: () => {
        if (autoUpdater) {
          autoUpdater.checkForUpdatesAndNotify();
        }
      }
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        isQuitting = true;
        if (serverProcess) {
          serverProcess.kill();
        }
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // 트레이 아이콘 클릭 시 메뉴 표시
  tray.on('click', () => {
    tray.popUpContextMenu();
  });
}

// 앱 준비 완료
app.whenReady().then(() => {
  // Windows 시작 프로그램 등록 옵션
  app.setLoginItemSettings({
    openAtLogin: false, // 사용자가 설정에서 변경 가능
    path: app.getPath('exe')
  });

  console.log('========================================');
  console.log('  매출지킴이 바코드 스캐너 v' + app.getVersion());
  console.log('========================================');

  // 설정 여부 확인
  const s = initStore();
  if (!s.get('isConfigured')) {
    console.log('  첫 실행: 매장 설정 필요');
    console.log('========================================');
    showSetupWindow();
    setupAutoUpdater();
  } else {
    const storeName = s.get('storeName');
    console.log(`  매장: ${storeName}`);
    console.log('  트레이 아이콘으로 실행 중');
    console.log('  종료하려면 트레이 아이콘 우클릭 → 종료');
    console.log('========================================');

    createTray();
    startServer();
    setupAutoUpdater();
  }
});

// 모든 창이 닫혀도 앱 종료하지 않음 (트레이 모드)
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

// 앱 종료 전 정리
app.on('before-quit', () => {
  isQuitting = true;
  if (serverProcess) {
    serverProcess.kill();
  }
});

// 두 번째 인스턴스 실행 시도 시
app.on('second-instance', () => {
  // 트레이 아이콘 메뉴 표시
  if (tray) {
    tray.popUpContextMenu();
  }
});
