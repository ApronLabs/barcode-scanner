/**
 * 요기요 워커: 매장별 수집
 * 실행: npx electron poc-yogiyo.js --id=아이디 --pw=비밀번호 --mode=backfill|daily --targetDate=YYYY-MM-DD
 *       --storeId=매장UUID --serverUrl=http://localhost:3000 --sessionToken=JWT토큰
 */

const { app, BrowserWindow, WebContentsView } = require('electron');
const path = require('path');
const fs = require('fs');
const { RawDumper } = require('./lib/raw-dumper');
const POC_VERSION = app.getVersion() || 'unknown';
const rawDumper = new RawDumper('yogiyo');

// Electron 자동화 감지 비활성화
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// ── CLI 인자 파싱 ──
function getArg(name) {
  const a = process.argv.find(a => a.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : '';
}

const config = {
  id: getArg('id'),
  pw: getArg('pw'),
  mode: getArg('mode') || 'backfill',
  targetDate: getArg('targetDate'),
  storeId: getArg('storeId'),
  serverUrl: getArg('serverUrl'),
  sessionToken: getArg('sessionToken'),
};

const LOG_FILE = path.join(__dirname, 'poc-yogiyo-log.txt');

// ── stdout JSON 프로토콜 ──
function emit(type, data) {
  console.log(JSON.stringify({ type, ...data }));
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return;
  fs.appendFileSync(LOG_FILE, `[FATAL] ${err.message}\n`);
  emit('error', { error: err.message });
});

// ── mode에 따른 날짜 범위 ──
function getDateRangeByMode() {
  if (config.mode === 'daily') {
    if (!config.targetDate) throw new Error('daily 모드에서는 --targetDate=YYYY-MM-DD 필요');
    return { startDate: config.targetDate, endDate: config.targetDate };
  }
  // backfill — 올해 1월 1일부터 D-1까지 (v3.5.4부터 전 기간 백필)
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const janFirst = new Date(today.getFullYear(), 0, 1);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { startDate: fmt(janFirst), endDate: fmt(yesterday) };
}

// ── 매출지킴이 API 전송 ──
async function sendToSalesKeeper(platform, targetDate, shopId, orders) {
  if (!config.serverUrl || !config.storeId || !config.sessionToken) return null;
  const url = `${config.serverUrl}/api/stores/${config.storeId}/crawler/${platform}`;
  const body = JSON.stringify({ targetDate, platformStoreId: shopId, orders, pocVersion: POC_VERSION });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `session-token=${config.sessionToken}`,
      },
      body,
    });
    log(`   API 전송 ${targetDate}: ${res.status}`);
    return { status: res.status, ok: res.ok };
  } catch (err) {
    log(`   API 전송 실패 ${targetDate}: ${err.message}`);
    emit('error', { error: `API 전송 실패 (${targetDate}): ${err.message}` });
    return null;
  }
}

// ── 인터셉트 스크립트 ──
const INTERCEPT_SCRIPT = `(function() {
  if (window._ygIntercepted) return;
  window._ygIntercepted = true;
  window._ygCaptures = [];
  window._ygAuthHeaders = {};
  window._ygOrdersRequest = null;

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const opts = args[1] || {};
    if (url.includes('ceo-api.yogiyo.co.kr') || url.includes('yogiyo')) {
      try {
        const h = opts.headers;
        if (h) {
          if (h instanceof Headers) h.forEach((v, k) => { window._ygAuthHeaders[k.toLowerCase()] = v; });
          else if (typeof h === 'object') Object.entries(h).forEach(([k, v]) => { window._ygAuthHeaders[k.toLowerCase()] = v; });
        }
      } catch {}
    }
    const response = await origFetch.apply(this, args);
    if (url.includes('ceo-api.yogiyo.co.kr') || url.includes('yogiyo') || url.includes('/proxy/')) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        try {
          const json = JSON.parse(text);
          window._ygCaptures.push({ url, data: json, ts: Date.now(), method: opts.method || 'GET', body: opts.body || null });
          console.log('[intercept] fetch: ' + url.substring(0, 150));
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
    this._interceptMethod = method;
    this._interceptHeaders = {};
    return origXHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this._interceptHeaders) this._interceptHeaders[name.toLowerCase()] = value;
    return origXHRSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const sendBody = args[0] || null;
    const method = this._interceptMethod || 'GET';
    this.addEventListener('load', function() {
      const url = this._interceptUrl || '';
      if (url.includes('ceo-api.yogiyo.co.kr') || url.includes('yogiyo') || url.includes('/proxy/')) {
        if (this._interceptHeaders) {
          Object.assign(window._ygAuthHeaders, this._interceptHeaders);
        }
        try {
          const json = JSON.parse(this.responseText);
          const captureEntry = { url, data: json, ts: Date.now(), method, body: sendBody, xhrHeaders: {...(this._interceptHeaders || {})} };
          window._ygCaptures.push(captureEntry);
          console.log('[intercept] XHR(' + method + '): ' + url.substring(0, 150));
          if (url.includes('/proxy/orders') && (json.orders || json.results)) {
            window._ygOrdersRequest = {
              url, method, body: sendBody,
              headers: {...(this._interceptHeaders || {})},
              count: json.count,
              next: json.next || null,
              responseUrl: this.responseURL || url,
            };
            console.log('[intercept] 주문API 저장: ' + method + ' ' + url);
          }
        } catch {}
      }
    });
    return origXHRSend.apply(this, args);
  };
})()`;

