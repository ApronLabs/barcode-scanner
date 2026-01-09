/**
 * 매출지킴이 바코드 스캐너 서버
 *
 * ASUS 노트북에서 실행
 * 브라우저에서 http://localhost:3333 접속
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3333;

// Supabase 설정
const SUPABASE_URL = 'https://kjfnhwhgsznhizibxiwj.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZm5od2hnc3puaGl6aWJ4aXdqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzA3MzE3NiwiZXhwIjoyMDgyNjQ5MTc2fQ.UG-EylX41DLxpzb-fh60Nwm-p9CISzl7t4EKb8RE63s';

// 매장 ID (유신)
const STORE_ID = '8f9f6053-4578-4b81-b03f-3d3d430253a6';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Supabase API 호출 헬퍼
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

// 바코드로 품목 조회
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

// 바코드 스캔 → 재고 업데이트 (입고/출고 모드 지원)
app.post('/api/scan', async (req, res) => {
  try {
    const { barcode, quantity = 1, mode = 'input' } = req.body;

    // 1. 바코드로 품목 조회
    const items = await supabaseRequest(`items?barcode=eq.${barcode}&store_id=eq.${STORE_ID}&select=id,name,barcode,unit`);

    if (items.length === 0) {
      return res.json({ success: false, message: '등록되지 않은 바코드입니다.', barcode });
    }

    const item = items[0];

    // 2. 현재 재고 조회
    const inventories = await supabaseRequest(`inventory?item_id=eq.${item.id}&store_id=eq.${STORE_ID}&select=id,quantity`);

    if (inventories.length === 0) {
      return res.json({ success: false, message: '재고 정보가 없습니다.', item: item.name });
    }

    const inventory = inventories[0];
    const currentQty = Number(inventory.quantity);

    // 입고/출고에 따라 수량 계산
    const changeAmount = mode === 'output' ? -quantity : quantity;
    const newQty = currentQty + changeAmount;

    // 출고 시 재고 부족 체크
    if (newQty < 0) {
      return res.json({
        success: false,
        message: `재고가 부족합니다. (현재: ${currentQty}${item.unit})`,
        item: item.name
      });
    }

    // 3. 재고 업데이트
    const updated = await supabaseRequest(`inventory?id=eq.${inventory.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        quantity: newQty,
        last_updated_at: new Date().toISOString()
      }),
    });

    if (updated.length === 0) {
      return res.json({ success: false, message: '재고 업데이트 실패', item: item.name });
    }

    // 4. 변경 이력 기록 (inventory_logs)
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
      mode: mode
    });

  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// 최근 스캔 이력 (메모리에 저장)
const scanHistory = [];

app.get('/api/history', (req, res) => {
  res.json(scanHistory.slice(-20)); // 최근 20개
});

// 스캔 이력 추가 (scan API에서 성공 시 호출)
app.post('/api/scan', async (req, res, next) => {
  // 기존 핸들러가 처리하도록 통과
  next();
});

// 서버 시작
app.listen(PORT, () => {
  console.log('');
  console.log('========================================');
  console.log('  매출지킴이 바코드 스캐너');
  console.log('========================================');
  console.log('');
  console.log(`  브라우저에서 접속: http://localhost:${PORT}`);
  console.log('');
  console.log('  바코드 스캐너 USB 연결 후');
  console.log('  입력창에 커서를 두고 스캔하세요.');
  console.log('');
  console.log('  종료: Ctrl+C');
  console.log('========================================');
});
