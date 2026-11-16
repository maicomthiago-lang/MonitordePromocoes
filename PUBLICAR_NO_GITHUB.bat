@echo off
chcp 65001 >nul
title Enviar monitordepromocoes para o GitHub
cd /d "%~dp0"

echo ========================================================
echo   ENVIANDO PROJETO PARA O GITHUB (monitordepromocoes)
echo ========================================================
echo.

where git >nul 2>&1
if errorlevel 1 (
    echo [ERRO] O Git nao foi encontrado no seu computador!
    echo Baixe e instale em: https://git-scm.com/download/win
    pause
    exit /b 1
)

if not exist ".git" (
    echo [1/5] Inicializando repositorio Git local...
    git init
)

echo [2/5] Configurando branch principal (main)...
git branch -M main

echo [3/5] Conectando ao repositorio remoto...
git remote remove origin >nul 2>&1
git remote add origin https://github.com/maicomthiago-lang/MonitordePromocoes.git

echo [4/5] Adicionando arquivos e criando commit...
git add .
git commit -m "chore: renomeia projeto para monitordepromocoes (padrao Vercel e Git)"

echo [5/5] Enviando arquivos para o GitHub...
git push -u origin main --force

if errorlevel 1 (
    echo.
    echo [AVISO] Caso seu repositorio no GitHub ainda se chame Monitor_de_Promocoes, tentando enviar para ele tambem...
    git remote set-url origin https://github.com/maicomthiago-lang/MonitordePromocoes.git
    git push -u origin main --force
)

echo.
echo ========================================================
echo   PROCESSO CONCLUIDO!
echo ========================================================
pause
