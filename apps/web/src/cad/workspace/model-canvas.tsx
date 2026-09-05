"use client";

/**
 * CAD-PARITY-002 professional Model canvas (Web host).
 *
 * The 2D drafting/BIM-plan viewport of the professional workspace: pan/zoom,
 * grid, crosshair + live coordinate readout, deterministic snapping with
 * markers, ortho/polar/otrack-constrained rubber bands, window/crossing
 * selection, stacked-hit cycling, entity grips with drag editing and a
 * contextual mini-toolbar. ALL command input flows through the shared
 * prompt engine (the shell dispatches the events) so the canvas, the
 * command line, the ribbon and the palette produce IDENTICAL semantic
 * commands (LOCK-004 parity; §5.3 — mutations only through the App API).
 *
 * The engine-free pure core (selection/grips/feedback) is imported from
 * @offisos/cad-app-shell/workspace — the SAME code the Electron renderer
 * uses. No engine ever loads in the browser (LOCK-003/018).
 *
 * CAD-PARITY-005 (Issue #82): annotation elements (text/mtext/dimensions/
 * leaders — including the legacy COMPAT-CAD-001 dims) render, pick and
 * window-select through the shared annotation core: the style-driven render
 * primitives painted by the ONE shared canvas painter, with primitive-based
 * picking — identical output and hit surfaces on both hosts (LOCK-004).
 *
 * CAD-PARITY-006 (Issue #84): block/xref INSTANCE elements render, pick and
 * bounds-check through their DERIVED content — the ONE shared expansion
 * (workspace/blocks): expanded geometry draws through the same
 * drawCanonicalEntity path with per-entity layer display resolution,
 * materialized text through the same annotation painter, unresolved
 * references as the honest dashed placeholder box. Clicking derived content
 * selects the WHOLE instance (AutoCAD semantics).
 */

