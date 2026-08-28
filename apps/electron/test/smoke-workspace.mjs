// CAD-PARITY-002 / Issue #75: professional workspace Electron smoke runner.
//
// Launches a headless Xvfb display, then runs the Electron host in
// --smoke-workspace mode against it. The smoke (main.ts runWorkspaceSmoke)
// drives the REAL professional UI — command line, prompt engine, Model
// canvas, palette — through the representative line/circle/wall workflow
// and asserts SEMANTIC PARITY with the Web host: the document save sha256
// must equal the pinned fixture produced by the identical prompt-engine
// script on the Web dev server (LOCK-004).
//
// CAD-PARITY-003 / Issue #78 (additive): after the 14 CAD-PARITY-002 steps
// pass, the runner launches the SAME app a second time (normal mode) and
// drives the NEW 2D vocabulary — ELLIPSE, TRIM implied-all-edges with an
// entityPoint CANVAS pick, ROTATE typed 45°, the ribbon tools, the
// canonical-only pick and the properties readout — over the DevTools
// protocol through the same real surfaces (window.__offisosWorkspace,
// window.cad.send, the canvas mousedown handler, the ribbon DOM).
//
// Reproduce: cd apps/electron && npm run smoke:workspace
// Verbose:   OFFISOS_SMOKE_VERBOSE=1 npm run smoke:workspace

// CAD-IMPLEMENT-001 / Issue #24 remediation: reproducible Electron smoke.
//
// Launches a headless Xvfb display, then runs the Electron host in --smoke
// mode against it. (We drive Xvfb directly with `-ac` instead of `xvfb-run`
// because the latter requires `xauth`, which is not present in this sandbox.)
//
// The main process (apps/electron/src/main/main.ts) drives the full chain
// THROUGH the BrowserWindow and writes a JSON result to $OFFISOS_SMOKE_OUT:
//   main -> BrowserWindow -> (did-finish-load) -> window.cad.send (preload)
//     -> ipcRenderer.invoke -> ipcMain.handle -> ElectronHost + IpcTransport
//     -> AppApiHandler -> CADDocument -> DummyAdapterBundle; and
//   window.cad.render(snapshot) -> createRenderer(host).render(snapshot)
//     -> deterministic scene hash (LOCK-017).
//
// Reproduce: cd apps/electron && npm run smoke
// Verbose:   OFFISOS_SMOKE_VERBOSE=1 npm run smoke

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = join(import.meta.dirname, ".."); // apps/electron (smoke.mjs lives in test/)
const REPO_ROOT = join(APP, "..", "..");

const electronExe =
  existsSync(join(APP, "node_modules", "electron", "dist", "electron"))
    ? join(APP, "node_modules", "electron", "dist", "electron")
    : "electron";

const tmp = mkdtempSync(join(tmpdir(), "offisos-electron-smoke-"));
const outFile = join(tmp, "smoke-result.json");

// Pick a random display number to avoid collisions with leftover X servers.
const displayNum = 100 + Math.floor(Math.random() * 100);
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
  console.error("smoke: failed to spawn Xvfb:", e.message);
  printResult(null, "", `Xvfb spawn error: ${e.message}`, "xvfb-spawn-error");
  process.exit(1);
});

// Give Xvfb a moment to initialize the display.
await new Promise((r) => setTimeout(r, 1000));

let stdout = "";
let stderr = "";
function attachIO(child) {
  child.stdout.on("data", (d) => {
    const s = d.toString();
    stdout += s;
    if (verbose) process.stdout.write(s);
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    stderr += s;
    if (verbose) process.stderr.write(s);
  });
}

