@echo off
title 매출지킴이 바코드 스캐너
echo.
echo ========================================
echo   매출지킴이 바코드 스캐너
echo ========================================
echo.
echo 서버 시작 중...
echo.

:: 3초 후 브라우저 자동 열기 (서버 시작 대기)
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3333"

:: 서버 실행
npm start
pause
