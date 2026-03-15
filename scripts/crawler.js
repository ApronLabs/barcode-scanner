// 크롤링 오케스트레이터
// - 배민/요기요/땡겨요: Electron WebContentsView + API 인터셉트
// - 쿠팡이츠: rebrowser-puppeteer + 시스템 Chrome (Akamai Bot Manager 우회)
'use strict';

const { WebContentsView } = require('electron');
const injector = require('./injector');
const { CoupangeatsCrawler } = require('./coupangeats');

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
  // @param {string[]} sites - 크롤링 대상 사이트 목록
  // @param {object} credentials - 사이트별 로그인 정보
  // @param {object} [options] - 추가 옵션
  // @param {string} [options.targetDate] - 크롤링 대상 날짜 (YYYY-MM-DD)
  // @param {string} [options.brandName] - 브랜드명
  // @param {object} [options.salesKeeper] - 매출지킴이 전송 설정
  // @param {string} [options.mode] - 크롤링 모드: 'daily' (기본) | 'backfill' (기간 범위)
  async start(sites, credentials, options = {}) {
    if (this.crawling) throw new Error('이미 크롤링 진행 중');
    this.crawling = true;
    this.results = {};
    this.errors = [];

    const mode = options.mode || 'daily';
    const targetSites = sites || ['baemin', 'yogiyo', 'coupangeats'];

    console.log(`[crawler] start() mode=${mode}, sites=${targetSites.join(',')}`);

    try {
      for (const siteKey of targetSites) {
        const config = SITE_CONFIG[siteKey];
        if (!config) continue;

        try {
          if (mode === 'backfill') {
            // 백필 모드: 배민/요기요는 Range 메서드, 쿠팡이츠/땡겨요는 기존 worker에서 mode 처리
            if (siteKey === 'baemin') {
              this.getOrCreateView();
              this.onStatus({ site: siteKey, status: 'starting', mode: 'backfill' });
              await this.performLogin(siteKey, credentials);
              await this.crawlBaeminRange(options);
            } else if (siteKey === 'yogiyo') {
              this.getOrCreateView();
              this.onStatus({ site: siteKey, status: 'starting', mode: 'backfill' });
              await this.performLogin(siteKey, credentials);
              await this.crawlYogiyoRange(options);
            } else if (siteKey === 'coupangeats') {
              await this.crawlCoupangeats(credentials, options);
            } else {
              await this.crawlSite(siteKey, credentials, options);
            }
          } else {
            // daily 모드: 기존 로직
            if (siteKey === 'coupangeats') {
              await this.crawlCoupangeats(credentials, options);
            } else {
              await this.crawlSite(siteKey, credentials, options);
            }
          }
        } catch (err) {
          console.error(`[crawler] ${siteKey} 크롤링 실패 (${mode}):`, err);
          const errData = { site: siteKey, error: err.message, mode };
          this.errors.push(errData);
          this.onError(errData);
        }
      }
    } finally {
      this.crawling = false;
      this.hideView();
      this.onComplete({
        completedAt: new Date().toISOString(),
        mode,
        results: this.results,
        errors: this.errors,
      });
    }

    return { results: this.results, errors: this.errors };
  }

  // ─── 배민/요기요/땡겨요 크롤링 (WebContentsView + API 인터셉트) ─────
  async crawlSite(siteKey, credentials, options = {}) {
    const config = SITE_CONFIG[siteKey];
    this.getOrCreateView();
    this.onStatus({ site: siteKey, status: 'starting' });

    await this.performLogin(siteKey, credentials);

    // API 인터셉트 방식
    const crawlMethod = siteKey === 'baemin' ? 'crawlBaeminApi'
      : siteKey === 'yogiyo' ? 'crawlYogiyoApi'
      : siteKey === 'ddangyoyo' ? 'crawlDdangyoyoApi'
      : null;
    if (crawlMethod) {
      try {
        await this[crawlMethod](options);
      } catch (err) {
        console.error(`[crawler] ${siteKey} API 크롤링 실패:`, err);
        this.errors.push({ site: siteKey, page: 'orderHistory', error: err.message });
        this.onError({ site: siteKey, page: 'orderHistory', error: err.message });
      }
    }

    // 매출지킴이 전송
    if (options.salesKeeper) {
      try {
        await this.sendSiteDataToSalesKeeper(siteKey, options);
      } catch (err) {
        console.error(`[crawler] ${siteKey} 매출지킴이 전송 실패:`, err.message);
      }
    }
  }

  // ─── 배민 API 인터셉트 크롤링 (주문+정산 동시 수집) ─────
  async crawlBaeminApi(options = {}) {
    const view = this.view;
    const targetDate = options.targetDate;
    this.onStatus({ site: 'baemin', page: 'orderHistory', status: 'crawling' });

    // 1) 주문내역 페이지 이동 + 인터셉트 설치 (dom-ready)
    console.log('[crawler] 배민 API 크롤링 시작');
    const interceptScript = injector.getBaeminInterceptScript();
    view.webContents.once('dom-ready', () => {
      view.webContents.executeJavaScript(interceptScript).catch(() => {});
    });
    await this.navigateAndWait('https://self.baemin.com/orders/history');
    await this.sleep(3000);
    // 재설치 (SPA 대비)
    await view.webContents.executeJavaScript(interceptScript).catch(() => {});
    await this.sleep(3000);

    // 2) 날짜 필터 적용 → API 호출 트리거
    if (targetDate) {
      console.log(`[crawler] 배민 날짜 필터 적용: ${targetDate}`);
      try {
        const filterResult = await view.webContents.executeJavaScript(
          injector.getBaeminDateFilterScript(targetDate)
        );
        console.log('[crawler] 배민 날짜 필터 결과:', filterResult);
        await this.sleep(3000);
      } catch (err) {
        console.error('[crawler] 배민 날짜 필터 실패:', err.message);
      }
    }

    // 3) shopOwnerNumber 캡처
    const shopOwnerNumber = await view.webContents.executeJavaScript(`(function() {
      const c = window._baeminCapturedResponses || [];
      for (const x of c) { const m = x.url.match(/shopOwnerNumber=(\\d+)/); if (m) return m[1]; }
      return null;
    })()`);
    if (!shopOwnerNumber) throw new Error('shopOwnerNumber 캡처 실패');
    console.log(`[crawler] 배민 shopOwnerNumber: ${shopOwnerNumber}`);

    // 4) 첫 페이지 인터셉트 데이터 읽기
    const firstPage = await view.webContents.executeJavaScript(`(function() {
      const c = window._baeminCapturedResponses || [];
      for (let i = c.length - 1; i >= 0; i--) {
        if (c[i].url.includes('/v4/orders') && !c[i].url.includes('commerce') && !c[i].url.includes('ad-')
            && c[i].url.includes('startDate=${targetDate}') && c[i].url.includes('endDate=${targetDate}')) {
          return c[i].data;
        }
      }
      return null;
    })()`);
    if (!firstPage) throw new Error('첫 페이지 API 응답 없음');

    const allOrders = [...(firstPage.contents || [])];
    const totalSize = firstPage.totalSize || 0;
    console.log(`[crawler] 배민 총 주문: ${totalSize}건 / 매출: ${(firstPage.totalPayAmount || 0).toLocaleString()}원`);

    // 5) 추가 페이지 수집 — "다음" 버튼으로 UI 페이지네이션
    let pg = 1;
    while (allOrders.length < totalSize) {
      pg++;
      const prevCount = await view.webContents.executeJavaScript(`
        window._baeminCapturedResponses.filter(x => x.url.includes('/v4/orders') && !x.url.includes('commerce') && !x.url.includes('ad-')).length
      `);

      const clicked = await view.webContents.executeJavaScript(`(function() {
        const nextBtn = Array.from(document.querySelectorAll('button, a')).find(function(b) {
          const label = (b.getAttribute('aria-label') || '');
          const text = b.innerText.trim();
          return label.includes('다음') || label.includes('next') ||
                 text === '›' || text === '>' || text === '»' || text === '다음';
        });
        if (!nextBtn || nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true') return false;
        nextBtn.click();
        return true;
      })()`);

      if (!clicked) { console.log(`[crawler] 배민 page ${pg}: 마지막 페이지`); break; }

      let newData = null;
      for (let wait = 0; wait < 10; wait++) {
        await this.sleep(1000);
        const newCount = await view.webContents.executeJavaScript(`
          window._baeminCapturedResponses.filter(x => x.url.includes('/v4/orders') && !x.url.includes('commerce') && !x.url.includes('ad-')).length
        `);
        if (newCount > prevCount) {
          newData = await view.webContents.executeJavaScript(`(function() {
            const c = window._baeminCapturedResponses.filter(x => x.url.includes('/v4/orders') && !x.url.includes('commerce') && !x.url.includes('ad-'));
            return c[c.length - 1].data;
          })()`);
          break;
        }
      }

      if (!newData) { console.log(`[crawler] 배민 page ${pg}: 응답 대기 타임아웃`); break; }
      const contents = newData.contents || [];
      console.log(`[crawler] 배민 [page ${pg}] ${contents.length}건`);
      allOrders.push(...contents);
      if (contents.length === 0) break;
    }

    console.log(`[crawler] 배민 전체 ${allOrders.length}건 수집 완료`);

    // 6) API 데이터를 결과 형식으로 변환
    const findCode = (items, code) => (items || []).find(i => i.code === code)?.amount || 0;
    const apiOrders = allOrders.map(item => {
      const o = item.order || {};
      const s = item.settle || {};
      return {
        orderId: o.orderNumber || '',
        orderedAt: o.orderDateTime || '',
        orderType: o.deliveryType === 'DELIVERY' ? 'delivery' : o.deliveryType === 'TAKEOUT' ? 'pickup' : (o.deliveryType || ''),
        channel: o.deliveryType || '',
        paymentMethod: o.payType || '',
        menuSummary: o.itemsSummary || '',
        menuAmount: o.payAmount || 0,
        deliveryTip: o.deliveryTip || 0,
        instantDiscount: o.totalInstantDiscountAmount || 0,
        commissionFee: Math.abs(findCode(s.orderBrokerageItems, 'ADVERTISE_FEE')),
        pgFee: Math.abs(findCode(s.etcItems, 'SERVICE_FEE')),
        deliveryCost: Math.abs(s.deliveryItemAmount || 0),
        vat: Math.abs(s.deductionAmountTotalVat || 0),
        meetPayment: s.meetAmount || 0,
        settlementAmount: s.depositDueAmount || 0,
        settlementDate: s.depositDueDate || '',
        platformDiscount: Math.abs(findCode(s.orderBrokerageItems, 'DISCOUNT_AMOUNT')),
        rawData: item,
      };
    });

    const result = {
      success: true,
      site: 'baemin',
      pageType: 'orderHistory',
      extractedAt: new Date().toISOString(),
      totalSize,
      totalPayAmount: firstPage.totalPayAmount || 0,
      apiOrders,
    };

    if (!this.results.baemin) this.results.baemin = {};
    this.results.baemin.orderHistory = result;
    this.onResult(result);
  }

  // ─── 요기요 API 인터셉트 크롤링 (주문+정산 동시 수집) ─────
  // POC 검증 완료: Electron WebContentsView (hidden) + fetch/XHR intercept
  // 플로우: 인터셉트 설치 → 주문내역 이동 → 날짜 필터 → /proxy/orders/ 캡처 → 행 클릭 → order_detail 캡처
  async crawlYogiyoApi(options = {}) {
    const view = this.view;
    const targetDate = options.targetDate;
    this.onStatus({ site: 'yogiyo', page: 'orderHistory', status: 'crawling' });

    // 1) 주문내역 페이지 이동 + 인터셉트 설치
    console.log('[crawler] 요기요 API 크롤링 시작');
    const interceptScript = injector.getYogiyoInterceptScript();
    view.webContents.once('dom-ready', () => {
      view.webContents.executeJavaScript(interceptScript).catch(() => {});
    });
    await this.navigateAndWait('https://ceo.yogiyo.co.kr/order-history/list');
    await this.sleep(5000);
    await view.webContents.executeJavaScript(interceptScript).catch(() => {});
    await this.sleep(3000);

    // 2) 날짜 필터 적용
    if (targetDate) {
      console.log(`[crawler] 요기요 날짜 필터 적용: ${targetDate}`);
      try {
        const filterResult = await view.webContents.executeJavaScript(
          injector.getYogiyoDateFilterScript(targetDate)
        );
        console.log('[crawler] 요기요 날짜 필터 결과:', filterResult);
        await this.sleep(5000);
      } catch (err) {
        console.error('[crawler] 요기요 날짜 필터 실패:', err.message);
      }
    }

    // 3) /proxy/orders/ 응답 캡처
    const ordersData = await view.webContents.executeJavaScript(`(function() {
      const c = window._yogiyoCapturedResponses || [];
      for (let i = c.length - 1; i >= 0; i--) {
        if (c[i].url.includes('/proxy/orders')) {
          const d = c[i].data;
          if (d.orders || d.results) return d;
        }
      }
      return null;
    })()`);
    if (!ordersData) throw new Error('요기요 주문 API 캡처 실패');

    const allOrders = ordersData.orders || ordersData.results || [];
    console.log(`[crawler] 요기요 총 주문: ${ordersData.count || allOrders.length}건 / 매출: ${(ordersData.orders_price || 0).toLocaleString()}원`);

    // targetDate 필터 (submitted_at 기반)
    const dateFiltered = targetDate
      ? allOrders.filter(o => (o.submitted_at || '').split(' ')[0] === targetDate)
      : allOrders;
    console.log(`[crawler] 요기요 ${targetDate || '전체'} 필터: ${dateFiltered.length}건`);

    // 4) 정산 수집 — 각 주문 행 클릭 → order_detail API 캡처
    console.log(`[crawler] 요기요 정산 수집 (${dateFiltered.length}건)...`);
    this.onStatus({ site: 'yogiyo', page: 'settlement', status: 'crawling' });

    const settlementScript = `(async function() {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const results = [];
      const orderRows = [];
      document.querySelectorAll('table tbody tr').forEach((row, idx) => {
        const text = row.innerText || '';
        const m = text.match(/([A-Z]\\d{10,}[A-Z0-9]*|F\\d+[A-Z0-9]+)/);
        if (m) orderRows.push({ orderNo: m[1], rowIdx: idx });
      });

      for (const { orderNo, rowIdx } of orderRows) {
        try {
          const beforeCount = (window._yogiyoCapturedResponses || []).length;
          const rows = document.querySelectorAll('table tbody tr');
          const row = rows[rowIdx] || Array.from(rows).find(r => r.innerText.includes(orderNo));
          if (!row) continue;

          // > 버튼 클릭 (order_detail API 트리거)
          const cells = row.querySelectorAll('td');
          let clicked = false;
          for (let c = cells.length - 1; c >= 0 && !clicked; c--) {
            const el = cells[c].querySelector('button, a, [role="button"], [class*="arrow"], [class*="chevron"]');
            if (el && typeof el.click === 'function') { el.click(); clicked = true; break; }
            const svg = cells[c].querySelector('svg');
            if (svg) {
              const parent = svg.closest('button, a, div, span, td');
              if (parent && typeof parent.click === 'function') { parent.click(); clicked = true; break; }
              svg.dispatchEvent(new MouseEvent('click', { bubbles: true })); clicked = true; break;
            }
          }
          if (!clicked) row.click();

          // order_detail 응답 대기
          let detailData = null;
          for (let wait = 0; wait < 10; wait++) {
            await sleep(500);
            const captured = window._yogiyoCapturedResponses || [];
            const detail = captured.slice(beforeCount).find(r =>
              r.url.includes('/proxy/order_detail/') || r.url.includes('/order_detail/') || r.url.includes('/order-detail/')
            );
            if (detail?.data) { detailData = detail.data; break; }
          }

          if (detailData) results.push({ orderNumber: orderNo, data: detailData });

          // 모달 닫기
          const closeBtn = document.querySelector('[aria-label*="닫기"], [aria-label*="close" i]')
            || Array.from(document.querySelectorAll('button, span, div')).find(b =>
              ['×', 'X', '✕', '닫기'].includes(b.innerText.trim())
            );
          if (closeBtn) closeBtn.click();
          else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
          await sleep(1000);
        } catch (e) {
          try {
            const x = Array.from(document.querySelectorAll('button, span')).find(b => ['×', 'X', '✕'].includes(b.innerText.trim()));
            if (x) x.click();
          } catch {}
          await sleep(500);
        }
      }
      return results;
    })()`;

    let settlementResults = [];
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('yogiyo settlement timeout')), 180000)
      );
      settlementResults = await Promise.race([
        view.webContents.executeJavaScript(settlementScript),
        timeoutPromise,
      ]);
    } catch (err) {
      console.error('[crawler] 요기요 정산 수집 실패:', err.message);
    }

    // 정산 맵
    const settlementMap = {};
    for (const r of (settlementResults || [])) {
      settlementMap[r.orderNumber] = r.data;
    }
    const validCount = Object.values(settlementMap).filter(d => d.settlement_info?.settlement_amount).length;
    console.log(`[crawler] 요기요 정산 ${(settlementResults || []).length}건 캡처 (유효 ${validCount}건)`);

    // 5) DB SalesOrder 매핑
    const payMap = { ONLINE: '온라인결제', OFFLINE_CARD: '만나서카드', OFFLINE_CASH: '만나서현금' };
    const channelMap = { VD: '배달', OD: '자체배달', TAKEOUT: '포장' };

    const apiOrders = dateFiltered.map(order => {
      const s = settlementMap[order.order_number] || {};
      const si = s.settlement_info || {};
      const items = si.settlement_items || [];
      const findItem = (keyword) => {
        const item = items.find(i => (i.item_title || '').includes(keyword));
        return Math.abs(item?.item_amount ?? item?.item_price ?? 0);
      };
      const menuItems = order.items || [];
      const firstItemName = menuItems[0]?.name || '';
      const menuSummary = menuItems.length > 1
        ? `${firstItemName} 외 ${menuItems.length - 1}건`
        : firstItemName;

      return {
        orderId: order.order_number || '',
        orderedAt: order.submitted_at || '',
        orderType: order.purchase_serving_type || '',
        channel: channelMap[order.delivery_method_code] || order.delivery_method_code || '',
        paymentMethod: payMap[order.central_payment_type] || order.central_payment_type || '',
        menuSummary,
        menuAmount: order.items_price || 0,
        deliveryIncome: order.delivery_fee || 0,
        commissionFee: findItem('중개') || findItem('이용료'),
        pgFee: findItem('외부결제') || findItem('결제'),
        deliveryCost: s.delivery_fee || findItem('배달'),
        storeDiscount: findItem('할인보전') || findItem('요기요') || Math.abs(si.yogiyo_discount_amount || 0),
        vat: findItem('부가세'),
        adFee: findItem('광고'),
        settlementAmount: si.settlement_amount || 0,
        settlementDate: si.payment_date || '',
        items: menuItems.map(item => ({
          menuName: item.name || '',
          quantity: item.quantity || 1,
        })),
      };
    });

    const result = {
      success: true,
      site: 'yogiyo',
      pageType: 'orderHistory',
      extractedAt: new Date().toISOString(),
      totalCount: ordersData.count || allOrders.length,
      ordersPrice: ordersData.orders_price || 0,
      apiOrders,
    };

    if (!this.results.yogiyo) this.results.yogiyo = {};
    this.results.yogiyo.orderHistory = result;
    this.onResult(result);
  }

  // ─── 땡겨요 API 인터셉트 크롤링 (requestQryOrderList 캡처) ─────
  // POC 검증 완료: Electron WebContentsView + fetch/XHR intercept
  // 플로우: 인터셉트 설치 → 주문내역(#SH0402) → requestQryOrderList 캡처 → 날짜 필터
  async crawlDdangyoyoApi(options = {}) {
    const view = this.view;
    const targetDate = options.targetDate;
    this.onStatus({ site: 'ddangyoyo', page: 'orders', status: 'crawling' });

    // 1) 인터셉트 설치 + 주문내역 이동
    console.log('[crawler] 땡겨요 API 크롤링 시작');
    const interceptScript = injector.getDdangyoyoInterceptScript();
    await view.webContents.executeJavaScript(interceptScript).catch(() => {});

    // 주문내역 메뉴 클릭 or 해시 네비게이션
    await view.webContents.executeJavaScript(`(function() {
      const links = Array.from(document.querySelectorAll('a'));
      const orderLink = links.find(a => a.innerText.trim() === '주문내역');
      if (orderLink) { orderLink.click(); return 'menu-click'; }
      location.hash = '#SH0402';
      return 'hash-nav';
    })()`);

    console.log('[crawler] 땡겨요 주문내역 이동, API 응답 대기...');
    await this.sleep(8000);

    // 인터셉트 재설치 (SPA 네비게이션 후)
    await view.webContents.executeJavaScript(interceptScript).catch(() => {});
    await this.sleep(3000);

    // 2) requestQryOrderList 응답 캡처
    let ordersData = await view.webContents.executeJavaScript(`(function() {
      const c = window._ddCaptures || [];
      for (let i = c.length - 1; i >= 0; i--) {
        if (c[i].url.includes('requestQryOrderList') && c[i].data?.dlt_result) {
          return c[i].data;
        }
      }
      return null;
    })()`);

    // 캡처 안 됐으면 조회 버튼 클릭
    if (!ordersData) {
      console.log('[crawler] 땡겨요 초기 캡처 없음 → 조회 버튼 클릭');
      await view.webContents.executeJavaScript(`(function() {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const btn = btns.find(b => { const t = b.innerText.trim(); return t === '조회' || t === '검색'; });
        if (btn) btn.click();
      })()`);
      await this.sleep(5000);

      ordersData = await view.webContents.executeJavaScript(`(function() {
        const c = window._ddCaptures || [];
        for (let i = c.length - 1; i >= 0; i--) {
          if (c[i].url.includes('requestQryOrderList') && c[i].data?.dlt_result) {
            return c[i].data;
          }
        }
        return null;
      })()`);
    }

    if (!ordersData) throw new Error('땡겨요 requestQryOrderList 캡처 실패');

    const allOrders = ordersData.dlt_result || [];
    const summary = ordersData.dlt_result_single || {};
    console.log(`[crawler] 땡겨요 API 캡처: ${allOrders.length}건 / 총 ${summary.tot_cnt || '?'}건 / 매출합계 ${(summary.tot_sum || 0).toLocaleString()}원`);

    // 3) targetDate 필터 (setl_dt: "20260313")
    const targetDateCompact = targetDate ? targetDate.replace(/-/g, '') : null;
    const dateFiltered = targetDateCompact
      ? allOrders.filter(o => o.setl_dt === targetDateCompact)
      : allOrders;
    console.log(`[crawler] 땡겨요 ${targetDate || '전체'} 필터: ${dateFiltered.length}건`);

    // 4) DB SalesOrder 매핑
    const parseAmt = (str) => {
      if (typeof str === 'number') return str;
      if (!str) return 0;
      return parseInt(String(str).replace(/[^0-9\-]/g, ''), 10) || 0;
    };
    const parseDt = (dt, tm) => {
      if (!dt) return '';
      const y = dt.substring(0, 4), m = dt.substring(4, 6), d = dt.substring(6, 8);
      if (!tm) return `${y}-${m}-${d}`;
      return `${y}-${m}-${d} ${tm.substring(0, 2)}:${tm.substring(2, 4)}:${tm.substring(4, 6)}`;
    };

    const apiOrders = dateFiltered.map(order => {
      const saleAmt = parseAmt(order.sale_amt);
      const settlAmt = parseAmt(order.tot_setl_amt);
      const menuNm = (order.menu_nm || '').trim();
      return {
        orderId: order.ord_id || '',
        orderIdInternal: order.ord_no || '',
        orderedAt: parseDt(order.setl_dt, order.setl_tm),
        orderType: order.ord_tp_nm || '',
        menuSummary: menuNm,
        menuAmount: saleAmt,
        settlementAmount: settlAmt,
        totalFee: saleAmt - settlAmt,
        channel: order.ord_tp_nm || 'DELIVERY',
        orderStatus: order.ord_prog_stat_cd === '40' ? 'COMPLETED' : order.ord_prog_stat_cd || '',
      };
    });

    const result = {
      success: true,
      site: 'ddangyoyo',
      pageType: 'orders',
      extractedAt: new Date().toISOString(),
      totalCount: summary.tot_cnt || allOrders.length,
      totalSaleAmount: summary.tot_sum || 0,
      apiOrders,
    };

    if (!this.results.ddangyoyo) this.results.ddangyoyo = {};
    this.results.ddangyoyo.orders = result;
    this.onResult(result);
  }

  // ─── 날짜별 주문 그룹핑 헬퍼 ─────
  _groupOrdersByDate(orders, getDateFn) {
    const groups = {};
    for (const order of orders) {
      const date = getDateFn(order);
      if (!groups[date]) groups[date] = [];
      groups[date].push(order);
    }
    return groups;
  }

  // ─── 매출지킴이 전송 헬퍼 (날짜별 전송용) ─────
  async _sendToSalesKeeper(siteKey, targetDate, apiOrders, options = {}) {
    const { salesKeeper, brandName } = options;
    if (!salesKeeper?.apiBaseUrl || !salesKeeper?.sessionToken || !salesKeeper?.salesKeeperStoreId) return;
    if (!apiOrders || apiOrders.length === 0) {
      console.log(`[crawler] ${siteKey} ${targetDate} 전송할 주문 없음`);
      return;
    }

    let orders;
    if (siteKey === 'baemin') {
      orders = apiOrders.map(o => ({
        orderId: o.orderId,
        orderedAt: o.orderedAt,
        orderType: o.orderType,
        channel: o.channel,
        paymentMethod: o.paymentMethod,
        menuSummary: (o.menuSummary || '').substring(0, 200),
        menuAmount: o.menuAmount,
        deliveryIncome: o.deliveryTip,
        commissionFee: o.commissionFee,
        pgFee: o.pgFee,
        deliveryCost: o.deliveryCost,
        vat: o.vat,
        meetPayment: o.meetPayment,
        instantDiscount: o.instantDiscount,
        platformDiscount: o.platformDiscount,
        settlementAmount: o.settlementAmount,
        settlementDate: o.settlementDate,
      }));
    } else if (siteKey === 'yogiyo') {
      orders = apiOrders.map(o => ({
        orderId: o.orderId,
        orderedAt: o.orderedAt,
        orderType: o.orderType,
        channel: o.channel,
        paymentMethod: o.paymentMethod,
        menuSummary: (o.menuSummary || '').substring(0, 200),
        menuAmount: o.menuAmount,
        deliveryIncome: o.deliveryIncome,
        commissionFee: o.commissionFee,
        pgFee: o.pgFee,
        deliveryCost: o.deliveryCost,
        vat: o.vat,
        adFee: o.adFee,
        storeDiscount: o.storeDiscount,
        settlementAmount: o.settlementAmount,
        settlementDate: o.settlementDate,
      }));
    } else {
      orders = apiOrders;
    }

    const url = `${salesKeeper.apiBaseUrl}/api/stores/${salesKeeper.salesKeeperStoreId}/crawler/${siteKey}`;
    console.log(`[crawler] ${siteKey} ${targetDate} 매출지킴이 전송: ${url} (${orders.length}건)`);

    try {
      const sendResult = await this._httpPost(url, salesKeeper.sessionToken, {
        targetDate,
        platformStoreId: siteKey,
        brandName,
        orders,
      });
      console.log(`[crawler] ${siteKey} ${targetDate} 전송 완료: ${sendResult.statusCode}`);
      this.onResult({ site: siteKey, pageType: 'salesKeeper', targetDate, ...sendResult });
    } catch (err) {
      console.error(`[crawler] ${siteKey} ${targetDate} 매출지킴이 전송 실패:`, err.message);
    }
  }

  // ─── 배민 기간 범위 크롤링 (3개월 백필) ─────
  async crawlBaeminRange(options = {}) {
    const view = this.view;
    this.onStatus({ site: 'baemin', page: 'orderHistory', status: 'crawling', mode: 'backfill' });

    // 1) 주문내역 페이지 이동 + 인터셉트 설치
    console.log('[crawler] 배민 Range 크롤링 시작 (3개월)');
    const interceptScript = injector.getBaeminInterceptScript();
    view.webContents.once('dom-ready', () => {
      view.webContents.executeJavaScript(interceptScript).catch(() => {});
    });
    await this.navigateAndWait('https://self.baemin.com/orders/history');
    await this.sleep(3000);
    // 재설치 (SPA 대비)
    await view.webContents.executeJavaScript(interceptScript).catch(() => {});
    await this.sleep(3000);

    // 2) 3개월 기간 범위 필터 적용 → API 호출 트리거
    console.log('[crawler] 배민 기간 범위 필터 적용 (3개월)');
    try {
      const filterResult = await view.webContents.executeJavaScript(
        injector.getBaeminRangeFilterScript()
      );
      console.log('[crawler] 배민 기간 범위 필터 결과:', filterResult);
      await this.sleep(3000);
    } catch (err) {
      console.error('[crawler] 배민 기간 범위 필터 실패:', err.message);
    }

    // 3) shopOwnerNumber 캡처
    const shopOwnerNumber = await view.webContents.executeJavaScript(`(function() {
      const c = window._baeminCapturedResponses || [];
      for (const x of c) { const m = x.url.match(/shopOwnerNumber=(\\d+)/); if (m) return m[1]; }
      return null;
    })()`);
    if (!shopOwnerNumber) throw new Error('shopOwnerNumber 캡처 실패 (range)');
    console.log(`[crawler] 배민 shopOwnerNumber: ${shopOwnerNumber}`);

    // 4) 첫 페이지 인터셉트 데이터 읽기
    const firstPage = await view.webContents.executeJavaScript(`(function() {
      const c = window._baeminCapturedResponses || [];
      for (let i = c.length - 1; i >= 0; i--) {
        if (c[i].url.includes('/v4/orders') && !c[i].url.includes('commerce') && !c[i].url.includes('ad-')) {
          return c[i].data;
        }
      }
      return null;
    })()`);
    if (!firstPage) throw new Error('배민 Range 첫 페이지 API 응답 없음');

    const allOrders = [...(firstPage.contents || [])];
    const totalSize = firstPage.totalSize || 0;
    console.log(`[crawler] 배민 Range 총 주문: ${totalSize}건 / 매출: ${(firstPage.totalPayAmount || 0).toLocaleString()}원`);

    // 5) 추가 페이지 수집 — "다음" 버튼으로 UI 페이지네이션
    let pg = 1;
    while (allOrders.length < totalSize) {
      pg++;
      const prevCount = await view.webContents.executeJavaScript(`
        window._baeminCapturedResponses.filter(x => x.url.includes('/v4/orders') && !x.url.includes('commerce') && !x.url.includes('ad-')).length
      `);

      const clicked = await view.webContents.executeJavaScript(`(function() {
        const nextBtn = Array.from(document.querySelectorAll('button, a')).find(function(b) {
          const label = (b.getAttribute('aria-label') || '');
          const text = b.innerText.trim();
          return label.includes('다음') || label.includes('next') ||
                 text === '›' || text === '>' || text === '»' || text === '다음';
        });
        if (!nextBtn || nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true') return false;
        nextBtn.click();
        return true;
      })()`);

      if (!clicked) { console.log(`[crawler] 배민 Range page ${pg}: 마지막 페이지`); break; }

      let newData = null;
      for (let wait = 0; wait < 10; wait++) {
        await this.sleep(1000);
        const newCount = await view.webContents.executeJavaScript(`
          window._baeminCapturedResponses.filter(x => x.url.includes('/v4/orders') && !x.url.includes('commerce') && !x.url.includes('ad-')).length
        `);
        if (newCount > prevCount) {
          newData = await view.webContents.executeJavaScript(`(function() {
            const c = window._baeminCapturedResponses.filter(x => x.url.includes('/v4/orders') && !x.url.includes('commerce') && !x.url.includes('ad-'));
            return c[c.length - 1].data;
          })()`);
          break;
        }
      }

      if (!newData) { console.log(`[crawler] 배민 Range page ${pg}: 응답 대기 타임아웃`); break; }
      const contents = newData.contents || [];
      console.log(`[crawler] 배민 Range [page ${pg}] ${contents.length}건`);
      allOrders.push(...contents);
      if (contents.length === 0) break;
    }

    console.log(`[crawler] 배민 Range 전체 ${allOrders.length}건 수집 완료`);

    // 6) API 데이터를 결과 형식으로 변환
    const findCode = (items, code) => (items || []).find(i => i.code === code)?.amount || 0;
    const apiOrders = allOrders.map(item => {
      const o = item.order || {};
      const s = item.settle || {};
      return {
        orderId: o.orderNumber || '',
        orderedAt: o.orderDateTime || '',
        orderType: o.deliveryType === 'DELIVERY' ? 'delivery' : o.deliveryType === 'TAKEOUT' ? 'pickup' : (o.deliveryType || ''),
        channel: o.deliveryType || '',
        paymentMethod: o.payType || '',
        menuSummary: o.itemsSummary || '',
        menuAmount: o.payAmount || 0,
        deliveryTip: o.deliveryTip || 0,
        instantDiscount: o.totalInstantDiscountAmount || 0,
        commissionFee: Math.abs(findCode(s.orderBrokerageItems, 'ADVERTISE_FEE')),
        pgFee: Math.abs(findCode(s.etcItems, 'SERVICE_FEE')),
        deliveryCost: Math.abs(s.deliveryItemAmount || 0),
        vat: Math.abs(s.deductionAmountTotalVat || 0),
        meetPayment: s.meetAmount || 0,
        settlementAmount: s.depositDueAmount || 0,
        settlementDate: s.depositDueDate || '',
        platformDiscount: Math.abs(findCode(s.orderBrokerageItems, 'DISCOUNT_AMOUNT')),
        rawData: item,
      };
    });

    // 7) orderDateTime 기준 날짜별 그룹핑 → 날짜별 매출지킴이 전송
    const grouped = this._groupOrdersByDate(apiOrders, (order) => {
      // orderDateTime: "2026-03-14 18:30:00" or ISO format
      const dt = order.orderedAt || '';
      return dt.split(' ')[0].split('T')[0]; // YYYY-MM-DD
    });

    const dates = Object.keys(grouped).sort();
    console.log(`[crawler] 배민 Range 날짜별 그룹: ${dates.length}일 — ${dates.join(', ')}`);

    if (options.salesKeeper) {
      for (const date of dates) {
        const dateOrders = grouped[date];
        console.log(`[crawler] 배민 Range ${date}: ${dateOrders.length}건 전송`);
        await this._sendToSalesKeeper('baemin', date, dateOrders, options);
      }
    }

    // 결과 저장
    const result = {
      success: true,
      site: 'baemin',
      pageType: 'orderHistory',
      mode: 'backfill',
      extractedAt: new Date().toISOString(),
      totalSize,
      totalPayAmount: firstPage.totalPayAmount || 0,
      apiOrders,
      dateGroups: Object.fromEntries(dates.map(d => [d, grouped[d].length])),
    };

    if (!this.results.baemin) this.results.baemin = {};
    this.results.baemin.orderHistory = result;
    this.onResult(result);
  }

  // ─── 요기요 기간 범위 크롤링 (90일 백필) ─────
  async crawlYogiyoRange(options = {}) {
    const view = this.view;
    this.onStatus({ site: 'yogiyo', page: 'orderHistory', status: 'crawling', mode: 'backfill' });

    // startDate = 90일 전 (KST)
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    kst.setDate(kst.getDate() - 90);
    const startDate = kst.toISOString().slice(0, 10);

    // 1) 주문내역 페이지 이동 + 인터셉트 설치
    console.log(`[crawler] 요기요 Range 크롤링 시작 (startDate: ${startDate})`);
    const interceptScript = injector.getYogiyoInterceptScript();
    view.webContents.once('dom-ready', () => {
      view.webContents.executeJavaScript(interceptScript).catch(() => {});
    });
    await this.navigateAndWait('https://ceo.yogiyo.co.kr/order-history/list');
    await this.sleep(5000);
    await view.webContents.executeJavaScript(interceptScript).catch(() => {});
    await this.sleep(3000);

    // 2) 기간 범위 필터 적용 (직접설정 → startDate)
    console.log(`[crawler] 요기요 기간 범위 필터 적용: ${startDate}`);
    try {
      const filterResult = await view.webContents.executeJavaScript(
        injector.getYogiyoRangeFilterScript(startDate)
      );
      console.log('[crawler] 요기요 기간 범위 필터 결과:', filterResult);
      await this.sleep(5000);
    } catch (err) {
      console.error('[crawler] 요기요 기간 범위 필터 실패:', err.message);
    }

    // 3) /proxy/orders/ 응답 캡처
    const ordersData = await view.webContents.executeJavaScript(`(function() {
      const c = window._yogiyoCapturedResponses || [];
      for (let i = c.length - 1; i >= 0; i--) {
        if (c[i].url.includes('/proxy/orders')) {
          const d = c[i].data;
          if (d.orders || d.results) return d;
        }
      }
      return null;
    })()`);
    if (!ordersData) throw new Error('요기요 Range 주문 API 캡처 실패');

    const allOrders = ordersData.orders || ordersData.results || [];
    console.log(`[crawler] 요기요 Range 총 주문: ${ordersData.count || allOrders.length}건 / 매출: ${(ordersData.orders_price || 0).toLocaleString()}원`);

    // 4) 정산 수집 — 각 주문 행 클릭 → order_detail API 캡처
    console.log(`[crawler] 요기요 Range 정산 수집 (${allOrders.length}건)...`);
    this.onStatus({ site: 'yogiyo', page: 'settlement', status: 'crawling', mode: 'backfill' });

    const settlementScript = `(async function() {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const results = [];
      const orderRows = [];
      document.querySelectorAll('table tbody tr').forEach((row, idx) => {
        const text = row.innerText || '';
        const m = text.match(/([A-Z]\\d{10,}[A-Z0-9]*|F\\d+[A-Z0-9]+)/);
        if (m) orderRows.push({ orderNo: m[1], rowIdx: idx });
      });

      for (const { orderNo, rowIdx } of orderRows) {
        try {
          const beforeCount = (window._yogiyoCapturedResponses || []).length;
          const rows = document.querySelectorAll('table tbody tr');
          const row = rows[rowIdx] || Array.from(rows).find(r => r.innerText.includes(orderNo));
          if (!row) continue;

          const cells = row.querySelectorAll('td');
          let clicked = false;
          for (let c = cells.length - 1; c >= 0 && !clicked; c--) {
            const el = cells[c].querySelector('button, a, [role="button"], [class*="arrow"], [class*="chevron"]');
            if (el && typeof el.click === 'function') { el.click(); clicked = true; break; }
            const svg = cells[c].querySelector('svg');
            if (svg) {
              const parent = svg.closest('button, a, div, span, td');
              if (parent && typeof parent.click === 'function') { parent.click(); clicked = true; break; }
              svg.dispatchEvent(new MouseEvent('click', { bubbles: true })); clicked = true; break;
            }
          }
          if (!clicked) row.click();

          let detailData = null;
          for (let wait = 0; wait < 10; wait++) {
            await sleep(500);
            const captured = window._yogiyoCapturedResponses || [];
            const detail = captured.slice(beforeCount).find(r =>
              r.url.includes('/proxy/order_detail/') || r.url.includes('/order_detail/') || r.url.includes('/order-detail/')
            );
            if (detail?.data) { detailData = detail.data; break; }
          }

          if (detailData) results.push({ orderNumber: orderNo, data: detailData });

          const closeBtn = document.querySelector('[aria-label*="닫기"], [aria-label*="close" i]')
            || Array.from(document.querySelectorAll('button, span, div')).find(b =>
              ['×', 'X', '✕', '닫기'].includes(b.innerText.trim())
            );
          if (closeBtn) closeBtn.click();
          else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
          await sleep(1000);
        } catch (e) {
          try {
            const x = Array.from(document.querySelectorAll('button, span')).find(b => ['×', 'X', '✕'].includes(b.innerText.trim()));
            if (x) x.click();
          } catch {}
          await sleep(500);
        }
      }
      return results;
    })()`;

    let settlementResults = [];
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('yogiyo range settlement timeout')), 300000)
      );
      settlementResults = await Promise.race([
        view.webContents.executeJavaScript(settlementScript),
        timeoutPromise,
      ]);
    } catch (err) {
      console.error('[crawler] 요기요 Range 정산 수집 실패:', err.message);
    }

    // 정산 맵
    const settlementMap = {};
    for (const r of (settlementResults || [])) {
      settlementMap[r.orderNumber] = r.data;
    }
    const validCount = Object.values(settlementMap).filter(d => d.settlement_info?.settlement_amount).length;
    console.log(`[crawler] 요기요 Range 정산 ${(settlementResults || []).length}건 캡처 (유효 ${validCount}건)`);

    // 5) DB SalesOrder 매핑
    const payMap = { ONLINE: '온라인결제', OFFLINE_CARD: '만나서카드', OFFLINE_CASH: '만나서현금' };
    const channelMap = { VD: '배달', OD: '자체배달', TAKEOUT: '포장' };

    const apiOrders = allOrders.map(order => {
      const s = settlementMap[order.order_number] || {};
      const si = s.settlement_info || {};
      const items = si.settlement_items || [];
      const findItem = (keyword) => {
        const item = items.find(i => (i.item_title || '').includes(keyword));
        return Math.abs(item?.item_amount ?? item?.item_price ?? 0);
      };
      const menuItems = order.items || [];
      const firstItemName = menuItems[0]?.name || '';
      const menuSummary = menuItems.length > 1
        ? `${firstItemName} 외 ${menuItems.length - 1}건`
        : firstItemName;

      return {
        orderId: order.order_number || '',
        orderedAt: order.submitted_at || '',
        orderType: order.purchase_serving_type || '',
        channel: channelMap[order.delivery_method_code] || order.delivery_method_code || '',
        paymentMethod: payMap[order.central_payment_type] || order.central_payment_type || '',
        menuSummary,
        menuAmount: order.items_price || 0,
        deliveryIncome: order.delivery_fee || 0,
        commissionFee: findItem('중개') || findItem('이용료'),
        pgFee: findItem('외부결제') || findItem('결제'),
        deliveryCost: s.delivery_fee || findItem('배달'),
        storeDiscount: findItem('할인보전') || findItem('요기요') || Math.abs(si.yogiyo_discount_amount || 0),
        vat: findItem('부가세'),
        adFee: findItem('광고'),
        settlementAmount: si.settlement_amount || 0,
        settlementDate: si.payment_date || '',
        items: menuItems.map(item => ({
          menuName: item.name || '',
          quantity: item.quantity || 1,
        })),
      };
    });

    // 6) submitted_at 기준 날짜별 그룹핑 → 날짜별 매출지킴이 전송
    const grouped = this._groupOrdersByDate(apiOrders, (order) => {
      // submitted_at: "2026-03-14 18:30:00" or similar
      const dt = order.orderedAt || '';
      return dt.split(' ')[0].split('T')[0]; // YYYY-MM-DD
    });

    const dates = Object.keys(grouped).sort();
    console.log(`[crawler] 요기요 Range 날짜별 그룹: ${dates.length}일 — ${dates.join(', ')}`);

    if (options.salesKeeper) {
      for (const date of dates) {
        const dateOrders = grouped[date];
        console.log(`[crawler] 요기요 Range ${date}: ${dateOrders.length}건 전송`);
        await this._sendToSalesKeeper('yogiyo', date, dateOrders, options);
      }
    }

    // 결과 저장
    const result = {
      success: true,
      site: 'yogiyo',
      pageType: 'orderHistory',
      mode: 'backfill',
      extractedAt: new Date().toISOString(),
      totalCount: ordersData.count || allOrders.length,
      ordersPrice: ordersData.orders_price || 0,
      apiOrders,
      dateGroups: Object.fromEntries(dates.map(d => [d, grouped[d].length])),
    };

    if (!this.results.yogiyo) this.results.yogiyo = {};
    this.results.yogiyo.orderHistory = result;
    this.onResult(result);
  }

  // ─── 플랫폼 데이터를 매출지킴이 API로 전송 ─────
  async sendSiteDataToSalesKeeper(siteKey, options) {
    const { salesKeeper, targetDate, brandName } = options;
    if (!salesKeeper?.apiBaseUrl || !salesKeeper?.sessionToken || !salesKeeper?.salesKeeperStoreId) return;

    console.log(`[crawler] ${siteKey} 매출지킴이 전송 준비...`);

    if (siteKey === 'baemin') {
      await this.sendBaeminToSalesKeeper(options);
    } else if (siteKey === 'yogiyo') {
      await this.sendYogiyoToSalesKeeper(options);
    } else if (siteKey === 'ddangyoyo') {
      await this.sendDdangyoyoToSalesKeeper(options);
    }
  }

  // ─── 배민 데이터를 매출지킴이에 전송 (API 데이터 기반) ──────
  async sendBaeminToSalesKeeper(options) {
    const { salesKeeper, targetDate, brandName } = options;
    const result = this.results.baemin?.orderHistory;
    if (!result?.apiOrders?.length) {
      console.log('[crawler] 배민 전송할 주문 없음');
      return;
    }

    const orders = result.apiOrders.map(o => ({
      orderId: o.orderId,
      orderedAt: o.orderedAt,
      orderType: o.orderType,
      channel: o.channel,
      paymentMethod: o.paymentMethod,
      menuSummary: (o.menuSummary || '').substring(0, 200),
      menuAmount: o.menuAmount,
      deliveryIncome: o.deliveryTip,
      commissionFee: o.commissionFee,
      pgFee: o.pgFee,
      deliveryCost: o.deliveryCost,
      vat: o.vat,
      meetPayment: o.meetPayment,
      instantDiscount: o.instantDiscount,
      platformDiscount: o.platformDiscount,
      settlementAmount: o.settlementAmount,
      settlementDate: o.settlementDate,
    }));

    const platformStoreId = 'baemin';

    const url = `${salesKeeper.apiBaseUrl}/api/stores/${salesKeeper.salesKeeperStoreId}/crawler/baemin`;
    console.log(`[crawler] 배민 매출지킴이 전송: ${url} (${orders.length}건)`);

    const sendResult = await this._httpPost(url, salesKeeper.sessionToken, {
      targetDate,
      platformStoreId,
      brandName,
      orders,
    });

    if (!this.results.baemin) this.results.baemin = {};
    this.results.baemin.salesKeeper = sendResult;
    this.onResult({ site: 'baemin', pageType: 'salesKeeper', ...sendResult });
  }

  // ─── 요기요 데이터를 매출지킴이에 전송 (API 데이터 기반) ────────
  async sendYogiyoToSalesKeeper(options) {
    const { salesKeeper, targetDate, brandName } = options;
    const result = this.results.yogiyo?.orderHistory;
    if (!result?.apiOrders?.length) {
      console.log('[crawler] 요기요 전송할 주문 없음');
      return;
    }

    const orders = result.apiOrders.map(o => ({
      orderId: o.orderId,
      orderedAt: o.orderedAt,
      orderType: o.orderType,
      channel: o.channel,
      paymentMethod: o.paymentMethod,
      menuSummary: (o.menuSummary || '').substring(0, 200),
      menuAmount: o.menuAmount,
      deliveryIncome: o.deliveryIncome,
      commissionFee: o.commissionFee,
      pgFee: o.pgFee,
      deliveryCost: o.deliveryCost,
      vat: o.vat,
      adFee: o.adFee,
      storeDiscount: o.storeDiscount,
      settlementAmount: o.settlementAmount,
      settlementDate: o.settlementDate,
    }));

    const url = `${salesKeeper.apiBaseUrl}/api/stores/${salesKeeper.salesKeeperStoreId}/crawler/yogiyo`;
    console.log(`[crawler] 요기요 매출지킴이 전송: ${url} (${orders.length}건)`);

    const sendResult = await this._httpPost(url, salesKeeper.sessionToken, {
      targetDate,
      platformStoreId: 'yogiyo',
      brandName,
      orders,
    });

    if (!this.results.yogiyo) this.results.yogiyo = {};
    this.results.yogiyo.salesKeeper = sendResult;
    this.onResult({ site: 'yogiyo', pageType: 'salesKeeper', ...sendResult });
  }

  // ─── 땡겨요 데이터를 매출지킴이에 전송 (API 데이터 기반) ────────
  async sendDdangyoyoToSalesKeeper(options) {
    const { salesKeeper, targetDate, brandName } = options;
    const result = this.results.ddangyoyo?.orders;
    if (!result?.apiOrders?.length) {
      console.log('[crawler] 땡겨요 전송할 주문 없음');
      return;
    }

    const orders = result.apiOrders.map(o => ({
      orderId: o.orderId,
      orderedAt: o.orderedAt,
      orderType: o.orderType,
      channel: o.channel,
      menuSummary: (o.menuSummary || '').substring(0, 200),
      menuAmount: o.menuAmount,
      settlementAmount: o.settlementAmount,
    }));

    const url = `${salesKeeper.apiBaseUrl}/api/stores/${salesKeeper.salesKeeperStoreId}/crawler/ddangyoyo`;
    console.log(`[crawler] 땡겨요 매출지킴이 전송: ${url} (${orders.length}건)`);

    const sendResult = await this._httpPost(url, salesKeeper.sessionToken, {
      targetDate,
      platformStoreId: 'ddangyoyo',
      brandName,
      orders,
    });

    if (!this.results.ddangyoyo) this.results.ddangyoyo = {};
    this.results.ddangyoyo.salesKeeper = sendResult;
    this.onResult({ site: 'ddangyoyo', pageType: 'salesKeeper', ...sendResult });
  }

  // ─── HTTP POST 유틸리티 (매출지킴이 전송용) ────────
  _httpPost(url, sessionToken, body) {
    const http = require('http');
    const https = require('https');
    const { URL } = require('url');

    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;
      const bodyStr = JSON.stringify(body);

      const req = client.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session-token=' + sessionToken,
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            console.log(`[crawler] 매출지킴이 응답: ${res.statusCode}`, JSON.stringify(json).substring(0, 200));
            resolve({ statusCode: res.statusCode, body: json });
          } catch {
            resolve({ statusCode: res.statusCode, body: data });
          }
        });
      });

      req.on('error', (err) => {
        console.error('[crawler] 매출지킴이 전송 실패:', err.message);
        reject(err);
      });

      req.write(bodyStr);
      req.end();
    });
  }

  // ─── 쿠팡이츠 크롤링 (별도 프로세스 rebrowser-puppeteer) ─────────
  async crawlCoupangeats(credentials, options = {}) {
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
      const { results, errors } = await ce.run(creds.id, creds.pw, {
        targetDate: options.targetDate,
        brandName: options.brandName,
        salesKeeper: options.salesKeeper,
      });

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

  // ─── 배민/요기요/땡겨요 자동 로그인 ───────────────────────
  async performLogin(siteKey, credentials) {
    const config = SITE_CONFIG[siteKey];
    const creds = credentials?.[siteKey];
    const view = this.view;

    console.log(`[crawler] ${config.name} 로그인 페이지 로드: ${config.loginUrl}`);
    await this.navigateAndWait(config.loginUrl);
    await this.sleep(3000);

    let currentUrl = view.webContents.getURL();
    console.log(`[crawler] ${config.name} 로드 후 URL: ${currentUrl}`);

    // 땡겨요: WebSquare SPA — URL이 변하지 않으므로 전용 폼 감지
    if (siteKey === 'ddangyoyo') {
      await this.sleep(2000);
      const hasForm = await view.webContents.executeJavaScript(`(function() {
        const el = document.getElementById('mf_ibx_mbrId');
        return el && el.offsetHeight > 0;
      })()`);

      if (!hasForm) {
        console.log(`[crawler] 땡겨요 이미 로그인됨`);
        return;
      }

      if (!creds?.id || !creds?.pw) {
        console.log(`[crawler] 땡겨요 계정 정보 없음`);
        this.onStatus({ site: siteKey, status: 'manual_login_required' });
        await this.sleep(30000);
        return;
      }

      this.onStatus({ site: siteKey, status: 'logging_in' });
      try {
        const loginResult = await view.webContents.executeJavaScript(
          injector.getDdangyoyoLoginScript(creds.id, creds.pw)
        );
        console.log(`[crawler] 땡겨요 로그인 결과:`, loginResult);
      } catch (err) {
        console.error(`[crawler] 땡겨요 로그인 스크립트 오류:`, err);
      }
      await this.sleep(10000);

      const stillLogin = await view.webContents.executeJavaScript(`(function() {
        const el = document.getElementById('mf_ibx_mbrId');
        return el && el.offsetHeight > 0;
      })()`);
      if (stillLogin) {
        console.log('[crawler] 땡겨요 자동 로그인 실패');
        this.onStatus({ site: siteKey, status: 'manual_login_required' });
        await this.sleep(60000);
      }
      return;
    }

    // 배민/요기요: 일반 로그인 플로우
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
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { Crawler, SITE_CONFIG };
