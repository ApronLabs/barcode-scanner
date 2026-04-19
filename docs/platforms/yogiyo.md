# 요기요 크롤러 스펙

**POC 파일**: [`scripts/poc-yogiyo.js`](../../scripts/poc-yogiyo.js)
**Raw 샘플**: [`../api-samples/yogiyo/sample-order-mapped.json`](../api-samples/yogiyo/sample-order-mapped.json) (⚠ mapped only — raw 수집 필요)

## 로그인

- 사이트: https://ceo.yogiyo.co.kr/login
- 방식: ID + 비밀번호
- 로그인 후 `order-history/list` 페이지 진입 → 매장 선택 모달 처리
- POC CLI: `--id=<아이디> --pw=<비밀번호>`

## API 엔드포인트

| 용도 | 메서드/URL | 파라미터 |
|---|---|---|
| 주문 리스트 | `POST https://ceo-api.yogiyo.co.kr/proxy/orders` | body: `{start_date, end_date, page, size}` |
| 주문 상세 + 정산 | `GET https://ceo-api.yogiyo.co.kr/proxy/order_detail/{orderNumber}/` | — |

**호출 방식**: Electron webview 페이지 내에서 fetch 직접 호출 → `executeJavaScript` 로 결과 수령.

## 응답 구조

### `/proxy/orders` 주문 리스트

```
{
  orders: [
    { order_number, submitted_at, items_price, delivery_fee, ... }
  ],
  count,
  next?
}
```

### `/proxy/order_detail/{N}/` 상세

```
{
  data: {
    settlement_info: {
      settlement_items: [
        { item_title: "주문중개 이용료", item_amount: -1234, ... },
        { item_title: "외부결제 수수료", item_amount: -567, ... },
        { item_title: "배달대행 수수료", item_amount: -3000, ... },
        { item_title: "사장님 할인 부담액", item_amount: -1000, ... },
        { item_title: "요기요 보전 할인", item_amount: 500, ... },
        { item_title: "추천광고 이용료", item_amount: -200, ... },
        { item_title: "부가세", item_amount: 689, ... },
        ...
      ],
      settlement_amount,
      yogiyo_discount_amount,
      ...
    }
  }
}
```

## 필드 매핑

⚠ **문자열 기반 파싱** — `settlement_items[].item_title` 에서 부분 문자열 매칭으로 각 수수료 추출. 매장별로 항목명이 미세하게 다를 수 있어 취약.

| 항목 | 소스 | POC 필드 | DB 컬럼 |
|---|---|---|---|
| 주문금액 | `order.items_price` | `menuAmount` | `sale_price` |
| 배달요금 (고객 수령) | `order.delivery_fee` | `deliveryIncome` | `delivery_income` |
| 중개이용료 | `settlement_items[item_title LIKE '주문중개%'].item_amount` | `commissionFee` | `commission_fee` |
| 결제수수료 | `settlement_items[LIKE '외부결제%']` | `pgFee` | `pg_fee` |
| 배달대행료 | `settlement_items[LIKE '배달대행%']` | `deliveryCost` | `delivery_fee` |
| 사장님 부담 할인 | `settlement_items[LIKE '사장님%' OR '타임 할인%' OR '프로모션%' OR '쿠폰 할인%']` 합산 | `sellerDiscount` | `store_discount` |
| 요기요 보전 할인 | `Math.abs(settlement_info.yogiyo_discount_amount)` | `platformSubsidy` | `platform_subsidy` |
| 광고비 | `settlement_items[LIKE '추천광고%' OR '요타임딜%']` 합산 | `adCost` | `ad_fee` |
| 부가세 (단일) | `settlement_items[LIKE '부가세%']` | `vat` | `vat` |
| 정산금액 | `settlement_info.settlement_amount` | `settlementAmount` | `settlement_amount` |

## VAT 분리 방식

❌ **요기요 API 는 수수료별 VAT 미제공**. `settlement_items` 에 "부가세" 단일 항목만 제공.
→ 엑셀 렌더러 `computeVatBreakdown` 헬퍼가 **공급가 × 0.1 폴백 계산**.

## 주의사항

### orderedAt timezone (v3.7.x fix)
- `order.submitted_at` 은 TZ 없음 (`2026-03-08T10:21:00`).
- 요기요 서버가 KST 로 저장/반환. POC 에서 `+09:00` 을 fold 해서 올려야 노심이 올바른 `order_date` 추출.
- `parseYogiyoOrderedAt` 헬퍼 (노심) 가 동일 처리.

### 매장 선택 모달
- 여러 매장 사장님이 로그인하면 팝업이 뜸 → POC 가 `.modal-store-select` 류 DOM 자동 클릭.

### 문자열 파싱 안정성 (v3.5.4 fix)
- 이전 `findItem('배달')` 이 "배달요금(고객 수령)"도 매칭 → 배달대행료로 오분류 → v3.5.4 에서 `'배달대행'` 로 좁힘.
- 매장 항목명 변형 발견 시 `findItem/sumFind` 파싱 대상에 별칭 추가 필요.

### 취소건
- `order.order_status === 'CANCELLED'` 로 판별.

### 3-31 후반 주문 누락 (기존 메모리)
- 일부 주문이 `/proxy/orders` 페이지네이션에서 누락되는 이슈 확인됨.
- `next` 토큰 처리 검토 필요 (후속 PR).

## 검증 워크플로우

1. 고기왕김치찜 요기요 주문 하나 선정
2. 요기요 CEO 사이트 → 해당 주문 상세 → 정산내역 탭 스크린샷
3. `settlement_items` 배열의 각 `item_title` 과 POC 의 `findItem/sumFind` 매칭 대상 대조
4. raw 덤프 확보 (POC `--dump-raw` 플래그 후속 PR 후)
5. 공급가 × 0.1 폴백 VAT 가 실제 정산서 부가세 합과 일치하는지 확인
