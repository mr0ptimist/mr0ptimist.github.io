@echo off
chcp 65001 >nul
cd /d "%~dp0.."
python organize_post_images.py %*
pause
