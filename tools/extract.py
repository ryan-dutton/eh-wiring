"""Extract a structured wiring-harness model from the EH Holden SVG export.

Usage: python3 -I extract.py <svg> <labels.json> <out.json>
"""
import re, json, sys, math, collections

SVG, LABELS, OUT = sys.argv[1:4]
H = 841.88977
K = 0.02999
OY = 0.10355

def T(x, y):
    return (K * x, H - (K * y + OY))

WIRE = {
    '#545454': 'BK', '#b8735c': 'DBR', '#003fff': 'DBL', '#00b85c': 'DGN',
    '#989898': 'GY', '#7fdfff': 'LBL', '#7fff7f': 'LGN', '#ff7f00': 'OR',
    '#ff7fdf': 'PK', '#a500dd': 'PU', '#ff0000': 'R', '#dda56e': 'LBR',
    '#fafafa': 'W', '#f4d715': 'Y',
}

src = open(SVG).read()
body = src[src.find('<rect'):]

# ---------------------------------------------------------------- parse paths
paths = []
for m in re.finditer(r'<path ([^>]*)/>', body):
    a = dict(re.findall(r'([\w:-]+)="([^"]*)"', m.group(1)))
    if 'stroke' not in a:
        continue
    toks = re.findall(r'[MLCZ]|[-\d.]+', a['d'])
    cmds = []  # list of (cmd, [pts])
    i = 0
    cmd = None
    while i < len(toks):
        tk = toks[i]
        if tk in 'MLCZ':
            cmd = tk
            i += 1
            if tk == 'Z':
                cmds.append(('Z', []))
            continue
        n = 6 if cmd == 'C' else 2
        nums = [float(v) for v in toks[i:i + n]]
        pts = [T(nums[j], nums[j + 1]) for j in range(0, n, 2)]
        cmds.append((cmd, pts))
        if cmd == 'M':
            cmd = 'L'
        i += n
    vec = 'vector-effect' in a
    sw = 0.0 if vec else float(a.get('stroke-width', 0)) * K
    allpts = [p for c, ps in cmds for p in ps]
    xs = [p[0] for p in allpts]
    ys = [p[1] for p in allpts]
    paths.append(dict(
        stroke=a['stroke'], fill=a.get('fill', 'none'), sw=sw, cmds=cmds,
        bbox=(min(xs), min(ys), max(xs), max(ys)),
        curve=any(c == 'C' for c, _ in cmds),
    ))

labels = json.load(open(LABELS))

# label rects + digit strokes are regenerated from data
skip = set()
for i, p in enumerate(paths):
    if p['stroke'] == '#ffffff':
        skip.add(i)
        j = i + 1
        while j < len(paths) and paths[j]['stroke'] == '#000000' and abs(paths[j]['sw'] - 0.36) < 0.01:
            b = paths[j]['bbox']
            if not (p['bbox'][0] - 1 <= b[0] and b[2] <= p['bbox'][2] + 1 and p['bbox'][1] - 1 <= b[1] and b[3] <= p['bbox'][3] + 1):
                break
            skip.add(j)
            j += 1

# ---------------------------------------------------------------- wire strokes
LEGEND_BOX = (856, 555, 1175, 764)
def is_wire(p):
    if p['stroke'] not in WIRE or p['fill'] != 'none':
        return False
    b = p['bbox']
    if LEGEND_BOX[0] <= b[0] and b[2] <= LEGEND_BOX[2] and LEGEND_BOX[1] <= b[1] and b[3] <= LEGEND_BOX[3]:
        return False
    if p['stroke'] == '#fafafa':
        return abs(p['sw'] - 0.99) < 0.05
    return abs(p['sw'] - 1.41) < 0.05

def is_white_outline(p):
    return p['stroke'] == '#545454' and abs(p['sw'] - 1.71) < 0.05 and p['fill'] == 'none'

segs = []  # (colour, polyline)
for i, p in enumerate(paths):
    if i in skip:
        continue
    if is_white_outline(p):
        skip.add(i)
        continue
    if not is_wire(p):
        continue
    pts = [q for c, ps in p['cmds'] for q in ps]
    if len(p['cmds']) == 3 and not p['curve'] and sum(math.dist(pts[k], pts[k + 1]) for k in range(len(pts) - 1)) < 5:
        continue   # terminal chevron marker -> art
    skip.add(i)
    col = WIRE[p['stroke']]
    cur = None
    for c, ps in p['cmds']:
        if c == 'M':
            cur = [ps[0]]
            segs.append((col, cur))
        elif c == 'L':
            cur.append(ps[0])
        elif c == 'C':
            cur.append(ps[2])   # hop arcs collapse to a straight run
        elif c == 'Z':
            cur.append(cur[0])

def axis(a, b):
    return abs(a[0] - b[0]) < 0.3 or abs(a[1] - b[1]) < 0.3

def line_dist(p, a, b):
    L = math.dist(a, b) or 1
    return abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / L

