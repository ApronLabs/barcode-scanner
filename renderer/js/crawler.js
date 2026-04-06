const ALL_SITES = ['baemin', 'yogiyo', 'coupangeats', 'ddangyoyo', 'okpos'];
const CRAWL_SITES = ['baemin', 'yogiyo', 'coupangeats', 'ddangyoyo', 'okpos'];
const SITE_NAMES = { baemin: '배민', yogiyo: '요기요', coupangeats: '쿠팡이츠', ddangyoyo: '땡겨요', okpos: 'OKPOS' };
const PAGE_NAMES = {
  orderHistory: '주문내역', orders: '주문내역', settlement: '정산',
  billing: '정산', sales: '매출', generic: '전체', default: '주문내역',
  okpos: '매출',
};

let allResults = {};
let activeTab = null;
let activeShopTab = {}; // { 'baemin-orderHistory': 'shopName' }

// ── 플랫폼 카드 상태 업데이트 ──
function updatePlatformCard(site) {
  const card = document.getElementById(`card-${site}`);
  const badge = document.getElementById(`badge-${site}`);
  const idVal = document.getElementById(`cred-${site}-id`).value.trim();
  const pwVal = document.getElementById(`cred-${site}-pw`).value;

  if (!card || !badge) return;

  const hasCredentials = idVal && pwVal;

  // 크롤링 결과가 있으면 그 상태 유지
  if (card.classList.contains('received') || card.classList.contains('error')) return;

  if (hasCredentials) {
    card.className = 'platform-card active';
    badge.className = 'platform-badge badge-wait';
    badge.textContent = '대기';
  } else {
    card.className = 'platform-card disabled';
    badge.className = 'platform-badge badge-inactive';
    badge.textContent = '미등록';
  }
}

function updateAllCards() {
  ALL_SITES.forEach(updatePlatformCard);
}

// ── 수정 버튼 ──
document.querySelectorAll('.platform-edit-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const site = btn.dataset.site;
    const idInput = document.getElementById(`cred-${site}-id`);
    const pwInput = document.getElementById(`cred-${site}-pw`);
    const isEditing = btn.classList.contains('editing');

    if (isEditing) {
      // 저장 모드
      btn.textContent = '저장 중...';
      btn.disabled = true;

      const creds = {};
      ALL_SITES.forEach(s => {
        creds[s] = {
          id: document.getElementById(`cred-${s}-id`).value.trim(),
          pw: document.getElementById(`cred-${s}-pw`).value,
        };
      });

      const result = await window.crawler.saveCredentials(creds);
      const status = document.getElementById('credStatus');

      if (result.success) {
        status.textContent = '저장 완료';
        status.style.color = '#059669';
      } else {
        status.textContent = '저장 실패: ' + (result.error || '');
        status.style.color = '#dc2626';
      }
      setTimeout(() => { status.textContent = ''; }, 3000);

      // readonly로 복귀
      idInput.readOnly = true;
      pwInput.readOnly = true;
      btn.classList.remove('editing');
      btn.textContent = '수정';
      btn.disabled = false;
      updatePlatformCard(site);
    } else {
      // 수정 모드 진입
      idInput.readOnly = false;
      pwInput.readOnly = false;
      idInput.focus();
      btn.classList.add('editing');
      btn.textContent = '저장';
    }
  });
});

// ── 뒤로가기 ──
document.getElementById('backBtn').addEventListener('click', () => {
  window.api.navigate('scanner');
});

