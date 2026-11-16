@echo off
chcp 65001 >nul
title Publicar monitordepromocoes na Vercel
cd /d "%~dp0"

echo ========================================================
echo   PUBLICANDO PROJETO NA VERCEL (monitordepromocoes)
echo ========================================================
echo.
call npx vercel --prod --name monitordepromocoes
pause