// ── 인터셉트 리셋 ──
const RESET_CAPTURES_SCRIPT = `(function() {
  window._ygCaptures = [];
  window._ygOrdersRequest = null;
  console.log('[intercept] 캡처 초기화 완료');
})()`;

// ── 자동 로그인 ──
function getAutoLoginScript(id, pw) {
  return `(async function() {
    await new Promise(r => setTimeout(r, 2000));
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
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', {bubbles:true}));
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, val);
      if (el.value !== val) {
        setter.call(el, val);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: val }));
        el.dispatchEvent(new Event('change', {bubbles:true}));
      }
    }
    typeInto(idInput, ${JSON.stringify(id)});
    await new Promise(r => setTimeout(r, 300));
    typeInto(pwInput, ${JSON.stringify(pw)});
    await new Promise(r => setTimeout(r, 500));
    const btns = document.querySelectorAll('button, input[type="submit"], a');
    for (const btn of btns) {
      const t = (btn.textContent||'').trim();
      if (t.includes('로그인') || t.includes('Login') || t.includes('Sign')) { btn.click(); return { success: true }; }
    }
    const sub = document.querySelector('button[type="submit"]');
    if (sub) { sub.click(); return { success: true }; }
    return { success: false, error: 'login button not found' };
  })()`;
}

// ── 매장 리스트 추출 (사이드바) ──
function getStoreListScript() {
  return `(async function() {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    console.log('[intercept] 매장 리스트 추출 시작...');
    const allElements = document.querySelectorAll('div, span, button, a, li, p');
    let storeToggle = null;
    for (const el of allElements) {
      const text = (el.innerText || '').trim();
      if (text.includes('ID.') && text.includes('계약') && el.offsetParent !== null) {
        let clickable = el;
        for (let p = el; p && p !== document.body; p = p.parentElement) {
          if (p.tagName === 'BUTTON' || p.tagName === 'A' || p.getAttribute('role') === 'button' ||
              p.style?.cursor === 'pointer' || p.onclick) {
            clickable = p; break;
          }
        }
        storeToggle = clickable; break;
      }
    }
    if (!storeToggle) {
      const sidebar = document.querySelector('[class*="sidebar"], [class*="side-bar"], nav, aside');
      if (sidebar) {
        const firstClickable = sidebar.querySelector('button, a, [role="button"], div[class*="store"], div[class*="shop"]');
        if (firstClickable) storeToggle = firstClickable;
      }
    }
    if (!storeToggle) return { stores: [], error: 'store toggle not found' };
    storeToggle.click();
    await sleep(2000);
    const stores = [];
    const storeElements = document.querySelectorAll('div, span, li, a, button, p');
    const seen = new Set();
    for (const el of storeElements) {
      const text = (el.innerText || '').trim();
      if (!text.includes('ID.') || !text.match(/ID\\.\\s*\\d+/) || el.offsetParent === null) continue;
      if (text.length > 200) continue;
      const idMatch = text.match(/ID\\.\\s*(\\d+)/);
      if (!idMatch) continue;
      const storeId = idMatch[1];
      if (seen.has(storeId)) continue;
      seen.add(storeId);
      let storeName = text.split('ID.')[0].trim();
      storeName = storeName.replace(/[·\\-]\\s*$/, '').trim();
      const isSelected = text.includes('\\u2713') || text.includes('\\u2714') ||
        el.querySelector('[class*="check"], [class*="selected"]') !== null ||
        (el.className || '').includes('selected') || (el.className || '').includes('active');
      stores.push({ storeId, storeName: storeName || 'Unknown', isSelected, elementText: text.substring(0, 100) });
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(500);
    return { stores };
  })()`;
}

