// 땡겨요 크롤링 워커 - 별도 Node.js 프로세스에서 실행
// boss.ddangyo.com (WebSquare SPA)
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

// 주문내역 추출
async function extractOrders(page) {
  // 주문내역 메뉴 클릭 (SPA — a 태그 텍스트 클릭)
  console.log('[worker] 주문내역 메뉴 클릭');
  await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    links.find(a => a.innerText.trim() === '주문내역')?.click();
  });
  await sleep(5000);

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
  orders.forEach((o, i) => {
    console.log(`[worker]   ${i + 1}: ${o.orderNo} | ${o.date} | ${o.amount}원 | ${o.orderSummary}`);
  });

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

  // 로그인 실패 체크 — 로그인 폼이 아직 있으면 실패
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

  // ── 주문내역 크롤링 ──
  send('status', { status: 'crawling', page: 'orders' });
  try {
    const result = await extractOrders(page);
    send('result', { pageKey: 'orders', result });
  } catch (err) {
    console.error('[worker] 주문 추출 실패:', err);
    send('page-error', { pageKey: 'orders', error: err.message });
  }

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
