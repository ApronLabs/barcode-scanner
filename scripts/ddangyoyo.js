// 땡겨요 크롤러 - child process로 rebrowser 실행
// 쿠팡이츠와 동일한 fork 패턴
'use strict';

const { fork } = require('child_process');
const path = require('path');

class DdangyoyoCrawler {
  constructor({ onStatus } = {}) {
    this.worker = null;
    this.onStatus = onStatus || (() => {});
  }

  /**
   * @param {string} id - 땡겨요 로그인 ID
   * @param {string} pw - 땡겨요 비밀번호
   * @param {object} [options] - 추가 옵션
   * @param {string} [options.targetDate] - 크롤링 대상 날짜 (YYYY-MM-DD)
   * @param {string} [options.brandName] - 브랜드명
   * @param {object} [options.salesKeeper] - 매출지킴이 전송 설정
   * @param {string} [options.mode] - 실행 모드 ('backfill': 90일 백필)
   */
  run(id, pw, options = {}) {
    return new Promise((resolve, reject) => {
      const workerPath = path.join(__dirname, 'ddangyoyo-worker.js');
      const results = {};
      const errors = [];

      // Electron 환경에서 fork할 때 순수 Node.js execPath 사용
      let nodeExec = process.execPath;
      if (nodeExec.includes('Electron') || nodeExec.includes('electron')) {
        const fs = require('fs');
        const os = require('os');
        const nvmDir = path.join(os.homedir(), '.nvm/versions/node');
        try {
          const versions = fs.readdirSync(nvmDir).filter(v => v.startsWith('v')).sort((a, b) => {
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
          const candidates = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];
          for (const p of candidates) {
            try { fs.accessSync(p); nodeExec = p; break; } catch {}
          }
        }
      }

      console.log('[ddangyoyo] 워커 프로세스 시작 (execPath:', nodeExec, ')');

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
            this.onStatus({ site: 'ddangyoyo', ...msg });
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
        console.log('[ddangyoyo] 워커 종료 (code:', code, ')');
        this.worker = null;
        resolve({ results, errors });
      });

      this.worker.on('error', (err) => {
        console.error('[ddangyoyo] 워커 에러:', err.message);
        this.worker = null;
        reject(err);
      });

      this.worker.send({
        type: 'start',
        config: {
          id,
          pw,
          targetDate: options.targetDate,
          brandName: options.brandName,
          salesKeeper: options.salesKeeper,
          mode: options.mode,
        },
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

module.exports = { DdangyoyoCrawler };
