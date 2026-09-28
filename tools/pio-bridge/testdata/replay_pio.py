#!/usr/bin/env python3
"""Replays the real PioSOLVER answers recorded by PioProbe (probe-8h5d3d.txt).
Commands that were recorded get their exact recorded output; a few setup
commands are acknowledged; anything else gets an ERROR line, like the solver.

REPLAY_CRASH_ONCE=<command> + REPLAY_MARKER=<file>: exit on that command the
first time (to test the bridge's restart).

REPLAY_SYNTH=1: answer unrecorded node commands with plausible data built from
the recorded ones (nodes known from a recorded show_children, children copied
from a recorded sibling, uniform strategies, r:0's equity / EV / ranges), so a
UI can walk the whole tree. Only for interface tests: the numbers are fake."""
import os, sys

here = os.path.dirname(os.path.abspath(__file__))
paths = os.environ.get("REPLAY_TRANSCRIPTS", os.pathsep.join(
    os.path.join(here, f) for f in ("probe-8h5d3d.txt", "probe-8h5d3d-run1.txt"))).split(os.pathsep)
banner, answers, cur, section = [], {}, None, None
lines = []
for path in paths:
    lines += open(path, encoding="utf-8", errors="replace").readlines()
for raw in lines:
    line = raw.rstrip("\n")
    if line.startswith("=== banner"):
        section = "banner" if not banner else "skip"; continue
    if section == "skip":
        if line.startswith("started in") or line.startswith("=== ") or not line.strip():
            section = None
        continue
    if section == "banner":
        if line.startswith("started in") or line.startswith("=== ") or not line.strip():
            section = None
        else:
            banner.append(line)
        continue
    if line.startswith(">>> "):
        cur = line[4:].strip()
        if cur in answers: cur = None  # keep the first recording
        else: answers[cur] = []
        continue
    if line.startswith("<<< ") or line.startswith("### ") or line.startswith("[noise]") or line.startswith("[stderr]"):
        if line.startswith("<<< "): cur = None
        continue
    if cur is not None:
        answers[cur].append(line)

crash_cmd = os.environ.get("REPLAY_CRASH_ONCE", "")
marker = os.environ.get("REPLAY_MARKER", "")
end = None
def out(*lines):
    for l in lines: sys.stdout.write(l + "\n")
def done():
    if end: out(end)
    sys.stdout.flush()

synth = os.environ.get("REPLAY_SYNTH") == "1"

# Node blocks seen in recorded show_children answers, by id.
blocks = {}
for cmd, lines in answers.items():
    if not cmd.startswith("show_children "): continue
    cur_block = None
    for l in lines:
        if l.startswith("child "):
            cur_block = []; continue
        if cur_block is None: continue
        if l.strip() == "":
            if cur_block: blocks[cur_block[0].strip()] = cur_block
            cur_block = None; continue
        cur_block.append(l)
    if cur_block: blocks[cur_block[0].strip()] = cur_block

def is_card(tok): return len(tok) == 2 and tok[0] in "23456789TJQKA" and tok[1] in "cdhs"

def node_block(nid):
    rec = answers.get("show_node " + nid)
    if rec: return [l for l in rec if l.strip()]
    return blocks.get(nid)

def children_lines(nid):
    rec = answers.get("show_children " + nid)
    if rec is not None: return rec
    # Copy the children of a recorded node with the same shape: a sibling
    # (same parent, e.g. another turn card) or the same line on another card.
    toks = nid.split(":")
    for cmd, lines in answers.items():
        if not cmd.startswith("show_children "): continue
        other = cmd.split(" ", 1)[1].split(":")
        if len(other) != len(toks): continue
        if all(a == b or (is_card(a) and is_card(b)) for a, b in zip(toks, other)):
            src = ":".join(other); me_board = None
            blk = node_block(nid)
            if blk: me_board = blk[2]
            out = []
            for l in lines:
                if l.startswith(src): l = nid + l[len(src):]
                out.append(l)
            if me_board:
                src_blk = node_block(src)
                if src_blk: out = [me_board if l == src_blk[2] else l for l in out]
            return out
    return None

def synth_answer(cmd):
    name, _, rest = cmd.partition(" ")
    args = rest.split()
    if name == "show_node" and args:
        blk = node_block(args[0])
        return blk + [""] if blk else None
    if name == "show_children" and args:
        return children_lines(args[0])
    if name == "show_strategy" and args:
        kids = [l for l in (children_lines(args[0]) or []) if l.startswith("r:")]
        if not kids: return None
        n = len(kids)
        return [" ".join([f"{1/n:.4f}"] * 1326) for _ in range(n)]
    if name in ("show_range", "calc_eq_node", "calc_ev") and len(args) == 2:
        return answers.get(f"{name} OOP r:0")
    if name == "calc_global_freq":
        return ["0.5"]
    return None

out(*banner); sys.stdout.flush()
for raw in sys.stdin:
    cmd = " ".join(raw.split())
    if not cmd: continue
    name = cmd.split(" ", 1)[0]
    if name == "exit": break
    if crash_cmd and cmd == crash_cmd and marker and not os.path.exists(marker):
        open(marker, "w").close(); sys.stdout.flush(); os._exit(5)
    if name == "set_end_string":
        end = cmd.split(" ", 1)[1]; out("set_end_string ok!"); done(); continue
    if name in ("load_tree", "free_tree", "set_threads", "is_ready"):
        out(name + " ok!"); done(); continue
    if cmd in answers:
        out(*answers[cmd])
    elif synth and (a := synth_answer(cmd)) is not None:
        out(*a)
    else:
        out("ERROR: not in fixture: " + cmd)
    done()
