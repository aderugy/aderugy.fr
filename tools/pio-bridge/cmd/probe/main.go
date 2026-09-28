// PioProbe: phase 0 of the Pio bridge. Starts PioSOLVER, loads one save, walks a
// few representative nodes (flop, a checked-through turn, a bet-called turn, a
// river) and records every command, its raw output and its duration in a
// transcript. The transcript answers the open questions of poker/pio-bridge.md
// and becomes the bridge's test fixture.
//
// Run 1 (2026-09-28) showed that node_count kills the solver on a tree loaded
// with "fast". So: the per-node walk runs first; whole-tree commands run last,
// after load_all_nodes, one at a time; if the solver dies during the walk it is
// restarted with a full load and the walk is retried once.
//
// Usage: PioProbe.exe [-pio path\to\PioSOLVER3-edge.exe] [-cfr path\to\tree.cfr] [-out dir]
package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"aderugy.fr/pio-bridge/internal/upi"
)

const cmdTimeout = 15 * time.Minute

var errCrashed = errors.New("solver crashed")

type probe struct {
	pio, cfr, out, name string
	c                   *upi.Client
	tr                  *os.File
	stats               []string
	fails               int
}

var emailRe = regexp.MustCompile(`[^\s@]+@[^\s@]+`)

func redact(s string) string {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(s)), "registered to") {
		return "registered to <redacted>"
	}
	return emailRe.ReplaceAllString(s, "<redacted>")
}

func (p *probe) logf(format string, a ...any) {
	s := fmt.Sprintf(format, a...)
	fmt.Println(s)
	fmt.Fprintln(p.tr, s)
}

func (p *probe) run(cmd string) upi.Response { return p.runTo(cmd, true) }

// runTo sends one command and records it; record=false keeps only the first
// lines in the transcript (long listings). Panics with errCrashed if the
// solver dies, so the caller's step can be recovered.
func (p *probe) runTo(cmd string, record bool) upi.Response {
	fmt.Printf("> %s ... ", short(cmd))
	fmt.Fprintf(p.tr, "\n>>> %s\n", cmd)
	r, err := p.c.Command(cmd, cmdTimeout, func(w time.Duration) {
		fmt.Printf("\n   still working (%s) ... ", w.Round(time.Second))
	})
	for i, l := range r.Lines {
		if !record && i >= 20 {
			fmt.Fprintf(p.tr, "… (%d more lines in the separate file)\n", len(r.Lines)-20)
			break
		}
		fmt.Fprintln(p.tr, redact(l))
	}
	status := "ok"
	switch {
	case err != nil:
		status = "FAILED: " + err.Error()
		p.fails++
	case r.Error != "":
		status = "solver error"
	}
	fmt.Fprintf(p.tr, "<<< %d ms · %d lines · %s\n", r.Duration.Milliseconds(), len(r.Lines), status)
	fmt.Printf("%s (%d ms)\n", status, r.Duration.Milliseconds())
	p.stats = append(p.stats, fmt.Sprintf("%8d ms  %-14s %s", r.Duration.Milliseconds(), status, short(cmd)))
	if errors.Is(err, upi.ErrExited) {
		select {
		case <-p.c.Exited():
		case <-time.After(5 * time.Second):
		}
		p.logf("!!! solver died on `%s`: %s", cmd, p.c.ExitStatus())
		panic(errCrashed)
	}
	return r
}

// step runs f and reports whether the solver crashed during it.
func (p *probe) step(title string, f func()) (crashed bool) {
	p.logf("\n=== %s", title)
	defer func() {
		if r := recover(); r != nil {
			if r == errCrashed {
				crashed = true
				return
			}
			panic(r)
		}
	}()
	f()
	return false
}

func short(s string) string {
	if len(s) > 90 {
		return s[:87] + "..."
	}
	return s
}

