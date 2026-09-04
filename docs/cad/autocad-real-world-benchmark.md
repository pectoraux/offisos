# Offisos AutoCAD Real-World Black-Box Benchmark Report

- **Benchmark ID**: CAD-BENCH-RW-001
- **Date**: 2026-09-04
- **Agent role**: black-box benchmark agent (browser-driven, production-only, no implementation knowledge used, no fixes applied)
- **System under test**: https://offisos.vercel.app (production; `Offisos CAD Workspace`)
- **Baseline**: main `f4a1a735dfbfa58d9b24197ffc1808d4cdf84db6`, deployment `dpl_2keo5yEQ3o3WnHncF6ggGMoqjAvm`
- **Primary instrument**: browser automation (Chromium) interacting with the visible UI exactly as a user: command line, ribbon, palettes, canvas clicks. One `GET /api/cad` was performed after UI operations to inspect the server graph identity (permitted validation).
- **Corpus**: 25 realistic AutoCAD project types researched from public sources (corpus metadata with source URLs: `autocad-benchmark-corpus.json`).
- **Evidence**: screenshots + full command-history transcripts in `docs/cad/autocad-benchmark-evidence/`.

---

## 1. Executive result

> **How close is current Offisos to being a practical replacement for common AutoCAD workflows?**

### Overall score: **18 / 100**

**Verdict.** The current Offisos web application is **not** a practical replacement for common AutoCAD workflows. It has a real, AutoCAD-shaped command surface — a command line with correct prompt sequencing, absolute/relative/polar coordinate entry with exact echoes, working geometry primitives (LINE/RECTANGLE/CIRCLE/POLYLINE), working annotation creation (TEXT/MTEXT/DIMLINEAR), working BIM story/wall creation, working layout/title-block creation, and a genuinely responsive feel — but **every professional-critical subsystem beneath that surface fails when exercised the way a real user would exercise it**:

- **Layers are unusable.** There is no working path to draw on any layer other than `'0'` (five distinct activation paths tested; four fail, the fifth reports raw internal ids and then bricks new documents after `NEW`).
- **Object picking is non-functional** in command select phases, which kills blocks, doors/windows, trim completion, fillet completion.
- **Navigation is one command** (`ZOOMEXTENTS`); there is no `ZOOM`/`Z`/`PAN`/`P`/`REGEN`.
- **Rendering is all-or-nothing per entity**: any entity with an endpoint outside the viewport renders zero pixels.
- **Arrays create invisible results** (command reports success; canvas and selection find nothing).
- **Persistence is a total failure chain**: reload loses everything; `SAVE` downloads a stale snapshot that does not match the document; there is no `OPEN`; DXF export rejects the app's own line/circle geometry as `geometry-unknown`; DXF import hangs forever and **destroys the Model viewport** until reloaded.
- **Layouts create in the UI but fail in the engine** (`viewport.create: bad_id — layout 'A-101' does not exist`), after which the layout vanishes.
- **The application menubar is dead**, `F1` does nothing despite being advertised in error messages, and there is no command autocomplete — command discovery is essentially the ribbon.

A competent AutoCAD user could **not** take any of the 25 corpus projects and execute the important work in Offisos through the UI to a usable professional result today.

**Score rationale** (what earns points, what loses them):

- **Earned (+)**: geometry primitives with exact coordinate echoes (relative/polar verified to 6 decimals); DIMLINEAR/TEXT/MTEXT create **and render**; STORY/WALL create and render (closed plan of 4 walls verified); LAYOUTNEW (A3 landscape) + TITLEBLOCK (5 rows, 180×60 mm); ROTATE completes via previous-selection; ARRAY has a correct, honest prompt flow ("Path is unsupported" disclosed); command error messages for bad coordinates are helpful and non-destructive; **zero browser console messages and zero page errors across the entire ~70-minute session** (no hydration crashes, no JS exceptions — all failures surface as command-line echoes).
- **Lost (−)**: layers (score 0 subsystem), selection (two desynced paths, dead picking), views (no zoom/pan), rendering (clipping), persistence (total loss + stale save + destructive import), interop (DXF both directions broken), blocks/hatch/attributes absent or unreachable, viewports engine-side failure, state instability over long sessions, command keyword inconsistency, dead menubar, no discoverability.

---

## 2. Category scores (0–5)

