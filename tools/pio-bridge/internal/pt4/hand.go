package pt4

import (
	"fmt"
	"strconv"
	"strings"
)

// Flag is one boolean column of cash_hand_player_statistics, stored as a bit.
type Flag uint8

// The flags the stats read. Order = bit index; flagColumns gives the columns.
const (
	FVpip Flag = iota
	FPFirstRaise
	FPLimp
	FPFold
	FPCCall
	FPFaceRaise
	FP3bet
	FP3betOpp
	FP3betDefOpp
	FP4bet
	FP4betOpp
	FP4betDefOpp
	FPSqueeze
	FPSqueezeOpp
	FPSqueezeDefOpp
	FPOpenOpp
	FStealAtt
	FStealOpp
	FBlindDefOpp
	FSbStealFold
	FBbStealFold
	FShowdown
	FWonHand
	// per street: f, t, r (same order for each)
	FFBet
	FFFirstRaise
	FFCheck
	FFCheckRaise
	FFFold
	FFSaw
	FFFaceRaise
	FF3bet
	FF3betOpp
	FF3betDefOpp
	FFCbet
	FFCbetOpp
	FFCbetDefOpp
	FFDonk
	FFDonkOpp
	FFDonkDefOpp
	FFFloat // not a PT4 column on the flop: computed
	FFFloatOpp
	FFFloatDefOpp
	FFOpenOpp
	FFHasPosition
	FTBet
	FTFirstRaise
	FTCheck
	FTCheckRaise
	FTFold
	FTSaw
	FTFaceRaise
	FT3bet
	FT3betOpp
	FT3betDefOpp
	FTCbet
	FTCbetOpp
	FTCbetDefOpp
	FTDonk
	FTDonkOpp
	FTDonkDefOpp
	FTFloat
	FTFloatOpp
	FTFloatDefOpp
	FTOpenOpp
	FTHasPosition
	FRBet
	FRFirstRaise
	FRCheck
	FRCheckRaise
	FRFold
	FRSaw
	FRFaceRaise
	FR3bet
	FR3betOpp
	FR3betDefOpp
	FRCbet
	FRCbetOpp
	FRCbetDefOpp
	FRDonk
	FRDonkOpp
	FRDonkDefOpp
	FRFloat
	FRFloatOpp
	FRFloatDefOpp
	FROpenOpp
	FRHasPosition
	flagCount
)

// streetFlags lists the per-street flag suffixes in the order above.
var streetFlags = []string{"bet", "first_raise", "check", "check_raise", "fold", "saw", "face_raise",
	"3bet", "3bet_opp", "3bet_def_opp", "cbet", "cbet_opp", "cbet_def_opp", "donk", "donk_opp", "donk_def_opp",
	"float", "float_opp", "float_def_opp", "open_opp", "has_position"}

const streetFlagCount = 21

var flagColumns = func() []string {
	cols := []string{"flg_vpip", "flg_p_first_raise", "flg_p_limp", "flg_p_fold", "flg_p_ccall", "flg_p_face_raise",
		"flg_p_3bet", "flg_p_3bet_opp", "flg_p_3bet_def_opp", "flg_p_4bet", "flg_p_4bet_opp", "flg_p_4bet_def_opp",
		"flg_p_squeeze", "flg_p_squeeze_opp", "flg_p_squeeze_def_opp", "flg_p_open_opp",
		"flg_steal_att", "flg_steal_opp", "flg_blind_def_opp", "flg_sb_steal_fold", "flg_bb_steal_fold",
		"flg_showdown", "flg_won_hand"}
	for _, st := range []string{"f", "t", "r"} {
		for _, f := range streetFlags {
			if st == "f" && strings.HasPrefix(f, "float") {
				cols = append(cols, "") // computed
				continue
			}
			cols = append(cols, "flg_"+st+"_"+f)
		}
	}
	if len(cols) != int(flagCount) {
		panic(fmt.Sprintf("flag columns: %d, want %d", len(cols), flagCount))
	}
	return cols
}()

// Street indexes.
const (
	Pre = iota
	Flop
	Turn
	River
)

// sf returns the flag for street st (Flop..River) given its flop flag.
func sf(st int, flop Flag) Flag { return flop + Flag((st-Flop)*streetFlagCount) }

