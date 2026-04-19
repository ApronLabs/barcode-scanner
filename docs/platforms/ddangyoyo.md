# 땡겨요 크롤러 스펙

**POC 파일**: [`scripts/poc-ddangyoyo.js`](../../scripts/poc-ddangyoyo.js)
**Raw 샘플**: [`../api-samples/ddangyoyo/sample-order-mapped.json`](../api-samples/ddangyoyo/sample-order-mapped.json) (⚠ mapped only)

## 로그인

- 사이트: https://boss.ddangyo.com
- 방식: ID + 비밀번호
- 로그인 후 주문내역 페이지 진입 → POC 가 SPA 내 API 호출 인터셉트

## API 엔드포인트

| 용도 | 메서드/URL | 파라미터 |
|---|---|---|
| 주문 리스트 | `POST https://boss.ddangyo.com/o2o/.../requestQryOrderList` | body: `{startDate, endDate, patsto_no, page_num}` |
| 정산 상세 합계 | `POST .../requestQryCalculateDetail` | (기간합계 API, 세부 breakdown 없음) |
| 주문별 수수료 상세 | ❌ 미확인 — 정산명세서 모달에 있을 가능성 |

**호출 방식**: Electron webview 가 페이지 내 fetch/XHR 를 인터셉트 → 재호출 (세션/헤더 재사용).

## 응답 구조

### `requestQryOrderList` 응답

```
{
  dlt_result: [
    {
      ord_id, ord_no, menu_nm,
      sale_amt, tot_setl_amt,
      setl_dt, setl_tm, ord_dttm,
      ord_tp_cd, ord_tp_nm,
      ord_prog_stat_cd, ord_prog_stat_nm,
      patsto_nm, patsto_no,
      page_num, total_cnt,
      rsrv_yn, pos_order_no,
      regl_cust_nm, regl_cust_yn,
      robot_delv_patsto_yn
    },
    ...
  ],
  dlt_result_single: { tot_cnt, ... }
}
```

## 필드 매핑

| 항목 | API 경로 | POC 필드 | DB 컬럼 |
|---|---|---|---|
| 주문금액 | `sale_amt` | `menuAmount` | `sale_price` |
| 정산액 | `tot_setl_amt` | `settlementAmount` | `settlement_amount` |
| 총 수수료 (계산) | `sale_amt − tot_setl_amt` | `totalFee` | — (저장 안 함) |
| 정산일 | `setl_dt` (YYYYMMDD) + `setl_tm` (HHMMSS) | `settlementDate` | `settlement_date` |
| 주문시각 | `ord_dttm` | `orderedAt` | `ordered_at` |
| 주문 상태 | `ord_prog_stat_cd / nm` | `orderStatus` | `order_status` |
| 주문 유형 | `ord_tp_nm` | `orderType` | `order_type` |
| 내부 주문번호 | `ord_no` | `orderIdInternal` | `order_id_internal` |
| 매장명 | `patsto_nm` | — | `brand_name` |

## VAT 분리 방식

❌ **수수료 자체가 주문 리스트 API 에 없음** → 공급가/VAT 분해 불가능.
→ 엑셀에서는 중개이용료/배달비/결제수수료 컬럼 모두 0 또는 공란.

## 주의사항

### 수수료 breakdown 부재 (구조적 한계)
- 주문 리스트 API 에 `ord_medi_amt` (주문중개료), `setl_ajst_amt` (결제정산료), `delv_agnt_amt` (배달대행료), `patstos_coup_amt` (사장님쿠폰), `plfm_coup_amt` (플랫폼쿠폰) 같은 필드가 **없음**.
- 정산명세서 페이지 (사장님라운지 > 정산 > 정산명세서)의 별도 API 가 있을 가능성이나 **D+3~7일 지연**이라 실시간 운영 부적합.
- 현재는 `총수수료 = sale − setl` 만 가능.

### 이중 집계 버그 (v3.9.1 부분 해결)
- 2026-04 기준 고기왕 3월 주문 중 11건이 `orders` 배열에는 없지만 `daily_settlements` 합계에는 포함됨.
- 원인: API 가 환불/조정 등 일부 주문을 리스트에서 제외하면서 합계만 포함.
- 메모리 기록 참고: `project_crawler_revenue_2026_04_16.md` 남은 작업 1번.

### orderedAt timezone
- `ord_dttm`, `setl_dt + setl_tm` 모두 TZ 없음.
- POC 가 `parseDdangyoyoOrderedAt` 헬퍼로 KST 간주 파싱 (v3.9.x).

## 검증 워크플로우

1. 고기왕김치찜 땡겨요 주문 선정 (DB)
2. 땡겨요 사장님라운지 → 주문내역 → 해당 주문 상세 스크린샷
3. `sale_amt`, `tot_setl_amt` 만 대조 가능
4. 수수료 breakdown 은 정산명세서 페이지와 대조 (D+7 대기)
5. **구조적으로 배민/쿠팡 수준 상세 대조는 불가능** 인정

## 후속 작업 후보

- 정산명세서 페이지 API 엔드포인트 캡처 (수수료 breakdown 확보)
- `orders` 리스트 누락 11건 원인 규명 (환불/조정 건 처리)
