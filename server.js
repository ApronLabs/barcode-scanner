/**
 * 매출지킴이 바코드 스캐너 서버 (v2 - Global Key Listener)
 *
 * 브라우저 탭 포커스와 무관하게 바코드 스캔 가능
 * 빠른 연속 키 입력을 감지하여 바코드로 인식
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { GlobalKeyboardListener } = require('node-global-key-listener');

const app = express();
const PORT = process.env.PORT || 3333;

// ========================================
// 바코드 감지 설정
// ========================================
const BARCODE_CONFIG = {
  // 키 입력 간격 임계값 (ms) - 이보다 빠르면 바코드로 인식
  INPUT_THRESHOLD_MS: 50,
  // 바코드 최소 길이
  MIN_LENGTH: 4,
  // 버퍼 타임아웃 (ms) - 이 시간 동안 입력 없으면 버퍼 초기화
  BUFFER_TIMEOUT_MS: 200,
};

// 접두사 설정 (스캐너에서 설정한 접두사)
const BARCODE_PREFIX = {
  OUTPUT: '-',
};

// Supabase 설정 (.env 파일에서 로드)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// 매장 ID (.env 파일에서 로드)
const STORE_ID = process.env.STORE_ID;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HTTP 서버 생성
const server = http.createServer(app);

// WebSocket 서버 생성
const wss = new WebSocket.Server({ server });

// 연결된 클라이언트들
const clients = new Set();

// 브라우저 처리 대기 중인 바코드
const pendingBarcodes = new Map(); // scanId -> { barcode, timeout }

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('  [WS] 브라우저 연결됨');

  ws.send(JSON.stringify({
    type: 'status',
    connected: true,
    mode: 'global-key-listener'
  }));

  // 브라우저로부터 메시지 수신
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'processed' && data.scanId) {
        // 브라우저가 처리 완료했으므로 서버 처리 취소
        const pending = pendingBarcodes.get(data.scanId);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingBarcodes.delete(data.scanId);
          console.log(`  [WS] 브라우저가 처리 완료: ${data.scanId}`);
        }
      }
    } catch (e) {
      // 파싱 에러 무시
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('  [WS] 브라우저 연결 해제');
  });
});

function broadcast(data) {
  const message = JSON.stringify(data);
  let sentCount = 0;
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      sentCount++;
    }
  });
  return sentCount;
}

// 브라우저 없을 때 서버에서 직접 바코드 처리
async function processBarcodeDirect(rawBarcode) {
  const { barcode, detectedMode } = parseBarcodePrefix(rawBarcode);
  const mode = detectedMode || 'input';

  try {
    const items = await supabaseRequest(`items?barcode=eq.${barcode}&store_id=eq.${STORE_ID}&select=id,name,barcode,unit`);
    if (items.length === 0) {
      console.log(`  [SERVER] ❌ 등록되지 않은 바코드: ${barcode}`);
      return;
    }

    const item = items[0];
    let inventories = await supabaseRequest(`inventory?item_id=eq.${item.id}&store_id=eq.${STORE_ID}&select=id,quantity`);

    // 재고 레코드가 없으면 자동 생성
    if (inventories.length === 0) {
      console.log(`  [SERVER] 📝 재고 레코드 생성: ${item.name}`);
      const newInventory = await supabaseRequest('inventory', {
        method: 'POST',
        body: JSON.stringify({
          item_id: item.id,
          store_id: STORE_ID,
          quantity: 0
        }),
      });
      if (!newInventory || newInventory.length === 0) {
        console.log(`  [SERVER] ❌ 재고 레코드 생성 실패: ${item.name}`);
        return;
      }
      inventories = newInventory;
    }

    const inventory = inventories[0];
    const currentQty = Number(inventory.quantity);
    const changeAmount = mode === 'output' ? -1 : 1;
    const newQty = currentQty + changeAmount;

    if (newQty < 0) {
      console.log(`  [SERVER] ❌ 재고 부족: ${item.name} (현재: ${currentQty})`);
      return;
    }

    await supabaseRequest(`inventory?id=eq.${inventory.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity: newQty, last_updated_at: new Date().toISOString() }),
    });

    // 발주-입고 연동 (입고 모드일 때만)
    let supplierOrderItemId = null;
    let orderMatchInfo = null;

    if (mode === 'input') {
      // 대기 중인 발주 항목 조회
      const pendingOrders = await supabaseRequest(
        `supplier_order_items?item_id=eq.${item.id}&select=id,quantity,received_quantity,order_id,supplier_orders!inner(store_id,status)&supplier_orders.store_id=eq.${STORE_ID}&supplier_orders.status=eq.ordered`
      );

      if (pendingOrders && pendingOrders.length > 0) {
        const orderItem = pendingOrders[0];
        const currentReceived = orderItem.received_quantity || 0;
        const pendingQty = orderItem.quantity - currentReceived;
        const inputQty = 1; // 서버 직접 처리는 항상 1개

        if (pendingQty > 0) {
          const orderReceiveQty = Math.min(inputQty, pendingQty);
          const newReceived = currentReceived + orderReceiveQty;

          await supabaseRequest(`supplier_order_items?id=eq.${orderItem.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ received_quantity: newReceived }),
          });

          supplierOrderItemId = orderItem.id;
          orderMatchInfo = {
            orderQty: orderItem.quantity,
            newReceived,
            remainingQty: orderItem.quantity - newReceived,
            isComplete: newReceived >= orderItem.quantity,
          };
        }
      }
    }

    await supabaseRequest('inventory_logs', {
      method: 'POST',
      body: JSON.stringify({
        inventory_id: inventory.id,
        item_id: item.id,
        store_id: STORE_ID,
        quantity_before: currentQty,
        quantity_after: newQty,
        change_amount: changeAmount,
        change_type: mode === 'output' ? 'output' : 'input',
        notes: `바코드 스캐너 ${mode === 'output' ? '출고' : '입고'} (서버 직접 처리)`,
        supplier_order_item_id: supplierOrderItemId
      }),
    });

    const icon = mode === 'output' ? '📤' : '📥';
    let orderMsg = '';
    if (orderMatchInfo) {
      if (orderMatchInfo.isComplete) {
        orderMsg = ` [발주 ${orderMatchInfo.orderQty}개 입고 완료]`;
      } else {
        orderMsg = ` [발주 연동: 남은 ${orderMatchInfo.remainingQty}개]`;
      }
    }
    console.log(`  [SERVER] ${icon} ${item.name}: ${currentQty} → ${newQty} (${mode === 'output' ? '출고' : '입고'})${orderMsg}`);
  } catch (error) {
    console.log(`  [SERVER] ❌ 처리 오류: ${error.message}`);
  }
}

// 바코드 감지 시 처리
function handleBarcodeDetected(barcode) {
  const scanId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // 브라우저에 알림
  const sentCount = broadcast({ type: 'barcode', barcode, scanId });

  if (sentCount > 0) {
    // 브라우저가 연결되어 있으면 500ms 대기
    console.log(`  [WS] 브라우저에 알림 전송 (${sentCount}개 클라이언트)`);
    const timeout = setTimeout(() => {
      // 500ms 내에 브라우저 응답 없으면 서버에서 처리
      if (pendingBarcodes.has(scanId)) {
        pendingBarcodes.delete(scanId);
        console.log(`  [SERVER] 브라우저 응답 없음, 서버에서 직접 처리`);
        processBarcodeDirect(barcode);
      }
    }, 500);

    pendingBarcodes.set(scanId, { barcode, timeout });
  } else {
    // 브라우저 연결 없으면 즉시 서버에서 처리
    console.log(`  [SERVER] 브라우저 미연결, 서버에서 직접 처리`);
    processBarcodeDirect(barcode);
  }
}

// ========================================
// Global Key Listener - 바코드 스캐너 감지
// ========================================

let keyBuffer = '';
let lastKeyTime = 0;
let bufferTimeout = null;
let fastKeyCount = 0; // 빠른 연속 입력 카운트

// 키 코드 → 문자 변환
function keyToChar(event) {
  const { name, state } = event;

  // 키 누름 이벤트만 처리 (키 뗌 이벤트 무시)
  if (state !== 'DOWN') return null;

  // Enter 키
  if (name === 'RETURN') return '\n';

  // 숫자 키 (메인 키보드)
  if (name.match(/^[0-9]$/)) return name;

  // 숫자 키 (넘패드)
  if (name.match(/^NUMPAD [0-9]$/)) return name.replace('NUMPAD ', '');

  // 알파벳 (소문자로 변환)
  if (name.match(/^[A-Z]$/)) return name.toLowerCase();

  // 특수 문자
  if (name === 'MINUS' || name === 'NUMPAD MINUS') return '-';
  if (name === 'PERIOD' || name === 'NUMPAD PERIOD') return '.';
  if (name === 'SLASH' || name === 'NUMPAD SLASH') return '/';

  return null;
}

function processKeyEvent(event) {
  const char = keyToChar(event);
  if (!char) return;

  // 디버그: 모든 키 입력 로그
  console.log(`  [KEY] 입력: "${char === '\n' ? 'ENTER' : char}" (버퍼: ${keyBuffer})`);

  const now = Date.now();
  const timeDiff = now - lastKeyTime;
  lastKeyTime = now;

  // 버퍼 타임아웃 초기화
  if (bufferTimeout) {
    clearTimeout(bufferTimeout);
  }

  // 빠른 연속 입력인지 확인
  const isFastInput = timeDiff < BARCODE_CONFIG.INPUT_THRESHOLD_MS;

  if (isFastInput) {
    fastKeyCount++;
  } else {
    // 느린 입력이면 버퍼 초기화 (일반 키보드 입력)
    if (keyBuffer.length > 0 && fastKeyCount < 3) {
      // 빠른 입력이 3개 미만이면 일반 타이핑으로 간주
      keyBuffer = '';
      fastKeyCount = 0;
    }
  }

  // Enter 키 처리
  if (char === '\n') {
    if (keyBuffer.length >= BARCODE_CONFIG.MIN_LENGTH && fastKeyCount >= 3) {
      // 바코드로 인식
      console.log(`  [SCAN] 바코드 감지: ${keyBuffer} (${fastKeyCount}개 빠른 입력)`);
      handleBarcodeDetected(keyBuffer);
    }
    keyBuffer = '';
    fastKeyCount = 0;
    return;
  }

  // 문자 추가
  keyBuffer += char;

  // 버퍼 타임아웃 설정 (일정 시간 입력 없으면 초기화)
  bufferTimeout = setTimeout(() => {
    if (keyBuffer.length > 0) {
      // 타임아웃 전에 충분한 빠른 입력이 있었으면 바코드로 처리
      if (keyBuffer.length >= BARCODE_CONFIG.MIN_LENGTH && fastKeyCount >= 3) {
        console.log(`  [SCAN] 바코드 감지 (타임아웃): ${keyBuffer}`);
        handleBarcodeDetected(keyBuffer);
      }
      keyBuffer = '';
      fastKeyCount = 0;
    }
  }, BARCODE_CONFIG.BUFFER_TIMEOUT_MS);
}

// Global Key Listener 초기화
let keyListener = null;

function initGlobalKeyListener() {
  try {
    keyListener = new GlobalKeyboardListener();

    keyListener.addListener((event) => {
      processKeyEvent(event);
    });

    console.log('  [KEY] Global Key Listener 활성화');
    console.log('  → 어느 앱에서든 바코드 스캔 가능!');
    return true;
  } catch (err) {
    console.error('  [KEY] Global Key Listener 초기화 실패:', err.message);
    console.log('  → 폴백 모드: 브라우저 입력창 사용');
    return false;
  }
}

// ========================================
// Supabase API
// ========================================
async function supabaseRequest(endpoint, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...options.headers,
    },
  });
  return response.json();
}

app.get('/api/item/:barcode', async (req, res) => {
  try {
    const { barcode } = req.params;
    const items = await supabaseRequest(`items?barcode=eq.${barcode}&store_id=eq.${STORE_ID}&select=id,name,barcode,unit`);
    if (items.length === 0) {
      return res.json({ success: false, message: '등록되지 않은 바코드입니다.' });
    }
    res.json({ success: true, item: items[0] });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

function parseBarcodePrefix(rawBarcode) {
  let barcode = rawBarcode;
  let detectedMode = null;
  let prefix = null;

  if (rawBarcode.startsWith(BARCODE_PREFIX.OUTPUT)) {
    barcode = rawBarcode.slice(BARCODE_PREFIX.OUTPUT.length);
    detectedMode = 'output';
    prefix = BARCODE_PREFIX.OUTPUT;
  }

  return { barcode, detectedMode, prefix };
}

app.post('/api/scan', async (req, res) => {
  try {
    const { barcode: rawBarcode, quantity = 1, mode: requestedMode = 'input' } = req.body;
    const { barcode, detectedMode, prefix } = parseBarcodePrefix(rawBarcode);
    const mode = detectedMode || requestedMode;

    const items = await supabaseRequest(`items?barcode=eq.${barcode}&store_id=eq.${STORE_ID}&select=id,name,barcode,unit`);
    if (items.length === 0) {
      return res.json({ success: false, message: '등록되지 않은 바코드입니다.', barcode });
    }

    const item = items[0];
    let inventories = await supabaseRequest(`inventory?item_id=eq.${item.id}&store_id=eq.${STORE_ID}&select=id,quantity`);

    // 재고 레코드가 없으면 자동 생성
    if (inventories.length === 0) {
      const newInventory = await supabaseRequest('inventory', {
        method: 'POST',
        body: JSON.stringify({
          item_id: item.id,
          store_id: STORE_ID,
          quantity: 0
        }),
      });
      if (!newInventory || newInventory.length === 0) {
        return res.json({ success: false, message: '재고 레코드 생성 실패', item: item.name });
      }
      inventories = newInventory;
    }

    const inventory = inventories[0];
    const currentQty = Number(inventory.quantity);
    const changeAmount = mode === 'output' ? -quantity : quantity;
    const newQty = currentQty + changeAmount;

    if (newQty < 0) {
      return res.json({
        success: false,
        message: `재고가 부족합니다. (현재: ${currentQty}${item.unit})`,
        item: item.name
      });
    }

    await supabaseRequest(`inventory?id=eq.${inventory.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity: newQty, last_updated_at: new Date().toISOString() }),
    });

    await supabaseRequest('inventory_logs', {
      method: 'POST',
      body: JSON.stringify({
        inventory_id: inventory.id,
        item_id: item.id,
        store_id: STORE_ID,
        quantity_before: currentQty,
        quantity_after: newQty,
        change_amount: changeAmount,
        change_type: mode === 'output' ? 'output' : 'input',
        notes: `바코드 스캐너 ${mode === 'output' ? '출고' : '입고'}`
      }),
    });

    res.json({
      success: true,
      item: item.name,
      unit: item.unit,
      before: currentQty,
      after: newQty,
      change: changeAmount,
      mode,
      autoDetected: !!detectedMode,
      prefix
    });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/scanner-status', (req, res) => {
  res.json({
    globalKeyListener: keyListener !== null,
    mode: 'global-key-listener'
  });
});

// 서버 시작
server.listen(PORT, () => {
  console.log('');
  console.log('========================================');
  console.log('  매출지킴이 바코드 스캐너 v2');
  console.log('========================================');
  console.log('');
  console.log(`  브라우저: http://localhost:${PORT}`);
  console.log('');

  const success = initGlobalKeyListener();

  if (success) {
    console.log('');
    console.log('  [설정]');
    console.log(`  - 입력 간격 임계값: ${BARCODE_CONFIG.INPUT_THRESHOLD_MS}ms`);
    console.log(`  - 최소 바코드 길이: ${BARCODE_CONFIG.MIN_LENGTH}`);
  }

  console.log('');
  console.log('  종료: Ctrl+C');
  console.log('========================================');
});

// 종료 시 정리
process.on('SIGINT', () => {
  if (keyListener) {
    keyListener.kill();
  }
  process.exit();
});
