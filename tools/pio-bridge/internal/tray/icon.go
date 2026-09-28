// Package tray is the Windows system-tray face of the bridge.
package tray

import (
	"bytes"
	"encoding/binary"
	"image/color"
	"math"

	"aderugy.fr/pio-bridge/internal/bridge"
)

// Colors per state: green = usable, amber = working, red = error, grey = no solver.
func StateColor(s bridge.State) color.RGBA {
	switch s {
	case bridge.StateReady, bridge.StateIdle:
		return color.RGBA{0x1f, 0x9d, 0x55, 0xff}
	case bridge.StateBusy, bridge.StateStarting:
		return color.RGBA{0xe0, 0x9b, 0x0e, 0xff}
	case bridge.StateError:
		return color.RGBA{0xd2, 0x3b, 0x3b, 0xff}
	default:
		return color.RGBA{0x8a, 0x93, 0x9c, 0xff}
	}
}

// Icon draws a 32×32 .ico: a coloured disc with a white spade-like pip, as a
// classic 32-bit BMP icon (BITMAPINFOHEADER + BGRA rows bottom-up + AND mask),
// which every Windows version loads.
func Icon(c color.RGBA) []byte {
	const n = 32
	px := make([]byte, n*n*4) // BGRA, bottom-up
	set := func(x, y int, r, g, b byte, a float64) {
		if a <= 0 {
			return
		}
		i := ((n-1-y)*n + x) * 4
		// "over" compositing onto what is already there (premultiplied not needed for 2 layers)
		oa := float64(px[i+3]) / 255
		na := a + oa*(1-a)
		mix := func(src, dst byte) byte {
			if na == 0 {
				return 0
			}
			return byte((float64(src)*a + float64(dst)*oa*(1-a)) / na)
		}
		px[i+0] = mix(b, px[i+0])
		px[i+1] = mix(g, px[i+1])
		px[i+2] = mix(r, px[i+2])
		px[i+3] = byte(na * 255)
	}
	cover := func(d float64) float64 { return math.Max(0, math.Min(1, 0.5-d)) } // 1px anti-aliasing
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			fx, fy := float64(x)+0.5, float64(y)+0.5
			// disc
			d := math.Hypot(fx-16, fy-16) - 15
			set(x, y, c.R, c.G, c.B, cover(d))
			// white pip: two small circles + a diamond, a spade silhouette
			d1 := math.Hypot(fx-12.5, fy-16.5) - 4.2
			d2 := math.Hypot(fx-19.5, fy-16.5) - 4.2
			d3 := (math.Abs(fx-16) + math.Abs(fy-12.5)) - 6.8
			d4 := math.Max(math.Abs(fx-16)-1.3, math.Abs(fy-22.5)-3.5) // stem
			dm := math.Min(math.Min(d1, d2), math.Min(d3, d4))
			set(x, y, 255, 255, 255, cover(dm)*0.95)
		}
	}
	andRow := n / 8 // 1 bpp, 4 bytes per row, already a multiple of 4
	mask := make([]byte, andRow*n)

	var img bytes.Buffer
	hdr := struct {
		Size                   uint32
		Width, Height          int32
		Planes, BitCount       uint16
		Compression, SizeImage uint32
		XPels, YPels           int32
		ClrUsed, ClrImportant  uint32
	}{40, n, n * 2, 1, 32, 0, uint32(len(px) + len(mask)), 0, 0, 0, 0}
	_ = binary.Write(&img, binary.LittleEndian, hdr)
	img.Write(px)
	img.Write(mask)

	var out bytes.Buffer
	_ = binary.Write(&out, binary.LittleEndian, [3]uint16{0, 1, 1}) // ICONDIR
	_ = binary.Write(&out, binary.LittleEndian, struct {
		W, H, Colors, Reserved byte
		Planes, BitCount       uint16
		Bytes, Offset          uint32
	}{n, n, 0, 0, 1, 32, uint32(img.Len()), 22})
	out.Write(img.Bytes())
	return out.Bytes()
}
