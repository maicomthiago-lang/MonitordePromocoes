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
    echo [1/4] Inicializando repositorio Git local...
    git init
    git branch -M main
    git remote add origin https://github.com/maicomthiago-lang/MonitordePromocoes.git
)

set /p COMMIT_MSG=Digite a mensagem do commit (Enter para padrao): 
if "%COMMIT_MSG%"=="" set COMMIT_MSG=chore: atualizacao do Monitor de Promocoes 5.1

echo [2/4] Verificando arquivos modificados...
git status -s

echo [3/4] Adicionando arquivos (respeitando .gitignore) e criando commit...
git add .
git commit -m "%COMMIT_MSG%"

echo [4/4] Enviando para o GitHub (push seguro sem --force)...
git push -u origin main

echo.
echo ========================================================
echo   PROCESSO CONCLUIDO!
echo ========================================================
pause
