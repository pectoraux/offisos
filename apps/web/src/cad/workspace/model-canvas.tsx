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
 */

import * as React from "react";
import type { CADDocumentSnapshot, Element, LayerRecord } from "@offisos/cad-app-shell/contracts/caddocument";
import type { Vec2 } from "@offisos/cad-app-shell/drafting/precision";
import { commandById } from "@offisos/cad-app-shell/workspace/commands";
import type { PromptEngineState } from "@offisos/cad-app-shell/workspace/prompt-engine";
import { effectiveStep } from "@offisos/cad-app-shell/workspace/prompt-engine";
import {
  applyPickModifier,
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
import type { Geom } from "@offisos/cad-app-shell/workspace/geometry/types";
import { constrainCursor, type DraftingAids } from "@offisos/cad-app-shell/workspace/feedback";
import { Eraser, Move, Copy, MousePointerSquareDashed } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  drawBimPlanElement,
  drawCanonicalEntity,
  drawCommandPreview,
  drawCrosshair,
  drawEntity,
  drawGeomEmphasis,
  drawGrid,
  drawGrips,
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
  /** CAD-PARITY-003 entityPoint step: the picked element + the RAW world
   *  pick point (the location is semantic for TRIM/EXTEND/FILLET/…). */
  readonly onPickEntityPoint: (pick: EntityPick, worldPoint: Vec2) => void;
  readonly onSelectionChange: (ids: readonly string[]) => void;
  readonly onGripEdit: (result: GripEditResult) => void;
  readonly onCommandStart: (commandId: string) => void;
  /** Increments when ZOOMEXTENTS runs — the canvas fits the visible model. */
  readonly zoomExtentsSignal: number;
}

interface DragState {
  readonly kind: "pan" | "selection" | "grip";
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
  const [panning, setPanning] = React.useState(false);
  const [cursor, setCursor] = React.useState<Vec2 | null>(null);
  const [selectionRect, setSelectionRect] = React.useState<{ a: [number, number]; b: [number, number] } | null>(null);
  const [hotGrip, setHotGrip] = React.useState<string | null>(null);

  const layers = snapshot?.layers ?? [];
  const settings = snapshot?.draftingSettings;

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

