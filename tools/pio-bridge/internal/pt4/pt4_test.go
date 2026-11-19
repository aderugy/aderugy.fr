package pt4

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Every stat of the site's HUD layout must exist in the catalogue.
func TestCatalogueCoversLayout(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "src", "lib", "hud", "layout.json"))
	if err != nil {
		t.Skip("layout.json not found:", err)
	}
	var layout struct {
		Groups []struct {
			Items []struct {
				T    string `json:"t"`
				Stat string `json:"stat"`
			} `json:"items"`
		} `json:"groups"`
	}
	if err := json.Unmarshal(b, &layout); err != nil {
		t.Fatal(err)
	}
	cat := Catalogue()
	missing := map[string]bool{}
	for _, g := range layout.Groups {
		for _, it := range g.Items {
			if it.T == "stat" && cat[it.Stat] == nil {
				missing[it.Stat] = true
			}
		}
	}
	for m := range missing {
		t.Errorf("stat not in catalogue: %q", m)
	}
}

func hand(pos int8, cat int8, flags ...Flag) Hand {
	h := Hand{Position: pos, Cat: cat, BB: 2}
	for _, f := range flags {
		h.set(f)
	}
	return h
}

func value(t *testing.T, v Values, stat string, pos int) [2]float64 {
	t.Helper()
	x := v[stat]
	if x == nil {
		return [2]float64{}
	}
	return x[pos]
}

func eq(t *testing.T, v Values, stat string, pos int, num, den float64) {
	t.Helper()
	got := value(t, v, stat, pos)
	if math.Abs(got[0]-num) > 1e-9 || math.Abs(got[1]-den) > 1e-9 {
		t.Errorf("%s[%d] = %v/%v, want %v/%v", stat, pos, got[0], got[1], num, den)
	}
}

func TestPreflopStats(t *testing.T) {
	// BTN opens, faces a 3bet, folds.
	h1 := hand(0, 6, FVpip, FPOpenOpp, FPFirstRaise, FPFold, FStealOpp, FStealAtt, FP3betDefOpp, FP4betOpp)
	h1.PRaise, h1.Enum3bet, h1.Act[Pre], h1.Aggr[Pre] = 1, 'F', "RF", "808"
	// BB walk.
	h2 := hand(8, 1)
	// SB limp-calls a raise.
	h3 := hand(9, 2, FVpip, FPOpenOpp, FPLimp, FPFaceRaise)
	h3.PCall, h3.Act[Pre], h3.Aggr[Pre] = 2, "CC", "88"
	// CO cold calls an EP open.
	h4 := hand(1, 5, FVpip, FP3betOpp, FPCCall)
	h4.Face2bet, h4.OpenerCat, h4.PCall, h4.Act[Pre], h4.Aggr[Pre] = true, 3, 1, "C", "83"

	v := Compute(SortedCatalogue(), []Hand{h1, h2, h3, h4})
	eq(t, v, "Hands Abbreviated", 0, 4, 4)
	eq(t, v, "VPIP", 0, 3, 3)
	eq(t, v, "PFR", 0, 1, 3)
	eq(t, v, "Raise First In", 0, 1, 2)
	eq(t, v, "Raise First In", 6, 1, 1) // BTN column
	eq(t, v, "Raise First In", 2, 0, 1) // SB column
	eq(t, v, "Fold to PF 3Bet After Raise", 0, 1, 1)
	eq(t, v, "Fold to PF 3Bet After Steal", 0, 1, 1)
	eq(t, v, "Att To Steal", 0, 1, 1)
	eq(t, v, "Preflop Limp Call", 0, 1, 1)
	eq(t, v, "Preflop Limp Fold", 0, 0, 1)
	eq(t, v, "Call PF 2Bet", 0, 1, 1)
	eq(t, v, "Cold Call 2Bet PF", 0, 1, 1)
	eq(t, v, "3Bet vs EP 2Bet", 0, 0, 1)
	eq(t, v, "3Bet Preflop", 0, 0, 1)
}

func TestPostflopStats(t *testing.T) {
	// PFA (CO) cbets the flop, gets called, checks the turn, folds to a bet.
	h := hand(1, 5, FVpip, FPFirstRaise, FFSaw, FFOpenOpp, FFBet, FFCbetOpp, FFCbet, FTSaw, FTOpenOpp, FTCbetOpp, FTCheck, FTFold)
	h.PRaise, h.PlayersF = 1, 2
	h.Act = [4]string{"R", "B", "XF", ""}
	h.Aggr = [4]string{"81", "1", "0", ""}
	h.Actors = [4]string{"10", "10", "10", ""}
	h.FaceBet[Turn] = true
	// BTN floats the flop when the PFA (SB) checks.
	f := hand(0, 6, FVpip, FFSaw, FFOpenOpp, FFHasPosition, FFBet)
	f.Act = [4]string{"C", "B", "", ""}
	f.Aggr = [4]string{"89", "0", "", ""}
	f.Actors = [4]string{"90", "90", "", ""}
	f.derive()

	v := Compute(SortedCatalogue(), []Hand{h, f})
	eq(t, v, "CBet Flop", 0, 1, 1)
	eq(t, v, "CBet Flop in non-3Bet+ Pot", 0, 1, 1)
	eq(t, v, "CBet Flop in 3Bet+ Pot", 0, 0, 0)
	eq(t, v, "CBet Turn", 0, 0, 1)
	eq(t, v, "Fold to T Bet", 0, 1, 1)
	eq(t, v, "Bet Flop", 0, 2, 2)
	eq(t, v, "Float Flop", 0, 1, 1)
	eq(t, v, "CBet Flop Multiway", 0, 0, 0)
	eq(t, v, "Flop AF", 0, 2, 0)
}

