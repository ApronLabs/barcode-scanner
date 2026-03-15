// 쿠팡이츠 크롤링 워커 - 별도 Node.js 프로세스에서 실행
// Electron 메인 프로세스와 완전히 분리되어 rebrowser-puppeteer가 정상 동작
//
// v4: DOM 스크래핑 + 매장별 수집 방식 (POC 검증 완료)
//     SSR 방식이라 fetch/XHR 인터셉트 불가 → DOM 스크래핑으로 수집
//     매장 드롭다운에서 모든 매장 추출 → 각 매장별 반복
//     일반(daily) 모드: API 인터셉트 유지 (단일 날짜)
//     backfill 모드: DOM 스크래핑, 2달 기간, 매장별 수집
//     매출지킴이 API로 결과 전송하여 DB 저장
'use strict';

const path = require('path');
const os = require('os');

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function send(type, data) {
  if (process.send) {
    process.send({ type, ...data });
  }
}

// 팝업 자동 닫기
async function dismissPopups(page) {
  const closed = await page.evaluate(() => {
    let count = 0;
    const closeSelectors = [
      '.btn-close',
      '[class*="close-button"]',
      '[class*="modal"] [class*="close"]',
      '[class*="popup"] [class*="close"]',
      '[class*="dialog"] [class*="close"]',
      '[aria-label="닫기"]',
      '[aria-label="close"]',
      '[aria-label="Close"]',
    ];
    for (const sel of closeSelectors) {
      document.querySelectorAll(sel).forEach(el => {
        if (el.offsetHeight > 0) { el.click(); count++; }
      });
    }
    document.querySelectorAll('button').forEach(btn => {
      const text = btn.innerText.trim();
      if (['확인', '닫기', '다음에', '다음에 보기', '건너뛰기', '나중에'].includes(text)) {
        const parent = btn.closest('[class*="modal"], [class*="popup"], [class*="dialog"], [class*="panel"], [class*="overlay"], [role="dialog"]');
        if (parent && parent.offsetHeight > 0) {
          btn.click();
          count++;
        }
      }
    });
    document.querySelectorAll('[class*="overlay"], [class*="backdrop"]').forEach(el => {
      if (el.offsetHeight > 0 && el.children.length === 0) {
        el.click();
        count++;
      }
    });
    return count;
  });
  if (closed > 0) console.log(`[worker] 팝업 ${closed}개 닫음`);
  return closed;
}

function startPopupDismisser(page) {
  const timer = setInterval(async () => {
    try { await dismissPopups(page); } catch {}
  }, 2000);
  return timer;
}

// ═══════════════════════════════════════════════════════════
// 매장 드롭다운에서 모든 매장 추출 (POC 검증 완료)
// 홈 상단 "매장명 ▲" 클릭 → 매장 목록 표시
// 매장 변경 시 URL의 storeId가 변경됨
// ═══════════════════════════════════════════════════════════

/**
 * 홈 페이지에서 매장 드롭다운을 열어 모든 매장 정보를 추출
 * @returns {Array<{storeName: string, storeId: string}>}
 */
