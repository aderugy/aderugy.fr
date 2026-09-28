package bridge

import (
	"crypto/subtle"
	_ "embed"
	"encoding/json"
	"errors"
	"html/template"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"aderugy.fr/pio-bridge/internal/upi"
)

// Handler is the full HTTP surface:
//
//	GET  /api/health                         bridge + solver state (no Origin needed)
//	GET  /api/files?dir=                     folders and .cfr files under the solves folder
//	GET  /api/tree?file=                     loads a save; board, pot, stack, info, root ranges
//	GET  /api/hand-order                     the 1326 combos in solver order
//	GET  /api/node?file=&id=                 a node and its children
//	GET  /api/decision?file=&id=&stats=1     strategy + range (+ equity, EV, EV per action)
//	GET  /                                   status page (same origin only)
//	GET  /api/status                         data for the status page (same origin only)
//	POST /settings, /restart                 status page forms (same origin + token)
//
// Only GET requests from the site: they need no CORS preflight.
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", a.health)
	mux.HandleFunc("GET /api/files", a.files)
	mux.HandleFunc("GET /api/tree", a.tree)
	mux.HandleFunc("GET /api/hand-order", a.handOrder)
	mux.HandleFunc("GET /api/node", a.node)
	mux.HandleFunc("GET /api/decision", a.decision)
	mux.HandleFunc("GET /api/runouts", a.runouts)
	mux.HandleFunc("GET /api/status", a.sameOrigin(a.statusJSON))
	mux.HandleFunc("GET /{$}", a.sameOrigin(a.statusPage))
	mux.HandleFunc("POST /settings", a.sameOrigin(a.formGuard(a.saveSettings)))
	mux.HandleFunc("POST /restart", a.sameOrigin(a.formGuard(a.restart)))
	return a.guard(mux)
}

/* ---------------------------------------------------------------- guards */

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(s int) { w.status = s; w.ResponseWriter.WriteHeader(s) }

// guard: Host check (DNS rebinding), CORS allow-list, Private Network Access
// preflight, request log.
func (a *App) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t0 := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		defer func() {
			if strings.HasPrefix(r.URL.Path, "/api/status") {
				return // the status page polls it; not worth logging
			}
			path := r.URL.RequestURI()
			if u, err := url.QueryUnescape(path); err == nil {
				path = u
			}
			a.record(ReqLog{Time: t0, Method: r.Method, Path: path, Origin: r.Header.Get("Origin"),
				Status: sw.status, Duration: time.Since(t0).Milliseconds()})
		}()

		if !a.hostAllowed(r.Host) {
			writeErr(sw, http.StatusMisdirectedRequest, "bad_host", "Unexpected Host header")
			return
		}
		origin := r.Header.Get("Origin")
		if origin != "" && origin != a.selfOrigin(r) {
			if !a.Config().OriginAllowed(origin) {
				writeErr(sw, http.StatusForbidden, "origin_not_allowed",
					"This site is not in PioBridge's allowed origins: "+origin)
				return
			}
			h := sw.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type")
			h.Set("Access-Control-Max-Age", "600")
			if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
				h.Set("Access-Control-Allow-Private-Network", "true")
			}
		}
		if r.Method == http.MethodOptions {
			sw.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(sw, r)
	})
}

func (a *App) hostAllowed(host string) bool {
	h, p, err := net.SplitHostPort(host)
	if err != nil {
		return false
	}
	if p != strconv.Itoa(a.Config().Port) && (a.addr == "" || p != portOf(a.addr)) {
		return false
	}
	return h == "127.0.0.1" || h == "localhost" || h == "::1"
}

func portOf(addr string) string {
	_, p, _ := net.SplitHostPort(addr)
	return p
}

func (a *App) selfOrigin(r *http.Request) string { return "http://" + r.Host }

// sameOrigin: only the status page itself (no Origin, or its own origin) and
// never a cross-site navigation.
func (a *App) sameOrigin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		o := r.Header.Get("Origin")
		if (o != "" && o != a.selfOrigin(r)) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			writeErr(w, http.StatusForbidden, "same_origin_only", "Only the PioBridge status page can use this")
			return
		}
		next(w, r)
	}
}

func (a *App) formGuard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil ||
			subtle.ConstantTimeCompare([]byte(r.PostForm.Get("token")), []byte(a.token)) != 1 {
			writeErr(w, http.StatusForbidden, "bad_token", "Reload the status page and try again")
			return
		}
		next(w, r)
	}
}

