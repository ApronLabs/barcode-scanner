# 배민 크롤러 스펙

**POC 파일**: [`scripts/poc-baemin.js`](../../scripts/poc-baemin.js)
**Raw 샘플**: [`../api-samples/baemin/sample-order-full.json`](../api-samples/baemin/sample-order-full.json)

## 로그인

- 사이트: https://self.baemin.com/
- 방식: ID + 비밀번호
- Electron BrowserWindow 로그인 → 쿠키 유지 → webview 가 API 호출
- POC CLI: `--id=<아이디> --pw=<비밀번호>`

## API 엔드포인트

| 용도 | 메서드/URL | 파라미터 |
|---|---|---|
| 주문 리스트 | `GET https://self-api.baemin.com/v4/orders` | `offset`, `limit=100`, `startDate`, `endDate`, `shopOwnerNumber`, `shopNumbers`, `orderStatus=CLOSED,CANCELLED` |
| 매장 정보 | `GET /v4/store/shops/{shopNumber}` | — |
| 매장 검색 | `GET /v4/store/shops/search` | `shopOwnerNo`, `pageSize=50` |
| CPC 광고비 | `GET /v2/statistics/campaign/cpc/metrics/{shopNumber}` | `startDate`, `endDate` (월별 1회 제한, POC 가 월 단위 분할 호출) |

**인터셉트 방식** (`INTERCEPT_SCRIPT`): webview `window.fetch` / `XMLHttpRequest` 를 래핑해 응답을 `window._baeminApiCaptures` 배열에 저장. POC 가 `executeJavaScript` 로 꺼내감.

## 응답 구조

### `GET /v4/orders` → `data.contents[].{order, settle}`

**`order` 객체 주요 필드** (36개, [샘플](../api-samples/baemin/sample-order-full.json) 참고):
```
orderNumber, status, deliveryType, payType, payAmount,
orderDateTime, shopNumber, itemsSummary, items[],
deliveryTip, smallOrderFee,
employeeDiscountAmount, ownerChargeCouponDiscountAmount, baeminChargeCouponDiscountAmount,
orderInstantDiscountAmount, totalInstantDiscountAmount,
instantDiscounts[{id, bucketType, policyType, amount, distributions[]}],
adCampaign, deliveryCarryType, serviceType, tags,
partialCanceled, isPartialCanceled
```

**`settle` 객체 주요 필드**:
```
orderBrokerageAmount,
orderBrokerageItems[{code, name, amount, depth3Items}],
deliveryItemAmount,
deliveryItems[{code, name, amount, depth3Items}],
etcItemAmount,
etcItems[{code, name, amount, sequence}],
deductionAmountTotalVat,
meetAmount,
depositDueAmount,
depositDueDate,
total
```

### `settle` 항목 code 전수

**`orderBrokerageItems[]`**:
| code | 의미 | 부호 |
|---|---|---|
| `ORDER_AMOUNT` | 주문금액 (할인 전) | + |
| `ADVERTISE_FEE` | 중개이용료 공급가 | − |
| `DISCOUNT_AMOUNT` | 고객할인비용 (매장 순부담, depth3 에 `TOTAL_ORDER_IMMEDIATE_DISCOUNT` / `WOOWABROS_ORDER_IMMEDIATE_DISCOUNT` 분리) | − |

**`deliveryItems[]`**:
| code | 의미 | 부호 |
|---|---|---|
| `DELIVERY_SUPPLY_PRICE` | 배달비 공급가 | − |
| `DEVLIERY_TIP_INSTANT_DISCOUNT` | 배달팁 할인비용 공급가 (오타 `DEVLIERY` 배민 API 원문) | − |
| `BAEMIN_CLUB_INSTANT_DISCOUNT` | 배민클럽 할인비용 | − (0인 경우 많음) |

**`etcItems[]`**:
| code | 의미 | 부호 |
|---|---|---|
| `SERVICE_FEE` | 결제정산수수료 공급가 | − |

## 필드 매핑 (배민 정산정보 페이지 ↔ API ↔ DB)

