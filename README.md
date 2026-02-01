# 매출지킴이 바코드 스캐너 v2.1

Windows용 Electron 앱으로 제공되는 바코드 스캐너 프로그램

## 기능

- **입고 모드**: 바코드 스캔 시 재고 +1
- **출고 모드**: `-` 접두사 바코드 스캔 시 재고 -1
- **TTS 음성 안내**: "품목명 1개 입고/출고 되었습니다"
- **트레이 아이콘**: 백그라운드 실행
- **자동 업데이트**: GitHub Releases 기반

---

## 설치 방법 (일반 사용자)

### 1. 설치 파일 다운로드
1. [Releases](https://github.com/semicolon-devteam/proj-sales-keeper/releases) 페이지 접속
2. 최신 `매출지킴이-바코드-스캐너-Setup-x.x.x.exe` 다운로드
3. 설치 프로그램 실행

### 2. 환경 설정
설치 후 `.env` 파일 설정 필요:
- 설치 경로에서 `.env.example`을 `.env`로 복사
- Supabase 정보 및 매장 ID 입력

### 3. 실행
- 바탕화면 또는 시작 메뉴에서 "매출지킴이 바코드 스캐너" 실행
- 트레이 아이콘으로 백그라운드 실행됨

---

## 개발자용

### 로컬 실행
```bash
cd apps/barcode-scanner
npm install
npm start
```

### 빌드
```bash
npm run build      # Windows .exe 생성
npm run build:dir  # 폴더 형태로 빌드 (디버그용)
```

### 릴리스 (GitHub Actions)
```bash
git tag barcode-scanner-v2.1.0
git push origin barcode-scanner-v2.1.0
```
→ GitHub Actions가 자동으로 빌드 후 Release 생성

---

## 사용 방법

### 입고 (기본)
바코드 스캔 → 재고 +1 증가 → "품목명 1개 입고 되었습니다" 음성

### 출고
바코드 스캐너에 `-` 접두사 설정 후 스캔
→ 재고 -1 감소 → "품목명 1개 출고 되었습니다" 음성

### 트레이 메뉴
- 우클릭 → 메뉴 표시
- 업데이트 확인, 종료 가능

---

## 문제 해결

### 바코드 스캔이 한글로 입력됨
- Windows IME가 영문 모드인지 확인
- 또는 바코드 스캐너 설정에서 "영문 전환" 활성화

### 음성이 안 나옴
- Windows 음성 설정 확인
- 설정 → 시간 및 언어 → 음성 → 한국어 음성 설치

### "등록되지 않은 바코드입니다"
- 매출지킴이 웹에서 해당 품목에 바코드 등록 필요

---

## 아이콘 준비 (빌드 전 필수)

`assets/` 폴더에 아래 파일 추가:
- `icon.ico` - Windows 설치 아이콘 (256x256)
- `icon.png` - 트레이 아이콘 (32x32 또는 64x64)
