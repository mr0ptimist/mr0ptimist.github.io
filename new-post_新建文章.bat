@echo off
cd /d "%~dp0"
set /p title="Post title: "
hugo new content "posts/%title%.md"
echo.
echo Created: content\posts\%title%.md
pause
