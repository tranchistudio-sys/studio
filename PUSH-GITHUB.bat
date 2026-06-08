@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo  PUSH code len GitHub
echo  Repo: mrvanlong2020/studio
echo ========================================
echo.

git remote set-url origin https://github.com/mrvanlong2020/studio.git 2>nul
if errorlevel 1 git remote add origin https://github.com/mrvanlong2020/studio.git

echo Dang push branch feature/additional-services-jun2026 ...
git push -u origin main:feature/additional-services-jun2026

if %ERRORLEVEL% EQU 0 (
  echo.
  echo THANH CONG!
  echo https://github.com/mrvanlong2020/studio/tree/feature/additional-services-jun2026
) else (
  echo.
  echo THAT BAI.
  echo - Dang nhap dung tai khoan: mrvanlong2020
  echo - Link repo phai la: github.com/mrvanlong2020/studio
)

echo.
pause
