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
echo ignoreFiles = ['\.rdc$', '\.mp4$', '\.pdf$']
) > "config\development\hugo.toml"

:: Register winfs/cc/cca protocols -> machine-stable relay (HKCU, no admin). Re-runs when
:: the entries are missing or still point at an old project-absolute path.
reg query HKCU\Software\Classes\cca\shell\open\command /ve 2>nul | findstr /i "protocol-relay" >nul || powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\setup_winfs_protocol.ps1"
copy /Y "%CD%\scripts\protocol-relay.ps1" "%LOCALAPPDATA%\GithubIO\protocols\protocol-relay.ps1" >nul

hugo server -D -p 1313
