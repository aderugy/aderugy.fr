package pt4

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Oracle: PT4's own cash_cache counters for a stat, as SQL expressions over
// summed columns. Used to check the re-derived stats against PT4.
type oracle struct{ num, den string }

func oracles() map[string]oracle {
	o := map[string]oracle{
		"VPIP":                            {"cnt_vpip", "cnt_hands - cnt_walks"},
		"PFR":                             {"cnt_pfr", "cnt_pfr_opp"},
		"Raise First In":                  {"cnt_p_raise_first_in", "cnt_p_open_opp"},
		"3Bet Preflop":                    {"cnt_p_3bet", "cnt_p_3bet_opp"},
		"4Bet Preflop":                    {"cnt_p_4bet", "cnt_p_4bet_opp"},
		"4Bet+ Preflop After Raising":     {"cnt_p_4bet_after_raising", "cnt_p_4bet_opp_when_open_raised"},
		"Fold to PF 3Bet After Raise":     {"cnt_p_3bet_def_action_fold_when_open_raised", "cnt_p_3bet_def_opp_when_open_raised"},
		"Call PF 3Bet":                    {"cnt_p_3bet_def_action_call", "cnt_p_3bet_def_opp"},
		"Fold to PF 4Bet After 3Bet":      {"cnt_p_4bet_def_action_fold_after_3b", "cnt_p_4bet_def_opp_after_3b"},
		"Call PF 4Bet":                    {"cnt_p_4bet_def_action_call", "cnt_p_4bet_def_opp"},
		"Preflop Squeeze":                 {"cnt_p_squeeze", "cnt_p_squeeze_opp"},
		"Fold to PF Squeeze":              {"cnt_p_squeeze_def_fold", "cnt_p_squeeze_def_opp"},
		"Call PF Squeeze":                 {"cnt_p_squeeze_def_call", "cnt_p_squeeze_def_opp"},
		"Raise PF Squeeze":                {"cnt_p_squeeze_def_raise", "cnt_p_squeeze_def_opp"},
		"Att To Steal":                    {"cnt_steal_att", "cnt_steal_opp"},
		"Att To Steal - SB":               {"cnt_steal_att_sb", "cnt_steal_opp_sb"},
		"Fold to Steal":                   {"cnt_steal_def_action_fold", "cnt_steal_def_opp"},
		"Call Steal":                      {"cnt_steal_def_action_call", "cnt_steal_def_opp"},
		"3Bet Steal":                      {"cnt_steal_def_action_raise", "cnt_steal_def_opp"},
		"Fold to PF 3Bet After Steal":     {"cnt_steal_3bet_def_action_fold", "cnt_steal_3bet_def_opp"},
		"3Bet vs BTN Open":                {"cnt_p_3bet_vs_btn_open", "cnt_p_3bet_opp_vs_btn_open"},
		"3Bet vs CO Open":                 {"cnt_p_3bet_vs_co_open", "cnt_p_3bet_opp_vs_co_open"},
		"Call vs BTN Open":                {"cnt_p_call_vs_btn_open", "cnt_p_2bet_def_opp_vs_btn_open"},
		"Call vs CO Open":                 {"cnt_p_call_vs_co_open", "cnt_p_2bet_def_opp_vs_co_open"},
		"Fold vs BTN Open":                {"cnt_p_fold_vs_btn_open", "cnt_p_2bet_def_opp_vs_btn_open"},
		"BB vs SB Open - 3Bet":            {"cnt_p_bb_v_sb_3bet", "cnt_p_bb_v_sb_3bet_opp"},
		"BB vs SB Open - Call":            {"cnt_p_bb_v_sb_call", "cnt_p_bb_v_sb_3bet_opp"},
		"Call PF 2Bet":                    {"cnt_p_2bet_def_action_call", "cnt_p_2bet_def_opp"},
		"Cold Call 2Bet PF":               {"cnt_p_ccall", "cnt_p_ccall_opp"},
		"Cold Call 3Bet+ PF":              {"cnt_p_ccall_3bet", "cnt_p_ccall_3bet_opp"},
		"Preflop Limp Call":               {"cnt_p_limp_call", "cnt_p_limp_faceraise"},
		"Preflop Limp Fold":               {"cnt_p_limp_fold", "cnt_p_limp_faceraise"},
		"Raise With Previous Limpers":     {"cnt_p_raise_limpers", "cnt_p_raise_opp_facing_limpers"},
		"5Bet+ Preflop":                   {"cnt_p_5bet", "cnt_p_5bet_opp"},
		"Fold to PF 5Bet+":                {"cnt_p_5bet_def_action_fold", "cnt_p_5bet_def_opp"},
		"WTSD":                            {"cnt_wtsd", "cnt_f_saw"},
		"WSD":                             {"cnt_wtsd_won", "cnt_wtsd"},
		"WWSF":                            {"cnt_f_saw_won", "cnt_f_saw"},
		"Saw River Percentage":            {"cnt_r_saw", "cnt_f_saw"},
		"Bet Flop (limp pot)":             {"cnt_f_bet_limp_pot", "cnt_f_open_opp_limp_pot"},
		"Fold to Raise After F CBet":      {"cnt_f_cbet_fold_to_raise", "cnt_f_cbet_face_raise"},
		"Fold to Raise After T CBet":      {"cnt_t_cbet_fold_to_raise", "cnt_t_cbet_face_raise"},
		"Fold to Raise After R CBet":      {"cnt_r_cbet_fold_to_raise", "cnt_r_cbet_face_raise"},
		"Fold to Raise After F Donk":      {"cnt_f_donk_fold", "cnt_f_donk_face_raise"},
		"Fold to Raise After F Float Bet": {"cnt_f_float_fold", "cnt_f_float_face_raise"},
	}
	for _, s := range streets {
		x := strings.ToLower(s.letter)
		L, W := s.letter, s.word
		o["CBet "+W] = oracle{"cnt_" + x + "_cbet", "cnt_" + x + "_cbet_opp"}
		o["CBet "+W+" in 3Bet+ Pot"] = oracle{"cnt_" + x + "_cbet_3bet_pot", "cnt_" + x + "_cbet_opp_3bet_pot"}
		o["Donk "+W] = oracle{"cnt_" + x + "_donk", "cnt_" + x + "_donk_opp"}
		o["Float "+W] = oracle{"cnt_" + x + "_float", "cnt_" + x + "_float_opp"}
		o["Check Raise "+W] = oracle{"cnt_" + x + "_check_raise", "cnt_" + x + "_check_raise_opp"}
		o["3Bet "+W] = oracle{"cnt_" + x + "_3bet", "cnt_" + x + "_3bet_opp"}
		for verb, a := range map[string]string{"Fold to": "fold", "Call": "call", "Raise": "raise"} {
			o[verb+" "+L+" CBet"] = oracle{"cnt_" + x + "_cbet_def_action_" + a, "cnt_" + x + "_cbet_def_opp"}
			donk := "_donk_def_action_"
			float := "_float_def_action_"
			if x == "f" {
				donk, float = "_donk_def_opp_action_", "_float_def_opp_action_"
			}
			o[verb+" "+L+" Donk Bet"] = oracle{"cnt_" + x + donk + a, "cnt_" + x + "_donk_def_opp"}
			o[verb+" "+L+" Float Bet"] = oracle{"cnt_" + x + float + a, "cnt_" + x + "_float_def_opp"}
			if x != "f" {
				o[verb+" "+L+" Probe Bet"] = oracle{"cnt_" + x + "_probe_def_action_" + a, "cnt_" + x + "_probe_def_opp"}
			}
			if a != "raise" {
				o[verb+" "+L+" Bet"] = oracle{"cnt_" + x + "_bet_def_action_" + a, "cnt_" + x + "_bet_def_opp"}
				o[verb+" "+L+" 2Bet"] = oracle{"cnt_" + x + "_2bet_def_action_" + a, "cnt_" + x + "_2bet_def_opp"}
				o[verb+" "+L+" 3Bet"] = oracle{"cnt_" + x + "_3bet_def_action_" + a, "cnt_" + x + "_3bet_def_opp"}
				o[verb+" "+L+" Check Raise"] = oracle{"cnt_" + x + "_face_xr_" + a, "cnt_" + x + "_face_xr"}
			}
		}
		o["3Bet "+L+" Check Raise"] = oracle{"cnt_" + x + "_face_xr_raise", "cnt_" + x + "_face_xr"}
		o["2Bet "+W] = oracle{"", "cnt_" + x + "_2bet_opp"}
		if x != "f" {
			o["Probe "+W] = oracle{"cnt_" + x + "_probe", "cnt_" + x + "_probe_opp"}
			o["Probe "+W+" in 3Bet+ Pot"] = oracle{"cnt_" + x + "_probe_3bet_pot", "cnt_" + x + "_probe_opp_3bet_pot"}
		}
		o["Float "+W+" in 3Bet+ Pot"] = oracle{"cnt_" + x + "_float_3bet_pot", "cnt_" + x + "_float_opp_3bet_pot"}
	}
	for _, p := range []string{"ep", "mp", "co", "btn", "sb", "bb"} {
		o["3Bet vs "+strings.ToUpper(p)+" 2Bet"] = oracle{"cnt_p_3bet_vs_" + p + "_2bet", "cnt_p_3bet_opp_vs_" + p + "_2bet"}
	}
	return o
}

