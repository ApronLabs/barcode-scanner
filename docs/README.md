# 크롤러 플랫폼 스펙 문서

배달플랫폼 4개 (배민·쿠팡이츠·요기요·땡겨요) 의 주문/정산 API 를 POC 가 어떻게 파싱해 매출지킴이(노심) 로 전송하는지 기록한 메타 문서.

## 왜 이 문서가 있는가

- 바코드스캐너 수정할 때마다 "이 필드가 어디서 왔더라?" 재조사 반복을 막기 위함
- 플랫폼 사이트 UI 와 우리 DB 값이 안 맞을 때 원인 추적 시작점
- 신규 수수료/할인 항목 추가 시 4개 플랫폼 횡단 영향도 점검용

## 플랫폼별 문서

| 플랫폼 | 문서 | 공급가/VAT 분리 | 비고 |
|---|---|---|---|
| 배민 | [`platforms/baemin.md`](platforms/baemin.md) | ✅ 공급가 저장, VAT 합계 → 비례분배 | v3.9.2+ 완전 재작성 |
| 쿠팡이츠 | [`platforms/coupangeats.md`](platforms/coupangeats.md) | ✅ 공급가·VAT 모두 API 제공 | `sale_price` 의미 후속 수정 필요 |
| 요기요 | [`platforms/yogiyo.md`](platforms/yogiyo.md) | ⚠ VAT 단일 합계, 공급가 × 0.1 폴백 | 문자열 파싱 의존 |
| 땡겨요 | [`platforms/ddangyoyo.md`](platforms/ddangyoyo.md) | ❌ 수수료 자체 미제공 | 구조적 한계 |

## 플랫폼 비교 요약

### 로그인
모두 BrowserWindow 기반 ID/PW 로그인. 세션쿠키 유지.

### API 인터셉트 vs 직접호출
| 플랫폼 | 방식 |
|---|---|
| 배민 | webview fetch/XHR 래핑 → `window._baeminApiCaptures` 큐에서 꺼냄 |
| 쿠팡이츠 | webview 내 `fetch(...)` 직접 호출, `executeJavaScript` 결과 |
| 요기요 | webview 내 `fetch(...)` 직접 호출 |
| 땡겨요 | fetch/XHR 인터셉트 (SPA URL/body 재사용) |

### 주문금액 (할인 전) 필드
| 플랫폼 | 필드 경로 |
|---|---|
| 배민 | `settle.orderBrokerageItems[ORDER_AMOUNT].amount` |
| 쿠팡이츠 | `orderSettlement.totalAmount` |
| 요기요 | `order.items_price` |
| 땡겨요 | `order.sale_amt` |

### 매장부담 할인 필드
| 플랫폼 | 필드 경로 | 특이사항 |
|---|---|---|
| 배민 | `settle.orderBrokerageItems[DISCOUNT_AMOUNT].amount` (절대값) | depth3 에 매장/배민 분리 (이미 net) |
| 쿠팡이츠 | `orderSettlement.storePromotionAmount` | — |
| 요기요 | `settlement_items[LIKE '사장님/타임/프로모션/쿠폰']` 합산 | 문자열 매칭 |
| 땡겨요 | 미제공 | — |

### 정산금액 (입금예정) 필드
| 플랫폼 | 필드 경로 |
|---|---|
| 배민 | `settle.depositDueAmount` |
| 쿠팡이츠 | `totalPayment − subtractAmount` |
| 요기요 | `settlement_info.settlement_amount` |
| 땡겨요 | `order.tot_setl_amt` |

## 검증 워크플로우 (공통 4단계)

1. **샘플 주문 1건 선정** — DB 에서 최근 주문 하나
2. **DB 값 추출** — `SELECT * FROM crawler_orders WHERE platform=? AND order_id=?`
3. **플랫폼 사이트 값 추출** — 정산정보 페이지 스크린샷 또는 raw JSON 덤프
4. **필드별 1:1 대조** — 각 플랫폼 문서의 "필드 매핑" 표 기준

## Raw JSON 샘플

`api-samples/{platform}/` 에 플랫폼별 1~2건 커밋. 새 버전 POC 릴리스 전에 업데이트 권장.

현재 상태:
- 배민: ✅ rawData (order + settle) 포함 `sample-order-full.json`
- 쿠팡이츠: ✅ orderSettlement 포함 `sample-order-full.json`
- 요기요: ⚠ mapped 만 `sample-order-mapped.json` (raw 재수집 필요)
- 땡겨요: ⚠ mapped 만 `sample-order-mapped.json`

## Raw JSON 재수집 방법

POC 는 `DUMP_RAW=1` 환경변수 설정 시 raw 응답 샘플 (기본 5건) 을 `docs/api-samples/{platform}/{targetDate}.json` 에 자동 저장합니다.

```bash
DUMP_RAW=1 npx electron scripts/poc-baemin.js \
  --id=<아이디> --pw=<비밀번호> \
  --mode=daily --targetDate=2026-04-19 \
  --storeId=<매장UUID>
```

실행 후 결과 파일 예시:
- `docs/api-samples/baemin/2026-04-19.json`
- `docs/api-samples/coupangeats/2026-04-19.json`
- `docs/api-samples/yogiyo/2026-04-19.json` (주문 + 정산 모달 응답 쌍)
- `docs/api-samples/ddangyoyo/2026-04-19.json`

구현: [`scripts/lib/raw-dumper.js`](../scripts/lib/raw-dumper.js)

**민감정보 주의**: 커밋 전에 샘플 JSON 에서 매장명·전화번호·주소가 있다면 redact.

## 후속 작업

- [ ] 요기요/땡겨요 raw JSON 수집 후 커밋 (DUMP_RAW=1 로 실행)
- [ ] 각 플랫폼 문서의 검증 워크플로우 실제 실행 — 주문 1건씩 DB vs 사이트 대조
- [ ] 쿠팡이츠 `sale_price` 정의 확정 (실측 대조 후 — `totalPayment` 유지 가능성 높음)
- [ ] 땡겨요 정산명세서 페이지 API 엔드포인트 캡처 (수수료 breakdown 확보)
- [ ] 요기요 페이지네이션 누락 이슈 규명
