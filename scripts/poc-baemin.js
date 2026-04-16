/**
 * 배민 워커: 매장별 수집
 * 실행: npx electron poc-baemin.js --id=아이디 --pw=비밀번호 --mode=backfill|daily --targetDate=YYYY-MM-DD
 *       --storeId=매장UUID --serverUrl=http://localhost:3000 --sessionToken=JWT토큰
 */

const { app, BrowserWindow, WebContentsView } = require('electron');
const path = require('path');
const fs = require('fs');

const POC_VERSION = app.getVersion() || 'unknown';

// ── CLI 인자 파싱 ──
function getArg(name) {
  const a = process.argv.find(a => a.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : '';
}

const config = {
  id: getArg('id'),
  pw: getArg('pw'),
  mode: getArg('mode') || 'backfill',       // backfill | daily
  targetDate: getArg('targetDate'),           // YYYY-MM-DD (daily 모드용)
  storeId: getArg('storeId'),                 // 매출지킴이 매장 UUID
  serverUrl: getArg('serverUrl'),             // http://localhost:3000
  sessionToken: getArg('sessionToken'),       // JWT 토큰
};

const os = require('os');
const LOG_FILE = path.join(os.homedir(), 'poc-baemin-log.txt');

// ── stdout JSON 프로토콜 ──
function emit(type, data) {
  console.log(JSON.stringify({ type, ...data }));
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
}
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return;
  fs.appendFileSync(LOG_FILE, `[FATAL] ${err.message}\n`);
  emit('error', { error: err.message });
});
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 날짜 포맷 (로컬 시간 기준, UTC 변환 방지) ──
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ── 백필 시작일 — 올해 1월 1일 ──
// v3.5.4부터 매장이 보유한 전체 기간(최대 1월 1일~)에 대해 백필을 돌려
// 노심 백필 스크립트가 raw_data 기반 재해석을 할 수 있게 한다.
function getBackfillStart() {
  const now = new Date();
  return formatDate(new Date(now.getFullYear(), 0, 1));
}
function getYesterday() {
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return formatDate(yesterday);
}

// ── mode에 따른 날짜 범위 결정 ──
function getDateRangeByMode() {
  if (config.mode === 'daily') {
    if (!config.targetDate) throw new Error('daily 모드에서는 --targetDate=YYYY-MM-DD 필요');
    return { startDate: config.targetDate, endDate: config.targetDate };
  }
  // backfill: 1월 1일 ~ D-1 (v3.5.4부터 전 기간 백필)
  return { startDate: getBackfillStart(), endDate: getYesterday() };
}

// ── 배민 CPC 광고비 수집 ──
// /v2/statistics/campaign/cpc/metrics/{shopNumber}?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// → dailyMetrics[].spentBudget (일별 광고비, 원 단위)
async function collectAdCost(shopNumber, startDate, endDate) {
  // 배민 광고비 API는 조회 기간 1개월 제한 → 월별 분할 호출
  const months = splitMonths(startDate, endDate);
  const allCosts = [];

  for (const month of months) {
    const apiUrl = `https://self-api.baemin.com/v2/statistics/campaign/cpc/metrics/${shopNumber}?startDate=${month.start}&endDate=${month.end}`;
    log(`   광고비 API: ${month.start} ~ ${month.end}`);
    const result = await fetchViaWebview(apiUrl);

    if (result?.error) {
      log(`   광고비 API 에러 (${month.start}): ${result.error}`);
      continue;
    }

    const dailyMetrics = result?.data?.dailyMetrics || [];
    const costs = dailyMetrics
      .filter(m => m.spentBudget > 0)
      .map(m => ({ date: m.date, amount: m.spentBudget }));
    allCosts.push(...costs);

    if (months.length > 1) await sleep(1000);
  }

  log(`   광고비 합계: ${allCosts.length}일 / ${allCosts.reduce((a, c) => a + c.amount, 0)}원`);
  return allCosts;
}