def clean_route(pts):
    """drop crossover-hop apexes and square off fillet chamfers (the editor redraws both)"""
    pts = list(pts)
    changed = True
    while changed:
        changed = False
        for i in range(1, len(pts) - 1):
            a, b, c = pts[i - 1], pts[i], pts[i + 1]
            if math.dist(a, c) <= 7.5 and axis(a, c) and 1.0 < line_dist(b, a, c) < 4:
                del pts[i]
                changed = True
                break
    pts = simplify(pts)
    changed = True
    while changed:
        changed = False
        for i in range(1, len(pts) - 2):
            a, b, c, d = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
            if math.dist(b, c) < 9 and not axis(b, c) and axis(a, b) and axis(c, d):
                ab_h, cd_h = abs(a[1] - b[1]) < 0.3, abs(c[1] - d[1]) < 0.3
                if ab_h == cd_h:
                    continue
                corner = (c[0], b[1]) if ab_h else (b[0], c[1])
                pts[i:i + 2] = [corner]
                changed = True
                break
    # a fillet running straight into a pin: finish the bend as a square corner
    if len(pts) >= 3:
        a, b, c = pts[-3], pts[-2], pts[-1]
        if math.dist(b, c) < 9 and not axis(b, c) and axis(a, b):
            pts.insert(-1, (c[0], b[1]) if abs(a[1] - b[1]) < 0.3 else (b[0], c[1]))
        a, b, c = pts[2], pts[1], pts[0]
        if math.dist(b, c) < 9 and not axis(b, c) and axis(a, b):
            pts.insert(1, (c[0], b[1]) if abs(a[1] - b[1]) < 0.3 else (b[0], c[1]))
    return simplify(pts)