// start launches the solver and loads the tree with the given mode.
func (p *probe) start(loadMode string) error {
	t0 := time.Now()
	c, err := upi.Start(p.pio, 90*time.Second)
	if c != nil {
		p.c = c
		c.Noise = func(l string) { fmt.Fprintln(p.tr, "[noise] "+redact(l)) }
		c.Stderr = func(l string) { fmt.Fprintln(p.tr, "[stderr] "+redact(l)) }
		fmt.Fprintln(p.tr, "\n=== banner")
		for _, l := range c.Banner {
			fmt.Fprintln(p.tr, redact(l))
		}
	}
	if err != nil {
		p.logf("START FAILED after %s: %v", time.Since(t0).Round(time.Millisecond), err)
		return err
	}
	p.logf("started in %s", time.Since(t0).Round(time.Millisecond))
	crashed := p.step("setup + load_tree "+loadMode, func() {
		p.run("set_threads 0")
		p.run("is_ready")
		p.run("load_tree " + p.quoted() + " " + loadMode)
		p.run("is_tree_present")
		p.run("show_memory")
	})
	if crashed {
		return errCrashed
	}
	return nil
}

func (p *probe) quoted() string { return `"` + p.cfr + `"` }

func (p *probe) node(id string) (upi.Node, bool) {
	r := p.run("show_node " + id)
	if r.Error != "" {
		return upi.Node{}, false
	}
	return upi.ParseNode(r.Lines)
}

func (p *probe) children(id string) []upi.Node {
	r := p.run("show_children " + id)
	if r.Error != "" {
		return nil
	}
	kids := upi.ParseChildren(r.Lines)
	fmt.Fprintf(p.tr, "### parsed %d children of %s\n", len(kids), id)
	return kids
}

// decision probes everything the bridge will need at one decision node.
func (p *probe) decision(id string, withChildEV bool) []upi.Node {
	n, ok := p.node(id)
	kids := p.children(id)
	player := n.Player()
	players := []string{player}
	if !ok || player == "" {
		players = []string{"OOP", "IP"}
	}
	p.run("show_strategy " + id)
	for _, pl := range []string{"OOP", "IP"} {
		p.run("show_range " + pl + " " + id)
	}
	for _, pl := range players {
		p.run("calc_eq_node " + pl + " " + id)
		p.run("calc_ev " + pl + " " + id)
		if withChildEV {
			for _, k := range kids {
				p.run("calc_ev " + pl + " " + k.ID)
			}
		}
	}
	p.run("calc_global_freq " + id)
	return kids
}

func isSplit(n upi.Node) bool { return strings.Contains(strings.ToUpper(n.Type), "SPLIT") }
func isEnd(n upi.Node) bool   { return strings.Contains(strings.ToUpper(n.Type), "END") }

// follow walks down from id, choosing a child with pick at each decision,
// until it reaches a card (split) node. Returns that node's id.
func (p *probe) follow(id string, pick func(kids []upi.Node) (upi.Node, bool)) (string, bool) {
	for depth := 0; depth < 12; depth++ {
		n, ok := p.node(id)
		if !ok || isEnd(n) {
			return "", false
		}
		if isSplit(n) {
			return id, true
		}
		k, ok := pick(p.children(id))
		if !ok {
			return "", false
		}
		id = k.ID
	}
	return "", false
}

func byLast(kids []upi.Node, want func(tok string) bool) (upi.Node, bool) {
	for _, k := range kids {
		if want(k.LastToken()) {
			return k, true
		}
	}
	return upi.Node{}, false
}

func checkOrCall(kids []upi.Node) (upi.Node, bool) {
	return byLast(kids, func(t string) bool { return t == "c" })
}

func isBet(t string) bool { return strings.HasPrefix(t, "b") }

// walk is the per-node part: everything the bridge does on a single import.
func (p *probe) walk() {
	p.run("show_hand_order")
	p.run("show_category_names")

	// Root and the first flop decision (with EV of each action).
	p.node("r")
	p.children("r")
	flopKids := p.decision("r:0", true)

	// Line A: check / check → turn → turn decision → check / check → river.
	if split, ok := p.follow("r:0", checkOrCall); ok {
		p.logf("### line A turn split: %s", split)
		turnCards := p.children(split)
		p.logf("### line A: %d turn cards (49 = no turn isomorphism)", len(turnCards))
		if len(turnCards) > 0 {
			turn := turnCards[0].ID
			tkids := p.decision(turn, true)
			// A bet on the turn and what can follow it (raise / all-in amounts).
			if b, ok := byLast(tkids, isBet); ok {
				p.node(b.ID)
				p.children(b.ID)
			}
			if rsplit, ok := p.follow(turn, checkOrCall); ok {
				p.logf("### line A river split: %s", rsplit)
				rcards := p.children(rsplit)
				p.logf("### line A: %d river cards", len(rcards))
				if len(rcards) > 0 {
					river := rcards[0].ID
					p.node(river)
					p.children(river)
					p.run("show_strategy " + river)
					p.run("calc_eq_node OOP " + river)
					p.run("calc_ev OOP " + river)
				}
			}
		}
	}

	// Line B: first flop bet, called → turn: bet amounts in node ids and pots.
	if b, ok := byLast(flopKids, isBet); ok {
		bkids := p.children(b.ID)
		for _, k := range bkids {
			p.node(k.ID) // fold / call / raise(s): raise amounts, all-in
		}
		if call, ok := checkOrCall(bkids); ok {
			if split, ok := p.follow(call.ID, checkOrCall); ok {
				p.logf("### line B turn split: %s", split)
				cards := p.children(split)
				if len(cards) > 0 {
					turn := cards[len(cards)-1].ID
					tkids := p.decision(turn, false)
					if tb, ok := byLast(tkids, isBet); ok {
						p.node(tb.ID)
						p.children(tb.ID)
					}
				}
			}
		}
	}
}