type VerifyRow struct {
	Stat  string     `json:"stat"`
	Mine  [2]float64 `json:"mine"`
	PT4   [2]float64 `json:"pt4"`
	Match bool       `json:"match"`
	Note  string     `json:"note,omitempty"`
}

type VerifyReport struct {
	Player   HUD         `json:"player"`
	Checked  int         `json:"checked"`
	Matching int         `json:"matching"`
	Rows     []VerifyRow `json:"rows"`
	Missing  []string    `json:"noPt4Counter"`
	Millis   int64       `json:"ms"`
}

// Verify compares one player's unfiltered stats with PT4's cash_cache.
func (s *Service) Verify(id int64) (*VerifyReport, error) {
	t0 := time.Now()
	huds, _, err := s.HUDs([]int64{id}, Filter{})
	if err != nil {
		return nil, err
	}
	hud := huds[0]
	if hud.Error != "" {
		return nil, &verifyErr{hud.Error}
	}
	cols, err := s.query(`SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'cash_cache'`)
	if err != nil {
		return nil, err
	}
	have := map[string]bool{}
	for _, v := range cols.Values {
		have[string(v[0])] = true
	}
	usable := func(expr string) bool {
		if expr == "" {
			return false
		}
		for _, f := range strings.FieldsFunc(expr, func(r rune) bool { return r == ' ' || r == '-' || r == '+' }) {
			if !have[f] {
				return false
			}
		}
		return true
	}
	sumExpr := func(expr string) string {
		parts := strings.Fields(expr)
		for i, p := range parts {
			if p != "-" && p != "+" {
				parts[i] = "coalesce(sum(" + p + "), 0)"
			}
		}
		return strings.Join(parts, " ")
	}
	type q struct {
		stat     string
		num, den string
	}
	var qs []q
	var exprs []string
	report := &VerifyReport{Player: hud}
	for stat, o := range oracles() {
		if !usable(o.den) {
			continue
		}
		num := o.num
		if !usable(num) {
			num = ""
		}
		qs = append(qs, q{stat, num, o.den})
		if num != "" {
			exprs = append(exprs, sumExpr(num))
		}
		exprs = append(exprs, sumExpr(o.den))
	}
	if len(exprs) == 0 {
		return report, nil
	}
	r, err := s.query("SELECT " + strings.Join(exprs, ", ") + " FROM cash_cache WHERE id_player = " + strconv.FormatInt(id, 10))
	if err != nil {
		return nil, err
	}
	vals := r.Values[0]
	i := 0
	for _, x := range qs {
		row := VerifyRow{Stat: x.stat}
		if x.num != "" {
			row.PT4[0] = atof(vals[i])
			i++
		} else {
			row.Note = "denominator only"
		}
		row.PT4[1] = atof(vals[i])
		i++
		if v := hud.Stats[x.stat]; v != nil {
			row.Mine = v[0]
		}
		row.Match = math.Abs(row.Mine[1]-row.PT4[1]) < 0.5 && (x.num == "" || math.Abs(row.Mine[0]-row.PT4[0]) < 0.5)
		report.Rows = append(report.Rows, row)
		report.Checked++
		if row.Match {
			report.Matching++
		}
	}
	sort.Slice(report.Rows, func(a, b int) bool {
		if report.Rows[a].Match != report.Rows[b].Match {
			return !report.Rows[a].Match
		}
		return report.Rows[a].Stat < report.Rows[b].Stat
	})
	o := oracles()
	for _, st := range s.catalogue {
		if _, ok := o[st.Name]; !ok {
			report.Missing = append(report.Missing, st.Name)
		}
	}
	report.Millis = time.Since(t0).Milliseconds()
	return report, nil
}

