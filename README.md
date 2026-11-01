# Harness Editor

A browser-based wiring harness visualiser and editor, deployed as a Cloudflare Worker for live,
shared editing. It ships with the **EH Holden** harness (Mad Folk drawing MF0015-54: Mad Folk circuit
numbers, alternator with built-in regulator, headlight relay upgrade) rebuilt as live data: 68
components, 144 wires, 75 numbered circuits and 18 splices, all drawn with the original artwork.

## How it runs

```
browser ──HTTPS──▶ Worker (src/index.ts) ──▶ static UI in public/ (only for signed-in users)
   │                   │
   │                   ├─▶ Directory DO "main"   sign-in codes, 30-day sessions, harness list
   │                   └─▶ HarnessRoom DO (one per harness)  canonical document in SQLite
   └──WebSocket────────────────▲                               │ alarm, ~30 s after edits
                                                               ▼
                                                    R2: harness-editor-backups
```

- **Sign-in**: only `ryan.dutton@gmail.com` and `kris.bousfield@gmail.com` (`ALLOWED_EMAILS`). Enter
  an address, receive a 6-digit code from `admin@xtract.bot` via Cloudflare Email Service, and enter
  it to get a 30-day `HttpOnly` session cookie. Codes expire after 10 minutes, work once, allow 5
  guesses, and at most 3 can be requested per address per 15 minutes. Unknown addresses get the
  same response but no email.
- **Live editing**: every edit is sent as small operations on whole components, wires or document
  fields. The harness's Durable Object applies them, stores them and relays them to everyone else
  connected. Two people changing different things never overwrite each other; on the same item, the
  last edit wins. Undo only reverts your own edits. You see who else is in the harness (status bar)
  and their cursors. Edits made while disconnected are re-sent when the connection returns.
- **Backups**: about 30 seconds after changes, the harness is written to R2 as
  `projects/<id>/latest.json`, plus a timestamped snapshot in `projects/<id>/history/` at most every
  10 minutes. A snapshot is also taken before every restore, reset or delete. **Harness menu →
  Backups & restore…** lists the snapshots and restores one for everyone.
- **Offline copy**: opening `public/index.html` straight from disk still works as before, saved in
  that browser only.

## Deploying

One-time setup (needs `npx wrangler login` first):

```sh
npm install
npx wrangler email sending enable xtract.bot      # if xtract.bot isn't onboarded for Email Sending yet
npx wrangler r2 bucket create harness-editor-backups
npx wrangler deploy
```

`wrangler email sending list` shows whether `xtract.bot` is ready. The `send_email` binding only
allows sending from `admin@xtract.bot` to the two allowed addresses. To add a person, add them to
both `ALLOWED_EMAILS` and `allowed_destination_addresses` in `wrangler.jsonc`, then redeploy.

Local development: `npm run dev`, then open http://localhost:8787. Locally, sign-in emails are not
sent. The code appears in the terminal (the `Subject:` line of the logged email). Durable Objects and
R2 are simulated in `.wrangler/`. Run `npm run check` to type-check the Worker after changes; rerun
`npm run types` after changing bindings.

## What it does

- **Visualise**: pan and zoom the full drawing, switch between OEM wire colours and Mad Folk harness
  colours, show labels as circuit number, colour code or both, and see crossover hops and rounded
  corners like the original sheet.
- **Trace**: pick a circuit (Circuits tab, the Find box, or select a wire and press `T`) to highlight
  its whole net through splices and connector cavities. Everything else dims.
- **Modify**: drag components (attached wires follow and stay square), reroute wires by dragging
  bends, segment midpoints or ends, reconnect an end by dropping it on another pin, slide labels
  along a wire, and edit circuit numbers, colours, gauge, length and notes in the inspector.
- **Extend**: draw new wires pin-to-pin (`W`), branch off an existing wire (this adds a splice), place
  new components (generic, lamp, switch, 5-pin relay, fuse, 2/4/6-way inline connector, ground,
  motor, battery, terminal, text note), add, rename and move pins, and define internal links (connector
  cavities, fuse in/out) for net tracing. You can also add colours and change the OEM→harness mapping.
  To make more room, enlarge the canvas under **View → Canvas**: type a size, pick an A4–A0 sheet,
  extend it on any side, or grow it to fit parts dragged off the page.
- **Save & share**: shared harnesses live on the server. You can also export and import JSON, export
  the drawing as SVG, export a CSV wire list, or print a wire schedule.