# ---------------------------------------------------------------- components
# [id, name, type, x0, y0, x1, y1]
COMPS = [
    ('HL_LH', 'Headlamp L.H.', 'lamp', 84, 38, 136, 79),
    ('HL_RH', 'Headlamp R.H.', 'lamp', 146, 38, 197, 79),
    ('GND_HL_LH', 'Ground (L.H. headlamp)', 'ground', 87, 97, 100, 112),
    ('GND_HL_RH', 'Ground (R.H. headlamp)', 'ground', 140, 97, 153, 112),
    ('HL_LH_PLUG', 'L.H. headlamp plug', 'connector', 110, 105, 130, 120),
    ('HL_RH_PLUG', 'R.H. headlamp plug', 'connector', 163, 105, 183, 120),
    ('HL_RELAY', 'Headlight relay (Hella 329316011)', 'relay', 70, 193, 171, 254),
    ('HL_FUSE', 'Headlight fuse 20A', 'fuse', 15, 190, 72, 242),
    ('DIMMER', 'Dimmer switch', 'switch', 38, 244, 93, 290),
    ('HORN_HI', 'Horn - high note (optional)', 'horn', 204, 52, 242, 102),
    ('HORN_LO', 'Horn - low note (optional)', 'horn', 280, 52, 323, 102),
    ('HORN_RELAY', 'Horn relay', 'relay', 200, 120, 268, 180),
    ('HORN_SINGLE', 'Low note single horn', 'horn', 195, 185, 279, 259),
    ('PARK_LH', 'Front parking & turn lamp L.H.', 'lamp', 342, 62, 370, 112),
    ('PARK_RH', 'Front parking & turn lamp R.H.', 'lamp', 375, 62, 401, 112),
    ('PARK_LH_PLUG', 'L.H. parking lamp plug', 'connector', 341, 165, 364, 184),
    ('PARK_RH_PLUG', 'R.H. parking lamp plug', 'connector', 374, 165, 397, 184),
    ('DOOR_RH', 'R.H. door switch', 'switch', 488, 40, 553, 76),
    ('DOOR_LH', 'L.H. door switch', 'switch', 412, 79, 479, 112),
    ('CONN_E', "Body harness connector 'E'", 'connector', 728, 66, 758, 141),
    ('QUAD_LAMP', 'Auto trans quadrant lamp', 'lamp', 712, 140, 793, 168),
    ('STOP_SW', 'Stop light switch', 'switch', 560, 138, 637, 170),
    ('CONN_C', "Turn signal switch connector 'C'", 'connector', 668, 167, 697, 215),
    ('CONN_D', "Turn signal & horn contacts connector 'D'", 'connector', 668, 220, 697, 267),
    ('TS_SW', 'Turn signal switch', 'switch', 712, 169, 792, 223),
    ('DOME', 'Dome lamp', 'lamp', 967, 22, 1043, 62),
    ('CONN_F', "Rear body harness connector 'F'", 'connector', 904, 85, 933, 152),
    ('TAIL_RH', 'Tail & stop lamp R.H.', 'lamp', 1062, 44, 1143, 81),
    ('TURN_RH', 'Rear turn signal / back-up lamp R.H.', 'lamp', 1094, 91, 1143, 117),
    ('TURN_LH', 'Rear turn signal / back-up lamp L.H.', 'lamp', 1094, 119, 1163, 161),
    ('TAIL_LH', 'Tail & stop lamp L.H.', 'lamp', 1060, 171, 1143, 208),
    ('REAR_COMP_PLUG', 'Rear comp. lamp plug', 'connector', 883, 157, 898, 174),
    ('REAR_COMP', 'Rear comp. lamp & switch (sedans only)', 'lamp', 869, 173, 935, 250),
    ('LIC_LAMP', 'Licence plate lamp', 'lamp', 943, 197, 1004, 244),
    ('FUEL_SENDER', 'Fuel gauge tank unit', 'sender', 1007, 181, 1055, 242),
    ('CONTACT_BREAKER', 'Contact breaker', 'ignition', 113, 299, 184, 350),
    ('COIL', 'Ignition coil', 'ignition', 228, 289, 289, 338),
    ('DIST_CAP', 'Distributor cap', 'ignition', 48, 348, 166, 387),
    ('OIL_SW', 'Oil pressure switch', 'sender', 199, 400, 223, 424),
    ('WATER_SW', 'Water temp switch', 'sender', 71, 443, 98, 467),
    ('ENGINE', 'Engine', 'engine', 62, 400, 227, 496),
    ('ALT', 'Alternator & regulator', 'alternator', 79, 491, 126, 540),
    ('STARTER', 'Starter motor & solenoid', 'starter', 157, 479, 239, 564),
    ('BATTERY', 'Battery', 'battery', 51, 553, 128, 597),
    ('IGN_SW', "Ignition / starter switch 'A'", 'switch', 239, 467, 337, 547),
    ('RADIO', 'Radio circuit', 'accessory', 229, 370, 274, 433),
    ('LIGHT_SW', "Light switch 'B'", 'switch', 361, 261, 506, 337),
    ('FUSE_PANEL', "Fuse panel / connector 'G'", 'fuse', 367, 436, 472, 534),
    ('TS_IND_RH', 'Turn signal indicator lamp R.H.', 'lamp', 539, 264, 573, 294),
    ('TS_IND_LH', 'Turn signal indicator lamp L.H.', 'lamp', 539, 294, 573, 317),
    ('FLASHER', 'Flasher', 'relay', 654, 271, 719, 331),
    ('HORN_PADS', 'Horn contact pads', 'switch', 737, 262, 815, 338),
    ('GLOVE_LAMP', 'Glove box lamp (optional)', 'lamp', 509, 427, 531, 457),
    ('GLOVE_SW', 'Glove box switch (optional)', 'switch', 470, 468, 529, 530),
    ('CIG', 'Cigarette lighter', 'accessory', 546, 439, 595, 511),
    ('TELLTALES', 'Tell-tales (oil / temp / gen)', 'gauge', 711, 343, 841, 410),
    ('SPEEDO', 'Speedometer / high beam tell-tale', 'gauge', 713, 459, 826, 576),
    ('FUEL_GAUGE', 'Fuel gauge', 'gauge', 676, 594, 799, 665),
    ('WIPER_SW', 'Two speed wiper switch', 'switch', 693, 683, 836, 763),
    ('HB_LAMP', 'Handbrake warning lamp (optional)', 'lamp', 621, 555, 653, 579),
    ('HB_SW', 'Handbrake switch (optional)', 'switch', 544, 603, 579, 635),
    ('NSS', 'Neutral safety & back-up switch', 'switch', 343, 574, 411, 629),
    ('BACKUP_SW', 'Back-up lamp switch (manual trans only)', 'switch', 449, 607, 534, 685),
    ('HEATER', 'Heater', 'motor', 295, 641, 379, 704),
    ('WASHER_PUMP', 'Electric W/shield washer (optional)', 'motor', 539, 639, 623, 705),
    ('WIPER_MOTOR', 'Wiper motor (2 speed)', 'motor', 51, 685, 173, 767),
    ('FOOT_WASHER', 'Foot operated W/shield washer (optional)', 'switch', 173, 665, 274, 703),
    ('WIPER_PLUG', 'Wiper SW1 inline connector', 'connector', 235, 727, 252, 741),
]
# art-only reference panels
PANELS = [
    ('FACE_A', "Ignition switch connector 'A' (face view)", 860, 290, 975, 380),
    ('FACE_B', "Light switch connector 'B' (face view)", 996, 260, 1057, 378),
    ('FACE_C', "Turn signal switch connector 'C' (face view)", 1090, 260, 1140, 314),
    ('FACE_D', "Turn signal switch & horn contacts connector 'D' (face view)", 1083, 328, 1147, 382),
    ('FACE_E', "Body harness connector 'E' (face view)", 881, 384, 958, 478),
    ('FACE_F', "Rear body harness connector 'F' (face view)", 971, 413, 1056, 463),
    ('FACE_G', "Fuse panel connector 'G' (face view)", 1070, 418, 1165, 466),
    ('NOTES', 'Notes', 898, 510, 1162, 552),
    ('LEGEND', 'Wire colour legend', 856, 555, 1175, 764),
    ('TITLE', 'Title block', 282, 760, 1180, 831),
]