// ── 자동 크롤링 ──
document.getElementById('btnAutoCrawl').addEventListener('click', async () => {
  const btn = document.getElementById('btnAutoCrawl');
  btn.disabled = true;
  btn.textContent = '크롤링 진행 중...';

  allResults = {};
  activeTab = null;
  activeShopTab = {};
  document.getElementById('result-area').style.display = 'none';

  // 계정이 등록된 크롤링 대상만 필터
  const storeId = sessionStorage.getItem('selectedStoreId');
  const credentials = await window.crawler.getCredentials(storeId);
  const activeSites = CRAWL_SITES.filter(site => {
    const c = credentials?.[site];
    return c && c.id && c.pw;
  });

  if (activeSites.length === 0) {
    document.getElementById('status').textContent = '등록된 플랫폼 계정이 없습니다.';
    btn.disabled = false;
    btn.textContent = '자동 크롤링 시작';
    return;
  }

  // 활성 사이트만 대기 뱃지
  activeSites.forEach(site => {
    const card = document.getElementById(`card-${site}`);
    const badge = document.getElementById(`badge-${site}`);
    if (card) card.className = 'platform-card active';
    if (badge) {
      badge.className = 'platform-badge badge-wait';
      badge.textContent = '대기';
    }
  });

  try {
    await window.crawler.triggerCrawl({
      sites: activeSites,
      credentials,
    });
  } catch (err) {
    document.getElementById('status').textContent = '트리거 실패: ' + err.message;
  }
});

// ── 크롤링 완료 ──
window.crawler.onCrawlComplete(async (data) => {
  const btn = document.getElementById('btnAutoCrawl');
  btn.disabled = false;
  btn.textContent = '자동 크롤링 시작';
  if (data.results) allResults = data.results;
  document.getElementById('status').textContent = '크롤링 완료!';
  renderResults();

  if (data.results && Object.keys(data.results).length > 0) {
    try {
      const saveData = {
        exportedAt: new Date().toISOString(),
        results: data.results,
        errors: data.errors || [],
      };
      const res = await window.crawler.saveCrawlJson(saveData);
      if (res.success) console.log('JSON 저장 완료:', res.path);
    } catch (e) {
      console.error('JSON 저장 실패:', e);
    }
  }
});

// ── 상태 업데이트 ──
window.crawler.onCrawlStatus((data) => {
  const statusNames = { starting: '시작', logging_in: '로그인 중', crawling: '데이터 추출 중', manual_login_required: '수동 로그인 대기' };
  const badge = document.getElementById(`badge-${data.site}`);
  if (badge) {
    badge.className = 'platform-badge badge-active';
    badge.textContent = statusNames[data.status] || data.status;
  }
});

window.crawler.onStatus((msg) => {
  document.getElementById('status').textContent = msg;
});

// ── 결과 수신 ──
window.crawler.onCrawlResult((data) => {
  const site = data.site;
  if (!allResults[site]) allResults[site] = {};
  allResults[site][data.pageType || 'default'] = data;

  const card = document.getElementById(`card-${site}`);
  const badge = document.getElementById(`badge-${site}`);
  if (card && badge) {
    card.className = 'platform-card received';
    const pageCount = Object.keys(allResults[site]).length;
    badge.className = 'platform-badge badge-ok';
    badge.textContent = `${pageCount}개 페이지 수신`;
  }

  renderResults();
});

// ── 에러 수신 ──
window.crawler.onCrawlError((data) => {
  const card = document.getElementById(`card-${data.site}`);
  const badge = document.getElementById(`badge-${data.site}`);
  if (card && badge) {
    card.className = 'platform-card error';
    badge.className = 'platform-badge badge-fail';
    badge.textContent = '오류';
  }
  document.getElementById('status').textContent = `[${data.site}${data.page ? '/' + data.page : ''}] ${data.error}`;
});

// ── 데이터에서 매장별 주문 추출 ──
function extractShops(data) {
  // shops 배열이 있으면 그대로 사용
  if (data.shops && data.shops.length > 0) {
    return data.shops.map(shop => ({
      shopName: shop.shopName || '매장',
      shopId: shop.shopId || '',
      orders: shop.orders || [],
    }));
  }
  // shops가 없으면 기존 apiOrders/orders를 단일 매장으로 묶음
  const orders = data.apiOrders || data.orders || [];
  if (orders.length === 0) return [];
  return [{ shopName: '', shopId: '', orders }];
}