// ── 광고비 별도 전송 ──
async function sendAdCostToSalesKeeper(shopId, dailyAdCosts) {
  if (!config.serverUrl || !config.storeId || !config.sessionToken) return null;
  if (!dailyAdCosts || dailyAdCosts.length === 0) return null;

  const url = `${config.serverUrl}/api/stores/${config.storeId}/crawler/baemin/ad-cost`;
  const body = JSON.stringify({
    platformStoreId: shopId,
    dailyAdCosts,
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `session-token=${config.sessionToken}`,
      },
      body,
    });
    log(`   광고비 API 전송: ${res.status} (${dailyAdCosts.length}일)`);
    return { status: res.status, ok: res.ok };
  } catch (err) {
    log(`   광고비 API 전송 실패: ${err.message}`);
    return null;
  }
}

// ── 매출지킴이 API 전송 ──
async function sendToSalesKeeper(platform, targetDate, shopId, shopName, orders) {
  if (!config.serverUrl || !config.storeId || !config.sessionToken) return null;
  const url = `${config.serverUrl}/api/stores/${config.storeId}/crawler/${platform}`;

  // POC 내부 필드명 → API 기대 필드명으로 변환
  const mappedOrders = orders.map(o => ({
    orderId: o.orderId || o.orderNo,
    orderedAt: o.orderedAt || o.date,
    orderType: o.deliveryType || null,
    orderStatus: o.status || null, // CLOSED | CANCELLED (배민 API 필드명은 status)
    channel: null,
    paymentMethod: o.payType || null,
    menuSummary: o.menuSummary || null,
    menuAmount: o.menuAmount || 0,
    deliveryIncome: o.deliveryTip || 0,
    tipIncome: 0,
    commissionFee: o.commissionFee || 0,
    pgFee: o.pgFee || 0,
    deliveryCost: o.deliveryCost || 0,
    tipDiscount: 0,
    storeDiscount: o.instantDiscount || 0,
    // v3.5.8: 쿠폰 할인 분리
    ownerCouponDiscount: o.ownerCouponDiscount || 0,
    platformSubsidy: o.platformSubsidy || 0,
    vat: o.vat || 0,
    smallOrderFee: 0,
    cupDeposit: 0,
    meetPayment: o.meetAmount || 0,
    settlementAmount: o.depositDueAmount || 0,
    settlementDate: o.depositDueDate || null,
    // v3.5.4: 원본 API item 전달 (노심 route raw_data에 저장됨)
    rawItem: o.rawItem || null,
  }));

  const body = JSON.stringify({
    targetDate,
    platformStoreId: shopId,
    brandName: shopName,
    pocVersion: POC_VERSION,
    orders: mappedOrders,
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `session-token=${config.sessionToken}`,
      },
      body,
    });
    const status = res.status;
    log(`   API 전송 ${targetDate}: ${status}`);
    return { status, ok: res.ok };
  } catch (err) {
    log(`   API 전송 실패 ${targetDate}: ${err.message}`);
    emit('error', { error: `API 전송 실패 (${targetDate}): ${err.message}` });
    return null;
  }
}

// ── fetch/XHR 인터셉트 스크립트 ──
const INTERCEPT_SCRIPT = `(function() {
  if (window._baeminIntercepted) return;
  window._baeminIntercepted = true;
  window._baeminApiCaptures = [];

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await origFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    if (url.includes('self-api.baemin.com') || url.includes('/api/')) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        try {
          const json = JSON.parse(text);
          window._baeminApiCaptures.push({ url, data: json, ts: Date.now() });
          console.log('[intercept] fetch 캡처: ' + url.substring(0, 120));
        } catch {}
      } catch {}
    }
    return response;
  };

  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  const origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._interceptUrl = url;
    this._interceptHeaders = {};
    return origXHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this._interceptHeaders) this._interceptHeaders[name] = value;
    return origXHRSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      const url = this._interceptUrl || '';
      if (url.includes('self-api.baemin.com') || url.includes('/api/')) {
        try {
          const json = JSON.parse(this.responseText);
          window._baeminApiCaptures.push({ url, data: json, headers: this._interceptHeaders, ts: Date.now() });
          console.log('[intercept] XHR 캡처: ' + url.substring(0, 120));
        } catch {}
      }
    });
    return origXHRSend.apply(this, args);
  };
})()`;

