// 크롤링 오케스트레이터
// - 배민/요기요: Electron WebContentsView
// - 쿠팡이츠: rebrowser-puppeteer + 시스템 Chrome (Akamai Bot Manager 우회)
// - 땡겨요: rebrowser-puppeteer + 시스템 Chrome (WebSquare SPA)
'use strict';

const { WebContentsView } = require('electron');
const injector = require('./injector');
const { CoupangeatsCrawler } = require('./coupangeats');
const { DdangyoyoCrawler } = require('./ddangyoyo');

const SITE_CONFIG = {
  baemin: {
    name: '배달의민족',
    origin: 'https://self.baemin.com',
    loginUrl: 'https://self.baemin.com',
    pages: {
      orderHistory: 'https://self.baemin.com/orders/history',
    },
  },
  yogiyo: {
    name: '요기요',
    origin: 'https://ceo.yogiyo.co.kr',
    loginUrl: 'https://ceo.yogiyo.co.kr/login',
    pages: {
      orderHistory: 'https://ceo.yogiyo.co.kr/order-history/list',
    },
  },
  coupangeats: {
    name: '쿠팡이츠',
    origin: 'https://store.coupangeats.com',
    loginUrl: 'https://store.coupangeats.com/merchant/login',
    pages: {
      orders: 'https://store.coupangeats.com/merchant/management/orders',
      settlement: 'https://store.coupangeats.com/merchant/management/settlement',
    },
  },
  ddangyoyo: {
    name: '땡겨요',
    origin: 'https://boss.ddangyo.com',
    loginUrl: 'https://boss.ddangyo.com',
    pages: {
      orders: 'https://boss.ddangyo.com/#SH0402',
    },
  },
};

function isLoginUrl(siteKey, url) {
  if (url.includes('/login') || url.includes('/signin')) return true;
  if (siteKey === 'coupangeats') {
    const u = new URL(url);
    return u.pathname === '/' || u.pathname === '' || u.pathname === '/merchant/login';
  }
  return false;
}

class Crawler {
  constructor(mainWindow, { onStatus, onResult, onError, onComplete }) {
    this.mainWindow = mainWindow;
    this.onStatus = onStatus || (() => {});
    this.onResult = onResult || (() => {});
    this.onError = onError || (() => {});
    this.onComplete = onComplete || (() => {});
    this.view = null;
    this.results = {};
    this.errors = [];
    this.crawling = false;
    this.coupangeatsCrawler = null;
  }

  // ─── WebContentsView 생성/재사용 (배민/요기요용) ────
  getOrCreateView() {
    if (this.view) {
      const children = this.mainWindow.contentView.children;
      if (!children.includes(this.view)) {
        this.mainWindow.contentView.addChildView(this.view);
      }
      this.updateBounds();
      return this.view;
    }

    this.view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    const chromeUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    this.view.webContents.setUserAgent(chromeUA);

    // 자동화 감지 우회
    this.view.webContents.on('dom-ready', () => {
      this.view.webContents.executeJavaScript(`
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        delete window.process;
        delete window.require;
        delete window.__electron_webpack;
        delete window.__electronLog;
        delete window.Buffer;
        delete window.global;
        if (!window.chrome) {
          window.chrome = {
            app: { isInstalled: false },
            runtime: { id: undefined, connect: function(){}, sendMessage: function(){} },
            loadTimes: function(){ return {}; },
            csi: function(){ return {}; },
          };
        }
        Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
        if (window.outerWidth === 0) Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
        if (window.outerHeight === 0) Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
      `).catch(() => {});
    });

    this.mainWindow.contentView.addChildView(this.view);
    this.updateBounds();

    this.view.webContents.on('did-navigate', (_e, url) => {
      console.log('[view] did-navigate:', url);
    });
    this.view.webContents.on('did-fail-load', (_e, code, desc, url) => {
      if (code !== -3) console.warn('[view] did-fail-load:', code, desc, url);
    });

    this._resizeHandler = () => this.updateBounds();
    this.mainWindow.on('resize', this._resizeHandler);

    return this.view;
  }

