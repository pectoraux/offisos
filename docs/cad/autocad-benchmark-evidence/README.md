# Benchmark evidence — CAD-BENCH-RW-001

Black-box browser evidence captured against production `https://offisos.vercel.app`
(main `f4a1a735dfbfa58d9b24197ffc1808d4cdf84db6`, deployment `dpl_2keo5yEQ3o3WnHncF6ggGMoqjAvm`).

Capture instrument: headless Chromium via browser automation acting as a real user
(command line, ribbon, palettes, canvas clicks). No application code was read or modified.

## Files

| File | What it shows |
| ---- | ------------- |
| `00-recon-initial.png` | Application surface at first load (ribbon, palettes, command line, empty Model viewport) |
| `00-recon-line-started.png` | LINE command prompt state ("LINE: Specify first point:") |
| `00-recon-line-drawn.png` | Single drawn LINE rendered on canvas |
| `00-recon-after-undo.png` | Canvas after UNDO — ghost residue of the undone line remains (DEF-019) |
| `u1-empty.png` / `u2-after-undo.png` / `u3-line-again.png` | Controlled experiment: empty state vs post-undo state vs redraw — the post-undo canvas differs from the empty state by ~1237 px exactly in the undone line's footprint |
| `t1.png` / `t2.png` | Canvas fingerprint stability checks (no animation; states are genuine) |
| `P01-layers-arch-standard.png` | Layers palette after applying the "Architectural (A-)" standard (10 A- rows created) |
| `P01-exterior-wall-rect.png` | 12000×9000 mm exterior-wall rectangle after ZOOMEXTENTS (rendering only after fit; DEF-004) |
| `P01-dimlinear-rendered.png` | DIMLINEAR entity rendered (positive finding) |
| `P01-text-rendered.png` | TEXT entity rendered (positive finding) |
| `P01-canvas-state-check.png` | Canvas state during the view-origin drift investigation |
| `P08-schedules-tab.png` | Schedules / property-definitions workbench (CAD-PARITY-015 surface) |
| `P10-array-result.png` / `P10-array-3rows.png` / `P10-array-final.png` | ARRAY Rectangular "success" echoes vs blank/invisible canvas results (DEF-015) |
| `P16-bim-walls.png` | BIM STORY + 4 WALLs rendered as a closed plan (positive finding) |
| `P21-documentation-tab.png` | Documentation workbench: layout created, then "No layouts" after the MVIEW engine-side failure (DEF-018) |
| `P24-import-crash.png` | Status bar stuck at "importing the DXF…" after the import attempt (DEF-012) |
| `P24-dxf-import-viewport-destroyed.png` | Model tab with no canvas after the DXF import attempt (viewport destruction, DEF-012) |
| `FINAL-session-command-history.txt` | Command-history transcript at session end (post-reload) |
| `FINAL-state.png` | Final workspace state |

## Key text evidence (exact echoes, from the live session transcript)

Layer activation failures (DEF-001/002):

```
-LAYER
M — Make — create a layer and make it current
A-WALL-TEST
X
-LAYER: layer 'A-WALL-TEST' created and set current.
LINE
0,0 → (0,0)
300,0 → (300,0)
LINE: (0,0) → (300,0) on layer '0'.
CLAYER
A-WALL-TEST
CLAYER: layer 'A-WALL-TEST' not found.
```

Palette layer activation async error:

```
CLAYER: active layer is now 'A-WALL'.
*ERROR* layer.setActive: bad_layer — layer.setActive: no layer 'ly-000001'
```

NEW leaves a dangling active layer and creation fails (DEF-003/027):

```
NEW
NEW: fresh document created.
RECTANGLE
0,0 → (0,0)
12000,9000 → (12000,9000)
RECTANGLE: (0,0) → (12000,9000) on layer 'ly-000001'.
*ERROR* drafting.createEntities: drafting_invalid — entities[0]: layer 'ly-000001' does not exist in the document layer table
```

Coordinate entry fidelity (positive finding):

```
0,0 → (0,0)
@100,0 → (100,0)
@50<90 → (100,50)
@50<45 → (135.355,85.355)
```

ARRAY completes but nothing renders (DEF-015):

```
ARRAY
1 found (previous selection)
R
5
1
2500
0
ARRAY Rectangular: 4 copies of 1 object(s) (5 x 1, spacing (0, 2500)) — one atomic revision; constraints bind the sources only.
ZOOMEXTENTS
→ canvas pixel analysis: 0 rendered pixels; SELECTALL: Sel 1
```

BIM walls work (positive finding):

```
STORY: 'Ground Floor' level 0, height 3000 created and set active.
WALL: (0,0) → (5000,0) width 240 height 3000 on story 'el-000001'.
```

MVIEW engine-side failure and layout vanishing (DEF-018):

```
LAYOUTNEW: Layout 'A-101' created (A3 landscape, 10 mm margins, fit) and activated.
MVIEW
Fit
Fit
Viewport placed on 'A-101' from 20,20 to 380,270 (fit to the model extents).
*ERROR* viewport.create: bad_id — layout 'A-101' does not exist
→ Documentation panel: "No layouts — LAYOUTNEW creates one"
```

DXF export rejects own geometry (DEF-011):

```
(fresh reload; single LINE (0,0)→(777,0) drawn)
Export DXF → "507 bytes | 0 entities exported | 1 skipped | geometry-unknown"
```

DXF import hang + viewport destruction (DEF-012):

```
Import DXF → status bar: "importing the DXF… (ONE atomic revision: linetypes + layers + elements)" (never completes)
→ Model tab: canvas element removed from DOM; tab switching frozen; zero console errors
```

## Console instrumentation note

`browser console` and `page errors` channels were checked repeatedly across the whole
session: **0 console messages, 0 page errors** — including during the DXF import viewport
destruction. The application fails silently from the browser's perspective; all failures
surface only as command-line echoes or as invisible/incorrect UI state. Deterministic
regression suites for this application must not rely on console instrumentation to detect
failure.