Press `?` in the app for the full mouse and keyboard reference.

## Files

| Path | Purpose |
| --- | --- |
| `wrangler.jsonc` | Worker config: assets, Durable Objects, R2, email binding, allowed users |
| `src/index.ts` | Worker: sign-in, session check, API routes, WebSocket hand-off, static assets |
| `src/directory.ts` | `Directory` Durable Object: codes, sessions, harness list |
| `src/room.ts` | `HarnessRoom` Durable Object: document storage, live relay, R2 backups |
| `src/ops.ts` | Edit-operation format and validation |
| `public/login.html` | Sign-in page |
| `public/index.html`, `public/css/app.css` | App shell and styles (light/dark) |
| `public/js/model.js` | Document model, geometry, net tracing, edit operations, undo/redo, local storage |
| `public/js/sync.js` | Server mode: harness list, WebSocket sync, presence, backups, sign-out |
| `public/js/render.js` | SVG rendering: artwork/symbols, wires with hops, labels, handles, cursors, SVG export |
| `public/js/editor.js` | Pointer/keyboard interaction and editing tools |
| `public/js/ui.js` | Menus, side panels, inspector, search, import/export, boot |
| `public/js/seed-eh-holden.js` | Generated EH Holden starting data (do not edit by hand) |
| `public/assets/eh-reference.png` | The original drawing as an optional underlay (View tab) |
| `tools/` | Pipeline that turned the SVG export into the seed data |

## Data format

An exported harness is plain JSON:

```jsonc
{
  "meta": { "title": "...", "drawingNo": "..." },
  "page": { "w": 1190.55, "h": 841.89 },              // drawing units (pt)
  "colors":   [{ "code": "DBL", "name": "Dark blue", "hex": "#003fff", "mf": "BL/BK" }],
  "mfColors": [{ "code": "BL/BK", "name": "Blue / black trace", "hex": "#7fdfff", "tracer": "#222222" }],
  "components": [{
    "id": "HL_RELAY", "name": "Headlight relay (Hella 329316011)", "type": "relay",
    "style": "art",                                   // "art" = original artwork, else a generated symbol
    "x": 70, "y": 193, "w": 101, "h": 61, "rot": 0,
    "pins": [{ "id": "p4", "name": "L1", "x": 57.4, "y": 1.1 }],
    "bridges": [["p1", "p3"]],                        // pins joined inside the part
    "art": [{ "d": "M…", "stroke": "#000000", "sw": 0.42 }]
  }],
  "wires": [{
    "id": "W1", "circuit": "15065", "color": "R", "gauge": "", "length": "", "notes": "",
    "from": { "c": "HL_FUSE", "p": "p2" }, "to": { "c": "STARTER", "p": "p1" },
    "points": [[29.3, 236.1], [29.3, 603.6], [207.7, 603.6], [207.7, 552.4]],
    "labels": [[29.2, 410.9]]                         // circuit label anchors
  }]
}
```

## Notes on the extracted data

- The export's text is stroked geometry. Circuit numbers were read by matching each digit's stroke
  shape (`tools/digit_templates.json`), and all 86 labels on the sheet were decoded.
- Pin names come from the drawing where it prints them: relay `L1/T1/L2/S1/S2`, ignition switch
  `BAT/GRD/1/2/ACC/SOL`, fuse panel positions, flasher `L/P/B`, wiper motor `SW1/SW2/BAT/W` and others.
  The rest are numbered, and you can rename any pin in the inspector.
- Connector pins are named by cavity row and side (`3A` ↔ `3B`) and linked so that tracing passes
  through them. Their numbering is in drawing order, not the manufacturer's cavity numbers.
- 41 wires have no circuit number on the drawing: plug tails, HT leads, battery cables and the
  turn-signal switch's internal harness.

## Rebuilding the seed from the SVG

```sh
python3 -I tools/decode_labels.py ~/Downloads/eh-wiring-diagram-svg.svg /tmp/labels.json
python3 -I tools/extract.py       ~/Downloads/eh-wiring-diagram-svg.svg /tmp/labels.json /tmp/model.json
python3 -I tools/build_seed.py    /tmp/model.json public/js/seed-eh-holden.js
```

`extract.py` holds the component bounding boxes and pin-name overrides used to group the artwork. Edit
those lists if you want to regroup a part. Existing harnesses are not affected by a rebuild.
To use a new seed, choose **New from EH Holden example** in the harness menu.