// ── 결과 렌더링 ──
function renderResults() {
  const area = document.getElementById('result-area');
  const tabsEl = document.getElementById('result-tabs');
  const contentEl = document.getElementById('result-content');

  const tabs = [];
  for (const [site, pages] of Object.entries(allResults)) {
    for (const [page, data] of Object.entries(pages)) {
      if (page === 'salesKeeper') continue;
      const siteName = SITE_NAMES[site] || site;
      const pageName = PAGE_NAMES[page] || page;
      tabs.push({ key: `${site}-${page}`, label: `${siteName} ${pageName}`, site, data });
    }
  }

  if (tabs.length === 0) { area.style.display = 'none'; return; }

  area.style.display = 'block';
  if (!activeTab || !tabs.find(t => t.key === activeTab)) activeTab = tabs[0].key;

  tabsEl.innerHTML = tabs.map(t =>
    `<div class="result-tab ${t.key === activeTab ? 'active' : ''}" data-key="${t.key}">${t.label}</div>`
  ).join('');

  tabsEl.querySelectorAll('.result-tab').forEach(tab => {
    tab.addEventListener('click', () => { activeTab = tab.dataset.key; renderResults(); });
  });

  const current = tabs.find(t => t.key === activeTab);
  if (current) {
    contentEl.innerHTML = renderDataWithShops(current.key, current.site, current.data);
    // 매장 서브탭 이벤트 바인딩
    contentEl.querySelectorAll('.shop-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeShopTab[current.key] = tab.dataset.shop;
        renderResults();
      });
    });
  }
}

// ── 매장별 서브탭 포함 렌더링 ──
function renderDataWithShops(tabKey, site, data) {
  const shops = extractShops(data);

  // 매장이 없으면 기존 방식으로 렌더
  if (shops.length === 0) {
    return renderData(data);
  }

  // 매장이 1개이고 이름이 없으면 서브탭 없이 바로 테이블
  if (shops.length === 1 && !shops[0].shopName) {
    return renderData(data);
  }

  // 매장이 1개이고 이름이 있어도 서브탭 없이 바로 테이블 (매장명만 표시)
  if (shops.length === 1) {
    const shop = shops[0];
    const shopData = { ...data, apiOrders: shop.orders, orders: shop.orders };
    let html = `<div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:10px;">${escapeHtml(shop.shopName)}</div>`;
    html += renderShopContent(site, shopData, shop.orders);
    return html;
  }

  // 여러 매장: 서브탭 표시
  const currentShop = activeShopTab[tabKey] || shops[0].shopName;
  // 현재 선택된 매장이 목록에 없으면 첫번째로 fallback
  const selectedShop = shops.find(s => s.shopName === currentShop) || shops[0];

  let html = '<div class="shop-tabs">';
  shops.forEach(shop => {
    const isActive = shop.shopName === selectedShop.shopName;
    const orderCount = shop.orders.length;
    html += `<button class="shop-tab ${isActive ? 'active' : ''}" data-shop="${escapeHtml(shop.shopName)}">${escapeHtml(shop.shopName)} (${orderCount})</button>`;
  });
  html += '</div>';

  // 선택된 매장의 데이터 렌더
  const shopData = { ...data, apiOrders: selectedShop.orders, orders: selectedShop.orders };
  html += renderShopContent(site, shopData, selectedShop.orders);

  return html;
}

