// 자동 크롤링 스케줄러
// - 매일 KST 11시에 어제 날짜 데이터 자동 수집
// - DB에 이미 수집된 데이터는 스킵
// - 첫 사용 시 2개월 백필
'use strict';

const { Crawler } = require('./crawler');

class AutoCrawlScheduler {
  /**
   * @param {object} opts
   * @param {Electron.BrowserWindow} [opts.mainWindow] - UI 알림용 (선택)
   * @param {object} opts.store - electron-store 인스턴스
   * @param {Function} opts.authenticatedFetch - main.js의 authenticatedFetch 함수
   * @param {Function} opts.getCredentials - 플랫폼 계정 가져오기 함수
   */
  constructor({ mainWindow, store, authenticatedFetch, getCredentials }) {
    this.mainWindow = mainWindow || null;
    this.store = store;
    this.authenticatedFetch = authenticatedFetch;
    this.getCredentials = getCredentials;
    this._interval = null;
    this._backfilling = false;
    this._backfillProgress = null;
    this._crawling = false;
  }

  start() {
    if (this._interval) return;
    console.log('[scheduler] 자동 크롤링 스케줄러 시작 (매일 KST 11시 실행)');
    this._interval = setInterval(() => this._checkAndRun(), 60_000);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    console.log('[scheduler] 스케줄러 중지');
  }

  getStatus() {
    const lastRunDate = this.store.get('schedulerLastRunDate') || null;
    return {
      enabled: !!this._interval,
      lastRunDate,
      isBackfilling: this._backfilling,
      backfillProgress: this._backfillProgress,
      isCrawling: this._crawling,
    };
  }

  // ─── 매분 체크: KST 11시이면 백필+일일 수집 실행 ───
  async _checkAndRun() {
    const now = new Date();
    const kstHour = new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCHours();
    if (kstHour !== 11) return;

    const todayStr = this._getKstToday();
    const lastRunDate = this.store.get('schedulerLastRunDate');
    if (lastRunDate === todayStr) return; // 오늘 이미 실행됨

    console.log('[scheduler] 11시 도달 — 백필+일일 크롤링 시작');
    await this.runBackfillAndDaily({ source: 'auto' });
  }

  // ─── 백필 + 일일 수집 통합 메서드 ───
  // @param {object} options
  // @param {string} options.source - 'manual' | 'auto'
  // @param {string[]} [options.sites] - 수동 시 UI에서 선택된 사이트
  // @param {object} [options.credentials] - 수동 시 전달
  // @param {Function} [options.onStatus] - 상태 콜백
  // @param {Function} [options.onResult] - 결과 콜백
  // @param {Function} [options.onError] - 에러 콜백
  // @param {Function} [options.onComplete] - 완료 콜백
  async runBackfillAndDaily(options = {}) {
    const { source = 'auto' } = options;
    const onStatus = options.onStatus || (() => {});
    const onResult = options.onResult || (() => {});
    const onError = options.onError || (() => {});
    const onComplete = options.onComplete || (() => {});

    // 1. 진행 중 체크
    if (this._crawling || this._backfilling) {
      const msg = '이미 크롤링/백필 진행 중입니다';
      console.log(`[scheduler] ${msg}`);
      onError({ error: msg });
      return { error: msg };
    }

    // 2. serverUrl, storeId 검증
    const serverUrl = this.store.get('serverUrl');
    const storeId = this.store.get('lastStoreId');
    if (!serverUrl || !storeId) {
      const msg = 'serverUrl 또는 storeId 미설정';
      console.log(`[scheduler] ${msg} — 스킵`);
      onError({ error: msg });
      return { error: msg };
    }

    // 3. credentials 획득
    let credentials;
    if (source === 'manual' && options.credentials) {
      credentials = options.credentials;
    } else {
      credentials = await this.getCredentials(storeId);
    }
    if (!credentials) {
      const msg = '계정 정보를 가져올 수 없습니다';
      console.log(`[scheduler] ${msg}`);
      onError({ error: msg });
      return { error: msg };
    }

    const yesterday = this._getKstYesterday();
    // 전전달 1일 계산 (예: 3/14 → 1/1)
    const yParts = yesterday.split('-').map(Number);
    const startDateObj = new Date(yParts[0], yParts[1] - 1 - 2, 1); // 전전달 1일
    const startDate60 = `${startDateObj.getFullYear()}-${String(startDateObj.getMonth() + 1).padStart(2, '0')}-01`;

    // 4. sync-status 확인 (전전달 1일 ~ 어제)
    let syncedDates = null;
    let syncStatusFailed = false;
    try {
      syncedDates = await this._checkSyncStatus(storeId, startDate60, yesterday);
      // syncedDates가 null이면 API 자체 실패 (401, 네트워크 에러 등)
      if (syncedDates === null) {
        syncStatusFailed = true;
        console.log('[scheduler] sync-status API 실패 — fallback (어제만 크롤링)');
      } else {
        // 빈 객체 {}는 "데이터 없음"이지 실패가 아님 → 백필 필요
        console.log('[scheduler] sync-status 결과:', JSON.stringify(Object.keys(syncedDates).reduce((a, k) => { a[k] = (syncedDates[k] || []).length + '건'; return a; }, {})));
      }
    } catch (err) {
      syncStatusFailed = true;
      console.error('[scheduler] sync-status 실패:', err.message, '— fallback (어제만 크롤링)');
    }

    const allSources = options.sites || ['baemin', 'yogiyo', 'coupangeats', 'ddangyoyo', 'okpos'];
    const availableSources = allSources.filter(src => credentials[src]?.id);
    if (availableSources.length === 0) {
      const msg = '등록된 플랫폼 계정이 없습니다';
      console.log(`[scheduler] ${msg}`);
      onError({ error: msg });
      return { error: msg };
    }

    // salesKeeper 옵션 구성
    const { session } = require('electron');
    const cookies = await session.defaultSession.cookies.get({ url: serverUrl, name: 'session-token' });
    const token = cookies.length > 0 ? cookies[0].value : '';
    if (!token) {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('session-expired');
      }
      const msg = '세션 토큰 없음 — 재로그인 필요';
      onError({ error: msg });
      return { error: msg };
    }

