; Custom NSIS script for barcode-scanner
; 1) 구 버전(oneClick:false) 레지스트리 잔여물 자동 정리
; 2) 실행 중인 앱 프로세스 강제 종료
; → 매장 POS에서 자동 업데이트 시 수동 개입 없이 깨끗하게 설치

!macro customInit
  ; ── 1) 구 버전 언인스톨 레지스트리 정리 ──
  ; oneClick:false → oneClick:true 전환 시 구 레지스트리가 남아있으면
  ; "Failed to uninstall old application files" 에러 발생.
  ; 구 항목을 삭제하면 NSIS가 신규 설치로 진행한다.
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.semicolon.barcode-scanner"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{com.semicolon.barcode-scanner}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\매출지킴이 바코드 스캐너"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.semicolon.barcode-scanner"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{com.semicolon.barcode-scanner}"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\매출지킴이 바코드 스캐너"

  ; ── 2) 실행 중인 앱 강제 종료 ──
  nsExec::Exec 'taskkill /f /im "${APP_EXECUTABLE_FILENAME}"'
  Sleep 2000
!macroend
