/**
 * Entity transforms: move, rotate, scale, mirror (CAD-PARITY-003 modify
 * vocabulary). All operations are pure functions returning new geometry;
 * circles keep radius under move/rotate/mirror, scale multiplies radius,
 * arcs keep sweep under move/rotate/scale and reverse sweep under mirror,
 * regions transform their boundary + recomputed associative properties.
 */

import { mirrorPt, normAngle, Pt, rotatePt, scalePt, TAU } from "./math2d.js";
import { arcSweep } from "./entities.js";
import type { Geom, RegionGeom } from "./types.js";

export function moveGeom(g: Geom, dx: number, dy: number): Geom {
  const t = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy });
  switch (g.type) {
    case "line":
    case "ray":
    case "xline":
      return { ...g, x1: g.x1 + dx, y1: g.y1 + dy, x2: g.x2 + dx, y2: g.y2 + dy };
    case "polyline":
      return { ...g, vertices: g.vertices.map(t) };
    case "circle":
    case "arc":
    case "ellipse":
      return { ...g, cx: g.cx + dx, cy: g.cy + dy };
    case "spline":
      return { ...g, controlPoints: g.controlPoints.map(t) };
    case "point":
      return { ...g, x: g.x + dx, y: g.y + dy };
    case "region":
      return { ...g, ...transformRegion(g, (p) => ({ x: p.x + dx, y: p.y + dy }), 1) };
  }
}

export function rotateGeom(g: Geom, about: Pt, angle: number): Geom {
  const t = (p: Pt): Pt => rotatePt(p, about, angle);
  switch (g.type) {
    case "line":
    case "ray":
    case "xline": {
      const p1 = t({ x: g.x1, y: g.y1 });
      const p2 = t({ x: g.x2, y: g.y2 });
      return { ...g, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    }
    case "polyline":
      return { ...g, vertices: g.vertices.map(t) };
    case "circle":
      return { ...g, cx: t({ x: g.cx, y: g.cy }).x, cy: t({ x: g.cx, y: g.cy }).y };
    case "arc":
      return {
        ...g,
        cx: t({ x: g.cx, y: g.cy }).x,
        cy: t({ x: g.cx, y: g.cy }).y,
        startAngle: normAngle(g.startAngle + angle),
        endAngle: normAngle(g.startAngle + angle) + arcSweep(g),
      };
    case "ellipse":
      return {
        ...g,
        cx: t({ x: g.cx, y: g.cy }).x,
        cy: t({ x: g.cx, y: g.cy }).y,
        rotation: normAngle(g.rotation + angle),
      };
    case "spline":
      return { ...g, controlPoints: g.controlPoints.map(t) };
    case "point":
      return { ...g, ...t({ x: g.x, y: g.y }) };
    case "region":
      return { ...g, ...transformRegion(g, t, 1) };
  }
}

export function scaleGeom(g: Geom, about: Pt, factor: number): Geom {
  if (factor <= 0) throw new Error("scale factor must be positive");
  const t = (p: Pt): Pt => scalePt(p, about, factor);
  switch (g.type) {
    case "line":
    case "ray":
    case "xline": {
      const p1 = t({ x: g.x1, y: g.y1 });
      const p2 = t({ x: g.x2, y: g.y2 });
      return { ...g, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    }
    case "polyline":
      return { ...g, vertices: g.vertices.map(t) };
    case "circle":
      return { ...g, cx: t({ x: g.cx, y: g.cy }).x, cy: t({ x: g.cx, y: g.cy }).y, r: g.r * factor };
    case "arc":
      return {
        ...g,
        cx: t({ x: g.cx, y: g.cy }).x,
        cy: t({ x: g.cx, y: g.cy }).y,
        r: g.r * factor,
      };
    case "ellipse":
      return {
        ...g,
        cx: t({ x: g.cx, y: g.cy }).x,
        cy: t({ x: g.cx, y: g.cy }).y,
        rx: g.rx * factor,
        ry: g.ry * factor,
      };
    case "spline":
      return { ...g, controlPoints: g.controlPoints.map(t) };
    case "point":
      return { ...g, ...t({ x: g.x, y: g.y }) };
    case "region":
      return { ...g, ...transformRegion(g, t, factor) };
  }
}

export function mirrorGeom(g: Geom, a: Pt, b: Pt): Geom {
  const t = (p: Pt): Pt => mirrorPt(p, a, b);
  const axisAngle = Math.atan2(b.y - a.y, b.x - a.x);
  const reflect = (ang: number): number => normAngle(2 * axisAngle - ang);
  switch (g.type) {
    case "line":
    case "ray":
    case "xline": {
      const p1 = t({ x: g.x1, y: g.y1 });
      const p2 = t({ x: g.x2, y: g.y2 });
      return { ...g, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    }
    case "polyline":
      return { ...g, vertices: g.vertices.map(t) };
    case "circle":
      return { ...g, cx: t({ x: g.cx, y: g.cy }).x, cy: t({ x: g.cx, y: g.cy }).y };
    case "arc": {
      // Sweep direction reverses: swap reflected end angles.
      const ns = reflect(g.endAngle);
      const ne = reflect(g.startAngle);
      const sweep = normAngle(ne - ns);
      return {
        ...g,
        cx: t({ x: g.cx, y: g.cy }).x,
        cy: t({ x: g.cx, y: g.cy }).y,
        startAngle: ns,
        endAngle: ns + (sweep > 1e-12 ? sweep : TAU),
      };
    }
    case "ellipse":
      return {
        ...g,
        cx: t({ x: g.cx, y: g.cy }).x,
        cy: t({ x: g.cx, y: g.cy }).y,
        rotation: reflect(g.rotation),
      };
    case "spline":
      return { ...g, controlPoints: g.controlPoints.map(t) };
    case "point":
      return { ...g, ...t({ x: g.x, y: g.y }) };
    case "region":
      return { ...g, ...transformRegion(g, t, 1) };
  }
}

/** Transform a region boundary + recompute associative properties. */
function transformRegion(
  r: RegionGeom,
  t: (p: Pt) => Pt,
  scaleFactor: number,
): Pick<RegionGeom, "boundary" | "area" | "perimeter" | "centroid"> {
  const b = r.boundary;
  let boundary = r.boundary;
  if (b.kind === "circle") {
    const c = t({ x: b.cx, y: b.cy });
    boundary = { kind: "circle", cx: c.x, cy: c.y, r: b.r * scaleFactor };
  } else if (b.kind === "ellipse") {
    const c = t({ x: b.cx, y: b.cy });
    boundary = {
      kind: "ellipse",
      cx: c.x,
      cy: c.y,
      rx: b.rx * scaleFactor,
      ry: b.ry * scaleFactor,
      rotation: b.rotation,
    };
  } else {
    boundary = { kind: "polyline", vertices: b.vertices.map(t) };
  }
  const centroid = t(r.centroid);
  return {
    boundary,
    area: r.area * scaleFactor * scaleFactor,
    perimeter: r.perimeter * scaleFactor,
    centroid,
  };
}
