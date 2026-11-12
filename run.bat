@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo  한글 뷰어 (HWP / HWPX)를 시작합니다.
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [오류] Python 3가 필요합니다. https://www.python.org/downloads/ 에서 설치해 주세요.
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [오류] 첫 실행에는 Node.js가 필요합니다. https://nodejs.org/ 에서 설치해 주세요.
    pause
    exit /b 1
  )
  echo  처음 실행을 위한 준비 중입니다...
  if not exist "node_modules\vite" (
    call npm install
    if errorlevel 1 goto :error
  )
  call npm run build
  if errorlevel 1 goto :error
  echo.
)

python serve.py
goto :eof

:error
echo.
echo  준비 중 오류가 발생했습니다. 위 메시지를 확인해 주세요.
pause
