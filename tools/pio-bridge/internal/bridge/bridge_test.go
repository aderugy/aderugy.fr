package bridge

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The tests drive the real HTTP handler against testdata/replay_pio.py, which
// replays PioSOLVER's recorded answers (PioProbe on 8h5d3d.cfr, 2026-09-28).

const saveRel = "BB vs BTN/Second souffle/8h5d3d.cfr"

func newTestApp(t *testing.T, env ...string) *App {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the replay fake is a Python script")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 needed for the replay fake")
	}
	replay, _ := filepath.Abs("../../testdata/replay_pio.py")
	root := t.TempDir()
	save := filepath.Join(root, filepath.FromSlash(saveRel))
	if err := os.MkdirAll(filepath.Dir(save), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(save, []byte("not a real save; the replay fake ignores it"), 0o644); err != nil {
		t.Fatal(err)
	}
	for i := 0; i+1 < len(env); i += 2 {
		t.Setenv(env[i], env[i+1])
	}
	cfg := DefaultConfig()
	cfg.PioPath = replay
	cfg.SolvesDir = root
	a := NewApp(cfg, filepath.Join(t.TempDir(), "config.json"), "test")
	t.Cleanup(a.Shutdown)
	return a
}

func get(t *testing.T, a *App, path string, hdr ...string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	req.Host = "127.0.0.1:7878"
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, req)
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return rec, body
}

func q(file, id string, extra ...string) string {
	v := url.Values{"file": {file}, "id": {id}}
	for i := 0; i+1 < len(extra); i += 2 {
		v.Set(extra[i], extra[i+1])
	}
	return v.Encode()
}

func floats(t *testing.T, v any) []float64 {
	t.Helper()
	arr, ok := v.([]any)
	if !ok {
		t.Fatalf("not an array: %T", v)
	}
	out := make([]float64, len(arr))
	for i, x := range arr {
		if x == nil {
			out[i] = math.NaN()
			continue
		}
		out[i] = x.(float64)
	}
	return out
}