// ── 매장 선택 ──
function getSelectStoreScript(storeId) {
  return `(async function() {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const targetStoreId = ${JSON.stringify(storeId)};
    const allElements = document.querySelectorAll('div, span, button, a, li, p');
    let storeToggle = null;
    for (const el of allElements) {
      const text = (el.innerText || '').trim();
      if (text.includes('ID.') && text.includes('계약') && el.offsetParent !== null) {
        let clickable = el;
        for (let p = el; p && p !== document.body; p = p.parentElement) {
          if (p.tagName === 'BUTTON' || p.tagName === 'A' || p.getAttribute('role') === 'button' ||
              p.style?.cursor === 'pointer' || p.onclick) {
            clickable = p; break;
          }
        }
        storeToggle = clickable; break;
      }
    }
    if (!storeToggle) {
      const sidebar = document.querySelector('[class*="sidebar"], [class*="side-bar"], nav, aside');
      if (sidebar) {
        const firstClickable = sidebar.querySelector('button, a, [role="button"], div[class*="store"], div[class*="shop"]');
        if (firstClickable) storeToggle = firstClickable;
      }
    }
    if (!storeToggle) return { success: false, error: 'store toggle not found' };
    storeToggle.click();
    await sleep(2000);
    const candidates = document.querySelectorAll('div, span, li, a, button, p');
    let clicked = false;
    for (const el of candidates) {
      const text = (el.innerText || '').trim();
      if (!text.includes('ID.') || el.offsetParent === null) continue;
      if (text.length > 200) continue;
      const m = text.match(/ID\\.\\s*(\\d+)/);
      if (m && m[1] === targetStoreId) {
        if (text.includes('\\u2713') || text.includes('\\u2714') ||
            (el.className || '').includes('selected') || (el.className || '').includes('active')) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
          await sleep(500);
          return { success: true, alreadySelected: true };
        }
        el.click();
        clicked = true; break;
      }
    }
    if (!clicked) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      return { success: false, error: 'store ID not found in dropdown: ' + targetStoreId };
    }
    await sleep(5000);
    return { success: true };
  })()`;
}

// ── 날짜 필터 ──
function getBackfillDateFilterScript(startDate, endDate) {
  return `(async function() {
    const startDate = ${JSON.stringify(startDate)};
    const endDate = ${JSON.stringify(endDate)};
    const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
    const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    console.log('[intercept] 날짜 필터: ' + startDate + ' ~ ' + endDate);

    const container = document.querySelector('.react-datepicker__input-container');
    if (!container) return { success: false, error: 'react-datepicker 못 찾음' };
    const input = container.querySelector('input');
    if (!input) return { success: false, error: 'datepicker input 못 찾음' };
    input.focus(); input.click();
    await sleep(1500);

    const customOpt = Array.from(document.querySelectorAll('div, span, li, button'))
      .find(el => el.innerText.trim() === '직접설정' && el.offsetParent !== null && el.children.length === 0);
    if (customOpt) {
      customOpt.click();
      await sleep(2000);
    } else {
      return { success: false, error: '직접설정 옵션 못 찾음' };
    }

    function getCurrentCalendarMonth() {
      const headerEls = document.querySelectorAll('.react-datepicker__header--custom');
      const months = [];
      headerEls.forEach(el => {
        const text = el.innerText.trim();
        const m = text.match(/(\\d{4})년\\s*(\\d{1,2})월/);
        if (m) months.push({ year: parseInt(m[1]), month: parseInt(m[2]), text: m[0] });
      });
      if (months.length > 0) return months;
      const monthEls = document.querySelectorAll('.react-datepicker__current-month');
      monthEls.forEach(el => {
        const text = el.innerText.trim();
        const m = text.match(/(\\d{4})년\\s*(\\d{1,2})월/) || text.match(/(\\d{4})\\.(\\d{1,2})/);
        if (m) months.push({ year: parseInt(m[1]), month: parseInt(m[2]), text: m[0] });
      });
      return months;
    }

    async function clickPrev() {
      const prevBtn = document.querySelector('.react-datepicker__navigation--previous, [class*="navigation--previous"]')
        || Array.from(document.querySelectorAll('button')).find(b => {
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          const text = (b.innerText || '').trim();
          return aria.includes('previous') || aria.includes('이전') || text === '<' || text === '\\u2039' || text === '<<';
        });
      if (prevBtn) { prevBtn.click(); await sleep(400); return true; }
      return false;
    }

    async function clickNext() {
      const nextBtn = document.querySelector('.react-datepicker__navigation--next, [class*="navigation--next"]')
        || Array.from(document.querySelectorAll('button')).find(b => {
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          const text = (b.innerText || '').trim();
          return aria.includes('next') || aria.includes('다음') || text === '>' || text === '\\u203A' || text === '>>';
        });
      if (nextBtn) { nextBtn.click(); await sleep(400); return true; }
      return false;
    }

    function findAndClickDay(year, month, day) {
      const dayEls = document.querySelectorAll('.react-datepicker__day');
      for (const el of dayEls) {
        const cls = el.className || '';
        if (cls.includes('disabled') || cls.includes('outside')) continue;
        const aria = el.getAttribute('aria-label') || '';
        const n = parseInt(el.innerText?.trim(), 10);
        if (aria.includes(month + '월') && aria.includes(day + '일') && n === day) {
          el.click(); return true;
        }
      }
      for (const el of dayEls) {
        const cls = el.className || '';
        if (cls.includes('disabled') || cls.includes('outside') || cls.includes('name')) continue;
        const n = parseInt(el.innerText?.trim(), 10);
        if (n === day && !isNaN(n)) { el.click(); return true; }
      }
      return false;
    }

    for (let nav = 0; nav < 12; nav++) {
      const months = getCurrentCalendarMonth();
      const found = months.some(m => m.year === startYear && m.month === startMonth);
      if (found) break;
      if (!(await clickPrev())) break;
    }
    await sleep(500);
    if (!findAndClickDay(startYear, startMonth, startDay)) {
      return { success: false, error: '시작일 클릭 실패: ' + startDate };
    }
    await sleep(1000);

    for (let nav = 0; nav < 12; nav++) {
      const months = getCurrentCalendarMonth();
      const found = months.some(m => m.year === endYear && m.month === endMonth);
      if (found) break;
      if (!(await clickNext())) break;
    }
    await sleep(500);
    if (!findAndClickDay(endYear, endMonth, endDay)) {
      return { success: false, error: '종료일 클릭 실패: ' + endDate };
    }
    await sleep(1000);

    await sleep(500);
    const searchBtn = Array.from(document.querySelectorAll('button'))
      .find(b => b.innerText.trim() === '조회' && b.offsetParent !== null);
    if (searchBtn) { searchBtn.click(); await sleep(3000); }

    return { success: true, startDate, endDate };
  })()`;
}

