@echo off
rem РобоАрена 3D — запуск в один клик
cd /d "%~dp0"
echo Запускаю РобоАрену 3D...
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 server.py
  goto :end
)
where python >nul 2>nul
if %errorlevel%==0 (
  python server.py
  goto :end
)
where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
  goto :end
)
echo.
echo Не найден ни Python, ни Node.js. Установи Python с python.org — больше ничего не нужно.
echo.
pause
:end
pause
