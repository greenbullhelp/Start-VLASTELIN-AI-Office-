@echo off
chcp 65001 >nul
schtasks /Delete /F /TN "JarvisNode" && echo Автозапуск вимкнено. Щоб зупинити вузол зараз: значок у треї - Вийти.
pause
