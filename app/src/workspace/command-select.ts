/**
 * COMPAT-CAD-007 (Issue #142) — the shared command-phase selection core.
 *
 * DEF-006/DEF-021 (CAD-BENCH-RW-001): the deterministic object-selection
 * surface "Select objects:" prompts run on. Both hosts route their
 * command-select workflows through THIS module — Web and Electron must not
 * develop divergent semantic selection implementations (LOCK-004).
 *
 * Two responsibilities:
 *
 *  1. `selectableElements` — the deterministic ALL/LAST keyword resolution.
 *     The rule mirrors the canvas pick surface exactly (the same elements a
 *     click or a window drag could pick): drafting-marked entities
 *     (lines/polylines/circles/arcs/rectangles/blocks/xrefs/legacy dims),
 *     annotation elements, and bim.wall/bim.slab footprints — restricted to
 *     layers that are visible, unfrozen and unlocked. Absent layer tables
 *     resolve to "no selectable objects" (a typed outcome, never an
 *     approximation — no fabricated selections).
 *
 *  2. `commandWindowIds` + `toEntityPicks` — the window/crossing batch
 *     resolution for command select phases. This is the SAME three-way
 *     merge the idle canvas selection runs (legacy hit list + canonical
 *     drafting-core window select + annotation primitive select), so a
 *     window drawn during a command captures exactly the objects the same
 *     window captures in idle selection mode, on both hosts.
 *
 * Engine-free, host-free (LOCK-003/018). Deterministic: the same elements
 * and rect produce the same id list on every host, every run.
 */

import type { Element, LayerRecord } from "../contracts/caddocument.js";
import { isDraftingElement } from "../drafting/entities.js";
import { selectionRectangle, windowSelect, type SelectionRectangle } from "./selection.js";
import { selectWindow, type Entity as GeomEntity } from "./precision-2d.js";
import { selectAnnotations } from "./annotation/pick.js";
import type { AnnotationStyleContext } from "./annotation/render.js";
import type { EntityPick } from "./types.js";

// ---------------------------------------------------------------------------
// ALL/LAST keyword resolution (DEF-021).
// ---------------------------------------------------------------------------

function isInteractableLayerTable(layers: readonly LayerRecord[]): Set<string> {
  return new Set(layers.filter((l) => l.visible && l.frozen !== true && l.locked !== true).map((l) => l.id));
}

function isSelectableKind(el: Element): boolean {
  if (el.kind === "bim") {
    const props = el.props as Record<string, unknown>;
    return props.type === "bim.wall" || props.type === "bim.slab";
  }
  // Drafting-marked entities (incl. block/xref instances and legacy dims)
  // and annotation elements — the canvas pick surface kinds.
  if (el.kind === "annotation") {
    const props = el.props as Record<string, unknown>;
    return props.annotation === true || isDraftingElement(el);
  }
  return isDraftingElement(el);
}

/**
 * The deterministic ALL/LAST resolution surface: elements of selectable
 * kinds, on visible/unfrozen/unlocked layers, in DOCUMENT ORDER (the order
 * the snapshot provides — creation order). Empty when the layer table is
 * absent or excludes everything (typed outcome upstream, never a guess).
 */
export function selectableElements(
  elements: readonly Element[],
  layers: readonly LayerRecord[],
): readonly Element[] {
  const interactable = isInteractableLayerTable(layers);
  if (interactable.size === 0) return [];
  const out: Element[] = [];
  for (const el of elements) {
    const props = el.props as Record<string, unknown> | null;
    if (props === null || typeof props !== "object") continue;
    const layer = props.layer;
    if (typeof layer === "string" && interactable.has(layer) && isSelectableKind(el)) {
      out.push(el);
    }
  }
  return out;
}

/**
 * LAST semantics: the most recently created selectable object — the last
 * element in document order that passes the selectable filter.
 */
export function lastSelectableElement(
  elements: readonly Element[],
  layers: readonly LayerRecord[],
): Element | null {
  const selectable = selectableElements(elements, layers);
  return selectable.length > 0 ? selectable[selectable.length - 1]! : null;
}

// ---------------------------------------------------------------------------
// Window/crossing batch resolution for command select phases (DEF-006).
// ---------------------------------------------------------------------------

function rectAsPtSel(rect: SelectionRectangle): { readonly mode: "window" | "crossing"; readonly min: { x: number; y: number }; readonly max: { x: number; y: number } } {
  return { mode: rect.mode, min: { x: rect.min[0], y: rect.min[1] }, max: { x: rect.max[0], y: rect.max[1] } };
}

/**
 * The merged window/crossing id resolution for a command select phase —
 * the exact three-way merge the idle canvas selection runs (windowSelect
 * document-order base + canonical drafting-core selectWindow + annotation
 * primitive selectAnnotations, deduped, first occurrence order). Both
 * hosts feed the SAME visible-elements list their click pick uses, so the
 * command-phase window captures the same objects as idle selection.
 */
export function commandWindowIds(
  rect: SelectionRectangle,
  elements: readonly Element[],
  geomEntities: readonly GeomEntity[],
  annotationCtx: AnnotationStyleContext,
): readonly string[] {
  const ids: string[] = [...windowSelect(rect, elements)];
  const sel = rectAsPtSel(rect);
  for (const id of selectWindow(geomEntities, sel)) {
    if (!ids.includes(id)) ids.push(id);
  }
  for (const id of selectAnnotations(elements, sel, annotationCtx)) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Map resolved ids back to EntityPick records (document-order elements). */
export function toEntityPicks(elements: readonly Element[], ids: readonly string[]): readonly EntityPick[] {
  const byId = new Map(elements.map((el) => [el.id, el] as const));
  const out: EntityPick[] = [];
  for (const id of ids) {
    const el = byId.get(id);
    if (el !== undefined) {
      out.push({ id: el.id, kind: el.kind, props: el.props as Record<string, unknown> });
    }
  }
  return out;
}

/** Convenience: the full batch resolution for a host drag (rect → picks). */
export function commandWindowPicks(
  a: readonly [number, number],
  b: readonly [number, number],
  elements: readonly Element[],
  geomEntities: readonly GeomEntity[],
  annotationCtx: AnnotationStyleContext,
): readonly EntityPick[] {
  const rect = selectionRectangle([a[0], a[1]], [b[0], b[1]]);
  return toEntityPicks(elements, commandWindowIds(rect, elements, geomEntities, annotationCtx));
}
