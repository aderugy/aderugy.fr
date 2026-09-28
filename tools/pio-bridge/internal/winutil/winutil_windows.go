//go:build windows

// Package winutil holds the few Windows calls the tray app needs.
package winutil

import (
	"errors"
	"os"
	"os/exec"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`

// SingleInstance returns false if another PioBridge is already running.
// The mutex lives as long as the process.
func SingleInstance(name string) bool {
	p, err := windows.UTF16PtrFromString(`Local\` + name)
	if err != nil {
		return true
	}
	_, err = windows.CreateMutex(nil, false, p)
	return !errors.Is(err, windows.ERROR_ALREADY_EXISTS)
}

// AutostartEnabled reports whether HKCU\…\Run starts this exe at logon.
func AutostartEnabled(name string) bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetStringValue(name)
	if err != nil {
		return false
	}
	exe, _ := os.Executable()
	return v == `"`+exe+`"`
}

func SetAutostart(name string, on bool) error {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !on {
		err := k.DeleteValue(name)
		if errors.Is(err, registry.ErrNotExist) {
			return nil
		}
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return k.SetStringValue(name, `"`+exe+`"`)
}

// OpenURL opens a URL in the default browser.
func OpenURL(u string) error {
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", u).Start()
}

// OpenFolder opens a folder in Explorer.
func OpenFolder(dir string) error { return exec.Command("explorer.exe", dir).Start() }

// Alert shows a blocking message box (used before the tray exists).
func Alert(title, msg string) {
	t, _ := windows.UTF16PtrFromString(title)
	m, _ := windows.UTF16PtrFromString(msg)
	windows.MessageBox(0, m, t, windows.MB_OK|windows.MB_ICONWARNING)
}