func TestDecisionWithStats(t *testing.T) {
	a := newTestApp(t)
	for _, id := range []string{"r:0", "r:0:c:c:As"} {
		rec, body := get(t, a, "/api/decision?"+q(saveRel, id, "stats", "1", "villain", "1"), "Origin", "https://aderugy.fr")
		if rec.Code != 200 {
			t.Fatalf("%s: status %d: %s", id, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://aderugy.fr" {
			t.Errorf("ACAO = %q", got)
		}
		if body["player"] != "OOP" {
			t.Errorf("%s: player %v", id, body["player"])
		}
		kids := body["children"].([]any)
		strat := body["strategy"].([]any)
		if len(strat) != len(kids) {
			t.Fatalf("%s: %d strategy rows for %d children", id, len(strat), len(kids))
		}
		rng := floats(t, body["range"])
		if len(rng) != 1326 || len(floats(t, body["villainRange"])) != 1326 {
			t.Fatalf("%s: range length %d", id, len(rng))
		}
		st := body["stats"].(map[string]any)
		ev := floats(t, st["ev"])
		childEV := st["childEv"].([]any)
		// EV(node) = Σ strategy × EV(child), per combo in range.
		checked := 0
		for h := 0; h < 1326; h++ {
			if rng[h] <= 0 || math.IsNaN(ev[h]) {
				continue
			}
			sum := 0.0
			for i := range kids {
				sum += floats(t, strat[i])[h] * floats(t, childEV[i])[h]
			}
			if math.Abs(sum-ev[h]) > 1e-3 {
				t.Fatalf("%s combo %d: Σ s·EV(child) = %f, EV = %f", id, h, sum, ev[h])
			}
			checked++
		}
		if checked < 400 {
			t.Errorf("%s: only %d combos checked", id, checked)
		}
		if eqt := st["equityTotal"].(float64); eqt < 0.4 || eqt > 0.5 {
			t.Errorf("%s: equityTotal %f", id, eqt)
		}
		// IP's equity was not recorded by the probe: the replay refuses it,
		// which must end up as a note, not a failed request.
		if st["villainEquity"] == nil && len(st["notes"].([]any)) == 0 {
			t.Errorf("%s: villain equity missing without a note", id)
		}
	}
}

func TestVillainEquity(t *testing.T) {
	a := newTestApp(t, "REPLAY_SYNTH", "1")
	rec, body := get(t, a, "/api/decision?"+q(saveRel, "r:0", "stats", "1", "villain", "1"))
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	st := body["stats"].(map[string]any)
	if len(floats(t, st["villainEquity"])) != 1326 || st["villainEquityTotal"] == nil {
		t.Fatalf("villain equity: %v", st["notes"])
	}
}

func TestVillainEV(t *testing.T) {
	a := newTestApp(t, "REPLAY_SYNTH", "1")
	rec, body := get(t, a, "/api/decision?"+q(saveRel, "r:0:c:c:Kh", "stats", "1", "villain", "1"))
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	st := body["stats"].(map[string]any)
	if len(floats(t, st["villainEv"])) != 1326 || len(floats(t, st["villainEvWeights"])) != 1326 {
		t.Fatalf("villain EV: %v", st["notes"])
	}
}

func TestRunouts(t *testing.T) {
	a := newTestApp(t, "REPLAY_SYNTH", "1")
	rec, body := get(t, a, "/api/runouts?"+q(saveRel, "r:0:c:c"))
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	cards := body["cards"].([]any)
	if len(cards) != 49 {
		t.Fatalf("%d cards, want 49", len(cards))
	}
	seen := map[float64]bool{}
	for _, x := range cards {
		c := x.(map[string]any)
		eq := c["equity"].(map[string]any)
		ev := c["ev"].(map[string]any)
		if eq["OOP"] == nil || eq["IP"] == nil || ev["OOP"] == nil || ev["IP"] == nil {
			t.Fatalf("%v: missing totals (%v)", c["card"], c["notes"])
		}
		strat := floats(t, c["strategy"])
		if len(strat) != len(c["children"].([]any)) || len(strat) == 0 {
			t.Fatalf("%v: strategy %v", c["card"], strat)
		}
		sum := 0.0
		for _, f := range strat {
			sum += f
		}
		if math.Abs(sum-1) > 1e-3 {
			t.Errorf("%v: strategy sums to %f", c["card"], sum)
		}
		seen[eq["OOP"].(float64)] = true
	}
	if len(seen) < 10 {
		t.Errorf("runouts all alike: %d distinct equities", len(seen))
	}
	// A later node of the turn on every card: BB checked, BTN to act.
	rec, body = get(t, a, "/api/runouts?"+q(saveRel, "r:0:c:c", "after", "c"))
	if rec.Code != 200 {
		t.Fatalf("after=c: status %d: %s", rec.Code, rec.Body.String())
	}
	cards = body["cards"].([]any)
	if len(cards) != 49 {
		t.Fatalf("after=c: %d cards", len(cards))
	}
	for _, x := range cards {
		c := x.(map[string]any)
		node := c["node"].(map[string]any)
		if node["player"] != "IP" || !strings.HasSuffix(node["id"].(string), ":c") || c["dealt"] == nil {
			t.Fatalf("after=c, %v: node %v (%v)", c["card"], node, c["notes"])
		}
	}
	if rec, _ := get(t, a, "/api/runouts?"+q(saveRel, "r:0:c:c", "after", "c x")); rec.Code != 400 {
		t.Errorf("bad after: status %d", rec.Code)
	}
	// Not a split node.
	if rec, _ := get(t, a, "/api/runouts?"+q(saveRel, "r:0")); rec.Code != 400 {
		t.Errorf("runouts on a decision: status %d", rec.Code)
	}
}

func TestDecisionLabelsAndPots(t *testing.T) {
	a := newTestApp(t)
	rec, body := get(t, a, "/api/node?"+q(saveRel, "r:0:b45:c:2c"))
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	n := body["node"].(map[string]any)
	pot := n["pot"].(map[string]any)
	if pot["oop"] != 45.0 || pot["ip"] != 45.0 || pot["start"] != 60.0 {
		t.Errorf("pot %v", pot)
	}
	if strings.Join(toStrings(n["board"]), " ") != "8h 5d 3d 2c" {
		t.Errorf("board %v", n["board"])
	}
	kids := body["children"].([]any)
	first := kids[0].(map[string]any)
	if first["last"] != "b495" || first["player"] != "IP" {
		t.Errorf("first child %v", first)
	}
}

func toStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

func TestRiverIsNotInSave(t *testing.T) {
	a := newTestApp(t)
	rec, body := get(t, a, "/api/decision?"+q(saveRel, "r:0:c:c:As:c:c:Ah"))
	if rec.Code != http.StatusConflict || body["error"] != "not_in_save" {
		t.Fatalf("got %d %v", rec.Code, body)
	}
}

func TestTree(t *testing.T) {
	a := newTestApp(t)
	rec, body := get(t, a, "/api/tree?file="+url.QueryEscape(saveRel))
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Join(toStrings(body["board"]), " ") != "8h 5d 3d" {
		t.Errorf("board %v", body["board"])
	}
	if body["infoBoardMatches"] != false {
		t.Errorf("the recorded save's #Board# line is wrong (Qs 8c 6s) and must be flagged")
	}
	if body["effectiveStack"] != 975.0 {
		t.Errorf("stack %v", body["effectiveStack"])
	}
	r := body["ranges"].(map[string]any)
	if len(floats(t, r["oop"])) != 1326 {
		t.Errorf("oop range")
	}
	if a.Manager().Status().File != saveRel {
		t.Errorf("status file %q", a.Manager().Status().File)
	}
}

func TestHandOrderAndFiles(t *testing.T) {
	a := newTestApp(t)
	rec, body := get(t, a, "/api/hand-order")
	if rec.Code != 200 || len(body["hands"].([]any)) != 1326 {
		t.Fatalf("hand order %d", rec.Code)
	}
	rec, body = get(t, a, "/api/files?dir="+url.QueryEscape("BB vs BTN/Second souffle"))
	if rec.Code != 200 {
		t.Fatalf("files %d %s", rec.Code, rec.Body.String())
	}
	ents := body["entries"].([]any)
	if len(ents) != 1 || ents[0].(map[string]any)["path"] != saveRel {
		t.Errorf("entries %v", ents)
	}
}

func TestSecurity(t *testing.T) {
	a := newTestApp(t)
	cases := []struct {
		name, path string
		hdr        []string
		code       int
		errCode    string
	}{
		{"foreign origin", "/api/health", []string{"Origin", "https://evil.example"}, 403, "origin_not_allowed"},
		{"traversal", "/api/node?" + q("../../etc/x.cfr", "r"), nil, 403, "forbidden_path"},
		{"absolute outside", "/api/node?" + q("/etc/x.cfr", "r"), nil, 403, "forbidden_path"},
		{"not cfr", "/api/node?" + q("BB vs BTN/Second souffle/script.txt", "r"), nil, 400, "not_cfr"},
		{"missing", "/api/node?" + q("nope.cfr", "r"), nil, 404, "not_found"},
		{"injection", "/api/node?" + q(saveRel, "r:0\nfree_tree"), nil, 400, "bad_node_id"},
		{"quote", "/api/node?" + q(saveRel, `r:0" x`), nil, 400, "bad_node_id"},
		{"status page from a site", "/api/status", []string{"Origin", "https://aderugy.fr"}, 403, "same_origin_only"},
	}
	for _, c := range cases {
		rec, body := get(t, a, c.path, c.hdr...)
		if rec.Code != c.code || body["error"] != c.errCode {
			t.Errorf("%s: got %d %v, want %d %s", c.name, rec.Code, body["error"], c.code, c.errCode)
		}
	}
	// DNS rebinding: a page on evil.com resolving to 127.0.0.1 sends Host: evil.com.
	req := httptest.NewRequest("GET", "/api/health", nil)
	req.Host = "evil.com:7878"
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMisdirectedRequest {
		t.Errorf("bad host: %d", rec.Code)
	}
	// Forms need the token and the page's own origin.
	for _, hdr := range [][2]string{{"", ""}, {"Origin", "https://evil.example"}} {
		req := httptest.NewRequest("POST", "/settings", strings.NewReader("pioPath=C:/evil.exe&token="+a.token))
		req.Host = "127.0.0.1:7878"
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if hdr[0] != "" {
			req.Header.Set(hdr[0], hdr[1])
		} else {
			req = httptest.NewRequest("POST", "/settings", strings.NewReader("pioPath=C:/evil.exe&token=wrong"))
			req.Host = "127.0.0.1:7878"
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
		rec := httptest.NewRecorder()
		a.Handler().ServeHTTP(rec, req)
		if rec.Code != 403 {
			t.Errorf("settings post %v: %d", hdr, rec.Code)
		}
	}
	if a.Config().PioPath == "C:/evil.exe" {
		t.Fatal("settings changed without a valid token")
	}
}

func TestPreflightPrivateNetwork(t *testing.T) {
	a := newTestApp(t)
	req := httptest.NewRequest("OPTIONS", "/api/decision", nil)
	req.Host = "127.0.0.1:7878"
	req.Header.Set("Origin", "http://localhost:3000")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Private-Network", "true")
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, req)
	if rec.Code != 204 || rec.Header().Get("Access-Control-Allow-Private-Network") != "true" ||
		rec.Header().Get("Access-Control-Allow-Origin") != "http://localhost:3000" {
		t.Fatalf("preflight: %d %v", rec.Code, rec.Header())
	}
}

func TestSettingsSaved(t *testing.T) {
	a := newTestApp(t)
	body := url.Values{"token": {a.token}, "pioPath": {a.Config().PioPath}, "solvesDir": {a.Config().SolvesDir},
		"port": {"7879"}, "idleMinutes": {"5"}, "allowedOrigins": {"https://aderugy.fr\nhttps://*.vercel.app\n"}}
	req := httptest.NewRequest("POST", "/settings", strings.NewReader(body.Encode()))
	req.Host = "127.0.0.1:7878"
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "http://127.0.0.1:7878")
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
	}
	c := a.Config()
	if c.Port != 7879 || c.IdleMinutes != 5 || len(c.AllowedOrigins) != 2 {
		t.Fatalf("config %+v", c)
	}
	if !strings.Contains(rec.Header().Get("Location"), "restarting") {
		t.Errorf("port change should say a restart is needed: %s", rec.Header().Get("Location"))
	}
	saved, err := LoadConfig(a.cfgPath)
	if err != nil || saved.Port != 7879 {
		t.Fatalf("saved config %+v %v", saved, err)
	}
}

