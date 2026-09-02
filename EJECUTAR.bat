@echo off
title Descargador de Certificados - JOMISER + EIN
cd /d "%~dp0"

where pythonw >nul 2>&1
if %errorlevel%==0 (
    start "" pythonw "descargar_certificados.py"
    exit /b 0
)

where python >nul 2>&1
if %errorlevel%==0 (
    python "descargar_certificados.py"
    exit /b 0
)

echo.
echo  No se encontro Python en este equipo.
echo  Instalalo desde https://www.python.org/downloads/
echo  (marca la casilla "Add Python to PATH" durante la instalacion)
echo.
pause