// ── DB SalesOrder 매핑 ──
// v3.5.4: deliveryCost 버그 수정 + 필드명 정리
//
// 변경 사항:
// 1. deliveryCost — 기존 `s.delivery_fee || findItem('배달')` 은 settlement_items의
//    "배달요금"(매장 수령액)까지 매장 부담 배달비로 잘못 집계했음.
//    → `findItem('배달대행')` 으로 교체. 없으면 0.
//
// 2. 필드 분리 + 이름 명확화:
//    - sellerDiscount (사장님 부담 할인) — settlement_items에서 "사장님 부담 / 타임 / 프로모션 / 쿠폰"
//    - platformSubsidy (요기요 보전 할인, 매장 입금 +) — yogiyo_discount_amount
//    - adCost (광고 상품 이용 대금) — 추천광고 + 요타임딜
//
// 3. 레거시 필드는 호환성 위해 유지:
//    - storeDiscount (기존 이름; 값은 sellerDiscount와 동일하게 제공 → 노심 route pickSellerDiscount로 수용)
//    - adFee (기존 이름; adCost와 동일값)
function mapToSalesOrder(order, settlementMap, storeName, storeId) {
  const s = settlementMap[order.order_number] || {};
  const si = s.settlement_info || {};
  const items = si.settlement_items || [];
  const findItem = (keyword) => {
    const item = items.find(i => (i.item_title || '').includes(keyword));
    return Math.abs(item?.item_amount ?? item?.item_price ?? 0);
  };
  const sumFind = (...kws) => kws.reduce((a, k) => a + findItem(k), 0);

  const menuItems = order.items || [];
  const firstItemName = menuItems[0]?.name || '';
  const menuSummary = menuItems.length > 1
    ? `${firstItemName} 외 ${menuItems.length - 1}건`
    : firstItemName;

  const payMap = { ONLINE: '온라인결제', OFFLINE_CARD: '만나서카드', OFFLINE_CASH: '만나서현금' };
  const channelMap = { VD: '배달', OD: '자체배달', TAKEOUT: '포장' };

  // 새 이름 (v3.5.4)
  const sellerDiscount = sumFind('사장님', '타임 할인', '프로모션', '쿠폰 할인');
  const platformSubsidy = Math.abs(si.yogiyo_discount_amount || 0);
  const adCost = sumFind('추천광고', '요타임딜');
  // ★ 버그 fix: 배달대행료만 매칭, 없으면 0
  const deliveryCost = findItem('배달대행');

  return {
    storeName,
    storeId,
    orderId: order.order_number || '',
    // ★ v3.5.6: submitted_at은 KST인데 타임존 없이 내려옴 (예: "2026-03-08 19:43:39").
    // 그대로 전송하면 노심 route의 new Date()가 UTC로 해석 → order_date 하루 밀림.
    // +09:00 suffix 추가하여 KST 명시.
    orderedAt: (order.submitted_at || '').replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/, '$1T$2+09:00') || order.submitted_at || '',
    orderType: order.service_type || '',
    orderStatus: order.transmission_status || '',
    channel: channelMap[order.delivery_method_code] || order.delivery_method_code || '',
    paymentMethod: payMap[order.central_payment_type] || order.central_payment_type || '',
    menuSummary,
    menuAmount: order.items_price || 0,
    deliveryIncome: order.delivery_fee || 0,
    orderPrice: order.order_price || 0,
    commissionFee: findItem('주문중개') || findItem('중개') || findItem('이용료'),
    pgFee: findItem('외부결제') || findItem('결제'),
    // ── v3.5.4 필드 이름 (노심 route의 pick* 헬퍼가 이 이름을 우선 사용) ──
    // 레거시 storeDiscount/adFee는 의도적으로 제거:
    //   v3.5.3에서는 storeDiscount가 "요기요 할인보전"(플랫폼 보전값)이었는데
    //   v3.5.4에서 의미가 "사장님 부담 할인"으로 바뀌어 혼동 위험.
    //   노심 route는 이미 platformSubsidy/sellerDiscount/adCost 새 이름을 수신하므로
    //   레거시 필드 없어도 정상 동작.
    sellerDiscount,
    platformSubsidy,
    adCost,
    deliveryCost,
    vat: findItem('부가세'),
    settlementAmount: si.settlement_amount || 0,
    settlementDate: si.payment_date || '',
    items: menuItems.map(item => ({
      menuName: item.name || '',
      quantity: item.quantity || 1,
    })),
    rawSettlement: s,
  };
}

