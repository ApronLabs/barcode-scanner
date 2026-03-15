// 크롤링 오케스트레이터 (PocRunner 기반)
// - 각 플랫폼별 POC 스크립트를 독립 Electron 프로세스로 실행
'use strict';

const PocRunner = require('./poc-runner');

class Crawler {
  constructor({ onStatus, onResult, onError, onComplete }) {
    this.onStatus = onStatus || (() => {});
    this.onResult = onResult || (() => {});
    this.onError = onError || (() => {});
    this.onComplete = onComplete || (() => {});
    this.runners = [];
  }

  // ─── 크롤링 시작 (PocRunner 기반) ──────────────────────────
  async start(sites, credentials, options = {}) {
    for (const site of sites) {
      const cred = credentials[site];
      if (!cred?.id) continue;

      const runner = new PocRunner(site, {
        onStatus: this.onStatus,
        onResult: this.onResult,
        onError: this.onError,
      });
      this.runners.push(runner);

      try {
        await runner.run(cred.id, cred.pw, options);
      } catch (err) {
        this.onError({ site, error: err.message });
      }
    }
    this.onComplete();
  }

  // ─── 정리 ──────────────────────────────────────────
  destroy() {
    for (const runner of this.runners) {
      runner.destroy();
    }
    this.runners = [];
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { Crawler };