// ── 매장 데이터 렌더 (요약 + 테이블) ──
function renderShopContent(site, shopData, orders) {
  if (!orders || orders.length === 0) {
    return '<p style="color:#888;font-size:12px;padding:16px 0;text-align:center;">주문 데이터가 없습니다.</p>';
  }

  // 요약 카드
  let totalAmount = 0;
  let totalSettlement = 0;
  let totalReceiptCount = 0;
  orders.forEach(o => {
    const amt = o.salePrice || o.menuAmount || o.totalPayment || o.amount || 0;
    totalAmount += amt;
    totalSettlement += (o.actuallyAmount || o.settlementAmount || 0);
    if (o.receiptCount) totalReceiptCount += o.receiptCount;
  });

  const isOkpos = site === 'okpos';

  let html = '<div class="shop-summary">';
  html += `<div class="shop-summary-item"><div class="shop-summary-label">${isOkpos ? '영수건수' : '주문 건수'}</div><div class="shop-summary-value">${isOkpos ? totalReceiptCount : orders.length}건</div></div>`;
  html += `<div class="shop-summary-item"><div class="shop-summary-label">총 매출</div><div class="shop-summary-value">${totalAmount.toLocaleString()}원</div></div>`;
  if (totalSettlement > 0) {
    html += `<div class="shop-summary-item"><div class="shop-summary-label">${isOkpos ? '실매출' : '정산 예정'}</div><div class="shop-summary-value" style="color:#2563eb;">${totalSettlement.toLocaleString()}원</div></div>`;
  }
  html += '</div>';

  // 테이블 렌더
  html += renderData(shopData);
  return html;
}

// ── 플랫폼별 데이터 정규화 (공통 표시 형식으로 변환) ──
function normalizeForDisplay(data) {
  const site = data.site;

  // 배민: API 인터셉트 데이터 (주문+정산 동시 수집)
  if (site === 'baemin') {
    if (data.apiOrders?.length > 0) {
      return data.apiOrders.map(o => {
        const channelMap = { DELIVERY: '배달', TAKEOUT: '포장', HALL: '홀' };
        const payMap = { BARO: '바로결제', MEET: '만나서결제' };
        return {
          date: o.orderedAt ? formatDateTime(o.orderedAt) : '',
          orderNo: o.orderId || '',
          orderSummary: o.menuSummary || '',
          amount: o.menuAmount || 0,
          channel: channelMap[o.channel] || o.channel || '',
          paymentMethod: payMap[o.paymentMethod] || o.paymentMethod || '',
          deliveryTip: o.deliveryTip || 0,
          instantDiscount: o.instantDiscount || 0,
          commissionFee: o.commissionFee || 0,
          pgFee: o.pgFee || 0,
          deliveryCost: o.deliveryCost || 0,
          vat: o.vat || 0,
          meetPayment: o.meetPayment || 0,
          platformDiscount: o.platformDiscount || 0,
          settlementAmount: o.settlementAmount || 0,
          settlementDate: o.settlementDate || '',
        };
      });
    }
    return null;
  }

  // 요기요: API 인터셉트 데이터 (주문+정산 동시 수집)
  if (site === 'yogiyo') {
    if (data.apiOrders?.length > 0) {
      return data.apiOrders.map(o => ({
        date: o.orderedAt ? formatDateTime(o.orderedAt) : '',
        orderNo: o.orderId || '',
        orderSummary: o.menuSummary || '',
        amount: o.menuAmount || 0,
        channel: o.channel || '',
        paymentMethod: o.paymentMethod || '',
        commissionFee: o.commissionFee || 0,
        pgFee: o.pgFee || 0,
        deliveryCost: o.deliveryCost || 0,
        adFee: o.adFee || 0,
        vat: o.vat || 0,
        storeDiscount: o.storeDiscount || 0,
        settlementAmount: o.settlementAmount || 0,
        settlementDate: o.settlementDate || '',
      }));
    }
    return null;
  }

  // 쿠팡이츠: XHR API 데이터 (settlement 객체 포함)
  if (site === 'coupangeats') {
    const orders = data.apiOrders || data.orders;
    if (orders?.length > 0) {
      return orders.map(o => {
        // DOM 스크래핑 형식: date+time / API 형식: orderedAt
        let dateStr = '';
        if (o.orderedAt) {
          dateStr = formatDateTime(o.orderedAt);
        } else if (o.date && o.time) {
          dateStr = o.time;
        } else if (o.date) {
          dateStr = o.date;
        }

        // settlement 객체에서 정산 상세 추출
        const s = o.settlement || {};

        return {
          date: dateStr,
          orderNo: o.orderId || '',
          orderSummary: o.menuSummary || '',
          amount: o.salePrice || o.totalPayment || o.amount || 0,
          commissionFee: s.serviceSupplyPrice || o.commissionFee || 0,
          pgFee: s.paymentSupplyPrice || o.pgFee || 0,
          deliveryCost: s.deliverySupplyPrice || o.deliveryCost || 0,
          adFee: s.advertisingSupplyPrice || o.adFee || 0,
          storeDiscount: s.storePromotionAmount || o.storeDiscount || 0,
          settlementAmount: o.actuallyAmount || o.settlementAmount || 0,
          settlementDate: s.settlementDueDate || o.settlementDate || o.settlementStatus || '',
        };
      });
    }
    return null;
  }

  // 땡겨요: API 인터셉트 데이터
  if (site === 'ddangyoyo') {
    const orders = data.apiOrders || data.orders;
    if (orders?.length > 0) {
      return orders.map(o => ({
        date: o.orderedAt ? formatDateTime(o.orderedAt) : '',
        orderNo: o.orderId || '',
        orderSummary: o.menuSummary || '',
        amount: o.menuAmount || 0,
        channel: o.channel || '',
        commissionFee: o.totalFee || 0,
        settlementAmount: o.settlementAmount || 0,
      }));
    }
    return null;
  }

  // OKPOS: POS 매출 데이터
  if (site === 'okpos') {
    const orders = data.apiOrders || data.orders;
    if (orders?.length > 0) {
      return orders.map(o => ({
        date: o.date || '',
        orderNo: '',
        orderSummary: `영수 ${o.receiptCount || 0}건`,
        amount: o.totalSaleAmount || 0,
        commissionFee: 0,
        pgFee: 0,
        deliveryCost: 0,
        settlementAmount: o.netSaleAmount || 0,
        settlementDate: o.date || '',
        // POS 전용
        cardAmount: o.cardAmount || 0,
        cashAmount: o.cashAmount || 0,
        vatAmount: o.vatAmount || 0,
      }));
    }
    return null;
  }

  return null;
}