type verifyErr struct{ msg string }

func (e *verifyErr) Error() string { return e.msg }

/* ------------------------------------------------------------ whole report */

type VerifyStat struct {
	Stat     string     `json:"stat"`
	Players  int        `json:"players"`  // players with an opportunity (mine or PT4's)
	Matching int        `json:"matching"` // of those, exact matches
	Mine     [2]float64 `json:"mine"`     // summed over the players
	PT4      [2]float64 `json:"pt4"`
	Note     string     `json:"note,omitempty"`
	// Worst: the player with the biggest gap, to look at in PT4.
	Worst *VerifyWorst `json:"worst,omitempty"`
}

type VerifyWorst struct {
	ID   int64      `json:"id"`
	Name string     `json:"name"`
	Mine [2]float64 `json:"mine"`
	PT4  [2]float64 `json:"pt4"`
}

type VerifyAllReport struct {
	Players []VerifyPlayer `json:"players"`
	// Stats sorted worst first: fewest matching players.
	Stats []VerifyStat `json:"stats"`
	// Stats of the catalogue PT4 has no counter for: check them by eye.
	NoPt4Counter []string `json:"noPt4Counter"`
	Millis       int64    `json:"ms"`
}

type VerifyPlayer struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Hands    int    `json:"hands"`
	Checked  int    `json:"checked"`
	Matching int    `json:"matching"`
	Error    string `json:"error,omitempty"`
}

