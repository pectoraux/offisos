/**
 * CAD-PARITY-012 command registry extension (Issue #102) — the components,
 * materials and coordination vocabulary.
 *
 * Commands:
 *  - MATERIAL — create a material record: name, category (the 8-value
 *    vocabulary, keyword shortcuts or the typed full name), optional color
 *    (#RRGGBB — the workspace color convention; Enter keeps the category
 *    default), optional lineweight (Enter keeps the 1.4 default). The record
 *    lands through ONE material.create revision (the bim createElement
 *    path — one undo entry).
 *  - MATSET (MSET) — assign a material to the picked objects (Enter
 *    completes the object set), or UNASSIGN (Enter on the name step). The
 *    name resolves through the CommandContext materials table — an unknown
 *    name is a typed failure echoed to the command line (nothing changes);
 *    the assignment itself is ONE material.assign batch (full-record
 *    rewrites, exact undo inverse).
 *  - CGRID (GRIDLINE) — create a bim.grid datum: optional name, then the
 *    u/v line offsets as comma-separated strictly-ascending numbers (Enter
 *    keeps the deterministic 2-line defaults). ONE grid.create revision
 *    with the full-set baseline grammar.
 *  - REVCLOUD — draw a revision cloud around two corner picks: the closed
 *    scalloped polyline with the bounded marker "revcloud" (markup — never
 *    clash-checked, never measured content).
 *  - MATLIST / BOM / CLASH — the report surfaces: minimal deterministic
 *    echo + the report ui action + the Coordination palette focus. The
 *    host intercepts the report actions and renders the real tables (the
 *    app-api queries materials.list / materials.bom / coordination.clash
 *    are the data source — the command line stays honest and short).
 *
 * Every command is pure data + a pure builder emitting App API commands —
 * the dispatch lives in app-api/contract.ts (server-side validation; the
 * document is the single authority). The SAME registry drives ribbon,
 * palette, keyboard and command line on BOTH hosts (LOCK-004).
 *
 * Name/alias discipline: CGRID (not GRID — GRID is the drafting-aid
 * toggle), MSET (not MA — MATCHPROP owns it).
 */

import type { Vec2 } from "../drafting/precision.js";
import type {
  AppApiCommandPlanEntry,
  CommandContext,
  CommandPlan,
  EntityPick,
  PromptStep,
  PromptValue,
} from "./types.js";
import { layerNameOrId } from "./types.js";
import type { WorkspaceCommand } from "./commands.js";
import { optionValue } from "./prompt-engine.js";
import {
  CATEGORY_DEFAULT_COLOR,
  DEFAULT_LINEWEIGHT,
  MATERIAL_CATEGORIES,
  type MaterialCategory,
} from "./materials.js";

// ---------------------------------------------------------------------------
// Local helpers (same conventions as commands.ts / commands-blocks.ts).
// ---------------------------------------------------------------------------

function plan(
  appApi: readonly AppApiCommandPlanEntry[],
  echo: readonly string[],
  ui: CommandPlan["ui"] = [],
): CommandPlan {
  return { appApi, ui, echo };
}

function pointValue(values: Readonly<Record<string, PromptValue>>, id: string): Vec2 {
  const v = values[id];
  if (v === undefined || v.kind !== "point") throw new Error(`command builder: step '${id}' has no point`);
  return v.point;
}

function entitiesValue(values: Readonly<Record<string, PromptValue>>, id: string): readonly EntityPick[] {
  const v = values[id];
  if (v === undefined || v.kind !== "entities") return [];
  return v.entities;
}

function textValue(values: Readonly<Record<string, PromptValue>>, id: string, fallback?: string): string | null {
  const v = values[id];
  if (v === undefined) return fallback !== undefined ? fallback : null;
  if (v.kind !== "text") return fallback !== undefined ? fallback : null;
  return v.text;
}

