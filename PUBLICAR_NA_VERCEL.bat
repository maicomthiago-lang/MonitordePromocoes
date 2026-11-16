@echo off
chcp 65001 >nul
title Publicar monitordepromocoes na Vercel (maicomthiago-2828)
cd /d "%~dp0"

echo ====================================================================
echo   PUBLICANDO PROJETO NA VERCEL
echo   Painel: https://vercel.com/maicomthiago-2828/monitordepromocoes
echo ====================================================================
echo.

echo [1/2] Vinculando ao escopo maicomthiago-2828 e projeto monitordepromocoes...
call npx vercel link --scope maicomthiago-2828 --project monitordepromocoes --yes

echo.
echo [2/2] Enviando build de producao para a Vercel...
call npx vercel --prod --scope maicomthiago-2828 --yes

echo.
echo ====================================================================
echo   DEPLOY CONCLUIDO! Abrindo painel na Vercel...
echo   URL do Painel: https://vercel.com/maicomthiago-2828/monitordepromocoes
echo ====================================================================
start https://vercel.com/maicomthiago-2828/monitordepromocoes
pause