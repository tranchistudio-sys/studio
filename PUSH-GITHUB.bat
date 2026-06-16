@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo  PUSH len: tranchistudio-sys/studio
echo  (repo ban vua tao o day)
echo ========================================
echo.
echo Dang nhap tai khoan: tranchistudio-sys
echo.
git remote set-url origin https://github.com/tranchistudio-sys/studio.git
git push -u origin main
if %ERRORLEVEL% EQU 0 (
  echo.
  echo THANH CONG!
  echo https://github.com/tranchistudio-sys/studio
) else (
  echo THAT BAI - chup man hinh gui minh
)
pause
