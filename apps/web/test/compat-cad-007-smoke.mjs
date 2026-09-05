// COMPAT-CAD-007 / Issue #142: Web host command-phase selection/option smoke.
//
// Drives the EXACT App API + shared-prompt-engine command stream the
// professional workspace UI produces for the CAD-BENCH-RW-001
// selection/editing flows against the running dev server, asserting:
//   1. the DEF-007 full-word option stream (LINE 'Undo', POLYLINE 'Close')
//      never cancels the running command (no *Cancel*, no UNDO command);
//   2. the DEF-021 select-phase keywords (ALL/LAST/PREVIOUS) resolve
//      INSIDE the running command — plans carry the selectable set and
//      never the SELECTALL escape;
//   3. the DEF-006 entities batch (the window/crossing drag semantic
//      stream) collects with "N found" echoes and commits ONE canonical
//      revision per mutating command through the REAL transport;
//   4. the negative probes: collection events mutate NOTHING before the
//      commit; UNDO restores the exact prior content.
//
// Reproduce: cd <repo>/apps/web && npm run dev -- -p 3100 &
//            then: node --import tsx apps/web/test/compat-cad-007-smoke.mjs
//            (OFFISOS_WEB_URL overrides the base URL, default :3100)

import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

const BASE = process.env.OFFISOS_WEB_URL ?? "http://localhost:3100";

const { runCommandScript } = await import(join(REPO_ROOT, "app", "src", "workspace", "prompt-engine.ts"));
const { defaultCommandContext } = await import(join(REPO_ROOT, "app", "src", "workspace", "types.ts"));

async function send(body) {
  const res = await fetch(`${BASE}/api/cad`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api: "1", body }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const cmd = (name, payload) => send({ type: "command", name, payload });
const q = (name, payload) => send({ type: "query", name, payload });
const ok = (r) => r.ok === true;
const val = (r) => {
  if (!ok(r)) throw new Error(JSON.stringify(r).slice(0, 400));
  return r.value;
};

const step = (name) => console.log(`COMPAT-CAD-007 SMOKE: ${name}`);
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

// ---------------------------------------------------------------------------
step("page render");
const page = await fetch(`${BASE}/`);
assert(page.status === 200, "GET / must be 200");
const html = await page.text();
assert(/Offisos/i.test(html), "the page must render the Offisos workspace shell");

// ---------------------------------------------------------------------------
step("fresh document + the G1 floor-plan slice (3 walls + a circle)");
await cmd("document.create", {});
const created = val(
  await cmd("drafting.createEntities", {
    entities: [
      { type: "line", layer: "0", from: [0, 0], to: [300, 0] },
      { type: "line", layer: "0", from: [0, 120], to: [300, 120] },
      { type: "line", layer: "0", from: [0, 0], to: [0, 120] },
      { type: "circle", layer: "0", center: [150, 60], radius: 40 },
    ],
  }),
);
assert(Array.isArray(created.created) && created.created.length === 4, "the floor-plan slice committed");

const snapshotOf = async () => {
  const snap = val(await q("document.getState", {}));
  return {
    elements: snap.elements ?? [],
    version: snap.version?.version_number,
    layers: snap.layers ?? [],
  };
};
const ctxOf = async (extra = {}) => {
  const snap = await snapshotOf();
  return defaultCommandContext({
    activeLayer: "0",
    documentElements: snap.elements,
    layers: snap.layers,
    elementCount: snap.elements.length,
    ...extra,
  });
};
const picksOf = (elements) => elements.map((el) => ({ id: el.id, kind: el.kind, props: el.props }));

// ---------------------------------------------------------------------------
step("DEF-007: LINE 'Undo' (full word) — the option path, never the UNDO command");
{
  const plans = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "LINE" } },
      { event: { type: "pick", point: [0, 200] } },
      { event: { type: "pick", point: [300, 200] } },
      { event: { type: "pick", point: [300, 320] } },
      { event: { type: "typed", text: "Undo" } },
    ],
    await ctxOf(),
    (plan) => plans.push(plan),
  );
  assert(lines.includes("Undo one segment."), `the full-word Undo ran the option (got: ${lines.join(" | ")})`);
  assert(!lines.includes("*Cancel*"), "the full word never cancels LINE");
  assert(
    plans.length === 3 && plans[2].appApi[0].name === "document.undo",
    "the segment plans + the option's document.undo plan",
  );
}

// ---------------------------------------------------------------------------
step("DEF-007: POLYLINE 'Close' (full word) closes the polyline");
{
  const plans = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "POLYLINE" } },
      { event: { type: "pick", point: [0, 400] } },
      { event: { type: "pick", point: [300, 400] } },
      { event: { type: "typed", text: "Close" } },
    ],
    await ctxOf(),
    (plan) => plans.push(plan),
  );
  assert(lines.includes("Close."), "the Close option echo");
  const entity = plans[0].appApi[0].payload.entities[0];
  assert(entity.closed === true, "the closed flag lands on the canonical entity");
}

