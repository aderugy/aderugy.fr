//go:build windows

package main

import (
	"aderugy.fr/pio-bridge/internal/bridge"
	"aderugy.fr/pio-bridge/internal/tray"
	"aderugy.fr/pio-bridge/internal/winutil"
)

func run(app *bridge.App) {
	if !winutil.SingleInstance("aderugy-PioBridge") {
		// Already running: just show its status page.
		_ = winutil.OpenURL(app.URL())
		return
	}
	if err := app.Listen(); err != nil {
		winutil.Alert("PioBridge", err.Error()+"\n\nChange the port in "+bridge.DefaultConfigPath()+" and start PioBridge again.")
		return
	}
	tray.Run(app)
}