// 2. Start Electron against the Xvfb display.
const electronArgs = [APP, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--smoke-workspace"];
const child = spawn(electronExe, electronArgs, { cwd: APP, env, stdio: ["ignore", "pipe", "pipe"] });
attachIO(child);

const timeoutMs = Number(process.env.OFFISOS_SMOKE_TIMEOUT_MS || 120000);
const timer = setTimeout(() => {
  console.error(`smoke: TIMEOUT after ${timeoutMs}ms`);
  try {
    child.kill("SIGKILL");
  } catch {
    // ignore
  }
  try {
    xvfb.kill("SIGTERM");
  } catch {
    // ignore
  }
  printResult(null, stdout, stderr, "timeout");
  process.exit(124);
}, timeoutMs);

child.on("error", (e) => {
  clearTimeout(timer);
  printResult(null, stdout, stderr, `electron spawn error: ${e.message}`);
  try {
    xvfb.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  let result = null;
  if (existsSync(outFile)) {
    try {
      result = JSON.parse(readFileSync(outFile, "utf8"));
    } catch (e) {
      printResult(null, stdout, stderr, `bad result json: ${(e).message}`);
      cleanup();
      process.exit(1);
    }
  }
  // CAD-PARITY-003 (Issue #78): the additive extension steps (15–19) drive
  // the NEW command vocabulary through the REAL Electron professional UI —
  // a second launch of the same app on the same Xvfb display, driven over
  // the Chromium DevTools protocol (Runtime.evaluate on the page). The
  // existing 14 steps (run above by main.ts --smoke-workspace) are untouched.
  void (async () => {
    if (result && result.ok === true) {
      try {
        const ext = await runCp3Extension(display, verbose);
        result.steps = [...(result.steps ?? []), ...ext.steps];
        result.ok = result.steps.every((s) => s.ok);
        if (verbose) {
          console.log("--- CAD-PARITY-003 extension stdout (last 1KB) ---");
          console.log(ext.stdout.slice(-1024));
        }
      } catch (e) {
        result.steps = [
          ...(result.steps ?? []),
          { step: "CAD-PARITY-003 extension driver", ok: false, detail: String((e && e.stack) || e) },
        ];
        result.ok = false;
      }
    }
    const status = `exit ${code}` + (signal ? ` signal ${signal}` : "");
    printResult(result, stdout, stderr, status);
    // Persist the result JSON next to the build output so CI can upload it as
    // inspectable smoke evidence (apps/electron/dist/smoke-result.json).
    if (result) {
      try {
        mkdirSync(join(APP, "dist"), { recursive: true });
        writeFileSync(join(APP, "dist", "smoke-workspace-result.json"), JSON.stringify(result, null, 2) + "\n");
        // The tmp result file may already be gone — rewrite it so a late read
        // observes the merged step list too.
        try {
          writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
        } catch {
          // ignore
        }
      } catch {
        // ignore — not fatal
      }
    }
    cleanup();
    process.exit(result && result.ok === true ? 0 : 1);
  })();
});

/**
 * CAD-PARITY-003 extension (Issue #78): drive the NEW 2D vocabulary through
 * the REAL professional UI in a fresh Electron launch (normal mode — the
 * window mounts the same renderer the --smoke-workspace run drives), over
 * the Chromium DevTools protocol. Everything crosses the same surfaces the
 * 14-step CAD-PARITY-002 smoke uses: window.__offisosWorkspace (the SAME
 * driver methods), window.cad.send (App API), the real canvas mousedown
 * handler (synthetic MouseEvents at computed client coordinates) and the
 * ribbon/properties DOM. Deterministic: fixed ids, fixed typed input, exact
 * value assertions.
 */
async function runCp3Extension(display, verbose) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

  const port = 9300 + (process.pid % 200);
  const electronArgs = [APP, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--remote-debugging-port=${port}`];
  const env = {
    ...process.env,
    DISPLAY: display,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    ELECTRON_RUN_AS_NODE: "", // ensure NOT set
    OFFISOS_SMOKE_OUT: "", // normal mode — main.ts must NOT run a smoke
  };
  const child = spawn(electronExe, electronArgs, { cwd: APP, env, stdio: ["ignore", "pipe", "pipe"] });
  let extOut = "";
  let extErr = "";
  child.stdout.on("data", (d) => {
    const s = d.toString();
    extOut += s;
    if (verbose) process.stdout.write(s);
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    extErr += s;
    if (verbose) process.stderr.write(s);
  });

  const steps = [];
  const push = (name, ok, detail = null) => steps.push({ step: name, ok, detail });
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  };
  const deadline = Date.now() + 120000;

  /** Run one step body; a throw records a FAIL step (and keeps the earlier
   *  PASS steps) instead of discarding the whole extension run. */
  const attempt = async (name, body) => {
    try {
      await body(push);
    } catch (e) {
      push(name, false, String((e && e.stack) || e).slice(0, 500));
    }
  };

  try {
    // 1. Wait for the DevTools HTTP endpoint, then the page target.
    let page = null;
    for (;;) {
      if (Date.now() > deadline) throw new Error("timeout waiting for the CDP endpoint");
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (res.ok) {
          const list = await res.json();
          const target = Array.isArray(list) ? list.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string") : null;
          if (target) {
            page = target;
            break;
          }
        }
      } catch {
        // endpoint not up yet
      }
      await sleep(250);
    }

    // 2. Minimal CDP client over the built-in WebSocket.
    if (typeof WebSocket !== "function") throw new Error("no built-in WebSocket (Node >= 22 required)");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP websocket open timeout")), 15000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("CDP websocket error"));
      });
    });
    let msgId = 0;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      let text;
      if (typeof ev.data === "string") text = ev.data;
      else text = Buffer.from(ev.data).toString("utf8");
      const msg = JSON.parse(text);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    const cdp = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++msgId;
        const t = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP call timeout: ${method}`));
        }, 20000);
        pending.set(id, (msg) => {
          clearTimeout(t);
          resolve(msg);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (js) => {
      const r = await cdp("Runtime.evaluate", {
        expression: `(async () => (${js}))()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.error !== undefined) throw new Error(`CDP error: ${JSON.stringify(r.error).slice(0, 300)}`);
      const payload = r.result;
      if (payload === undefined || payload.exceptionDetails !== undefined) {
        throw new Error(`renderer exception: ${JSON.stringify(payload && payload.exceptionDetails).slice(0, 600)}`);
      }
      return payload.result !== undefined ? payload.result.value : undefined;
    };
    const waitForEval = async (predicateJs, what, timeoutMs = 15000) => {
      const end = Date.now() + timeoutMs;
      for (;;) {
        if ((await evaluate(predicateJs)) === true) return;
        if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
        await sleep(150);
      }
    };

    // 3. Wait for the professional workspace driver (same one the main smoke uses).
    await waitForEval("!!window.__offisosWorkspace", "professional workspace driver", 30000);
    const drv = (method, ...args) => evaluate(`window.__offisosWorkspace.${method}(${args.map((a) => JSON.stringify(a)).join(",")})`);
    const cad = (req) => evaluate(`window.cad.send(${JSON.stringify(req)})`);
    const docState = async () => (await cad({ type: "query", name: "document.getState", payload: {} })).value;
    /** Click the Model canvas at a WORLD point through the REAL mousedown/mouseup
     *  handlers (client coordinates computed from the live view transform — the
     *  exact inverse of the renderer's svgPoint mapping). */
    const clickWorld = (wx, wy) =>
      evaluate(`(async () => {
        const svg = document.querySelector('[data-testid="pro-model-svg"]');
        const rect = svg.getBoundingClientRect();
        const view = window.__offisosWorkspace.viewTransform();
        const sx = (${wx} - view.pan.x) * view.zoom;
        const sy = view.height - (${wy} - view.pan.y) * view.zoom;
        // MouseEvent coerces clientX/clientY to integers — pre-round so the
        // pick lands within half a pixel of the intended world point.
        const clientX = Math.round(rect.left + (sx / view.width) * rect.width);
        const clientY = Math.round(rect.top + (sy / view.height) * rect.height);
        svg.dispatchEvent(new MouseEvent("mousedown", { clientX, clientY, button: 0, bubbles: true }));
        svg.dispatchEvent(new MouseEvent("mouseup", { clientX, clientY, button: 0, bubbles: true }));
        return { clientX, clientY };
      })()`);

    // 4. Fresh document — the SAME entityId convention the Web CP3 flow uses.
    const created = await cad({ type: "command", name: "document.create", payload: { entityId: "cad-parity-003-smoke", format: "offisos-occt", formatVersion: "1", createdBy: "cad-parity-003-smoke" } });
    await drv("refresh");
    if (!created || created.ok !== true) throw new Error("document.create failed in the extension launch");

    // --- Step 15: ELLIPSE via the command line (typed axes) -------------------
    await attempt("CAD-PARITY-003: ELLIPSE via command line (typed 0,0 / 100,0 / 0,50 → exact axes 100×50, rotation 0; canonical <ellipse> rendered)", async (push) => {
      await drv("typedInput", "ELLIPSE");
      await drv("typedInput", "0,0");
      await drv("typedInput", "100,0");
      await drv("typedInput", "0,50");
      const st1 = await docState();
      const e1 = st1.elements.length === 1 ? st1.elements[0].props : null;
      const view = await drv("viewTransform");
      const ellipseNode = await evaluate(`(async () => {
        const el = document.querySelector('[data-testid="pro-model-svg"] ellipse');
        if (!el) return null;
        return { rx: parseFloat(el.getAttribute("rx")), ry: parseFloat(el.getAttribute("ry")), cx: parseFloat(el.getAttribute("cx")) };
      })()`);
      const ellipseOk =
        e1 !== null &&
        e1.type === "ellipse" && e1.cx === 0 && e1.cy === 0 && e1.rx === 100 && e1.ry === 50 && e1.rotation === 0;
      const ellipseRendered =
        ellipseNode !== null && close(ellipseNode.rx, 100 * view.zoom, 1e-6) && close(ellipseNode.ry, 50 * view.zoom, 1e-6);
      push(
        "CAD-PARITY-003: ELLIPSE via command line (typed 0,0 / 100,0 / 0,50 → exact axes 100×50, rotation 0; canonical <ellipse> rendered)",
        ellipseOk && ellipseRendered,
        ellipseOk ? (ellipseRendered ? `props rx=${e1.rx} ry=${e1.ry}; svg rx=${ellipseNode && ellipseNode.rx} ry=${ellipseNode && ellipseNode.ry}` : `props ok but svg node missing/mismatch: ${JSON.stringify(ellipseNode)}`) : JSON.stringify(e1),
      );
    });

    // --- Step 16: TRIM implied-all-edges + entityPoint CANVAS pick -------------
    await attempt("CAD-PARITY-003: TRIM implied-all-edges + entityPoint canvas pick at (120,80) → line trimmed to (-200,80)-(50,80) exactly", async (push) => {
      await drv("typedInput", "LINE");
      await drv("typedInput", "-200,80");
      await drv("typedInput", "200,80");
      await drv("typedInput", "");
      await drv("typedInput", "CIRCLE");
      await drv("typedInput", "0,80");
      await drv("typedInput", "50");
      await drv("typedInput", "TRIM");
      await drv("typedInput", ""); // Enter → "all objects implied" (implied-all-edges)
      await clickWorld(120, 80); // pick the RIGHT piece of the line to remove
      await waitForEval(`window.__offisosWorkspace.status().history.some((l) => l.includes("1 found"))`, "entityPoint pick echo");
      await drv("typedInput", ""); // Enter → complete TRIM
      const st2 = await docState();
      const trimmed = st2.elements.find((e) => e.id === "el-000002");
      const trimOk =
        trimmed !== undefined &&
        trimmed.props.type === "line" &&
        trimmed.props.x1 === -200 && trimmed.props.y1 === 80 && trimmed.props.x2 === 50 && trimmed.props.y2 === 80;
      push(
        "CAD-PARITY-003: TRIM implied-all-edges + entityPoint canvas pick at (120,80) → line trimmed to (-200,80)-(50,80) exactly",
        trimOk,
        trimOk ? "flat-convention setProps write-back verified" : JSON.stringify(trimmed && trimmed.props),
      );
    });

    // --- Step 17: ROTATE typed 45° (preselection + typed angle) ----------------
    await attempt("CAD-PARITY-003: ROTATE 45° typed (preselection + base 0,0) → endpoint (70.71067811865476, 70.71067811865474) exact", async (push) => {
      await drv("typedInput", "LINE");
      await drv("typedInput", "0,0");
      await drv("typedInput", "100,0");
      await drv("typedInput", "");
      await drv("setSelection", ["el-000004"]);
      await drv("typedInput", "ROTATE");
      await drv("typedInput", ""); // objects ← current selection
      await drv("typedInput", "0,0"); // base point
      await drv("typedInput", "45"); // typed angle
      const st3 = await docState();
      const rotated = st3.elements.find((e) => e.id === "el-000004");
      const rotateOk =
        rotated !== undefined &&
        rotated.props.type === "line" &&
        rotated.props.x1 === 0 && rotated.props.y1 === 0 &&
        close(rotated.props.x2, 70.71067811865476) && close(rotated.props.y2, 70.71067811865474);
      push(
        "CAD-PARITY-003: ROTATE 45° typed (preselection + base 0,0) → endpoint (70.71067811865476, 70.71067811865474) exact",
        rotateOk,
        rotateOk ? `x2=${rotated.props.x2} y2=${rotated.props.y2}` : JSON.stringify(rotated && rotated.props),
      );
    });

    // --- Step 18: ribbon tool palette exposes (and drives) the 18 new commands --
    await attempt("CAD-PARITY-003: ribbon tool palette exposes all 18 new commands and drives the engine (ELLIPSE tool click → prompt engine)", async (push) => {
      const ribbonInfo = await evaluate(`(async () => {
        const ribbon = document.querySelector('[data-testid="pro-ribbon"]');
        if (!ribbon) return { present: false, missing: ["ribbon"], count: 0 };
        const required = ["ellipse","spline","point","ray","xline","region","rotate","scale","mirror","offset","trim","extend","stretch","fillet","chamfer","break","join","explode"];
        const missing = required.filter((id) => !ribbon.querySelector('[data-testid="pro-tool-' + id + '"]'));
        return { present: true, missing, count: ribbon.querySelectorAll(".pro-ribbon-tool").length };
      })()`);
      await evaluate(`document.querySelector('[data-testid="pro-tool-ellipse"]').click()`);
      const ribbonStarted = await waitForEval(
        `window.__offisosWorkspace.status().commandName === "ELLIPSE"`,
        "ribbon-started ELLIPSE",
      )
        .then(() => true)
        .catch(() => false);
      await drv("pressEscape");
      const ribbonOk = ribbonInfo.present && ribbonInfo.missing.length === 0 && ribbonStarted;
      push(
        "CAD-PARITY-003: ribbon tool palette exposes all 18 new commands and drives the engine (ELLIPSE tool click → prompt engine)",
        ribbonOk,
        ribbonOk ? `${ribbonInfo.count} tools; ELLIPSE tool click started the command` : JSON.stringify(ribbonInfo),
      );
    });

    // --- Step 19: canonical-only canvas pick + properties readout ---------------
    await attempt("CAD-PARITY-003: canonical-only canvas pick selects the ellipse (merged pickAt) + properties readout shows its canonical geometry", async (push) => {
      await drv("setSelection", []);
      await clickWorld(100, 0); // ON the ellipse — legacy hitTest cannot see it
      let pickedOk = false;
      try {
        await waitForEval(`JSON.stringify(window.__offisosWorkspace.status().selection) === JSON.stringify(["el-000001"])`, "canonical-only pick", 8000);
        pickedOk = true;
      } catch {
        pickedOk = false;
      }
      const propsText = await evaluate(`(async () => {
        const p = document.querySelector('[data-testid="pro-properties"]');
        return p ? p.textContent : null;
      })()`);
      const propsOk =
        pickedOk &&
        propsText !== null &&
        propsText.includes("Ellipse") &&
        propsText.includes("100 × 50") &&
        propsText.includes("el-000001");
      push(
        "CAD-PARITY-003: canonical-only canvas pick selects the ellipse (merged pickAt) + properties readout shows its canonical geometry",
        propsOk,
        propsOk ? "selection=[el-000001]; properties show Ellipse axes 100 × 50" : `picked=${pickedOk} props=${JSON.stringify(propsText && propsText.slice(0, 160))}`,
      );
    });

    try {
      ws.close();
    } catch {
      // ignore
    }
  } finally {
    kill();
  }
  return { steps, stdout: extOut, stderr: extErr };
}

function cleanup() {
  try {
    xvfb.kill("SIGTERM");
  } catch {
    // ignore
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function printResult(result, out, err, status) {
  console.log("=== Electron smoke result ===");
  console.log("status:", status);
  console.log("command:", electronExe, electronArgs.join(" "), "  (DISPLAY=" + display + ")");
  if (result) {
    console.log("ok:", result.ok);
    console.log("electronVersion:", result.electronVersion);
    console.log("nodeVersion:", result.nodeVersion);
    console.log("chromeVersion:", result.chromeVersion);
    console.log("contentHash:", result.contentHash);
    console.log("sceneHash:", result.sceneHash);
    console.log("steps:");
    for (const s of result.steps || []) {
      console.log(
        `  [${s.ok ? "PASS" : "FAIL"}] ${s.step} — ${typeof s.detail === "string" ? s.detail : JSON.stringify(s.detail)}`,
      );
    }
  } else {
    console.log("ok: false (no result file written)");
  }
  console.log("--- stdout (last 3KB) ---");
  console.log(out.slice(-3072));
  console.log("--- stderr (last 3KB) ---");
  console.log(err.slice(-3072));
  console.log(`(verbose: OFFISOS_SMOKE_VERBOSE=1; repo root: ${REPO_ROOT})`);
}
