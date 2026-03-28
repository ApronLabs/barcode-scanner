const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

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
    const electronPath = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
    // Linux/Windows 대응도 필요하면 require('electron') 사용
    const scriptPath = path.join(__dirname, `poc-${this.platform}.js`);

    // 세션 격리: 크롤러별 임시 user-data-dir 사용
    this._tmpDir = path.join(os.tmpdir(), `poc-${this.platform}-${Date.now()}`);
    fs.mkdirSync(this._tmpDir, { recursive: true });

    const args = [
      `--user-data-dir=${this._tmpDir}`,
      scriptPath,
      `--id=${id}`,
      `--pw=${pw}`,
      `--mode=${options.mode || 'daily'}`,
    ];
    if (options.targetDate) args.push(`--targetDate=${options.targetDate}`);
    if (options.salesKeeper) {
      args.push(`--storeId=${options.salesKeeper.salesKeeperStoreId}`);
      args.push(`--serverUrl=${options.salesKeeper.apiBaseUrl}`);
      args.push(`--sessionToken=${options.salesKeeper.sessionToken}`);
    }

    return new Promise((resolve, reject) => {
      this.child = spawn(electronPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
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
        // stderr는 디버깅 로그 — 필요시 console.log
      });

      this.child.on('exit', (code) => {
        this._cleanup();
        if (code === 0) resolve(resultData);
        else reject(new Error(`${this.platform} POC 종료 (code ${code})`));
      });
    });
  }

  _cleanup() {
    if (this._tmpDir) {
      try { fs.rmSync(this._tmpDir, { recursive: true, force: true }); } catch {}
      this._tmpDir = null;
    }
  }

  destroy() {
    if (this.child && !this.child.killed) this.child.kill();
    this._cleanup();
  }
}

module.exports = PocRunner;
