// 땡겨요 크롤링 워커 - 별도 Node.js 프로세스에서 실행
// boss.ddangyo.com (WebSquare SPA)
//
// v2: 정산 데이터 수집 + 매출지킴이 전송
//     주문내역 + 정산상세(requestQryCalculateDetail) API 인터셉트
// v3: backfill 모드 — 시작일 캘린더 조작 + 날짜별 그룹핑 전송
// v4: backfill 모드 — POC 검증 완료된 API body 직접 수정 방식
//     WebSquare DOM 조작 대신 캡처된 API body의 dma_para를 수정하여 직접 fetch
//     매장별 수집: gen_patstoSelector에서 매장 목록 추출 → patsto_no로 매장 구분
'use strict';

const path = require('path');

function findChromePath() {
  if (process.platform === 'darwin') {
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const p of paths) {
      try { require('fs').accessSync(p); return p; } catch {}
    }
  } else if (process.platform === 'win32') {
    const os = require('os');
    const paths = [
      path.join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const p of paths) {
      try { require('fs').accessSync(p); return p; } catch {}
    }
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function send(type, data) {
  if (process.send) process.send({ type, ...data });
}

// YYYYMMDD → YYYY-MM-DD 변환
function compactToIsoDate(yyyymmdd) {
  return yyyymmdd.slice(0, 4) + '-' + yyyymmdd.slice(4, 6) + '-' + yyyymmdd.slice(6, 8);
}

// "2026.03.12(목)18:54:50" → "2026-03-12" 변환
function parseDateFromOrderDate(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // YYYYMMDD 형식 폴백
  const m2 = dateStr.match(/^(\d{4})(\d{2})(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
}

// 주문을 날짜별로 그룹핑
function groupOrdersByDate(orders) {
  const groups = {};
  for (const order of orders) {
    const date = parseDateFromOrderDate(order.date);
    if (!date) continue;
    if (!groups[date]) groups[date] = [];
    groups[date].push(order);
  }
  return groups;
}

// N일 전 날짜를 YYYYMMDD 형식으로 반환
function getDaysAgoCompact(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// N일 전 날짜를 YYYY-MM-DD 형식으로 반환
function getDaysAgoIso(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

// D-1 기준 전전달 1일부터 날짜 범위 계산
function getBackfillDateRange() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const end = new Date(yesterday);
  const start = new Date(yesterday.getFullYear(), yesterday.getMonth() - 2, 1); // 전전달 1일
  const fmt = (d) => d.toISOString().split('T')[0]; // YYYY-MM-DD
  const fmtCompact = (d) => fmt(d).replace(/-/g, ''); // YYYYMMDD
  return {
    startDate: fmt(start),
    endDate: fmt(end),
    startDateCompact: fmtCompact(start),
    endDateCompact: fmtCompact(end),
  };
}

// ═══════════════════════════════════════════════════════════
// API 인터셉트 스크립트 (fetch + XHR 모두 캡처)
// POC에서 검증 완료 — WebSquare의 XHR 기반 API 호출 캡처
// ═══════════════════════════════════════════════════════════

const INTERCEPT_SCRIPT = `(function() {
  if (window._ddIntercepted) return;
  window._ddIntercepted = true;
  window._ddCaptures = [];

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const opts = args[1] || {};
    const response = await origFetch.apply(this, args);
    if (url.includes('boss.ddangyo.com') || url.includes('/o2o/')) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        try {
          const json = JSON.parse(text);
          window._ddCaptures.push({
            url, data: json, ts: Date.now(),
            method: opts.method || 'GET',
            body: opts.body || null,
            contentType: opts.headers?.['Content-Type'] || null,
          });
        } catch {}
      } catch {}
    }
    return response;
  };

  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  const origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._ddUrl = url;
    this._ddMethod = method;
    this._ddHeaders = {};
    return origXHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this._ddHeaders) this._ddHeaders[name] = value;
    return origXHRSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this._ddBody = args[0] || null;
    this.addEventListener('load', function() {
      const url = this._ddUrl || '';
      if (url.includes('boss.ddangyo.com') || url.includes('/o2o/')) {
        try {
          const json = JSON.parse(this.responseText);
          window._ddCaptures.push({
            url, data: json, ts: Date.now(),
            method: this._ddMethod || 'GET',
            body: this._ddBody,
            headers: this._ddHeaders || {},
            contentType: (this._ddHeaders || {})['Content-Type'] || null,
          });
        } catch {}
      }
    });
    return origXHRSend.apply(this, args);
  };

  console.log('[intercept] API intercept installed');
  true;
})();`;

// ═══════════════════════════════════════════════════════════
// API 응답 기반 SalesOrder 매핑 (POC 검증 완료)
// ═══════════════════════════════════════════════════════════

function parseAmount(str) {
  if (typeof str === 'number') return str;
  if (!str) return 0;
  return parseInt(String(str).replace(/[^0-9\-]/g, ''), 10) || 0;
}

function parseDateTime(setlDt, setlTm) {
  if (!setlDt) return '';
  const y = setlDt.substring(0, 4);
  const m = setlDt.substring(4, 6);
  const d = setlDt.substring(6, 8);
  if (!setlTm) return `${y}-${m}-${d}`;
  const hh = setlTm.substring(0, 2);
  const mm = setlTm.substring(2, 4);
  const ss = setlTm.substring(4, 6);
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function mapToSalesOrder(order, storeName) {
  const menuNm = (order.menu_nm || '').trim();
  const saleAmt = parseAmount(order.sale_amt);
  const settlAmt = parseAmount(order.tot_setl_amt);
  const orderedAt = parseDateTime(order.setl_dt, order.setl_tm);

  return {
    orderId: order.ord_id || '',
    orderIdInternal: order.ord_no || '',
    orderedAt,
    orderType: order.ord_tp_nm || '',
    menuSummary: menuNm,
    menuAmount: saleAmt,
    settlementAmount: settlAmt,
    totalFee: saleAmt - settlAmt,
    channel: order.ord_tp_nm || 'DELIVERY',
    orderStatus: order.ord_prog_stat_cd === '40' ? 'COMPLETED' : order.ord_prog_stat_cd || '',
    isRegularCustomer: order.regl_cust_yn === 'Y',
    storeName: storeName,
    items: [],
  };
}

// 주문내역 추출 (DOM 스크래핑 — 일반 모드용)
// @param {boolean} skipNavigation - true이면 메뉴 클릭 생략 (backfill 등 이미 이동한 경우)
async function extractOrders(page, { skipNavigation = false } = {}) {
  if (!skipNavigation) {
    // 주문내역 메뉴 클릭 (SPA — a 태그 텍스트 클릭)
    console.log('[worker] 주문내역 메뉴 클릭');
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      links.find(a => a.innerText.trim() === '주문내역')?.click();
    });
    await sleep(5000);
  } else {
    console.log('[worker] 주문내역 메뉴 클릭 생략 (이미 이동됨)');
  }

  // 요약 정보
  const summary = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const s = {};
    const countMatch = bodyText.match(/주문 건수\s*(\d+)건/);
    const amountMatch = bodyText.match(/결제금액\s*([\d,]+)원/);
    if (countMatch) s['주문수'] = countMatch[1];
    if (amountMatch) s['결제금액'] = amountMatch[1];
    return s;
  });
  console.log('[worker] 요약:', JSON.stringify(summary));

  // 주문 데이터 추출 (WebSquare gen_benefitsList 패턴)
  const orders = await page.evaluate(() => {
    const result = [];
    let idx = 0;
    while (true) {
      const prefix = `mf_wfm_contents_gen_benefitsList_${idx}`;
      const orderNoEl = document.getElementById(`${prefix}_lbx_order_id`);
      if (!orderNoEl) break;

      const wrap = orderNoEl.closest('[class*="C_table_list_wrap"]');
      if (!wrap) { idx++; continue; }

      const get = (suffix) => {
        const el = wrap.querySelector(`[id$="_${suffix}"]`);
        return el?.innerText?.trim() || '';
      };

      result.push({
        orderNo: get('lbx_order_id'),
        date: get('ibx_setl_dt'),
        status: get('ibx_ord_prog_stat_cd'),
        orderSummary: get('ibx_menu_nm'),
        amount: get('ibx_sale_amt').replace('원', ''),
        method: get('ibx_ord_tp_cd'),
        customer: get('ibx_regl_cust_yn'),
      });
      idx++;
    }
    return result;
  });

  console.log(`[worker] ${orders.length}건 추출`);

  // 페이지네이션 확인 + 추가 페이지 처리
  const totalPages = await page.evaluate(() => {
    const paging = document.querySelector('[id*="pgl_pageList"]');
    if (!paging) return 1;
    const labels = paging.querySelectorAll('[class*="pageList_li_label"]');
    let max = 1;
    labels.forEach(el => {
      const n = parseInt(el.innerText.trim(), 10);
      if (!isNaN(n) && n > max) max = n;
    });
    return max;
  });

  const allOrders = [...orders];

  if (totalPages > 1) {
    console.log(`[worker] 총 ${totalPages} 페이지`);
    for (let pg = 2; pg <= totalPages; pg++) {
      console.log(`[worker] 페이지 ${pg}/${totalPages} 이동`);
      await page.evaluate((targetPage) => {
        const paging = document.querySelector('[id*="pgl_pageList"]');
        if (!paging) return;
        const labels = paging.querySelectorAll('[class*="pageList_control_label"]');
        labels.forEach(el => {
          if (el.innerText.trim() === String(targetPage)) el.click();
        });
      }, pg);
      await sleep(3000);

      const pageOrders = await page.evaluate(() => {
        const result = [];
        let idx = 0;
        while (true) {
          const prefix = `mf_wfm_contents_gen_benefitsList_${idx}`;
          const orderNoEl = document.getElementById(`${prefix}_lbx_order_id`);
          if (!orderNoEl) break;

          const wrap = orderNoEl.closest('[class*="C_table_list_wrap"]');
          if (!wrap) { idx++; continue; }

          const get = (suffix) => {
            const el = wrap.querySelector(`[id$="_${suffix}"]`);
            return el?.innerText?.trim() || '';
          };

          result.push({
            orderNo: get('lbx_order_id'),
            date: get('ibx_setl_dt'),
            status: get('ibx_ord_prog_stat_cd'),
            orderSummary: get('ibx_menu_nm'),
            amount: get('ibx_sale_amt').replace('원', ''),
            method: get('ibx_ord_tp_cd'),
            customer: get('ibx_regl_cust_yn'),
          });
          idx++;
        }
        return result;
      });

      console.log(`[worker] 페이지 ${pg}: ${pageOrders.length}건`);
      allOrders.push(...pageOrders);
    }
  }

  return {
    success: true,
    site: 'ddangyoyo',
    pageType: 'orders',
    extractedAt: new Date().toISOString(),
    url: page.url(),
    title: await page.title(),
    summary,
    orders: allOrders,
  };
}

// ═══════════════════════════════════════════════════════════
// 주문별 상세정보 추출 (할인금액, 배달비, 총결제금액)
// 주문 행 클릭 → 상세 팝업/패널에서 파싱 → 닫기
// ═══════════════════════════════════════════════════════════

async function extractOrderDetails(page, orders) {
  if (!orders || orders.length === 0) return;
  console.log(`[worker] 주문 상세정보 추출 시작 (${orders.length}건)`);

  const orderMap = {};
  for (const o of orders) orderMap[o.orderNo] = o;

  let processed = 0;

  // 페이지 1로 리셋
  await page.evaluate(() => {
    const paging = document.querySelector('[id*="pgl_pageList"]');
    if (!paging) return;
    const labels = paging.querySelectorAll('[class*="pageList_li_label"], [class*="pageList_control_label"]');
    for (const el of labels) {
      if (el.innerText.trim() === '1') { el.click(); return; }
    }
  });
  await sleep(3000);

  for (let pg = 1; pg <= 20; pg++) {
    const rowCount = await page.evaluate(() => {
      let idx = 0;
      while (document.getElementById(`mf_wfm_contents_gen_benefitsList_${idx}_lbx_order_id`)) idx++;
      return idx;
    });

    console.log(`[worker] 페이지 ${pg}: ${rowCount}행 발견`);
    if (rowCount === 0) break;

    for (let i = 0; i < rowCount; i++) {
      try {
        const orderNo = await page.evaluate((idx) => {
          return document.getElementById(`mf_wfm_contents_gen_benefitsList_${idx}_lbx_order_id`)?.innerText?.trim() || '';
        }, i);

        if (!orderNo) { console.log(`[worker] row ${i}: 주문번호 없음`); continue; }
        if (!orderMap[orderNo]) { console.log(`[worker] row ${i}: ${orderNo} orderMap에 없음 (skip)`); continue; }

        // ── puppeteer native click (WebSquare에서 더 안정적) ──
        const selector = `#mf_wfm_contents_gen_benefitsList_${i}_lbx_order_id`;
        try {
          await page.click(selector);
          console.log(`[worker] ${orderNo}: puppeteer click OK`);
        } catch (clickErr) {
          // 폴백: evaluate에서 다양한 이벤트 디스패치
          console.log(`[worker] ${orderNo}: puppeteer click 실패 (${clickErr.message}), evaluate 폴백`);
          await page.evaluate((idx) => {
            const el = document.getElementById(`mf_wfm_contents_gen_benefitsList_${idx}_lbx_order_id`);
            if (!el) return;
            // mousedown → mouseup → click 시퀀스
            ['mousedown', 'mouseup', 'click'].forEach(type => {
              el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
          }, i);
        }
        await sleep(3000);

        // ── 상세 팝업/패널 텍스트 추출 ──
        const detail = await page.evaluate(() => {
          // 팝업/레이어 요소에서 텍스트 추출 (body 전체보다 정확)
          const popups = document.querySelectorAll(
            '[id*="popup"], [id*="layer"], [id*="Pop"], [id*="detail"], ' +
            '[class*="popup"], [class*="layer"], [class*="modal"], [class*="detail"]'
          );
          let popupText = '';
          for (const p of popups) {
            if (p.offsetHeight > 100 && p.innerText.length > 50) {
              popupText = p.innerText;
              break;
            }
          }
          const text = popupText || document.body.innerText;

          function parseAmt(label) {
            // label 뒤에 비숫자 문자들(최대 20자) + 금액 + 원
            const re = new RegExp(label + '[^\\d\\-]{0,20}(-?[\\d,]+)\\s*원');
            const m = text.match(re);
            return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
          }

          return {
            discount: parseAmt('할인금액'),
            deliveryFee: parseAmt('배달비'),
            storeDeliveryFee: parseAmt('가게배달비'),
            totalPayment: parseAmt('총 결제 금액') || parseAmt('총결제금액') || parseAmt('총 결제금액'),
            couponDiscount: parseAmt('할인쿠폰'),
            hasPopup: popupText.length > 0,
            textLen: text.length,
            textPreview: text.substring(0, 200),
          };
        });

        console.log(`[worker] ${orderNo}: popup=${detail.hasPopup}(${detail.textLen}자), 할인=${detail.discount}, 배달비=${detail.deliveryFee}, 결제=${detail.totalPayment}`);
        if (!detail.hasPopup) {
          console.log(`[worker] ${orderNo}: 미리보기: ${detail.textPreview}`);
        }

        if (detail.discount !== null || detail.totalPayment !== null || detail.deliveryFee !== null) {
          orderMap[orderNo].discount = String(detail.discount || 0);
          orderMap[orderNo].deliveryFee = String(detail.deliveryFee || detail.storeDeliveryFee || 0);
          orderMap[orderNo].totalPayment = String(detail.totalPayment || 0);
          processed++;
        }

        // ── 팝업 닫기 ──
        await page.evaluate(() => {
          // 방법 1: 확인/닫기 버튼
          const btns = Array.from(document.querySelectorAll('button, a, span, img'));
          const closeBtn = btns.find(b => {
            const t = (b.innerText || b.alt || '').trim();
            return t === '확인' || t === '닫기' || t === 'X' || t === '×' ||
              (b.className && b.className.includes('close'));
          });
          if (closeBtn) { closeBtn.click(); return; }
          // 방법 2: ESC 키
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        });
        await sleep(1500);

        // 팝업이 안 닫혔으면 한번 더 시도
        const stillOpen = await page.evaluate(() => {
          const popups = document.querySelectorAll('[id*="popup"], [id*="layer"], [id*="Pop"], [class*="popup"], [class*="modal"]');
          for (const p of popups) { if (p.offsetHeight > 100) return true; }
          return false;
        });
        if (stillOpen) {
          await page.keyboard.press('Escape');
          await sleep(1000);
        }

      } catch (err) {
        console.error(`[worker] 상세 추출 실패 (pg ${pg}, row ${i}):`, err.message);
      }
    }

    // 다음 페이지
    const nextPage = pg + 1;
    const hasNext = await page.evaluate((np) => {
      const paging = document.querySelector('[id*="pgl_pageList"]');
      if (!paging) return false;
      const labels = paging.querySelectorAll('[class*="pageList_li_label"], [class*="pageList_control_label"]');
      for (const el of labels) {
        if (el.innerText.trim() === String(np)) { el.click(); return true; }
      }
      return false;
    }, nextPage);

    if (!hasNext) break;
    await sleep(2000);
  }

  console.log(`[worker] 상세정보 추출 완료: ${processed}건`);
}

// ═══════════════════════════════════════════════════════════
// v2: 정산 상세 추출 (requestQryCalculateDetail API 인터셉트)
// ═══════════════════════════════════════════════════════════

async function extractSettlement(page, targetDate) {
  console.log('[worker] 정산 메뉴 클릭');

  // 정산 메뉴 네비게이션
  await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const settlementLink = links.find(a => {
      const text = a.innerText.trim();
      return text === '정산' || text === '정산내역' || text === '정산상세';
    });
    if (settlementLink) settlementLink.click();
  });
  await sleep(5000);

  // API 응답 인터셉트 설정
  let capturedSettlement = null;
  let resolveCapture;
  const capturePromise = new Promise(r => { resolveCapture = r; });

  const responseHandler = async (response) => {
    const url = response.url();
    if (!url.includes('requestQryCalculateDetail') && !url.includes('requestQryCalculate')) return;
    if (response.status() !== 200) return;

    try {
      const text = await response.text();
      const json = JSON.parse(text);
      console.log('[worker] 정산 API 응답 캡처:', url.substring(url.lastIndexOf('/') + 1));
      capturedSettlement = json;
      resolveCapture(json);
    } catch {}
  };
  page.on('response', responseHandler);

  // 정산상세 페이지로 이동 시도
  // WebSquare SPA 해시 네비게이션
  const currentUrl = page.url();
  if (!currentUrl.includes('SH0602') && !currentUrl.includes('SH0601')) {
    // 사이드바에서 정산 > 정산상세 클릭
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, span, div'));
      for (const el of links) {
        const text = el.innerText?.trim();
        if (text === '정산상세' || text === '정산 상세') {
          el.click();
          return true;
        }
      }
      // 해시 직접 변경
      location.hash = '#SH0601';
      return false;
    });
    await sleep(5000);
  }

  // 날짜 필터 설정 (targetDate로)
  if (targetDate) {
    console.log(`[worker] 정산 날짜 필터: ${targetDate}`);
    const formattedDate = targetDate.replace(/-/g, '');

    await page.evaluate((dateStr) => {
      // 시작일/종료일 input 찾기
      const inputs = document.querySelectorAll('input[type="text"]');
      for (const inp of inputs) {
        const id = inp.id || '';
        if (id.includes('strt_dt') || id.includes('start_dt') || id.includes('fr_dt')) {
          inp.value = dateStr;
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (id.includes('end_dt') || id.includes('to_dt')) {
          inp.value = dateStr;
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // 조회 버튼 클릭
      const btns = document.querySelectorAll('button, a');
      for (const btn of btns) {
        const text = btn.innerText?.trim();
        if (text === '조회' || text === '검색') {
          btn.click();
          return true;
        }
      }
      return false;
    }, formattedDate);

    await sleep(5000);
  }

  // API 응답 대기 (최대 15초)
  const timeout = setTimeout(() => resolveCapture(null), 15000);
  await capturePromise;
  clearTimeout(timeout);
  page.off('response', responseHandler);

  if (!capturedSettlement) {
    console.log('[worker] 정산 API 캡처 실패 — DOM에서 추출 시도');

    // DOM에서 정산 데이터 추출 폴백
    const domSettlement = await page.evaluate(() => {
      const text = document.body.innerText;
      const parse = (label) => {
        const m = text.match(new RegExp(label + '\\s*([\\-\\d,]+)'));
        return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
      };

      return {
        ordAmt: parse('주문금액') || parse('주문결제'),
        delvfeeAmt: parse('배달비수익') || parse('배달비\\s*수익'),
        ordMediAmt: Math.abs(parse('주문중개이용료') || parse('중개이용료')),
        setlAjstAmt: Math.abs(parse('결제정산이용료') || parse('정산이용료')),
        ownerCoupAmt: parse('사장님쿠폰') || 0,
        patstosCoupAmt: parse('사장님쿠폰차감') || parse('쿠폰차감') || 0,
        plfmCoupAmt: parse('플랫폼쿠폰') || parse('플랫폼보전') || 0,
        delvAgntAmt: parse('배달대행') || 0,
        paynAmt: parse('입금') || parse('입금예정') || parse('입금금액') || 0,
        source: 'dom',
      };
    });

    return {
      success: domSettlement.paynAmt > 0 || domSettlement.ordAmt > 0,
      site: 'ddangyoyo',
      pageType: 'settlement',
      settlement: domSettlement,
    };
  }

  // API 응답 파싱
  const dltAjst = capturedSettlement.dlt_ajst || capturedSettlement.data?.dlt_ajst || {};
  const settlement = {
    ordAmt: parseInt(dltAjst.ord_amt || 0, 10),
    delvfeeAmt: parseInt(dltAjst.delvfee_amt || 0, 10),
    ordMediAmt: Math.abs(parseInt(dltAjst.ord_medi_amt || 0, 10)),
    setlAjstAmt: Math.abs(parseInt(dltAjst.setl_ajst_amt || 0, 10)),
    ownerCoupAmt: parseInt(dltAjst.owner_coup_amt || 0, 10),
    patstosCoupAmt: parseInt(dltAjst.patsto_coup_amt || 0, 10),
    plfmCoupAmt: parseInt(dltAjst.plfm_coup_amt || 0, 10),
    delvAgntAmt: parseInt(dltAjst.delv_agnt_amt || 0, 10),
    paynAmt: parseInt(dltAjst.payn_amt || 0, 10),
    // 결제수단별 금액
    paymentBreakdown: {
      locpay: parseInt(dltAjst.locpay_amt || 0, 10),
      kakaopay: parseInt(dltAjst.kakaopay_amt || 0, 10),
      naverpay: parseInt(dltAjst.naverpay_amt || 0, 10),
      credit: parseInt(dltAjst.credit_amt || 0, 10),
      ddangyo: parseInt(dltAjst.ddangyo_amt || 0, 10),
      account: parseInt(dltAjst.acc_amt || 0, 10),
      zero: parseInt(dltAjst.zero_amt || 0, 10),
      point: parseInt(dltAjst.point_amt || 0, 10),
    },
    source: 'api',
  };

  console.log('[worker] 정산 데이터:', JSON.stringify(settlement));

  return {
    success: true,
    site: 'ddangyoyo',
    pageType: 'settlement',
    settlement,
    rawData: capturedSettlement,
  };
}

// ═══════════════════════════════════════════════════════════
// 매출지킴이 API 전송
// ═══════════════════════════════════════════════════════════

async function sendToSalesKeeper(config, targetDate, platformStoreId, brandName, orderCount, settlement, orders) {
  const { apiBaseUrl, sessionToken, salesKeeperStoreId } = config;
  if (!apiBaseUrl || !sessionToken || !salesKeeperStoreId) {
    console.log('[worker] 매출지킴이 전송 설정 없음 — 건너뜀');
    return null;
  }

  const url = `${apiBaseUrl}/api/stores/${salesKeeperStoreId}/crawler/ddangyoyo`;
  console.log(`[worker] 매출지킴이 전송: ${url}`);

  const http = require('http');
  const https = require('https');
  const { URL } = require('url');

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    // 주문 데이터 변환
    const apiOrders = (orders || []).map(o => ({
      orderId: o.orderId || o.orderNo,
      orderedAt: o.orderedAt || (o.date ? new Date(o.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')).toISOString() : new Date().toISOString()),
      orderType: o.orderType || o.method || '',
      menuSummary: o.menuSummary || o.orderSummary || '',
      menuAmount: o.menuAmount || parseInt((o.amount || '0').replace(/,/g, ''), 10),
      paymentMethod: o.method || '',
      storeDiscount: o.discount != null ? parseInt(String(o.discount).replace(/,/g, ''), 10) : 0,
      deliveryCost: o.deliveryFee != null ? parseInt(String(o.deliveryFee).replace(/,/g, ''), 10) : 0,
      settlementAmount: o.settlementAmount || parseInt((o.totalPayment || '0').replace(/,/g, ''), 10),
    }));

    const body = JSON.stringify({
      targetDate,
      platformStoreId,
      brandName,
      orderCount,
      settlement,
      orders: apiOrders,
    });

    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `session-token=${sessionToken}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log(`[worker] 매출지킴이 응답: ${res.statusCode}`, JSON.stringify(json));
          resolve({ statusCode: res.statusCode, body: json });
        } catch {
          console.error(`[worker] 매출지킴이 응답 파싱 실패: ${data.substring(0, 500)}`);
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });

    req.on('error', (err) => {
      console.error('[worker] 매출지킴이 전송 실패:', err.message);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════
// v4 backfill: API body 직접 수정 방식 (POC 검증 완료)
//
// 1. 로그인 후 주문내역 페이지 이동
// 2. API 인터셉트로 requestQryOrderList body 캡처
// 3. 매장 드롭다운(gen_patstoSelector)에서 매장 목록 추출
// 4. 매장별로:
//    a. API body의 patsto_no 설정
//    b. setl_dt_st=2달전, setl_dt_ed=어제, page_row_cnt=500
//    c. 수정된 body로 직접 fetch
//    d. 날짜별 그룹핑 → 매출지킴이 전송
// ═══════════════════════════════════════════════════════════

async function runBackfill(page, config) {
  const { brandName, salesKeeper } = config;
  const dates = getBackfillDateRange();
  console.log(`[worker-backfill] 기간: ${dates.startDate} ~ ${dates.endDate} (D-1 기준 2달)`);

  send('status', { status: 'crawling', page: 'orders', mode: 'backfill' });

  // ── Step 1: 주문내역 페이지 이동 + API 인터셉트 설치 ──
  console.log('[worker-backfill] Step 1: 주문내역 페이지 이동');

  // 인터셉트 스크립트 설치
  await page.evaluate(INTERCEPT_SCRIPT);
  await sleep(1000);

  // 주문내역 메뉴 클릭
  await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    links.find(a => a.innerText.trim() === '주문내역')?.click();
  });
  await sleep(8000);

  // SPA 네비게이션 후 인터셉트 재설치
  await page.evaluate(INTERCEPT_SCRIPT);
  await sleep(3000);

  // ── Step 2: API 패턴 캡처 (requestQryOrderList) ──
  console.log('[worker-backfill] Step 2: API 패턴 캡처');

  let apiInfo = await page.evaluate(() => {
    const c = window._ddCaptures || [];
    for (let i = c.length - 1; i >= 0; i--) {
      if (c[i].url.includes('requestQryOrderList') || (c[i].data && c[i].data.dlt_result)) {
        return {
          url: c[i].url,
          method: c[i].method || 'GET',
          body: c[i].body || null,
          headers: c[i].headers || {},
          contentType: c[i].contentType || null,
          resultCount: (c[i].data?.dlt_result || []).length,
        };
      }
    }
    return null;
  });

  // 캡처 안 됐으면 조회 버튼 클릭 시도
  if (!apiInfo) {
    console.log('[worker-backfill] 초기 캡처 없음 -> 조회 버튼 클릭');
    await page.evaluate(() => {
      window._ddIntercepted = false;
      window._ddCaptures = [];
    });
    await page.evaluate(INTERCEPT_SCRIPT);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
      const searchBtn = btns.find(b => (b.innerText || b.value || '').trim() === '조회');
      if (searchBtn) searchBtn.click();
    });
    await sleep(5000);

    apiInfo = await page.evaluate(() => {
      const c = window._ddCaptures || [];
      for (let i = c.length - 1; i >= 0; i--) {
        if (c[i].url.includes('requestQryOrderList') || (c[i].data && c[i].data.dlt_result)) {
          return {
            url: c[i].url,
            method: c[i].method || 'GET',
            body: c[i].body || null,
            headers: c[i].headers || {},
            contentType: c[i].contentType || null,
            resultCount: (c[i].data?.dlt_result || []).length,
          };
        }
      }
      return null;
    });
  }

  if (!apiInfo) {
    const allUrls = await page.evaluate(() => {
      return (window._ddCaptures || []).map(c => ({ url: (c.url || '').substring(0, 200), method: c.method }));
    });
    console.error('[worker-backfill] API 캡처 실패. 캡처된 URL:', JSON.stringify(allUrls));
    send('error', { error: '땡겨요 API 패턴 캡처 실패 (requestQryOrderList)' });
    return null;
  }

  console.log(`[worker-backfill] API URL: ${apiInfo.url}`);
  console.log(`[worker-backfill] Body preview: ${(apiInfo.body || '').substring(0, 300)}`);

  // API body 파싱
  let baseBody;
  try { baseBody = JSON.parse(apiInfo.body); } catch { baseBody = null; }

  if (!baseBody || !baseBody.dma_para) {
    console.error('[worker-backfill] dma_para 구조 파싱 실패');
    send('error', { error: '땡겨요 API body 구조 파싱 실패 (dma_para 없음)' });
    return null;
  }

  const apiHeaders = Object.keys(apiInfo.headers).length > 0
    ? apiInfo.headers
    : { 'Content-Type': 'application/json; charset=UTF-8' };

  // ── Step 3: 매장 목록 추출 (gen_patstoSelector) ──
  console.log('[worker-backfill] Step 3: 매장 목록 추출');

  // 드롭다운 클릭하여 매장 목록 열기
  await page.evaluate(() => {
    const allEls = Array.from(document.querySelectorAll('*'));
    for (const el of allEls) {
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim())
        .join('');
      if (directText.includes('가게전체') || directText.includes('가게 전체')) {
        const clickTarget = el.closest('button, a, [role="combobox"], [role="listbox"], select, .selectbox') || el;
        clickTarget.click();
        return;
      }
    }
    // input[value*="가게전체"] 근처의 selectbox 클릭
    const inputs = Array.from(document.querySelectorAll('input'));
    for (const inp of inputs) {
      if ((inp.value || '').includes('가게전체') || (inp.value || '').includes('가게 전체')) {
        const parent = inp.closest('[class*="select"], [class*="combo"]') || inp.parentElement;
        if (parent) parent.click();
        return;
      }
    }
  });
  await sleep(2000);

  // gen_patstoSelector 패턴으로 매장 추출
  let storeList = await page.evaluate(() => {
    const stores = [];

    // 1) gen_patstoSelector 패턴 (WebSquare)
    let idx = 0;
    while (true) {
      const el = document.getElementById('mf_wfm_contents_gen_patstoSelector_' + idx + '_tbx_patstoItem');
      if (!el) break;
      const name = el.textContent.trim();
      if (name && !name.includes('가게전체') && !name.includes('가게 전체')) {
        stores.push({ name, selectorIndex: idx });
      }
      idx++;
    }
    if (stores.length > 0) return { source: 'ws-patstoSelector', stores };

    // 2) select 요소에서 옵션 추출
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const opts = Array.from(sel.options);
      const hasAll = opts.some(o => o.textContent.trim().includes('가게전체'));
      if (hasAll) {
        for (const o of opts) {
          const name = o.textContent.trim();
          if (!name.includes('가게전체') && !name.includes('가게 전체') && name) {
            stores.push({ name, value: o.value });
          }
        }
        return { source: 'select', selectId: sel.id, stores };
      }
    }

    // 3) WebSquare selectbox 리스트
    const wsLists = Array.from(document.querySelectorAll('[class*="w2selectbox"] li, [class*="selectbox_list"] li, [id*="patsto"] li'));
    for (const li of wsLists) {
      const text = li.textContent.trim();
      if (text && !text.includes('가게전체') && !text.includes('가게 전체') && text.length < 50 && text.length > 1) {
        if (!stores.some(s => s.name === text)) {
          stores.push({ name: text, element: li.tagName + '#' + li.id });
        }
      }
    }
    if (stores.length > 0) return { source: 'ws-list', stores };

    return { source: 'not-found', stores: [] };
  });

  console.log(`[worker-backfill] 매장 목록 추출: ${storeList.source}, ${storeList.stores.length}개`);

  // 팝업 닫기
  await page.evaluate(() => {
    const closeBtn = Array.from(document.querySelectorAll('button, a, span')).find(el => {
      const t = el.textContent.trim();
      return t === 'X' || t === '닫기' || el.className?.includes('close');
    });
    if (closeBtn) closeBtn.click();
    document.body.click();
  });
  await sleep(1000);

  // 매장 목록이 비어있으면 API로 가게전체 조회 후 주문 데이터에서 매장 추출
  if (storeList.stores.length === 0) {
    console.log('[worker-backfill] UI에서 매장 목록 추출 실패, API 기반 매장 탐색...');

    const testBody = JSON.parse(JSON.stringify(baseBody));
    testBody.dma_para.setl_dt_st = dates.startDateCompact;
    testBody.dma_para.setl_dt_ed = dates.endDateCompact;
    testBody.dma_para.page_row_cnt = 500;
    testBody.dma_para.page_num = 1;
    testBody.dma_para.patsto_no = '0000000';
    testBody.dma_para.patsto_nm = '가게전체';

    const testBodyStr = JSON.stringify(testBody);
    const testResult = await page.evaluate(async (apiUrl, headers, bodyStr) => {
      try {
        const resp = await fetch(apiUrl, {
          method: 'POST',
          headers: headers,
          credentials: 'include',
          body: bodyStr,
        });
        const data = await resp.json();
        const orders = data.dlt_result || [];
        const storeMap = {};
        for (const o of orders) {
          const no = o.patsto_no || '';
          const nm = o.patsto_nm || o.store_nm || '';
          if (no && no !== '0000000') {
            storeMap[no] = nm || no;
          }
        }
        return { success: true, totalOrders: orders.length, storeMap };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }, apiInfo.url, apiHeaders, testBodyStr);

    console.log(`[worker-backfill] 가게전체 조회: ${testResult.success ? testResult.totalOrders + '건' : testResult.error}`);

    if (testResult.success && Object.keys(testResult.storeMap).length > 0) {
      storeList = {
        source: 'api-orders',
        stores: Object.entries(testResult.storeMap).map(([no, nm]) => ({ name: nm, value: no })),
      };
    } else {
      // 마지막 수단: rpsnt_patsto_no를 개별 매장으로 사용
      const rpsntNo = baseBody.dma_para.rpsnt_patsto_no;
      console.log(`[worker-backfill] 대표 매장 번호로 fallback: ${rpsntNo}`);
      storeList = {
        source: 'fallback-rpsnt',
        stores: [{ name: brandName || 'unknown', value: rpsntNo }],
      };
    }
  }

  console.log(`[worker-backfill] 총 ${storeList.stores.length}개 매장:`);
  for (const s of storeList.stores) {
    console.log(`[worker-backfill]   - ${s.name} (${s.value || 'no-id'})`);
  }

  // ── Step 4: 매장별 주문 수집 (API body 직접 수정) ──
  console.log('[worker-backfill] Step 4: 매장별 주문 수집');

  const allStoreResults = {};

  for (let si = 0; si < storeList.stores.length; si++) {
    const store = storeList.stores[si];
    console.log(`[worker-backfill] [${si + 1}/${storeList.stores.length}] ${store.name}`);

    let storePatNo = store.value || null;

    // selectorIndex가 있으면 UI 클릭으로 매장 선택 → API 캡처하여 patsto_no 확인
    if (store.selectorIndex !== undefined && !storePatNo) {
      console.log(`[worker-backfill] 매장 선택 UI 클릭 (selectorIndex: ${store.selectorIndex})...`);

      // 캡처 초기화
      await page.evaluate(() => {
        window._ddIntercepted = false;
        window._ddCaptures = [];
      });
      await page.evaluate(INTERCEPT_SCRIPT);

      // 드롭다운 열기
      await page.evaluate(() => {
        const trigger = document.getElementById('mf_wfm_contents_tbx_selectedPatstoItem')
          || document.getElementById('mf_wfm_contents_wq_uuid_499');
        if (trigger) {
          const parent = trigger.closest('a, button, div[class*="pop_call"]') || trigger;
          parent.click();
        }
      });
      await sleep(1000);

      // 매장 항목 클릭
      const sIdx = store.selectorIndex;
      await page.evaluate((idx) => {
        const clickLine = document.getElementById('mf_wfm_contents_gen_patstoSelector_' + idx + '_grp_clickLine');
        if (clickLine) { clickLine.click(); return; }
        const tbx = document.getElementById('mf_wfm_contents_gen_patstoSelector_' + idx + '_tbx_patstoItem');
        if (tbx) {
          const parent = tbx.closest('a, li, div') || tbx;
          parent.click();
        }
      }, sIdx);
      await sleep(3000);

      // 매장 선택 후 API 캡처에서 patsto_no 추출
      const capturedStoreApi = await page.evaluate(() => {
        const c = window._ddCaptures || [];
        for (let i = c.length - 1; i >= 0; i--) {
          if (c[i].url.includes('requestQryOrderList') && c[i].body) {
            try {
              const b = JSON.parse(c[i].body);
              if (b.dma_para && b.dma_para.patsto_no !== '0000000') {
                return { patsto_no: b.dma_para.patsto_no, patsto_nm: b.dma_para.patsto_nm };
              }
            } catch {}
          }
        }
        return null;
      });

      if (capturedStoreApi) {
        storePatNo = capturedStoreApi.patsto_no;
        console.log(`[worker-backfill] patsto_no 캡처: ${storePatNo} (${capturedStoreApi.patsto_nm})`);
      } else {
        storePatNo = baseBody.dma_para.rpsnt_patsto_no;
        console.log(`[worker-backfill] 자동 캡처 없음, rpsnt_patsto_no 사용: ${storePatNo}`);
      }
    }

    // API body 수정: 매장 + 2달 날짜 + 500건
    const reqBody = JSON.parse(JSON.stringify(baseBody));
    reqBody.dma_para.setl_dt_st = dates.startDateCompact;
    reqBody.dma_para.setl_dt_ed = dates.endDateCompact;
    reqBody.dma_para.page_row_cnt = 500;
    reqBody.dma_para.page_num = 1;
    if (storePatNo) {
      reqBody.dma_para.patsto_no = storePatNo;
    }
    reqBody.dma_para.patsto_nm = store.name;
    store.value = storePatNo || store.value || '';

    console.log(`[worker-backfill] 요청: patsto_no=${reqBody.dma_para.patsto_no}, ${dates.startDateCompact}~${dates.endDateCompact}`);

    const reqBodyStr = JSON.stringify(reqBody);
    const result = await page.evaluate(async (apiUrl, headers, bodyStr) => {
      try {
        const resp = await fetch(apiUrl, {
          method: 'POST',
          headers: headers,
          credentials: 'include',
          body: bodyStr,
        });
        const data = await resp.json();
        return {
          success: true,
          orders: data.dlt_result || [],
          summary: data.dlt_result_single || {},
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }, apiInfo.url, apiHeaders, reqBodyStr);

    if (!result.success) {
      console.error(`[worker-backfill] API 호출 실패: ${result.error}`);
      continue;
    }

    let allOrders = result.orders;
    const totalExpected = result.summary.tot_cnt || allOrders.length;
    console.log(`[worker-backfill] 응답: ${allOrders.length}건 / 총 ${totalExpected}건`);

    // 페이지네이션
    let pageNum = 2;
    while (allOrders.length < totalExpected && pageNum <= 20) {
      console.log(`[worker-backfill] 페이지 ${pageNum} 추가 조회... (${allOrders.length}/${totalExpected})`);
      reqBody.dma_para.page_num = pageNum;
      const pageBodyStr = JSON.stringify(reqBody);

      const pageResult = await page.evaluate(async (apiUrl, headers, bodyStr) => {
        try {
          const resp = await fetch(apiUrl, {
            method: 'POST',
            headers: headers,
            credentials: 'include',
            body: bodyStr,
          });
          const data = await resp.json();
          return { success: true, orders: data.dlt_result || [] };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }, apiInfo.url, apiHeaders, pageBodyStr);

      if (!pageResult.success || pageResult.orders.length === 0) break;

      const existingIds = new Set(allOrders.map(o => o.ord_id || o.ord_no));
      const uniqueNew = pageResult.orders.filter(o => !existingIds.has(o.ord_id || o.ord_no));
      if (uniqueNew.length === 0) break;

      allOrders = allOrders.concat(uniqueNew);
      console.log(`[worker-backfill]   +${uniqueNew.length}건 (누적 ${allOrders.length}건)`);
      pageNum++;
      await sleep(1000);
    }

    // 날짜별 그룹핑 (setl_dt 기준)
    const byDate = {};
    for (const order of allOrders) {
      const dt = order.setl_dt || 'unknown';
      if (!byDate[dt]) byDate[dt] = [];
      byDate[dt].push(order);
    }

    const dailySummaries = {};
    const sortedDates = Object.keys(byDate).sort();

    for (const dt of sortedDates) {
      const dayOrders = byDate[dt];
      const mapped = dayOrders.map(o => mapToSalesOrder(o, store.name));
      let daySale = 0, daySettl = 0;
      for (const o of mapped) {
        daySale += o.menuAmount;
        daySettl += o.settlementAmount;
      }
      const dateFormatted = dt.length === 8
        ? `${dt.substring(0, 4)}-${dt.substring(4, 6)}-${dt.substring(6, 8)}`
        : dt;
      dailySummaries[dateFormatted] = {
        date: dateFormatted,
        dateCompact: dt,
        orderCount: dayOrders.length,
        totalSaleAmount: daySale,
        totalSettlementAmount: daySettl,
        totalFee: daySale - daySettl,
        orders: mapped,
      };
      console.log(`[worker-backfill]   ${dateFormatted}: ${dayOrders.length}건 | 매출:${daySale.toLocaleString()} | 정산:${daySettl.toLocaleString()}`);
    }

    // 매장 합계
    let storeSale = 0, storeSettl = 0;
    for (const ds of Object.values(dailySummaries)) {
      storeSale += ds.totalSaleAmount;
      storeSettl += ds.totalSettlementAmount;
    }

    allStoreResults[store.name] = {
      storeName: store.name,
      storeId: store.value || '',
      dateRange: { start: dates.startDate, end: dates.endDate },
      totalDays: sortedDates.length,
      totalOrders: allOrders.length,
      totalSaleAmount: storeSale,
      totalSettlementAmount: storeSettl,
      totalFee: storeSale - storeSettl,
      dailySummaries,
    };

    console.log(`[worker-backfill] 매장 합계: ${sortedDates.length}일 / ${allOrders.length}건 / 매출:${storeSale.toLocaleString()} / 정산:${storeSettl.toLocaleString()}`);

    // 매장 간 대기
    if (si < storeList.stores.length - 1) await sleep(2000);
  }

  // ── Step 5: 매출지킴이 전송 (날짜별) ──
  if (salesKeeper) {
    console.log('[worker-backfill] Step 5: 매출지킴이 전송');

    for (const [storeName, storeResult] of Object.entries(allStoreResults)) {
      console.log(`[worker-backfill] ${storeName} 전송 시작 (${Object.keys(storeResult.dailySummaries).length}일)`);

      for (const [date, daySummary] of Object.entries(storeResult.dailySummaries)) {
        // settlement 추정 생성 (orders의 sale_amt/tot_setl_amt 합산)
        const settlement = {
          ordAmt: daySummary.totalSaleAmount,
          paynAmt: daySummary.totalSettlementAmount,
          delvfeeAmt: 0,
          ordMediAmt: 0,
          setlAjstAmt: 0,
          ownerCoupAmt: 0,
          patstosCoupAmt: 0,
          plfmCoupAmt: 0,
          delvAgntAmt: 0,
        };

        try {
          await sendToSalesKeeper(
            salesKeeper,
            date,
            storeResult.storeId,
            storeName,
            daySummary.orderCount,
            settlement,
            daySummary.orders,
          );
          console.log(`[worker-backfill]   ${date}: ${daySummary.orderCount}건 전송 완료`);
        } catch (err) {
          console.error(`[worker-backfill]   ${date} 전송 실패:`, err.message);
        }
      }
    }
  }

  // 결과 IPC 전송
  let grandSale = 0, grandSettl = 0, grandOrders = 0;
  for (const sr of Object.values(allStoreResults)) {
    grandSale += sr.totalSaleAmount;
    grandSettl += sr.totalSettlementAmount;
    grandOrders += sr.totalOrders;
  }

  const backfillResult = {
    success: true,
    site: 'ddangyoyo',
    mode: 'backfill',
    dateRange: { start: dates.startDate, end: dates.endDate },
    storeCount: Object.keys(allStoreResults).length,
    totalOrders: grandOrders,
    totalSaleAmount: grandSale,
    totalSettlementAmount: grandSettl,
    totalFee: grandSale - grandSettl,
    stores: allStoreResults,
  };

  console.log(`[worker-backfill] 완료: ${Object.keys(allStoreResults).length}매장 / ${grandOrders}건 / 매출:${grandSale.toLocaleString()} / 정산:${grandSettl.toLocaleString()}`);

  send('result', { pageKey: 'orders', result: backfillResult });
  if (salesKeeper) {
    send('result', { pageKey: 'salesKeeper', result: { mode: 'backfill', storeCount: Object.keys(allStoreResults).length, totalOrders: grandOrders } });
  }

  return backfillResult;
}

// ═══════════════════════════════════════════════════════════
// 메인 실행
// ═══════════════════════════════════════════════════════════

async function run(config) {
  const { id, pw, targetDate, brandName, salesKeeper, mode } = config;
  const isBackfill = mode === 'backfill';

  const crawlDate = targetDate || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  })();

  if (isBackfill) {
    console.log('[ddangyoyo-worker] backfill 모드 시작 (D-1 기준 2달)');
  }

  const chromePath = findChromePath();
  if (!chromePath) {
    send('error', { error: '시스템에 Chrome이 설치되어 있지 않습니다.' });
    process.exit(1);
  }
  console.log('[worker] Chrome 경로:', chromePath);

  const puppeteer = require('rebrowser-puppeteer-core');

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--lang=ko-KR',
      '--window-size=1400,900',
    ],
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await browser.newPage();
  console.log('[worker] 브라우저 시작됨');

  // ── 로그인 ──
  send('status', { status: 'logging_in' });
  await page.goto('https://boss.ddangyo.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);

  const hasForm = await page.evaluate(() => ({
    hasId: !!document.getElementById('mf_ibx_mbrId'),
    hasPw: !!document.getElementById('mf_sct_pwd'),
  }));

  if (!hasForm.hasId || !hasForm.hasPw) {
    send('error', { error: '로그인 폼을 찾을 수 없습니다' });
    await browser.close();
    process.exit(1);
  }

  console.log('[worker] 아이디/비밀번호 입력...');
  await page.click('#mf_ibx_mbrId', { clickCount: 3 });
  await page.type('#mf_ibx_mbrId', id, { delay: 80 });
  await sleep(300);
  await page.click('#mf_sct_pwd', { clickCount: 3 });
  await page.type('#mf_sct_pwd', pw, { delay: 80 });
  await sleep(500);

  console.log('[worker] 로그인 버튼 클릭...');
  await page.click('#mf_btn_webLogin');
  await sleep(10000);

  const afterUrl = page.url();
  console.log('[worker] 로그인 후 URL:', afterUrl);

  const stillLogin = await page.evaluate(() => {
    const idField = document.getElementById('mf_ibx_mbrId');
    return idField && idField.offsetHeight > 0;
  });

  if (stillLogin) {
    send('error', { error: '땡겨요 로그인 실패: 아이디 또는 비밀번호를 확인해주세요' });
    await browser.close();
    process.exit(1);
  }

  console.log('[worker] 로그인 성공!');

  // ── backfill 모드: POC 검증된 API body 직접 수정 방식 ──
  if (isBackfill) {
    try {
      await runBackfill(page, config);
    } catch (err) {
      console.error('[worker-backfill] 에러:', err.message, err.stack);
      send('error', { error: `backfill 실패: ${err.message}` });
    }

    send('done', {});
    await browser.close();
    process.exit(0);
    return; // early return for backfill
  }

  // ── 일반 모드: 주문내역 크롤링 (기존 DOM 방식 유지) ──
  let orderResult = null;
  send('status', { status: 'crawling', page: 'orders' });
  try {
    orderResult = await extractOrders(page);

    // 일반 모드: 날짜 필터링 (대상일자 주문만)
    if (orderResult?.orders?.length > 0 && crawlDate) {
      const dateStr = crawlDate.replace(/-/g, '.');
      const before = orderResult.orders.length;
      orderResult.orders = orderResult.orders.filter(o => {
        // date 형식: "2026.03.12(목)18:54:50"
        return (o.date || '').includes(dateStr);
      });
      console.log(`[worker] 날짜 필터(${crawlDate}): ${before}건 → ${orderResult.orders.length}건`);
      // 요약 업데이트
      if (orderResult.summary) {
        orderResult.summary['주문수'] = String(orderResult.orders.length);
        const totalAmt = orderResult.orders.reduce((s, o) => s + (parseInt(String(o.amount || '0').replace(/,/g, ''), 10) || 0), 0);
        orderResult.summary['결제금액'] = totalAmt.toLocaleString();
      }
    }

    // 주문별 상세정보 추출 (할인금액, 배달비, 총결제금액)
    if (orderResult?.orders?.length > 0) {
      send('status', { status: 'crawling', page: 'orderDetails' });
      await extractOrderDetails(page, orderResult.orders);
    }

    send('result', { pageKey: 'orders', result: orderResult });
  } catch (err) {
    console.error('[worker] 주문 추출 실패:', err);
    send('page-error', { pageKey: 'orders', error: err.message });
  }

  // ── 매출지킴이 전송 (일반 모드) ──
  if (salesKeeper && orderResult?.success) {
    try {
      // 가맹점번호를 platformStoreId로 사용
      const platformStoreId = await page.evaluate(() => {
        const bodyText = document.body.innerText;
        const m = bodyText.match(/가맹점(?:번호|코드)?\s*[:\s]*(\d+)/);
        return m ? m[1] : '';
      }) || '1237016'; // 폴백: 고기왕김치찜 가맹점번호

      // 일반 모드: 단일 날짜 전송
      const sendResult = await sendToSalesKeeper(
        salesKeeper,
        crawlDate,
        platformStoreId,
        brandName || '',
        orderResult?.orders?.length || 0,
        null,
        orderResult?.orders || [],
      );
      send('result', { pageKey: 'salesKeeper', result: sendResult });
    } catch (sendErr) {
      console.error('[worker] 매출지킴이 전송 실패:', sendErr.message);
      send('page-error', { pageKey: 'salesKeeper', error: sendErr.message });
    }
  }

  send('done', {});
  await browser.close();
  process.exit(0);
}

process.on('message', (msg) => {
  if (msg.type === 'start') {
    const opts = msg.config || {};
    // mode 전달 (backfill 등)
    if (msg.opts?.mode) opts.mode = msg.opts.mode;
    run(opts).catch((err) => {
      console.error('[worker] 치명적 오류:', err);
      send('error', { error: err.message });
      process.exit(1);
    });
  }
});
