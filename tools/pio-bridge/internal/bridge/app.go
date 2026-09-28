package bridge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// App is the whole bridge minus the tray: config, solver manager, HTTP server.
type App struct {
	Version string

	cfgPath string
	m       *Manager
	srv     *http.Server
	addr    string
	token   string // CSRF token for the status page forms (per run)

	logMu   sync.Mutex
	reqs    []ReqLog
	logTail []string
}

type ReqLog struct {
	Time     time.Time `json:"time"`
	Method   string    `json:"method"`
	Path     string    `json:"path"`
	Origin   string    `json:"origin,omitempty"`
	Status   int       `json:"status"`
	Duration int64     `json:"ms"`
}

func NewApp(cfg Config, cfgPath, version string) *App {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	a := &App{Version: version, cfgPath: cfgPath, token: hex.EncodeToString(b)}
	a.m = NewManager(cfg)
	a.m.Logf = a.Logf
	return a
}

func (a *App) Manager() *Manager { return a.m }
func (a *App) Config() Config    { return a.m.Config() }

// URL of the status page.
func (a *App) URL() string { return fmt.Sprintf("http://127.0.0.1:%d/", a.Config().Port) }

// Logf writes to the log file (standard logger) and keeps a tail for the page.
func (a *App) Logf(format string, args ...any) {
	s := fmt.Sprintf(format, args...)
	log.Print(s)
	a.logMu.Lock()
	a.logTail = append(a.logTail, time.Now().Format("15:04:05 ")+s)
	if len(a.logTail) > 200 {
		a.logTail = a.logTail[len(a.logTail)-200:]
	}
	a.logMu.Unlock()
}

func (a *App) record(r ReqLog) {
	a.logMu.Lock()
	a.reqs = append(a.reqs, r)
	if len(a.reqs) > 100 {
		a.reqs = a.reqs[len(a.reqs)-100:]
	}
	a.logMu.Unlock()
}

// Listen binds 127.0.0.1 only (no firewall prompt, unreachable from the LAN)
// and serves in the background.
func (a *App) Listen() error {
	port := a.Config().Port
	a.addr = net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	ln, err := net.Listen("tcp", a.addr)
	if err != nil {
		return fmt.Errorf("cannot listen on %s (already used by another program?): %w", a.addr, err)
	}
	a.srv = &http.Server{
		Handler:           a.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	a.Logf("PioBridge %s listening on http://%s", a.Version, a.addr)
	go func() {
		if err := a.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			a.Logf("server stopped: %v", err)
		}
	}()
	return nil
}

func (a *App) Shutdown() {
	if a.srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = a.srv.Shutdown(ctx)
	}
	a.m.Close()
}

// SaveConfig validates, writes and applies a new config. A port change needs
// a restart of the bridge; the returned note says so.
func (a *App) SaveConfig(c Config) (note string, err error) {
	if err := c.Validate(); err != nil {
		return "", err
	}
	old := a.Config()
	if err := c.Save(a.cfgPath); err != nil {
		return "", err
	}
	a.m.SetConfig(c)
	a.Logf("settings saved")
	if c.Port != old.Port {
		return fmt.Sprintf("Saved. The new port %d applies after restarting PioBridge.", c.Port), nil
	}
	return "Saved.", nil
}
