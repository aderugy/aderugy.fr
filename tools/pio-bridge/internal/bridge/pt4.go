package bridge

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"aderugy.fr/pio-bridge/internal/pt4"
)

// PokerTracker 4 endpoints. Read-only sessions with the role the user
// configured (aderugy_ro), except POST /pt4/notes which writes one player
// note in a READ WRITE transaction (it needs INSERT, UPDATE on notes).

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

// /pt4/notes?ids=1,2 → {notes: {"1": {...}}}; players without a note are absent.
func (a *App) pt4Notes(w http.ResponseWriter, r *http.Request) {
	ids, err := intList(r.URL.Query().Get("ids"), 40)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_ids", "ids: up to 40 player ids, comma separated")
		return
	}
	notes, err := a.pt4.Notes(ids)
	if err != nil {
		writePT4Error(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"notes": notes})
}

// /pt4/autonotes?ids=1,2 → {autonotes: {"1": [...]}}; players without any are absent.
func (a *App) pt4AutoNotes(w http.ResponseWriter, r *http.Request) {
	ids, err := intList(r.URL.Query().Get("ids"), 40)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_ids", "ids: up to 40 player ids, comma separated")
		return
	}
	notes, err := a.pt4.AutoNotes(ids)
	if err != nil {
		writePT4Error(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"autonotes": notes})
}

// POST /pt4/notes {player, color, text, expected} → {note}; 409 note_changed
// with the current note if PT4 changed it since `expected` (its date).
func (a *App) pt4SaveNote(w http.ResponseWriter, r *http.Request) {
	// A cross-site form can't send JSON without a preflight, and the guard
	// already refused origins not in the allow-list.
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		writeErr(w, http.StatusUnsupportedMediaType, "bad_content_type", "JSON expected")
		return
	}
	var body struct {
		Player   int64  `json:"player"`
		Color    int    `json:"color"`
		Text     string `json:"text"`
		Expected string `json:"expected"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil || body.Player <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_note", "player, color, text, expected")
		return
	}
	n, err := a.pt4.SaveNote(body.Player, body.Color, body.Text, body.Expected)
	var conflict pt4.NoteConflict
	switch {
	case errors.As(err, &conflict):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "note_changed",
			"message": "This note was changed in PokerTracker meanwhile", "note": conflict.Current})
	case err != nil:
		if strings.Contains(err.Error(), "permission denied") {
			writeErr(w, http.StatusForbidden, "pt4_no_write",
				"The PT4 role can't write notes yet: GRANT INSERT, UPDATE ON public.notes TO aderugy_ro;")
			return
		}
		writePT4Error(w, err)
	default:
		a.Logf("pt4: note saved for player %d", body.Player)
		writeJSON(w, 200, map[string]any{"note": n})
	}
}

// /pt4/verify-all?n=20: the check against cash_cache for the n players with
// the most hands, added up by stat (worst first). Takes a few seconds.
func (a *App) pt4VerifyAll(w http.ResponseWriter, r *http.Request) {
	n, _ := strconv.Atoi(r.URL.Query().Get("n"))
	rep, err := a.pt4.VerifyAll(n)
	if err != nil {
		writePT4Error(w, err)
		return
	}
	a.Logf("pt4: verify-all on %d players in %d ms", len(rep.Players), rep.Millis)
	w.Header().Set("Content-Disposition", `inline; filename="pt4-verify.json"`)
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
