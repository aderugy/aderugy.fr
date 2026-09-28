// Package upi talks to PioSOLVER over UPI: its line-based text protocol on
// stdin/stdout. One command at a time; every response ends with a line equal
// to the end string (set to "END" at startup).
package upi

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const EndString = "END"

var (
	ErrTimeout = errors.New("upi: timeout waiting for the solver")
	ErrExited  = errors.New("upi: solver process exited")
)

// Response is what the solver printed for one command, without the end line.
type Response struct {
	Command  string
	Lines    []string
	Duration time.Duration
	// Error holds the first line when it starts with "ERROR".
	Error string
}

// Client owns one PioSOLVER process.
type Client struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	lines  chan string
	mu     sync.Mutex
	Banner []string
	// Noise receives lines the solver prints unprompted (SOLVER:, LOG:, …).
	Noise func(line string)
	// Stderr receives the solver's stderr lines.
	Stderr func(line string)

	exited  chan struct{}
	waitErr error
}

// Exited is closed once the solver process has ended.
func (c *Client) Exited() <-chan struct{} { return c.exited }

// ExitStatus describes how the process ended ("" while it runs). On Windows a
// crash shows as an NTSTATUS code, e.g. 0xC0000005 (access violation).
func (c *Client) ExitStatus() string {
	select {
	case <-c.exited:
	default:
		return ""
	}
	code := c.cmd.ProcessState.ExitCode()
	return fmt.Sprintf("exit code %d (0x%08X), %v", code, uint32(code), c.waitErr)
}

// Start launches the solver with its install folder as working directory (the
// licence and supporting files are resolved from there) and sets the end
// string. startTimeout bounds the wait for the first answer.
func Start(exe string, startTimeout time.Duration) (*Client, error) {
	cmd := exec.Command(exe)
	cmd.Dir = filepath.Dir(exe)
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("upi: starting %s: %w", exe, err)
	}
	afterStart(cmd)
	c := &Client{cmd: cmd, stdin: stdin, lines: make(chan string, 4096), exited: make(chan struct{})}

	var errDone sync.WaitGroup
	errDone.Add(1)
	go func() {
		defer errDone.Done()
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			if c.Stderr != nil {
				c.Stderr(strings.TrimRight(sc.Text(), "\r"))
			}
		}
	}()
	// Wait only after both pipes are drained (os/exec requirement), then
	// signal the end: lines closed = the process is gone.
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 1<<20), 256<<20)
		for sc.Scan() {
			c.lines <- strings.TrimRight(sc.Text(), "\r")
		}
		errDone.Wait()
		c.waitErr = cmd.Wait()
		close(c.exited)
		close(c.lines)
	}()

	// Everything before "set_end_string ok!" is the banner (version, licence).
	if _, err := io.WriteString(stdin, "set_end_string "+EndString+"\n"); err != nil {
		return nil, err
	}
	deadline := time.After(startTimeout)
	for {
		select {
		case l, ok := <-c.lines:
			if !ok {
				return c, fmt.Errorf("%w during startup (banner: %q)", ErrExited, c.Banner)
			}
			t := strings.TrimSpace(l)
			if t == "set_end_string ok!" {
				if err := c.expectEnd(startTimeout); err != nil {
					return c, err
				}
				return c, nil
			}
			if t != "" {
				c.Banner = append(c.Banner, t)
			}
			if strings.HasPrefix(t, "problems with your license") {
				return c, fmt.Errorf("upi: licence problem: %s", t)
			}
		case <-deadline:
			return c, fmt.Errorf("%w during startup (banner: %q)", ErrTimeout, c.Banner)
		}
	}
}

func (c *Client) expectEnd(timeout time.Duration) error {
	select {
	case l, ok := <-c.lines:
		if !ok {
			return ErrExited
		}
		if strings.TrimSpace(l) != EndString {
			return fmt.Errorf("upi: expected %s after set_end_string, got %q", EndString, l)
		}
		return nil
	case <-time.After(timeout):
		return ErrTimeout
	}
}