// ── 자동 로그인 스크립트 ──
function getAutoLoginScript(id, pw) {
  return `(async function() {
    await new Promise(r => setTimeout(r, 1000));
    const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
    let idInput = null, pwInput = null;
    inputs.forEach(inp => { if ((inp.type||'').toLowerCase() === 'password') pwInput = inp; });
    inputs.forEach(inp => {
      if (inp === pwInput) return;
      const t = (inp.type||'').toLowerCase();
      if (t !== 'submit' && t !== 'button' && t !== 'file' && !idInput) idInput = inp;
    });
    if (!idInput || !pwInput) return { success: false, error: 'input not found (' + inputs.length + ')' };
    function typeInto(el, val) {
      el.focus();
      el.value = '';
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      nativeSetter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, val);
      if (el.value !== val) {
        nativeSetter.call(el, val);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: val }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    typeInto(idInput, ${JSON.stringify(id)});
    await new Promise(r => setTimeout(r, 300));
    typeInto(pwInput, ${JSON.stringify(pw)});
    await new Promise(r => setTimeout(r, 500));
    const btns = document.querySelectorAll('button, input[type="submit"], a[role="button"]');
    for (const btn of btns) {
      const t = (btn.textContent||'').trim();
      if (t.includes('로그인') || t.includes('Login') || t.includes('Sign') || t.includes('LOG IN')) { btn.click(); return { success: true }; }
    }
    const sub = document.querySelector('button[type="submit"]');
    if (sub) { sub.click(); return { success: true }; }
    const forms = document.querySelectorAll('form');
    if (forms.length > 0) { forms[0].submit(); return { success: true, method: 'form.submit' }; }
    return { success: false, error: 'button not found' };
  })()`;
}

let mainWindow, webView;

// ── navigateAndWait ──
function navigateAndWait(url, timeoutMs = 30000) {
  return new Promise(resolve => {
    let resolved = false;
    const done = () => { if (resolved) return; resolved = true; clearTimeout(t); };
    const t = setTimeout(() => { done(); resolve(); }, timeoutMs);
    webView.webContents.once('did-finish-load', () => { done(); resolve(); });
    webView.webContents.loadURL(url).catch(() => {});
  });
}

function isLoginUrl(url) {
  return url.includes('/login') || url.includes('/signin') || url.includes('biz-member');
}

function waitForLoginRedirect(timeoutMs = 30000) {
  return new Promise(resolve => {
    const cur = webView.webContents.getURL();
    if (!isLoginUrl(cur)) { resolve(cur); return; }
    let resolved = false;
    const cleanup = () => {
      if (resolved) return; resolved = true;
      clearInterval(poll); clearTimeout(t);
      webView.webContents.removeListener('did-navigate', onNav);
      webView.webContents.removeListener('did-navigate-in-page', onNav);
    };
    const t = setTimeout(() => { cleanup(); resolve(webView.webContents.getURL()); }, timeoutMs);
    const onNav = (_, url) => { if (!isLoginUrl(url)) { cleanup(); resolve(url); } };
    webView.webContents.on('did-navigate', onNav);
    webView.webContents.on('did-navigate-in-page', onNav);
    const poll = setInterval(() => {
      const url = webView.webContents.getURL();
      if (!isLoginUrl(url)) { cleanup(); resolve(url); }
    }, 1000);
  });
}

// ── 웹뷰 XHR로 API 호출 ──
function fetchViaWebview(apiUrl) {
  return webView.webContents.executeJavaScript(`
    (function() {
      return new Promise(function(resolve) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', ${JSON.stringify(apiUrl)}, true);
        xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
        xhr.setRequestHeader('service-channel', 'SELF_SERVICE_PC');
        xhr.withCredentials = true;
        xhr.onload = function() {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve({ success: true, data: JSON.parse(xhr.responseText) }); }
            catch (e) { resolve({ error: 'JSON parse: ' + e.message }); }
          } else {
            resolve({ error: 'HTTP ' + xhr.status + ' ' + xhr.responseText.substring(0, 200), body: xhr.responseText.substring(0, 500) });
          }
        };
        xhr.onerror = function() {
          resolve({ error: 'XHR onerror (status=' + xhr.status + ', readyState=' + xhr.readyState + ')' });
        };
        xhr.ontimeout = function() {
          resolve({ error: 'XHR timeout' });
        };
        xhr.timeout = 30000;
        xhr.send();
      });
    })()
  `);
}