import * as React from "react";
import type { CADDocumentSnapshot, Element, LayerRecord } from "@offisos/cad-app-shell/contracts/caddocument";
import type { Vec2 } from "@offisos/cad-app-shell/drafting/precision";
import { commandById } from "@offisos/cad-app-shell/workspace/commands";
import type { PromptEngineState } from "@offisos/cad-app-shell/workspace/prompt-engine";
import { effectiveStep } from "@offisos/cad-app-shell/workspace/prompt-engine";
import {
  applyPickModifier,
  // COMPAT-CAD-007 (Issue #142): the shared command-phase selection core —
  // the command-select window/crossing batch (the SAME merge the idle
  // selection runs, from ONE module, on both hosts).
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
import {
  pickApertureWorld,
  pickAt as pickAtGeom,
  resolveSnap as resolveSnapPrecision,
  selectWindow,
  toEntities,
  type Entity as GeomEntity,
  type OsnapMode,
  type PrecisionSettings,
} from "@offisos/cad-app-shell/workspace/precision-2d";
import { bbox as geomBBox } from "@offisos/cad-app-shell/workspace/geometry/entities";
import { closestOn } from "@offisos/cad-app-shell/workspace/geometry/entities";
import { propsToGeom, type Geom } from "@offisos/cad-app-shell/workspace/geometry/types";
// COMPAT-CAD-006 (Issue #138): the ONE shared screen↔world view-transform
// contract — every pick/render path on this host constructs its transform
// through the same pure functions the Electron renderer uses.
import {
  CULL_MARGIN_PX,
  SCALE_ZOOM_LIMITS,
  WEB_ZOOM_LIMITS,
  clipSegment,
  expandRect,
  fitExtents,
  fitZoomOf,
  panBy,
  rectsIntersect,
  toScreen as viewToScreen,
  toWorld as viewToWorld,
  viewTransformOf,
  visibleWorldRect,
  zoomAboutPoint,
  zoomScaleAboutCenter,
  zoomWindow,
  type ViewNavigation,
  type WorldRect,
} from "@offisos/cad-app-shell/workspace/view";
import { constrainCursor, type DraftingAids } from "@offisos/cad-app-shell/workspace/feedback";
// CAD-PARITY-004: the shared standards module — the SAME display resolution
// the Electron renderer and the App API run (LOCK-004 parity).
import {
  dashToDevicePx,
  displayOverridesOf,
  LOCKED_LAYER_FADE_ALPHA,
  lineweightToDevicePx,
  resolveDimStyle,
  resolveDisplay,
  transparencyToAlpha,
} from "@offisos/cad-app-shell/workspace/standards";
import { Eraser, Move, Copy, MousePointerSquareDashed } from "lucide-react";

// CAD-PARITY-005: the shared annotation core (Issue #82) — the SAME
// primitive resolution + painter + pick surface the Electron renderer and
// the App API run (LOCK-004 parity by construction; no engine loads here).
import {
  annotationFromElement,
  annotationPickDistance,
  annotationPrimitives,
  annotationStyleContext,
  makeText,
  pickAnnotationAt,
  selectAnnotations,
  type TextAnnotation,
} from "@offisos/cad-app-shell/workspace/annotation";
import { paintAnnotationPrimitives } from "@offisos/cad-app-shell/workspace/annotation/paint";
// CAD-PARITY-007 (Issue #86): the shared constraints core — the glyph
// descriptors + the ONE shared badge painter (the SAME rendering the
// Electron canvas runs; diagnostics computed through the shared solver).
import {
  constraintGlyphs,
  diagnoseConstraints,
  paintConstraintGlyphs,
} from "@offisos/cad-app-shell/workspace/constraints";
// CAD-PARITY-006 (Issue #84): the shared blocks core — the instance
// vocabulary checks + the ONE shared expansion (render, pick and bounds read
// the SAME derived view; no engine loads here — LOCK-003/018/004).
import {
  expandedBounds,
  expandInstanceElement,
  isBlockRefElement,
  isXrefRefElement,
  blockRefFromElement,
  type BlockTable,
  type ExpandedEntity,
} from "@offisos/cad-app-shell/workspace/blocks";
// CAD-PARITY-012 (Issue #102): the shared materials/coordination cores — the
// materialId readers (entity + block-instance resolution), the revcloud
// marker constant, the grid display geometry + the document content bounds
// (the SAME modules the App API and the Electron host run; LOCK-004).
import {
  materialIdOf,
  resolvedBlockMaterialId,
  REVCLOUD_MARKER,
} from "@offisos/cad-app-shell/workspace/materials";
import {
  documentContentBounds,
  gridLines,
  type GridLineView,
} from "@offisos/cad-app-shell/workspace/coordination";
// CAD-PARITY-012: the material display resolution helpers (color/lineweight
// — the same module the shell + palettes run).
import {
  materialColorHex,
  materialLineweight,
  materialViewsOf,
  type MaterialView,
} from "@/cad/workspace/material-display";

import { Button } from "@/components/ui/button";
import {
  drawBimPlanElement,
  drawCanonicalEntity,
  drawCommandPreview,
  drawCrosshair,
  drawEntity,
  drawGeomEmphasis,
  drawGrid,
  drawGridBubbles,
  drawGridDatumLines,
  drawGrips,
  drawInstancePlaceholder,
  drawPendingPolyline,
  drawRubberBand,
  drawSelectionRect,
  drawSnapMarker,
  parseDraftEntity,
} from "@/cad/workspace/draw";

export interface ModelCanvasProps {
  readonly snapshot: CADDocumentSnapshot | null;
  readonly selection: readonly string[];
  readonly aids: DraftingAids;
  readonly engineState: PromptEngineState;
  readonly busy: boolean;
  readonly onCursor: (world: Vec2 | null) => void;
  readonly onPickPoint: (world: Vec2) => void;
  readonly onPickEntity: (pick: EntityPick) => void;
  /** COMPAT-CAD-007 (Issue #142; DEF-006): a WINDOW/CROSSING batch of object
   *  picks during a command select phase — the drag rectangle captured
   *  through the shared command-select core (the SAME merge the idle
   *  selection runs). Dispatched to the engine as one `entities` event. */
  readonly onPickEntities: (picks: readonly EntityPick[]) => void;
  /** CAD-PARITY-003 entityPoint step: the picked element + the RAW world
   *  pick point (the location is semantic for TRIM/EXTEND/FILLET/…). */
  readonly onPickEntityPoint: (pick: EntityPick, worldPoint: Vec2) => void;
  readonly onSelectionChange: (ids: readonly string[]) => void;
  readonly onGripEdit: (result: GripEditResult) => void;
  readonly onCommandStart: (commandId: string) => void;
  /** COMPAT-CAD-006: one navigation request channel (ZOOM/PAN/REGEN/
   *  ZOOMEXTENTS) — the shell translates the command ui-actions into these
   *  requests; the canvas (the view-state owner) applies them through the
   *  SHARED view-transform functions and persists the presentation view. */
  readonly navigation: ViewNavigation | null;
  /** COMPAT-CAD-006: honest typed feedback from the view layer (e.g. ZOOM P
   *  with no previous view) — appended to the command history by the shell. */
  readonly onViewFeedback?: (line: string) => void;
  /** COMPAT-CAD-005: increments when the document is swapped (NEW/OPEN) —
  *  the canvas resets pan/zoom to the (new) document's persisted view; the
  *  previous document's viewport must never survive a document swap. */
  readonly viewResetSignal: number;
  /** COMPAT-CAD-005: a pick MISS during a command select phase is visible
   *  feedback ("0 found"), never a silent drop (CAD-BENCH-RW-001 DEF-006:
   *  clicks vanished without a trace, leaving the prompt unchanged). */
  readonly onPickMiss?: (world: Vec2) => void;
  /** CAD-PARITY-004: contextual layer/palette actions from the canvas
   *  right-click menu (dispatched by the shell through the App API). */
  readonly onContextAction: (action: string, payload?: unknown) => void;
}

interface DragState {
  readonly kind: "pan" | "selection" | "commandSelection" | "grip";
  readonly startX: number;
  readonly startY: number;
  readonly panX: number;
  readonly panY: number;
  readonly gripId: string;
  readonly gripElement: Element | null;
}

function toEntityPick(el: Element): EntityPick {
  return { id: el.id, kind: el.kind, props: el.props as Record<string, unknown> };
}

/** COMPAT-CAD-006: the conservative world bbox of a LEGACY draft entity
 *  (the drawEntity rendering branch) for the viewport cull gate — null for
 *  shapes without a derivable rect (they draw; the surface clips). */
function legacyEntityRect(entity: ReturnType<typeof parseDraftEntity>): WorldRect | null {
  if (entity === null) return null;
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
      // Center ± radius is a superset for arcs too.
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

/** CAD-PARITY-006: soft-load the materialized text view of one expanded
 *  entity (the CAD-PARITY-005 text constructor — the SAME annotation
 *  pipeline the canvas runs for text elements; malformed derived props read
 *  as "renders nothing", never throw). */
function expandedTextOf(props: Record<string, unknown>): TextAnnotation | null {
  try {
    return makeText(props);
  } catch {
    return null;
  }
}

/** Representative bounds points of a canonical entity (ZOOMEXTENTS /
 *  selection-bbox). Infinite entities contribute their defining points only
 *  (not the draw extent); splines contribute their control points (the curve
 *  lies inside the convex hull). Deterministic. */
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

export function ModelCanvas(props: ModelCanvasProps): React.JSX.Element {
  const { snapshot, selection, aids, engineState, busy } = props;
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const viewTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = React.useRef<DragState | null>(null);
  const lastClickRef = React.useRef<{ screen: [number, number]; at: number; index: number } | null>(null);

  const [pan, setPan] = React.useState({ x: -20, y: -20 });
  const [zoom, setZoom] = React.useState(6);
  const [canvasH, setCanvasH] = React.useState(480);
  // COMPAT-CAD-006: the viewport WIDTH tracked alongside the height (the
  // shared transform/navigation math needs the full viewport size).
  const [canvasW, setCanvasW] = React.useState(900);
  const [panning, setPanning] = React.useState(false);
  const [cursor, setCursor] = React.useState<Vec2 | null>(null);
  const [selectionRect, setSelectionRect] = React.useState<{ a: [number, number]; b: [number, number] } | null>(null);
  const [hotGrip, setHotGrip] = React.useState<string | null>(null);
  // CAD-PARITY-004: the contextual right-click menu (idle canvas only —
  // during a command, right-click stays Enter as before).
  const [contextMenu, setContextMenu] = React.useState<{ screen: [number, number]; world: Vec2; layerId: string | null } | null>(null);

  const layers = snapshot?.layers ?? [];
  const settings = snapshot?.draftingSettings;
  const lweightDisplay = settings?.lineweightDisplay === true;

  // Restore the persisted view once the first snapshot arrives (async —
  // state updates happen after the await boundary).
  const restoredRef = React.useRef(false);
  React.useEffect(() => {
    if (restoredRef.current || snapshot === null) return;
    restoredRef.current = true;
    const view = snapshot.draftingSettings?.view;
    if (view !== undefined) {
      void (async () => {
        await Promise.resolve();
        setPan({ x: view.pan[0], y: view.pan[1] });
        setZoom(view.zoom);
      })();
    }
  }, [snapshot]);

  // COMPAT-CAD-005: reset the view when the document is swapped (NEW/OPEN) —
  // restores the incoming document's persisted view (or the default framing
  // when it has none). Keyed on the shell's viewResetSignal so the reset is
  // synchronous with the document swap, not the next snapshot arrival.
  // (Applied after the await boundary like the initial restore above — the
  // shell's document-swap state updates land in the same commit.)
  const lastViewReset = React.useRef(props.viewResetSignal);
  React.useEffect(() => {
    if (props.viewResetSignal === lastViewReset.current) return;
    lastViewReset.current = props.viewResetSignal;
    const view = snapshot?.draftingSettings?.view;
    void (async () => {
      await Promise.resolve();
      if (view !== undefined) {
        setPan({ x: view.pan[0], y: view.pan[1] });
        setZoom(view.zoom);
      } else {
        setPan({ x: -20, y: -20 });
        setZoom(6);
      }
    })();
  }, [props.viewResetSignal, snapshot]);

  // Track the canvas size (pure transforms below read state, not refs).
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const update = () => {
      setCanvasH(canvas.clientHeight);
      setCanvasW(canvas.clientWidth);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // COMPAT-CAD-006: THE shared view transform — the one value every
  // pick/render path on this host reads through the shared module (the
  // Electron renderer constructs the identical value through the identical
  // functions; toScreen/toWorld below are thin adapters for the tuple-based
  // call sites).
  const viewTransform = React.useMemo(
    () => viewTransformOf(pan, zoom, { w: canvasW, h: canvasH }),
    [pan, zoom, canvasW, canvasH],
  );

  const toScreen = React.useCallback(
    (p: Vec2): [number, number] => viewToScreen(viewTransform, p),
    [viewTransform],
  );

  const toWorld = React.useCallback(
    (sx: number, sy: number): Vec2 => viewToWorld(viewTransform, sx, sy),
    [viewTransform],
  );

  const persistView = React.useCallback((p: { x: number; y: number }, z: number) => {
    if (viewTimer.current !== null) clearTimeout(viewTimer.current);
    viewTimer.current = setTimeout(() => {
      void fetch("/api/cad", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api: "1",
          body: { type: "command", name: "drafting.setSettings", payload: { settings: { view: { pan: [p.x, p.y], zoom: z } } } },
        }),
      }).catch(() => undefined);
    }, 400);
  }, []);

  // --- layer views (CAD-PARITY-004: frozen = suppressed; locked = drawn but
  // not interactive — the same exclusion the App API precision queries run) ---

  const layerById = React.useMemo(() => new Map(layers.map((l) => [l.id, l] as const)), [layers]);

  /** Rendered entities: visible + not frozen (LOCKED layers render faded). */
  const drawableEntities = React.useMemo(() => {
    const renderable = new Set(layers.filter((l) => l.visible && l.frozen !== true).map((l) => l.id));
    return (snapshot?.elements ?? []).filter((el) => {
      const props = el.props as Record<string, unknown>;
      if (el.kind === "bim") return props.type === "bim.wall" || props.type === "bim.slab";
      const layer = props.layer;
      return typeof layer === "string" && renderable.has(layer);
    });
  }, [snapshot, layers]);

  /** Interactable entities (pick/snap/window selection): additionally
   *  excludes LOCKED layers (AutoCAD-class: locked entities display but do
   *  not interact; modification is blocked at the document gate). */
  const visibleEntities = React.useMemo(() => {
    const interactable = new Set(layers.filter((l) => l.visible && l.frozen !== true && l.locked !== true).map((l) => l.id));
    return (snapshot?.elements ?? []).filter((el) => {
      const props = el.props as Record<string, unknown>;
      if (el.kind === "bim") return props.type === "bim.wall" || props.type === "bim.slab";
      const layer = props.layer;
      return typeof layer === "string" && interactable.has(layer);
    });
  }, [snapshot, layers]);

  // CAD-PARITY-006: the document block/xref tables — the lookup view the
  // shared expansion resolves definitions and reference records through.
  // (Hoisted above displayById for the CAD-PARITY-012 material resolution.)
  const blockTable = React.useMemo<BlockTable>(
    () => ({
      blockDefById: (id: string) => (snapshot?.blockDefs ?? []).find((b) => b.id === id),
      xrefById: (id: string) => (snapshot?.xrefs ?? []).find((x) => x.id === id),
    }),
    [snapshot],
  );

  // CAD-PARITY-012 (Issue #102): the document material table (the bim.material
  // elements with the parity fields — the SAME rows materials.list serves).
  const materialsById = React.useMemo<ReadonlyMap<string, MaterialView>>(
    () => new Map(materialViewsOf(snapshot?.elements ?? []).map((m) => [m.id, m] as const)),
    [snapshot],
  );

  /** CAD-PARITY-012: the RESOLVED material id of one element — block
   *  instances resolve instance.materialId ?? definition default ?? null;
   *  everything else reads its own props (null = unassigned). */
  const resolvedMaterialIdOf = React.useCallback(
    (el: Element): string | null => {
      if (isBlockRefElement(el)) {
        const ref = blockRefFromElement(el);
        const def = ref !== null ? blockTable.blockDefById(ref.blockId) : undefined;
        return resolvedBlockMaterialId(el.props as Record<string, unknown>, def?.materialId);
      }
      return materialIdOf(el.props as Record<string, unknown>);
    },
    [blockTable],
  );

  /** CAD-PARITY-004: resolved display per drawable entity (the SAME
   *  standards resolution on both hosts): linetype dash in device px,
   *  lineweight px, transparency alpha + locked-layer fade.
   *  CAD-PARITY-012: the material display precedence — entity explicit
   *  override > material (color else category default; lineweight else 1.4)
   *  > layer — the material resolution runs through the SAME shared helpers
   *  the Properties swatches and the App API run. */
  const displayById = React.useMemo(() => {
    const userLtypes = snapshot?.ltypes ?? [];
    const standards = settings?.standards;
    const map = new Map<string, { dash: readonly number[] | null; weightPx: number; alpha: number; color: string }>();
    for (const el of drawableEntities) {
      const props = el.props as Record<string, unknown>;
      const layerId = typeof props.layer === "string" ? props.layer : "0";
      const layer = layerById.get(layerId);
      if (layer === undefined) continue;
      try {
        const overrides = displayOverridesOf(props);
        const resolved = resolveDisplay(overrides, layer, standards, userLtypes);
        // CAD-PARITY-012: the material slot (null when unassigned or the id
        // no longer resolves — the layer fallback).
        const materialId = resolvedMaterialIdOf(el);
        const material = materialId !== null ? materialsById.get(materialId) : undefined;
        const color = overrides.color ?? (material !== undefined ? materialColorHex(material) : resolved.color);
        const lineweight =
          overrides.lineweight ?? (material !== undefined ? materialLineweight(material) : resolved.lineweight);
        let alpha = transparencyToAlpha(resolved.transparency);
        if (layer.locked === true) alpha *= LOCKED_LAYER_FADE_ALPHA;
        map.set(el.id, {
          dash: resolved.dash.length > 0 ? dashToDevicePx(resolved.dash, zoom) : null,
          weightPx: lineweightToDevicePx(lineweight, zoom, lweightDisplay),
          alpha,
          color,
        });
      } catch {
        // Unresolvable display (stale linetype reference) falls back to the
        // layer color, solid, hairline — rendering never throws.
        map.set(el.id, { dash: null, weightPx: 1, alpha: layer.locked === true ? LOCKED_LAYER_FADE_ALPHA : 1, color: layer.color });
      }
    }
    return map;
  }, [drawableEntities, layerById, snapshot, settings, zoom, lweightDisplay, materialsById, resolvedMaterialIdOf]);

  /** CAD-PARITY-004: the resolved ACTIVE dimension style (dims render with
   *  its text height, arrow size, scale and precision). */
  const activeDimStyle = React.useMemo(
    () => resolveDimStyle(settings?.dimStyle ?? "Standard", snapshot?.dimStyles ?? []) ?? undefined,
    [settings, snapshot],
  );

  // CAD-PARITY-005: the annotation style context — the user text/dim style
  // tables + the document annotation scale (DrawingStandards.annotationScale,
  // 1 when absent). The SAME resolution drives annotation rendering, picking
  // and window selection on both hosts (LOCK-004).
  const annotationStyleCtx = React.useMemo(
    () => annotationStyleContext(snapshot?.textStyles ?? [], snapshot?.dimStyles ?? [], settings?.standards?.annotationScale),
    [snapshot, settings],
  );

  // CAD-PARITY-012 (Issue #102): the bim.grid coordination datums — their
  // DERIVED display segments (full-span over the document content bounds,
  // labels minted from the sorted line order — never stored). The SAME
  // gridLines/documentContentBounds the App API grids.list query runs.
  const gridLineViews = React.useMemo(() => {
    const gridElements = (snapshot?.elements ?? []).filter(
      (el) => el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.grid",
    );
    if (gridElements.length === 0) return [] as readonly GridLineView[];
    const bounds = documentContentBounds(snapshot?.elements ?? [], blockTable, 500);
    const out: GridLineView[] = [];
    for (const el of gridElements) {
      const p = el.props as Record<string, unknown>;
      if (!Array.isArray(p.uLines) || !Array.isArray(p.vLines)) continue;
      out.push(...gridLines({ uLines: p.uLines as number[], vLines: p.vLines as number[] }, bounds));
    }
    return out;
  }, [snapshot, blockTable]);

  /** CAD-PARITY-006: the DERIVED content of every block/xref instance (the
   *  ONE shared expansion — render, pick and bounds all read this view, so a
   *  definition edit changes every instance on the next expansion; malformed
   *  instance props expand to their honest placeholder, never throw). */
  const expandedInstances = React.useMemo(() => {
    const map = new Map<string, readonly ExpandedEntity[]>();
    for (const el of snapshot?.elements ?? []) {
      if (!isBlockRefElement(el) && !isXrefRefElement(el)) continue;
      map.set(el.id, expandInstanceElement(el, blockTable) ?? []);
    }
    return map;
  }, [snapshot, blockTable]);

  // CAD-PARITY-003: the canonical entity view over BOTH storage conventions
  // (same module the server-side precision queries run) — used for shared
  // osnap, canonical picking and the modify previews.
  const geomEntities = React.useMemo(() => toEntities(visibleEntities), [visibleEntities]);
  const geomEntityMap = React.useMemo(() => {
    const map = new Map<string, GeomEntity>();
    for (const e of geomEntities) map.set(e.id, e);
    return map;
  }, [geomEntities]);
  const geomById = React.useCallback((id: string): Geom | null => geomEntityMap.get(id)?.geom ?? null, [geomEntityMap]);

  /** CAD-PARITY-006: the pick distance of one instance's DERIVED content —
   *  geometry through the canonical closestOn (the precision-2d pick
   *  semantics), text through the annotation primitive hit boxes,
   *  placeholders by their box. Null when nothing draws within the
   *  aperture. Deterministic. */
  const expandedInstancePickDistance = React.useCallback(
    (entities: readonly ExpandedEntity[], probe: { x: number; y: number }, aperture: number): number | null => {
      let best: number | null = null;
      for (const entity of entities) {
        let d: number | null = null;
        if (entity.kind === "geometry") {
          const geom = propsToGeom(entity.props);
          if (geom !== null) d = closestOn(geom, probe).d;
        } else if (entity.kind === "text") {
          const anno = expandedTextOf(entity.props);
          if (anno !== null) d = annotationPickDistance(annotationPrimitives(anno, annotationStyleCtx), probe);
        } else {
          const dx = Math.max(entity.box.minX - probe.x, 0, probe.x - entity.box.maxX);
          const dy = Math.max(entity.box.minY - probe.y, 0, probe.y - entity.box.maxY);
          d = Math.hypot(dx, dy);
        }
        if (d !== null && d <= aperture && (best === null || d < best)) best = d;
      }
      return best;
    },
    [annotationStyleCtx],
  );

  /** Deterministic merged pick (CAD-PARITY-003): the shared pickAt over the
   *  canonical entity view, merged with the legacy hitTest (which also covers
   *  legacy dimension annotations) and the CAD-PARITY-005 annotation pick
   *  (primitive-based — the pick surface IS the render surface). Closest
   *  distance wins; ties break by element id. */
  const pickEntityAt = React.useCallback(
    (world: Vec2): { id: string; d: number } | null => {
      // COMPAT-CAD-005: the DECLARED pickbox (see precision-2d) — the one
      // deterministic screen-space tolerance for every entity pick, converted
      // to world units through the view transform.
      const aperture = pickApertureWorld(zoom);
      const probe = { x: world[0], y: world[1] };
      const canonical = pickAtGeom(geomEntities, probe, aperture);
      let canonicalBest: { id: string; d: number } | null = null;
      if (canonical !== null) {
        canonicalBest = { id: canonical.id, d: closestOn(canonical.geom, probe).d };
      }
      const legacyHits = hitTest(world, aperture, visibleEntities);
      const legacyBest = legacyHits.length > 0 ? { id: legacyHits[0]!.id, d: legacyHits[0]!.distance } : null;
      // CAD-PARITY-005: annotations pick where they paint (primitives).
      const annotationPick = pickAnnotationAt(visibleEntities, probe, aperture, annotationStyleCtx);
      const annotationBest = annotationPick !== null ? { id: annotationPick.id, d: annotationPick.d } : null;
      // CAD-PARITY-006: block/xref instances pick by their DERIVED content —
      //  the closest expanded entity within the aperture selects the WHOLE
      //  instance (AutoCAD semantics: clicking block content selects the
      //  insert; ties break by element id like every other candidate).
      let instanceBest: { id: string; d: number } | null = null;
      for (const el of visibleEntities) {
        const expanded = expandedInstances.get(el.id);
        if (expanded === undefined) continue;
        const d = expandedInstancePickDistance(expanded, probe, aperture);
        if (d === null) continue;
        if (instanceBest === null || d < instanceBest.d - 1e-12 || (Math.abs(d - instanceBest.d) <= 1e-12 && el.id < instanceBest.id)) {
          instanceBest = { id: el.id, d };
        }
      }
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
    },
    [zoom, geomEntities, visibleEntities, annotationStyleCtx, expandedInstances, expandedInstancePickDistance],
  );

  // --- engine-aware interaction -------------------------------------------------

  const command = engineState.commandId === null ? null : commandById(engineState.commandId);
  // The effective step is option-capture aware (CAD-PARITY-003): while a
  // FILLET R / OFFSET T sub-prompt is active, the step kind routes pick and
  // typed input through the sub-prompt, not the paused step.
  const activeStep = React.useMemo(() => effectiveStep(engineState), [engineState]);
  const stepBase = React.useMemo<Vec2 | null>(() => {
    if (activeStep === null) return engineState.lastPoint;
    if (activeStep.baseStep !== undefined) {
      const v = engineState.values[activeStep.baseStep];
      if (v !== undefined && v.kind === "point") return v.point;
    }
    return engineState.lastPoint;
  }, [activeStep, engineState]);

  // COMPAT-CAD-006 (Issue #138): the deterministic CONTENT BOUNDS the
  // fit-extents and absolute-scale zooms read — every visible entity (grid
  // datum spans included so a grids-only document still fits; stories are
  // excluded — they have no plan geometry) and each block/xref instance's
  // DERIVED content bounds (the same shared expansion the paint loop runs —
  // the zoom fits what actually renders). Pure derivation from the snapshot;
  // null when the document has no renderable content.
  const contentBounds = React.useCallback((): WorldRect | null => {
    const elements = visibleEntities;
    if (elements.length === 0 && gridLineViews.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const line of gridLineViews) {
      minX = Math.min(minX, line.p1.x, line.p2.x);
      minY = Math.min(minY, line.p1.y, line.p2.y);
      maxX = Math.max(maxX, line.p1.x, line.p2.x);
      maxY = Math.max(maxY, line.p1.y, line.p2.y);
    }
    for (const el of elements) {
      const expanded = expandedInstances.get(el.id);
      if (expanded !== undefined) {
        const bb = expandedBounds(expanded);
        if (bb !== null) {
          minX = Math.min(minX, bb.minX);
          minY = Math.min(minY, bb.minY);
          maxX = Math.max(maxX, bb.maxX);
          maxY = Math.max(maxY, bb.maxY);
        }
        continue;
      }
      const entity = parseDraftEntity(el);
      const p = el.props as Record<string, unknown>;
      const points: Vec2[] = [];
      if (entity !== null) {
        if (entity.type === "line") points.push(entity.from, entity.to);
        else if (entity.type === "polyline") points.push(...entity.points);
        else if (entity.type === "circle") {
          points.push([entity.center[0] - entity.radius, entity.center[1] - entity.radius], [entity.center[0] + entity.radius, entity.center[1] + entity.radius]);
        } else if (entity.type === "rectangle") points.push(entity.corner1, entity.corner2);
      } else {
        const geom = geomById(el.id);
        if (geom !== null) {
          points.push(...canonicalBoundsPoints(geom));
        } else if (p.type === "bim.wall" && Array.isArray(p.start) && Array.isArray(p.end)) {
          points.push(p.start as unknown as Vec2, p.end as unknown as Vec2);
        } else if (p.type === "bim.slab" && Array.isArray(p.corner1) && Array.isArray(p.corner2)) {
          points.push(p.corner1 as unknown as Vec2, p.corner2 as unknown as Vec2);
        } else {
          continue;
        }
      }
      for (const pt of points) {
        minX = Math.min(minX, pt[0]);
        minY = Math.min(minY, pt[1]);
        maxX = Math.max(maxX, pt[0]);
        maxY = Math.max(maxY, pt[1]);
      }
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }, [visibleEntities, gridLineViews, expandedInstances, geomById]);

  // COMPAT-CAD-006 (Issue #138): the command-driven view history (ZOOM
  // Previous) — the pre-navigation {pan, zoom} of every COMMAND navigation
  // (zoom window/scale/extents, pan), max 10 entries (the AutoCAD-class
  // previous-view stack depth). Wheel-zoom and drag-pan deliberately do NOT
  // push entries (a wheel gesture would flood the stack with per-tick
  // states) — the stack records the discrete command vocabulary. Disclosed
  // in the work-item record.
  const viewHistoryRef = React.useRef<readonly { pan: { x: number; y: number }; zoom: number }[]>([]);
  const lastNavigationSeq = React.useRef(0);

  // COMPAT-CAD-006 (Issue #138): ONE navigation effect — every
  // ZOOM/PAN/REGEN/ZOOMEXTENTS ui-action from the command plans lands here
  // and is applied through the SHARED view-transform functions. Navigation
  // is presentation-only: nothing here touches document entities, version
  // or undo history; the view persists through the existing non-versioned
  // drafting.setSettings { view } mechanism.
  React.useEffect(() => {
    const nav = props.navigation;
    if (nav === null || nav.seq === 0 || nav.seq === lastNavigationSeq.current) return;
    lastNavigationSeq.current = nav.seq;
    const req = nav.request;
    const current = viewTransformOf(pan, zoom, { w: canvasW, h: canvasH });
    // The declared world-unit padding of the fit transforms (the shipped
    // ZOOMEXTENTS presentation policy, unchanged).
    const FIT_PAD = 600;
    if (req.kind === "regen") {
      // Pure redraw — no view or document change. The paint effect re-runs
      // through the navigation prop identity (this object is new for every
      // navigation request, regen included).
      return;
    }
    if (req.kind === "zoomPrevious") {
      const stack = viewHistoryRef.current;
      if (stack.length === 0) {
        props.onViewFeedback?.("ZOOM: no previous view to restore.");
        return;
      }
      const prev = stack[stack.length - 1]!;
      viewHistoryRef.current = stack.slice(0, -1);
      setPan({ x: prev.pan.x, y: prev.pan.y });
      setZoom(prev.zoom);
      persistView({ x: prev.pan.x, y: prev.pan.y }, prev.zoom);
      return;
    }
    // Every other navigation records the pre-navigation view (ZOOM P stack).
    viewHistoryRef.current = [...viewHistoryRef.current, { pan: { x: pan.x, y: pan.y }, zoom }].slice(-10);
    if (req.kind === "zoomExtents") {
      const bounds = contentBounds();
      if (bounds === null) return;
      // NO zoom clamp on the fit (the shipped ZOOMEXTENTS presentation
      // policy: a real-scale site plan fits at whatever zoom the content
      // needs — the declared limits govern the INTERACTIVE zooms only).
      const next = fitExtents({ w: canvasW, h: canvasH }, bounds, FIT_PAD);
      setPan({ x: next.pan.x, y: next.pan.y });
      setZoom(next.zoom);
      persistView({ x: next.pan.x, y: next.pan.y }, next.zoom);
      return;
    }
    if (req.kind === "zoomWindow") {
      // No clamp: the user-specified window is the explicit target (the
      // fit semantics — a real-scale window zooms to exactly what it spans).
      const next = zoomWindow(current, req.corner1, req.corner2);
      if (next === null) {
        // Defensive: the builder rejects degenerate windows; a null here
        // means the world window collapsed below the zoom precision — the
        // honest typed feedback, no view change.
        props.onViewFeedback?.("ZOOM: window too small — no view change.");
        return;
      }
      setPan({ x: next.pan.x, y: next.pan.y });
      setZoom(next.zoom);
      persistView({ x: next.pan.x, y: next.pan.y }, next.zoom);
      return;
    }
    if (req.kind === "zoomScale") {
      // The user-specified factor is honored exactly within the wide scale
      // guards (NOT the interactive wheel floor — a real-scale view at zoom
      // 0.02 must be able to double).
      let next;
      if (req.relative) {
        next = zoomScaleAboutCenter(current, req.factor, SCALE_ZOOM_LIMITS);
      } else {
        // AutoCAD "n" (plain): scale relative to the drawing-extents fit —
        // the deterministic reference zoom over the content bounds (the
        // empty-document degenerate bounds keep it deterministic).
        const bounds = contentBounds() ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        const reference = fitZoomOf({ w: canvasW, h: canvasH }, bounds, FIT_PAD);
        const target = Math.min(SCALE_ZOOM_LIMITS.max, Math.max(SCALE_ZOOM_LIMITS.min, reference * req.factor));
        next = zoomScaleAboutCenter(current, target / current.zoom, SCALE_ZOOM_LIMITS);
      }
      setPan({ x: next.pan.x, y: next.pan.y });
      setZoom(next.zoom);
      persistView({ x: next.pan.x, y: next.pan.y }, next.zoom);
      return;
    }
    if (req.kind === "pan") {
      const next = panBy(current, req.delta);
      setPan({ x: next.pan.x, y: next.pan.y });
      persistView({ x: next.pan.x, y: next.pan.y }, next.zoom);
      return;
    }
  }, [props.navigation, pan, zoom, canvasW, canvasH, contentBounds, persistView, props.onViewFeedback]);

  // CAD-PARITY-003 shared precision settings (CAD-2D-003): the professional
  // default osnap mode set, the drafting-settings snap tolerance as aperture,
  // ortho/polar from the host aids. Grid snapping stays as-is (grid is drawn
  // but not snapped to); single-base otrack remains the CAD-PARITY-002
  // constrainCursor behavior (tracking is not duplicated here).
  const precisionSettings = React.useMemo<PrecisionSettings>(
    () => ({
      osnapModes: ["endpoint", "midpoint", "center", "quadrant", "intersection", "node"],
      ortho: aids.ortho,
      polar: aids.polar,
      polarAnglesDeg: [0, 45, 90, 135, 180, 225, 270, 315],
      gridSnap: false,
      gridSize: settings?.grid.size ?? 10,
      aperture: settings?.snap.tolerance ?? 0.5,
      tracking: false,
    }),
    [aids.ortho, aids.polar, settings],
  );

  /** Constrain (aids) → snap (osnap) — the canonical composition order. The
   *  osnap runs on the SAME shared precision module as the App API queries
   *  (CAD-PARITY-003 parity by construction). */
  const constrainedSnapped = React.useCallback(
    (world: Vec2, shiftHeld: boolean): { point: Vec2; snapped: boolean; mode: OsnapMode | null } => {
      const effectiveAids: DraftingAids = shiftHeld ? { ...aids, ortho: true } : aids;
      const constrained = constrainCursor(stepBase, world, effectiveAids).point;
      if (settings?.snap.enabled !== true) return { point: constrained, snapped: false, mode: null };
      const r = resolveSnapPrecision(
        geomEntities,
        { x: constrained[0], y: constrained[1] },
        precisionSettings,
        engineState.lastPoint !== null ? { x: engineState.lastPoint[0], y: engineState.lastPoint[1] } : null,
      );
      if (r.mode === null) return { point: constrained, snapped: false, mode: null };
      return { point: [r.point.x, r.point.y], snapped: true, mode: r.mode };
    },
    [aids, stepBase, settings, geomEntities, precisionSettings, engineState.lastPoint],
  );

  const selectedSet = React.useMemo(() => new Set(selection), [selection]);
  const singleSelected = React.useMemo(() => {
    if (selection.length !== 1) return null;
    return (snapshot?.elements ?? []).find((el) => el.id === selection[0]) ?? null;
  }, [selection, snapshot]);
  // CAD-PARITY-004: grips are READ-ONLY-hidden on locked layers (a locked
  // entity cannot be grip-edited; the document gate would reject it — the
  // affordance must not offer it).
  const singleSelectedLocked = React.useMemo(() => {
    if (singleSelected === null) return false;
    const layerId = (singleSelected.props as Record<string, unknown>).layer;
    if (typeof layerId !== "string") return false;
    return layerById.get(layerId)?.locked === true;
  }, [singleSelected, layerById]);
  const grips = React.useMemo(
    () => (singleSelected !== null && !singleSelectedLocked ? gripsFor(singleSelected) : []),
    [singleSelected, singleSelectedLocked],
  );

  // --- pointer handlers -----------------------------------------------------------

  const pointerScreen = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [sx, sy] = pointerScreen(e);
    canvasRef.current?.focus();

    // Middle button or space+left → pan.
    if (e.button === 1) {
      dragRef.current = { kind: "pan", startX: sx, startY: sy, panX: pan.x, panY: pan.y, gripId: "", gripElement: null };
      setPanning(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    // Grip drag start (single selection, engine idle).
    if (activeStep === null && singleSelected !== null) {
      for (const grip of grips) {
        const gs = toScreen(grip.point);
        if (Math.hypot(gs[0] - sx, gs[1] - sy) <= 7) {
          dragRef.current = { kind: "grip", startX: sx, startY: sy, panX: pan.x, panY: pan.y, gripId: grip.id, gripElement: singleSelected };
          e.currentTarget.setPointerCapture(e.pointerId);
          setHotGrip(grip.id);
          return;
        }
      }
    }

    const world = toWorld(sx, sy);

    if (activeStep !== null) {
      // Command input.
      if (activeStep.kind === "entity") {
        const picked = pickEntityAt(world);
        const hit = picked !== null ? (snapshot?.elements ?? []).find((el) => el.id === picked.id) : undefined;
        if (hit !== undefined) props.onPickEntity(toEntityPick(hit));
        else {
          // COMPAT-CAD-007 (Issue #142; DEF-006): a miss during a command
          // select phase STARTS a window/crossing drag (the benchmark's
          // "drag-select attempts also fail" probe). A plain click (< 4 px,
          // the idle threshold) still reports the "0 found" miss on pointer
          // up; a drag resolves through the shared command-select core and
          // dispatches one `entities` batch to the engine.
          dragRef.current = { kind: "commandSelection", startX: sx, startY: sy, panX: pan.x, panY: pan.y, gripId: "", gripElement: null };
          setSelectionRect({ a: [sx, sy], b: [sx, sy] });
          // Pointer capture is a progressive enhancement (drags leaving the
          // canvas bounds); synthetic PointerEvents (browser-agent forensics,
          // test harnesses) carry no active pointer id, where setPointerCapture
          // throws — guarded so the drag state still records and completes.
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* no active pointer — the drag completes on pointerup */
          }
        }
        return;
      }
      // CAD-PARITY-003 entityPoint step: pick the object under the cursor AND
      // record the RAW pick point (the location selects the piece/corner to
      // operate on — no snap constraint is applied to it).
      if (activeStep.kind === "entityPoint") {
        const picked = pickEntityAt(world);
        if (picked !== null) {
          const hit = (snapshot?.elements ?? []).find((el) => el.id === picked.id);
          if (hit !== undefined) props.onPickEntityPoint(toEntityPick(hit), world);
        } else {
          props.onPickMiss?.(world); // COMPAT-CAD-005: visible "0 found" feedback
        }
        return;
      }
      const { point } = constrainedSnapped(world, e.shiftKey);
      if (activeStep.kind === "point") props.onPickPoint(point);
      else if (activeStep.kind === "distance" || activeStep.kind === "displacement") props.onPickPoint(point);
      return;
    }

    // Selection mode.
    const picked = pickEntityAt(world);
    if (picked !== null) {
      const hits = hitTest(world, pickApertureWorld(zoom), visibleEntities);
      if (hits.length > 0 && hits[0]!.id === picked.id) {
        // Legacy pickability — stacked-hit cycling preserved.
        const last = lastClickRef.current;
        const now = Date.now();
        let chosen = hits[0]!.id;
        let index = 0;
        if (last !== null && now - last.at < 700 && Math.hypot(last.screen[0] - sx, last.screen[1] - sy) < 6) {
          const cycled = cyclePick(world, pickApertureWorld(zoom), visibleEntities, last.index);
          if (cycled !== null) {
            chosen = cycled.id;
            index = cycled.index;
          }
        }
        lastClickRef.current = { screen: [sx, sy], at: now, index };
        props.onSelectionChange(applyPickModifier(selection, chosen, e.shiftKey ? "toggle" : "replace"));
        return;
      }
      // Canonical-only hit (ellipse/spline/point/ray/xline/region …).
      lastClickRef.current = null;
      props.onSelectionChange(applyPickModifier(selection, picked.id, e.shiftKey ? "toggle" : "replace"));
      return;
    }
    lastClickRef.current = null;
    // Empty-space drag → window/crossing selection rect.
    dragRef.current = { kind: "selection", startX: sx, startY: sy, panX: pan.x, panY: pan.y, gripId: "", gripElement: null };
    setSelectionRect({ a: [sx, sy], b: [sx, sy] });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [sx, sy] = pointerScreen(e);
    const drag = dragRef.current;

    if (drag !== null && drag.kind === "pan") {
      setPan({ x: drag.panX - (sx - drag.startX) / zoom, y: drag.panY + (sy - drag.startY) / zoom });
      return;
    }
    if (drag !== null && (drag.kind === "selection" || drag.kind === "commandSelection")) {
      setSelectionRect({ a: [drag.startX, drag.startY], b: [sx, sy] });
      return;
    }
    if (drag !== null && drag.kind === "grip") {
      const world = toWorld(sx, sy);
      const snapped = settings?.snap.enabled === true ? constrainedSnapped(world, e.shiftKey).point : world;
      setCursor(snapped);
      return;
    }

    const world = toWorld(sx, sy);
    setCursor(world);
    props.onCursor(world);

    // Hover highlight of grips.
    if (activeStep === null && singleSelected !== null) {
      let hot: string | null = null;
      for (const grip of grips) {
        const gs = toScreen(grip.point);
        if (Math.hypot(gs[0] - sx, gs[1] - sy) <= 7) {
          hot = grip.id;
          break;
        }
      }
      setHotGrip(hot);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag === null) return;

    if (drag.kind === "pan") {
      setPanning(false);
      persistView(pan, zoom);
      return;
    }
    if (drag.kind === "commandSelection") {
      // COMPAT-CAD-007 (Issue #142; DEF-006): the command-phase window/
      // crossing drag. A sub-threshold release is the plain click miss
      // (the CC005 "0 found" contract); a real drag resolves through the
      // SHARED command-select core — the SAME three-way merge the idle
      // selection below runs — and dispatches one `entities` batch.
      setSelectionRect(null);
      const [sx, sy] = pointerScreen(e);
      const world = toWorld(drag.startX, drag.startY);
      if (Math.hypot(sx - drag.startX, sy - drag.startY) < 4) {
        props.onPickMiss?.(world);
        return;
      }
      const a = toWorld(drag.startX, drag.startY);
      const b = toWorld(sx, sy);
      const picks = commandWindowPicks(
        [a[0], a[1]],
        [b[0], b[1]],
        visibleEntities,
        geomEntities,
        annotationStyleCtx,
      );
      props.onPickEntities(picks);
      return;
    }
    if (drag.kind === "selection") {
      setSelectionRect(null);
      const [sx, sy] = pointerScreen(e);
      const a = toWorld(drag.startX, drag.startY);
      const b = toWorld(sx, sy);
      if (Math.hypot(sx - drag.startX, sy - drag.startY) < 4) {
        // A click on empty space clears the selection.
        if (!e.shiftKey && selection.length > 0) props.onSelectionChange([]);
        return;
      }
      const rect = selectionRectangle(a, b);
      const ids = windowSelect(rect, visibleEntities);
      // CAD-PARITY-003 canonical entities — the SAME window/crossing semantics
      // as the shared precision engine (legacy ids stay first, deterministic
      // document order for the new ones).
      const canonicalIds = selectWindow(geomEntities, {
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
        visibleEntities,
        { mode: rect.mode, min: { x: rect.min[0], y: rect.min[1] }, max: { x: rect.max[0], y: rect.max[1] } },
        annotationStyleCtx,
      );
      for (const id of annotationIds) {
        if (!merged.includes(id)) merged.push(id);
      }
      props.onSelectionChange(e.shiftKey ? Array.from(new Set([...selection, ...merged])) : merged);
      return;
    }
    if (drag.kind === "grip" && drag.gripElement !== null) {
      setHotGrip(null);
      const [sx, sy] = pointerScreen(e);
      const world = toWorld(sx, sy);
      const snapped = constrainedSnapped(world, e.shiftKey).point;
      const result = gripDrag(drag.gripElement, drag.gripId, snapped);
      if (result !== null && result.appApi.length > 0) props.onGripEdit(result);
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    // COMPAT-CAD-006 (Issue #138): wheel zoom is anchored at the cursor —
    // the world point under the pointer stays at the same screen position
    // (the shared zoomAboutPoint invariant; the previous fixed-pan zoom let
    // the content drift away from the cursor, the DEF-005 "unstable zoom"
    // observation). Clamped to the declared limits; view-only.
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const rect = e.currentTarget.getBoundingClientRect();
    const [sx, sy] = [e.clientX - rect.left, e.clientY - rect.top];
    const anchor = viewToWorld(viewTransform, sx, sy);
    const next = zoomAboutPoint(viewTransform, factor, anchor, WEB_ZOOM_LIMITS);
    setZoom(next.zoom);
    setPan({ x: next.pan.x, y: next.pan.y });
    persistView({ x: next.pan.x, y: next.pan.y }, next.zoom);
  };

  // --- rendering -----------------------------------------------------------------

  const snapPreview = React.useMemo(() => {
    if (cursor === null || activeStep === null) return null;
    const { point, snapped, mode } = constrainedSnapped(cursor, false);
    return snapped ? { point, mode } : null;
  }, [cursor, activeStep, constrainedSnapped]);

  // CAD-PARITY-003: canonical geometry of the objects the running command
  // will modify — the collected object picks, or the current selection.
  const targetGeoms = React.useMemo<readonly Geom[]>(() => {
    if (command === null) return [];
    const objects = engineState.values.objects;
    const ids =
      objects !== undefined && objects.kind === "entities"
        ? objects.entities.map((entity) => entity.id)
        : selection;
    const out: Geom[] = [];
    for (const id of ids) {
      const geom = geomEntityMap.get(id)?.geom;
      if (geom !== undefined) out.push(geom);
    }
    return out;
  }, [command, engineState.values, selection, geomEntityMap]);

  const polylinePending = React.useMemo(() => {
    if (command === null || command.id !== "polyline") return [];
    const start = engineState.values.start;
    const next = engineState.values.next;
    const points: Vec2[] = [];
    if (start !== undefined && start.kind === "point") points.push(start.point);
    if (next !== undefined && next.kind === "points") points.push(...next.points);
    return points;
  }, [command, engineState]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const dpr = window.devicePixelRatio ?? 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    // COMPAT-CAD-006 (Issue #138): THE deterministic viewport gate — the
    // visible world rect expanded by the declared device-px cull margin.
    // Geometry whose world bbox misses this rect is culled (never drawn);
    // LINE segments are additionally PRE-CLIPPED (Liang–Barsky) so their
    // screen coordinates stay bounded inside the viewport at any world
    // scale — the explicit partial-clipping contract that replaces reliance
    // on implicit host clipping (CAD-BENCH-RW-001 DEF-004 discipline).
    // Rays/xlines are never culled here (their bbox is unbounded; the
    // shared painter clips them to the visible rect itself).
    const gateRect = expandRect(visibleWorldRect(viewTransform), CULL_MARGIN_PX, zoom);
    /** Cull verdict for one world bbox against the gate. */
    const passesGate = (bb: { minX: number; minY: number; maxX: number; maxY: number }): boolean =>
      rectsIntersect(bb, gateRect);

    if (settings?.grid.enabled) {
      drawGrid(ctx, { size: settings.grid.size, pan, zoom, w, h, toScreen });
    }

    // CAD-PARITY-012 (Issue #102): the bim.grid coordination datum segments —
    // thin dashed slate lines under the entities (the shared
    // gridLines/documentContentBounds derivation — deterministic from the
    // snapshot; the label bubbles paint over the entities below).
    if (gridLineViews.length > 0) {
      drawGridDatumLines(ctx, gridLineViews, toScreen);
    }

    const layerById = new Map<string, LayerRecord>(layers.map((l) => [l.id, l] as const));
    // CAD-PARITY-005: the shared painter takes Pt objects ({x, y}) — the
    // canvas transform stays tuple-based (Vec2), so adapt once per frame.
    const toScreenPt = (p: { x: number; y: number }): [number, number] => toScreen([p.x, p.y]);
    // CAD-PARITY-005: the painter's structural Canvas2DContext accepts the
    // DOM CanvasRenderingContext2D directly (its style slots are widened
    // to `string | object` in the core so the DOM lib's gradient/pattern
    // unions stay assignable).

    // CAD-PARITY-006: the resolved display of one DERIVED instance entity —
    // the SAME standards resolution (ByLayer chain, dash/lineweight px,
    // transparency + locked-layer fade) the displayById memo runs for
    // standalone entities, resolved from the CONTENT's own layer.
    // CAD-PARITY-012 (Issue #102): the INSTANCE's resolved material
    // (instance.materialId ?? definition default ?? null) applies between
    // the piece's explicit override and its layer — precedence: piece
    // explicit > instance material > layer. Rendering never throws (an
    // unresolvable display falls back to the layer color, solid, hairline).
    const resolveDerivedDisplay = (
      props: Record<string, unknown>,
      instanceMaterialId: string | null,
    ): { dash: readonly number[] | null; weightPx: number; alpha: number; color: string } => {
      const layerId = typeof props.layer === "string" ? props.layer : "0";
      const layer = layerById.get(layerId);
      if (layer === undefined) return { dash: null, weightPx: 1, alpha: 1, color: "#111827" };
      try {
        const overrides = displayOverridesOf(props);
        const resolved = resolveDisplay(overrides, layer, settings?.standards, snapshot?.ltypes ?? []);
        const material = instanceMaterialId !== null ? materialsById.get(instanceMaterialId) : undefined;
        const color = overrides.color ?? (material !== undefined ? materialColorHex(material) : resolved.color);
        const lineweight =
          overrides.lineweight ?? (material !== undefined ? materialLineweight(material) : resolved.lineweight);
        let alpha = transparencyToAlpha(resolved.transparency);
        if (layer.locked === true) alpha *= LOCKED_LAYER_FADE_ALPHA;
        return {
          dash: resolved.dash.length > 0 ? dashToDevicePx(resolved.dash, zoom) : null,
          weightPx: lineweightToDevicePx(lineweight, zoom, lweightDisplay),
          alpha,
          color,
        };
      } catch {
        return { dash: null, weightPx: 1, alpha: layer.locked === true ? LOCKED_LAYER_FADE_ALPHA : 1, color: layer.color };
      }
    };

    // CAD-PARITY-006 (Issue #84): paint one block/xref instance's DERIVED
    // content — geometry through the same drawCanonicalEntity path, text
    // through the same annotation painter, placeholders as the dashed box.
    // Each entity's OWN layer visibility gates it exactly like a standalone
    // entity (the instance's own layer already gated entry into
    // drawableEntities); the whole instance highlights when selected.
    const drawExpandedInstance = (el: Element, entities: readonly ExpandedEntity[]): void => {
      const selected = selectedSet.has(el.id);
      // CAD-PARITY-012: the instance's RESOLVED material (instance ??
      // definition default ?? null) governs every piece of the expansion.
      const instanceMaterialId = resolvedMaterialIdOf(el);
      for (const entity of entities) {
        if (entity.kind === "placeholder") {
          drawInstancePlaceholder(ctx, entity.box, entity.label, toScreen);
          continue;
        }
        if (entity.kind === "text") {
          const anno = expandedTextOf(entity.props);
          if (anno === null) continue;
          const layer = layerById.get(anno.layer);
          if (layer !== undefined && (layer.frozen === true || !layer.visible)) continue;
          const derived = resolveDerivedDisplay(entity.props, instanceMaterialId);
          paintAnnotationPrimitives(ctx, annotationPrimitives(anno, annotationStyleCtx), {
            toScreen: toScreenPt,
            zoom,
            color: derived.color,
            weightPx: selected ? derived.weightPx * 1.8 : derived.weightPx,
            dash: derived.dash,
            alpha: selected ? 1 : derived.alpha,
          });
          continue;
        }
        const geom = propsToGeom(entity.props);
        if (geom === null) continue;
        const layerId = typeof entity.props.layer === "string" ? entity.props.layer : "0";
        const layer = layerById.get(layerId);
        if (layer !== undefined && (layer.frozen === true || !layer.visible)) continue;
        const derived = resolveDerivedDisplay(entity.props, instanceMaterialId);
        // COMPAT-CAD-006: the viewport gate applies to each DERIVED piece
        // exactly like a standalone entity (lines pre-clipped).
        if (geom.type === "line") {
          const seg = clipSegment(gateRect, [geom.x1, geom.y1], [geom.x2, geom.y2]);
          if (seg === null) continue;
          drawCanonicalEntity(ctx, { ...geom, x1: seg[0][0], y1: seg[0][1], x2: seg[1][0], y2: seg[1][1] }, {
            color: derived.color,
            selected,
            toScreen,
            zoom,
            viewport: { w, h },
            dash: derived.dash,
            weightPx: derived.weightPx,
            alpha: derived.alpha,
          });
          continue;
        }
        if (geom.type !== "ray" && geom.type !== "xline" && !passesGate(geomBBox(geom))) continue;
        drawCanonicalEntity(ctx, geom, {
          color: derived.color,
          selected,
          toScreen,
          zoom,
          viewport: { w, h },
          dash: derived.dash,
          weightPx: derived.weightPx,
          alpha: derived.alpha,
        });
      }
    };

    for (const el of drawableEntities) {
      // CAD-PARITY-006: block/xref INSTANCE elements render their DERIVED
      // content through the ONE shared expansion (definition → instance
      // propagation: a definition edit changes every instance here).
      const expanded = expandedInstances.get(el.id);
      if (expanded !== undefined) {
        drawExpandedInstance(el, expanded);
        continue;
      }
      // CAD-PARITY-003: canonical geometry first (BOTH storage conventions
      // decode through the bridge — legacy line/polyline/circle/arc/rectangle
      // included).
      // CAD-PARITY-004: the resolved display (dash/lineweight/alpha) flows
      // through the SAME standards resolution on both hosts.
      // CAD-PARITY-012: revision-cloud markup (the bounded marker
      // "revcloud") paints the amber family in BOTH states — the polyline
      // geometry stays exactly as persisted.
      const display = displayById.get(el.id);
      const isRevcloud = (el.props as Record<string, unknown>).marker === REVCLOUD_MARKER;
      const canonical = geomEntityMap.get(el.id);
      if (canonical !== undefined) {
        const layer = layerById.get(canonical.layer);
        if (layer !== undefined && (layer.frozen === true || !layer.visible)) continue;
        // COMPAT-CAD-006 (Issue #138): the deterministic viewport gate —
        // LINE geoms are pre-clipped (Liang–Barsky) to the gate rect so the
        // rasterizer only ever sees bounded screen coordinates (the
        // explicit partial-clip contract; the visible portion of a
        // boundary-crossing segment is drawn — never the whole-entity skip
        // of CAD-BENCH-RW-001 DEF-004); every other geom type is bbox-gated
        // (its bbox is a superset of the stroke — the margin covers the
        // weights) and the host surface clips the visible portion.
        if (canonical.geom.type === "line") {
          const g = canonical.geom;
          const seg = clipSegment(gateRect, [g.x1, g.y1], [g.x2, g.y2]);
          if (seg === null) continue;
          drawCanonicalEntity(ctx, { ...g, x1: seg[0][0], y1: seg[0][1], x2: seg[1][0], y2: seg[1][1] }, {
            color: display?.color ?? canonical.color ?? layer?.color ?? "#111827",
            selected: selectedSet.has(el.id),
            toScreen,
            zoom,
            viewport: { w, h },
            dash: display?.dash ?? null,
            weightPx: display?.weightPx,
            alpha: display?.alpha,
            markerStroke: isRevcloud ? (selectedSet.has(el.id) ? "#d97706" : "#f59e0b") : undefined,
          });
          continue;
        }
        if (canonical.geom.type !== "ray" && canonical.geom.type !== "xline" && !passesGate(geomBBox(canonical.geom))) continue;
        drawCanonicalEntity(ctx, canonical.geom, {
          color: display?.color ?? canonical.color ?? layer?.color ?? "#111827",
          selected: selectedSet.has(el.id),
          toScreen,
          zoom,
          viewport: { w, h },
          dash: display?.dash ?? null,
          weightPx: display?.weightPx,
          alpha: display?.alpha,
          markerStroke: isRevcloud ? (selectedSet.has(el.id) ? "#d97706" : "#f59e0b") : undefined,
        });
        continue;
      }
      // CAD-PARITY-005: annotation elements (the 8-type canonical vocabulary
      // AND the legacy COMPAT-CAD-001 dims — both load through
      // annotationFromElement) render through the ONE shared painter: the
      // style-driven primitives painted identically on Web and Electron.
      // Layer visibility/frozen filtering applies exactly like geometry;
      // selected annotations render slightly thicker at full alpha (no
      // emphasis outline by design).
      if (el.kind === "annotation") {
        const anno = annotationFromElement(el);
        if (anno !== null) {
          const layer = layerById.get(anno.layer);
          if (layer !== undefined && (layer.frozen === true || !layer.visible)) continue;
          const primitives = annotationPrimitives(anno, annotationStyleCtx);
          const selected = selectedSet.has(el.id);
          paintAnnotationPrimitives(ctx, primitives, {
            toScreen: toScreenPt,
            zoom,
            color: display?.color ?? layer?.color ?? "#111827",
            weightPx: selected ? (display?.weightPx ?? 1) * 1.8 : (display?.weightPx ?? 1),
            dash: display?.dash ?? null,
            alpha: selected ? 1 : (display?.alpha ?? 1),
          });
          continue;
        }
      }
      const entity = parseDraftEntity(el);
      if (entity !== null) {
        const layer = layerById.get(entity.layer);
        if (layer !== undefined && (layer.frozen === true || !layer.visible)) continue;
        // COMPAT-CAD-006: the same viewport gate for the legacy rendering
        // branch (dims etc.) — conservative bbox from the entity's own
        // points; unknown shapes draw (never a silent drop).
        const gate = legacyEntityRect(entity);
        if (gate !== null && !passesGate(gate)) continue;
        drawEntity(ctx, entity, {
          color: display?.color ?? layer?.color ?? "#111827",
          selected: selectedSet.has(el.id),
          toScreen,
          zoom,
          dash: display?.dash ?? null,
          weightPx: display?.weightPx,
          alpha: display?.alpha,
          dimStyle: activeDimStyle,
        });
        continue;
      }
      // COMPAT-CAD-006: BIM plan elements (walls/slabs) pass the gate by
      // their start/end or corner points — with the wall thickness safety
      // margin baked into CULL_MARGIN_PX (16 px device); anything without a
      // derivable rect draws (conservative, the surface clips).
      {
        const p = el.props as Record<string, unknown>;
        let gate: WorldRect | null = null;
        if (p.type === "bim.wall" && Array.isArray(p.start) && Array.isArray(p.end)) {
          const a = p.start as [number, number];
          const b = p.end as [number, number];
          gate = { minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) };
        } else if (p.type === "bim.slab" && Array.isArray(p.corner1) && Array.isArray(p.corner2)) {
          const a = p.corner1 as [number, number];
          const b = p.corner2 as [number, number];
          gate = { minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) };
        }
        if (gate !== null && !passesGate(gate)) continue;
      }
      drawBimPlanElement(ctx, el, { selected: selectedSet.has(el.id), toScreen, zoom });
    }

    // CAD-PARITY-012 (Issue #102): the grid label bubbles — screen-space
    // circles (~24px) with the DERIVED label (A…/1…) at BOTH segment ends,
    // painted OVER the entities (the standard bubble presentation).
    if (gridLineViews.length > 0) {
      drawGridBubbles(ctx, gridLineViews, toScreen);
    }

    // CAD-PARITY-007 (Issue #86): the constraint bar badges — one glyph per
    // declared constraint at the deterministic positions (the SHARED painter;
    // violated badges render hot through the shared diagnostics — identical
    // on Web and Electron, LOCK-004).
    const declaredConstraints = snapshot?.constraints ?? [];
    if (declaredConstraints.length > 0) {
      const diagnostics = diagnoseConstraints(snapshot?.elements ?? [], declaredConstraints);
      const violated = new Set(
        diagnostics.statuses.filter((s) => !s.satisfied).map((s) => s.id),
      );
      paintConstraintGlyphs(
        ctx,
        constraintGlyphs(snapshot?.elements ?? [], declaredConstraints),
        { toScreen: toScreenPt, violated },
      );
    }

    // Pending polyline preview.
    if (polylinePending.length > 0) {
      const previewCursor = cursor !== null ? constrainedSnapped(cursor, false).point : null;
      drawPendingPolyline(ctx, polylinePending, previewCursor, toScreen);
    }

    // CAD-PARITY-003 command previews (ghost geometry, axis lines, live
    // entities, echo readouts) + hover emphasis during object picks.
    if (activeStep !== null && cursor !== null && command !== null) {
      if (activeStep.kind === "entity" || activeStep.kind === "entityPoint") {
        // Hover emphasis: highlight the entity under the cursor before the
        // pick (TRIM/EXTEND/BREAK target feedback).
        const hovered = pickEntityAt(cursor);
        if (hovered !== null) {
          const geom = geomEntityMap.get(hovered.id)?.geom;
          if (geom !== undefined) {
            drawGeomEmphasis(ctx, geom, { toScreen, zoom, viewport: { w, h } });
          }
        }
      }
      drawCommandPreview(ctx, {
        commandId: command.id,
        values: engineState.values,
        cursor: constrainedSnapped(cursor, false).point,
        targetGeoms,
        geomById,
        toScreen,
        zoom,
        viewport: { w, h },
      });
      // COMPAT-CAD-006: ZOOM window rubber band — the dashed cyan rectangle
      // from the first corner to the cursor while the second corner prompt
      // is active (the classic zoom-window affordance; the pan command has
      // its own displacement rubber band below).
      if (command.id === "zoom") {
        const first = engineState.values.corner1;
        if (first !== undefined && first.kind === "point" && cursor !== null) {
          const a = toScreen(first.point);
          const b = toScreen(constrainedSnapped(cursor, false).point);
          ctx.save();
          ctx.strokeStyle = "#0891b2";
          ctx.lineWidth = 1;
          ctx.setLineDash([5, 4]);
          ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
          ctx.restore();
        }
      }
    }

    // Rubber band for the active point/distance/displacement step
    // (CAD-PARITY-012: REVCLOUD skips it — its command preview draws the live
    // rectangle + scalloped cloud instead of the diagonal rubber line).
    if (
      activeStep !== null && stepBase !== null && cursor !== null &&
      (activeStep.kind === "point" || activeStep.kind === "distance" || activeStep.kind === "displacement") &&
      command?.id !== "revcloud"
    ) {
      const constrained = constrainedSnapped(cursor, false).point;
      drawRubberBand(ctx, stepBase, constrained, toScreen);
    }

    // Selection rectangle (window/crossing).
    if (selectionRect !== null) {
      const mode = selectionRect.b[0] >= selectionRect.a[0] ? "window" : "crossing";
      drawSelectionRect(ctx, selectionRect.a, selectionRect.b, mode);
    }

    // Grips for the single selection.
    if (activeStep === null && singleSelected !== null) {
      drawGrips(ctx, grips, toScreen, hotGrip);
    }

    // Snap marker (mode-aware shape: endpoint square, center circle, …).
    if (snapPreview !== null) {
      drawSnapMarker(ctx, toScreen(snapPreview.point), "#0d9488", snapPreview.mode);
    }

    // Crosshair (always in this professional viewport).
    if (cursor !== null) {
      drawCrosshair(ctx, toScreen(cursor), w, h);
    }
  }, [settings, layers, drawableEntities, geomEntityMap, selectedSet, toScreen, viewTransform, pan, zoom, cursor, selectionRect, snapPreview, polylinePending, activeStep, stepBase, singleSelected, grips, hotGrip, constrainedSnapped, command, engineState.values, targetGeoms, geomById, pickEntityAt, displayById, activeDimStyle, annotationStyleCtx, expandedInstances, lweightDisplay, gridLineViews, materialsById, resolvedMaterialIdOf, props.navigation]);

  // --- mini-toolbar position -------------------------------------------------------------

  const miniToolbar = React.useMemo(() => {
    if (activeStep !== null || selection.length === 0 || selectionRect !== null) return null;
    const selected = (snapshot?.elements ?? []).filter((el) => selectedSet.has(el.id));
    if (selected.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of selected) {
      const entity = parseDraftEntity(el);
      const props = el.props as Record<string, unknown>;
      const points: Vec2[] = [];
      if (entity !== null) {
        if (entity.type === "line") points.push(entity.from, entity.to);
        else if (entity.type === "polyline") points.push(...entity.points);
        else if (entity.type === "circle") {
          points.push([entity.center[0] - entity.radius, entity.center[1] - entity.radius], [entity.center[0] + entity.radius, entity.center[1] + entity.radius]);
        } else if (entity.type === "rectangle") points.push(entity.corner1, entity.corner2);
      } else {
        // CAD-PARITY-006: instances contribute their DERIVED content bounds
        // (the same shared expansion the paint loop runs).
        const expanded = expandedInstances.get(el.id);
        const instanceBox = expanded !== undefined ? expandedBounds(expanded) : null;
        // CAD-PARITY-003 canonical entities (bounds of the canonical view).
        const geom = geomEntityMap.get(el.id)?.geom;
        if (instanceBox !== null) {
          points.push([instanceBox.minX, instanceBox.minY], [instanceBox.maxX, instanceBox.maxY]);
        } else if (geom !== undefined) {
          points.push(...canonicalBoundsPoints(geom));
        } else if (props.type === "bim.wall") {
          points.push(props.start as unknown as Vec2, props.end as unknown as Vec2);
        } else if (props.type === "bim.slab") {
          points.push(props.corner1 as unknown as Vec2, props.corner2 as unknown as Vec2);
        }
      }
      for (const p of points) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      }
    }
    if (!Number.isFinite(minX)) return null;
    const top = toScreen([minX, maxY]);
    return { left: top[0], top: Math.max(8, top[1] - 44) };
  }, [activeStep, selection, selectionRect, snapshot, selectedSet, toScreen, geomEntityMap, expandedInstances]);

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label="Offisos Model viewport — 2D drafting and BIM plan canvas"
        className="h-full min-h-[420px] w-full touch-none rounded border bg-white outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ cursor: panning ? "grabbing" : "crosshair" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => {
          e.preventDefault();
          // CAD-PARITY-004: idle right-click opens the contextual layer/
          // properties menu (during a command right-click stays Enter — the
          // legacy double-click/Enter path is untouched).
          if (activeStep !== null || contextMenu !== null) return;
          const [sx, sy] = [e.nativeEvent.offsetX, e.nativeEvent.offsetY];
          const world = toWorld(sx, sy);
          const picked = pickEntityAt(world);
          const layerId =
            picked !== null
              ? ((snapshot?.elements ?? []).find((el) => el.id === picked.id)?.props as Record<string, unknown> | undefined)?.layer
              : null;
          setContextMenu({ screen: [sx, sy], world, layerId: typeof layerId === "string" ? layerId : null });
        }}
        onDoubleClick={() => {
          // Double-click = Enter (finishes polyline-style steps).
          const ev = new KeyboardEvent("keydown", { key: "Enter" });
          window.dispatchEvent(ev);
        }}
      />
      {contextMenu !== null && (
        <ContextMenuPanel
          layer={contextMenu.layerId !== null ? layerById.get(contextMenu.layerId) ?? null : null}
          screen={contextMenu.screen}
          onAction={(action, payload) => {
            setContextMenu(null);
            props.onContextAction(action, payload);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
      {busy && (
        <div className="pointer-events-none absolute right-3 top-3 rounded bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow" role="status">
          working…
        </div>
      )}
      {miniToolbar !== null && (
        <div
          className="absolute z-10 flex items-center gap-0.5 rounded-md border bg-background/95 p-0.5 shadow-md"
          style={{ left: Math.max(4, miniToolbar.left), top: miniToolbar.top }}
          role="toolbar"
          aria-label="selection actions"
        >
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title="Move selection (MOVE)" onClick={() => props.onCommandStart("move")}>
            <Move className="mr-1 h-3.5 w-3.5" aria-hidden /> Move
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title="Copy selection (COPY)" onClick={() => props.onCommandStart("copy")}>
            <Copy className="mr-1 h-3.5 w-3.5" aria-hidden /> Copy
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title="Erase selection (ERASE / Del)" onClick={() => props.onCommandStart("erase")}>
            <Eraser className="mr-1 h-3.5 w-3.5" aria-hidden /> Erase
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title="Deselect all (Esc)" onClick={() => props.onSelectionChange([])}>
            <MousePointerSquareDashed className="mr-1 h-3.5 w-3.5" aria-hidden /> Deselect
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CAD-PARITY-004: the contextual right-click menu (idle canvas).
// ---------------------------------------------------------------------------

function ContextMenuPanel(props: {
  readonly layer: LayerRecord | null;
  readonly screen: readonly [number, number];
  readonly onAction: (action: string, payload?: unknown) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const item = (action: string, label: string, payload?: unknown, disabled = false): React.JSX.Element => (
    <button
      key={action + String(payload ?? "")}
      type="button"
      disabled={disabled}
      className={
        "flex w-full items-center rounded px-2 py-1 text-left text-xs " +
        (disabled ? "text-muted-foreground/50" : "hover:bg-muted")
      }
      onClick={() => props.onAction(action, payload)}
    >
      {label}
    </button>
  );
  const l = props.layer;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={props.onClose} onContextMenu={(e) => { e.preventDefault(); props.onClose(); }} aria-hidden />
      <div
        role="menu"
        aria-label="canvas context menu"
        className="absolute z-50 flex min-w-44 flex-col gap-0.5 rounded-md border bg-background p-1 shadow-lg"
        style={{ left: Math.max(4, props.screen[0]), top: Math.max(4, props.screen[1]) }}
      >
        {l !== null ? (
          <>
            <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Layer “{l.name}”
            </div>
            {item("layer.toggleVisible", l.visible ? "Hide layer" : "Show layer", l.id)}
            {item("layer.toggleFrozen", l.frozen === true ? "Thaw layer" : "Freeze layer", l.id, l.frozen !== true && l.id === "0")}
            {item("layer.toggleLocked", l.locked === true ? "Unlock layer" : "Lock layer", l.id)}
            {item("layer.isolate", "Isolate layer", l.id)}
            {item("layer.setActive", "Make active layer", l.id)}
          </>
        ) : (
          <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Layers</div>
        )}
        <div className="my-0.5 h-px bg-border" />
        {item("layer.allOn", "Show all layers (LAYON)")}
        {item("layer.unisolate", "Unisolate layers (LAYUNISO)", undefined, props.layer === undefined)}
        {item("palette.layers", "Layer Manager…")}
        {item("palette.properties", "Properties…")}
      </div>
    </>
  );
}
