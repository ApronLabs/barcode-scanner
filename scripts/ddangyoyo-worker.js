// 땡겨요 크롤링 워커 - 별도 Node.js 프로세스에서 실행
// boss.ddangyo.com (WebSquare SPA)
//
// v2: 정산 데이터 수집 + 매출지킴이 전송
//     주문내역 + 정산상세(requestQryCalculateDetail) API 인터셉트
// v3: backfill 모드 — 시작일 캘린더 조작 + 날짜별 그룹핑 전송
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

// 주문내역 추출
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
      orderId: o.orderNo,
      orderedAt: o.date ? new Date(o.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')).toISOString() : new Date().toISOString(),
      orderType: o.method || '',
      menuSummary: o.orderSummary || '',
      menuAmount: parseInt((o.amount || '0').replace(/,/g, ''), 10),
      paymentMethod: o.method || '',
      storeDiscount: parseInt((o.discount || '0').replace(/,/g, ''), 10),
      deliveryCost: parseInt((o.deliveryFee || '0').replace(/,/g, ''), 10),
      settlementAmount: parseInt((o.totalPayment || '0').replace(/,/g, ''), 10),
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
// backfill: 주문내역 날짜 범위 설정 (시작일 캘린더 조작)
// ═══════════════════════════════════════════════════════════

async function setBackfillDateRange(page) {
  const startDateCompact = getDaysAgoCompact(90); // 90일 전
  const endDateCompact = getDaysAgoCompact(1);    // 어제
  const startDateIso = getDaysAgoIso(90);
  const endDateIso = getDaysAgoIso(1);
  console.log(`[ddangyoyo-worker] backfill 날짜 범위: ${startDateIso} ~ ${endDateIso}`);

  // 방법 1: Input 직접 값 설정 (기존 코드 패턴 활용)
  const inputSet = await page.evaluate((startDt, endDt) => {
    const inputs = document.querySelectorAll('input[type="text"]');
    let startFound = false;
    let endFound = false;
    for (const inp of inputs) {
      const id = inp.id || '';
      if (id.includes('strt_dt') || id.includes('start_dt') || id.includes('fr_dt')) {
        inp.value = startDt;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        startFound = true;
      }
      if (id.includes('end_dt') || id.includes('to_dt')) {
        inp.value = endDt;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        endFound = true;
      }
    }
    return { startFound, endFound };
  }, startDateCompact, endDateCompact);

  console.log(`[ddangyoyo-worker] Input 직접 설정: start=${inputSet.startFound}, end=${inputSet.endFound}`);

  // 방법 2: Input 설정이 안 되면 캘린더 UI 조작
  if (!inputSet.startFound) {
    console.log('[ddangyoyo-worker] Input 못 찾음 — 캘린더 UI 조작 시도');

    // 시작일 캘린더 아이콘 클릭
    const calOpened = await page.evaluate(() => {
      // 캘린더 아이콘/버튼 찾기 (시작일 쪽)
      const calBtns = document.querySelectorAll(
        '[id*="strt_dt"] ~ [class*="calendar"], ' +
        '[id*="strt_dt"] ~ button, ' +
        '[id*="strt_dt"] ~ img, ' +
        '[class*="calendar"][class*="start"], ' +
        'img[src*="calendar"], ' +
        'button[class*="cal"]'
      );
      if (calBtns.length > 0) {
        calBtns[0].click();
        return true;
      }
      // WebSquare 캘린더 아이콘 패턴
      const wsCalBtns = document.querySelectorAll('[id*="btn_cal"], [id*="calendar"], [class*="w2calendar"]');
      if (wsCalBtns.length > 0) {
        wsCalBtns[0].click();
        return true;
      }
      return false;
    });

    if (calOpened) {
      await sleep(1000);

      // 3개월 전으로 이동 (< 이전달 버튼 3번 클릭)
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => {
          const prevBtns = document.querySelectorAll(
            '[class*="prev"], [class*="Prev"], ' +
            'button[title*="이전"], a[title*="이전"]'
          );
          for (const btn of prevBtns) {
            if (btn.offsetHeight > 0) { btn.click(); return; }
          }
          // < 텍스트 패턴
          const allBtns = document.querySelectorAll('button, a, span');
          for (const btn of allBtns) {
            if (btn.innerText?.trim() === '<' || btn.innerText?.trim() === '◀') {
              btn.click();
              return;
            }
          }
        });
        await sleep(500);
      }

      // 해당 월의 목표 날짜 클릭
      const targetDay = parseInt(startDateCompact.slice(6, 8), 10);
      await page.evaluate((day) => {
        // 캘린더에서 날짜 셀 클릭
        const cells = document.querySelectorAll(
          'td[class*="day"], td[class*="date"], ' +
          '[class*="calendar"] td, [class*="Calendar"] td'
        );
        for (const cell of cells) {
          const text = cell.innerText?.trim();
          if (text === String(day) && !cell.classList.contains('disabled') && !cell.classList.contains('other')) {
            cell.click();
            return true;
          }
        }
        return false;
      }, targetDay);
      await sleep(500);
    }
  }

  // 조회 버튼 클릭
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button, a');
    for (const btn of btns) {
      const text = btn.innerText?.trim();
      if (text === '조회' || text === '검색') {
        btn.click();
        return true;
      }
    }
    return false;
  });

  console.log('[ddangyoyo-worker] backfill 조회 요청 완료 — 데이터 로딩 대기');
  await sleep(5000);

  return { startDate: startDateIso, endDate: endDateIso };
}

