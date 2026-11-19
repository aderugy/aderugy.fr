"""Converts a PokerTracker 4 HUD export (.pt4hud) into the layout JSON used by /poker/hud.

Usage: python scripts/poker/pt4hud_layout.py "Cash - HUD.pt4hud" src/lib/hud/layout.json

The .pt4hud file is a tagged binary stream (big endian):
  header = u32 length + UTF-16 "PT4.Hud.Layout.Export" + u32 version
  s = u32 length + UTF-16 text · i = u8 size + signed int · l = 4-byte ARGB colour
  b = 1 byte bool · d = 80-bit extended float · < … > = list
"""
import json
import struct
import sys


def parse(d: bytes):
    n = struct.unpack(">I", d[0:4])[0]
    header = d[4:4 + 2 * n].decode("utf-16-be")
    p = 4 + 2 * n + 4
    stack = [[]]
    while p < len(d):
        t = chr(d[p])
        p += 1
        if t == "s":
            n = struct.unpack(">I", d[p:p + 4])[0]
            p += 4
            stack[-1].append(d[p:p + 2 * n].decode("utf-16-be"))
            p += 2 * n
        elif t == "i":
            size = d[p]
            p += 1
            stack[-1].append(int.from_bytes(d[p:p + size], "big", signed=True))
            p += size
        elif t == "l":
            stack[-1].append(d[p:p + 4].hex())  # aarrggbb
            p += 4
        elif t == "b":
            stack[-1].append(bool(d[p]))
            p += 1
        elif t == "d":
            b = d[p:p + 10]
            p += 10
            se = int.from_bytes(b[:2], "big")
            m = int.from_bytes(b[2:], "big")
            e = se & 0x7FFF
            v = 0.0 if (e == 0 and m == 0) else m / 2**63 * 2.0 ** (e - 16383)
            stack[-1].append(round(-v if se & 0x8000 else v, 4))
        elif t == "<":
            stack.append([])
        elif t == ">":
            x = stack.pop()
            stack[-1].append(x)
        else:
            raise ValueError(f"unknown tag {t!r} at byte {p - 1}")
    if len(stack) != 1:
        raise ValueError("unbalanced lists")
    return header, stack[0]


def rgb(argb: str) -> str | None:
    return None if argb[:2] == "00" else "#" + argb[2:]


# Element kinds: 1 stat · 2 "New Line" / "Horizontal Line" · 4 text label.
# A group is a grid: "New Line" starts a row, each element spans e[14] columns.
# e[7] is the wxWidgets alignment (0x100 centre, 0x200 right, else left).
# e[13] is the position filter: 0 all · 1 BB · 2 SB · 3 EP · 4 MP · 5 CO · 6 BTN.
def cell(e, item):
    if e[14] and e[14] != 1:
        item["span"] = e[14]
    if e[7] & 0x100:
        item["align"] = "center"
    elif e[7] & 0x200:
        item["align"] = "right"
    return item


def element(e):
    name, kind = e[0], e[1]
    if kind == 2:
        return {"t": "hr"} if name == "Horizontal Line" else {"t": "br"}
    if kind == 4:
        return cell(e, {"t": "text", "text": name})
    if name == "Note Editor":
        return None
    item = cell(e, {"t": "stat", "stat": name, "pos": e[13]})
    if e[5].strip():
        item["prefix"] = e[5]
    if e[8]:
        item["popup"] = e[8]
    if e[10]:
        item["minSample"] = e[10]
    fg = rgb(e[2])
    if fg and fg != "#ffffff":
        item["color"] = fg
    ranges = e[22]
    if ranges and ranges[0]:
        item["ranges"] = [[lo, hi, rgb(c)] for lo, hi, c in ranges[1:]]
    return item


def main(src: str, dst: str):
    header, data = parse(open(src, "rb").read())
    if header != "PT4.Hud.Layout.Export":
        raise SystemExit(f"not a PT4 HUD export: {header}")
    layout = data[1][0]
    groups = []
    for g in layout[2:]:
        items = [x for x in (element(e) for e in g[15][1:]) if x]
        group = {"name": g[0], "main": g[1] == 1 and not groups, "items": items}
        # The group's popup menu: "TTL:<title>\tPOP:<group>" lines.
        menu = []
        for line in g[5].splitlines():
            parts = dict(p.split(":", 1) for p in line.split("\t") if ":" in p)
            if parts.get("POP"):
                menu.append({"title": parts.get("TTL") or parts["POP"], "group": parts["POP"]})
        if menu:
            group["menu"] = menu
        groups.append(group)
    custom = [s for s in data[5] if isinstance(s, str)]
    out = {"name": layout[0], "groups": groups, "customStats": custom}
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")
    stats = sorted({i["stat"] for g in groups for i in g["items"] if i["t"] == "stat"})
    print(f"{len(groups)} groups, {len(stats)} distinct stats → {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
