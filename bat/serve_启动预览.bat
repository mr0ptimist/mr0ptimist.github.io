@echo off
cd /d "%~dp0.."

:: Relaunch in Windows Terminal if not already
if "%WT_SESSION%"=="" (
    wt -w 0 nt -d "%CD%" cmd /c "%~f0" %*
    exit /b
)

taskkill /F /IM hugo.exe >nul 2>&1

:: Auto-generate development config with project root path (for VS Code open button)
set "ROOT_DIR=%CD:\=/%"
if not exist "config\development" mkdir "config\development"
(echo [params]
echo   vscodeContentBase = '%ROOT_DIR%'
) > "config\development\hugo.toml"

:: Register winfs:// protocol for "Open in Explorer" button (once per machine, HKCU no admin)
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\setup_winfs_protocol.ps1"

hugo server -D -p 1313
