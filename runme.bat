@echo off
setlocal EnableExtensions DisableDelayedExpansion
title SheeshhClipper
pushd "%~dp0" || goto bad_directory
if not exist compose.yaml goto bad_checkout
where /q docker.exe || goto no_docker
docker compose version >nul 2>&1 || goto no_docker
docker info >nul 2>&1 || goto docker_stopped
if not exist "data\cache\" mkdir "data\cache"
echo Building and starting SheeshhClipper...
docker compose up -d --build --wait --wait-timeout 120
if errorlevel 1 goto failed
set "clipper_port="
for /f "tokens=2 delims=:" %%P in ('docker compose port clipper 8000 2^>nul') do set "clipper_port=%%P"
if not defined clipper_port goto failed
echo SheeshhClipper is ready at http://localhost:%clipper_port%/
start "" "http://localhost:%clipper_port%/"
popd
exit /b 0
:bad_directory
echo Could not open the folder containing this launcher.
pause
exit /b 1
:bad_checkout
echo Put runme.bat next to compose.yaml in the SheeshhClipper folder.
goto failed
:no_docker
echo Install Docker Desktop with Docker Compose and open it.
goto failed
:docker_stopped
echo Open Docker Desktop and wait for its engine to start.
goto failed
:failed
echo See the message above. For app logs, run docker compose logs --tail 60 in this folder.
pause
popd
exit /b 1
