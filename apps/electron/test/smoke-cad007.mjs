// COMPAT-CAD-007 / Issue #142: Electron command-phase selection/option smoke launcher.
//
// Launches a headless Xvfb display, then the Electron host in --smoke-cad007
// mode against it. The in-app smoke (main.ts runCad007Smoke) drives the REAL
// renderer command line (typedInput — the same dispatch the keyboard runs)
// and the REAL entities-batch dispatch through the DEF-006/007/021 flows:
//   - LINE 'Undo' / POLYLINE 'Close' full-word options (no *Cancel*);
//   - ERASE 'ALL' resolving inside the command (no SELECTALL escape);
//   - the entities batch "N found" echoes + ONE revision per mutation;
//   - UNDO restoring the exact prior content; the empty/dead-id typed
//     declines; the Esc-cancelled MOVE + ALL with zero mutation.
//
// Reproduce: cd apps/electron && npm run smoke:cad007
// Verbose:   OFFISOS_SMOKE_VERBOSE=1 npm run smoke:cad007

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = join(import.meta.dirname, ".."); // apps/electron

const electronExe =
  existsSync(join(APP, "node_modules", "electron", "dist", "electron"))
    ? join(APP, "node_modules", "electron", "dist", "electron")
    : "electron";

const tmp = mkdtempSync(join(tmpdir(), "offisos-electron-cad007-smoke-"));
const outFile = join(tmp, "smoke-result.json");

// Random display number to avoid collisions with the other smokes' X servers.
const displayNum = 500 + Math.floor(Math.random() * 100);
const display = `:${displayNum}`;
const xvfbArgs = [display, "-screen", "0", "1280x800x24", "-ac", "-nolisten", "tcp"];

const env = {
  ...process.env,
  DISPLAY: display,
  OFFISOS_SMOKE_OUT: outFile,
  ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  ELECTRON_RUN_AS_NODE: "", // ensure NOT set (we need the real Electron runtime)
};

const verbose = !!process.env.OFFISOS_SMOKE_VERBOSE;

// 1. Start Xvfb.
const xvfb = spawn("Xvfb", xvfbArgs, { stdio: "ignore" });
xvfb.on("error", (e) => {
  console.error("cad007 smoke: failed to spawn Xvfb:", e.message);
  process.exit(1);
});

await new Promise((r) => setTimeout(r, 1000));

// 2. Run Electron in --smoke-cad007 mode.
const args = [
  APP,
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--smoke-cad007",
];
const child = spawn(electronExe, args, { env, stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"] });

let stderr = "";
if (!verbose) {
  child.stderr.on("data", (d) => {
    stderr += String(d);
    // Keep the tail for the failure report.
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
}

const timeout = setTimeout(() => {
  console.error("cad007 smoke: TIMEOUT (90s)");
  child.kill("SIGKILL");
  process.exit(1);
}, 90000);

const code = await new Promise((resolve) => {
  child.on("exit", (c) => resolve(c ?? -1));
});
clearTimeout(timeout);
xvfb.kill("SIGTERM");

// 3. Read + report the result file.
let ok = false;
let steps = [];
try {
  const result = JSON.parse(readFileSync(outFile, "utf-8"));
  ok = result.ok === true;
  steps = result.steps ?? [];
} catch {
  console.error("cad007 smoke: no result file at", outFile);
}
rmSync(tmp, { recursive: true, force: true });

console.log("=== Electron COMPAT-CAD-007 command-phase selection/option smoke result (real UI) ===");
console.log(`command: ${electronExe} ${args.join(" ")}  (DISPLAY=${display})`);
console.log(`ok: ${ok}`);
for (const step of steps) {
  console.log(`  [${step.ok ? "PASS" : "FAIL"}] ${step.step}${step.detail !== null && step.detail !== undefined ? " — " + String(step.detail) : ""}`);
}
process.exit(ok ? code : 1);
