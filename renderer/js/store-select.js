const storeGrid = document.getElementById('storeGrid');
const errorMsg = document.getElementById('errorMsg');

let lastStoreId = null;

// TTS helper (inline since speak() is only in scanner.js)
function speakText(text) {
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.2;
    utterance.volume = 1.0;
    const voices = window.speechSynthesis.getVoices();
    const koreanVoice = voices.find((v) => v.lang.startsWith('ko'));
    if (koreanVoice) utterance.voice = koreanVoice;
    window.speechSynthesis.speak(utterance);
  } catch (e) { /* ignore */ }
}

// Session expired listener
window.api.onSessionExpired(() => {
  speakText('세션이 만료되었습니다. 다시 로그인해주세요.');
  setTimeout(() => window.api.navigate('login'), 1500);
});

async function loadStores() {
  const config = await window.api.getConfig();
  lastStoreId = config.lastStoreId;

  const result = await window.api.getStores();

  if (result.code === 'UNAUTHORIZED') {
    return; // session-expired event will handle navigation
  }

  if (!result.success) {
    storeGrid.innerHTML = '';
    errorMsg.textContent = result.message;
    errorMsg.classList.add('visible');
    speakText(result.message);
    return;
  }

  const stores = result.stores;

  if (stores.length === 0) {
    storeGrid.innerHTML = '<div class="waiting">등록된 매장이 없습니다.</div>';
    return;
  }

  storeGrid.innerHTML = '';
  stores.forEach((store) => {
    const isLast = store.id === lastStoreId;

    const card = document.createElement('div');
    card.className = `store-card${isLast ? ' last-selected' : ''}`;
    card.dataset.id = store.id;
    card.dataset.name = store.name;

    const nameEl = document.createElement('div');
    nameEl.className = 'store-name';
    nameEl.textContent = store.name;
    card.appendChild(nameEl);

    if (store.address) {
      const addrEl = document.createElement('div');
      addrEl.className = 'store-info';
      addrEl.textContent = store.address;
      card.appendChild(addrEl);
    }

    if (isLast) {
      const tag = document.createElement('span');
      tag.className = 'last-tag';
      tag.textContent = '최근 사용';
      card.appendChild(tag);
    }

    card.addEventListener('click', () => selectStore(card));
    storeGrid.appendChild(card);
  });
}

async function selectStore(card) {
  const storeId = card.dataset.id;
  const storeName = card.dataset.name;

  await window.api.saveConfig({ lastStoreId: storeId, lastStoreName: storeName });

  // Store selected info in sessionStorage for scanner page
  sessionStorage.setItem('selectedStoreId', storeId);
  sessionStorage.setItem('selectedStoreName', storeName);

  window.api.navigate('scanner');
}

loadStores();