async function extractAllStores(page) {
  console.log('[worker] 매장 드롭다운에서 모든 매장 추출...');

  // 현재 URL에서 storeId 추출
  const currentUrl = page.url();
  const currentStoreMatch = currentUrl.match(/\/(\d+)(?:\/|$)/);
  const currentStoreId = currentStoreMatch ? currentStoreMatch[1] : null;

  // 드롭다운 트리거 클릭 (매장명 ▲ 영역)
  const dropdownOpened = await page.evaluate(() => {
    // 매장명 드롭다운 트리거 탐색
    const candidates = document.querySelectorAll('button, div, span, a');
    for (const el of candidates) {
      const text = el.innerText?.trim() || '';
      // "매장명 ▲" 또는 드롭다운 트리거 패턴
      if (el.offsetHeight > 0 && (
        text.includes('▲') || text.includes('▼') ||
        el.className?.includes('store-select') ||
        el.className?.includes('store-dropdown') ||
        el.className?.includes('shop-name') ||
        el.getAttribute('data-testid')?.includes('store')
      )) {
        el.click();
        return { clicked: true, text: text.substring(0, 60) };
      }
    }
    // 헤더 영역에서 매장명 찾기 (보통 header 내 첫 번째 클릭 가능 텍스트)
    const headerEls = document.querySelectorAll('header button, header a, header [role="button"], nav button, nav a');
    for (const el of headerEls) {
      const text = el.innerText?.trim() || '';
      if (text.length > 1 && text.length < 30 && el.offsetHeight > 0 && !text.includes('로그아웃')) {
        el.click();
        return { clicked: true, text: text.substring(0, 60), method: 'header' };
      }
    }
    return { clicked: false };
  });

  if (dropdownOpened.clicked) {
    console.log(`[worker] 드롭다운 열림: "${dropdownOpened.text}"`);
  } else {
    console.log('[worker] 드롭다운 트리거 찾지 못함');
  }
  await sleep(2000);

  // 매장 목록 추출
  const stores = await page.evaluate(() => {
    const result = [];
    // 드롭다운 내 매장 항목 탐색
    const listItems = document.querySelectorAll(
      '[class*="dropdown"] li, [class*="dropdown"] a, [class*="dropdown"] button, ' +
      '[class*="store-list"] li, [class*="store-list"] a, ' +
      '[class*="shop-list"] li, [class*="shop-list"] a, ' +
      '[role="listbox"] [role="option"], [role="menu"] [role="menuitem"]'
    );
    for (const item of listItems) {
      const text = item.innerText?.trim() || '';
      const href = item.getAttribute('href') || '';
      // href에서 storeId 추출
      const idMatch = href.match(/\/(\d+)(?:\/|$)/);
      if (text && text.length > 1 && text.length < 50) {
        result.push({
          storeName: text,
          storeId: idMatch ? idMatch[1] : '',
          href: href.substring(0, 150),
        });
      }
    }
    // 중복 제거
    const seen = new Set();
    return result.filter(s => {
      const key = s.storeName + s.storeId;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  // storeId가 비어있으면 클릭해서 URL 변화로 추출
  const resolvedStores = [];
  for (const store of stores) {
    if (store.storeId) {
      resolvedStores.push({ storeName: store.storeName, storeId: store.storeId });
    } else {
      // 매장 클릭 → URL에서 storeId 추출
      console.log(`[worker] 매장 "${store.storeName}" storeId 추출 중...`);
      await page.evaluate((name) => {
        const items = document.querySelectorAll(
          '[class*="dropdown"] li, [class*="dropdown"] a, [class*="dropdown"] button, ' +
          '[class*="store-list"] li, [class*="store-list"] a, ' +
          '[role="listbox"] [role="option"], [role="menu"] [role="menuitem"]'
        );
        for (const item of items) {
          if (item.innerText?.trim() === name) {
            item.click();
            return;
          }
        }
      }, store.storeName);
      await sleep(3000);

      const newUrl = page.url();
      const newMatch = newUrl.match(/\/(\d+)(?:\/|$)/);
      if (newMatch) {
        resolvedStores.push({ storeName: store.storeName, storeId: newMatch[1] });
        console.log(`[worker] → storeId: ${newMatch[1]}`);
      }

      // 다시 드롭다운 열기 (다음 매장용)
      if (stores.indexOf(store) < stores.length - 1) {
        await page.evaluate(() => {
          const candidates = document.querySelectorAll('button, div, span, a');
          for (const el of candidates) {
            const text = el.innerText?.trim() || '';
            if (el.offsetHeight > 0 && (text.includes('▲') || text.includes('▼') ||
              el.className?.includes('store-select') || el.className?.includes('store-dropdown'))) {
              el.click();
              return;
            }
          }
        });
        await sleep(2000);
      }
    }
  }

  // 드롭다운에서 못 찾았으면 현재 매장이라도 반환
  if (resolvedStores.length === 0 && currentStoreId) {
    const currentName = await page.evaluate(() => {
      const header = document.querySelector('header');
      if (!header) return '';
      const spans = header.querySelectorAll('span, div, button');
      for (const el of spans) {
        const text = el.innerText?.trim() || '';
        if (text.length > 1 && text.length < 30 && !text.includes('로그아웃') && !text.includes('홈')) {
          return text;
        }
      }
      return '';
    });
    resolvedStores.push({ storeName: currentName || '알수없는매장', storeId: currentStoreId });
    console.log(`[worker] 드롭다운 미발견 — 현재 매장 사용: ${currentName || '?'} (${currentStoreId})`);
  }

  console.log(`[worker] 총 ${resolvedStores.length}개 매장 발견: ${resolvedStores.map(s => `${s.storeName}(${s.storeId})`).join(', ')}`);
  return resolvedStores;
}


// ═══════════════════════════════════════════════════════════
// DOM 스크래핑 방식 (POC 검증 완료)
// SSR 방식이라 fetch/XHR 인터셉트 불가 → DOM에서 직접 추출
// .order-expand-btn 기반 행 단위 스크래핑
// ═══════════════════════════════════════════════════════════

/**
 * DOM에서 주문 목록을 스크래핑
 * .order-expand-btn이 있는 행에서 날짜, 주문번호, 금액, 정산상태 추출
 */
async function scrapeOrdersFromDOM(page) {
  return page.evaluate(() => {
    const orders = [];
    const expandBtns = document.querySelectorAll('.order-expand-btn');

    expandBtns.forEach(btn => {
      // expand 버튼이 속한 행 찾기
      let searchEl = btn.parentElement;
      for (let i = 0; i < 3; i++) {
        searchEl = searchEl?.parentElement;
        if (!searchEl) break;
      }
      const wideText = searchEl?.innerText || btn.parentElement?.innerText || '';

      // 행 내 텍스트 요소
      const textParts = [];
      const allSpans = (searchEl || btn.parentElement).querySelectorAll('span, div, p, td');
      allSpans.forEach(s => {
        const t = s.innerText?.trim();
        if (t && t.length > 0 && t.length < 200 && !s.querySelector('span, div')) {
          textParts.push(t);
        }
      });

      // 날짜: "2026.03.15  13:06"
      const dateMatch = wideText.match(/(\d{4}\.\d{2}\.\d{2})\s+(\d{2}:\d{2})/);
      // 주문번호: 영숫자 6자리
      const idMatch = wideText.match(/\b([A-Z0-9]{6})\b/);
      // 금액: "17,900원"
      const amounts = wideText.match(/([\d,]+)원/g) || [];
      const mainAmount = amounts.length > 0 ? parseInt(amounts[0].replace(/[,원]/g, ''), 10) : 0;
      // 메뉴 내용
      const menuPart = textParts.find(t => t.startsWith('배달') || t.includes('포장'));

      if (dateMatch) {
        orders.push({
          date: dateMatch[1].replace(/\./g, '-'),
          time: dateMatch[2],
          orderId: idMatch ? idMatch[1] : '',
          menuSummary: menuPart || '',
          amount: mainAmount,
          settlementStatus: wideText.includes('정산완료') ? '정산완료' : '정산예정',
        });
      }
    });

    return orders;
  });
}

/**
 * 페이지네이션 정보 조회 (DOM 기반)
 */
async function getDomPaginationInfo(page) {
  return page.evaluate(() => {
    const btns = document.querySelectorAll('.pagination-btn, [class*="pagination"] button');
    const nums = [];
    let hasNext = false;
    let activeNum = 0;
    btns.forEach(btn => {
      const text = btn.innerText.trim();
      const num = parseInt(text, 10);
      if (!isNaN(num)) {
        nums.push(num);
        if (btn.classList.contains('active')) activeNum = num;
      }
      const cls = btn.className || '';
      if (cls.includes('next-btn') && !cls.includes('hide-btn')) hasNext = true;
    });
    return { nums, hasNext, activeNum, btnCount: btns.length };
  });
}

/**
 * 페이지 번호 클릭 (DOM 기반)
 */
async function clickDomPage(page, pageNum) {
  return page.evaluate((target) => {
    const btns = document.querySelectorAll('.pagination-btn, [class*="pagination"] button');
    for (const btn of btns) {
      if (btn.innerText.trim() === String(target)) { btn.click(); return true; }
    }
    // 일반 버튼에서도 찾기
    const allBtns = document.querySelectorAll('button');
    for (const btn of allBtns) {
      if (btn.innerText.trim() === String(target) && btn.offsetHeight > 0) { btn.click(); return true; }
    }
    return false;
  }, pageNum);
}

/**
 * 다음 페이지 그룹(>) 클릭 (DOM 기반)
 */
async function clickDomNextGroup(page) {
  return page.evaluate(() => {
    const btns = document.querySelectorAll('.pagination-btn');
    for (const btn of btns) {
      const cls = btn.className || '';
      if (cls.includes('next-btn') && !cls.includes('hide-btn')) { btn.click(); return true; }
    }
    return false;
  });
}

/**
 * backfill 모드: 2달 기간 설정 (D-1 기준)
 * "주문일" 클릭 → 날짜 input에 2달 전 ~ 어제 설정 → 조회
 */
async function setBackfillDateRange(page) {
  console.log('[worker] backfill 모드 — 2달 기간 설정 (D-1 기준)');

  // D-1 기준 전전달 1일부터 계산
  const now = new Date();
  // KST 기준으로 계산
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const endDate = new Date(kstNow);
  endDate.setUTCDate(endDate.getUTCDate() - 1); // D-1
  const startDate = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - 2, 1)); // 전전달 1일

  const startStr = `${startDate.getUTCFullYear()}.${String(startDate.getUTCMonth() + 1).padStart(2, '0')}.${String(startDate.getUTCDate()).padStart(2, '0')}`;
  const endStr = `${endDate.getUTCFullYear()}.${String(endDate.getUTCMonth() + 1).padStart(2, '0')}.${String(endDate.getUTCDate()).padStart(2, '0')}`;

  console.log(`[worker] 기간: ${startStr} ~ ${endStr}`);

  // 1. "주문일" 영역 클릭
  const dropdownOpened = await page.evaluate(() => {
    const candidates = document.querySelectorAll('span, div, label, button, select, p');
    for (const el of candidates) {
      const text = el.innerText?.trim();
      if (text && (text === '주문일' || text.startsWith('주문일')) && el.offsetHeight > 0) {
        el.click();
        return text;
      }
    }
    return null;
  });
  if (dropdownOpened) {
    console.log(`[worker] 드롭다운 열림: ${dropdownOpened}`);
  }
  await sleep(1500);

  // 2. 날짜 input에 직접 기간 설정
  const dateSet = await page.evaluate((start, end) => {
    const inputs = document.querySelectorAll('input');
    const dateInputs = [];
    for (const inp of inputs) {
      const val = inp.value || '';
      if (val.match(/\d{4}[-./]\d{2}[-./]\d{2}/)) {
        dateInputs.push(inp);
      }
    }

    if (dateInputs.length >= 2) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      // 시작일
      setter.call(dateInputs[0], start);
      dateInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      dateInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
      // 종료일
      setter.call(dateInputs[1], end);
      dateInputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      dateInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, method: 'inputs', count: dateInputs.length };
    }

    if (dateInputs.length === 1) {
      // 단일 input인 경우 범위 형식으로 시도
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(dateInputs[0], start + ' - ' + end);
      dateInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      dateInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, method: 'single_input', count: 1 };
    }

    return { success: false, method: 'no_inputs' };
  }, startStr, endStr);

  console.log(`[worker] 날짜 설정 결과: ${JSON.stringify(dateSet)}`);

  if (!dateSet.success) {
    // 폴백: "3개월" 프리셋 클릭
    console.log('[worker] 날짜 input 없음 — "3개월" 프리셋 폴백');
    const presetClicked = await page.evaluate(() => {
      const labels = document.querySelectorAll('label, span, div, button, input[type="radio"]');
      for (const el of labels) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text === '3개월' && el.offsetHeight > 0) {
          el.click();
          return '3개월';
        }
      }
      const radios = document.querySelectorAll('input[type="radio"]');
      for (const radio of radios) {
        const label = radio.closest('label') || document.querySelector(`label[for="${radio.id}"]`);
        if (label && label.innerText?.trim() === '3개월') {
          radio.click();
          return '3개월(radio)';
        }
      }
      return null;
    });
    if (presetClicked) {
      console.log(`[worker] 프리셋 폴백 성공: ${presetClicked}`);
    } else {
      console.log('[worker] 프리셋도 찾지 못함');
      return false;
    }
  }

  await sleep(1000);

  // 3. 조회/검색 버튼 클릭
  const searchClicked = await page.evaluate(() => {
    const btns = document.querySelectorAll('button, a, span, div');
    for (const btn of btns) {
      const text = (btn.innerText || '').trim();
      if ((text === '조회' || text === '검색') && btn.offsetHeight > 0) {
        btn.click();
        return text;
      }
    }
    // SVG 돋보기 아이콘 버튼
    const svgBtns = Array.from(document.querySelectorAll('button')).filter(b => b.querySelector('svg') && b.offsetHeight > 0);
    for (const btn of svgBtns) {
      const ariaLabel = btn.getAttribute('aria-label') || '';
      const cls = btn.className || '';
      if (ariaLabel.includes('검색') || ariaLabel.includes('search') || ariaLabel.includes('조회') ||
          cls.includes('search') || cls.includes('Search')) {
        btn.click();
        return 'svg-search';
      }
    }
    // type=submit
    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.offsetHeight > 0) {
      submitBtn.click();
      return 'submit';
    }
    // 마지막 SVG 버튼 (보통 검색)
    if (svgBtns.length > 0) {
      svgBtns[svgBtns.length - 1].click();
      return 'svg-last';
    }
    return null;
  });

  if (searchClicked) {
    console.log(`[worker] 검색 버튼 클릭: ${searchClicked}`);
  } else {
    console.log('[worker] 검색 버튼 찾지 못함 — 날짜 설정만으로 자동 조회될 수 있음');
  }

  await sleep(5000);
  return true;
}

