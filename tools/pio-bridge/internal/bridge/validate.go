package bridge

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// A node id is only ever made of these tokens, so nothing else can reach the
// solver's command line (no spaces, quotes or newlines).
var nodeIDRe = regexp.MustCompile(`^r(:(\d+|c|f|b\d+|[2-9TJQKA][cdhs]))*$`)

func ValidNodeID(id string) bool { return len(id) <= 400 && nodeIDRe.MatchString(id) }

func ValidPlayer(p string) bool { return p == "OOP" || p == "IP" }

var (
	ErrOutsideRoot = errors.New("path is outside the solves folder")
	ErrNotCfr      = errors.New("only .cfr files can be opened")
	ErrNotFound    = errors.New("file not found")
)

// within reports whether p is root or below it (after cleaning).
func within(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// resolveIn turns a path relative to root (forward or back slashes) or an
// absolute one into a clean absolute path, refusing anything outside root,
// symlinks included.
func resolveIn(root, p string) (string, error) {
	root, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return "", err
	}
	if p == "" {
		return root, nil
	}
	if strings.ContainsAny(p, "\"\r\n\x00") {
		return "", ErrOutsideRoot
	}
	var abs string
	if filepath.IsAbs(p) {
		abs = filepath.Clean(p)
	} else {
		abs = filepath.Join(root, filepath.FromSlash(strings.ReplaceAll(p, `\`, "/")))
	}
	if !within(root, abs) {
		return "", ErrOutsideRoot
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", ErrNotFound
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", ErrNotFound
	}
	if !within(realRoot, real) {
		return "", ErrOutsideRoot
	}
	return abs, nil
}

// ResolveCfr resolves a .cfr file under root.
func ResolveCfr(root, p string) (string, error) {
	if !strings.EqualFold(filepath.Ext(p), ".cfr") {
		return "", ErrNotCfr
	}
	abs, err := resolveIn(root, p)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(abs)
	if err != nil || !st.Mode().IsRegular() {
		return "", ErrNotFound
	}
	return abs, nil
}

// ResolveDir resolves a folder under root ("" = root).
func ResolveDir(root, p string) (string, error) {
	abs, err := resolveIn(root, p)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return "", ErrNotFound
	}
	return abs, nil
}

// RelPath is abs relative to root with forward slashes (what the site sees).
func RelPath(root, abs string) string {
	rel, err := filepath.Rel(root, abs)
	if err != nil {
		return filepath.ToSlash(abs)
	}
	if rel == "." {
		return ""
	}
	return filepath.ToSlash(rel)
}
