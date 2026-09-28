package upi

import "testing"

func TestParseChildren(t *testing.T) {
	// Verbatim from PioSOLVER 3.3.0 (trailing spaces included).
	lines := []string{"child 0:", "r:0:b45", "IP_DEC", "8h 5d 3d ", "45 0 60 ", "3 children", "flags: PIO_ALG ", "",
		"child 1:", "r:0:c:c", "SPLIT_NODE", "8h 5d 3d ", "0 0 60 ", "49 children", "flags: LOAD_FROM_FILE ", "",
		"child 2:", "r:0:b45:c:2c:b495:c", "SPLIT_NODE", "8h 5d 3d 2c ", "495 495 60 ", "48 children", "flags: UNSOLVED SCHEMATIC_SPLIT ", ""}
	kids := ParseChildren(lines)
	if len(kids) != 3 {
		t.Fatalf("%d children", len(kids))
	}
	k := kids[0]
	if k.ID != "r:0:b45" || k.Player() != "IP" || len(k.Board) != 3 || k.Pot[0] != "45" || k.LastToken() != "b45" {
		t.Errorf("%+v", k)
	}
	if f := kids[2].Flags; len(f) != 2 || f[0] != "UNSOLVED" {
		t.Errorf("flags %v", f)
	}
	if kids[1].Children != "49 children" {
		t.Errorf("children %q", kids[1].Children)
	}
}
