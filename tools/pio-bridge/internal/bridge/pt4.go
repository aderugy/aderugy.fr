package bridge

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"aderugy.fr/pio-bridge/internal/pt4"
)

// PokerTracker 4 endpoints. Read-only: every query runs in a read-only
// session, with the role the user configured (aderugy_ro).

func (a *App) pt4Status(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, a.pt4.Status())
}

func (a *App) pt4Players(w http.ResponseWriter, r *http.Request) {
	ps, err := a.pt4.Search(r.URL.Query().Get("q"), 25)
	if err != nil {
		writePT4Error(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"players": ps})
}

func (a *App) pt4Limits(w http.ResponseWriter, r *http.Request) {
	ls, err := a.pt4.Limits()
	if err != nil {
		writePT4Error(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"limits": ls})
}

// /pt4/hud?ids=1,2&limits=3,4&last=500&days=30
func (a *App) pt4HUD(w http.ResponseWriter, r *http.Request) {
	t0 := time.Now()
	q := r.URL.Query()
	ids, err := intList(q.Get("ids"), 40)
	if err != nil || len(ids) == 0 {
		writeErr(w, http.StatusBadRequest, "bad_ids", "ids: up to 40 player ids, comma separated")
		return
	}
	lim, err := intList(q.Get("limits"), 200)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_limits", "limits: stake ids, comma separated")
		return
	}
	f := pt4.Filter{}
	for _, l := range lim {
		f.Limits = append(f.Limits, int16(l))
	}
	if n, err := strconv.Atoi(q.Get("last")); err == nil && n > 0 {
		f.LastHands = n
	}
	if d, err := strconv.ParseFloat(q.Get("days"), 64); err == nil && d > 0 {
		f.Since = time.Now().Add(-time.Duration(d * float64(24*time.Hour))).Unix()
	}
	huds, maxHand, err := a.pt4.HUDs(ids, f)
	if err != nil {
		writePT4Error(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"maxHand": maxHand, "players": huds, "ms": time.Since(t0).Milliseconds()})
}

func (a *App) pt4Verify(w http.ResponseWriter, r *http.Request) {
	ids, err := intList(r.URL.Query().Get("id"), 1)
	if err != nil || len(ids) != 1 {
		writeErr(w, http.StatusBadRequest, "bad_id", "id: one player id")
		return
	}
	rep, err := a.pt4.Verify(ids[0])
	if err != nil {
		writePT4Error(w, err)
		return
	}
	writeJSON(w, 200, rep)
}

func writePT4Error(w http.ResponseWriter, err error) {
	if err == pt4.ErrNotConfigured {
		writeErr(w, http.StatusServiceUnavailable, "pt4_not_configured", "Set the PokerTracker 4 database in PioBridge's settings")
		return
	}
	writeErr(w, http.StatusServiceUnavailable, "pt4_error", err.Error())
}

func intList(s string, maxN int) ([]int64, error) {
	var out []int64
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p == "" {
			continue
		}
		n, err := strconv.ParseInt(p, 10, 64)
		if err != nil || n < 0 {
			return nil, strconv.ErrSyntax
		}
		out = append(out, n)
	}
	if len(out) > maxN {
		return nil, strconv.ErrRange
	}
	return out, nil
}
