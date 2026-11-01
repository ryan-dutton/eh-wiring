"""Read the circuit-number labels off the MF0015-54 SVG export.

Each label is a white box followed by single-stroke digit paths (0.36 wide). Digits are
matched against tools/digit_templates.json by the set of their vertices on a coarse grid.

Usage: python3 -I decode_labels.py <svg> <out labels.json>
"""
import json, os, re, sys

SVG, OUT = sys.argv[1:3]
H, K, OY = 841.88977, 0.02999, 0.10355
templates = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'digit_templates.json')))
DIGITS = {json.dumps(t['sig']): t['digit'] for t in templates}

paths = []
for m in re.finditer(r'<path ([^>]*)/>', open(SVG).read()):
    a = dict(re.findall(r'([\w:-]+)="([^"]*)"', m.group(1)))
    if 'stroke' not in a or 'transform' not in a:
        continue
    subs, cur = [], None
    toks = re.findall(r'[MLCZ]|[-\d.]+', a['d'])
    i, cmd = 0, None
    while i < len(toks):
        if toks[i] in 'MLCZ':
            cmd = toks[i]
            i += 1
            if cmd == 'Z' and cur:
                cur.append(cur[0])
            continue
        n = 6 if cmd == 'C' else 2
        x, y = float(toks[i + n - 2]), float(toks[i + n - 1])
        pt = (K * x, H - (K * y + OY))
        if cmd == 'M':
            cur = [pt]
            subs.append(cur)
            cmd = 'L'
        else:
            cur.append(pt)
        i += n
    sw = 0 if 'vector-effect' in a else float(a.get('stroke-width', 0)) * K
    paths.append(dict(stroke=a['stroke'], sw=sw, subs=subs))

def bbox(p):
    xs = [x for s in p['subs'] for x, y in s]
    ys = [y for s in p['subs'] for x, y in s]
    return min(xs), min(ys), max(xs), max(ys)

labels = []
for ri, rect in enumerate(paths):
    if rect['stroke'] != '#ffffff':
        continue
    x0, y0, x1, y1 = bbox(rect)
    vert = (y1 - y0) > (x1 - x0)
    strokes = []
    for p in paths[ri + 1:ri + 40]:
        if p['stroke'] != '#000000' or abs(p['sw'] - 0.36) > 0.01:
            break
        b = bbox(p)
        if not (x0 - 1 <= b[0] and b[2] <= x1 + 1 and y0 - 1 <= b[1] and b[3] <= y1 + 1):
            break
        # text-local coords: u along the text, v up
        strokes.append([[((y1 - y) if vert else (x - x0), (x1 - x) if vert else (y1 - y)) for x, y in s] for s in p['subs']])
    chars = []
    for st in sorted(strokes, key=lambda st: min(u for s in st for u, v in s)):
        umin = min(u for s in st for u, v in s)
        umax = max(u for s in st for u, v in s)
        if chars and umin < chars[-1]['umax'] - 0.3:
            chars[-1]['st'].append(st)
            chars[-1]['umax'] = max(umax, chars[-1]['umax'])
        else:
            chars.append(dict(umin=umin, umax=umax, st=[st]))
    text = ''
    for c in chars:
        pts = [(u - c['umin'], v) for st in c['st'] for s in st for u, v in s]
        vmin = min(v for u, v in pts)
        sig = sorted(set((round(u / 0.7), round((v - vmin) / 0.7)) for u, v in pts))
        text += DIGITS.get(json.dumps([list(t) for t in sig]), '?')
    labels.append(dict(text=text, box=[round(v, 2) for v in (x0, y0, x1, y1)], vert=vert))

json.dump(labels, open(OUT, 'w'))
bad = [l for l in labels if '?' in l['text']]
print('%d labels decoded, %d with unknown glyphs' % (len(labels), len(bad)))