  updateBounds() {
    if (!this.view || !this.mainWindow) return;
    const [w, h] = this.mainWindow.getContentSize();
    const uiHeight = 380;
    const children = this.mainWindow.contentView.children;
    if (children.length > 0) {
      children[0].setBounds({ x: 0, y: 0, width: w, height: uiHeight });
    }
    this.view.setBounds({ x: 0, y: uiHeight, width: w, height: h - uiHeight });
  }

  // ─── 크롤링 시작 ──────────────────────────────────────────
  async start(sites, credentials) {
    if (this.crawling) throw new Error('이미 크롤링 진행 중');
    this.crawling = true;
    this.results = {};
    this.errors = [];

    const targetSites = sites || ['baemin', 'yogiyo', 'coupangeats'];

    try {
      for (const siteKey of targetSites) {
        const config = SITE_CONFIG[siteKey];
        if (!config) continue;

        try {
          if (siteKey === 'coupangeats') {
            await this.crawlCoupangeats(credentials);
          } else if (siteKey === 'ddangyoyo') {
            await this.crawlDdangyoyo(credentials);
          } else {
            await this.crawlSite(siteKey, credentials);
          }
        } catch (err) {
          console.error(`[crawler] ${siteKey} 크롤링 실패:`, err);
          const errData = { site: siteKey, error: err.message };
          this.errors.push(errData);
          this.onError(errData);
        }
      }
    } finally {
      this.crawling = false;
      this.hideView();
      this.onComplete({
        completedAt: new Date().toISOString(),
        results: this.results,
        errors: this.errors,
      });
    }

    return { results: this.results, errors: this.errors };
  }

  // ─── 배민/요기요 크롤링 (기존 WebContentsView) ─────
  async crawlSite(siteKey, credentials) {
    const config = SITE_CONFIG[siteKey];
    this.getOrCreateView();
    this.onStatus({ site: siteKey, status: 'starting' });

    await this.performLogin(siteKey, credentials);

    for (const [pageKey, pageUrl] of Object.entries(config.pages)) {
      this.onStatus({ site: siteKey, page: pageKey, status: 'crawling' });
      try {
        const result = await this.extractPage(siteKey, pageKey, pageUrl);
        if (result?.success) {
          if (!this.results[siteKey]) this.results[siteKey] = {};
          this.results[siteKey][pageKey] = result;
          this.onResult(result);
        } else {
          throw new Error(result?.error || '데이터 추출 실패');
        }
      } catch (err) {
        console.error(`[crawler] ${siteKey}/${pageKey} 추출 실패:`, err);
        const errData = { site: siteKey, page: pageKey, error: err.message };
        this.errors.push(errData);
        this.onError(errData);
      }
    }
  }

  // ─── 쿠팡이츠 크롤링 (별도 프로세스 rebrowser-puppeteer) ─────────
  async crawlCoupangeats(credentials) {
    const creds = credentials?.coupangeats;
    if (!creds?.id || !creds?.pw) {
      console.log('[crawler] 쿠팡이츠 계정 정보 없음');
      this.onStatus({ site: 'coupangeats', status: 'manual_login_required' });
      return;
    }

    this.onStatus({ site: 'coupangeats', status: 'starting' });

    const ce = new CoupangeatsCrawler({
      onStatus: (data) => this.onStatus(data),
    });

    this.coupangeatsCrawler = ce;

    try {
      const { results, errors } = await ce.run(creds.id, creds.pw);

      // 결과 처리
      for (const [pageKey, result] of Object.entries(results)) {
        if (result?.success) {
          if (!this.results.coupangeats) this.results.coupangeats = {};
          this.results.coupangeats[pageKey] = result;
          this.onResult(result);
        }
      }

      // 에러 처리
      for (const err of errors) {
        const errData = { site: 'coupangeats', page: err.page, error: err.error };
        this.errors.push(errData);
        this.onError(errData);
      }

      if (Object.keys(results).length === 0 && errors.length > 0) {
        throw new Error(errors[0].error || '쿠팡이츠 크롤링 실패');
      }
    } finally {
      ce.close();
      this.coupangeatsCrawler = null;
    }
  }