comps = []
for cid, name, typ, x0, y0, x1, y1 in COMPS:
    comps.append(dict(id=cid, name=name, type=typ, box=[x0, y0, x1, y1], pins=[], art=[]))
for cid, name, x0, y0, x1, y1 in PANELS:
    comps.append(dict(id=cid, name=name, type='panel', box=[x0, y0, x1, y1], pins=[], art=[]))

def area(c):
    b = c['box']
    return (b[2] - b[0]) * (b[3] - b[1])

def contains(box, b, tol=0.6):
    return box[0] - tol <= b[0] and b[2] <= box[2] + tol and box[1] - tol <= b[1] and b[3] <= box[3] + tol

def comp_at(x, y, pinnable=True):
    best = None
    for c in comps:
        if pinnable and c['type'] == 'panel':
            continue
        b = c['box']
        if b[0] <= x <= b[2] and b[1] <= y <= b[3]:
            if best is None or area(c) < area(best):
                best = c
    return best

# ---------------------------------------------------------------- graph
TOL = 0.9
nodes = []        # [x, y, colour]
adj = collections.defaultdict(set)
edges = {}        # (a,b) sorted -> dict(label=None)

def node_at(x, y, col):
    for i, (nx, ny, nc) in enumerate(nodes):
        if nc == col and abs(nx - x) < TOL and abs(ny - y) < TOL:
            return i
    nodes.append([x, y, col])
    return len(nodes) - 1

def add_edge(a, b, **kw):
    if a == b:
        return
    k = (min(a, b), max(a, b))
    adj[a].add(b)
    adj[b].add(a)
    e = edges.setdefault(k, {})
    e.update(kw)

def deg(n):
    return len(adj[n])

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return math.hypot(px - ax, py - ay), 0
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t

path_ends = collections.Counter()
for col, pl in segs:
    prev = None
    for x, y in pl:
        n = node_at(x, y, col)
        if prev is not None:
            add_edge(prev, n)
        prev = n
    path_ends[node_at(*pl[0], col)] += 1
    path_ends[node_at(*pl[-1], col)] += 1

# T-junctions (no dot) away from components: an end landing mid-edge
for n in range(len(nodes)):
    if deg(n) != 1 or comp_at(nodes[n][0], nodes[n][1]):
        continue
    x, y, col = nodes[n]
    for (a, b) in list(edges):
        if n in (a, b) or nodes[a][2] != col:
            continue
        d, t = seg_dist(x, y, nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1])
        if d < 0.8 and 0.02 < t < 0.98:
            e = edges.pop((a, b))
            adj[a].discard(b)
            adj[b].discard(a)
            add_edge(a, n, **e)
            add_edge(n, b, **e)
            break


# junction dots: filled circles in a wire colour mark splices
dots = []
for i, p in enumerate(paths):
    if i in skip or p['fill'] not in WIRE or not p['curve']:
        continue
    b = p['bbox']
    w, h = b[2] - b[0], b[3] - b[1]
    if 1.2 < w < 14 and abs(w - h) < 0.6:
        dots.append(((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, w / 2, WIRE[p['fill']], i))

def split_edge(a, b, x, y, col):
    e = edges.pop((min(a, b), max(a, b)))
    adj[a].discard(b)
    adj[b].discard(a)
    nodes.append([x, y, col])
    n = len(nodes) - 1
    add_edge(a, n, **e)
    add_edge(n, b, **e)
    return n

for cx, cy, r, col, pi in dots:
    hub = None
    for n in range(len(nodes)):
        if nodes[n][2] == col and math.hypot(nodes[n][0] - cx, nodes[n][1] - cy) < 0.6:
            hub = n
    if hub is None:
        for (a, b) in list(edges):
            if nodes[a][2] != col:
                continue
            d, t = seg_dist(cx, cy, nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1])
            if d < 0.6 and 0 < t < 1:
                ax, ay, bx, by = nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1]
                hub = split_edge(a, b, ax + t * (bx - ax), ay + t * (by - ay), col)
                break
    if hub is None:
        continue
    skip.add(pi)
    for n in range(len(nodes)):
        if n != hub and deg(n) == 1 and nodes[n][2] == col and math.hypot(nodes[n][0] - cx, nodes[n][1] - cy) < r + 1.5:
            add_edge(n, hub)
    for (a, b) in list(edges):
        if nodes[a][2] != col or hub in (a, b):
            continue
        d, t = seg_dist(cx, cy, nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1])
        if d < r and 0.01 < t < 0.99:
            ax, ay, bx, by = nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1]
            n = split_edge(a, b, ax + t * (bx - ax), ay + t * (by - ay), col)
            add_edge(n, hub)

