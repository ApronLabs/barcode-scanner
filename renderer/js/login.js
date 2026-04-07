const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const loginBtn = document.getElementById('loginBtn');
const errorMsg = document.getElementById('errorMsg');
const rememberCheck = document.getElementById('rememberCheck');

// 앱 버전 표시
api.getAppVersion().then(v => {
  document.getElementById('appVersion').textContent = `v${v}`;
}).catch(() => {});

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
