// 쿠팡이츠 크롤러 - child process로 rebrowser 실행
// Electron 메인 프로세스의 CDP 환경이 rebrowser를 간섭하지 않도록
// 별도 Node.js 프로세스(fork)에서 실행
'use strict';

const { fork } = require('child_process');
const path = require('path');

class CoupangeatsCrawler {
  constructor({ onStatus } = {}) {
    this.worker = null;
    this.onStatus = onStatus || (() => {});
  }

  run(id, pw) {
    return new Promise((resolve, reject) => {
      const workerPath = path.join(__dirname, 'coupangeats-worker.js');
      const results = {};
      const errors = [];

      // Electron 환경에서 fork할 때 execPath를 Node로 지정해야 함
      // Electron의 process.execPath는 Electron 바이너리라 child_process.fork가
      // Electron을 다시 실행하게 됨 → 순수 Node.js로 실행해야 함
      let nodeExec = process.execPath;
      if (nodeExec.includes('Electron') || nodeExec.includes('electron')) {
        const fs = require('fs');
        const os = require('os');
        const candidates = [
          // nvm
          path.join(os.homedir(), '.nvm/versions/node'),
          // homebrew
          '/usr/local/bin/node',
          '/opt/homebrew/bin/node',
          // system
          '/usr/bin/node',
        ];
        // nvm: 최신 버전 폴더의 node 바이너리 찾기
        const nvmDir = candidates[0];
        try {
          const versions = fs.readdirSync(nvmDir).filter(v => v.startsWith('v')).sort((a, b) => {
            // 시맨틱 버전 정렬 (v20.20.0 > v20.9.0)
            const pa = a.slice(1).split('.').map(Number);
            const pb = b.slice(1).split('.').map(Number);
            for (let i = 0; i < 3; i++) {
              if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
            }
            return 0;
          });
          for (const v of versions) {
            const p = path.join(nvmDir, v, 'bin', 'node');
            try { fs.accessSync(p); nodeExec = p; break; } catch {}
          }
        } catch {
          // nvm 없음 — 다른 경로 시도
          for (const p of candidates.slice(1)) {
            try { fs.accessSync(p); nodeExec = p; break; } catch {}
          }
        }
      }

      console.log('[coupangeats] 워커 프로세스 시작 (execPath:', nodeExec, ')');

      this.worker = fork(workerPath, [], {
        execPath: nodeExec,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      this.worker.stdout.on('data', (data) => {
        console.log(data.toString().trimEnd());
      });

      this.worker.stderr.on('data', (data) => {
        console.error(data.toString().trimEnd());
      });

      this.worker.on('message', (msg) => {
        switch (msg.type) {
          case 'status':
            this.onStatus({ site: 'coupangeats', ...msg });
            break;
          case 'result':
            results[msg.pageKey] = msg.result;
            break;
          case 'page-error':
            errors.push({ page: msg.pageKey, error: msg.error });
            break;
          case 'error':
            errors.push({ error: msg.error });
            break;
          case 'done':
            break;
        }
      });

      this.worker.on('exit', (code) => {
        console.log('[coupangeats] 워커 종료 (code:', code, ')');
        this.worker = null;
        resolve({ results, errors });
      });

      this.worker.on('error', (err) => {
        console.error('[coupangeats] 워커 에러:', err.message);
        this.worker = null;
        reject(err);
      });

      // 워커에 설정 전송
      this.worker.send({
        type: 'start',
        config: { id, pw },
      });
    });
  }

  close() {
    if (this.worker) {
      try { this.worker.kill(); } catch {}
      this.worker = null;
    }
  }
}

module.exports = { CoupangeatsCrawler };