func TestSolverCrashIsRetried(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "crashed")
	a := newTestApp(t, "REPLAY_CRASH_ONCE", "show_strategy r:0", "REPLAY_MARKER", marker)
	rec, body := get(t, a, "/api/decision?"+q(saveRel, "r:0"))
	if rec.Code != 200 {
		t.Fatalf("after a crash the request should be retried: %d %v", rec.Code, body)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("the fake did not crash; the test proves nothing")
	}
	if s := a.Manager().Status().State; s != StateReady {
		t.Errorf("state %s", s)
	}
}

func TestIdleStop(t *testing.T) {
	a := newTestApp(t)
	if rec, _ := get(t, a, "/api/hand-order"); rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	a.Manager().Stop("test")
	if s := a.Manager().Status().State; s != StateIdle {
		t.Fatalf("state after stop: %s", s)
	}
	// Next request starts it again.
	start := time.Now()
	if rec, _ := get(t, a, "/api/decision?"+q(saveRel, "r:0")); rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	t.Logf("restart + load + decision: %s", time.Since(start))
}

func TestPioMissing(t *testing.T) {
	a := newTestApp(t)
	c := a.Config()
	c.PioPath = filepath.Join(t.TempDir(), "nope.exe")
	a.Manager().SetConfig(c)
	rec, body := get(t, a, "/api/decision?"+q(saveRel, "r:0"))
	if rec.Code != 503 || body["error"] != "pio_missing" {
		t.Fatalf("%d %v", rec.Code, body)
	}
	if a.Manager().Status().State != StatePioMissing {
		t.Errorf("state %s", a.Manager().Status().State)
	}
}

func TestFloatsJSON(t *testing.T) {
	b, _ := json.Marshal(ParseFloats("0.5 nan -nan(ind) 1e-7 12.3456789"))
	if string(b) != "[0.5,null,null,1e-07,12.34568]" {
		t.Fatalf("%s", b)
	}
}

func TestOriginAllowed(t *testing.T) {
	c := Config{AllowedOrigins: []string{"https://aderugy.fr", "https://*.vercel.app"}}
	for o, want := range map[string]bool{
		"https://aderugy.fr":            true,
		"https://aderugy.fr/":           true,
		"http://aderugy.fr":             false,
		"https://aderugy.fr.evil.com":   false,
		"https://x-git-main.vercel.app": true,
		"https://a.b.vercel.app":        false,
		"https://vercel.app":            false,
		"https://evil.com/.vercel.app":  false,
		"https://evilvercel.app":        false,
	} {
		if got := c.OriginAllowed(o); got != want {
			t.Errorf("%s: %v", o, got)
		}
	}
}