    const salesKeeperOpts = {
      salesKeeper: {
        apiBaseUrl: serverUrl,
        salesKeeperStoreId: storeId,
        sessionToken: token,
      },
    };

    // 5. sync-status 실패 시: 어제만 daily 크롤링 (fallback)
    if (syncStatusFailed) {
      console.log(`[scheduler] fallback — 어제(${yesterday}) daily 크롤링`);
      try {
        this._crawling = true;
        onStatus(`어제 데이터 크롤링 시작 (${yesterday})`);
        this._sendUpdate({ type: 'daily-start', targetDate: yesterday });

        await this._crawlPlatformsWithCallbacks(availableSources, credentials, yesterday, salesKeeperOpts, {
          onStatus, onResult, onError,
        });

        this.store.set('schedulerLastRunDate', this._getKstToday());
        this._sendUpdate({ type: 'daily-done', targetDate: yesterday, platforms: availableSources });
        onComplete({ type: 'daily-done', targetDate: yesterday, platforms: availableSources });
        console.log(`[scheduler] fallback 일일 수집 완료`);
      } catch (err) {
        console.error('[scheduler] fallback 일일 수집 오류:', err.message);
        this._sendUpdate({ type: 'daily-error', error: err.message });
        onError({ error: err.message });
      } finally {
        this._crawling = false;
      }
      return { success: true, mode: 'fallback-daily' };
    }

    // 6. 미수집 날짜/플랫폼 확인
    const needBackfillSites = availableSources.filter(src => {
      const synced = syncedDates[src] || [];
      const dateRange = this._getDateRange(startDate60, yesterday);
      return dateRange.some(d => !synced.includes(d));
    });

    // 7. 백필 실행 (미수집 있으면)
    if (needBackfillSites.length > 0) {
      console.log(`[scheduler] 백필 필요 사이트: ${needBackfillSites.join(', ')}`);
      try {
        this._backfilling = true;
        onStatus('백필 크롤링 시작');
        this._sendUpdate({ type: 'backfill-start', sites: needBackfillSites });

        await this._crawlPlatformsWithCallbacks(needBackfillSites, credentials, null, {
          ...salesKeeperOpts,
          mode: 'backfill',
        }, { onStatus, onResult, onError });

        this._sendUpdate({ type: 'backfill-done', sites: needBackfillSites });
        console.log('[scheduler] 백필 완료');
      } catch (err) {
        console.error('[scheduler] 백필 오류:', err.message);
        this._sendUpdate({ type: 'backfill-error', error: err.message });
        onError({ error: err.message });
      } finally {
        this._backfilling = false;
      }
    } else {
      console.log('[scheduler] 백필 불필요 — 모든 플랫폼 60일 데이터 수집 완료');
    }

    // 8. 어제 데이터 daily 크롤링 — 백필이 실행됐으면 어제 데이터도 포함되어 있으므로 건너뜀
    if (needBackfillSites.length > 0) {
      console.log('[scheduler] 백필에서 어제 데이터 포함 수집 완료 — daily 건너뜀');
      this.store.set('schedulerLastRunDate', this._getKstToday());
      onComplete({ type: 'backfill-and-daily-done', platforms: availableSources });
      console.log('[scheduler] runBackfillAndDaily 완료');
      return { success: true, mode: 'backfill' };
    }

    const needDailySites = availableSources.filter(src => {
      const synced = syncedDates[src] || [];
      return !synced.includes(yesterday);
    });

    if (needDailySites.length > 0) {
      console.log(`[scheduler] 어제(${yesterday}) 일일 크롤링 대상: ${needDailySites.join(', ')}`);
      try {
        this._crawling = true;
        onStatus(`어제 데이터 크롤링 시작 (${yesterday})`);
        this._sendUpdate({ type: 'daily-start', targetDate: yesterday });

        await this._crawlPlatformsWithCallbacks(needDailySites, credentials, yesterday, salesKeeperOpts, {
          onStatus, onResult, onError,
        });

        this.store.set('schedulerLastRunDate', this._getKstToday());
        this._sendUpdate({ type: 'daily-done', targetDate: yesterday, platforms: needDailySites });
        console.log(`[scheduler] ${yesterday} 일일 수집 완료`);
      } catch (err) {
        console.error('[scheduler] 일일 수집 오류:', err.message);
        this._sendUpdate({ type: 'daily-error', error: err.message });
        onError({ error: err.message });
      } finally {
        this._crawling = false;
      }
    } else {
      console.log(`[scheduler] ${yesterday} — 모든 플랫폼 이미 수집 완료`);
      this.store.set('schedulerLastRunDate', this._getKstToday());
    }