/* --------------------------------------------------------------- helpers */

type apiError struct {
	Status  int
	Code    string
	Message string
}

func (e *apiError) Error() string { return e.Message }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]string{"error": code, "message": msg})
}

func writeError(w http.ResponseWriter, err error) {
	var ae *apiError
	var se *SolverError
	switch {
	case errors.As(err, &ae):
		writeErr(w, ae.Status, ae.Code, ae.Message)
	case errors.Is(err, ErrOutsideRoot):
		writeErr(w, http.StatusForbidden, "forbidden_path", err.Error())
	case errors.Is(err, ErrNotCfr):
		writeErr(w, http.StatusBadRequest, "not_cfr", err.Error())
	case errors.Is(err, ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, ErrPioMissing):
		writeErr(w, http.StatusServiceUnavailable, "pio_missing", "PioSOLVER executable not found — check the path in PioBridge settings")
	case errors.As(err, &se):
		writeErr(w, http.StatusUnprocessableEntity, "solver_error", se.Error())
	case errors.Is(err, upi.ErrExited), errors.Is(err, upi.ErrTimeout):
		writeErr(w, http.StatusServiceUnavailable, "solver_unavailable", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

func (a *App) cfrParam(r *http.Request) (abs, rel string, err error) {
	root := a.Config().SolvesDir
	abs, err = ResolveCfr(root, r.URL.Query().Get("file"))
	if err != nil {
		return "", "", err
	}
	return abs, RelPath(root, abs), nil
}

func idParam(r *http.Request) (string, error) {
	id := r.URL.Query().Get("id")
	if id == "" {
		id = "r:0"
	}
	if !ValidNodeID(id) {
		return "", &apiError{http.StatusBadRequest, "bad_node_id", "Invalid node id: " + id}
	}
	return id, nil
}

/* ------------------------------------------------------------- endpoints */

func (a *App) health(w http.ResponseWriter, r *http.Request) {
	cfg := a.Config()
	writeJSON(w, 200, map[string]any{
		"bridge":    "PioBridge",
		"version":   a.Version,
		"status":    a.m.Status(),
		"solvesDir": cfg.SolvesDir,
		"pioPath":   cfg.PioPath,
	})
}

type fileEntry struct {
	Name     string    `json:"name"`
	Path     string    `json:"path"` // relative to the solves folder, forward slashes
	Kind     string    `json:"kind"` // dir · cfr
	Size     int64     `json:"size,omitempty"`
	Modified time.Time `json:"modified"`
}

func (a *App) files(w http.ResponseWriter, r *http.Request) {
	root := a.Config().SolvesDir
	dir, err := ResolveDir(root, r.URL.Query().Get("dir"))
	if err != nil {
		writeError(w, err)
		return
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		writeError(w, err)
		return
	}
	out := []fileEntry{}
	for _, e := range ents {
		name := e.Name()
		if strings.HasPrefix(name, ".") || strings.HasPrefix(name, "$") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		abs := filepath.Join(dir, name)
		switch {
		case e.IsDir():
			out = append(out, fileEntry{Name: name, Path: RelPath(root, abs), Kind: "dir", Modified: info.ModTime()})
		case strings.EqualFold(filepath.Ext(name), ".cfr"):
			out = append(out, fileEntry{Name: name, Path: RelPath(root, abs), Kind: "cfr", Size: info.Size(), Modified: info.ModTime()})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind == "dir"
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	writeJSON(w, 200, map[string]any{"dir": RelPath(root, dir), "entries": out})
}

func (a *App) tree(w http.ResponseWriter, r *http.Request) {
	abs, rel, err := a.cfrParam(r)
	if err != nil {
		writeError(w, err)
		return
	}
	var resp map[string]any
	err = a.m.Do(abs, func(s *Session) error {
		root, err := s.Node("r")
		if err != nil {
			return err
		}
		first, err := s.Node("r:0")
		if err != nil {
			return err
		}
		info, err := s.TreeInfo()
		if err != nil {
			return err
		}
		stack, err := s.EffectiveStack()
		if err != nil {
			return err
		}
		// Ranges at the first decision = the starting ranges (nothing played yet).
		oop, err := s.Range("OOP", "r:0")
		if err != nil {
			return err
		}
		ip, err := s.Range("IP", "r:0")
		if err != nil {
			return err
		}
		resp = map[string]any{
			"file":           rel,
			"board":          root.Board,
			"root":           root,
			"first":          first,
			"effectiveStack": stack,
			"info":           info,
			// The #Board# line is written by the solving script and can be
			// wrong (the same line for every board of a batch).
			"infoBoardMatches": strings.Join(strings.Fields(info["Board"]), " ") == strings.Join(root.Board, " "),
			"ranges":           map[string]Floats{"oop": oop, "ip": ip},
		}
		return nil
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, resp)
}

func (a *App) handOrder(w http.ResponseWriter, r *http.Request) {
	var hands []string
	err := a.m.Do("", func(s *Session) (err error) {
		hands, err = s.HandOrder()
		return err
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"hands": hands})
}

func (a *App) node(w http.ResponseWriter, r *http.Request) {
	abs, rel, err := a.cfrParam(r)
	if err != nil {
		writeError(w, err)
		return
	}
	id, err := idParam(r)
	if err != nil {
		writeError(w, err)
		return
	}
	var resp map[string]any
	err = a.m.Do(abs, func(s *Session) error {
		n, err := s.Node(id)
		if err != nil {
			return err
		}
		kids, err := s.Children(id)
		if err != nil {
			return err
		}
		resp = map[string]any{"file": rel, "node": n, "children": kids}
		return nil
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, resp)
}

type decisionStats struct {
	Unit          string   `json:"unit"` // chips, as the solver gives them
	Equity        Floats   `json:"equity"`
	EquityWeights Floats   `json:"equityWeights"`
	EquityTotal   float64  `json:"equityTotal"`
	EV            Floats   `json:"ev"`
	EVWeights     Floats   `json:"evWeights"`
	ChildEV       []Floats `json:"childEv"` // one per child (action), null if unavailable
	// With villain=1: the other player's equity at this node.
	VillainEquity        Floats   `json:"villainEquity,omitempty"`
	VillainEquityWeights Floats   `json:"villainEquityWeights,omitempty"`
	VillainEquityTotal   *float64 `json:"villainEquityTotal,omitempty"`
	// And the other player's EV at this node.
	VillainEV        Floats   `json:"villainEv,omitempty"`
	VillainEVWeights Floats   `json:"villainEvWeights,omitempty"`
	Notes            []string `json:"notes"`
}

type decisionResp struct {
	File         string         `json:"file"`
	Node         NodeInfo       `json:"node"`
	Children     []NodeInfo     `json:"children"`
	Player       string         `json:"player"`
	Strategy     []Floats       `json:"strategy"` // one row per child, 1326 values each
	Range        Floats         `json:"range"`
	VillainRange Floats         `json:"villainRange,omitempty"`
	GlobalFreq   *float64       `json:"globalFreq,omitempty"`
	Stats        *decisionStats `json:"stats,omitempty"`
	Millis       int64          `json:"ms"`
}

func (a *App) decision(w http.ResponseWriter, r *http.Request) {
	t0 := time.Now()
	abs, rel, err := a.cfrParam(r)
	if err != nil {
		writeError(w, err)
		return
	}
	id, err := idParam(r)
	if err != nil {
		writeError(w, err)
		return
	}
	q := r.URL.Query()
	withStats, withVillain, allowResolve := q.Get("stats") == "1", q.Get("villain") == "1", q.Get("resolve") == "1"

	var resp decisionResp
	err = a.m.Do(abs, func(s *Session) error {
		n, err := s.Node(id)
		if err != nil {
			return err
		}
		if n.Player == "" {
			return &apiError{http.StatusBadRequest, "not_a_decision", id + " is a " + n.Type + ", not a decision"}
		}
		if !n.Solved && !allowResolve {
			return &apiError{http.StatusConflict, "not_in_save",
				"This node is not in the save (a river of a no_rivers save); the solver would re-solve it on the fly"}
		}
		kids, err := s.Children(id)
		if err != nil {
			return err
		}
		strat, err := s.Strategy(id, len(kids))
		if err != nil {
			return err
		}
		rng, err := s.Range(n.Player, id)
		if err != nil {
			return err
		}
		resp = decisionResp{File: rel, Node: n, Children: kids, Player: n.Player, Strategy: strat[:len(kids)], Range: rng}
		other := "IP"
		if n.Player == "IP" {
			other = "OOP"
		}
		if withVillain {
			if resp.VillainRange, err = s.Range(other, id); err != nil {
				return err
			}
		}
		if f, err := s.GlobalFreq(id); err == nil {
			resp.GlobalFreq = &f
		} else if !isSolverErr(err) {
			return err
		}
		if !withStats {
			return nil
		}
		st := &decisionStats{Unit: "chips", Notes: []string{}}
		if st.Equity, st.EquityWeights, st.EquityTotal, err = s.Equity(n.Player, id); err != nil {
			return err
		}
		if st.EV, st.EVWeights, err = s.EV(n.Player, id); err != nil {
			return err
		}
		if withVillain {
			eq, w, total, err := s.Equity(other, id)
			switch {
			case err == nil:
				st.VillainEquity, st.VillainEquityWeights, st.VillainEquityTotal = eq, w, &total
			case isSolverErr(err):
				st.Notes = append(st.Notes, "villain equity: "+err.Error())
			default:
				return err
			}
			ev, w, err := s.EV(other, id)
			switch {
			case err == nil:
				st.VillainEV, st.VillainEVWeights = ev, w
			case isSolverErr(err):
				st.Notes = append(st.Notes, "villain EV: "+err.Error())
			default:
				return err
			}
		}
		st.ChildEV = make([]Floats, len(kids))
		for i, k := range kids {
			v, _, err := s.EV(n.Player, k.ID)
			switch {
			case err == nil:
				st.ChildEV[i] = v
			case isSolverErr(err) && k.Last == "f":
				// Folding wins no part of the pot: EV 0 for every combo in range.
				z := make(Floats, len(st.EV))
				for h, e := range st.EV {
					if e != e { // NaN: combo not in range
						z[h] = e
					}
				}
				st.ChildEV[i] = z
				st.Notes = append(st.Notes, "fold EV set to 0 (solver: "+err.Error()+")")
			case isSolverErr(err):
				st.Notes = append(st.Notes, k.ID+": "+err.Error())
			default:
				return err
			}
		}
		resp.Stats = st
		return nil
	})
	if err != nil {
		writeError(w, err)
		return
	}
	resp.Millis = time.Since(t0).Milliseconds()
	writeJSON(w, 200, resp)
}

/* --------------------------------------------------------------- runouts */

// One card dealt at a split node, summed up: both players' equity and EV
// over their ranges there, and how often the player to act takes each option.
type runoutCard struct {
	Card     string     `json:"card"`
	Node     NodeInfo   `json:"node"`
	Children []NodeInfo `json:"children"`
	// Average frequency of each child (option) over the actor's range.
	Strategy Floats `json:"strategy,omitempty"`
	// Solver's equity total (0–1) and EV averaged with calc_ev's weights
	// (chips), by player: "OOP", "IP".
	Equity map[string]*float64 `json:"equity"`
	EV     map[string]*float64 `json:"ev"`
	Notes  []string            `json:"notes"`
}

type runoutsResp struct {
	File   string       `json:"file"`
	Node   NodeInfo     `json:"node"`
	Cards  []runoutCard `json:"cards"`
	Millis int64        `json:"ms"`
}

// mean averages values over weights, skipping NaN values; nil when nothing counts.
func mean(values, weights Floats) *float64 {
	sum, w := 0.0, 0.0
	for h, v := range values {
		if h >= len(weights) || v != v || weights[h] != weights[h] || weights[h] <= 0 {
			continue
		}
		sum += v * weights[h]
		w += weights[h]
	}
	if w <= 0 {
		return nil
	}
	x := sum / w
	return &x
}

// runouts sums up every card of a split node (the turn or river cards after
// a betting round): the aggregated report used to pick the runouts to study.
func (a *App) runouts(w http.ResponseWriter, r *http.Request) {
	t0 := time.Now()
	abs, rel, err := a.cfrParam(r)
	if err != nil {
		writeError(w, err)
		return
	}
	id, err := idParam(r)
	if err != nil {
		writeError(w, err)
		return
	}
	var resp runoutsResp
	err = a.m.Do(abs, func(s *Session) error {
		n, err := s.Node(id)
		if err != nil {
			return err
		}
		if n.Type != "SPLIT_NODE" {
			return &apiError{http.StatusBadRequest, "not_a_split", id + " is a " + n.Type + ", not where cards are dealt"}
		}
		if err := s.LoadAll(); err != nil {
			return err
		}
		kids, err := s.Children(id)
		if err != nil {
			return err
		}
		resp = runoutsResp{File: rel, Node: n, Cards: []runoutCard{}}
		for _, k := range kids {
			c := runoutCard{Card: k.Last, Node: k, Children: []NodeInfo{}, Equity: map[string]*float64{}, EV: map[string]*float64{}, Notes: []string{}}
			if !k.Solved {
				c.Notes = append(c.Notes, "not in the save")
				resp.Cards = append(resp.Cards, c)
				continue
			}
			for _, p := range []string{"OOP", "IP"} {
				if _, _, total, err := s.Equity(p, k.ID); err == nil {
					t := total
					c.Equity[p] = &t
				} else if isSolverErr(err) {
					c.Notes = append(c.Notes, p+" equity: "+err.Error())
				} else {
					return err
				}
				if ev, wts, err := s.EV(p, k.ID); err == nil {
					c.EV[p] = mean(ev, wts)
				} else if isSolverErr(err) {
					c.Notes = append(c.Notes, p+" EV: "+err.Error())
				} else {
					return err
				}
			}
			if k.Player != "" && k.Children > 0 {
				if c.Children, err = s.Children(k.ID); err != nil {
					return err
				}
				strat, err := s.Strategy(k.ID, len(c.Children))
				if err != nil {
					return err
				}
				rng, err := s.Range(k.Player, k.ID)
				if err != nil {
					return err
				}
				c.Strategy = make(Floats, len(c.Children))
				for i := range c.Children {
					if f := mean(strat[i], rng); f != nil {
						c.Strategy[i] = *f
					}
				}
			}
			resp.Cards = append(resp.Cards, c)
		}
		return nil
	})
	if err != nil {
		writeError(w, err)
		return
	}
	resp.Millis = time.Since(t0).Milliseconds()
	writeJSON(w, 200, resp)
}

/* ----------------------------------------------------------- status page */

//go:embed status.html
var statusHTML string

var statusTmpl = template.Must(template.New("status").Parse(statusHTML))

func (a *App) statusPage(w http.ResponseWriter, r *http.Request) {
	cfg := a.Config()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'")
	_ = statusTmpl.Execute(w, map[string]any{
		"Version": a.Version,
		"Token":   a.token,
		"Config":  cfg,
		"Origins": strings.Join(cfg.AllowedOrigins, "\n"),
		"Flash":   r.URL.Query().Get("msg"),
	})
}

func (a *App) statusJSON(w http.ResponseWriter, r *http.Request) {
	a.logMu.Lock()
	reqs := append([]ReqLog{}, a.reqs...)
	tail := append([]string{}, a.logTail...)
	a.logMu.Unlock()
	for i, j := 0, len(reqs)-1; i < j; i, j = i+1, j-1 {
		reqs[i], reqs[j] = reqs[j], reqs[i]
	}
	writeJSON(w, 200, map[string]any{
		"version":  a.Version,
		"status":   a.m.Status(),
		"requests": reqs,
		"log":      tail,
	})
}

func (a *App) saveSettings(w http.ResponseWriter, r *http.Request) {
	c := a.Config()
	c.PioPath = strings.TrimSpace(r.PostForm.Get("pioPath"))
	c.SolvesDir = strings.TrimSpace(r.PostForm.Get("solvesDir"))
	if p, err := strconv.Atoi(strings.TrimSpace(r.PostForm.Get("port"))); err == nil {
		c.Port = p
	}
	if m, err := strconv.Atoi(strings.TrimSpace(r.PostForm.Get("idleMinutes"))); err == nil {
		c.IdleMinutes = m
	}
	c.AllowedOrigins = nil
	for _, o := range strings.Split(r.PostForm.Get("allowedOrigins"), "\n") {
		if o = strings.TrimSpace(o); o != "" {
			c.AllowedOrigins = append(c.AllowedOrigins, o)
		}
	}
	msg, err := a.SaveConfig(c)
	if err != nil {
		msg = "Not saved: " + err.Error()
	}
	http.Redirect(w, r, "/?msg="+urlEscape(msg), http.StatusSeeOther)
}

func (a *App) restart(w http.ResponseWriter, r *http.Request) {
	a.m.Stop("restart from the status page")
	http.Redirect(w, r, "/?msg="+urlEscape("Solver stopped; it restarts on the next request."), http.StatusSeeOther)
}

func urlEscape(s string) string { return template.URLQueryEscaper(s) }