// ---------------------------------------------------------------------------
step("DEF-021: ERASE 'ALL' — one revision through the REAL transport, UNDO restores");
{
  const before = await snapshotOf();
  const plans = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "ERASE" } },
      { event: { type: "typed", text: "ALL" } },
      { event: { type: "enter" } },
    ],
    await ctxOf(),
    (plan) => plans.push(plan),
  );
  assert(lines.includes("4 found (all objects)"), `ALL collected the live set (got: ${lines.join(" | ")})`);
  assert(!lines.includes("*Cancel*"), "typed ALL never cancels ERASE");
  assert(plans.length === 1 && plans[0].appApi.length === 1, "one plan, one mutation entry");
  for (const entry of plans[0].appApi) val(await cmd(entry.name, entry.payload));
  const after = await snapshotOf();
  assert(after.elements.length === 0, `everything erased (got ${after.elements.length})`);
  assert(after.version === before.version + 1, `exactly ONE revision (v${before.version} → v${after.version})`);
  val(await cmd("document.undo", {}));
  const undone = await snapshotOf();
  assert(undone.elements.length === 4, `UNDO restored the exact prior content (got ${undone.elements.length})`);
}

// ---------------------------------------------------------------------------
step("DEF-006: the entities batch — window drag semantic stream, ONE revision");
{
  const before = await snapshotOf();
  const elements = before.elements;
  const batch1 = picksOf(elements.slice(0, 2));
  const batch2 = picksOf(elements.slice(2, 3));
  const plans = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "ERASE" } },
      { event: { type: "entities", entities: batch1 } },
      { event: { type: "entities", entities: batch2 } },
      { event: { type: "enter" } },
    ],
    await ctxOf(),
    (plan) => plans.push(plan),
  );
  assert(
    lines.some((l) => /^2 found$/.test(l.trim())) && lines.some((l) => /1 found \(3 total\)/.test(l)),
    `the batch echoes accumulate (got: ${lines.join(" | ")})`,
  );
  assert(plans.length === 1, "one plan for the whole command");
  for (const entry of plans[0].appApi) val(await cmd(entry.name, entry.payload));
  const after = await snapshotOf();
  assert(after.elements.length === 1, `three erased, one left (got ${after.elements.length})`);
  assert(after.version === before.version + 1, `exactly ONE revision (v${before.version} → v${after.version})`);
  val(await cmd("document.undo", {}));
  const undone = await snapshotOf();
  assert(undone.elements.length === 4, `UNDO restored (got ${undone.elements.length})`);
}

// ---------------------------------------------------------------------------
step("DEF-021: MOVE 'ALL' + typed displacement — the plan carries the selectable set");
{
  const snap = await snapshotOf();
  const plans = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "MOVE" } },
      { event: { type: "typed", text: "ALL" } },
      { event: { type: "pick", point: [0, 0] } },
      { event: { type: "typed", text: "50,25" } },
    ],
    await ctxOf(),
    (plan) => plans.push(plan),
  );
  assert(lines.includes("4 found (all objects)"), "the keyword collected");
  assert(!lines.includes("*Cancel*"), "MOVE never cancelled");
  const carried = plans[0].appApi.flatMap((e) => e.payload.ids ?? []);
  assert(
    carried.length === 4 && carried.every((id) => snap.elements.some((el) => el.id === id)),
    "the plan carries the full live set",
  );
}

// ---------------------------------------------------------------------------
step("DEF-021: LAST and PREVIOUS keywords");
{
  const snap = await snapshotOf();
  const lastPlans = [];
  const last = runCommandScript(
    [
      { event: { type: "typed", text: "ERASE" } },
      { event: { type: "typed", text: "LAST" } },
      { event: { type: "enter" } },
    ],
    await ctxOf(),
    (plan) => lastPlans.push(plan),
  );
  assert(last.lines.some((l) => /1 found \(LAST: .+\)/.test(l)), `LAST resolved (got: ${last.lines.join(" | ")})`);
  const lastId = lastPlans[0].appApi[0].payload.ids[0];
  assert(lastId === snap.elements[snap.elements.length - 1].id, "LAST is the newest live element");

  const prevPlans = [];
  const prev = runCommandScript(
    [
      { event: { type: "typed", text: "ERASE" } },
      { event: { type: "typed", text: "PREVIOUS" } },
      { event: { type: "enter" } },
    ],
    await ctxOf({ currentSelection: picksOf(snap.elements.slice(0, 1)) }),
    (plan) => prevPlans.push(plan),
  );
  assert(prev.lines.includes("1 found (previous selection)"), `PREVIOUS resolved (got: ${prev.lines.join(" | ")})`);
  assert(prevPlans[0].appApi[0].payload.ids.length === 1, "the previous selection carried");
}

// ---------------------------------------------------------------------------
step("NEGATIVE: collection events mutate NOTHING before the commit");
{
  const before = await snapshotOf();
  const plans = [];
  runCommandScript(
    [
      { event: { type: "typed", text: "ERASE" } },
      { event: { type: "typed", text: "ALL" } },
      { event: { type: "entities", entities: picksOf(before.elements.slice(0, 2)) } },
      { event: { type: "typed", text: "LAST" } },
      { event: { type: "cancel" } },
    ],
    await ctxOf(),
    (plan) => plans.push(plan),
  );
  assert(plans.length === 0, "ZERO plans emitted during collection");
  const after = await snapshotOf();
  assert(after.version === before.version && after.elements.length === before.elements.length, "no mutation before commit");
}

// ---------------------------------------------------------------------------
step("NEGATIVE: empty-document ALL answers typed, the command survives");
{
  const { lines, state } = runCommandScript(
    [
      { event: { type: "typed", text: "MOVE" } },
      { event: { type: "typed", text: "ALL" } },
    ],
    defaultCommandContext(),
    () => {},
  );
  assert(state.commandId === "move", "MOVE keeps running");
  assert(lines.some((l) => /0 found — the document contains no selectable objects/.test(l)), `the typed outcome (got: ${lines.join(" | ")})`);
  assert(!lines.includes("*Cancel*"), "no cancellation");
}

step("DONE — all assertions green");