function formatDateTime(isoStr) {
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    const h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? '오후' : '오전';
    const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    return `${ampm} ${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  } catch {
    return String(isoStr);
  }
}

function renderData(data) {
  // 플랫폼별 정규화된 주문 데이터 생성
  const normalized = normalizeForDisplay(data);
  if (normalized && normalized.length > 0) {
    return renderNormalizedTable(data, normalized);
  }
  if (data.tables && data.tables.length > 0) return data.tables.map(t => renderTable(t)).join('');
  if (data.items && data.items.length > 0) {
    return `<div style="font-size:12px;">${data.items.map((item, i) =>
      `<div style="padding:6px 0;border-bottom:1px solid #f3f4f6;">[${i+1}] ${escapeHtml(item.text || JSON.stringify(item))}</div>`
    ).join('')}</div>`;
  }
  return `<pre id="result-json">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
}

function renderNormalizedTable(data, orders) {
  let html = '';

  // 요약 정보
  if (data.summary && Object.keys(data.summary).length > 0) {
    html += '<div style="display:flex;gap:16px;margin-bottom:16px;">';
    for (const [key, val] of Object.entries(data.summary)) {
      const unit = key.includes('수') ? '건' : '원';
      html += `<div style="flex:1;background:#f0fdf4;border-radius:8px;padding:12px 16px;text-align:center;">
        <div style="font-size:11px;color:#666;margin-bottom:4px;">${escapeHtml(key)}</div>
        <div style="font-size:18px;font-weight:700;color:#059669;">${escapeHtml(String(val))}${unit}</div>
      </div>`;
    }
    html += '</div>';
  }

  // 정산 상세 표시 여부
  const hasSettlement = orders.some(o => o.commissionFee || o.settlementAmount);
  const allDetailKeys = ['commissionFee', 'pgFee', 'deliveryCost', 'adFee', 'vat', 'storeDiscount', 'instantDiscount', 'cupDeposit', 'favorableFee', 'platformDiscount', 'meetPayment', 'settlementAmount', 'settlementDate'];
  const allDetailHeaders = ['중개이용료', '결제수수료', '배달비', '광고비', '부가세', '가게할인', '즉시할인', '일회용컵', '우대수수료', '플랫폼할인', '만나서결제', '정산예정', '정산일'];

  // 데이터가 있는 컬럼만 표시 (settlementAmount/settlementDate는 항상 표시)
  const alwaysShow = new Set(['settlementAmount', 'settlementDate']);
  const activeIdx = [];
  allDetailKeys.forEach((key, i) => {
    if (alwaysShow.has(key) || orders.some(o => o[key])) activeIdx.push(i);
  });
  const detailKeys = activeIdx.map(i => allDetailKeys[i]);
  const detailHeaders = activeIdx.map(i => allDetailHeaders[i]);
  const detailColCount = detailKeys.length;

  html += '<div style="overflow-x:auto;">';
  html += `<table class="order-table" style="min-width:${hasSettlement ? (600 + detailColCount * 95) : '600'}px;">`;
  const hasChannel = orders.some(o => o.channel || o.paymentMethod);
  html += '<thead><tr>';
  ['주문일', '주문번호', '주문내역', '매출액'].forEach(h => { html += `<th>${h}</th>`; });
  if (hasChannel) ['유형', '결제'].forEach(h => { html += `<th>${h}</th>`; });
  if (hasSettlement) detailHeaders.forEach(h => { html += `<th style="text-align:right;">${h}</th>`; });
  html += '</tr></thead><tbody>';

  let totalAmount = 0;
  const detailTotals = {};
  detailKeys.forEach(k => { detailTotals[k] = 0; });

  orders.forEach(order => {
    const amt = typeof order.amount === 'number' ? order.amount : (parseInt(String(order.amount || '0').replace(/,/g, ''), 10) || 0);
    totalAmount += amt;
    html += '<tr>';
    html += `<td style="white-space:nowrap;">${escapeHtml(order.date || '')}</td>`;
    html += `<td style="font-family:monospace;font-weight:600;">${escapeHtml(order.orderNo || '')}</td>`;
    html += `<td>${escapeHtml(order.orderSummary || '')}</td>`;
    html += `<td class="amount" style="text-align:right;white-space:nowrap;">${amt.toLocaleString()}원</td>`;
    if (hasChannel) {
      html += `<td style="white-space:nowrap;">${escapeHtml(order.channel || '')}</td>`;
      html += `<td style="white-space:nowrap;">${escapeHtml(order.paymentMethod || '')}</td>`;
    }

    if (hasSettlement) {
      detailKeys.forEach(key => {
        if (key === 'settlementDate') {
          html += `<td style="text-align:center;white-space:nowrap;font-size:11px;color:#6b7280;">${escapeHtml(order[key] || '-')}</td>`;
          return;
        }
        const val = order[key] || 0;
        detailTotals[key] += val;
        if (val) {
          const isSettlement = key === 'settlementAmount';
          const isPositive = key === 'platformDiscount' || key === 'meetPayment';
          const color = isSettlement ? '#2563eb' : isPositive ? '#059669' : '#dc2626';
          const weight = isSettlement ? '600' : '400';
          const displayVal = isSettlement || isPositive ? val : -Math.abs(val);
          html += `<td style="text-align:right;white-space:nowrap;color:${color};font-weight:${weight};">${displayVal.toLocaleString()}원</td>`;
        } else {
          html += '<td style="text-align:right;color:#d1d5db;">-</td>';
        }
      });
    }
    html += '</tr>';
  });

  html += '<tr class="total-row">';
  const baseColspan = hasChannel ? 5 : 3;
  html += `<td colspan="${baseColspan}" style="text-align:right;">합계 (${orders.length}건)</td>`;
  html += `<td class="amount" style="text-align:right;">${totalAmount.toLocaleString()}원</td>`;
  if (hasSettlement) {
    detailKeys.forEach(key => {
      if (key === 'settlementDate') {
        html += '<td></td>';
        return;
      }
      const total = detailTotals[key];
      if (total !== 0) {
        const isSettlement = key === 'settlementAmount';
        const isPositive = key === 'platformDiscount' || key === 'meetPayment';
        const color = isSettlement ? '#2563eb' : isPositive ? '#059669' : '#dc2626';
        const displayVal = isSettlement || isPositive ? total : -Math.abs(total);
        html += `<td style="text-align:right;font-weight:700;color:${color};">${displayVal.toLocaleString()}원</td>`;
      } else {
        html += '<td style="text-align:right;color:#d1d5db;">-</td>';
      }
    });
  }
  html += '</tr></tbody></table></div>';
  return html;
}

