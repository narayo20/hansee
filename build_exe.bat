@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo  한글 뷰어 EXE 빌드
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [오류] Python 3가 필요합니다.
  pause
  exit /b 1
)

python -c "import PyInstaller, webview" >nul 2>nul
if errorlevel 1 (
  echo  빌드 도구를 설치합니다...
  python -m pip install --upgrade pyinstaller pywebview
  if errorlevel 1 goto :error
)

where npm >nul 2>nul
if not errorlevel 1 (
  echo  웹 앱을 빌드합니다...
  call npm run build
  if errorlevel 1 goto :error
)

if not exist "dist\index.html" (
  echo [오류] dist\index.html 이 없습니다. 먼저 npm install ^&^& npm run build 를 실행해 주세요.
  pause
  exit /b 1
)

echo  EXE를 만드는 중입니다. 잠시만 기다려 주세요...
python -m PyInstaller ^
  --noconfirm --clean --onefile --windowed ^
  --name "HangulViewer" ^
  --icon "%~dp0assets\icon.ico" ^
  --add-data "%~dp0dist;dist" ^
  --distpath "%~dp0" ^
  --workpath "%~dp0build\pyinstaller" ^
  --specpath "%~dp0build" ^
  "launcher.py"
if errorlevel 1 goto :error

rem PyInstaller가 한글 이름을 코드페이지에 맞게 처리하지 못하는 경우가 있어
rem 영문 이름으로 빌드한 뒤 PowerShell(유니코드)로 한글 이름을 붙인다.
if not exist "%~dp0HangulViewer.exe" (
  echo [오류] HangulViewer.exe 가 생성되지 않았습니다.
  goto :error
)
powershell -NoProfile -Command "$n=[string][char]0xD55C+[char]0xAE00+[char]0xBDF0+[char]0xC5B4; Move-Item -LiteralPath 'HangulViewer.exe' -Destination ($n + '.exe') -Force"
if errorlevel 1 goto :error

echo.
echo  완료: %~dp0한글뷰어.exe
echo.
pause
goto :eof

:error
echo.
echo  빌드 중 오류가 발생했습니다. 위 메시지를 확인해 주세요.
pause
exit /b 1
