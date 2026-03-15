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

// ─── 배민 날짜 필터 적용 스크립트 ─────────────────────────────────
// /orders/history 페이지에서 전날 날짜로 필터 적용
// 플로우: "날짜 직접 선택" → "날짜" 탭(radio directly) → DatePicker 버튼 → 월 네비 → 날짜 2번 클릭 → 적용(캘린더) → 적용(모달)
// DOM 구조 (2026-03-09 진단 기준):
//   캘린더 테이블: table[class*="DatePicker_b_r4ax_g1sabv"]
//   월 헤더: <caption> "2026년 3월"
//   날짜 버튼: <button aria-label="8일"> inside <td class="DatePicker_b_r4ax_1qne6wi3">
//   월 네비: button[aria-label="이전 달"] / button[aria-label="다음 달"]
//   적용 버튼: 캘린더(w≈75) + 모달(w≈480)
function getBaeminDateFilterScript(targetDate) {
  // targetDate: 'YYYY-MM-DD'
  const dateJson = JSON.stringify(targetDate);
  return `
    (async function() {
      const targetDate = ${dateJson};
      const [targetYear, targetMonth, targetDay] = targetDate.split('-').map(Number);
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      console.log('[baemin-filter] 날짜 필터 시작:', targetDate);

      // 1. 프로모션 팝업 닫기
      const dismissBtn = Array.from(document.querySelectorAll('button'))
        .find(b => b.innerText.trim() === '오늘 하루 보지 않기');
      if (dismissBtn) { dismissBtn.click(); await sleep(1000); console.log('[baemin-filter] 팝업 닫음'); }

      // 2. "날짜 직접 선택" 버튼 클릭
      const dateSelectBtn = Array.from(document.querySelectorAll('button'))
        .find(el => el.innerText.includes('날짜 직접 선택'));
      if (!dateSelectBtn) return { success: false, error: '날짜 직접 선택 버튼 못 찾음' };
      dateSelectBtn.click();
      console.log('[baemin-filter] 날짜 직접 선택 클릭');
      await sleep(2000);

      // 3. "날짜" 탭 활성화 (radio value="directly")
      const directlyRadio = document.querySelector('input[type="radio"][value="directly"]');
      if (directlyRadio) {
        const label = directlyRadio.closest('label') || directlyRadio.parentElement;
        if (label) label.click(); else directlyRadio.click();
        console.log('[baemin-filter] 날짜 탭 클릭');
        await sleep(1000);
      }

      // 4. DatePicker 버튼 클릭 → 캘린더 열기
      const dpBtn = document.querySelector('button[class*="DatePicker_b_r4ax_14nnus3"]');
      if (dpBtn) {
        dpBtn.click();
        console.log('[baemin-filter] DatePicker 버튼 클릭:', dpBtn.innerText.trim());
        await sleep(1500);
      } else {
        // 폴백: SVG 근처 날짜 텍스트 버튼
        for (const svg of document.querySelectorAll('svg')) {
          const p = svg.closest('button') || svg.parentElement;
          if (p) {
            const t = p.parentElement?.innerText?.trim() || '';
            if (/\\d{4}\\.\\s*\\d{1,2}\\.\\s*\\d{1,2}.*~/.test(t) && t.length < 50) {
              p.click(); console.log('[baemin-filter] SVG 폴백 캘린더 열기'); break;
            }
          }
        }
        await sleep(1500);
      }

      // 5. 올바른 월로 네비게이션 (caption 기반)
      const targetMonthStr = targetYear + '년 ' + targetMonth + '월';
      for (let nav = 0; nav < 24; nav++) {
        const captions = Array.from(document.querySelectorAll('caption'))
          .map(c => c.innerText.trim())
          .filter(t => /\\d{4}년\\s*\\d{1,2}월/.test(t));
        if (captions.some(c => c.includes(targetMonthStr))) {
          console.log('[baemin-filter] 타겟 월 발견:', targetMonthStr, '표시:', captions.join(', '));
          break;
        }
        // 첫 번째 캡션에서 표시 연월 파싱
        const m = captions[0]?.match(/(\\d{4})년\\s*(\\d{1,2})월/);
        if (!m) break;
        const dispVal = Number(m[1]) * 12 + Number(m[2]);
        const targetVal = targetYear * 12 + targetMonth;
        const navLabel = targetVal < dispVal ? '이전 달' : '다음 달';
        const navBtn = Array.from(document.querySelectorAll('button'))
          .find(b => b.getAttribute('aria-label') === navLabel);
        if (navBtn) { navBtn.click(); await sleep(500); } else break;
      }

      // 6. 타겟 날짜 찾아서 2번 클릭
      const findDayBtn = () => {
        const tables = document.querySelectorAll('table[class*="DatePicker_b_r4ax_g1sabv"]');
        for (const table of tables) {
          const caption = table.querySelector('caption');
          if (!caption || !caption.innerText.includes(targetMonthStr)) continue;
          const btn = Array.from(table.querySelectorAll('button'))
            .find(b => b.getAttribute('aria-label') === targetDay + '일');
          if (btn) return btn;
        }
        // 폴백: aria-label만으로 찾기 (DatePicker 테이블 안)
        return Array.from(document.querySelectorAll('table button'))
          .find(b => b.getAttribute('aria-label') === targetDay + '일' && b.closest('table[class*="DatePicker"]'));
      };

      const btn1 = findDayBtn();
      if (!btn1) return { success: false, error: targetDay + '일 버튼 못 찾음' };
      btn1.click();
      console.log('[baemin-filter] 날짜 첫 번째 클릭:', targetDay + '일');
      await sleep(800);

      const btn2 = findDayBtn();
      if (btn2) {
        btn2.click();
        console.log('[baemin-filter] 날짜 두 번째 클릭:', targetDay + '일');
      }
      await sleep(800);

      // 7. 캘린더 "적용" 클릭 (작은 버튼, w < 200)
      const applyBtns = Array.from(document.querySelectorAll('button'))
        .filter(b => b.innerText.trim() === '적용')
        .map(b => ({ btn: b, w: b.getBoundingClientRect().width }));
      const calApply = applyBtns.find(a => a.w < 200) || applyBtns[applyBtns.length - 1];
      if (calApply) {
        calApply.btn.click();
        console.log('[baemin-filter] 캘린더 적용 클릭 (w=' + Math.round(calApply.w) + ')');
        await sleep(1500);
      }

      // 8. 모달 "적용" 클릭 (큰 버튼, w > 200 또는 유일한 적용)
      const applyBtns2 = Array.from(document.querySelectorAll('button'))
        .filter(b => b.innerText.trim() === '적용')
        .map(b => ({ btn: b, w: b.getBoundingClientRect().width }));
      const modalApply = applyBtns2.find(a => a.w > 200) || applyBtns2[0];
      if (modalApply) {
        modalApply.btn.click();
        console.log('[baemin-filter] 모달 적용 클릭 (w=' + Math.round(modalApply.w) + ')');
        await sleep(3000);
      }

      console.log('[baemin-filter] 날짜 필터 완료');
      return { success: true, targetDate };
    })()
  `;
}

