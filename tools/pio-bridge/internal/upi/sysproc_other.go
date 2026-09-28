//go:build !windows

package upi

import "os/exec"

func hideWindow(cmd *exec.Cmd) {}

func afterStart(cmd *exec.Cmd) {}