/**
 * 단일 매장에 대한 backfill DOM 스크래핑 수집
 * @param {object} page - puppeteer page
 * @param {string} storeId - 매장 ID
 * @param {string} storeName - 매장명
 * @returns {Array} 스크래핑된 주문 배열
 */
async function backfillScrapeStore(page, storeId, storeName) {
  console.log(`[worker] ═══ 매장 "${storeName}" (${storeId}) backfill 시작 ═══`);

  // 매출관리 페이지 이동
  const ordersUrl = `https://store.coupangeats.com/merchant/management/orders/${storeId}`;
  console.log(`[worker] 매출관리 이동: ${ordersUrl}`);
  await page.goto(ordersUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);
  await dismissPopups(page);
  await sleep(2000);
  await dismissPopups(page);

  // 2달 기간 설정
  const dateSet = await setBackfillDateRange(page);
  if (!dateSet) {
    console.error(`[worker] "${storeName}" 날짜 설정 실패`);
    return [];
  }

  // 페이지 헤더 정보 확인
  const headerInfo = await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    const salesMatch = bodyText.match(/매출액\s*([\d,]+)\s*원/);
    const countMatch = bodyText.match(/주문 수\s*([\d,]+)\s*건/);
    const periodMatch = bodyText.match(/(\d{4}\.\d{2}\.\d{2})\s*-\s*(\d{4}\.\d{2}\.\d{2})/);
    return {
      totalSales: salesMatch ? salesMatch[1] : '',
      totalOrders: countMatch ? countMatch[1] : '',
      periodStart: periodMatch ? periodMatch[1] : '',
      periodEnd: periodMatch ? periodMatch[2] : '',
    };
  });
  console.log(`[worker] "${storeName}" 기간: ${headerInfo.periodStart} ~ ${headerInfo.periodEnd}, 주문: ${headerInfo.totalOrders}건, 매출: ${headerInfo.totalSales}원`);

  // 첫 페이지 DOM 스크래핑
  let pageOrders = await scrapeOrdersFromDOM(page);
  console.log(`[worker] [page 1] ${pageOrders.length}건`);

  const allScrapedOrders = [...pageOrders];

  // 페이지네이션 수집
  let hasMorePages = true;
  let currentPageNum = 1;

  while (hasMorePages) {
    const pageInfo = await getDomPaginationInfo(page);
    console.log(`[worker] 페이지네이션: nums=[${pageInfo.nums}], active=${pageInfo.activeNum}, hasNext=${pageInfo.hasNext}`);

    // 현재 그룹에서 미방문 페이지 클릭
    const unvisited = pageInfo.nums.filter(n => n > currentPageNum);
    for (const pg of unvisited) {
      console.log(`[worker]   ── 페이지 ${pg} 클릭 ──`);
      await clickDomPage(page, pg);
      await sleep(3000);

      const orders = await scrapeOrdersFromDOM(page);
      console.log(`[worker]   페이지 ${pg}: ${orders.length}건`);
      allScrapedOrders.push(...orders);
      currentPageNum = pg;
    }

    // ">" 다음 그룹 버튼 클릭
    if (pageInfo.hasNext) {
      console.log(`[worker]   ── 다음 페이지 그룹 (>) ──`);
      const clicked = await clickDomNextGroup(page);
      if (clicked) {
        await sleep(3000);
        const orders = await scrapeOrdersFromDOM(page);
        currentPageNum++;
        console.log(`[worker]   다음 그룹 첫 페이지 (${currentPageNum}): ${orders.length}건`);
        allScrapedOrders.push(...orders);
      } else {
        hasMorePages = false;
      }
    } else {
      hasMorePages = false;
    }
  }

  console.log(`[worker] "${storeName}" 수집 완료: ${allScrapedOrders.length}건`);
  return allScrapedOrders;
}


