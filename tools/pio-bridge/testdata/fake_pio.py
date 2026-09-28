#!/usr/bin/env python3
"""Minimal fake PioSOLVER for testing the UPI client and the probe on Linux.
It follows the documented formats; the real ones are checked by the probe."""
import os, sys, random
CRASH_ON = os.environ.get("FAKE_CRASH_ON", "")            # command that always kills the fake
CRASH_FAST_ON = os.environ.get("FAKE_CRASH_FAST_ON", "")  # command that kills it on a fast-loaded tree
loaded = ""
BOARD = ["8h", "5d", "3d"]
DECK = [r + s for s in "cdhs" for r in "23456789TJQKA" if r + s not in BOARD]
END = None
def out(*lines):
    for l in lines: sys.stdout.write(l + "\n")
def done():
    if END: out(END)
    sys.stdout.flush()
def floats(n=1326): return " ".join(f"{random.random():.4f}" for _ in range(n))

def analyse(nid):
    toks = nid.split(":")
    if nid == "r": return dict(type="ROOT", board=BOARD, kids=["r:0"])
    board = list(BOARD); street_actions = []; street = 0
    for t in toks[2:]:
        if t[0] in "23456789TJQKA" and len(t) == 2:
            board.append(t); street_actions = []; street += 1
        else:
            street_actions.append(t)
    if street_actions and street_actions[-1] == "f":
        return dict(type="END_NODE", board=board, kids=[])
    closed = len(street_actions) >= 2 and street_actions[-1] == "c"
    if closed:
        if street == 2: return dict(type="END_NODE", board=board, kids=[])
        cards = [c for c in DECK if c not in board]
        return dict(type="SPLIT_NODE", board=board, kids=[nid + ":" + c for c in cards])
    player = "OOP_DEC" if len(street_actions) % 2 == 0 else "IP_DEC"
    facing = street_actions and street_actions[-1].startswith("b")
    nbets = sum(1 for a in street_actions if a.startswith("b"))
    kids = (["f", "c"] if facing else ["c"]) + ([f"b{20 * (nbets + 1)}"] if nbets < 2 else [])
    flags = ["UNSOLVED_SCHEMATIC"] if street == 2 else []
    return dict(type=player, board=board, kids=[nid + ":" + k for k in kids], flags=flags)

def node_block(nid):
    a = analyse(nid)
    return [nid, a["type"], " ".join(a["board"]), "0 0 60", f'{len(a["kids"])} children',
            "flags: " + " ".join(["PIO_CFR"] + a.get("flags", []))]

out("PioSOLVER 3.fake", "registered to someone@example.com"); sys.stdout.flush()
for raw in sys.stdin:
    line = raw.strip()
    if not line: continue
    cmd, *args = line.split(" ", 1); arg = args[0] if args else ""
    if cmd == "exit": break
    if cmd == "load_tree": loaded = arg.rsplit(" ", 1)[-1]
    if cmd == CRASH_ON or (cmd == CRASH_FAST_ON and loaded == "fast"):
        sys.stdout.flush(); os._exit(3)
    if cmd == "set_end_string": out("set_end_string ok!"); END = arg; done(); continue
    if cmd == "show_node": out(*node_block(arg))
    elif cmd == "show_children":
        for i, k in enumerate(analyse(arg)["kids"]):
            out(f"child {i}:", *node_block(k), "")
    elif cmd == "show_strategy":
        a = analyse(arg)
        if not a["type"].endswith("_DEC") or a.get("flags"): out("ERROR: not a solved decision node")
        else: out(*[floats() for _ in a["kids"]])
    elif cmd in ("show_range",): out(floats())
    elif cmd == "calc_ev": out(floats(), floats())
    elif cmd == "calc_eq_node": out(floats(), floats(), "0.5")
    elif cmd == "calc_global_freq": out("0.123")
    elif cmd == "show_hand_order": out(" ".join(f"h{i}" for i in range(1326)))
    elif cmd == "show_all_lines": out(*[f"line {i}" for i in range(50)])
    elif cmd == "show_tree_info": out("#Pot#60", "#EffectiveStacks#975")
    elif cmd == "show_version": out("ERROR: unknown command")
    else: out(f"{cmd} ok!")
    done()
