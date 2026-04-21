// ── 업데이트 오버레이 제어 ──
// 앱 시작 시 오버레이가 로그인 폼 위에 떠서 상호작용 차단.
// main 프로세스에서 update-status IPC가 오면 상태별 처리.
const updateOverlay = document.getElementById('updateOverlay');
const updateMsg = document.getElementById('updateMsg');
const updateProgress = document.getElementById('updateProgress');
const updateFill = document.getElementById('updateFill');
const updatePercent = document.getElementById('updatePercent');

if (window.api?.onUpdateStatus) {
  window.api.onUpdateStatus((data) => {
    switch (data.status) {
      case 'update-available':
        updateMsg.textContent = `새 버전 (v${data.version}) 다운로드 중...`;
        updateProgress.style.display = 'flex';
        // 스피너 숨기기 (프로그레스바가 대체)
        updateOverlay.querySelector('.spinner')?.remove();
        break;
      case 'downloading':
        updateFill.style.width = `${data.percent}%`;
        updatePercent.textContent = `${data.percent}%`;
        break;
      case 'downloaded':
        updateMsg.textContent = '업데이트 설치 중... 잠시 후 재시작됩니다';
        updateProgress.style.display = 'none';
        break;
      case 'no-update':
      case 'error':
      case 'timeout':
        updateOverlay.style.display = 'none';
        break;
    }
  });
}

// ── 로그인 폼 ──
const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const loginBtn = document.getElementById('loginBtn');
const errorMsg = document.getElementById('errorMsg');
const rememberCheck = document.getElementById('rememberCheck');

// 앱 버전 표시는 renderer/js/version-display.js 공통 모듈이 처리.

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.add('visible');
}

function hideError() {
  errorMsg.classList.remove('visible');
}

async function handleLogin() {
  hideError();

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    showError('이메일과 비밀번호를 입력하세요.');
    return;
  }

  loginBtn.disabled = true;
  loginBtn.innerHTML = '<span class="spinner"></span>로그인 중...';

  const result = await window.api.login(email, password);

  if (result.success) {
    // 로그인 성공 시 저장 처리
    if (rememberCheck.checked) {
      await window.api.saveLogin(email, password);
    } else {
      await window.api.clearSavedLogin();
    }
    window.api.navigate('store-select');
  } else {
    showError(result.message);
    loginBtn.disabled = false;
    loginBtn.textContent = '로그인';
  }
}

loginBtn.addEventListener('click', handleLogin);

passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleLogin();
});

emailInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') passwordInput.focus();
});

// 저장된 로그인 정보 불러오기
(async () => {
  const saved = await window.api.getSavedLogin();
  if (saved) {
    emailInput.value = saved.email;
    passwordInput.value = saved.password;
    rememberCheck.checked = true;
  }
})();