// ═══════════════════════════════════════════════════════════
// API 응답 인터셉트 방식 (일반 daily 모드용)
// React 앱이 자연스럽게 호출하는 /order/condition POST 응답을 캡처
// ═══════════════════════════════════════════════════════════

/**
 * 매출관리 페이지에서 날짜 필터를 설정하고,
 * React가 자동으로 호출하는 order/condition API 응답을 가로챔
 */
async function interceptOrderAPI(page, storeId, targetDate, options = {}) {
  console.log(`[worker] API 인터셉트: storeId=${storeId}, targetDate=${targetDate}, mode=${options.mode || 'normal'}`);

  // 응답 수집기 설정
  let capturedData = null;
  let resolveCapture;
  const capturePromise = new Promise(r => { resolveCapture = r; });

  const responseHandler = async (response) => {
    const url = response.url();
    if (!url.includes('/order/condition') || response.status() !== 200) return;

    try {
      const text = await response.text();
      const json = JSON.parse(text);
      const pageVo = json.data?.orderPageVo || json.orderPageVo;
      if (pageVo && pageVo.content) {
        capturedData = json;
        resolveCapture(json);
      }
    } catch {}
  };
  page.on('response', responseHandler);

  // 매출관리 페이지 이동
  const ordersUrl = `https://store.coupangeats.com/merchant/management/orders/${storeId}`;
  console.log(`[worker] 매출관리 이동: ${ordersUrl}`);
  await page.goto(ordersUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);
  await dismissPopups(page);
  await sleep(2000);

  // 날짜 필터 변경 — 캘린더 UI로 targetDate를 설정
  console.log(`[worker] 날짜 필터 변경: ${targetDate} (mode: ${options.mode || 'normal'})`);
  const dateChanged = await setDateFilter(page, targetDate, options);

  if (dateChanged) {
    // 날짜 변경 후 API 응답 대기 (최대 15초)
    const timeout = setTimeout(() => resolveCapture(null), 15000);
    await capturePromise;
    clearTimeout(timeout);
  } else {
    // 날짜 변경 실패 — 이미 로드된 데이터(오늘) 사용 시도
    console.log('[worker] 날짜 변경 실패 — 현재 페이지 데이터 대기...');
    const timeout = setTimeout(() => resolveCapture(null), 10000);
    await capturePromise;
    clearTimeout(timeout);
  }

  page.off('response', responseHandler);

  if (!capturedData) {
    console.error('[worker] API 응답 캡처 실패');
    return { orders: [], totalCount: 0, error: 'API 응답 캡처 실패' };
  }

  // 데이터 파싱
  const pageVo = capturedData.data?.orderPageVo || capturedData.orderPageVo;
  const content = pageVo?.content || [];
  const totalElements = capturedData.data?.totalOrderCount || pageVo?.totalElements || content.length;

  console.log(`[worker] 1페이지 캡처 완료: ${content.length}건 (전체 ${totalElements}건)`);

  const allRawOrders = [...content];

  // 추가 페이지 수집 — ">" 다음 그룹 버튼까지 처리
  // 쿠팡이츠 페이지네이션: [1][2][3][4][5][>] → [<][6][7][8][9][10][>] → ...
  let hasMorePages = true;
  let currentPageNum = 1;

  while (hasMorePages) {
    // 현재 보이는 페이지 버튼들 확인
    const pageButtons = await page.evaluate(() => {
      // 여러 셀렉터로 페이지네이션 버튼 탐색
      const selectors = [
        '.merchant-pagination ul > li > button',
        '.merchant-pagination button',
        '[class*="pagination"] button',
        '[class*="Pagination"] button',
        '[class*="pagination"] a',
      ];
      let allBtns = [];
      for (const sel of selectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > allBtns.length) allBtns = Array.from(found);
      }
      const nums = [];
      let hasNext = false;
      allBtns.forEach(btn => {
        const text = btn.innerText.trim();
        const num = parseInt(text, 10);
        if (!isNaN(num)) nums.push(num);
        const ariaLabel = btn.getAttribute('aria-label') || '';
        if (text === '>' || text === '›' || text === '»' || text === '다음' || text === 'Next' ||
            ariaLabel.includes('next') || ariaLabel.includes('Next') || ariaLabel.includes('다음') ||
            (btn.className && (btn.className.includes('next') || btn.className.includes('Next')))) {
          hasNext = true;
        }
      });
      return { nums, hasNext, btnCount: allBtns.length };
    });
    console.log(`[worker] 페이지네이션: nums=[${pageButtons.nums}], hasNext=${pageButtons.hasNext}, btns=${pageButtons.btnCount}`);

    // 현재 그룹에서 아직 안 클릭한 페이지 클릭
    const unvisited = pageButtons.nums.filter(n => n > currentPageNum);
    for (const pg of unvisited) {
      console.log(`[worker] ── 페이지 ${pg} 클릭 ──`);

      let pageData = null;
      let resolvePageCapture;
      const pageCapturePromise = new Promise(r => { resolvePageCapture = r; });

      const pageResponseHandler = async (response) => {
        const url = response.url();
        if (!url.includes('/order/condition') || response.status() !== 200) return;
        try {
          const text = await response.text();
          const json = JSON.parse(text);
          const pv = json.data?.orderPageVo || json.orderPageVo;
          if (pv && pv.content) {
            pageData = json;
            resolvePageCapture(json);
          }
        } catch {}
      };
      page.on('response', pageResponseHandler);

      await page.evaluate((targetPage) => {
        const selectors = [
          '.merchant-pagination ul > li > button',
          '.merchant-pagination button',
          '[class*="pagination"] button',
          '[class*="Pagination"] button',
        ];
        for (const sel of selectors) {
          const btns = document.querySelectorAll(sel);
          for (const btn of btns) {
            if (btn.innerText.trim() === String(targetPage)) { btn.click(); return; }
          }
        }
      }, pg);

      const pageTimeout = setTimeout(() => resolvePageCapture(null), 10000);
      await pageCapturePromise;
      clearTimeout(pageTimeout);
      page.off('response', pageResponseHandler);

      if (pageData) {
        const pv = pageData.data?.orderPageVo || pageData.orderPageVo;
        const pageContent = pv?.content || [];
        console.log(`[worker] 페이지 ${pg}: ${pageContent.length}건`);
        allRawOrders.push(...pageContent);
      } else {
        console.error(`[worker] 페이지 ${pg} 캡처 실패`);
      }

      currentPageNum = pg;
      await dismissPopups(page);
      await sleep(1500);
    }

    // ">" 다음 그룹 버튼 클릭
    if (pageButtons.hasNext) {
      console.log(`[worker] ── 다음 페이지 그룹 이동 (>) ──`);

      let nextGroupData = null;
      let resolveNextGroup;
      const nextGroupPromise = new Promise(r => { resolveNextGroup = r; });

      const nextGroupHandler = async (response) => {
        const url = response.url();
        if (!url.includes('/order/condition') || response.status() !== 200) return;
        try {
          const text = await response.text();
          const json = JSON.parse(text);
          const pv = json.data?.orderPageVo || json.orderPageVo;
          if (pv && pv.content) {
            nextGroupData = json;
            resolveNextGroup(json);
          }
        } catch {}
      };
      page.on('response', nextGroupHandler);

      await page.evaluate(() => {
        const selectors = [
          '.merchant-pagination ul > li > button',
          '.merchant-pagination button',
          '[class*="pagination"] button',
          '[class*="Pagination"] button',
          '[class*="pagination"] a',
        ];
        for (const sel of selectors) {
          const btns = document.querySelectorAll(sel);
          for (const btn of btns) {
            const text = btn.innerText.trim();
            const ariaLabel = btn.getAttribute('aria-label') || '';
            if (text === '>' || text === '›' || text === '»' || text === '다음' || text === 'Next' ||
                ariaLabel.includes('next') || ariaLabel.includes('Next') || ariaLabel.includes('다음') ||
                (btn.className && (btn.className.includes('next') || btn.className.includes('Next')))) {
              btn.click();
              return;
            }
          }
        }
      });

      const nextTimeout = setTimeout(() => resolveNextGroup(null), 10000);
      await nextGroupPromise;
      clearTimeout(nextTimeout);
      page.off('response', nextGroupHandler);

      if (nextGroupData) {
        const pv = nextGroupData.data?.orderPageVo || nextGroupData.orderPageVo;
        const pageContent = pv?.content || [];
        currentPageNum++;
        console.log(`[worker] 다음 그룹 첫 페이지: ${pageContent.length}건`);
        allRawOrders.push(...pageContent);
      } else {
        console.log('[worker] 다음 그룹 없음 — 수집 완료');
        hasMorePages = false;
      }

      await sleep(1500);
    } else {
      hasMorePages = false;
    }
  }

  console.log(`[worker] 전체 수집: ${allRawOrders.length}건`);

  // ─── backfill 모드: 날짜 필터 없이 전체 반환 (run()에서 그룹핑) ───
  if (options.mode === 'backfill') {
    const allOrders = allRawOrders.map(parseOrder);
    const validOrders = allOrders.filter(o => o.orderSettlement);
    const noSettlement = allOrders.length - validOrders.length;
    if (noSettlement > 0) {
      console.log(`[coupangeats-worker] 정산 데이터 없는 주문 ${noSettlement}건 제외`);
    }
    console.log(`[coupangeats-worker] backfill 전체: ${validOrders.length}건 (정산 있음)`);
    return {
      orders: validOrders,
      totalCount: allOrders.length,
      allRawOrders, // backfill 디버깅용
      error: null,
    };
  }

  // ─── 일반 모드: targetDate에 해당하는 주문만 필터 (createdAt 기반 KST) ───
  const targetStart = new Date(targetDate + 'T00:00:00+09:00').getTime();
  const targetEnd = new Date(targetDate + 'T23:59:59.999+09:00').getTime();

  const dateFiltered = allRawOrders.filter(o => {
    const ts = o.createdAt;
    return ts >= targetStart && ts <= targetEnd;
  });

  console.log(`[worker] ${targetDate} 날짜 필터: ${dateFiltered.length}건 (전체 ${allRawOrders.length}건 중)`);

  const allOrders = dateFiltered.map(parseOrder);

  // orderSettlement 있는 주문만 필터
  const validOrders = allOrders.filter(o => o.orderSettlement);
  const noSettlement = allOrders.length - validOrders.length;
  if (noSettlement > 0) {
    console.log(`[worker] 정산 데이터 없는 주문 ${noSettlement}건 제외`);
  }

  return {
    orders: validOrders,
    totalCount: allOrders.length,
    error: null,
  };
}

