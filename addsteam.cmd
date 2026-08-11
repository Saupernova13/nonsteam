@echo off
REM addsteam - add a non-Steam PC game to Steam, with SteamGridDB artwork, from one path.
REM
REM Usage:
REM   addsteam "C:\Games\GameHere\Launch.exe"     add that exe
REM   addsteam "C:\Games\GameHere"                find the game exe in that folder
REM   addsteam <path> --name "Game Here"          override the derived name
REM   addsteam <path> --pick                      choose the SteamGridDB match yourself
REM   addsteam <path> --no-art                    skip artwork
REM   addsteam <path> --dry-run                   show what would happen
REM   addsteam --list                             list existing non-Steam entries
REM   addsteam --help                             full option list

setlocal
set "SCRIPT=%~dp0scripts\addsteam.mjs"

if not exist "%SCRIPT%" (
    echo [ERROR] Script not found: %SCRIPT%
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not on PATH. Install Node.js, then run addsteam again.
    exit /b 1
)

node "%SCRIPT%" %*
exit /b %ERRORLEVEL%