# stray ends just short of a splice hub
for n in range(len(nodes)):
    if deg(n) != 1 or comp_at(nodes[n][0], nodes[n][1]):
        continue
    best = None
    for m in range(len(nodes)):
        if m != n and nodes[m][2] == nodes[n][2] and deg(m) >= 3:
            d = math.hypot(nodes[m][0] - nodes[n][0], nodes[m][1] - nodes[n][1])
            if d < 5 and (best is None or d < best[0]):
                best = (d, m)
    if best:
        add_edge(n, best[1])

def direction(n):
    """unit vector pointing from the neighbour into end node n"""
    (m,) = adj[n]
    dx, dy = nodes[n][0] - nodes[m][0], nodes[n][1] - nodes[m][1]
    L = math.hypot(dx, dy) or 1
    return dx / L, dy / L

# circuit labels: masked onto continuous wires; find the edge under each label
unplaced = []
label_links = []
for lab in labels:
    x0, y0, x1, y1 = lab['box']
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    best = None
    for (a, b), e in edges.items():
        ax, ay, bx, by = nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1]
        if lab['vert'] and abs(ax - bx) > 0.5:
            continue
        if not lab['vert'] and abs(ay - by) > 0.5:
            continue
        d, t = seg_dist(cx, cy, ax, ay, bx, by)
        if d < 2.5 and (best is None or d < best[0]):
            best = (d, (a, b))
    if best:
        e = edges[best[1]]
        e['label'] = lab['text']
        e.setdefault('labelPos', []).append([round(cx, 2), round(cy, 2)])
        label_links.append(lab['text'])
    else:
        unplaced.append(lab)

# dashed runs (white-orange/purple trace): bridge short collinear gaps
for a in range(len(nodes)):
    if deg(a) != 1:
        continue
    for b in range(a + 1, len(nodes)):
        if deg(b) != 1 or nodes[a][2] != nodes[b][2]:
            continue
        d = math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1])
        if d > 7.8:
            continue
        if comp_at(*nodes[a][:2]) or comp_at(*nodes[b][:2]):
            continue
        da, db = direction(a), direction(b)
        if da[0] * db[0] + da[1] * db[1] > -0.98:
            continue
        ux, uy = (nodes[b][0] - nodes[a][0]) / d, (nodes[b][1] - nodes[a][1]) / d
        if ux * da[0] + uy * da[1] < 0.98:
            continue
        add_edge(a, b, dash=True)

# ---------------------------------------------------------------- chains
def is_term(n):
    if deg(n) != 2:
        return True
    # two wires meeting at a component pin are separate wires, not one
    if path_ends[n] >= 2 and comp_at(nodes[n][0], nodes[n][1]):
        a, b = list(adj[n])
        ax, ay = nodes[a][0] - nodes[n][0], nodes[a][1] - nodes[n][1]
        bx, by = nodes[b][0] - nodes[n][0], nodes[b][1] - nodes[n][1]
        cos = (ax * bx + ay * by) / ((math.hypot(ax, ay) * math.hypot(bx, by)) or 1)
        return cos > 0.3
    return False

seen = set()
chains = []
for n in range(len(nodes)):
    if not is_term(n):
        continue
    for m in adj[n]:
        k = (min(n, m), max(n, m))
        if k in seen:
            continue
        pts = [n]
        info = []
        prev, cur = n, m
        seen.add(k)
        info.append(edges[k])
        while not is_term(cur):
            pts.append(cur)
            nxt = [q for q in adj[cur] if q != prev][0]
            k = (min(cur, nxt), max(cur, nxt))
            seen.add(k)
            info.append(edges[k])
            prev, cur = cur, nxt
        pts.append(cur)
        chains.append(dict(nodes=pts, info=info))

def simplify(pts):
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        a, b, c = out[-1], pts[i], pts[i + 1]
        cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
        if abs(cross) < 0.05 * max(1, math.hypot(c[0] - a[0], c[1] - a[1])):
            continue
        out.append(b)
    out.append(pts[-1])
    return out

auto_n = [0]
def endpoint_ref(n):
    x, y, col = nodes[n]
    c = comp_at(x, y)
    if c is None:
        auto_n[0] += 1
        c = dict(id='T%d' % auto_n[0], name='Terminal %d' % auto_n[0], type='terminal',
                 box=[x - 3, y - 3, x + 3, y + 3], pins=[], art=[])
        comps.append(c)
        print('  unassigned end -> %s at (%.1f,%.1f) %s' % (c['id'], x, y, col))
    for p in c['pins']:
        if abs(p['x'] - x) < 1.2 and abs(p['y'] - y) < 1.2:
            return c, p
    p = dict(id='p%d' % (len(c['pins']) + 1), name=str(len(c['pins']) + 1), x=x, y=y)
    c['pins'].append(p)
    return c, p

splices = {}
def splice_ref(n):
    if n not in splices:
        x, y, col = nodes[n]
        sid = 'SP%d' % (len(splices) + 1)
        c = dict(id=sid, name='Splice %d' % (len(splices) + 1), type='splice',
                 box=[x - 1.5, y - 1.5, x + 1.5, y + 1.5], pins=[dict(id='p1', name='1', x=x, y=y)], art=[])
        comps.append(c)
        splices[n] = c
    c = splices[n]
    return c, c['pins'][0]

