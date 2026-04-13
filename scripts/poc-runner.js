const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 디버깅용 로그 파일 (앱 실행 디렉토리에 poc-runner.log)
const LOG_FILE = path.join(os.homedir(), 'poc-runner.log');
function log(msg) {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`); } catch {}
}

class PocRunner {
  constructor(platform, callbacks = {}) {
    this.platform = platform;
    this.onStatus = callbacks.onStatus || (() => {});
    this.onResult = callbacks.onResult || (() => {});
    this.onError = callbacks.onError || (() => {});
    this.child = null;
    this._tmpDir = null;
  }

  async run(id, pw, options = {}) {
    const isPackaged = __dirname.includes('app.asar');
    const electronPath = isPackaged ? process.execPath : this._getElectronPath();
    const scriptPath = path.join(__dirname, `poc-${this.platform}.js`);

    // 세션 격리: 크롤러별 user-data-dir
    // sikbom은 네이버 OAuth 로그인이 필요하고 매 실행마다 로그인하면 캡차/기기등록에
    // 막히므로, 전용 stable 디렉토리를 써서 쿠키와 세션을 지속시킨다. 다른 플랫폼은
    // 매 실행 새 임시 디렉토리로 완전 격리.
    this._useStableDir = this.platform === 'sikbom';
    if (this._useStableDir) {
      this._tmpDir = path.join(os.homedir(), '.poc-sikbom-session');
    } else {
      this._tmpDir = path.join(os.tmpdir(), `poc-${this.platform}-${Date.now()}`);
    }
    fs.mkdirSync(this._tmpDir, { recursive: true });

    const args = [
      `--user-data-dir=${this._tmpDir}`,
    ];
    // 패키징 모드: exe가 --poc-script 플래그로 poc 스크립트 라우팅
    // 개발 모드: electron에 스크립트 경로 직접 전달
    if (isPackaged) {
      args.push(`--poc-script=${this.platform}`);
    } else {
      args.push(scriptPath);
    }
    args.push(
      `--id=${id}`,
      `--pw=${pw}`,
      `--mode=${options.mode || 'daily'}`,
    );
    if (options.targetDate) args.push(`--targetDate=${options.targetDate}`);
    if (options.salesKeeper) {
      args.push(`--storeId=${options.salesKeeper.salesKeeperStoreId}`);
      args.push(`--serverUrl=${options.salesKeeper.apiBaseUrl}`);
      args.push(`--sessionToken=${options.salesKeeper.sessionToken}`);
    }

    log(`spawn: ${electronPath}`);
    log(`args: ${JSON.stringify(args)}`);
    log(`isPackaged: ${isPackaged}`);

    return new Promise((resolve, reject) => {
      this.child = spawn(electronPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });

      this.child.on('error', (err) => {
        log(`spawn error: ${err.message}`);
      });

      let resultData = null;
      let buffer = '';

      this.child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 마지막 불완전 라인 보존

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            switch (msg.type) {
              case 'status':
                this.onStatus({ site: this.platform, ...msg });
                break;
              case 'result':
                resultData = msg;
                this.onResult({ site: this.platform, ...msg });
                break;
              case 'error':
                this.onError({ site: this.platform, ...msg });
                break;
            }
          } catch {} // JSON 아닌 일반 로그는 무시
        }
      });

      this.child.stderr.on('data', (data) => {
        log(`[${this.platform}:stderr] ${data.toString().trim()}`);
      });

      this.child.on('exit', (code) => {
        log(`[${this.platform}] exit code: ${code}`);
        this._cleanup();
        if (code === 0) resolve(resultData);
        else reject(new Error(`${this.platform} POC 종료 (code ${code})`));
      });
    });
  }

  _cleanup() {
    if (this._tmpDir) {
      // stable 디렉토리는 삭제하지 않음 (세션 지속)
      if (!this._useStableDir) {
        try { fs.rmSync(this._tmpDir, { recursive: true, force: true }); } catch {}
      }
      this._tmpDir = null;
    }
  }

  destroy() {
    if (this.child && !this.child.killed) this.child.kill();
    this._cleanup();
  }

  _getElectronPath() {
    const baseDist = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
    switch (process.platform) {
      case 'darwin':
        return path.join(baseDist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
      case 'win32':
        return path.join(baseDist, 'electron.exe');
      case 'linux':
        return path.join(baseDist, 'electron');
      default:
        return path.join(baseDist, 'electron');
    }
  }
}

module.exports = PocRunner;