/**
 * 쿠팡이츠 API 주문 객체를 DB SalesOrder 스키마에 맞게 변환
 * API 필드 → DB 필드 매핑 (2026-03 확인)
 */
function parseOrder(order) {
  const items = order.items || [];
  const firstItemName = items[0]?.name || '';
  const menuSummary = items.length > 1
    ? `${firstItemName} 외 ${items.length - 1}건`
    : firstItemName;

  const orderedAt = order.createdAt
    ? new Date(order.createdAt).toISOString()
    : '';

  const s = order.orderSettlement || {};

  return {
    // 주문 기본
    orderId: order.abbrOrderId || '',
    orderIdInternal: order.uniqueOrderId || String(order.orderId || ''),
    orderedAt,
    orderType: order.type || '',
    menuSummary,
    totalPayment: order.salePrice || 0,
    orderStatus: order.status || 'COMPLETED',
    channel: 'DELIVERY',
    paymentMethod: '',

    // 정산 상세 (DB SalesOrder 필드명)
    commissionFee: s.serviceSupplyPrice?.appliedSupplyPrice || 0,
    pgFee: s.paymentSupplyPrice?.appliedSupplyPrice || 0,
    deliveryCost: s.deliverySupplyPrice?.appliedSupplyPrice || 0,
    adFee: s.advertisingSupplyPrice?.appliedSupplyPrice || 0,
    vat: s.commissionVat || 0,
    storeDiscount: s.storePromotionAmount || 0,
    instantDiscount: s.mfdTotalAmount || 0,
    cupDeposit: s.disposableCupFee || 0,
    favorableFee: s.favorableFee || 0,
    settlementAmount: order.actuallyAmount || ((order.salePrice || 0) - (s.subtractAmount || 0)),
    settlementDate: s.settlementDueDate || '',
    isSettled: s.hasSettled || false,

    // 메뉴 상세 (SalesOrderItem)
    items: items.map(item => ({
      menuName: item.name || '',
      quantity: item.quantity || 1,
      unitPrice: item.unitSalePrice || 0,
      totalPrice: item.subTotalPrice || 0,
      options: (item.itemOptions || []).map(opt => ({
        name: opt.optionName || '',
        quantity: opt.optionQuantity || 1,
        price: opt.optionPrice || 0,
      })),
    })),

    // 원본 보존 (디버깅/추후 활용)
    orderSettlement: order.orderSettlement || null,
  };
}