wires = []
for i, ch in enumerate(chains):
    ns = ch['nodes']
    col = nodes[ns[0]][2]
    pts = clean_route(simplify([(nodes[n][0], nodes[n][1]) for n in ns]))
    if len(pts) == 2 and math.dist(pts[0], pts[1]) < 0.6:
        continue
    if math.dist(pts[0], pts[-1]) < 1.0 and all(math.dist(p, pts[0]) < 12 for p in pts):
        continue   # tiny loop around a junction dot
    if True:
        c0, c1 = comp_at(*pts[0]), comp_at(*pts[-1])
        if c0 is not None and c0 is c1 and all(contains(c0['box'], (x, y, x, y)) for x, y in pts):
            c0.setdefault('wire_art', []).append((col, pts))
            continue
    ends = []
    for n in (ns[0], ns[-1]):
        ends.append(endpoint_ref(n) if deg(n) == 1 or comp_at(nodes[n][0], nodes[n][1]) else splice_ref(n))
    lab = [e for e in ch['info'] if e.get('label')]
    w = dict(
        id='W%d' % (len(wires) + 1),
        color=col,
        circuit=lab[0]['label'] if lab else '',
        labels=[p for e in lab for p in e['labelPos']],
        dashed=any(e.get('dash') for e in ch['info']),
        frm=dict(c=ends[0][0]['id'], p=ends[0][1]['id']),
        to=dict(c=ends[1][0]['id'], p=ends[1][1]['id']),
        points=[[round(x, 2), round(y, 2)] for x, y in pts],
    )
    if len({e['label'] for e in lab}) > 1 or len(lab) > 1 and False:
        print('  multiple labels on chain', [e['label'] for e in lab])
    wires.append(w)

# propagate circuit numbers across splices (same colour)
changed = True
while changed:
    changed = False
    by_splice = collections.defaultdict(list)
    for w in wires:
        for e in (w['frm'], w['to']):
            if e['c'].startswith('SP'):
                by_splice[e['c']].append(w)
    for sp, ws in by_splice.items():
        known = [w['circuit'] for w in ws if w['circuit']]
        if known:
            for w in ws:
                if not w['circuit']:
                    w['circuit'] = known[0]
                    changed = True

for w in wires:
    if w['circuit'] == '15003':
        w['color'] = 'WOP'

# ---------------------------------------------------------------- art
def fmt(v):
    s = '%.2f' % v
    s = s.rstrip('0').rstrip('.')
    return s if s not in ('-0', '') else '0'

def path_d(p, ox, oy):
    out = []
    for c, ps in p['cmds']:
        if c == 'Z':
            out.append('Z')
        else:
            out.append(c + ' '.join('%s %s' % (fmt(x - ox), fmt(y - oy)) for x, y in ps))
    return ''.join(out)


leftover = []
for i, p in enumerate(paths):
    if i in skip:
        continue
    best = None
    for c in comps:
        if c['type'] in ('splice', 'terminal'):
            continue
        if contains(c['box'], p['bbox']):
            if best is None or area(c) < area(best):
                best = c
    if best is None:
        leftover.append(i)
    else:
        best['art'].append(i)

# cluster leftovers into annotation groups
BIG = 300
parent = list(range(len(leftover)))
def find(a):
    while parent[a] != a:
        parent[a] = parent[parent[a]]
        a = parent[a]
    return a
small = [k for k, i in enumerate(leftover) if max(paths[i]['bbox'][2] - paths[i]['bbox'][0], paths[i]['bbox'][3] - paths[i]['bbox'][1]) < BIG]
G = 5.0
for ai in range(len(small)):
    a = paths[leftover[small[ai]]]['bbox']
    for bi in range(ai + 1, len(small)):
        b = paths[leftover[small[bi]]]['bbox']
        if a[0] - G <= b[2] and b[0] - G <= a[2] and a[1] - G <= b[3] and b[1] - G <= a[3]:
            parent[find(small[ai])] = find(small[bi])
groups = collections.defaultdict(list)
for k, i in enumerate(leftover):
    big = k not in small
    groups['frame' if big else find(k)].append(i)
for gk, idxs in groups.items():
    if len(idxs) == 1 and paths[idxs[0]]['fill'] in WIRE and paths[idxs[0]]['curve']:
        continue
    xs0 = min(paths[i]['bbox'][0] for i in idxs); ys0 = min(paths[i]['bbox'][1] for i in idxs)
    xs1 = max(paths[i]['bbox'][2] for i in idxs); ys1 = max(paths[i]['bbox'][3] for i in idxs)
    nid = 'SHEET' if gk == 'frame' else 'NOTE%d' % (len([c for c in comps if c['id'].startswith('NOTE')]) + 1)
    comps.append(dict(id=nid, name='Sheet border' if gk == 'frame' else 'Annotation', type='panel',
                      box=[xs0, ys0, xs1, ys1], pins=[], art=idxs))

