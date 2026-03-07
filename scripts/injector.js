// executeJavaScript()용 스크립트 문자열 생성 모듈
'use strict';

// ─── 공통 유틸리티 (extractor.js 기반) ──────────────────────────
function getExtractorScript() {
  return `
    (function() {
      window._extractTables = function(containerSelector) {
        const container = containerSelector ? document.querySelector(containerSelector) : document;
        if (!container) return [];
        const tables = container.querySelectorAll('table');
        const result = [];

        tables.forEach((table, idx) => {
          const headers = [];
          const rows = [];

          table.querySelectorAll('thead th').forEach(th => {
            headers.push(th.innerText.trim());
          });

          table.querySelectorAll('tbody tr').forEach(tr => {
            const cells = [];
            tr.querySelectorAll('td').forEach(td => {
              cells.push(td.innerText.trim());
            });
            if (cells.length > 0) rows.push(cells);
          });

          if (headers.length === 0) {
            const firstRow = table.querySelector('tr');
            if (firstRow) {
              firstRow.querySelectorAll('th, td').forEach(cell => {
                headers.push(cell.innerText.trim());
              });
              if (rows.length > 0 && rows[0].join('') === headers.join('')) {
                rows.shift();
              }
            }
          }

          if (rows.length > 0 || headers.length > 0) {
            result.push({ tableIndex: idx, headers, rows });
          }
        });

        return result;
      };

      window._extractListItems = function(selector, fieldSelectors) {
        const items = document.querySelectorAll(selector);
        const result = [];
        items.forEach(item => {
          const data = {};
          if (fieldSelectors) {
            Object.entries(fieldSelectors).forEach(([key, sel]) => {
              const el = item.querySelector(sel);
              data[key] = el ? el.innerText.trim() : null;
            });
          } else {
            data.text = item.innerText.trim().substring(0, 500);
          }
          result.push(data);
        });
        return result;
      };

      window._parseAmount = function(str) {
        if (!str) return 0;
        const cleaned = str.replace(/[^0-9\\-]/g, '');
        return parseInt(cleaned, 10) || 0;
      };

      window._waitForElement = function(selector, timeout) {
        timeout = timeout || 10000;
        return new Promise((resolve, reject) => {
          const existing = document.querySelector(selector);
          if (existing) return resolve(existing);
          const observer = new MutationObserver(() => {
            const el = document.querySelector(selector);
            if (el) {
              observer.disconnect();
              resolve(el);
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => {
            observer.disconnect();
            reject(new Error('"' + selector + '" not found within ' + timeout + 'ms'));
          }, timeout);
        });
      };

      true;
    })();
  `;
}

// ─── 자동 로그인 스크립트 ────────────────────────────────────────
function getAutoLoginScript(loginId, loginPw) {
  const idEscaped = JSON.stringify(loginId);
  const pwEscaped = JSON.stringify(loginPw);

  return `
    (async function() {
      await new Promise(r => setTimeout(r, 1000));

      const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
      let idInput = null;
      let pwInput = null;

      inputs.forEach(input => {
        const type = (input.type || '').toLowerCase();
        const autocomplete = (input.autocomplete || '').toLowerCase();
        if (type === 'password' || autocomplete === 'current-password' || autocomplete === 'new-password') {
          pwInput = input;
        }
      });

      inputs.forEach(input => {
        if (input === pwInput) return;
        const type = (input.type || '').toLowerCase();
        if (type !== 'submit' && type !== 'button' && type !== 'file' && type !== 'image') {
          if (!idInput) idInput = input;
        }
      });

      if (!idInput || !pwInput) {
        const visible = Array.from(inputs).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (visible.length >= 2) {
          idInput = idInput || visible[0];
          pwInput = pwInput || visible[1];
        }
      }

      if (!idInput || !pwInput) {
        return { success: false, error: 'ID/PW 입력란 없음 (input ' + inputs.length + '개)' };
      }

      function setVal(el, val) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      idInput.focus();
      setVal(idInput, ${idEscaped});
      pwInput.focus();
      setVal(pwInput, ${pwEscaped});

      await new Promise(r => setTimeout(r, 500));

      const btns = document.querySelectorAll('button, input[type="submit"], a');
      let loginBtn = null;
      btns.forEach(btn => {
        const text = (btn.innerText || btn.value || '').trim();
        if (text.includes('로그인') || text.includes('Login') || text.includes('Sign in') || text === '확인') {
          if (!loginBtn) loginBtn = btn;
        }
      });
      if (!loginBtn) loginBtn = document.querySelector('button[type="submit"], input[type="submit"]');

      if (loginBtn) {
        loginBtn.click();
        return { success: true, clicked: loginBtn.innerText || loginBtn.value };
      }

      const form = idInput.closest('form') || pwInput.closest('form');
      if (form) {
        form.submit();
        return { success: true, method: 'form-submit' };
      }

      return { success: false, error: '로그인 버튼 없음' };
    })()
  `;
}