// Hand is one hand from one player's point of view.
type Hand struct {
	ID       int64
	Date     int64 // unix seconds (PT4 stores the site's time, usually UTC)
	Limit    int16
	BB       float64
	Position int8 // PT4: 0 BTN, 1 CO, 2…7 earlier, 8 BB, 9 SB
	Cat      int8 // HUD position filter: 1 BB, 2 SB, 3 EP, 4 MP, 5 CO, 6 BTN, 0 unknown
	Players  int8 // cnt_players_lookup_position
	PlayersF int8
	flags    [2]uint64

	PRaise, PCall, PFaceLimpers int8
	Raise, Call                 [4]int8 // by street (index 0 unused)

	Enum3bet, Enum4bet, EnumSqueeze byte    // preflop defence actions F/C/R
	EnumCbet, EnumDonk, EnumFloat   [4]byte // by street
	Enum3betS                       [4]byte
	EnumAllin                       byte

	Face2bet, Face3bet bool    // amt_p_2bet_facing / amt_p_3bet_facing > 0
	FaceBet            [4]bool // amt_<st>_bet_facing > 0

	Won, BetR, BetTotal, Equity float64

	Act    [4]string // lookup_actions.action per street
	Aggr   [4]string // cash_hand_summary.str_aggressors_*
	Actors [4]string // cash_hand_summary.str_actors_*
	// OpenerCat: HUD position category of the preflop 2bettor (0 = none).
	OpenerCat int8
}

func (h *Hand) F(f Flag) bool { return h.flags[f/64]&(1<<(f%64)) != 0 }
func (h *Hand) set(f Flag)    { h.flags[f/64] |= 1 << (f % 64) }

/* ---------------------------------------------------------------- loading */

// handColumns: the SELECT list, parsed by parseHand in this order.
func handColumns() []string {
	var flags []string
	for _, c := range flagColumns {
		if c == "" {
			flags = append(flags, "false")
		} else {
			flags = append(flags, "s."+c)
		}
	}
	return []string{
		"s.id_hand", "extract(epoch from s.date_played)::bigint", "s.id_limit", "l.amt_bb", "s.position",
		"s.cnt_players_lookup_position", "hs.cnt_players_f",
		// all flags as one 't'/'f' string
		"concat_ws('', " + strings.Join(boolChars(flags), ", ") + ")",
		"s.cnt_p_raise", "s.cnt_p_call", "s.cnt_p_face_limpers",
		"s.cnt_f_raise", "s.cnt_f_call", "s.cnt_t_raise", "s.cnt_t_call", "s.cnt_r_raise", "s.cnt_r_call",
		"s.enum_p_3bet_action", "s.enum_p_4bet_action", "s.enum_p_squeeze_action",
		"s.enum_f_cbet_action", "s.enum_t_cbet_action", "s.enum_r_cbet_action",
		"s.enum_f_donk_action", "s.enum_t_donk_action", "s.enum_r_donk_action",
		"s.enum_t_float_action", "s.enum_r_float_action",
		"s.enum_f_3bet_action", "s.enum_t_3bet_action", "s.enum_r_3bet_action",
		"s.enum_allin",
		"s.amt_p_2bet_facing > 0", "s.amt_p_3bet_facing > 0",
		"s.amt_f_bet_facing > 0", "s.amt_t_bet_facing > 0", "s.amt_r_bet_facing > 0",
		"s.amt_won", "s.amt_bet_r", "s.amt_bet_ttl", "s.val_equity",
		"ap.action", "af.action", "at.action", "ar.action",
		"hs.str_aggressors_p", "hs.str_aggressors_f", "hs.str_aggressors_t", "hs.str_aggressors_r",
		"hs.str_actors_p", "hs.str_actors_f", "hs.str_actors_t", "hs.str_actors_r",
	}
}

func boolChars(exprs []string) []string {
	out := make([]string, len(exprs))
	for i, e := range exprs {
		out[i] = "CASE WHEN " + e + " THEN 't' ELSE 'f' END"
	}
	return out
}

// HandsQuery selects one player's hands with an id above after, oldest first.
func HandsQuery(player int64, after int64) string {
	return "SELECT " + strings.Join(handColumns(), ", ") + `
FROM cash_hand_player_statistics s
JOIN cash_hand_summary hs ON hs.id_hand = s.id_hand
JOIN cash_limit l ON l.id_limit = s.id_limit
LEFT JOIN lookup_actions ap ON ap.id_action = s.id_action_p
LEFT JOIN lookup_actions af ON af.id_action = s.id_action_f
LEFT JOIN lookup_actions at ON at.id_action = s.id_action_t
LEFT JOIN lookup_actions ar ON ar.id_action = s.id_action_r
WHERE s.id_player = ` + strconv.FormatInt(player, 10) + ` AND s.id_hand > ` + strconv.FormatInt(after, 10) + `
ORDER BY s.date_played, s.id_hand`
}