let mainWindow, webView;

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
  return url.includes('/login') || url.includes('/signin');
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

// ── 주문 수집 + 페이지네이션 ──
async function collectOrders(startDate, endDate) {
  await webView.webContents.executeJavaScript(RESET_CAPTURES_SCRIPT).catch(() => {});
  await sleep(1000);

  const filterResult = await webView.webContents.executeJavaScript(getBackfillDateFilterScript(startDate, endDate));
  log(`   필터 결과: ${JSON.stringify(filterResult)}`);
  if (!filterResult?.success) {
    log(`   날짜 필터 실패: ${filterResult?.error || 'unknown'}`);
    return [];
  }
  await sleep(5000);

  const captureState = await webView.webContents.executeJavaScript(`({
    count: (window._ygCaptures||[]).length,
    orderCaptures: (window._ygCaptures||[]).filter(x => x.url.includes('/proxy/orders')).length,
    urls: (window._ygCaptures||[]).map(x => x.url.substring(0, 120))
  })`);
  log(`   캡처 ${captureState.count}건 (주문API: ${captureState.orderCaptures}건)`);

  let firstPageData = await webView.webContents.executeJavaScript(`(function() {
    const c = window._ygCaptures || [];
    for (let i = c.length - 1; i >= 0; i--) {
      if (c[i].url.includes('/proxy/orders')) {
        const d = c[i].data;
        if (d.orders || d.results) return { data: d, url: c[i].url };
      }
    }
    return null;
  })()`);

  if (!firstPageData) {
    log('   주문 API 캡처 실패');
    return [];
  }

  const ordersData = firstPageData.data;
  const firstPageUrl = firstPageData.url;
  let allOrders = ordersData.orders || ordersData.results || [];
  const totalCount = ordersData.count || allOrders.length;
  log(`   1페이지: ${allOrders.length}건 / 전체: ${totalCount}건`);

  // 페이지네이션
  if (totalCount > allOrders.length) {
    log(`   페이지네이션: ${totalCount}건 중 ${allOrders.length}건 수신`);

    const remainingOrders = await webView.webContents.executeJavaScript(`(async function() {
      const totalCount = ${totalCount};
      const pageSize = ${allOrders.length};
      const allExtra = [];
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const reqInfo = window._ygOrdersRequest;
      const xhrHeaders = reqInfo?.headers || {};
      const allHeaders = {...(window._ygAuthHeaders || {}), ...xhrHeaders};
      const origUrl = reqInfo?.url || ${JSON.stringify(firstPageUrl)};
      const origMethod = reqInfo?.method || 'GET';
      const origBody = reqInfo?.body || null;

      let bodyObj = null;
      try { bodyObj = origBody ? JSON.parse(origBody) : null; } catch {}

      if (bodyObj && typeof bodyObj.page !== 'undefined') {
        const totalPages = Math.ceil(totalCount / pageSize);
        for (let page = 2; page <= totalPages; page++) {
          try {
            bodyObj.page = page;
            const bodyStr = JSON.stringify(bodyObj);
            const xhr = new XMLHttpRequest();
            xhr.open(origMethod, origUrl, false);
            Object.entries(allHeaders).forEach(([k, v]) => {
              try { xhr.setRequestHeader(k, v); } catch {}
            });
            xhr.send(bodyStr);
            if (xhr.status === 200) {
              const data = JSON.parse(xhr.responseText);
              const orders = data.orders || data.results || [];
              if (orders.length === 0) break;
              allExtra.push(...orders);
              if (allExtra.length + pageSize >= totalCount) break;
              if (page % 3 === 0) await sleep(300);
            } else {
              if (xhr.status === 401 || xhr.status === 403) break;
            }
          } catch (e) { break; }
        }
      } else {
        for (let offset = pageSize; offset < totalCount; offset += pageSize) {
          try {
            let paginatedUrl = origUrl + (origUrl.includes('?') ? '&' : '?') + 'offset=' + offset;
            const xhr = new XMLHttpRequest();
            xhr.open(origMethod, paginatedUrl, false);
            Object.entries(allHeaders).forEach(([k, v]) => {
              try { xhr.setRequestHeader(k, v); } catch {}
            });
            xhr.send(origBody);
            if (xhr.status === 200) {
              const data = JSON.parse(xhr.responseText);
              const orders = data.orders || data.results || [];
              if (orders.length === 0) break;
              allExtra.push(...orders);
              if (allExtra.length + pageSize >= totalCount) break;
              await sleep(300);
            } else break;
          } catch (e) { break; }
        }
      }

      // DOM 페이지 버튼 폴백
      if (allExtra.length === 0) {
        let captureIdx = (window._ygCaptures || []).length;
        for (let collected = pageSize; collected < totalCount; ) {
          const pageBtn = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(b => {
            const text = (b.innerText || '').trim();
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return text === '>' || text === '\\u203A' || text === '>>' || text === '다음' ||
              aria.includes('next') || aria.includes('다음');
          });
          const currentPage = Math.floor(collected / pageSize);
          const nextPage = currentPage + 1;
          const pageNumBtn = !pageBtn ? Array.from(document.querySelectorAll('button, a')).find(b => {
            const text = (b.innerText || '').trim();
            return text === String(nextPage) && b.closest('nav, [class*="pagination"], [class*="pager"]');
          }) : null;
          const clickTarget = pageBtn || pageNumBtn;
          if (!clickTarget) break;
          clickTarget.click();
          let found = false;
          for (let wait = 0; wait < 15; wait++) {
            await sleep(500);
            const newCaptures = (window._ygCaptures || []).slice(captureIdx);
            const orderResp = newCaptures.find(c => c.url.includes('/proxy/orders') && (c.data?.orders || c.data?.results));
            if (orderResp) {
              const orders = orderResp.data.orders || orderResp.data.results || [];
              allExtra.push(...orders);
              collected += orders.length;
              captureIdx = (window._ygCaptures || []).length;
              found = true;
              break;
            }
          }
          if (!found) break;
          await sleep(500);
        }
      }

      return allExtra;
    })()`);
    allOrders = allOrders.concat(remainingOrders);
    log(`   전체 주문 수집 완료: ${allOrders.length}건`);
  }

  return allOrders;
}