# QR image -> title block
img = re.search(r'xlink:href="(data:image/jpeg;base64,[^"]*)"', src).group(1)
for c in comps:
    if c['id'] == 'TITLE':
        c['image'] = dict(href=img, x=301.36 - c['box'][0], y=(H - 75.405) - c['box'][1], w=60.547, h=60.547)

# ---------------------------------------------------------------- pin names
PIN_NAMES = {
    'HL_RELAY': [(127, 194, 'L1'), (145, 194, 'T1'), (163, 194, 'L2'), (127, 242, 'S1'), (163, 242, 'S2')],
    'HL_FUSE': [(29, 207, 'OUT'), (29, 236, 'IN')],
    'HORN_RELAY': [(227, 126, 'H'), (227, 123, 'H'), (251, 148, 'S'), (251, 157, 'B')],
    'COIL': [(285, 324, 'SW (+)'), (283, 325, 'SW (+)'), (265, 325, 'CB (-)'), (274, 334, 'HT')],
    'DIST_CAP': [(150, 367, 'HT IN')],
    'ENGINE': [(70, 483, 'GND'), (80, 408, 'PLUG 1'), (103, 408, 'PLUG 2'), (126, 408, 'PLUG 3'),
               (149, 408, 'PLUG 4'), (171, 408, 'PLUG 5'), (194, 408, 'PLUG 6')],
    'ALT': [(115, 504, 'IND'), (115, 514, 'B+')],
    'STARTER': [(209, 552, 'BAT'), (206, 552, 'BAT'), (208, 552, 'BAT'), (233, 550, 'SOL')],
    'BATTERY': [(119, 569, '+'), (127, 569, '+'), (63, 564, '-')],
    'IGN_SW': [(324, 490, 'BAT'), (264, 504, 'GRD'), (293, 471, '1'), (283, 472, '2'), (303, 541, 'ACC'), (297, 533, 'ACC'), (306, 544, 'SOL')],
    'FUSE_PANEL': [(403, 438, 'RADIO 3A'), (411, 438, 'HORN 25A'), (422, 438, 'CIG LIGHTER'), (448, 438, 'TAIL STOP & DOME 15A'),
                   (457, 438, 'GLOVE BOX'), (403, 532, 'INSTA LAMPS 3A'), (411, 532, 'WIPER 15A'), (422, 532, 'TURN SIGNAL'),
                   (429, 532, 'HEATER 15A'), (439, 532, 'W/S WASHER'), (448, 533, 'BACK UP 15A'), (457, 533, 'BRAKE ALARM'),
                   (373, 480, 'G BAT'), (383, 488, 'G ACC'), (383, 499, 'G LAMPS'), (470, 490, 'IGN'), (471, 488, 'IGN')],
    'FLASHER': [(655, 292, 'L'), (655, 306, 'P'), (655, 320, 'B')],
    'TELLTALES': [(741, 361, 'OIL'), (721, 377, 'TEMP'), (741, 393, 'GEN')],
    'SPEEDO': [(751, 516, 'HIGH BEAM')],
    'FUEL_GAUGE': [(711, 627, 'BAT'), (712, 642, 'SENDER'), (788, 634, 'LAMP')],
    'WASHER_PUMP': [(553, 695, 'BAT'), (604, 695, 'SWITCH')],
    'WIPER_MOTOR': [(155, 711, 'SW2'), (155, 723, 'BAT'), (155, 734, 'SW1'), (155, 757, 'W')],
    'TAIL_RH': [(1098, 61, 'TAIL'), (1098, 67, 'STOP')],
    'TAIL_LH': [(1098, 178, 'TAIL'), (1098, 184, 'STOP')],
    'PARK_LH': [(350, 104, 'PARK'), (355, 104, 'TURN')],
    'PARK_RH': [(382, 104, 'PARK'), (387, 104, 'TURN')],
    'HL_LH': [(107, 79, 'GND'), (116, 79, 'LO'), (124, 79, 'HI')],
    'HL_RH': [(160, 79, 'GND'), (169, 79, 'LO'), (177, 79, 'HI')],
}
cmap = {c['id']: c for c in comps}
for cid, names in PIN_NAMES.items():
    c = cmap[cid]
    for x, y, name in names:
        best = min(c['pins'], key=lambda p: math.hypot(p['x'] - x, p['y'] - y))
        if math.hypot(best['x'] - x, best['y'] - y) < 3:
            best['name'] = name

def clusters(vals, tol=3):
    out = []
    for v in sorted(vals):
        if out and v - out[-1][-1] < tol:
            out[-1].append(v)
        else:
            out.append([v])
    return out

