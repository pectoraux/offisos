"use client";

/**
 * CAD-PARITY-002 professional canvas painting (Web host), extended for
 * CAD-PARITY-003 (Issue #78): the canonical 2D entity vocabulary
 * (ellipse/spline/point/ray/xline/region + both storage conventions through
 * the geometry bridge), mode-aware snap markers and the rubber-band command
 * previews. Deterministic 2D canvas rendering for the Model viewport:
 * drafting entities (ported from the COMPAT-CAD-001 workbench), BIM plan
 * footprints (walls as thick bands, slabs as filled rectangles), the
 * professional crosshair, snap markers, rubber bands, selection rectangles,
 * grips and the pending-command preview. Pure drawing — no state, no engines.
 */

import type { Vec2 } from "@offisos/cad-app-shell/drafting/precision";
import type { DraftEntity } from "@offisos/cad-app-shell/drafting/entities";
import type { Element } from "@offisos/cad-app-shell/contracts/caddocument";
import { parseDraftEntity } from "@/cad/drafting/hit";
import type { GripHandle } from "@offisos/cad-app-shell/workspace/grips";
import type { Geom } from "@offisos/cad-app-shell/workspace/geometry/types";
import type { Pt } from "@offisos/cad-app-shell/workspace/geometry/math2d";
import { arcSweep, sampleSpline } from "@offisos/cad-app-shell/workspace/geometry/entities";
import { closestOn } from "@offisos/cad-app-shell/workspace/geometry/entities";
import { mirrorGeom, rotateGeom, scaleGeom } from "@offisos/cad-app-shell/workspace/geometry/transform";
import { offsetGeom } from "@offisos/cad-app-shell/workspace/geometry/offset";
import { optionValue } from "@offisos/cad-app-shell/workspace/prompt-engine";
import type { PromptValue } from "@offisos/cad-app-shell/workspace/types";

export interface ScreenTransform {
  readonly toScreen: (p: Vec2) => [number, number];
  readonly zoom: number;
}

export type { Geom };

// ---------------------------------------------------------------------------
// Canonical 2D entities (CAD-PARITY-003, both storage conventions).
// ---------------------------------------------------------------------------

/** Visible world rectangle (viewport bounds in world units). */
export interface WorldRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface GeomDrawOptions {
  readonly color: string;
  readonly selected: boolean;
  readonly toScreen: (p: Vec2) => [number, number];
  readonly zoom: number;
  readonly viewport: { readonly w: number; readonly h: number };
}

interface GeomStroke {
  readonly stroke: string;
  readonly lineWidth: number;
  readonly dash: readonly number[] | null;
  readonly fill: string | null;
}

const TAU = Math.PI * 2;
const OSNAP_TEAL = "#0d9488";
const PREVIEW_AMBER = "#f59e0b";
const GHOST_STROKE = "rgba(14,165,233,0.55)";
const SELECTED_STROKE = "#0ea5e9";
const REGION_FILL = "rgba(13,148,136,0.10)";
const REGION_FILL_SELECTED = "rgba(14,165,233,0.16)";

/** Unit direction of an infinite entity's defining pair. */
function infiniteDir(g: Extract<Geom, { type: "ray" } | { type: "xline" }>): Pt {
  const dx = g.x2 - g.x1;
  const dy = g.y2 - g.y1;
  const l = Math.hypot(dx, dy);
  if (l <= 1e-9) return { x: 1, y: 0 };
  return { x: dx / l, y: dy / l };
}

/** Clip an infinite line (through `base` along unit `dir`) to the visible
 *  world rectangle (Liang–Barsky). `halfLine` clamps t ≥ 0 (RAY). Returns
 *  null when no part is visible. Deterministic. */
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

/** The visible world rectangle for a pan/zoom view over a w×h viewport. */
export function visibleWorldRect(
  pan: { readonly x: number; readonly y: number },
  zoom: number,
  viewport: { readonly w: number; readonly h: number },
): WorldRect {
  return {
    minX: pan.x,
    minY: pan.y,
    maxX: pan.x + viewport.w / zoom,
    maxY: pan.y + viewport.h / zoom,
  };
}