// ─── 배민 API 인터셉트 설정 스크립트 ─────────────────────────────
// self-api.baemin.com API 응답을 캡처하는 fetch/XHR monkey-patch
function getBaeminInterceptScript() {
  return `
    (function() {
      if (window._baeminInterceptInstalled) return true;
      window._baeminInterceptInstalled = true;
      window._baeminCapturedResponses = [];

      // fetch 인터셉트
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
              window._baeminCapturedResponses.push({ url, data: json, ts: Date.now() });
            } catch {}
          } catch {}
        }
        return response;
      };

      // XMLHttpRequest 인터셉트
      const origXHROpen = XMLHttpRequest.prototype.open;
      const origXHRSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._interceptUrl = url;
        return origXHROpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
          const url = this._interceptUrl || '';
          if (url.includes('self-api.baemin.com') || url.includes('/api/')) {
            try {
              const json = JSON.parse(this.responseText);
              window._baeminCapturedResponses.push({ url, data: json, ts: Date.now() });
            } catch {}
          }
        });
        return origXHRSend.apply(this, args);
      };

      true;
    })();
  `;
}


// ─── 요기요 날짜 필터 적용 스크립트 ───────────────────────────────
// /order-history/list 페이지에서 전날 날짜로 필터 적용
// 플로우: react-datepicker input focus+click → "일별" → 캘린더 날짜 클릭 → "조회"
// DOM 구조 (2026-03-09 진단 기준):
//   드롭다운 열기: .react-datepicker__input-container input (focus+click)
//   일별 옵션: div[class*="getCustomCalendarCotainer__Shortcut"] text="일별"
//   날짜 셀: div.react-datepicker__day--00N, aria-label="Choose 2026년 3월 8일 일요일"
//   disabled: class includes "disabled"
//   조회 버튼: button text="조회"
function getYogiyoDateFilterScript(targetDate) {
  const dateJson = JSON.stringify(targetDate);
  return `
    (async function() {
      const targetDate = ${dateJson};
      const [targetYear, targetMonth, targetDay] = targetDate.split('-').map(Number);
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      console.log('[yogiyo-filter] 날짜 필터 시작:', targetDate);

      // 1. react-datepicker input focus+click → 드롭다운 열기
      const container = document.querySelector('.react-datepicker__input-container');
      if (!container) return { success: false, error: 'react-datepicker__input-container 못 찾음' };
      const input = container.querySelector('input');
      if (!input) return { success: false, error: 'react-datepicker input 못 찾음' };
      input.focus();
      input.click();
      console.log('[yogiyo-filter] 드롭다운 열기:', input.value);
      await sleep(1500);

      // 2. "일별" 클릭
      const dailyOption = Array.from(document.querySelectorAll('div, span'))
        .find(el => el.innerText.trim() === '일별' && el.offsetParent !== null && el.children.length === 0);
      if (dailyOption) {
        dailyOption.click();
        console.log('[yogiyo-filter] 일별 클릭');
        await sleep(2000);
      } else {
        console.log('[yogiyo-filter] 일별 옵션 못 찾음 — 직접설정 시도');
      }

      // 3. 캘린더에서 날짜 클릭 (react-datepicker__day)
      const findDayEl = () => {
        return Array.from(document.querySelectorAll('[class*="react-datepicker__day"]'))
          .find(el => {
            const t = el.innerText?.trim();
            const n = parseInt(t, 10);
            if (n !== targetDay) return false;
            const cls = el.className || '';
            // disabled, outside-month 제외
            if (cls.includes('disabled') || cls.includes('outside')) return false;
            // aria-label로 정확한 월 확인 가능
            const aria = el.getAttribute('aria-label') || '';
            if (aria && aria.includes(targetMonth + '월') && aria.includes(targetDay + '일')) return true;
            // aria 없으면 숫자만 일치 + disabled 아닌 것
            return n === targetDay;
          });
      };

      // 월 이동이 필요한 경우
      for (let nav = 0; nav < 12; nav++) {
        const dayEl = findDayEl();
        if (dayEl) {
          dayEl.click();
          console.log('[yogiyo-filter] 날짜 클릭:', targetDay + '일');
          await sleep(1000);
          break;
        }
        // 이전 달 버튼 (react-datepicker navigation)
        const prevBtn = document.querySelector('.react-datepicker__navigation--previous, [class*="navigation--previous"]')
          || Array.from(document.querySelectorAll('button'))
            .find(b => (b.getAttribute('aria-label') || '').includes('Previous') || (b.getAttribute('aria-label') || '').includes('이전'));
        if (prevBtn) {
          prevBtn.click();
          console.log('[yogiyo-filter] 이전 달 이동');
          await sleep(500);
        } else {
          console.log('[yogiyo-filter] 이전 달 버튼 못 찾음');
          break;
        }
      }

      // 4. "조회" 클릭
      await sleep(500);
      const searchBtn = Array.from(document.querySelectorAll('button'))
        .find(b => b.innerText.trim() === '조회' && b.offsetParent !== null);
      if (searchBtn) {
        searchBtn.click();
        console.log('[yogiyo-filter] 조회 클릭');
        await sleep(3000);
      } else {
        console.log('[yogiyo-filter] 조회 버튼 못 찾음');
      }

      console.log('[yogiyo-filter] 날짜 필터 완료');
      return { success: true, targetDate };
    })()
  `;
}