// Command sends one line and collects the response up to the end string.
// progress, if set, is called every tick while waiting (long computations).
func (c *Client) Command(line string, timeout time.Duration, progress func(waited time.Duration)) (Response, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	r := Response{Command: line}
	t0 := time.Now()
	if _, err := io.WriteString(c.stdin, line+"\n"); err != nil {
		return r, err
	}
	deadline := time.After(timeout)
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	inSolverBlock := false
	for {
		select {
		case l, ok := <-c.lines:
			if !ok {
				r.Duration = time.Since(t0)
				return r, ErrExited
			}
			t := strings.TrimSpace(l)
			// Unprompted solver output: a "SOLVER:" block ends with its own END.
			if inSolverBlock {
				if c.Noise != nil {
					c.Noise(t)
				}
				if t == EndString {
					inSolverBlock = false
				}
				continue
			}
			if t == "SOLVER:" {
				inSolverBlock = true
				if c.Noise != nil {
					c.Noise(t)
				}
				continue
			}
			if isNoise(t) {
				if c.Noise != nil {
					c.Noise(t)
				}
				continue
			}
			if t == EndString {
				r.Duration = time.Since(t0)
				return r, nil
			}
			if len(r.Lines) == 0 && strings.HasPrefix(t, "ERROR") {
				r.Error = t
			}
			r.Lines = append(r.Lines, l)
		case <-tick.C:
			if progress != nil {
				progress(time.Since(t0))
			}
		case <-deadline:
			r.Duration = time.Since(t0)
			return r, ErrTimeout
		}
	}
}

func isNoise(t string) bool {
	for _, p := range []string{"SOLVER:", "ALERT:", "LOG:", "[LOG]", "[IGNORE]"} {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	return false
}

// Close asks the solver to exit, then kills it if it is still there.
func (c *Client) Close() {
	select {
	case <-c.exited:
		return
	default:
	}
	_, _ = io.WriteString(c.stdin, "exit\n")
	select {
	case <-c.exited:
	case <-time.After(3 * time.Second):
		_ = c.cmd.Process.Kill()
		<-c.exited
	}
}

// Node is one show_node block.
type Node struct {
	ID       string
	Type     string
	Board    []string
	Pot      []string
	Children string
	Flags    []string
	Raw      []string
}

// Player returns "OOP" / "IP" for a decision node, "" otherwise.
func (n Node) Player() string {
	switch {
	case strings.HasPrefix(n.Type, "OOP_DEC"):
		return "OOP"
	case strings.HasPrefix(n.Type, "IP_DEC"):
		return "IP"
	}
	return ""
}

// LastToken is the last element of the node id ("c", "b20", "7h", …).
func (n Node) LastToken() string {
	i := strings.LastIndex(n.ID, ":")
	return n.ID[i+1:]
}

// ParseNode reads a show_node block (6 lines; tolerant of extra lines).
func ParseNode(lines []string) (Node, bool) {
	var ls []string
	for _, l := range lines {
		if t := strings.TrimSpace(l); t != "" {
			ls = append(ls, t)
		}
	}
	if len(ls) < 2 || !strings.HasPrefix(ls[0], "r") {
		return Node{Raw: ls}, false
	}
	n := Node{ID: ls[0], Type: ls[1], Raw: ls}
	if len(ls) > 2 {
		n.Board = strings.Fields(ls[2])
	}
	if len(ls) > 3 {
		n.Pot = strings.Fields(ls[3])
	}
	if len(ls) > 4 {
		n.Children = ls[4]
	}
	for _, l := range ls[5:] {
		if strings.HasPrefix(l, "flags") {
			if i := strings.Index(l, ":"); i >= 0 {
				n.Flags = append(n.Flags, strings.Fields(l[i+1:])...)
			}
		}
	}
	return n, true
}

// ParseChildren reads a show_children response: "child i:" headers each
// followed by a show_node block.
func ParseChildren(lines []string) []Node {
	var out []Node
	var cur []string
	flush := func() {
		if len(cur) > 0 {
			if n, ok := ParseNode(cur); ok {
				out = append(out, n)
			}
		}
		cur = nil
	}
	for _, l := range lines {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "child") {
			flush()
			continue
		}
		if t == "" {
			continue
		}
		// A new node id also starts a block (in case headers are missing).
		if strings.HasPrefix(t, "r:") && len(cur) >= 2 {
			flush()
		}
		cur = append(cur, t)
	}
	flush()
	return out
}
