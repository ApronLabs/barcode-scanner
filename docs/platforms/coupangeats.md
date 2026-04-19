# 쿠팡이츠 크롤러 스펙

**POC 파일**: [`scripts/poc-coupangeats.js`](../../scripts/poc-coupangeats.js)
**Raw 샘플**: [`../api-samples/coupangeats/sample-order-full.json`](../api-samples/coupangeats/sample-order-full.json)

## 로그인

- 사이트: https://store.coupangeats.com/merchant/login
- 방식: ID + 비밀번호
- Electron BrowserWindow 로그인 → 세션쿠키 유지
- POC CLI: `--id=<아이디> --pw=<비밀번호>`

## API 엔드포인트

| 용도 | 메서드/URL | 파라미터 |
|---|---|---|
| 주문 리스트 (필터+조회) | `POST https://store.coupangeats.com/api/v1/merchant/web/order/condition` | body: `{startDate, endDate, page, size, storeIds}` |
| 주문 상세 (매장관리 페이지) | `GET https://store.coupangeats.com/merchant/management/orders/{id}` | (HTML, 크롤 불필요) |
| 매장 목록 | (로그인 후 홈 페이지에서 `defId` 추출) | — |

**호출 방식**: Electron webview 내에서 직접 `fetch(...)` 호출 (인터셉트 불필요). 응답 JSON 을 `executeJavaScript` 결과로 받아감.

## 응답 구조

### `POST /order/condition` 응답

```
{
  orderPageVo: {
    content: [
      { ...orderObject (아래 필드) }
    ],
    totalElements
  },
  totalOrderCount,
  totalSalePrice
}
```

### 주문 객체 필드 ([샘플](../api-samples/coupangeats/sample-order-full.json))

```
abbrOrderId, orderId, status (CANCELLED 포함),
salePrice, totalAmount, totalPayment, actuallyAmount,
orderSettlement: {
  commissionTotal, commissionVat,
  serviceSupplyPrice: { appliedSupplyPrice, ... },
  paymentSupplyPrice: { appliedSupplyPrice, ... },
  deliverySupplyPrice: { appliedSupplyPrice, ... },
  advertisingSupplyPrice: { appliedSupplyPrice, ... },
  storePromotionAmount,
  mfdTotalAmount,
  favorableFee,
  subtractAmount,
  settlementDueDate,
  hasSettled
}
```

**핵심**: 쿠팡이츠는 **각 수수료 `appliedSupplyPrice` 로 공급가를 이미 분리 제공**. 배민과 달리 VAT 직접 계산 필요 없음 (`commissionVat` 명시 필드).

## 필드 매핑

| 항목 | API 경로 | POC 필드 | DB 컬럼 |
|---|---|---|---|
| 주문금액 (할인 전 원가) | `totalAmount` | (POC 변환 후) | `sale_price`? (⚠ 현재는 `totalPayment` 저장, v3.9.2 후속 PR 필요) |
| 결제금액 (즉시할인 적용 후) | `totalPayment` | `totalPayment` | `total_payment` |
| 즉시할인 | `orderSettlement.mfdTotalAmount` | `instantDiscount` | `instant_discount` |
| 매장부담 할인 | `orderSettlement.storePromotionAmount` | `storeDiscount` | `store_discount` |
| 쿠팡부담 쿠폰 (역산) | `totalAmount − totalPayment − mfdTotalAmount` | (route 계산) | `platform_subsidy` |
| 중개수수료 공급가 | `orderSettlement.serviceSupplyPrice.appliedSupplyPrice` | `commissionFee` | `commission_fee` |
| 중개수수료 VAT | `orderSettlement.commissionVat` | — | `commission_fee_vat` (v3.9.2+ route 저장) |
| 결제수수료 공급가 | `orderSettlement.paymentSupplyPrice.appliedSupplyPrice` | `pgFee` | `pg_fee` |
| 배달비 공급가 | `orderSettlement.deliverySupplyPrice.appliedSupplyPrice` | `deliveryCost` | `delivery_fee` |
| 광고비 공급가 | `orderSettlement.advertisingSupplyPrice.appliedSupplyPrice` | `adFee` | `ad_fee` |
| 우대수수료 | `orderSettlement.favorableFee` | `favorableFee` | `favorable_fee` |
| 정산금액 | `totalPayment − subtractAmount` | — | `settlement_amount` |
| 정산예정일 | `orderSettlement.settlementDueDate` | `settlementDate` | `settlement_date` |
| 정산완료 여부 | `orderSettlement.hasSettled` | `isSettled` | `is_settled` |

## VAT 분리 방식

✅ **쿠팡이츠 API 가 수수료별 공급가를 직접 제공** + `commissionVat` 명시 → 비례분배 불필요.
단, 현재 `pgVat`, `deliveryVat`, `adVat` 필드 존재 여부 미확인 (샘플 대조 필요).

## 주의사항

### 즉시할인 구조 차이
- `totalAmount`: 할인 적용 전 원가 (배민의 `ORDER_AMOUNT` 와 유사)
- `salePrice`: 할인 후 결제금액 (≈ `totalPayment`)
- `mfdTotalAmount`: 즉시할인 (쿠팡부담 + 매장부담 합)
- 매장부담 할인은 `storePromotionAmount` 에 별도 (배민 `DISCOUNT_AMOUNT` 와 동일 의미)

### `sale_price` 정의 불일치 (⚠ 후속 수정 필요)
- 현재 ingest route가 `sale_price: order.totalPayment` (결제금액) 저장 중.
- 배민 v3.9.2 와 동일 원칙 적용하려면 `totalAmount` (할인 전) 로 바꿔야 함.
- 다음 PR 범위.

### 쿠팡부담 쿠폰
- 쿠팡 UI/API 어디에도 "쿠팡부담 쿠폰" 명시 필드 없음.
- `totalAmount − totalPayment − mfdTotalAmount` 로 역산.
- POC v3.5.5+ `totalAmount` 추가 저장으로 이 계산 가능.

### 취소건
- `status = 'CANCELLED'` 로 구분 (배민과 동일 컨벤션).
- 배민은 별도 row, 쿠팡은 동일 row 에 status 만 바뀜.

## 검증 워크플로우

1. 고기왕김치찜 쿠팡이츠 주문 하나 선정 (DB)
2. `SELECT * FROM crawler_orders WHERE platform='coupangeats' AND order_id='...'`
3. 쿠팡이츠 사장님포털 → 해당 주문의 정산내역 스크린샷
4. [샘플 raw](../api-samples/coupangeats/sample-order-full.json) 의 `orderSettlement` 와 비교
5. diff 있으면 해당 필드의 `appliedSupplyPrice` / `Vat` 대조