/** Paint one canonical Geom with the given stroke (shared by entity
 *  rendering, hover emphasis and command previews). */
function paintGeom(
  ctx: CanvasRenderingContext2D,
  g: Geom,
  style: GeomStroke,
  toScreen: (p: Vec2) => [number, number],
  zoom: number,
  viewport: { readonly w: number; readonly h: number },
): void {
  const s = (p: Pt): [number, number] => toScreen([p.x, p.y]);
  ctx.save();
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = style.lineWidth;
  ctx.setLineDash(style.dash ?? []);
  if (style.fill !== null) ctx.fillStyle = style.fill;

  switch (g.type) {
    case "line": {
      const a = s({ x: g.x1, y: g.y1 });
      const b = s({ x: g.x2, y: g.y2 });
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      break;
    }
    case "polyline": {
      if (g.vertices.length === 0) break;
      ctx.beginPath();
      const first = s(g.vertices[0]!);
      ctx.moveTo(first[0], first[1]);
      for (let i = 1; i < g.vertices.length; i++) {
        const p = s(g.vertices[i]!);
        ctx.lineTo(p[0], p[1]);
      }
      if (g.closed) ctx.closePath();
      if (style.fill !== null) ctx.fill();
      ctx.stroke();
      break;
    }
    case "circle": {
      const c = s({ x: g.cx, y: g.cy });
      if (g.r * zoom < 0.5) break;
      ctx.beginPath();
      ctx.arc(c[0], c[1], g.r * zoom, 0, TAU);
      if (style.fill !== null) ctx.fill();
      ctx.stroke();
      break;
    }
    case "arc": {
      const c = s({ x: g.cx, y: g.cy });
      // World angles are y-up; the canvas y axis points down — negate the
      // angles and sweep backwards so the arc mirrors correctly.
      const sweep = arcSweep(g);
      ctx.beginPath();
      ctx.arc(c[0], c[1], g.r * zoom, -g.startAngle, -(g.startAngle + sweep), true);
      ctx.stroke();
      break;
    }
    case "ellipse": {
      const c = s({ x: g.cx, y: g.cy });
      ctx.beginPath();
      // Negate the rotation: the canvas y axis points down.
      ctx.ellipse(c[0], c[1], g.rx * zoom, g.ry * zoom, -g.rotation, 0, TAU);
      if (style.fill !== null) ctx.fill();
      ctx.stroke();
      break;
    }
    case "spline": {
      const pts = sampleSpline(g, 32);
      if (pts.length < 2) break;
      ctx.beginPath();
      const first = s(pts[0]!);
      ctx.moveTo(first[0], first[1]);
      for (let i = 1; i < pts.length; i++) {
        const p = s(pts[i]!);
        ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();
      break;
    }
    case "point": {
      const p = s({ x: g.x, y: g.y });
      ctx.beginPath();
      ctx.moveTo(p[0] - 3, p[1]);
      ctx.lineTo(p[0] + 3, p[1]);
      ctx.moveTo(p[0], p[1] - 3);
      ctx.lineTo(p[0], p[1] + 3);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p[0], p[1], 1.5, 0, TAU);
      ctx.fillStyle = style.stroke;
      ctx.fill();
      break;
    }
    case "ray":
    case "xline": {
      const rect = visibleWorldRectFromTransform(toScreen, zoom, viewport);
      const seg = clipInfinite({ x: g.x1, y: g.y1 }, infiniteDir(g), rect, g.type === "ray");
      if (seg === null) break;
      const a = s(seg[0]);
      const b = s(seg[1]);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
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
      paintGeom(ctx, boundary, style, toScreen, zoom, viewport);
      // Centroid marker (small cross).
      const c = s(g.centroid);
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(c[0] - 4, c[1]);
      ctx.lineTo(c[0] + 4, c[1]);
      ctx.moveTo(c[0], c[1] - 4);
      ctx.lineTo(c[0], c[1] + 4);
      ctx.stroke();
      ctx.restore();
      break;
    }
  }
  ctx.restore();
}

