@echo off
cd /d "%~dp0.."
if exist public (
    rmdir /s /q public
    echo Cleaned public/
) else (
    echo public/ not found
)
pause
