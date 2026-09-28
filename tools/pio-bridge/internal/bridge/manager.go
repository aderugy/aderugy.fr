package bridge

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"aderugy.fr/pio-bridge/internal/upi"
)

// State of the bridge as shown by the tray icon and the status page.
type State string

const (
	StateIdle       State = "idle"        // up; the solver starts on the next request
	StateStarting   State = "starting"    // launching the solver / loading a tree
	StateReady      State = "ready"       // solver running, waiting
	StateBusy       State = "busy"        // answering a request
	StateError      State = "error"       // last start or request failed
	StatePioMissing State = "pio_missing" // the configured exe does not exist
)

type Status struct {
	State      State     `json:"state"`
	Message    string    `json:"message,omitempty"`
	File       string    `json:"file,omitempty"` // loaded save, relative to the solves folder
	Board      []string  `json:"board,omitempty"`
	PioVersion string    `json:"pioVersion,omitempty"`
	Updated    time.Time `json:"updated"`
}

var ErrPioMissing = errors.New("PioSOLVER executable not found")

// SolverError is an "ERROR …" answer from the solver (the process is fine).
type SolverError struct{ Cmd, Msg string }

func (e *SolverError) Error() string { return fmt.Sprintf("solver refused `%s`: %s", e.Cmd, e.Msg) }

// Manager owns the solver process. Every use goes through Do, which
// serialises requests (UPI is one command at a time), starts the solver on
// demand, loads the requested save, and restarts the solver once if it dies.
type Manager struct {
	mu        sync.Mutex // held for the whole of each Do
	c         *upi.Client
	file      string // absolute path of the loaded save
	fileMod   time.Time
	board     []string
	handOrder []string
	lastUse   time.Time
	// allNodes: load_all_nodes ran on the loaded save (whole-tree reads are
	// safe and every turn is in memory).
	allNodes bool

	cfgMu sync.RWMutex
	cfg   Config

	stMu      sync.Mutex
	st        Status
	listeners []func(Status)

	Logf       func(format string, a ...any)
	CmdTimeout time.Duration
	quit       chan struct{}
}

func NewManager(cfg Config) *Manager {
	m := &Manager{
		cfg:        cfg,
		CmdTimeout: 2 * time.Minute,
		Logf:       func(string, ...any) {},
		quit:       make(chan struct{}),
		st:         Status{State: StateIdle, Updated: time.Now()},
	}
	if _, err := os.Stat(cfg.PioPath); err != nil {
		m.st = Status{State: StatePioMissing, Message: "Not found: " + cfg.PioPath, Updated: time.Now()}
	}
	go m.idleLoop()
	return m
}

func (m *Manager) Config() Config {
	m.cfgMu.RLock()
	defer m.cfgMu.RUnlock()
	return m.cfg
}

// SetConfig applies a new config; the solver is stopped if its path changed.
func (m *Manager) SetConfig(cfg Config) {
	m.cfgMu.Lock()
	old := m.cfg
	m.cfg = cfg
	m.cfgMu.Unlock()
	if old.PioPath != cfg.PioPath || old.SolvesDir != cfg.SolvesDir {
		m.Stop("settings changed")
	}
}

func (m *Manager) OnStatus(f func(Status)) {
	m.stMu.Lock()
	m.listeners = append(m.listeners, f)
	m.stMu.Unlock()
}

func (m *Manager) Status() Status {
	m.stMu.Lock()
	defer m.stMu.Unlock()
	return m.st
}

func (m *Manager) setStatus(state State, msg string) {
	m.stMu.Lock()
	m.st.State = state
	m.st.Message = msg
	m.st.Updated = time.Now()
	st := m.st
	ls := append([]func(Status){}, m.listeners...)
	m.stMu.Unlock()
	for _, f := range ls {
		f(st)
	}
}

func (m *Manager) setLoaded(file string, board []string, version string) {
	m.stMu.Lock()
	m.st.File, m.st.Board = file, board
	if version != "" {
		m.st.PioVersion = version
	}
	m.stMu.Unlock()
}