// ── 정산 수집 (전체 주문 대상, 배치 처리) ──
async function collectSettlements(orderNumbers) {
  log(`   정산 수집: 전체 ${orderNumbers.length}건 (배치 5건씩)`);

  // 브라우저 내 메모리 제한을 피하기 위해 Node 측에서 배치 분할
  const BATCH_SIZE = 5;
  const allSettlementResults = [];

  for (let batchStart = 0; batchStart < orderNumbers.length; batchStart += BATCH_SIZE) {
    const batchOrderNumbers = orderNumbers.slice(batchStart, batchStart + BATCH_SIZE);

    const batchResults = await webView.webContents.executeJavaScript(`(async function() {
      const orderNumbers = ${JSON.stringify(batchOrderNumbers)};
      const results = [];
      const reqInfo = window._ygOrdersRequest;
      const xhrHeaders = reqInfo?.headers || {};
      const allHeaders = {...(window._ygAuthHeaders || {}), ...xhrHeaders};

      function fetchDetail(orderNo, headers) {
        return new Promise((resolve) => {
          const url = 'https://ceo-api.yogiyo.co.kr/proxy/order_detail/' + orderNo + '/';
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.timeout = 8000;
          Object.entries(headers).forEach(([k, v]) => {
            try { xhr.setRequestHeader(k, v); } catch {}
          });
          xhr.onload = function() {
            if (xhr.status === 200) {
              try {
                const data = JSON.parse(xhr.responseText);
                resolve({ orderNumber: orderNo, data: data.data || data });
              } catch (e) { resolve({ orderNumber: orderNo, data: null }); }
            } else { resolve({ orderNumber: orderNo, data: null }); }
          };
          xhr.onerror = function() { resolve({ orderNumber: orderNo, data: null }); };
          xhr.ontimeout = function() { resolve({ orderNumber: orderNo, data: null }); };
          xhr.send();
        });
      }

      const batchResults = await Promise.all(orderNumbers.map(no => fetchDetail(no, allHeaders)));
      results.push(...batchResults);
      return results;
    })()`);

    allSettlementResults.push(...batchResults);
    log(`   정산 배치 ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(orderNumbers.length / BATCH_SIZE)} 완료 (${allSettlementResults.length}/${orderNumbers.length}건)`);

    // 배치 간 딜레이 (마지막 배치 제외)
    if (batchStart + BATCH_SIZE < orderNumbers.length) await sleep(300);
  }

  const settlementMap = {};
  for (const r of allSettlementResults) {
    if (r.data) settlementMap[r.orderNumber] = r.data;
  }
  log(`   정산 캡처 성공: ${Object.keys(settlementMap).length}/${orderNumbers.length}건`);
  return settlementMap;
}

