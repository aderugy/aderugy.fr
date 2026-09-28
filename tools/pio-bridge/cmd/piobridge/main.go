// PioBridge: local bridge between aderugy.fr and PioSOLVER.
// Windows: a tray app (no console). Elsewhere: headless, for tests with a fake solver.
package main

import (
	"flag"
	"io"
	"log"
	"os"
	"path/filepath"

	"aderugy.fr/pio-bridge/internal/bridge"
)

const version = "0.1.0"

func main() {
	cfgPath := flag.String("config", bridge.DefaultConfigPath(), "config file")
	flag.Parse()

	logPath := filepath.Join(bridge.DataDir(), "bridge.log")
	_ = os.MkdirAll(filepath.Dir(logPath), 0o755)
	rotate(logPath, 5<<20)
	if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		log.SetOutput(io.MultiWriter(f, os.Stderr))
	}
	log.SetFlags(log.LstdFlags)

	cfg, err := bridge.LoadConfig(*cfgPath)
	app := bridge.NewApp(cfg, *cfgPath, version)
	if err != nil {
		app.Logf("config: %v (using defaults where needed)", err)
	}
	run(app)
}

// rotate keeps one previous log when the current one grows past max bytes.
func rotate(path string, max int64) {
	if st, err := os.Stat(path); err == nil && st.Size() > max {
		_ = os.Rename(path, path+".1")
	}
}
