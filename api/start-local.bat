@echo off
REM Start Azure Functions locally using the Python 3.11 venv.
REM Puts the venv Scripts first in PATH so func.exe picks up Python 3.11
REM instead of the system Python 3.13.
REM
REM Usage: from the /api directory, double-click or run in a terminal.

SET "VENV_SCRIPTS=%~dp0.venv\Scripts"
SET "PATH=%VENV_SCRIPTS%;%PATH%"

echo Using Python: %VENV_SCRIPTS%\python.exe
"%VENV_SCRIPTS%\python.exe" --version

echo Starting Azure Functions...
"C:\Program Files\Microsoft\Azure Functions Core Tools\func.exe" start
