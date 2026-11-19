@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Джарвіс: встановлення вузла на ПК ===
where py >nul 2>nul || (echo Встановіть Python 3.12 з python.org ^(галочка "Add to PATH"^) і запустіть знову. & pause & exit /b 1)
if not exist .venv py -3.12 -m venv .venv || py -3 -m venv .venv
.venv\Scripts\python -m pip install --upgrade pip >nul
.venv\Scripts\python -m pip install -r requirements.txt || (echo Помилка встановлення пакетів & pause & exit /b 1)
if not exist config.toml (copy config.example.toml config.toml >nul & echo Створено config.toml - зараз відкриється Блокнот: вставте адресу сервера й токен, збережіть і закрийте. & notepad config.toml)
.venv\Scripts\python jarvis_node.py --check
echo.
echo Реєструю автозапуск разом із Windows...
schtasks /Create /F /TN "JarvisNode" /SC ONLOGON /RL LIMITED /TR "\"%~dp0.venv\Scripts\pythonw.exe\" \"%~dp0jarvis_node.py\"" >nul && echo Автозапуск увімкнено.
start "" "%~dp0.venv\Scripts\pythonw.exe" "%~dp0jarvis_node.py"
echo Готово! Значок вузла з’явився біля годинника: зелений - онлайн, червоний - немає зв’язку.
pause