/** Reconstruct the visible world rect from the screen transform (the pan
 *  origin is the screen (0, h) corner because the canvas flips Y). */
function visibleWorldRectFromTransform(
  toScreen: (p: Vec2) => [number, number],
  zoom: number,
  viewport: { readonly w: number; readonly h: number },
): WorldRect {
  const origin = toScreen([0, 0]);
  return {
    minX: -origin[0] / zoom,
    minY: -(viewport.h - origin[1]) / zoom,
    maxX: (viewport.w - origin[0]) / zoom,
    maxY: origin[1] / zoom,
  };
}

/** Draw a canonical CAD-PARITY-003 entity (any drafting element decoded
 *  through the geometry bridge — BOTH storage conventions). Professional
 *  conventions: rays draw thin, construction lines thin + dashed, regions
 *  fill translucent with a stroked boundary, points draw as small crosses. */
export function drawCanonicalEntity(ctx: CanvasRenderingContext2D, geom: Geom, opts: GeomDrawOptions): void {
  const { color, selected, toScreen, zoom, viewport } = opts;
  const isConstruction = geom.type === "ray" || geom.type === "xline";
  const baseWidth = selected ? 1.8 : isConstruction ? 0.8 : 1;
  const style: GeomStroke = {
    stroke: selected ? SELECTED_STROKE : color,
    lineWidth: Math.max(isConstruction ? 0.75 : 1, baseWidth * Math.min(2, zoom)),
    dash: geom.type === "xline" ? [6, 4] : null,
    fill:
      geom.type === "region"
        ? selected
          ? REGION_FILL_SELECTED
          : REGION_FILL
        : null,
  };
  paintGeom(ctx, geom, style, toScreen, zoom, viewport);
}

/** Emphasize an entity (hover highlight before a pick, or a picked target
 *  during FILLET/CHAMFER/BREAK): a thicker amber stroke over the geometry. */
export function drawGeomEmphasis(
  ctx: CanvasRenderingContext2D,
  geom: Geom,
  opts: { readonly toScreen: (p: Vec2) => [number, number]; readonly zoom: number; readonly viewport: { readonly w: number; readonly h: number } },
): void {
  paintGeom(
    ctx,
    geom,
    {
      stroke: PREVIEW_AMBER,
      lineWidth: Math.max(2.5, 2.2 * Math.min(2, opts.zoom)),
      dash: null,
      fill: geom.type === "region" ? "rgba(245,158,11,0.14)" : null,
    },
    opts.toScreen,
    opts.zoom,
    opts.viewport,
  );
}

// ---------------------------------------------------------------------------
// Drafting entities (COMPAT-CAD-001 rendering, unchanged semantics).
// ---------------------------------------------------------------------------