| Category | Score | Note |
| --- | ---: | --- |
| 2D drafting | 1 | primitives + coordinate entry work; rendering, navigation, undo ghosts and state drift make real drafting unreliable |
| Architectural documentation | 1 | layers/hatch/blocks broken or absent; DIMLINEAR/TEXT work |
| Civil/site | 1 | real-scale geometry invisible until ZOOMEXTENTS; no navigation; arrays invisible |
| Structural | 1 | grid/rect primitives work; arrays invisible, no hatch, layers broken |
| MEP | 0 | symbol blocks unreachable (BLOCK dead); walls work but nothing leaves the app |
| Mechanical/detail drafting | 1 | dims work; trim/fillet object-pick broken; arrays invisible; no tolerance workflow |
| Annotation/documentation | 2 | TEXT/MTEXT/DIMLINEAR create and render; MTEXT layer echo shows raw ids; associative-dims verification blocked by selection defects |
| Layers/properties | 0 | no working activation path; client/engine identity split; NEW leaves a dangling active layer that bricks creation |
| Blocks/reuse | 0 | BLOCK creation unreachable (selection cleared + picking dead) |
| Editing | 1 | ROTATE completes via P-selection; TRIM reaches object-pick stage; picking broken blocks completion |
| Persistence | 0 | reload = total loss; SAVE = stale snapshot; no OPEN; DXF import destroys the viewport |
| Layouts/plotting | 1 | LAYOUTNEW + TITLEBLOCK work; MVIEW fails engine-side and the layout vanishes; sheets unexportable |
| Complex workflows | 1 | long sessions degrade state (entity-count inflation, canvas blanking, status flapping) |
| BIM elements | 2 | STORY/WALL create and render correctly; DOOR host-pick unreachable; no BIM export on the web host |

---

## 3. Project ranking

| Rank | Project | Discipline | Overall | Blocking? | Main weakness |
| ---: | ------- | ---------- | ------: | --------- | ------------- |
| 1 | P24 Persistence / reload / round-trip cycle | complex | 0 | YES | reload loses all work; SAVE stale; DXF export skips own geometry; DXF import destroys the viewport |
| 2 | P19 tutorial45 Exercise 1 quadrilateral | mechanical | 2 | no | polar/relative entry works exactly; TRIM object-pick broken; no LIST to verify; no persistence |
| 3 | P21 Title block + revision block + sheet border | documentation | 2 | no | LAYOUTNEW + TITLEBLOCK work; MVIEW fails engine-side and the layout vanishes |
| 4 | P25 Failure recovery / undo-redo torture | complex | 1 | no | undo leaves visual ghosts; 3 undos → only 2 redos; failed CLAYER resets the active layer |
| 5 | P09 Site plan (real-scale meters) | civil | 1 | YES | entities invisible until ZOOMEXTENTS; no zoom/pan; frozen single-view |
| 6 | P01 Single-family residential floor plan | architecture | 1 | YES | layers unusable; OFFSET bricked by dangling layer; clipped rendering |
| 7 | P02 Office floor plan w/ door swings + labels | architecture | 1 | YES | layers/selection/picking defects; door swings need arcs+trim (pick broken) |
| 8 | P03 Multi-storey residential floor grid | architecture | 1 | YES | STORY works; ARRAY copies invisible and unselectable |
| 9 | P10 Parking layout with stall arrays | civil | 1 | YES | ARRAY completes but result invisible and unselectable |
| 10 | P13 Foundation plan with column grid | structural | 1 | YES | primitives work; layers broken; arrays invisible |
| 11 | P04 Reflected ceiling plan w/ fixture blocks | architecture | 0 | YES | BLOCK creation unreachable → no symbol workflow at all |
| 12 | P08 Door schedule table | architecture | 1 | no | Schedules workbench exists; no TABLE command found; nothing to schedule (no blocks) |
| 13 | P07 Stair plan and section detail | architecture | 1 | YES | repeated treads need ARRAY → invisible results |
| 14 | P05 Building elevation with hatches | architecture | 0 | YES | HATCH entirely absent |
| 15 | P06 Wall section construction detail | architecture | 0 | YES | no HATCH + no usable layers = detailing impossible |
| 16 | P11 Contour/topographic plan | civil | 1 | YES | splines exist; no reliable editing/selection for contours; no persistence |
| 17 | P12 Road geometry with curves | civil | 1 | YES | FILLET prompts work; fillet completion needs object picks (broken) |
| 18 | P14 Steel connection w/ bolt-hole pattern | structural | 1 | YES | arrays invisible; no hatch; no centerline workflow |
| 19 | P15 RC beam reinforcement detail | structural | 1 | YES | no hatch; array invisible; layers broken |
| 20 | P16 HVAC duct layout (manufacturer template) | MEP | 1 | YES | STORY+WALL strongest workflow; OFFSET bricked by layers; BIM not exportable |
| 21 | P17 Electrical lighting plan w/ legend | MEP | 0 | YES | blocks + attributes unreachable |
| 22 | P18 Multi-view part drawing w/ tolerances | mechanical | 1 | YES | dims work; no tolerance/dim-style workflow reachable; no snapping reliability |
| 23 | P20 Flange plate w/ bolt-hole circle | mechanical | 1 | YES | circles work; polar array result invisible |
| 24 | P22 Sheet layout with viewports | documentation | 1 | YES | MVIEW engine-side failure; layout vanishes; sheets unexportable |
| 25 | P23 Long editing session torture | complex | 1 | YES | state degradation: entity-count inflation, canvas blanking, status flapping |