func TestFilter(t *testing.T) {
	var hs []Hand
	for i := 0; i < 10; i++ {
		h := hand(0, 6)
		h.ID, h.Date, h.Limit = int64(i), int64(1000+i), int16(1+i%2)
		hs = append(hs, h)
	}
	if n := len(Select(hs, Filter{LastHands: 3})); n != 3 {
		t.Errorf("last 3: %d", n)
	}
	sel := Select(hs, Filter{Limits: []int16{2}, LastHands: 2})
	if len(sel) != 2 || sel[0].ID != 7 || sel[1].ID != 9 {
		t.Errorf("limit 2, last 2: %+v", sel)
	}
	if n := len(Select(hs, Filter{Since: 1005})); n != 5 {
		t.Errorf("since: %d", n)
	}
}

func TestDSN(t *testing.T) {
	d, err := ParseDSN("postgres://aderugy_ro:p%40ss@localhost:5432/PT4%20DB")
	if err != nil || d.Password != "p@ss" || d.Database != "PT4 DB" || d.Port != "5432" {
		t.Fatalf("%+v %v", d, err)
	}
	if d.Redacted() != "postgres://aderugy_ro@localhost:5432/PT4%20DB" {
		t.Error(d.Redacted())
	}
	if _, err := ParseDSN("mysql://x@y/z"); err == nil {
		t.Error("want an error")
	}
	if Literal("it's") != "'it''s'" || likeEscape(`a%b_c\`) != `a\%b\_c\\` {
		t.Error("quoting")
	}
}

// Integration test against a PostgreSQL holding the PT4 schema and
// testdata/pt4_fixture.sql. Set PT4_TEST_DSN to run it.
func TestIntegration(t *testing.T) {
	dsn := os.Getenv("PT4_TEST_DSN")
	if dsn == "" {
		t.Skip("PT4_TEST_DSN not set")
	}
	s := NewService(dsn)
	s.Logf = t.Logf
	st := s.Status()
	if !st.Connected || st.MaxHand != 104 {
		t.Fatalf("status %+v", st)
	}
	ps, err := s.Search("vil", 10)
	if err != nil || len(ps) != 1 || ps[0].Name != "Villain" || ps[0].Hands != 4 {
		t.Fatalf("search %+v %v", ps, err)
	}
	if ps, err := s.Search("_lain%", 10); err != nil || len(ps) != 0 {
		t.Fatalf("wildcards not escaped: %+v %v", ps, err)
	}
	if ps, err := s.Search("x' OR 1=1 --", 10); err != nil || len(ps) != 0 {
		t.Fatalf("quote: %+v %v", ps, err)
	}
	ls, err := s.Limits()
	if err != nil || len(ls) != 2 || ls[0].Name != "NL100" || ls[1].Hands != 3 {
		t.Fatalf("limits %+v %v", ls, err)
	}
	huds, _, err := s.HUDs([]int64{1, 999}, Filter{})
	if err != nil {
		t.Fatal(err)
	}
	h := huds[0]
	if h.Error != "" || h.Name != "Villain" || h.Site != "WIN" || h.Total != 4 {
		t.Fatalf("hud %+v", h)
	}
	if huds[1].Error == "" {
		t.Error("unknown player should give an error")
	}
	v := h.Stats
	eq(t, v, "VPIP", 0, 3, 3)
	eq(t, v, "PFR", 0, 2, 3)
	eq(t, v, "Raise First In", 0, 2, 3)
	eq(t, v, "Fold to PF 3Bet After Raise", 0, 1, 1)
	eq(t, v, "CBet Flop", 0, 1, 1)
	eq(t, v, "CBet Turn", 0, 0, 1)
	eq(t, v, "Fold to T Bet", 0, 1, 1)
	eq(t, v, "Fold to F CBet", 0, 1, 1)
	eq(t, v, "Preflop Limp Call", 0, 1, 1)
	eq(t, v, "BB Won", 0, -1.25-7+0.5-3, 4)
	eq(t, v, "VPIP", 6, 1, 1) // BTN
	eq(t, v, "VPIP", 1, 0, 0) // BB: walk only

	// Filters.
	huds, _, _ = s.HUDs([]int64{1}, Filter{Limits: []int16{2}})
	if huds[0].Hands != 1 {
		t.Errorf("NL100 hands %d", huds[0].Hands)
	}
	huds, _, _ = s.HUDs([]int64{1}, Filter{LastHands: 2})
	if huds[0].Hands != 2 {
		t.Errorf("last 2 hands %d", huds[0].Hands)
	}
	since := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC).Unix()
	huds, _, _ = s.HUDs([]int64{1}, Filter{Since: since})
	if huds[0].Hands != 1 {
		t.Errorf("since hands %d", huds[0].Hands)
	}

	rep, err := s.Verify(1)
	if err != nil {
		t.Fatal(err)
	}
	ok := map[string]bool{}
	for _, r := range rep.Rows {
		ok[r.Stat] = r.Match
	}
	for _, stat := range []string{"VPIP", "PFR", "CBet Flop"} {
		if !ok[stat] {
			t.Errorf("verify %s: %+v", stat, rep.Rows)
		}
	}
	t.Logf("verify: %d/%d match, %d stats without a PT4 counter", rep.Matching, rep.Checked, len(rep.Missing))
}