// Positions maps (cnt_players_lookup_position, position) → HUD category.
type Positions map[[2]int8]int8

func (p Positions) cat(players, pos int8) int8 {
	if c, ok := p[[2]int8{players, pos}]; ok {
		return c
	}
	// Fallback when lookup_positions has no row.
	switch {
	case pos == 8:
		return 1
	case pos == 9:
		return 2
	case pos == 0:
		return 6
	case pos == 1:
		return 5
	case pos <= 3:
		return 4
	}
	return 3
}

const PositionsQuery = `SELECT cnt_players, position,
  CASE WHEN flg_bb THEN 1 WHEN flg_sb THEN 2 WHEN flg_ep THEN 3 WHEN flg_mp THEN 4 WHEN flg_co THEN 5 WHEN flg_btn THEN 6 ELSE 0 END
FROM lookup_positions`

func ParsePositions(r *Rows) Positions {
	p := Positions{}
	for _, v := range r.Values {
		p[[2]int8{int8(atoi(v[0])), int8(atoi(v[1]))}] = int8(atoi(v[2]))
	}
	return p
}

func atoi(b []byte) int64 {
	n, _ := strconv.ParseInt(string(b), 10, 64)
	return n
}

func atof(b []byte) float64 {
	f, _ := strconv.ParseFloat(string(b), 64)
	return f
}

func enum(b []byte) byte {
	if len(b) == 0 {
		return 0
	}
	return b[0]
}

func ParseHands(r *Rows, pos Positions) ([]Hand, error) {
	want := len(handColumns())
	if len(r.Columns) != want {
		return nil, fmt.Errorf("hands query: %d columns, want %d", len(r.Columns), want)
	}
	out := make([]Hand, 0, len(r.Values))
	for _, v := range r.Values {
		h := Hand{}
		i := 0
		next := func() []byte { b := v[i]; i++; return b }
		h.ID = atoi(next())
		h.Date = atoi(next())
		h.Limit = int16(atoi(next()))
		h.BB = atof(next())
		h.Position = int8(atoi(next()))
		h.Players = int8(atoi(next()))
		h.PlayersF = int8(atoi(next()))
		for j, c := range next() {
			if c == 't' {
				h.set(Flag(j))
			}
		}
		h.PRaise = int8(atoi(next()))
		h.PCall = int8(atoi(next()))
		h.PFaceLimpers = int8(atoi(next()))
		for st := Flop; st <= River; st++ {
			h.Raise[st] = int8(atoi(next()))
			h.Call[st] = int8(atoi(next()))
		}
		h.Enum3bet, h.Enum4bet, h.EnumSqueeze = enum(next()), enum(next()), enum(next())
		for st := Flop; st <= River; st++ {
			h.EnumCbet[st] = enum(next())
		}
		for st := Flop; st <= River; st++ {
			h.EnumDonk[st] = enum(next())
		}
		h.EnumFloat[Turn], h.EnumFloat[River] = enum(next()), enum(next())
		for st := Flop; st <= River; st++ {
			h.Enum3betS[st] = enum(next())
		}
		h.EnumAllin = enum(next())
		h.Face2bet = enum(next()) == 't'
		h.Face3bet = enum(next()) == 't'
		for st := Flop; st <= River; st++ {
			h.FaceBet[st] = enum(next()) == 't'
		}
		h.Won, h.BetR, h.BetTotal, h.Equity = atof(next()), atof(next()), atof(next()), atof(next())
		for st := Pre; st <= River; st++ {
			h.Act[st] = string(next())
		}
		for st := Pre; st <= River; st++ {
			h.Aggr[st] = string(next())
		}
		for st := Pre; st <= River; st++ {
			h.Actors[st] = string(next())
		}
		h.Cat = pos.cat(h.Players, h.Position)
		if len(h.Aggr[Pre]) >= 2 {
			if p, err := strconv.Atoi(h.Aggr[Pre][1:2]); err == nil {
				h.OpenerCat = pos.cat(h.Players, int8(p))
			}
		}
		h.derive()
		out = append(out, h)
	}
	return out, nil
}

/* ------------------------------------------------------------- derivations */

// posChar is the player's position as it appears in str_aggressors / str_actors.
func (h *Hand) posChar() byte { return '0' + byte(h.Position) }

// Raised: someone raised preflop (str_aggressors_p starts with the big blind).
func (h *Hand) Raised() bool { return len(h.Aggr[Pre]) >= 2 }

