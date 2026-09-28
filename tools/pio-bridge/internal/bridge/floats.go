package bridge

import (
	"math"
	"strconv"
	"strings"
)

// Floats is a vector from the solver (1326 values in hand order, usually).
// JSON: NaN / ±Inf become null (Pio uses nan for combos out of range), other
// values keep 7 significant digits.
type Floats []float64

func (f Floats) MarshalJSON() ([]byte, error) {
	buf := make([]byte, 0, len(f)*9+2)
	buf = append(buf, '[')
	for i, v := range f {
		if i > 0 {
			buf = append(buf, ',')
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			buf = append(buf, "null"...)
			continue
		}
		buf = strconv.AppendFloat(buf, v, 'g', 7, 64)
	}
	return append(buf, ']'), nil
}

// ParseFloats reads a space-separated solver line. Anything unparseable
// ("nan", "-nan(ind)", "inf") becomes NaN.
func ParseFloats(line string) Floats {
	fs := strings.Fields(line)
	out := make(Floats, len(fs))
	for i, s := range fs {
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			v = math.NaN()
		}
		out[i] = v
	}
	return out
}
