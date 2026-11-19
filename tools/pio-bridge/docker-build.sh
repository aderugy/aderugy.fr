#!/bin/sh
# Runs inside the golang:1.24 container (build.sh / build.ps1): tidy, vet,
# test, then the two Windows executables in dist/. Kept in a file so no shell
# quoting has to survive PowerShell's argument passing.
set -e
go mod tidy
go vet ./...
go test ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H windowsgui" -o dist/PioBridge.exe ./cmd/piobridge
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o dist/PioProbe.exe ./cmd/probe
ls -la dist