function numberValue(values: Readonly<Record<string, PromptValue>>, id: string, fallback: number): number {
  const v = values[id];
  if (v === undefined || v.kind !== "number") return fallback;
  return v.value;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

// ---------------------------------------------------------------------------
// The material category vocabulary as prompt options (keyword shortcuts —
// options win over command switching while the step runs, so CON/STL/… are
// unambiguous here).
// ---------------------------------------------------------------------------

const CATEGORY_KEYWORDS: Readonly<Record<MaterialCategory, string>> = {
  Concrete: "CON",
  Steel: "STL",
  Masonry: "MAS",
  Timber: "TIM",
  Glass: "GLA",
  Insulation: "INS",
  Finishes: "FIN",
  Generic: "GEN",
};

const CATEGORY_OPTIONS = MATERIAL_CATEGORIES.map((category) => ({
  keyword: CATEGORY_KEYWORDS[category],
  label: category,
  flag: true,
}));

/** Resolve the category step's collected value: a flag keyword wins, else
 *  the typed text (full category name), else the Generic default. Returns
 *  null when the typed text is not in the vocabulary (typed failure). */
function categoryOf(values: Readonly<Record<string, PromptValue>>): MaterialCategory | null {
  for (const category of MATERIAL_CATEGORIES) {
    if (optionValue(values, "category", CATEGORY_KEYWORDS[category]) !== null) return category;
  }
  const typed = textValue(values, "category", "Generic")!.trim();
  const match = MATERIAL_CATEGORIES.find(
    (c) => c.toLowerCase() === typed.toLowerCase(),
  );
  return match ?? null;
}

/** #RRGGBB → [r, g, b] (the workspace color convention, CHPROP-compatible). */
const HEX_COLOR = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/;

function hexToRgb(text: string): readonly [number, number, number] | null {
  const m = HEX_COLOR.exec(text.trim());
  if (m === null) return null;
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

/** Parse a comma-separated strictly-ascending offset list (the CGRID line
 *  grammar). Returns null on any violation (typed failure). */
function parseAscendingList(text: string, axis: "u" | "v"): number[] | null {
  const parts = text.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const values: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n)) return null;
    values.push(n);
  }
  for (let i = 1; i < values.length; i++) {
    if (values[i]! <= values[i - 1]!) return null;
  }
  void axis;
  return values;
}

// ---------------------------------------------------------------------------
// The CAD-PARITY-012 registry.
// ---------------------------------------------------------------------------