// ── 데이터 매핑 함수 ──
// v3.5.4: 원본 API 응답(item)을 rawItem으로 보존한다.
// 노심 route(baemin/route.ts)의 raw_data에 저장되어, 노심 백필 스크립트가
// remapBaemin에서 광고비/배민분담 등 분리된 필드를 재추출할 수 있게 한다.
function mapOrder(item) {
  const o = item.order, s = item.settle;
  const findCode = (items, code) => (items || []).find(i => i.code === code)?.amount || 0;

  // ★ v3.5.8: orderedAt에 +09:00 KST suffix 추가.
  // 배민 API는 "2026-04-13T17:18:38" (TZ 없음)을 KST로 내려주는데,
  // 노심 route의 new Date()가 UTC로 해석하면 order_date가 하루 밀린다.
  let orderedAt = o.orderDateTime || '';
  if (orderedAt && !orderedAt.includes('+') && !orderedAt.includes('Z')) {
    orderedAt = orderedAt + '+09:00';
  }

  return {
    orderNo: o.orderNumber,
    orderId: o.orderNumber,
    orderedAt,
    date: o.orderDateTime,
    deliveryType: o.deliveryType,
    orderStatus: o.orderStatus || null, // CLOSED | CANCELLED
    payType: o.payType,
    menuSummary: o.itemsSummary,
    menuAmount: o.payAmount,
    deliveryTip: o.deliveryTip || 0,
    instantDiscount: o.totalInstantDiscountAmount || 0,
    // ★ v3.5.8: 쿠폰 할인 분리
    ownerCouponDiscount: o.ownerChargeCouponDiscountAmount || 0,
    platformSubsidy: o.baeminChargeCouponDiscountAmount || 0,
    commissionFee: Math.abs(findCode(s?.orderBrokerageItems, 'ADVERTISE_FEE')),
    pgFee: Math.abs(findCode(s?.etcItems, 'SERVICE_FEE')),
    deliveryCost: s?.deliveryItemAmount || 0,
    vat: s?.deductionAmountTotalVat || 0,
    meetAmount: s?.meetAmount || 0,
    depositDueAmount: s?.depositDueAmount || 0,
    depositDueDate: s?.depositDueDate || '',
    // ★ v3.5.4: 원본 보존 — 백필 스크립트가 raw_data에서 재추출 가능
    rawItem: item,
  };
}