    // 완료 이벤트
    const completeData = {
      type: 'complete',
      source,
      backfillSites: needBackfillSites,
      dailySites: needDailySites,
      targetDate: yesterday,
    };
    this._sendUpdate(completeData);
    onComplete(completeData);
    console.log('[scheduler] runBackfillAndDaily 완료');
    return { success: true };
  }

  // ─── 크롤링 실행 (Crawler 인스턴스 생성 → 실행 → 파괴) ───
  async _crawlPlatforms(sites, credentials, targetDate) {
    const serverUrl = this.store.get('serverUrl');
    const storeId = this.store.get('lastStoreId');

    // 세션 토큰 가져오기
    const { session } = require('electron');
    const cookies = await session.defaultSession.cookies.get({ url: serverUrl, name: 'session-token' });
    const token = cookies.length > 0 ? cookies[0].value : '';
    if (!token) {
      // 세션 만료 — renderer에 알림
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('session-expired');
      }
      throw new Error('세션 토큰 없음 — 재로그인 필요');
    }

    const salesKeeperOpts = {
      targetDate,
      salesKeeper: {
        apiBaseUrl: serverUrl,
        salesKeeperStoreId: storeId,
        sessionToken: token,
      },
    };

    const crawler = new Crawler({
      onStatus: (msg) => console.log(`[scheduler:crawl] ${typeof msg === 'object' ? JSON.stringify(msg) : msg}`),
      onResult: (data) => console.log(`[scheduler:crawl] 결과: ${data?.site || JSON.stringify(data)}`),
      onError: (data) => console.error(`[scheduler:crawl] 오류: ${data?.site} — ${data?.error}`),
      onComplete: () => {},
    });

    try {
      await crawler.start(sites, credentials, salesKeeperOpts);
    } finally {
      crawler.destroy();
    }
  }

  // ─── 크롤링 실행 (콜백 지원 — runBackfillAndDaily용) ───
  async _crawlPlatformsWithCallbacks(sites, credentials, targetDate, salesKeeperOpts, callbacks = {}) {
    const { onStatus = () => {}, onResult = () => {}, onError = () => {} } = callbacks;
    const mode = salesKeeperOpts.mode || 'daily';

    const crawlerOpts = {
      ...salesKeeperOpts,
      ...(targetDate ? { targetDate } : {}),
    };

    const crawler = new Crawler({
      onStatus: (msg) => {
        console.log(`[scheduler:crawl] ${typeof msg === 'object' ? JSON.stringify(msg) : msg}`);
        onStatus(msg);
      },
      onResult: (data) => {
        console.log(`[scheduler:crawl] 결과: ${data?.site || JSON.stringify(data)}`);
        onResult(data);
      },
      onError: (data) => {
        console.error(`[scheduler:crawl] 오류: ${data?.site} — ${data?.error}`);
        onError(data);
      },
      onComplete: () => {},
    });

    try {
      await crawler.start(sites, credentials, crawlerOpts);
    } finally {
      crawler.destroy();
    }
  }

  // ─── Sync Status API 호출 ───
  async _checkSyncStatus(storeId, startDate, endDate) {
    const serverUrl = this.store.get('serverUrl');
    const sources = 'baemin,yogiyo,coupangeats,ddangyoyo,okpos';
    const url = `${serverUrl}/api/stores/${encodeURIComponent(storeId)}/crawler/sync-status?sources=${sources}&startDate=${startDate}&endDate=${endDate}`;

    try {
      const { unauthorized, response } = await this.authenticatedFetch(url);
      if (unauthorized) {
        console.warn('[scheduler] sync-status 401 — 세션 만료');
        return null; // API 실패
      }
      if (!response.ok) {
        console.warn('[scheduler] sync-status 응답 오류:', response.status);
        return null; // API 실패
      }
      const data = await response.json();
      return data.syncedDates || {}; // 빈 객체 = 데이터 없음 (정상)
    } catch (err) {
      console.error('[scheduler] sync-status 요청 실패:', err.message);
      return null; // API 실패
    }
  }

  // ─── 유틸리티 ───
  _getKstToday() {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return kst.toISOString().slice(0, 10);
  }

  _getKstYesterday() {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    kst.setDate(kst.getDate() - 1);
    return kst.toISOString().slice(0, 10);
  }

  _addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  _getDateRange(startDate, endDate) {
    const dates = [];
    const d = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');
    while (d <= end) {
      dates.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return dates;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _sendUpdate(data) {
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('scheduler-update', data);
      }
    } catch {}
  }
}

module.exports = { AutoCrawlScheduler };
