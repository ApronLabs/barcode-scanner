// 자동 크롤링 스케줄러
// - 1시간 단위로 전날 데이터 수집 시도 (성공한 플랫폼은 스킵)
// - DB에 이미 수집된 데이터는 스킵 (sync-status API 기반)
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
    // 식봄 전용 30분 interval (hourly 크롤링과 독립)
    this._sikbomInterval = null;
    this._sikbomRunning = false;
  }

  start() {
    if (this._interval) return;
    console.log('[scheduler] 자동 크롤링 스케줄러 시작 (1시간 단위 시도)');
    this._interval = setInterval(() => this._checkAndRun(), 60_000);
    this.startSikbomInterval();
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this.stopSikbomInterval();
    console.log('[scheduler] 스케줄러 중지');
  }

  // ─── 식봄 30분 인터벌 ───
  // 앱이 켜져 있을 때 30분마다 식봄 스크래퍼만 실행.
  // 서버의 pending 엔드포인트가 이미 `orderDate >= 오늘-3일` 필터를 적용하므로
  // 각 tick에서 해당 범위의 미수집 주문만 수집하고, 수집된 주문은 status가
  // 'ordered'로 바뀌어 다음 tick에 빠짐 → 중복 수집 없음.
  startSikbomInterval() {
    if (this._sikbomInterval) return;
    const INTERVAL_MS = 30 * 60 * 1000;
    console.log('[scheduler] 식봄 30분 interval 시작');
    // 시작 직후 1회 즉시 실행 (앱 방금 켰을 때도 바로 긁어온다)
    setTimeout(() => this._runSikbomOnce().catch(err => {
      console.error('[scheduler] 식봄 초기 실행 오류:', err.message);
    }), 5_000);
    this._sikbomInterval = setInterval(() => {
      this._runSikbomOnce().catch(err => {
        console.error('[scheduler] 식봄 interval 실행 오류:', err.message);
      });
    }, INTERVAL_MS);
  }

  stopSikbomInterval() {
    if (this._sikbomInterval) {
      clearInterval(this._sikbomInterval);
      this._sikbomInterval = null;
      console.log('[scheduler] 식봄 interval 중지');
    }
  }

  async _postSchedulerTrace(serverUrl, storeId, token, events) {
    if (!serverUrl || !storeId || !token || events.length === 0) return;
    try {
      await fetch(
        `${serverUrl}/api/stores/${storeId}/supplier-scrapers/sikbom/trace`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `session-token=${token}`,
          },
          body: JSON.stringify({ events }),
        }
      );
    } catch (err) {
      console.log('[scheduler] trace POST 실패:', err.message);
    }
  }

  async _runSikbomOnce() {
    const runId = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const serverUrl = this.store.get('serverUrl');
    const storeId = this.store.get('lastStoreId');

    // 세션 토큰 먼저 확보해서 이후 skip 사유도 서버로 쏠 수 있게
    let token = '';
    if (serverUrl) {
      try {
        const { session } = require('electron');
        const cookies = await session.defaultSession.cookies.get({
          url: serverUrl,
          name: 'session-token',
        });
        token = cookies.length > 0 ? cookies[0].value : '';
      } catch {}
    }

    const emitSkip = async (reason) => {
      console.log(`[scheduler] 식봄 스킵: ${reason}`);
      this._sendUpdate({ type: 'sikbom-skip', reason });
      await this._postSchedulerTrace(serverUrl, storeId, token, [
        { runId, level: 'skip', event: 'skip', message: reason },
      ]);
    };

    if (this._sikbomRunning) {
      await emitSkip('이전 실행 진행 중');
      return;
    }
    if (!serverUrl) { await emitSkip('serverUrl 미설정 (로그인 필요)'); return; }
    if (!storeId)   { await emitSkip('storeId 미설정 (매장 선택 필요)'); return; }
    if (!token)     { await emitSkip('세션 토큰 없음 — 노심 재로그인 필요'); return; }

    let credentials;
    try {
      credentials = await this.getCredentials(storeId);
    } catch (err) {
      await emitSkip(`크레덴셜 조회 실패: ${err.message}`);
      return;
    }
    if (!credentials || !credentials.sikbom?.id) {
      await emitSkip('식봄 계정 미등록');
      return;
    }

    const salesKeeperOpts = {
      salesKeeper: {
        apiBaseUrl: serverUrl,
        salesKeeperStoreId: storeId,
        sessionToken: token,
      },
      // poc-sikbom.js 내부에서 trace POST 할 때 동일 runId 사용하도록 전달
      sikbomRunId: runId,
    };

    this._sikbomRunning = true;
    try {
      console.log('[scheduler] 식봄 실행 시작 runId=', runId);
      this._sendUpdate({ type: 'sikbom-start' });
      await this._postSchedulerTrace(serverUrl, storeId, token, [
        { runId, level: 'info', event: 'sched-start', message: '스케줄러가 식봄 스크래퍼 시작' },
      ]);

      await this._crawlPlatformsWithCallbacks(
        ['sikbom'],
        credentials,
        null,
        salesKeeperOpts,
        {
          onStatus: (msg) => this._sendUpdate({ type: 'sikbom-status', ...msg }),
          onResult: (data) => this._sendUpdate({ type: 'sikbom-result', ...data }),
          onError: (data) => this._sendUpdate({ type: 'sikbom-error', ...data }),
        }
      );
      this.store.set('sikbomLastRunAt', Date.now());
      this._sendUpdate({ type: 'sikbom-done' });
      await this._postSchedulerTrace(serverUrl, storeId, token, [
        { runId, level: 'info', event: 'sched-done', message: '스케줄러 종료' },
      ]);
      console.log('[scheduler] 식봄 실행 완료 runId=', runId);
    } catch (err) {
      console.error('[scheduler] 식봄 실행 오류:', err.message);
      this._sendUpdate({ type: 'sikbom-error', error: err.message });
      await this._postSchedulerTrace(serverUrl, storeId, token, [
        { runId, level: 'error', event: 'sched-error', message: err.message },
      ]);
    } finally {
      this._sikbomRunning = false;
    }
  }

  getStatus() {
    const lastRunDate = this.store.get('schedulerLastRunDate') || null;
    const lastAttemptSlot = this.store.get('schedulerLastAttemptSlot') || null;
    return {
      enabled: !!this._interval,
      lastRunDate,
      lastAttemptSlot,
      isBackfilling: this._backfilling,
      backfillProgress: this._backfillProgress,
      isCrawling: this._crawling,
    };
  }

  // ─── 매분 체크: 1시간 단위로 백필+일일 수집 시도 ───
  // 매 정시마다 sync-status 확인 후 미수집 플랫폼만 크롤링
  // POS 컴퓨터가 언제 켜져도 1시간 내 전날 데이터 수집
  async _checkAndRun() {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const kstHour = kst.getUTCHours();
    const todayStr = this._getKstToday();

    // 1시간에 한 번만 시도 (YYYY-MM-DD-HH 단위)
    const currentSlot = `${todayStr}-${String(kstHour).padStart(2, '0')}`;
    const lastAttemptSlot = this.store.get('schedulerLastAttemptSlot');
    if (lastAttemptSlot === currentSlot) return;

    this.store.set('schedulerLastAttemptSlot', currentSlot);
    console.log(`[scheduler] 매시 체크 (KST ${currentSlot}) — 백필+일일 크롤링 시도`);
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
    // v3.5.4: 백필 시작일을 올해 1월 1일로 확장 (이전: 전전달 1일)
    const yParts = yesterday.split('-').map(Number);
    const backfillStart = `${yParts[0]}-01-01`;

    // 4. sync-status 확인 (1월 1일 ~ 어제)
    let syncedDates = null;
    let syncStatusFailed = false;
    try {
      syncedDates = await this._checkSyncStatus(storeId, backfillStart, yesterday);
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

    // 식봄은 날짜 기반 backfill/daily 개념이 없어 이 경로에서 제외.
    // 대신 startSikbomInterval의 30분 interval이 별도로 돌린다.
    const allSources = options.sites || ['baemin', 'yogiyo', 'coupangeats', 'ddangyoyo', 'okpos'];
    const availableSources = allSources.filter(src => credentials[src]?.id);
    if (availableSources.length === 0) {
      const msg = '등록된 플랫폼 계정이 없습니다';
      console.log(`[scheduler] ${msg}`);
      onError({ error: msg });
      return { error: msg };
    }

    const dateBasedSources = availableSources;

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

    // 배달 플랫폼 경로가 어떻게 끝나든(fallback/backfill/daily/all-synced) 식봄은
    // 항상 한 번 시도하도록 보장. _runSikbomOnce 내부에 _sikbomRunning 가드가 있어
    // 30분 interval과 중복 실행이 되어도 안전.
    const maybeRunSikbom = async () => {
      if (credentials.sikbom?.id) {
        await this._runSikbomOnce().catch((err) => {
          console.error('[scheduler] runBackfillAndDaily 식봄 오류:', err.message);
        });
      }
    };

    // 5. sync-status 실패 시: 어제만 daily 크롤링 (fallback)
    if (syncStatusFailed) {
      console.log(`[scheduler] fallback — 어제(${yesterday}) daily 크롤링`);
      try {
        this._crawling = true;
        onStatus(`어제 데이터 크롤링 시작 (${yesterday})`);
        this._sendUpdate({ type: 'daily-start', targetDate: yesterday });

        await this._crawlPlatformsWithCallbacks(dateBasedSources, credentials, yesterday, salesKeeperOpts, {
          onStatus, onResult, onError,
        });

        this.store.set('schedulerLastRunDate', this._getKstToday());
        this._sendUpdate({ type: 'daily-done', targetDate: yesterday, platforms: dateBasedSources });
        onComplete({ type: 'daily-done', targetDate: yesterday, platforms: availableSources });
        console.log(`[scheduler] fallback 일일 수집 완료`);
      } catch (err) {
        console.error('[scheduler] fallback 일일 수집 오류:', err.message);
        this._sendUpdate({ type: 'daily-error', error: err.message });
        onError({ error: err.message });
      } finally {
        this._crawling = false;
      }
      await maybeRunSikbom();
      return { success: true, mode: 'fallback-daily' };
    }

    // 6. 미수집 날짜/플랫폼 확인
    const needBackfillSites = dateBasedSources.filter(src => {
      const synced = syncedDates[src] || [];
      const dateRange = this._getDateRange(backfillStart, yesterday);
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
      console.log('[scheduler] 백필 불필요 — 모든 플랫폼 1월 1일부터 전 기간 수집 완료');
    }

    // 8. 어제 데이터 daily 크롤링 — 백필이 실행됐으면 어제 데이터도 포함되어 있으므로 건너뜀
    if (needBackfillSites.length > 0) {
      console.log('[scheduler] 백필에서 어제 데이터 포함 수집 완료 — daily 건너뜀');
      this.store.set('schedulerLastRunDate', this._getKstToday());
      await maybeRunSikbom();
      onComplete({ type: 'backfill-and-daily-done', platforms: availableSources });
      console.log('[scheduler] runBackfillAndDaily 완료');
      return { success: true, mode: 'backfill' };
    }

    const needDailySites = dateBasedSources.filter(src => {
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

    // 배달 플랫폼 경로가 끝났으니 식봄도 한 번 시도
    await maybeRunSikbom();

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