/**
 * UTC 타임스탬프(ms)를 KST 날짜 문자열(YYYY-MM-DD)로 변환
 */
function timestampToKstDate(ms) {
  const d = new Date(ms + 9 * 60 * 60 * 1000); // UTC → KST
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

/**
 * 매출관리 페이지에서 날짜 필터를 targetDate로 변경
 * 캘린더 UI 조작 또는 input 직접 변경
 * (일반 daily 모드 전용 — backfill은 setBackfillDateRange() 사용)
 */
async function setDateFilter(page, targetDate, options = {}) {
  try {
    // ─── 일반 모드: 기존 로직 ───
    // 쿠팡이츠 매출관리의 날짜 필터 구조 파악
    const filterInfo = await page.evaluate(() => {
      // date input 찾기
      const dateInputs = document.querySelectorAll('input[type="date"], input[type="text"][class*="date"], input[class*="DatePicker"], input[class*="datepicker"]');
      // 캘린더 관련 버튼
      const calBtns = Array.from(document.querySelectorAll('button')).filter(b => {
        const text = b.innerText.trim();
        return text === '오늘' || text === '어제' || text === '1주일' || text === '1개월' || text.includes('조회');
      }).map(b => ({ text: b.innerText.trim(), className: (b.className || '').substring(0, 80) }));

      // "어제" 버튼이 있는지
      const hasYesterday = calBtns.some(b => b.text === '어제');

      // 현재 표시된 날짜 범위
      const bodyText = document.body.innerText;
      const dateRange = bodyText.match(/(\d{4}\.\d{2}\.\d{2})\s*[-~]\s*(\d{4}\.\d{2}\.\d{2})/);

      return {
        dateInputCount: dateInputs.length,
        calBtns,
        hasYesterday,
        dateRange: dateRange ? { start: dateRange[1], end: dateRange[2] } : null,
      };
    });

    console.log('[worker] 날짜 필터 상태:', JSON.stringify(filterInfo));

    // "어제" 버튼 클릭 (targetDate가 어제인 경우 가장 간단)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    if (targetDate === yesterdayStr && filterInfo.hasYesterday) {
      console.log('[worker] "어제" 버튼 클릭');
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          if (b.innerText.trim() === '어제') { b.click(); return true; }
        }
        return false;
      });
      await sleep(3000);
      return true;
    }

    // 날짜 input 직접 변경 시도
    const changed = await page.evaluate((date) => {
      // react-datepicker 또는 input[type="date"] 찾기
      const inputs = document.querySelectorAll('input');
      const dateInputs = [];
      for (const inp of inputs) {
        const val = inp.value || '';
        // 날짜 형식 감지 (2026.03.08, 2026-03-08 등)
        if (val.match(/\d{4}[-./]\d{2}[-./]\d{2}/)) {
          dateInputs.push(inp);
        }
      }

      if (dateInputs.length >= 2) {
        // 시작일, 종료일 둘 다 변경
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        for (const inp of dateInputs) {
          nativeInputValueSetter.call(inp, date.replace(/-/g, '.'));
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return 'inputs_changed';
      }

      if (dateInputs.length === 1) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(dateInputs[0], date.replace(/-/g, '.'));
        dateInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        dateInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        return 'input_changed';
      }

      return 'no_inputs_found';
    }, targetDate);

    console.log('[worker] 날짜 변경 결과:', changed);

    if (changed.includes('changed')) {
      // "조회" 버튼 클릭
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          if (b.innerText.trim() === '조회') { b.click(); return true; }
        }
        return false;
      });
      await sleep(3000);
      return true;
    }

    // 날짜 input을 못 찾았으면 — 직접 캘린더 클릭 시도
    console.log('[worker] 날짜 input 없음 — 캘린더 클릭 시도');

    // 날짜 영역 클릭 → 캘린더 팝업 열기
    const calendarOpened = await page.evaluate(() => {
      // 날짜 표시 영역 (span/div with date text)
      const allEls = document.querySelectorAll('span, div, p');
      for (const el of allEls) {
        const text = el.innerText?.trim();
        if (text && text.match(/^\d{4}\.\d{2}\.\d{2}$/) && el.offsetHeight > 0) {
          el.click();
          return text;
        }
      }
      return null;
    });

    if (calendarOpened) {
      console.log(`[worker] 캘린더 열림 (현재: ${calendarOpened})`);
      await sleep(1000);

      // 날짜 선택 (day 클릭)
      const [year, month, day] = targetDate.split('-').map(Number);
      const dayClicked = await page.evaluate((d) => {
        // 캘린더에서 날짜 클릭
        const cells = document.querySelectorAll('[class*="calendar"] td, [class*="datepicker"] td, [class*="Calendar"] button, [role="gridcell"]');
        for (const cell of cells) {
          if (cell.innerText.trim() === String(d) && cell.offsetHeight > 0) {
            cell.click();
            return true;
          }
        }
        return false;
      }, day);

      if (dayClicked) {
        console.log(`[worker] 날짜 ${day}일 클릭 완료`);
        await sleep(2000);

        // 종료일도 같은 날 클릭 (시작일-종료일 동일)
        await page.evaluate((d) => {
          const cells = document.querySelectorAll('[class*="calendar"] td, [class*="datepicker"] td, [class*="Calendar"] button, [role="gridcell"]');
          for (const cell of cells) {
            if (cell.innerText.trim() === String(d) && cell.offsetHeight > 0) {
              cell.click();
              return true;
            }
          }
          return false;
        }, day);
        await sleep(1000);

        // 조회/확인 버튼
        await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          for (const b of btns) {
            const t = b.innerText.trim();
            if (t === '조회' || t === '적용' || t === '확인') { b.click(); return; }
          }
        });
        await sleep(3000);
        return true;
      }
    }

    return false;
  } catch (err) {
    console.error('[worker] 날짜 변경 오류:', err.message);
    return false;
  }
}


