@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Dang push len https://github.com/trandatdev-vn/studio ...
git remote set-url origin https://github.com/trandatdev-vn/studio.git
git push -u origin main
if %ERRORLEVEL% EQU 0 (
  echo.
  echo THANH CONG! Mo: https://github.com/trandatdev-vn/studio
) else (
  echo THAT BAI - chup man hinh gui minh
)
pause
