package pt4

import (
	"sort"
	"strconv"
	"strings"
)

// Filter selects the hands a HUD is computed on. Zero values = no filter.
type Filter struct {
	Limits    []int16 // stakes (cash_limit.id_limit)
	Since     int64   // unix seconds: hands played at or after
	LastHands int     // the most recent N hands (after the other filters)
}

func (f Filter) Key() string {
	l := make([]string, len(f.Limits))
	for i, v := range f.Limits {
		l[i] = strconv.Itoa(int(v))
	}
	sort.Strings(l)
	return strings.Join(l, ",") + "|" + strconv.FormatInt(f.Since, 10) + "|" + strconv.Itoa(f.LastHands)
}

// Positions of the result arrays: 0 all, then the HUD position filters.
const PosCount = 7

// Values: per stat, per position, [numerator, denominator].
type Values map[string]*[PosCount][2]float64

// Select returns the hands matching the filter (hands are sorted oldest first).
func Select(hands []Hand, f Filter) []Hand {
	if len(f.Limits) == 0 && f.Since == 0 {
		if f.LastHands > 0 && len(hands) > f.LastHands {
			return hands[len(hands)-f.LastHands:]
		}
		return hands
	}
	ok := map[int16]bool{}
	for _, l := range f.Limits {
		ok[l] = true
	}
	out := make([]Hand, 0, len(hands))
	for i := range hands {
		h := &hands[i]
		if len(ok) > 0 && !ok[h.Limit] {
			continue
		}
		if f.Since > 0 && h.Date < f.Since {
			continue
		}
		out = append(out, *h)
	}
	if f.LastHands > 0 && len(out) > f.LastHands {
		out = out[len(out)-f.LastHands:]
	}
	return out
}

// Compute evaluates every stat of the catalogue on the hands.
func Compute(cat []*Stat, hands []Hand) Values {
	acc := make([][PosCount][2]float64, len(cat))
	for i := range hands {
		h := &hands[i]
		pos := int(h.Cat)
		if pos <= 0 || pos >= PosCount {
			pos = 0
		}
		for j, s := range cat {
			n, d := s.Acc(h)
			if n == 0 && d == 0 {
				continue
			}
			acc[j][0][0] += n
			acc[j][0][1] += d
			if pos > 0 {
				acc[j][pos][0] += n
				acc[j][pos][1] += d
			}
		}
	}
	out := Values{}
	for j, s := range cat {
		if acc[j][0][1] == 0 && acc[j][0][0] == 0 {
			continue
		}
		v := acc[j]
		for p := range v {
			v[p][0] = round4(v[p][0])
			v[p][1] = round4(v[p][1])
		}
		out[s.Name] = &v
	}
	return out
}

func round4(x float64) float64 {
	if x == float64(int64(x)) {
		return x
	}
	return float64(int64(x*10000+copysign(0.5, x))) / 10000
}

func copysign(v, sign float64) float64 {
	if sign < 0 {
		return -v
	}
	return v
}

// SortedCatalogue is the catalogue as a slice, by name.
func SortedCatalogue() []*Stat {
	m := Catalogue()
	out := make([]*Stat, 0, len(m))
	for _, s := range m {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