export function drawEntity(
  ctx: CanvasRenderingContext2D,
  entity: DraftEntity,
  opts: { color: string; selected: boolean; toScreen: (p: Vec2) => [number, number]; zoom: number },
): void {
  const { color, selected, toScreen, zoom } = opts;
  ctx.strokeStyle = selected ? "#0ea5e9" : color;
  ctx.lineWidth = Math.max(1, (selected ? 1.8 : 1) * Math.min(2, zoom));
  if (entity.type === "line") {
    const a = toScreen(entity.from);
    const b = toScreen(entity.to);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    return;
  }
  if (entity.type === "polyline") {
    if (entity.points.length === 0) return;
    ctx.beginPath();
    const first = toScreen(entity.points[0] as Vec2);
    ctx.moveTo(first[0], first[1]);
    for (let i = 1; i < entity.points.length; i++) {
      const p = toScreen(entity.points[i] as Vec2);
      ctx.lineTo(p[0], p[1]);
    }
    if (entity.closed) ctx.closePath();
    ctx.stroke();
    return;
  }
  if (entity.type === "circle") {
    const c = toScreen(entity.center);
    ctx.beginPath();
    ctx.arc(c[0], c[1], entity.radius * zoom, 0, 2 * Math.PI);
    ctx.stroke();
    return;
  }
  if (entity.type === "arc") {
    const c = toScreen(entity.center);
    const sweep = entity.endAngle - entity.startAngle;
    ctx.beginPath();
    ctx.arc(c[0], c[1], entity.radius * zoom, entity.startAngle, entity.startAngle + sweep);
    ctx.stroke();
    return;
  }
  if (entity.type === "rectangle") {
    const a = toScreen(entity.corner1);
    const b = toScreen(entity.corner2);
    ctx.strokeRect(
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.abs(b[0] - a[0]),
      Math.abs(b[1] - a[1]),
    );
    return;
  }
  if (entity.type === "dim-linear") {
    const a = toScreen(entity.p1);
    const b = toScreen(entity.p2);
    const dx = entity.p2[0] - entity.p1[0];
    const dy = entity.p2[1] - entity.p1[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const off = entity.offset;
    const a2 = toScreen([entity.p1[0] + nx * off, entity.p1[1] + ny * off]);
    const b2 = toScreen([entity.p2[0] + nx * off, entity.p2[1] + ny * off]);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(a2[0], a2[1]);
    ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b2[0], b2[1]);
    ctx.moveTo(a2[0], a2[1]);
    ctx.lineTo(b2[0], b2[1]);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = "11px ui-monospace, monospace";
    const mid: [number, number] = [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2];
    ctx.fillText(`${entity.measured.toFixed(1)}`, mid[0] + 4, mid[1] - 4);
    return;
  }
  if (entity.type === "dim-radius") {
    // Radius dims annotate their target (no own geometry) — the label
    // renders in the annotation corner exactly like the COMPAT-CAD-001
    // workbench did (same visual semantics).
    ctx.lineWidth = 1;
    ctx.fillStyle = "#374151";
    ctx.font = "12px ui-monospace, monospace";
    ctx.fillText(`R${entity.measured.toFixed(2)} → ${entity.target}`, 8, 16);
    return;
  }
}

// ---------------------------------------------------------------------------
// BIM plan footprints.
// ---------------------------------------------------------------------------

function isBimType(el: Element, type: string): boolean {
  const props = el.props as Record<string, unknown>;
  return el.kind === "bim" && props.type === type;
}

export function drawBimPlanElement(
  ctx: CanvasRenderingContext2D,
  el: Element,
  opts: { selected: boolean; toScreen: (p: Vec2) => [number, number]; zoom: number },
): void {
  const props = el.props as Record<string, unknown>;
  const { selected, toScreen, zoom } = opts;

  if (isBimType(el, "bim.wall")) {
    const start = props.start as Vec2 | undefined;
    const end = props.end as Vec2 | undefined;
    const width = props.width as number | undefined;
    if (!Array.isArray(start) || !Array.isArray(end) || typeof width !== "number") return;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const half = width / 2;
    const corners: Vec2[] = [
      [start[0] + nx * half, start[1] + ny * half],
      [end[0] + nx * half, end[1] + ny * half],
      [end[0] - nx * half, end[1] - ny * half],
      [start[0] - nx * half, start[1] - ny * half],
    ];
    const pts = corners.map(toScreen);
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
    ctx.closePath();
    ctx.fillStyle = selected ? "rgba(14,165,233,0.25)" : "rgba(120,113,108,0.18)";
    ctx.fill();
    ctx.strokeStyle = selected ? "#0ea5e9" : "#57534e";
    ctx.lineWidth = Math.max(1, (selected ? 1.8 : 1) * Math.min(2, zoom));
    ctx.stroke();
    return;
  }

  if (isBimType(el, "bim.slab")) {
    const corner1 = props.corner1 as Vec2 | undefined;
    const corner2 = props.corner2 as Vec2 | undefined;
    if (!Array.isArray(corner1) || !Array.isArray(corner2)) return;
    const a = toScreen(corner1);
    const b = toScreen(corner2);
    ctx.fillStyle = selected ? "rgba(14,165,233,0.15)" : "rgba(161,98,7,0.10)";
    ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    ctx.strokeStyle = selected ? "#0ea5e9" : "#a16207";
    ctx.lineWidth = Math.max(1, (selected ? 1.8 : 1) * Math.min(2, zoom));
    ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    return;
  }
}

