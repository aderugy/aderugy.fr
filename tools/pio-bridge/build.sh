#!/bin/sh
# Builds dist/PioBridge.exe and dist/PioProbe.exe with Docker (no Go install needed).
# From Git Bash / WSL:  ./build.sh      From PowerShell: .\build.ps1
set -e
cd "$(dirname "$0")"
docker run --rm -v "$PWD":/src -w /src golang:1.24 sh docker-build.sh