  // Track the canvas size (pure transforms below read state, not refs).
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const update = () => setCanvasH(canvas.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const toScreen = React.useCallback(
    (p: Vec2): [number, number] => [(p[0] - pan.x) * zoom, canvasH - (p[1] - pan.y) * zoom],
    [pan, zoom, canvasH],
  );

  const toWorld = React.useCallback(
    (sx: number, sy: number): Vec2 => [sx / zoom + pan.x, (canvasH - sy) / zoom + pan.y],
    [pan, zoom, canvasH],
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

  // --- visible (pickable/snappable) entities ----------------------------------

  const visibleEntities = React.useMemo(() => {
    const visible = new Set(layers.filter((l) => l.visible).map((l) => l.id));
    return (snapshot?.elements ?? []).filter((el) => {
      const props = el.props as Record<string, unknown>;
      if (el.kind === "bim") return props.type === "bim.wall" || props.type === "bim.slab";
      const layer = props.layer;
      return typeof layer === "string" && visible.has(layer);
    });
  }, [snapshot, layers]);

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

  /** Deterministic merged pick (CAD-PARITY-003): the shared pickAt over the
   *  canonical entity view, merged with the legacy hitTest (which also covers
   *  dimension annotations). Closest distance wins; ties break by element id. */
  const pickEntityAt = React.useCallback(
    (world: Vec2): { id: string; d: number } | null => {
      const aperture = 8 / zoom;
      const probe = { x: world[0], y: world[1] };
      const canonical = pickAtGeom(geomEntities, probe, aperture);
      let canonicalBest: { id: string; d: number } | null = null;
      if (canonical !== null) {
        canonicalBest = { id: canonical.id, d: closestOn(canonical.geom, probe).d };
      }
      const legacyHits = hitTest(world, aperture, visibleEntities);
      const legacyBest = legacyHits.length > 0 ? { id: legacyHits[0]!.id, d: legacyHits[0]!.distance } : null;
      if (legacyBest === null) return canonicalBest;
      if (canonicalBest === null) return legacyBest;
      if (Math.abs(canonicalBest.d - legacyBest.d) <= 1e-12) {
        return canonicalBest.id < legacyBest.id ? canonicalBest : legacyBest;
      }
      return canonicalBest.d < legacyBest.d ? canonicalBest : legacyBest;
    },
    [zoom, geomEntities, visibleEntities],
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

  // ZOOMEXTENTS: fit every visible entity in the viewport (deterministic
  // bounds + padding; stories are excluded — they have no plan geometry).
  React.useEffect(() => {
    if (props.zoomExtentsSignal === 0) return;
    const elements = visibleEntities;
    if (elements.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of elements) {
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
        // CAD-PARITY-003 canonical entities (ellipse/spline/point/ray/xline/
        // region + flat-convention records).
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
    if (!Number.isFinite(minX)) return;
    const w = canvasRef.current?.clientWidth ?? 900;
    const pad = 600;
    const spanX = Math.max(maxX - minX + pad * 2, 1);
    const spanY = Math.max(maxY - minY + pad * 2, 1);
    const z = Math.min(w / spanX, canvasH / spanY);
    setZoom(z);
    setPan({ x: minX - pad - (w / z - spanX) / 2, y: minY - pad - (canvasH / z - spanY) / 2 });
    persistView({ x: minX - pad - (w / z - spanX) / 2, y: minY - pad - (canvasH / z - spanY) / 2 }, z);
  }, [props.zoomExtentsSignal]);

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
  const grips = React.useMemo(() => (singleSelected !== null ? gripsFor(singleSelected) : []), [singleSelected]);

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
        return; // miss: the prompt stays (the command line shows guidance)
      }
      // CAD-PARITY-003 entityPoint step: pick the object under the cursor AND
      // record the RAW pick point (the location selects the piece/corner to
      // operate on — no snap constraint is applied to it).
      if (activeStep.kind === "entityPoint") {
        const picked = pickEntityAt(world);
        if (picked !== null) {
          const hit = (snapshot?.elements ?? []).find((el) => el.id === picked.id);
          if (hit !== undefined) props.onPickEntityPoint(toEntityPick(hit), world);
        }
        return; // miss: the prompt stays
      }
      const { point } = constrainedSnapped(world, e.shiftKey);
      if (activeStep.kind === "point") props.onPickPoint(point);
      else if (activeStep.kind === "distance" || activeStep.kind === "displacement") props.onPickPoint(point);
      return;
    }

    // Selection mode.
    const picked = pickEntityAt(world);
    if (picked !== null) {
      const hits = hitTest(world, 8 / zoom, visibleEntities);
      if (hits.length > 0 && hits[0]!.id === picked.id) {
        // Legacy pickability — stacked-hit cycling preserved.
        const last = lastClickRef.current;
        const now = Date.now();
        let chosen = hits[0]!.id;
        let index = 0;
        if (last !== null && now - last.at < 700 && Math.hypot(last.screen[0] - sx, last.screen[1] - sy) < 6) {
          const cycled = cyclePick(world, 8 / zoom, visibleEntities, last.index);
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
    if (drag !== null && drag.kind === "selection") {
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
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const z = Math.min(400, Math.max(0.5, zoom * factor));
    setZoom(z);
    persistView(pan, z);
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

    if (settings?.grid.enabled) {
      drawGrid(ctx, { size: settings.grid.size, pan, zoom, w, h, toScreen });
    }

    const layerById = new Map<string, LayerRecord>(layers.map((l) => [l.id, l] as const));
    for (const el of visibleEntities) {
      // CAD-PARITY-003: canonical geometry first (BOTH storage conventions
      // decode through the bridge — legacy line/polyline/circle/arc/rectangle
      // included); annotations (dims) fall through to the legacy painter.
      const canonical = geomEntityMap.get(el.id);
      if (canonical !== undefined) {
        const layer = layerById.get(canonical.layer);
        if (layer !== undefined && !layer.visible) continue;
        drawCanonicalEntity(ctx, canonical.geom, {
          color: canonical.color ?? layer?.color ?? "#111827",
          selected: selectedSet.has(el.id),
          toScreen,
          zoom,
          viewport: { w, h },
        });
        continue;
      }
      const entity = parseDraftEntity(el);
      if (entity !== null) {
        const layer = layerById.get(entity.layer);
        if (layer !== undefined && !layer.visible) continue;
        drawEntity(ctx, entity, {
          color: layer?.color ?? "#111827",
          selected: selectedSet.has(el.id),
          toScreen,
          zoom,
        });
        continue;
      }
      drawBimPlanElement(ctx, el, { selected: selectedSet.has(el.id), toScreen, zoom });
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
    }

    // Rubber band for the active point/distance/displacement step.
    if (activeStep !== null && stepBase !== null && cursor !== null && (activeStep.kind === "point" || activeStep.kind === "distance" || activeStep.kind === "displacement")) {
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
  }, [settings, layers, visibleEntities, geomEntityMap, selectedSet, toScreen, pan, zoom, cursor, selectionRect, snapPreview, polylinePending, activeStep, stepBase, singleSelected, grips, hotGrip, constrainedSnapped, command, engineState.values, targetGeoms, geomById, pickEntityAt]);

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
        // CAD-PARITY-003 canonical entities (bounds of the canonical view).
        const geom = geomEntityMap.get(el.id)?.geom;
        if (geom !== undefined) {
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
  }, [activeStep, selection, selectionRect, snapshot, selectedSet, toScreen, geomEntityMap]);

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
        onDoubleClick={() => {
          // Double-click = Enter (finishes polyline-style steps).
          const ev = new KeyboardEvent("keydown", { key: "Enter" });
          window.dispatchEvent(ev);
        }}
      />
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