// ─── 로그인 상태 확인 스크립트 ───────────────────────────────────
function getCheckLoginScript(siteKey) {
  return `
    (function() {
      const url = location.href;
      if (url.includes('/login') || url.includes('/signin')) return false;
      ${siteKey === 'coupangeats' ? `
      // 쿠팡이츠: 루트(/)이면 아직 로그인 안 됨, /merchant/가 있으면 로그인됨
      const u = new URL(url);
      if (u.pathname === '/' || u.pathname === '') return false;
      if (url.includes('/merchant/')) return true;
      ` : ''}
      const hasNav = document.querySelector('nav, [class*="gnb"], [class*="header"] [class*="user"], [class*="profile"], [class*="sidebar"], [class*="lnb"], [class*="menu"]');
      const notLoginPage = !document.querySelector('[class*="login-form"], [class*="login-container"], [class*="LoginPage"], [class*="signin"]');
      return !!(hasNav || notLoginPage);
    })()
  `;
}

// ─── 배민 추출 스크립트 ──────────────────────────────────────────
function getBaeminExtractScript() {
  return `
    (async function() {
      const url = location.href;
      let pageType = 'generic';
      if (url.includes('/orders/history')) pageType = 'orderHistory';

      if (pageType === 'orderHistory') {
        try {
          await window._waitForElement('table, [class*="order"], [class*="list"], [class*="history"]', 15000);
        } catch {}
        await new Promise(r => setTimeout(r, 2000));

        const tables = window._extractTables();
        if (tables.length > 0) {
          return {
            success: true,
            site: 'baemin',
            pageType: 'orderHistory',
            extractedAt: new Date().toISOString(),
            url: location.href,
            title: document.title,
            tables,
          };
        }

        const listItems = document.querySelectorAll('[class*="order-item"], [class*="list-item"], [class*="row"]');
        if (listItems.length > 0) {
          const items = Array.from(listItems).map(item => ({
            text: item.innerText.trim().substring(0, 500),
          }));
          return {
            success: true,
            site: 'baemin',
            pageType: 'orderHistory',
            extractedAt: new Date().toISOString(),
            url: location.href,
            title: document.title,
            items,
          };
        }
      }

      return {
        success: true,
        site: 'baemin',
        pageType: pageType === 'generic' ? 'generic' : pageType,
        extractedAt: new Date().toISOString(),
        url: location.href,
        title: document.title,
        tables: window._extractTables(),
        bodyPreview: document.body.innerText.substring(0, 5000),
      };
    })()
  `;
}

// ─── 요기요 추출 스크립트 ────────────────────────────────────────
function getYogiyoExtractScript() {
  return `
    (async function() {
      const url = location.href;
      let pageType = 'generic';
      if (url.includes('order-history') || url.includes('order_history')) pageType = 'orderHistory';

      if (pageType === 'orderHistory') {
        try {
          await window._waitForElement('table', 15000);
        } catch {
          try {
            await window._waitForElement('[class*="order"], [class*="list"], [class*="row"]', 15000);
          } catch {}
        }
        await new Promise(r => setTimeout(r, 3000));

        const summaryText = document.body.innerText;
        const totalOrderMatch = summaryText.match(/총\\s*주문\\s*(\\d+)\\s*건/);
        const totalAmountMatch = summaryText.match(/총\\s*주문금액\\s*([\\d,]+)\\s*원/);
        const summary = {};
        if (totalOrderMatch) summary['총 주문'] = totalOrderMatch[1] + '건';
        if (totalAmountMatch) summary['총 주문금액'] = totalAmountMatch[1] + '원';

        const tables = window._extractTables();
        if (tables.length > 0) {
          return {
            success: true,
            site: 'yogiyo',
            pageType: 'orderHistory',
            extractedAt: new Date().toISOString(),
            url: location.href,
            title: document.title,
            summary,
            tables,
          };
        }

        const rows = document.querySelectorAll('tr, [class*="order-item"], [class*="list-row"], [class*="row"]');
        if (rows.length > 2) {
          const items = Array.from(rows).map(row => ({
            text: row.innerText.trim().substring(0, 500),
          })).filter(item => item.text.length > 5);
          return {
            success: true,
            site: 'yogiyo',
            pageType: 'orderHistory',
            extractedAt: new Date().toISOString(),
            url: location.href,
            title: document.title,
            summary,
            items,
          };
        }
      }

      return {
        success: true,
        site: 'yogiyo',
        pageType: pageType === 'generic' ? 'generic' : pageType,
        extractedAt: new Date().toISOString(),
        url: location.href,
        title: document.title,
        tables: window._extractTables(),
        bodyPreview: document.body.innerText.substring(0, 5000),
      };
    })()
  `;
}