// ═══════════════════════════════════════════════════════════
// backfill: 날짜별 그룹핑 후 각 날짜별 매출지킴이 전송
// ═══════════════════════════════════════════════════════════

async function sendBackfillToSalesKeeper(config, platformStoreId, brandName, allOrders) {
  const dateGroups = groupOrdersByDate(allOrders);
  const dates = Object.keys(dateGroups).sort();

  console.log(`[ddangyoyo-worker] backfill 전송: ${dates.length}개 날짜, 총 ${allOrders.length}건`);

  const results = [];
  for (const date of dates) {
    const dayOrders = dateGroups[date];
    console.log(`[ddangyoyo-worker] ${date}: ${dayOrders.length}건 전송`);
    try {
      const result = await sendToSalesKeeper(
        config,
        date,
        platformStoreId,
        brandName,
        dayOrders.length,
        null, // settlement — backfill에서는 주문별로 분리 불가, null 전송
        dayOrders,
      );
      results.push({ date, orderCount: dayOrders.length, result });
    } catch (err) {
      console.error(`[ddangyoyo-worker] ${date} 전송 실패:`, err.message);
      results.push({ date, orderCount: dayOrders.length, error: err.message });
    }
  }

  return results;
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
    console.log('[ddangyoyo-worker] backfill 모드 시작 (90일 전 ~ 어제)');
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

  // ── backfill 모드: 주문내역 페이지에서 날짜 범위 설정 ──
  if (isBackfill) {
    send('status', { status: 'crawling', page: 'orders', mode: 'backfill' });
    console.log('[ddangyoyo-worker] 주문내역 메뉴 이동 후 날짜 범위 설정');

    // 주문내역 메뉴 클릭 (extractOrders 내부에서도 하지만, 날짜 설정을 먼저 해야 함)
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      links.find(a => a.innerText.trim() === '주문내역')?.click();
    });
    await sleep(5000);

    // 날짜 범위 설정 (90일 전 ~ 어제)
    const backfillRange = await setBackfillDateRange(page);
    console.log(`[ddangyoyo-worker] backfill 범위 설정 완료: ${backfillRange.startDate} ~ ${backfillRange.endDate}`);
  }

  // ── 주문내역 크롤링 ──
  let orderResult = null;
  send('status', { status: 'crawling', page: 'orders' });
  try {
    if (isBackfill) {
      // backfill 모드: 이미 날짜 범위 설정 + 조회 완료, 데이터만 추출
      // 메뉴 클릭 생략 (이미 주문내역 페이지에서 날짜 설정 + 조회 완료)
      orderResult = await extractOrders(page, { skipNavigation: true });
    } else {
      orderResult = await extractOrders(page);
    }

    if (isBackfill) {
      // backfill 모드: 날짜 필터링 하지 않음 (전체 기간 주문 수집)
      console.log(`[ddangyoyo-worker] backfill 전체 주문: ${orderResult?.orders?.length || 0}건`);

      // 날짜별 그룹핑 요약 로그
      if (orderResult?.orders?.length > 0) {
        const groups = groupOrdersByDate(orderResult.orders);
        const dates = Object.keys(groups).sort();
        console.log(`[ddangyoyo-worker] backfill 날짜 그룹: ${dates.length}개 날짜`);
        for (const date of dates) {
          console.log(`[ddangyoyo-worker]   ${date}: ${groups[date].length}건`);
        }
      }
    } else {
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

  // ── 매출지킴이 전송 ──
  if (salesKeeper && orderResult?.success) {
    try {
      // 가맹점번호를 platformStoreId로 사용
      const platformStoreId = await page.evaluate(() => {
        const bodyText = document.body.innerText;
        const m = bodyText.match(/가맹점(?:번호|코드)?\s*[:\s]*(\d+)/);
        return m ? m[1] : '';
      }) || '1237016'; // 폴백: 고기왕김치찜 가맹점번호

      if (isBackfill) {
        // backfill 모드: 날짜별 그룹핑 후 각 날짜별 전송
        console.log('[ddangyoyo-worker] backfill 날짜별 전송 시작');
        const backfillResults = await sendBackfillToSalesKeeper(
          salesKeeper,
          platformStoreId,
          brandName || '',
          orderResult?.orders || [],
        );
        send('result', { pageKey: 'salesKeeper', result: { mode: 'backfill', results: backfillResults } });
      } else {
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
      }
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
