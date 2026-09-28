package tray

import (
	"encoding/binary"
	"testing"

	"aderugy.fr/pio-bridge/internal/bridge"
)

func TestIcon(t *testing.T) {
	b := Icon(StateColor(bridge.StateReady))
	if len(b) != 6+16+40+32*32*4+32*4 {
		t.Fatalf("size %d", len(b))
	}
	if binary.LittleEndian.Uint16(b[2:]) != 1 || binary.LittleEndian.Uint16(b[4:]) != 1 {
		t.Fatal("ICONDIR")
	}
	if binary.LittleEndian.Uint32(b[22:]) != 40 || int32(binary.LittleEndian.Uint32(b[30:])) != 64 {
		t.Fatal("BITMAPINFOHEADER")
	}
	// centre pixel is part of the white pip, a corner is transparent
	px := b[62:]
	at := func(x, y int) []byte { i := ((31-y)*32 + x) * 4; return px[i : i+4] }
	if c := at(16, 14); c[0] < 200 || c[3] < 200 {
		t.Errorf("centre %v", c)
	}
	if c := at(0, 0); c[3] != 0 {
		t.Errorf("corner %v", c)
	}
}