/**
 * 크롤링 결과를 매출지킴이 API로 전송
 */
async function sendToSalesKeeper(config, targetDate, platformStoreId, brandName, orders) {
  const { apiBaseUrl, sessionToken, salesKeeperStoreId } = config;
  if (!apiBaseUrl || !sessionToken || !salesKeeperStoreId) {
    console.log('[worker] 매출지킴이 전송 설정 없음 — 건너뜀');
    return null;
  }

  const url = `${apiBaseUrl}/api/stores/${salesKeeperStoreId}/crawler/coupangeats`;
  console.log(`[worker] 매출지킴이 전송: ${url} (${orders.length}건)`);

  const http = require('http');
  const https = require('https');
  const { URL } = require('url');

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    const body = JSON.stringify({
      targetDate,
      platformStoreId,
      brandName,
      orders,
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
      console.error(`[worker] 매출지킴이 전송 실패:`, err.message);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}


async function run(config) {
  const { id, pw, targetDate, brandName, salesKeeper, mode } = config;

  // targetDate가 없으면 어제 날짜 사용
  const crawlDate = targetDate || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  })();

  const crawlOptions = { mode: mode || null };

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
      '--window-size=1200,900',
      '--window-position=-32000,-32000',
    ],
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await browser.newPage();

  page.on('response', async (res) => {
    const url = res.url();
    const status = res.status();
    if ((url.includes('/api/') && url.includes('order')) || status >= 400) {
      console.log(`[HTTP] ${status} ${url.substring(0, 150)}`);
    }
  });

  console.log('[worker] 브라우저 시작됨');
  send('status', { status: 'logging_in' });

  // 로그인
  await page.goto('https://store.coupangeats.com/merchant/login', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  console.log('[worker] Akamai 센서 대기 (10초)...');
  await sleep(10000);

  const hasForm = await page.evaluate(() => ({
    hasId: !!document.getElementById('loginId'),
    hasPw: !!document.getElementById('password'),
  }));
  if (!hasForm.hasId || !hasForm.hasPw) {
    send('error', { error: '로그인 폼을 찾을 수 없습니다' });
    await browser.close();
    process.exit(1);
  }

  console.log('[worker] 아이디/비밀번호 입력...');
  await page.click('#loginId', { clickCount: 3 });
  await page.type('#loginId', id, { delay: 80 });
  await sleep(300);
  await page.click('#password', { clickCount: 3 });
  await page.type('#password', pw, { delay: 80 });
  await sleep(500);

  console.log('[worker] 로그인 버튼 클릭...');
  const btn = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '로그인')
  );
  if (btn) await btn.click();
  else {
    send('error', { error: '로그인 버튼 없음' });
    await browser.close();
    process.exit(1);
  }

  console.log('[worker] 응답 대기 (10초)...');
  await sleep(10000);

  const afterUrl = page.url();
  console.log('[worker] 로그인 후 URL:', afterUrl);

  if (afterUrl.includes('/login')) {
    const errors = await page.evaluate(() => {
      const errs = [];
      document.querySelectorAll('[class*="error"], [class*="alert"]').forEach(el => {
        const t = el.innerText?.trim();
        if (t) errs.push(t);
      });
      return errs;
    }).catch(() => []);
    send('error', { error: '쿠팡이츠 로그인 실패: ' + (errors[0] || 'unknown') });
    await browser.close();
    process.exit(1);
  }

  console.log('[worker] 로그인 성공!');

  // 팝업 자동 닫기 시작
  const popupTimer = startPopupDismisser(page);
  await sleep(1000);
  await dismissPopups(page);
  await sleep(500);
  await dismissPopups(page);

  // storeId 추출 (기본값)
  const storeIdMatch = afterUrl.match(/\/(\d+)$/);
  const defaultStoreId = storeIdMatch ? storeIdMatch[1] : '518582';
  console.log('[worker] 기본 storeId:', defaultStoreId);

  // ═══════════════════════════════════════════════════════════
  // backfill 모드: DOM 스크래핑 + 매장별 수집 (POC 검증 완료)
  // ═══════════════════════════════════════════════════════════
  if (crawlOptions.mode === 'backfill') {
    send('status', { status: 'crawling', page: 'orders', mode: 'backfill' });
    try {
      console.log('[worker] ═══ BACKFILL 모드: 매장별 DOM 스크래핑 (2달 기간) ═══');

      // 1. 매장 드롭다운에서 모든 매장 추출
      const stores = await extractAllStores(page);
      if (stores.length === 0) {
        // 드롭다운에서 못 찾으면 기본 storeId 사용
        stores.push({ storeName: brandName || '기본매장', storeId: defaultStoreId });
      }

      console.log(`[worker] ${stores.length}개 매장에 대해 backfill 시작`);

      // 2. 각 매장에 대해 반복
      const allStoreResults = [];
      for (let i = 0; i < stores.length; i++) {
        const store = stores[i];
        console.log(`[worker] ── 매장 ${i + 1}/${stores.length}: "${store.storeName}" (${store.storeId}) ──`);

        const scrapedOrders = await backfillScrapeStore(page, store.storeId, store.storeName);

        // 날짜별 그룹핑
        const groups = {};
        for (const order of scrapedOrders) {
          if (!order.date) continue;
          if (!groups[order.date]) groups[order.date] = [];
          groups[order.date].push(order);
        }

        const sortedDates = Object.keys(groups).sort();
        console.log(`[worker] "${store.storeName}": ${sortedDates.length}개 날짜, ${scrapedOrders.length}건`);

        // 일별 요약 로그
        for (const date of sortedDates) {
          const dayOrders = groups[date];
          const totalSales = dayOrders.reduce((s, o) => s + o.amount, 0);
          const settled = dayOrders.filter(o => o.settlementStatus === '정산완료').length;
          console.log(`[worker]   [${date}] ${dayOrders.length}건 | 매출: ${totalSales.toLocaleString()}원 | 정산완료: ${settled}건`);
        }

        // IPC 결과 전송 (매장별)
        const storeResult = {
          success: scrapedOrders.length > 0,
          site: 'coupangeats',
          pageType: 'orders',
          mode: 'backfill',
          extractedAt: new Date().toISOString(),
          storeName: store.storeName,
          storeId: store.storeId,
          totalCount: scrapedOrders.length,
          dateGroups: sortedDates.map(d => ({ date: d, count: groups[d].length })),
          orders: scrapedOrders,
        };
        send('result', { pageKey: `orders_${store.storeId}`, result: storeResult });
        allStoreResults.push(storeResult);

        // 매출지킴이 API로 날짜별 전송
        if (salesKeeper && scrapedOrders.length > 0) {
          let sentCount = 0;
          let failCount = 0;
          for (const [date, dateOrders] of Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))) {
            console.log(`[worker] 매출지킴이 전송: ${store.storeName} / ${date} (${dateOrders.length}건)`);
            try {
              const sendResult = await sendToSalesKeeper(
                salesKeeper,
                date,
                store.storeId,
                store.storeName,
                dateOrders,
              );
              sentCount++;
              send('result', { pageKey: `salesKeeper_${store.storeId}_${date}`, result: sendResult });
            } catch (sendErr) {
              failCount++;
              console.error(`[worker] 매출지킴이 전송 실패 (${store.storeName}/${date}):`, sendErr.message);
              send('page-error', { pageKey: `salesKeeper_${store.storeId}_${date}`, error: sendErr.message });
            }
            await sleep(500);
          }
          console.log(`[worker] "${store.storeName}" 전송 완료: 성공 ${sentCount}건, 실패 ${failCount}건`);
        }
      }

      // 전체 요약 IPC 전송
      const totalOrders = allStoreResults.reduce((s, r) => s + r.totalCount, 0);
      const summaryResult = {
        success: totalOrders > 0,
        site: 'coupangeats',
        pageType: 'orders',
        mode: 'backfill',
        extractedAt: new Date().toISOString(),
        storeCount: stores.length,
        stores: stores.map(s => ({ storeName: s.storeName, storeId: s.storeId })),
        totalCount: totalOrders,
        storeResults: allStoreResults.map(r => ({
          storeName: r.storeName,
          storeId: r.storeId,
          orderCount: r.totalCount,
          dateGroupCount: r.dateGroups.length,
        })),
      };
      send('result', { pageKey: 'orders', result: summaryResult });

      console.log(`[worker] ═══ BACKFILL 완료: ${stores.length}개 매장, 총 ${totalOrders}건 ═══`);

    } catch (err) {
      console.error('[worker] backfill 실패:', err);
      send('page-error', { pageKey: 'orders', error: err.message });
    }

  } else {
    // ═══════════════════════════════════════════════════════════
    // 일반(daily) 모드: API 인터셉트 방식 (기존 로직 유지)
    // ═══════════════════════════════════════════════════════════
    send('status', { status: 'crawling', page: 'orders' });
    try {
      console.log(`[worker] ═══ ${crawlDate} 주문 데이터 크롤링 시작 (daily 모드) ═══`);
      const { orders, totalCount, error } = await interceptOrderAPI(page, defaultStoreId, crawlDate, crawlOptions);

      if (error) {
        console.error(`[worker] 오류: ${error}`);
      }

      // 결과를 IPC로 전송 (바코드 스캐너 UI용)
      const result = {
        success: orders.length > 0,
        site: 'coupangeats',
        pageType: 'orders',
        extractedAt: new Date().toISOString(),
        targetDate: crawlDate,
        storeId: defaultStoreId,
        totalCount,
        ordersWithSettlement: orders.length,
        orders,
      };
      send('result', { pageKey: 'orders', result });

      // 매출지킴이 API로 전송
      if (salesKeeper && orders.length > 0) {
        try {
          const sendResult = await sendToSalesKeeper(
            salesKeeper,
            crawlDate,
            defaultStoreId,
            brandName || '',
            orders,
          );
          send('result', { pageKey: 'salesKeeper', result: sendResult });
        } catch (sendErr) {
          console.error('[worker] 매출지킴이 전송 실패:', sendErr.message);
          send('page-error', { pageKey: 'salesKeeper', error: sendErr.message });
        }
      }

    } catch (err) {
      console.error('[worker] 주문 추출 실패:', err);
      send('page-error', { pageKey: 'orders', error: err.message });
    }
  }

  clearInterval(popupTimer);
  send('done', {});
  await browser.close();
  process.exit(0);
}

process.on('message', (msg) => {
  if (msg.type === 'start') {
    // mode 파라미터를 config에 포함하여 전달
    const config = { ...msg.config };
    if (msg.config.mode) {
      config.mode = msg.config.mode;
    }
    run(config).catch((err) => {
      console.error('[worker] 치명적 오류:', err);
      send('error', { error: err.message });
      process.exit(1);
    });
  }
});
