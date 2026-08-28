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
import type { CADDocumentSnapshot, Element, LayerRecord } from "@offisos/cad-app-shell/contracts/caddocument";
import type { Vec2 } from "@offisos/cad-app-shell/drafting/precision";
import { elementToDraftEntity, isDraftingElement, type DraftEntity } from "@offisos/cad-app-shell/drafting/entities";
import {
  IDLE_PROMPT_STATE,
  applyPromptEvent,
  describePrompt,
  effectiveStep,
  optionValue,
  type PromptEngineState,
} from "@offisos/cad-app-shell/workspace/prompt-engine";
// CAD-PARITY-003: the SAME shared precision engine the Web host renderer and
// the server-side precision queries run — parity by construction.
import {
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
import { GEOM_LABEL, type Geom } from "@offisos/cad-app-shell/workspace/geometry/types";
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
}

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
.pro-cmdline .history { max-height:110px; overflow-y:auto; padding:4px 12px; font-size:11px; color:var(--muted); line-height:1.45; }
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
.pro-ribbon-group { display:flex; flex-direction:column; gap:2px; }
.pro-ribbon-label { font-size:9px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); text-align:center; }
.pro-ribbon-buttons { display:flex; gap:2px; }
.pro-ribbon-tool { border:1px solid transparent; background:transparent; font-size:11px; padding:3px 7px; border-radius:4px; cursor:pointer; white-space:nowrap; }
.pro-ribbon-tool:hover { background:#f1f5f9; border-color:var(--border); }
.pro-props { position:absolute; top:8px; left:8px; z-index:15; max-width:280px; background:rgba(255,255,255,.96); border:1px solid var(--border); border-radius:6px; padding:6px 10px; font-size:11px; line-height:1.5; box-shadow:0 4px 12px rgba(15,23,42,.12); display:none; }
.pro-props .t { font-weight:700; margin-bottom:2px; }
.pro-props .row { display:flex; gap:10px; justify-content:space-between; }
.pro-props .row .k { color:var(--muted); }
.pro-props .row .v { font-family:ui-monospace,monospace; }
`;

/** Public driver surface (used by test/smoke-workspace.mjs — the SAME code
 *  paths the real input/canvas handlers use). */
export interface ProfessionalDriver {
  typedInput(text: string): Promise<void>;
  pressEnter(): Promise<void>;
  pressEscape(): Promise<void>;
  pickPoint(x: number, y: number): Promise<void>;
  setSelection(ids: string[]): Promise<void>;
  refresh(): Promise<void>;
  commandLog(): string[];
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

  // --- transport helpers -----------------------------------------------------

  const commandLog: string[] = [];
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
    if (!layers.some((l: LayerRecord) => l.id === state.activeLayer)) {
      state.activeLayer = layers[0]?.id ?? "0";
    }
    if (state.activeStoryId === null) {
      const story = (state.snapshot?.elements ?? []).find(
        (el) => el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.story",
      );
      if (story !== undefined) state.activeStoryId = story.id;
    }
    renderModel();
    renderCommandLine();
    renderStatusBar();
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
    });
  }

  async function executePlan(plan: CommandPlan): Promise<void> {
    for (const entry of plan.appApi) {
      state.busy = true;
      const res = await command(entry.name, entry.payload);
      if (!res.ok) {
        pushLines([`*ERROR* ${entry.name}: ${res.code} — ${res.message}`]);
      } else if (entry.name === "bim.createElements") {
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
        case "selection.clear":
          await command("document.setSelection", { ids: [] });
          state.selection = [];
          break;
        case "selection.selectAll": {
          const visible = new Set((state.snapshot?.layers ?? []).filter((l: LayerRecord) => l.visible).map((l: LayerRecord) => l.id));
          const ids = (state.snapshot?.elements ?? [])
            .filter((el) => {
              const props = el.props as Record<string, unknown>;
              if (el.kind === "bim") return props.type === "bim.wall" || props.type === "bim.slab";
              return typeof props.layer === "string" && visible.has(props.layer);
            })
            .map((el) => el.id);
          await command("document.setSelection", { ids });
          state.selection = ids;
          break;
        }
        case "file.new":
          await command("document.create", { entityId: `electron-workspace-${Date.now().toString(36)}` });
          state.activeStoryId = null;
          break;
        case "file.save": {
          const res = await command("document.save", {});
          if (res.ok) pushLines(["SAVE: document saved through the App API."]);
          break;
        }
        case "palette.show": {
          const palette = (action.payload as { palette?: string } | undefined)?.palette;
          if (palette === "search") openPalette(true);
          else if (palette === "layers" || palette === "navigator" || palette === "properties") {
            pushLines([`${palette.toUpperCase()} palette: available in the Web host dock; Electron keeps the legacy side panels.`]);
          }
          break;
        }
        default:
          break;
      }
    }
    await refresh();
  }

  function pushLines(lines: readonly string[]): void {
    state.history = [...state.history, ...lines];
  }

  async function dispatchEngine(event: Parameters<typeof applyPromptEvent>[1]): Promise<void> {
    const result = applyPromptEvent(state.engine, event, engineContext());
    state.engine = result.state;
    if (result.output.lines.length > 0) pushLines(result.output.lines);
    renderCommandLine();
    renderModel();
    if (result.output.plan !== null) await executePlan(result.output.plan);
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

  interface MenuSpec {
    label: string;
    items: readonly { label: string; run: () => void }[];
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
      ],
    },
    { label: "Insert", items: [{ label: "Door", run: runCmd("door") }, { label: "Window", run: runCmd("window") }, { label: "Slab", run: runCmd("slab") }] },
    { label: "Annotate", items: [{ label: "Linear dimension", run: runCmd("dimlinear") }, { label: "Radius dimension", run: runCmd("dimradius") }] },
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
    { label: "Annotate", ids: ["dimlinear", "dimradius"] },
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
      ],
    },
  ];
  for (const group of RIBBON_GROUPS) {
    const g = h("div", "pro-ribbon-group");
    const label = h("span", "pro-ribbon-label");
    label.textContent = group.label;
    const buttons = h("div", "pro-ribbon-buttons");
    for (const id of group.ids) {
      const tool = commandById(id);
      if (tool === null) continue;
      const b = h("button", "pro-ribbon-tool");
      b.type = "button";
      b.textContent = tool.label;
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
  const svg = svgNs("svg") as unknown as SVGSVGElement;
  svg.setAttribute("viewBox", `0 0 ${SVG_W} ${SVG_H}`);
  svg.setAttribute("role", "application");
  svg.setAttribute("aria-label", "Offisos Model viewport — 2D drafting and BIM plan canvas");
  svg.setAttribute("tabindex", "0");
  svg.setAttribute("data-testid", "pro-model-svg");
  modelBody.append(svg);
  modelCard.append(modelBody);
  opts.main.insertBefore(modelCard, opts.main.firstChild);

  const miniToolbar = h("div", "pro-mini");
  miniToolbar.style.display = "none";
  miniToolbar.setAttribute("role", "toolbar");
  miniToolbar.setAttribute("aria-label", "selection actions");
  modelBody.append(miniToolbar);

  // CAD-PARITY-003: canonical entity type/geometry readout for the single
  // selection (mirrors the Web PropertiesPanel canonical rows).
  const propsPanel = h("div", "pro-props");
  propsPanel.setAttribute("data-testid", "pro-properties");
  propsPanel.setAttribute("role", "region");
  propsPanel.setAttribute("aria-label", "selection properties");
  modelBody.append(propsPanel);
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

  // --- view transform ------------------------------------------------------------------

  const toScreen = (p: Vec2): [number, number] => [(p[0] - state.pan.x) * state.zoom, SVG_H - (p[1] - state.pan.y) * state.zoom];
  const toWorld = (sx: number, sy: number): Vec2 => [sx / state.zoom + state.pan.x, (SVG_H - sy) / state.zoom + state.pan.y];

  function zoomExtents(): void {
    const elements = state.snapshot?.elements ?? [];
    if (elements.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of elements) {
      const pts: Vec2[] = [];
      // CAD-PARITY-003: canonical bounds first (BOTH storage conventions
      // decode through the bridge); BIM footprints next; annotations
      // contribute no bounds (mirrors the Web host).
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
      for (const p of pts) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      }
    }
    if (!Number.isFinite(minX)) return;
    const pad = 800;
    const w = Math.max(maxX - minX + pad * 2, 1);
    const h = Math.max(maxY - minY + pad * 2, 1);
    state.zoom = Math.min(SVG_W / w, SVG_H / h);
    state.pan = { x: minX - pad - (SVG_W / state.zoom - w) / 2, y: minY - pad - (SVG_H / state.zoom - h) / 2 };
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

  // --- visible entities ------------------------------------------------------------------

  function visibleElements(): Element[] {
    const visible = new Set((state.snapshot?.layers ?? []).filter((l: LayerRecord) => l.visible).map((l: LayerRecord) => l.id));
    return (state.snapshot?.elements ?? []).filter((el) => {
      const props = el.props as Record<string, unknown>;
      if (el.kind === "bim") return props.type === "bim.wall" || props.type === "bim.slab";
      return typeof props.layer === "string" && visible.has(props.layer);
    });
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
   *  with the legacy hitTest (which also covers dimension annotations).
   *  Closest distance wins; ties break by element id. */
  function pickEntityAt(world: Vec2, geoms: readonly GeomEntity[], visible: readonly Element[]): { id: string; d: number } | null {
    const aperture = 8 / state.zoom;
    const probe = { x: world[0], y: world[1] };
    const canonical = pickAtGeom(geoms, probe, aperture);
    let canonicalBest: { id: string; d: number } | null = null;
    if (canonical !== null) {
      canonicalBest = { id: canonical.id, d: closestOn(canonical.geom, probe).d };
    }
    const legacyHits = hitTest(world, aperture, visible);
    const legacyBest = legacyHits.length > 0 ? { id: legacyHits[0]!.id, d: legacyHits[0]!.distance } : null;
    if (legacyBest === null) return canonicalBest;
    if (canonicalBest === null) return legacyBest;
    if (Math.abs(canonicalBest.d - legacyBest.d) <= 1e-12) {
      return canonicalBest.id < legacyBest.id ? canonicalBest : legacyBest;
    }
    return canonicalBest.d < legacyBest.d ? canonicalBest : legacyBest;
  }

  // --- canvas pointer interaction ------------------------------------------------------------

  let dragKind: "pan" | "selection" | null = null;
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

    // Grip drag start.
    const cmd = commandById(state.engine.commandId ?? "");
    const stepActive = cmd !== null && cmd.steps.length > 0;
    if (!stepActive && state.selection.length === 1) {
      const el = (state.snapshot?.elements ?? []).find((x) => x.id === state.selection[0]);
      if (el !== undefined) {
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
        }
        return; // miss: the prompt stays (the command line shows guidance)
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
        }
        return; // miss: the prompt stays
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
      const hits = hitTest(world, 8 / state.zoom, visible);
      if (hits.length > 0 && hits[0]!.id === picked.id) {
        // Legacy pickability — stacked-hit cycling preserved.
        const now = Date.now();
        let chosen = hits[0]!.id;
        let index = 0;
        if (lastClick !== null && now - lastClick.at < 700) {
          const cycled = cyclePick(world, 8 / state.zoom, visible, lastClick.index);
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
    if (dragKind === "selection" && selRect !== null) {
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
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    state.zoom = Math.min(20, Math.max(0.005, state.zoom * factor));
    renderModel();
  }, { passive: false });

  svg.addEventListener("dblclick", () => {
    void dispatchEngine({ type: "enter" });
  });

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
  }

  function styleGeomElement(node: SVGElement, style: GeomSvgStyle, fill: boolean): void {
    node.setAttribute("stroke", style.stroke);
    node.setAttribute("stroke-width", String(style.width));
    if (style.dash !== null) node.setAttribute("stroke-dasharray", style.dash.join(" "));
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
          m.setAttribute("stroke-opacity", "0.7");
          svg.append(m);
        }
        break;
      }
    }
  }

  /** Draw a canonical CAD-PARITY-003 entity (any drafting element decoded
   *  through the geometry bridge — BOTH storage conventions). Professional
   *  conventions mirror the Web host: rays draw thin, construction lines
   *  thin + dashed, regions fill translucent with a stroked boundary,
   *  points draw as small crosses. */
  function drawCanonicalEntity(geom: Geom, opts: { color: string; selected: boolean }): void {
    const isConstruction = geom.type === "ray" || geom.type === "xline";
    drawGeomSvg(geom, {
      stroke: opts.selected ? SELECTED_STROKE : opts.color,
      width: opts.selected ? 2.4 : isConstruction ? 1 : 1.6,
      dash: geom.type === "xline" ? [6, 4] : null,
      fill: geom.type === "region" ? (opts.selected ? REGION_FILL_SELECTED : REGION_FILL) : null,
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

    const visible = visibleElements();
    // CAD-PARITY-003: the canonical entity view over BOTH storage
    // conventions (the SAME module the server-side precision queries run).
    const geoms = toEntities(visible);
    const geomById = new Map<string, GeomEntity>(geoms.map((e) => [e.id, e] as const));

    for (const el of visible) {
      const selected = selectedSet.has(el.id);
      // CAD-PARITY-003: canonical geometry first — the SAME bridge painter
      // the Web host uses (ellipse/spline/point/ray/xline/region + the
      // classic types in BOTH conventions); annotations (dims) fall through
      // to the legacy painter below.
      const canonical = geomById.get(el.id);
      if (canonical !== undefined) {
        const layer = layerById.get(canonical.layer);
        drawCanonicalEntity(canonical.geom, {
          color: canonical.color ?? layer?.color ?? "#111827",
          selected,
        });
        continue;
      }
      const entity = parseEntity(el);
      if (entity !== null) {
        const layer = layerById.get(entity.layer);
        const color = selected ? "#0ea5e9" : (layer?.color ?? "#111827");
        const g = svgNs("g");
        g.setAttribute("stroke", color);
        g.setAttribute("fill", "none");
        g.setAttribute("stroke-width", selected ? "2.4" : "1.6");
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

    // Grips for the single selection.
    if (state.selection.length === 1) {
      const el = (state.snapshot?.elements ?? []).find((x) => x.id === state.selection[0]);
      if (el !== undefined) {
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

    renderProperties(geomById);
  }

  // --- CAD-PARITY-003 properties readout (mirrors the Web PropertiesPanel rows) ----------------

  function renderProperties(geomById: Map<string, GeomEntity>): void {
    while (propsPanel.firstChild) propsPanel.removeChild(propsPanel.firstChild);
    const el =
      state.selection.length === 1
        ? (state.snapshot?.elements ?? []).find((x) => x.id === state.selection[0])
        : undefined;
    if (el === undefined) {
      propsPanel.style.display = "none";
      return;
    }
    const p = el.props as Record<string, unknown>;
    const canonical = geomById.get(el.id)?.geom ?? null;
    const num = (v: number): string => String(Number(v.toFixed(3)));
    const row = (k: string, v: string): void => {
      const d = h("div", "row");
      const kEl = h("span", "k");
      kEl.textContent = k;
      const vEl = h("span", "v");
      vEl.textContent = v;
      d.append(kEl, vEl);
      propsPanel.append(d);
    };
    const title = h("div", "t");
    title.textContent =
      canonical !== null
        ? GEOM_LABEL[canonical.type]
        : typeof p.type === "string"
          ? p.type
          : el.kind;
    const idSpan = h("span");
    idSpan.textContent = ` · ${el.id}`;
    title.append(idSpan);
    propsPanel.append(title);
    if (typeof p.layer === "string") row("layer", p.layer);
    const g = canonical;
    if (g !== null) {
      switch (g.type) {
        case "ellipse":
          row("axes", `${num(g.rx)} × ${num(g.ry)}`);
          row("rotation", `${num((g.rotation * 180) / Math.PI)}°`);
          row("center", `${num(g.cx)}, ${num(g.cy)}`);
          break;
        case "spline":
          row("control points", String(g.controlPoints.length));
          row("degree", String(g.degree));
          break;
        case "point":
          row("position", `${num(g.x)}, ${num(g.y)}`);
          break;
        case "ray":
        case "xline": {
          const dirDeg = (Math.atan2(g.y2 - g.y1, g.x2 - g.x1) * 180) / Math.PI + 360;
          row("base", `${num(g.x1)}, ${num(g.y1)}`);
          row("through", `${num(g.x2)}, ${num(g.y2)}`);
          row("direction", `${num(dirDeg % 360)}°`);
          break;
        }
        case "region":
          row("boundary", g.boundary.kind);
          row("area", num(g.area));
          row("perimeter", num(g.perimeter));
          row("centroid", `${num(g.centroid.x)}, ${num(g.centroid.y)}`);
          break;
        case "line":
          row("from", `${num(g.x1)}, ${num(g.y1)}`);
          row("to", `${num(g.x2)}, ${num(g.y2)}`);
          break;
        case "circle":
          row("center", `${num(g.cx)}, ${num(g.cy)}`);
          row("radius", num(g.r));
          break;
        case "arc":
          row("center", `${num(g.cx)}, ${num(g.cy)}`);
          row("radius", num(g.r));
          row("sweep", `${num((((g.endAngle - g.startAngle) * 180) / Math.PI + 360) % 360)}°`);
          break;
        case "polyline":
          row("vertices", String(g.vertices.length));
          row("closed", g.closed ? "yes" : "no");
          break;
      }
    }
    propsPanel.style.display = "block";
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
  const info = h("span");
  info.style.marginLeft = "auto";
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
    const elements = state.snapshot?.elements ?? [];
    const story = elements.find((el) => el.id === state.activeStoryId);
    const storyName = story !== undefined ? ((story.props as Record<string, unknown>).name as string | undefined) ?? "—" : "—";
    info.textContent = `Layer ${state.activeLayer} · Story ${storyName} · Sel ${state.selection.length} · v${state.snapshot?.version?.version_number ?? 0} · ${settings?.units ?? "mm"}`;
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
    async setSelection(ids: string[]): Promise<void> {
      await command("document.setSelection", { ids });
      state.selection = [...ids];
      renderModel();
    },
    async refresh(): Promise<void> {
      await refresh();
    },
    commandLog(): string[] {
      return [...commandLog];
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