(Complete per-project records with capability/fidelity/usability/robustness/persistence sub-scores, operations, source URLs and evidence references: `autocad-benchmark-corpus.json`.)

---

## 4. Defect backlog

Grouped by root cause. "Projects" lists reproductions; the same root defect may surface differently in each.

### DEF-001 — No working path to draw on a non-'0' layer
- **Severity**: BLOCKER · **Area**: layers
- **Reproduction** (production, any session):
  1. `-LAYER` → `M` → `A-WALL-TEST` → `X` → echo: "layer 'A-WALL-TEST' created and set current."
  2. `LINE` → `0,0` → `300,0` → echo: "LINE: (0,0) → (300,0) **on layer '0'**." (not the layer just set current)
  3. `CLAYER` → `A-WALL-TEST` → echo: "CLAYER: layer 'A-WALL-TEST' not found."
  4. Palette "set active" button → async echo: `*ERROR* layer.setActive: bad_layer — no layer 'ly-000001'`.
  5. Props-panel active-layer combobox → sets it (status shows the name) → next LINE echo: "on layer 'ly-000001'" (raw id) — and see DEF-003 for the follow-on damage.
- **Expected**: geometry lands on the active layer; name-based CLAYER resolves.
- **Actual**: every path fails or lands on `'0'`; echoes show raw internal ids.
- **Projects**: P01, P02, P03, P04, P16 (all layer-dependent workflows).
- **Evidence**: command-history transcripts; `P01-layers-arch-standard.png`.

### DEF-002 — Client layer table and engine layer table are two different identity spaces
- **Severity**: BLOCKER · **Area**: data model / layers
- **Reproduction**: create a layer via the Layers palette ("new layer name" + "add layer") → click its "set active" → `*ERROR* layer.setActive: bad_layer — no layer 'ly-000010'`; `-LAYER`-created layers appear in the palette but `CLAYER` reports "not found"; the entity layer combobox reports `ly-000001` as value.
- **Expected**: one layer table shared by UI and engine, addressed by name.
- **Actual**: palette layers (ly-NNN ids) are unknown to the engine; engine layers are unresolvable by name from the command line.
- **Projects**: P01 (and every layer-dependent workflow).

### DEF-003 — NEW does not reset the active layer; documents become undrawable
- **Severity**: BLOCKER · **Area**: data model / state
- **Reproduction**: set active layer to a non-'0' layer via the Props combobox → `NEW` → `LINE` → `0,0` → `300,0` → echo: "LINE: (0,0) → (300,0) on layer 'ly-000001'." followed by `*ERROR* drafting.createEntities: drafting_invalid — entities[0]: layer 'ly-000001' does not exist in the document layer table` — the create fails (entity never appears). The document stays broken until the user manually resets the active layer to `'0'`.
- **Expected**: NEW resets the drafting environment to layer '0'.
- **Actual**: dangling active-layer reference; creation failures with success-then-error echo pairs.
- **Projects**: P01, P24 (draw-after-NEW sequences).

### DEF-004 — Entities with any out-of-viewport endpoint render zero pixels (all-or-nothing clipping)
- **Severity**: BLOCKER · **Area**: geometry / rendering
- **Reproduction**: fresh document → `LINE` → `0,0` → `5000,200` (crosses the entire viewport) → canvas pixel analysis: **0** dark pixels; the visible portion is not drawn. `ZOOMEXTENTS` → 318 dark pixels (line appears).
- **Expected**: viewport clipping draws the visible portion of every entity.
- **Actual**: whole-entity skip when geometry exceeds the viewport.
- **Projects**: P01 (12000×9000 rectangle), P09 (site scale), P13, P16.
- **Evidence**: pixel-analysis transcripts; `P01-exterior-wall-rect.png`.

### DEF-005 — No zoom/pan navigation; only ZOOMEXTENTS
- **Severity**: BLOCKER · **Area**: views
- **Reproduction**: `ZOOM`, `Z`, `ZE`, `EXT`, `PAN`, `P`, `REGEN` → all "Unknown command". `ZOOMEXTENTS` → works (rescales to extents).
- **Expected**: window/dynamic zoom, pan, regenerate — the daily navigation vocabulary of CAD.
- **Actual**: one fit-extents command; real drawings are a frozen single view.
- **Projects**: all.