// Close stops the solver and the idle loop.
func (m *Manager) Close() {
	select {
	case <-m.quit:
	default:
		close(m.quit)
	}
	m.Stop("bridge closing")
}

// Stop ends the solver process; the next request starts a new one.
func (m *Manager) Stop(reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.c != nil {
		m.Logf("stopping solver (%s)", reason)
	}
	m.killLocked()
	if _, err := os.Stat(m.Config().PioPath); err != nil {
		m.setStatus(StatePioMissing, "Not found: "+m.Config().PioPath)
		return
	}
	m.setStatus(StateIdle, "")
}

func (m *Manager) killLocked() {
	if m.c != nil {
		m.c.Close()
	}
	m.c = nil
	m.file = ""
	m.board = nil
	m.setLoaded("", nil, "")
}

func (m *Manager) idleLoop() {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-m.quit:
			return
		case <-t.C:
			idle := m.Config().IdleMinutes
			if idle <= 0 {
				continue
			}
			m.mu.Lock()
			stale := m.c != nil && time.Since(m.lastUse) > time.Duration(idle)*time.Minute
			m.mu.Unlock()
			if stale {
				m.Stop(fmt.Sprintf("idle for %d min", idle))
			}
		}
	}
}

// Do runs f with the solver ready and, if file is not empty, that save loaded.
// If the solver dies or hangs, it is restarted and f is retried once.
func (m *Manager) Do(file string, f func(s *Session) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastUse = time.Now()
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		err = m.ensureLocked(file)
		if err == nil {
			m.setStatus(StateBusy, "")
			err = f(&Session{m: m})
		}
		if errors.Is(err, upi.ErrExited) || errors.Is(err, upi.ErrTimeout) {
			status := ""
			if m.c != nil {
				status = m.c.ExitStatus()
			}
			m.Logf("solver lost (%v %s), attempt %d", err, status, attempt+1)
			m.killLocked()
			continue
		}
		break
	}
	m.lastUse = time.Now()
	switch {
	case errors.Is(err, ErrPioMissing):
		m.setStatus(StatePioMissing, "Not found: "+m.Config().PioPath)
	case errors.Is(err, upi.ErrExited), errors.Is(err, upi.ErrTimeout):
		m.setStatus(StateError, "Solver stopped responding: "+err.Error())
	case m.c != nil:
		m.setStatus(StateReady, "")
	case err != nil:
		m.setStatus(StateError, err.Error())
	}
	return err
}

func (m *Manager) ensureLocked(file string) error {
	if m.c != nil {
		select {
		case <-m.c.Exited():
			m.Logf("solver had exited: %s", m.c.ExitStatus())
			m.killLocked()
		default:
		}
	}
	cfg := m.Config()
	if m.c == nil {
		if _, err := os.Stat(cfg.PioPath); err != nil {
			return ErrPioMissing
		}
		m.setStatus(StateStarting, "Starting PioSOLVER")
		t0 := time.Now()
		c, err := upi.Start(cfg.PioPath, 60*time.Second)
		if err != nil {
			if c != nil {
				c.Close()
			}
			return fmt.Errorf("starting the solver: %w", err)
		}
		c.Noise = func(l string) { m.Logf("[solver] %s", l) }
		c.Stderr = func(l string) { m.Logf("[solver stderr] %s", l) }
		m.c = c
		version := ""
		if len(c.Banner) > 0 {
			version = c.Banner[0]
		}
		m.setLoaded("", nil, version)
		m.Logf("solver started in %s: %s", time.Since(t0).Round(time.Millisecond), version)
		s := &Session{m: m}
		for _, cmd := range []string{"set_threads 0", "is_ready"} {
			if _, err := s.Raw(cmd); err != nil {
				return err
			}
		}
	}
	if file == "" {
		return nil
	}
	st, err := os.Stat(file)
	if err != nil {
		return ErrNotFound
	}
	if m.file == file && st.ModTime().Equal(m.fileMod) {
		return nil
	}
	m.setStatus(StateStarting, "Loading "+RelPath(cfg.SolvesDir, file))
	s := &Session{m: m}
	t0 := time.Now()
	if m.file != "" {
		if _, err := s.Raw("free_tree"); err != nil && !isSolverErr(err) {
			return err
		}
	}
	m.file, m.board, m.allNodes = "", nil, false
	if _, err := s.Raw(`load_tree "` + file + `" fast`); err != nil {
		return err
	}
	root, err := s.Node("r")
	if err != nil {
		return err
	}
	m.file, m.fileMod, m.board = file, st.ModTime(), root.Board
	m.setLoaded(RelPath(cfg.SolvesDir, file), root.Board, "")
	m.Logf("loaded %s in %s", file, time.Since(t0).Round(time.Millisecond))
	return nil
}

