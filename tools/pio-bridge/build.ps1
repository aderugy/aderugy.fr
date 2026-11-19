# Builds dist\PioBridge.exe and dist\PioProbe.exe with Docker (no Go install needed).
# The steps are in docker-build.sh: Windows PowerShell 5 drops the inner quotes
# of a long `sh -c '…'` argument (-ldflags "-s -w …" got cut, "no Go files in /src").
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
docker run --rm -v "${PWD}:/src" -w /src golang:1.24 sh docker-build.sh
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
