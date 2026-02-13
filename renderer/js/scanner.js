// DOM elements
const barcodeInput = document.getElementById('barcodeInput');
const resultBox = document.getElementById('resultBox');
const historyList = document.getElementById('historyList');
const quantityDisplay = document.getElementById('quantityDisplay');
const scanLabel = document.getElementById('scanLabel');
const storeNameEl = document.getElementById('storeName');
const changeStoreBtn = document.getElementById('changeStoreBtn');
const qtyMinus = document.getElementById('qtyMinus');
const qtyPlus = document.getElementById('qtyPlus');

// State
let quantity = 1;
let history = [];
let debounceTimer = null;
let currentMode = 'auto'; // 'auto' | 'input' | 'output'
let storeId = null;
let storeName = null;
let lastProcessedBarcode = '';
let lastProcessedTime = 0;
let isProcessing = false;

const modeText = { auto: '자동 감지', input: '입고', output: '출고' };

// Init
async function init() {
  // Try sessionStorage first, then config
  storeId = sessionStorage.getItem('selectedStoreId');
  storeName = sessionStorage.getItem('selectedStoreName');

  if (!storeId) {
    const config = await window.api.getConfig();
    storeId = config.lastStoreId;
    storeName = config.lastStoreName;
  }

  if (!storeId) {
    window.api.navigate('store-select');
    return;
  }

  storeNameEl.textContent = storeName || '-';
  barcodeInput.focus();
}

// Mode toggle
document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    setMode(btn.dataset.mode);
  });
});

function setMode(mode) {
  currentMode = mode;

  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector(`.mode-btn[data-mode="${mode}"]`).classList.add('active');

  scanLabel.textContent = `바코드를 스캔하세요 (${modeText[mode]})`;

  document.body.classList.remove('output-mode');
  if (mode === 'output') {
    document.body.classList.add('output-mode');
  }

  barcodeInput.focus();
}

// Quantity
qtyMinus.addEventListener('click', () => changeQuantity(-1));
qtyPlus.addEventListener('click', () => changeQuantity(1));

function changeQuantity(delta) {
  quantity = Math.max(1, Math.min(99, quantity + delta));
  quantityDisplay.textContent = quantity;
}

// Store change
changeStoreBtn.addEventListener('click', () => {
  window.api.navigate('store-select');
});

// Barcode input handlers
barcodeInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const barcode = barcodeInput.value.trim();
    if (barcode.length >= 4) {
      processBarcode(barcode);
    }
  }, 100);
});

barcodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(debounceTimer);
    const barcode = barcodeInput.value.trim();
    if (barcode) {
      processBarcode(barcode);
    }
  }
  // Tab to cycle modes
  if (e.key === 'Tab') {
    e.preventDefault();
    const modes = ['auto', 'input', 'output'];
    const idx = modes.indexOf(currentMode);
    setMode(modes[(idx + 1) % modes.length]);
  }
});

// Keep focus on input
document.addEventListener('click', () => {
  if (!isProcessing) barcodeInput.focus();
});

// Barcode processing
async function processBarcode(rawBarcode) {
  // Duplicate guard (same barcode within 1s)
  const now = Date.now();
  if (rawBarcode === lastProcessedBarcode && now - lastProcessedTime < 1000) {
    barcodeInput.value = '';
    return;
  }
  lastProcessedBarcode = rawBarcode;
  lastProcessedTime = now;
  isProcessing = true;

  // Parse prefix
  let barcode = rawBarcode;
  let actionType = 'input'; // default

  if (rawBarcode.startsWith('-')) {
    barcode = rawBarcode.substring(1);
    actionType = 'output';
  }

  // Mode override
  if (currentMode === 'input') actionType = 'input';
  else if (currentMode === 'output') actionType = 'output';
  // 'auto' keeps prefix-based decision

  // Pulse animation
  barcodeInput.classList.add('scanning');
  setTimeout(() => barcodeInput.classList.remove('scanning'), 500);

  // 1. Lookup barcode
  const lookup = await window.api.lookupBarcode(barcode, storeId);

  if (!lookup.success || !lookup.item) {
    showResult('error', { message: lookup.item === null ? '등록되지 않은 바코드입니다.' : (lookup.message || '조회 실패'), barcode });
    playSound('error');
    barcodeInput.value = '';
    barcodeInput.focus();
    isProcessing = false;
    return;
  }

  const item = lookup.item;

  // 2. Update inventory
  const update = await window.api.updateInventory({
    itemId: item.id,
    storeId,
    type: actionType,
    amount: quantity,
    notes: `바코드 스캐너 ${actionType === 'output' ? '출고' : '입고'}`,
    inventoryId: item.inventoryId || undefined,
  });

  if (!update.success) {
    showResult('error', { message: update.message || '재고 변경 실패', barcode });
    playSound('error');
  } else {
    const changeAmount = actionType === 'output' ? -quantity : quantity;
    const before = item.currentQuantity;
    const after = update.newQuantity;

    showResult('success', {
      item: item.name,
      unit: item.unit || '개',
      before,
      after,
      change: changeAmount,
      mode: actionType,
    });
    addToHistory({
      item: item.name,
      change: changeAmount,
      mode: actionType,
    });
    playSound('success');
    speak(`${item.name} ${quantity}개 ${actionType === 'output' ? '출고' : '입고'} 되었습니다`);
  }

  barcodeInput.value = '';
  barcodeInput.focus();
  isProcessing = false;
}

// Result display
function showResult(type, result) {
  const isOutput = result.mode === 'output';
  resultBox.className = `result-box ${type}${isOutput ? ' output' : ''}`;

  if (type === 'success') {
    const changeText = result.change > 0 ? `+${result.change}` : result.change;
    const icon = isOutput ? '📤' : '📥';
    resultBox.innerHTML = `
      <div class="result-content">
        <div class="icon">${icon}</div>
        <div class="item-name">${result.item}</div>
        <div class="detail">${result.before} → ${result.after} ${result.unit} (${changeText})</div>
      </div>
    `;
  } else {
    resultBox.innerHTML = `
      <div class="result-content">
        <div class="icon">❌</div>
        <div class="message">${result.message}</div>
        ${result.barcode ? `<div class="detail" style="margin-top:8px;font-size:14px;color:#999;">바코드: ${result.barcode}</div>` : ''}
      </div>
    `;
  }
}

// History
function addToHistory(result) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const changeText = result.change > 0 ? `+${result.change}` : String(result.change);

  history.unshift({ name: result.item, qty: changeText, mode: result.mode, time: timeStr });
  history = history.slice(0, 20);
  renderHistory();
}

function renderHistory() {
  if (history.length === 0) {
    historyList.innerHTML = '<div class="empty-history">스캔 이력이 없습니다</div>';
    return;
  }

  historyList.innerHTML = history
    .map(
      (item) => `
    <div class="history-item">
      <div>
        <div class="name">${item.name}</div>
        <div class="time">${item.time}</div>
      </div>
      <div class="qty ${item.mode}">${item.qty}</div>
    </div>
  `
    )
    .join('');
}

// Sound
function playSound(type) {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    if (type === 'success') {
      oscillator.frequency.value = currentMode === 'output' ? 440 : 880;
    } else {
      oscillator.frequency.value = 220;
    }
    gainNode.gain.value = 0.1;

    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.1);
  } catch (e) {
    // ignore
  }
}

// TTS
function speak(text) {
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
  } catch (e) {
    // ignore
  }
}

if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}

// Start
init();
