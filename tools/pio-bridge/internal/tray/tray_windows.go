//go:build windows

package tray

import (
	"fmt"
	"path/filepath"
	"strings"

	"fyne.io/systray"

	"aderugy.fr/pio-bridge/internal/bridge"
	"aderugy.fr/pio-bridge/internal/winutil"
)

const AppName = "PioBridge"

var labels = map[bridge.State]string{
	bridge.StateIdle:       "Ready — solver starts on demand",
	bridge.StateReady:      "Ready",
	bridge.StateBusy:       "Working…",
	bridge.StateStarting:   "Starting…",
	bridge.StateError:      "Error",
	bridge.StatePioMissing: "PioSOLVER not found",
}

// Run shows the tray icon and blocks until Quit.
func Run(app *bridge.App) {
	systray.Run(func() { onReady(app) }, func() { app.Shutdown() })
}

func describe(st bridge.Status) (title, tip string) {
	title = labels[st.State]
	if title == "" {
		title = string(st.State)
	}
	tip = AppName + " — " + title
	if st.File != "" {
		tip += "\n" + filepath.Base(filepath.FromSlash(st.File))
		if len(st.Board) > 0 {
			tip += " (" + strings.Join(st.Board, " ") + ")"
		}
	}
	if st.Message != "" && (st.State == bridge.StateError || st.State == bridge.StatePioMissing) {
		tip += "\n" + st.Message
	}
	if len(tip) > 120 { // tooltip limit is 128 UTF-16 units
		tip = tip[:117] + "…"
	}
	return title, tip
}

func onReady(app *bridge.App) {
	icons := map[bridge.State][]byte{}
	iconFor := func(s bridge.State) []byte {
		if b, ok := icons[s]; ok {
			return b
		}
		b := Icon(StateColor(s))
		icons[s] = b
		return b
	}

	systray.SetTitle(AppName)
	mStatus := systray.AddMenuItem(AppName, "")
	mStatus.Disable()
	systray.AddSeparator()
	mPage := systray.AddMenuItem("Open status page", "Status, recent requests, settings")
	mFolder := systray.AddMenuItem("Open solves folder", "")
	mRestart := systray.AddMenuItem("Restart solver", "Stop PioSOLVER; it restarts on the next request")
	systray.AddSeparator()
	mAuto := systray.AddMenuItemCheckbox("Start with Windows", "", winutil.AutostartEnabled(AppName))
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "")

	var last bridge.State = "-"
	apply := func(st bridge.Status) {
		title, tip := describe(st)
		if st.State != last {
			systray.SetIcon(iconFor(st.State))
			last = st.State
		}
		systray.SetTooltip(tip)
		mStatus.SetTitle(title)
	}
	apply(app.Manager().Status())
	app.Manager().OnStatus(apply)

	go func() {
		for {
			select {
			case <-mPage.ClickedCh:
				_ = winutil.OpenURL(app.URL())
			case <-mFolder.ClickedCh:
				_ = winutil.OpenFolder(app.Config().SolvesDir)
			case <-mRestart.ClickedCh:
				go app.Manager().Stop("restart from the tray")
			case <-mAuto.ClickedCh:
				on := !mAuto.Checked()
				if err := winutil.SetAutostart(AppName, on); err != nil {
					app.Logf("start with Windows: %v", err)
					continue
				}
				if on {
					mAuto.Check()
				} else {
					mAuto.Uncheck()
				}
				app.Logf("start with Windows: %v", fmt.Sprint(on))
			case <-mQuit.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()
}