// ── 월별 구간 분할 ──
function splitMonths(startDate, endDate) {
  const months = [];
  const [sy, sm, sdd] = startDate.split('-').map(Number);
  const [ey, em, edd] = endDate.split('-').map(Number);
  const sd = new Date(sy, sm - 1, sdd);
  const ed = new Date(ey, em - 1, edd);
  let cursor = new Date(sd);
  while (cursor <= ed) {
    const monthStart = formatDate(cursor);
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const monthEndStr = monthEnd > ed ? endDate : formatDate(monthEnd);
    if (monthStart <= monthEndStr) {
      months.push({ start: monthStart, end: monthEndStr });
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return months;
}

// ── 매장 1개에 대한 주문 수집 ──
async function collectOrdersForShop(shopOwnerNumber, shopNumber, startDate, endDate) {
  const months = splitMonths(startDate, endDate);
  log(`   ${months.length}개 월별 구간으로 분할 조회`);

  const LIMIT = 100;
  const allOrders = [];

  // CLOSED + CANCELLED 별도 패스 (배민 API가 콤마 구분 미지원)
  const statuses = ['CLOSED', 'CANCELLED'];

  for (const orderStatus of statuses) {
    log(`\n   === ${orderStatus} 주문 수집 ===`);

  for (let mi = 0; mi < months.length; mi++) {
    const month = months[mi];
    log(`\n   -- [${mi + 1}/${months.length}] ${month.start} ~ ${month.end} (${orderStatus}) --`);
    let offset = 0;
    let totalSize = null;
    let pageNum = 0;

    while (true) {
      pageNum++;
      const apiUrl = `https://self-api.baemin.com/v4/orders?offset=${offset}&limit=${LIMIT}&purchaseType=&startDate=${month.start}&endDate=${month.end}&shopOwnerNumber=${shopOwnerNumber}&shopNumbers=${shopNumber}&orderStatus=${orderStatus}`;

      let result;
      let retries = 0;
      const MAX_RETRIES = 5;

      while (retries <= MAX_RETRIES) {
        result = await fetchViaWebview(apiUrl);

        if (result?.error && result.error.includes('429')) {
          retries++;
          const waitSec = 10 + (10 * retries);
          log(`   429 Rate Limit -> ${waitSec}초 대기 후 재시도 (${retries}/${MAX_RETRIES})...`);
          await sleep(waitSec * 1000);
          continue;
        }
        break;
      }

      if (result?.error) {
        log(`   API 에러: ${result.error}${result.body ? ' | body: ' + result.body : ''}`);
        break;
      }

      const data = result.data;
      if (totalSize === null) {
        totalSize = data.totalSize || 0;
        log(`   총 주문: ${totalSize}건`);
      }

      const contents = data.contents || [];
      allOrders.push(...contents);

      // 진행 상황 emit
      emit('progress', { current: allOrders.length, total: totalSize, date: month.start });

      offset += LIMIT;
      if (offset >= totalSize || contents.length === 0) break;

      await sleep(3000);
    }

    if (mi < months.length - 1) {
      await sleep(5000);
    }
  }

  } // end statuses loop

  return allOrders;
}

// ── 주문 데이터를 날짜별로 그룹핑 ──
function buildDailySummary(mapped) {
  const byDate = {};
  for (const m of mapped) {
    const dateKey = m.date ? m.date.split('T')[0] : 'unknown';
    if (!byDate[dateKey]) {
      byDate[dateKey] = { date: dateKey, orders: [], count: 0, totalMenuAmount: 0, totalDepositDue: 0 };
    }
    byDate[dateKey].orders.push(m);
    byDate[dateKey].count++;
    byDate[dateKey].totalMenuAmount += m.menuAmount || 0;
    byDate[dateKey].totalDepositDue += m.depositDueAmount || 0;
  }

  const sortedDates = Object.keys(byDate).sort();
  const dailySummary = sortedDates.map(d => ({
    date: d,
    orderCount: byDate[d].count,
    totalMenuAmount: byDate[d].totalMenuAmount,
    totalDepositDue: byDate[d].totalDepositDue,
  }));

  return { dailySummary, byDate, sortedDates };
}

app.whenReady().then(async () => {
  fs.writeFileSync(LOG_FILE, '');

  if (!config.id || !config.pw) {
    emit('error', { error: '--id=ID --pw=PW 필요' });
    app.quit(); return;
  }

  const { startDate, endDate } = getDateRangeByMode();
  emit('status', { msg: `배민 수집 시작 (${config.mode}: ${startDate} ~ ${endDate})` });
  log(`=== 배민 워커: ${config.mode} (${startDate} ~ ${endDate}) ===`);

  mainWindow = new BrowserWindow({ width: 1200, height: 900, show: false });
  mainWindow.loadURL('about:blank');

  webView = new WebContentsView({
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  mainWindow.contentView.addChildView(webView);
  const [w, h] = mainWindow.getContentSize();
  webView.setBounds({ x: 0, y: 0, width: w, height: h });

  webView.webContents.on('console-message', (_, level, msg) => {
    if (msg.includes('[intercept]') || msg.includes('[baemin-filter]')) log(`  ${msg}`);
  });

  try {
    // ── 1) 로그인 ──
    emit('status', { msg: '배민 로그인 중...' });
    log('1) 배민 로그인...');
    await navigateAndWait('https://self.baemin.com');
    await sleep(3000);

    let url = webView.webContents.getURL();
    if (isLoginUrl(url)) {
      log(`   로그인 페이지: ${url.substring(0, 60)}`);
      const loginResult = await webView.webContents.executeJavaScript(getAutoLoginScript(config.id, config.pw));
      log(`   자동 로그인: ${JSON.stringify(loginResult)}`);
      await waitForLoginRedirect(15000);
      await sleep(2000);

      url = webView.webContents.getURL();
      if (isLoginUrl(url)) {
        log('   자동 로그인 실패 -> 수동 대기 (60초)');
        mainWindow.show();
        await waitForLoginRedirect(60000);
        await sleep(2000);
      }
    }

    url = webView.webContents.getURL();
    if (isLoginUrl(url)) {
      emit('error', { error: '배민 로그인 실패' });
      throw new Error('배민 로그인 실패');
    }
    log('   -> 로그인 완료');

    // ── 2) 홈 페이지에서 인터셉트 -> shopOwnerNumber + 매장 목록 캡처 ──
    emit('status', { msg: '매장 정보 수집 중...' });
    log('2) 홈 이동 -> shopOwnerNumber + 매장 목록 캡처...');
    webView.webContents.once('dom-ready', () => {
      webView.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});
    });
    await navigateAndWait('https://self.baemin.com/orders/history');
    await sleep(3000);
    await webView.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});
    await sleep(3000);

    // shopOwnerNumber 캡처 — 여러 방법 시도
    let shopOwnerNumber = null;

    // 방법 1: API 인터셉트에서 캡처
    let captureResult = await webView.webContents.executeJavaScript(`(function() {
      const c = window._baeminApiCaptures || [];
      for (const x of c) {
        const m = x.url.match(/shopOwnerNumber=(\\d+)/);
        if (m) return { shopOwnerNumber: m[1], headers: x.headers || {}, url: x.url };
      }
      return null;
    })()`);

    if (captureResult) {
      shopOwnerNumber = captureResult.shopOwnerNumber;
      log(`   -> shopOwnerNumber (인터셉트): ${shopOwnerNumber}`);
    }

    // 방법 2: 팝업 닫고 재시도
    if (!shopOwnerNumber) {
      log('   shopOwnerNumber 미캡처 -- 팝업 닫기 + 재시도...');
      await webView.webContents.executeJavaScript(`(function() {
        document.querySelectorAll('button').forEach(b => {
          if (b.innerText.includes('오늘 하루') || b.innerText.includes('닫기')) b.click();
        });
      })()`);
      await sleep(5000);
      await webView.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});
      await sleep(5000);

      captureResult = await webView.webContents.executeJavaScript(`(function() {
        const c = window._baeminApiCaptures || [];
        for (const x of c) {
          const m = x.url.match(/shopOwnerNumber=(\\d+)/);
          if (m) return { shopOwnerNumber: m[1] };
        }
        return null;
      })()`);
      if (captureResult) shopOwnerNumber = captureResult.shopOwnerNumber;
    }

    // 방법 3: 셀렉트박스에서 shopNumber 추출 → shops API로 shopOwnerNumber 조회
    if (!shopOwnerNumber) {
      log('   shopOwnerNumber 미캡처 -- 셀렉트박스에서 shopNumber 추출 시도...');
      const shopNumber = await webView.webContents.executeJavaScript(`(function() {
        // 셀렉트박스 option에서 숫자 추출 (예: "[음식배달] 매장명 / 카테고리 14830273")
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
          for (const opt of sel.options) {
            const m = opt.text.match(/(\\d{8,})/);
            if (m) return m[1];
            if (opt.value && opt.value.match(/^\\d{5,}$/)) return opt.value;
          }
        }
        // 폴백: 드롭다운 텍스트에서 숫자 추출
        const dropdownEl = document.querySelector('[class*="dropdown"], [class*="select"]');
        if (dropdownEl) {
          const m = dropdownEl.innerText.match(/(\\d{8,})/);
          if (m) return m[1];
        }
        return null;
      })()`);

      if (shopNumber) {
        log(`   shopNumber from DOM: ${shopNumber}`);
        // /v4/store/shops/{shopNumber} API 호출 → shopOwnerNumber 추출
        const shopInfo = await fetchViaWebview(`https://self-api.baemin.com/v4/store/shops/${shopNumber}`);
        if (shopInfo?.data) {
          shopOwnerNumber = shopInfo.data.shopOwnerNumber || shopInfo.data.shopOwnerNo;
          if (!shopOwnerNumber) {
            // 응답 객체에서 shopOwnerNumber 키 탐색
            const json = JSON.stringify(shopInfo.data);
            const ownerMatch = json.match(/"shopOwner(?:Number|No)"\s*:\s*"?(\d+)"?/);
            if (ownerMatch) shopOwnerNumber = ownerMatch[1];
          }
          log(`   -> shopOwnerNumber (API): ${shopOwnerNumber}`);
        }
      }
    }

    // 방법 4: 페이지 URL 또는 쿠키에서 추출
    if (!shopOwnerNumber) {
      const pageUrl = webView.webContents.getURL();
      const urlMatch = pageUrl.match(/shopOwnerNumber=(\d+)/);
      if (urlMatch) shopOwnerNumber = urlMatch[1];
    }

    if (!shopOwnerNumber) {
      emit('error', { error: 'shopOwnerNumber 캡처 실패 (4가지 방법 모두)' });
      throw new Error('shopOwnerNumber 캡처 실패');
    }
    log(`   -> shopOwnerNumber: ${shopOwnerNumber}`);

    // ── 3) 매장 목록 API 호출 ──
    emit('status', { msg: '매장 목록 조회 중...' });
    log('3) 매장 목록 조회...');

    const shopsApiUrl = `https://self-api.baemin.com/v4/store/shops/search?shopOwnerNo=${shopOwnerNumber}&lastOffsetId=&pageSize=50&desc=true`;
    const shopsResult = await fetchViaWebview(shopsApiUrl);

    if (shopsResult?.error) {
      log(`   매장 목록 API 에러: ${shopsResult.error}`);
      throw new Error('매장 목록 조회 실패');
    }

    const shopsData = shopsResult.data;
    let shops = [];
    if (Array.isArray(shopsData.contents)) {
      shops = shopsData.contents;
    } else if (Array.isArray(shopsData.shops)) {
      shops = shopsData.shops;
    } else if (Array.isArray(shopsData.data)) {
      shops = shopsData.data;
    } else if (Array.isArray(shopsData)) {
      shops = shopsData;
    } else {
      for (const key of Object.keys(shopsData)) {
        if (Array.isArray(shopsData[key]) && shopsData[key].length > 0) {
          shops = shopsData[key];
          break;
        }
      }
    }

    if (shops.length === 0) {
      log('   shops/search 직접 호출 실패 -> 캡처 데이터에서 추출 시도...');
      const capturedShops = await webView.webContents.executeJavaScript(`(function() {
        const c = window._baeminApiCaptures || [];
        for (const x of c) {
          if (x.url.includes('shops/search')) return x.data;
        }
        return null;
      })()`);

      if (capturedShops) {
        if (Array.isArray(capturedShops.contents)) shops = capturedShops.contents;
        else if (Array.isArray(capturedShops.shops)) shops = capturedShops.shops;
        else if (Array.isArray(capturedShops.data)) shops = capturedShops.data;
        else {
          for (const key of Object.keys(capturedShops)) {
            if (Array.isArray(capturedShops[key]) && capturedShops[key].length > 0) {
              shops = capturedShops[key];
              break;
            }
          }
        }
      }
    }

    if (shops.length === 0) {
      log('   API 실패 -> DOM 셀렉트박스에서 매장 추출 시도...');
      await navigateAndWait('https://self.baemin.com');
      await sleep(3000);

      const domShops = await webView.webContents.executeJavaScript(`(function() {
        const results = [];
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
          for (const opt of sel.options) {
            const text = opt.textContent.trim();
            const value = opt.value;
            if (text && value && !text.includes('선택')) {
              results.push({ text, value });
            }
          }
        }
        if (results.length === 0) {
          const items = document.querySelectorAll('[role="option"], [role="listbox"] li, .shop-select-item');
          items.forEach(item => {
            results.push({ text: item.textContent.trim(), value: item.getAttribute('data-value') || '' });
          });
        }
        return results;
      })()`);

      if (domShops && domShops.length > 0) {
        shops = domShops.map(d => {
          const numMatch = d.text.match(/(\d{5,})/);
          const nameMatch = d.text.match(/\]\s*(.+?)\s*\//);
          return {
            shopNumber: numMatch ? numMatch[1] : d.value,
            shopName: nameMatch ? nameMatch[1].trim() : d.text,
            rawText: d.text,
          };
        });
      }
    }

    // shops 배열에서 shopNumber, shopName 정규화
    const normalizedShops = shops.map(s => {
      const shopNumber = String(s.shopNumber || s.shopNo || s.id || s.number || '');
      const shopName = s.shopName || s.name || s.title || s.rawText || '';
      return { shopNumber, shopName, raw: s };
    }).filter(s => s.shopNumber);

    log(`\n=== 총 ${normalizedShops.length}개 매장 발견 ===`);
    for (const s of normalizedShops) {
      log(`   - [${s.shopNumber}] ${s.shopName}`);
    }

    if (normalizedShops.length === 0) {
      emit('error', { error: '매장 목록을 찾을 수 없습니다' });
      throw new Error('매장 목록을 찾을 수 없습니다');
    }

    // ── 4) 매장별 순회 수집 ──
    emit('status', { msg: `매장별 수집 시작 (${startDate} ~ ${endDate})` });
    log(`\n4) 매장별 수집 시작 (${startDate} ~ ${endDate})...`);

    const shopResults = [];

    for (let si = 0; si < normalizedShops.length; si++) {
      const shop = normalizedShops[si];
      log(`\n매장 [${si + 1}/${normalizedShops.length}] ${shop.shopName} (${shop.shopNumber})`);
      emit('shop', { shopName: shop.shopName, shopId: shop.shopNumber });

      const allOrders = await collectOrdersForShop(shopOwnerNumber, shop.shopNumber, startDate, endDate);
      log(`   매장 "${shop.shopName}" 수집 완료: ${allOrders.length}건`);

      // 데이터 매핑
      const mapped = allOrders.map(mapOrder);
      const { dailySummary, byDate, sortedDates } = buildDailySummary(mapped);

      // 날짜별로 매출지킴이 API 전송
      for (const dateKey of sortedDates) {
        const dayOrders = byDate[dateKey].orders;
        await sendToSalesKeeper('baemin', dateKey, shop.shopNumber, shop.shopName, dayOrders);
      }

      // ★ v3.5.8: CPC 광고비 수집 + 별도 엔드포인트 전송
      log(`\n   광고비(CPC) 수집: ${startDate} ~ ${endDate}`);
      const adCosts = await collectAdCost(shop.shopNumber, startDate, endDate);
      if (adCosts.length > 0) {
        await sendAdCostToSalesKeeper(shop.shopNumber, adCosts);
      }

      // 매장별 합계
      const totals = mapped.reduce((a, m) => {
        a.menu += m.menuAmount;
        a.comm += m.commissionFee;
        a.pg += m.pgFee;
        a.dep += m.depositDueAmount;
        return a;
      }, { menu: 0, comm: 0, pg: 0, dep: 0 });

      shopResults.push({
        shopName: shop.shopName,
        shopId: shop.shopNumber,
        orders: mapped,
        dailySummary,
        totals: {
          totalOrders: mapped.length,
          totalDays: sortedDates.length,
          menuAmount: totals.menu,
          commissionFee: totals.comm,
          pgFee: totals.pg,
          depositDueAmount: totals.dep,
        },
      });

      if (si < normalizedShops.length - 1) {
        await sleep(10000);
      }
    }

    // ── 5) 결과 emit ──
    log('\n5) 결과 출력...');

    emit('result', {
      site: 'baemin',
      shops: shopResults.map(s => ({
        shopName: s.shopName,
        shopId: s.shopId,
        orders: s.orders,
        dailySummary: s.dailySummary,
        totals: s.totals,
      })),
    });

    log('\n=== 배민 워커 완료 ===');
    emit('done', {});

  } catch (err) {
    log(`\nERROR: ${err?.message || JSON.stringify(err) || err}`);
    emit('error', { error: err?.message || String(err) });
  }

  setTimeout(() => app.quit(), 5000);
});

app.on('window-all-closed', () => app.quit());
