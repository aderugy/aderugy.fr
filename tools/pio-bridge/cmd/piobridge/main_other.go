//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"

	"aderugy.fr/pio-bridge/internal/bridge"
)

func run(app *bridge.App) {
	if err := app.Listen(); err != nil {
		app.Logf("%v", err)
		os.Exit(1)
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	app.Shutdown()
}
