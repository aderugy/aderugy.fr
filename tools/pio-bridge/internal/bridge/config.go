package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Config is stored as JSON in %APPDATA%\PioBridge\config.json.
type Config struct {
	PioPath        string   `json:"pioPath"`
	SolvesDir      string   `json:"solvesDir"`
	Port           int      `json:"port"`
	AllowedOrigins []string `json:"allowedOrigins"`
	// IdleMinutes: the solver is stopped after this long without a request
	// (it restarts in ~0.3 s on the next one). 0 = never.
	IdleMinutes int `json:"idleMinutes"`
}

func DefaultConfig() Config {
	return Config{
		PioPath:   `D:\Programs\PioSOLVER\PioSOLVER3-edge.exe`,
		SolvesDir: `D:\Poker\Solvers`,
		Port:      7878,
		AllowedOrigins: []string{
			"https://aderugy.fr",
			"https://www.aderugy.fr",
			"http://localhost:3000",
		},
		IdleMinutes: 15,
	}
}

// DataDir is %APPDATA%\PioBridge (or the platform's equivalent).
func DataDir() string {
	d, err := os.UserConfigDir()
	if err != nil {
		d = "."
	}
	return filepath.Join(d, "PioBridge")
}

func DefaultConfigPath() string { return filepath.Join(DataDir(), "config.json") }

// LoadConfig reads the config, creating it with defaults when missing.
func LoadConfig(path string) (Config, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		c := DefaultConfig()
		return c, c.Save(path)
	}
	if err != nil {
		return DefaultConfig(), err
	}
	c := DefaultConfig()
	if err := json.Unmarshal(b, &c); err != nil {
		return DefaultConfig(), fmt.Errorf("config %s: %w", path, err)
	}
	return c, c.Validate()
}

func (c Config) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (c Config) Validate() error {
	var errs []string
	if c.Port < 1024 || c.Port > 65535 {
		errs = append(errs, "port must be between 1024 and 65535")
	}
	if c.IdleMinutes < 0 {
		errs = append(errs, "idleMinutes must be ≥ 0")
	}
	if strings.TrimSpace(c.PioPath) == "" {
		errs = append(errs, "pioPath is empty")
	}
	if strings.TrimSpace(c.SolvesDir) == "" {
		errs = append(errs, "solvesDir is empty")
	}
	for _, o := range c.AllowedOrigins {
		if !strings.HasPrefix(o, "http://") && !strings.HasPrefix(o, "https://") {
			errs = append(errs, fmt.Sprintf("origin %q must start with http:// or https://", o))
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

// OriginAllowed matches exactly, or a "https://*.example.com" wildcard on one
// subdomain level.
func (c Config) OriginAllowed(origin string) bool {
	origin = strings.TrimRight(origin, "/")
	for _, o := range c.AllowedOrigins {
		o = strings.TrimRight(o, "/")
		if strings.EqualFold(o, origin) {
			return true
		}
		if i := strings.Index(o, "://*."); i >= 0 {
			scheme, suffix := o[:i+3], o[i+4:] // "https://", ".example.com"
			if strings.HasPrefix(origin, scheme) && strings.HasSuffix(strings.ToLower(origin), strings.ToLower(suffix)) {
				sub := strings.TrimSuffix(origin[len(scheme):], suffix)
				if sub != "" && !strings.ContainsAny(sub, "./:") {
					return true
				}
			}
		}
	}
	return false
}
