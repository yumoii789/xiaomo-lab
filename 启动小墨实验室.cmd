@echo off
chcp 65001 >nul
cd /d "%~dp0"
title XiaoMo Lab
node "desktop\launch.mjs" %*
if errorlevel 1 pause
