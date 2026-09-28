# Builds dist\PioBridge.exe and dist\PioProbe.exe with Docker (no Go install needed).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
docker run --rm -v "${PWD}:/src" -w /src golang:1.24 sh -c 'go mod tidy && go vet ./... && go test ./... && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H windowsgui" -o dist/PioBridge.exe ./cmd/piobridge && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o dist/PioProbe.exe ./cmd/probe && ls -la dist'