func isSolverErr(err error) bool {
	var se *SolverError
	return errors.As(err, &se)
}

// ---------------------------------------------------------------- session

// Session is the solver during one Do call.
type Session struct{ m *Manager }

// Raw runs one command; an "ERROR" answer becomes a *SolverError.
func (s *Session) Raw(cmd string) ([]string, error) {
	r, err := s.m.c.Command(cmd, s.m.CmdTimeout, nil)
	if err != nil {
		return nil, err
	}
	if r.Error != "" {
		return nil, &SolverError{Cmd: cmd, Msg: strings.Join(r.Lines, " ")}
	}
	return r.Lines, nil
}

// Pot is chips put in by each player during the whole hand, plus the pot at
// the start of the tree (so the pot now = OOP + IP + Start).
type Pot struct {
	OOP   float64 `json:"oop"`
	IP    float64 `json:"ip"`
	Start float64 `json:"start"`
}

type NodeInfo struct {
	ID       string   `json:"id"`
	Type     string   `json:"type"` // ROOT · OOP_DEC · IP_DEC · SPLIT_NODE · END_NODE
	Player   string   `json:"player,omitempty"`
	Last     string   `json:"last,omitempty"` // last token of the id: c, f, b45, 7h, 0
	Board    []string `json:"board"`
	Pot      Pot      `json:"pot"`
	Children int      `json:"children"`
	Flags    []string `json:"flags"`
	// Solved is false for nodes the save does not hold (rivers of a no_rivers
	// save): the solver would re-solve them on the fly.
	Solved bool `json:"solved"`
}

func nodeInfo(n upi.Node) NodeInfo {
	ni := NodeInfo{ID: n.ID, Type: n.Type, Player: n.Player(), Board: n.Board, Flags: n.Flags}
	if ni.Board == nil {
		ni.Board = []string{}
	}
	if ni.Flags == nil {
		ni.Flags = []string{}
	}
	if n.ID != "r" {
		ni.Last = n.LastToken()
	}
	if len(n.Pot) >= 3 {
		ni.Pot.OOP, _ = strconv.ParseFloat(n.Pot[0], 64)
		ni.Pot.IP, _ = strconv.ParseFloat(n.Pot[1], 64)
		ni.Pot.Start, _ = strconv.ParseFloat(n.Pot[2], 64)
	}
	if f := strings.Fields(n.Children); len(f) > 0 {
		ni.Children, _ = strconv.Atoi(f[0])
	}
	has := func(flag string) bool {
		for _, f := range n.Flags {
			if f == flag {
				return true
			}
		}
		return false
	}
	switch {
	case ni.Player != "":
		ni.Solved = has("PIO_ALG")
	default:
		ni.Solved = !has("UNSOLVED")
	}
	return ni
}

func (s *Session) Node(id string) (NodeInfo, error) {
	lines, err := s.Raw("show_node " + id)
	if err != nil {
		return NodeInfo{}, err
	}
	n, ok := upi.ParseNode(lines)
	if !ok {
		return NodeInfo{}, fmt.Errorf("unexpected show_node output: %q", lines)
	}
	return nodeInfo(n), nil
}

func (s *Session) Children(id string) ([]NodeInfo, error) {
	lines, err := s.Raw("show_children " + id)
	if err != nil {
		return nil, err
	}
	var out []NodeInfo
	for _, n := range upi.ParseChildren(lines) {
		out = append(out, nodeInfo(n))
	}
	if out == nil {
		out = []NodeInfo{}
	}
	return out, nil
}