// VerifyAll runs Verify on the n players with the most cash hands and adds
// the results up by stat.
func (s *Service) VerifyAll(n int) (*VerifyAllReport, error) {
	t0 := time.Now()
	if n <= 0 || n > 100 {
		n = 20
	}
	r, err := s.query(`SELECT id_player FROM cash_cache GROUP BY id_player ORDER BY sum(cnt_hands) DESC LIMIT ` + strconv.Itoa(n))
	if err != nil {
		return nil, err
	}
	rep := &VerifyAllReport{}
	byStat := map[string]*VerifyStat{}
	gap := map[string]float64{}
	for _, v := range r.Values {
		id := atoi(v[0])
		pr, err := s.Verify(id)
		if err != nil {
			rep.Players = append(rep.Players, VerifyPlayer{ID: id, Error: err.Error()})
			continue
		}
		rep.Players = append(rep.Players, VerifyPlayer{ID: id, Name: pr.Player.Name, Hands: pr.Player.Total,
			Checked: pr.Checked, Matching: pr.Matching})
		if rep.NoPt4Counter == nil {
			rep.NoPt4Counter = pr.Missing
		}
		for _, row := range pr.Rows {
			st := byStat[row.Stat]
			if st == nil {
				st = &VerifyStat{Stat: row.Stat, Note: row.Note}
				byStat[row.Stat] = st
			}
			if row.Mine[1] == 0 && row.PT4[1] == 0 {
				continue // no opportunity either way
			}
			st.Players++
			if row.Match {
				st.Matching++
			}
			for i := 0; i < 2; i++ {
				st.Mine[i] += row.Mine[i]
				st.PT4[i] += row.PT4[i]
			}
			g := math.Abs(row.Mine[1]-row.PT4[1]) + math.Abs(row.Mine[0]-row.PT4[0])
			if !row.Match && g > gap[row.Stat] {
				gap[row.Stat] = g
				st.Worst = &VerifyWorst{ID: id, Name: pr.Player.Name, Mine: row.Mine, PT4: row.PT4}
			}
		}
	}
	for _, st := range byStat {
		rep.Stats = append(rep.Stats, *st)
	}
	sort.Slice(rep.Stats, func(i, j int) bool {
		a, b := rep.Stats[i], rep.Stats[j]
		ra, rb := ratio(a.Matching, a.Players), ratio(b.Matching, b.Players)
		if ra != rb {
			return ra < rb
		}
		return a.Stat < b.Stat
	})
	rep.Millis = time.Since(t0).Milliseconds()
	return rep, nil
}

func ratio(a, b int) float64 {
	if b == 0 {
		return 2 // nothing to compare: last
	}
	return float64(a) / float64(b)
}