export const COMMANDS_COORDINATION: readonly WorkspaceCommand[] = [
  // --- MATERIAL — create a material record ----------------------------------
  {
    id: "material",
    name: "MATERIAL",
    aliases: [],
    label: "Material",
    description:
      "Create a material (name + category from the 8-value vocabulary Concrete/Steel/Masonry/Timber/Glass/Insulation/Finishes/Generic, optional #RRGGBB color and lineweight) — the assignment and bill-of-materials table entry.",
    category: "bim",
    ribbonTab: "Materials",
    steps: [
      { id: "name", kind: "text", prompt: "Material name:" },
      {
        id: "category",
        kind: "text",
        prompt:
          "Category [CONcrete/STL/Masonry/TImber/GLass/INsulation/FINishes/GENeric] <Generic>:",
        defaultValue: "Generic",
        options: CATEGORY_OPTIONS,
      },
      {
        id: "color",
        kind: "text",
        prompt: "Color #RRGGBB <category default>:",
        optional: true,
      },
      {
        id: "lineweight",
        kind: "number",
        prompt: "Lineweight (mm) <1.4>:",
        optional: true,
        defaultValue: DEFAULT_LINEWEIGHT,
      },
    ],
    build: (values, ctx) => {
      const name = textValue(values, "name")!.trim();
      if (name.length === 0) {
        throw new Error("MATERIAL requires a non-empty name (the document-unique exchange key).");
      }
      const category = categoryOf(values);
      if (category === null) {
        const typed = textValue(values, "category", "Generic")!.trim();
        throw new Error(
          `MATERIAL category '${typed}' is not in the vocabulary [${MATERIAL_CATEGORIES.join(", ")}].`,
        );
      }
      const payload: Record<string, unknown> = {
        name,
        category,
        lineweight: numberValue(values, "lineweight", DEFAULT_LINEWEIGHT),
      };
      const colorText = textValue(values, "color", "");
      const echo: string[] = [];
      if (colorText !== null && colorText.trim().length > 0) {
        const rgb = hexToRgb(colorText);
        if (rgb === null) {
          throw new Error(
            `MATERIAL color '${colorText.trim()}' must be #RRGGBB (the workspace color convention) — Enter keeps the category default.`,
          );
        }
        payload.color = [...rgb];
        echo.push(`color ${colorText.trim()}`);
      } else {
        const fallback = CATEGORY_DEFAULT_COLOR[category];
        payload.color = [...fallback];
        echo.push(`color category default (${fallback.join(",")})`);
      }
      void ctx;
      return plan(
        [{ name: "material.create", payload }],
        [`MATERIAL: '${name}' (${category}) — ${echo.join(", ")}.`],
      );
    },
  },

  // --- MATSET — assign / unassign materials on the picked objects -----------
  {
    id: "matset",
    name: "MATSET",
    aliases: ["MSET"],
    label: "Set material",
    description:
      "Assign a material to the selected objects (pick objects, Enter completes, then the material name) — Enter on the name step UNASSIGNS. Unknown names fail typed (nothing changes).",
    category: "bim",
    ribbonTab: "Materials",
    steps: [
      {
        id: "objects",
        kind: "entity",
        prompt: "Select objects:",
        optional: true,
        multiple: true,
        minInputs: 1,
      },
      {
        id: "material",
        kind: "text",
        prompt: "Material name (Enter = unassign):",
        optional: true,
      },
    ],
    build: (values, ctx) => {
      const objects = entitiesValue(values, "objects");
      if (objects.length === 0) {
        return plan([], ["MATSET: no objects selected — nothing changed."]);
      }
      const ids = objects.map((o) => o.id);
      const typed = textValue(values, "material", "");
      const name = typed !== null ? typed.trim() : "";
      if (name.length === 0) {
        return plan(
          [{ name: "material.assign", payload: { ids, materialId: null } }],
          [`MATSET: ${ids.length} object${ids.length === 1 ? "" : "s"} → (unassigned).`],
        );
      }
      const material = ctx.materials.find((m) => m.name === name);
      if (material === undefined) {
        return plan(
          [],
          [
            `MATSET: material '${name}' not found — MATERIAL creates one (the document materials table is the exchange key). Nothing changed.`,
          ],
        );
      }
      return plan(
        [{ name: "material.assign", payload: { ids, materialId: material.id } }],
        [`MATSET: ${ids.length} object${ids.length === 1 ? "" : "s"} → material '${name}'.`],
      );
    },
  },

  // --- CGRID — create a bim.grid datum ---------------------------------------
  {
    id: "cgrid",
    name: "CGRID",
    aliases: ["GRIDLINE"],
    label: "Grid",
    description:
      "Create a coordination grid datum (bim.grid): optional name, then the u/v line offsets as comma-separated strictly-ascending numbers (Enter keeps the 2-line defaults 0,6000 / 0,4000). Labels are derived (A,B,C… / 1,2,3…).",
    category: "bim",
    ribbonTab: "Coordination",
    steps: [
      { id: "name", kind: "text", prompt: "Grid name <Grid N+1>:", optional: true },
      {
        id: "uLines",
        kind: "text",
        prompt: "U grid line offsets, comma-separated ascending <0,6000>:",
        defaultValue: "0,6000",
      },
      {
        id: "vLines",
        kind: "text",
        prompt: "V grid line offsets, comma-separated ascending <0,4000>:",
        defaultValue: "0,4000",
      },
    ],
    build: (values, ctx) => {
      const typedName = textValue(values, "name", "");
      const name = typedName !== null ? typedName.trim() : "";
      const uText = textValue(values, "uLines", "0,6000")!;
      const vText = textValue(values, "vLines", "0,4000")!;
      const uLines = parseAscendingList(uText, "u");
      if (uLines === null) {
        throw new Error(
          `CGRID uLines '${uText.trim()}' must be comma-separated finite strictly-ascending offsets (duplicates are rejected).`,
        );
      }
      const vLines = parseAscendingList(vText, "v");
      if (vLines === null) {
        throw new Error(
          `CGRID vLines '${vText.trim()}' must be comma-separated finite strictly-ascending offsets (duplicates are rejected).`,
        );
      }
      const payload: Record<string, unknown> = { uLines, vLines };
      if (name.length > 0) payload.name = name;
      if (ctx.activeStoryId !== null) payload.storyId = ctx.activeStoryId;
      return plan(
        [{ name: "grid.create", payload }],
        [
          `CGRID: ${name.length > 0 ? `'${name}'` : "(default name)"} — u [${uLines.map(trimNum).join(", ")}] × v [${vLines.map(trimNum).join(", ")}].`,
        ],
      );
    },
  },

  // --- REVCLOUD — the revision markup ----------------------------------------
  {
    id: "revcloud",
    name: "REVCLOUD",
    aliases: ["RVC"],
    label: "Revision cloud",
    description:
      "Draw a revision cloud around two corner picks: the closed scalloped polyline (deterministic sampling) with the bounded marker 'revcloud' — markup, never clash-checked or measured.",
    category: "draw",
    ribbonTab: "Coordination",
    steps: [
      { id: "cornerA", kind: "point", prompt: "Specify first corner of the revision cloud:" },
      { id: "cornerB", kind: "point", prompt: "Specify opposite corner:" },
    ],
    build: (values, ctx) => {
      const a = pointValue(values, "cornerA");
      const b = pointValue(values, "cornerB");
      if (a[0] === b[0] || a[1] === b[1]) {
        throw new Error(
          "REVCLOUD corners must span a non-degenerate rectangle (zero width or height has no edge to scallop).",
        );
      }
      return plan(
        [
          {
            name: "revcloud.create",
            payload: {
              cornerA: { x: a[0], y: a[1] },
              cornerB: { x: b[0], y: b[1] },
              layer: ctx.activeLayer,
            },
          },
        ],
        [`REVCLOUD: (${trimNum(a[0])},${trimNum(a[1])}) → (${trimNum(b[0])},${trimNum(b[1])}) on layer '${layerNameOrId(ctx, ctx.activeLayer)}'.`],
      );
    },
  },

  // --- The report surfaces (host-intercepted ui actions) ---------------------
  {
    id: "matlist",
    name: "MATLIST",
    aliases: [],
    label: "Material list",
    description:
      "List the material table (name, category, lineweight, assigned usage) in the Coordination palette — the report action renders the live query result.",
    category: "view",
    ribbonTab: "Materials",
    steps: [],
    instant: () =>
      plan([], ["MATLIST."], [{ action: "report.matlist" }, { action: "palette.show", payload: { palette: "coordination" } }]),
  },
  {
    id: "bom",
    name: "BOM",
    aliases: ["BOQ"],
    label: "Bill of materials",
    description:
      "Open the bill of materials (the deterministic quantity takeoff over the concrete 2D view — count, length, area per material; unassigned last) in the Coordination palette.",
    category: "view",
    ribbonTab: "Coordination",
    steps: [],
    instant: () =>
      plan([], ["BOM."], [{ action: "report.bom" }, { action: "palette.show", payload: { palette: "coordination" } }]),
  },
  {
    id: "clash",
    name: "CLASH",
    aliases: [],
    label: "Clash check",
    description:
      "Run the pairwise clash detection over the concrete 2D view (pairs, intersection points, checked/excluded counts) and show the result in the Coordination palette.",
    category: "view",
    ribbonTab: "Coordination",
    steps: [],
    instant: () =>
      plan([], ["CLASH."], [{ action: "report.clash" }, { action: "palette.show", payload: { palette: "coordination" } }]),
  },
];
