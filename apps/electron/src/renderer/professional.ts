/**
 * CAD-PARITY-002 professional workspace — Electron renderer module
 * (Issue #75; CAD/BIM Product Architecture v1.0 FROZEN under
 * ConstructionOS Architecture v1.1), extended for CAD-PARITY-003
 * (Issue #78): the canonical 2D entity vocabulary (ellipse/spline/point/
 * ray/xline/region + both storage conventions through the geometry bridge),
 * the merged canonical entity picking, the entityPoint step dispatch, the
 * shared precision snapping and the rubber-band command previews — mirroring
 * the Web host 1:1 so both hosts present the SAME command surface and
 * semantics (LOCK-004).
 *
 * CAD-PARITY-004 (Issue #80, CAD-2D-004) — layers, properties, styles &
 * palettes: display resolution through the shared standards module (the
 * ByLayer chain: entity override → layer → document standard — color,
 * linetype dash, lineweight px, transparency alpha, locked-layer fade), the
 * drawable/interactable entity views (frozen = suppressed; locked = drawn
 * faded but not pickable/snappable), the professional Properties inspector,
 * the Layers manager + Styles manager right dock, the idle-canvas context
 * menu and the LWT status toggle — mirroring the Web host palettes.tsx so
 * both hosts present the SAME property/layer/style surface (LOCK-004).
 *
 * CAD-PARITY-005 (Issue #82) — annotation/text/dimension parity: annotation
 * elements (the 8-type canonical vocabulary AND the legacy COMPAT-CAD-001
 * dims) render on a real HTML canvas overlay through the ONE shared painter
 * (annotationPrimitives + paintAnnotationPrimitives) with the resolved
 * CAD-PARITY-004 display (layer visibility/frozen gate, selected = thicker +
 * full alpha); pick and window/crossing selection merge the shared
 * primitive-based annotation hit tests; the Properties inspector gains the
 * per-type Annotation section (measured READ-ONLY through dimensionLabel,
 * textOverride, style/height/rotation/justification/attachment edits through
 * annotation.update, locked-layer read-only); the Styles manager gains the
 * dim-style arrowStyle/unitSuffix editors + the document annotation scale;
 * the Annotate menu/ribbon surfaces expose all 11 annotation commands —
 * mirroring the Web host model-canvas/palettes/ribbon so both hosts present
 * the SAME annotation surface (LOCK-004 parity by construction).
 *
 * CAD-PARITY-006 (Issue #84) — blocks, components, references & reuse:
 * block-ref/xref-ref instance elements render through the ONE shared
 * expansion (expandInstanceElement) on the CAD-PARITY-005 canvas overlay —
 * geometry pieces painted from the canonical props with the resolved
 * display of each piece's own layer, text pieces through the SAME shared
 * annotation painter (annotationPrimitives + paintAnnotationPrimitives),
 * unresolved references as the dashed placeholder box + label; instances
 * pick/window-select by their DERIVED content (returning the INSTANCE
 * element id) and contribute their expanded bounds to zoom extents. The
 * Properties inspector gains the Block Instance / Reference Instance
 * sections (definition readout, placement edits through entity.modify's
 * instance transforms, per-tag attribute editors through
 * attribute.update); the Insert menu/ribbon expose the BLOCK/INSERT/ATTDEF/
 * ATTEDIT/XATTACH/XDETACH/XREF vocabulary and the right dock gains the
 * Blocks & References manager (definitions with instance counts; the xref
 * table with Attach/Reload through the REAL main-process file dialog —
 * dialog.showOpenDialog filtered to .offisos/.json — plus Detach and status
 * badges) — mirroring the Web host so both hosts present the SAME blocks
 * surface (LOCK-004 parity by construction).
 *
 * Adds the professional shell to the Electron host: application menu bar,
 * ribbon/tool palette, command-driven 2D Model canvas (SVG plan viewport
 * with crosshair, snap markers, ortho/polar rubber bands, window/crossing
 * selection, cycling, grips), command line with prompt state + history,
 * status bar with drafting-aid toggles, command palette (Ctrl+K), a
 * properties readout and the keyboard map.
 *
 * EVERYTHING routes through the SAME shared workspace core the Web host
 * uses (`@offisos/cad-app-shell/workspace` — bundled at build time; pure,
 * engine-free, LOCK-003/018). Mutations flow only through App API command
 * plans via `window.cad.send` (§5.3) — Web/Electron semantic parity is the
 * acceptance criterion (LOCK-004), proven by test/smoke-workspace.mjs
 * against the pinned parity fixture (same save sha as the Web smoke).
 *
 * The legacy drafting/BIM/docs/IFC/components surfaces remain untouched and
 * accessible (mode toggles unchanged) — additive integration only.
 */

import type { Command, CommandQueryResponse, Query } from "@offisos/cad-app-shell/contracts/app-api";
import type {
  BlockDefinitionRecord,
  CADDocumentSnapshot,
  DimStyleRecord,
  Element,
  LayerRecord,
  LayerStateRecord,
  LtypeRecord,
  TextStyleRecord,
  UcsRecord,
  XrefRecord,
  Camera3DState,
} from "@offisos/cad-app-shell/contracts/caddocument";
import type { Vec2 } from "@offisos/cad-app-shell/drafting/precision";
import { elementToDraftEntity, isDraftingElement, type DraftEntity } from "@offisos/cad-app-shell/drafting/entities";
import {
  IDLE_PROMPT_STATE,
  applyPromptEvent,
  describePrompt,
  effectiveStep,
  optionValue,
  splitEchoTiming,
  type PromptEngineState,
} from "@offisos/cad-app-shell/workspace/prompt-engine";
// CAD-PARITY-003: the SAME shared precision engine the Web host renderer and
// the server-side precision queries run — parity by construction.
import {
  pickApertureWorld,
  pickAt as pickAtGeom,
  resolveSnap as resolveSnapPrecision,
  selectWindow as selectWindowGeom,
  toEntities,
  type Entity as GeomEntity,
  type OsnapMode,
  type PrecisionSettings,
} from "@offisos/cad-app-shell/workspace/precision-2d";
import { arcSweep, bbox as geomBBox, closestOn, sampleSpline } from "@offisos/cad-app-shell/workspace/geometry/entities";
import { mirrorGeom, rotateGeom, scaleGeom } from "@offisos/cad-app-shell/workspace/geometry/transform";
import { offsetGeom } from "@offisos/cad-app-shell/workspace/geometry/offset";
import { geomFromElement } from "@offisos/cad-app-shell/workspace/geometry/bridge";
import { GEOM_LABEL, propsToGeom, type Geom } from "@offisos/cad-app-shell/workspace/geometry/types";
import type { Pt } from "@offisos/cad-app-shell/workspace/geometry/math2d";
import {
  WORKSPACE_COMMANDS,
  commandById,
  resolveCommand,
  searchCommands,
  type WorkspaceCommand,
} from "@offisos/cad-app-shell/workspace/commands";
import {
  applyPickModifier,
  // COMPAT-CAD-007 (Issue #142): the shared command-phase selection core —
  // the command-select window/crossing batch (the SAME merge the Web
  // canvas runs, from ONE module — LOCK-004 parity by construction).
  commandWindowPicks,
  cyclePick,
  gripDrag,
  gripsFor,
  hitTest,
  selectionRectangle,
  windowSelect,
  type EntityPick,
  type GripEditResult,
} from "@offisos/cad-app-shell/workspace";
import { constrainCursor, DEFAULT_DRAFTING_AIDS, formatCoordinate, type DraftingAids } from "@offisos/cad-app-shell/workspace/feedback";
import { mapKeyEvent } from "@offisos/cad-app-shell/workspace/keymap";
import { defaultCommandContext, type CommandContext, type CommandPlan, type PromptValue } from "@offisos/cad-app-shell/workspace/types";
// COMPAT-CAD-006 (Issue #138): the ONE shared screen↔world view-transform
// contract — this host constructs the SAME ViewTransform (viewport 900×620
// SVG user space) through the SAME pure functions the Web host uses: every
// pick/render path and every navigation application is identical math.
import {
  CULL_MARGIN_PX,
  DESKTOP_ZOOM_LIMITS,
  SCALE_ZOOM_LIMITS,
  clipSegment as sharedClipSegment,
  expandRect as sharedExpandRect,
  fitExtents as sharedFitExtents,
  fitZoomOf as sharedFitZoomOf,
  panBy as sharedPanBy,
  rectsIntersect as sharedRectsIntersect,
  toScreen as sharedToScreen,
  toWorld as sharedToWorld,
  viewTransformOf as sharedViewTransformOf,
  visibleWorldRect as sharedVisibleWorldRect,
  zoomAboutPoint as sharedZoomAboutPoint,
  zoomScaleAboutCenter as sharedZoomScaleAboutCenter,
  zoomWindow as sharedZoomWindow,
  type ViewNavigationRequest,
} from "@offisos/cad-app-shell/workspace/view";
// CAD-PARITY-009 (Issue #90): the shared model3d core — the SAME camera /
// projection / UCS / scene-SVG modules the Web 3D viewport and the App API
// run (LOCK-004 parity by construction; pure + engine-free, LOCK-003/018).
import {
  WORLD_UCS,
  buildScene3DSVG,
  defaultCamera as defaultCamera3D,
  formatCamera,
  orbitCamera,
  panCamera,
  projectPoint,
  ucsGridSegments,
  zoomCamera,
  type BBox3D,
  type Scene3DElement,
  type StandardViewName,
} from "@offisos/cad-app-shell/workspace/model3d/index";
// CAD-PARITY-004: the SAME shared standards module the Web host renderer,
// the Web palettes and the App API run — display resolution (ByLayer chain),
// layer filters, the built-in linetype catalog and the reserved style
// records (LOCK-004 parity by construction; pure + engine-free, LOCK-003/018).
import {
  BUILT_IN_LTYPES,
  LAYER_FILTER_MODES,
  LAYER_STANDARDS,
  LOCKED_LAYER_FADE_ALPHA,
  STANDARD_DEFAULT_LINEWEIGHT,
  STANDARD_DIM_STYLE,
  STANDARD_LINEWEIGHTS,
  STANDARD_TEXT_STYLE,
  dashToDevicePx,
  displayOverridesOf,
  filterLayers,
  lineweightToDevicePx,
  resolveDisplay,
  transparencyToAlpha,
  type LayerFilterMode,
} from "@offisos/cad-app-shell/workspace/standards";
// CAD-PARITY-005: the shared annotation core (Issue #82) — the SAME
// style-driven primitive resolution, the ONE shared canvas painter and the
// primitive-based pick surface the Web host renderer and the App API run
// (LOCK-004 parity by construction; engine-free, pure — LOCK-003/018).
import {
  ANNOTATION_LABEL,
  annotationFromElement,
  annotationPrimitives,
  annotationStyleContext,
  dimensionLabel,
  pickAnnotationAt,
  selectAnnotations,
  type Annotation,
  type AnnotationStyleContext,
} from "@offisos/cad-app-shell/workspace/annotation";
import { paintAnnotationPrimitives } from "@offisos/cad-app-shell/workspace/annotation/paint";
// CAD-PARITY-007 (Issue #86): the shared constraints core — the glyph
// descriptors + the ONE shared badge painter + the shared diagnostics (the
// SAME rendering/solver the Web canvas and the App API run; LOCK-004).
import {
  CONSTRAINT_LABEL,
  constraintGlyphs,
  diagnoseConstraints,
  paintConstraintGlyphs,
} from "@offisos/cad-app-shell/workspace/constraints";
// CAD-PARITY-008 (Issue #88): the shared layouts/plot core — the SAME
// model↔paper transform, Plot IR builder and paper painter the Web host and
// the export writers consume (LOCK-004 parity by construction).
import {
  buildPlotIR,
  formatViewportScale,
  paintPlotIR,
  paintSheetBackdrop,
  type PaperPt,
  type PlotIR,
} from "@offisos/cad-app-shell/workspace/layouts";
import type { LayoutRecord, ViewportRecord } from "@offisos/cad-app-shell/contracts/caddocument";
// CAD-PARITY-006 (Issue #84): the shared blocks core — the ONE expansion
// (expandInstanceElement) + the instance views both hosts render/pick through
// (LOCK-004 parity by construction; engine-free, pure — LOCK-003/018).
import {
  attdefTagsOf,
  blockRefFromElement,
  expandInstanceElement,
  expandedBounds,
  isBlockRefElement,
  isXrefRefElement,
  xrefRefFromElement,
  type BlockTable,
} from "@offisos/cad-app-shell/workspace/blocks";

export interface ProfessionalOptions {
  /** The app root element (#app). */
  readonly root: HTMLElement;
  /** The <main> element hosting the mode cards. */
  readonly main: HTMLElement;
  /** Transport — the SAME window.cad.send bridge the legacy UI uses. */
  readonly send: (req: Command | Query) => Promise<CommandQueryResponse>;
  /** Current legacy mode ("drafting" | "bim" | "docs" | "ifc" | "components"). */
  readonly getMode: () => string;
  /** Legacy refresh — called after professional-side mutations. */
  readonly onLegacyRefresh: () => void;
  /** CAD-PARITY-006 (Issue #84): the external-reference file picker — the
   *  main-process Electron dialog (showOpenDialog filtered to
   *  .offisos/.json → read → JSON.parse). The Blocks & References manager's
   *  Attach/Reload flows resolve xref CONTENT through it (Electron-only
   *  capability; the command line attaches unresolved by design). */
  readonly pickReferenceFile: () => Promise<ReferenceFilePick | null>;
  /** CAD-PARITY-008 (Issue #88): the plot-artifact save flow — the
   *  main-process save dialog + the single fs write (pickSavePath +
   *  savePlotFile through the preload bridge; typed outcomes; the renderer
   *  never touches node/fs, §16). Optional so legacy hosts mount without it. */
  readonly pickSaveFile?: (defaultPath: string, payload: { text?: string; bytesBase64?: string }) => Promise<{ status: "canceled" } | { status: "saved"; size: number } | { status: "error"; message: string }>;
}

/** The reference-file pick outcome (mirrors the main-process
 *  cad:pickReferenceFile channel shape). */
export type ReferenceFilePick =
  | { readonly status: "canceled" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "loaded";
      readonly fileName: string;
      readonly filePath: string;
      readonly content: unknown;
    };

interface ProState {
  snapshot: CADDocumentSnapshot | null;
  selection: string[];
  engine: PromptEngineState;
  history: string[];
  aids: DraftingAids;
  activeLayer: string;
  activeStoryId: string | null;
  pan: { x: number; y: number };
  zoom: number;
  cursor: Vec2 | null;
  busy: boolean;
  paletteOpen: boolean;
}

const SVG_W = 900;
const SVG_H = 620;

function svgNs(tag: string): SVGElement {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  return e;
}

// --- CAD-PARITY-003 canonical entity helpers (mirrors of the Web host) -------

/** Visible world rectangle (viewport bounds in world units). */
interface WorldRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** The visible world rectangle of the pan/zoom view over the SVG viewport
 *  (the pan origin is the world point at the screen (0, SVG_H) corner). */
function visibleWorldRectOf(pan: { readonly x: number; readonly y: number }, zoom: number): WorldRect {
  // COMPAT-CAD-006: delegates to the ONE shared module (the fixed SVG user
  // space viewport) — identical math to the Web host's visible rect.
  return {
    minX: pan.x,
    minY: pan.y,
    maxX: pan.x + SVG_W / zoom,
    maxY: pan.y + SVG_H / zoom,
  };
}

/** Clip an infinite line (through `base` along unit `dir`) to the visible
 *  world rectangle (Liang–Barsky). `halfLine` clamps t ≥ 0 (RAY). Returns
 *  null when no part is visible. Deterministic — the SVG mirror of the Web
 *  host's clipInfinite. */
function clipInfinite(base: Pt, dir: Pt, rect: WorldRect, halfLine: boolean): readonly [Pt, Pt] | null {
  let tMin = halfLine ? 0 : -Infinity;
  let tMax = Infinity;
  if (Math.abs(dir.x) <= 1e-12) {
    if (base.x < rect.minX || base.x > rect.maxX) return null;
  } else {
    const t1 = (rect.minX - base.x) / dir.x;
    const t2 = (rect.maxX - base.x) / dir.x;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  }
  if (Math.abs(dir.y) <= 1e-12) {
    if (base.y < rect.minY || base.y > rect.maxY) return null;
  } else {
    const t1 = (rect.minY - base.y) / dir.y;
    const t2 = (rect.maxY - base.y) / dir.y;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  }
  if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || !(tMax > tMin)) return null;
  return [
    { x: base.x + dir.x * tMin, y: base.y + dir.y * tMin },
    { x: base.x + dir.x * tMax, y: base.y + dir.y * tMax },
  ];
}

/** Unit direction of an infinite entity's defining pair. */
function infiniteDir(g: Extract<Geom, { type: "ray" } | { type: "xline" }>): Pt {
  const dx = g.x2 - g.x1;
  const dy = g.y2 - g.y1;
  const l = Math.hypot(dx, dy);
  if (l <= 1e-9) return { x: 1, y: 0 };
  return { x: dx / l, y: dy / l };
}

/** Representative bounds points of a canonical entity (ZOOMEXTENTS /
 *  selection-bbox). Infinite entities contribute their defining points only
 *  (not the draw extent); splines contribute their control points (the curve
 *  lies inside the convex hull). Deterministic — mirrors the Web host. */
function canonicalBoundsPoints(g: Geom): readonly Vec2[] {
  switch (g.type) {
    case "ray":
    case "xline":
      return [
        [g.x1, g.y1],
        [g.x2, g.y2],
      ];
    case "spline":
      return g.controlPoints.map((p) => [p.x, p.y] as Vec2);
    default: {
      const bb = geomBBox(g);
      return [
        [bb.minX, bb.minY],
        [bb.maxX, bb.maxY],
      ];
    }
  }
}

// CAD-PARITY-005 (Issue #82): the annotation inspector constants — the 9
// MTEXT attachment corners (AutoCAD vocabulary), the annotation types
// carrying a text-content value and the degrees conversion for the rotation
// editor (stored radians, edited in degrees — the Web host's convention).
const DEG = Math.PI / 180;

const MTEXT_ATTACHMENTS: readonly string[] = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
];

const CONTENT_TYPES: readonly string[] = ["text", "mtext", "leader", "mleader"];

// CAD-PARITY-006 (Issue #84): the instance type labels — the same vocabulary
// the Web inspector derives for block-ref/xref-ref selections.
const BLOCK_INSTANCE_LABEL = "Block Instance";
const XREF_INSTANCE_LABEL = "Reference Instance";

// The unresolved-reference placeholder rendering constants (the dashed box
// + label painted on the annotation overlay — the shared expansion's
// diagnostic surface, drawn gray exactly like the Web host).
const PLACEHOLDER_STROKE = "#94a3b8";
const PLACEHOLDER_TEXT = "#64748b";

const PRO_CSS = `
.pro-menubar { display:flex; align-items:center; gap:2px; border-bottom:1px solid var(--border); padding:4px 10px; background:var(--bg); flex-wrap:wrap; }
.pro-menubar .brand { font-weight:700; font-size:12px; margin-right:8px; }
.pro-menu { position:relative; }
.pro-menu > button { border:0; background:transparent; font-size:12px; padding:4px 8px; border-radius:4px; cursor:pointer; }
.pro-menu > button:hover, .pro-menu.open > button { background:#f1f5f9; }
.pro-menu .items { display:none; position:absolute; top:100%; left:0; z-index:60; min-width:210px; background:var(--bg); border:1px solid var(--border); border-radius:6px; box-shadow:0 8px 24px rgba(15,23,42,.12); padding:4px 0; }
.pro-menu.open .items { display:block; }
.pro-menu .items button { display:flex; justify-content:space-between; gap:16px; width:100%; border:0; background:transparent; text-align:left; font-size:12px; padding:6px 12px; cursor:pointer; }
.pro-menu .items button:hover { background:#f1f5f9; }
.pro-menu .items .sep { border-top:1px solid var(--border); margin:4px 0; }
.pro-cmdline { border-top:1px solid var(--border); background:var(--bg); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
/* COMPAT-CAD-005: FIXED-height history (the Web host's fixed command-line
   mirror): the panel never grows with echo lines, so the layout under it
   stays byte-stable across a session. */
.pro-cmdline .history { height:110px; overflow-y:auto; padding:4px 12px; font-size:11px; color:var(--muted); line-height:1.45; }
.pro-cmdline .prompt { padding:0 12px; font-size:11px; font-weight:600; color:var(--fg); }
.pro-cmdline .entry { display:flex; align-items:center; gap:6px; border-top:1px solid var(--border); padding:4px 10px; }
.pro-cmdline .entry input { flex:1; border:0; outline:none; font-family:inherit; font-size:13px; background:transparent; color:var(--fg); }
.pro-statusbar { display:flex; flex-wrap:wrap; align-items:center; gap:10px; border-top:1px solid var(--border); background:var(--bg); padding:3px 12px; font-size:11px; color:var(--muted); }
.pro-statusbar .coord { min-width:140px; font-family:ui-monospace,monospace; }
.pro-statusbar .tog { border:1px solid var(--border); border-radius:4px; background:transparent; font-size:10px; font-weight:700; letter-spacing:.04em; padding:2px 6px; cursor:pointer; color:var(--muted); }
.pro-statusbar .tog.on { background:var(--fg); color:var(--bg); border-color:var(--fg); }
.pro-model-card { border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--bg); }
.pro-model-card header { border-bottom:1px solid var(--border); padding:8px 14px; }
.pro-model-card header h2 { font-size:13px; margin:0; }
.pro-model-card header p { margin:2px 0 0; font-size:11px; color:var(--muted); }
.pro-model-card .body { position:relative; }
.pro-model-card svg { display:block; width:100%; height:auto; background:#fff; touch-action:none; cursor:crosshair; outline:none; }
.pro-model-card svg:focus-visible { outline:2px solid #2563eb; }
.pro-mini { position:absolute; display:flex; gap:2px; background:rgba(255,255,255,.96); border:1px solid var(--border); border-radius:6px; padding:2px; box-shadow:0 4px 12px rgba(15,23,42,.15); z-index:20; }
.pro-mini button { border:0; background:transparent; font-size:11px; padding:3px 8px; border-radius:4px; cursor:pointer; }
/* CAD-PARITY-009 (Issue #90): the 3D Model view surface — the canonical scene
   container takes the plan svg's layout slot; the toolbar mirrors the Web 3D
   viewport's tool row. */
.pro-model3d-scene { display:none; width:100%; height:auto; aspect-ratio:900/620; background:#fff; overflow:hidden; }
.pro-model3d-scene svg { display:block; width:100%; height:auto; }
.pro-model3d-toolbar { display:none; flex-wrap:wrap; align-items:center; gap:3px; margin-top:4px; }
.pro-model3d-toolbar button { border:1px solid var(--border); border-radius:4px; background:transparent; font-size:11px; padding:2px 7px; cursor:pointer; }
.pro-model3d-toolbar button:hover { background:#f1f5f9; }
.pro-mini button:hover { background:#f1f5f9; }
.pro-palette { position:fixed; inset:0; z-index:100; background:rgba(15,23,42,.32); display:none; align-items:flex-start; justify-content:center; padding-top:11vh; }
.pro-palette.open { display:flex; }
.pro-palette .box { width:min(560px,92vw); background:var(--bg); border:1px solid var(--border); border-radius:10px; box-shadow:0 16px 40px rgba(15,23,42,.25); overflow:hidden; }
.pro-palette .search { display:flex; gap:8px; align-items:center; padding:10px 12px; border-bottom:1px solid var(--border); }
.pro-palette .search input { flex:1; border:0; outline:none; font-size:13px; }
.pro-palette ul { list-style:none; margin:0; padding:4px 0; max-height:320px; overflow-y:auto; }
.pro-palette li button { display:flex; gap:8px; width:100%; border:0; background:transparent; text-align:left; font-size:12px; padding:6px 14px; cursor:pointer; align-items:baseline; }
.pro-palette li button .name { font-family:ui-monospace,monospace; font-weight:700; }
.pro-palette li button .aliases { color:var(--muted); font-size:10px; }
.pro-palette li button .desc { margin-left:auto; color:var(--muted); font-size:10px; max-width:46%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pro-palette li.sel button, .pro-palette li button:hover { background:#f1f5f9; }
.pro-ribbon { display:flex; align-items:stretch; gap:14px; border-bottom:1px solid var(--border); padding:4px 10px; background:var(--bg); overflow-x:auto; }
.pro-layout-tabs { display:flex; align-items:center; gap:2px; border-bottom:1px solid var(--border); padding:3px 10px 0; background:var(--bg); }
.pro-layout-tab { border:1px solid var(--border); border-bottom:none; background:transparent; font-size:11px; font-weight:600; padding:3px 12px; border-radius:4px 4px 0 0; cursor:pointer; color:var(--muted); }
.pro-layout-tab:hover { background:#f1f5f9; }
.pro-layout-tab.active { background:var(--bg); color:var(--fg); }
.pro-layout-tabs-dyn { display:flex; gap:2px; margin-left:8px; padding-left:8px; border-left:1px solid var(--border); }
.pro-overlay { position:fixed; inset:0; z-index:60; display:flex; align-items:center; justify-content:center; background:rgba(15,23,42,.45); }
.pro-overlay-card { display:flex; flex-direction:column; gap:8px; width:min(940px,94vw); max-height:88vh; overflow:auto; background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:12px 14px; box-shadow:0 20px 40px rgba(15,23,42,.25); }
.pro-overlay-card header { display:flex; align-items:center; }
.pro-overlay-card h2 { flex:1; font-size:13px; margin:0; }
.pro-vp-row { flex-wrap:wrap; gap:6px; }
.pro-strong { font-weight:700; font-size:10px; font-family:ui-monospace,monospace; }
.pro-inline { display:inline-flex; align-items:center; gap:3px; font-size:10px; color:var(--muted); }
.pro-ribbon-group { display:flex; flex-direction:column; gap:2px; }
.pro-ribbon-label { font-size:9px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); text-align:center; }
.pro-ribbon-buttons { display:flex; gap:2px; }
.pro-ribbon-tool { border:1px solid transparent; background:transparent; font-size:11px; padding:3px 7px; border-radius:4px; cursor:pointer; white-space:nowrap; }
.pro-ribbon-tool:hover { background:#f1f5f9; border-color:var(--border); }
.pro-props { position:absolute; top:8px; left:8px; z-index:15; max-width:300px; max-height:calc(100% - 16px); overflow-y:auto; background:rgba(255,255,255,.96); border:1px solid var(--border); border-radius:6px; padding:6px 10px; font-size:11px; line-height:1.5; box-shadow:0 4px 12px rgba(15,23,42,.12); display:none; }
.pro-props::-webkit-scrollbar { width:8px; }
.pro-props::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:4px; }
.pro-props::-webkit-scrollbar-track { background:transparent; }
.pro-props .t { font-weight:700; margin-bottom:2px; }
.pro-props .row { display:flex; gap:10px; justify-content:space-between; }
.pro-props .row .k { color:var(--muted); }
.pro-props .row .v { font-family:ui-monospace,monospace; }
/* CAD-PARITY-004: the professional inspector extension. */
.pro-props .hdr { display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:2px; }
.pro-props .collapse { border:0; background:transparent; cursor:pointer; color:var(--muted); font-size:10px; padding:1px 4px; border-radius:3px; }
.pro-props .collapse:hover { background:#f1f5f9; color:var(--fg); }
.pro-props .sec { font-size:9px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin:7px 0 2px; }
.pro-props .prow { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:1px 0; }
.pro-props .prow .k { color:var(--muted); white-space:nowrap; }
.pro-props .prow .v { font-family:ui-monospace,monospace; font-size:11px; }
.pro-props select { font-size:10px; border:1px solid var(--border); border-radius:3px; background:var(--bg); max-width:150px; padding:1px 2px; }
.pro-props select:disabled { color:#94a3b8; background:#f8fafc; }
.pro-props input[type="color"] { width:26px; height:16px; padding:0; border:1px solid var(--border); border-radius:3px; background:var(--bg); cursor:pointer; }
.pro-props input[type="color"]:disabled { cursor:default; }
.pro-props .mini { border:1px solid var(--border); background:transparent; font-size:9px; border-radius:3px; padding:1px 5px; cursor:pointer; color:var(--muted); }
.pro-props .mini:hover:not(:disabled) { background:#f1f5f9; color:var(--fg); }
.pro-props .mini:disabled { color:#cbd5e1; cursor:default; }
.pro-props .locked { color:#b91c1c; font-size:10px; font-weight:600; }
.pro-props .hint { color:var(--muted); font-size:10px; margin-top:4px; }
.pro-props .swatch { display:inline-block; width:12px; height:12px; border:1px solid var(--border); border-radius:2px; vertical-align:-2px; margin-right:4px; }
/* CAD-PARITY-004: the right dock (Layers manager + Styles manager). */
.pro-model-card .body { display:flex; align-items:stretch; }
.pro-viewport { position:relative; flex:1; min-width:0; }
.pro-dock { display:flex; flex-direction:column; width:320px; max-width:46%; flex-shrink:0; border-left:1px solid var(--border); background:var(--bg); min-height:0; }
.pro-dock.closed { display:none; }
.pro-dock-tabs { display:flex; align-items:stretch; border-bottom:1px solid var(--border); }
.pro-dock-tab { flex:1; border:0; background:transparent; font-size:11px; font-weight:600; padding:5px 4px; cursor:pointer; color:var(--muted); border-bottom:2px solid transparent; }
.pro-dock-tab.active { color:var(--fg); border-bottom-color:var(--fg); }
.pro-dock-tab:hover { background:#f1f5f9; }
.pro-dock-close { border:0; background:transparent; cursor:pointer; color:var(--muted); padding:0 10px; font-size:13px; line-height:1; }
.pro-dock-close:hover { color:var(--fg); }
.pro-dock-body { flex:1; min-height:0; display:flex; flex-direction:column; }
.pro-dock-scroll { overflow-y:auto; }
.pro-dock-scroll::-webkit-scrollbar { width:8px; }
.pro-dock-scroll::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:4px; }
.pro-dock-scroll::-webkit-scrollbar-track { background:transparent; }
.pro-dock .bar { display:flex; align-items:center; gap:4px; padding:6px 8px; border-bottom:1px solid var(--border); }
.pro-dock .bar input[type="text"] { flex:1; min-width:0; border:1px solid var(--border); border-radius:4px; background:var(--bg); font-size:11px; padding:3px 6px; }
.pro-dock .bar input[type="text"]:focus-visible { outline:1px solid #94a3b8; }
.pro-dock .bar select { font-size:10px; border:1px solid var(--border); border-radius:4px; background:var(--bg); padding:3px 2px; }
.pro-dock .iconbtn { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border:1px solid var(--border); border-radius:4px; background:transparent; cursor:pointer; color:var(--fg); flex-shrink:0; }
.pro-dock .iconbtn:hover:not(:disabled) { background:#f1f5f9; }
.pro-dock .iconbtn:disabled { color:#cbd5e1; cursor:default; }
.pro-dock .sec { font-size:9px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); padding:7px 8px 2px; }
.pro-dock .desc { font-size:10px; color:var(--muted); padding:1px 8px 3px; }
.pro-layers-scroll { flex:1; min-height:0; overflow-y:auto; }
.pro-layers-scroll::-webkit-scrollbar { width:8px; }
.pro-layers-scroll::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:4px; }
.pro-layers-scroll::-webkit-scrollbar-track { background:transparent; }
.pro-layers-head, .pro-layer-row { display:grid; grid-template-columns:13px minmax(56px,1fr) 18px 18px 18px 27px 62px 46px 20px; gap:3px; align-items:center; padding:2px 8px; font-size:11px; }
.pro-layers-head { position:sticky; top:0; z-index:1; background:var(--bg); border-bottom:1px solid var(--border); font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
.pro-layer-row:hover { background:#f8fafc; }
.pro-layer-row.active { background:#f1f5f9; font-weight:600; }
.pro-layer-row .name { min-width:0; display:flex; align-items:center; gap:2px; }
.pro-layer-row .name .nm { min-width:0; flex:1; text-align:left; border:0; background:transparent; font-size:11px; cursor:pointer; padding:1px 2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border-radius:3px; color:inherit; font-weight:inherit; }
.pro-layer-row .name .nm:hover:not(:disabled) { background:#e2e8f0; }
.pro-layer-row .name .nm:disabled { color:var(--muted); cursor:default; }
.pro-layer-row .name .unused { font-size:8px; color:#94a3b8; white-space:nowrap; }
.pro-layer-row .name .rename { flex:1; min-width:0; border:1px solid #94a3b8; border-radius:3px; font-size:11px; padding:1px 3px; font-weight:400; }
.pro-layer-row .dot { width:10px; height:10px; border-radius:50%; border:1px solid #94a3b8; background:transparent; cursor:pointer; padding:0; }
.pro-layer-row .dot:disabled { cursor:default; opacity:.4; }
.pro-layer-row.active .dot { background:var(--fg); border-color:var(--fg); }
.pro-layer-row .tgl { border:0; background:transparent; cursor:pointer; color:#94a3b8; padding:1px; display:inline-flex; align-items:center; justify-content:center; border-radius:3px; font-size:10px; }
.pro-layer-row .tgl:hover:not(:disabled) { background:#e2e8f0; color:var(--fg); }
.pro-layer-row .tgl:disabled { opacity:.3; cursor:default; }
.pro-layer-row .tgl.on { color:var(--fg); }
.pro-layer-row .tgl.warn { color:#b45309; }
.pro-layer-row input[type="color"] { width:25px; height:16px; padding:0; border:1px solid var(--border); border-radius:3px; background:var(--bg); cursor:pointer; }
.pro-layer-row select { font-size:9px; border:1px solid var(--border); border-radius:3px; background:var(--bg); max-width:100%; padding:1px 0px; }
.pro-dock .empty { padding:8px 10px; font-size:11px; color:var(--muted); }
.pro-states { border-top:1px solid var(--border); }
.pro-states .head { display:flex; align-items:center; gap:4px; width:100%; border:0; background:transparent; font-size:9px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); padding:5px 8px; cursor:pointer; }
.pro-states .head:hover { background:#f8fafc; color:var(--fg); }
.pro-states .body { max-height:150px; overflow-y:auto; padding:2px 8px 6px; }
.pro-states .body::-webkit-scrollbar { width:8px; }
.pro-states .body::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:4px; }
.pro-state-row { display:flex; align-items:center; gap:4px; font-size:11px; padding:1px 0; border-radius:3px; }
.pro-state-row:hover { background:#f8fafc; }
.pro-state-row .nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,monospace; }
.pro-state-row .cnt { font-size:9px; color:var(--muted); white-space:nowrap; }
.pro-style-row { display:flex; align-items:center; gap:4px; padding:2px 8px; font-size:11px; border-radius:3px; }
.pro-style-row:hover { background:#f8fafc; }
.pro-style-row .nm { width:72px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pro-style-row input, .pro-style-row select { font-size:10px; border:1px solid var(--border); border-radius:3px; background:var(--bg); padding:1px 2px; width:44px; }
.pro-style-row input.num { text-align:right; font-family:ui-monospace,monospace; }
.pro-style-row .ltsample { color:var(--fg); flex-shrink:0; display:inline-flex; }
.pro-style-row .built-in { font-size:8px; color:#94a3b8; border:1px solid var(--border); border-radius:3px; padding:0 3px; white-space:nowrap; }
.pro-style-row .grow { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pro-style-row .muted { color:var(--muted); font-size:9px; }
/* CAD-PARITY-004: the idle-canvas context menu. */
.pro-ctx-backdrop { position:fixed; inset:0; z-index:90; }
.pro-ctx-menu { position:fixed; z-index:91; min-width:200px; background:var(--bg); border:1px solid var(--border); border-radius:6px; box-shadow:0 8px 24px rgba(15,23,42,.16); padding:4px 0; display:flex; flex-direction:column; }
.pro-ctx-head { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); padding:4px 12px 3px; }
.pro-ctx-item { display:block; width:100%; text-align:left; border:0; background:transparent; font-size:12px; padding:5px 12px; cursor:pointer; color:var(--fg); }
.pro-ctx-item:hover:not(:disabled) { background:#f1f5f9; }
.pro-ctx-item:disabled { color:#94a3b8; cursor:default; }
.pro-ctx-sep { border-top:1px solid var(--border); margin:4px 0; }
/* CAD-PARITY-004: the status-bar active-layer link. */
.pro-statusbar .layerlink { border:0; background:transparent; font-size:11px; font-weight:600; cursor:pointer; padding:1px 5px; border-radius:3px; color:var(--fg); }
.pro-statusbar .layerlink:hover { background:#f1f5f9; }
/* CAD-PARITY-005: the annotation inspector editors (text/number inputs,
   multi-line content) + the Annotate ribbon tools (icon + label) + the
   wrap-aware dim-style rows (arrowStyle/unitSuffix join the numeric fields). */
.pro-props .prow input[type="text"], .pro-props .prow input[type="number"] { font-size:10px; border:1px solid var(--border); border-radius:3px; background:var(--bg); padding:1px 4px; width:132px; font-family:ui-monospace,monospace; }
.pro-props .prow input[type="number"] { text-align:right; width:64px; }
.pro-props textarea { font-size:10px; border:1px solid var(--border); border-radius:3px; background:var(--bg); padding:1px 4px; width:150px; height:auto; resize:vertical; font-family:ui-monospace,monospace; display:block; }
.pro-props .prow input:disabled, .pro-props textarea:disabled { color:#94a3b8; background:#f8fafc; }
.pro-props .prow .v.measure { font-weight:600; }
.pro-ribbon-tool { display:inline-flex; align-items:center; gap:4px; }
.pro-ribbon-tool svg { flex-shrink:0; }
.pro-style-row.dimrow { flex-wrap:wrap; row-gap:2px; }
/* CAD-PARITY-006: the Blocks & References manager rows + the xref status
   badges (the 004 manager-row conventions, extended). */
.pro-block-row { display:flex; align-items:center; gap:4px; padding:2px 8px; font-size:11px; border-radius:3px; }
.pro-block-row:hover { background:#f8fafc; }
.pro-block-row .nm { width:72px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
.pro-block-row .grow { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pro-block-row .muted { color:var(--muted); font-size:9px; }
.pro-block-row .tgl { border:0; background:transparent; cursor:pointer; color:#94a3b8; padding:1px 4px; display:inline-flex; align-items:center; justify-content:center; border-radius:3px; font-size:10px; }
.pro-block-row .tgl:hover:not(:disabled) { background:#e2e8f0; color:var(--fg); }
.pro-block-row .tgl:disabled { opacity:.3; cursor:default; }
.pro-block-row button.attach { border:1px solid var(--border); border-radius:4px; background:transparent; cursor:pointer; font-size:10px; padding:3px 6px; }
.pro-block-row button.attach:hover { background:#f1f5f9; }
.pro-xref-badge { font-size:9px; font-weight:700; letter-spacing:.03em; border-radius:3px; padding:0 4px; border:1px solid; white-space:nowrap; flex-shrink:0; }
.pro-xref-badge.loaded { color:#15803d; border-color:#86efac; background:#f0fdf4; }
.pro-xref-badge.unresolved { color:#b45309; border-color:#fcd34d; background:#fffbeb; }
`;

/** Public driver surface (used by test/smoke-workspace.mjs — the SAME code
 *  paths the real input/canvas handlers use). */
export interface ProfessionalDriver {
  typedInput(text: string): Promise<void>;
  /** CAD-PARITY-008 (Issue #88): the paper-space surface — the space
   *  context, the paper canvas info, the plot preview + the deterministic
   *  plot exports (the SAME commands the UI runs; the smoke asserts the
   *  artifacts byte-identically against the Web host). */
  space(): "model" | "paper";
  setActiveSpace(next: "model" | "paper"): void;
  paperInfo(): { space: "model" | "paper"; layoutName: string | null; viewportCount: number; selectedViewportId: string | null };
  openPlotPreview(): Promise<void>;
  exportPlot(layoutName: string, format: "svg" | "pdf" | "plot-ir"): Promise<{ ok: boolean; sha256?: string; size?: number; message?: string }>;
  selectViewport(id: string | null): void;
  pressEnter(): Promise<void>;
  pressEscape(): Promise<void>;
  pickPoint(x: number, y: number): Promise<void>;
  /** COMPAT-CAD-007 (Issue #142): dispatch a WINDOW/CROSSING batch of object
   *  picks through the SAME engine dispatch path the svg mouseup handler
   *  runs after the shared command-select resolution (the semantic stream:
   *  dispatchEngine({type:"entities"}) → engine → plan → App API). */
  pickEntities(ids: readonly string[]): Promise<void>;
  setSelection(ids: string[]): Promise<void>;
  /** CAD-PARITY-011 (Issue #97): set the ACTIVE STORY (the Navigator's
   *  story context for BIM authoring commands — the same state the UI sets
   *  when a story is created or picked; the smoke drives it explicitly to
   *  reproduce the pinned stream's story switching). */
  setActiveStory(id: string | null): void;
  refresh(): Promise<void>;
  commandLog(): string[];
  /** CAD-PARITY-009 (Issue #90): the 3D Model view surface — the view
   *  switch (the 3D tab's code path), the rendered state readout, the
   *  canonical scene SVG string (the SHARED writer's exact output — the
   *  smoke hashes it against the Web parity fixture) and the engine echo
   *  lines (the same lines the Web host's runCommandScript collects). */
  setModel3dView(active: boolean): void;
  model3dInfo(): { active: boolean; info: string; ucsOptions: string[]; solidCount: number; sceneFormat: string | null };
  model3dSceneSvg(selectedIds: readonly string[], withSectionFacets: boolean): Promise<string | null>;
  /** CAD-PARITY-010 (Issue #93): the EXACT-section scene — the canonical
   *  scene with the adapter-backed canonical section LOOPS as the section
   *  facets (the same input shape the Web P010 smoke builds through the
   *  shared barrel; each loop is one facet polygon) — and the shared
   *  projectPoint over the persisted camera (the sub-entity pick screen
   *  point, the SAME core the viewport consumes — no duplicated math). */
  model3dExactSectionSvg(selectedIds: readonly string[]): Promise<string | null>;
  model3dProjectPoint(point: readonly [number, number, number]): Promise<{ x: number; y: number } | null>;
  echoLog(): string[];
  /** CAD-PARITY-003: the current view transform (pan/zoom) — the driver the
   *  smoke uses to compute synthetic canvas clicks at world points through
   * the SAME screen mapping the real pointer handler applies. */
  viewTransform(): { pan: { x: number; y: number }; zoom: number; width: number; height: number };
  status(): {
    prompt: string | null;
    commandName: string | null;
    history: string[];
    selection: string[];
    elementCount: number;
    aids: DraftingAids;
  };
}

export function mountProfessionalWorkspace(opts: ProfessionalOptions): ProfessionalDriver {
  const style = h("style");
  style.textContent = PRO_CSS;
  document.head.append(style);

  const state: ProState = {
    snapshot: null,
    selection: [],
    engine: IDLE_PROMPT_STATE,
    history: [],
    aids: { ...DEFAULT_DRAFTING_AIDS },
    activeLayer: "0",
    activeStoryId: null,
    pan: { x: -20, y: -20 },
    zoom: 0.14,
    cursor: null,
    busy: false,
    paletteOpen: false,
  };

  // --- CAD-PARITY-004 local UI state (host-local, LOCK-015 non-authoritative) ---
  // Dock/tab visibility, the Layers manager filter + editing state and the
  // panel input drafts. Survives re-renders (the panels rebuild on every
  // refresh; input values restore from these).
  let dockOpen = true;
  let dockTab: "layers" | "styles" | "blocks" | "constraints" | "layouts" = "layers";
  // CAD-PARITY-008 (Issue #88): the paper-space editor context — the host
  // view switches between the Model canvas and the ACTIVE layout's paper
  // canvas (the layout.activate / layout.setSpace commands drive it through
  // executePlan's space.model/space.paper ui actions; LOCK-015 host-local
  // view state, the Web host's Layout tab mirror).
  let space: "model" | "paper" = "model";
  let selectedViewportId: string | null = null;
  // CAD-PARITY-009 (Issue #90): the 3D Model view — a host-local VIEW mode
  // beside the Model/paper canvases (LOCK-015; the Web host's "3D" view tab
  // mirror). While active, the model card paints the canonical 3D scene
  // through the SHARED model3d core and the 3D toolbar (standard views, Fit,
  // the UCS dropdown, quick shapes) is visible.
  let model3dView = false;
  let model3dLiveCamera: Camera3DState | null = null;
  let model3dSceneString: string | null = null;
  // CAD-PARITY-010 (Issue #93): the EXACT-section overlay state — the
  // adapter-backed canonical section loops rendered as the 3D scene's
  // section facets (a viewport-only layer; SECTIONEXACT sets it, the Web
  // host's Exact Section toggle mirrors it).
  let model3dExactFacets: readonly { elementId: string; polygon: readonly number[] }[] | null = null;
  let model3dDrag: { kind: "orbit" | "pan"; x: number; y: number } | null = null;
  let model3dWheelTimer: ReturnType<typeof setTimeout> | null = null;
  let layerFilterText = "";
  let layerFilterMode: LayerFilterMode = "all";
  let layerStatesOpen = false;
  let editingLayerId: string | null = null;
  let newLayerName = "";
  let newStateName = "";
  let newLtypeName = "";
  let newLtypePattern = "8,4";
  let newTextStyleName = "";
  let newDimStyleName = "";
  let propsCollapsed = false;

  // --- transport helpers -----------------------------------------------------

  const commandLog: string[] = [];
  // CAD-PARITY-009: the ENGINE echo lines (the prompt engine's own output —
  // exactly what the Web host's runCommandScript collects; host-side lines
  // like *ERROR* echoes are NOT part of it). The smoke digests this for the
  // Web/Electron semantic-parity evidence.
  const echoLog: string[] = [];
  const command = (name: string, payload: unknown): Promise<CommandQueryResponse> => {
    commandLog.push(name);
    return opts.send({ type: "command", name: name as Command["name"], payload });
  };
  const query = (name: string, payload: unknown = {}): Promise<CommandQueryResponse> =>
    opts.send({ type: "query", name: name as Query["name"], payload });

  async function refresh(): Promise<void> {
    const [stateRes, selRes] = await Promise.all([query("document.getState"), query("document.getSelection")]);
    if (stateRes.ok) state.snapshot = stateRes.value as CADDocumentSnapshot;
    if (selRes.ok && Array.isArray(selRes.value)) state.selection = selRes.value as string[];
    const layers = state.snapshot?.layers ?? [];
    // CAD-PARITY-004: the ACTIVE layer is persisted document editor state
    // (draftingSettings.activeLayer — CLAYER class; the same resolution the
    // Web host runs). Falls back to the first existing layer when the
    // persisted id is stale; switched ONLY through layer.setActive.
    const persisted = state.snapshot?.draftingSettings?.activeLayer;
    if (persisted !== undefined && layers.some((l: LayerRecord) => l.id === persisted)) {
      state.activeLayer = persisted;
    } else if (!layers.some((l: LayerRecord) => l.id === state.activeLayer)) {
      state.activeLayer = layers[0]?.id ?? "0";
    }
    if (state.activeStoryId === null) {
      const story = (state.snapshot?.elements ?? []).find(
        (el) => el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.story",
      );
      if (story !== undefined) state.activeStoryId = story.id;
    }
    renderLayoutTabs();
    renderModel();
    renderCommandLine();
    renderStatusBar();
    renderDock();
    opts.onLegacyRefresh();
  }

  // --- engine context + plan execution -----------------------------------------

  function engineContext(): CommandContext {
    const elements = state.snapshot?.elements ?? [];
    const stories = elements.filter((el) => el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.story");
    return defaultCommandContext({
      activeLayer: state.activeLayer,
      activeStoryId:
        state.activeStoryId ?? (stories.length > 0 ? (stories[stories.length - 1] as Element).id : null),
      elementCount: elements.length,
      storyCount: stories.length,
      currentSelection: elements
        .filter((el) => state.selection.includes(el.id))
        .map((el) => ({ id: el.id, kind: el.kind, props: el.props as Record<string, unknown> })),
      // COMPAT-CAD-007 (Issue #142): the document's live elements — the
      // deterministic ALL/LAST resolution surface for "Select objects:"
      // prompts (the SAME snapshot state the Web context passes; LOCK-004).
      documentElements: elements,
      // CAD-PARITY-004: the document layer table — the -LAYER / CHPROP /
      // LAYERSTATE builders resolve layer NAMES through it (name resolution,
      // LAYON batching; empty on snapshots without layers).
      layers: state.snapshot?.layers ?? [],
      // CAD-PARITY-005: the user style tables + the current style names
      // (TEXT/MTEXT resolve style-fixed heights; every annotation command
      // stamps ctx.currentTextStyle / ctx.currentDimStyle — the SAME
      // persisted editor state the Web shell passes).
      textStyles: state.snapshot?.textStyles ?? [],
      dimStyles: state.snapshot?.dimStyles ?? [],
      currentTextStyle: state.snapshot?.draftingSettings?.textStyle ?? "Standard",
      currentDimStyle: state.snapshot?.draftingSettings?.dimStyle ?? "Standard",
      // CAD-PARITY-006: the document block-definition + external-reference
      // tables — BLOCK/INSERT/ATTDEF/ATTEDIT resolve names and build the
      // dynamic attribute prompts; XATTACH/XDETACH/XLIST/XREF surface the
      // reference table (the SAME snapshot fields the Web context passes).
      blocks: state.snapshot?.blockDefs ?? [],
      xrefs: state.snapshot?.xrefs ?? [],
      // CAD-PARITY-007: the declared constraint graph (CONSTRAINTLIST /
      // DELCONSTRAINT builders — the SAME document state the Web host
      // passes; LOCK-004 parity).
      constraints: state.snapshot?.constraints ?? [],
      // CAD-PARITY-008: the paper-space layout/viewport tables + the
      // TILEMODE-class context (the SAME document state the Web host passes).
      layouts: state.snapshot?.layouts ?? [],
      viewports: state.snapshot?.viewports ?? [],
      activeLayoutId: state.snapshot?.draftingSettings?.activeLayout ?? state.snapshot?.layouts?.[0]?.id ?? null,
      space: state.snapshot?.draftingSettings?.space ?? "model",
      // CAD-PARITY-009 (Issue #90): the named-UCS table + the active workplane
      // + the persisted 3D camera + the solid count (the SAME snapshot
      // fields the Web host passes — the UCS/model3d builders resolve
      // through them; LOCK-004 parity).
      ucs: state.snapshot?.ucs ?? [],
      activeUcsId: state.snapshot?.draftingSettings?.activeUcs ?? "world",
      view3d: state.snapshot?.draftingSettings?.view3d ?? null,
      model3dSolidCount: (state.snapshot?.elements ?? []).filter(
        (el) => (el.props as Record<string, unknown> | null)?.type === "model3d.solid",
      ).length,
    });
  }

  // COMPAT-CAD-005: authoritative snapshot adoption — the mirror of the Web
  // shell's adoptSnapshot. Successful commands that return a post-commit
  // snapshot adopt it immediately (version-monotonic guard: a stale response
  // never rolls the renderer back), closing the stale-context window between
  // commit and refresh (DEF-001/002 layer-identity desync).
  function adoptSnapshot(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const next = value as CADDocumentSnapshot;
    if (typeof next?.version?.version_number !== "number" || !Array.isArray(next?.layers)) return;
    const current = state.snapshot;
    if (current !== null && next.version.version_number < current.version.version_number) return;
    state.snapshot = next;
  }

  async function executePlan(plan: CommandPlan, deferredEcho: readonly string[] = []): Promise<boolean> {
    // COMPAT-CAD-005: COMMIT-AUTHORITATIVE plan execution (the Web host's
    // mirror): a failed App API entry is THE one authoritative failure —
    // *ERROR* line, abort of the remaining entries, SUPPRESSED outcome
    // echoes (no success claim before or after a rejected transaction —
    // CAD-BENCH-RW-001 DEF-027); every successful entry's snapshot is
    // adopted immediately.
    let failed = false;
    for (const entry of plan.appApi) {
      state.busy = true;
      const res = await command(entry.name, entry.payload);
      if (!res.ok) {
        pushLines([`*ERROR* ${entry.name}: ${res.code} — ${res.message}`]);
        failed = true;
        state.busy = false;
        break;
      }
      adoptSnapshot((res.value as { snapshot?: CADDocumentSnapshot } | null)?.snapshot);
      if (entry.name === "bim.createElements") {
        const value = res.value as { created?: string[] } | null;
        if (value !== null && Array.isArray(value.created) && value.created.length > 0) {
          const stateRes = await query("document.getState");
          if (stateRes.ok) {
            const snap = stateRes.value as CADDocumentSnapshot;
            const story = (snap.elements ?? []).find(
              (el) => value.created!.includes(el.id) && el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.story",
            );
            if (story !== undefined) state.activeStoryId = story.id;
          }
        }
      } else if (entry.name === "plot.export" || entry.name === "plot.publish") {
        // CAD-PARITY-008: PLOT/PUBLISH deliver the deterministic artifact —
        // save through the main-process dialog (the Web host downloads; the
        // SAME App API command produces the SAME bytes on both hosts).
        const value = res.value as {
          format?: string; text?: string; bytesBase64?: string; sha256?: string;
          layoutName?: string; pageCount?: number;
        };
        const ext = value.format === "pdf" ? "pdf" : value.format === "svg" ? "svg" : "json";
        const base = (value.layoutName ?? "layouts").replace(/\s+/g, "-").toLowerCase();
        const defaultPath = `offisos-${base}${value.pageCount !== undefined && value.pageCount > 1 ? "-set" : ""}.${ext}`;
        const payload: { text?: string; bytesBase64?: string } =
          value.bytesBase64 !== undefined ? { bytesBase64: value.bytesBase64 } : { text: value.text ?? "" };
        if (opts.pickSaveFile !== undefined) {
          const saved = await opts.pickSaveFile(defaultPath, payload);
          if (saved.status === "saved") {
            pushLines([`PLOT: ${value.pageCount !== undefined && value.pageCount > 1 ? `${value.pageCount} layouts published` : (value.layoutName ?? "layout")} as ${(value.format ?? "?").toUpperCase()} — saved (${saved.size} bytes, sha256 ${(value.sha256 ?? "").slice(0, 12)}…).`]);
          } else if (saved.status === "error") {
            pushLines([`*ERROR* plot save: ${saved.message}`]);
          }
        } else {
          pushLines([`PLOT: ${(value.format ?? "?").toUpperCase()} artifact ready (sha256 ${(value.sha256 ?? "").slice(0, 12)}…) — no save dialog bridge on this host.`]);
        }
      }
      state.busy = false;
    }
    for (const action of plan.ui) {
      switch (action.action) {
        case "toggle.ortho":
          state.aids = { ...state.aids, ortho: !state.aids.ortho };
          break;
        case "toggle.polar":
          state.aids = { ...state.aids, polar: !state.aids.polar };
          break;
        case "toggle.otrack":
          state.aids = { ...state.aids, otrack: !state.aids.otrack };
          break;
        case "toggle.grid":
        case "toggle.snap": {
          const key = action.action === "toggle.grid" ? "grid" : "snap";
          const settings = state.snapshot?.draftingSettings;
          const enabled = key === "grid" ? !(settings?.grid.enabled ?? true) : !(settings?.snap.enabled ?? true);
          await command("drafting.setSettings", { settings: { [key]: { enabled } } });
          break;
        }
        case "view.zoomExtents":
          zoomExtents();
          break;
        // COMPAT-CAD-006 (Issue #138): the navigation vocabulary — the
        // ZOOM/PAN/REGEN builders emit these ui actions; both hosts
        // translate them through the SAME shared view module (the Web
        // shell's navigate() mirror).
        case "view.zoomWindow": {
          const payload = (action.payload as { corner1?: [number, number]; corner2?: [number, number] } | undefined) ?? undefined;
          if (
            payload !== undefined && Array.isArray(payload.corner1) && Array.isArray(payload.corner2) &&
            payload.corner1.length === 2 && payload.corner2.length === 2
          ) {
            applyNavigation({ kind: "zoomWindow", corner1: [payload.corner1[0]!, payload.corner1[1]!], corner2: [payload.corner2[0]!, payload.corner2[1]!] });
          }
          break;
        }
        case "view.zoomScale": {
          const payload = (action.payload as { factor?: number; relative?: boolean } | undefined) ?? undefined;
          if (payload !== undefined && typeof payload.factor === "number" && Number.isFinite(payload.factor)) {
            applyNavigation({ kind: "zoomScale", factor: payload.factor, relative: payload.relative === true });
          }
          break;
        }
        case "view.pan": {
          const payload = (action.payload as { delta?: [number, number] } | undefined) ?? undefined;
          if (payload !== undefined && Array.isArray(payload.delta) && payload.delta.length === 2) {
            applyNavigation({ kind: "pan", delta: [payload.delta[0]!, payload.delta[1]!] });
          }
          break;
        }
        case "view.zoomPrevious":
          applyNavigation({ kind: "zoomPrevious" });
          break;
        case "view.regen":
          applyNavigation({ kind: "regen" });
          break;
        // CAD-PARITY-008 (Issue #88): the paper-space context switches + the
        // plot preview surface (host-local view state, LOCK-015 — the Web
        // host's Layout view mirror).
        case "space.model":
          space = "model";
          renderLayoutTabs();
          break;
        case "space.paper":
          space = "paper";
          renderLayoutTabs();
          break;
        // CAD-PARITY-009 (Issue #90): the 3D Model view switch (host-local
        // view state, LOCK-015 — the Web host's 3D view mirror; the
        // UCS/VPOINT/ZOOM3D/3DSTATE commands hint it).
        case "view.model3d":
          setModel3dView(true);
          break;
        // CAD-PARITY-010 (Issue #93): the exact-section overlay — SECTIONEXACT
        // switches to the 3D view and renders the canonical scene with the
        // adapter-backed section loops (a typed engine decline shows no
        // overlay — never an approximation presented as exact).
        case "query.sectionExact": {
          setModel3dView(true);
          const planeName = (action.payload as { planeName?: string } | undefined)?.planeName;
          const res = await query("model3d.section", planeName === undefined ? {} : { name: planeName });
          if (res.ok) {
            const section = (res.value as { section?: { facets?: readonly { elementId: string; loops: readonly (readonly number[])[] }[] } | null }).section;
            model3dExactFacets = (section?.facets ?? []).flatMap((facet) =>
              facet.loops.map((loop) => ({ elementId: facet.elementId, polygon: loop })),
            );
          } else {
            model3dExactFacets = null;
          }
          break;
        }
        case "plot.preview":
          openPlotPreview();
          break;
        case "plot.download":
          // The artifact already saved inline with the plot.export /
          // plot.publish response (see the appApi loop above).
          break;
        case "selection.clear":
          await command("document.setSelection", { ids: [] });
          state.selection = [];
          break;
        case "selection.selectAll": {
          // COMPAT-CAD-005: compute from the AUTHORITATIVE document state (a
          // fresh getState — not the possibly stale state.snapshot), adopt it,
          // and adopt the server's effective (live-pruned) selection — the
          // Web host's mirror (CAD-BENCH-RW-001 DEF-014 phantom counts).
          const stateRes = await query("document.getState");
          if (!stateRes.ok) {
            pushLines([`*ERROR* document.getState: ${stateRes.code} — ${stateRes.message}`]);
            failed = true;
            break;
          }
          const fresh = stateRes.value as CADDocumentSnapshot;
          state.snapshot = fresh;
          const visible = new Set((fresh.layers ?? []).filter((l: LayerRecord) => l.visible).map((l: LayerRecord) => l.id));
          const ids = (fresh.elements ?? [])
            .filter((el) => {
              const props = el.props as Record<string, unknown>;
              if (el.kind === "bim") return props.type === "bim.wall" || props.type === "bim.slab";
              return typeof props.layer === "string" && visible.has(props.layer);
            })
            .map((el) => el.id);
          const selRes = await command("document.setSelection", { ids });
          if (selRes.ok) {
            const eff = (selRes.value as { selection?: string[] } | null)?.selection;
            state.selection = Array.isArray(eff) ? eff : ids;
          } else {
            state.selection = ids;
          }
          break;
        }
        case "file.new": {
          // COMPAT-CAD-005: NEW is a FULL editor-session reset driven by the
          // canonical create response (the Web host's mirror — DEF-003/
          // DEF-014): adopt the fresh snapshot, clear the selection, the
          // active story, the transient command state and the canvas view.
          const res = await command("document.create", { entityId: `electron-workspace-${Date.now().toString(36)}` });
          if (!res.ok) {
            failed = true;
            break;
          }
          const snap = res.value as CADDocumentSnapshot;
          if (typeof snap?.version?.version_number === "number") {
            state.snapshot = snap;
            state.selection = [];
            state.activeStoryId = null;
            state.pan = { x: -20, y: -20 };
            state.zoom = 0.14;
            if (state.engine.commandId !== null) {
              state.engine = IDLE_PROMPT_STATE;
              pushLines(["*Cancel*"]);
            }
            renderModel();
          }
          break;
        }
        case "file.save": {
          const res = await command("document.save", {});
          if (res.ok) pushLines(["SAVE: document saved through the App API."]);
          break;
        }
        case "toggle.lweight": {
          // CAD-PARITY-004: LWEIGHT — the lineweight display toggle (persisted
          // drafting setting; identical on both hosts).
          const settings = state.snapshot?.draftingSettings;
          await command("drafting.setSettings", { settings: { lineweightDisplay: !(settings?.lineweightDisplay ?? false) } });
          break;
        }
        case "palette.show": {
          const palette = (action.payload as { palette?: string } | undefined)?.palette;
          if (palette === "search") openPalette(true);
          else if (palette === "linetypes" || palette === "textStyles" || palette === "dimStyles") {
            // CAD-PARITY-004: the style managers (LTYPE/STYLE/DIMSTYLE).
            openDock("styles");
          } else if (palette === "layerStates") {
            // CAD-PARITY-004: LAYERSTATE — the states section of the Layers
            // manager (expanded on open).
            layerStatesOpen = true;
            openDock("layers");
          } else if (palette === "layers") {
            // CAD-PARITY-004: LAYER — the Layers manager (right dock).
            openDock("layers");
          } else if (palette === "blocks") {
            // CAD-PARITY-006: XREF — the Blocks & References manager (the
            // definitions list + the external-reference table).
            openDock("blocks");
          } else if (palette === "constraints") {
            // CAD-PARITY-007: CONSTRAINTS — the parametric manager (live
            // diagnostics, dimensional value editing, removal).
            openDock("constraints");
          } else if (palette === "layouts") {
            // CAD-PARITY-008: LAYOUT/VPORTS — the layouts manager (the layout
            // table, page setup, viewport scale/rotation/lock + the
            // per-viewport layer visibility).
            openDock("layouts");
          } else if (palette === "properties") {
            // CAD-PARITY-004: PROPERTIES — the professional inspector overlay.
            showInspector();
          } else if (palette === "navigator") {
            pushLines(["NAVIGATOR palette: available in the Web host dock; Electron keeps the legacy side panels."]);
          }
          break;
        }
        default:
          break;
      }
    }
    await refresh();
    // COMPAT-CAD-005: the deferred outcome echoes print ONLY after every
    // plan entry (App API + ui actions) committed — the commit-authoritative
    // feedback channel (DEF-027; the Web host's mirror).
    if (!failed && deferredEcho.length > 0) pushLines(deferredEcho);
    return !failed;
  }

  function pushLines(lines: readonly string[]): void {
    state.history = [...state.history, ...lines];
    renderCommandLine();
  }

  /** CAD-PARITY-004: commit one App API command from a panel/inspector editor
   *  (typed failures surface in the command-line history) + refresh. */
  function commitCommand(name: string, payload: unknown): void {
    void (async () => {
      const res = await command(name, payload);
      if (!res.ok) pushLines([`*ERROR* ${name}: ${res.code} — ${res.message}`]);
      await refresh();
    })();
  }

  async function dispatchEngine(event: Parameters<typeof applyPromptEvent>[1]): Promise<void> {
    const result = applyPromptEvent(state.engine, event, engineContext());
    state.engine = result.state;
    // CAD-PARITY-009: accumulate the ENGINE echo lines (the parity record —
    // identical to the Web host's runCommandScript lines for the same events).
    for (const line of result.output.lines) echoLog.push(line);
    // COMPAT-CAD-005: interactive echoes render immediately; the plan's
    // OUTCOME claims are deferred until every plan entry commits (the Web
    // host's splitEchoTiming mirror — DEF-027). echoLog keeps the FULL
    // engine output (the parity record is the engine's own output, not the
    // host's render timing).
    const { interactive, deferred } = splitEchoTiming(result.output.lines, result.output.plan);
    if (interactive.length > 0) pushLines(interactive);
    renderCommandLine();
    renderModel();
    if (result.output.plan !== null) await executePlan(result.output.plan, deferred);
  }

  async function startCommand(commandId: string): Promise<void> {
    await dispatchEngine({ type: "start", commandId });
  }

  // --- menu bar -------------------------------------------------------------------

  const menuBar = h("div", "pro-menubar");
  menuBar.setAttribute("role", "menubar");
  menuBar.setAttribute("aria-label", "application menu");
  const brand = h("span", "brand");
  brand.textContent = "Offisos";
  menuBar.append(brand);

  interface MenuEntry {
    readonly label: string;
    readonly run: () => void;
  }

  interface MenuSpec {
    label: string;
    /** CAD-PARITY-005: entries, or separators ({ sep: true }). */
    items: readonly (MenuEntry | { readonly sep: true })[];
  }
  const setDraftingMode = (): void => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="mode-drafting"]');
    if (btn !== null) btn.click();
  };
  const setBimMode = (): void => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="mode-bim"]');
    if (btn !== null) btn.click();
  };
  const setDocsMode = (): void => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="mode-docs"]');
    if (btn !== null) btn.click();
  };
  const setIfcMode = (): void => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="mode-ifc"]');
    if (btn !== null) btn.click();
  };
  const setComponentsMode = (): void => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="mode-components"]');
    if (btn !== null) btn.click();
  };
  const runCmd = (id: string) => (): void => {
    void startCommand(id);
  };

  // CAD-PARITY-005 (Issue #82): the annotation tool glyphs — 12×12 line
  // icons (currentColor strokes, the SAME single-path convention as the dock
  // ICON set below) mirroring the Web ribbon's lucide choices: Type (text),
  // Text (mtext), Ruler (dimlinear), MoveHorizontal (dimaligned), Circle
  // (dimradius), CircleDashed (dimdiameter), Compass (dimangular),
  // ArrowUpRight (leader), MessageSquareText (mleader), TextCursorInput
  // (dimtedit), Scaling (dimscale).
  const ANNOTATION_ICONS: Readonly<Record<string, () => SVGElement>> = {
    text: () => icon("M2 2 h8 M6 2 v8"),
    mtext: () => icon("M2 2.2 h8 M2 5.5 h6 M2 8.8 h4"),
    dimlinear: () => icon("M1.6 8.2 L8.2 1.6 L10.4 3.8 L3.8 10.4 Z M3.4 6.4 l1.2 1.2 M5.2 4.6 l1.2 1.2 M7 2.8 l1.2 1.2"),
    dimaligned: () => icon("M1 6 h10 M3.2 3.8 L1 6 l2.2 2.2 M8.8 3.8 L11 6 l-2.2 2.2"),
    dimradius: () => icon("M6 6 m-4.2 0 a4.2 4.2 0 1 0 8.4 0 a4.2 4.2 0 1 0 -8.4 0 M6 6 L9.2 2.8"),
    dimdiameter: () => icon("M6 6 m-4.2 0 a4.2 4.2 0 1 0 8.4 0 a4.2 4.2 0 1 0 -8.4 0 M1.8 6 h8.4"),
    dimangular: () => icon("M6 6 m-4.5 0 a4.5 4.5 0 1 0 9 0 a4.5 4.5 0 1 0 -9 0 M6 6 L8.8 3.2 M6 6 v-4.5"),
    leader: () => icon("M2.5 9.5 L9.5 2.5 M9.5 2.5 h-4 M9.5 2.5 v4"),
    mleader: () => icon("M1.5 2.5 h9 v5.5 h-5.5 l-1.8 1.8 v-1.8 h-1.7 Z M4 4.8 h4 M4 6.3 h2.4"),
    dimtedit: () => icon("M4.5 1.5 h3 M4.5 10.5 h3 M6 1.5 v9 M3 3 h1 M3 9 h1 M8 3 h1 M8 9 h1"),
    dimscale: () => icon("M2 10 L7 5 M2 10 v-3 M2 10 h3 M10 2 L5 7 M10 2 v3 M10 2 h-3"),
  };

  // CAD-PARITY-006 (Issue #84): the blocks/references tool glyphs — the same
  // 12×12 single-path line-icon convention (nested squares = a definition,
  // the arrow-into-frame = insert, the pencil = attribute editing, the
  // plus/x-boxes = attach/detach, the overlapping sheets = the references
  // manager, the list rows = the inventory queries).
  const BLOCK_ICONS: Readonly<Record<string, () => SVGElement>> = {
    block: () => icon("M1.8 1.8 h8.4 v8.4 h-8.4 Z M4.4 4.4 h3.2 v3.2 h-3.2 Z"),
    insert: () => icon("M7.2 1.8 h3 v8.4 h-3 M1.6 6 h4.4 M4.2 4 L1.6 6 L4.2 8"),
    attdef: () => icon("M2.2 1.8 v8.4 M5 4.2 h4.8 M5 7.8 h3"),
    attedit: () => icon("M2.2 9.8 L3.1 7.4 L8.4 2.1 L9.9 3.6 L4.6 8.9 Z"),
    xattach: () => icon("M1.8 3 h8.4 v7.2 h-8.4 Z M6 4.6 v3.6 M4.2 6.4 h3.6"),
    xdetach: () => icon("M1.8 3 h8.4 v7.2 h-8.4 Z M4.4 4.9 l3.2 3.2 M7.6 4.9 L4.4 8.1"),
    xref: () => icon("M2.5 3 h5.5 v6.5 h-5.5 Z M4.5 1.5 h5 v6.5"),
    xlist: () => icon("M2 3 h1.6 M4.8 3 H10 M2 6 h1.6 M4.8 6 H10 M2 9 h1.6 M4.8 9 H10"),
    blocklist: () => icon("M1.8 2.2 h8.4 v7.6 h-8.4 Z M4 5 h4 M4 7 h2.4"),
  };

  const menus: readonly MenuSpec[] = [
    {
      label: "File",
      items: [
        { label: "New", run: () => void command("document.create", { entityId: `electron-workspace-${Date.now().toString(36)}` }).then(refresh) },
        { label: "Save", run: runCmd("save") },
        { label: "Undo", run: runCmd("undo") },
        { label: "Redo", run: runCmd("redo") },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", run: runCmd("undo") },
        { label: "Redo", run: runCmd("redo") },
        { label: "Erase selection", run: runCmd("erase") },
        { label: "Select all", run: runCmd("selectall") },
        { label: "Deselect", run: runCmd("cancel") },
      ],
    },
    {
      label: "View",
      items: [
        { label: "Drafting (Model)", run: setDraftingMode },
        { label: "BIM", run: setBimMode },
        { label: "Documentation", run: setDocsMode },
        { label: "IFC", run: setIfcMode },
        { label: "Components", run: setComponentsMode },
        { label: "Zoom extents", run: runCmd("zoomextents") },
        // CAD-PARITY-004: the managers (right dock + inspector overlay).
        { label: "Layers manager", run: () => openDock("layers") },
        { label: "Styles manager", run: () => openDock("styles") },
        // CAD-PARITY-006: the Blocks & References manager (right dock).
        { label: "Blocks & References manager", run: () => openDock("blocks") },
        // CAD-PARITY-007: the Constraints manager (right dock).
        { label: "Constraints manager", run: () => openDock("constraints") },
        { label: "Properties inspector", run: () => showInspector() },
      ],
    },
    {
      label: "Insert",
      // CAD-PARITY-006 (Issue #84): the blocks/attributes/references
      // vocabulary — every entry resolves to the canonical registry command
      // (runCmd → startCommand), nothing mutates state directly. The mirror
      // of the Web Insert menu (BIM items retained below).
      items: [
        { label: "Block…", run: runCmd("block") },
        { label: "Insert Block…", run: runCmd("insert") },
        { label: "Attribute…", run: runCmd("attdef") },
        { label: "Edit Attribute…", run: runCmd("attedit") },
        { sep: true },
        { label: "Attach Reference…", run: runCmd("xattach") },
        { label: "Detach Reference…", run: runCmd("xdetach") },
        { label: "References…", run: runCmd("xref") },
        { sep: true },
        { label: "Door", run: runCmd("door") },
        { label: "Window", run: runCmd("window") },
        { label: "Slab", run: runCmd("slab") },
      ],
    },
    {
      label: "Annotate",
      // CAD-PARITY-005 (Issue #82): the full annotation/text/dimension
      // vocabulary — every entry resolves to the canonical registry command
      // (runCmd → startCommand), nothing mutates state directly. The mirror
      // of the Web MenuBar Annotate menu (labels + separators included).
      items: [
        { label: "Text (DT)", run: runCmd("text") },
        { label: "MText (MT)", run: runCmd("mtext") },
        { sep: true },
        { label: "Linear dimension (DLI)", run: runCmd("dimlinear") },
        { label: "Aligned dimension (DAL)", run: runCmd("dimaligned") },
        { label: "Radius dimension (DRA)", run: runCmd("dimradius") },
        { label: "Diameter dimension (DDI)", run: runCmd("dimdiameter") },
        { label: "Angular dimension (DAN)", run: runCmd("dimangular") },
        { sep: true },
        { label: "Leader (LE)", run: runCmd("leader") },
        { label: "Multileader (MLD)", run: runCmd("mleader") },
        { sep: true },
        { label: "Dimension text position (DIMTED)", run: runCmd("dimtedit") },
        { label: "Annotation scale (DIMSCALE)", run: runCmd("dimscale") },
      ],
    },
    { label: "BIM", items: [{ label: "Story", run: runCmd("story") }, { label: "Wall", run: runCmd("wall") }, { label: "Slab", run: runCmd("slab") }, { label: "Door", run: runCmd("door") }, { label: "Window", run: runCmd("window") }] },
    { label: "Help", items: [{ label: "Command palette", run: () => openPalette(true) }] },
  ];

  for (const spec of menus) {
    const menu = h("div", "pro-menu");
    menu.setAttribute("role", "menu");
    const button = h("button");
    button.type = "button";
    button.textContent = spec.label;
    button.setAttribute("aria-haspopup", "menu");
    const items = h("div", "items");
    for (const item of spec.items) {
      // CAD-PARITY-005: separators between menu groups (the Web MenuBar's
      // border-t dividers).
      if ("sep" in item) {
        items.append(h("div", "sep"));
        continue;
      }
      const ib = h("button");
      ib.type = "button";
      ib.textContent = item.label;
      ib.addEventListener("click", () => {
        menu.classList.remove("open");
        item.run();
      });
      items.append(ib);
    }
    button.addEventListener("click", () => {
      document.querySelectorAll(".pro-menu.open").forEach((m) => m.classList.remove("open"));
      menu.classList.toggle("open");
    });
    menu.append(button, items);
    menuBar.append(menu);
  }
  const searchButton = h("button");
  searchButton.type = "button";
  searchButton.textContent = "Search (Ctrl+K)";
  searchButton.style.cssText = "margin-left:auto;border:1px solid var(--border);border-radius:4px;background:transparent;font-size:11px;padding:3px 8px;cursor:pointer;";
  searchButton.addEventListener("click", () => openPalette(true));
  menuBar.append(searchButton);

  opts.root.insertBefore(menuBar, opts.root.firstChild);

  // --- CAD-PARITY-003 ribbon / tool palette (mirrors the Web ToolPalette groups) ----------

  const ribbon = h("div", "pro-ribbon");
  ribbon.setAttribute("role", "toolbar");
  ribbon.setAttribute("aria-label", "draw and modify tools");
  ribbon.setAttribute("data-testid", "pro-ribbon");
  const RIBBON_GROUPS: readonly { label: string; ids: readonly string[] }[] = [
    {
      label: "Draw",
      ids: ["line", "polyline", "circle", "arc", "rectangle", "ellipse", "spline", "point", "ray", "xline", "region"],
    },
    // CAD-PARITY-006 (Issue #84): the blocks/attributes/references group —
    // the SAME command set the Web Insert surfaces expose (BLOCK/INSERT/
    // ATTDEF/ATTEDIT, XATTACH/XDETACH, the References manager + the two
    // inventory commands; XRELOAD stays a typed decline surfaced through the
    // command palette only — the ribbon carries no dead buttons).
    {
      label: "Insert",
      ids: ["block", "insert", "attdef", "attedit", "xattach", "xdetach", "xref", "xlist", "blocklist"],
    },
    // CAD-PARITY-005 (Issue #82): the full interactive annotation vocabulary
    // — the SAME 11-command group the Web Annotate tool palette carries
    // (text/mtext, the dimension family, leaders/multileaders, DIMTEDIT and
    // the DIMSCALE settings command).
    {
      label: "Annotate",
      ids: ["text", "mtext", "dimlinear", "dimaligned", "dimradius", "dimdiameter", "dimangular", "leader", "mleader", "dimtedit", "dimscale"],
    },
    // CAD-PARITY-007 (Issue #86): the parametric group — the SAME command
    // set the Web Parametric ribbon tab carries (the geometric/dimensional
    // constraint declarations, the graph inventory, the release + the
    // manager surface; ARRAY lives in Modify).
    {
      label: "Parametric",
      ids: ["geomconstraint", "dimconstraint", "constraintlist", "delconstraint", "constraints"],
    },
    // CAD-PARITY-008 (Issue #88): the layouts/publishing group — the SAME
    // command set the Web Layout ribbon tab carries (the layout lifecycle,
    // the context switches, viewports, page setup, preview, plot, publish).
    {
      label: "Layout",
      ids: ["layout", "layoutnew", "layoutrename", "layoutclone", "layoutdelete", "tilemode", "mspace", "pspace", "mview", "vports", "pagesetup", "preview", "plot", "publish"],
    },
    // CAD-PARITY-009 (Issue #90): the 3D modeling group — the SAME command
    // set the Web 3D Model ribbon tab carries (the UCS/workplane lifecycle,
    // the standard views/fit, the solid primitives + transforms, the
    // section planes, the 3D state echo).
    {
      label: "3D Model",
      ids: ["ucs", "ucsnew", "ucsrename", "ucsdelete", "ucsw", "ucsact", "vpoint", "zoom3d", "box3d", "cylinder3d", "extrude3d", "move3d", "rotate3d", "scale3d", "sectionplane", "sectionplaneedit", "sectionplanedelete", "state3d"],
    },
    { label: "BIM", ids: ["story", "wall", "slab", "door", "window"] },
    {
      label: "Modify",
      ids: [
        "move",
        "copy",
        "rotate",
        "scale",
        "mirror",
        "offset",
        "trim",
        "extend",
        "stretch",
        "fillet",
        "chamfer",
        "break",
        "join",
        "explode",
        "erase",
        // CAD-PARITY-007 (Issue #86): the ARRAY pattern command (AR).
        "array",
      ],
    },
  ];
  // CAD-PARITY-004: the Layers / Styles / Properties ribbon groups — computed
  // from the SAME shared registry the Web ribbon filters (per-tab instant vs
  // interactive split, LOCK-004) so newly registered commands appear here
  // automatically. The status-bar drafting-aid toggles, the document commands
  // and the command palette keep their own surfaces, so the computed groups
  // take only the settings-category managers and the unlisted interactive
  // modify commands (CHPROP/MATCHPROP).
  const listedIds = new Set(RIBBON_GROUPS.flatMap((g) => g.ids));
  const layersRibbonIds = WORKSPACE_COMMANDS.filter(
    (c) => !listedIds.has(c.id) && c.instant !== undefined && c.category === "settings" && c.ribbonTab === "Home",
  ).map((c) => c.id);
  const stylesRibbonIds = WORKSPACE_COMMANDS.filter(
    (c) =>
      !listedIds.has(c.id) &&
      c.instant !== undefined &&
      c.category === "settings" &&
      (c.ribbonTab === "Annotate" || c.id === "lweight"),
  ).map((c) => c.id);
  const propsRibbonIds = WORKSPACE_COMMANDS.filter(
    (c) => !listedIds.has(c.id) && c.instant === undefined && c.steps.length > 0 && c.category === "modify",
  ).map((c) => c.id);
  const RIBBON_GROUPS_CP4: readonly { label: string; ids: readonly string[] }[] = [
    { label: "Properties", ids: propsRibbonIds },
    { label: "Layers", ids: layersRibbonIds },
    { label: "Styles", ids: stylesRibbonIds },
  ];
  for (const group of [...RIBBON_GROUPS, ...RIBBON_GROUPS_CP4]) {
    const g = h("div", "pro-ribbon-group");
    const label = h("span", "pro-ribbon-label");
    label.textContent = group.label;
    const buttons = h("div", "pro-ribbon-buttons");
    for (const id of group.ids) {
      const tool = commandById(id);
      if (tool === null) continue;
      const b = h("button", "pro-ribbon-tool");
      b.type = "button";
      // CAD-PARITY-005/006: the annotation + blocks tools carry icon glyphs
      // (the Web ribbon's lucide icon choices rendered as 12×12 line icons).
      const glyph = ANNOTATION_ICONS[id] ?? BLOCK_ICONS[id];
      if (glyph !== undefined) {
        b.append(glyph());
        const lbl = h("span");
        lbl.textContent = tool.label;
        b.append(lbl);
      } else {
        b.textContent = tool.label;
      }
      b.title = `${tool.name} (${tool.aliases.join(", ")}) — ${tool.description}`;
      b.setAttribute("data-testid", `pro-tool-${id}`);
      b.setAttribute("aria-label", tool.name);
      b.addEventListener("click", () => void startCommand(id));
      buttons.append(b);
    }
    g.append(label, buttons);
    ribbon.append(g);
  }
  opts.root.insertBefore(ribbon, menuBar.nextSibling);

  // --- CAD-PARITY-008 (Issue #88): the layout tab row — the Model tab plus
  //     ONE tab per paper-space layout (distinct from the Model tab, the Web
  //     host's view-tabs mirror). Clicking a layout activates it through
  //     layout.activate + switches the canvas to paper space.

  const layoutTabsRow = h("div", "pro-layout-tabs");
  layoutTabsRow.setAttribute("role", "tablist");
  layoutTabsRow.setAttribute("aria-label", "model and layout tabs");
  layoutTabsRow.setAttribute("data-testid", "pro-layout-tabs");
  const modelTabBtn = h("button", "pro-layout-tab");
  modelTabBtn.type = "button";
  modelTabBtn.textContent = "Model";
  modelTabBtn.setAttribute("role", "tab");
  modelTabBtn.setAttribute("data-testid", "pro-tab-model");
  modelTabBtn.addEventListener("click", () => {
    void (async () => {
      space = "model";
      setModel3dView(false);
      await command("layout.setSpace", { space: "model" });
      renderLayoutTabs();
      await refresh();
    })();
  });
  layoutTabsRow.append(modelTabBtn);
  // CAD-PARITY-009 (Issue #90): the 3D Model tab — a host-local VIEW mode
  // (no App API command; the Web host's "3D" view-tab mirror). Clicking it
  // paints the canonical 3D scene through the SHARED model3d core.
  const model3dTabBtn = h("button", "pro-layout-tab");
  model3dTabBtn.type = "button";
  model3dTabBtn.textContent = "3D";
  model3dTabBtn.setAttribute("role", "tab");
  model3dTabBtn.setAttribute("data-testid", "pro-tab-3d");
  model3dTabBtn.title = "3D Model — the canonical 3D scene: UCS/workplane, solids, standard views, gestures";
  model3dTabBtn.addEventListener("click", () => {
    setModel3dView(true);
    renderLayoutTabs();
  });
  layoutTabsRow.append(model3dTabBtn);
  const layoutTabsDyn = h("span", "pro-layout-tabs-dyn");
  layoutTabsRow.append(layoutTabsDyn);
  opts.root.insertBefore(layoutTabsRow, ribbon.nextSibling);

  /** Repaint the layout tab row from the current snapshot (called by
   *  refresh + the space switches). */
  function renderLayoutTabs(): void {
    while (layoutTabsDyn.firstChild) layoutTabsDyn.removeChild(layoutTabsDyn.firstChild);
    modelTabBtn.classList.toggle("active", space === "model" && !model3dView);
    modelTabBtn.setAttribute("aria-selected", String(space === "model" && !model3dView));
    model3dTabBtn.classList.toggle("active", model3dView);
    model3dTabBtn.setAttribute("aria-selected", String(model3dView));
    const layouts = state.snapshot?.layouts ?? [];
    const activeId = state.snapshot?.draftingSettings?.activeLayout ?? layouts[0]?.id ?? null;
    for (const layout of layouts) {
      const btn = h("button", "pro-layout-tab");
      btn.type = "button";
      btn.textContent = layout.name;
      btn.setAttribute("role", "tab");
      btn.setAttribute("data-testid", `pro-tab-layout-${layout.id}`);
      const isActive = space === "paper" && layout.id === activeId && !model3dView;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", String(isActive));
      btn.title = `Activate the '${layout.name}' layout (${layout.pageSetup.paperSize} ${layout.pageSetup.orientation})`;
      btn.addEventListener("click", () => {
        void (async () => {
          selectedViewportId = null;
          space = "paper";
          const res = await command("layout.activate", { name: layout.name });
          if (!res.ok) pushLines([`*ERROR* layout.activate: ${res.code} — ${res.message}`]);
          renderLayoutTabs();
          await refresh();
        })();
      });
      layoutTabsDyn.append(btn);
    }
  }

  // --- Model canvas (drafting mode card) ---------------------------------------------

  const modelCard = h("div", "pro-model-card");
  modelCard.setAttribute("data-testid", "pro-model-card");
  const modelHead = h("header");
  const modelTitle = h("h2");
  modelTitle.textContent = "Model — command-driven plan viewport";
  const modelDesc = h("p");
  modelDesc.textContent = "Command line + canvas parity surface: crosshair, snaps, ortho/polar, window/crossing selection, cycling, grips. Every pick and typed entry flows through the shared prompt engine.";
  modelHead.append(modelTitle, modelDesc);
  modelCard.append(modelHead);
  const modelBody = h("div", "body");
  // CAD-PARITY-004: the body is a flex row — the plan viewport (svg + the
  // absolute overlays) plus the right dock (Layers / Styles managers).
  const viewport = h("div", "pro-viewport");
  const svg = svgNs("svg") as unknown as SVGSVGElement;
  svg.setAttribute("viewBox", `0 0 ${SVG_W} ${SVG_H}`);
  svg.setAttribute("role", "application");
  svg.setAttribute("aria-label", "Offisos Model viewport — 2D drafting and BIM plan canvas");
  svg.setAttribute("tabindex", "0");
  svg.setAttribute("data-testid", "pro-model-svg");
  viewport.append(svg);
  // CAD-PARITY-005 (Issue #82): the annotation paint layer — a REAL HTML
  // canvas overlaying the SVG plan viewport (pointer-transparent, aligned to
  // the svg's box through the same 900×620 aspect). Annotation elements
  // paint through the ONE shared canvas painter (annotation/paint.ts) —
  // the SAME strokes, arrowheads, text runs and fonts the Web model canvas
  // draws (LOCK-004 parity by construction). The painter's structural
  // Canvas2DContext accepts the DOM CanvasRenderingContext2D directly (its
  // style slots are widened to `string | object` in the core).
  const annoCanvas = document.createElement("canvas");
  annoCanvas.width = SVG_W;
  annoCanvas.height = SVG_H;
  annoCanvas.setAttribute("aria-hidden", "true");
  annoCanvas.setAttribute("data-testid", "pro-model-annotation-canvas");
  annoCanvas.style.cssText =
    `position:absolute;top:0;left:0;width:100%;height:auto;aspect-ratio:${SVG_W}/${SVG_H};pointer-events:none;`;
  viewport.append(annoCanvas);
  const annoCtx: CanvasRenderingContext2D | null = annoCanvas.getContext("2d");
  modelBody.append(viewport);
  modelCard.append(modelBody);
  opts.main.insertBefore(modelCard, opts.main.firstChild);

  // --- CAD-PARITY-009 (Issue #90): the 3D Model view surface -----------------
  //
  // The canonical 3D scene rendered through the SHARED buildScene3DSVG
  // writer (the SAME byte-identical SVG the Web 3D viewport produces from the
  // same inputs), the standard-view/Fit buttons (view3d.standard/view3d.fit),
  // the UCS dropdown (ucs.activate) and the quick BOX/CYLINDER shapes
  // (model3d.box/model3d.cylinder through the ACTIVE UCS). Gestures run
  // through the SHARED camera module (orbitCamera/panCamera/zoomCamera) and
  // persist through view3d.set — no host-local navigation math (LOCK-004).

  const model3dScene = h("div", "pro-model3d-scene");
  model3dScene.setAttribute("data-testid", "pro-model3d-scene");
  model3dScene.setAttribute("data-format", "offisos-scene3d-svg");
  model3dScene.setAttribute("role", "application");
  model3dScene.setAttribute(
    "aria-label",
    "Offisos 3D Model viewport — orbit with drag, pan with shift-drag or middle-drag, zoom with the wheel",
  );
  model3dScene.style.display = "none";
  model3dScene.style.touchAction = "none";
  model3dScene.style.cursor = "crosshair";
  viewport.append(model3dScene);

  const model3dToolbar = h("div", "pro-model3d-toolbar");
  model3dToolbar.setAttribute("role", "toolbar");
  model3dToolbar.setAttribute("aria-label", "3D view tools");
  model3dToolbar.style.display = "none";
  const model3dInfo = h("span", "pro-model3d-info");
  model3dInfo.setAttribute("data-testid", "pro-model3d-info");
  model3dInfo.style.cssText = "font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  const MODEL3D_VIEWS: readonly { id: StandardViewName; label: string }[] = [
    { id: "top", label: "Top" },
    { id: "bottom", label: "Bottom" },
    { id: "front", label: "Front" },
    { id: "back", label: "Back" },
    { id: "left", label: "Left" },
    { id: "right", label: "Right" },
    { id: "iso", label: "Iso" },
  ];
  const MODEL3D_ASPECT = 800 / 600;
  const runModel3dCommand = (name: string, payload: unknown): void => {
    void (async () => {
      const res = await command(name, payload);
      if (!res.ok) pushLines([`*ERROR* ${name}: ${res.code} — ${res.message}`]);
      await refresh();
    })();
  };
  for (const view of MODEL3D_VIEWS) {
    const b = h("button");
    b.type = "button";
    b.textContent = view.label;
    b.title = `view3d.standard — the ${view.label} standard view of the model extents (VPOINT ${view.label})`;
    b.setAttribute("data-testid", `pro-model3d-view-${view.id}`);
    b.addEventListener("click", () => runModel3dCommand("view3d.standard", { view: view.id, aspect: MODEL3D_ASPECT }));
    model3dToolbar.append(b);
  }
  const model3dFitBtn = h("button");
  model3dFitBtn.type = "button";
  model3dFitBtn.textContent = "Fit";
  model3dFitBtn.title = "view3d.fit — all eight corners of the extents inside the view (ZOOM3D Fit)";
  model3dFitBtn.setAttribute("data-testid", "pro-model3d-fit");
  model3dFitBtn.addEventListener("click", () => runModel3dCommand("view3d.fit", { aspect: MODEL3D_ASPECT }));
  model3dToolbar.append(model3dFitBtn);
  const model3dUcsLabel = h("span");
  model3dUcsLabel.textContent = "UCS";
  model3dUcsLabel.style.cssText = "font-size:10px;color:var(--muted);margin:0 2px 0 6px;";
  model3dToolbar.append(model3dUcsLabel);
  const model3dUcsSelect = document.createElement("select");
  model3dUcsSelect.setAttribute("data-testid", "pro-model3d-ucs");
  model3dUcsSelect.title = "ucs.activate — the active workplane (triad + grid + typed 'x,y,z' resolution)";
  model3dUcsSelect.style.cssText = "font-size:11px;border:1px solid var(--border);border-radius:4px;background:transparent;padding:2px;";
  model3dUcsSelect.addEventListener("change", () => {
    const name = model3dUcsSelect.value;
    if (name === "World") runModel3dCommand("ucs.activate", { id: "world" });
    else runModel3dCommand("ucs.activate", { name });
  });
  model3dToolbar.append(model3dUcsSelect);
  const model3dBoxBtn = h("button");
  model3dBoxBtn.type = "button";
  model3dBoxBtn.textContent = "Box";
  model3dBoxBtn.title = "model3d.box — quick 2×3×4 box through the ACTIVE UCS (at 0,0,0)";
  model3dBoxBtn.setAttribute("data-testid", "pro-model3d-box");
  model3dBoxBtn.addEventListener("click", () => {
    runModel3dCommand("model3d.box", { width: 2, depth: 3, height: 4, at: [0, 0, 0], ucsId: activeModel3dUcs().id });
  });
  model3dToolbar.append(model3dBoxBtn);
  const model3dCylinderBtn = h("button");
  model3dCylinderBtn.type = "button";
  model3dCylinderBtn.textContent = "Cylinder";
  model3dCylinderBtn.title = "model3d.cylinder — quick r2 h5 cylinder through the ACTIVE UCS (at 0,0,0)";
  model3dCylinderBtn.setAttribute("data-testid", "pro-model3d-cylinder");
  model3dCylinderBtn.addEventListener("click", () => {
    runModel3dCommand("model3d.cylinder", { radius: 2, height: 5, at: [0, 0, 0], ucsId: activeModel3dUcs().id });
  });
  model3dToolbar.append(model3dCylinderBtn);
  model3dToolbar.append(model3dInfo);
  modelHead.append(model3dToolbar);

  /** The ACTIVE UCS record (the implicit World when unset/unknown — the same
   *  resolution the registry + the App API run). */
  function activeModel3dUcs(): UcsRecord {
    const snap = state.snapshot;
    const id = snap?.draftingSettings?.activeUcs;
    if (snap !== null && id !== undefined && id !== "world") {
      const found = (snap.ucs ?? []).find((u) => u.id === id);
      if (found !== undefined) return found;
    }
    return WORLD_UCS;
  }

  /** The scene surface of the snapshot elements (id + extent + engine token). */
  function model3dSceneElements(): Scene3DElement[] {
    const snap = state.snapshot;
    if (snap === null) return [];
    return snap.elements.map((el) => {
      const props = el.props as { meshToken?: unknown; meshBBox?: unknown };
      const b = props.meshBBox;
      const bbox =
        Array.isArray(b) && b.length === 6 && b.every((n) => typeof n === "number" && Number.isFinite(n))
          ? { minX: b[0] as number, minY: b[1] as number, minZ: b[2] as number, maxX: b[3] as number, maxY: b[4] as number, maxZ: b[5] as number }
          : null;
      const out: { id: string; bbox: BBox3D | null; meshToken?: string } = { id: el.id, bbox };
      if (typeof props.meshToken === "string") out.meshToken = props.meshToken;
      return out;
    });
  }

  /** The bounded workplane grid (the SAME adaptive derivation the Web 3D
   *  viewport runs: step doubling to ≤ 20 cells per axis, major every 5,
   *  hard cap 400 segments). */
  function model3dGridSegments(): ReturnType<typeof ucsGridSegments>["segments"] {
    const elements = model3dSceneElements();
    const boxes = elements.map((el) => el.bbox).filter((b): b is BBox3D => b !== null);
    if (boxes.length === 0) boxes.push({ minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 });
    let box = boxes[0]!;
    for (const b of boxes.slice(1)) {
      box = {
        minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), minZ: Math.min(box.minZ, b.minZ),
        maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY), maxZ: Math.max(box.maxZ, b.maxZ),
      };
    }
    const maxDim = Math.max(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ);
    let step = 1;
    while (maxDim / step > 20) step *= 2;
    return ucsGridSegments(activeModel3dUcs(), box, step, 5, 400).segments;
  }

  /** The 3D camera (the live gesture camera while dragging, else the
   *  persisted view3d state — the deterministic default when unset). */
  function currentModel3dCamera(): Camera3DState {
    if (model3dLiveCamera !== null) return model3dLiveCamera;
    return state.snapshot?.draftingSettings?.view3d ?? defaultCamera3D();
  }

  /** Persist a camera through view3d.set (the ONLY view mutation path). */
  function persistModel3dCamera(next: Camera3DState): void {
    runModel3dCommand("view3d.set", {
      eye: [...next.eye],
      target: [...next.target],
      up: [...next.up],
      mode: next.mode,
      orthoHalfHeight: next.orthoHalfHeight,
      fovDeg: next.fovDeg,
    });
  }

  /** Paint the canonical 3D scene (renderModel's 3D branch). */
  function renderModel3D(): void {
    modelTitle.textContent = "3D Model — UCS/workplane & solids";
    const camera = currentModel3dCamera();
    const ucs = activeModel3dUcs();
    model3dSceneString = buildScene3DSVG({
      viewport: { width: 800, height: 600 },
      camera,
      elements: model3dSceneElements(),
      ucs,
      grid: model3dGridSegments(),
      ...(model3dExactFacets !== null ? { sectionFacets: model3dExactFacets as never } : {}),
      selectedIds: [...state.selection],
    });
    model3dScene.innerHTML = model3dSceneString;
    // The UCS dropdown options (World + the named table), the active one selected.
    const activeName = ucs.name;
    const options = ["World", ...(state.snapshot?.ucs ?? []).map((u) => u.name)];
    while (model3dUcsSelect.firstChild) model3dUcsSelect.removeChild(model3dUcsSelect.firstChild);
    for (const name of options) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === activeName) opt.selected = true;
      model3dUcsSelect.append(opt);
    }
    const solidCount = (state.snapshot?.elements ?? []).filter(
      (el) => (el.props as Record<string, unknown> | null)?.type === "model3d.solid",
    ).length;
    model3dInfo.textContent =
      state.snapshot === null
        ? "3D state: no document."
        : `3D state: ${formatCamera(camera)} · UCS ${ucs.name} (${ucs.id}) · ${solidCount} solid${solidCount === 1 ? "" : "s"}`;
  }

  /** Switch the model card between the 2D plan/paper canvas and the 3D scene
   *  (host-local view state, LOCK-015 — the tab + the view.model3d ui action). */
  function setModel3dView(active: boolean): void {
    model3dView = active;
    if (!active) model3dDrag = null;
    svg.style.display = active ? "none" : "";
    annoCanvas.style.display = active ? "none" : "";
    model3dScene.style.display = active ? "block" : "none";
    model3dToolbar.style.display = active ? "flex" : "none";
    renderModel();
  }

  // The 3D gestures on the scene surface (the SHARED camera module only).
  model3dScene.addEventListener("mousedown", (e) => {
    if (state.snapshot === null) return;
    const pan = e.button === 1 || (e.button === 0 && e.shiftKey);
    const orbit = e.button === 0 && !e.shiftKey;
    if (!pan && !orbit) return;
    e.preventDefault();
    model3dDrag = { kind: pan ? "pan" : "orbit", x: e.clientX, y: e.clientY };
    model3dScene.style.cursor = pan ? "move" : "grabbing";
  });
  model3dScene.addEventListener("mousemove", (e) => {
    if (model3dDrag === null) return;
    const dx = e.clientX - model3dDrag.x;
    const dy = e.clientY - model3dDrag.y;
    model3dDrag = { ...model3dDrag, x: e.clientX, y: e.clientY };
    const camera = currentModel3dCamera();
    let next: Camera3DState | null = null;
    if (model3dDrag.kind === "orbit") {
      next = orbitCamera(camera, dx * 0.5, dy * 0.5);
    } else {
      const wpp =
        camera.mode === "orthographic"
          ? (camera.orthoHalfHeight * 2) / 600
          : (2 * Math.tan((camera.fovDeg * Math.PI) / 360) *
              Math.hypot(camera.eye[0] - camera.target[0], camera.eye[1] - camera.target[1], camera.eye[2] - camera.target[2])) / 600;
      next = panCamera(camera, -dx, dy, wpp);
    }
    if (next !== null) {
      model3dLiveCamera = next;
      renderModel3D();
    }
  });
  const endModel3dDrag = (): void => {
    if (model3dDrag === null) return;
    model3dDrag = null;
    model3dScene.style.cursor = "crosshair";
    const camera = model3dLiveCamera;
    model3dLiveCamera = null;
    if (camera !== null) persistModel3dCamera(camera);
    else renderModel();
  };
  model3dScene.addEventListener("mouseup", endModel3dDrag);
  model3dScene.addEventListener("mouseleave", endModel3dDrag);
  model3dScene.addEventListener("wheel", (e) => {
    if (state.snapshot === null) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = zoomCamera(currentModel3dCamera(), factor);
    if (next === null) return;
    model3dLiveCamera = next;
    renderModel3D();
    if (model3dWheelTimer !== null) clearTimeout(model3dWheelTimer);
    model3dWheelTimer = setTimeout(() => {
      model3dWheelTimer = null;
      const cam = model3dLiveCamera;
      if (cam !== null) {
        model3dLiveCamera = null;
        persistModel3dCamera(cam);
      }
    }, 180);
  }, { passive: false });


  const miniToolbar = h("div", "pro-mini");
  miniToolbar.style.display = "none";
  miniToolbar.setAttribute("role", "toolbar");
  miniToolbar.setAttribute("aria-label", "selection actions");
  viewport.append(miniToolbar);

  // CAD-PARITY-003/004: canonical entity type/geometry readout extended into
  // the professional Properties inspector (mirrors the Web PropertiesPanel:
  // General + Display + canonical Geometry rows, the current drafting
  // environment when nothing is selected).
  const propsPanel = h("div", "pro-props");
  propsPanel.setAttribute("data-testid", "pro-properties");
  propsPanel.setAttribute("role", "region");
  propsPanel.setAttribute("aria-label", "selection properties");
  viewport.append(propsPanel);
  const miniMove = h("button");
  miniMove.textContent = "Move";
  const miniCopy = h("button");
  miniCopy.textContent = "Copy";
  const miniErase = h("button");
  miniErase.textContent = "Erase";
  const miniDeselect = h("button");
  miniDeselect.textContent = "Deselect";
  miniToolbar.append(miniMove, miniCopy, miniErase, miniDeselect);
  miniMove.addEventListener("click", () => void startCommand("move"));
  miniCopy.addEventListener("click", () => void startCommand("copy"));
  miniErase.addEventListener("click", () => void startCommand("erase"));
  miniDeselect.addEventListener("click", () => {
    void command("document.setSelection", { ids: [] }).then(() => {
      state.selection = [];
      renderModel();
    });
  });

  // --- CAD-PARITY-004 right dock: the Layers manager + the Styles manager
  //     (+ the CAD-PARITY-006 Blocks & References manager) ---------------------

  const dock = h("div", "pro-dock");
  dock.setAttribute("role", "complementary");
  dock.setAttribute("aria-label", "layers, styles and blocks managers");
  dock.setAttribute("data-testid", "pro-dock");
  const dockTabs = h("div", "pro-dock-tabs");
  dockTabs.setAttribute("role", "tablist");
  dockTabs.setAttribute("aria-label", "manager tabs");
  const dockTabLayers = h("button", "pro-dock-tab");
  dockTabLayers.type = "button";
  dockTabLayers.textContent = "Layers";
  dockTabLayers.setAttribute("role", "tab");
  dockTabLayers.setAttribute("aria-label", "Layers manager");
  dockTabLayers.addEventListener("click", () => {
    dockTab = "layers";
    renderDock();
  });
  const dockTabStyles = h("button", "pro-dock-tab");
  dockTabStyles.type = "button";
  dockTabStyles.textContent = "Styles";
  dockTabStyles.setAttribute("role", "tab");
  dockTabStyles.setAttribute("aria-label", "Styles manager");
  dockTabStyles.addEventListener("click", () => {
    dockTab = "styles";
    renderDock();
  });
  // CAD-PARITY-006 (Issue #84): the Blocks & References manager tab.
  const dockTabBlocks = h("button", "pro-dock-tab");
  dockTabBlocks.type = "button";
  dockTabBlocks.textContent = "Blocks";
  dockTabBlocks.setAttribute("role", "tab");
  dockTabBlocks.setAttribute("aria-label", "Blocks and References manager");
  dockTabBlocks.setAttribute("data-testid", "pro-dock-tab-blocks");
  dockTabBlocks.addEventListener("click", () => {
    dockTab = "blocks";
    renderDock();
  });
  // CAD-PARITY-007 (Issue #86): the Constraints manager tab.
  const dockTabConstraints = h("button", "pro-dock-tab");
  dockTabConstraints.type = "button";
  dockTabConstraints.textContent = "Constr";
  dockTabConstraints.setAttribute("role", "tab");
  dockTabConstraints.setAttribute("aria-label", "Constraints manager");
  dockTabConstraints.setAttribute("data-testid", "pro-dock-tab-constraints");
  dockTabConstraints.addEventListener("click", () => {
    dockTab = "constraints";
    renderDock();
  });
  // CAD-PARITY-008 (Issue #88): the Layouts manager tab.
  const dockTabLayouts = h("button", "pro-dock-tab");
  dockTabLayouts.type = "button";
  dockTabLayouts.textContent = "Layouts";
  dockTabLayouts.setAttribute("role", "tab");
  dockTabLayouts.setAttribute("aria-label", "Layouts manager");
  dockTabLayouts.setAttribute("data-testid", "pro-dock-tab-layouts");
  dockTabLayouts.addEventListener("click", () => {
    dockTab = "layouts";
    renderDock();
  });
  const dockClose = h("button", "pro-dock-close");
  dockClose.type = "button";
  dockClose.textContent = "×";
  dockClose.title = "Close the manager dock (reopen from the View menu, the status bar, LAYER/LINETYPE/STYLE/DIMSTYLE/XREF or the context menu)";
  dockClose.setAttribute("aria-label", "close the manager dock");
  dockClose.addEventListener("click", () => {
    dockOpen = false;
    renderDock();
  });
  dockTabs.append(dockTabLayers, dockTabStyles, dockTabBlocks, dockTabConstraints, dockTabLayouts, dockClose);
  const dockBody = h("div", "pro-dock-body");
  dock.append(dockTabs, dockBody);
  modelBody.append(dock);

  /** Open (and focus) a manager dock tab. */
  function openDock(tab: "layers" | "styles" | "blocks" | "constraints" | "layouts"): void {
    dockOpen = true;
    dockTab = tab;
    renderDock();
  }

  /** Show (expand) the Properties inspector overlay. */
  function showInspector(): void {
    propsCollapsed = false;
    renderModel();
  }

  // --- view transform ------------------------------------------------------------------

  // COMPAT-CAD-006 (Issue #138): the shared contract adapters — the local
  // toScreen/toWorld now delegate to the ONE shared module (viewport = the
  // fixed 900×620 SVG user space). Same math as the Web host by
  // construction (LOCK-004/017/018).
  const toScreen = (p: Vec2): [number, number] => sharedToScreen(sharedViewTransformOf(state.pan, state.zoom, { w: SVG_W, h: SVG_H }), p);
  const toWorld = (sx: number, sy: number): Vec2 => sharedToWorld(sharedViewTransformOf(state.pan, state.zoom, { w: SVG_W, h: SVG_H }), sx, sy);
  /** COMPAT-CAD-006: the shared viewport gate rect (margin-expanded visible
   *  world rect) for the cull/pre-clip contract. */
  const viewGateRect = () => sharedExpandRect(sharedVisibleWorldRect(sharedViewTransformOf(state.pan, state.zoom, { w: SVG_W, h: SVG_H })), CULL_MARGIN_PX, state.zoom);
  /** COMPAT-CAD-006: cull verdict for one world bbox against the gate. */
  const passesGate = (bb: { minX: number; minY: number; maxX: number; maxY: number }): boolean =>
    sharedRectsIntersect(bb, viewGateRect());
  /** COMPAT-CAD-006: the command-driven view history (ZOOM Previous) — the
   *  mirror of the Web canvas stack (command navigations only, max 10). */
  const viewHistory: { pan: { x: number; y: number }; zoom: number }[] = [];
  /** COMPAT-CAD-006: apply ONE navigation request through the shared module
   *  (the Web canvas navigation-effect mirror). View-only: no document
   *  entities/version/history are touched; the desktop host keeps its
   *  transient view policy (no setSettings persist on this host — the same
   *  presentation policy it had before COMPAT-CAD-006). */
  function applyNavigation(request: ViewNavigationRequest): void {
    const current = sharedViewTransformOf(state.pan, state.zoom, { w: SVG_W, h: SVG_H });
    if (request.kind === "regen") {
      // Pure redraw — re-render the model, zero state change.
      renderModel();
      return;
    }
    if (request.kind === "zoomPrevious") {
      if (viewHistory.length === 0) {
        pushLines(["ZOOM: no previous view to restore."]);
        return;
      }
      const prev = viewHistory.pop()!;
      state.pan = { x: prev.pan.x, y: prev.pan.y };
      state.zoom = prev.zoom;
      renderModel();
      return;
    }
    viewHistory.push({ pan: { ...state.pan }, zoom: state.zoom });
    if (viewHistory.length > 10) viewHistory.shift();
    if (request.kind === "zoomExtents") {
      zoomExtents();
      return;
    }
    if (request.kind === "zoomWindow") {
      // No clamp: the user-specified window is the explicit target (the
      // fit semantics — a real-scale window zooms to exactly what it spans).
      const next = sharedZoomWindow(current, request.corner1, request.corner2);
      if (next === null) {
        viewHistory.pop();
        pushLines(["ZOOM: window too small — no view change."]);
        return;
      }
      state.pan = { x: next.pan.x, y: next.pan.y };
      state.zoom = next.zoom;
      renderModel();
      return;
    }
    if (request.kind === "zoomScale") {
      // The user-specified factor is honored exactly within the wide scale
      // guards (NOT the interactive wheel floor — a real-scale view at a
      // small zoom must be able to double).
      let next;
      if (request.relative) {
        next = sharedZoomScaleAboutCenter(current, request.factor, SCALE_ZOOM_LIMITS);
      } else {
        // AutoCAD "n" (plain): scale relative to the extents fit — the
        // deterministic reference zoom over the content bounds.
        const bounds = contentBoundsOf();
        const reference = sharedFitZoomOf({ w: SVG_W, h: SVG_H }, bounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }, 800);
        const target = Math.min(SCALE_ZOOM_LIMITS.max, Math.max(SCALE_ZOOM_LIMITS.min, reference * request.factor));
        next = sharedZoomScaleAboutCenter(current, target / current.zoom, SCALE_ZOOM_LIMITS);
      }
      state.pan = { x: next.pan.x, y: next.pan.y };
      state.zoom = next.zoom;
      renderModel();
      return;
    }
    if (request.kind === "pan") {
      const next = sharedPanBy(current, request.delta);
      state.pan = { x: next.pan.x, y: next.pan.y };
      renderModel();
      return;
    }
  }

  /** COMPAT-CAD-006: the deterministic CONTENT BOUNDS (the derivation the
   *  shipped zoomExtents ran, extracted so the absolute-scale zoom shares
   *  it) — canonical bounds first (BOTH storage conventions), block/xref
   *  instances through their EXPANDED content bounds, BIM footprints next;
   *  annotations contribute no bounds (mirrors the Web host). Null when the
   *  document has no renderable content. */
  function contentBoundsOf(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const elements = state.snapshot?.elements ?? [];
    if (elements.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of elements) {
      const pts: Vec2[] = [];
      // CAD-PARITY-003: canonical bounds first (BOTH storage conventions
      // decode through the bridge); BIM footprints next; annotations
      // contribute no bounds (mirrors the Web host).
      // CAD-PARITY-006: block/xref instances contribute their EXPANDED
      // content bounds (the ONE shared expansion — zoom fits the derived
      // content, placeholders included).
      const expanded = expandInstanceElement(el, blockTableOf());
      if (expanded !== null) {
        const box = expandedBounds(expanded);
        if (box !== null) pts.push([box.minX, box.minY], [box.maxX, box.maxY]);
      } else {
        const geom = geomFromElement(el);
        if (geom !== null) {
          pts.push(...canonicalBoundsPoints(geom));
        } else {
          const props = el.props as Record<string, unknown>;
          if (props.type === "bim.wall" && Array.isArray(props.start) && Array.isArray(props.end)) {
            pts.push(props.start as unknown as Vec2, props.end as unknown as Vec2);
          } else if (props.type === "bim.slab" && Array.isArray(props.corner1) && Array.isArray(props.corner2)) {
            pts.push(props.corner1 as unknown as Vec2, props.corner2 as unknown as Vec2);
          } else {
            continue;
          }
        }
      }
      for (const p of pts) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      }
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  function zoomExtents(): void {
    const bounds = contentBoundsOf();
    if (bounds === null) return;
    // COMPAT-CAD-006: the fit through the ONE shared module (byte-exact
    // extraction of the shipped desktop formula: pad 800 world units on
    // every side, aspect-preserving zoom, centered in the slack axis).
    const next = sharedFitExtents({ w: SVG_W, h: SVG_H }, bounds, 800);
    state.zoom = next.zoom;
    state.pan = { x: next.pan.x, y: next.pan.y };
    renderModel();
  }

  function parseEntity(el: Element): DraftEntity | null {
    if (!isDraftingElement(el)) return null;
    try {
      return elementToDraftEntity(el);
    } catch {
      return null;
    }
  }

  /** COMPAT-CAD-006: the conservative world bbox of a LEGACY draft entity
   *  for the viewport cull gate (the Web host's legacyEntityRect mirror) —
   *  null for shapes without a derivable rect (they draw; the surface
   *  clips). */
  function legacyRectOf(entity: DraftEntity): { minX: number; minY: number; maxX: number; maxY: number } | null {
    switch (entity.type) {
      case "line": {
        const a = entity.from;
        const b = entity.to;
        return { minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) };
      }
      case "polyline": {
        if (entity.points.length === 0) return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const p of entity.points) {
          minX = Math.min(minX, p[0]);
          minY = Math.min(minY, p[1]);
          maxX = Math.max(maxX, p[0]);
          maxY = Math.max(maxY, p[1]);
        }
        return { minX, minY, maxX, maxY };
      }
      case "circle":
      case "arc":
        return { minX: entity.center[0] - entity.radius, minY: entity.center[1] - entity.radius, maxX: entity.center[0] + entity.radius, maxY: entity.center[1] + entity.radius };
      case "rectangle": {
        const a = entity.corner1;
        const b = entity.corner2;
        return { minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) };
      }
      case "dim-linear": {
        const a = entity.p1;
        const b = entity.p2;
        return { minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) };
      }
      default:
        return null;
    }
  }

  /** CAD-PARITY-005: the annotation style context — the user text/dim style
   *  tables + the document annotation scale (DrawingStandards.annotationScale,
   *  1 when absent). The SAME resolution drives annotation rendering, picking
   *  and window selection on both hosts (the SVG-mirror of the Web
   *  annotationStyleCtx memo). */
  function annotationStyleCtxOf(): AnnotationStyleContext {
    return annotationStyleContext(
      state.snapshot?.textStyles ?? [],
      state.snapshot?.dimStyles ?? [],
      state.snapshot?.draftingSettings?.standards?.annotationScale,
    );
  }

  // --- CAD-PARITY-006 (Issue #84): the blocks/references derived view ------
  // Block-ref/xref-ref instances render, pick and window-select through the
  // ONE shared expansion (workspace/blocks — the SAME module the App API
  // explode/bounds paths run; LOCK-004 parity by construction). The
  // instance's OWN layer gates visibility exactly like every other element
  // (drawableElements/visibleElements); each expanded piece then resolves
  // ITS OWN layer/display through the shared standards chain.

  /** The document block/xref tables as the shared BlockTable lookups. */
  function blockTableOf(): BlockTable {
    const blockDefById = new Map<string, BlockDefinitionRecord>(
      (state.snapshot?.blockDefs ?? []).map((b) => [b.id, b] as const),
    );
    const xrefById = new Map<string, XrefRecord>(
      (state.snapshot?.xrefs ?? []).map((x) => [x.id, x] as const),
    );
    return {
      blockDefById: (id: string): BlockDefinitionRecord | undefined => blockDefById.get(id),
      xrefById: (id: string): XrefRecord | undefined => xrefById.get(id),
    };
  }

  /** Is this element a block/xref instance (the soft vocabulary check)? */
  function isInstanceElement(el: Element): boolean {
    return isBlockRefElement(el) || isXrefRefElement(el);
  }

  /** The resolved display of one expanded piece (its OWN layer + display
   *  overrides through the shared standards chain — the same resolution
   *  computeDisplayMap runs for plain entities; unresolvable displays fall
   *  back to the layer color, solid, hairline; rendering never throws). */
  function expandedDisplayOf(props: Record<string, unknown>, layerById: ReadonlyMap<string, LayerRecord>): DisplayDraw {
    const layerId = typeof props.layer === "string" && props.layer.length > 0 ? props.layer : "0";
    const layer = layerById.get(layerId);
    if (layer === undefined) {
      return { dash: null, weightPx: 1, alpha: 1, color: "#111827" };
    }
    try {
      const resolved = resolveDisplay(
        displayOverridesOf(props),
        layer,
        state.snapshot?.draftingSettings?.standards,
        state.snapshot?.ltypes ?? [],
      );
      let alpha = transparencyToAlpha(resolved.transparency);
      if (layer.locked === true) alpha *= LOCKED_LAYER_FADE_ALPHA;
      return {
        dash: resolved.dash.length > 0 ? dashToDevicePx(resolved.dash, state.zoom) : null,
        weightPx: lineweightToDevicePx(resolved.lineweight, state.zoom, state.snapshot?.draftingSettings?.lineweightDisplay === true),
        alpha,
        color: resolved.color,
      };
    } catch {
      return {
        dash: null,
        weightPx: 1,
        alpha: layer.locked === true ? LOCKED_LAYER_FADE_ALPHA : 1,
        color: layer.color,
      };
    }
  }

  /** The synthetic annotation ELEMENT for one expanded text piece — the
   *  expanded props ARE the CAD-PARITY-005 text convention, so the SAME
   *  annotation pipeline (annotationFromElement → annotationPrimitives →
   *  paintAnnotationPrimitives / pickAnnotationAt / selectAnnotations) runs
   *  on it unchanged. The synthetic id IS the instance element id, so every
   *  derived hit resolves to the INSTANCE (definition → instance semantics:
   *  picking a block's text selects the block). */
  function textPieceElement(instanceId: string, props: Record<string, unknown>): Element {
    return {
      id: instanceId,
      kind: "annotation",
      engineId: null,
      props: { ...props, drafting: true, annotation: true },
    };
  }

  /** Paint one canonical geometry piece on the annotation canvas overlay —
   *  the canvas mirror of drawGeomSvg's conventions (same world→screen
   *  transform, construction-thin rays/xlines, xline default dash, region
   *  translucent fill + centroid cross, point crosses, viewport-clipped
   *  infinite entities). Selected pieces stroke the selection highlight
   *  (solid, thicker, full alpha) exactly like the SVG geometry path. */
  function paintGeomCanvas(
    ctx: CanvasRenderingContext2D,
    g: Geom,
    d: { color: string; weightPx: number; dash: readonly number[] | null; alpha: number },
    selected: boolean,
  ): void {
    // COMPAT-CAD-006 (Issue #138): the same viewport gate as the SVG path —
    // lines pre-clipped (bounded screen coordinates), other types bbox-gated
    // (rays/xlines pass; the painter clips them). The Web paint loop runs
    // the identical contract.
    if (g.type === "line") {
      const seg = sharedClipSegment(viewGateRect(), [g.x1, g.y1], [g.x2, g.y2]);
      if (seg === null) return;
      g = { ...g, x1: seg[0][0], y1: seg[0][1], x2: seg[1][0], y2: seg[1][1] };
    } else if (g.type !== "ray" && g.type !== "xline") {
      const bb = geomBBox(g);
      if (bb !== null && !passesGate(bb)) return;
    }
    const s = (p: Pt): [number, number] => toScreen([p.x, p.y]);
    const isConstruction = g.type === "ray" || g.type === "xline";
    const stroke = (): void => {
      ctx.strokeStyle = selected ? SELECTED_STROKE : d.color;
      ctx.lineWidth = selected ? 2.4 : Math.max(isConstruction ? 0.75 : 1, d.weightPx);
      const dash = selected ? null : (d.dash ?? (g.type === "xline" ? [6, 4] : null));
      ctx.setLineDash(dash !== null ? [...dash] : []);
      ctx.stroke();
    };
    ctx.save();
    if (!selected && d.alpha < 1) ctx.globalAlpha = ctx.globalAlpha * d.alpha;
    switch (g.type) {
      case "line": {
        const a = s({ x: g.x1, y: g.y1 });
        const b = s({ x: g.x2, y: g.y2 });
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        stroke();
        break;
      }
      case "polyline": {
        if (g.vertices.length === 0) break;
        ctx.beginPath();
        const first = s(g.vertices[0]!);
        ctx.moveTo(first[0], first[1]);
        for (const v of g.vertices.slice(1)) {
          const p = s(v);
          ctx.lineTo(p[0], p[1]);
        }
        if (g.closed) ctx.closePath();
        stroke();
        break;
      }
      case "circle": {
        if (g.r * state.zoom < 0.5) break;
        const c = s({ x: g.cx, y: g.cy });
        ctx.beginPath();
        ctx.arc(c[0], c[1], g.r * state.zoom, 0, Math.PI * 2);
        stroke();
        break;
      }
      case "arc": {
        const c = s({ x: g.cx, y: g.cy });
        // Canvas Y is down: world CCW angles map to NEGATED screen angles
        // traversed counterclockwise (the paintText rotation mirror).
        ctx.beginPath();
        ctx.arc(c[0], c[1], g.r * state.zoom, -g.startAngle, -g.endAngle, true);
        stroke();
        break;
      }
      case "ellipse": {
        const c = s({ x: g.cx, y: g.cy });
        ctx.beginPath();
        ctx.ellipse(c[0], c[1], g.rx * state.zoom, g.ry * state.zoom, -g.rotation, 0, Math.PI * 2);
        stroke();
        break;
      }
      case "spline": {
        const pts = sampleSpline(g, 32);
        if (pts.length < 2) break;
        ctx.beginPath();
        const p0 = s(pts[0]!);
        ctx.moveTo(p0[0], p0[1]);
        for (const p of pts.slice(1)) {
          const q = s(p);
          ctx.lineTo(q[0], q[1]);
        }
        stroke();
        break;
      }
      case "point": {
        const p = s({ x: g.x, y: g.y });
        const color = selected ? SELECTED_STROKE : d.color;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, d.weightPx);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(p[0] - 3, p[1]);
        ctx.lineTo(p[0] + 3, p[1]);
        ctx.moveTo(p[0], p[1] - 3);
        ctx.lineTo(p[0], p[1] + 3);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p[0], p[1], 1.5, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case "ray":
      case "xline": {
        // Viewport-clipped (Liang–Barsky) — never an unbounded draw.
        const seg = clipInfinite({ x: g.x1, y: g.y1 }, infiniteDir(g), visibleWorldRectOf(state.pan, state.zoom), g.type === "ray");
        if (seg === null) break;
        const a = s(seg[0]);
        const b = s(seg[1]);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        stroke();
        break;
      }
      case "region": {
        // Translucent fill + boundary stroke + centroid cross (the SVG
        // drawGeomSvg region conventions, canvas-mirrored).
        const b = g.boundary;
        ctx.save();
        ctx.beginPath();
        if (b.kind === "circle") {
          const c = s({ x: b.cx, y: b.cy });
          ctx.arc(c[0], c[1], b.r * state.zoom, 0, Math.PI * 2);
        } else if (b.kind === "ellipse") {
          const c = s({ x: b.cx, y: b.cy });
          ctx.ellipse(c[0], c[1], b.rx * state.zoom, b.ry * state.zoom, -b.rotation, 0, Math.PI * 2);
        } else if (b.vertices.length > 0) {
          const first = s(b.vertices[0]!);
          ctx.moveTo(first[0], first[1]);
          for (const v of b.vertices.slice(1)) {
            const p = s(v);
            ctx.lineTo(p[0], p[1]);
          }
          ctx.closePath();
        }
        ctx.fillStyle = selected ? REGION_FILL_SELECTED : REGION_FILL;
        if (!selected && d.alpha < 1) ctx.globalAlpha = ctx.globalAlpha * d.alpha;
        ctx.fill();
        ctx.restore();
        const boundary: Geom =
          b.kind === "circle"
            ? { type: "circle", cx: b.cx, cy: b.cy, r: b.r }
            : b.kind === "ellipse"
              ? { type: "ellipse", cx: b.cx, cy: b.cy, rx: b.rx, ry: b.ry, rotation: b.rotation }
              : { type: "polyline", vertices: b.vertices, closed: true };
        paintGeomCanvas(ctx, boundary, d, selected);
        const c = s(g.centroid);
        ctx.strokeStyle = selected ? SELECTED_STROKE : d.color;
        ctx.lineWidth = Math.max(1, d.weightPx);
        ctx.setLineDash([]);
        ctx.globalAlpha = ctx.globalAlpha * 0.7;
        ctx.beginPath();
        ctx.moveTo(c[0] - 4, c[1]);
        ctx.lineTo(c[0] + 4, c[1]);
        ctx.moveTo(c[0], c[1] - 4);
        ctx.lineTo(c[0], c[1] + 4);
        ctx.stroke();
        break;
      }
    }
    ctx.restore();
    ctx.setLineDash([]);
  }

  /** Paint the unresolved-reference placeholder: a dashed gray box + label
   *  (the shared expansion's honest diagnostic rendering — never a blank). */
  function paintPlaceholderCanvas(
    ctx: CanvasRenderingContext2D,
    box: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number },
    label: string,
    selected: boolean,
  ): void {
    const a = toScreen([box.minX, box.maxY]);
    const b = toScreen([box.maxX, box.minY]);
    ctx.save();
    ctx.strokeStyle = selected ? SELECTED_STROKE : PLACEHOLDER_STROKE;
    ctx.lineWidth = selected ? 2.4 : 1.2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    ctx.setLineDash([]);
    ctx.fillStyle = selected ? SELECTED_STROKE : PLACEHOLDER_TEXT;
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(label, Math.min(a[0], b[0]) + 4, Math.min(a[1], b[1]) - 4);
    ctx.restore();
  }

  /** Draw one instance element through the ONE shared expansion: geometry
   *  pieces painted from the canonical props with the resolved display of
   *  each piece's own layer, text pieces through the SAME shared annotation
   *  painter, placeholders as the dashed box + label. Selected instances
   *  paint the highlighted conventions (thicker, full alpha — the annotation
   *  overlay mirror of the SVG selection emphasis). */
  function drawInstanceElement(el: Element, selected: boolean, layerById: ReadonlyMap<string, LayerRecord>): void {
    if (annoCtx === null) return;
    const entities = expandInstanceElement(el, blockTableOf());
    if (entities === null) return;
    const styleCtx = annotationStyleCtxOf();
    for (const e of entities) {
      if (e.kind === "geometry") {
        const geom = propsToGeom(e.props);
        if (geom === null) continue;
        paintGeomCanvas(annoCtx, geom, expandedDisplayOf(e.props, layerById), selected);
        continue;
      }
      if (e.kind === "text") {
        const piece = textPieceElement(el.id, e.props);
        const anno = annotationFromElement(piece);
        if (anno === null) continue;
        const d = expandedDisplayOf(e.props, layerById);
        paintAnnotationPrimitives(annoCtx, annotationPrimitives(anno, styleCtx), {
          toScreen: (p: Pt): [number, number] => toScreen([p.x, p.y]),
          zoom: state.zoom,
          color: d.color,
          weightPx: selected ? (d.weightPx ?? 1) * 1.8 : (d.weightPx ?? 1),
          dash: selected ? null : d.dash,
          alpha: selected ? 1 : d.alpha,
        });
        continue;
      }
      paintPlaceholderCanvas(annoCtx, e.box, e.label, selected);
    }
  }

  /** Hover emphasis for a picked-instance preview (ATTEDIT object picks,
   *  entity-step hovers): the expanded content stroked amber + thicker —
   *  the drawGeomEmphasis mirror for derived content. */
  function drawInstanceEmphasis(el: Element): void {
    if (annoCtx === null) return;
    const entities = expandInstanceElement(el, blockTableOf());
    if (entities === null) return;
    const emphasis = { color: PREVIEW_AMBER, weightPx: 3, dash: null as readonly number[] | null, alpha: 1 };
    for (const e of entities) {
      if (e.kind === "geometry") {
        const geom = propsToGeom(e.props);
        if (geom !== null) paintGeomCanvas(annoCtx, geom, emphasis, false);
        continue;
      }
      if (e.kind === "text") {
        const piece = textPieceElement(el.id, e.props);
        const anno = annotationFromElement(piece);
        if (anno === null) continue;
        paintAnnotationPrimitives(annoCtx, annotationPrimitives(anno, annotationStyleCtxOf()), {
          toScreen: (p: Pt): [number, number] => toScreen([p.x, p.y]),
          zoom: state.zoom,
          color: PREVIEW_AMBER,
          weightPx: 3,
          dash: null,
          alpha: 1,
        });
        continue;
      }
      paintPlaceholderCanvas(annoCtx, e.box, e.label, false);
    }
  }

  /** Pick the closest instance under the cursor BY ITS DERIVED CONTENT
   *  (expand → canonical closest-distance for geometry, the shared
   *  primitive-based text hit box, bbox distance for placeholders). Returns
   *  the INSTANCE element id + distance — the merged pick surface mirror of
   *  the Web blocks pick. */
  function pickInstanceAt(visible: readonly Element[], probe: Pt, aperture: number): { id: string; d: number } | null {
    const table = blockTableOf();
    const styleCtx = annotationStyleCtxOf();
    let best: { id: string; d: number } | null = null;
    const consider = (id: string, d: number): void => {
      if (d > aperture) return;
      if (best === null || d < best.d - 1e-12 || (Math.abs(d - best.d) <= 1e-12 && id < best.id)) best = { id, d };
    };
    for (const el of visible) {
      if (!isInstanceElement(el)) continue;
      const entities = expandInstanceElement(el, table);
      if (entities === null) continue;
      for (const e of entities) {
        if (e.kind === "geometry") {
          const geom = propsToGeom(e.props);
          if (geom === null) continue;
          consider(el.id, closestOn(geom, probe).d);
          continue;
        }
        if (e.kind === "text") {
          // The SAME shared primitive-based annotation pick (the pick surface
          // IS the render surface) over the synthetic text-piece element.
          const hit = pickAnnotationAt([textPieceElement(el.id, e.props)], probe, aperture, styleCtx);
          if (hit !== null) consider(hit.id, hit.d);
          continue;
        }
        // Placeholder — the distance to its bounding box.
        const dx = Math.max(e.box.minX - probe.x, 0, probe.x - e.box.maxX);
        const dy = Math.max(e.box.minY - probe.y, 0, probe.y - e.box.maxY);
        consider(el.id, Math.hypot(dx, dy));
      }
    }
    return best;
  }

  /** Window/crossing selection over instance DERIVED content: window mode
   *  needs EVERY piece fully inside (the whole block inside the rect);
   *  crossing needs ANY piece intersecting. Geometry pieces reuse the shared
   *  precision selectWindow tests; text pieces reuse the shared annotation
   *  selectAnnotations over the synthetic piece element; placeholders test
   *  their box. Deterministic — the Web host's instance selection mirror. */
  function selectInstanceElements(
    visible: readonly Element[],
    sel: { readonly mode: "window" | "crossing"; readonly min: Pt; readonly max: Pt },
  ): string[] {
    const table = blockTableOf();
    const styleCtx = annotationStyleCtxOf();
    const out: string[] = [];
    for (const el of visible) {
      if (!isInstanceElement(el)) continue;
      const entities = expandInstanceElement(el, table);
      if (entities === null || entities.length === 0) continue;
      let pieces = 0;
      let hits = 0;
      for (const e of entities) {
        if (e.kind === "geometry") {
          const geom = propsToGeom(e.props);
          if (geom === null) continue;
          pieces++;
          const hit = selectWindowGeom(
            [{ id: el.id, geom, layer: "0", color: null, linetype: "Continuous" }],
            sel,
          );
          if (hit.includes(el.id)) hits++;
          continue;
        }
        if (e.kind === "text") {
          pieces++;
          const hit = selectAnnotations([textPieceElement(el.id, e.props)], sel, styleCtx);
          if (hit.includes(el.id)) hits++;
          continue;
        }
        // Placeholder — rect fully inside (window) vs rect intersecting
        // (crossing), the conservative box tests.
        pieces++;
        const inside =
          e.box.minX >= sel.min.x - 1e-9 && e.box.maxX <= sel.max.x + 1e-9 &&
          e.box.minY >= sel.min.y - 1e-9 && e.box.maxY <= sel.max.y + 1e-9;
        const intersects =
          e.box.minX <= sel.max.x + 1e-9 && e.box.maxX >= sel.min.x - 1e-9 &&
          e.box.minY <= sel.max.y + 1e-9 && e.box.maxY >= sel.min.y - 1e-9;
        if (sel.mode === "window" ? inside : intersects) hits++;
      }
      if (pieces > 0 && (sel.mode === "window" ? hits === pieces : hits > 0)) out.push(el.id);
    }
    return out;
  }

  // --- entity views (CAD-PARITY-004: frozen = suppressed; locked = drawn
  // faded but not interactive — the same exclusion the App API precision
  // queries run) ---------------------------------------------------------

  /** DRAWABLE entities (rendering): visible + not frozen. LOCKED layers
   *  render (faded through the locked-layer fade alpha) — the SVG mirror of
   *  the Web drawableEntities. */
  function drawableElements(): Element[] {
    const renderable = new Set(
      (state.snapshot?.layers ?? []).filter((l: LayerRecord) => l.visible && l.frozen !== true).map((l: LayerRecord) => l.id),
    );
    return (state.snapshot?.elements ?? []).filter((el) => {
      const props = el.props as Record<string, unknown>;
      if (el.kind === "bim") return props.type === "bim.wall" || props.type === "bim.slab";
      return typeof props.layer === "string" && renderable.has(props.layer);
    });
  }

  /** INTERACTABLE entities (pick/snap/window selection): additionally excludes
   *  LOCKED layers (AutoCAD-class: locked entities display but do not
   *  interact; modification is blocked at the document gate). */
  function visibleElements(): Element[] {
    const interactable = new Set(
      (state.snapshot?.layers ?? [])
        .filter((l: LayerRecord) => l.visible && l.frozen !== true && l.locked !== true)
        .map((l: LayerRecord) => l.id),
    );
    return (state.snapshot?.elements ?? []).filter((el) => {
      const props = el.props as Record<string, unknown>;
      if (el.kind === "bim") return props.type === "bim.wall" || props.type === "bim.slab";
      return typeof props.layer === "string" && interactable.has(props.layer);
    });
  }

  /** The resolved display of one drawable entity (the shared standards
   *  resolution — the SAME code the Web host and the App API run). */
  interface DisplayDraw {
    readonly dash: readonly number[] | null;
    readonly weightPx: number;
    readonly alpha: number;
    readonly color: string;
  }

  /** CAD-PARITY-004: resolved display per drawable entity: linetype dash in
   *  device px, lineweight px, transparency alpha + locked-layer fade (the
   *  SVG mirror of the Web displayById). Unresolvable displays (stale
   *  linetype references) fall back to the layer color, solid, hairline —
   *  rendering never throws. */
  function computeDisplayMap(
    drawable: readonly Element[],
    layerById: ReadonlyMap<string, LayerRecord>,
  ): Map<string, DisplayDraw> {
    const userLtypes = state.snapshot?.ltypes ?? [];
    const standards = state.snapshot?.draftingSettings?.standards;
    const lweightDisplay = state.snapshot?.draftingSettings?.lineweightDisplay === true;
    const map = new Map<string, DisplayDraw>();
    for (const el of drawable) {
      const props = el.props as Record<string, unknown>;
      const layerId = typeof props.layer === "string" ? props.layer : "0";
      const layer = layerById.get(layerId);
      if (layer === undefined) continue;
      try {
        const resolved = resolveDisplay(displayOverridesOf(props), layer, standards, userLtypes);
        let alpha = transparencyToAlpha(resolved.transparency);
        if (layer.locked === true) alpha *= LOCKED_LAYER_FADE_ALPHA;
        map.set(el.id, {
          dash: resolved.dash.length > 0 ? dashToDevicePx(resolved.dash, state.zoom) : null,
          weightPx: lineweightToDevicePx(resolved.lineweight, state.zoom, lweightDisplay),
          alpha,
          color: resolved.color,
        });
      } catch {
        map.set(el.id, { dash: null, weightPx: 1, alpha: layer.locked === true ? LOCKED_LAYER_FADE_ALPHA : 1, color: layer.color });
      }
    }
    return map;
  }

  function constrainSnap(
    world: Vec2,
    shift: boolean,
    precomputed?: readonly GeomEntity[],
  ): { point: Vec2; snapped: boolean; mode: OsnapMode | null } {
    // The EFFECTIVE step is option-capture aware (CAD-PARITY-003) — the
    // rubber base follows the paused step's baseStep exactly like the Web.
    const step = effectiveStep(state.engine);
    const base = stepBaseOf(step);
    const aids: DraftingAids = shift ? { ...state.aids, ortho: true } : state.aids;
    const constrained = constrainCursor(base, world, aids).point;
    const settings = state.snapshot?.draftingSettings;
    if (settings?.snap.enabled !== true) return { point: constrained, snapped: false, mode: null };
    // CAD-PARITY-003: the SAME shared precision engine the Web host and the
    // App API precision queries run (parity by construction).
    const geoms = precomputed ?? toEntities(visibleElements());
    const r = resolveSnapPrecision(
      geoms,
      { x: constrained[0], y: constrained[1] },
      precisionAids(),
      base !== null ? { x: base[0], y: base[1] } : null,
    );
    if (r.mode === null) return { point: constrained, snapped: false, mode: null };
    return { point: [r.point.x, r.point.y], snapped: true, mode: r.mode };
  }

  /** The rubber/preview base point of the effective step (baseStep value,
   *  else the engine's lastPoint) — mirrors the Web stepBase. */
  function stepBaseOf(step: { readonly baseStep?: string } | null): Vec2 | null {
    if (step !== null && step.baseStep !== undefined) {
      const v = state.engine.values[step.baseStep];
      if (v !== undefined && v.kind === "point") return v.point;
    }
    return state.engine.lastPoint;
  }

  // CAD-PARITY-003 shared precision settings (CAD-2D-003): the professional
  // default osnap mode set, the drafting-settings snap tolerance as aperture,
  // ortho/polar from the host aids. Grid snapping stays off (grid is drawn
  // but not snapped to) — the Web host's exact composition.
  function precisionAids(): PrecisionSettings {
    const settings = state.snapshot?.draftingSettings;
    return {
      osnapModes: ["endpoint", "midpoint", "center", "quadrant", "intersection", "node"],
      ortho: state.aids.ortho,
      polar: state.aids.polar,
      polarAnglesDeg: [0, 45, 90, 135, 180, 225, 270, 315],
      gridSnap: false,
      gridSize: settings?.grid.size ?? 10,
      aperture: settings?.snap.tolerance ?? 0.5,
      tracking: false,
    };
  }

  /** Deterministic merged pick (CAD-PARITY-003, mirror of the Web
   *  pickEntityAt): the shared pickAt over the canonical entity view, merged
   *  with the legacy hitTest (which also covers legacy dimension annotations)
   *  and the CAD-PARITY-005 annotation pick (primitive-based — the pick
   *  surface IS the render surface). Closest distance wins; ties break by
   *  element id. */
  function pickEntityAt(world: Vec2, geoms: readonly GeomEntity[], visible: readonly Element[]): { id: string; d: number } | null {
    // COMPAT-CAD-005: the DECLARED pickbox (see precision-2d) — the one
    // deterministic screen-space tolerance, the Web host's mirror.
    const aperture = pickApertureWorld(state.zoom);
    const probe = { x: world[0], y: world[1] };
    const canonical = pickAtGeom(geoms, probe, aperture);
    let canonicalBest: { id: string; d: number } | null = null;
    if (canonical !== null) {
      canonicalBest = { id: canonical.id, d: closestOn(canonical.geom, probe).d };
    }
    const legacyHits = hitTest(world, aperture, visible);
    const legacyBest = legacyHits.length > 0 ? { id: legacyHits[0]!.id, d: legacyHits[0]!.distance } : null;
    // CAD-PARITY-005: annotations pick where they paint (primitives).
    const annotationPick = pickAnnotationAt(visible, probe, aperture, annotationStyleCtxOf());
    const annotationBest = annotationPick !== null ? { id: annotationPick.id, d: annotationPick.d } : null;
    // CAD-PARITY-006: block/xref instances pick by their DERIVED content
    // (expand → canonical/text/placeholder distances), returning the
    // INSTANCE element id.
    const instanceBest = pickInstanceAt(visible, probe, aperture);
    let best: { id: string; d: number } | null = null;
    const consider = (c: { id: string; d: number } | null): void => {
      if (c === null) return;
      if (best === null || c.d < best.d - 1e-12 || (Math.abs(c.d - best.d) <= 1e-12 && c.id < best.id)) best = c;
    };
    consider(canonicalBest);
    consider(legacyBest);
    consider(annotationBest);
    consider(instanceBest);
    return best;
  }

  // --- canvas pointer interaction ------------------------------------------------------------

  let dragKind: "pan" | "selection" | "commandSelection" | null = null;
  let dragStart: Vec2 = [0, 0];
  let dragStartScreen: [number, number] = [0, 0];
  let dragPan = { x: 0, y: 0 };
  let selRect: { a: Vec2; b: Vec2 } | null = null;
  let lastClick: { screen: [number, number]; at: number; index: number } | null = null;
  let gripDragState: { id: string; element: Element } | null = null;

  function svgPoint(e: MouseEvent): Vec2 {
    const rect = svg.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * SVG_W;
    const sy = ((e.clientY - rect.top) / rect.height) * SVG_H;
    return toWorld(sx, sy);
  }

  svg.addEventListener("mousedown", (e) => {
    // Focus for the canvas keymap WITHOUT scrolling — a canvas that extends
    // past the viewport must not jump on click (also keeps synthetic-event
    // client coordinates stable for the smoke driver).
    svg.focus({ preventScroll: true });
    const world = svgPoint(e);
    if (e.button === 1) {
      dragKind = "pan";
      const rect0 = svg.getBoundingClientRect();
      dragStartScreen = [((e.clientX - rect0.left) / rect0.width) * SVG_W, ((e.clientY - rect0.top) / rect0.height) * SVG_H];
      dragPan = { ...state.pan };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    // Grip drag start. CAD-PARITY-004: locked layers offer no grip editing —
    // the grips are not rendered and the drag start is skipped (the document
    // gate would reject the write anyway).
    const cmd = commandById(state.engine.commandId ?? "");
    const stepActive = cmd !== null && cmd.steps.length > 0;
    if (!stepActive && state.selection.length === 1) {
      const el = (state.snapshot?.elements ?? []).find((x) => x.id === state.selection[0]);
      const elLayerId = el !== undefined ? (el.props as Record<string, unknown>).layer : undefined;
      const elLocked =
        el !== undefined && typeof elLayerId === "string" &&
        (state.snapshot?.layers ?? []).some((l) => l.id === elLayerId && l.locked === true);
      if (el !== undefined && !elLocked) {
        for (const grip of gripsFor(el)) {
          const gs = toScreen(grip.point);
          const rect = svg.getBoundingClientRect();
          const px = (gs[0] / SVG_W) * rect.width + rect.left;
          const py = (gs[1] / SVG_H) * rect.height + rect.top;
          if (Math.hypot(px - e.clientX, py - e.clientY) <= 8) {
            gripDragState = { id: grip.id, element: el };
            e.preventDefault();
            return;
          }
        }
      }
    }

    if (stepActive && cmd !== null) {
      // The EFFECTIVE step is option-capture aware (CAD-PARITY-003): while a
      // FILLET R / OFFSET T sub-prompt is active, picks route through the
      // sub-prompt, not the paused step — same as the Web host.
      const step = effectiveStep(state.engine);
      if (step !== null && step.kind === "entity") {
        const visible = visibleElements();
        const picked = pickEntityAt(world, toEntities(visible), visible);
        const hit = picked !== null ? (state.snapshot?.elements ?? []).find((el) => el.id === picked.id) : undefined;
        if (hit !== undefined) {
          void dispatchEngine({ type: "entity", entity: { id: hit.id, kind: hit.kind, props: hit.props as Record<string, unknown> } });
        } else {
          // COMPAT-CAD-007 (Issue #142; DEF-006): a miss during a command
          // select phase STARTS a window/crossing drag (the Web host's
          // mirror — the benchmark's "drag-select attempts also fail"
          // probe). A plain click (< 4 px) still reports the "0 found" miss
          // on mouseup; a drag resolves through the shared command-select
          // core and dispatches one `entities` batch to the engine.
          dragKind = "commandSelection";
          dragStart = world;
          selRect = { a: world, b: world };
          renderModel();
        }
        return;
      }
      // CAD-PARITY-003 entityPoint step: pick the object under the cursor AND
      // dispatch the RAW world point — the pick location is semantic for
      // TRIM/EXTEND/FILLET/CHAMFER/BREAK (no snap constraint applies to it).
      if (step !== null && step.kind === "entityPoint") {
        const visible = visibleElements();
        const picked = pickEntityAt(world, toEntities(visible), visible);
        if (picked !== null) {
          const hit = (state.snapshot?.elements ?? []).find((el) => el.id === picked.id);
          if (hit !== undefined) {
            void dispatchEngine({
              type: "entityPoint",
              entity: { id: hit.id, kind: hit.kind, props: hit.props as Record<string, unknown> },
              point: [world[0], world[1]],
            });
          }
        } else {
          // COMPAT-CAD-005: visible "0 found" feedback (the Web host's mirror).
          pushLines([`0 found — nothing within the pickbox at (${Math.round(world[0])}, ${Math.round(world[1])}).`]);
        }
        return;
      }
      const { point } = constrainSnap(world, e.shiftKey);
      void dispatchEngine({ type: "pick", point });
      return;
    }

    // Selection mode — the merged canonical + legacy pick (CAD-PARITY-003).
    const visible = visibleElements();
    const geoms = toEntities(visible);
    const picked = pickEntityAt(world, geoms, visible);
    if (picked !== null) {
      const hits = hitTest(world, pickApertureWorld(state.zoom), visible);
      if (hits.length > 0 && hits[0]!.id === picked.id) {
        // Legacy pickability — stacked-hit cycling preserved.
        const now = Date.now();
        let chosen = hits[0]!.id;
        let index = 0;
        if (lastClick !== null && now - lastClick.at < 700) {
          const cycled = cyclePick(world, pickApertureWorld(state.zoom), visible, lastClick.index);
          if (cycled !== null) {
            chosen = cycled.id;
            index = cycled.index;
          }
        }
        lastClick = { screen: [e.clientX, e.clientY], at: now, index };
        const next = applyPickModifier(state.selection, chosen, e.shiftKey ? "toggle" : "replace");
        void command("document.setSelection", { ids: next }).then(() => {
          state.selection = [...next];
          renderModel();
        });
        return;
      }
      // Canonical-only hit (ellipse/spline/point/ray/xline/region …).
      lastClick = null;
      const next = applyPickModifier(state.selection, picked.id, e.shiftKey ? "toggle" : "replace");
      void command("document.setSelection", { ids: next }).then(() => {
        state.selection = [...next];
        renderModel();
      });
      return;
    }
    lastClick = null;
    dragKind = "selection";
    dragStart = world;
    selRect = { a: world, b: world };
    renderModel();
  });

  svg.addEventListener("mousemove", (e) => {
    const world = svgPoint(e);
    state.cursor = world;
    if (dragKind === "pan") {
      const rect = svg.getBoundingClientRect();
      const sx = ((e.clientX - rect.left) / rect.width) * SVG_W;
      const sy = ((e.clientY - rect.top) / rect.height) * SVG_H;
      state.pan = {
        x: dragPan.x - (sx - dragStartScreen[0]) / state.zoom,
        y: dragPan.y + (sy - dragStartScreen[1]) / state.zoom,
      };
      renderModel();
      return;
    }
    if ((dragKind === "selection" || dragKind === "commandSelection") && selRect !== null) {
      selRect = { a: dragStart, b: world };
      renderModel();
      return;
    }
    renderModel();
    renderStatusBar();
  });

  svg.addEventListener("mouseup", (e) => {
    if (dragKind === "pan") {
      dragKind = null;
      return;
    }
    // COMPAT-CAD-007 (Issue #142; DEF-006): the command-phase window/crossing
    // drag — the Web host's mirror. A sub-threshold release is the plain
    // click miss (the CC005 "0 found" contract); a real drag resolves
    // through the SHARED command-select core (the same merge both hosts
    // run) and dispatches one `entities` batch to the engine.
    if (dragKind === "commandSelection" && selRect !== null) {
      const a: Vec2 = [selRect.a[0], selRect.a[1]];
      const b: Vec2 = [selRect.b[0], selRect.b[1]];
      const moved = Math.hypot(b[0] - a[0], b[1] - a[1]);
      dragKind = null;
      selRect = null;
      renderModel();
      if (moved < 4 / state.zoom) {
        pushLines([`0 found — nothing within the pickbox at (${Math.round(a[0])}, ${Math.round(a[1])}).`]);
        return;
      }
      const visible = visibleElements();
      const picks = commandWindowPicks(
        [a[0], a[1]],
        [b[0], b[1]],
        visible,
        toEntities(visible),
        annotationStyleCtxOf(),
      );
      void dispatchEngine({ type: "entities", entities: [...picks] });
      return;
    }
    if (dragKind === "selection" && selRect !== null) {
      const rect = selectionRectangle(selRect.a, selRect.b);
      const moved = Math.hypot(selRect.b[0] - selRect.a[0], selRect.b[1] - selRect.a[1]);
      dragKind = null;
      selRect = null;
      if (moved < 4 / state.zoom) {
        if (state.selection.length > 0) {
          void command("document.setSelection", { ids: [] }).then(() => {
            state.selection = [];
            renderModel();
          });
        }
        return;
      }
      const visible = visibleElements();
      const ids = windowSelect(rect, visible);
      // CAD-PARITY-003 canonical entities — the SAME window/crossing
      // semantics as the shared precision engine (legacy ids stay first,
      // deterministic document order for the new ones).
      const canonicalIds = selectWindowGeom(toEntities(visible), {
        mode: rect.mode,
        min: { x: rect.min[0], y: rect.min[1] },
        max: { x: rect.max[0], y: rect.max[1] },
      });
      const merged: string[] = [...ids];
      for (const id of canonicalIds) {
        if (!merged.includes(id)) merged.push(id);
      }
      // CAD-PARITY-005: annotations select through their render primitives
      // (window = whole primitive set inside, crossing = any intersection);
      // deduped by id against the geometry paths.
      const annotationIds = selectAnnotations(
        visible,
        { mode: rect.mode, min: { x: rect.min[0], y: rect.min[1] }, max: { x: rect.max[0], y: rect.max[1] } },
        annotationStyleCtxOf(),
      );
      for (const id of annotationIds) {
        if (!merged.includes(id)) merged.push(id);
      }
      // CAD-PARITY-006: block/xref instances select through their DERIVED
      // content (window = every expanded piece inside, crossing = any piece
      // intersecting) — the instance element id joins the selection.
      const instanceIds = selectInstanceElements(
        visible,
        { mode: rect.mode, min: { x: rect.min[0], y: rect.min[1] }, max: { x: rect.max[0], y: rect.max[1] } },
      );
      for (const id of instanceIds) {
        if (!merged.includes(id)) merged.push(id);
      }
      const next = e.shiftKey ? Array.from(new Set([...state.selection, ...merged])) : merged;
      void command("document.setSelection", { ids: next }).then(() => {
        state.selection = [...next];
        renderModel();
      });
      return;
    }
    if (gripDragState !== null) {
      const world = svgPoint(e);
      const snapped = constrainSnap(world, e.shiftKey).point;
      const result: GripEditResult | null = gripDrag(gripDragState.element, gripDragState.id, snapped);
      gripDragState = null;
      if (result !== null && result.appApi.length > 0) {
        pushLines(result.echo);
        void (async () => {
          for (const entry of result.appApi) {
            await command(entry.name, entry.payload);
          }
          await refresh();
        })();
      }
    }
  });

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    // COMPAT-CAD-006 (Issue #138): wheel zoom anchored at the cursor — the
    // world point under the pointer stays at the same screen position (the
    // shared zoomAboutPoint invariant, the Web wheel mirror). Clamped to the
    // declared desktop limits; view-only.
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const anchor = svgPoint(e);
    const next = sharedZoomAboutPoint(sharedViewTransformOf(state.pan, state.zoom, { w: SVG_W, h: SVG_H }), factor, anchor, DESKTOP_ZOOM_LIMITS);
    state.zoom = next.zoom;
    state.pan = { x: next.pan.x, y: next.pan.y };
    renderModel();
  }, { passive: false });

  svg.addEventListener("dblclick", () => {
    void dispatchEngine({ type: "enter" });
  });

  // --- CAD-PARITY-004 idle-canvas context menu (right-click) -----------------------
  // During a command, right-click keeps its existing behavior (no menu — the
  // command line owns the interaction); when idle, right-click opens the
  // contextual layer/properties menu at the cursor — the SAME App API commands
  // the Web context menu issues.

  let ctxMenu: { backdrop: HTMLDivElement; root: HTMLDivElement } | null = null;

  function closeContextMenu(): void {
    if (ctxMenu !== null) {
      ctxMenu.backdrop.remove();
      ctxMenu.root.remove();
      ctxMenu = null;
    }
  }

  svg.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    closeContextMenu();
    // During a command (any active step, including option capture), right
    // click keeps the legacy no-op behavior.
    if (effectiveStep(state.engine) !== null) return;
    const world = svgPoint(e);
    const visible = visibleElements();
    const picked = pickEntityAt(world, toEntities(visible), visible);
    let layer: LayerRecord | null = null;
    if (picked !== null) {
      const hit = (state.snapshot?.elements ?? []).find((el) => el.id === picked.id);
      const layerId = (hit?.props as Record<string, unknown> | undefined)?.layer;
      if (hit !== undefined && typeof layerId === "string") {
        layer = (state.snapshot?.layers ?? []).find((l) => l.id === layerId) ?? null;
      }
    }
    openContextMenu(e.clientX, e.clientY, layer);
  });

  function openContextMenu(clientX: number, clientY: number, layer: LayerRecord | null): void {
    const backdrop = h("div", "pro-ctx-backdrop");
    const root = h("div", "pro-ctx-menu");
    root.setAttribute("role", "menu");
    root.setAttribute("aria-label", "canvas context menu");
    root.setAttribute("data-testid", "pro-context-menu");
    const close = (): void => closeContextMenu();
    backdrop.addEventListener("click", close);
    backdrop.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      close();
    });
    const item = (label: string, run: () => void, disabled = false): void => {
      const b = h("button", "pro-ctx-item");
      b.type = "button";
      b.textContent = label;
      b.setAttribute("role", "menuitem");
      if (disabled) {
        b.disabled = true;
      } else {
        b.addEventListener("click", () => {
          closeContextMenu();
          run();
        });
      }
      root.append(b);
    };
    const sep = (): void => {
      const s = h("div", "pro-ctx-sep");
      root.append(s);
    };
    const updateLayer = (layerId: string, patch: Record<string, unknown>): void => {
      commitCommand("drafting.updateLayer", { layerId, patch });
    };
    if (layer !== null) {
      const head = h("div", "pro-ctx-head");
      head.textContent = `Layer “${layer.name}”`;
      root.append(head);
      item(layer.visible ? "Hide layer" : "Show layer", () => updateLayer(layer.id, { visible: !layer.visible }));
      item(
        layer.frozen === true ? "Thaw layer" : "Freeze layer",
        () => updateLayer(layer.id, { frozen: layer.frozen !== true }),
        layer.frozen !== true && layer.id === "0",
      );
      item(layer.locked === true ? "Unlock layer" : "Lock layer", () => updateLayer(layer.id, { locked: layer.locked !== true }));
      item("Isolate layer", () => {
        void (async () => {
          const res = await command("layer.isolate", { layerIds: [layer.id] });
          if (!res.ok) pushLines([`*ERROR* layer.isolate: ${res.code} — ${res.message}`]);
          else pushLines(["LAYISO: 1 layer isolated. LAYUNISO restores."]);
          await refresh();
        })();
      });
      item("Make active layer", () => commitCommand("layer.setActive", { layerId: layer.id }));
    } else {
      const head = h("div", "pro-ctx-head");
      head.textContent = "Layers";
      root.append(head);
    }
    sep();
    item("Show all layers (LAYON)", () => {
      const edits = (state.snapshot?.layers ?? []).map((l) => ({ type: "updateLayer" as const, layerId: l.id, patch: { visible: true } }));
      if (edits.length > 0) {
        void (async () => {
          const res = await command("document.applyEdit", { edit: { type: "applyEdits", edits } });
          if (!res.ok) pushLines([`*ERROR* LAYON: ${res.code} — ${res.message}`]);
          else pushLines([`LAYON: ${edits.length} layer(s) turned on.`]);
          await refresh();
        })();
      }
    });
    item("Unisolate layers (LAYUNISO)", () => {
      void (async () => {
        const res = await command("layer.unisolate", {});
        if (!res.ok) pushLines([`*ERROR* LAYUNISO: ${res.code} — ${res.message}`]);
        else pushLines(["LAYUNISO: layer table restored."]);
        await refresh();
      })();
    });
    item("Layer Manager…", () => openDock("layers"));
    item("Properties…", () => showInspector());
    document.body.append(backdrop, root);
    // Clamp to the viewport.
    root.style.left = `${Math.max(4, Math.min(clientX, window.innerWidth - 210))}px`;
    root.style.top = `${Math.max(4, Math.min(clientY, window.innerHeight - 260))}px`;
    ctxMenu = { backdrop, root };
  }

  // Any canvas interaction closes an open context menu.
  svg.addEventListener("mousedown", () => closeContextMenu());
  window.addEventListener("blur", () => closeContextMenu());

  // --- CAD-PARITY-003 canonical entity painting (SVG mirror of the Web draw.ts) --------------

  const SELECTED_STROKE = "#0ea5e9";
  const REGION_FILL = "rgba(13,148,136,0.10)";
  const REGION_FILL_SELECTED = "rgba(14,165,233,0.16)";
  const PREVIEW_AMBER = "#f59e0b";
  const GHOST_STROKE = "rgba(14,165,233,0.55)";

  interface GeomSvgStyle {
    readonly stroke: string;
    readonly width: number;
    readonly dash: readonly number[] | null;
    readonly fill: string | null;
    /** CAD-PARITY-004: composite alpha (transparency + locked-layer fade). */
    readonly alpha?: number;
  }

  function styleGeomElement(node: SVGElement, style: GeomSvgStyle, fill: boolean): void {
    node.setAttribute("stroke", style.stroke);
    node.setAttribute("stroke-width", String(style.width));
    if (style.dash !== null) node.setAttribute("stroke-dasharray", style.dash.join(" "));
    if (style.alpha !== undefined && style.alpha < 1) {
      node.setAttribute("stroke-opacity", String(style.alpha));
      node.setAttribute("fill-opacity", String(style.alpha));
    }
    node.setAttribute("fill", fill && style.fill !== null ? style.fill : "none");
  }

  /** Paint one canonical Geom (shared by entity rendering, hover emphasis
   *  and command previews — the SVG mirror of the Web paintGeom). */
  function drawGeomSvg(g: Geom, style: GeomSvgStyle): void {
    const s = (p: Pt): [number, number] => toScreen([p.x, p.y]);
    switch (g.type) {
      case "line": {
        const l = svgNs("line");
        const a = s({ x: g.x1, y: g.y1 });
        const b = s({ x: g.x2, y: g.y2 });
        l.setAttribute("x1", String(a[0])); l.setAttribute("y1", String(a[1]));
        l.setAttribute("x2", String(b[0])); l.setAttribute("y2", String(b[1]));
        styleGeomElement(l, style, false);
        svg.append(l);
        break;
      }
      case "polyline": {
        if (g.vertices.length === 0) break;
        const pl = svgNs("polyline");
        pl.setAttribute("points", g.vertices.map((p) => s(p).join(",")).join(" "));
        styleGeomElement(pl, style, true);
        svg.append(pl);
        break;
      }
      case "circle": {
        if (g.r * state.zoom < 0.5) break;
        const c = s({ x: g.cx, y: g.cy });
        const el = svgNs("circle");
        el.setAttribute("cx", String(c[0]));
        el.setAttribute("cy", String(c[1]));
        el.setAttribute("r", String(g.r * state.zoom));
        styleGeomElement(el, style, true);
        svg.append(el);
        break;
      }
      case "arc": {
        const sweep = arcSweep(g);
        const p0: Pt = { x: g.cx + g.r * Math.cos(g.startAngle), y: g.cy + g.r * Math.sin(g.startAngle) };
        const p1: Pt = { x: g.cx + g.r * Math.cos(g.endAngle), y: g.cy + g.r * Math.sin(g.endAngle) };
        const s0 = s(p0);
        const s1 = s(p1);
        const path = svgNs("path");
        // World CCW sweep stays visually CCW on screen (the screen transform
        // flips Y) — SVG sweep-flag 0; large-arc when the sweep exceeds 180°.
        path.setAttribute("d", `M ${s0[0]} ${s0[1]} A ${g.r * state.zoom} ${g.r * state.zoom} 0 ${sweep > Math.PI ? 1 : 0} 0 ${s1[0]} ${s1[1]}`);
        styleGeomElement(path, style, false);
        svg.append(path);
        break;
      }
      case "ellipse": {
        const c = s({ x: g.cx, y: g.cy });
        const el = svgNs("ellipse");
        el.setAttribute("cx", String(c[0]));
        el.setAttribute("cy", String(c[1]));
        el.setAttribute("rx", String(g.rx * state.zoom));
        el.setAttribute("ry", String(g.ry * state.zoom));
        // World rotation is CCW (Y up); the screen transform flips Y, so the
        // SVG transform rotates by the NEGATED angle — the mirror of the
        // Web host's ctx.ellipse rotation negation.
        el.setAttribute("transform", `rotate(${(-g.rotation * 180) / Math.PI} ${c[0]} ${c[1]})`);
        styleGeomElement(el, style, true);
        svg.append(el);
        break;
      }
      case "spline": {
        const pts = sampleSpline(g, 32);
        if (pts.length < 2) break;
        const pl = svgNs("polyline");
        pl.setAttribute("points", pts.map((p) => s(p).join(",")).join(" "));
        styleGeomElement(pl, style, false);
        svg.append(pl);
        break;
      }
      case "point": {
        const p = s({ x: g.x, y: g.y });
        const l1 = svgNs("line");
        l1.setAttribute("x1", String(p[0] - 3)); l1.setAttribute("y1", String(p[1]));
        l1.setAttribute("x2", String(p[0] + 3)); l1.setAttribute("y2", String(p[1]));
        styleGeomElement(l1, style, false);
        const l2 = svgNs("line");
        l2.setAttribute("x1", String(p[0])); l2.setAttribute("y1", String(p[1] - 3));
        l2.setAttribute("x2", String(p[0])); l2.setAttribute("y2", String(p[1] + 3));
        styleGeomElement(l2, style, false);
        const dot = svgNs("circle");
        dot.setAttribute("cx", String(p[0]));
        dot.setAttribute("cy", String(p[1]));
        dot.setAttribute("r", "1.5");
        dot.setAttribute("fill", style.stroke);
        svg.append(l1, l2, dot);
        break;
      }
      case "ray":
      case "xline": {
        // Viewport-clipped (Liang–Barsky) — never an unbounded DOM node.
        const seg = clipInfinite({ x: g.x1, y: g.y1 }, infiniteDir(g), visibleWorldRectOf(state.pan, state.zoom), g.type === "ray");
        if (seg === null) break;
        const l = svgNs("line");
        const a = s(seg[0]);
        const b = s(seg[1]);
        l.setAttribute("x1", String(a[0])); l.setAttribute("y1", String(a[1]));
        l.setAttribute("x2", String(b[0])); l.setAttribute("y2", String(b[1]));
        styleGeomElement(l, style, false);
        svg.append(l);
        break;
      }
      case "region": {
        // Translucent fill + boundary stroke (circle/ellipse/polyline kinds).
        const b = g.boundary;
        const boundary: Geom =
          b.kind === "circle"
            ? { type: "circle", cx: b.cx, cy: b.cy, r: b.r }
            : b.kind === "ellipse"
              ? { type: "ellipse", cx: b.cx, cy: b.cy, rx: b.rx, ry: b.ry, rotation: b.rotation }
              : { type: "polyline", vertices: b.vertices, closed: true };
        drawGeomSvg(boundary, style);
        // Centroid marker (small cross).
        const c = s(g.centroid);
        for (const [x1, y1, x2, y2] of [
          [c[0] - 4, c[1], c[0] + 4, c[1]],
          [c[0], c[1] - 4, c[0], c[1] + 4],
        ] as const) {
          const m = svgNs("line");
          m.setAttribute("x1", String(x1)); m.setAttribute("y1", String(y1));
          m.setAttribute("x2", String(x2)); m.setAttribute("y2", String(y2));
          m.setAttribute("stroke", style.stroke);
          m.setAttribute("stroke-width", String(style.width));
          m.setAttribute("stroke-opacity", String(0.7 * (style.alpha ?? 1)));
          svg.append(m);
        }
        break;
      }
    }
  }

  /** Draw a canonical CAD-PARITY-003 entity (any drafting element decoded
   *  through the geometry bridge — BOTH storage conventions). Professional
   *  conventions mirror the Web host: rays draw thin, construction lines
   *  thin, regions fill translucent with a stroked boundary, points draw as
   *  small crosses. CAD-PARITY-004: the resolved display (linetype dash in
   *  device px, lineweight px, transparency/locked-fade alpha) flows through
   *  the options — the SAME resolution both hosts run (standards module);
   *  selection strokes stay solid + highlighted for contrast. */
  function drawCanonicalEntity(
    geom: Geom,
    opts: { color: string; selected: boolean; dash?: readonly number[] | null; weightPx?: number; alpha?: number },
  ): void {
    // COMPAT-CAD-006 (Issue #138): the deterministic viewport gate — LINE
    // geoms are pre-clipped (shared Liang–Barsky) so the SVG coordinates
    // stay bounded at any world scale (the explicit partial-clip contract —
    // the visible portion of a boundary-crossing segment draws); every
    // other geom type is bbox-gated (rays/xlines never culled — the painter
    // clips them to the visible rect itself).
    if (geom.type === "line") {
      const seg = sharedClipSegment(viewGateRect(), [geom.x1, geom.y1], [geom.x2, geom.y2]);
      if (seg === null) return;
      geom = { ...geom, x1: seg[0][0], y1: seg[0][1], x2: seg[1][0], y2: seg[1][1] };
    } else if (geom.type !== "ray" && geom.type !== "xline") {
      const bb = geomBBox(geom);
      if (bb !== null && !passesGate(bb)) return;
    }
    const isConstruction = geom.type === "ray" || geom.type === "xline";
    const legacyWidth = isConstruction ? 1 : 1.6;
    drawGeomSvg(geom, {
      stroke: opts.selected ? SELECTED_STROKE : opts.color,
      width: opts.selected ? 2.4 : Math.max(isConstruction ? 0.75 : 1, opts.weightPx ?? legacyWidth),
      dash: opts.selected ? null : (opts.dash ?? (geom.type === "xline" ? [6, 4] : null)),
      fill: geom.type === "region" ? (opts.selected ? REGION_FILL_SELECTED : REGION_FILL) : null,
      alpha: opts.alpha,
    });
  }

  /** Emphasize an entity (hover highlight before a pick, or a picked target
   *  during FILLET/CHAMFER/BREAK): a thicker amber stroke over the geometry. */
  function drawGeomEmphasis(g: Geom): void {
    drawGeomSvg(g, {
      stroke: PREVIEW_AMBER,
      width: 3,
      dash: null,
      fill: g.type === "region" ? "rgba(245,158,11,0.14)" : null,
    });
  }

  /** Snap marker at a snap point — mode-aware shapes in the professional
   *  osnap vocabulary (mirror of the Web drawSnapMarker). The default keeps
   *  the CAD-PARITY-002 square marker. */
  function drawSnapMarkerSvg(screen: [number, number], mode: OsnapMode | null): void {
    const r = 5;
    const x = screen[0];
    const y = screen[1];
    const stroke: GeomSvgStyle = { stroke: "#0d9488", width: 1.6, dash: null, fill: null };
    const crossLine = (x1: number, y1: number, x2: number, y2: number): void => {
      const l = svgNs("line");
      l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1));
      l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2));
      styleGeomElement(l, stroke, false);
      svg.append(l);
    };
    switch (mode) {
      case "midpoint": {
        const p = svgNs("polygon");
        p.setAttribute("points", `${x - r},${y + r * 0.7} ${x},${y - r} ${x + r},${y + r * 0.7}`);
        styleGeomElement(p, stroke, false);
        svg.append(p);
        break;
      }
      case "center": {
        const c = svgNs("circle");
        c.setAttribute("cx", String(x)); c.setAttribute("cy", String(y)); c.setAttribute("r", String(r));
        styleGeomElement(c, stroke, false);
        svg.append(c);
        break;
      }
      case "quadrant": {
        const p = svgNs("polygon");
        p.setAttribute("points", `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`);
        styleGeomElement(p, stroke, false);
        svg.append(p);
        break;
      }
      case "intersection":
        crossLine(x - r, y - r, x + r, y + r);
        crossLine(x + r, y - r, x - r, y + r);
        break;
      case "node":
        crossLine(x - r, y - r, x + r, y + r);
        crossLine(x + r, y - r, x - r, y + r);
        crossLine(x - r, y, x + r, y);
        crossLine(x, y - r, x, y + r);
        break;
      default: {
        // endpoint / perpendicular / tangent / nearest / unknown — the
        // CAD-PARITY-002 square marker.
        const m = svgNs("rect");
        m.setAttribute("x", String(x - r)); m.setAttribute("y", String(y - r));
        m.setAttribute("width", String(r * 2)); m.setAttribute("height", String(r * 2));
        styleGeomElement(m, stroke, false);
        svg.append(m);
        break;
      }
    }
  }

  // --- CAD-PARITY-003 rubber-band command previews (mirror of the Web drawCommandPreview) ------

  function previewPointValue(id: string): Pt | null {
    const v = state.engine.values[id];
    return v !== undefined && v.kind === "point" ? { x: v.point[0], y: v.point[1] } : null;
  }

  function previewPointsValue(id: string): readonly Pt[] {
    const v = state.engine.values[id];
    return v !== undefined && v.kind === "points" ? v.points.map((p) => ({ x: p[0], y: p[1] })) : [];
  }

  function previewEntityIds(id: string): readonly string[] {
    const v = state.engine.values[id];
    return v !== undefined && v.kind === "entities" ? v.entities.map((e) => e.id) : [];
  }

  function previewEntityPointIds(id: string): readonly string[] {
    const v = state.engine.values[id];
    return v !== undefined && v.kind === "entityPoints" ? v.picks.map((p) => p.entity.id) : [];
  }

  /** Live preview for the CAD-PARITY-003 commands — ghost geometry, axis
   *  lines, live entities and picked-object emphasis. Dashed amber rubber
   *  lines + translucent blue ghosts; deterministic per
   *  (command, values, cursor). SVG mirror of the Web drawCommandPreview. */
  function drawCommandPreview(cmd: WorkspaceCommand, geoms: readonly GeomEntity[], geomById: Map<string, GeomEntity>): void {
    if (state.cursor === null) return;
    const values: Readonly<Record<string, PromptValue>> = state.engine.values;
    const cursor: Pt = { x: state.cursor[0], y: state.cursor[1] };
    const rubber: GeomSvgStyle = { stroke: PREVIEW_AMBER, width: 1.4, dash: [5, 4], fill: null };
    const ghost: GeomSvgStyle = { stroke: GHOST_STROKE, width: 1.2, dash: [5, 4], fill: null };
    const drawLine = (a: Pt, b: Pt, style: GeomSvgStyle): void =>
      drawGeomSvg({ type: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y }, style);
    const drawInfinite = (a: Pt, b: Pt, style: GeomSvgStyle): void => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy);
      if (l <= 1e-9) return;
      const seg = clipInfinite(a, { x: dx / l, y: dy / l }, visibleWorldRectOf(state.pan, state.zoom), false);
      if (seg === null) return;
      drawLine(seg[0], seg[1], style);
    };
    const drawGhost = (g: Geom): void => {
      drawGeomSvg(g, ghost);
    };
    const echo = (text: string): void => {
      const s = toScreen([cursor.x, cursor.y]);
      const t = svgNs("text");
      t.setAttribute("x", String(s[0] + 14));
      t.setAttribute("y", String(s[1] - 10));
      t.setAttribute("fill", "#b45309");
      t.setAttribute("font-size", "11");
      t.setAttribute("font-family", "ui-monospace, monospace");
      t.textContent = text;
      svg.append(t);
    };
    // Canonical geometry of the objects the running command will modify —
    // the collected object picks, or the current selection.
    const targetGeoms = (): readonly Geom[] => {
      const objects = values.objects;
      const ids =
        objects !== undefined && objects.kind === "entities"
          ? objects.entities.map((e) => e.id)
          : state.selection;
      const out: Geom[] = [];
      for (const id of ids) {
        const g = geomById.get(id)?.geom;
        if (g !== undefined) out.push(g);
      }
      return out;
    };

    switch (cmd.id) {
      // COMPAT-CAD-006 (Issue #138): the ZOOM window rubber band — the
      // dashed cyan rectangle from the first corner to the cursor while the
      // opposite-corner prompt is active (the Web canvas preview mirror).
      case "zoom": {
        const first = values.corner1;
        if (first !== undefined && first.kind === "point") {
          const a = toScreen(first.point);
          const b = toScreen([cursor.x, cursor.y]);
          const rect = svgNs("rect");
          rect.setAttribute("x", String(Math.min(a[0], b[0])));
          rect.setAttribute("y", String(Math.min(a[1], b[1])));
          rect.setAttribute("width", String(Math.abs(b[0] - a[0])));
          rect.setAttribute("height", String(Math.abs(b[1] - a[1])));
          rect.setAttribute("fill", "none");
          rect.setAttribute("stroke", "#0891b2");
          rect.setAttribute("stroke-width", "1");
          rect.setAttribute("stroke-dasharray", "5 4");
          svg.append(rect);
        }
        break;
      }
      case "ellipse": {
        const center = previewPointValue("center");
        if (center === null) break;
        const axisEnd = previewPointValue("axisEnd");
        if (axisEnd === null) {
          // First axis under construction: base → cursor axis line.
          drawLine(center, cursor, { ...rubber, dash: null });
          break;
        }
        const axisX = axisEnd.x - center.x;
        const axisY = axisEnd.y - center.y;
        const rx = Math.hypot(axisX, axisY);
        if (rx <= 1e-9) break;
        const u = { x: axisX / rx, y: axisY / rx };
        const rel = { x: cursor.x - center.x, y: cursor.y - center.y };
        const ry = Math.abs(rel.x * u.y - rel.y * u.x);
        // Committed axis (thin) + live ellipse (dashed rubber).
        drawLine(center, axisEnd, { ...rubber, dash: null, width: 1 });
        if (ry > 1e-9) {
          drawGhost({ type: "ellipse", cx: center.x, cy: center.y, rx, ry, rotation: Math.atan2(axisY, axisX) });
        }
        break;
      }
      case "spline": {
        const start = previewPointValue("start");
        const pts: Pt[] = [];
        if (start !== null) pts.push(start);
        pts.push(...previewPointsValue("next"));
        if (pts.length === 0) break;
        // Live control polygon (collected points + cursor).
        drawGhost({ type: "polyline", vertices: [...pts, cursor], closed: false });
        // Sampled curve preview.
        const control = [...pts, cursor];
        if (control.length >= 2) {
          drawGhost({
            type: "spline",
            controlPoints: control,
            degree: Math.min(3, control.length - 1),
          });
        }
        break;
      }
      case "point": {
        // Crosshair marker at the prospective node position.
        drawGhost({ type: "point", x: cursor.x, y: cursor.y });
        break;
      }
      case "ray":
      case "xline": {
        const base = previewPointValue("base");
        if (base === null) break;
        // Infinite dashed construction line through base → cursor.
        drawInfinite(base, cursor, rubber);
        break;
      }
      case "rotate": {
        const base = previewPointValue("base");
        if (base === null) break;
        const dx = cursor.x - base.x;
        const dy = cursor.y - base.y;
        if (Math.hypot(dx, dy) <= 1e-9) break;
        const angle = Math.atan2(dy, dx);
        for (const g of targetGeoms()) drawGhost(rotateGeom(g, base, angle));
        echo(`${(((angle * 180) / Math.PI + 360) % 360).toFixed(1)}°`);
        break;
      }
      case "scale": {
        const base = previewPointValue("base");
        if (base === null) break;
        const factor = Math.hypot(cursor.x - base.x, cursor.y - base.y) / 100;
        if (factor > 1e-9) {
          for (const g of targetGeoms()) drawGhost(scaleGeom(g, base, factor));
        }
        echo(`×${factor.toFixed(2)}`);
        break;
      }
      case "mirror": {
        const p1 = previewPointValue("p1");
        if (p1 === null) break;
        const p2v = previewPointValue("p2");
        const p2: Pt = p2v !== null ? p2v : cursor;
        if (Math.hypot(p2.x - p1.x, p2.y - p1.y) <= 1e-9) break;
        // Mirror axis (dashed, extended to the viewport bounds).
        drawInfinite(p1, p2, rubber);
        for (const g of targetGeoms()) drawGhost(mirrorGeom(g, p1, p2));
        break;
      }
      case "offset": {
        const ids = previewEntityIds("object");
        const target = ids.length > 0 ? (geomById.get(ids[0]!)?.geom ?? null) : null;
        if (target === null) break;
        const throughOpt = optionValue(values, "distance", "T");
        const through = throughOpt !== null && throughOpt.kind === "point";
        let distance = 0;
        if (through) {
          // Through mode: the cursor IS the through point.
          distance = closestOn(target, cursor).d;
        } else {
          const d = values.distance;
          distance = d !== undefined && d.kind === "number" ? d.value : 0;
        }
        if (!(distance > 1e-9)) break;
        try {
          drawGhost(offsetGeom(target, distance, cursor));
        } catch {
          // Typed kernel limitation (ellipse/spline offsets) — no preview.
        }
        break;
      }
      case "stretch": {
        const c1 = previewPointValue("corner1");
        if (c1 === null) break;
        // Crossing window while picking corners (dashed green).
        const a = toScreen([c1.x, c1.y]);
        const b = toScreen([cursor.x, cursor.y]);
        const r = svgNs("rect");
        r.setAttribute("x", String(Math.min(a[0], b[0])));
        r.setAttribute("y", String(Math.min(a[1], b[1])));
        r.setAttribute("width", String(Math.abs(b[0] - a[0])));
        r.setAttribute("height", String(Math.abs(b[1] - a[1])));
        r.setAttribute("stroke", "#16a34a");
        r.setAttribute("stroke-width", "1");
        r.setAttribute("stroke-dasharray", "4 3");
        r.setAttribute("fill", "rgba(22,163,74,0.08)");
        svg.append(r);
        break;
      }
      case "fillet":
      case "chamfer": {
        // Emphasize the first picked object while the second is selected.
        const ids = previewEntityPointIds("first");
        const target = ids.length > 0 ? (geomById.get(ids[0]!)?.geom ?? null) : null;
        if (target !== null) drawGeomEmphasis(target);
        break;
      }
      case "break": {
        const ids = previewEntityPointIds("object");
        const target = ids.length > 0 ? (geomById.get(ids[0]!)?.geom ?? null) : null;
        if (target !== null) drawGeomEmphasis(target);
        break;
      }
      default:
        break;
    }
  }

  // --- model rendering -----------------------------------------------------------------------

  function renderModel(): void {
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // CAD-PARITY-005: the annotation paint layer repaints with the model —
    // cleared first (transparent; the SVG's white background shows through).
    if (annoCtx !== null) {
      annoCtx.setTransform(1, 0, 0, 1, 0, 0);
      annoCtx.clearRect(0, 0, SVG_W, SVG_H);
    }

    // CAD-PARITY-009 (Issue #90): the 3D Model view — the canonical 3D scene
    // through the SHARED writer (the 2D plan/paper canvas stays empty while
    // the scene surface owns the viewport).
    if (model3dView) {
      renderModel3D();
      return;
    }

    // CAD-PARITY-008 (Issue #88): PAPER SPACE — the active layout's sheet
    // painted through the SHARED paper painter from the SHARED Plot IR (the
    // SAME ir.ts/paint.ts the Web paper canvas and the export writers
    // consume — the preview IS the plot). The SVG plan viewport stays empty
    // in paper mode; theannoCanvas carries the sheet (display-only surface —
    // viewport frame editing lives in the Layouts dock panel through the
    // SAME viewport.update commands; the Web paper canvas adds grips).
    if (space === "paper") {
      const layouts = state.snapshot?.layouts ?? [];
      const activeId = state.snapshot?.draftingSettings?.activeLayout ?? layouts[0]?.id ?? null;
      const layout = layouts.find((l) => l.id === activeId) ?? null;
      modelTitle.textContent = `Paper — ${layout?.name ?? "no layout"}`;
      if (annoCtx !== null) {
        annoCtx.fillStyle = "#e2e8f0";
        annoCtx.fillRect(0, 0, SVG_W, SVG_H);
      }
      if (layout !== null) {
        const snap = state.snapshot;
        if (snap !== null) {
          const ir: PlotIR = buildPlotIR({
            layout,
            viewports: snap.viewports ?? [],
            elements: snap.elements,
            layers: snap.layers ?? [],
            ltypes: snap.ltypes ?? [],
            textStyles: snap.textStyles ?? [],
            dimStyles: snap.dimStyles ?? [],
            ...(snap.draftingSettings?.standards !== undefined ? { standards: snap.draftingSettings.standards } : {}),
          });
          if (annoCtx !== null) {
            const margin = 20;
            const zoom = Math.min((SVG_W - margin * 2) / ir.sheet.widthMm, (SVG_H - margin * 2) / ir.sheet.heightMm);
            const ox = (SVG_W - ir.sheet.widthMm * zoom) / 2;
            const oy = (SVG_H + ir.sheet.heightMm * zoom) / 2;
            const toScreen = (pt: PaperPt): [number, number] => [ox + pt.x * zoom, oy - pt.y * zoom];
            paintSheetBackdrop(annoCtx, ir, { toScreen, pxPerMm: zoom });
            paintPlotIR(annoCtx, ir, { toScreen, pxPerMm: zoom, selectedViewportId });
            // The paper sheet marker (the smoke asserts the painted surface).
            const marker = svgNs("rect");
            marker.setAttribute("data-testid", "pro-paper-sheet");
            marker.setAttribute("x", "0");
            marker.setAttribute("y", "0");
            marker.setAttribute("width", "0");
            marker.setAttribute("height", "0");
            marker.setAttribute("fill", "none");
            svg.append(marker);
          }
        }
      }
      return;
    }
    modelTitle.textContent = "Model — command-driven plan viewport";

    const settings = state.snapshot?.draftingSettings;
    if (settings?.grid.enabled === true && settings.grid.size > 0) {
      const size = settings.grid.size * Math.max(1, Math.round(10 / (settings.grid.size * state.zoom)));
      const startX = Math.floor(state.pan.x / size) * size;
      const startY = Math.floor(state.pan.y / size) * size;
      for (let x = startX; x <= state.pan.x + SVG_W / state.zoom; x += size) {
        const l = svgNs("line");
        const [sx] = toScreen([x, 0]);
        l.setAttribute("x1", String(sx)); l.setAttribute("y1", "0");
        l.setAttribute("x2", String(sx)); l.setAttribute("y2", String(SVG_H));
        l.setAttribute("stroke", "#e5e7eb");
        svg.append(l);
      }
      for (let y = startY; y <= state.pan.y + SVG_H / state.zoom; y += size) {
        const l = svgNs("line");
        const [, sy] = toScreen([0, y]);
        l.setAttribute("x1", "0"); l.setAttribute("y1", String(sy));
        l.setAttribute("x2", String(SVG_W)); l.setAttribute("y2", String(sy));
        l.setAttribute("stroke", "#e5e7eb");
        svg.append(l);
      }
    }

    const selectedSet = new Set(state.selection);
    const layerById = new Map<string, LayerRecord>((state.snapshot?.layers ?? []).map((l: LayerRecord) => [l.id, l] as const));

    // CAD-PARITY-004: TWO entity views — the DRAWABLE view (visible + not
    // frozen; LOCKED layers draw faded) for rendering, and the INTERACTABLE
    // view (additionally excludes locked layers) for picking/snapping/window
    // selection and the command previews (the same split the Web host runs).
    const drawable = drawableElements();
    const displayById = computeDisplayMap(drawable, layerById);
    // The canonical geometry view of the DRAWABLE set (rendering — includes
    // locked entities; toEntities skips annotations/BIM/malformed props).
    const renderGeomById = new Map<string, GeomEntity>(toEntities(drawable).map((e) => [e.id, e] as const));
    // The canonical INTERACTABLE view (pick/snap/preview — the SAME module
    // the server-side precision queries run).
    const visible = visibleElements();
    const geoms = toEntities(visible);
    const geomById = new Map<string, GeomEntity>(geoms.map((e) => [e.id, e] as const));

    for (const el of drawable) {
      const selected = selectedSet.has(el.id);
      // CAD-PARITY-004: the resolved display (dash/lineweight/alpha) flows
      // through the SAME standards resolution on both hosts.
      const display = displayById.get(el.id);
      // CAD-PARITY-003: canonical geometry first — the SAME bridge painter
      // the Web host uses (ellipse/spline/point/ray/xline/region + the
      // classic types in BOTH conventions).
      const canonical = renderGeomById.get(el.id);
      if (canonical !== undefined) {
        const layer = layerById.get(canonical.layer);
        drawCanonicalEntity(canonical.geom, {
          color: display?.color ?? canonical.color ?? layer?.color ?? "#111827",
          selected,
          dash: display?.dash ?? null,
          weightPx: display?.weightPx,
          alpha: display?.alpha,
        });
        continue;
      }
      // CAD-PARITY-005: annotation elements (the 8-type canonical vocabulary
      // AND the legacy COMPAT-CAD-001 dims — both load through
      // annotationFromElement) render through the ONE shared painter: the
      // style-driven primitives painted identically on Web and Electron.
      // Layer visibility/frozen filtering applies exactly like geometry;
      // selected annotations render slightly thicker at full alpha (no
      // emphasis outline by design — the Web host's exact convention).
      if (el.kind === "annotation") {
        const anno = annotationFromElement(el);
        if (anno !== null) {
          const layer = layerById.get(anno.layer);
          if (layer !== undefined && (layer.frozen === true || !layer.visible)) continue;
          if (annoCtx !== null) {
            const primitives = annotationPrimitives(anno, annotationStyleCtxOf());
            paintAnnotationPrimitives(annoCtx, primitives, {
              // The shared painter takes Pt objects ({x, y}) — the view
              // transform stays tuple-based (Vec2), so adapt once per frame.
              toScreen: (p: Pt): [number, number] => toScreen([p.x, p.y]),
              zoom: state.zoom,
              color: display?.color ?? layer?.color ?? "#111827",
              weightPx: selected ? (display?.weightPx ?? 1) * 1.8 : (display?.weightPx ?? 1),
              dash: display?.dash ?? null,
              alpha: selected ? 1 : (display?.alpha ?? 1),
            });
          }
          continue;
        }
      }
      // CAD-PARITY-006 (Issue #84): block/xref instances render through the
      // ONE shared expansion (expandInstanceElement) on the annotation canvas
      // overlay — geometry pieces from the canonical props with the resolved
      // display of each piece's own layer, text pieces through the SAME
      // shared annotation painter, placeholders as the dashed box + label.
      // The instance's OWN layer visibility gates rendering here (the
      // drawableElements filter above — the same gate every element passes).
      if (isInstanceElement(el)) {
        drawInstanceElement(el, selected, layerById);
        continue;
      }
      const entity = parseEntity(el);
      if (entity !== null) {
        const layer = layerById.get(entity.layer);
        const color = selected ? "#0ea5e9" : (display?.color ?? layer?.color ?? "#111827");
        // COMPAT-CAD-006: the same viewport gate for the legacy SVG branch —
        // conservative bbox; unknown shapes draw (the surface clips).
        const gate = legacyRectOf(entity);
        if (gate !== null && !passesGate(gate)) continue;
        const g = svgNs("g");
        g.setAttribute("stroke", color);
        g.setAttribute("fill", "none");
        g.setAttribute("stroke-width", selected ? "2.4" : String(display?.weightPx ?? 1.6));
        if (!selected && display?.dash !== null && display?.dash !== undefined) {
          g.setAttribute("stroke-dasharray", display.dash.join(" "));
        }
        if (display?.alpha !== undefined && display.alpha < 1) {
          g.setAttribute("opacity", String(display.alpha));
        }
        if (entity.type === "line") {
          const a = toScreen(entity.from);
          const b = toScreen(entity.to);
          const l = svgNs("line");
          l.setAttribute("x1", String(a[0])); l.setAttribute("y1", String(a[1]));
          l.setAttribute("x2", String(b[0])); l.setAttribute("y2", String(b[1]));
          g.append(l);
        } else if (entity.type === "polyline") {
          const pl = svgNs("polyline");
          pl.setAttribute("points", entity.points.map((p) => toScreen(p).join(",")).join(" "));
          g.append(pl);
        } else if (entity.type === "circle") {
          const c = toScreen(entity.center);
          const circle = svgNs("circle");
          circle.setAttribute("cx", String(c[0]));
          circle.setAttribute("cy", String(c[1]));
          circle.setAttribute("r", String(entity.radius * state.zoom));
          g.append(circle);
        } else if (entity.type === "arc") {
          const c = toScreen(entity.center);
          const arc = svgNs("path");
          const sweep = entity.endAngle - entity.startAngle;
          const p0: Vec2 = [entity.center[0] + entity.radius * Math.cos(entity.startAngle), entity.center[1] + entity.radius * Math.sin(entity.startAngle)];
          const p1: Vec2 = [entity.center[0] + entity.radius * Math.cos(entity.endAngle), entity.center[1] + entity.radius * Math.sin(entity.endAngle)];
          const s0 = toScreen(p0);
          const s1 = toScreen(p1);
          arc.setAttribute("d", `M ${s0[0]} ${s0[1]} A ${entity.radius * state.zoom} ${entity.radius * state.zoom} 0 ${sweep > Math.PI ? 1 : 0} 1 ${s1[0]} ${s1[1]}`);
          g.append(arc);
        } else if (entity.type === "rectangle") {
          const a = toScreen(entity.corner1);
          const b = toScreen(entity.corner2);
          const r = svgNs("rect");
          r.setAttribute("x", String(Math.min(a[0], b[0])));
          r.setAttribute("y", String(Math.min(a[1], b[1])));
          r.setAttribute("width", String(Math.abs(b[0] - a[0])));
          r.setAttribute("height", String(Math.abs(b[1] - a[1])));
          g.append(r);
        } else if (entity.type === "dim-linear") {
          const a = toScreen(entity.p1);
          const b = toScreen(entity.p2);
          const l = svgNs("line");
          l.setAttribute("x1", String(a[0])); l.setAttribute("y1", String(a[1]));
          l.setAttribute("x2", String(b[0])); l.setAttribute("y2", String(b[1]));
          l.setAttribute("stroke-dasharray", "4 3");
          g.append(l);
          const t = svgNs("text");
          t.setAttribute("x", String((a[0] + b[0]) / 2 + 4));
          t.setAttribute("y", String((a[1] + b[1]) / 2 - 4));
          t.setAttribute("fill", "#374151");
          t.setAttribute("font-size", "11");
          t.setAttribute("font-family", "ui-monospace, monospace");
          t.textContent = entity.measured.toFixed(1);
          g.append(t);
        } else if (entity.type === "dim-radius") {
          const t = svgNs("text");
          t.setAttribute("x", "10");
          t.setAttribute("y", "18");
          t.setAttribute("fill", "#374151");
          t.setAttribute("font-size", "11");
          t.setAttribute("font-family", "ui-monospace, monospace");
          t.textContent = `R${entity.measured.toFixed(2)} → ${entity.target}`;
          g.append(t);
        }
        svg.append(g);
        continue;
      }

      // BIM plan footprints.
      const props = el.props as Record<string, unknown>;
      // COMPAT-CAD-006: the viewport gate for BIM footprints — walls/slabs
      // by their wall-rect points (the thickness is covered by the declared
      // 16 px device margin); anything without a derivable rect draws.
      if (props.type === "bim.wall" && Array.isArray(props.start) && Array.isArray(props.end)) {
        const a = props.start as unknown as [number, number];
        const b = props.end as unknown as [number, number];
        if (!passesGate({ minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) })) continue;
      } else if (props.type === "bim.slab" && Array.isArray(props.corner1) && Array.isArray(props.corner2)) {
        const a = props.corner1 as unknown as [number, number];
        const b = props.corner2 as unknown as [number, number];
        if (!passesGate({ minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) })) continue;
      }
      if (props.type === "bim.wall" && Array.isArray(props.start) && Array.isArray(props.end) && typeof props.width === "number") {
        const start = props.start as unknown as Vec2;
        const end = props.end as unknown as Vec2;
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const half = (props.width as number) / 2;
        const corners: Vec2[] = [
          [start[0] + nx * half, start[1] + ny * half],
          [end[0] + nx * half, end[1] + ny * half],
          [end[0] - nx * half, end[1] - ny * half],
          [start[0] - nx * half, start[1] - ny * half],
        ];
        const poly = svgNs("polygon");
        poly.setAttribute("points", corners.map((p) => toScreen(p).join(",")).join(" "));
        poly.setAttribute("fill", selected ? "rgba(14,165,233,.28)" : "rgba(120,113,108,.16)");
        poly.setAttribute("stroke", selected ? "#0ea5e9" : "#57534e");
        poly.setAttribute("stroke-width", selected ? "2.2" : "1.4");
        svg.append(poly);
      } else if (props.type === "bim.slab" && Array.isArray(props.corner1) && Array.isArray(props.corner2)) {
        const a = toScreen(props.corner1 as unknown as Vec2);
        const b = toScreen(props.corner2 as unknown as Vec2);
        const r = svgNs("rect");
        r.setAttribute("x", String(Math.min(a[0], b[0])));
        r.setAttribute("y", String(Math.min(a[1], b[1])));
        r.setAttribute("width", String(Math.abs(b[0] - a[0])));
        r.setAttribute("height", String(Math.abs(b[1] - a[1])));
        r.setAttribute("fill", selected ? "rgba(14,165,233,.15)" : "rgba(161,98,7,.10)");
        r.setAttribute("stroke", selected ? "#0ea5e9" : "#a16207");
        svg.append(r);
      }
    }

    // CAD-PARITY-007 (Issue #86): the constraint bar badges — one glyph per
    // declared constraint at the deterministic positions, painted on the
    // annotation canvas through the ONE shared painter (violated badges
    // render hot through the shared diagnostics — identical on Web and
    // Electron, LOCK-004).
    const declaredConstraints = state.snapshot?.constraints ?? [];
    if (declaredConstraints.length > 0 && annoCtx !== null) {
      const diagnostics = diagnoseConstraints(state.snapshot?.elements ?? [], declaredConstraints);
      const violated = new Set(
        diagnostics.statuses.filter((s) => !s.satisfied).map((s) => s.id),
      );
      paintConstraintGlyphs(annoCtx, constraintGlyphs(state.snapshot?.elements ?? [], declaredConstraints), {
        toScreen: (p: Pt): [number, number] => toScreen([p.x, p.y]),
        violated,
      });
    }

    // CAD-PARITY-003 command previews (ghost geometry, axis lines, live
    // entities, echo readouts) + hover emphasis during object picks.
    const cmd = commandById(state.engine.commandId ?? "");
    const step = effectiveStep(state.engine);
    if (cmd !== null && step !== null && state.cursor !== null) {
      if (step.kind === "entity" || step.kind === "entityPoint") {
        // Hover emphasis: highlight the entity under the cursor before the
        // pick (TRIM/EXTEND/BREAK target feedback).
        const hovered = pickEntityAt(state.cursor, geoms, visible);
        if (hovered !== null) {
          const g = geomById.get(hovered.id)?.geom;
          if (g !== undefined) drawGeomEmphasis(g);
          // CAD-PARITY-006: instance targets (ATTEDIT picks, BLOCK object
          // picks) emphasize their DERIVED content on the overlay.
          else {
            const hoverEl = (state.snapshot?.elements ?? []).find((el) => el.id === hovered.id);
            if (hoverEl !== undefined && isInstanceElement(hoverEl)) drawInstanceEmphasis(hoverEl);
          }
        }
      }
      drawCommandPreview(cmd, geoms, geomById);
    }

    // Rubber band for the active point/distance/displacement step.
    if (cmd !== null && step !== null && state.cursor !== null && stepBaseOf(step) !== null &&
        (step.kind === "point" || step.kind === "distance" || step.kind === "displacement")) {
      const base = stepBaseOf(step);
      const from = toScreen(base!);
      const to = toScreen(constrainSnap(state.cursor, false, geoms).point);
      const l = svgNs("line");
      l.setAttribute("x1", String(from[0])); l.setAttribute("y1", String(from[1]));
      l.setAttribute("x2", String(to[0])); l.setAttribute("y2", String(to[1]));
      l.setAttribute("stroke", "#f59e0b");
      l.setAttribute("stroke-dasharray", "6 4");
      l.setAttribute("stroke-width", "1.4");
      svg.append(l);
    }

    // Snap marker (mode-aware shapes — mirrors the Web drawSnapMarker).
    if (cmd !== null && step !== null && state.cursor !== null) {
      const snap = constrainSnap(state.cursor, false, geoms);
      if (snap.snapped) drawSnapMarkerSvg(toScreen(snap.point), snap.mode);
    }

    // Selection rectangle.
    if (selRect !== null) {
      const a = toScreen(selRect.a);
      const b = toScreen(selRect.b);
      const mode = selRect.b[0] >= selRect.a[0] ? "window" : "crossing";
      const r = svgNs("rect");
      r.setAttribute("x", String(Math.min(a[0], b[0])));
      r.setAttribute("y", String(Math.min(a[1], b[1])));
      r.setAttribute("width", String(Math.abs(b[0] - a[0])));
      r.setAttribute("height", String(Math.abs(b[1] - a[1])));
      r.setAttribute("fill", mode === "window" ? "rgba(37,99,235,.07)" : "rgba(22,163,74,.07)");
      r.setAttribute("stroke", mode === "window" ? "#2563eb" : "#16a34a");
      r.setAttribute("stroke-dasharray", mode === "crossing" ? "5 3" : "");
      svg.append(r);
    }

    // Grips for the single selection. CAD-PARITY-004: grips (and the anchored
    // mini-toolbar — its Move/Copy/Erase actions are document-gated anyway)
    // are READ-ONLY-hidden on LOCKED layers: a locked entity cannot be
    // grip-edited, so the affordance must not offer it.
    if (state.selection.length === 1) {
      const el = (state.snapshot?.elements ?? []).find((x) => x.id === state.selection[0]);
      const elLayerId = el !== undefined ? (el.props as Record<string, unknown>).layer : undefined;
      const elLocked =
        el !== undefined && typeof elLayerId === "string" && layerById.get(elLayerId)?.locked === true;
      if (el !== undefined && !elLocked) {
        for (const grip of gripsFor(el)) {
          const s = toScreen(grip.point);
          const r = svgNs("rect");
          r.setAttribute("x", String(s[0] - 4)); r.setAttribute("y", String(s[1] - 4));
          r.setAttribute("width", "8"); r.setAttribute("height", "8");
          r.setAttribute("fill", "#fff");
          r.setAttribute("stroke", "#2563eb");
          r.setAttribute("stroke-width", "1.2");
          svg.append(r);
        }
        // Mini-toolbar near the selection.
        const grips = gripsFor(el);
        if (grips.length > 0) {
          const s = toScreen(grips[0]!.point);
          miniToolbar.style.display = "flex";
          miniToolbar.style.left = `${Math.max(4, (s[0] / SVG_W) * 100)}%`;
          miniToolbar.style.top = `${Math.max(2, (s[1] / SVG_H) * 100 - 8)}%`;
        }
      }
    } else {
      miniToolbar.style.display = "none";
    }

    // Crosshair.
    if (state.cursor !== null) {
      const s = toScreen(state.cursor);
      const lx = svgNs("line");
      lx.setAttribute("x1", String(s[0])); lx.setAttribute("y1", "0");
      lx.setAttribute("x2", String(s[0])); lx.setAttribute("y2", String(SVG_H));
      lx.setAttribute("stroke", "rgba(37,99,235,.5)");
      lx.setAttribute("stroke-width", "1");
      const ly = svgNs("line");
      ly.setAttribute("x1", "0"); ly.setAttribute("y1", String(s[1]));
      ly.setAttribute("x2", String(SVG_W)); ly.setAttribute("y2", String(s[1]));
      ly.setAttribute("stroke", "rgba(37,99,235,.5)");
      ly.setAttribute("stroke-width", "1");
      svg.append(lx, ly);
    }

    // CAD-PARITY-005: skip the inspector rebuild while a free-text editor
    // inside it holds focus (the annotation value/override/height fields
    // would lose their in-progress edit on every canvas mousemove repaint —
    // the Web host never re-renders the panel during typing; selects/color
    // inputs commit on change and rebuild freely). The panel catches up on
    // the next repaint after the edit commits and blurs.
    const active = document.activeElement;
    let editingText = false;
    if (active !== null && propsPanel.contains(active)) {
      const tag = active.tagName;
      editingText =
        tag === "TEXTAREA" ||
        (tag === "INPUT" && ((active as HTMLInputElement).type === "text" || (active as HTMLInputElement).type === "number"));
    }
    if (!editingText) renderProperties();
  }

  // --- CAD-PARITY-004 professional Properties inspector ------------------------
  // (mirrors the Web PropertiesPanel: General + Display (ByLayer chain with
  // entity.setDisplay writes) + the canonical geometry readout retained; the
  // current drafting environment when nothing is selected.)

  /** One key/value readout row (mono value). */
  function propRow(parent: HTMLElement, k: string, v: string): void {
    const d = h("div", "prow");
    const kEl = h("span", "k");
    kEl.textContent = k;
    const vEl = h("span", "v");
    vEl.textContent = v;
    d.append(kEl, vEl);
    parent.append(d);
  }

  /** One section header. */
  function propSection(parent: HTMLElement, title: string): void {
    const s = h("div", "sec");
    s.textContent = title;
    parent.append(s);
  }

  /** The shared display-property editors (CHPROP-class writes through
   *  entity.setDisplay — the DOM mirror of the Web DisplayEditors). */
  function appendDisplayEditors(
    parent: HTMLElement,
    ids: readonly string[],
    overrides: { color: string | null; linetype: string | null; lineweight: number | null; transparency: number | null },
    layerId: string | null,
    locked: boolean,
  ): void {
    const setDisplay = (patch: Record<string, unknown>): void => {
      commitCommand("entity.setDisplay", { ids, patch });
    };
    const layers = state.snapshot?.layers ?? [];
    const ltypeOptions = [...BUILT_IN_LTYPES.map((l) => l.name), ...(state.snapshot?.ltypes ?? []).map((l) => l.name)];

    // color override + ByLayer reset.
    const colorRow = h("div", "prow");
    const colorKey = h("span", "k");
    colorKey.textContent = "color";
    const colorWrap = h("span");
    colorWrap.style.cssText = "display:flex;align-items:center;gap:4px;";
    const colorInput = h("input");
    colorInput.type = "color";
    colorInput.title = "Entity color override";
    colorInput.setAttribute("aria-label", "entity color override");
    colorInput.value = overrides.color ?? "#111827";
    colorInput.disabled = locked;
    colorInput.addEventListener("change", () => setDisplay({ color: colorInput.value }));
    const colorReset = h("button", "mini");
    colorReset.type = "button";
    colorReset.textContent = "ByLayer";
    colorReset.title = "Reset to ByLayer";
    colorReset.setAttribute("aria-label", "reset color to ByLayer");
    colorReset.disabled = locked;
    colorReset.addEventListener("click", () => setDisplay({ color: "ByLayer" }));
    colorWrap.append(colorInput, colorReset);
    colorRow.append(colorKey, colorWrap);
    parent.append(colorRow);

    // linetype override.
    const ltRow = h("div", "prow");
    const ltKey = h("span", "k");
    ltKey.textContent = "linetype";
    const ltSelect = h("select");
    ltSelect.title = "Entity linetype override";
    ltSelect.setAttribute("aria-label", "entity linetype override");
    ltSelect.disabled = locked;
    const ltByLayer = h("option");
    ltByLayer.value = "ByLayer";
    ltByLayer.textContent = "ByLayer";
    ltSelect.append(ltByLayer);
    for (const name of ltypeOptions) {
      const o = h("option");
      o.value = name;
      o.textContent = name;
      ltSelect.append(o);
    }
    ltSelect.value = overrides.linetype ?? "ByLayer";
    ltSelect.addEventListener("change", () => setDisplay({ linetype: ltSelect.value }));
    ltRow.append(ltKey, ltSelect);
    parent.append(ltRow);

    // lineweight override.
    const lwRow = h("div", "prow");
    const lwKey = h("span", "k");
    lwKey.textContent = "lineweight";
    const lwSelect = h("select");
    lwSelect.title = "Entity lineweight override (mm)";
    lwSelect.setAttribute("aria-label", "entity lineweight override");
    lwSelect.disabled = locked;
    const lwByLayer = h("option");
    lwByLayer.value = "ByLayer";
    lwByLayer.textContent = "ByLayer";
    lwSelect.append(lwByLayer);
    for (const w of STANDARD_LINEWEIGHTS) {
      const o = h("option");
      o.value = String(w);
      o.textContent = w.toFixed(2);
      lwSelect.append(o);
    }
    lwSelect.value = overrides.lineweight !== null ? String(overrides.lineweight) : "ByLayer";
    lwSelect.addEventListener("change", () =>
      setDisplay({ lineweight: lwSelect.value === "ByLayer" ? "ByLayer" : Number(lwSelect.value) }),
    );
    lwRow.append(lwKey, lwSelect);
    parent.append(lwRow);

    // transparency override.
    const trRow = h("div", "prow");
    const trKey = h("span", "k");
    trKey.textContent = "transparency";
    const trSelect = h("select");
    trSelect.title = "Entity transparency override";
    trSelect.setAttribute("aria-label", "entity transparency override");
    trSelect.disabled = locked;
    const trByLayer = h("option");
    trByLayer.value = "ByLayer";
    trByLayer.textContent = "ByLayer";
    trSelect.append(trByLayer);
    for (let i = 1; i <= 9; i++) {
      const o = h("option");
      o.value = String(i * 10);
      o.textContent = `${i * 10}%`;
      trSelect.append(o);
    }
    trSelect.value = overrides.transparency !== null ? String(overrides.transparency) : "ByLayer";
    trSelect.addEventListener("change", () =>
      setDisplay({ transparency: trSelect.value === "ByLayer" ? "ByLayer" : Number(trSelect.value) }),
    );
    trRow.append(trKey, trSelect);
    parent.append(trRow);

    // layer assignment.
    const layerRow = h("div", "prow");
    const layerKey = h("span", "k");
    layerKey.textContent = "layer";
    const layerSelect = h("select");
    layerSelect.title = "Entity layer";
    layerSelect.setAttribute("aria-label", "entity layer");
    layerSelect.disabled = locked;
    for (const l of layers) {
      const o = h("option");
      o.value = l.id;
      o.textContent = l.name;
      layerSelect.append(o);
    }
    layerSelect.value = layerId ?? "";
    layerSelect.addEventListener("change", () => setDisplay({ layer: layerSelect.value }));
    layerRow.append(layerKey, layerSelect);
    parent.append(layerRow);
  }

  // --- CAD-PARITY-005 professional Properties inspector: the annotation
  // sections (Issue #82) — the DOM mirror of the Web AnnotationRows /
  // AnnotationMultiRows. Every write goes through the annotation.update App
  // API command (one atomic revision per field; null RESETS an optional field
  // to its default, keeping records canonical-minimal). The measured value is
  // the READ-ONLY stored document truth, formatted through the SAME style
  // context the canvas paints (dimensionLabel). -----------------------------

  /** The style select shared by every annotation type ("Standard" = the
   *  built-in, resolved code-side; selecting it RESETS the reference; the
   *  empty value is the multi-selection "choose a style" placeholder). */
  function annotationStyleSelect(
    value: string,
    dim: boolean,
    locked: boolean,
    onPatch: (patch: Record<string, unknown>) => void,
  ): HTMLSelectElement {
    const sel = h("select");
    sel.title = dim ? "Annotation dim style" : "Annotation text style";
    sel.setAttribute("aria-label", dim ? "annotation dim style" : "annotation text style");
    sel.disabled = locked;
    if (value.length === 0) {
      const placeholder = h("option");
      placeholder.value = "";
      placeholder.textContent = "(set…)";
      sel.append(placeholder);
    }
    const std = h("option");
    std.value = "Standard";
    std.textContent = "Standard (built-in)";
    sel.append(std);
    const styles = dim ? (state.snapshot?.dimStyles ?? []) : (state.snapshot?.textStyles ?? []);
    for (const s of styles) {
      const o = h("option");
      o.value = s.name;
      o.textContent = s.name;
      sel.append(o);
    }
    sel.value = value;
    sel.addEventListener("change", () => {
      if (sel.value.length === 0) return;
      onPatch({ style: sel.value === "Standard" ? null : sel.value });
    });
    return sel;
  }

  /** The single-selection annotation fields (text, mtext, the dimension
   *  family, leaders and multileaders) — the mirror of the Web
   *  AnnotationRows. */
  function appendAnnotationRows(
    parent: HTMLElement,
    anno: Annotation,
    locked: boolean,
    onPatch: (patch: Record<string, unknown>) => void,
  ): void {
    const isDim = anno.type.startsWith("dim-");
    const styleName = anno.style ?? "Standard";
    const row = (key: string, control: HTMLElement): void => {
      const r = h("div", "prow");
      const k = h("span", "k");
      k.textContent = key;
      r.append(k, control);
      parent.append(r);
    };

    propRow(parent, "type", ANNOTATION_LABEL[anno.type]);

    // --- Content entities (text / mtext): value, height, rotation. --------
    if (anno.type === "text" || anno.type === "mtext") {
      const value = anno.type === "text" ? h("input") : h("textarea");
      value.setAttribute("aria-label", "annotation value");
      if (anno.type === "text") {
        (value as HTMLInputElement).type = "text";
        (value as HTMLInputElement).value = anno.value;
      } else {
        (value as HTMLTextAreaElement).rows = 3;
        (value as HTMLTextAreaElement).value = anno.value;
      }
      value.disabled = locked;
      value.addEventListener("change", () => {
        const v = (value as HTMLInputElement | HTMLTextAreaElement).value;
        if (v !== anno.value && v.length > 0) onPatch({ value: v });
      });
      row("value", value);

      const height = h("input");
      height.type = "number";
      height.step = "any";
      height.title = "Text height (mm)";
      height.setAttribute("aria-label", "annotation height");
      height.value = String(anno.height);
      height.disabled = locked;
      height.addEventListener("change", () => {
        const v = Number(height.value);
        if (Number.isFinite(v) && v > 0 && v !== anno.height) onPatch({ height: v });
      });
      row("height", height);

      const rotation = h("input");
      rotation.type = "number";
      rotation.step = "any";
      rotation.title = "Rotation (°)";
      rotation.setAttribute("aria-label", "annotation rotation degrees");
      rotation.value = String(Number((anno.rotation / DEG).toFixed(4)));
      rotation.disabled = locked;
      rotation.addEventListener("change", () => {
        const v = Number(rotation.value);
        if (Number.isFinite(v)) onPatch({ rotation: v * DEG });
      });
      row("rotation (°)", rotation);
    }
    if (anno.type === "text") {
      const hAlign = h("select");
      hAlign.title = "Horizontal justification";
      hAlign.setAttribute("aria-label", "annotation horizontal alignment");
      hAlign.disabled = locked;
      for (const a of ["left", "center", "right"] as const) {
        const o = h("option");
        o.value = a;
        o.textContent = a;
        hAlign.append(o);
      }
      hAlign.value = anno.hAlign ?? "left";
      hAlign.addEventListener("change", () => onPatch({ hAlign: hAlign.value === "left" ? null : hAlign.value }));
      row("horizontal", hAlign);

      const vAlign = h("select");
      vAlign.title = "Vertical justification";
      vAlign.setAttribute("aria-label", "annotation vertical alignment");
      vAlign.disabled = locked;
      for (const a of ["baseline", "bottom", "middle", "top"] as const) {
        const o = h("option");
        o.value = a;
        o.textContent = a;
        vAlign.append(o);
      }
      vAlign.value = anno.vAlign ?? "baseline";
      vAlign.addEventListener("change", () => onPatch({ vAlign: vAlign.value === "baseline" ? null : vAlign.value }));
      row("vertical", vAlign);
    }
    if (anno.type === "mtext") {
      const attach = h("select");
      attach.title = "Attachment corner";
      attach.setAttribute("aria-label", "annotation attachment corner");
      attach.disabled = locked;
      for (const a of MTEXT_ATTACHMENTS) {
        const o = h("option");
        o.value = a;
        o.textContent = a;
        attach.append(o);
      }
      attach.value = anno.attachment ?? "top-left";
      attach.addEventListener("change", () => onPatch({ attachment: attach.value === "top-left" ? null : attach.value }));
      row("attachment", attach);
    }

    // --- Dimensions: measured (read-only document truth) + text override. --
    if (anno.type === "dim-linear" || anno.type === "dim-radius" || anno.type === "dim-diameter" || anno.type === "dim-angular") {
      const measured = h("div", "prow");
      const measuredKey = h("span", "k");
      measuredKey.textContent = "measured";
      const measuredVal = h("span", "v measure");
      measuredVal.textContent = dimensionLabel(anno, annotationStyleCtxOf());
      measuredVal.setAttribute("data-testid", "pro-annotation-measured");
      measured.append(measuredKey, measuredVal);
      parent.append(measured);

      const override = h("input");
      override.type = "text";
      override.title = "Text override (empty = the measured value)";
      override.setAttribute("aria-label", "annotation text override");
      override.placeholder = "(none)";
      override.value = anno.textOverride ?? "";
      override.disabled = locked;
      override.addEventListener("change", () => {
        const v = override.value;
        if (v !== (anno.textOverride ?? "")) onPatch({ textOverride: v.length === 0 ? null : v });
      });
      row("text override", override);
    }

    // --- Leaders / multileaders: content + the optional text height. -------
    if (anno.type === "leader" || anno.type === "mleader") {
      const value = h("input");
      value.type = "text";
      value.setAttribute("aria-label", "annotation content");
      value.placeholder = "(none)";
      value.value = anno.value ?? "";
      value.disabled = locked;
      value.addEventListener("change", () => {
        const v = value.value;
        if (v !== (anno.value ?? "")) onPatch({ value: v.length === 0 ? null : v });
      });
      row(anno.type === "leader" ? "value" : "content", value);

      const height = h("input");
      height.type = "number";
      height.step = "any";
      height.title = "Text height (blank = the Standard dim text height)";
      height.setAttribute("aria-label", "annotation height");
      height.placeholder = "2.5";
      height.value = anno.height !== undefined ? String(anno.height) : "";
      height.disabled = locked;
      height.addEventListener("change", () => {
        const raw = height.value.trim();
        if (raw.length === 0) {
          if (anno.height !== undefined) onPatch({ height: null });
          return;
        }
        const v = Number(raw);
        if (Number.isFinite(v) && v > 0 && v !== anno.height) onPatch({ height: v });
      });
      row("height", height);
    }

    // --- Style reference (every annotation type). --------------------------
    row("style", annotationStyleSelect(styleName, isDim, locked, onPatch));
  }

  /** The multi-selection annotation fields — only the fields that apply to
   *  EVERY selected annotation (the server validates the per-type vocabulary;
   *  mixed dim/content selections show a note instead). The mirror of the
   *  Web AnnotationMultiRows. */
  function appendAnnotationMultiRows(
    parent: HTMLElement,
    annos: readonly Annotation[],
    locked: boolean,
    onPatch: (patch: Record<string, unknown>) => void,
  ): void {
    const allDims = annos.every((a) => a.type.startsWith("dim-"));
    const allContent = annos.every((a) => CONTENT_TYPES.includes(a.type));
    if (!allDims && !allContent) {
      const hint = h("div", "hint");
      hint.textContent =
        "Mixed annotation types — shared-field editing needs one kind (all dimensions or all text/leaders); edit individually with a single selection.";
      parent.append(hint);
      return;
    }
    const input = h("input");
    input.type = "text";
    input.setAttribute("aria-label", allDims ? "annotation text override" : "annotation value");
    input.placeholder = "(none)";
    input.disabled = locked;
    input.addEventListener("change", () => {
      const v = input.value;
      if (v.length > 0) onPatch(allDims ? { textOverride: v } : { value: v });
    });
    const r = h("div", "prow");
    const k = h("span", "k");
    k.textContent = allDims ? "text override" : "value";
    r.append(k, input);
    parent.append(r);

    const styleRow = h("div", "prow");
    const styleKey = h("span", "k");
    styleKey.textContent = "style";
    styleRow.append(styleKey, annotationStyleSelect("", allDims, locked, onPatch));
    parent.append(styleRow);
  }

  function renderProperties(): void {
    while (propsPanel.firstChild) propsPanel.removeChild(propsPanel.firstChild);
    const layers = state.snapshot?.layers ?? [];
    const layerById = new Map<string, LayerRecord>(layers.map((l) => [l.id, l] as const));
    const selected = (state.snapshot?.elements ?? []).filter((el) => state.selection.includes(el.id));
    const num = (v: number): string => String(Number(v.toFixed(3)));

    // Header (title + collapse affordance).
    const hdr = h("div", "hdr");
    const title = h("span", "t");
    if (selected.length === 1) {
      const el = selected[0]!;
      const p = el.props as Record<string, unknown>;
      const canonical = geomFromElement(el);
      // CAD-PARITY-005: annotations carry the shared type label vocabulary
      // (the ANNOTATION_LABEL mirror of the Web inspector's badge).
      const anno = annotationFromElement(el);
      // CAD-PARITY-006: block/xref instances carry their own type labels
      // ("Block Instance" / "Reference Instance" — the Web inspector's
      // derived-label mirror).
      const instanceRef = blockRefFromElement(el);
      const instanceXref = instanceRef === null ? xrefRefFromElement(el) : null;
      title.textContent =
        instanceRef !== null
          ? BLOCK_INSTANCE_LABEL
          : instanceXref !== null
            ? XREF_INSTANCE_LABEL
            : anno !== null
              ? ANNOTATION_LABEL[anno.type]
              : canonical !== null
                ? GEOM_LABEL[canonical.type]
                : typeof p.type === "string"
                  ? p.type
                  : el.kind;
      const idSpan = h("span");
      idSpan.textContent = ` · ${el.id}`;
      title.append(idSpan);
    } else if (selected.length > 1) {
      title.textContent = `Selection — ${selected.length} entities`;
    } else {
      title.textContent = "Properties";
    }
    const collapse = h("button", "collapse");
    collapse.type = "button";
    collapse.textContent = propsCollapsed ? "▸" : "▾";
    collapse.title = propsCollapsed ? "Expand the properties inspector" : "Collapse the properties inspector";
    collapse.setAttribute("aria-label", propsCollapsed ? "expand properties inspector" : "collapse properties inspector");
    collapse.addEventListener("click", () => {
      propsCollapsed = !propsCollapsed;
      renderModel();
    });
    hdr.append(title, collapse);
    propsPanel.append(hdr);
    propsPanel.style.display = "block";
    if (propsCollapsed) return;

    // --- No selection: the current drafting environment (AutoCAD-class). ----
    if (selected.length === 0) {
      const settings = state.snapshot?.draftingSettings;
      const layer = layerById.get(state.activeLayer);
      let resolved: { color: string; linetype: string; lineweight: number } | null = null;
      if (layer !== undefined) {
        try {
          const r = resolveDisplay(
            { color: null, linetype: null, lineweight: null, transparency: null },
            layer,
            settings?.standards,
            state.snapshot?.ltypes ?? [],
          );
          resolved = { color: r.color, linetype: r.linetype, lineweight: r.lineweight };
        } catch {
          resolved = { color: layer.color, linetype: layer.linetype ?? "Continuous", lineweight: layer.lineweight ?? STANDARD_DEFAULT_LINEWEIGHT };
        }
      }
      propSection(propsPanel, "Current drafting environment");
      // Active layer select (layer.setActive; frozen layers are listed but
      // disabled — a frozen layer cannot become current).
      const activeRow = h("div", "prow");
      const activeKey = h("span", "k");
      activeKey.textContent = "active layer";
      const activeSelect = h("select");
      activeSelect.title = "Active layer for new entities (layer.setActive)";
      activeSelect.setAttribute("aria-label", "active layer");
      for (const l of layers) {
        const o = h("option");
        o.value = l.id;
        o.textContent = l.frozen === true ? `${l.name} (frozen)` : l.name;
        o.disabled = l.frozen === true;
        activeSelect.append(o);
      }
      activeSelect.value = state.activeLayer;
      activeSelect.addEventListener("change", () => commitCommand("layer.setActive", { layerId: activeSelect.value }));
      activeRow.append(activeKey, activeSelect);
      propsPanel.append(activeRow);
      if (resolved !== null && layer !== undefined) {
        const colorRow = h("div", "prow");
        const colorKey = h("span", "k");
        colorKey.textContent = "effective color";
        const swatch = h("span", "swatch");
        swatch.style.background = resolved.color;
        swatch.setAttribute("aria-hidden", "true");
        const colorVal = h("span", "v");
        colorVal.textContent = resolved.color;
        colorRow.append(colorKey, swatch, colorVal);
        propsPanel.append(colorRow);
        propRow(propsPanel, "effective linetype", resolved.linetype);
        propRow(propsPanel, "effective lineweight", `${resolved.lineweight.toFixed(2)} mm`);
      }
      propRow(propsPanel, "current text style", settings?.textStyle ?? "Standard");
      propRow(propsPanel, "current dim style", settings?.dimStyle ?? "Standard");
      propRow(propsPanel, "linetype scale", String(settings?.standards?.linetypeScale ?? 1));
      const hint = h("div", "hint");
      hint.textContent = "No selection. Pick an entity in the Model viewport — or draw with LINE, CIRCLE, PLINE…";
      propsPanel.append(hint);
      return;
    }

    // --- Multi-selection: common-property editing (CHPROP-class). ------------
    if (selected.length > 1) {
      const drafting = selected.filter((el) => (el.props as Record<string, unknown>).drafting === true);
      const locked = drafting.some((el) => {
        const layerId = (el.props as Record<string, unknown>).layer;
        return typeof layerId === "string" && layerById.get(layerId)?.locked === true;
      });
      // CAD-PARITY-005: the annotation subset (soft load — legacy dims too);
      // annotation.update patches apply to the annotation ids only.
      const annoViews: { el: Element; anno: Annotation }[] = [];
      for (const el of selected) {
        const anno = annotationFromElement(el);
        if (anno !== null) annoViews.push({ el, anno });
      }
      propSection(propsPanel, `Selection — ${selected.length} entities`);
      propRow(propsPanel, "drafting entities", String(drafting.length));
      if (annoViews.length > 0) propRow(propsPanel, "annotations", String(annoViews.length));
      if (locked) {
        const l = h("div", "locked");
        l.textContent = "locked layer — read-only";
        propsPanel.append(l);
      }
      if (drafting.length > 0) {
        propSection(propsPanel, "Common display properties");
        const firstLayer = (drafting[0]!.props as Record<string, unknown>).layer;
        const commonLayer =
          typeof firstLayer === "string" && drafting.every((el) => (el.props as Record<string, unknown>).layer === firstLayer)
            ? firstLayer
            : null;
        appendDisplayEditors(
          propsPanel,
          drafting.map((el) => el.id),
          { color: null, linetype: null, lineweight: null, transparency: null },
          commonLayer,
          locked,
        );
        const hint = h("div", "hint");
        hint.textContent = `Display edits apply to the ${drafting.length} drafting entities atomically (CHPROP semantics); mixed values show ByLayer defaults.`;
        propsPanel.append(hint);
      }
      if (annoViews.length > 0) {
        // CAD-PARITY-005: the shared annotation fields over the whole
        // annotation subset (one atomic annotation.update revision).
        propSection(propsPanel, `Common annotation properties — ${annoViews.length}`);
        appendAnnotationMultiRows(
          propsPanel,
          annoViews.map((v) => v.anno),
          locked,
          (patch) => commitCommand("annotation.update", { ids: annoViews.map((v) => v.el.id), patch }),
        );
      }
      return;
    }

    // --- Single selection: the full professional inspector. -------------------
    const el = selected[0]!;
    const p = el.props as Record<string, unknown>;
    const canonical = geomFromElement(el);
    const layerId = typeof p.layer === "string" ? p.layer : null;
    const layer = layerId !== null ? layerById.get(layerId) : undefined;
    const locked = layer?.locked === true && p.drafting === true;

    propSection(propsPanel, "General");
    propRow(propsPanel, "id", el.id);
    propRow(propsPanel, "kind", el.kind);
    propRow(propsPanel, "layer", layer?.name ?? layerId ?? "—");

    if (p.drafting === true) {
      propSection(propsPanel, "Display (ByLayer chain)");
      if (locked) {
        const l = h("div", "locked");
        l.textContent = `layer “${layer?.name ?? layerId}” locked — read-only`;
        propsPanel.append(l);
      }
      const overrides = displayOverridesOf(p);
      appendDisplayEditors(propsPanel, [el.id], overrides, layerId, locked);
      if (layer !== undefined) {
        propRow(propsPanel, "↳ layer color", layer.color);
        propRow(propsPanel, "↳ layer linetype", layer.linetype ?? "Continuous");
        propRow(propsPanel, "↳ layer lineweight", (layer.lineweight ?? STANDARD_DEFAULT_LINEWEIGHT).toFixed(2));
      }
    }

    // CAD-PARITY-006 (Issue #84): the Block Instance / Reference Instance
    // section — definition readout (read-only, resolved from the document
    // tables), the placement editors (x/y/scale/rotation through
    // entity.modify's instance transforms — move/rotate/scale, one atomic
    // revision per edit exactly like the annotation placement fields) and,
    // for block instances, the per-tag attribute value editors through
    // attribute.update (an EMPTY value clears the stored value with null —
    // the definition default renders).
    const blockInstanceRef = blockRefFromElement(el);
    const xrefInstanceRef = blockInstanceRef === null ? xrefRefFromElement(el) : null;
    if (blockInstanceRef !== null || xrefInstanceRef !== null) {
      const isBlock = blockInstanceRef !== null;
      propSection(propsPanel, isBlock ? "Block Instance" : "Reference Instance");
      if (locked) {
        const l = h("div", "locked");
        l.textContent = `layer “${layer?.name ?? layerId}” locked — read-only`;
        propsPanel.append(l);
      }
      let tagSlots: readonly { readonly tag: string; readonly default: string }[] = [];
      if (isBlock) {
        const def = (state.snapshot?.blockDefs ?? []).find((b) => b.id === blockInstanceRef!.blockId);
        propRow(propsPanel, "definition", def !== undefined ? def.name : `unresolved (${blockInstanceRef!.blockId})`);
        if (def !== undefined) {
          propRow(propsPanel, "entities", String(def.entities.length));
          for (const e of def.entities) {
            if (e.type === "attdef" && typeof e.tag === "string") {
              tagSlots = [
                ...tagSlots,
                { tag: e.tag, default: typeof e.default === "string" ? e.default : "" },
              ];
            }
          }
        }
      } else {
        const rec = (state.snapshot?.xrefs ?? []).find((x) => x.id === xrefInstanceRef!.xrefId);
        propRow(propsPanel, "name", rec !== undefined ? rec.name : `unresolved (${xrefInstanceRef!.xrefId})`);
        propRow(propsPanel, "status", rec?.status ?? "unresolved");
        if (rec !== undefined) {
          propRow(propsPanel, "path", rec.path);
          propRow(propsPanel, "source", rec.sourceHash !== null ? `${rec.sourceHash.slice(0, 12)}…` : "none");
          propRow(propsPanel, "entities", String(rec.entities.length));
        }
      }
      // Placement editors — the current placement of the instance (the
      // fallbacks mirror the core's instancePlacement).
      const at = isBlock ? blockInstanceRef! : xrefInstanceRef!;
      const placement = (key: "x" | "y" | "scale" | "rotation"): HTMLInputElement => {
        const input = h("input");
        input.type = "number";
        input.step = "any";
        input.title = `Instance ${key === "rotation" ? "rotation (°)" : key}`;
        input.setAttribute("aria-label", `instance ${key}`);
        input.value =
          key === "x" ? String(Number(at.x.toFixed(3))) :
          key === "y" ? String(Number(at.y.toFixed(3))) :
          key === "scale" ? String(Number(at.scale.toFixed(4))) :
          String(Number((at.rotation / DEG).toFixed(4)));
        input.disabled = locked;
        input.addEventListener("change", () => {
          const v = Number(input.value);
          if (!Number.isFinite(v)) return;
          if (key === "x") {
            const dx = v - at.x;
            if (dx !== 0) commitCommand("entity.modify", { op: "move", ids: [el.id], dx, dy: 0 });
            return;
          }
          if (key === "y") {
            const dy = v - at.y;
            if (dy !== 0) commitCommand("entity.modify", { op: "move", ids: [el.id], dx: 0, dy });
            return;
          }
          if (key === "scale") {
            if (!(v > 0) || v === at.scale) return;
            // Scale about the insertion point: the point stays, the uniform
            // instance scale becomes v (the core's instance scaling).
            commitCommand("entity.modify", { op: "scale", ids: [el.id], base: { x: at.x, y: at.y }, factor: v / at.scale });
            return;
          }
          // Rotation edited in degrees → rotate about the insertion point by
          // the delta (the core's instance rotation composes the angle).
          const angle = v * DEG - at.rotation;
          if (angle !== 0) {
            commitCommand("entity.modify", { op: "rotate", ids: [el.id], base: { x: at.x, y: at.y }, angle });
          }
        });
        return input;
      };
      const prow = (key: "x" | "y" | "scale" | "rotation", label: string): void => {
        const r = h("div", "prow");
        const k = h("span", "k");
        k.textContent = label;
        r.append(k, placement(key));
        propsPanel.append(r);
      };
      prow("x", "insertion x");
      prow("y", "insertion y");
      prow("scale", "scale");
      prow("rotation", "rotation (°)");
      // Per-tag attribute value editors (block instances only).
      if (isBlock && tagSlots.length > 0) {
        propSection(propsPanel, "Attributes");
        for (const slot of tagSlots) {
          const stored = (blockInstanceRef!.attributes ?? []).find((a) => a.tag === slot.tag)?.value ?? null;
          const r = h("div", "prow");
          const k = h("span", "k");
          k.textContent = slot.tag;
          const input = h("input");
          input.type = "text";
          input.title =
            slot.default.length > 0
              ? `Value for attribute '${slot.tag}' (empty = the definition default '${slot.default}')`
              : `Value for attribute '${slot.tag}' (empty = no rendered value)`;
          input.setAttribute("aria-label", `attribute value ${slot.tag}`);
          // The editor shows the EFFECTIVE value (the stored value, else the
          // definition default); committing an EMPTY input clears the stored
          // value (value: null → the default renders, an empty slot hides).
          input.value = stored !== null ? stored : slot.default;
          input.disabled = locked;
          input.addEventListener("change", () => {
            const v = input.value;
            if (v === (stored ?? slot.default)) return;
            commitCommand("attribute.update", { id: el.id, tag: slot.tag, ...(v.length > 0 ? { value: v } : { value: null }) });
          });
          r.append(k, input);
          propsPanel.append(r);
        }
        const hint = h("div", "hint");
        hint.textContent = "Attribute values render through the definition's ATTDEF slots (ATTEDIT edits the same values; an empty input clears the stored value — the definition default renders).";
        propsPanel.append(hint);
      }
    }

    // The canonical geometry readout (CAD-PARITY-003 rows, retained verbatim).
    const g = canonical;
    if (g !== null) {
      propSection(propsPanel, "Geometry");
      switch (g.type) {
        case "ellipse":
          propRow(propsPanel, "axes", `${num(g.rx)} × ${num(g.ry)}`);
          propRow(propsPanel, "rotation", `${num((g.rotation * 180) / Math.PI)}°`);
          propRow(propsPanel, "center", `${num(g.cx)}, ${num(g.cy)}`);
          break;
        case "spline":
          propRow(propsPanel, "control points", String(g.controlPoints.length));
          propRow(propsPanel, "degree", String(g.degree));
          break;
        case "point":
          propRow(propsPanel, "position", `${num(g.x)}, ${num(g.y)}`);
          break;
        case "ray":
        case "xline": {
          const dirDeg = (Math.atan2(g.y2 - g.y1, g.x2 - g.x1) * 180) / Math.PI + 360;
          propRow(propsPanel, "base", `${num(g.x1)}, ${num(g.y1)}`);
          propRow(propsPanel, "through", `${num(g.x2)}, ${num(g.y2)}`);
          propRow(propsPanel, "direction", `${num(dirDeg % 360)}°`);
          break;
        }
        case "region":
          propRow(propsPanel, "boundary", g.boundary.kind);
          propRow(propsPanel, "area", num(g.area));
          propRow(propsPanel, "perimeter", num(g.perimeter));
          propRow(propsPanel, "centroid", `${num(g.centroid.x)}, ${num(g.centroid.y)}`);
          break;
        case "line":
          propRow(propsPanel, "from", `${num(g.x1)}, ${num(g.y1)}`);
          propRow(propsPanel, "to", `${num(g.x2)}, ${num(g.y2)}`);
          break;
        case "circle":
          propRow(propsPanel, "center", `${num(g.cx)}, ${num(g.cy)}`);
          propRow(propsPanel, "radius", num(g.r));
          break;
        case "arc":
          propRow(propsPanel, "center", `${num(g.cx)}, ${num(g.cy)}`);
          propRow(propsPanel, "radius", num(g.r));
          propRow(propsPanel, "sweep", `${num((((g.endAngle - g.startAngle) * 180) / Math.PI + 360) % 360)}°`);
          break;
        case "polyline":
          propRow(propsPanel, "vertices", String(g.vertices.length));
          propRow(propsPanel, "closed", g.closed ? "yes" : "no");
          break;
      }
    }

    // CAD-PARITY-005: the per-type annotation fields (content/placement/
    // style — annotation.update, one atomic revision per field; the measured
    // value is the READ-ONLY stored document truth, formatted through the
    // SAME style context the canvas paints). The mirror of the Web
    // PropertiesPanel Annotation section.
    const anno = annotationFromElement(el);
    if (anno !== null) {
      propSection(propsPanel, "Annotation");
      if (locked) {
        const l = h("div", "locked");
        l.textContent = `layer “${layer?.name ?? layerId}” locked — read-only`;
        propsPanel.append(l);
      }
      appendAnnotationRows(propsPanel, anno, locked, (patch) =>
        commitCommand("annotation.update", { ids: [el.id], patch }),
      );
    }
  }

  // --- command line + status bar ------------------------------------------------------------

  const cmdLine = h("div", "pro-cmdline");
  cmdLine.setAttribute("data-testid", "pro-command-line");
  const history = h("div", "history");
  history.setAttribute("data-testid", "pro-command-history");
  history.setAttribute("aria-live", "polite");
  const prompt = h("div", "prompt");
  prompt.setAttribute("data-testid", "pro-command-prompt");
  const entry = h("div", "entry");
  const promptChar = h("span");
  promptChar.textContent = "▸";
  promptChar.style.color = "var(--muted)";
  const input = h("input");
  input.setAttribute("type", "text");
  input.setAttribute("aria-label", "command input");
  input.setAttribute("data-testid", "pro-command-input");
  input.setAttribute("placeholder", "Type a command or alias (L, C, WA, ST…) — Ctrl+K searches");
  entry.append(promptChar, input);
  cmdLine.append(history, prompt, entry);

  const statusBar = h("div", "pro-statusbar");
  statusBar.setAttribute("role", "status");
  statusBar.setAttribute("data-testid", "pro-status-bar");
  const coord = h("span", "coord");
  coord.setAttribute("data-testid", "pro-coordinate-readout");
  const toggleButtons = new Map<string, HTMLButtonElement>();
  const makeToggle = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = h("button", "tog");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    statusBar.append(b);
    toggleButtons.set(label, b);
    return b;
  };
  makeToggle("SNAP", "Grid snap stepping (F9)", () => void executePlan({ appApi: [], ui: [{ action: "toggle.snap" }], echo: [] }));
  makeToggle("GRID", "Grid display (F7)", () => void executePlan({ appApi: [], ui: [{ action: "toggle.grid" }], echo: [] }));
  makeToggle("ORTHO", "Orthogonal constraint (F8)", () => void executePlan({ appApi: [], ui: [{ action: "toggle.ortho" }], echo: [] }));
  makeToggle("POLAR", "Polar tracking (F10)", () => void executePlan({ appApi: [], ui: [{ action: "toggle.polar" }], echo: [] }));
  makeToggle("OTRACK", "Object tracking (F11)", () => void executePlan({ appApi: [], ui: [{ action: "toggle.otrack" }], echo: [] }));
  // CAD-PARITY-004: LWT — the lineweight display toggle (LWEIGHT/LW class;
  // persisted drafting setting, identical on both hosts).
  makeToggle("LWT", "Lineweight display (LWEIGHT/LW) — lineweights render at weight × zoom when on", () =>
    void executePlan({ appApi: [], ui: [{ action: "toggle.lweight" }], echo: [] }),
  );
  const info = h("span");
  info.style.marginLeft = "auto";
  // CAD-PARITY-004: the active-layer display is a clickable link to the
  // Layers manager (the same affordance the Web status bar carries).
  const layerLink = h("button", "layerlink");
  layerLink.type = "button";
  layerLink.title = "Active drafting layer — click to open the Layers manager";
  layerLink.setAttribute("aria-label", "active layer — open the Layers manager");
  layerLink.addEventListener("click", () => openDock("layers"));
  const infoRest = h("span");
  info.append(layerLink, infoRest);
  statusBar.append(coord, info);

  document.body.append(cmdLine, statusBar);

  function renderCommandLine(): void {
    while (history.firstChild) history.removeChild(history.firstChild);
    const MAX = 400;
    const lines = state.history.slice(-MAX);
    for (const line of lines) {
      const d = h("div");
      d.textContent = line;
      history.append(d);
    }
    history.scrollTop = history.scrollHeight;
    const described = describePrompt(state.engine);
    prompt.textContent = described.prompt !== null ? `${described.commandName !== null ? described.commandName + ": " : ""}${described.prompt}` : "";
  }

  function renderStatusBar(): void {
    coord.textContent = state.cursor !== null ? formatCoordinate(state.cursor) : "—";
    const settings = state.snapshot?.draftingSettings;
    const snapOn = toggleButtons.get("SNAP");
    if (snapOn !== undefined) snapOn.classList.toggle("on", settings?.snap.enabled ?? true);
    const gridOn = toggleButtons.get("GRID");
    if (gridOn !== undefined) gridOn.classList.toggle("on", settings?.grid.enabled ?? true);
    const orthoOn = toggleButtons.get("ORTHO");
    if (orthoOn !== undefined) orthoOn.classList.toggle("on", state.aids.ortho);
    const polarOn = toggleButtons.get("POLAR");
    if (polarOn !== undefined) polarOn.classList.toggle("on", state.aids.polar);
    const otrackOn = toggleButtons.get("OTRACK");
    if (otrackOn !== undefined) otrackOn.classList.toggle("on", state.aids.otrack);
    // CAD-PARITY-004: the lineweight display toggle state.
    const lwtOn = toggleButtons.get("LWT");
    if (lwtOn !== undefined) lwtOn.classList.toggle("on", settings?.lineweightDisplay === true);
    const elements = state.snapshot?.elements ?? [];
    const story = elements.find((el) => el.id === state.activeStoryId);
    const storyName = story !== undefined ? ((story.props as Record<string, unknown>).name as string | undefined) ?? "—" : "—";
    const layerName =
      (state.snapshot?.layers ?? []).find((l) => l.id === state.activeLayer)?.name ?? state.activeLayer;
    layerLink.textContent = `Layer ${layerName}`;
    // CAD-PARITY-008: the Model/Paper context indicator (TILEMODE/MSPACE/
    // PSPACE — layout.setSpace).
    const layouts = state.snapshot?.layouts ?? [];
    const activeLayout = layouts.find((l) => l.id === (settings?.activeLayout ?? layouts[0]?.id));
    const spaceLabel = layouts.length === 0 ? "" : space === "model" ? "Model" : `Paper · ${activeLayout?.name ?? "—"}`;
    infoRest.textContent = `${spaceLabel.length > 0 ? ` · ${spaceLabel}` : ""} · Story ${storyName} · Sel ${state.selection.length} · v${state.snapshot?.version?.version_number ?? 0} · ${settings?.units ?? "mm"}`;
  }

  // --- CAD-PARITY-004 right dock: Layers manager + Styles manager ---------------
  // (DOM mirrors of the Web palettes.tsx LayersPanel/StylesPanel; every write
  //  goes through the App API command() helper + refresh.)

  /** Tiny inline SVG glyph set for the panel icon buttons (12×12 line icons,
   *  currentColor strokes — no external assets). */
  function icon(d: string): SVGElement {
    const s = svgNs("svg");
    s.setAttribute("viewBox", "0 0 12 12");
    s.setAttribute("width", "12");
    s.setAttribute("height", "12");
    s.setAttribute("aria-hidden", "true");
    const p = svgNs("path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.1");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    s.append(p);
    return s;
  }

  const ICON = {
    plus: () => icon("M6 2 v8 M2 6 h8"),
    trash: () => icon("M2 3 h8 M4.6 3 V1.9 h2.8 V3 M3 3 l.5 7.5 h5 L9.5 3"),
    eye: () => icon("M1 6 C2.7 3.4, 9.3 3.4, 11 6 C9.3 8.6, 2.7 8.6, 1 6 Z M6 4.7 a1.3 1.3 0 1 0 0 2.6 a1.3 1.3 0 1 0 0 -2.6"),
    eyeOff: () => icon("M1 6 C2.7 3.4, 9.3 3.4, 11 6 C9.3 8.6, 2.7 8.6, 1 6 Z M1.8 10.2 L10.2 1.8"),
    snow: () => icon("M6 1 V11 M2.2 3.3 L9.8 8.7 M9.8 3.3 L2.2 8.7"),
    lock: () => icon("M3.2 5.2 V4.2 a2.8 2.8 0 0 1 5.6 0 V5.2 M2.6 5.2 h6.8 v4.9 h-6.8 Z"),
    unlock: () => icon("M3.2 5.2 V4.2 a2.8 2.8 0 0 1 5.6 0 M2.6 5.2 h6.8 v4.9 h-6.8 Z"),
  } as const;

  /** A small dash-pattern sample line (the linetype catalog preview). */
  function dashSample(pattern: readonly number[]): SVGElement {
    const s = svgNs("svg");
    s.setAttribute("width", "42");
    s.setAttribute("height", "8");
    s.setAttribute("aria-hidden", "true");
    const line = svgNs("line");
    line.setAttribute("x1", "1");
    line.setAttribute("y1", "4");
    line.setAttribute("x2", "41");
    line.setAttribute("y2", "4");
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "1");
    if (pattern.length > 0) line.setAttribute("stroke-dasharray", pattern.join(","));
    s.append(line);
    return s;
  }

  function renderDock(): void {
    dock.classList.toggle("closed", !dockOpen);
    dockTabLayers.classList.toggle("active", dockTab === "layers");
    dockTabStyles.classList.toggle("active", dockTab === "styles");
    dockTabBlocks.classList.toggle("active", dockTab === "blocks");
    dockTabConstraints.classList.toggle("active", dockTab === "constraints");
    dockTabLayouts.classList.toggle("active", dockTab === "layouts");
    dockTabLayers.setAttribute("aria-selected", String(dockTab === "layers"));
    dockTabStyles.setAttribute("aria-selected", String(dockTab === "styles"));
    dockTabBlocks.setAttribute("aria-selected", String(dockTab === "blocks"));
    dockTabConstraints.setAttribute("aria-selected", String(dockTab === "constraints"));
    dockTabLayouts.setAttribute("aria-selected", String(dockTab === "layouts"));
    while (dockBody.firstChild) dockBody.removeChild(dockBody.firstChild);
    if (dockTab === "layers") renderLayersPanel(dockBody);
    else if (dockTab === "blocks") renderBlocksPanel(dockBody);
    else if (dockTab === "constraints") renderConstraintsPanel(dockBody);
    else if (dockTab === "layouts") renderLayoutsPanel(dockBody);
    else renderStylesPanel(dockBody);
  }

  /** The Layers manager (mirrors the Web LayersPanel): new layer + layer
   *  standards, name/state filters, the layer table and the collapsible
   *  layer-states section. */
  function renderLayersPanel(container: HTMLElement): void {
    const snapshot = state.snapshot;
    const layers = snapshot?.layers ?? [];
    const settings = snapshot?.draftingSettings;
    const states = snapshot?.layerStates ?? [];
    const usedLayerIds = new Set<string>();
    for (const el of snapshot?.elements ?? []) {
      const layer = (el.props as Record<string, unknown>).layer;
      if (typeof layer === "string") usedLayerIds.add(layer);
    }
    const ltypeOptions = [...BUILT_IN_LTYPES.map((l) => l.name), ...(snapshot?.ltypes ?? []).map((l) => l.name)];
    const updateLayer = (layerId: string, patch: Record<string, unknown>): void => {
      commitCommand("drafting.updateLayer", { layerId, patch });
    };

    // Bar 1: new layer + Add + layer standards.
    const bar1 = h("div", "bar");
    const nameInput = h("input");
    nameInput.type = "text";
    nameInput.placeholder = "New layer name…";
    nameInput.setAttribute("aria-label", "new layer name");
    nameInput.value = newLayerName;
    nameInput.addEventListener("input", () => {
      newLayerName = nameInput.value;
      addBtn.disabled = newLayerName.trim().length === 0;
    });
    const addLayer = (): void => {
      const name = newLayerName.trim();
      if (name.length === 0) return;
      newLayerName = "";
      commitCommand("drafting.addLayer", { name });
    };
    nameInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        addLayer();
      }
    });
    const addBtn = h("button", "iconbtn");
    addBtn.type = "button";
    addBtn.title = "Add layer";
    addBtn.setAttribute("aria-label", "add layer");
    addBtn.disabled = newLayerName.trim().length === 0;
    addBtn.append(ICON.plus());
    addBtn.addEventListener("click", addLayer);
    const stdSelect = h("select");
    stdSelect.title = "Apply a named drawing standard (creates the standard layer set)";
    stdSelect.setAttribute("aria-label", "apply layer standard");
    const stdNone = h("option");
    stdNone.value = "";
    stdNone.textContent = "Standard…";
    stdSelect.append(stdNone);
    for (const s of LAYER_STANDARDS) {
      const o = h("option");
      o.value = s.id;
      o.textContent = s.label;
      stdSelect.append(o);
    }
    stdSelect.value = "";
    stdSelect.addEventListener("change", () => {
      if (stdSelect.value !== "") commitCommand("layer.applyStandard", { standard: stdSelect.value });
    });
    bar1.append(nameInput, addBtn, stdSelect);
    container.append(bar1);

    // Bar 2: filters (re-render only the table on input so the caret stays).
    const bar2 = h("div", "bar");
    const filterInput = h("input");
    filterInput.type = "text";
    filterInput.placeholder = "Filter layers…";
    filterInput.setAttribute("aria-label", "layer name filter");
    filterInput.value = layerFilterText;
    const modeSelect = h("select");
    modeSelect.title = "Layer state filter";
    modeSelect.setAttribute("aria-label", "layer state filter");
    for (const m of LAYER_FILTER_MODES) {
      const o = h("option");
      o.value = m.id;
      o.textContent = m.label;
      modeSelect.append(o);
    }
    modeSelect.value = layerFilterMode;
    const tableWrap = h("div", "pro-layers-scroll");
    tableWrap.setAttribute("aria-label", "layers list");
    const renderTable = (): void => {
      while (tableWrap.firstChild) tableWrap.removeChild(tableWrap.firstChild);
      const filtered = filterLayers(layers, layerFilterMode, layerFilterText, usedLayerIds);
      const head = h("div", "pro-layers-head");
      const headCells = [
        { label: "", title: "Active layer" },
        { label: "Name", title: "Layer name" },
        { label: "On", title: "Layer visibility" },
        { label: "Frz", title: "Freeze" },
        { label: "Lck", title: "Lock" },
        { label: "Color", title: "Layer color" },
        { label: "Linetype", title: "Layer linetype" },
        { label: "Weight", title: "Layer lineweight (mm)" },
        { label: "Plt", title: "Plot" },
      ];
      for (const cell of headCells) {
        const span = h("span");
        span.textContent = cell.label;
        if (cell.title !== "") span.title = cell.title;
        head.append(span);
      }
      tableWrap.append(head);
      for (const layer of filtered) {
        const active = state.activeLayer === layer.id;
        const used = usedLayerIds.has(layer.id);
        const row = h("div", "pro-layer-row" + (active ? " active" : ""));

        // Active-layer dot.
        const dot = h("button", "dot");
        dot.type = "button";
        dot.title = "Set active layer";
        dot.setAttribute("aria-label", `${layer.name} set active`);
        dot.disabled = layer.frozen === true;
        dot.addEventListener("click", () => commitCommand("layer.setActive", { layerId: layer.id }));
        row.append(dot);

        // Name (double-click to rename) + delete.
        const nameCell = h("span", "name");
        if (editingLayerId === layer.id) {
          const rename = h("input", "rename");
          rename.type = "text";
          rename.value = layer.name;
          rename.setAttribute("aria-label", "rename layer");
          rename.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              const v = rename.value.trim();
              editingLayerId = null;
              if (v.length > 0 && v !== layer.name) updateLayer(layer.id, { name: v });
              else renderDock();
            } else if (e.key === "Escape") {
              e.preventDefault();
              editingLayerId = null;
              renderDock();
            }
          });
          rename.addEventListener("blur", () => {
            if (editingLayerId === layer.id) {
              editingLayerId = null;
              renderDock();
            }
          });
          nameCell.append(rename);
        } else {
          const nm = h("button", "nm");
          nm.type = "button";
          nm.textContent = layer.name;
          nm.title = layer.description ?? layer.name;
          nm.disabled = layer.frozen === true;
          nm.addEventListener("dblclick", () => {
            editingLayerId = layer.id;
            renderDock();
            const inputEl = tableWrap.querySelector<HTMLInputElement>("input.rename");
            if (inputEl !== null) {
              inputEl.focus();
              inputEl.select();
            }
          });
          nm.addEventListener("click", () => commitCommand("layer.setActive", { layerId: layer.id }));
          nameCell.append(nm);
          if (!used) {
            const unused = h("span", "unused");
            unused.textContent = "(unused)";
            unused.title = "No entities on this layer";
            nameCell.append(unused);
          }
        }
        const del = h("button", "tgl");
        del.type = "button";
        del.title = "Delete layer (blocked while entities reference it)";
        del.setAttribute("aria-label", `delete layer ${layer.name}`);
        del.disabled = used || layer.id === "0";
        del.append(ICON.trash());
        del.addEventListener("click", () => commitCommand("drafting.removeLayer", { layerId: layer.id }));
        nameCell.append(del);
        row.append(nameCell);

        // Visibility toggle.
        const vis = h("button", "tgl" + (layer.visible ? " on" : ""));
        vis.type = "button";
        vis.title = layer.visible ? "Hide layer" : "Show layer";
        vis.setAttribute("aria-label", `${layer.name} ${layer.visible ? "hide" : "show"}`);
        vis.append(layer.visible ? ICON.eye() : ICON.eyeOff());
        vis.addEventListener("click", () => updateLayer(layer.id, { visible: !layer.visible }));
        row.append(vis);

        // Freeze toggle (the active layer cannot be frozen).
        const frz = h("button", "tgl" + (layer.frozen === true ? " on" : ""));
        frz.type = "button";
        frz.title = layer.frozen === true ? "Thaw layer" : "Freeze layer (suppresses display, creation and snap)";
        frz.setAttribute("aria-label", `${layer.name} ${layer.frozen === true ? "thaw" : "freeze"}`);
        frz.disabled = active && layer.frozen !== true;
        frz.append(ICON.snow());
        frz.addEventListener("click", () => updateLayer(layer.id, { frozen: layer.frozen !== true }));
        row.append(frz);

        // Lock toggle.
        const lck = h("button", "tgl" + (layer.locked === true ? " warn" : ""));
        lck.type = "button";
        lck.title = layer.locked === true ? "Unlock layer" : "Lock layer (entities become read-only)";
        lck.setAttribute("aria-label", `${layer.name} ${layer.locked === true ? "unlock" : "lock"}`);
        lck.append(layer.locked === true ? ICON.lock() : ICON.unlock());
        lck.addEventListener("click", () => updateLayer(layer.id, { locked: layer.locked !== true }));
        row.append(lck);

        // Color.
        const colorInput = h("input");
        colorInput.type = "color";
        colorInput.title = "Layer color";
        colorInput.setAttribute("aria-label", `${layer.name} color`);
        colorInput.value = layer.color;
        colorInput.addEventListener("change", () => updateLayer(layer.id, { color: colorInput.value }));
        row.append(colorInput);

        // Linetype.
        const ltSelect = h("select");
        ltSelect.title = "Layer linetype";
        ltSelect.setAttribute("aria-label", `${layer.name} linetype`);
        for (const name of ltypeOptions) {
          const o = h("option");
          o.value = name;
          o.textContent = name;
          ltSelect.append(o);
        }
        ltSelect.value = layer.linetype ?? "Continuous";
        ltSelect.addEventListener("change", () => updateLayer(layer.id, { linetype: ltSelect.value }));
        row.append(ltSelect);

        // Lineweight.
        const lwSelect = h("select");
        lwSelect.title = "Layer lineweight (mm)";
        lwSelect.setAttribute("aria-label", `${layer.name} lineweight`);
        for (const w of STANDARD_LINEWEIGHTS) {
          const o = h("option");
          o.value = String(w);
          o.textContent = w.toFixed(2);
          lwSelect.append(o);
        }
        lwSelect.value = String(layer.lineweight ?? settings?.standards?.defaultLineweight ?? STANDARD_DEFAULT_LINEWEIGHT);
        lwSelect.addEventListener("change", () => updateLayer(layer.id, { lineweight: Number(lwSelect.value) }));
        row.append(lwSelect);

        // Plot toggle.
        const plot = h("button", "tgl" + (layer.plot !== false ? " on" : ""));
        plot.type = "button";
        plot.title = layer.plot !== false ? "Exclude from plotting" : "Include in plotting";
        plot.setAttribute("aria-label", `${layer.name} plot ${layer.plot !== false ? "off" : "on"}`);
        plot.textContent = layer.plot !== false ? "✓" : "–";
        plot.addEventListener("click", () => updateLayer(layer.id, { plot: layer.plot === false }));
        row.append(plot);

        tableWrap.append(row);
      }
      if (filtered.length === 0) {
        const empty = h("div", "empty");
        empty.textContent = "No layers match the filter.";
        tableWrap.append(empty);
      }
    };
    filterInput.addEventListener("input", () => {
      layerFilterText = filterInput.value;
      renderTable();
    });
    modeSelect.addEventListener("change", () => {
      layerFilterMode = modeSelect.value as LayerFilterMode;
      renderTable();
    });
    bar2.append(filterInput, modeSelect);
    container.append(bar2);
    renderTable();
    container.append(tableWrap);

    // Layer states (collapsible).
    const statesSec = h("div", "pro-states");
    const statesHead = h("button", "head");
    statesHead.type = "button";
    statesHead.textContent = `${layerStatesOpen ? "▾" : "▸"} Layer states (${states.length})`;
    statesHead.setAttribute("aria-expanded", String(layerStatesOpen));
    statesHead.setAttribute("aria-label", "layer states section");
    statesHead.addEventListener("click", () => {
      layerStatesOpen = !layerStatesOpen;
      renderDock();
    });
    statesSec.append(statesHead);
    if (layerStatesOpen) {
      const body = h("div", "body");
      const bar = h("div", "bar");
      bar.style.borderBottom = "none";
      bar.style.padding = "4px 0";
      const stateInput = h("input");
      stateInput.type = "text";
      stateInput.placeholder = "State name…";
      stateInput.setAttribute("aria-label", "new layer state name");
      stateInput.value = newStateName;
      const saveState = (): void => {
        const name = newStateName.trim();
        if (name.length === 0) return;
        newStateName = "";
        commitCommand("layerState.save", { name });
      };
      stateInput.addEventListener("input", () => {
        newStateName = stateInput.value;
        saveBtn.disabled = newStateName.trim().length === 0;
      });
      stateInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          saveState();
        }
      });
      const saveBtn = h("button", "iconbtn");
      saveBtn.type = "button";
      saveBtn.title = "Save layer state";
      saveBtn.setAttribute("aria-label", "save layer state");
      saveBtn.disabled = newStateName.trim().length === 0;
      saveBtn.textContent = "Save";
      saveBtn.style.width = "auto";
      saveBtn.style.fontSize = "10px";
      saveBtn.addEventListener("click", saveState);
      bar.append(stateInput, saveBtn);
      body.append(bar);
      for (const st of states as readonly LayerStateRecord[]) {
        const r = h("div", "pro-state-row");
        const nm = h("span", "nm");
        nm.textContent = st.name;
        nm.title = st.name;
        const cnt = h("span", "cnt");
        cnt.textContent = `${st.layers.length} layers`;
        const restore = h("button", "tgl");
        restore.type = "button";
        restore.title = "Restore state";
        restore.setAttribute("aria-label", `restore layer state ${st.name}`);
        restore.textContent = "↺";
        restore.addEventListener("click", () => commitCommand("layerState.restore", { name: st.name }));
        const remove = h("button", "tgl");
        remove.type = "button";
        remove.title = "Delete state";
        remove.setAttribute("aria-label", `delete layer state ${st.name}`);
        remove.append(ICON.trash());
        remove.addEventListener("click", () => commitCommand("layerState.remove", { name: st.name }));
        r.append(nm, cnt, restore, remove);
        body.append(r);
      }
      if (states.length === 0) {
        const empty = h("div", "empty");
        empty.style.padding = "2px 2px";
        empty.textContent = "No saved states.";
        body.append(empty);
      }
      statesSec.append(body);
    }
    container.append(statesSec);
  }

  /** CAD-PARITY-006 (Issue #84): the Blocks & References manager (mirrors the
   *  Web palettes pattern — the 004 managers' DOM conventions). Two sections:
   *  the block-definition table (name, inline entity count, INSTANCE count,
   *  attribute tags; per-definition Insert + reference-checked remove) and
   *  the external-reference table (Attach through the REAL main-process file
   *  dialog → xref.attach with the parsed content, Reload through the same
   *  dialog → xref.reload, Detach → xref.detach, status badges + provenance).
   *  Every write goes through the App API command() helper + refresh. */
  function renderBlocksPanel(container: HTMLElement): void {
    const snapshot = state.snapshot;
    const defs = snapshot?.blockDefs ?? [];
    const xrefs = snapshot?.xrefs ?? [];
    const elements = snapshot?.elements ?? [];
    // Instance counts derived from the elements (the same count the
    // blocks.list / xrefs.list queries report).
    const blockInstances = new Map<string, number>();
    const xrefInstances = new Map<string, number>();
    for (const el of elements) {
      const props = el.props as Record<string, unknown>;
      if (props.drafting !== true) continue;
      if (props.type === "block-ref" && typeof props.blockId === "string") {
        blockInstances.set(props.blockId, (blockInstances.get(props.blockId) ?? 0) + 1);
      } else if (props.type === "xref-ref" && typeof props.xrefId === "string") {
        xrefInstances.set(props.xrefId, (xrefInstances.get(props.xrefId) ?? 0) + 1);
      }
    }

    const scroll = h("div", "pro-dock-scroll");
    scroll.style.flex = "1";
    const sec = (title: string): void => {
      const s = h("div", "sec");
      s.textContent = title;
      scroll.append(s);
    };
    const desc = (text: string): void => {
      const d = h("div", "desc");
      d.textContent = text;
      scroll.append(d);
    };

    // --- Block definitions ---
    sec("Block definitions");
    const defBar = h("div", "bar");
    const createBtn = h("button");
    createBtn.type = "button";
    createBtn.className = "mini";
    createBtn.style.width = "auto";
    createBtn.style.fontSize = "10px";
    createBtn.textContent = "Create from selection…";
    createBtn.title = "BLOCK — convert the selected entities into a reusable definition (name, base point, objects)";
    createBtn.setAttribute("aria-label", "create block definition from selection");
    createBtn.addEventListener("click", () => void startCommand("block"));
    defBar.append(createBtn);
    scroll.append(defBar);
    desc(
      defs.length === 0
        ? "No definitions. BLOCK converts selected entities into a reusable definition (the sources are removed — one revision; INSERT places instances)."
        : "Definitions are the single source of content truth — every instance re-derives on each render (definition → instance propagation).",
    );
    for (const def of defs) {
      const row = h("div", "pro-block-row");
      const nm = h("span", "nm");
      nm.textContent = def.name;
      nm.title = def.description ?? def.name;
      const meta = h("span", "grow muted");
      const instances = blockInstances.get(def.id) ?? 0;
      const tags = attdefTagsOf(def.entities);
      meta.textContent =
        `${def.entities.length} ${def.entities.length === 1 ? "entity" : "entities"} · ` +
        `${instances} ${instances === 1 ? "instance" : "instances"}` +
        (tags.length > 0 ? ` · ${tags.join(", ")}` : "");
      const insertBtn = h("button", "tgl");
      insertBtn.type = "button";
      insertBtn.title = `INSERT — place an instance of '${def.name}'`;
      insertBtn.setAttribute("aria-label", `insert block ${def.name}`);
      insertBtn.textContent = "Insert";
      insertBtn.style.fontSize = "9px";
      insertBtn.addEventListener("click", () => {
        // Start INSERT and answer the name prompt with the definition name
        // (the SAME typed flow the command line runs; the placement prompts
        // continue interactively).
        void (async () => {
          await startCommand("insert");
          await dispatchEngine({ type: "typed", text: def.name, cursor: state.cursor });
        })();
      });
      const del = h("button", "tgl");
      del.type = "button";
      del.title = "Delete definition (blocked while instances or other definitions reference it)";
      del.setAttribute("aria-label", `delete block definition ${def.name}`);
      del.append(ICON.trash());
      del.disabled = instances > 0;
      del.addEventListener("click", () => commitCommand("block.remove", { name: def.name }));
      row.append(nm, meta, insertBtn, del);
      scroll.append(row);
    }

    // --- External references ---
    sec("External references");
    const xrefBar = h("div", "bar");
    const attachBtn = h("button");
    attachBtn.type = "button";
    attachBtn.style.flex = "1";
    attachBtn.style.fontSize = "10px";
    attachBtn.title = "XATTACH — attach an external reference with resolved content (the Electron file dialog reads the snapshot)";
    attachBtn.setAttribute("aria-label", "attach external reference from file");
    attachBtn.setAttribute("data-testid", "pro-xref-attach");
    attachBtn.textContent = "Attach reference…";
    attachBtn.addEventListener("click", () => void attachReferenceFlow());
    xrefBar.append(attachBtn);
    scroll.append(xrefBar);
    desc(
      xrefs.length === 0
        ? "No references attached. Attach resolves the snapshot content through the file dialog (.offisos/.json); XATTACH from the command line attaches unresolved (placeholder box)."
        : "Loaded references render their resolved content; unresolved references render the placeholder box. Reload re-reads the file; Detach removes the record AND its instances (one atomic revision).",
    );
    for (const rec of xrefs) {
      const row = h("div", "pro-block-row");
      const nm = h("span", "nm");
      nm.textContent = rec.name;
      nm.title = `${rec.name} — ${rec.path}`;
      const badge = h("span", `pro-xref-badge ${rec.status}`);
      badge.textContent = rec.status;
      badge.title =
        rec.status === "loaded"
          ? `Loaded — source ${rec.sourceHash !== null ? rec.sourceHash.slice(0, 12) + "…" : "none"}`
          : "Unresolved — the placeholder box renders (reload with the file)";
      const meta = h("span", "grow muted");
      const instances = xrefInstances.get(rec.id) ?? 0;
      meta.textContent =
        `${instances} ${instances === 1 ? "instance" : "instances"} · ` +
        `${rec.entities.length} ${rec.entities.length === 1 ? "entity" : "entities"}`;
      const reload = h("button", "tgl");
      reload.type = "button";
      reload.title = "Reload — re-read the external file and re-resolve the content";
      reload.setAttribute("aria-label", `reload reference ${rec.name}`);
      reload.setAttribute("data-testid", `pro-xref-reload-${rec.name}`);
      reload.textContent = "↺";
      reload.addEventListener("click", () => void reloadReferenceFlow(rec.name));
      const detach = h("button", "tgl");
      detach.type = "button";
      detach.title = "Detach — remove the record and all its instances (one atomic revision)";
      detach.setAttribute("aria-label", `detach reference ${rec.name}`);
      detach.setAttribute("data-testid", `pro-xref-detach-${rec.name}`);
      detach.append(ICON.trash());
      detach.addEventListener("click", () => commitCommand("xref.detach", { name: rec.name }));
      row.append(nm, badge, meta, reload, detach);
      scroll.append(row);
    }
    container.append(scroll);
  }

  /** The References-palette Attach flow: the main-process file dialog picks
   *  an .offisos/.json snapshot → xref.attach WITH the parsed content (the
   *  reference attaches LOADED, with an instance at the origin on the active
   *  layer). Typed failures surface in the command-line history. */
  async function attachReferenceFlow(): Promise<void> {
    let picked: ReferenceFilePick | null = null;
    try {
      picked = await opts.pickReferenceFile();
    } catch (e) {
      pushLines([`*ERROR* reference file dialog: ${(e as Error).message}`]);
      return;
    }
    if (picked === null || picked.status === "canceled") return;
    if (picked.status === "error") {
      pushLines([`*ERROR* reference file: ${picked.message}`]);
      return;
    }
    const res = await command("xref.attach", {
      name: picked.fileName,
      path: picked.filePath,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      layer: state.activeLayer,
      content: picked.content,
    });
    if (!res.ok) {
      pushLines([`*ERROR* xref.attach: ${res.code} — ${res.message}`]);
    } else {
      const value = res.value as { resolved?: number; skipped?: number } | null;
      pushLines([
        `XREF: '${picked.fileName}' attached loaded from '${picked.filePath}' — ` +
          `${value?.resolved ?? 0} entit${(value?.resolved ?? 0) === 1 ? "y" : "ies"} resolved` +
          `${(value?.skipped ?? 0) > 0 ? `, ${value?.skipped} skipped (non-convertible)` : ""}; instance placed at (0, 0).`,
      ]);
    }
    await refresh();
  }

  /** The References-palette Reload flow: the same dialog re-reads the file →
   *  xref.reload with the fresh content (the status/provenance update). */
  async function reloadReferenceFlow(name: string): Promise<void> {
    let picked: ReferenceFilePick | null = null;
    try {
      picked = await opts.pickReferenceFile();
    } catch (e) {
      pushLines([`*ERROR* reference file dialog: ${(e as Error).message}`]);
      return;
    }
    if (picked === null || picked.status === "canceled") return;
    if (picked.status === "error") {
      pushLines([`*ERROR* reference file: ${picked.message}`]);
      return;
    }
    const res = await command("xref.reload", { name, content: picked.content });
    if (!res.ok) {
      pushLines([`*ERROR* xref.reload: ${res.code} — ${res.message}`]);
    } else {
      const value = res.value as { resolved?: number; skipped?: number } | null;
      pushLines([
        `XRELOAD: '${name}' re-resolved from '${picked.filePath}' — ` +
          `${value?.resolved ?? 0} entit${(value?.resolved ?? 0) === 1 ? "y" : "ies"} resolved` +
          `${(value?.skipped ?? 0) > 0 ? `, ${value?.skipped} skipped (non-convertible)` : ""}.`,
      ]);
    }
    await refresh();
  }

  /** CAD-PARITY-007 (Issue #86): the Constraints manager (mirrors the Web
   *  ConstraintsPanel) — the live solver diagnostics (the six typed
   *  outcomes + the per-component DoF accounting), dimensional value
   *  editing through constraint.update and removal through
   *  constraint.remove; the explicit Solve runs constraint.solve. The
   *  diagnostics compute through the SAME shared solver the Web panel and
   *  the App API run (LOCK-004 parity by construction). */
  function renderConstraintsPanel(container: HTMLElement): void {
    const snapshot = state.snapshot;
    const constraints = snapshot?.constraints ?? [];
    const elements = snapshot?.elements ?? [];

    const scroll = h("div", "pro-dock-scroll");
    scroll.style.flex = "1";
    const sec = (title: string): void => {
      const s = h("div", "sec");
      s.textContent = title;
      scroll.append(s);
    };
    const desc = (text: string): void => {
      const d = h("div", "desc");
      d.textContent = text;
      scroll.append(d);
    };

    // The header bar: the explicit Solve + the typed outcome badge.
    const bar = h("div", "bar");
    const solveBtn = h("button");
    solveBtn.type = "button";
    solveBtn.className = "mini";
    solveBtn.style.width = "auto";
    solveBtn.style.fontSize = "10px";
    solveBtn.textContent = "Solve";
    solveBtn.title = "Re-run the deterministic solve over the whole declared graph (CONSTRAINTSOLVE)";
    solveBtn.setAttribute("aria-label", "solve the constraint graph");
    solveBtn.addEventListener("click", () => {
      void (async () => {
        const res = await command("constraint.solve", {});
        if (!res.ok) pushLines([`*ERROR* constraint.solve: ${res.code} — ${res.message}`]);
        else pushLines([`CONSTRAINTS: ${(res.value as { summary?: string }).summary ?? "solved"}.`]);
        await refresh();
      })();
    });
    bar.append(solveBtn);
    const outcomeBadge = h("span");
    outcomeBadge.style.cssText = "font-size:10px;padding:1px 6px;border-radius:4px;border:1px solid;";
    let statusById: Map<string, { id: string; satisfied: boolean; note: string | null }> | null = null;
    if (constraints.length === 0) {
      outcomeBadge.textContent = "no constraints";
      outcomeBadge.style.color = "#57534e";
    } else {
      const diagnostics = diagnoseConstraints(elements, constraints);
      outcomeBadge.textContent = diagnostics.outcome;
      outcomeBadge.setAttribute("data-testid", "pro-constraints-outcome");
      const dof = diagnostics.dof.reduce((sum, c) => sum + c.dof, 0);
      outcomeBadge.title = `per-component DoF accounting (total ${dof})`;
      const color =
        diagnostics.outcome === "solved" ? "#047857" :
        diagnostics.outcome === "under-constrained" ? "#b45309" :
        diagnostics.outcome === "over-constrained" ? "#b91c1c" :
        diagnostics.outcome === "unsupported" ? "#3f3f46" : "#c2410c";
      outcomeBadge.style.color = color;
      outcomeBadge.style.borderColor = color;
      // The DoF section.
      sec(`Degrees of freedom (total ${dof})`);
      for (const comp of diagnostics.dof) {
        const row = h("div", "desc");
        row.textContent =
          `${comp.entities.length} ${comp.entities.length === 1 ? "entity" : "entities"} · ` +
          `${comp.constraints.length} ${comp.constraints.length === 1 ? "constraint" : "constraints"} · DoF ${comp.dof}`;
        row.title = comp.entities.join(", ");
        scroll.append(row);
      }
      statusById = new Map(diagnostics.statuses.map((s) => [s.id, s] as const));
    }
    bar.append(outcomeBadge);
    scroll.append(bar);

    sec("Declared constraints");
    desc(
      constraints.length === 0
        ? "No constraints declared. GEOMCONSTRAINT (GC) / DIMCONSTRAINT (DC) add them; the canvas shows one badge per constraint."
        : "The declared graph — satisfaction computed live through the shared solver. Edit a dimensional value to re-solve; the geometry follows in one revision.",
    );
    for (const c of constraints) {
      const row = h("div", "pro-block-row");
      const status = statusById?.get(c.id);
      const satisfied = status?.satisfied ?? false;
      const dot = h("span");
      dot.style.cssText =
        `width:8px;height:8px;border-radius:9999px;flex-shrink:0;background:${satisfied ? "#10b981" : "#ef4444"};`;
      dot.title = satisfied ? "satisfied" : `not satisfied — ${status?.note ?? "unknown"}`;
      dot.setAttribute("aria-label", satisfied ? "satisfied" : "violated");
      const nm = h("span", "nm");
      nm.textContent = CONSTRAINT_LABEL[c.kind] ?? c.kind;
      const meta = h("span", "grow muted");
      meta.textContent =
        c.targets.map((t) => (t.anchor !== undefined ? `${t.id}:${t.anchor}` : t.id)).join(" → ") +
        (c.mode !== undefined ? ` · ${c.mode}` : "");
      meta.title = c.id;
      row.append(dot, nm, meta);
      if (!satisfied && status?.note != null) {
        row.title = status.note;
      }
      // Dimensional value editing (constraint.update re-solves).
      if (c.value !== undefined) {
        const valueInput = document.createElement("input");
        valueInput.type = "number";
        valueInput.step = "any";
        valueInput.min = "0";
        valueInput.value = String(c.value);
        valueInput.style.cssText = "width:64px;font-size:10px;text-align:right;";
        valueInput.setAttribute("aria-label", `value of constraint ${c.id}`);
        valueInput.title = "Re-declare the value and re-solve (constraint.update)";
        valueInput.addEventListener("change", () => {
          const n = Number(valueInput.value);
          if (!Number.isFinite(n) || n <= 0 || n === c.value) return;
          void (async () => {
            const res = await command("constraint.update", { id: c.id, patch: { value: n } });
            if (!res.ok) pushLines([`*ERROR* constraint.update: ${res.code} — ${res.message}`]);
            await refresh();
          })();
        });
        row.append(valueInput);
      }
      const removeBtn = h("button");
      removeBtn.type = "button";
      removeBtn.className = "mini";
      removeBtn.style.width = "auto";
      removeBtn.style.fontSize = "10px";
      removeBtn.textContent = "×";
      removeBtn.title = "Remove the constraint (the geometry stays at its solved state)";
      removeBtn.setAttribute("aria-label", `remove constraint ${c.id}`);
      removeBtn.addEventListener("click", () => {
        void (async () => {
          const res = await command("constraint.remove", { id: c.id });
          if (!res.ok) pushLines([`*ERROR* constraint.remove: ${res.code} — ${res.message}`]);
          await refresh();
        })();
      });
      row.append(removeBtn);
      scroll.append(row);
    }
    container.append(scroll);
  }

  // --- CAD-PARITY-008 (Issue #88): the Layouts manager + the plot preview ----

  /** The active layout record (activeLayout ?? the first table entry — the
   *  layouts.list semantics). */
  function activeLayoutRecord(): LayoutRecord | null {
    const layouts = state.snapshot?.layouts ?? [];
    const activeId = state.snapshot?.draftingSettings?.activeLayout ?? layouts[0]?.id ?? null;
    return layouts.find((l) => l.id === activeId) ?? null;
  }

  /** The Layouts manager (mirrors the Web LayoutsPanel): the layout table
   *  (activate/rename/clone/delete), the page setup of the active layout and
   *  the viewport inventory (scale/rotation/lock + the per-viewport layer
   *  visibility — the VPLAYER surface). Every write is ONE App API command
   *  (commitCommand) — the SAME commands the Web panel sends. */
  function renderLayoutsPanel(container: HTMLElement): void {
    const layouts = state.snapshot?.layouts ?? [];
    const viewports = state.snapshot?.viewports ?? [];
    const layers = state.snapshot?.layers ?? [];
    const active = activeLayoutRecord();
    const layoutViewports: ViewportRecord[] = viewports.filter((v) => v.layoutId === active?.id);

    const head = h("div", "pro-panel-head");
    const newBtn = h("button", "pro-btn");
    newBtn.type = "button";
    newBtn.textContent = "New";
    newBtn.title = "Create a paper-space layout (LAYOUTNEW)";
    newBtn.setAttribute("data-testid", "pro-layouts-new");
    newBtn.addEventListener("click", () => void startCommand("layoutnew"));
    const vpBtn = h("button", "pro-btn");
    vpBtn.type = "button";
    vpBtn.textContent = "Viewports";
    vpBtn.title = "The bounded viewport manager (VPORTS)";
    vpBtn.addEventListener("click", () => void startCommand("vports"));
    const previewBtn = h("button", "pro-btn");
    previewBtn.type = "button";
    previewBtn.textContent = "Preview";
    previewBtn.title = "The deterministic plot preview of the active layout (PREVIEW)";
    previewBtn.setAttribute("data-testid", "pro-layouts-preview");
    previewBtn.addEventListener("click", () => openPlotPreview());
    const publishBtn = h("button", "pro-btn");
    publishBtn.type = "button";
    publishBtn.textContent = "Publish";
    publishBtn.title = "Publish every layout as one multi-page PDF (PUBLISH)";
    publishBtn.addEventListener("click", () => void startCommand("publish"));
    head.append(newBtn, vpBtn, previewBtn, publishBtn);
    container.append(head);

    // --- The layout table.
    const list = h("div", "pro-panel-list");
    list.setAttribute("data-testid", "pro-layouts-list");
    if (layouts.length === 0) {
      const empty = h("p", "pro-muted");
      empty.textContent = "No layouts yet — LAYOUTNEW creates one (A3 landscape, 10 mm margins, fit, as-displayed plot style).";
      list.append(empty);
    }
    for (const layout of layouts) {
      const vps = viewports.filter((v) => v.layoutId === layout.id);
      const isActive = layout.id === active?.id;
      const row = h("div", "pro-row" + (isActive ? " pro-active" : ""));
      row.setAttribute("data-testid", `pro-layout-row-${layout.id}`);
      const nameBtn = h("button", "pro-link");
      nameBtn.type = "button";
      nameBtn.textContent = (isActive ? "▸ " : "") + layout.name;
      nameBtn.title = "Activate this layout (paper space)";
      nameBtn.addEventListener("click", () => {
        void (async () => {
          const res = await command("layout.activate", { name: layout.name });
          if (!res.ok) pushLines([`*ERROR* layout.activate: ${res.code} — ${res.message}`]);
          space = "paper";
          renderLayoutTabs();
          await refresh();
        })();
      });
      const meta = h("span", "pro-muted");
      meta.textContent = `${layout.pageSetup.paperSize} · ${vps.length}vp`;
      const renameBtn = h("button", "pro-icon-btn");
      renameBtn.type = "button";
      renameBtn.textContent = "✎";
      renameBtn.title = "Rename layout (LAYOUTRENAME)";
      renameBtn.addEventListener("click", () => {
        const newName = window.prompt("New layout name", layout.name);
        if (newName !== null && newName.trim().length > 0) commitCommand("layout.rename", { name: layout.name, newName: newName.trim() });
      });
      const cloneBtn = h("button", "pro-icon-btn");
      cloneBtn.type = "button";
      cloneBtn.textContent = "⧉";
      cloneBtn.title = "Clone layout with its viewports (LAYOUTCLONE)";
      cloneBtn.addEventListener("click", () => commitCommand("layout.clone", { name: layout.name, newName: `${layout.name}-Copy` }));
      const delBtn = h("button", "pro-icon-btn danger");
      delBtn.type = "button";
      delBtn.textContent = "✕";
      delBtn.title = "Delete layout and its viewports (LAYOUTDELETE)";
      delBtn.addEventListener("click", () => commitCommand("layout.remove", { name: layout.name }));
      row.append(nameBtn, meta, renameBtn, cloneBtn, delBtn);
      list.append(row);
    }
    container.append(list);

    // --- The page setup of the active layout.
    if (active !== null) {
      const setup = active.pageSetup;
      const section = h("div", "pro-panel-section");
      section.setAttribute("data-testid", "pro-pagesetup");
      const title = h("p", "pro-section-title");
      title.textContent = `Page setup — ${active.name}`;
      section.append(title);

      const paperRow = h("div", "pro-row");
      const paperLabel = h("span", "pro-muted");
      paperLabel.textContent = "Paper";
      const paperSel = document.createElement("select");
      paperSel.setAttribute("aria-label", "paper size");
      for (const size of ["A4", "A3", "A2", "A1", "A0"] as const) {
        const opt = document.createElement("option");
        opt.value = size;
        opt.textContent = size;
        if (setup.paperSize === size) opt.selected = true;
        paperSel.append(opt);
      }
      if (setup.paperSize === "CUSTOM") {
        const opt = document.createElement("option");
        opt.value = "CUSTOM";
        opt.textContent = "CUSTOM";
        opt.selected = true;
        paperSel.append(opt);
      }
      paperSel.addEventListener("change", () => {
        const size = paperSel.value as "A4" | "A3" | "A2" | "A1" | "A0";
        const dims: Record<string, { w: number; h: number }> = {
          A4: { w: 210, h: 297 }, A3: { w: 297, h: 420 }, A2: { w: 420, h: 594 },
          A1: { w: 594, h: 841 }, A0: { w: 841, h: 1189 },
        };
        const d = dims[size]!;
        commitCommand("layout.setPageSetup", { name: active.name, patch: { paperSize: size, widthMm: d.w, heightMm: d.h } });
      });
      paperRow.append(paperLabel, paperSel);
      section.append(paperRow);

      const orientRow = h("div", "pro-row");
      const orientLabel = h("span", "pro-muted");
      orientLabel.textContent = "Orientation";
      const orientSel = document.createElement("select");
      orientSel.setAttribute("aria-label", "orientation");
      for (const o of ["portrait", "landscape"] as const) {
        const opt = document.createElement("option");
        opt.value = o;
        opt.textContent = o === "portrait" ? "Portrait" : "Landscape";
        if (setup.orientation === o) opt.selected = true;
        orientSel.append(opt);
      }
      orientSel.addEventListener("change", () => {
        commitCommand("layout.setPageSetup", { name: active.name, patch: { orientation: orientSel.value } });
      });
      orientRow.append(orientLabel, orientSel);
      section.append(orientRow);

      const scaleRow = h("div", "pro-row");
      const scaleLabel = h("span", "pro-muted");
      scaleLabel.textContent = "Plot scale";
      const scaleInput = document.createElement("input");
      scaleInput.type = "text";
      scaleInput.value = setup.plotScale;
      scaleInput.setAttribute("aria-label", "plot scale (fit or N:M)");
      scaleInput.style.width = "72px";
      scaleInput.addEventListener("change", () => {
        commitCommand("layout.setPageSetup", { name: active.name, patch: { plotScale: scaleInput.value.trim() } });
      });
      scaleRow.append(scaleLabel, scaleInput);
      section.append(scaleRow);

      const styleNote = h("p", "pro-muted");
      styleNote.textContent =
        setup.plotStyleKind === "none"
          ? `Plot style: none (as displayed) · borders ${setup.plotViewports !== false ? "plotted" : "off"}`
          : `Plot style: ${setup.plotStyleTable} (${setup.plotStyleKind.toUpperCase()}) — application is a typed decline`;
      section.append(styleNote);
      container.append(section);
    }

    // --- The viewport inventory of the active layout.
    const vpSection = h("div", "pro-panel-section");
    vpSection.setAttribute("data-testid", "pro-viewports");
    const vpTitle = h("p", "pro-section-title");
    vpTitle.textContent = `Viewports — ${active?.name ?? "…"} (${layoutViewports.length})`;
    vpSection.append(vpTitle);
    if (layoutViewports.length === 0) {
      const empty = h("p", "pro-muted");
      empty.textContent = "None yet — MVIEW places one (two paper corners + Fit/Scale/Window).";
      vpSection.append(empty);
    }
    for (const vp of layoutViewports) {
      const locked = vp.locked === true;
      const row = h("div", "pro-row pro-vp-row");
      row.setAttribute("data-testid", `pro-viewport-row-${vp.id}`);
      const idLabel = h("span", "pro-strong");
      idLabel.textContent = vp.id;
      const scaleLabel = h("label", "pro-inline");
      scaleLabel.textContent = "1:";
      const scaleInput = document.createElement("input");
      scaleInput.type = "number";
      scaleInput.value = String(vp.scaleDenominator);
      scaleInput.disabled = locked;
      scaleInput.style.width = "64px";
      scaleInput.setAttribute("aria-label", `viewport ${vp.id} scale denominator`);
      scaleInput.addEventListener("change", () => {
        const d = Number(scaleInput.value);
        if (Number.isFinite(d) && d > 0) commitCommand("viewport.update", { id: vp.id, patch: { scaleDenominator: d } });
      });
      scaleLabel.append(scaleInput);
      const rotLabel = h("label", "pro-inline");
      rotLabel.textContent = "rot°";
      const rotInput = document.createElement("input");
      rotInput.type = "number";
      rotInput.value = String(vp.rotationDeg);
      rotInput.disabled = locked;
      rotInput.style.width = "56px";
      rotInput.setAttribute("aria-label", `viewport ${vp.id} rotation degrees`);
      rotInput.addEventListener("change", () => {
        const r = Number(rotInput.value);
        if (Number.isFinite(r)) commitCommand("viewport.update", { id: vp.id, patch: { rotationDeg: r } });
      });
      rotLabel.append(rotInput);
      const lockLabel = h("label", "pro-inline");
      lockLabel.title = "Display lock: the view (camera/scale/rotation) freezes; the frame still moves";
      const lockInput = document.createElement("input");
      lockInput.type = "checkbox";
      lockInput.checked = locked;
      lockInput.setAttribute("aria-label", `viewport ${vp.id} display lock`);
      lockInput.addEventListener("change", () => {
        commitCommand("viewport.update", { id: vp.id, patch: { locked: lockInput.checked } });
      });
      lockLabel.append(lockInput, document.createTextNode(" lock"));
      const layerBtn = h("button", "pro-btn");
      layerBtn.type = "button";
      layerBtn.textContent = "layers";
      layerBtn.title = "Per-viewport layer visibility (VPLAYER)";
      layerBtn.addEventListener("click", () => {
        const next = promptViewportLayerOverrides(vp, layers);
        if (next !== null) commitCommand("viewport.update", { id: vp.id, patch: { layerOverrides: next } });
      });
      const delBtn = h("button", "pro-icon-btn danger");
      delBtn.type = "button";
      delBtn.textContent = "✕";
      delBtn.title = "Delete viewport";
      delBtn.addEventListener("click", () => commitCommand("viewport.remove", { id: vp.id }));
      row.append(idLabel, scaleLabel, rotLabel, lockLabel, layerBtn, delBtn);
      vpSection.append(row);
    }
    container.append(vpSection);
  }

  /** The bounded VPLAYER prompt: one line per layer — "y/n/<Enter>=inherit".
   *  Builds the canonical-minimal override array (entries only where the
   *  override DIFFERS from the layer table). */
  function promptViewportLayerOverrides(vp: ViewportRecord, layers: readonly LayerRecord[]): { layerId: string; visible: boolean }[] | null {
    const overrides: { layerId: string; visible: boolean }[] = [];
    for (const layer of layers) {
      const current = (vp.layerOverrides ?? []).find((o: { layerId: string; visible?: boolean }) => o.layerId === layer.id)?.visible ?? layer.visible;
      const answer = window.prompt(`Layer '${layer.name}' visible in viewport ${vp.id}? (y/n, empty = inherit)`, current ? "y" : "n");
      if (answer === null) return null;
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "y") overrides.push({ layerId: layer.id, visible: true });
      else if (trimmed === "n") overrides.push({ layerId: layer.id, visible: false });
    }
    // Canonical-minimal: keep only entries that DIFFER from the table.
    return overrides.filter((o) => o.visible !== (layers.find((l) => l.id === o.layerId)?.visible ?? o.visible));
  }

  /** The deterministic plot preview overlay (mirrors the Web PlotPreview):
   *  plot.preview IR + hash painted through the SHARED paper painter, with
   *  the page-setup summary and the SVG/PDF export buttons (the main-process
   *  save dialog when the bridge exists). */
  function openPlotPreview(): void {
    const existing = document.querySelector("[data-testid='pro-plot-preview']");
    if (existing !== null) existing.remove();
    const active = activeLayoutRecord();
    const overlay = h("div", "pro-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Plot preview");
    overlay.setAttribute("data-testid", "pro-plot-preview");
    overlay.addEventListener("click", () => overlay.remove());
    const card = h("div", "pro-overlay-card");
    card.addEventListener("click", (e) => e.stopPropagation());
    const head = h("header");
    const title = h("h2");
    title.textContent = `Plot preview — ${active?.name ?? "no layout"}`;
    const closeBtn = h("button", "pro-icon-btn");
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "close plot preview");
    closeBtn.addEventListener("click", () => overlay.remove());
    head.append(title, closeBtn);
    card.append(head);
    const canvas = document.createElement("canvas");
    canvas.width = 880;
    canvas.height = 560;
    canvas.setAttribute("data-testid", "pro-plot-preview-canvas");
    canvas.setAttribute("aria-label", "plot preview canvas");
    canvas.style.cssText = "width:100%;height:auto;background:#e2e8f0;border-radius:4px;";
    card.append(canvas);
    const info = h("p", "pro-muted");
    info.setAttribute("data-testid", "pro-plot-preview-info");
    info.textContent = "Building the plot IR…";
    card.append(info);
    const actions = h("div", "pro-row");
    const exportSvg = h("button", "pro-btn");
    exportSvg.type = "button";
    exportSvg.textContent = "Export SVG";
    exportSvg.setAttribute("data-testid", "pro-plot-preview-export-svg");
    const exportPdf = h("button", "pro-btn");
    exportPdf.type = "button";
    exportPdf.textContent = "Export PDF";
    actions.append(exportSvg, exportPdf);
    card.append(actions);
    overlay.append(card);
    document.body.append(overlay);
    if (active === null) {
      info.textContent = "No layouts exist yet — LAYOUTNEW creates one.";
      return;
    }
    void (async () => {
      const res = await query("plot.preview", { name: active.name });
      if (!res.ok) {
        info.textContent = `*ERROR* plot.preview: ${res.code} — ${res.message}`;
        return;
      }
      const value = res.value as { ir: PlotIR; hash: string; layoutName: string };
      info.textContent = `IR sha256 ${value.hash.slice(0, 16)}… · ${value.ir.primitiveCount} primitives · ${active.pageSetup.paperSize} ${active.pageSetup.orientation} · plot scale ${active.pageSetup.plotScale}`;
      const ctx = canvas.getContext("2d");
      if (ctx !== null) {
        ctx.fillStyle = "#e2e8f0";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const margin = 20;
        const zoom = Math.min((canvas.width - margin * 2) / value.ir.sheet.widthMm, (canvas.height - margin * 2) / value.ir.sheet.heightMm);
        const ox = (canvas.width - value.ir.sheet.widthMm * zoom) / 2;
        const oy = (canvas.height + value.ir.sheet.heightMm * zoom) / 2;
        const toScreen = (pt: PaperPt): [number, number] => [ox + pt.x * zoom, oy - pt.y * zoom];
        paintSheetBackdrop(ctx, value.ir, { toScreen, pxPerMm: zoom });
        paintPlotIR(ctx, value.ir, { toScreen, pxPerMm: zoom, selectedViewportId });
      }
      const doExport = (format: "svg" | "pdf"): void => {
        void (async () => {
          const res2 = await command("plot.export", { name: active.name, format });
          if (!res2.ok) {
            pushLines([`*ERROR* plot.export: ${res2.code} — ${res2.message}`]);
            return;
          }
          const out = res2.value as { text?: string; bytesBase64?: string; sha256: string; layoutName: string };
          if (opts.pickSaveFile !== undefined) {
            const ext = format === "pdf" ? "pdf" : "svg";
            const payload: { text?: string; bytesBase64?: string } =
              out.bytesBase64 !== undefined ? { bytesBase64: out.bytesBase64 } : { text: out.text ?? "" };
            const saved = await opts.pickSaveFile(`offisos-${out.layoutName.replace(/\s+/g, "-").toLowerCase()}.${ext}`, payload);
            if (saved.status === "saved") pushLines([`PLOT: ${out.layoutName} exported as ${format.toUpperCase()} — saved (${saved.size} bytes, sha256 ${out.sha256.slice(0, 12)}…).`]);
            else if (saved.status === "error") pushLines([`*ERROR* plot save: ${saved.message}`]);
          } else {
            pushLines([`PLOT: ${out.layoutName} ${format.toUpperCase()} artifact ready (sha256 ${out.sha256.slice(0, 12)}…).`]);
          }
        })();
      };
      exportSvg.addEventListener("click", () => doExport("svg"));
      exportPdf.addEventListener("click", () => doExport("pdf"));
    })();
  }

  /** The Styles manager (mirrors the Web StylesPanel): current styles +
   *  standards, the linetype catalog + user linetypes, text styles and
   *  dimension styles. */
  function renderStylesPanel(container: HTMLElement): void {
    const snapshot = state.snapshot;
    const settings = snapshot?.draftingSettings;
    const ltypes = snapshot?.ltypes ?? [];
    const textStyles = snapshot?.textStyles ?? [];
    const dimStyles = snapshot?.dimStyles ?? [];
    const scroll = h("div", "pro-dock-scroll");
    scroll.style.flex = "1";
    const setSettings = (patch: Record<string, unknown>): void => {
      commitCommand("drafting.setSettings", { settings: patch });
    };
    const sec = (title: string): void => {
      const s = h("div", "sec");
      s.textContent = title;
      scroll.append(s);
    };
    const desc = (text: string): void => {
      const d = h("div", "desc");
      d.textContent = text;
      scroll.append(d);
    };

    // --- Current styles + standards ---
    sec("Current");
    const styleRow = (label: string, build: (row: HTMLDivElement) => void): void => {
      const r = h("div", "pro-style-row");
      const k = h("span", "muted");
      k.textContent = label;
      r.append(k);
      build(r);
      scroll.append(r);
    };
    styleRow("text style", (r) => {
      const sel = h("select");
      sel.title = "Current text style";
      sel.setAttribute("aria-label", "current text style");
      sel.style.width = "120px";
      const std = h("option");
      std.value = "Standard";
      std.textContent = "Standard (built-in)";
      sel.append(std);
      for (const s of textStyles as readonly TextStyleRecord[]) {
        const o = h("option");
        o.value = s.name;
        o.textContent = s.name;
        sel.append(o);
      }
      sel.value = settings?.textStyle ?? "Standard";
      sel.addEventListener("change", () => setSettings({ textStyle: sel.value }));
      r.append(sel);
    });
    styleRow("dim style", (r) => {
      const sel = h("select");
      sel.title = "Current dimension style";
      sel.setAttribute("aria-label", "current dim style");
      sel.style.width = "120px";
      const std = h("option");
      std.value = "Standard";
      std.textContent = "Standard (built-in)";
      sel.append(std);
      for (const s of dimStyles as readonly DimStyleRecord[]) {
        const o = h("option");
        o.value = s.name;
        o.textContent = s.name;
        sel.append(o);
      }
      sel.value = settings?.dimStyle ?? "Standard";
      sel.addEventListener("change", () => setSettings({ dimStyle: sel.value }));
      r.append(sel);
    });
    styleRow("linetype scale", (r) => {
      const input = h("input", "num");
      input.type = "number";
      input.step = "any";
      input.title = "Global linetype scale (LTSCALE)";
      input.setAttribute("aria-label", "linetype scale");
      input.value = String(settings?.standards?.linetypeScale ?? 1);
      input.addEventListener("change", () => {
        const v = Number(input.value);
        if (Number.isFinite(v) && v > 0) setSettings({ standards: { linetypeScale: v } });
      });
      r.append(input);
    });
    // CAD-PARITY-005: the document annotation scale (DIMSCALE-class —
    // multiplies every dimension annotation's text height and arrow size:
    // field × style.scale × this). Positive values only; invalid entries
    // never write (the mirror of the Web StylesPanel row).
    styleRow("annotation scale", (r) => {
      const input = h("input", "num");
      input.type = "number";
      input.step = "any";
      input.title = "Document annotation scale (DIMSCALE-class — multiplies every dimension annotation's text height and arrow size)";
      input.setAttribute("aria-label", "annotation scale");
      input.value = String(settings?.standards?.annotationScale ?? 1);
      input.addEventListener("change", () => {
        const v = Number(input.value);
        if (Number.isFinite(v) && v > 0) setSettings({ standards: { annotationScale: v } });
      });
      r.append(input);
    });
    styleRow("default lineweight", (r) => {
      const sel = h("select");
      sel.title = "Default lineweight (mm)";
      sel.setAttribute("aria-label", "default lineweight");
      sel.style.width = "70px";
      for (const w of STANDARD_LINEWEIGHTS) {
        const o = h("option");
        o.value = String(w);
        o.textContent = w.toFixed(2);
        sel.append(o);
      }
      sel.value = String(settings?.standards?.defaultLineweight ?? STANDARD_DEFAULT_LINEWEIGHT);
      sel.addEventListener("change", () => setSettings({ standards: { defaultLineweight: Number(sel.value) } }));
      r.append(sel);
    });

    // --- Linetypes ---
    sec("Linetypes");
    const ltypeBar = h("div", "pro-style-row");
    const ltypeName = h("input");
    ltypeName.type = "text";
    ltypeName.placeholder = "Name…";
    ltypeName.setAttribute("aria-label", "new linetype name");
    ltypeName.value = newLtypeName;
    const ltypePattern = h("input", "num");
    ltypePattern.type = "text";
    ltypePattern.placeholder = "8,4";
    ltypePattern.title = "Dash/gap lengths in mm, comma separated (even count)";
    ltypePattern.setAttribute("aria-label", "new linetype pattern");
    ltypePattern.style.width = "56px";
    ltypePattern.style.fontFamily = "ui-monospace, monospace";
    ltypePattern.value = newLtypePattern;
    const addLtype = (): void => {
      const name = newLtypeName.trim();
      if (name.length === 0) return;
      const pattern = newLtypePattern
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      newLtypeName = "";
      commitCommand("ltype.create", { name, description: "user-defined", pattern });
    };
    ltypeName.addEventListener("input", () => {
      newLtypeName = ltypeName.value;
      ltypeAdd.disabled = newLtypeName.trim().length === 0;
    });
    ltypeName.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        addLtype();
      }
    });
    ltypePattern.addEventListener("input", () => {
      newLtypePattern = ltypePattern.value;
    });
    const ltypeAdd = h("button", "iconbtn");
    ltypeAdd.type = "button";
    ltypeAdd.title = "Create linetype";
    ltypeAdd.setAttribute("aria-label", "create linetype");
    ltypeAdd.disabled = newLtypeName.trim().length === 0;
    ltypeAdd.append(ICON.plus());
    ltypeAdd.addEventListener("click", addLtype);
    ltypeBar.append(ltypeName, ltypePattern, ltypeAdd);
    scroll.append(ltypeBar);
    for (const lt of BUILT_IN_LTYPES) {
      const r = h("div", "pro-style-row");
      const nm = h("span", "nm");
      nm.textContent = lt.name;
      nm.title = lt.description;
      const d = h("span", "grow muted");
      d.textContent = lt.description;
      const sample = h("span", "ltsample");
      sample.append(dashSample(lt.pattern));
      const tag = h("span", "built-in");
      tag.textContent = "built-in";
      r.append(nm, d, sample, tag);
      scroll.append(r);
    }
    for (const lt of ltypes as readonly LtypeRecord[]) {
      const r = h("div", "pro-style-row");
      const nm = h("span", "nm");
      nm.textContent = lt.name;
      nm.title = lt.name;
      const sample = h("span", "ltsample");
      sample.append(dashSample(lt.pattern));
      const del = h("button", "tgl");
      del.type = "button";
      del.title = "Delete linetype (blocked while referenced)";
      del.setAttribute("aria-label", `delete linetype ${lt.name}`);
      del.append(ICON.trash());
      del.addEventListener("click", () => commitCommand("ltype.remove", { name: lt.name }));
      r.append(nm, sample, del);
      scroll.append(r);
    }

    // --- Text styles ---
    sec("Text styles");
    desc(
      `Standard — ${STANDARD_TEXT_STYLE.font}, height ${STANDARD_TEXT_STYLE.height || "auto"}, width ${STANDARD_TEXT_STYLE.widthFactor} (built-in)`,
    );
    const tsBar = h("div", "pro-style-row");
    const tsName = h("input");
    tsName.type = "text";
    tsName.placeholder = "New text style name…";
    tsName.setAttribute("aria-label", "new text style name");
    tsName.value = newTextStyleName;
    tsName.addEventListener("input", () => {
      newTextStyleName = tsName.value;
      tsAdd.disabled = newTextStyleName.trim().length === 0;
    });
    tsName.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        if (newTextStyleName.trim().length > 0) {
          const name = newTextStyleName.trim();
          newTextStyleName = "";
          commitCommand("textStyle.create", { name });
        }
      }
    });
    const tsAdd = h("button", "iconbtn");
    tsAdd.type = "button";
    tsAdd.title = "Create text style";
    tsAdd.setAttribute("aria-label", "create text style");
    tsAdd.disabled = newTextStyleName.trim().length === 0;
    tsAdd.append(ICON.plus());
    tsAdd.addEventListener("click", () => {
      const name = newTextStyleName.trim();
      if (name.length === 0) return;
      newTextStyleName = "";
      commitCommand("textStyle.create", { name });
    });
    tsBar.append(tsName, tsAdd);
    scroll.append(tsBar);
    for (const s of textStyles as readonly TextStyleRecord[]) {
      const r = h("div", "pro-style-row");
      const nm = h("span", "nm");
      nm.textContent = s.name;
      nm.title = s.name;
      const font = h("select");
      font.title = "Font family";
      font.setAttribute("aria-label", `${s.name} font`);
      for (const f of ["sans", "mono", "serif"] as const) {
        const o = h("option");
        o.value = f;
        o.textContent = f;
        font.append(o);
      }
      font.value = s.font;
      font.addEventListener("change", () => commitCommand("textStyle.update", { name: s.name, patch: { font: font.value } }));
      const height = h("input", "num");
      height.type = "number";
      height.step = "any";
      height.title = "Fixed height (0 = not fixed)";
      height.setAttribute("aria-label", `${s.name} height`);
      height.value = String(s.height);
      height.addEventListener("change", () => {
        const v = Number(height.value);
        if (Number.isFinite(v) && v >= 0 && v !== s.height) {
          commitCommand("textStyle.update", { name: s.name, patch: { height: v } });
        }
      });
      const width = h("input", "num");
      width.type = "number";
      width.step = "0.05";
      width.title = "Width factor";
      width.setAttribute("aria-label", `${s.name} width factor`);
      width.value = String(s.widthFactor);
      width.addEventListener("change", () => {
        const v = Number(width.value);
        if (Number.isFinite(v) && v > 0 && v !== s.widthFactor) {
          commitCommand("textStyle.update", { name: s.name, patch: { widthFactor: v } });
        }
      });
      const oblique = h("input", "num");
      oblique.type = "number";
      oblique.step = "any";
      oblique.title = "Oblique angle (°)";
      oblique.setAttribute("aria-label", `${s.name} oblique angle`);
      oblique.value = String(s.obliqueAngle);
      oblique.addEventListener("change", () => {
        const v = Number(oblique.value);
        if (Number.isFinite(v) && v !== s.obliqueAngle) {
          commitCommand("textStyle.update", { name: s.name, patch: { obliqueAngle: v } });
        }
      });
      const del = h("button", "tgl");
      del.type = "button";
      del.title = "Delete text style (blocked while referenced)";
      del.setAttribute("aria-label", `delete text style ${s.name}`);
      del.append(ICON.trash());
      del.addEventListener("click", () => commitCommand("textStyle.remove", { name: s.name }));
      r.append(nm, font, height, width, oblique, del);
      scroll.append(r);
    }

    // --- Dimension styles ---
    sec("Dimension styles");
    desc(
      `Standard — text ${STANDARD_DIM_STYLE.textHeight}, arrows ${STANDARD_DIM_STYLE.arrowSize}, scale ${STANDARD_DIM_STYLE.scale}, precision ${STANDARD_DIM_STYLE.precision} (built-in)`,
    );
    const dsBar = h("div", "pro-style-row");
    const dsName = h("input");
    dsName.type = "text";
    dsName.placeholder = "New dimension style name…";
    dsName.setAttribute("aria-label", "new dim style name");
    dsName.value = newDimStyleName;
    dsName.addEventListener("input", () => {
      newDimStyleName = dsName.value;
      dsAdd.disabled = newDimStyleName.trim().length === 0;
    });
    dsName.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        if (newDimStyleName.trim().length > 0) {
          const name = newDimStyleName.trim();
          newDimStyleName = "";
          commitCommand("dimStyle.create", { name });
        }
      }
    });
    const dsAdd = h("button", "iconbtn");
    dsAdd.type = "button";
    dsAdd.title = "Create dimension style";
    dsAdd.setAttribute("aria-label", "create dim style");
    dsAdd.disabled = newDimStyleName.trim().length === 0;
    dsAdd.append(ICON.plus());
    dsAdd.addEventListener("click", () => {
      const name = newDimStyleName.trim();
      if (name.length === 0) return;
      newDimStyleName = "";
      commitCommand("dimStyle.create", { name });
    });
    dsBar.append(dsName, dsAdd);
    scroll.append(dsBar);
    for (const s of dimStyles as readonly DimStyleRecord[]) {
      const r = h("div", "pro-style-row dimrow");
      const nm = h("span", "nm");
      nm.textContent = s.name;
      nm.title = s.name;
      const numField = (
        key: "textHeight" | "arrowSize" | "scale",
        label: string,
      ): HTMLInputElement => {
        const input = h("input", "num");
        input.type = "number";
        input.step = "0.1";
        input.title = `${label} (${s.name})`;
        input.setAttribute("aria-label", `${s.name} ${label}`);
        input.value = String(s[key]);
        input.addEventListener("change", () => {
          const v = Number(input.value);
          if (Number.isFinite(v) && v > 0 && v !== s[key]) {
            commitCommand("dimStyle.update", { name: s.name, patch: { [key]: v } });
          }
        });
        return input;
      };
      const precision = h("select");
      precision.title = "Measurement precision";
      precision.setAttribute("aria-label", `${s.name} precision`);
      precision.style.width = "40px";
      for (let p = 0; p <= 3; p++) {
        const o = h("option");
        o.value = String(p);
        o.textContent = String(p);
        precision.append(o);
      }
      precision.value = String(s.precision);
      precision.addEventListener("change", () =>
        commitCommand("dimStyle.update", { name: s.name, patch: { precision: Number(precision.value) } }),
      );
      // CAD-PARITY-005: the rendered arrowhead kind ("closed" is the default
      // — selecting it sends the null RESET so records stay
      // canonical-minimal) and the measurement unit suffix (empty sends the
      // null RESET) — the mirror of the Web dim-style row editors.
      const arrowStyle = h("select");
      arrowStyle.title = "Arrowhead kind (closed filled / architectural tick / none)";
      arrowStyle.setAttribute("aria-label", `${s.name} arrow style`);
      arrowStyle.style.width = "54px";
      for (const a of ["closed", "tick", "none"] as const) {
        const o = h("option");
        o.value = a;
        o.textContent = a;
        arrowStyle.append(o);
      }
      arrowStyle.value = s.arrowStyle ?? "closed";
      arrowStyle.addEventListener("change", () =>
        commitCommand("dimStyle.update", {
          name: s.name,
          patch: { arrowStyle: arrowStyle.value === "closed" ? null : arrowStyle.value },
        }),
      );
      const unitSuffix = h("input");
      unitSuffix.type = "text";
      unitSuffix.title = 'Unit suffix appended to formatted measurements (e.g. " mm")';
      unitSuffix.setAttribute("aria-label", `${s.name} unit suffix`);
      unitSuffix.style.width = "50px";
      unitSuffix.placeholder = "(none)";
      unitSuffix.value = s.unitSuffix ?? "";
      unitSuffix.addEventListener("change", () => {
        const v = unitSuffix.value;
        if (v !== (s.unitSuffix ?? "")) {
          commitCommand("dimStyle.update", { name: s.name, patch: { unitSuffix: v.length === 0 ? null : v } });
        }
      });
      const del = h("button", "tgl");
      del.type = "button";
      del.title = "Delete dimension style (blocked while referenced)";
      del.setAttribute("aria-label", `delete dim style ${s.name}`);
      del.append(ICON.trash());
      del.addEventListener("click", () => commitCommand("dimStyle.remove", { name: s.name }));
      r.append(nm, numField("textHeight", "text"), numField("arrowSize", "arrow"), numField("scale", "scale"), precision, arrowStyle, unitSuffix, del);
      scroll.append(r);
    }

    container.append(scroll);
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const text = input.value.trim();
      input.value = "";
      void dispatchEngine(text.length === 0 ? { type: "enter" } : { type: "typed", text, cursor: state.cursor });
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.value = "";
      void dispatchEngine({ type: "cancel" });
    }
  });

  // --- command palette --------------------------------------------------------------------------

  const palette = h("div", "pro-palette");
  palette.setAttribute("role", "dialog");
  palette.setAttribute("aria-modal", "true");
  palette.setAttribute("aria-label", "Command search");
  palette.setAttribute("data-testid", "pro-command-palette");
  const paletteBox = h("div", "box");
  const paletteSearch = h("div", "search");
  const paletteInput = h("input");
  paletteInput.setAttribute("type", "text");
  paletteInput.setAttribute("aria-label", "command search input");
  paletteInput.setAttribute("placeholder", "Search commands by name, alias or description…");
  const paletteList = h("ul");
  paletteList.setAttribute("role", "listbox");
  paletteSearch.append(paletteInput);
  paletteBox.append(paletteSearch, paletteList);
  palette.append(paletteBox);
  document.body.append(palette);

  let paletteIndex = 0;
  function renderPalette(): void {
    const hits = searchCommands(paletteInput.value).slice(0, 40);
    while (paletteList.firstChild) paletteList.removeChild(paletteList.firstChild);
    hits.forEach((hit, i) => {
      const li = h("li");
      if (i === paletteIndex) li.className = "sel";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === paletteIndex));
      const b = h("button");
      b.type = "button";
      const name = h("span", "name");
      name.textContent = hit.command.name;
      const aliases = h("span", "aliases");
      aliases.textContent = hit.command.aliases.filter((a) => a !== hit.command.name).join(", ");
      const desc = h("span", "desc");
      desc.textContent = hit.command.description;
      b.append(name, aliases, desc);
      b.addEventListener("click", () => {
        openPalette(false);
        void startCommand(hit.command.id);
      });
      li.append(b);
      paletteList.append(li);
    });
  }

  function openPalette(open: boolean): void {
    state.paletteOpen = open;
    palette.classList.toggle("open", open);
    if (open) {
      paletteInput.value = "";
      paletteIndex = 0;
      renderPalette();
      paletteInput.focus();
    }
  }
  palette.addEventListener("click", (e) => {
    if (e.target === palette) openPalette(false);
  });
  paletteInput.addEventListener("input", () => {
    paletteIndex = 0;
    renderPalette();
  });
  paletteInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      openPalette(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      paletteIndex = Math.min(39, paletteIndex + 1);
      renderPalette();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      paletteIndex = Math.max(0, paletteIndex - 1);
      renderPalette();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = searchCommands(paletteInput.value).slice(0, 40)[paletteIndex];
      if (hit !== undefined) {
        openPalette(false);
        void startCommand(hit.command.id);
      }
    }
  });

  // --- global keyboard (shared keymap) --------------------------------------------------------------

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName ?? "";
    const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if (state.paletteOpen && !inInput) {
      if (e.key === "Escape") openPalette(false);
      return;
    }
    const action = mapKeyEvent(
      { key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey },
      inInput ? "commandLine" : "canvas",
    );
    if (action === null) return;
    e.preventDefault();
    switch (action.type) {
      case "command":
        void startCommand(action.commandId);
        break;
      case "toggle":
        if (action.aid === "ortho" || action.aid === "polar" || action.aid === "otrack") {
          state.aids = { ...state.aids, [action.aid]: !state.aids[action.aid] };
          renderStatusBar();
        } else if (action.aid === "grid" || action.aid === "snap") {
          void executePlan({ appApi: [], ui: [{ action: `toggle.${action.aid}` }], echo: [] });
        }
        break;
      case "palette":
        if (action.palette === "search") openPalette(true);
        break;
      case "cancel":
        if (state.engine.commandId !== null) void dispatchEngine({ type: "cancel" });
        else if (state.selection.length > 0) {
          void command("document.setSelection", { ids: [] }).then(() => {
            state.selection = [];
            renderModel();
          });
        }
        break;
      case "enter":
        void dispatchEngine({ type: "enter" });
        break;
      case "zoomExtents":
        zoomExtents();
        break;
      case "selectionAll":
        void executePlan({ appApi: [], ui: [{ action: "selection.selectAll" }], echo: [] });
        break;
      default:
        break;
    }
  });

  // --- mode visibility (the professional Model card shows in drafting mode) --------------------------

  function syncMode(): void {
    const drafting = opts.getMode() === "drafting";
    modelCard.style.display = drafting ? "" : "none";
    ribbon.style.display = drafting ? "" : "none";
  }
  const modeObserver = new MutationObserver(syncMode);
  modeObserver.observe(opts.root, { subtree: true, attributes: true, attributeFilter: ["aria-pressed"] });
  syncMode();

  // --- boot + driver ---------------------------------------------------------------------------------

  void refresh();

  const driver: ProfessionalDriver = {
    async typedInput(text: string): Promise<void> {
      await dispatchEngine(text.length === 0 ? { type: "enter" } : { type: "typed", text, cursor: state.cursor });
    },
    async pressEnter(): Promise<void> {
      await dispatchEngine({ type: "enter" });
    },
    async pressEscape(): Promise<void> {
      await dispatchEngine({ type: "cancel" });
    },
    async pickPoint(x: number, y: number): Promise<void> {
      state.cursor = [x, y];
      const { point } = constrainSnap([x, y], false);
      await dispatchEngine({ type: "pick", point });
    },
    // COMPAT-CAD-007 (Issue #142): the entities-batch dispatch — the REAL
    // engine path the svg command-selection mouseup runs (ids resolve to
    // the live snapshot elements exactly as toEntityPicks does).
    async pickEntities(ids: readonly string[]): Promise<void> {
      const elements = state.snapshot?.elements ?? [];
      const byId = new Map(elements.map((el) => [el.id, el] as const));
      const picks: EntityPick[] = [];
      for (const id of ids) {
        const el = byId.get(id);
        if (el !== undefined) picks.push({ id: el.id, kind: el.kind, props: el.props as Record<string, unknown> });
      }
      await dispatchEngine({ type: "entities", entities: picks });
    },
    async setSelection(ids: string[]): Promise<void> {
      await command("document.setSelection", { ids });
      state.selection = [...ids];
      renderModel();
    },
    setActiveStory(id: string | null): void {
      // CAD-PARITY-011: pure UI context state (the same field the story
      // creation/picking paths maintain) — no document revision.
      state.activeStoryId = id;
    },
    async refresh(): Promise<void> {
      await refresh();
    },
    commandLog(): string[] {
      return [...commandLog];
    },
    // CAD-PARITY-009 (Issue #90): the 3D Model driver surface — the SAME code
    // paths the 3D tab/toolbar/scene run; the smoke asserts the rendered
    // scene + hashes the canonical SVG against the Web parity fixture.
    setModel3dView(active: boolean): void {
      setModel3dView(active);
      renderLayoutTabs();
    },
    model3dInfo(): { active: boolean; info: string; ucsOptions: string[]; solidCount: number; sceneFormat: string | null } {
      return {
        active: model3dView,
        info: model3dInfo.textContent ?? "",
        ucsOptions: [...model3dUcsSelect.options].map((o) => o.value),
        solidCount: (state.snapshot?.elements ?? []).filter(
          (el) => (el.props as Record<string, unknown> | null)?.type === "model3d.solid",
        ).length,
        sceneFormat: model3dSceneString !== null && model3dSceneString.startsWith("<svg") ? "offisos-scene3d-svg" : null,
      };
    },
    async model3dSceneSvg(selectedIds: readonly string[], withSectionFacets: boolean): Promise<string | null> {
      const snap = state.snapshot;
      if (snap === null) return null;
      // The CAD-PARITY-009 parity-anchor construction: the canonical scene
      // over the persisted camera + elements + the ACTIVE UCS + (optionally)
      // the section-preview facets + the caller's selection — the SAME input
      // shape the Web smoke builds through the shared barrel (the exportPlot
      // driver precedent: queries + shared writers, nothing client-only).
      let sectionFacets: unknown;
      if (withSectionFacets) {
        const res = await query("model3d.sectionPreview", {});
        if (res.ok) {
          const preview = (res.value as { preview?: { facets?: unknown } | null }).preview;
          if (preview !== undefined && preview !== null) sectionFacets = preview.facets;
        }
      }
      return buildScene3DSVG({
        viewport: { width: 800, height: 600 },
        camera: snap.draftingSettings?.view3d ?? defaultCamera3D(),
        elements: model3dSceneElements(),
        ucs: activeModel3dUcs(),
        ...(sectionFacets !== undefined ? { sectionFacets: sectionFacets as never } : {}),
        selectedIds: [...selectedIds],
      });
    },
    // CAD-PARITY-010 (Issue #93): the EXACT-section parity-anchor surface —
    // the canonical scene with the adapter-backed canonical section LOOPS as
    // the section facets (each loop is one facet polygon; the same input
    // shape the Web P010 smoke builds through the shared barrel), plus the
    // shared projectPoint over the persisted camera (the sub-entity pick
    // screen point — the SAME core the viewport consumes, no duplicated math).
    async model3dExactSectionSvg(selectedIds: readonly string[]): Promise<string | null> {
      const snap = state.snapshot;
      if (snap === null) return null;
      let sectionFacets: unknown;
      const res = await query("model3d.section", {});
      if (res.ok) {
        const section = (res.value as { section?: { facets?: readonly { elementId: string; loops: readonly (readonly number[])[] }[] } | null }).section;
        if (section !== undefined && section !== null && Array.isArray(section.facets)) {
          sectionFacets = section.facets.flatMap((facet: { elementId: string; loops: readonly (readonly number[])[] }) =>
            facet.loops.map((loop: readonly number[]) => ({ elementId: facet.elementId, polygon: loop })),
          );
        }
      }
      return buildScene3DSVG({
        viewport: { width: 800, height: 600 },
        camera: snap.draftingSettings?.view3d ?? defaultCamera3D(),
        elements: model3dSceneElements(),
        ucs: activeModel3dUcs(),
        ...(sectionFacets !== undefined ? { sectionFacets: sectionFacets as never } : {}),
        selectedIds: [...selectedIds],
      });
    },
    async model3dProjectPoint(point: readonly [number, number, number]): Promise<{ x: number; y: number } | null> {
      return projectPoint(currentModel3dCamera(), { width: 800, height: 600 }, [point[0], point[1], point[2]]);
    },
    echoLog(): string[] {
      return [...echoLog];
    },
    // CAD-PARITY-008 (Issue #88): the paper-space driver surface — the smoke
    // asserts the tab switching, the painted paper sheet, the preview
    // overlay and the deterministic plot exports through the SAME commands
    // the UI runs.
    space(): "model" | "paper" {
      return space;
    },
    setActiveSpace(next: "model" | "paper"): void {
      space = next;
      renderLayoutTabs();
      renderModel();
    },
    paperInfo(): { space: "model" | "paper"; layoutName: string | null; viewportCount: number; selectedViewportId: string | null } {
      const layout = activeLayoutRecord();
      return {
        space,
        layoutName: layout?.name ?? null,
        viewportCount: layout !== null ? (state.snapshot?.viewports ?? []).filter((v) => v.layoutId === layout.id).length : 0,
        selectedViewportId,
      };
    },
    async openPlotPreview(): Promise<void> {
      openPlotPreview();
      await new Promise((resolve) => setTimeout(resolve, 400));
    },
    async exportPlot(layoutName: string, format: "svg" | "pdf" | "plot-ir"): Promise<{ ok: boolean; sha256?: string; size?: number; message?: string }> {
      const res = await query("plot.preview", { name: layoutName });
      if (!res.ok) return { ok: false, message: `${res.code}: ${res.message}` };
      const previewValue = res.value as { hash: string };
      if (format === "plot-ir") return { ok: true, sha256: previewValue.hash };
      const out = await command("plot.export", { name: layoutName, format });
      if (!out.ok) return { ok: false, message: `${out.code}: ${out.message}` };
      const value = out.value as { sha256: string; size: number };
      return { ok: true, sha256: value.sha256, size: value.size };
    },
    selectViewport(id: string | null): void {
      selectedViewportId = id;
      renderModel();
    },
    viewTransform(): { pan: { x: number; y: number }; zoom: number; width: number; height: number } {
      return { pan: { ...state.pan }, zoom: state.zoom, width: SVG_W, height: SVG_H };
    },
    status() {
      const described = describePrompt(state.engine);
      return {
        prompt: described.prompt,
        commandName: described.commandName,
        history: [...state.history],
        selection: [...state.selection],
        elementCount: state.snapshot?.elements.length ?? 0,
        aids: { ...state.aids },
      };
    },
  };
  (window as unknown as { __offisosWorkspace: ProfessionalDriver }).__offisosWorkspace = driver;

  return driver;
}

export { resolveCommand, WORKSPACE_COMMANDS };