func (s *Session) vectors(cmd string, want int) ([]Floats, error) {
	lines, err := s.Raw(cmd)
	if err != nil {
		return nil, err
	}
	var out []Floats
	for _, l := range lines {
		if strings.TrimSpace(l) == "" {
			continue
		}
		out = append(out, ParseFloats(l))
	}
	if want > 0 && len(out) < want {
		return nil, fmt.Errorf("`%s`: expected %d lines, got %d", cmd, want, len(out))
	}
	return out, nil
}

// Strategy returns one row of 1326 frequencies per child, in children order.
func (s *Session) Strategy(id string, children int) ([]Floats, error) {
	rows, err := s.vectors("show_strategy "+id, children)
	if err != nil {
		return nil, err
	}
	for i, r := range rows {
		if len(r) != 1326 {
			return nil, fmt.Errorf("show_strategy %s: row %d has %d values", id, i, len(r))
		}
	}
	return rows, nil
}

func (s *Session) Range(player, id string) (Floats, error) {
	v, err := s.vectors("show_range "+player+" "+id, 1)
	if err != nil {
		return nil, err
	}
	return v[0], nil
}

// EV per combo in chips, and the weights to average it over the range.
func (s *Session) EV(player, id string) (ev, weights Floats, err error) {
	v, err := s.vectors("calc_ev "+player+" "+id, 2)
	if err != nil {
		return nil, nil, err
	}
	return v[0], v[1], nil
}

// Equity per combo (0–1), matchup weights, and the solver's range total.
func (s *Session) Equity(player, id string) (eq, weights Floats, total float64, err error) {
	v, err := s.vectors("calc_eq_node "+player+" "+id, 3)
	if err != nil {
		return nil, nil, 0, err
	}
	if len(v[2]) > 0 {
		total = v[2][0]
	}
	return v[0], v[1], total, nil
}

func (s *Session) GlobalFreq(id string) (float64, error) {
	v, err := s.vectors("calc_global_freq "+id, 1)
	if err != nil || len(v[0]) == 0 {
		return 0, err
	}
	return v[0][0], nil
}

func (s *Session) HandOrder() ([]string, error) {
	if s.m.handOrder != nil {
		return s.m.handOrder, nil
	}
	lines, err := s.Raw("show_hand_order")
	if err != nil {
		return nil, err
	}
	var hands []string
	for _, l := range lines {
		hands = append(hands, strings.Fields(l)...)
	}
	if len(hands) != 1326 {
		return nil, fmt.Errorf("show_hand_order: %d hands", len(hands))
	}
	s.m.handOrder = hands
	return hands, nil
}

// TreeInfo returns the "#Key#Value" lines of the save as a map.
func (s *Session) TreeInfo() (map[string]string, error) {
	lines, err := s.Raw("show_tree_info")
	if err != nil {
		return nil, err
	}
	info := map[string]string{}
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if !strings.HasPrefix(l, "#") {
			continue
		}
		parts := strings.SplitN(l[1:], "#", 2)
		if len(parts) == 2 {
			info[parts[0]] = parts[1]
		}
	}
	return info, nil
}

func (s *Session) EffectiveStack() (float64, error) {
	lines, err := s.Raw("show_effective_stack")
	if err != nil || len(lines) == 0 {
		return 0, err
	}
	return strconv.ParseFloat(strings.TrimSpace(lines[0]), 64)
}

// LoadAll reads every node of the loaded save into memory once (1.5 s on a
// flop save), so a pass over all the runouts doesn't read each turn from disk.
func (s *Session) LoadAll() error {
	if s.m.allNodes {
		return nil
	}
	if _, err := s.Raw("load_all_nodes"); err != nil {
		return err
	}
	s.m.allNodes = true
	return nil
}

// Board is the loaded save's real board (from the root node; the tree info's
// #Board# line can be wrong).
func (s *Session) Board() []string { return s.m.board }
