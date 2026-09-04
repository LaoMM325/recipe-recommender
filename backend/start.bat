@echo off
setlocal
cd /d "%~dp0"

rem 找到可用的 Python：优先 python，退而求其次用 py -3
set "PYCMD="
where python >nul 2>nul
if not errorlevel 1 (
  set "PYCMD=python"
) else (
  where py >nul 2>nul
  if not errorlevel 1 set "PYCMD=py -3"
)
if not defined PYCMD (
  echo [ERROR] Python not found in PATH.
  echo Install Python 3.10+ from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH", then open a NEW terminal.
  pause
  exit /b 1
)

echo Using: %PYCMD%

if not exist ".venv" (
  echo [1/4] Creating virtual environment .venv ...
  %PYCMD% -m venv .venv
)

call ".venv\Scripts\activate.bat"

echo [2/4] Installing dependencies (fastapi / uvicorn / openai / python-dotenv)...
python -m pip install --upgrade pip
python -m pip install fastapi "uvicorn[standard]" openai python-dotenv

if not exist ".env" (
  echo [3/4] Creating .env from .env.example ...
  copy ".env.example" ".env" >nul
)

echo [4/4] Starting backend at http://127.0.0.1:8000
echo.
echo NOTE: open backend\.env with notepad and fill LLM_API_KEY.
echo       No key yet? set MOCK=1 to test with sample data.
echo       Press Ctrl+C in this window to stop the server.
echo.
uvicorn main:app --reload

pause