// Pot3bet: a 3bet or more preflop.
func (h *Hand) Pot3bet() bool { return len(h.Aggr[Pre]) >= 3 }

// LimpPot: no raise preflop.
func (h *Hand) LimpPot() bool { return len(h.Aggr[Pre]) <= 1 }

// PFA: the player made the last preflop raise.
func (h *Hand) PFA() bool {
	a := h.Aggr[Pre]
	return len(a) >= 2 && a[len(a)-1] == h.posChar()
}

func (h *Hand) pfaChar() byte {
	a := h.Aggr[Pre]
	if len(a) < 2 {
		return 0
	}
	return a[len(a)-1]
}

// Walk: the big blind won without acting.
func (h *Hand) Walk() bool { return h.Act[Pre] == "" }

// First is the player's first preflop action (F, C, R, X) or 0.
func (h *Hand) First() byte { return enum([]byte(h.Act[Pre])) }

// Resp is the player's first non-check action on a street.
func (h *Hand) Resp(st int) byte {
	return enum([]byte(strings.TrimLeft(h.Act[st], "X")))
}

// AfterBet is the player's action after his own bet on a street (facing a raise).
func (h *Hand) AfterBet(st int) byte {
	a := h.Act[st]
	i := strings.IndexByte(a, 'B')
	if i < 0 || i+1 >= len(a) {
		return 0
	}
	return a[i+1]
}

// ActedBefore: who acted first on the street between positions a and b.
func (h *Hand) actedBefore(st int, a, b byte) bool {
	s := h.Actors[st]
	ia, ib := strings.IndexByte(s, a), strings.IndexByte(s, b)
	return ia >= 0 && (ib < 0 || ia < ib)
}

// FacedCheckRaise: the player bet the street and was raised by someone who
// had checked before him.
func (h *Hand) FacedCheckRaise(st int) bool {
	if !h.F(sf(st, FFBet)) || !h.F(sf(st, FFFaceRaise)) {
		return false
	}
	a := h.Aggr[st]
	me := h.posChar()
	i := strings.IndexByte(a, me)
	if i < 0 || i+1 >= len(a) {
		return false
	}
	return h.actedBefore(st, a[i+1], me)
}

// CheckRaiseOpp: the player checked and faced a bet.
func (h *Hand) CheckRaiseOpp(st int) bool {
	return strings.HasPrefix(h.Act[st], "X") && len(h.Act[st]) >= 2
}

// FacingFirstBet: facing a bet he didn't make (a raise opportunity).
func (h *Hand) FacingFirstBet(st int) bool {
	return h.FaceBet[st] && !h.F(sf(st, FFBet))
}

// ProbeOpp (turn / river): not the preflop aggressor, the PFA is still in, the
// previous street was checked through, and the player is first to act.
func (h *Hand) ProbeOpp(st int) bool {
	if st < Turn || !h.Raised() || h.PFA() || h.Aggr[st-1] != "" {
		return false
	}
	return h.F(sf(st, FFOpenOpp)) && !h.F(sf(st, FFHasPosition)) &&
		strings.IndexByte(h.Actors[st-1], h.pfaChar()) >= 0
}

// ProbeDefOpp (turn / river): the PFA, previous street checked through, faces
// a bet from a player who acted before him.
func (h *Hand) ProbeDefOpp(st int) bool {
	if st < Turn || !h.PFA() || h.Aggr[st-1] != "" || !h.FacingFirstBet(st) || h.Aggr[st] == "" {
		return false
	}
	return h.actedBefore(st, h.Aggr[st][0], h.posChar())
}

// derive fills the flop float flags (PT4 has them for turn and river only).
// Float flop: not the PFA, in position on the PFA, who checked; bet or not.
func (h *Hand) derive() {
	if !h.F(FFSaw) || !h.Raised() {
		return
	}
	pfa := h.pfaChar()
	if !h.PFA() && strings.IndexByte(h.Actors[Flop], pfa) >= 0 && h.F(FFHasPosition) && h.F(FFOpenOpp) &&
		h.actedBefore(Flop, pfa, h.posChar()) {
		h.set(FFFloatOpp)
		if h.F(FFBet) {
			h.set(FFFloat)
		}
	}
	if h.PFA() && strings.HasPrefix(h.Act[Flop], "X") && h.FacingFirstBet(Flop) && h.Aggr[Flop] != "" &&
		!h.actedBefore(Flop, h.Aggr[Flop][0], h.posChar()) {
		h.set(FFFloatDefOpp)
		h.EnumFloat[Flop] = h.Resp(Flop)
	}
}
