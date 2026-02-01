/**
 * 매출지킴이 바코드 스캐너 - Electron 메인 프로세스
 *
 * 트레이 아이콘으로 백그라운드 실행
 * 자동 업데이트 지원
 */

const { app, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const { fork } = require('child_process');

// autoUpdater는 앱 준비 후 lazy-load (electron-updater가 app.getVersion() 필요)
let autoUpdater = null;

// 단일 인스턴스 잠금
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let tray = null;
let serverProcess = null;
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

// 서버 프로세스 시작
function startServer() {
  const serverPath = path.join(__dirname, 'server.js');

  // 환경 변수 설정 (패키징된 앱에서 .env 파일 경로)
  const envPath = app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.join(__dirname, '.env');

  serverProcess = fork(serverPath, [], {
    env: {
      ...process.env,
      DOTENV_CONFIG_PATH: envPath,
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

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '매출지킴이 바코드 스캐너 v' + app.getVersion(),
      enabled: false
    },
    { type: 'separator' },
    {
      label: '서버 상태: 실행 중',
      enabled: false
    },
    { type: 'separator' },
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

  createTray();
  startServer();
  setupAutoUpdater();

  console.log('========================================');
  console.log('  매출지킴이 바코드 스캐너 v' + app.getVersion());
  console.log('========================================');
  console.log('  트레이 아이콘으로 실행 중');
  console.log('  종료하려면 트레이 아이콘 우클릭 → 종료');
  console.log('========================================');
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