| 정산정보 페이지 | API 경로 | POC 필드 | DB 컬럼 |
|---|---|---|---|
| 총매출 (주문금액) | `settle.orderBrokerageItems[ORDER_AMOUNT].amount` | `menuAmount` | `sale_price` |
| 고객할인비용 | `settle.orderBrokerageItems[DISCOUNT_AMOUNT].amount` 절대값 | `storeDiscount` (v3.9.2+) | `store_discount` |
| (A) 주문중개 | (= 순매출 − 중개이용료 공급가) | — | (계산) |
| 중개이용료 공급가 | `settle.orderBrokerageItems[ADVERTISE_FEE].amount` 절대값 | `commissionFee` | `commission_fee` |
| 중개이용료 VAT | (= `deductionAmountTotalVat` × 공급가 비례분배) | `commissionFeeVat` (v3.9.2+) | `commission_fee_vat` |
| 배달비 공급가 | `settle.deliveryItems[DELIVERY_SUPPLY_PRICE].amount` 절대값 | `deliveryCost` (v3.9.2+) | `delivery_fee` |
| 배달비 VAT | (비례분배) | `deliveryFeeVat` | `delivery_fee_vat` |
| 배달팁 할인비용 공급가 | `settle.deliveryItems[DEVLIERY_TIP_INSTANT_DISCOUNT].amount` 절대값 | `deliveryTipDiscount` (v3.9.2+) | `delivery_tip_discount` |
| 배달팁 할인 VAT | (비례분배) | `deliveryTipDiscountVat` | `delivery_tip_discount_vat` |
| 결제정산수수료 공급가 | `settle.etcItems[SERVICE_FEE].amount` 절대값 | `pgFee` | `pg_fee` |
| 결제정산수수료 VAT | (비례분배 잔차) | `pgFeeVat` | `pg_fee_vat` |
| (D) 부가세 총합 | `settle.deductionAmountTotalVat` 절대값 | `vat` | `vat` |
| 입금예정금액 | `settle.depositDueAmount` | `depositDueAmount` | `settlement_amount` |
| 정산(입금)예정일 | `settle.depositDueDate` | `depositDueDate` | `settlement_date` |
| 배달팁 (고객 지불) | `order.deliveryTip` | `deliveryTip` | `delivery_income` |
| 즉시할인 UI 합계 (매장+배민) | `order.totalInstantDiscountAmount` | `instantDiscount` | `instant_discount` |

### 광고비 (별도 API)

| 필드 | 경로 | POC | DB |
|---|---|---|---|
| CPC 일별 광고비 공급가 | `GET /v2/statistics/campaign/cpc/metrics/{shopNumber}` → `data.dailyMetrics[].spentBudget` | `collectAdCost()` | `crawler_daily_settlements.ad_cost` |
| 광고비 정산일 | 주문의 `depositDueDate` 로 역매핑 (CPC API 가 settlement_date 미제공) | `settlementDateMap` | `ad_cost_settlement_date` |

광고비 표시는 **공급가 × 1.1 VAT 포함** (배민 정산명세서 UI 기준).

## VAT 분리 방식

배민 API 는 각 수수료별 VAT 를 별도 제공하지 않음 → `deductionAmountTotalVat` 합계 1개만 제공.
POC (v3.9.2+) 가 공급가 비례분배:

```
vatTotal = |deductionAmountTotalVat|
supplySum = commission + delivery + deliveryTipDiscount + pgFee
commissionFeeVat = round(vatTotal × commission / supplySum)
deliveryFeeVat = round(vatTotal × delivery / supplySum)
deliveryTipDiscountVat = round(vatTotal × deliveryTipDiscount / supplySum)
pgFeeVat = vatTotal − (위 3개 합)  ← 반올림 누적오차 0 보장
```

## 주의사항

### 시간대 (v3.5.8+)
- `orderedAt` 은 `2026-03-08T22:31:39` 형식 (TZ 없음).
- 배민은 항상 KST 로 내려주는데 `new Date()` 가 UTC 로 해석하면 하루 밀림.
- POC 가 `+09:00` suffix 수동 부착.

### 취소건 (v3.5.8+)
- `order.status = "CANCELLED"` 별도 row 로 제공 (orderType 은 `DELIVERY` 그대로).
- 이전에는 `orderType === 'CANCELLED'` 로 판별했으나 오분류 발생 → `status` 기준으로 교체.

### sale_price 정의 (v3.9.2 rebuild)
- v3.5.4 ~ v3.9.1: `menuAmount = payAmount − deliveryTip` → 할인 후 결제금액 저장 (🐛 버그)
- v3.9.2+: `menuAmount = settle.ORDER_AMOUNT` → 할인 전 주문금액 (정산서 "총매출" 과 일치)

### 광고비 부호
- CPC API 의 `spentBudget` 는 양수 공급가.
- 정산서 VAT 포함 표시는 `× 1.1` 로 엑셀 렌더 시점 계산 (DB 는 공급가 보존).

### 고객할인비용 = 매장부담 (`DISCOUNT_AMOUNT`)
- `depth3Items` 에 `TOTAL_ORDER_IMMEDIATE_DISCOUNT` (매장 + 배민 합) 와 `WOOWABROS_ORDER_IMMEDIATE_DISCOUNT` (배민 보조분) 가 분리되어 있음.
- `DISCOUNT_AMOUNT.amount` 는 이미 net (매장 순부담만). depth3 재계산 불필요.

## 검증 워크플로우

1. 고기왕김치찜 주문 하나 선정 (DB)
2. `SELECT * FROM crawler_orders WHERE platform='baemin' AND order_id='T2AV...'`
3. 배민 self 사이트 → 해당 주문의 정산정보 페이지 스크린샷
4. 위 필드 매핑표 기준으로 1:1 대조
5. diff 있으면 [샘플 raw](../api-samples/baemin/sample-order-full.json) 와 비교해 POC 파싱 로직 점검
