const ALL_SITES = ['baemin', 'yogiyo', 'coupangeats', 'ddangyoyo'];
const CRAWL_SITES = ['baemin', 'yogiyo', 'coupangeats', 'ddangyoyo'];
const SITE_NAMES = { baemin: '배민', yogiyo: '요기요', coupangeats: '쿠팡이츠', ddangyoyo: '땡겨요' };
const PAGE_NAMES = {
  orderHistory: '주문내역', orders: '주문내역', settlement: '정산',
  billing: '정산', sales: '매출', generic: '전체',
};

let allResults = {};
let activeTab = null;

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

// ── 결과 렌더링 ──
function renderResults() {
  const area = document.getElementById('result-area');
  const tabsEl = document.getElementById('result-tabs');
  const contentEl = document.getElementById('result-content');

  const tabs = [];
  for (const [site, pages] of Object.entries(allResults)) {
    for (const [page, data] of Object.entries(pages)) {
      const siteName = SITE_NAMES[site] || site;
      const pageName = PAGE_NAMES[page] || page;
      tabs.push({ key: `${site}-${page}`, label: `${siteName} ${pageName}`, data });
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
  if (current) contentEl.innerHTML = renderData(current.data);
}

function renderData(data) {
  if (data.orders && data.orders.length > 0) return renderOrdersTable(data);
  if (data.tables && data.tables.length > 0) return data.tables.map(t => renderTable(t)).join('');
  if (data.items && data.items.length > 0) {
    return `<div style="font-size:12px;">${data.items.map((item, i) =>
      `<div style="padding:6px 0;border-bottom:1px solid #f3f4f6;">[${i+1}] ${escapeHtml(item.text || JSON.stringify(item))}</div>`
    ).join('')}</div>`;
  }
  return `<pre id="result-json">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
}

function renderOrdersTable(data) {
  const { summary, orders } = data;
  let html = '';

  if (summary && Object.keys(summary).length > 0) {
    html += '<div style="display:flex;gap:16px;margin-bottom:16px;">';
    for (const [key, val] of Object.entries(summary)) {
      const unit = key.includes('수') ? '건' : '원';
      html += `<div style="flex:1;background:#f0fdf4;border-radius:8px;padding:12px 16px;text-align:center;">
        <div style="font-size:11px;color:#666;margin-bottom:4px;">${escapeHtml(key)}</div>
        <div style="font-size:18px;font-weight:700;color:#059669;">${escapeHtml(val)}${unit}</div>
      </div>`;
    }
    html += '</div>';
  }

  const detailKeys = ['상점부담쿠폰금액', '중개이용료', '결제대행사수수료', '배달비', '부가세', '즉시할인금액', '정산예정금액'];
  const detailHeaders = ['쿠폰', '중개이용료', '결제수수료', '배달비', '부가세', '즉시할인', '정산예정'];

  html += '<div style="overflow-x:auto;">';
  html += '<table class="order-table" style="min-width:900px;">';
  html += '<thead><tr>';
  ['주문일', '주문번호', '주문내역', '매출액'].forEach(h => { html += `<th>${h}</th>`; });
  detailHeaders.forEach(h => { html += `<th style="text-align:right;">${h}</th>`; });
  html += '</tr></thead><tbody>';

  let totalAmount = 0;
  const detailTotals = {};
  detailKeys.forEach(k => { detailTotals[k] = 0; });

  orders.forEach(order => {
    const amt = parseInt((order.amount || '0').replace(/,/g, ''), 10) || 0;
    totalAmount += amt;
    html += '<tr>';
    html += `<td style="white-space:nowrap;">${escapeHtml(order.date || '')}</td>`;
    html += `<td style="font-family:monospace;font-weight:600;">${escapeHtml(order.orderNo || '')}</td>`;
    html += `<td>${escapeHtml(order.orderSummary || '')}</td>`;
    html += `<td class="amount" style="text-align:right;white-space:nowrap;">${escapeHtml(order.amount || '')}원</td>`;
    detailKeys.forEach(key => {
      const val = order.details?.[key];
      if (val) {
        const num = parseInt(val.replace(/,/g, ''), 10) || 0;
        detailTotals[key] += num;
        const color = num < 0 ? '#dc2626' : (key === '정산예정금액' ? '#2563eb' : '#374151');
        const weight = key === '정산예정금액' ? '600' : '400';
        html += `<td style="text-align:right;white-space:nowrap;color:${color};font-weight:${weight};">${escapeHtml(val)}원</td>`;
      } else {
        html += '<td style="text-align:right;color:#d1d5db;">-</td>';
      }
    });
    html += '</tr>';
  });

  html += '<tr class="total-row">';
  html += `<td colspan="3" style="text-align:right;">합계 (${orders.length}건)</td>`;
  html += `<td class="amount" style="text-align:right;">${totalAmount.toLocaleString()}원</td>`;
  detailKeys.forEach(key => {
    const total = detailTotals[key];
    if (total !== 0) {
      const color = total < 0 ? '#dc2626' : (key === '정산예정금액' ? '#2563eb' : '#374151');
      html += `<td style="text-align:right;font-weight:700;color:${color};">${total.toLocaleString()}원</td>`;
    } else {
      html += '<td style="text-align:right;color:#d1d5db;">-</td>';
    }
  });
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

// ── 초기화 ──
document.getElementById('btnClear').addEventListener('click', async () => {
  if (!confirm('결과를 모두 초기화하시겠습니까?')) return;
  await window.crawler.clearResults();
  allResults = {};
  activeTab = null;
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
})();
