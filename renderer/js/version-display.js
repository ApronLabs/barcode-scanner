// 공통 버전 표시 모듈 — 각 페이지의 #appVersion 엘리먼트를 찾아 앱 버전을 채움.
// 2026-04-22: 사장님(노유항) 요청 — 로그인 이후 페이지에서도 버전 확인 가능하도록.
// main 프로세스의 ipcHandler 'get-app-version' 사용 (preload.js:L18 노출).

(function () {
  const el = document.getElementById('appVersion');
  if (!el) return;
  const api = window.api;
  if (!api || typeof api.getAppVersion !== 'function') return;

  api
    .getAppVersion()
    .then((v) => {
      if (v) el.textContent = `v${v}`;
    })
    .catch(() => {
      // 버전 조회 실패 시 그냥 비워둠 (기존 placeholder 유지)
    });
})();