// ─── 쿠팡이츠 주문내역 추출 스크립트 ─────────────────────────────
function getCoupangeatsOrderExtractScript() {
  return `
    (async function() {
      // SPA 렌더링 대기
      try {
        await window._waitForElement('table, [class*="order"], [class*="list"], [class*="row"], [class*="content"]', 15000);
      } catch {}
      await new Promise(r => setTimeout(r, 3000));

      const tables = window._extractTables();

      // 요약 정보 추출
      const bodyText = document.body.innerText;
      const summary = {};
      const countMatch = bodyText.match(/(\\d+)\\s*건/);
      const amountMatch = bodyText.match(/([\\d,]+)\\s*원/);
      if (countMatch) summary['건수'] = countMatch[1];
      if (amountMatch) summary['금액'] = amountMatch[1];

      if (tables.length > 0) {
        return {
          success: true,
          site: 'coupangeats',
          pageType: 'orders',
          extractedAt: new Date().toISOString(),
          url: location.href,
          title: document.title,
          summary,
          tables,
        };
      }

      // 테이블 없으면 리스트/카드 형태 추출
      const listItems = document.querySelectorAll('[class*="order"], [class*="item"], [class*="card"], [class*="row"]');
      if (listItems.length > 0) {
        const items = Array.from(listItems).map(item => ({
          text: item.innerText.trim().substring(0, 500),
        })).filter(item => item.text.length > 5);
        if (items.length > 0) {
          return {
            success: true,
            site: 'coupangeats',
            pageType: 'orders',
            extractedAt: new Date().toISOString(),
            url: location.href,
            title: document.title,
            summary,
            items,
          };
        }
      }

      // 폴백
      return {
        success: true,
        site: 'coupangeats',
        pageType: 'orders',
        extractedAt: new Date().toISOString(),
        url: location.href,
        title: document.title,
        summary,
        tables: [],
        bodyPreview: document.body.innerText.substring(0, 5000),
      };
    })()
  `;
}

// ─── 쿠팡이츠 정산내역 추출 스크립트 ─────────────────────────────
function getCoupangeatsSettlementExtractScript() {
  return `
    (async function() {
      // SPA 렌더링 대기
      try {
        await window._waitForElement('table, [class*="settlement"], [class*="list"], [class*="content"]', 15000);
      } catch {}
      await new Promise(r => setTimeout(r, 3000));

      const tables = window._extractTables();

      // 요약 정보 추출
      const bodyText = document.body.innerText;
      const summary = {};
      const totalMatch = bodyText.match(/정산\\s*금액\\s*([\\d,]+)/);
      const countMatch = bodyText.match(/(\\d+)\\s*건/);
      if (totalMatch) summary['정산 금액'] = totalMatch[1];
      if (countMatch) summary['건수'] = countMatch[1];

      if (tables.length > 0) {
        return {
          success: true,
          site: 'coupangeats',
          pageType: 'settlement',
          extractedAt: new Date().toISOString(),
          url: location.href,
          title: document.title,
          summary,
          tables,
        };
      }

      // 리스트 형태 폴백
      const listItems = document.querySelectorAll('[class*="settlement"], [class*="item"], [class*="card"], [class*="row"]');
      if (listItems.length > 0) {
        const items = Array.from(listItems).map(item => ({
          text: item.innerText.trim().substring(0, 500),
        })).filter(item => item.text.length > 5);
        if (items.length > 0) {
          return {
            success: true,
            site: 'coupangeats',
            pageType: 'settlement',
            extractedAt: new Date().toISOString(),
            url: location.href,
            title: document.title,
            summary,
            items,
          };
        }
      }

      // 폴백
      return {
        success: true,
        site: 'coupangeats',
        pageType: 'settlement',
        extractedAt: new Date().toISOString(),
        url: location.href,
        title: document.title,
        summary,
        tables: [],
        bodyPreview: document.body.innerText.substring(0, 5000),
      };
    })()
  `;
}

module.exports = {
  getExtractorScript,
  getAutoLoginScript,
  getCheckLoginScript,
  getBaeminExtractScript,
  getYogiyoExtractScript,
  getCoupangeatsOrderExtractScript,
  getCoupangeatsSettlementExtractScript,
};