  // ─── 땡겨요 크롤링 (별도 프로세스 rebrowser-puppeteer) ────────
  async crawlDdangyoyo(credentials) {
    const creds = credentials?.ddangyoyo;
    if (!creds?.id || !creds?.pw) {
      console.log('[crawler] 땡겨요 계정 정보 없음');
      this.onStatus({ site: 'ddangyoyo', status: 'manual_login_required' });
      return;
    }

    this.onStatus({ site: 'ddangyoyo', status: 'starting' });

    const dd = new DdangyoyoCrawler({
      onStatus: (data) => this.onStatus(data),
    });

    this.ddangyoyoCrawler = dd;

    try {
      const { results, errors } = await dd.run(creds.id, creds.pw);

      for (const [pageKey, result] of Object.entries(results)) {
        if (result?.success) {
          if (!this.results.ddangyoyo) this.results.ddangyoyo = {};
          this.results.ddangyoyo[pageKey] = result;
          this.onResult(result);
        }
      }

      for (const err of errors) {
        const errData = { site: 'ddangyoyo', page: err.page, error: err.error };
        this.errors.push(errData);
        this.onError(errData);
      }

      if (Object.keys(results).length === 0 && errors.length > 0) {
        throw new Error(errors[0].error || '땡겨요 크롤링 실패');
      }
    } finally {
      dd.close();
      this.ddangyoyoCrawler = null;
    }
  }

  // ─── 배민/요기요 자동 로그인 ───────────────────────
  async performLogin(siteKey, credentials) {
    const config = SITE_CONFIG[siteKey];
    const creds = credentials?.[siteKey];
    const view = this.view;

    console.log(`[crawler] ${config.name} 로그인 페이지 로드: ${config.loginUrl}`);
    await this.navigateAndWait(config.loginUrl);
    await this.sleep(3000);

    let currentUrl = view.webContents.getURL();
    console.log(`[crawler] ${config.name} 로드 후 URL: ${currentUrl}`);

    if (!isLoginUrl(siteKey, currentUrl)) {
      try {
        await view.webContents.executeJavaScript(injector.getExtractorScript());
        const isLoggedIn = await view.webContents.executeJavaScript(injector.getCheckLoginScript(siteKey));
        if (isLoggedIn) {
          console.log(`[crawler] ${config.name} 이미 로그인됨`);
          return;
        }
      } catch (err) {
        console.log(`[crawler] 로그인 확인 오류:`, err.message);
      }
    }

    if (!creds?.id || !creds?.pw) {
      console.log(`[crawler] ${config.name} 계정 정보 없음`);
      this.onStatus({ site: siteKey, status: 'manual_login_required' });
      await this.waitForLoginRedirect(siteKey, 30000);
      return;
    }

    this.onStatus({ site: siteKey, status: 'logging_in' });

    currentUrl = view.webContents.getURL();
    if (!isLoginUrl(siteKey, currentUrl)) {
      await this.navigateAndWait(config.loginUrl);
      await this.sleep(3000);
    }

    try {
      const loginResult = await view.webContents.executeJavaScript(
        injector.getAutoLoginScript(creds.id, creds.pw)
      );
      console.log(`[crawler] ${config.name} 로그인 결과:`, loginResult);
    } catch (err) {
      console.error(`[crawler] ${config.name} 로그인 스크립트 오류:`, err);
    }

    try {
      await this.waitForLoginRedirect(siteKey, 15000);
    } catch {}
    await this.sleep(2000);

    currentUrl = view.webContents.getURL();
    if (isLoginUrl(siteKey, currentUrl)) {
      console.log(`[crawler] ${config.name} 자동 로그인 실패 → 수동 로그인 대기 (60초)`);
      this.onStatus({ site: siteKey, status: 'manual_login_required' });
      await this.waitForLoginRedirect(siteKey, 60000);
      await this.sleep(2000);
    }
  }

