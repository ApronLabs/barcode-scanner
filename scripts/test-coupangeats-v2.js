#!/usr/bin/env node
// 쿠팡이츠 크롤러 v2 테스트 — Electron 없이 직접 실행
// 사용법: node scripts/test-coupangeats-v2.js [YYYY-MM-DD]
//
// 매출지킴이 전송 테스트 시:
//   SALES_KEEPER_URL=http://localhost:3000 \
//   SALES_KEEPER_TOKEN=your-session-token \
//   SALES_KEEPER_STORE_ID=your-store-uuid \
//   node scripts/test-coupangeats-v2.js 2026-03-07
'use strict';

require('dotenv').config();
const { CoupangeatsCrawler } = require('./coupangeats');

const targetDate = process.argv[2] || (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
})();

const id = process.env.COUPANGEATS_ID || '01088597177';
const pw = process.env.COUPANGEATS_PW || 'abcd7177@';

// 매출지킴이 전송 설정 (환경변수로)
const salesKeeper = process.env.SALES_KEEPER_URL ? {
  apiBaseUrl: process.env.SALES_KEEPER_URL,
  sessionToken: process.env.SALES_KEEPER_TOKEN,
  salesKeeperStoreId: process.env.SALES_KEEPER_STORE_ID,
} : undefined;

console.log('='.repeat(60));
console.log('  쿠팡이츠 크롤러 v2 테스트');
console.log(`  대상 날짜: ${targetDate}`);
console.log(`  로그인 ID: ${id}`);
console.log(`  매출지킴이: ${salesKeeper ? salesKeeper.apiBaseUrl : '미설정 (결과만 출력)'}`);
console.log('='.repeat(60));

const crawler = new CoupangeatsCrawler({
  onStatus: (status) => console.log('[상태]', JSON.stringify(status)),
});

crawler.run(id, pw, {
  targetDate,
  brandName: '고기왕김치찜',
  salesKeeper,
}).then(({ results, errors }) => {
  console.log('\n' + '='.repeat(60));
  console.log('  크롤링 완료');
  console.log('='.repeat(60));

  if (errors.length > 0) {
    console.log('\n에러:', JSON.stringify(errors, null, 2));
  }

  if (results.orders) {
    const { orders, totalCount, ordersWithSettlement, targetDate: td } = results.orders;
    console.log(`\n날짜: ${td}`);
    console.log(`전체 주문: ${totalCount}건`);
    console.log(`정산 데이터 포함: ${ordersWithSettlement}건`);

    if (orders && orders.length > 0) {
      console.log('\n── 주문 목록 (상위 5건) ──');
      orders.slice(0, 5).forEach((o, i) => {
        const s = o.orderSettlement;
        console.log(`\n[${i + 1}] ${o.orderId} | ${o.orderedAt}`);
        console.log(`    메뉴: ${o.menuSummary}`);
        console.log(`    매출액: ${o.totalPayment.toLocaleString()}원`);
        if (s) {
          console.log(`    중개이용료: ${s.serviceSupplyPrice?.appliedSupplyPrice?.toLocaleString()}원`);
          console.log(`    결제수수료: ${s.paymentSupplyPrice?.appliedSupplyPrice?.toLocaleString()}원`);
          console.log(`    배달비: ${s.deliverySupplyPrice?.appliedSupplyPrice?.toLocaleString()}원`);
          console.log(`    광고비: ${s.advertisingSupplyPrice?.appliedSupplyPrice?.toLocaleString()}원`);
          console.log(`    부가세: ${s.commissionVat?.toLocaleString()}원`);
          console.log(`    즉시할인: ${s.mfdTotalAmount?.toLocaleString()}원`);
          console.log(`    정산예정: ${(o.totalPayment - s.subtractAmount).toLocaleString()}원 (${s.settlementDueDate})`);
        }
      });

      // 일별 합계
      console.log('\n── 일별 합계 ──');
      let totalSales = 0, totalCommission = 0, totalPg = 0, totalDelivery = 0;
      let totalAd = 0, totalVat = 0, totalSettlement = 0;
      for (const o of orders) {
        const s = o.orderSettlement;
        if (!s) continue;
        totalSales += o.totalPayment;
        totalCommission += s.serviceSupplyPrice?.appliedSupplyPrice || 0;
        totalPg += s.paymentSupplyPrice?.appliedSupplyPrice || 0;
        totalDelivery += s.deliverySupplyPrice?.appliedSupplyPrice || 0;
        totalAd += s.advertisingSupplyPrice?.appliedSupplyPrice || 0;
        totalVat += s.commissionVat || 0;
        totalSettlement += o.totalPayment - s.subtractAmount;
      }
      console.log(`  매출액: ${totalSales.toLocaleString()}원`);
      console.log(`  중개이용료: ${totalCommission.toLocaleString()}원`);
      console.log(`  결제수수료: ${totalPg.toLocaleString()}원`);
      console.log(`  배달비: ${totalDelivery.toLocaleString()}원`);
      console.log(`  광고비: ${totalAd.toLocaleString()}원`);
      console.log(`  부가세: ${totalVat.toLocaleString()}원`);
      console.log(`  정산예정: ${totalSettlement.toLocaleString()}원`);
    }
  }

  if (results.salesKeeper) {
    console.log('\n── 매출지킴이 전송 결과 ──');
    console.log(JSON.stringify(results.salesKeeper, null, 2));
  }

}).catch(err => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