### DEF-006 — Object picking by mouse click is non-functional in command select phases
- **Severity**: BLOCKER · **Area**: selection
- **Reproduction**: draw a line; note its exact canvas row via pixel analysis; start `BLOCK` (or `DOOR`, or TRIM's object stage); click exactly on the entity's rendered pixels → no selection echo, prompt unchanged, `Sel` stays 0. Drag-select attempts also fail. (Picking worked sporadically early in one session — never reliably.)
- **Expected**: clicking near an entity selects it (pickbox tolerance in screen space).
- **Actual**: clicks are ignored; all pick-dependent commands cannot complete.
- **Projects**: P01, P04, P12, P16, P17.

### DEF-007 — Bracketed prompt options are inconsistently implemented (some are dead and cancel the command)
- **Severity**: MAJOR · **Area**: command
- **Reproduction**: `LINE` → points → at "Specify next point or [Undo]:" type `Undo` → LINE is cancelled and `UNDO` runs instead. `POLYLINE` → vertex → type `Arc` → PLINE cancelled, ARC command starts. But: `FILLET` → `R` works ("R — Fillet radius"); `-LAYER` → `M` works; `ARRAY` → `P`/`R` work; `CIRCLE` → `3P` → "not a coordinate" (option unimplemented but command survives).
- **Expected**: advertised bracketed keywords are honored uniformly.
- **Actual**: per-command lottery; typing a keyword can destroy the active command.
- **Projects**: P01, P15, P19, P23.

### DEF-008 — SELECTALL selection is not reflected in the Properties palette (two desynced selection paths)
- **Severity**: BLOCKER · **Area**: selection / properties
- **Reproduction**: draw a line → `SELECTALL` → status bar shows "Sel 1" but the Props palette shows "No selection. Pick an entity in the Model viewport…". A canvas-click selection (when it works) **does** populate the palette ("SELECTION — 3 ENTITIES", "GENERAL id el-000001 …").
- **Expected**: one selection state reflected everywhere.
- **Actual**: command-driven selection and click-driven selection are different states; properties editing on command-selected entities is impossible.
- **Projects**: P01, P02, P18.

### DEF-009 — No persistence: reload loses all work; no OPEN
- **Severity**: BLOCKER · **Area**: persistence
- **Reproduction**: draw entities → reload the page → canvas empty, `SELECTALL` → "Sel 0", command history empty. `OPEN`, `IMPORT`, `LOAD` → all "Unknown command". No localStorage/sessionStorage/IndexedDB entries at any point.
- **Expected**: the document survives a refresh or can be reopened from the saved file.
- **Actual**: total, unrecoverable loss on every reload.
- **Projects**: P24 (and the practical end of every project).

### DEF-010 — SAVE downloads a stale snapshot disconnected from the live document
- **Severity**: BLOCKER · **Area**: persistence / data model
- **Reproduction**: (a) draw a 5000 mm line → `SAVE` → downloaded `offisos-workspace.json` contains entities from a **previous session**, not the current one; (b) create document A (TEXT present) → export DXF → create document B (a single LINE) → export DXF → **identical sha256 and byte count for both exports** (5503a2cc…, "1 entities exported | 4 skipped"); (c) the snapshot contains entities referencing layers that do not exist in its own layer table (`ly-000001`).
- **Expected**: SAVE serializes the current document.
- **Actual**: a frozen/diverged server-side snapshot; the live client graph never reaches the export.
- **Projects**: P24.
- **Evidence**: downloaded `offisos-workspace.json` + `offisos-export.dxf` (contents documented in the transcript); identical-sha observation.

### DEF-011 — DXF export classifies freshly drawn LINE/CIRCLE geometry as "geometry-unknown"
- **Severity**: BLOCKER · **Area**: interoperability
- **Reproduction**: full page reload → draw a single LINE (0,0)→(777,0) → Interoperability → "Export DXF" → result: "507 bytes | **0 entities exported | 1 skipped — geometry-unknown**". In a mixed document, TEXT exports and LINE/CIRCLE are skipped.
- **Expected**: the app's own LINE/CIRCLE entities export (the writer documents LINE/CIRCLE support).
- **Actual**: only annotation-like entities export; geometry does not.
- **Projects**: P24 (and any intent to move work to another CAD tool).

### DEF-012 — DXF import hangs forever and destroys the Model viewport
- **Severity**: BLOCKER · **Area**: interoperability / browser-UI
- **Reproduction**: Interoperability → paste a valid 89-byte DXF (single LINE entity) into "paste DXF ASCII text…" → click "Import DXF" → status bar stuck at "importing the DXF… (ONE atomic revision…)" indefinitely; after a while the **Model tab has no canvas** (canvas element removed from DOM) and tab switching freezes on the Interop view; only a full reload recovers the UI — and the reload loses all work (DEF-009). Zero console errors throughout.
- **Expected**: the DXF imports as entities (or produces a typed error).
- **Actual**: hang + workspace destruction.
- **Projects**: P24.
- **Evidence**: `P24-import-crash.png`, `P24-dxf-import-viewport-destroyed.png`.

### DEF-013 — BLOCK creation is unreachable
- **Severity**: MAJOR (BLOCKER for reuse workflows) · **Area**: blocks
- **Reproduction**: `BLOCK` → name → base point → at "Select objects for the block:" type `P` → "No previous selection — pick objects or type P with a selection active" (even with an active selection — the name/base-point prompts clear it); canvas clicks on the entity do nothing (DEF-006).
- **Expected**: select objects → block defined.
- **Actual**: no path to complete the command.
- **Projects**: P04, P17 (all symbol/block libraries).

### DEF-014 — Entity-count inflation; NEW does not fully clear the client graph
- **Severity**: MAJOR · **Area**: data model
- **Reproduction**: `NEW` → draw ONE line → `SELECTALL` → "Sel 3". Draw three lines → "Sel 5". The surplus entities are not selectable-by-click, not visible, but counted. Long sessions make it worse (see DEF-026).
- **Expected**: Sel count == drawn entities.
- **Actual**: phantom entities accumulate.
- **Projects**: P10, P23, P25.

### DEF-015 — ARRAY completes but the copies neither render nor are selectable
- **Severity**: MAJOR (BLOCKER for repetitive geometry) · **Area**: arrays
- **Reproduction**: draw a line → `SELECTALL` → `ARRAY` → `P` → "1 found (previous selection)" → `R` → 5 rows × 1 col → spacing 2500/0 → echo "ARRAY Rectangular: 4 copies of 1 object(s) (5 x 1, spacing (0, 2500)) — one atomic revision" → `ZOOMEXTENTS` → canvas pixel analysis: **0 rendered pixels**; `SELECTALL` → "Sel 1".
- **Expected**: 5 visible, selectable lines.
- **Actual**: an atomic revision that is invisible and unselectable.
- **Projects**: P03, P07, P10, P13, P14, P15, P20.
- **Evidence**: `P10-array-result.png`, `P10-array-final.png`.

### DEF-016 — BIM DOOR/WINDOW host-wall selection is unreachable
- **Severity**: MAJOR (BLOCKER for BIM openings) · **Area**: BIM / selection
- **Reproduction**: STORY + 4 WALLs (closed rectangle, renders correctly) → `DOOR` → "Select host wall:" → coordinate input rejected ("'2500,0' is not an object — pick in the canvas or type P"); canvas clicks on the wall's exact rendered pixels do nothing; `P` would select everything, not one wall.
- **Expected**: pick the host wall, place the door.
- **Actual**: no completion path.
- **Projects**: P16.

### DEF-017 — BIM elements cannot leave the app (DXF skips them; IFC unavailable on the web host)
- **Severity**: MAJOR · **Area**: interoperability / BIM
- **Reproduction**: document with STORY + 4 WALLs → "Export DXF" → "0 entities exported | 3 skipped | geometry-unknown". IFC section: "IFC interop unavailable — no IFC interop adapter is bound to this host's engine bundle".
- **Expected**: BIM geometry exportable (IFC per the app's own IFC4 story, or DXF).
- **Actual**: no export path on the production web host.
- **Projects**: P16, P24.

### DEF-018 — MVIEW fails engine-side ("layout does not exist") and the layout then vanishes
- **Severity**: MAJOR · **Area**: layout / data model
- **Reproduction**: `LAYOUTNEW` → `A-101` → "Layout 'A-101' created (A3 landscape, 10 mm margins, fit) and activated" (Documentation panel shows "A-101 · A3 landscape · 0 viewports") → `MVIEW` → corners (20,20)–(380,270) → `Fit` → echo "Viewport placed on 'A-101' …" followed by `*ERROR* viewport.create: bad_id — layout 'A-101' does not exist` → the Documentation panel now shows "**No layouts** — LAYOUTNEW creates one".
- **Expected**: the viewport is created on the layout that provably exists.
- **Actual**: engine-side lookup fails (same name/id split as DEF-002) and the UI state is destroyed by the failure.
- **Projects**: P21, P22.
- **Evidence**: `P21-documentation-tab.png`.

### DEF-019 — UNDO leaves a visual ghost of the undone entity; undo/redo stacks mismatch
- **Severity**: MAJOR · **Area**: undo/redo / rendering
- **Reproduction**: (a) fresh doc → draw one line (0,0)→(120,60) → `UNDO` → `SELECTALL` → "Sel 0" (entity gone) but canvas pixel diff shows ~1237 residual pixels exactly in the line's footprint (stable across reads — no animation); (b) 3 lines → `UNDO` ×3 (5→2 entities) → `REDO` ×3 → the third redo: `*ERROR* document.redo: nothing_to_redo — redo stack is empty` (only 2 redos available).
- **Expected**: canvas returns to the pre-draw state; N undos give N redos.
- **Actual**: ghost pixels persist; stacks are off by one.
- **Projects**: P25, and any undo-dependent correction workflow.
- **Evidence**: `00-recon-line-drawn.png` vs `00-recon-after-undo.png`; `u1-empty.png` vs `u2-after-undo.png` vs `u3-line-again.png`.

### DEF-020 — Application menubar dead; F1 hint false; no command autocomplete
- **Severity**: MAJOR · **Area**: browser/UI / discoverability
- **Reproduction**: click (or hover) File/Edit/…/Help → no menu opens (no `[role=menuitem]` ever appears). Error messages say "Press F1 or Ctrl+K for the command search" — F1 opens nothing. Typing in the command input produces no suggestions. The Search button merely focuses the command input.
- **Expected**: menus open; F1 opens help; the search autocompletes commands.
- **Actual**: the top menubar is inert chrome; command discovery is the ribbon.
- **Projects**: all.

### DEF-021 — Selection keywords at "Select objects:" prompts run new commands instead
- **Severity**: MAJOR · **Area**: command / selection
- **Reproduction**: `MOVE` → "Select objects:" → type `ALL` → MOVE is cancelled and `SELECTALL` runs instead.
- **Expected**: `ALL`/`LAST`/`PREVIOUS` are selection keywords inside the prompt.
- **Actual**: typed keywords escape the prompt and cancel the active command.
- **Projects**: P01, P23.

### DEF-022 — Annotation layer attribution echoes raw internal ids; MTEXT height fixed
- **Severity**: MODERATE · **Area**: annotation
- **Reproduction**: with active layer set via the Props combobox: `MTEXT` → … → echo "MTEXT: 1 line(s) … on layer 'ly-000001'." (raw id, not the name). MTEXT text height is fixed at 2.5 mm regardless of a 2000 mm width context.
- **Projects**: P01, P02.

### DEF-023 — HATCH is entirely absent
- **Severity**: BLOCKER (for sections/details/material representation) · **Area**: hatch
- **Reproduction**: `HATCH`, `BHATCH`, `-HATCH`, `H` → all "Unknown command". No hatch button anywhere in the ribbon (searched all buttons).
- **Projects**: P05, P06, P14, P15, P18.

### DEF-024 — Status bar is untrustworthy (layer display flaps; version counter non-monotonic; stuck states)
- **Severity**: MODERATE · **Area**: browser/UI
- **Reproduction**: after setting active layer to '0', the status bar still shows "Layer A-WALL-TEST" while creates land on '0'; the graph version counter moves both up and down across reads; transient "working…" stuck status appears after failed operations.
- **Projects**: P01, P23.

### DEF-025 — WALL does not chain segments (single segment per command)
- **Severity**: MODERATE · **Area**: BIM / command
- **Reproduction**: `WALL` → start → end → command exits; the next point input becomes "Unknown command".
- **Expected**: wall chaining like polyline-style input (common BIM/AutoCAD pattern).
- **Projects**: P16.

### DEF-026 — Long-session state degradation
- **Severity**: MAJOR · **Area**: data model / robustness
- **Reproduction**: after ~1 hour of interactive work in one tab: NEW stops clearing the graph (entity-count inflation becomes permanent), canvas blanking occurs during failed command sequences (px 66 → 0 with no successful undo), status-bar flapping increases, and a reload is the only remedy (which loses all work).
- **Projects**: P23.

### DEF-027 — Command echoes report success before the engine rejects the operation
- **Severity**: MAJOR · **Area**: command / data model
- **Reproduction**: every failing create shows an optimistic success echo immediately followed by the async error — e.g. "RECTANGLE: (0,0) → (12000,9000) on layer 'ly-000001'." then `*ERROR* drafting.createEntities: drafting_invalid …`; "Viewport placed on 'A-101' …" then `*ERROR* viewport.create: bad_id …`. Users cannot tell which line is true.
- **Projects**: P01, P21, P22, P24.

---

## 5. Capability gaps

**Fully supported (verified working end-to-end, production):**
- LINE / RECTANGLE / CIRCLE / POLYLINE creation with absolute, relative (`@dx,dy`) and polar (`@dist<angle`) coordinates
- TEXT and MTEXT creation
- DIMLINEAR creation and rendering (measured server-side)
- STORY and WALL creation and rendering (BIM plan graphics)
- LAYOUTNEW (A3 landscape) and TITLEBLOCK creation
- ZOOMEXTENTS
- ROTATE (via previous-selection)
- -LAYER keyword flow (Make creates a layer record)
- ARRAY command prompt flow (completion semantics see DEF-015)

**Partially supported (works with material limitations):**
- OFFSET (prompts and selection-by-click once worked; creation fails on dangling layers)
- TRIM / EXTEND / FILLET / CHAMFER (prompt flow correct; object completion blocked by picking)
- ARRAY Rectangular (completes; result invisible/unselectable)
- UNDO / REDO (entity removal works; ghosts remain; stacks mismatch)
- Layer palette management (rows, standards, per-layer linetype/lineweight controls exist; activation broken)
- Schedules / property-definitions workbench (machinery present; not drivable end-to-end from a drawing because blocks/doors don't exist)
- OSNAP/ORTHO status toggles (ORTHO toggles; OSNAP click points to palette settings)

**Unreliable:**
- Canvas click selection (worked twice early, never again)
- Active-layer state (flaps between displays)
- Sel count (inflated by phantoms)
- View state after ZOOMEXTENTS (origin moves; NEW does not reset it)
- Command-input keystroke handling across long sessions

**Unsupported (verified absent or unreachable):**
- HATCH (no command, no alias, no button)
- ZOOM (window/dynamic), PAN, REGEN
- OPEN / file loading of any kind
- BLOCK creation and INSERT workflow
- Attributes (ribbon buttons exist; prerequisite dead)
- BIM DOOR / WINDOW placement
- Viewports (MVIEW) on layouts
- Layer activation by any command path
- LIST, LIST-like entity inspection
- Command aliases (L, C, P, Z, H, …) — the placeholder advertises "(L, C, WA, ST…)" but single letters are "Unknown command"

**Not yet evaluated (out of black-box reach this run):**
- 3D / 3D BIM tabs beyond STORY/WALL (rendering of 3D views)
- Collab / Automation / Toolsets / Parametrics workbenches
- Certification workbench corpora (present; diagnostic surface)
- Components workbench
- Print/plot beyond sheet export ("no sheets in this document")

---

## 6. Highest-leverage fixes (ranked by user impact × frequency × workflows affected)

1. **Unify the layer identity space and make active-layer activation real** (DEF-001/002/003). Layers are the backbone of every professional drawing; today every project lands on layer '0'. Fix the name↔id resolution, make `CLAYER`/`-LAYER M`/palette agree, and reset the active layer on `NEW`.
2. **Fix object picking (screen-space pickbox)** (DEF-006). Unlocks BLOCK, DOOR/WINDOW, TRIM/EXTEND/FILLET completion, and per-entity properties editing in one fix.
3. **Fix viewport clipping to draw partial entities** (DEF-004) **and add zoom/pan** (DEF-005). Together they make real-scale drawings (site plans, floor plans) actually visible and navigable.
4. **Make ARRAY results renderable and selectable** (DEF-015). Repetitive geometry is the heart of parking, grids, stairs, bolt circles.
5. **Fix SAVE to serialize the live document and add OPEN** (DEF-010 + DEF-009). No professional tool survives without round-trip persistence.
6. **Fix DXF export of the app's own geometry ("geometry-unknown")** (DEF-011) **and repair the DXF import hang/viewport destruction** (DEF-012). Interop is the only bridge to the rest of the CAD world (DWG is a documented typed decline; DXF must work).
7. **Synchronize selection state between command selection and the Properties palette** (DEF-008). Enables properties-driven editing, CHPROP workflows, and trustworthy feedback.
8. **Fix layout/viewport engine-side identity resolution** (DEF-018). LAYOUTNEW already works; viewports are the last mile to sheets.
9. **Honor advertised bracketed prompt options uniformly** (DEF-007) **and selection keywords (ALL/LAST)** (DEF-021). Command-line trust is the product's core interaction contract.
10. **Stabilize the state machine over sessions** (DEF-014/024/026/027): true graph reset on NEW, trustworthy Sel/version displays, echo-after-commit instead of optimistic success-then-error.

(Not recommended before these: cosmetic work, additional workbenches, more certification corpora. HATCH (DEF-023) is a genuine functional gap but a *new feature*, ranked below structural workflow blockers per the prioritization rule; it becomes top priority once items 1–7 land.)

---

## 7. Golden benchmark set (permanent black-box regression corpus)

Ten canonical projects selected for breadth + difficulty; each exposes today's failures and should pass at score ≥4 before "AutoCAD parity" claims:

| # | Project | Why it matters | Capabilities exercised | Failures it currently exposes |
| - | ------- | -------------- | ---------------------- | ----------------------------- |
| 1 | **G1 — Single-family floor plan** (P01) | the most common CAD deliverable; composes layers+walls+dims+text | layers, RECTANGLE/LINE, OFFSET, DIMLINEAR, TEXT, save | DEF-001/002/003/004/010 |
| 2 | **G2 — Site plan at real scale** (P09) | forces real-world coordinate magnitudes | large extents, navigation, boundary polylines, dims | DEF-004/005 |
| 3 | **G3 — Parking layout** (P10) | repetitive geometry at production scale | ARRAY, LINE, dims | DEF-015 |
| 4 | **G4 — tutorial45 quadrilateral exercise** (P19) | exact polar/relative drafting + trim closure | coordinate entry, TRIM, geometric closure | DEF-006 (trim pick), no LIST |
| 5 | **G5 — RCP with light-fixture blocks** (P04) | symbol-library workflows (blocks/insert/attributes) | BLOCK, INSERT, attributes, arrays | DEF-013/006 |
| 6 | **G6 — Wall section detail** (P06) | material representation and detailing | hatch, linetypes, layers, detail dims | DEF-023/001 |
| 7 | **G7 — HVAC/BIM duct layout** (P16) | BIM elements + host relationships | STORY, WALL, OFFSET, DOOR (openings) | DEF-016/017/003 |
| 8 | **G8 — Title-block sheet with viewports** (P21/P22) | documentation delivery: sheets, scales, viewports | LAYOUTNEW, TITLEBLOCK, MVIEW, sheet export | DEF-018 |
| 9 | **G9 — Save/reload/DXF round-trip cycle** (P24) | the persistence and interop contract | SAVE, reload, DXF export/import, state integrity | DEF-009/010/011/012 |
| 10 | **G10 — 60-minute editing torture + undo/redo** (P23/P25) | long-session robustness and history integrity | interleaved editing, undo/redo, cancellation, state stability | DEF-014/019/024/026 |

---

## 8. Method notes and honest limitations

- All interaction went through the visible UI (command line, ribbon, palettes, canvas clicks). No hidden API was used to accomplish work; one `GET /api/cad` was performed after UI operations to inspect server-side graph identity.
- Command echoes (the `command history` element) are the primary text evidence; canvas pixel analysis (background-diff and dark-pixel counting against the known palette `#E7E9EC` background / `#464D58` line color) is the primary visual evidence; screenshots corroborate.
- Console and page-error channels were monitored throughout: **zero browser errors, zero console messages** for the entire session. Every failure in this report surfaced as a command-line echo or as invisible/incorrect UI state — a "silent failure" profile that deterministic test suites must not rely on console instrumentation to catch.
- The benchmark did not modify the application, the repository code, the Architecture, or any governance record. All artifacts added in this PR are documentation/evidence only.
- Not evaluated (documented in §5): 3D workbenches, Collab/Automation/Toolsets/Parametrics, Certification corpora UI, Components, plotting beyond sheet export status.
- Limitations: single browser profile, single ~70-minute continuous session plus reload cycles, one production deployment; scores reflect the UI as exercised, not internal intent.

## 9. Evidence index

Directory `docs/cad/autocad-benchmark-evidence/`:

- `00-recon-*.png` — initial surface, LINE draw, undo ghost chain
- `u1-empty.png`, `u2-after-undo.png`, `u3-line-again.png` — controlled undo-residue experiment
- `t1.png`, `t2.png` — fingerprint stability checks
- `P01-*.png` — layers standard, rectangle render, DIMLINEAR render, TEXT render, canvas state
- `P08-schedules-tab.png` — schedules workbench
- `P10-array-*.png` — array result invisibility
- `P16-bim-walls.png` — BIM story/wall rendering (positive finding)
- `P21-documentation-tab.png` — layout + viewport failure state
- `P24-import-crash.png`, `P24-dxf-import-viewport-destroyed.png` — DXF import viewport destruction
- `FINAL-session-command-history.txt` — end-of-session command transcript
- `FINAL-state.png` — final workspace state

Machine-readable corpus with per-project sub-scores: `docs/cad/autocad-benchmark-corpus.json`.