  // ─── 로그인 리다이렉트 대기 ────────────────────────
  waitForLoginRedirect(siteKey, timeoutMs = 20000) {
    const view = this.view;
    return new Promise((resolve) => {
      const currentUrl = view.webContents.getURL();
      if (!isLoginUrl(siteKey, currentUrl)) {
        resolve(currentUrl);
        return;
      }

      let resolved = false;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearInterval(pollInterval);
        clearTimeout(timeout);
        view.webContents.removeListener('did-navigate', onNav);
        view.webContents.removeListener('did-navigate-in-page', onNav);
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve(view.webContents.getURL());
      }, timeoutMs);

      const onNav = (_event, url) => {
        if (!isLoginUrl(siteKey, url)) { cleanup(); resolve(url); }
      };

      view.webContents.on('did-navigate', onNav);
      view.webContents.on('did-navigate-in-page', onNav);

      const pollInterval = setInterval(() => {
        const url = view.webContents.getURL();
        if (!isLoginUrl(siteKey, url)) { cleanup(); resolve(url); }
      }, 1000);
    });
  }

  // ─── 페이지 데이터 추출 (배민/요기요) ──────────────
  async extractPage(siteKey, pageKey, pageUrl) {
    const view = this.view;
    const currentUrl = view.webContents.getURL();
    if (!currentUrl.startsWith(pageUrl)) {
      console.log(`[crawler] 페이지 이동: ${pageUrl}`);
      await this.navigateAndWait(pageUrl);
      await this.sleep(3000);
    }

    await view.webContents.executeJavaScript(injector.getExtractorScript());

    let extractScript;
    if (siteKey === 'baemin') {
      extractScript = injector.getBaeminExtractScript();
    } else if (siteKey === 'yogiyo') {
      extractScript = injector.getYogiyoExtractScript();
    } else {
      throw new Error(`알 수 없는 사이트: ${siteKey}`);
    }

    console.log(`[crawler] ${siteKey}/${pageKey} 데이터 추출 시작`);
    const result = await view.webContents.executeJavaScript(extractScript);
    console.log(`[crawler] ${siteKey}/${pageKey} 추출 결과:`, result?.success, 'tables:', result?.tables?.length);
    return result;
  }

  // ─── URL 이동 + 로드 완료 대기 ─────────────────────
  navigateAndWait(url, timeoutMs = 30000) {
    const view = this.view;
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
      };

      const timeout = setTimeout(() => {
        console.log(`[crawler] 페이지 로딩 타임아웃 (계속 진행): ${url}`);
        done();
        resolve();
      }, timeoutMs);

      view.webContents.once('did-finish-load', () => {
        console.log(`[crawler] 페이지 로드 완료: ${view.webContents.getURL()}`);
        done();
        resolve();
      });

      view.webContents.loadURL(url).catch(() => {});
    });
  }

  // ─── 웹뷰 숨기기 ──────────────────────────────────
  hideView() {
    if (!this.view || !this.mainWindow) return;
    try {
      this.mainWindow.contentView.removeChildView(this.view);
      const [w, h] = this.mainWindow.getContentSize();
      const children = this.mainWindow.contentView.children;
      if (children.length > 0) {
        children[0].setBounds({ x: 0, y: 0, width: w, height: h });
      }
    } catch {}
  }

  // ─── 정리 ──────────────────────────────────────────
  destroy() {
    if (this._resizeHandler) {
      this.mainWindow.removeListener('resize', this._resizeHandler);
    }
    if (this.view) {
      try {
        this.mainWindow.contentView.removeChildView(this.view);
        this.view.webContents.close();
      } catch {}
      this.view = null;
    }
    if (this.coupangeatsCrawler) {
      this.coupangeatsCrawler.close().catch(() => {});
      this.coupangeatsCrawler = null;
    }
    if (this.ddangyoyoCrawler) {
      this.ddangyoyoCrawler.close().catch(() => {});
      this.ddangyoyoCrawler = null;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { Crawler, SITE_CONFIG };