func (p *probe) finish(reason string) {
	p.logf("\n==== summary (%s) ====", reason)
	for _, s := range p.stats {
		fmt.Fprintln(p.tr, s)
	}
	p.logf("%d commands, %d failed", len(p.stats), p.fails)
	if p.c != nil {
		p.c.Close()
	}
	p.tr.Close()
	fmt.Printf("\nTranscript: %s\nPress Enter to close.", p.tr.Name())
	bufio.NewReader(os.Stdin).ReadString('\n')
	os.Exit(0)
}

func main() {
	exeDir := "."
	if e, err := os.Executable(); err == nil {
		exeDir = filepath.Dir(e)
	}
	p := &probe{}
	flag.StringVar(&p.pio, "pio", `D:\Programs\PioSOLVER\PioSOLVER3-edge.exe`, "PioSOLVER executable")
	flag.StringVar(&p.cfr, "cfr", `D:\Poker\Solvers\BB vs BTN\Second souffle\8h5d3d.cfr`, "save to probe")
	flag.StringVar(&p.out, "out", exeDir, "folder for the transcript")
	flag.Parse()

	p.name = fmt.Sprintf("probe-%s-%s.txt", strings.TrimSuffix(filepath.Base(p.cfr), ".cfr"), time.Now().Format("20060102-150405"))
	tr, err := os.Create(filepath.Join(p.out, p.name))
	if err != nil {
		fmt.Println("cannot create transcript:", err)
		bufio.NewReader(os.Stdin).ReadString('\n')
		return
	}
	p.tr = tr
	fmt.Fprintf(tr, "# PioProbe transcript (v2)\n# date: %s\n# pio: %s\n# cfr: %s\n", time.Now().Format(time.RFC3339), p.pio, p.cfr)

	fmt.Println("Starting", p.pio)
	if err := p.start("fast"); err != nil {
		p.finish("start failed")
	}
	p.step("versions + save", func() {
		p.run("show_version")
		p.run("show_build_version")
		p.run("show_save_version " + p.quoted())
	})

	// Per-node walk on the fast-loaded tree; on a crash, retry once on a full load.
	loadMode := "fast"
	if p.step("walk (tree loaded "+loadMode+")", p.walk) {
		p.logf("restarting the solver with a full load")
		loadMode = "full"
		if err := p.start(loadMode); err != nil {
			p.finish("restart failed")
		}
		if p.step("walk (tree loaded full)", p.walk) {
			p.finish("crashed during the walk on a full load too")
		}
	}

	// Whole-tree commands, last, each on its own (run 1: node_count crashed).
	if loadMode == "fast" && p.step("load_all_nodes", func() {
		p.run("load_all_nodes")
		p.run("show_memory")
	}) {
		p.finish("crashed on load_all_nodes")
	}
	if p.step("show_all_lines", func() {
		r := p.runTo("show_all_lines", false)
		if len(r.Lines) > 0 {
			f := filepath.Join(p.out, strings.TrimSuffix(p.name, ".txt")+"-all-lines.txt")
			_ = os.WriteFile(f, []byte(strings.Join(r.Lines, "\n")), 0o644)
			p.logf("### show_all_lines: %d lines → %s", len(r.Lines), f)
		}
	}) {
		p.finish("crashed on show_all_lines")
	}
	if p.step("node_count", func() { p.run("node_count") }) {
		p.finish("crashed on node_count (again)")
	}
	p.finish("done")
}
