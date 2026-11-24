@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions

rem agy-aio 一键安装入口（Windows CMD）。
rem 本脚本只负责检查 Node.js 版本，然后转交给 bin\agy-aio.mjs 执行安装逻辑。

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [错误] 未检测到 Node.js。
  echo [ERROR] Node.js was not found.
  echo.
  echo 请安装 Node.js 18.18.0 或更高版本：
  echo Please install Node.js 18.18.0 or newer from https://nodejs.org/
  echo.
  if "%~1"=="" pause
  exit /b 1
)

node -e "const [M,m]=process.versions.node.split('.').map(Number); if(M<18||(M===18&&m<18)) process.exit(1)" >nul 2>&1
if errorlevel 1 (
  echo.
  echo [错误] Node.js 版本过低，需要 18.18.0 或更高版本。
  echo [ERROR] Node.js is too old. Version 18.18.0 or newer is required.
  echo.
  echo 请升级 Node.js：
  echo Please upgrade Node.js from https://nodejs.org/
  echo.
  if "%~1"=="" pause
  exit /b 1
)

if not exist "%~dp0bin\agy-aio.mjs" (
  echo.
  echo [错误] 找不到 CLI 入口：%~dp0bin\agy-aio.mjs
  echo [ERROR] CLI entry not found: %~dp0bin\agy-aio.mjs
  echo.
  if "%~1"=="" pause
  exit /b 1
)

node "%~dp0bin\agy-aio.mjs" install %*
set EXIT_CODE=%errorlevel%

rem 仅当从资源管理器双击运行时暂停，避免自动化调用被挂起。
if "%~1"=="" pause
exit /b %EXIT_CODE%
