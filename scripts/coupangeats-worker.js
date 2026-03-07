// 쿠팡이츠 크롤링 워커 - 별도 Node.js 프로세스에서 실행
// Electron 메인 프로세스와 완전히 분리되어 rebrowser-puppeteer가 정상 동작
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

// 팝업 자동 닫기 — 주기적으로 실행
async function dismissPopups(page) {
  const closed = await page.evaluate(() => {
    let count = 0;
    // 1. X 닫기 버튼 (SVG 또는 아이콘)
    const closeSelectors = [
      '.btn-close',                    // MUI close
      '[class*="close-button"]',       // panel close
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
    // 2. "확인", "닫기", "다음에" 등 텍스트 버튼
    document.querySelectorAll('button').forEach(btn => {
      const text = btn.innerText.trim();
      if (['확인', '닫기', '다음에', '다음에 보기', '건너뛰기', '나중에'].includes(text)) {
        // 모달/팝업 안의 버튼인지 확인
        const parent = btn.closest('[class*="modal"], [class*="popup"], [class*="dialog"], [class*="panel"], [class*="overlay"], [role="dialog"]');
        if (parent && parent.offsetHeight > 0) {
          btn.click();
          count++;
        }
      }
    });
    // 3. 오버레이 배경 클릭 (모달 뒤)
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

// 팝업 감지 타이머 시작/중지
function startPopupDismisser(page) {
  const timer = setInterval(async () => {
    try { await dismissPopups(page); } catch {}
  }, 2000);
  return timer;
}

// 현재 페이지의 주문을 하나씩 펼쳐서 추출
async function extractCurrentPage(page) {
  const orderCount = await page.evaluate(() => {
    return document.querySelectorAll('ul.order-search-result-content > li.col-12').length;
  });

  const orders = [];
  for (let i = 0; i < orderCount; i++) {
    const basicInfo = await page.evaluate((idx) => {
      const lis = document.querySelectorAll('ul.order-search-result-content > li.col-12');
      const li = lis[idx];
      if (!li) return null;

      const orderRow = li.querySelector('section.order-item');
      if (!orderRow) return null;

      const rowText = orderRow.innerText || '';
      const dateMatch = rowText.match(/(\d{4}\.\d{2}\.\d{2})\s+(\d{2}:\d{2})/);
      const orderNoMatch = rowText.match(/\n([A-Z0-9]{5,})\n/);
      const amountMatch = rowText.match(/([\d,]+)원/);
      const lines = rowText.split('\n').map(l => l.trim()).filter(l => l);

      let orderSummary = '';
      for (const line of lines) {
        if (line.match(/^(배달|포장)/)) { orderSummary = line; break; }
      }
      let settlementStatus = '';
      for (const line of lines) {
        if (line.match(/정산(예정|완료)/)) { settlementStatus = line; break; }
      }

      // accordion: expand 클릭 (이전 것은 자동으로 접힘)
      if (!li.classList.contains('expanded')) {
        const expandBtn = li.querySelector('button.order-expand-btn');
        if (expandBtn) expandBtn.click();
      }

      return {
        date: dateMatch ? `${dateMatch[1]} ${dateMatch[2]}` : '',
        orderNo: orderNoMatch ? orderNoMatch[1] : '',
        amount: amountMatch ? amountMatch[1] : '',
        orderSummary,
        settlementStatus,
      };
    }, i);

    if (!basicInfo) continue;

    await sleep(1000);

    const details = await page.evaluate((idx) => {
      const lis = document.querySelectorAll('ul.order-search-result-content > li.col-12');
      const li = lis[idx];
      if (!li) return {};

      const detailContainer = li.querySelector('section.order-details');
      if (!detailContainer || detailContainer.offsetHeight === 0) return {};

      const detailText = detailContainer.innerText || '';
      const breakdown = {};
      const bdLines = detailText.split('\n').map(l => l.trim()).filter(l => l);

      for (let j = 0; j < bdLines.length; j++) {
        const line = bdLines[j];
        const nextLine = bdLines[j + 1] || '';
        const amtInNext = nextLine.match(/^([-\d,]+)원$/);

        if (line === '매출액' && amtInNext) breakdown['매출액'] = amtInNext[1];
        else if (line.includes('상점부담') && amtInNext) breakdown['상점부담쿠폰금액'] = amtInNext[1];
        else if (line.includes('중개') && amtInNext) breakdown['중개이용료'] = amtInNext[1];
        else if (line.includes('결제대행') && amtInNext) breakdown['결제대행사수수료'] = amtInNext[1];
        else if (line === '배달비' && amtInNext) breakdown['배달비'] = amtInNext[1];
        else if (line === '부가세' && amtInNext) breakdown['부가세'] = amtInNext[1];
        else if (line.includes('즉시할인') && amtInNext) breakdown['즉시할인금액'] = amtInNext[1];
        else if (line.includes('정산 예정 금액') || line.includes('기본 정산 예정')) {
          const amt = line.match(/([-\d,]+)원/) || (amtInNext ? amtInNext : null);
          if (amt) breakdown['정산예정금액'] = amt[1];
        }
      }
      return breakdown;
    }, i);

    orders.push({ ...basicInfo, details });
  }
  return orders;
}

async function extractOrders(page, storeId) {
  const ordersUrl = `https://store.coupangeats.com/merchant/management/orders/${storeId}`;

  console.log(`[worker] 매출관리 이동: ${ordersUrl}`);
  await page.goto(ordersUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  await dismissPopups(page);
  await sleep(2000);

  // ── 1. 요약 정보 추출 ──
  const summary = await page.evaluate(() => {
    const bodyText = document.body.innerText || '';
    const s = {};
    const salesMatch = bodyText.match(/매출액\s*([\d,]+)\s*원/);
    const countMatch = bodyText.match(/주문\s*수[^]*?([\d,]+)\s*건/);
    const avgMatch = bodyText.match(/평균\s*주문\s*금액[^]*?([\d,]+)\s*원/);
    if (salesMatch) s['매출액'] = salesMatch[1];
    if (countMatch) s['주문수'] = countMatch[1];
    if (avgMatch) s['평균주문금액'] = avgMatch[1];
    return s;
  });
  console.log('[worker] 요약:', JSON.stringify(summary));

  // ── 2. 총 페이지 수 확인 ──
  const totalPages = await page.evaluate(() => {
    const btns = document.querySelectorAll('.merchant-pagination ul > li > button');
    let maxPage = 1;
    btns.forEach(btn => {
      const num = parseInt(btn.innerText.trim(), 10);
      if (!isNaN(num) && num > maxPage) maxPage = num;
    });
    return maxPage;
  });
  console.log(`[worker] 총 ${totalPages} 페이지`);

  // ── 3. 페이지별 순회하며 추출 ──
  const allOrders = [];

  for (let pg = 1; pg <= totalPages; pg++) {
    console.log(`[worker] ── 페이지 ${pg}/${totalPages} ──`);

    if (pg > 1) {
      // 페이지 버튼 클릭
      await page.evaluate((targetPage) => {
        const btns = document.querySelectorAll('.merchant-pagination ul > li > button');
        btns.forEach(btn => {
          if (btn.innerText.trim() === String(targetPage)) btn.click();
        });
      }, pg);
      await sleep(2000);
      await dismissPopups(page);
      await sleep(1000);
    }

    const pageOrders = await extractCurrentPage(page);
    console.log(`[worker] 페이지 ${pg}: ${pageOrders.length}건 추출`);
    pageOrders.forEach((o, i) => {
      console.log(`[worker]   ${allOrders.length + i + 1}: ${o.orderNo} | ${o.amount}원 | 상세=${Object.keys(o.details).length}개`);
    });
    allOrders.push(...pageOrders);
  }

  const result = {
    success: true,
    site: 'coupangeats',
    pageType: 'orders',
    extractedAt: new Date().toISOString(),
    url: page.url(),
    title: await page.title(),
    summary,
    orders: allOrders,
  };

  const withDetails = allOrders.filter(o => Object.keys(o.details).length > 0).length;
  console.log(`[worker] 추출 완료: ${allOrders.length}건 (상세 ${withDetails}건), 요약:`, JSON.stringify(summary));
  return result;
}

async function run(config) {
  const { id, pw } = config;

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
    ],
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await browser.newPage();

  page.on('response', async (res) => {
    const url = res.url();
    const status = res.status();
    if (url.includes('/api/') || status >= 400) {
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
  // 로그인 직후 팝업 즉시 처리
  await sleep(1000);
  await dismissPopups(page);
  await sleep(500);
  await dismissPopups(page);

  const storeIdMatch = afterUrl.match(/\/(\d+)$/);
  const storeId = storeIdMatch ? storeIdMatch[1] : '518582';
  console.log('[worker] storeId:', storeId);

  // 매출관리 크롤링
  send('status', { status: 'crawling', page: 'orders' });
  try {
    const result = await extractOrders(page, storeId);
    send('result', { pageKey: 'orders', result });
  } catch (err) {
    console.error('[worker] 주문 추출 실패:', err);
    send('page-error', { pageKey: 'orders', error: err.message });
  }

  clearInterval(popupTimer);
  send('done', {});
  await browser.close();
  process.exit(0);
}

process.on('message', (msg) => {
  if (msg.type === 'start') {
    run(msg.config).catch((err) => {
      console.error('[worker] 치명적 오류:', err);
      send('error', { error: err.message });
      process.exit(1);
    });
  }
});
