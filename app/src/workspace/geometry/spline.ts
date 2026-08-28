/**
 * Clamped uniform B-spline evaluation (CAD-PARITY-003 SPLINE support).
 *
 * The 2D SPLINE entity stores control points and a degree; the curve is the
 * clamped B-spline over the uniform knot vector [0..1]. Evaluation uses the
 * de Boor algorithm — exact, deterministic, host-agnostic. This is an exact
 * evaluation of the stored control polygon (the classic SPLINE "control
 * points" method), not a fit-point interpolation; the distinction is surfaced
 * in the UI prompt.
 */

import type { Pt } from "./math2d.js";

/** Uniform clamped knot vector for n control points of degree p.
 *  Domain: t in [0, 1] (parameter range of the curve proper). */
export function knots(n: number, p: number): number[] {
  const m = n + p + 1; // knot count
  const inner = m - 2 * (p + 1); // interior knots
  const ks: number[] = [];
  for (let i = 0; i <= p; i++) ks.push(0);
  for (let i = 1; i <= inner; i++) ks.push(i / (inner + 1));
  for (let i = 0; i <= p; i++) ks.push(1);
  while (ks.length < m) ks.push(1);
  return ks;
}

/** Effective degree: min(requested, n-1), at least 1. */
export function effectiveDegree(n: number, requested: number): number {
  if (n <= 1) return 0;
  return Math.max(1, Math.min(requested, n - 1));
}

/** Evaluate the clamped B-spline at parameter t in [0,1] via de Boor. */
export function bsplinePoint(ctrl: readonly Pt[], degree: number, t: number): Pt {
  const n = ctrl.length;
  const p = effectiveDegree(n, degree);
  if (n === 0) return { x: 0, y: 0 };
  if (n === 1 || p === 0) return { ...ctrl[0]! };
  const ks = knots(n, p);
  // Clamp t into the valid domain.
  const tMin = ks[p]!;
  const tMax = ks[n]!;
  const tc = Math.min(Math.max(t, tMin), tMax);
  // Find knot span k such that ks[k] <= tc < ks[k+1], k in [p, n-1].
  let k = p;
  while (k < n - 1 && tc >= ks[k + 1]!) k++;
  // de Boor: d[j] = ctrl[k-p+j], then reduce.
  const d: Pt[] = [];
  for (let j = 0; j <= p; j++) {
    d.push({ ...ctrl[k - p + j]! });
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const a = (tc - ks[i]!) / (ks[i + p - r + 1]! - ks[i]! || 1);
      d[j] = {
        x: (1 - a) * d[j - 1]!.x + a * d[j]!.x,
        y: (1 - a) * d[j - 1]!.y + a * d[j]!.y,
      };
    }
  }
  return d[p]!;
}

/** Sample parameters t in [0,1], `perSegment * (n-1) + 1` values. */
export function bsplineSampleTs(n: number, degree: number, perSegment: number): number[] {
  if (n <= 1) return [0];
  const count = Math.max(2, perSegment * (n - 1));
  const ts: number[] = [];
  for (let i = 0; i <= count; i++) {
    ts.push(i / count);
  }
  return ts;
}

/** Deterministic polyline approximation of the spline (EXPLODE output +
 *  intersection approximation is NOT used — trim/extend report splines as
 *  unsupported rather than guessing, per LOCK-007). */
export function splineToPolyline(ctrl: readonly Pt[], degree: number, perSegment = 32): Pt[] {
  return bsplineSampleTs(ctrl.length, degree, perSegment).map((t) =>
    bsplinePoint(ctrl, degree, t),
  );
}
