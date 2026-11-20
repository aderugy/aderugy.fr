package pt4

import (
	"encoding/json"
	"encoding/xml"
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
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
	// Panels defined on the site (src/lib/hud/extra.ts): row("label", "stat").
	if extra, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "src", "lib", "hud", "extra.ts")); err == nil {
		for _, m := range regexp.MustCompile(`row\("[^"]*", "([^"]+)"\)`).FindAllStringSubmatch(string(extra), -1) {
			if cat[m[1]] == nil {
				missing[m[1]] = true
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
	f.PfaSaw[Flop] = true
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

	// Reload drops the cached player; the next HUD reads PT4 again.
	if n := s.Reload(); n != 2 {
		t.Errorf("reload dropped %d players, want 2", n)
	}
	huds, _, err = s.HUDs([]int64{1}, Filter{})
	if err != nil || huds[0].Total != 4 {
		t.Fatalf("after reload %+v %v", huds, err)
	}
	eq(t, huds[0].Stats, "VPIP", 0, 3, 3)

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

	all, err := s.VerifyAll(5)
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Players) != 1 || all.Players[0].Name != "Villain" || len(all.Stats) == 0 {
		t.Fatalf("verify-all %+v", all.Players)
	}
	for _, st := range all.Stats {
		if st.Stat == "VPIP" && (st.Players != 1 || st.Matching != 1 || st.Mine != [2]float64{3, 3}) {
			t.Errorf("VPIP %+v", st)
		}
	}
}

const ptNote = `<?xml version="1.0" encoding="UTF-8"?>
<richtext version="1.0.0.0" xmlns="http://www.wxwidgets.org">
  <paragraphlayout textcolor="#000000" fontface="Segoe UI" margin-left="5,4098">
    <paragraph>
      <text>C4B = QQ</text>
    </paragraph>
    <paragraph>
      <text></text>
    </paragraph>
    <paragraph>
      <text>4BP &lt;= ccbet ip =&gt; MV bluff</text>
    </paragraph>
    <paragraph>
      <text></text>
    </paragraph>
  </paragraphlayout>
</richtext>
`

func TestNoteText(t *testing.T) {
	text, rich := NoteText(ptNote)
	if text != "C4B = QQ\n\n4BP <= ccbet ip => MV bluff" || rich {
		t.Errorf("%q rich=%v", text, rich)
	}
	empty := `<?xml version="1.0" encoding="UTF-8"?>
<richtext version="1.0.0.0" xmlns="http://www.wxwidgets.org">
  <paragraphlayout margin-left="4,4098"><paragraph><text></text></paragraph></paragraphlayout>
</richtext>`
	if text, _ := NoteText(empty); text != "" {
		t.Errorf("empty: %q", text)
	}
	bold := `<richtext><paragraphlayout><paragraph><text>a </text><text fontweight="700">fish</text></paragraph></paragraphlayout></richtext>`
	if text, rich := NoteText(bold); text != "a fish" || !rich {
		t.Errorf("bold: %q %v", text, rich)
	}
	if text, rich := NoteText("plain"); text != "plain" || rich {
		t.Errorf("plain: %q", text)
	}
}

func TestNoteXMLRoundTrip(t *testing.T) {
	in := "line <1> & \"2\"\r\n\nlast\x01"
	x := NoteXML(in, ptNote)
	if !strings.Contains(x, `fontface="Segoe UI"`) {
		t.Error("layout of the previous version not kept")
	}
	if !strings.Contains(x, "<text>line &lt;1&gt; &amp; &quot;2&quot;</text>") {
		t.Error(x)
	}
	out, rich := NoteText(x)
	if out != "line <1> & \"2\"\n\nlast" || rich {
		t.Errorf("%q", out)
	}
	if !strings.Contains(NoteXML("x", ""), defaultLayout) {
		t.Error("default layout")
	}
	var v struct{}
	if err := xml.Unmarshal([]byte(x), &v); err != nil {
		t.Errorf("not valid XML: %v", err)
	}
}

// Notes against the fixture database (PT4_TEST_DSN). The role needs
// GRANT INSERT, UPDATE ON notes; the test grants nothing itself.
func TestNotesIntegration(t *testing.T) {
	dsn := os.Getenv("PT4_TEST_DSN")
	if dsn == "" {
		t.Skip("PT4_TEST_DSN not set")
	}
	s := NewService(dsn)
	notes, err := s.Notes([]int64{1, 2, 101})
	if err != nil {
		t.Fatal(err)
	}
	n, ok := notes[1]
	if len(notes) != 1 || !ok || n.Color != 6 || n.Date != "2026-10-27T19:28:19" || !strings.HasPrefix(n.Text, "C4B = QQ\n\n4BP <=") {
		t.Fatalf("notes %+v", notes)
	}
	// Stale version → conflict with the current note.
	_, err = s.SaveNote(1, 6, "x", "2020-01-01T00:00:00")
	var c NoteConflict
	if !errors.As(err, &c) || c.Current == nil || c.Current.ID != 1327 {
		t.Fatalf("want a conflict, got %v", err)
	}
	// Update keeps the id and the layout, changes colour and date.
	saved, err := s.SaveNote(1, 8, "C4B = QQ\nnew line", n.Date)
	if err != nil {
		t.Fatal(err)
	}
	if saved.ID != 1327 || saved.Color != 8 || saved.Text != "C4B = QQ\nnew line" || saved.Date == n.Date {
		t.Fatalf("saved %+v", saved)
	}
	// Twice in the same second: the version still moves.
	again, err := s.SaveNote(1, 8, "C4B = QQ", saved.Date)
	if err != nil || again.Date == saved.Date {
		t.Fatalf("second save %+v %v", again, err)
	}
	// New note for a player without one: next id, read back.
	created, err := s.SaveNote(2, 3, "reg", "")
	if err != nil {
		t.Fatal(err)
	}
	if created.ID != 1331 || created.Color != 3 || created.Text != "reg" {
		t.Fatalf("created %+v", created)
	}
	if _, err := s.SaveNote(2, 3, "dup", ""); !errors.As(err, &c) {
		t.Fatalf("creating twice should conflict: %v", err)
	}
	if _, err := s.SaveNote(999, 1, "x", ""); err == nil || !strings.Contains(err.Error(), "no player") {
		t.Fatalf("unknown player: %v", err)
	}
	if _, err := s.SaveNote(1, 99, "x", ""); err == nil {
		t.Fatal("colour out of range accepted")
	}
	// The other sessions stay read-only.
	if _, err := s.query("UPDATE notes SET id_color = 0"); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("plain query should be read-only: %v", err)
	}
	// Still usable after all that (connections not left in a transaction).
	if _, err := s.Notes([]int64{1}); err != nil {
		t.Fatal(err)
	}
}