// ═══════════════════════════════════════════════════════════════
// 메인 실행
// ═══════════════════════════════════════════════════════════════
app.whenReady().then(async () => {
  fs.writeFileSync(LOG_FILE, '');

  if (!config.id || !config.pw) {
    emit('error', { error: '--id=ID --pw=PW 필요' });
    app.quit(); return;
  }

  const { startDate, endDate } = getDateRangeByMode();
  emit('status', { msg: `요기요 수집 시작 (${config.mode}: ${startDate} ~ ${endDate})` });
  log(`=== 요기요 워커: ${config.mode} (${startDate} ~ ${endDate}) ===`);

  mainWindow = new BrowserWindow({ width: 1200, height: 900, show: false });
  mainWindow.loadURL('about:blank');

  webView = new WebContentsView({
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  mainWindow.contentView.addChildView(webView);
  const [w, h] = mainWindow.getContentSize();
  webView.setBounds({ x: 0, y: 0, width: w, height: h });

  webView.webContents.on('dom-ready', () => {
    webView.webContents.executeJavaScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      delete window.__electron; delete window.__webpack_require__;
      window.chrome = { runtime: {}, loadTimes: () => ({}) };
      Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
    `).catch(() => {});
  });

  webView.webContents.on('console-message', (_, level, msg) => {
    if (msg.includes('[intercept]')) log(`  ${msg}`);
  });

  const allStoreResults = [];

  try {
    // ═══ 1) 로그인 ═══
    emit('status', { msg: '요기요 로그인 중...' });
    log('1) 요기요 로그인...');
    await navigateAndWait('https://ceo.yogiyo.co.kr/login');
    await sleep(3000);

    let url = webView.webContents.getURL();
    if (isLoginUrl(url)) {
      const loginResult = await webView.webContents.executeJavaScript(getAutoLoginScript(config.id, config.pw));
      log(`   자동 로그인: ${JSON.stringify(loginResult)}`);
      await sleep(5000);
      await waitForLoginRedirect(15000);
      await sleep(2000);
    }

    url = webView.webContents.getURL();
    if (isLoginUrl(url)) {
      log('   자동 로그인 실패 -> 수동 대기 (60초)');
      await waitForLoginRedirect(60000);
      await sleep(2000);
      url = webView.webContents.getURL();
    }
    if (isLoginUrl(url)) {
      emit('error', { error: '요기요 로그인 실패' });
      throw new Error('요기요 로그인 실패');
    }
    log('   -> 로그인 완료');

    // ═══ 2) 주문내역 이동 + 인터셉트 설치 ═══
    emit('status', { msg: '주문내역 페이지 이동 중...' });
    log('2) 주문내역 페이지 이동...');
    webView.webContents.once('dom-ready', () => {
      webView.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});
    });
    await navigateAndWait('https://ceo.yogiyo.co.kr/order-history/list');
    await sleep(5000);
    await webView.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});
    await sleep(3000);

    // ═══ 3) 매장 리스트 추출 ═══
    emit('status', { msg: '매장 리스트 추출 중...' });
    log('3) 매장 리스트 추출...');
    const storeListResult = await webView.webContents.executeJavaScript(getStoreListScript());
    let stores = storeListResult?.stores || [];
    log(`   매장 ${stores.length}개 발견`);

    if (stores.length === 0) {
      log('   매장 리스트 없음 -> 현재 매장 정보 추출 시도');
      const currentStore = await webView.webContents.executeJavaScript(`(function() {
        const allEls = document.querySelectorAll('div, span, p, h1, h2, h3, h4');
        for (const el of allEls) {
          const text = (el.innerText || '').trim();
          if (text.includes('ID.') && text.match(/ID\\.\\s*\\d+/) && el.offsetParent !== null && text.length < 200) {
            const m = text.match(/ID\\.\\s*(\\d+)/);
            if (m) {
              const storeName = text.split('ID.')[0].trim().replace(/[·\\-]\\s*$/, '').trim();
              return { storeId: m[1], storeName: storeName || 'Unknown' };
            }
          }
        }
        return null;
      })()`);

      if (currentStore) {
        stores = [{ storeId: currentStore.storeId, storeName: currentStore.storeName, isSelected: true }];
      } else {
        stores = [{ storeId: 'unknown', storeName: 'Unknown', isSelected: true }];
      }
    }

    stores.forEach(s => emit('shop', { shopName: s.storeName, shopId: s.storeId }));

    // ═══ 4) 매장별 수집 ═══
    for (let si = 0; si < stores.length; si++) {
      const store = stores[si];
      log(`\n[매장 ${si + 1}/${stores.length}] ${store.storeName} (ID: ${store.storeId})`);

      // 매장 선택
      if (si > 0 || !store.isSelected) {
        const selectResult = await webView.webContents.executeJavaScript(getSelectStoreScript(store.storeId));
        log(`   매장 전환: ${JSON.stringify(selectResult)}`);

        if (!selectResult?.success) {
          allStoreResults.push({
            storeName: store.storeName,
            storeId: store.storeId,
            error: `매장 전환 실패: ${selectResult?.error || 'unknown'}`,
            orders: [],
          });
          continue;
        }

        await sleep(3000);
        const currentUrl = webView.webContents.getURL();
        if (!currentUrl.includes('/order-history')) {
          webView.webContents.once('dom-ready', () => {
            webView.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});
          });
          await navigateAndWait('https://ceo.yogiyo.co.kr/order-history/list');
          await sleep(5000);
        }
        await webView.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});
        await sleep(2000);
      }

      // 날짜 필터 + 주문 수집
      log(`   날짜 필터: ${startDate} ~ ${endDate}`);
      const allOrders = await collectOrders(startDate, endDate);
      log(`   주문 수집 완료: ${allOrders.length}건`);

      emit('progress', { current: allOrders.length, total: allOrders.length, date: endDate });

      if (allOrders.length === 0) {
        allStoreResults.push({
          storeName: store.storeName,
          storeId: store.storeId,
          totalOrders: 0,
          orders: [],
          dailySummary: {},
        });
        continue;
      }

      // 정산 수집
      const orderNumbers = allOrders.map(o => o.order_number).filter(Boolean);
      const settlementMap = await collectSettlements(orderNumbers);

      // DUMP_RAW=1 시 raw 응답 샘플 수집 (주문 + 매칭되는 정산 정보)
      // settlementMap 은 plain object — `.get()` 아닌 index 접근 (line 775 collectSettlements 반환)
      for (const o of allOrders) {
        rawDumper.add({ order: o, settlement: settlementMap[o.order_number] ?? null });
      }

      // 매핑
      const mapped = allOrders.map(o => mapToSalesOrder(o, settlementMap, store.storeName, store.storeId));

      // 날짜별 그룹핑
      const dailyGroups = {};
      for (const m of mapped) {
        const date = (m.orderedAt || '').split(' ')[0] || 'unknown';
        if (!dailyGroups[date]) dailyGroups[date] = [];
        dailyGroups[date].push(m);
      }

      const dailySummary = {};
      const sortedDates = Object.keys(dailyGroups).sort();
      for (const date of sortedDates) {
        const dayOrders = dailyGroups[date];
        dailySummary[date] = dayOrders.reduce((a, m) => {
          a.count++;
          a.menuAmount += m.menuAmount;
          a.deliveryIncome += m.deliveryIncome;
          a.orderPrice += m.orderPrice;
          a.commissionFee += m.commissionFee;
          a.pgFee += m.pgFee;
          a.deliveryCost += m.deliveryCost;
          a.storeDiscount += m.storeDiscount;
          a.settlementAmount += m.settlementAmount;
          return a;
        }, { count: 0, menuAmount: 0, deliveryIncome: 0, orderPrice: 0, commissionFee: 0, pgFee: 0, deliveryCost: 0, storeDiscount: 0, settlementAmount: 0 });
      }

      // 날짜별 매출지킴이 API 전송
      for (const date of sortedDates) {
        const dayOrders = dailyGroups[date];
        await sendToSalesKeeper('yogiyo', date, store.storeId, dayOrders);
      }

      allStoreResults.push({
        storeName: store.storeName,
        storeId: store.storeId,
        totalOrders: mapped.length,
        totalDays: sortedDates.length,
        dailySummary,
        orders: mapped,
      });
    }

    // ═══ 5) 결과 emit ═══
    emit('result', {
      site: 'yogiyo',
      shops: allStoreResults.map(s => ({
        shopName: s.storeName,
        shopId: s.storeId,
        orders: s.orders,
        dailySummary: s.dailySummary,
        totalOrders: s.totalOrders || 0,
      })),
    });

    rawDumper.flush(config.targetDate || new Date().toISOString().slice(0, 10), { mode: config.mode });

    log('\n=== 요기요 워커 완료 ===');
    emit('done', {});

  } catch (err) {
    log(`\nERROR: ${err?.message || JSON.stringify(err) || err}`);
    emit('error', { error: err?.message || String(err) });

    if (allStoreResults.length > 0) {
      emit('result', {
        site: 'yogiyo',
        shops: allStoreResults.map(s => ({
          shopName: s.storeName,
          shopId: s.storeId,
          orders: s.orders,
          dailySummary: s.dailySummary,
          totalOrders: s.totalOrders || 0,
        })),
        partial: true,
      });
    }
  }

  setTimeout(() => app.quit(), 5000);
});

app.on('window-all-closed', () => app.quit());
