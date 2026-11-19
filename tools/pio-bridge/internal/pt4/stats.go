package pt4

// The stats of the HUD, by their PokerTracker 4 names, computed from one
// player's hands. Each stat gives a numerator and a denominator per hand;
// the site turns them into the value PT4 shows (%, ratio, bb/100…).
//
// Built-in PT4 stats are re-derived from the columns of
// cash_hand_player_statistics (flg_*, enum_*) and cash_hand_summary
// (str_aggressors_*, str_actors_*). `piobridge -pt4-verify` compares the
// unfiltered totals with PT4's own cash_cache counters where one exists.

type Kind string

const (
	Pct   Kind = "pct"   // num / den × 100
	Ratio Kind = "ratio" // num / den
	Count Kind = "count" // num
	BB100 Kind = "bb100" // num / den × 100 (num in big blinds)
	Sum   Kind = "sum"   // num (e.g. big blinds won)
)

type Stat struct {
	Name string
	Kind Kind
	Acc  func(h *Hand) (num, den float64)
	// Exact: the definition is PT4's own (custom stat exported with the HUD,
	// or a direct flag ratio). Others are re-derivations to check.
	Exact bool
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// pct: den(h) decides the opportunity, num(h) the action.
func pct(den, num func(h *Hand) bool) func(h *Hand) (float64, float64) {
	return func(h *Hand) (float64, float64) {
		if !den(h) {
			return 0, 0
		}
		return b2f(num(h)), 1
	}
}

func flag(f Flag) func(h *Hand) bool { return func(h *Hand) bool { return h.F(f) } }

func and(ps ...func(h *Hand) bool) func(h *Hand) bool {
	return func(h *Hand) bool {
		for _, p := range ps {
			if !p(h) {
				return false
			}
		}
		return true
	}
}

func not(p func(h *Hand) bool) func(h *Hand) bool { return func(h *Hand) bool { return !p(h) } }

func is(get func(h *Hand) byte, c byte) func(h *Hand) bool {
	return func(h *Hand) bool { return get(h) == c }
}

var (
	pot3bet    = func(h *Hand) bool { return h.Pot3bet() }
	limpPot    = func(h *Hand) bool { return h.LimpPot() }
	blind      = func(h *Hand) bool { return h.Cat == 1 || h.Cat == 2 }
	first      = func(h *Hand) byte { return h.First() }
	face2bet   = func(h *Hand) bool { return h.Face2bet && !h.F(FPLimp) && !h.F(FPFirstRaise) }
	noLimpers  = func(h *Hand) bool { return h.PFaceLimpers == 0 }
	openerIs   = func(cat int8) func(h *Hand) bool { return func(h *Hand) bool { return h.OpenerCat == cat } }
	openerChar = func(c byte) func(h *Hand) bool {
		return func(h *Hand) bool { return len(h.Aggr[Pre]) >= 2 && h.Aggr[Pre][1] == c }
	}
)

var streets = []struct {
	st           int
	letter, word string
}{{Flop, "F", "Flop"}, {Turn, "T", "Turn"}, {River, "R", "River"}}

var potVariants = []struct {
	suffix string
	cond   func(h *Hand) bool
}{
	{"", func(*Hand) bool { return true }},
	{" in 3Bet+ Pot", pot3bet},
	{" in non-3Bet+ Pot", not(pot3bet)},
}

// Catalogue builds every stat, keyed by PT4 name.
func Catalogue() map[string]*Stat {
	m := map[string]*Stat{}
	add := func(name string, kind Kind, acc func(h *Hand) (float64, float64), exact bool) {
		m[name] = &Stat{Name: name, Kind: kind, Acc: acc, Exact: exact}
	}
	p := func(name string, den, num func(h *Hand) bool) { add(name, Pct, pct(den, num), false) }
	px := func(name string, den, num func(h *Hand) bool) { add(name, Pct, pct(den, num), true) }

	/* -------------------------------------------------------- general */
	add("Hands Abbreviated", Count, func(h *Hand) (float64, float64) { return 1, 1 }, true)
	add("Player", Count, func(h *Hand) (float64, float64) { return 1, 1 }, true)
	px("VPIP", not((*Hand).Walk), flag(FVpip))
	px("PFR", not((*Hand).Walk), func(h *Hand) bool { return h.PRaise > 0 })
	add("BB/100", BB100, func(h *Hand) (float64, float64) {
		if h.BB <= 0 {
			return 0, 0
		}
		return h.Won / h.BB, 1
	}, true)
	add("BB Won", Sum, func(h *Hand) (float64, float64) {
		if h.BB <= 0 {
			return 0, 0
		}
		return h.Won / h.BB, 1
	}, true)
	px("WWSF", flag(FFSaw), flag(FWonHand))
	px("WTSD", flag(FFSaw), flag(FShowdown))
	px("WSD", flag(FShowdown), flag(FWonHand))
	p("WSDWRR", func(h *Hand) bool { return h.F(FShowdown) && h.Raise[River] > 0 }, flag(FWonHand))
	p("Saw River Percentage", flag(FFSaw), flag(FRSaw))
	add("River Call Efficiency", Ratio, func(h *Hand) (float64, float64) {
		if h.Call[River] == 0 || h.BetR <= 0 {
			return 0, 0
		}
		won := 0.0
		if h.F(FWonHand) {
			won = h.Won + h.BetTotal
		}
		return won, h.BetR
	}, false)
	add("Avg All-In Equity PF", Ratio, func(h *Hand) (float64, float64) {
		if h.EnumAllin != 'P' {
			return 0, 0
		}
		return h.Equity, 1
	}, false)

	/* -------------------------------------------------------- preflop */
	px("Raise First In", flag(FPOpenOpp), func(h *Hand) bool { return h.First() == 'R' })
	px("3Bet Preflop", flag(FP3betOpp), flag(FP3bet))
	px("4Bet Preflop", flag(FP4betOpp), flag(FP4bet))
	p("4Bet+ Preflop After Raising", and(flag(FP4betOpp), flag(FPFirstRaise)), flag(FP4bet))
	p("5Bet+ Preflop", and(flag(FP4betDefOpp), flag(FP3bet)), func(h *Hand) bool { return h.Enum4bet == 'R' })
	px("Preflop Squeeze", flag(FPSqueezeOpp), flag(FPSqueeze))
	p("Fold to PF 3Bet After Raise", and(flag(FP3betDefOpp), flag(FPFirstRaise)), func(h *Hand) bool { return h.Enum3bet == 'F' })
	p("Call PF 3Bet After Raise", and(flag(FP3betDefOpp), flag(FPFirstRaise)), func(h *Hand) bool { return h.Enum3bet == 'C' })
	p("Fold to PF 3Bet After Steal", and(flag(FP3betDefOpp), flag(FStealAtt)), func(h *Hand) bool { return h.Enum3bet == 'F' })
	p("Call PF 3Bet", flag(FP3betDefOpp), func(h *Hand) bool { return h.Enum3bet == 'C' })
	p("Fold to PF 4Bet After 3Bet", and(flag(FP4betDefOpp), flag(FP3bet)), func(h *Hand) bool { return h.Enum4bet == 'F' })
	p("Call PF 4Bet", flag(FP4betDefOpp), func(h *Hand) bool { return h.Enum4bet == 'C' })
	p("Fold to PF 5Bet+", func(h *Hand) bool {
		a := h.Aggr[Pre]
		return h.F(FP4bet) && len(a) >= 5 && a[3] == h.posChar()
	}, flag(FPFold))
	p("Fold to PF Squeeze", flag(FPSqueezeDefOpp), func(h *Hand) bool { return h.EnumSqueeze == 'F' })
	p("Call PF Squeeze", flag(FPSqueezeDefOpp), func(h *Hand) bool { return h.EnumSqueeze == 'C' })
	p("Raise PF Squeeze", flag(FPSqueezeDefOpp), func(h *Hand) bool { return h.EnumSqueeze == 'R' })
	p("Call PF 2Bet", face2bet, is(first, 'C'))
	p("Cold Call 2Bet PF", and(face2bet, not(blind)), and(is(first, 'C'), flag(FPCCall)))
	p("Cold Call 3Bet+ PF", func(h *Hand) bool {
		return h.Face3bet && !h.F(FP3betDefOpp) && !h.F(FPSqueezeDefOpp) && !h.F(FPLimp) &&
			!h.F(FPFirstRaise) && h.PCall <= 1 && !blind(h)
	}, is(first, 'C'))
	// Facing limpers and no raise yet: limp, raise (iso), fold, or check (BB).
	limpersDen := func(h *Hand) bool {
		return h.PFaceLimpers > 0 && !h.Face2bet &&
			(h.F(FPLimp) || h.F(FPFirstRaise) || h.First() == 'F' || h.First() == 'X')
	}
	p("Limp With Previous Limpers", and(limpersDen, func(h *Hand) bool { return h.Cat != 1 }), flag(FPLimp))
	p("Raise With Previous Limpers", limpersDen, flag(FPFirstRaise))
	// 3bet vs an iso-raise: someone limped, another player raised over the
	// limp(s), and this player (who hadn't limped) faces that raise.
	p("3Bet vs Iso-Raise", and(face2bet, flag(FP3betOpp), func(h *Hand) bool { return h.IsoRaised() }), flag(FP3bet))
	limpFaced := and(flag(FPLimp), flag(FPFaceRaise))
	second := func(h *Hand) byte {
		if len(h.Act[Pre]) < 2 {
			return 0
		}
		return h.Act[Pre][1]
	}
	p("Preflop Limp Call", limpFaced, is(second, 'C'))
	p("Preflop Limp Fold", limpFaced, is(second, 'F'))
	px("Att To Steal", flag(FStealOpp), flag(FStealAtt))
	px("Att To Steal - SB", and(flag(FStealOpp), func(h *Hand) bool { return h.Cat == 2 }), flag(FStealAtt))
	p("Fold to Steal", flag(FBlindDefOpp), func(h *Hand) bool { return h.F(FSbStealFold) || h.F(FBbStealFold) })
	p("Call Steal", flag(FBlindDefOpp), is(first, 'C'))
	p("3Bet Steal", flag(FBlindDefOpp), flag(FP3bet))
	vsOpen := func(c byte) func(h *Hand) bool { return and(face2bet, noLimpers, openerChar(c)) }
	p("Fold vs BTN Open", vsOpen('0'), is(first, 'F'))
	p("Call vs BTN Open", vsOpen('0'), is(first, 'C'))
	p("Call vs CO Open", vsOpen('1'), is(first, 'C'))
	p("3Bet vs BTN Open", and(vsOpen('0'), flag(FP3betOpp)), flag(FP3bet))
	p("3Bet vs CO Open", and(vsOpen('1'), flag(FP3betOpp)), flag(FP3bet))
	for name, cat := range map[string]int8{"EP": 3, "MP": 4, "CO": 5, "BTN": 6, "SB": 2, "BB": 1} {
		p("3Bet vs "+name+" 2Bet", and(flag(FP3betOpp), face2bet, openerIs(cat)), flag(FP3bet))
	}
	bbVsSb := and(func(h *Hand) bool { return h.Cat == 1 }, vsOpen('9'))
	p("BB vs SB Open - 3Bet", bbVsSb, is(first, 'R'))
	p("BB vs SB Open - Call", bbVsSb, is(first, 'C'))
	add("Preflop AF", Ratio, func(h *Hand) (float64, float64) { return float64(h.PRaise), float64(h.PCall) }, false)
	add("Preflop AFq", Pct, func(h *Hand) (float64, float64) {
		r, c, f := float64(h.PRaise), float64(h.PCall), b2f(h.F(FPFold))
		return r, r + c + f
	}, false)

	// Custom stats exported with the HUD (PT4 formulas, translated as is).
	px("Fold to PF 4Bet After 3Bet BTN vs CO", func(h *Hand) bool {
		return h.F(FP3bet) && len(h.Aggr[Pre]) >= 4 && h.Aggr[Pre][:4] == "8101" &&
			len(h.Actors[Pre]) > 0 && h.Actors[Pre][0] == '1' && h.Position == 0 && h.F(FP4betDefOpp)
	}, func(h *Hand) bool { return h.Enum4bet == 'F' })
	px("CBet Flop Multiway", and(flag(FFCbetOpp), func(h *Hand) bool { return h.PlayersF > 2 }), flag(FFCbet))
	px("Delayed Turn CBet", and(flag(FTOpenOpp), flag(FFCbetOpp), func(h *Hand) bool { return h.Act[Flop] == "X" }), flag(FTBet))
	px("Bet Turn After Raise F CBet", and(flag(FTOpenOpp), func(h *Hand) bool {
		return h.EnumCbet[Flop] == 'R' && !h.F(FF3betOpp)
	}), flag(FTBet))

	/* ------------------------------------------------------- postflop */
	for _, s := range streets {
		st, L, W := s.st, s.letter, s.word
		f := func(fl Flag) Flag { return sf(st, fl) }
		resp := func(h *Hand) byte { return h.Resp(st) }
		after := func(h *Hand) byte { return h.AfterBet(st) }

		px("Bet "+W, flag(f(FFOpenOpp)), flag(f(FFBet)))
		if st == Flop {
			p("Bet Flop (limp pot)", and(flag(FFOpenOpp), limpPot), flag(FFBet))
		}
		px("Check Raise "+W, func(h *Hand) bool { return h.CheckRaiseOpp(st) }, flag(f(FFCheckRaise)))
		px("3Bet "+W, flag(f(FF3betOpp)), flag(f(FF3bet)))
		p("2Bet "+W, func(h *Hand) bool { return h.FacingFirstBet(st) }, func(h *Hand) bool {
			return h.F(f(FFFirstRaise)) && h.Raise[st] > 0
		})
		for _, a := range []struct {
			verb string
			c    byte
		}{{"Fold to", 'F'}, {"Call", 'C'}} {
			c := a.c
			p(a.verb+" "+L+" Bet", func(h *Hand) bool { return h.FacingFirstBet(st) }, is(resp, c))
			p(a.verb+" "+L+" 2Bet", and(flag(f(FFBet)), flag(f(FFFaceRaise))), is(after, c))
			p(a.verb+" "+L+" 3Bet", flag(f(FF3betDefOpp)), func(h *Hand) bool { return h.Enum3betS[st] == c })
			p(a.verb+" "+L+" Check Raise", func(h *Hand) bool { return h.FacedCheckRaise(st) }, is(after, c))
		}
		p("3Bet "+L+" Check Raise", func(h *Hand) bool { return h.FacedCheckRaise(st) }, is(after, 'R'))

		for _, pv := range potVariants {
			cond, sfx := pv.cond, pv.suffix
			name := func(base string) string { return base + sfx }
			if sfx == "" {
				px("CBet "+W, flag(f(FFCbetOpp)), flag(f(FFCbet)))
				px("Donk "+W, flag(f(FFDonkOpp)), flag(f(FFDonk)))
			} else {
				p("CBet "+W+sfx, and(flag(f(FFCbetOpp)), cond), flag(f(FFCbet)))
				p("Donk "+W+sfx, and(flag(f(FFDonkOpp)), cond), flag(f(FFDonk)))
			}
			for _, a := range []struct {
				verb string
				c    byte
			}{{"Fold to", 'F'}, {"Call", 'C'}, {"Raise", 'R'}} {
				c := a.c
				p(name(a.verb+" "+L+" CBet"), and(flag(f(FFCbetDefOpp)), cond), func(h *Hand) bool { return h.EnumCbet[st] == c })
				p(name(a.verb+" "+L+" Donk Bet"), and(flag(f(FFDonkDefOpp)), cond), func(h *Hand) bool { return h.EnumDonk[st] == c })
				p(name(a.verb+" "+L+" Float Bet"), and(flag(f(FFFloatDefOpp)), cond), func(h *Hand) bool { return h.EnumFloat[st] == c })
				if st >= Turn {
					p(name(a.verb+" "+L+" Probe Bet"), and(func(h *Hand) bool { return h.ProbeDefOpp(st) }, cond), is(resp, c))
				}
			}
			p(name("Fold to Raise After "+L+" CBet"), and(flag(f(FFCbet)), flag(f(FFFaceRaise)), cond), is(after, 'F'))
			p(name("Float "+W), and(flag(f(FFFloatOpp)), cond), flag(f(FFFloat)))
			p(name("Fold to Raise After "+L+" Float Bet"), and(flag(f(FFFloat)), flag(f(FFFaceRaise)), cond), is(after, 'F'))
			if st == Flop {
				p(name("Fold to Raise After F Donk"), and(flag(FFDonk), flag(FFFaceRaise), cond), is(after, 'F'))
			}
			if st >= Turn {
				probe := func(h *Hand) bool { return h.ProbeOpp(st) }
				p(name("Probe "+W), and(probe, cond), flag(f(FFBet)))
				p(name("Fold to Raise After "+L+" Probe"), and(probe, flag(f(FFBet)), flag(f(FFFaceRaise)), cond), is(after, 'F'))
			}
		}
		// Aggression factor / frequency.
		add(W+" AF", Ratio, func(h *Hand) (float64, float64) {
			if !h.F(f(FFSaw)) {
				return 0, 0
			}
			return b2f(h.F(f(FFBet))) + float64(h.Raise[st]), float64(h.Call[st])
		}, false)
		add(W+" AFq", Pct, func(h *Hand) (float64, float64) {
			if !h.F(f(FFSaw)) {
				return 0, 0
			}
			agg := b2f(h.F(f(FFBet))) + float64(h.Raise[st])
			return agg, agg + float64(h.Call[st]) + b2f(h.F(f(FFFold)))
		}, false)
	}
	m["Float Flop in 3Bet Pot"] = &Stat{Name: "Float Flop in 3Bet Pot", Kind: Pct, Acc: m["Float Flop in 3Bet+ Pot"].Acc}
	m["Probe Total"] = &Stat{Name: "Probe Total", Kind: Pct, Acc: func(h *Hand) (float64, float64) {
		n1, d1 := m["Probe Turn"].Acc(h)
		n2, d2 := m["Probe River"].Acc(h)
		return n1 + n2, d1 + d2
	}}
	return m
}