func TestAutoNotesIntegration(t *testing.T) {
	dsn := os.Getenv("PT4_TEST_DSN")
	if dsn == "" {
		t.Skip("PT4_TEST_DSN not set")
	}
	s := NewService(dsn)
	got, err := s.AutoNotes([]int64{1, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	v := got[1]
	if len(got) != 2 || len(v) != 3 || len(got[2]) != 1 {
		t.Fatalf("%+v", got)
	}
	// Category 1 first, most frequent first inside it.
	if v[0].Count != 11 || v[1].Text != "3Bet range {cardrange:QQ-KK,AQs+,AKo}" || v[1].Hands != 3 || v[2].Category != 2 {
		t.Errorf("%+v", v)
	}
	if v[1].Updated != "2026-11-19T00:00:00" {
		t.Errorf("updated %q", v[1].Updated)
	}
}

func TestLimperStats(t *testing.T) {
	// MP limps, CO isos, BTN (this player) 3bets.
	threeB := hand(0, 6, FVpip, FP3betOpp, FP3bet)
	threeB.Face2bet, threeB.PFaceLimpers = true, 1
	threeB.Act[Pre], threeB.Aggr[Pre], threeB.Actors[Pre] = "R", "810", "210"
	// Same, BTN just calls the iso.
	call := threeB
	call.flags = [2]uint64{}
	call.set(FVpip)
	call.set(FP3betOpp)
	call.Act[Pre] = "C"
	// A plain open (no limper) faced by the BTN: not an iso.
	open := hand(0, 6, FP3betOpp)
	open.Face2bet, open.Act[Pre], open.Aggr[Pre], open.Actors[Pre] = true, "F", "81", "1"
	// BB checks behind two limpers; another BB isos them.
	bbCheck := hand(8, 1)
	bbCheck.PFaceLimpers, bbCheck.Act[Pre], bbCheck.Aggr[Pre], bbCheck.Actors[Pre] = 2, "X", "8", "21"
	bbIso := hand(8, 1, FVpip, FPFirstRaise)
	bbIso.PFaceLimpers, bbIso.PRaise, bbIso.Act[Pre], bbIso.Aggr[Pre], bbIso.Actors[Pre] = 2, 1, "R", "88", "218"

	v := Compute(SortedCatalogue(), []Hand{threeB, call, open, bbCheck, bbIso})
	eq(t, v, "3Bet vs Iso-Raise", 0, 1, 2)
	eq(t, v, "3Bet vs Iso-Raise", 6, 1, 2) // BTN column
	eq(t, v, "Raise With Previous Limpers", 0, 1, 2)
	eq(t, v, "Raise With Previous Limpers", 1, 1, 2) // BB column
	eq(t, v, "Limp With Previous Limpers", 0, 0, 0)  // the BB can't limp
}

func TestFacingCheckRaise(t *testing.T) {
	// BTN (0) bets the flop, the BB (8) — who acts first, so checked — raises: BTN folds.
	xrFold := hand(0, 6, FFSaw, FFOpenOpp, FFBet, FFFaceRaise, FFFold)
	xrFold.Act[Flop], xrFold.Aggr[Flop], xrFold.RaiserPos[Flop] = "BF", "08", 8
	// Same, BTN calls.
	xrCall := xrFold
	xrCall.flags = [2]uint64{}
	for _, f := range []Flag{FFSaw, FFOpenOpp, FFBet, FFFaceRaise} {
		xrCall.set(f)
	}
	xrCall.Act[Flop] = "BC"
	// The BB (8) leads, the BTN (0) raises: a raise, not a check-raise.
	lead := hand(8, 1, FFSaw, FFOpenOpp, FFBet, FFFaceRaise, FFFold)
	lead.Act[Flop], lead.Aggr[Flop], lead.RaiserPos[Flop] = "BF", "80", 0
	// UTG (5) bets, CO (1) — acting after him — raises: not a check-raise.
	ip := hand(5, 3, FFSaw, FFOpenOpp, FFBet, FFFaceRaise)
	ip.Act[Flop], ip.Aggr[Flop], ip.RaiserPos[Flop] = "BC", "51", 1
	// MP (2) bets the turn, the SB (9) check-raises: re-raised.
	sb := hand(2, 4, FTSaw, FTOpenOpp, FTBet, FTFaceRaise)
	sb.Act[Turn], sb.Aggr[Turn], sb.RaiserPos[Turn] = "BR", "292", 9

	for _, h := range []*Hand{&xrFold, &xrCall, &lead, &ip} {
		h.Face2betS[Flop] = true
	}
	// The BB checks, the CO bets, the BTN raises: the BB faces a 2bet he
	// didn't bet into, and folds.
	cold := hand(8, 1, FFSaw, FFOpenOpp, FFCheck, FFFaceRaise, FFFold)
	cold.Act[Flop], cold.Aggr[Flop], cold.Face2betS[Flop] = "XF", "10", true

	v := Compute(SortedCatalogue(), []Hand{xrFold, xrCall, lead, ip, sb, cold})
	eq(t, v, "Fold to F Check Raise", 0, 1, 2)
	eq(t, v, "Call F Check Raise", 0, 1, 2)
	eq(t, v, "3Bet F Check Raise", 0, 0, 2)
	eq(t, v, "3Bet T Check Raise", 0, 1, 1)
	eq(t, v, "Fold to F 2Bet", 0, 3, 5) // every raise of a bet faced, bettor or not
	eq(t, v, "Call F 2Bet", 0, 2, 5)
	six := Hand{Players: 6}
	if !(six.actsBefore('9', '8') && six.actsBefore('8', '7') && six.actsBefore('5', '1') && six.actsBefore('1', '0') && !six.actsBefore('0', '9')) {
		t.Error("postflop order")
	}
	// Heads-up the SB is the button: the BB acts first after the flop.
	hu := Hand{Players: 2}
	if !hu.actsBefore('8', '9') || hu.actsBefore('9', '8') {
		t.Error("heads-up postflop order")
	}
}