// ---------------------------------------------------------------------------
// Professional workspace overlays.
// ---------------------------------------------------------------------------

/** Full-viewport crosshair (AutoCAD-class) through the cursor position. */
export function drawCrosshair(ctx: CanvasRenderingContext2D, screen: [number, number], w: number, h: number): void {
  ctx.strokeStyle = "rgba(37,99,235,0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(screen[0], 0);
  ctx.lineTo(screen[0], h);
  ctx.moveTo(0, screen[1]);
  ctx.lineTo(w, screen[1]);
  ctx.stroke();
}

/** Snap marker at a snap point — mode-aware shapes in the professional
 *  osnap vocabulary (endpoint square, midpoint triangle, center circle,
 *  quadrant diamond, intersection/node crosses, …). The default keeps the
 *  CAD-PARITY-002 square marker. */
export function drawSnapMarker(
  ctx: CanvasRenderingContext2D,
  screen: [number, number],
  color = OSNAP_TEAL,
  mode: string | null = null,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  const r = 5;
  const x = screen[0];
  const y = screen[1];
  switch (mode) {
    case "midpoint":
      ctx.beginPath();
      ctx.moveTo(x - r, y + r * 0.7);
      ctx.lineTo(x, y - r);
      ctx.lineTo(x + r, y + r * 0.7);
      ctx.closePath();
      ctx.stroke();
      break;
    case "center":
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.stroke();
      break;
    case "quadrant":
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.stroke();
      break;
    case "intersection":
      ctx.beginPath();
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
      ctx.stroke();
      break;
    case "node":
      ctx.beginPath();
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
      ctx.moveTo(x - r, y);
      ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r);
      ctx.lineTo(x, y + r);
      ctx.stroke();
      break;
    default:
      // endpoint / unknown — the CAD-PARITY-002 square marker.
      ctx.strokeRect(x - r, y - r, r * 2, r * 2);
      break;
  }
  ctx.restore();
}

