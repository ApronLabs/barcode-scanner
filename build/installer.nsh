; Custom NSIS script for barcode-scanner
; electron-builder 24.13.2+ 에서 "Failed to uninstall old application files" 에러 해결
; 인스톨러 실행 시 기존 앱 프로세스를 taskkill로 강제 종료한다.

!macro customInit
  ; 앱 exe 강제 종료 (한글 productName)
  nsExec::Exec 'taskkill /f /im "${APP_EXECUTABLE_FILENAME}"'
  ; Electron helper 프로세스도 종료
  nsExec::Exec 'taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /fi "WINDOWTITLE eq *"'
  ; 잠시 대기 (프로세스 완전 종료)
  Sleep 2000
!macroend