for c in comps:
    if c['type'] != 'connector' or not c['pins']:
        continue
    xs = [p['x'] for p in c['pins']]
    ys = [p['y'] for p in c['pins']]
    b = c['box']
    if max(xs) - min(xs) < 2:
        flow = 'v'
    elif max(ys) - min(ys) < 2:
        flow = 'h'
    else:
        flow = 'h' if (b[3] - b[1]) > (b[2] - b[0]) else 'v'
    mid = (b[0] + b[2]) / 2 if flow == 'h' else (b[1] + b[3]) / 2
    rows = clusters([p['y'] if flow == 'h' else p['x'] for p in c['pins']])
    for p in c['pins']:
        v = p['y'] if flow == 'h' else p['x']
        k = next(i for i, r in enumerate(rows) if r[0] - 0.01 <= v <= r[-1] + 0.01) + 1
        side = p['x'] < mid if flow == 'h' else p['y'] < mid
        p['name'] = '%d%s' % (k, ('A' if side else 'B'))

# merge pins that now share a name (several wires landing on one terminal)
remap = {}
for c in comps:
    keep = {}
    pins = []
    for p in c['pins']:
        if p['name'] in keep and not p['name'].isdigit():
            remap[(c['id'], p['id'])] = keep[p['name']]['id']
        else:
            keep[p['name']] = p
            pins.append(p)
    c['pins'] = pins
for w in wires:
    for e in (w['frm'], w['to']):
        e['p'] = remap.get((e['c'], e['p']), e['p'])
# tidy ids/names for remaining unnamed pins
for c in comps:
    if c['type'] == 'connector':
        c['bridges'] = []
        by = collections.defaultdict(list)
        for p in c['pins']:
            by[p['name'][:-1]].append(p['id'])
        for k, ids in sorted(by.items(), key=lambda kv: int(kv[0])):
            if len(ids) == 2:
                c['bridges'].append(ids)

NOTE_NAMES = [
    (146, 34, 'Headlamps (title)'), (63, 74, 'Headlamp beam key'), (261, 112, 'Optional twin horns'),
    (371, 54, 'Front parking & turn signal lamps (title)'), (574, 324, 'Turn signal indicator lamps (title)'),
    (601, 590, 'Optional handbrake warning lamp & switch (title)'), (73, 338, 'TVRS high tension cable note'),
]

# ---------------------------------------------------------------- emit
def style_key(p):
    if p['sw'] == 0 and p['fill'] != 'none':
        return (p['fill'], 'fill', 0)
    return (p['stroke'], 'stroke', round(p['sw'], 2))

out_comps = []
for c in comps:
    ox, oy = c['box'][0], c['box'][1]
    groups = collections.OrderedDict()
    for i in c['art']:
        k = style_key(paths[i])
        if paths[i]['fill'] not in ('none',) and paths[i]['sw'] > 0:
            k = (paths[i]['stroke'], 'both:' + paths[i]['fill'], round(paths[i]['sw'], 2))
        groups.setdefault(k, []).append(path_d(paths[i], ox, oy))
    HEX = {v: k for k, v in WIRE.items()}
    for col, pts in c.get('wire_art', []):
        k = (HEX[col], 'stroke', 1.41)
        groups.setdefault(k, []).append('M' + 'L'.join('%s %s' % (fmt(x - ox), fmt(y - oy)) for x, y in pts))
    art = []
    for (colr, mode, w), ds in groups.items():
        a = dict(d=''.join(ds))
        if mode == 'fill':
            a['fill'] = colr
        elif mode.startswith('both:'):
            a['fill'] = mode[5:]
            a['stroke'] = colr
            a['sw'] = w
        else:
            a['stroke'] = colr
            a['sw'] = w
        art.append(a)
    name = c['name']
    if c['id'].startswith('NOTE'):
        cx, cy = (c['box'][0] + c['box'][2]) / 2, (c['box'][1] + c['box'][3]) / 2
        for nx, ny, nn in NOTE_NAMES:
            if abs(nx - cx) < 15 and abs(ny - cy) < 10:
                name = nn
        if name == 'Annotation' and c['box'][2] - c['box'][0] < 6 and c['box'][3] - c['box'][1] < 6:
            name = 'Auto-trans marker'
    oc = dict(
        id=c['id'], name=name, type=c['type'],
        x=round(ox, 2), y=round(oy, 2),
        w=round(c['box'][2] - ox, 2), h=round(c['box'][3] - oy, 2),
        pins=[dict(id=p['id'], name=p['name'], x=round(p['x'] - ox, 2), y=round(p['y'] - oy, 2)) for p in c['pins']],
        art=art,
    )
    if 'image' in c:
        oc['image'] = c['image']
    if c.get('bridges'):
        oc['bridges'] = c['bridges']
    out_comps.append(oc)

json.dump(dict(components=out_comps, wires=wires), open(OUT, 'w'), separators=(',', ':'))
print('wires', len(wires), 'components', len(out_comps), 'splices', len(splices),
      'annotations', sum(1 for c in out_comps if c['id'].startswith('NOTE')))
print('labels linked', len(label_links), 'unplaced', [l['text'] for l in unplaced])
print('unlabelled wires', sum(1 for w in wires if not w['circuit']))