/** Rubber band from a base point to the (constrained) cursor. */
export function drawRubberBand(
  ctx: CanvasRenderingContext2D,
  from: Vec2,
  to: Vec2,
  toScreen: (p: Vec2) => [number, number],
  color = "#f59e0b",
): void {
  const a = toScreen(from);
  const b = toScreen(to);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Window (blue) / crossing (green) selection rectangle. */
export function drawSelectionRect(
  ctx: CanvasRenderingContext2D,
  a: [number, number],
  b: [number, number],
  mode: "window" | "crossing",
): void {
  ctx.strokeStyle = mode === "window" ? "#2563eb" : "#16a34a";
  ctx.fillStyle = mode === "window" ? "rgba(37,99,235,0.08)" : "rgba(22,163,74,0.08)";
  ctx.lineWidth = 1;
  ctx.setLineDash(mode === "crossing" ? [4, 3] : []);
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  const w = Math.abs(b[0] - a[0]);
  const h = Math.abs(b[1] - a[1]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
}

/** Grip squares for the selected entity. */
export function drawGrips(
  ctx: CanvasRenderingContext2D,
  grips: readonly GripHandle[],
  toScreen: (p: Vec2) => [number, number],
  hot: string | null,
): void {
  for (const grip of grips) {
    const s = toScreen(grip.point);
    const isHot = grip.id === hot;
    ctx.fillStyle = isHot ? "#f97316" : "#ffffff";
    ctx.strokeStyle = isHot ? "#c2410c" : "#2563eb";
    ctx.lineWidth = 1.25;
    ctx.fillRect(s[0] - 4, s[1] - 4, 8, 8);
    ctx.strokeRect(s[0] - 4, s[1] - 4, 8, 8);
  }
}

/** Pending polyline preview (collected vertices + cursor). */
export function drawPendingPolyline(
  ctx: CanvasRenderingContext2D,
  points: readonly Vec2[],
  cursor: Vec2 | null,
  toScreen: (p: Vec2) => [number, number],
): void {
  if (points.length === 0) return;
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  const first = toScreen(points[0] as Vec2);
  ctx.moveTo(first[0], first[1]);
  for (let i = 1; i < points.length; i++) {
    const p = toScreen(points[i] as Vec2);
    ctx.lineTo(p[0], p[1]);
  }
  if (cursor !== null) {
    const c = toScreen(cursor);
    ctx.lineTo(c[0], c[1]);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Grid (drafting settings aware). */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  opts: { size: number; pan: { x: number; y: number }; zoom: number; w: number; h: number; toScreen: (p: Vec2) => [number, number] },
): void {
  const { size, pan, zoom, w, h, toScreen } = opts;
  if (!(size > 0)) return;
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  const startX = Math.floor(pan.x / size) * size;
  const startY = Math.floor(pan.y / size) * size;
  ctx.beginPath();
  for (let x = startX; x <= pan.x + w / zoom; x += size) {
    const [sx] = toScreen([x, 0]);
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
  }
  for (let y = startY; y <= pan.y + h / zoom; y += size) {
    const [, sy] = toScreen([0, y]);
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
  }
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// CAD-PARITY-003 rubber-band command previews.
// ---------------------------------------------------------------------------

export interface CommandPreviewInput {
  readonly commandId: string;
  /** Values collected by the prompt engine so far. */
  readonly values: Readonly<Record<string, PromptValue>>;
  /** The (constrained + snapped) cursor point driving the preview. */
  readonly cursor: Vec2;
  /** Canonical geometry of the objects the running command will modify
   *  (collected object picks, or the current selection). */
  readonly targetGeoms: readonly Geom[];
  /** Canonical geometry lookup by element id (for picked-object emphasis). */
  readonly geomById: (id: string) => Geom | null;
  readonly toScreen: (p: Vec2) => [number, number];
  readonly zoom: number;
  readonly viewport: { readonly w: number; readonly h: number };
}

function pointOf(values: Readonly<Record<string, PromptValue>>, id: string): Pt | null {
  const v = values[id];
  return v !== undefined && v.kind === "point" ? { x: v.point[0], y: v.point[1] } : null;
}

function pointsOf(values: Readonly<Record<string, PromptValue>>, id: string): readonly Pt[] {
  const v = values[id];
  return v !== undefined && v.kind === "points" ? v.points.map((p) => ({ x: p[0], y: p[1] })) : [];
}

function entityIdsOf(values: Readonly<Record<string, PromptValue>>, id: string): readonly string[] {
  const v = values[id];
  return v !== undefined && v.kind === "entities" ? v.entities.map((e) => e.id) : [];
}

function entityPointIdsOf(values: Readonly<Record<string, PromptValue>>, id: string): readonly string[] {
  const v = values[id];
  return v !== undefined && v.kind === "entityPoints" ? v.picks.map((p) => p.entity.id) : [];
}

/** Live preview for the CAD-PARITY-003 commands — ghost geometry, axis
 *  lines, live entities and picked-object emphasis. Light strokes: dashed
 *  amber rubber lines + translucent blue ghosts. Deterministic per
 *  (command, values, cursor). */
export function drawCommandPreview(ctx: CanvasRenderingContext2D, input: CommandPreviewInput): void {
  const { commandId, values, toScreen, zoom, viewport } = input;
  const cursor: Pt = { x: input.cursor[0], y: input.cursor[1] };
  const rubber: GeomStroke = { stroke: PREVIEW_AMBER, lineWidth: 1.5, dash: [5, 4], fill: null };
  const ghost: GeomStroke = { stroke: GHOST_STROKE, lineWidth: 1.2, dash: [5, 4], fill: null };
  const drawLine = (a: Pt, b: Pt, style: GeomStroke): void => {
    paintGeom(ctx, { type: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y }, style, toScreen, zoom, viewport);
  };
  const drawInfinite = (a: Pt, b: Pt, style: GeomStroke): void => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy);
    if (l <= 1e-9) return;
    const rect = visibleWorldRectFromTransform(toScreen, zoom, viewport);
    const seg = clipInfinite(a, { x: dx / l, y: dy / l }, rect, false);
    if (seg === null) return;
    drawLine(seg[0], seg[1], style);
  };
  const drawGhost = (g: Geom): void => {
    paintGeom(ctx, g, ghost, toScreen, zoom, viewport);
  };
  const echo = (text: string): void => {
    const s = toScreen(input.cursor);
    ctx.save();
    ctx.fillStyle = "#b45309";
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(text, s[0] + 14, s[1] - 10);
    ctx.restore();
  };

  switch (commandId) {
    case "ellipse": {
      const center = pointOf(values, "center");
      if (center === null) break;
      const axisEnd = pointOf(values, "axisEnd");
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
      drawLine(center, axisEnd, { ...rubber, dash: null, lineWidth: 1 });
      if (ry > 1e-9) {
        drawGhost({ type: "ellipse", cx: center.x, cy: center.y, rx, ry, rotation: Math.atan2(axisY, axisX) });
      }
      break;
    }
    case "spline": {
      const start = pointOf(values, "start");
      const pts: Pt[] = [];
      if (start !== null) pts.push(start);
      pts.push(...pointsOf(values, "next"));
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
      const base = pointOf(values, "base");
      if (base === null) break;
      // Infinite dashed construction line through base → cursor.
      drawInfinite(base, cursor, rubber);
      break;
    }
    case "rotate": {
      const base = pointOf(values, "base");
      if (base === null) break;
      const dx = cursor.x - base.x;
      const dy = cursor.y - base.y;
      if (Math.hypot(dx, dy) <= 1e-9) break;
      const angle = Math.atan2(dy, dx);
      for (const g of input.targetGeoms) drawGhost(rotateGeom(g, base, angle));
      echo(`${(((angle * 180) / Math.PI + 360) % 360).toFixed(1)}°`);
      break;
    }
    case "scale": {
      const base = pointOf(values, "base");
      if (base === null) break;
      const factor = Math.hypot(cursor.x - base.x, cursor.y - base.y) / 100;
      if (factor > 1e-9) {
        for (const g of input.targetGeoms) drawGhost(scaleGeom(g, base, factor));
      }
      echo(`×${factor.toFixed(2)}`);
      break;
    }
    case "mirror": {
      const p1 = pointOf(values, "p1");
      if (p1 === null) break;
      const p2 = pointOf(values, "p2") ?? cursor;
      if (Math.hypot(p2.x - p1.x, p2.y - p1.y) <= 1e-9) break;
      // Mirror axis (dashed, extended to the viewport bounds).
      drawInfinite(p1, p2, rubber);
      for (const g of input.targetGeoms) drawGhost(mirrorGeom(g, p1, p2));
      break;
    }
    case "offset": {
      const ids = entityIdsOf(values, "object");
      const target = ids.length > 0 ? input.geomById(ids[0]!) : null;
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
      const c1 = pointOf(values, "corner1");
      if (c1 === null) break;
      // Crossing window while picking corners (dashed green).
      const a = toScreen([c1.x, c1.y]);
      const b = toScreen(input.cursor);
      ctx.save();
      ctx.strokeStyle = "#16a34a";
      ctx.fillStyle = "rgba(22,163,74,0.08)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      ctx.restore();
      break;
    }
    case "fillet":
    case "chamfer": {
      // Emphasize the first picked object while the second is selected.
      const ids = entityPointIdsOf(values, "first");
      const target = ids.length > 0 ? input.geomById(ids[0]!) : null;
      if (target !== null) drawGeomEmphasis(ctx, target, { toScreen, zoom, viewport });
      break;
    }
    case "break": {
      const ids = entityPointIdsOf(values, "object");
      const target = ids.length > 0 ? input.geomById(ids[0]!) : null;
      if (target !== null) drawGeomEmphasis(ctx, target, { toScreen, zoom, viewport });
      break;
    }
    default:
      break;
  }
}

export { parseDraftEntity };