function renderTable(tableData) {
  const { headers, rows } = tableData;
  if (!rows || rows.length === 0) return '<p style="color:#888;font-size:12px;">데이터 없음</p>';
  const amountIdx = headers.findIndex(h => h.includes('금액') || h.includes('결제') || h.includes('매출'));
  let totalAmount = 0;
  let html = '<table class="order-table"><thead><tr>';
  headers.forEach(h => { html += `<th>${escapeHtml(h)}</th>`; });
  html += '</tr></thead><tbody>';
  rows.forEach(row => {
    if (row.length === 1 && row[0].length > 100) return;
    html += '<tr>';
    row.forEach((cell, idx) => {
      const isAmount = idx === amountIdx || (cell.includes('원') && /[\d,]+원/.test(cell));
      if (isAmount) {
        const num = parseInt(cell.replace(/[^0-9]/g, ''), 10) || 0;
        totalAmount += num;
        html += `<td class="amount">${escapeHtml(cell)}</td>`;
      } else {
        html += `<td>${escapeHtml(cell.replace(/\n+/g, ' ').substring(0, 80))}</td>`;
      }
    });
    html += '</tr>';
  });
  if (totalAmount > 0) {
    html += `<tr class="total-row"><td colspan="${headers.length - 1}" style="text-align:right;">합계</td><td class="amount">${totalAmount.toLocaleString()}원</td></tr>`;
  }
  html += '</tbody></table>';
  return html;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── JSON 내보내기 ──
document.getElementById('btnExport').addEventListener('click', async () => {
  const { results, errors } = await window.crawler.getResults();
  if (!results || Object.keys(results).length === 0) { alert('내보낼 데이터가 없습니다.'); return; }
  const data = { exportedAt: new Date().toISOString(), results, errors: errors || [] };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sales-data-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ── 엑셀 내보내기 ──
document.getElementById('btnExportExcel').addEventListener('click', async () => {
  const { results, errors } = await window.crawler.getResults();
  if (!results || Object.keys(results).length === 0) { alert('내보낼 데이터가 없습니다.'); return; }

  const btn = document.getElementById('btnExportExcel');
  btn.disabled = true;
  btn.textContent = '저장 중...';

  try {
    const res = await window.crawler.exportExcel({
      exportedAt: new Date().toISOString(),
      results,
      errors: errors || [],
    });
    if (res.success) {
      document.getElementById('status').textContent = '엑셀 저장 완료: ' + res.path;
    } else if (!res.cancelled) {
      alert('엑셀 저장 실패: ' + (res.error || ''));
    }
  } catch (err) {
    alert('엑셀 저장 실패: ' + err.message);
  }

  btn.disabled = false;
  btn.textContent = '엑셀 내보내기';
});

// ── 초기화 ──
document.getElementById('btnClear').addEventListener('click', async () => {
  if (!confirm('결과를 모두 초기화하시겠습니까?')) return;
  await window.crawler.clearResults();
  allResults = {};
  activeTab = null;
  activeShopTab = {};
  document.getElementById('result-area').style.display = 'none';
  document.getElementById('status').textContent = '초기화 완료';
  updateAllCards();
});

// ── 초기 로드 ──
(async () => {
  // 크롤링 결과
  const { results } = await window.crawler.getResults();
  if (results && Object.keys(results).length > 0) {
    allResults = results;
    Object.keys(results).forEach(site => {
      const card = document.getElementById(`card-${site}`);
      const badge = document.getElementById(`badge-${site}`);
      if (card && badge) {
        card.className = 'platform-card received';
        badge.className = 'platform-badge badge-ok';
        badge.textContent = `${Object.keys(results[site]).length}개 페이지`;
      }
    });
    renderResults();
  }

  // 저장된 계정 정보 로드
  const storeId = sessionStorage.getItem('selectedStoreId');
  const creds = await window.crawler.getCredentials(storeId);
  if (creds) {
    ALL_SITES.forEach(site => {
      if (creds[site]) {
        document.getElementById(`cred-${site}-id`).value = creds[site].id || '';
        document.getElementById(`cred-${site}-pw`).value = creds[site].pw || '';
      }
    });
  }
  updateAllCards();

  // 스케줄러 상태 로드
  loadSchedulerStatus();
})();

// ── 스케줄러 상태 UI ──
async function loadSchedulerStatus() {
  try {
    const status = await window.crawler.getSchedulerStatus();
    updateSchedulerUI(status);
  } catch {}
}

function updateSchedulerUI(status) {
  const dot = document.getElementById('schedulerDot');
  const info = document.getElementById('schedulerInfo');
  if (!dot || !info) return;

  if (status.enabled) {
    dot.classList.add('active');
    let text = '<strong>1시간 단위</strong> 자동 수집 활성';
    if (status.lastRunDate) {
      text += ` | 마지막 수집: ${status.lastRunDate}`;
    }
    info.innerHTML = text;
  } else {
    dot.classList.remove('active');
    info.textContent = '자동 수집 비활성';
  }

  // 백필 상태
  const backfillArea = document.getElementById('backfillArea');
  if (status.isBackfilling && status.backfillProgress) {
    const { total, completed, current } = status.backfillProgress;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    backfillArea.style.display = 'block';
    document.getElementById('backfillFill').style.width = pct + '%';
    document.getElementById('backfillText').textContent =
      `과거 데이터 수집 중: ${completed}/${total}일 완료${current ? ` (${current})` : ''}`;
  } else if (backfillArea) {
    backfillArea.style.display = 'none';
  }
}

// 스케줄러 업데이트 이벤트 수신
window.crawler.onSchedulerUpdate((data) => {
  if (data.type === 'backfill-progress' || data.type === 'backfill-start') {
    const backfillArea = document.getElementById('backfillArea');
    if (backfillArea) backfillArea.style.display = 'block';
    if (data.total != null && data.completed != null) {
      const pct = data.total > 0 ? Math.round((data.completed / data.total) * 100) : 0;
      document.getElementById('backfillFill').style.width = pct + '%';
      document.getElementById('backfillText').textContent =
        `과거 데이터 수집 중: ${data.completed}/${data.total}일 완료${data.current ? ` (${data.current})` : ''}`;
    }
  } else if (data.type === 'backfill-done' || data.type === 'backfill-error') {
    const backfillArea = document.getElementById('backfillArea');
    if (backfillArea) backfillArea.style.display = 'none';
    loadSchedulerStatus();
  } else if (data.type === 'daily-done' || data.type === 'daily-error') {
    loadSchedulerStatus();
  }
});
