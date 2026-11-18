@echo off
cd /d "%~dp0"
python app\launcher.py
if errorlevel 1 pause