// ─── 요기요 API 인터셉트 설정 스크립트 ───────────────────────────
// ceo-api.yogiyo.co.kr API 응답을 캡처하는 fetch/XHR monkey-patch
function getYogiyoInterceptScript() {
  return `
    (function() {
      if (window._yogiyoInterceptInstalled) return true;
      window._yogiyoInterceptInstalled = true;
      window._yogiyoCapturedResponses = [];
      window._yogiyoAuthHeaders = {};

      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

        // API 요청의 인증 헤더 캡처 (order_detail 호출에 재사용)
        if (url.includes('ceo-api.yogiyo.co.kr') || url.includes('yogiyo')) {
          try {
            const reqInit = args[1] || {};
            const h = reqInit.headers;
            if (h) {
              if (h instanceof Headers) {
                h.forEach((v, k) => { window._yogiyoAuthHeaders[k.toLowerCase()] = v; });
              } else if (typeof h === 'object') {
                Object.entries(h).forEach(([k, v]) => { window._yogiyoAuthHeaders[k.toLowerCase()] = v; });
              }
            }
          } catch {}
        }

        const response = await origFetch.apply(this, args);
        if (url.includes('ceo-api.yogiyo.co.kr') || url.includes('yogiyo')) {
          try {
            const clone = response.clone();
            const text = await clone.text();
            try {
              const json = JSON.parse(text);
              window._yogiyoCapturedResponses.push({ url, data: json, ts: Date.now() });
            } catch {}
          } catch {}
        }
        return response;
      };

      const origXHROpen = XMLHttpRequest.prototype.open;
      const origXHRSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._interceptUrl = url;
        return origXHROpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        // XHR 요청 헤더도 캡처
        const origSetHeader = this.setRequestHeader.bind(this);
        const capturedHeaders = {};
        this.setRequestHeader = function(name, value) {
          capturedHeaders[name.toLowerCase()] = value;
          return origSetHeader(name, value);
        };

        this.addEventListener('load', function() {
          const url = this._interceptUrl || '';
          if (url.includes('ceo-api.yogiyo.co.kr') || url.includes('yogiyo')) {
            // 헤더 병합
            Object.assign(window._yogiyoAuthHeaders, capturedHeaders);
            try {
              const json = JSON.parse(this.responseText);
              window._yogiyoCapturedResponses.push({ url, data: json, ts: Date.now() });
            } catch {}
          }
        });
        return origXHRSend.apply(this, args);
      };

      true;
    })();
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

// ─── 땡겨요 API 인터셉트 설정 스크립트 ───────────────────────────
// boss.ddangyo.com API 응답을 캡처하는 fetch/XHR monkey-patch
function getDdangyoyoInterceptScript() {
  return `
    (function() {
      if (window._ddIntercepted) return true;
      window._ddIntercepted = true;
      window._ddCaptures = [];

      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        const response = await origFetch.apply(this, args);
        if (url.includes('boss.ddangyo.com') || url.includes('/o2o/')) {
          try {
            const clone = response.clone();
            const text = await clone.text();
            try {
              const json = JSON.parse(text);
              window._ddCaptures.push({ url, data: json, ts: Date.now() });
            } catch {}
          } catch {}
        }
        return response;
      };

      const origXHROpen = XMLHttpRequest.prototype.open;
      const origXHRSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._ddUrl = url;
        return origXHROpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
          const url = this._ddUrl || '';
          if (url.includes('boss.ddangyo.com') || url.includes('/o2o/')) {
            try {
              const json = JSON.parse(this.responseText);
              window._ddCaptures.push({ url, data: json, ts: Date.now() });
            } catch {}
          }
        });
        return origXHRSend.apply(this, args);
      };

      true;
    })();
  `;
}

// ─── 땡겨요 전용 로그인 스크립트 (WebSquare SPA) ────────────────
function getDdangyoyoLoginScript(loginId, loginPw) {
  const idEscaped = JSON.stringify(loginId);
  const pwEscaped = JSON.stringify(loginPw);

  return `
    (async function() {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const idInput = document.getElementById('mf_ibx_mbrId');
      const pwInput = document.getElementById('mf_sct_pwd');
      if (!idInput || !pwInput) return { success: false, error: 'WebSquare 로그인 폼 없음' };

      function setVal(el, val) {
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      setVal(idInput, ${idEscaped});
      await sleep(300);
      setVal(pwInput, ${pwEscaped});
      await sleep(500);

      const loginBtn = document.getElementById('mf_btn_webLogin');
      if (loginBtn) { loginBtn.click(); return { success: true, clicked: 'mf_btn_webLogin' }; }
      return { success: false, error: '로그인 버튼 없음' };
    })()
  `;
}

// ─── 배민 3개월 기간 범위 필터 스크립트 ───────────────────────────
// /orders/history 페이지에서 "월" 탭 → "지난 3개월" 프리셋 선택
// 플로우: 프로모션 팝업 닫기 → "날짜 직접 선택" → "월" 탭(radio) → "지난 3개월" → 적용
function getBaeminRangeFilterScript() {
  return `
    (async function() {
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      console.log('[baemin-range] 3개월 기간 필터 시작');

      // 1. 프로모션 팝업 닫기
      const dismissBtn = Array.from(document.querySelectorAll('button'))
        .find(b => b.innerText.trim() === '오늘 하루 보지 않기');
      if (dismissBtn) { dismissBtn.click(); await sleep(1000); console.log('[baemin-range] 팝업 닫음'); }

      // 2. "날짜 직접 선택" 버튼 클릭
      const dateSelectBtn = Array.from(document.querySelectorAll('button'))
        .find(el => el.innerText.includes('날짜 직접 선택'));
      if (!dateSelectBtn) return { success: false, error: '날짜 직접 선택 버튼 못 찾음' };
      dateSelectBtn.click();
      console.log('[baemin-range] 날짜 직접 선택 클릭');
      await sleep(2000);

      // 3. "월" 탭 클릭 (radio value="monthly" 또는 텍스트 "월")
      const monthlyRadio = document.querySelector('input[type="radio"][value="monthly"]');
      if (monthlyRadio) {
        const label = monthlyRadio.closest('label') || monthlyRadio.parentElement;
        if (label) label.click(); else monthlyRadio.click();
        console.log('[baemin-range] 월 탭 클릭 (radio value=monthly)');
        await sleep(1000);
      } else {
        // 폴백: 텍스트 "월"인 라디오 라벨 찾기
        const monthLabel = Array.from(document.querySelectorAll('label'))
          .find(l => {
            const text = l.innerText.trim();
            return text === '월' || text === '월별';
          });
        if (monthLabel) {
          monthLabel.click();
          console.log('[baemin-range] 월 탭 클릭 (텍스트 폴백)');
          await sleep(1000);
        } else {
          return { success: false, error: '월 탭 라디오 못 찾음' };
        }
      }

      // 4. "지난 3개월" 라디오/라벨 클릭
      const threeMonthLabel = Array.from(document.querySelectorAll('label, span, div, button'))
        .find(el => {
          const text = el.innerText.trim();
          return text === '지난 3개월' && el.offsetParent !== null;
        });
      if (threeMonthLabel) {
        threeMonthLabel.click();
        console.log('[baemin-range] 지난 3개월 클릭');
        await sleep(1000);
      } else {
        // 폴백: input[type="radio"] 중 가까운 텍스트에 "3개월" 포함
        const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
        const threeMonthRadio = radios.find(r => {
          const parent = r.closest('label') || r.parentElement;
          return parent && parent.innerText.includes('3개월');
        });
        if (threeMonthRadio) {
          const parent = threeMonthRadio.closest('label') || threeMonthRadio.parentElement;
          if (parent) parent.click(); else threeMonthRadio.click();
          console.log('[baemin-range] 지난 3개월 클릭 (라디오 폴백)');
          await sleep(1000);
        } else {
          return { success: false, error: '지난 3개월 옵션 못 찾음' };
        }
      }

      // 5. "적용" 버튼 클릭 (큰 파란 버튼, width > 200px)
      const applyBtns = Array.from(document.querySelectorAll('button'))
        .filter(b => b.innerText.trim() === '적용')
        .map(b => ({ btn: b, w: b.getBoundingClientRect().width }));
      const modalApply = applyBtns.find(a => a.w > 200) || applyBtns[0];
      if (modalApply) {
        modalApply.btn.click();
        console.log('[baemin-range] 적용 클릭 (w=' + Math.round(modalApply.w) + ')');
        await sleep(3000);
      } else {
        return { success: false, error: '적용 버튼 못 찾음' };
      }

      console.log('[baemin-range] 3개월 기간 필터 완료');
      return { success: true, filterType: 'range', period: '3months' };
    })()
  `;
}

// ─── 요기요 기간 범위 필터 스크립트 ─────────────────────────────────
// /order-history/list 페이지에서 "직접설정" → 시작일 선택 → 조회
// 플로우: react-datepicker input click → "직접설정" → 월 네비게이션 → 시작일 클릭 → "조회"
function getYogiyoRangeFilterScript(startDate) {
  const dateJson = JSON.stringify(startDate);
  return `
    (async function() {
      const startDate = ${dateJson};
      const [targetYear, targetMonth, targetDay] = startDate.split('-').map(Number);
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      console.log('[yogiyo-range] 기간 필터 시작, startDate:', startDate);

      // 1. react-datepicker input 클릭 → 캘린더 드롭다운 열기
      const container = document.querySelector('.react-datepicker__input-container');
      if (!container) return { success: false, error: 'react-datepicker__input-container 못 찾음' };
      const input = container.querySelector('input');
      if (!input) return { success: false, error: 'react-datepicker input 못 찾음' };
      input.focus();
      input.click();
      console.log('[yogiyo-range] 드롭다운 열기:', input.value);
      await sleep(1500);

      // 2. "직접설정" 클릭
      const customOption = Array.from(document.querySelectorAll('div, span, button'))
        .find(el => el.innerText.trim() === '직접설정' && el.offsetParent !== null && el.children.length === 0);
      if (customOption) {
        customOption.click();
        console.log('[yogiyo-range] 직접설정 클릭');
        await sleep(2000);
      } else {
        return { success: false, error: '직접설정 옵션 못 찾음' };
      }

      // 3. 캘린더에서 시작일의 월로 이동 (이전 버튼으로 네비게이션)
      for (let nav = 0; nav < 12; nav++) {
        // 현재 캘린더 헤더에서 표시 중인 연월 확인
        const monthHeader = document.querySelector('.react-datepicker__current-month')
          || document.querySelector('[class*="react-datepicker__header"] [class*="current-month"]');
        if (monthHeader) {
          const headerText = monthHeader.innerText.trim();
          console.log('[yogiyo-range] 현재 캘린더 월:', headerText);
          // "2026년 3월" 또는 "March 2026" 형태
          const korMatch = headerText.match(/(\\d{4})년\\s*(\\d{1,2})월/);
          if (korMatch) {
            const dispYear = Number(korMatch[1]);
            const dispMonth = Number(korMatch[2]);
            if (dispYear === targetYear && dispMonth === targetMonth) {
              console.log('[yogiyo-range] 타겟 월 도달:', targetYear + '년 ' + targetMonth + '월');
              break;
            }
          }
        }

        // 이전 달 버튼 클릭
        const prevBtn = document.querySelector('.react-datepicker__navigation--previous, [class*="navigation--previous"]')
          || Array.from(document.querySelectorAll('button'))
            .find(b => (b.getAttribute('aria-label') || '').includes('Previous') || (b.getAttribute('aria-label') || '').includes('이전'));
        if (prevBtn) {
          prevBtn.click();
          console.log('[yogiyo-range] 이전 달 이동');
          await sleep(500);
        } else {
          console.log('[yogiyo-range] 이전 달 버튼 못 찾음');
          break;
        }
      }

      // 4. 시작일(startDate) 날짜 클릭
      const findDayEl = () => {
        return Array.from(document.querySelectorAll('[class*="react-datepicker__day"]'))
          .find(el => {
            const t = el.innerText?.trim();
            const n = parseInt(t, 10);
            if (n !== targetDay) return false;
            const cls = el.className || '';
            // disabled, outside-month 제외
            if (cls.includes('disabled') || cls.includes('outside')) return false;
            // aria-label로 정확한 월 확인
            const aria = el.getAttribute('aria-label') || '';
            if (aria && aria.includes(targetMonth + '월') && aria.includes(targetDay + '일')) return true;
            // aria 없으면 숫자만 일치 + disabled 아닌 것
            return n === targetDay;
          });
      };

      const dayEl = findDayEl();
      if (dayEl) {
        dayEl.click();
        console.log('[yogiyo-range] 시작일 클릭:', targetDay + '일');
        await sleep(1000);
      } else {
        return { success: false, error: targetYear + '-' + targetMonth + '-' + targetDay + ' 날짜 버튼 못 찾음' };
      }

      // 5. "조회" 버튼 클릭
      await sleep(500);
      const searchBtn = Array.from(document.querySelectorAll('button'))
        .find(b => b.innerText.trim() === '조회' && b.offsetParent !== null);
      if (searchBtn) {
        searchBtn.click();
        console.log('[yogiyo-range] 조회 클릭');
        await sleep(3000);
      } else {
        console.log('[yogiyo-range] 조회 버튼 못 찾음');
      }

      console.log('[yogiyo-range] 기간 필터 완료');
      return { success: true, filterType: 'range', startDate };
    })()
  `;
}

module.exports = {
  getExtractorScript,
  getAutoLoginScript,
  getCheckLoginScript,
  getBaeminDateFilterScript,
  getBaeminRangeFilterScript,
  getBaeminInterceptScript,
  getYogiyoDateFilterScript,
  getYogiyoRangeFilterScript,
  getYogiyoInterceptScript,
  getCoupangeatsOrderExtractScript,
  getCoupangeatsSettlementExtractScript,
  getDdangyoyoInterceptScript,
  getDdangyoyoLoginScript,
};
