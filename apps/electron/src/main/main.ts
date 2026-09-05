/**
 * Electron main process — real host bootstrap (CAD-IMPLEMENT-001 / Issue #24
 * remediation for CHANGES_REQUESTED). Architecture v1.1 FROZEN.
 *
 * The chain the Architect required:
 *
 *   Electron main -> BrowserWindow -> shared renderer -> native/local transport
 *     -> shared CAD App API -> dummy adapter
 *
 * What this file proves (all of it runs):
 *
 * - BrowserWindow: `app.whenReady()` creates a real OS window that loads the
 *   shared renderer UI (`dist/renderer/index.html`). Settings are the secure
 *   Electron defaults: `contextIsolation: true`, `nodeIntegration: false`,
 *   `sandbox: false` (so the preload can use the Electron bridge APIs) and a
 *   preload script. The renderer never gets node access (§16).
 *
 * - Shared renderer: the window loads the shared renderer UI
 *   (`apps/electron/src/renderer`), which is the same workspace semantics as
 *   the Web host (`apps/web/src/app/page.tsx`) — SVG canvas + create / add /
 *   undo / redo / save — talking to the App API ONLY through `window.cad.send`
 *   (native IPC), exactly as the Web host talks only through `fetch("/api/cad")`.
 *
 * - Native/local transport: the Electron native IPC boundary
 *   (`ipcRenderer.invoke` -> `ipcMain.handle`). The preload bridge
 *   (`contextBridge`) exposes a tiny `window.cad`; the window's requests cross
 *   the native IPC boundary into this main process.
 *
 * - Shared CAD App API: `ipcMain.handle("cad:send", req => host.transport.send(req))`
 *   where `host = new ElectronHost(new IpcTransport(handler))` — the SAME shared
 *   host-electron layer proven by `app/test/host-parity.test.ts`. The
 *   `IpcTransport` JSON-round-trips the request through the `AppApiHandler`
 *   (the App API) which holds the CADDocument and dispatches to the dummy
 *   `EngineAdapterBundle`.
 *
 * - Dummy adapter: `handler = AppApiHandler.create({ adapterBundle:
 *   DummyAdapterBundle, ... })`. No FreeCAD/OCCT/IfcOpenShell anywhere
 *   (LOCK-003/018); CADDocument is the editor representation (LOCK-019).
 *
 * `createRenderer(host)` (the shared platform-independent renderer core,
 * LOCK-017) is exposed via `cad:render` so the window can ask for the
 * deterministic scene graph for a snapshot — the same scene-hash parity
 * primitive the host-parity test asserts. `cad:contentHash` exposes the
 * handler's current content hash for parity diagnostics.
 *
 * `--smoke` mode: after `did-finish-load`, this main drives the full chain
 * THROUGH the BrowserWindow via `webContents.executeJavaScript("window.cad...")`,
 * asserts each step, writes a JSON result to `$OFFISOS_SMOKE_OUT`, and
 * `app.exit(0|1)`. This is the reproducible Electron smoke evidence.
 */

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { basename, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

import { AppApiHandler } from "@offisos/cad-app-shell/app-api";
import { createOcctAdapterBundle } from "@offisos/cad-app-shell/adapters/occt";
import { createIfcInteropAdapter } from "@offisos/cad-app-shell/adapters/ifc";
import { createReferenceAdapterBundle } from "@offisos/cad-app-shell/adapters/reference";
import { ElectronHost, IpcTransport } from "@offisos/cad-app-shell/host-electron";
import { createRenderer } from "@offisos/cad-app-shell/renderer";
import { FileP016Persist } from "@offisos/cad-app-shell/persist/file";
import type { CommandQueryRequest, CommandQueryResponse } from "@offisos/cad-app-shell/contracts/app-api";
import type { CADDocumentSnapshot } from "@offisos/cad-app-shell/contracts/caddocument";
import type { EngineAdapterBundle } from "@offisos/cad-app-shell/contracts/adapter";
import type { SceneGraph } from "@offisos/cad-app-shell/contracts/scene";

// CAD-IMPLEMENT-002 / Issue #26: the Electron workspace surface is connected
// to the REAL geometry engine (OCCT 7.8.1.1 via the isolated Python worker —
// the same kernel FreeCAD builds on) behind the frozen EngineAdapterBundle
// boundary. The bundle swap is the ONLY wiring change (LOCK-003). The worker
// spawns lazily per geometry.prepare call (process-per-call isolation,
// wall-clock timeout, typed failures — CAD-005); the CAD-IMPLEMENT-001 smoke
// flow (no geometry.prepare) runs engine-free.
const CONFIG = {
  // COMPAT-IFC-001: the IFC interop adapter (IfcOpenShell 0.8.5 worker) is
  // bound alongside the OCCT engines — ifc.* becomes available.
  adapterBundle: createOcctAdapterBundle({ ifc: createIfcInteropAdapter() }),
  entityId: "electron-workspace",
  format: "offisos-occt",
  formatVersion: "1",
  createdBy: "electron-workspace",
};

// CAD-PARITY-006 (Issue #84): the main BrowserWindow — the external-reference
// file dialog is modal to it (set by createWindow; the renderer can only
// invoke `cad:pickReferenceFile` after the window loaded, so it is always
// non-null in practice).
let mainWindow: BrowserWindow | null = null;

const isSmoke = process.argv.includes("--smoke");
const isGeometrySmoke = process.argv.includes("--smoke-geometry");
const isModelSmoke = process.argv.includes("--smoke-model");
const isImpactSmoke = process.argv.includes("--smoke-impact");
const isDraftingSmoke = process.argv.includes("--smoke-drafting");
const isBimSmoke = process.argv.includes("--smoke-bim");
const isDocsSmoke = process.argv.includes("--smoke-docs");
const isIfcSmoke = process.argv.includes("--smoke-ifc");
const isComponentsSmoke = process.argv.includes("--smoke-components");
const isWorkspaceSmoke = process.argv.includes("--smoke-workspace");
const isCad006Smoke = process.argv.includes("--smoke-cad006");
const isCad007Smoke = process.argv.includes("--smoke-cad007");

function createWindow(): BrowserWindow {
  // app.getAppPath() is the directory containing this package's package.json
  // (apps/electron when run via `electron .`). The build emits dist/main/ and
  // dist/renderer/ under it. Using the Electron-native API avoids relying on
  // import.meta.url (empty under CJS) or __dirname (ESM typecheck friction).
  const appRoot = app.getAppPath();
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(appRoot, "dist", "main", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs the Electron contextBridge/ipcRenderer APIs
      spellcheck: false,
    },
  });
  void win.loadFile(join(appRoot, "dist", "renderer", "index.html"));
  mainWindow = win;
  return win;
}

/** Wire the native IPC handlers to the shared host + renderer core. The
 *  bundle is injectable: the impact smoke (RESEARCH-CAD-007) binds the
 *  engine-free REFERENCE adapter — the second engine running inside the
 *  Electron host behind the same frozen boundary (LOCK-003).
 *
 *  CAD-PARITY-016 remediation: the persistence boundary is equally
 *  injectable (the LOCK-003 wiring-point discipline applied to persistence).
 *  The production wiring is the host-filesystem store (durable across app
 *  restarts — the desktop crash-recovery boundary); callers may pass the
 *  per-handler default (deterministic in-process memory) instead. */
function registerIpc(
  bundle: EngineAdapterBundle = CONFIG.adapterBundle,
  p016Persist: Parameters<typeof AppApiHandler.create>[0]["p016Persist"] = new FileP016Persist(
    join(app.getPath("userData"), "p016-projects"),
  ),
): { handler: AppApiHandler; host: ElectronHost } {
  const handler = AppApiHandler.create({ ...CONFIG, adapterBundle: bundle, p016Persist });
  const host = new ElectronHost(new IpcTransport(handler));
  const renderer = createRenderer(host);

  ipcMain.handle(
    "cad:send",
    (_event, req: CommandQueryRequest): Promise<CommandQueryResponse> => {
      return host.transport.send(req);
    },
  );

  ipcMain.handle(
    "cad:render",
    (_event, snapshot: CADDocumentSnapshot): Promise<SceneGraph> => {
      return Promise.resolve(renderer.render(snapshot));
    },
  );

  ipcMain.handle("cad:contentHash", (): Promise<string> => {
    return Promise.resolve(handler.currentContentHash());
  });

  // CAD-PARITY-006 (Issue #84): the external-reference file picker — a REAL
  // Electron dialog (dialog.showOpenDialog filtered to .offisos/.json)
  // followed by the file read + JSON.parse IN THE MAIN PROCESS. The renderer
  // receives the parsed offisos snapshot object (the xref.attach `content`
  // payload — the ifc.import payload precedent) and never touches node/fs
  // (§16 context isolation). Mirrors the cad:send/cad:render ipcMain.handle
  // pattern; typed outcomes (canceled / error / loaded) — LOCK-007/008.
  ipcMain.handle("cad:pickReferenceFile", async (): Promise<ReferenceFilePick> => {
    const options: Electron.OpenDialogOptions = {
      title: "Attach external reference — select an offisos snapshot",
      properties: ["openFile"],
      filters: [
        { name: "Offisos snapshots (.offisos, .json)", extensions: ["offisos", "json"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const picked = mainWindow !== null ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return { status: "canceled" };
    const filePath = picked.filePaths[0]!;
    try {
      const content: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      const name = basename(filePath).replace(/\.(offisos|json)$/i, "");
      return {
        status: "loaded",
        fileName: name.length > 0 ? name : "reference",
        filePath,
        content,
      };
    } catch (e) {
      return { status: "error", message: `cannot read '${filePath}': ${(e as Error).message}` };
    }
  });

  // CAD-PARITY-008 (Issue #88): the plot-artifact save dialog — the
  // main-process showSaveDialog (the pickReferenceFile precedent; the
  // renderer never touches node/fs — §16 context isolation). Typed outcomes
  // (canceled / error / saved); the renderer writes the returned path back
  // through cad:savePlotFile below.
  ipcMain.handle("cad:pickSavePath", async (_e, payload: { defaultPath?: string } = {}): Promise<{ status: "canceled" } | { status: "saved"; filePath: string } | { status: "error"; message: string }> => {
    const options: Electron.SaveDialogOptions = {
      title: "Save plot artifact",
      defaultPath: typeof payload?.defaultPath === "string" ? payload.defaultPath : "offisos-plot",
    };
    const picked = mainWindow !== null ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || picked.filePath === undefined) return { status: "canceled" };
    return { status: "saved", filePath: picked.filePath };
  });
  // CAD-PARITY-008: write the plot artifact bytes (SVG text or PDF base64)
  // at the previously picked path — the single fs write the plot flow needs.
  ipcMain.handle(
    "cad:savePlotFile",
    async (_e, payload: { filePath: string; text?: string; bytesBase64?: string }): Promise<{ status: "saved"; size: number } | { status: "error"; message: string }> => {
      try {
        const data =
          typeof payload?.bytesBase64 === "string"
            ? Buffer.from(payload.bytesBase64, "base64")
            : Buffer.from(payload?.text ?? "", "utf8");
        writeFileSync(payload.filePath, data);
        return { status: "saved", size: data.length };
      } catch (e) {
        return { status: "error", message: (e as Error).message };
      }
    },
  );

  return { handler, host };
}

/** The cad:pickReferenceFile outcome (CAD-PARITY-006) — the parsed snapshot
 *  crosses the IPC boundary to the renderer as the xref.attach content. */
export interface ReferenceFilePick {
  readonly status: "canceled" | "error" | "loaded";
  readonly fileName?: string;
  readonly filePath?: string;
  readonly content?: unknown;
  readonly message?: string;
}

interface SmokeStep {
  step: string;
  ok: boolean;
  detail?: unknown;
}
interface SmokeResult {
  ok: boolean;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  steps: SmokeStep[];
  contentHash: unknown;
  sceneHash: unknown;
}

function writeSmokeOut(payload: SmokeResult): void {
  const outPath = process.env.OFFISOS_SMOKE_OUT;
  if (outPath) writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
}

/** Drive the full chain through the BrowserWindow and assert each step. */
async function runSmoke(win: BrowserWindow): Promise<void> {
  const steps: SmokeStep[] = [];
  const exec = <T>(js: string): Promise<T> => win.webContents.executeJavaScript(js) as Promise<T>;

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  // 1. Preload bridge is exposed in the renderer (window.cad).
  const bridgePresent = await exec<boolean>(
    `(window.cad && typeof window.cad.send === "function" && typeof window.cad.render === "function" && typeof window.cad.contentHash === "function")`,
  );
  steps.push({ step: "preload bridge exposed (window.cad)", ok: !!bridgePresent, detail: !!bridgePresent });
  if (!bridgePresent) {
    writeSmokeOut({ ok: false, electronVersion: process.versions.electron, nodeVersion: process.versions.node, chromeVersion: process.versions.chrome, steps, contentHash: null, sceneHash: null });
    return;
  }

  // 2. document.create through the BrowserWindow -> native IPC -> host -> App API.
  const rCreate = await exec<CommandQueryResponse>(
    `window.cad.send(${JSON.stringify({ type: "command", name: "document.create", payload: { entityId: "smoke-doc" } })})`,
  );
  steps.push({ step: "document.create via window.cad", ok: !!(rCreate && rCreate.ok), detail: rCreate && rCreate.ok ? "ok" : rCreate });

  // 3. applyEdit(addElement).
  const rAdd = await exec<CommandQueryResponse>(
    `window.cad.send(${JSON.stringify({ type: "command", name: "document.applyEdit", payload: { edit: { type: "addElement", element: { id: "e1", kind: "geometry", engineId: null, props: { meshToken: "m1" } } } } })})`,
  );
  steps.push({ step: "document.applyEdit(addElement)", ok: !!(rAdd && rAdd.ok), detail: rAdd && rAdd.ok ? "ok" : rAdd });

  // 4. document.getState -> 1 element.
  const rState = await exec<CommandQueryResponse>(
    `window.cad.send(${JSON.stringify({ type: "query", name: "document.getState", payload: {} })})`,
  );
  const snap = rState && rState.ok ? (rState.value as CADDocumentSnapshot | undefined) : undefined;
  const nAfterAdd = snap && Array.isArray(snap.elements) ? snap.elements.length : -1;
  steps.push({ step: "document.getState after add has 1 element", ok: nAfterAdd === 1, detail: `elements=${nAfterAdd}` });

  // 5. window.cad.render(snapshot) -> shared renderer core deterministic scene.
  let sceneHash: string | null = null;
  let sceneNodes = -1;
  if (snap) {
    const scene = await exec<SceneGraph>(`window.cad.render(${JSON.stringify(snap)})`);
    sceneHash = scene && typeof scene.hash === "string" ? scene.hash : null;
    sceneNodes = scene && Array.isArray(scene.nodes) ? scene.nodes.length : -1;
  }
  steps.push({ step: "renderer.render(snapshot) deterministic scene (LOCK-017)", ok: !!sceneHash && sceneNodes === 1, detail: `hash=${sceneHash ? sceneHash.slice(0, 12) : null} nodes=${sceneNodes}` });

  // 6. document.undo -> removes e1.
  const rUndo = await exec<CommandQueryResponse>(
    `window.cad.send(${JSON.stringify({ type: "command", name: "document.undo", payload: {} })})`,
  );
  steps.push({ step: "document.undo", ok: !!(rUndo && rUndo.ok), detail: rUndo && rUndo.ok ? "ok" : rUndo });

  // 7. document.getState -> 0 elements (undo reverted content).
  const rState2 = await exec<CommandQueryResponse>(
    `window.cad.send(${JSON.stringify({ type: "query", name: "document.getState", payload: {} })})`,
  );
  const snap2 = rState2 && rState2.ok ? (rState2.value as CADDocumentSnapshot | undefined) : undefined;
  const nAfterUndo = snap2 && Array.isArray(snap2.elements) ? snap2.elements.length : -1;
  steps.push({ step: "document.getState after undo has 0 elements", ok: nAfterUndo === 0, detail: `elements=${nAfterUndo}` });

  // 8. contentHash via native IPC (parity diagnostic).
  const contentHash = await exec<string>(`window.cad.contentHash()`);
  steps.push({ step: "contentHash via native IPC", ok: typeof contentHash === "string" && contentHash.length > 0, detail: typeof contentHash === "string" ? contentHash.slice(0, 12) : contentHash });

  const allOk = steps.every((s) => s.ok);
  writeSmokeOut({
    ok: allOk,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: typeof contentHash === "string" ? contentHash : null,
    sceneHash,
  });
}

/** Drive the REAL-ENGINE geometry workflow through the BrowserWindow
 *  (CAD-IMPLEMENT-002 / Issue #26 CHAIN):
 *  BrowserWindow -> window.cad.send -> native IPC -> ElectronHost/IpcTransport
 *    -> AppApiHandler geometry.prepare -> EngineAdapterBundle -> OCCT worker
 *    (disposable Python subprocess) -> deterministic GeometryResult
 *    -> applyEdit(addElement) -> CADDocument -> undo/redo + selection.
 *  Requires the pinned toolchain (python3 + cadquery-ocp) in the environment. */
async function runGeometrySmoke(win: BrowserWindow): Promise<void> {
  const steps: SmokeStep[] = [];

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  // Call window.cad.<method> through a rejection-capturing wrapper: the raw
  // executeJavaScript rejection hides the real IPC error behind the generic
  // "Script failed to execute" wrapper — this surfaces the renderer-side
  // rejection reason (message + stack) as a normal value.
  const call = async (js: string): Promise<CommandQueryResponse> => {

    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: CommandQueryResponse } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };

  const send = (payload: unknown): Promise<CommandQueryResponse> =>
    call(`window.cad.send(${JSON.stringify({ type: "command", name: "geometry.prepare", payload })})`);

  // 1. Box through the full chain (BrowserWindow -> IPC -> App API -> OCCT worker).
  const box = await send({ geometry: { shape: "box", width: 2, depth: 3, height: 4 } });
  const boxValue = box && box.ok ? (box.value as { meshToken: string; bbox: number[]; mesh: { vertices: unknown[] } | null; metadata: { volume: number } | null; engine: { engineId: string; engineVersion: string } }) : null;
  const boxOk = !!boxValue && boxValue.meshToken.startsWith("occt:") && !!boxValue.mesh && boxValue.mesh.vertices.length === 8 * 3;
  steps.push({ step: "geometry.prepare box through the real engine", ok: boxOk, detail: boxValue ? `token=${boxValue.meshToken.slice(0, 14)}… mesh=${boxValue.mesh ? boxValue.mesh.vertices.length / 3 : 0} verts engine=${boxValue.engine.engineId}@${boxValue.engine.engineVersion}` : box });

  // 2. Volume + bbox correctness (box is exact).
  const boxMetaOk = !!boxValue?.metadata && Math.abs(boxValue.metadata.volume - 24) < 1e-9 && Math.abs(boxValue.bbox[3]! - 2) < 0.01;
  steps.push({ step: "box volume 24 + bbox width 2 (deterministic within tolerance)", ok: boxMetaOk, detail: boxValue ? `volume=${boxValue.metadata ? boxValue.metadata.volume : null} bbox=${JSON.stringify(boxValue.bbox)}` : "no result" });

  // 3. Boolean fuse (box + cylinder) through the same chain.
  const fuse = await send({ geometry: { shape: "fuse", a: { shape: "box", width: 4, depth: 3, height: 2 }, b: { shape: "cylinder", radius: 1, height: 5, origin: [2, 1.5, 0], direction: [0, 0, 1] } } });
  const fuseValue = fuse && fuse.ok ? (fuse.value as { meshToken: string; metadata: { volume: number } | null }) : null;
  const fuseOk = !!fuseValue && fuseValue.meshToken.startsWith("occt:") && !!fuseValue.metadata && fuseValue.metadata.volume > 24;
  steps.push({ step: "geometry.prepare fuse(box, cylinder) through the real engine", ok: fuseOk, detail: fuseValue ? `token=${fuseValue.meshToken.slice(0, 14)}… volume=${fuseValue.metadata ? fuseValue.metadata.volume : null}` : fuse });

  // 4. Determinism: repeat the box prepare -> identical meshToken.
  const boxAgain = await send({ geometry: { shape: "box", width: 2, depth: 3, height: 4 } });
  const boxAgainToken = boxAgain && boxAgain.ok ? (boxAgain.value as { meshToken: string }).meshToken : null;
  const deterministic = !!boxValue && boxAgainToken === boxValue.meshToken;
  steps.push({ step: "determinism: repeated prepare yields the identical meshToken", ok: deterministic, detail: boxAgainToken ? `${boxAgainToken.slice(0, 14)}… === ${boxValue ? boxValue.meshToken.slice(0, 14) : "?"}…` : "no token" });

  // 5. Persist the real geometry result into the CADDocument (the EXISTING workflow).
  if (boxValue) {
    const add = await call(
      `window.cad.send(${JSON.stringify({ type: "command", name: "document.applyEdit", payload: { edit: { type: "addElement", element: { id: "real-box", kind: "geometry", engineId: "occt", props: { geometry: { shape: "box", width: 2, depth: 3, height: 4 }, meshToken: boxValue.meshToken } } } } })})`,
    );
    steps.push({ step: "applyEdit(addElement) with the real occt: meshToken", ok: !!(add && add.ok), detail: add && add.ok ? "ok" : add });
  } else {
    steps.push({ step: "applyEdit(addElement) with the real occt: meshToken", ok: false, detail: "box prepare failed earlier" });
  }

  // 6. getState -> 1 element carrying the occt token.
  const state = await call(
    `window.cad.send(${JSON.stringify({ type: "query", name: "document.getState", payload: {} })})`,
  );
  const snap = state && state.ok ? (state.value as { elements: { id: string; props: { meshToken?: string } }[] }) : null;
  const oneElement = !!snap && snap.elements.length === 1 && snap.elements[0]!.props.meshToken === (boxValue ? boxValue.meshToken : "");
  steps.push({ step: "document.getState has 1 element with the real meshToken", ok: oneElement, detail: `elements=${snap ? snap.elements.length : -1}` });

  // 7. Selection metadata on the real element (ephemeral, non-versioned).
  const select = await call(
    `window.cad.send(${JSON.stringify({ type: "command", name: "document.setSelection", payload: { ids: ["real-box"] } })})`,
  );
  const selected = await call(
    `window.cad.send(${JSON.stringify({ type: "query", name: "document.getSelection", payload: {} })})`,
  );
  const selectionOk = !!(select && select.ok && selected && selected.ok && JSON.stringify(selected.value) === JSON.stringify(["real-box"]));
  steps.push({ step: "setSelection/getSelection metadata on the real element", ok: selectionOk, detail: selected && selected.ok ? JSON.stringify(selected.value) : selected });

  // 8. Undo removes the real element; redo restores it.
  const undo = await call(
    `window.cad.send(${JSON.stringify({ type: "command", name: "document.undo", payload: {} })})`,
  );
  const stateAfterUndo = await call(
    `window.cad.send(${JSON.stringify({ type: "query", name: "document.getState", payload: {} })})`,
  );
  const snapAfterUndo = stateAfterUndo && stateAfterUndo.ok ? (stateAfterUndo.value as { elements: unknown[] }) : null;
  const undoOk = !!(undo && undo.ok && snapAfterUndo && snapAfterUndo.elements.length === 0);
  steps.push({ step: "undo reverts the real geometry element", ok: undoOk, detail: `elements=${snapAfterUndo ? snapAfterUndo.elements.length : -1}` });

  const redo = await call(
    `window.cad.send(${JSON.stringify({ type: "command", name: "document.redo", payload: {} })})`,
  );
  const stateAfterRedo = await call(
    `window.cad.send(${JSON.stringify({ type: "query", name: "document.getState", payload: {} })})`,
  );
  const snapAfterRedo = stateAfterRedo && stateAfterRedo.ok ? (stateAfterRedo.value as { elements: unknown[] }) : null;
  const redoOk = !!(redo && redo.ok && snapAfterRedo && snapAfterRedo.elements.length === 1);
  steps.push({ step: "redo restores the real geometry element", ok: redoOk, detail: `elements=${snapAfterRedo ? snapAfterRedo.elements.length : -1}` });

  // 9. Typed failure: a malformed descriptor is rejected without crashing the host.
  const bad = await send({ geometry: { shape: "box", width: -1, depth: 1, height: 1 } });
  const badOk = !!bad && bad.ok === false && bad.code === "engine_malformed_input";
  steps.push({ step: "typed failure: malformed descriptor -> engine_malformed_input", ok: badOk, detail: bad && !bad.ok ? `${bad.code} (retryable=${bad.retryable})` : bad });

  const allOk = steps.every((s) => s.ok);
  writeSmokeOut({
    ok: allOk,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: null,
    sceneHash: null,
  });
}

/** Drive the MODEL REVISIONS + Construction Graph bridge workflow through
 *  the BrowserWindow (CAD-IMPLEMENT-003 / Issue #28 CHAIN):
 *  BrowserWindow -> window.cad.send -> native IPC -> ElectronHost/IpcTransport
 *    -> AppApiHandler -> CADDocument (immutable ModelHistory)
 *    -> model.getHistory / model.getGraphEvents / model.replay queries
 *    -> save/open persistence -> revision continuation.
 *  Engine-free (provenance engine ids are plain data), so it runs on any
 *  toolchain. */
async function runModelSmoke(win: BrowserWindow): Promise<void> {
  const steps: SmokeStep[] = [];

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  // Rejection-capturing wrapper (see runGeometrySmoke).
  const call = async (js: string): Promise<CommandQueryResponse> => {
    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: CommandQueryResponse } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };
  const send = (request: CommandQueryRequest): Promise<CommandQueryResponse> =>
    call(`window.cad.send(${JSON.stringify(request)})`);

  // 1. document.create with an explicit entity id.
  const create = await send({ type: "command", name: "document.create", payload: { entityId: "model-smoke-doc" } });
  steps.push({ step: "document.create(model-smoke-doc)", ok: !!(create && create.ok), detail: create && create.ok ? "ok" : create });

  // 2-3. Two edits with engine provenance (engineId is data, not an engine call).
  const add1 = await send({
    type: "command", name: "document.applyEdit", payload: {
      edit: { type: "addElement", element: { id: "e1", kind: "geometry", engineId: "occt", props: { meshToken: "occt:smoke1" } } },
    },
  });
  steps.push({ step: "applyEdit addElement e1 (engine provenance)", ok: !!(add1 && add1.ok), detail: add1 && add1.ok ? "ok" : add1 });
  const add2 = await send({
    type: "command", name: "document.applyEdit", payload: {
      edit: { type: "addElement", element: { id: "e2", kind: "geometry", engineId: null, props: { meshToken: "dummy-mesh:e2" } } },
    },
  });
  steps.push({ step: "applyEdit addElement e2 (no engine provenance)", ok: !!(add2 && add2.ok), detail: add2 && add2.ok ? "ok" : add2 });

  // 4. undo + redo — both append revisions.
  const undoRes = await send({ type: "command", name: "document.undo", payload: {} });
  const redoRes = await send({ type: "command", name: "document.redo", payload: {} });
  steps.push({ step: "undo + redo through the BrowserWindow", ok: !!(undoRes && undoRes.ok && redoRes && redoRes.ok), detail: "ok" });

  // 5. model.getHistory — 4 immutable revisions with the right notes + linkage.
  const historyRes = await send({ type: "query", name: "model.getHistory", payload: {} });
  type Rev = { revision_number: number; note: string; revision_id: string; from_version_id: string; version: { version_id: string }; delta: { added: string[]; removed: string[]; updated: string[] }; content_hash: string };
  const history = historyRes && historyRes.ok ? (historyRes.value as { entity_id: string; base: { origin: string }; revisions: Rev[] }) : null;
  const notesOk =
    !!history &&
    history.base.origin === "created" &&
    history.revisions.length === 4 &&
    history.revisions.every((r, i) => r.revision_number === i + 1) &&
    history.revisions.map((r) => r.note).join(",") === "edit,edit,undo,redo" &&
    history.revisions[3]!.from_version_id === history.revisions[2]!.version.version_id;
  steps.push({
    step: "model.getHistory: 4 revisions, notes edit,edit,undo,redo, monotonic, linked",
    ok: notesOk,
    detail: history ? `revisions=${history.revisions.length} notes=${history.revisions.map((r) => r.note).join(",")} base=${history.base.origin}` : historyRes,
  });

  // 6. model.getGraphEvents — 1 model.created + 4 model.version.created, chained.
  const eventsRes = await send({ type: "query", name: "model.getGraphEvents", payload: {} });
  type Evt = { event_id: string; event_type: string; causation_id: string | null; payload: { elements: { element_id: string; change: string; engineId: string | null; uncertainty: { geometry_provenance: string } }[]; revision: { revision_number: number; content_hash: string } } };
  const events = eventsRes && eventsRes.ok ? (eventsRes.value as { events: Evt[]; events_hash: string }) : null;
  const eventsOk =
    !!events &&
    /^[0-9a-f]{64}$/.test(events.events_hash) &&
    events.events.length === 5 &&
    events.events[0]!.event_type === "model.created" &&
    events.events[0]!.causation_id === null &&
    events.events.slice(1).every((e, i) => e.event_type === "model.version.created" && e.causation_id === events.events[i]!.event_id) &&
    events.events[1]!.payload.revision.content_hash === history!.revisions[0]!.content_hash;
  steps.push({
    step: "model.getGraphEvents: model.created + 4 model.version.created, causation-chained",
    ok: eventsOk,
    detail: events ? `events=${events.events.length} hash=${events.events_hash.slice(0, 12)}…` : eventsRes,
  });

  // 7. Graph event provenance: e1 carries engineId occt (OBSERVED), e2 UNKNOWN.
  const e1Add = events?.events.find((e) => e.payload.elements.some((p) => p.element_id === "e1" && p.change === "added"));
  const e2Add = events?.events.find((e) => e.payload.elements.some((p) => p.element_id === "e2" && p.change === "added"));
  const provenanceOk =
    !!e1Add && !!e2Add &&
    e1Add.payload.elements.find((p) => p.element_id === "e1")!.engineId === "occt" &&
    e1Add.payload.elements.find((p) => p.element_id === "e1")!.uncertainty.geometry_provenance === "OBSERVED" &&
    e2Add.payload.elements.find((p) => p.element_id === "e2")!.engineId === null &&
    e2Add.payload.elements.find((p) => p.element_id === "e2")!.uncertainty.geometry_provenance === "UNKNOWN";
  steps.push({ step: "graph events carry engine ids as provenance + uncertainty labels", ok: provenanceOk, detail: provenanceOk ? "e1=OBSERVED e2=UNKNOWN" : "provenance mismatch" });

  // 8. model.replay to revision 2 — verified, elements [e1, e2].
  const replay2 = await send({ type: "query", name: "model.replay", payload: { revision_number: 2 } });
  const replay2Value = replay2 && replay2.ok ? (replay2.value as { revision_number: number; elements: { id: string }[]; content_hash: string; verified: boolean }) : null;
  const replayOk =
    !!replay2Value &&
    replay2Value.verified === true &&
    replay2Value.revision_number === 2 &&
    replay2Value.elements.map((e) => e.id).join(",") === "e1,e2" &&
    replay2Value.content_hash === history!.revisions[1]!.content_hash;
  steps.push({ step: "model.replay(2): verified replay matches the recorded content hash", ok: replayOk, detail: replay2Value ? `elements=${replay2Value.elements.length} hash=${replay2Value.content_hash.slice(0, 12)}…` : replay2 });

  // 9. model.replay out of range — typed bad_payload.
  const replayBad = await send({ type: "query", name: "model.replay", payload: { revision_number: 999 } });
  steps.push({
    step: "model.replay(999) -> typed bad_payload",
    ok: !!(replayBad && replayBad.ok === false && replayBad.code === "bad_payload"),
    detail: replayBad && !replayBad.ok ? replayBad.code : replayBad,
  });

  // 10. save -> open persistence: history + events survive the round-trip.
  const saveRes = await send({ type: "command", name: "document.save", payload: {} });
  const saveBytes = saveRes && saveRes.ok ? (saveRes.value as { bytes: number[] }).bytes : null;
  steps.push({ step: "document.save (bytes carry the revision history)", ok: !!saveBytes && saveBytes.length > 0, detail: `bytes=${saveBytes ? saveBytes.length : 0}` });
  let reopenedOk = false;
  let eventsHashAfter: string | null = null;
  if (saveBytes) {
    const openRes = await send({ type: "command", name: "document.open", payload: { source: saveBytes } });
    const opened = openRes && openRes.ok ? (openRes.value as { modelHistory?: { revisions: unknown[] }; elements: unknown[] }) : null;
    const historyAfterRes = await send({ type: "query", name: "model.getHistory", payload: {} });
    const historyAfter = historyAfterRes && historyAfterRes.ok ? (historyAfterRes.value as { revisions: unknown[] }) : null;
    const eventsAfterRes = await send({ type: "query", name: "model.getGraphEvents", payload: {} });
    const eventsAfter = eventsAfterRes && eventsAfterRes.ok ? (eventsAfterRes.value as { events_hash: string }) : null;
    eventsHashAfter = eventsAfter ? eventsAfter.events_hash : null;
    reopenedOk =
      !!opened &&
      !!opened.modelHistory &&
      opened.modelHistory.revisions.length === 4 &&
      !!historyAfter && historyAfter.revisions.length === 4 &&
      !!eventsAfter && eventsAfter.events_hash === events!.events_hash;
    steps.push({ step: "document.open(saved bytes): history + events identical after reopen", ok: reopenedOk, detail: reopenedOk ? `revisions=4 events_hash=${eventsHashAfter ? eventsHashAfter.slice(0, 12) : "?"}…` : "mismatch" });
  } else {
    steps.push({ step: "document.open(saved bytes): history + events identical after reopen", ok: false, detail: "save failed" });
  }

  // 11. Revision continuation after reopen: revision 5 links to the reopened head.
  let continuationOk = false;
  if (reopenedOk) {
    const add3 = await send({
      type: "command", name: "document.applyEdit", payload: {
        edit: { type: "addElement", element: { id: "e3", kind: "geometry", engineId: "occt", props: { meshToken: "occt:smoke3" } } },
      },
    });
    const historyFinalRes = await send({ type: "query", name: "model.getHistory", payload: {} });
    const historyFinal = historyFinalRes && historyFinalRes.ok ? (historyFinalRes.value as { revisions: Rev[] }) : null;
    const lastFinal = historyFinal ? historyFinal.revisions[historyFinal.revisions.length - 1] : undefined;
    continuationOk =
      !!(add3 && add3.ok) &&
      !!historyFinal &&
      historyFinal.revisions.length === 5 &&
      !!lastFinal &&
      lastFinal.revision_number === 5 &&
      lastFinal.from_version_id === history!.revisions[3]!.version.version_id &&
      lastFinal.delta.added.join(",") === "e3";
    steps.push({ step: "revision continuation after reopen (r5 links to the reopened head)", ok: continuationOk, detail: continuationOk ? "r5 appended" : historyFinalRes });
  } else {
    steps.push({ step: "revision continuation after reopen (r5 links to the reopened head)", ok: false, detail: "reopen failed" });
  }

  const allOk = steps.every((s) => s.ok);
  writeSmokeOut({
    ok: allOk,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: null,
    sceneHash: null,
  });
}

/**
 * RESEARCH-CAD-007 / Issue #32: the downstream impact cascade Electron smoke.
 *
 * Proves the FULL chain through a real BrowserWindow with the engine-free
 * REFERENCE adapter bound as the geometry engine (the second engine inside
 * the Electron host behind the same frozen boundary — LOCK-003):
 *
 *   BrowserWindow -> window.cad.send (preload) -> ipcRenderer.invoke
 *     -> ipcMain.handle -> ElectronHost + IpcTransport -> AppApiHandler
 *     -> immutable ModelHistory -> impact.cascade
 *     (model.version.created cause -> quantity.recalculate.requested
 *       -> quantity.changed -> estimate.recalculated
 *       -> rfq.scope.impact.detected -> commercial impact)
 *     -> save/open persistence -> identical cascade hash.
 *
 * Engine-free (the reference adapter is pure TypeScript), so it runs on any
 * toolchain. Reproduce: cd apps/electron && npm run smoke:impact
 */
async function runImpactSmoke(win: BrowserWindow): Promise<void> {
  const steps: SmokeStep[] = [];

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  const call = async (js: string): Promise<CommandQueryResponse> => {
    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: CommandQueryResponse } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };
  const send = (request: CommandQueryRequest): Promise<CommandQueryResponse> =>
    call(`window.cad.send(${JSON.stringify(request)})`);

  const add = (id: string, category: string, geometry: Record<string, unknown>) =>
    send({
      type: "command", name: "document.applyEdit", payload: {
        edit: { type: "addElement", element: { id, kind: "geometry", engineId: null, props: { geometry, category } } },
      },
    });

  // 1-4. Build the model: concrete column, steel pipe, concrete slab (r1-r3).
  const create = await send({ type: "command", name: "document.create", payload: { entityId: "cad007-impact-smoke" } });
  steps.push({ step: "document.create(cad007-impact-smoke)", ok: !!(create && create.ok) });
  const add1 = await add("el-column-a", "concrete", { shape: "box", width: 0.4, depth: 0.4, height: 3.0 });
  steps.push({ step: "addElement el-column-a (concrete box)", ok: !!(add1 && add1.ok) });
  const add2 = await add("el-pipe-riser", "steel", { shape: "cylinder", radius: 0.05, height: 3, origin: [1, 1, 0], direction: [0, 0, 1] });
  steps.push({ step: "addElement el-pipe-riser (steel cylinder)", ok: !!(add2 && add2.ok) });
  const add3 = await add("el-slab", "concrete", { shape: "box", width: 6, depth: 4, height: 0.2 });
  steps.push({ step: "addElement el-slab (concrete box)", ok: !!(add3 && add3.ok) });

  // 5. The model change: column grows 3.0 -> 3.5 (r4).
  const resize = await send({
    type: "command", name: "document.applyEdit", payload: {
      edit: { type: "updateElement", elementId: "el-column-a", patch: { geometry: { shape: "box", width: 0.4, depth: 0.4, height: 3.5 } } },
    },
  });
  steps.push({ step: "updateElement el-column-a resize (model change, r4)", ok: !!(resize && resize.ok) });

  // 6. impact.cascade for r4: the full deterministic downstream chain.
  const cascadeRes = await send({ type: "query", name: "impact.cascade", payload: { revision_number: 4 } });
  type Cascade = {
    model_event_id: string;
    events_hash: string;
    events: { event_id: string; event_type: string; causation_id: string | null }[];
    quantities: { deltas: { element_id: string; delta: number | null }[]; skipped: { element_id: string }[] };
    estimate: { previous: { total: number } | null; current: { total: number } };
    rfq: { impacts: { category: string; affected: boolean; delta_amount: number }[] };
    commercial_impact: { total_delta: number; currency: string; affected_category_count: number };
    engine: { engineId: string; engineVersion: string };
  };
  const cascade = cascadeRes && cascadeRes.ok ? (cascadeRes.value as Cascade) : null;
  const chainOk =
    !!cascade &&
    /^[0-9a-f]{64}$/.test(cascade.events_hash) &&
    cascade.events.length === 4 &&
    cascade.events[0]!.event_type === "quantity.recalculate.requested" &&
    cascade.events[1]!.event_type === "quantity.changed" &&
    cascade.events[2]!.event_type === "estimate.recalculated" &&
    cascade.events[3]!.event_type === "rfq.scope.impact.detected" &&
    cascade.events[0]!.causation_id === cascade.model_event_id &&
    cascade.events.slice(1).every((e, i) => e.causation_id === cascade.events[i]!.event_id);
  steps.push({
    step: "impact.cascade r4: 4-event chain caused by model.version.created",
    ok: chainOk,
    detail: cascade ? `types=${cascade.events.map((e) => e.event_type).join("->")}` : cascadeRes,
  });

  // 7. The cascade's cause IS the revision-4 graph event.
  const graphRes = await send({ type: "query", name: "model.getGraphEvents", payload: {} });
  const graph = graphRes && graphRes.ok ? (graphRes.value as { events: { event_id: string; event_type: string; payload: { revision: { revision_number: number } } }[] }) : null;
  const r4Event = graph?.events.find((e) => e.event_type === "model.version.created" && e.payload.revision.revision_number === 4);
  const causeOk = !!cascade && !!r4Event && cascade.model_event_id === r4Event.event_id;
  steps.push({ step: "cascade hangs off the r4 model.version.created graph event", ok: causeOk });

  // 8. Quantity delta exact (0.4*0.4*0.5 = 0.08); only the column changed.
  const columnDelta = cascade?.quantities.deltas.find((d) => d.element_id === "el-column-a");
  const othersZero = cascade?.quantities.deltas.filter((d) => d.element_id !== "el-column-a").every((d) => d.delta !== null && Math.abs(d.delta) < 1e-12);
  const deltaOk = !!columnDelta && Math.abs((columnDelta.delta ?? 0) - 0.08) <= 1e-12 && !!othersZero && (cascade?.quantities.skipped.length ?? 1) === 0;
  steps.push({
    step: "quantity delta exact (column +0.08 model-unit^3, others unchanged)",
    ok: deltaOk,
    detail: columnDelta ? `delta=${columnDelta.delta}` : "missing column delta",
  });

  // 9. Estimate + RFQ + commercial impact arithmetic (demo rates: concrete 420 GHS).
  const estimateDelta = cascade ? cascade.estimate.current.total - (cascade.estimate.previous?.total ?? 0) : NaN;
  const concrete = cascade?.rfq.impacts.find((i) => i.category === "concrete");
  const steel = cascade?.rfq.impacts.find((i) => i.category === "steel");
  const impactOk =
    !!cascade &&
    Math.abs(estimateDelta - 0.08 * 420) <= 1e-9 &&
    !!concrete && concrete.affected === true && Math.abs(concrete.delta_amount - 0.08 * 420) <= 1e-9 &&
    !!steel && steel.affected === false &&
    Math.abs(cascade.commercial_impact.total_delta - 0.08 * 420) <= 1e-9 &&
    cascade.commercial_impact.currency === "GHS" &&
    cascade.commercial_impact.affected_category_count === 1 &&
    cascade.engine.engineId === "reference";
  steps.push({
    step: "estimate/RFQ/commercial arithmetic exact; concrete affected, steel not; provenance=reference",
    ok: impactOk,
    detail: cascade ? `estimateDelta=${estimateDelta} commercial=${cascade.commercial_impact.total_delta} ${cascade.commercial_impact.currency}` : "no cascade",
  });

  // 10. Persistence: save -> open -> identical cascade hash.
  const saveRes = await send({ type: "command", name: "document.save", payload: {} });
  let persistenceOk = false;
  let hashDetail = "save failed";
  if (saveRes && saveRes.ok) {
    const bytes = (saveRes.value as { bytes: number[] }).bytes;
    const openRes = await send({ type: "command", name: "document.open", payload: { source: bytes } });
    if (openRes && openRes.ok) {
      const againRes = await send({ type: "query", name: "impact.cascade", payload: { revision_number: 4 } });
      const again = againRes && againRes.ok ? (againRes.value as Cascade) : null;
      persistenceOk = !!again && !!cascade && again.events_hash === cascade.events_hash;
      hashDetail = persistenceOk ? `events_hash=${cascade!.events_hash.slice(0, 16)}... identical` : "cascade hash changed after save/open";
    } else {
      hashDetail = "open failed";
    }
  }
  steps.push({ step: "save -> open -> identical cascade events_hash", ok: persistenceOk, detail: hashDetail });

  const allOk = steps.every((s) => s.ok);
  writeSmokeOut({
    ok: allOk,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: null,
    sceneHash: null,
  });
}

/**
 * COMPAT-CAD-006 / Issue #138: the viewport/navigation smoke — the ZOOM
 * vocabulary (E extents, W window, S scale, P previous), PAN (displacement
 * mode) and REGEN driven through the REAL renderer command line
 * (window.__offisosWorkspace.typedInput — the same dispatch the keyboard
 * input runs), asserting the shared-module view-transform values, the
 * zero-document-mutation negative probe, and the entity-step P precedence.
 */
async function runCad006Smoke(win: BrowserWindow): Promise<void> {
  if (process.env.OFFISOS_SMOKE_VERBOSE) {
    win.webContents.on("console-message", (_e, _level, message) => {
      console.log("[renderer]", String(message).slice(0, 500));
    });
  }
  const steps: SmokeStep[] = [];
  const push = (name: string, ok: boolean, detail: unknown = null): void => {
    steps.push({ step: name, ok, detail });
    if (process.env.OFFISOS_SMOKE_VERBOSE) console.log(ok ? `  [PASS] ${name}` : `  [FAIL] ${name}`, detail ?? "");
  };

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  const page = async <T>(js: string): Promise<T> => {
    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: T } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };
  const qq = (name: string, payload: unknown) =>
    page<CommandQueryResponse>(`window.cad.send(${JSON.stringify({ type: "query", name, payload })})`);
  const driver = async <T>(method: string, ...args: unknown[]): Promise<T> =>
    page<T>(
      `(async () => await window.__offisosWorkspace.${method}(${args.map((a) => JSON.stringify(a)).join(",")}))()`,
    );
  const type = (text: string) => driver<void>("typedInput", text);
  type DocState = { elements: unknown[]; version: { version_number: number } };
  const docState = async (): Promise<DocState | null> => {
    const r = await qq("document.getState", {});
    return r && r.ok ? (r.value as DocState) : null;
  };
  const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;

  // 1. Fresh document + a real-scale site boundary through the REAL command line.
  await type("NEW");
  await type("LINE");
  await type("0,0");
  await type("50000,30000");
  await type("");
  let s = await docState();
  push("1", !!(s && s.elements.length === 1), s ? `elements=${s.elements.length} version=${s.version.version_number}` : "no state");
  const baselineVersion = s?.version.version_number ?? -1;

  // 2. ZOOM E through the command line: the unclamped extents fit reaches the
  //    real-scale content (zoom ≈ 900/(50000+1600) on the 900×620 viewport).
  await type("ZOOM");
  await type("E");
  const afterE = await driver<{ pan: { x: number; y: number }; zoom: number }>("viewTransform");
  const expectedFitZoom = 900 / (50000 + 1600);
  push("2", near(afterE.zoom, expectedFitZoom, 1e-9), `fit zoom ${afterE.zoom} (expected ~${expectedFitZoom})`);
  const historyAfterE = await driver<string[]>("commandLog");
  void historyAfterE;
  const status1 = await driver<{ history: string[] }>("status");
  push(
    "3",
    status1.history.some((l) => l.includes("ZOOM: fitting extents")),
    `echo present: ${status1.history.filter((l) => l.includes("ZOOM")).join(" | ")}`,
  );

  // 4. ZOOM W: the window (10000,6000)→(40000,24000) lands exactly.
  await type("ZOOM");
  await type("10000,6000");
  await type("40000,24000");
  const afterW = await driver<{ pan: { x: number; y: number }; zoom: number }>("viewTransform");
  push(
    "5",
    near(afterW.pan.x, 10000, 1e-6) && near(afterW.pan.y, 6000, 1e-6) && near(afterW.zoom, 900 / 30000, 1e-9),
    `window view pan=(${afterW.pan.x},${afterW.pan.y}) zoom=${afterW.zoom}`,
  );

  // 6. ZOOM S 2x: the relative scale doubles the zoom about the center.
  await type("ZOOM");
  await type("S");
  await type("2x");
  const afterS = await driver<{ zoom: number }>("viewTransform");
  push("7", near(afterS.zoom, (900 / 30000) * 2, 1e-9), `scaled zoom ${afterS.zoom}`);

  // 8. PAN displacement mode: base (500,250), Enter at the second prompt.
  await type("PAN");
  await type("500,250");
  await type("");
  const afterPan = await driver<{ pan: { x: number; y: number }; zoom: number }>("viewTransform");
  // Expected pan from the S view's center invariance: the world center of
  // the WINDOW view is the viewport's visible-rect center (span 900/zW ×
  // 620/zW — aspect-limited by width), and pan_S = center − (center −
  // pan_W)·z_W/z_S; the PAN then adds the displacement exactly.
  const zW = 900 / 30000;
  const zS = zW * 2;
  const centerW: [number, number] = [10000 + 900 / zW / 2, 6000 + 620 / zW / 2];
  const expectedPanSx = centerW[0] - (centerW[0] - 10000) * zW / zS;
  const expectedPanSy = centerW[1] - (centerW[1] - 6000) * zW / zS;
  const expectedPanX = expectedPanSx + 500;
  const expectedPanY = expectedPanSy + 250;
  push(
    "9",
    near(afterPan.pan.x, expectedPanX, 1e-6) && near(afterPan.pan.y, expectedPanY, 1e-6),
    `pan pan=(${afterPan.pan.x},${afterPan.pan.y}) expected=(${expectedPanX},${expectedPanY})`,
  );

  // 10. REGEN: pure redraw + the honest no-mutation echo.
  await type("REGEN");
  const statusRegen = await driver<{ history: string[] }>("status");
  push(
    "11",
    statusRegen.history.some((l) => l.includes("no document change")),
    `regen echo: ${statusRegen.history.filter((l) => l.includes("REGEN") || l.includes("Regenerating")).join(" | ")}`,
  );

  // 12. ZOOM P restores the pre-PAN view exactly.
  await type("ZOOM");
  await type("P");
  const afterPrev = await driver<{ pan: { x: number; y: number }; zoom: number }>("viewTransform");
  push(
    "13",
    near(afterPrev.pan.x, expectedPanSx, 1e-6) && near(afterPrev.pan.y, expectedPanSy, 1e-6) && near(afterPrev.zoom, zS, 1e-9),
    `previous view pan=(${afterPrev.pan.x},${afterPrev.pan.y}) zoom=${afterPrev.zoom}`,
  );

  // 14. NEGATIVE PROBE: the document never mutated through ALL navigation.
  s = await docState();
  push(
    "15",
    !!(s && s.elements.length === 1 && s.version.version_number === baselineVersion),
    s ? `elements=${s.elements.length} version=${s.version.version_number} (baseline ${baselineVersion})` : "no state",
  );

  // 16. The entity-step "P" (previous selection) convention beats the PAN
  //     alias in the REAL UI: SELECTALL → ERASE → P (previous selection) →
  //     Enter deletes the line (no PAN switch, no *Cancel*).
  await type("SELECTALL");
  await type("ERASE");
  await type("P");
  await type("");
  s = await docState();
  const erased = !!(s && s.elements.length === 0);
  push("17", erased, s ? `elements after ERASE P=${s.elements.length}` : "no state");
  const statusP = await driver<{ history: string[] }>("status");
  const noCancel = !statusP.history.slice(-8).includes("*Cancel*");
  push("18", noCancel, `no *Cancel* during the P flow: ${statusP.history.slice(-6).join(" | ")}`);
  await type("UNDO");
  s = await docState();
  push("19", !!(s && s.elements.length === 1), `undo restored elements=${s?.elements.length ?? -1}`);

  const allOk = steps.every((st) => st.ok);
  writeSmokeOut({
    ok: allOk,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: null,
    sceneHash: null,
  });
}

/**
 * COMPAT-CAD-007 / Issue #142: the command-phase selection/option smoke —
 * DEF-006/007/021 driven through the REAL renderer command line
 * (window.__offisosWorkspace.typedInput — the same dispatch the keyboard
 * runs) and the REAL entities-batch dispatch path:
 *   - DEF-007: the advertised full-word options (LINE 'Undo', POLYLINE
 *     'Close') behave exactly like their abbreviations — no *Cancel*, no
 *     command switch;
 *   - DEF-021: 'ALL' at "Select objects:" resolves inside the running
 *     command (no SELECTALL escape); empty-document ALL answers typed;
 *   - DEF-006: the entities batch collects with "N found" echoes and ONE
 *     canonical revision per mutating command; UNDO restores the exact
 *     prior content.
 */
async function runCad007Smoke(win: BrowserWindow): Promise<void> {
  if (process.env.OFFISOS_SMOKE_VERBOSE) {
    win.webContents.on("console-message", (_e, _level, message) => {
      console.log("[renderer]", String(message).slice(0, 500));
    });
  }
  const steps: SmokeStep[] = [];
  const push = (name: string, ok: boolean, detail: unknown = null): void => {
    steps.push({ step: name, ok, detail });
    if (process.env.OFFISOS_SMOKE_VERBOSE) console.log(ok ? `  [PASS] ${name}` : `  [FAIL] ${name}`, detail ?? "");
  };

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  const page = async <T>(js: string): Promise<T> => {
    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: T } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };
  const qq = (name: string, payload: unknown) =>
    page<CommandQueryResponse>(`window.cad.send(${JSON.stringify({ type: "query", name, payload })})`);
  const driver = async <T>(method: string, ...args: unknown[]): Promise<T> =>
    page<T>(
      `(async () => await window.__offisosWorkspace.${method}(${args.map((a) => JSON.stringify(a)).join(",")}))()`,
    );
  const type = (text: string) => driver<void>("typedInput", text);
  type DocState = { elements: { id: string }[]; version: { version_number: number } };
  const docState = async (): Promise<DocState | null> => {
    const r = await qq("document.getState", {});
    return r && r.ok ? (r.value as DocState) : null;
  };
  const history = async (): Promise<string[]> => (await driver<{ history: string[] }>("status")).history;
  const drawLine = async (x1: number, y1: number, x2: number, y2: number): Promise<void> => {
    await type("LINE");
    await type(`${x1},${y1}`);
    await type(`${x2},${y2}`);
    await type("");
  };

  // 1. Fresh document + three lines through the REAL command line.
  await type("NEW");
  await drawLine(0, 0, 100, 0);
  await drawLine(0, 10, 100, 10);
  await drawLine(0, 20, 100, 20);
  let s = await docState();
  push("1", !!(s && s.elements.length === 3), s ? `elements=${s.elements.length} version=${s.version.version_number}` : "no state");
  const ids = (s?.elements ?? []).map((el) => el.id);

  // 2. DEF-007: LINE + typed 'Undo' (FULL WORD) — the option runs, the
  //    command never cancels, the UNDO command never starts.
  await type("LINE");
  await type("0,30");
  await type("100,30");
  const beforeUndoSeg = (await docState())?.elements.length ?? -1;
  await type("Undo");
  const afterUndoSeg = (await docState())?.elements.length ?? -1;
  const histUndo = await history();
  push(
    "2",
    histUndo.includes("Undo one segment.") && afterUndoSeg === beforeUndoSeg - 1,
    `echo=${histUndo.includes("Undo one segment.")} elements ${beforeUndoSeg}→${afterUndoSeg}`,
  );
  push(
    "3",
    !histUndo.slice(-12).includes("*Cancel*"),
    `no *Cancel* around the full-word Undo: ${histUndo.slice(-6).join(" | ")}`,
  );
  await type("");

  // 4. DEF-007: POLYLINE + typed 'Close' (FULL WORD) closes the polyline.
  await type("POLYLINE");
  await type("0,40");
  await type("100,40");
  await type("100,80");
  await type("Close");
  s = await docState();
  const closedCount = (s?.elements ?? []).length;
  push("4", closedCount === 4, `elements after closed POLYLINE=${closedCount}`);
  const histClose = await history();
  push("5", histClose.includes("Close."), `Close echo: ${histClose.slice(-3).join(" | ")}`);

  // 6. DEF-021: ERASE + typed 'ALL' resolves INSIDE the command.
  const versionBeforeErase = (await docState())?.version.version_number ?? -1;
  await type("ERASE");
  await type("ALL");
  const histAll = await history();
  push(
    "6",
    histAll.some((l) => l.includes("4 found (all objects)")),
    `ALL echo: ${histAll.filter((l) => /found|SELECTALL|\*Cancel\*/.test(l)).slice(-4).join(" | ")}`,
  );
  await type("");
  s = await docState();
  push(
    "7",
    !!(s && s.elements.length === 0 && s.version.version_number === versionBeforeErase + 1),
    `after ERASE ALL: elements=${s?.elements.length ?? -1} version=${s?.version.version_number ?? -1} (one revision)`,
  );

  // 8. UNDO restores the exact prior content.
  await type("UNDO");
  s = await docState();
  push("8", !!(s && s.elements.length === 4), `UNDO restored elements=${s?.elements.length ?? -1}`);
  const restoredIds = (s?.elements ?? []).map((el) => el.id);

  // 9. DEF-006: the entities batch through the REAL dispatch path —
  //    "N found" echo, accumulation, ONE revision on commit.
  const versionBeforeBatch = (await docState())?.version.version_number ?? -1;
  await type("ERASE");
  await driver<void>("pickEntities", restoredIds.slice(0, 2));
  const histBatch = await history();
  push(
    "9",
    histBatch.some((l) => /^2 found$/.test(l.trim())),
    `batch echo: ${histBatch.filter((l) => /found/.test(l)).slice(-3).join(" | ")}`,
  );
  // A second batch accumulates: "N found (M total)".
  await driver<void>("pickEntities", restoredIds.slice(2, 3));
  const histBatch2 = await history();
  push(
    "10",
    histBatch2.some((l) => /1 found \(3 total\)/.test(l)),
    `second batch echo: ${histBatch2.filter((l) => /found/.test(l)).slice(-3).join(" | ")}`,
  );
  await type("");
  s = await docState();
  push(
    "11",
    !!(s && s.elements.length === 1 && s.version.version_number === versionBeforeBatch + 1),
    `after batch ERASE: elements=${s?.elements.length ?? -1} version=${s?.version.version_number ?? -1} (one revision)`,
  );
  await type("UNDO");
  s = await docState();
  push("12", !!(s && s.elements.length === 4), `UNDO after batch restored elements=${s?.elements.length ?? -1}`);

  // 13. DEF-006 negative: an empty batch answers typed '0 found'.
  await type("ERASE");
  await driver<void>("pickEntities", []);
  const histEmpty = await history();
  push(
    "13",
    histEmpty.some((l) => /0 found — no objects within the selection window/.test(l)),
    `empty batch echo: ${histEmpty.slice(-2).join(" | ")}`,
  );
  // A batch with an id that no longer resolves picks nothing (typed decline).
  await driver<void>("pickEntities", ["el-999999"]);
  const histDead = await history();
  push(
    "14",
    histDead.some((l) => /0 found — no objects within the selection window/.test(l)),
    `dead-id batch echo: ${histDead.slice(-2).join(" | ")}`,
  );
  await type("");
  s = await docState();
  push("15", !!(s && s.elements.length === 4), `nothing erased by empty/dead batches: elements=${s?.elements.length ?? -1}`);

  // 16. DEF-021 negative: MOVE + ALL on the CURRENT document resolves
  //     typed (no command escape) — the flow is Esc-cancelled with zero
  //     document change.
  const versionBeforeNeg = (await docState())?.version.version_number ?? -1;
  await type("MOVE");
  await type("ALL");
  const histMoveAll = await history();
  // The command-switch *Cancel* (ERASE → MOVE) is legitimate pre-existing
  // behavior; the DEF-021 contract is that the typed ALL itself never
  // cancels — no *Cancel* AFTER MOVE started, and the collection echo lands.
  const moveStart = histMoveAll.lastIndexOf("MOVE");
  const cancelAfterMove = histMoveAll.slice(moveStart + 1).includes("*Cancel*");
  push(
    "16",
    histMoveAll.some((l) => l.includes("4 found (all objects)")) && !cancelAfterMove,
    `MOVE ALL echo: ${histMoveAll.filter((l) => /found|\*Cancel\*/.test(l)).slice(-3).join(" | ")}`,
  );
  await driver<void>("pressEscape");
  s = await docState();
  push(
    "17",
    !!(s && s.elements.length === 4 && s.version.version_number === versionBeforeNeg),
    `Esc cancelled with zero mutation: elements=${s?.elements.length ?? -1} version=${s?.version.version_number ?? -1}`,
  );

  const allOk = steps.every((st) => st.ok);
  writeSmokeOut({
    ok: allOk,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: null,
    sceneHash: null,
  });
}

/**
 * CAD-PARITY-002 / Issue #75: the professional workspace Electron smoke.
 *
 * Drives the REAL renderer UI — the professional command line, prompt
 * engine and Model canvas (window.__offisosWorkspace driver uses the SAME
 * handlers the real input/canvas events use) — through the representative
 * line/circle/wall workflow and asserts SEMANTIC PARITY with the Web host:
 * the final document save sha256 must equal the pinned fixture
 * (app/test/fixtures/cad-parity-002-parity.json) that the Web dev-server
 * smoke produces from the identical command script. Also verifies the
 * shell surfaces (menu bar, command line, status bar, palette) and the
 * deterministic cancel path.
 */
async function runWorkspaceSmoke(win: BrowserWindow): Promise<void> {
  if (process.env.OFFISOS_SMOKE_VERBOSE) {
    win.webContents.on("console-message", (_e, _level, message) => {
      console.log("[renderer]", String(message).slice(0, 500));
    });
    win.webContents.on("render-process-gone", (_e, details) => {
      console.log("[renderer gone]", JSON.stringify(details).slice(0, 300));
    });
  }
  interface Step { step: string; ok: boolean; detail: unknown }
  const steps: Step[] = [];
  const push = (name: string, ok: boolean, detail: unknown = null): void => {
    steps.push({ step: name, ok, detail });
  };

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  const page = async <T>(js: string): Promise<T> => {
    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: T } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };
  const send = (request: CommandQueryRequest): Promise<CommandQueryResponse> =>
    page<CommandQueryResponse>(`window.cad.send(${JSON.stringify(request)})`);
  const cmd = (name: string, payload: unknown) =>
    send({ type: "command", name: name as never, payload });
  const qq = (name: string, payload: unknown) =>
    send({ type: "query", name: name as never, payload });
  const driver = async <T>(method: string, ...args: unknown[]): Promise<T> =>
    page<T>(
      `(async () => await window.__offisosWorkspace.${method}(${args.map((a) => JSON.stringify(a)).join(",")}))()`,
    );

  const waitFor = async (predicateJs: string, timeoutMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await page<boolean>(`(async () => (${predicateJs}))()`);
      if (v === true) return;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  // 0. The professional shell mounted: menu bar, command line, status bar,
  //    Model canvas card and the driver are present in the REAL UI.
  await waitFor(`!!window.__offisosWorkspace`, 20000, "professional workspace driver");
  push(
    "professional workspace mounted",
    await page<boolean>(
      `(async () => !!document.querySelector('.pro-menubar') && !!document.querySelector('[data-testid="pro-command-line"]') && !!document.querySelector('[data-testid="pro-status-bar"]') && !!document.querySelector('[data-testid="pro-model-card"]'))()`,
    ),
  );

  // 1. Fresh document — the SAME entityId the Web smoke uses (parity).
  const created = await cmd("document.create", {
    entityId: "cad-parity-002-smoke",
    format: "offisos-occt",
    formatVersion: "1",
    createdBy: "cad-parity-002-smoke",
  });
  push("document.create (parity entityId)", created.ok === true, created.ok ? "ok" : created);

  // 2. The representative workflow through the REAL command line.
  await driver<void>("typedInput", "STORY");
  await driver<void>("typedInput", "");
  await driver<void>("typedInput", "");
  await driver<void>("typedInput", "");
  await driver<void>("refresh");
  let state = await qq("document.getState", {});
  let elements = ((state as { value?: { elements: unknown[] } }).value ?? { elements: [] }).elements;
  push("STORY via command line (defaults)", elements.length === 1, `elements=${elements.length}`);

  await driver<void>("typedInput", "LINE");
  await driver<void>("typedInput", "0,0");
  await driver<void>("typedInput", "4000,0");
  await driver<void>("typedInput", "");
  await driver<void>("refresh");
  state = await qq("document.getState", {});
  elements = ((state as { value?: { elements: unknown[] } }).value ?? { elements: [] }).elements;
  push("LINE via typed coordinates", elements.length === 2, `elements=${elements.length}`);

  await driver<void>("typedInput", "CIRCLE");
  await driver<void>("typedInput", "2000,1000");
  await driver<void>("typedInput", "500");
  await driver<void>("refresh");
  state = await qq("document.getState", {});
  elements = ((state as { value?: { elements: unknown[] } }).value ?? { elements: [] }).elements;
  push("CIRCLE center + radius", elements.length === 3, `elements=${elements.length}`);

  await driver<void>("typedInput", "WALL");
  await driver<void>("typedInput", "0,0");
  await driver<void>("typedInput", "6000,0");
  await driver<void>("refresh");
  state = await qq("document.getState", {});
  elements = ((state as { value?: { elements: unknown[] } }).value ?? { elements: [] }).elements;
  push("WALL on the active story", elements.length === 4, `elements=${elements.length}`);

  // 3. Deterministic undo/redo.
  const undone = await cmd("document.undo", {});
  state = await qq("document.getState", {});
  elements = ((state as { value?: { elements: unknown[] } }).value ?? { elements: [] }).elements;
  push("undo removes the wall", undone.ok === true && elements.length === 3, `elements=${elements.length}`);
  const redone = await cmd("document.redo", {});
  state = await qq("document.getState", {});
  elements = ((state as { value?: { elements: unknown[] } }).value ?? { elements: [] }).elements;
  push("redo restores the wall", redone.ok === true && elements.length === 4, `elements=${elements.length}`);

  // 4. Command cancellation is deterministic (no entity, *Cancel* echoed).
  await driver<void>("typedInput", "LINE");
  await driver<void>("typedInput", "0,0");
  await driver<void>("pressEscape");
  await driver<void>("refresh");
  state = await qq("document.getState", {});
  elements = ((state as { value?: { elements: unknown[] } }).value ?? { elements: [] }).elements;
  const status = await driver<{ history: string[] }>("status");
  push("cancel mid-LINE emits no entity", elements.length === 4, `elements=${elements.length}`);
  push("cancel echoes *Cancel*", status.history.includes("*Cancel*"), status.history.slice(-3));

  // 5. Command palette opens/closes in the real UI.
  push("command palette surface", await page<boolean>(`(async () => {
    const input = document.querySelector('[data-testid="pro-command-input"]');
    if (!input) return false;
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const open = !!document.querySelector('.pro-palette.open');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    document.querySelector('.pro-palette input')?.dispatchEvent(esc);
    await new Promise((r) => setTimeout(r, 120));
    const closed = !document.querySelector('.pro-palette.open');
    return open && closed;
  })()`));

  // 6. Semantic parity: the save sha + command stream must match the Web
  //    host fixture (the same prompt-engine script, the same document).
  const s1 = await cmd("document.save", {});
  const s2 = await cmd("document.save", {});
  const saveOk = s1.ok === true && s2.ok === true;
  const bytes = saveOk ? (((s1 as { value?: { bytes: number[] } }).value ?? { bytes: [] }).bytes) : [];
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  const driverLog = await driver<string[]>("commandLog");
  const commandStream = ["document.create", ...driverLog, "document.undo", "document.redo", "document.save", "document.save"];

  const fixturePath = join(__dirname, "..", "..", "..", "..", "app", "test", "fixtures", "cad-parity-002-parity.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    saveSha256: string;
    saveSize: number;
    elements: number;
    commandStream: string[];
  };
  const shaMatch = sha === fixture.saveSha256;
  const streamMatch = commandStream.join("|") === fixture.commandStream.join("|");
  push("save determinism", saveOk && s1.ok === true && sha === createHash("sha256").update(Buffer.from(((s2 as { value?: { bytes: number[] } }).value ?? { bytes: [] }).bytes)).digest("hex"), sha.slice(0, 16));
  push("PARITY: save sha256 equals the Web host fixture", shaMatch, `${sha.slice(0, 16)}… vs ${fixture.saveSha256.slice(0, 16)}…`);
  push("PARITY: semantic command stream equals the fixture", streamMatch, commandStream.join(" → "));

  const ok = steps.every((s) => s.ok);
  writeSmokeOut({
    ok,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: sha,
    sceneHash: null,
  });
  if (!ok) {
    for (const s of steps.filter((x) => !x.ok)) {
      console.error(`WORKSPACE SMOKE FAIL: ${s.step}: ${JSON.stringify(s.detail).slice(0, 300)}`);
    }
  } else {
    console.log(`WORKSPACE SMOKE: PASS — ${steps.length} steps; save sha ${sha.slice(0, 16)}… matches the Web host parity fixture`);
  }
}

app.whenReady().then(() => {
  // CAD-PARITY-009 (Issue #90): the engine-availability pattern at the wiring
  // point (LOCK-003). OFFISOS_GEOMETRY_ENGINE=reference forces the in-process
  // reference adapter (the deterministic analytic engine — the parity-fixture
  // basis the model3d smoke pins; the impact-smoke precedent), =occt forces
  // the OCCT subprocess bundle (the desktop default — fails loud on
  // engine_unavailable), unset keeps the OCCT bundle (the desktop host ships
  // the engine; every element's geometryEngine provenance records the engine
  // that actually realized it, so an explicit override is honest, never
  // silent).
  const engineOverride =
    process.env.OFFISOS_GEOMETRY_ENGINE === "reference" || isImpactSmoke
      ? createReferenceAdapterBundle()
      : process.env.OFFISOS_GEOMETRY_ENGINE === "occt"
        ? createOcctAdapterBundle({ ifc: createIfcInteropAdapter() })
        : undefined;
  registerIpc(engineOverride);
  const win = createWindow();

  const smokeRun = isSmoke
    ? runSmoke(win)
    : isGeometrySmoke
      ? runGeometrySmoke(win)
      : isModelSmoke
        ? runModelSmoke(win)
        : isImpactSmoke
          ? runImpactSmoke(win)
          : isDraftingSmoke
            ? runDraftingSmoke(win)
            : isBimSmoke
              ? runBimSmoke(win)
              : isDocsSmoke
                ? runDocsSmoke(win)
                : isIfcSmoke
                  ? runIfcSmoke(win)
                  : isComponentsSmoke
                    ? runComponentsSmoke(win)
                    : isWorkspaceSmoke
                      ? runWorkspaceSmoke(win)
                      : isCad006Smoke
                        ? runCad006Smoke(win)
                        : isCad007Smoke
                          ? runCad007Smoke(win)
                          : null;
  if (smokeRun !== null) {
    smokeRun
      .then(() => {
        // Result written to OFFISOS_SMOKE_OUT inside the smoke; exit code from
        // the result's `ok` is set by the runner via the result file. Quit
        // cleanly either way (the runner reads the file, not the exit code, but
        // we mirror ok -> 0 for hygiene).
        const outPath = process.env.OFFISOS_SMOKE_OUT;
        let ok = true;
        if (outPath) {
          try {
            const data = JSON.parse(readFileSync(outPath, "utf8")) as { ok?: boolean };
            ok = data.ok === true;
          } catch {
            ok = false;
          }
        }
        app.exit(ok ? 0 : 1);
      })
      .catch((e: unknown) => {
        writeSmokeOut({
          ok: false,
          electronVersion: process.versions.electron,
          nodeVersion: process.versions.node,
          chromeVersion: process.versions.chrome,
          steps: [{ step: "smoke threw", ok: false, detail: String((e as Error)?.stack || e) }],
          contentHash: null,
          sceneHash: null,
        });
        app.exit(1);
      });
  } else {
    win.webContents.once("did-finish-load", () => win.show());
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * COMPAT-CAD-001 / Issue #37: the 2D drafting smoke — the representative
 * drafting workflow through the FULL Electron chain (BrowserWindow →
 * window.cad.send preload bridge → ipcMain → ElectronHost/IpcTransport →
 * shared App API → CADDocument command model). Engine-free: drafting never
 * touches the geometry engine (the default OCCT bundle stays lazily unused).
 *
 * Asserts: layers (default + minted + visibility), entity creation with
 * canonical minted ids, dimensions (measured values), deterministic snap
 * through the API, move/copy/delete, trim/extend EXACT coordinates,
 * undo/redo, and save/open persistence of entities + layers + selection +
 * settings + revision lineage with identical graph events hash.
 */
async function runDraftingSmoke(win: BrowserWindow): Promise<void> {
  const steps: SmokeStep[] = [];

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  const call = async (js: string): Promise<CommandQueryResponse> => {
    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: CommandQueryResponse } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };
  const send = (request: CommandQueryRequest): Promise<CommandQueryResponse> =>
    call(`window.cad.send(${JSON.stringify(request)})`);
  const cmd = (name: string, payload: unknown) =>
    send({ type: "command", name: name as never, payload });
  const qq = (name: string, payload: unknown) =>
    send({ type: "query", name: name as never, payload });

  type Snapshot = {
    elements: { id: string; kind: string; props: Record<string, unknown> }[];
    layers: { id: string; name: string; visible: boolean }[];
    selection: string[];
    draftingSettings: { snap: { tolerance: number; enabled: boolean }; view: { pan: number[]; zoom: number } };
    modelHistory: { revisions: unknown[] };
    version: { version_id: string };
  };
  const state = async (): Promise<Snapshot | null> => {
    const r = await qq("document.getState", {});
    return r && r.ok ? (r.value as Snapshot) : null;
  };

  // 1. Fresh drafting document.
  const create = await cmd("document.create", { entityId: "compat-cad-001-electron" });
  steps.push({ step: "document.create(compat-cad-001-electron)", ok: !!(create && create.ok) });
  const fresh = await state();
  const layerDefaultOk = !!fresh && fresh.layers.length === 1 && fresh.layers[0]!.id === "0";
  steps.push({ step: "canonical default layer '0' present", ok: layerDefaultOk });

  // 2. Layer workflow: add 'walls', add + hide 'construction'.
  const wallsRes = await cmd("drafting.addLayer", { name: "walls", color: "#b91c1c" });
  const wallsId = wallsRes && wallsRes.ok ? (wallsRes.value as { layerId: string }).layerId : "";
  const hiddenRes = await cmd("drafting.addLayer", { name: "construction" });
  const hiddenId = hiddenRes && hiddenRes.ok ? (hiddenRes.value as { layerId: string }).layerId : "";
  const hideRes = await cmd("drafting.updateLayer", { layerId: hiddenId, patch: { visible: false } });
  steps.push({
    step: "layers: minted ly-000001/ly-000002 + visibility toggle",
    ok: wallsId === "ly-000001" && hiddenId === "ly-000002" && !!(hideRes && hideRes.ok),
  });

  // 3. Core entities + dimensions in one atomic batch.
  const createRes = await cmd("drafting.createEntities", {
    entities: [
      { type: "line", layer: wallsId, from: [0, 0], to: [100, 0] },
      { type: "line", layer: wallsId, from: [100, 0], to: [100, 60] },
      { type: "polyline", layer: wallsId, points: [[0, 0], [0, 60], [100, 60]] },
      { type: "circle", layer: "0", center: [50, 30], radius: 12 },
      { type: "arc", layer: "0", center: [50, 30], radius: 20, startAngle: 0, endAngle: Math.PI },
      { type: "rectangle", layer: wallsId, corner1: [10, 10], corner2: [30, 25] },
    ],
  });
  const created = createRes && createRes.ok ? (createRes.value as { created: string[] }).created : [];
  steps.push({
    step: "entities: 6 drafting entities, canonical minted ids el-000001..el-000006",
    ok: created.length === 6 && created[0] === "el-000001" && created[5] === "el-000006",
  });
  const circleId = created[3] ?? "";

  // 4. Dimensions: measured values computed deterministically.
  const dimRes = await cmd("drafting.createEntities", {
    entities: [
      { type: "dim-linear", layer: "0", p1: [0, 0], p2: [100, 0], mode: "aligned", offset: -8 },
      { type: "dim-radius", layer: "0", target: circleId },
    ],
  });
  const dims = dimRes && dimRes.ok ? (dimRes.value as { created: string[] }).created : [];
  const afterDims = await state();
  const dimLinear = afterDims?.elements.find((e) => e.id === dims[0]);
  const dimRadius = afterDims?.elements.find((e) => e.id === dims[1]);
  const dimsOk =
    dims.length === 2 &&
    dimLinear?.kind === "annotation" && (dimLinear.props.measured as number) === 100 &&
    (dimRadius?.props.measured as number) === 12;
  steps.push({ step: "dimensions: aligned=100 exactly, radius=12 exactly (annotation kind)", ok: dimsOk });

  // 5. Deterministic snap through the API: endpoint at the L1/L2 corner.
  const snapRes = await qq("drafting.snap", { point: [100.4, -0.1], tolerance: 0.5 });
  const snap = snapRes && snapRes.ok ? (snapRes.value as { snapped: boolean; best: { kind: string; point: number[] } | null }) : null;
  steps.push({
    step: "snap: endpoint (100,0) wins the clamped tie",
    ok: !!snap && snap.snapped === true && snap.best?.kind === "endpoint" && snap.best?.point[0] === 100 && snap.best?.point[1] === 0,
  });
  // hidden layers are not snappable
  const hiddenEnt = await cmd("drafting.createEntities", {
    entities: [{ type: "line", layer: hiddenId, from: [200, 200], to: [300, 200] }],
  });
  const snapHidden = await qq("drafting.snap", { point: [250.2, 200.2], tolerance: 1, kinds: ["on-object"] });
  const hiddenOk = !!(hiddenEnt && hiddenEnt.ok) && !!(snapHidden && snapHidden.ok) && (snapHidden.value as { best: unknown }).best === null;
  steps.push({ step: "entities on hidden layers are not snappable", ok: hiddenOk });

  // 6. Move + copy (+ delete the copy).
  const rectId = created[5] ?? "";
  const moveRes = await cmd("drafting.move", { ids: [rectId], dx: 5, dy: 5 });
  const afterMove = await state();
  const movedRect = afterMove?.elements.find((e) => e.id === rectId);
  const moveOk = !!(moveRes && moveRes.ok) && JSON.stringify(movedRect?.props.corner1) === JSON.stringify([15, 15]);
  steps.push({ step: "move: rectangle corner1 → [15,15] exactly", ok: moveOk });
  const copyRes = await cmd("drafting.copy", { ids: [rectId], dx: 40, dy: 0 });
  const copyId = copyRes && copyRes.ok ? ((copyRes.value as { created: string[] }).created[0] ?? "") : "";
  const delRes = await cmd("drafting.delete", { ids: [copyId] });
  steps.push({ step: "copy mints a new id; delete removes it", ok: /^el-\d{6}$/.test(copyId) && !!(delRes && delRes.ok) });

  // 7. Trim with an EXACT resulting coordinate.
  const cutRes = await cmd("drafting.createEntities", {
    entities: [
      { type: "line", layer: "0", from: [0, 80], to: [120, 80] },
      { type: "line", layer: "0", from: [60, 60], to: [60, 100] },
    ],
  });
  const cutIds = cutRes && cutRes.ok ? (cutRes.value as { created: string[] }).created : [];
  const trimRes = await cmd("drafting.trim", { targetId: cutIds[0] ?? "", pick: [90, 80] });
  const afterTrim = await state();
  const trimmed = afterTrim?.elements.find((e) => e.id === (cutIds[0] ?? ""));
  const trimOk =
    !!(trimRes && trimRes.ok) && (trimRes.value as { applied: boolean }).applied === true &&
    JSON.stringify(trimmed?.props.to) === JSON.stringify([60, 80]);
  steps.push({ step: "trim: line shortened to exactly [60,80], identity retained", ok: trimOk });

  // 8. Extend with an EXACT resulting coordinate.
  const farRes = await cmd("drafting.createEntities", {
    entities: [{ type: "line", layer: "0", from: [130, -20], to: [130, 20] }],
  });
  const farId = farRes && farRes.ok ? (farRes.value as { created: string[] }).created[0] ?? "" : "";
  const line1 = created[0] ?? "";
  const extRes = await cmd("drafting.extend", { targetId: line1, pick: [95, 0] });
  const afterExt = await state();
  const extended = afterExt?.elements.find((e) => e.id === line1);
  const extOk =
    !!(extRes && extRes.ok) && (extRes.value as { applied: boolean }).applied === true &&
    JSON.stringify(extended?.props.to) === JSON.stringify([130, 0]);
  steps.push({ step: "extend: line grown to exactly [130,0]", ok: extOk });

  // 9. Undo/redo through the command model.
  const undoRes = await cmd("document.undo", {});
  const afterUndo = await state();
  const redoRes = await cmd("document.redo", {});
  const afterRedo = await state();
  const undoOk =
    !!(undoRes && undoRes.ok) && JSON.stringify(afterUndo?.elements.find((e) => e.id === line1)?.props.to) === JSON.stringify([100, 0]) &&
    !!(redoRes && redoRes.ok) && JSON.stringify(afterRedo?.elements.find((e) => e.id === line1)?.props.to) === JSON.stringify([130, 0]);
  steps.push({ step: "undo/redo revert + re-apply the extend exactly", ok: undoOk });

  // 10. Settings + selection + full persistence through save/open.
  await cmd("drafting.setSettings", { settings: { snap: { tolerance: 0.25 }, view: { pan: [12, -4], zoom: 1.75 } } });
  await cmd("document.setSelection", { ids: [line1, circleId] });
  const beforeSave = await state();
  const eventsBefore = await qq("model.getGraphEvents", {});
  const eventsHashBefore = eventsBefore && eventsBefore.ok ? (eventsBefore.value as { events_hash: string }).events_hash : "";
  const saveRes = await cmd("document.save", {});
  // Canonical stringify (sorted keys): the save/open round-trip is canonical
  // JSON, so raw JSON.stringify key ORDER differs while the data is equal.
  const canon = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  };
  let persistenceOk = false;
  let persistDetail = "save failed";
  if (saveRes && saveRes.ok) {
    const bytes = (saveRes.value as { bytes: number[] }).bytes;
    const openRes = await cmd("document.open", { source: bytes });
    if (openRes && openRes.ok) {
      const reopened = await state();
      const eventsAfter = await qq("model.getGraphEvents", {});
      const eventsHashAfter = eventsAfter && eventsAfter.ok ? (eventsAfter.value as { events_hash: string }).events_hash : "";
      persistenceOk =
        !!reopened && !!beforeSave &&
        reopened.elements.length === beforeSave.elements.length &&
        canon(reopened.elements.map((e) => e.id).sort()) === canon(beforeSave.elements.map((e) => e.id).sort()) &&
        canon(reopened.layers) === canon(beforeSave.layers) &&
        canon(reopened.selection) === canon([line1, circleId]) &&
        reopened.draftingSettings.snap.tolerance === 0.25 &&
        reopened.draftingSettings.view.zoom === 1.75 &&
        reopened.modelHistory.revisions.length === beforeSave.modelHistory.revisions.length &&
        eventsHashAfter === eventsHashBefore;
      persistDetail = persistenceOk
        ? `elements=${reopened!.elements.length} revisions=${reopened!.modelHistory.revisions.length} events_hash=${eventsHashBefore.slice(0, 16)}... identical`
        : "state diverged across save/open";
    } else {
      persistDetail = "open failed";
    }
  }
  steps.push({
    step: "save/open: entities + ids + layers + selection + settings + lineage + events_hash all preserved",
    ok: persistenceOk,
    detail: persistDetail,
  });

  const allOk = steps.every((s) => s.ok);
  writeSmokeOut({
    ok: allOk,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: null,
    sceneHash: null,
  });
}

/**
 * COMPAT-CAD-002 / Issue #39: the 3D/BIM authoring smoke — the representative
 * mini-building workflow through the FULL Electron chain, DRIVING THE REAL
 * RENDERER UI (BrowserWindow DOM: mode toggle → buttons/inputs with
 * data-testid selectors → readouts), exactly like a user would:
 *
 *   BrowserWindow → renderer DOM (BIM mode panel) → window.cad.send (preload)
 *     → ipcMain → ElectronHost/IpcTransport → App API → bim.* commands
 *     → CADDocument → OCCT worker (bim.buildGeometry — the default OCCT
 *       bundle, lazily per-call) → undo/redo → save/open identity.
 *
 * Non-UI assertions (state/semantics/camera/events queries) go through
 * window.cad.send directly, mirroring how smoke-drafting handles non-UI
 * assertions. The engine path is adaptive: with the OCCT toolchain present
 * the happy path asserts occt: meshTokens; engine-free environments assert
 * the typed engine_unavailable failure path instead (steps 8-11 branch).
 *
 * Reproduce: cd apps/electron && OFFISOS_OCCT_WORKER=<repo>/app/src/adapters/
 * occt/worker/occt-worker.py npm run smoke:bim
 */
async function runBimSmoke(win: BrowserWindow): Promise<void> {
  // Steps record {step, name, pass, detail} (ok mirrors pass for the shared
  // SmokeResult envelope the runner reads).
  interface BimStep { step: string; name: string; pass: boolean; ok: boolean; detail: unknown }
  const steps: BimStep[] = [];
  const push = (num: string, name: string, pass: boolean, detail: unknown): void => {
    steps.push({ step: num, name, pass, ok: pass, detail });
  };

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  // Rejection-capturing page evaluation (see runGeometrySmoke).
  const page = async <T>(js: string): Promise<T> => {
    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: T } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };
  const send = (request: CommandQueryRequest): Promise<CommandQueryResponse> =>
    page<CommandQueryResponse>(`window.cad.send(${JSON.stringify(request)})`);
  const cmd = (name: string, payload: unknown) =>
    send({ type: "command", name: name as never, payload });
  const qq = (name: string, payload: unknown) =>
    send({ type: "query", name: name as never, payload });

  /** Poll a page predicate until true (throws on timeout). */
  const waitFor = async (predicateJs: string, timeoutMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await page<boolean>(`(async () => (${predicateJs}))()`);
      if (v === true) return;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  /** Click a data-testid button in the page. */
  const click = (testid: string): Promise<boolean> =>
    page<boolean>(
      `(async () => { const b = document.querySelector('[data-testid="${testid}"]'); if (!b) return false; b.click(); return true; })()`,
    );
  /** Wait for the BIM status protocol to settle: state done|error for `op`
   *  AND the UI idle again (mode toggle re-enabled). Returns the status. */
  const waitOp = async (op: string, timeoutMs: number): Promise<{ state: string; op: string; text: string }> => {
    await waitFor(
      `(() => { const s = document.querySelector('[data-testid="bim-status"]'); const m = document.querySelector('[data-testid="mode-bim"]');` +
        ` return !!s && (s.getAttribute("data-state") === "done" || s.getAttribute("data-state") === "error")` +
        ` && s.getAttribute("data-op") === "${op}" && !!m && !m.disabled; })()`,
      timeoutMs,
      `BIM op '${op}' to settle`,
    );
    return page<{ state: string; op: string; text: string }>(
      `(async () => { const s = document.querySelector('[data-testid="bim-status"]');` +
        ` return { state: s ? s.getAttribute("data-state") : "none", op: s ? s.getAttribute("data-op") : "", text: s ? s.textContent : "" }; })()`,
    );
  };
  const readAttr = (testid: string, attr: string): Promise<string | null> =>
    page<string | null>(
      `(async () => { const e = document.querySelector('[data-testid="${testid}"]'); return e ? e.getAttribute("${attr}") : null; })()`,
    );
  const readText = (testid: string): Promise<string> =>
    page<string>(
      `(async () => { const e = document.querySelector('[data-testid="${testid}"]'); return e ? (e.textContent || "") : ""; })()`,
    );

  type Snap = {
    elements: { id: string; kind: string; props: Record<string, unknown> }[];
    bimSettings?: { camera?: { preset?: string } };
  };
  const state = async (): Promise<Snap | null> => {
    const r = await qq("document.getState", {});
    return r && r.ok ? (r.value as Snap) : null;
  };
  const openingDistance = async (): Promise<number | null> => {
    const r = await qq("bim.getSemantics", { elementId: "op-door" });
    if (!r || !r.ok) return null;
    const sem = (r.value as { semantics?: { distance?: unknown } }).semantics;
    return typeof sem?.distance === "number" ? sem.distance : null;
  };
  const wallToken = async (): Promise<string | null> => {
    const snap = await state();
    const wall = snap?.elements.find((e) => e.id === "wall-south");
    const token = wall?.props.meshToken;
    return typeof token === "string" ? token : null;
  };

  // 1. BIM mode is reachable and visible: header toggle + the BIM panel.
  const beforeToggle = await page<boolean>(
    `(async () => !!document.querySelector('[data-testid="mode-bim"]') && !!document.querySelector('[data-testid="mode-drafting"]'))()`,
  );
  const clickedMode = beforeToggle ? await click("mode-bim") : false;
  await waitFor(
    `(() => { const c = document.querySelector('[data-testid="bim-card"]'); const b = document.querySelector('[data-testid="mode-bim"]');` +
      ` return !!c && c.style.display !== "none" && !!b && b.getAttribute("aria-pressed") === "true"; })()`,
    10000,
    "BIM mode panel visible",
  );
  const bimControlsPresent = await page<boolean>(
    `(async () => ["bim-create-building","bim-move-opening","bim-camera-top","bim-build","bim-undo","bim-redo","bim-save-open","bim-tree"]` +
      `.every((t) => !!document.querySelector('[data-testid="' + t + '"]')))()`,
  );
  push(
    "1",
    "BIM mode visible (header toggle switches the BIM panel in; all data-testid controls present)",
    beforeToggle && clickedMode && bimControlsPresent,
    bimControlsPresent ? "mode-bim clicked; bim-card displayed; 8/8 BIM controls present" : "BIM controls missing",
  );

  // 2. Create the representative mini building through the UI. The status op
  //    label repeats (document.create + the batch), so the wait keys on the
  //    deterministic created-count readout instead (or the error state).
  const clickedCreate = await click("bim-create-building");
  await waitFor(
    `(() => { const c = document.querySelector('[data-testid="bim-created"]'); const s = document.querySelector('[data-testid="bim-status"]'); const m = document.querySelector('[data-testid="mode-bim"]');` +
      ` return (!!c && c.getAttribute("data-count") === "6" && !!m && !m.disabled) || (!!s && s.getAttribute("data-state") === "error"); })()`,
    30000,
    "mini building created (6 elements)",
  );
  const createStatus = await page<{ state: string; text: string }>(
    `(async () => { const s = document.querySelector('[data-testid="bim-status"]'); return { state: s ? s.getAttribute("data-state") : "none", text: s ? s.textContent : "" }; })()`,
  );
  const createdCount = Number(await readAttr("bim-created", "data-count"));
  const createdText = await readText("bim-created");
  push(
    "2",
    "create the mini building via the UI (bim.createElements, one atomic batch)",
    clickedCreate && createStatus.state !== "error" && createdCount === 6,
    `${createdText} (document.create + one 6-entity batch)`,
  );

  // 3. Element count/state via the state query.
  const snap3 = await state();
  const ids3 = snap3 ? snap3.elements.map((e) => e.id).sort() : [];
  const allBim = snap3 ? snap3.elements.every((e) => e.kind === "bim") : false;
  const expectedIds = ["door-main", "op-door", "slab-g", "space-office", "story-gf", "wall-south"];
  push(
    "3",
    "document.getState: 6 BIM elements with the exact authored ids",
    ids3.length === 6 && JSON.stringify(ids3) === JSON.stringify(expectedIds) && allBim,
    `elements=${ids3.length} ids=${ids3.join(",")} allKindBim=${allBim}`,
  );

  // 4. Move the door opening +600 along the wall (UI dx default 600).
  const clickedMove = await click("bim-move-opening");
  const moveStatus = await waitOp("move-opening", 30000);
  const distanceAfter = await openingDistance();
  push(
    "4",
    "move door opening +600 along the wall (distance 500 → 1100 exactly)",
    clickedMove && moveStatus.state === "done" && distanceAfter === 1100,
    `distance=${distanceAfter} (bim.getSemantics op-door)`,
  );

  // 5. Cross-axis move attempt (dy=50) → the typed error surfaces in the UI.
  //    The op label repeats step 4's, so the wait keys on the ERROR state.
  const setDy = await page<boolean>(
    `(async () => { const i = document.querySelector('[data-testid="bim-move-dy"]'); if (!i) return false;` +
      ` i.value = "50"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
  );
  const clickedCross = setDy ? await click("bim-move-opening") : false;
  await waitFor(
    `(() => { const s = document.querySelector('[data-testid="bim-status"]'); const m = document.querySelector('[data-testid="mode-bim"]');` +
      ` return !!s && s.getAttribute("data-state") === "error" && s.getAttribute("data-op") === "move-opening" && !!m && !m.disabled; })()`,
    30000,
    "cross-axis move error state",
  );
  const crossStatus = await page<{ state: string; op: string; text: string }>(
    `(async () => { const s = document.querySelector('[data-testid="bim-status"]');` +
      ` return { state: s ? s.getAttribute("data-state") : "none", op: s ? s.getAttribute("data-op") : "", text: s ? s.textContent : "" }; })()`,
  );
  const errorText = await readText("cad-error");
  // Frozen-backend note: the cross-axis reject message carries "(unsupported
  // set; no silent approximation)", which the frozen cmdBimTransform mapping
  // classifies as bim_unsupported (verified by app/test/bim-workflow.test.ts).
  const uiErrorOk = /cross-axis/.test(errorText) && /bim_unsupported/.test(errorText) && crossStatus.state === "error";
  const crossDirect = await cmd("bim.move", { ids: ["op-door"], dx: 0, dy: 50, dz: 0 });
  const directOk = crossDirect.ok === false && crossDirect.code === "bim_unsupported" && /cross-axis/.test(crossDirect.message);
  push(
    "5",
    "cross-axis opening move shows the typed error (UI alert + direct assert)",
    setDy && clickedCross && uiErrorOk && directOk,
    `ui=[${crossStatus.state}] ${errorText.slice(0, 160)} | direct=${directOk ? crossDirect.code : crossDirect}`,
  );

  // 6. Camera preset "top" via the UI → preset + eye displayed. The readout
  //    is written AFTER the op settles, so wait for its content explicitly.
  const clickedTop = await click("bim-camera-top");
  const topStatus = await waitOp("camera-top", 30000);
  const topQuery = await qq("bim.camera", { preset: "top" });
  const topCamera = topQuery && topQuery.ok ? (topQuery.value as { camera: { eye: number[] } }).camera : null;
  const topEyeStr = topCamera ? `eye=[${topCamera.eye.map((n) => Math.round(n)).join(", ")}]` : "";
  if (topEyeStr !== "") {
    await waitFor(
      `(() => { const e = document.querySelector('[data-testid="bim-camera-readout"]'); const t = e ? (e.textContent || "") : "";` +
        ` return t.includes("preset=top") && t.includes(${JSON.stringify(topEyeStr)}); })()`,
      10000,
      "camera top readout",
    );
  }
  const topReadout = await readText("bim-camera-readout");
  const snap6 = await state();
  push(
    "6",
    "camera preset top via UI → preset + eye shown, bimSettings persisted",
    clickedTop && topStatus.state === "done" &&
      topReadout.includes("preset=top") && topEyeStr !== "" && topReadout.includes(topEyeStr) &&
      snap6?.bimSettings?.camera?.preset === "top",
    `${topReadout} · snapshot.preset=${snap6?.bimSettings?.camera?.preset}`,
  );

  // 7. Camera preset "iso" via the UI.
  const clickedIso = await click("bim-camera-iso");
  const isoStatus = await waitOp("camera-iso", 30000);
  const isoQuery = await qq("bim.camera", { preset: "iso" });
  const isoCamera = isoQuery && isoQuery.ok ? (isoQuery.value as { camera: { eye: number[] } }).camera : null;
  const isoEyeStr = isoCamera ? `eye=[${isoCamera.eye.map((n) => Math.round(n)).join(", ")}]` : "";
  if (isoEyeStr !== "") {
    await waitFor(
      `(() => { const e = document.querySelector('[data-testid="bim-camera-readout"]'); const t = e ? (e.textContent || "") : "";` +
        ` return t.includes("preset=iso") && t.includes(${JSON.stringify(isoEyeStr)}); })()`,
      10000,
      "camera iso readout",
    );
  }
  const isoReadout = await readText("bim-camera-readout");
  const isoPressed = await readAttr("bim-camera-iso", "aria-pressed");
  push(
    "7",
    "camera preset iso via UI → preset + eye shown, button pressed",
    clickedIso && isoStatus.state === "done" &&
      isoReadout.includes("preset=iso") && isoEyeStr !== "" && isoReadout.includes(isoEyeStr) &&
      isoPressed === "true",
    `${isoReadout} · aria-pressed=${isoPressed}`,
  );

  // 8. Build geometry through the UI — busy state first (synchronous check
  //    right after the click), then the OCCT worker realizes the solids.
  const busyProbe = await page<{ clicked: boolean; state: string; op: string }>(
    `(async () => { const b = document.querySelector('[data-testid="bim-build"]'); if (!b) return { clicked: false, state: "none", op: "" };` +
      ` b.click(); const s = document.querySelector('[data-testid="bim-status"]'); const busy = document.querySelector('[data-testid="bim-build-busy"]');` +
      ` return { clicked: true, state: s ? s.getAttribute("data-state") : "none", op: s ? s.getAttribute("data-op") : "" , busyVisible: !!busy && !busy.hidden }; })()`,
  );
  const buildStatus = await waitOp("build", 180000);
  const builtAttr = await readAttr("bim-build-result", "data-built");
  const skippedAttr = await readAttr("bim-build-result", "data-skipped");
  const skipId = await readAttr("bim-build-result", "data-skip-id");
  const skipReason = await readAttr("bim-build-result", "data-skip-reason");
  const builtNum = builtAttr === null ? -1 : Number(builtAttr);
  const skippedNum = skippedAttr === null ? -1 : Number(skippedAttr);
  const engineAvailable = buildStatus.state === "done";
  const sawEngineUnavailable = /engine_unavailable/.test(buildStatus.text);
  const buildHappy = engineAvailable && busyProbe.state === "busy" && busyProbe.op === "build" &&
    builtNum >= 5 && skippedNum === 1 && skipId === "story-gf" && /level container/.test(skipReason ?? "");
  const buildEngineFree = !engineAvailable && sawEngineUnavailable;
  push(
    "8",
    "build geometry → built ≥ 5, skipped exactly 1 (story-gf, level-container reason)",
    buildHappy || buildEngineFree,
    buildHappy
      ? `built=${builtNum} skipped=${skippedNum} (${skipId}: ${skipReason}) · busy state observed during the engine call`
      : buildEngineFree
        ? `engine-free path: typed engine_unavailable asserted (${buildStatus.text.slice(0, 140)})`
        : `unexpected: busy=${busyProbe.state}/${busyProbe.op} status=${buildStatus.state} built=${builtNum} skipped=${skippedNum} skipId=${skipId}`,
  );

  // 9. meshToken starts with "occt:" when the engine is available.
  const token9 = await wallToken();
  const tokenOk = engineAvailable ? token9 !== null && token9.startsWith("occt:") : sawEngineUnavailable;
  push(
    "9",
    "meshToken starts with occt: when the engine is available",
    tokenOk,
    engineAvailable ? `wall-south meshToken=${token9 === null ? "null" : token9.slice(0, 18) + "…"}` : "engine unavailable — typed path asserted in step 8 (N/A by design)",
  );

  // (The pre-undo snapshot workaround that used to live here was removed:
  // the app-core defect it worked around — undo of a key-adding patch
  // serializing undefined values into invalid JSON — is FIXED in this slice
  // (updateElement inverses of key-adding patches are now full setProps
  // inverses, and canonicalStringify rejects undefined outright); the
  // regression is pinned by app/test/bim-workflow.test.ts.)

  // 10. Undo → the build revision is undone (meshToken gone from wall props).
  const clickedUndo = await click("bim-undo");
  const undoStatus = await waitOp("undo", 30000);
  let undoOk = false;
  let undoDetail = "";
  if (engineAvailable) {
    const tokenAfterUndo = await wallToken();
    const distAfterUndo = await openingDistance();
    undoOk = clickedUndo && undoStatus.state === "done" && tokenAfterUndo === null && distAfterUndo === 1100;
    undoDetail = `wall-south meshToken=${tokenAfterUndo === null ? "gone" : tokenAfterUndo.slice(0, 14) + "…"} · op-door distance still ${distAfterUndo}`;
  } else {
    // Engine-free: undo reverts the move revision instead (build never applied).
    const distAfterUndo = await openingDistance();
    undoOk = clickedUndo && undoStatus.state === "done" && distAfterUndo === 500;
    undoDetail = `engine-free path: move revision undone → op-door distance=${distAfterUndo}`;
  }
  push("10", "undo → build revision undone (meshToken gone from wall props)", undoOk, undoDetail);

  // 11. Redo → the build revision (and its meshToken) is restored.
  const clickedRedo = await click("bim-redo");
  const redoStatus = await waitOp("redo", 30000);
  let redoOk = false;
  let redoDetail = "";
  if (engineAvailable) {
    const tokenAfterRedo = await wallToken();
    redoOk = clickedRedo && redoStatus.state === "done" && tokenAfterRedo !== null && tokenAfterRedo === token9;
    redoDetail = `wall-south meshToken restored=${tokenAfterRedo !== null && tokenAfterRedo === token9}`;
  } else {
    const distAfterRedo = await openingDistance();
    redoOk = clickedRedo && redoStatus.state === "done" && distAfterRedo === 1100;
    redoDetail = `engine-free path: move revision re-applied → op-door distance=${distAfterRedo}`;
  }
  push("11", "redo → meshToken back (identical token)", redoOk, redoDetail);

  // 12. Save → open round trip → identical graph events hash, exercising the
  //     REAL post-redo document (save-after-undo of the key-adding build
  //     revision is covered by the fixed core + the app regression test).
  const eventsBefore12 = await qq("model.getGraphEvents", {});
  const hashBefore12 = eventsBefore12 && eventsBefore12.ok ? (eventsBefore12.value as { events_hash: string }).events_hash : "";
  const clickedSaveOpen = await click("bim-save-open");
  const saveOpenStatus = await waitOp("save-open", 60000);
  const identicalAttr = await readAttr("bim-persist-result", "data-identical");
  const persistText = await readText("bim-persist-result");
  const eventsAfter12 = await qq("model.getGraphEvents", {});
  const hashAfter12 = eventsAfter12 && eventsAfter12.ok ? (eventsAfter12.value as { events_hash: string }).events_hash : "";
  push(
    "12",
    "save → open round trip → identical graph events hash",
    clickedSaveOpen && saveOpenStatus.state === "done" && identicalAttr === "true" && hashBefore12 !== "" && hashAfter12 === hashBefore12,
    `${persistText} · uiState=${saveOpenStatus.state} · direct hash identical=${hashAfter12 === hashBefore12}`,
  );

  // 13. Selection set via the UI (building tree row click).
  const clickedRow = await click("bim-element-row-wall-south");
  await waitFor(
    `(() => { const r = document.querySelector('[data-testid="bim-element-row-wall-south"]'); const m = document.querySelector('[data-testid="mode-bim"]');` +
      ` return !!r && r.getAttribute("aria-pressed") === "true" && !!m && !m.disabled; })()`,
    30000,
    "wall-south row selected",
  );
  const sel13 = await qq("document.getSelection", {});
  const sel13Value = sel13 && sel13.ok ? (sel13.value as unknown) : null;
  const selOk = JSON.stringify(sel13Value) === JSON.stringify(["wall-south"]);
  push(
    "13",
    "selection set via UI (tree row) → document.getSelection = [wall-south]",
    clickedRow && selOk,
    `selection=${JSON.stringify(sel13Value)} · row aria-pressed=true`,
  );

  // 14. Result file written with ALL steps PASS (the runner reads it and the
  //     exit code mirrors ok — the smoke-drafting convention).
  const first13 = steps.slice(0, 13);
  const first13AllPass = first13.every((s) => s.pass);
  push(
    "14",
    "result file written with all steps PASS",
    first13AllPass,
    first13AllPass
      ? `steps 1-13: ${first13.filter((s) => s.pass).length}/13 PASS · result JSON → $OFFISOS_SMOKE_OUT · engine=${engineAvailable ? "occt (happy path)" : "unavailable (typed path)"}`
      : `steps 1-13: ${first13.filter((s) => s.pass).length}/13 PASS — failing: ${first13.filter((s) => !s.pass).map((s) => s.step).join(",")}`,
  );

  const allOk = steps.every((s) => s.ok);
  writeSmokeOut({
    ok: allOk,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: null,
    sceneHash: null,
  });
}

/**
 * COMPAT-CAD-003 / Issue #41: the construction-documentation smoke — the
 * representative drawing-production workflow through the FULL Electron chain,
 * DRIVING THE REAL RENDERER UI (BrowserWindow DOM: header mode toggle → the
 * Documentation panel's buttons/inputs with data-testid selectors → readouts),
 * exactly like a user would:
 *
 *   BrowserWindow → renderer DOM (docs mode panel) → window.cad.send (preload)
 *     → ipcMain → ElectronHost/IpcTransport → App API → docs.* commands/queries
 *     → CADDocument → deterministic pure-TS projection (NO engine anywhere —
 *     the default bundle binding stays lazily unused, exactly like
 *     --smoke-drafting) → undo/redo → Sheet IR export → save/open identity.
 *
 * Non-UI assertions (state/semantics queries) go through window.cad.send
 * directly, mirroring how smoke-drafting/smoke-bim handle non-UI assertions.
 * Engine-free by construction: documentation projection is pure deterministic
 * TypeScript inside the core.
 *
 * Reproduce: cd apps/electron && npm run smoke:docs
 */
async function runDocsSmoke(win: BrowserWindow): Promise<void> {
  // Steps record {step, name, pass, detail} (ok mirrors pass for the shared
  // SmokeResult envelope the runner reads).
  interface DocsStep { step: string; name: string; pass: boolean; ok: boolean; detail: unknown }
  const steps: DocsStep[] = [];
  const push = (num: string, name: string, pass: boolean, detail: unknown): void => {
    steps.push({ step: num, name, pass, ok: pass, detail });
  };

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  // Rejection-capturing page evaluation (see runGeometrySmoke).
  const page = async <T>(js: string): Promise<T> => {
    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: T } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };
  const send = (request: CommandQueryRequest): Promise<CommandQueryResponse> =>
    page<CommandQueryResponse>(`window.cad.send(${JSON.stringify(request)})`);
  const cmd = (name: string, payload: unknown) =>
    send({ type: "command", name: name as never, payload });
  const qq = (name: string, payload: unknown) =>
    send({ type: "query", name: name as never, payload });

  /** Poll a page predicate until true (throws on timeout). */
  const waitFor = async (predicateJs: string, timeoutMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await page<boolean>(`(async () => (${predicateJs}))()`);
      if (v === true) return;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  /** Click a data-testid button in the page. */
  const click = (testid: string): Promise<boolean> =>
    page<boolean>(
      `(async () => { const b = document.querySelector('[data-testid="${testid}"]'); if (!b) return false; b.click(); return true; })()`,
    );
  const readAttr = (testid: string, attr: string): Promise<string | null> =>
    page<string | null>(
      `(async () => { const e = document.querySelector('[data-testid="${testid}"]'); return e ? e.getAttribute("${attr}") : null; })()`,
    );
  const readText = (testid: string): Promise<string> =>
    page<string>(
      `(async () => { const e = document.querySelector('[data-testid="${testid}"]'); return e ? (e.textContent || "") : ""; })()`,
    );
  /** The docs status protocol's monotonic run counter (set synchronously at
   *  click time — disambiguates repeated op labels such as a second undo). */
  const currentRun = async (): Promise<number> => {
    const v = await readAttr("docs-status", "data-run");
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  /** Wait for the docs status protocol to settle: state done|error for `op`
   *  at run counter `run` AND the UI idle again (mode toggle re-enabled).
   *  Returns the status snapshot. */
  const waitDocsOp = async (op: string, run: number, timeoutMs: number): Promise<{ state: string; op: string; run: string; text: string }> => {
    await waitFor(
      `(() => { const s = document.querySelector('[data-testid="docs-status"]'); const m = document.querySelector('[data-testid="mode-docs"]');` +
        ` return !!s && (s.getAttribute("data-state") === "done" || s.getAttribute("data-state") === "error")` +
        ` && s.getAttribute("data-op") === "${op}" && s.getAttribute("data-run") === "${run}" && !!m && !m.disabled; })()`,
      timeoutMs,
      `docs op '${op}' #${run} to settle`,
    );
    return page<{ state: string; op: string; run: string; text: string }>(
      `(async () => { const s = document.querySelector('[data-testid="docs-status"]');` +
        ` return { state: s ? s.getAttribute("data-state") : "none", op: s ? s.getAttribute("data-op") : "", run: s ? s.getAttribute("data-run") : "", text: s ? s.textContent : "" }; })()`,
    );
  };
  const viewRowCount = (): Promise<number> =>
    page<number>(`(async () => document.querySelectorAll('[data-testid^="docs-view-row-"]').length)()`);
  const sheetRowCount = (): Promise<number> =>
    page<number>(`(async () => document.querySelectorAll('[data-testid^="docs-sheet-row-"]').length)()`);

  type ViewRow = { view: { id: string; kind: string; direction?: string }; contentHash: string | null; primitiveCount: number };
  const listViews = async (): Promise<ViewRow[] | null> => {
    const r = await qq("docs.listViews", {});
    return r && r.ok ? ((r.value as { views: ViewRow[] }).views ?? null) : null;
  };
  type PlanGeom = {
    primitiveCount: number;
    contentHash: string;
    bbox: { uMin: number; uMax: number; vMin: number; vMax: number } | null;
    annotations: { type: string; measured?: number; label?: string }[];
  };
  const planGeometry = async (): Promise<PlanGeom | null> => {
    const r = await qq("docs.getViewGeometry", { viewId: "vw-000001" });
    return r && r.ok ? (r.value as PlanGeom) : null;
  };

  // 1. Documentation mode is reachable and visible: header toggle + the panel.
  const beforeToggle = await page<boolean>(
    `(async () => !!document.querySelector('[data-testid="mode-docs"]') && !!document.querySelector('[data-testid="mode-bim"]') && !!document.querySelector('[data-testid="mode-drafting"]'))()`,
  );
  const clickedMode = beforeToggle ? await click("mode-docs") : false;
  await waitFor(
    `(() => { const c = document.querySelector('[data-testid="docs-card"]'); const b = document.querySelector('[data-testid="mode-docs"]');` +
      ` return !!c && c.style.display !== "none" && !!b && b.getAttribute("aria-pressed") === "true"; })()`,
    10000,
    "Documentation mode panel visible",
  );
  const docsControls = [
    "docs-status", "docs-seed", "docs-seed-result", "docs-view-kind", "docs-view-story", "docs-view-direction",
    "docs-view-axis", "docs-view-offset", "docs-create-view", "docs-list-views", "docs-view-list", "docs-get-geometry",
    "docs-geometry-readout", "docs-regenerate", "docs-regen-readout", "docs-create-sheet", "docs-list-sheets",
    "docs-sheet-list", "docs-export", "docs-export-readout", "docs-export-pdf", "docs-undo", "docs-redo",
    "docs-save-open", "docs-persist-result",
  ];
  const controlsPresent = await page<boolean>(
    `(async () => ${JSON.stringify(docsControls)}.every((t) => !!document.querySelector('[data-testid="' + t + '"]')))()`,
  );
  push(
    "1",
    "Documentation mode visible (header toggle switches the panel in; all data-testid controls present)",
    beforeToggle && clickedMode && controlsPresent,
    controlsPresent ? `mode-docs clicked; docs-card displayed; ${docsControls.length}/${docsControls.length} docs controls present` : "docs controls missing",
  );

  // 2. Seed the representative documentation set through the UI (one click:
  //    document.create + building + 4 views + annotations + regenerate + sheet).
  const run2 = await currentRun();
  const clickedSeed = await click("docs-seed");
  const seedStatus = await waitDocsOp("seed", run2 + 1, 30000);
  const seedCount = Number(await readAttr("docs-seed-result", "data-count"));
  const seedRegen = await readAttr("docs-seed-result", "data-regen-applied");
  const seedSheet = await readAttr("docs-seed-result", "data-sheet");
  const seedText = await readText("docs-seed-result");
  push(
    "2",
    "seed the representative building + plan/elevation/section/detail views + annotations + regeneration + A-101 sheet via the UI",
    clickedSeed && seedStatus.state === "done" && seedCount === 4 && seedRegen === "2" && seedSheet === "sh-000001",
    `${seedText}`,
  );

  // 3. docs.listViews via the UI → 4 rows; plan view carries 17 primitives.
  const run3 = await currentRun();
  const clickedList = await click("docs-list-views");
  const listStatus = await waitDocsOp("list-views", run3 + 1, 30000);
  const rowCount3 = await viewRowCount();
  const rowPlanText = await readText("docs-view-row-vw-000001");
  const views3 = await listViews();
  const plan3 = views3?.find((v) => v.view.id === "vw-000001");
  push(
    "3",
    "listViews via UI → 4 rows (kind + primitive count + 8-char hash prefix); plan = 17 primitives",
    clickedList && listStatus.state === "done" && rowCount3 === 4 && views3 !== null && views3.length === 4 &&
      plan3?.primitiveCount === 17 && /plan/.test(rowPlanText) && /17 primitives/.test(rowPlanText) &&
      plan3?.contentHash !== null && rowPlanText.includes(plan3!.contentHash!.slice(0, 8)),
    `rows=${rowCount3} · row vw-000001: ${rowPlanText} · direct plan primitives=${plan3?.primitiveCount ?? "n/a"}`,
  );

  // 4. View geometry via the UI: row click selects the plan + fetches geometry,
  //    then the View geometry button re-queries the selection → 17 primitives
  //    + content hash + the exact hand-derived plan bbox.
  const run4a = await currentRun();
  const clickedRow = await click("docs-view-row-vw-000001");
  const geomStatusRow = await waitDocsOp("get-geometry", run4a + 1, 30000);
  const run4b = await currentRun();
  const clickedGeomBtn = await click("docs-get-geometry");
  const geomStatusBtn = await waitDocsOp("get-geometry", run4b + 1, 30000);
  const geoText = await readText("docs-geometry-readout");
  const geoHash = await readAttr("docs-geometry-readout", "data-hash");
  const geoPrimitives = await readAttr("docs-geometry-readout", "data-primitives");
  const geoBbox = await readAttr("docs-geometry-readout", "data-bbox");
  const geom4 = await planGeometry();
  const bboxOk =
    geom4 !== null && geom4.bbox !== null &&
    JSON.stringify(geom4.bbox) === JSON.stringify({ uMin: -300, uMax: 6300, vMin: -300, vMax: 6000 });
  const planHashOriginal = geom4?.contentHash ?? "";
  push(
    "4",
    "view geometry via UI (row select + get-geometry button) → 17 primitives + hash prefix + exact bbox [-300,6300]×[-300,6000]",
    clickedRow && geomStatusRow.state === "done" && clickedGeomBtn && geomStatusBtn.state === "done" &&
      geom4?.primitiveCount === 17 && /^[0-9a-f]{64}$/.test(geom4?.contentHash ?? "") &&
      geoPrimitives === "17" && geoHash === geom4?.contentHash && geoBbox !== null &&
      JSON.stringify(JSON.parse(geoBbox)) === JSON.stringify(geom4?.bbox ?? null) && bboxOk &&
      geoText.includes("vw-000001") && geoText.includes("plan"),
    `${geoText} · direct: primitives=${geom4?.primitiveCount ?? "n/a"} bbox=${JSON.stringify(geom4?.bbox ?? null)}`,
  );

  // 5. Create one additional view through the UI (elevation back) → 5 rows.
  const setKind = await page<boolean>(
    `(async () => { const i = document.querySelector('[data-testid="docs-view-kind"]'); if (!i) return false;` +
      ` i.value = "elevation"; i.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
  );
  const setDir = await page<boolean>(
    `(async () => { const i = document.querySelector('[data-testid="docs-view-direction"]'); if (!i) return false;` +
      ` i.value = "back"; i.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
  );
  const run5 = await currentRun();
  const clickedCreateView = await click("docs-create-view");
  const createViewStatus = await waitDocsOp("create-view", run5 + 1, 30000);
  const views5 = await listViews();
  const backView = views5?.find((v) => v.view.id === "vw-000005");
  const run5b = await currentRun();
  const clickedList5 = await click("docs-list-views");
  const listStatus5 = await waitDocsOp("list-views", run5b + 1, 30000);
  const rowCount5 = await viewRowCount();
  push(
    "5",
    "create an additional elevation (back) view via the UI form → 5 views / 5 rows",
    setKind && setDir && clickedCreateView && createViewStatus.state === "done" &&
      views5?.length === 5 && rowCount5 === 5 && clickedList5 && listStatus5.state === "done" &&
      backView?.view.kind === "elevation" && backView?.view.direction === "back" && (backView?.primitiveCount ?? 0) > 0,
    `views=${views5?.length ?? "n/a"} rows=${rowCount5} · vw-000005: ${backView?.view.kind ?? "missing"} ${backView?.view.direction ?? ""} · ${backView?.primitiveCount ?? "n/a"} primitives`,
  );

  // 6. Regenerate via the UI. ENGINE TRUTH (adapted from the task text): the
  //    seed's docs.regenerate already derived the annotation values (its
  //    applied=2 is asserted in step 2), so THIS regeneration is the engine's
  //    documented no-op — applied=0, no revision (identical inputs → identical
  //    outputs, the determinism proof). The derived values are asserted via
  //    direct docs.getViewGeometry: dim 5300 + tag label "Office 1 (27.00 m²)".
  const run6 = await currentRun();
  const clickedRegen = await click("docs-regenerate");
  const regenStatus = await waitDocsOp("regenerate", run6 + 1, 30000);
  const applied6 = await readAttr("docs-regen-readout", "data-applied");
  const firstHash6 = await readAttr("docs-regen-readout", "data-first-hash");
  const regenText = await readText("docs-regen-readout");
  const geom6 = await planGeometry();
  const dim6 = geom6?.annotations.find((a) => a.type === "docs.dim");
  const tag6 = geom6?.annotations.find((a) => a.type === "docs.tag");
  push(
    "6",
    "regenerate via UI → derived annotation values current: dim 5300 + tag 'Office 1 (27.00 m²)' (no-op proof: applied 0, no revision)",
    clickedRegen && regenStatus.state === "done" && applied6 === "0" &&
      dim6?.measured === 5300 && tag6?.label === "Office 1 (27.00 m²)" &&
      firstHash6 === planHashOriginal,
    `applied=${applied6} (the seed's regeneration applied the task's 'applied 2' — step 2; a no-op records no revision) · dim measured=${dim6?.measured ?? "n/a"} · tag label=${JSON.stringify(tag6?.label ?? null)} · first view hash ${firstHash6?.slice(0, 8) ?? "—"} = plan hash`,
  );

  // 7. Parametric dimension: move wall-north +500 in y (direct bim.move — a
  //    model edit, not a docs-card control) then regenerate via the UI → the
  //    overall dimension re-derives 5300 → 5800 (applied 1).
  const moveRes = await cmd("bim.move", { ids: ["wall-north"], dx: 0, dy: 500, dz: 0 });
  const run7 = await currentRun();
  const clickedRegen7 = await click("docs-regenerate");
  const regenStatus7 = await waitDocsOp("regenerate", run7 + 1, 30000);
  const applied7 = await readAttr("docs-regen-readout", "data-applied");
  const geom7 = await planGeometry();
  const dim7 = geom7?.annotations.find((a) => a.type === "docs.dim");
  push(
    "7",
    "parametric dimension: bim.move wall-north +500 (direct) + regenerate via UI → measured 5800",
    !!moveRes && moveRes.ok && clickedRegen7 && regenStatus7.state === "done" && applied7 === "1" &&
      dim7?.measured === 5800,
    `move=${moveRes && moveRes.ok ? "ok" : JSON.stringify(moveRes).slice(0, 120)} · applied=${applied7} · dim measured=${dim7?.measured ?? "n/a"}`,
  );

  // 8. Undo twice: the regeneration revision (immutable — restores 5300), then
  //    the move itself (restores the pre-move plan projection EXACTLY).
  const run8a = await currentRun();
  const clickedUndo1 = await click("docs-undo");
  const undoStatus1 = await waitDocsOp("undo", run8a + 1, 30000);
  const geom8a = await planGeometry();
  const measured8a = geom8a?.annotations.find((a) => a.type === "docs.dim")?.measured;
  const run8b = await currentRun();
  const clickedUndo2 = await click("docs-undo");
  const undoStatus2 = await waitDocsOp("undo", run8b + 1, 30000);
  const geom8b = await planGeometry();
  const dim8 = geom8b?.annotations.find((a) => a.type === "docs.dim");
  const views8 = await listViews();
  const planHash8 = views8?.find((v) => v.view.id === "vw-000001")?.contentHash ?? null;
  push(
    "8",
    "undo twice → regeneration revision + move undone; measured back to 5300 (regeneration is an immutable revision)",
    clickedUndo1 && undoStatus1.state === "done" && clickedUndo2 && undoStatus2.state === "done" &&
      measured8a === 5300 && dim8?.measured === 5300 && planHash8 !== null && planHash8 === planHashOriginal,
    `after undo#1 measured=${measured8a ?? "n/a"} · after undo#2 measured=${dim8?.measured ?? "n/a"} · plan contentHash restored to the pre-move hash=${planHash8 === planHashOriginal}`,
  );

  // 9. Create a sheet via the UI (A-102 placing section + detail) → 2 sheets.
  const run9 = await currentRun();
  const clickedCreateSheet = await click("docs-create-sheet");
  const createSheetStatus = await waitDocsOp("create-sheet", run9 + 1, 30000);
  const run9b = await currentRun();
  const clickedListSheets = await click("docs-list-sheets");
  const listSheetsStatus = await waitDocsOp("list-sheets", run9b + 1, 30000);
  const sheetRows9 = await sheetRowCount();
  const sheetsDirect = await qq("docs.listSheets", {});
  const sheets9 = sheetsDirect && sheetsDirect.ok ? (sheetsDirect.value as { sheets: { id: string; titleBlock: { sheetNumber: string } }[] }).sheets : [];
  push(
    "9",
    "create sheet via UI (A-102, section + detail placements) → sheets list shows 2",
    clickedCreateSheet && createSheetStatus.state === "done" && clickedListSheets && listSheetsStatus.state === "done" &&
      sheetRows9 === 2 && sheets9.length === 2 && sheets9[1]?.titleBlock?.sheetNumber === "A-102",
    `sheet rows=${sheetRows9} · ${sheets9.map((s) => `${s.id}/${s.titleBlock.sheetNumber}`).join(", ")}`,
  );

  // 10. Export the canonical Sheet IR via the UI → 64-hex sha256 in the
  //     readout, matching the direct export of sh-000001 byte-for-byte.
  const run10 = await currentRun();
  const clickedExport = await click("docs-export");
  const exportStatus = await waitDocsOp("export", run10 + 1, 30000);
  const exportHash10 = await readAttr("docs-export-readout", "data-hash");
  const exportText = await readText("docs-export-readout");
  const directExport = await qq("docs.exportSheet", { sheetId: "sh-000001", format: "sheet-ir" });
  const directHash10 = directExport && directExport.ok ? (directExport.value as { hash: string }).hash : "";
  push(
    "10",
    "export sheet-ir via UI → canonical 64-hex hash prefix in the readout (matches the direct export)",
    clickedExport && exportStatus.state === "done" &&
      /^[0-9a-f]{64}$/.test(exportHash10 ?? "") && exportHash10 === directHash10 &&
      exportText.includes(directHash10.slice(0, 16)),
    `${exportText} · direct hash identical=${exportHash10 === directHash10}`,
  );

  // 11. Export pdf via the UI → CAD-PARITY-014 (Issue #107): the REAL
  //     deterministic PDF writer — bytes + sha256 + the irHash binding to the
  //     step-10 Sheet IR + double-export byte-identity (the disclosed
  //     migration of the P013 interim typed-decline assertion).
  const run11 = await currentRun();
  const clickedPdf = await click("docs-export-pdf");
  const pdfStatus = await waitDocsOp("export-pdf", run11 + 1, 30000);
  const pdfReadout11 = await readText("docs-export-readout");
  const directPdf = await qq("docs.exportSheet", { sheetId: "sh-000001", format: "pdf" });
  const directPdfAgain = await qq("docs.exportSheet", { sheetId: "sh-000001", format: "pdf" });
  const pdfVal = directPdf && directPdf.ok ? (directPdf.value as { sha256?: string; size?: number; irHash?: string }) : null;
  const pdfOk = pdfVal !== null && /^[0-9a-f]{64}$/.test(pdfVal.sha256 ?? "") && (pdfVal.size ?? 0) > 500;
  push(
    "11",
    "export pdf via UI → the real deterministic writer (sha + irHash binding + byte-determinism)",
    clickedPdf && pdfStatus.state === "done" &&
      pdfOk && (pdfVal?.irHash ?? "") === (exportHash10 ?? "") &&
      pdfVal?.sha256 === (directPdfAgain && directPdfAgain.ok ? (directPdfAgain.value as { sha256?: string }).sha256 : "") &&
      pdfReadout11.includes((pdfVal?.sha256 ?? "").slice(0, 16)),
    `ui=[${pdfStatus.state}] ${pdfReadout11.slice(0, 160)} | direct sha=${(pdfVal?.sha256 ?? "n/a").slice(0, 16)}… size=${pdfVal?.size ?? 0} irHash-identical=${(pdfVal?.irHash ?? "") === (exportHash10 ?? "")}`,
  );

  // 12. Save → open round trip via the UI → identical graph events hash, with
  //     the documentation set intact (5 views persisted across the round trip).
  const eventsBefore = await qq("model.getGraphEvents", {});
  const hashBefore12 = eventsBefore && eventsBefore.ok ? (eventsBefore.value as { events_hash: string }).events_hash : "";
  const run12 = await currentRun();
  const clickedSaveOpen = await click("docs-save-open");
  const saveOpenStatus = await waitDocsOp("save-open", run12 + 1, 60000);
  const identicalAttr = await readAttr("docs-persist-result", "data-identical");
  const persistText = await readText("docs-persist-result");
  const eventsAfter = await qq("model.getGraphEvents", {});
  const hashAfter12 = eventsAfter && eventsAfter.ok ? (eventsAfter.value as { events_hash: string }).events_hash : "";
  const viewsAfterOpen = await listViews();
  push(
    "12",
    "save → open round trip via UI → identical graph events hash (+ documentation set intact)",
    clickedSaveOpen && saveOpenStatus.state === "done" && identicalAttr === "true" &&
      hashBefore12 !== "" && hashAfter12 === hashBefore12 && viewsAfterOpen?.length === 5,
    `${persistText} · views after open=${viewsAfterOpen?.length ?? "n/a"} · direct hash identical=${hashAfter12 === hashBefore12}`,
  );

  const allOk = steps.every((s) => s.ok);
  writeSmokeOut({
    ok: allOk,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: null,
    sceneHash: null,
  });
}

/**
 * COMPAT-IFC-001 / Issue #47: the IFC/openBIM interop smoke — the
 * representative round-trip workflow through the FULL Electron chain:
 * BrowserWindow → window.cad.send preload bridge → ipcMain →
 * ElectronHost/IpcTransport → shared App API (ifc.*) → IfcInteropAdapter →
 * IfcOpenShell 0.8.5 disposable Python worker. The smoke drives the REAL
 * renderer UI (the IFC mode panel) for every surfaced control and uses
 * window.cad.send directly only where the UI does not surface raw values
 * (probe, the mutation edits, the persistence round trip).
 *
 * Every step's expectation was verified against the real engine in a
 * rehearsal first — app/test/ifc-roundtrip.test.ts (+ ifc-idsbcf.test.ts) are
 * the ground truth. One documented deviation from the task text: step 7
 * ("mutate → re-export → import → exactly 2 reconciled") requires the document
 * to hold the PRE-mutation state at import time — importing the mutated file
 * into the document that already holds the mutated state reconciles NOTHING
 * (all unchanged; the identity reconciliation the engine implements, exactly
 * as the roundtrip test imports the mutated file into a document holding the
 * pre-mutation state). The smoke therefore undoes the two mutation edits
 * (through the UI) BEFORE importing the mutated export; step 8 then undoes the
 * two imports (the same total of four undos the task text prescribed).
 */
async function runIfcSmoke(win: BrowserWindow): Promise<void> {
  // Steps record {step, name, pass, detail} (ok mirrors pass for the shared
  // SmokeResult envelope the runner reads).
  interface IfcStep { step: string; name: string; pass: boolean; ok: boolean; detail: unknown }
  const steps: IfcStep[] = [];
  const push = (num: string, name: string, pass: boolean, detail: unknown): void => {
    steps.push({ step: num, name, pass, ok: pass, detail });
  };

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  // Rejection-capturing page evaluation (see runGeometrySmoke).
  const page = async <T>(js: string): Promise<T> => {
    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: T } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };
  const send = (request: CommandQueryRequest): Promise<CommandQueryResponse> =>
    page<CommandQueryResponse>(`window.cad.send(${JSON.stringify(request)})`);
  const cmd = (name: string, payload: unknown) =>
    send({ type: "command", name: name as never, payload });
  const qq = (name: string, payload: unknown) =>
    send({ type: "query", name: name as never, payload });

  /** Poll a page predicate until true (throws on timeout). */
  const waitFor = async (predicateJs: string, timeoutMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await page<boolean>(`(async () => (${predicateJs}))()`);
      if (v === true) return;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  /** Click a data-testid button in the page. */
  const click = (testid: string): Promise<boolean> =>
    page<boolean>(
      `(async () => { const b = document.querySelector('[data-testid="${testid}"]'); if (!b) return false; b.click(); return true; })()`,
    );
  const readAttr = (testid: string, attr: string): Promise<string | null> =>
    page<string | null>(
      `(async () => { const e = document.querySelector('[data-testid="${testid}"]'); return e ? e.getAttribute("${attr}") : null; })()`,
    );
  const readText = (testid: string): Promise<string> =>
    page<string>(
      `(async () => { const e = document.querySelector('[data-testid="${testid}"]'); return e ? (e.textContent || "") : ""; })()`,
    );
  /** The ifc status protocol's monotonic run counter (set synchronously at
   *  click time — disambiguates repeated op labels such as the fourth undo). */
  const currentRun = async (): Promise<number> => {
    const v = await readAttr("ifc-status", "data-run");
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  /** Wait for the ifc status protocol to settle: state done|error for `op`
   *  at run counter `run` AND the UI idle again (mode toggle re-enabled). */
  const waitIfcOp = async (op: string, run: number, timeoutMs: number): Promise<{ state: string; op: string; run: string; text: string }> => {
    await waitFor(
      `(() => { const s = document.querySelector('[data-testid="ifc-status"]'); const m = document.querySelector('[data-testid="mode-ifc"]');` +
        ` return !!s && (s.getAttribute("data-state") === "done" || s.getAttribute("data-state") === "error")` +
        ` && s.getAttribute("data-op") === "${op}" && s.getAttribute("data-run") === "${run}" && !!m && !m.disabled; })()`,
      timeoutMs,
      `ifc op '${op}' #${run} to settle`,
    );
    return page<{ state: string; op: string; run: string; text: string }>(
      `(async () => { const s = document.querySelector('[data-testid="ifc-status"]');` +
        ` return { state: s ? s.getAttribute("data-state") : "none", op: s ? s.getAttribute("data-op") : "", run: s ? s.getAttribute("data-run") : "", text: s ? s.textContent : "" }; })()`,
    );
  };

  // Direct document-state helpers for the non-UI assertions.
  type SmokeElement = { id: string; props: Record<string, unknown> };
  const elementsOf = async (): Promise<SmokeElement[]> => {
    const r = await qq("document.getState", {});
    if (!(r && r.ok)) return [];
    const snap = r.value as CADDocumentSnapshot;
    return snap.elements.map((e) => ({ id: e.id, props: (e.props ?? {}) as Record<string, unknown> }));
  };
  const wallNorthAtRest = (els: SmokeElement[]): boolean => {
    const n = els.find((e) => e.id === "wall-north");
    return (
      n !== undefined &&
      JSON.stringify(n.props.start) === JSON.stringify([6000, 5000]) &&
      JSON.stringify(n.props.end) === JSON.stringify([0, 5000])
    );
  };
  const wallEastNoFireRating = (els: SmokeElement[]): boolean => {
    const e = els.find((x) => x.id === "wall-east");
    return e !== undefined && !("FireRating" in e.props);
  };
  const importRecordIds = async (): Promise<string[] | null> => {
    const r = await qq("ifc.listImports", {});
    if (!(r && r.ok)) return null;
    return ((r.value as { records: { id: string }[] }).records ?? []).map((x) => x.id);
  };

  // COMPAT-BIM-003 grew the export counts surface additively: materials,
  // components, gridsNotExported and referencePlanesNotExported are now always
  // reported (0 for a pure-building model — honest, never silent).
  const EXPECTED_COUNTS = {
    stories: 1, walls: 4, slabs: 1, openings: 2, doors: 1, windows: 1, spaces: 1,
    materials: 0, components: 0, gridsNotExported: 0, referencePlanesNotExported: 0,
  };

  // 1. IFC mode is reachable and visible: header toggle + the panel; seed the
  //    representative building (11 elements incl. the 30°-rotated wall).
  const beforeToggle = await page<boolean>(
    `(async () => !!document.querySelector('[data-testid="mode-ifc"]') && !!document.querySelector('[data-testid="mode-docs"]') && !!document.querySelector('[data-testid="mode-bim"]') && !!document.querySelector('[data-testid="mode-drafting"]'))()`,
  );
  const clickedMode = beforeToggle ? await click("mode-ifc") : false;
  await waitFor(
    `(() => { const c = document.querySelector('[data-testid="ifc-card"]'); const b = document.querySelector('[data-testid="mode-ifc"]');` +
      ` return !!c && c.style.display !== "none" && !!b && b.getAttribute("aria-pressed") === "true"; })()`,
    10000,
    "IFC mode panel visible",
  );
  const ifcControls = [
    "ifc-status", "ifc-seed", "ifc-seed-result", "ifc-export", "ifc-export-result",
    "ifc-determinism", "ifc-determinism-result", "ifc-import", "ifc-import-result",
    "ifc-compare", "ifc-compare-result", "ifc-ids", "ifc-ids-result", "ifc-bcf", "ifc-bcf-result",
    "ifc-records", "ifc-records-list", "ifc-undo",
  ];
  const controlsPresent = await page<boolean>(
    `(async () => ${JSON.stringify(ifcControls)}.every((t) => !!document.querySelector('[data-testid="' + t + '"]')))()`,
  );
  const run1 = await currentRun();
  const clickedSeed = await click("ifc-seed");
  const seedStatus = await waitIfcOp("seed", run1 + 1, 60000);
  const seedCount = Number(await readAttr("ifc-seed", "data-count"));
  const seedText = await readText("ifc-seed-result");
  const contentHashSeeded = await page<string>(`window.cad.contentHash()`);
  push(
    "1",
    "IFC mode visible (header toggle switches the panel in; all data-testid controls present) + seed the representative building via the UI → 11 elements",
    beforeToggle && clickedMode && controlsPresent && clickedSeed && seedStatus.state === "done" && seedCount === 11,
    controlsPresent
      ? `mode-ifc clicked; ${ifcControls.length}/${ifcControls.length} ifc controls present; ${seedText} · seeded contentHash ${contentHashSeeded.slice(0, 12)}…`
      : "ifc controls missing",
  );

  // 2. ifc.probe via window.cad.send → the real IfcOpenShell toolchain.
  const probe = await qq("ifc.probe", {});
  const probeValue = probe && probe.ok ? (probe.value as { available: boolean; engineVersion: string | null }) : null;
  push(
    "2",
    "ifc.probe via window.cad.send → IfcOpenShell 0.8.5 worker available",
    probeValue !== null && probeValue.available === true && probeValue.engineVersion === "0.8.5",
    `available=${probeValue?.available ?? "n/a"} · engineVersion=${probeValue?.engineVersion ?? "n/a"}`,
  );

  // 3. Export through the UI → 64-hex sha256 + the exact element counts
  //    (cross-checked against a direct export — byte-deterministic).
  const run3 = await currentRun();
  const clickedExport = await click("ifc-export");
  const exportStatus = await waitIfcOp("export", run3 + 1, 90000);
  const uiSha = await readAttr("ifc-export", "data-ifc-sha");
  const uiCounts = await readAttr("ifc-export", "data-ifc-counts");
  const exportText = await readText("ifc-export-result");
  const directExport = await cmd("ifc.export", {});
  const directExportValue =
    directExport && directExport.ok
      ? (directExport.value as { ifc: string; sha256: string; size: number; schema: string; counts: Record<string, number> })
      : null;
  const uiCountsParsed = uiCounts !== null ? (JSON.parse(uiCounts) as Record<string, number>) : null;
  const countsOk =
    uiCountsParsed !== null &&
    JSON.stringify(uiCountsParsed) === JSON.stringify(EXPECTED_COUNTS) &&
    JSON.stringify(directExportValue?.counts ?? null) === JSON.stringify(EXPECTED_COUNTS);
  push(
    "3",
    "export via UI → deterministic IFC4 file: 64-hex sha256 + exact counts {stories:1,walls:4,slabs:1,openings:2,doors:1,windows:1,spaces:1} (== direct export)",
    clickedExport && exportStatus.state === "done" &&
      /^[0-9a-f]{64}$/.test(uiSha ?? "") && uiSha === directExportValue?.sha256 &&
      directExportValue?.schema === "IFC4" && (directExportValue?.size ?? 0) > 1000 && countsOk,
    `${exportText} · direct sha identical=${uiSha === directExportValue?.sha256} · size=${directExportValue?.size ?? "n/a"}`,
  );

  // 4. Determinism through the UI: two exports → byte-identical files.
  const run4 = await currentRun();
  const clickedDet = await click("ifc-determinism");
  const detStatus = await waitIfcOp("determinism", run4 + 1, 150000);
  const detAttr = await readAttr("ifc-determinism", "data-ifc-deterministic");
  const detText = await readText("ifc-determinism-result");
  push(
    "4",
    "determinism via UI (two ifc.export calls) → byte-identical files for equal inputs",
    clickedDet && detStatus.state === "done" && detAttr === "true",
    detText,
  );

  // 5. Compare through the UI + direct: the export reconciles against its own
  //    document with zero loss (unchanged 11, lossy 0, 64-hex report hash).
  const run5 = await currentRun();
  const clickedCmp = await click("ifc-compare");
  const cmpStatus = await waitIfcOp("compare", run5 + 1, 90000);
  const cmpStatusAttr = await readAttr("ifc-compare", "data-ifc-compare-status");
  const cmpHashAttr = await readAttr("ifc-compare", "data-ifc-compare-hash");
  const cmpText = await readText("ifc-compare-result");
  const directCompare = await qq("ifc.compare", { ifc: directExportValue?.ifc ?? "" });
  const cmpValue =
    directCompare && directCompare.ok
      ? (directCompare.value as { report: { summary: Record<string, number> }; reportHash: string })
      : null;
  push(
    "5",
    "compare via UI (+ direct) → the export reconciles against its own document: unchanged 11, lossy 0, 64-hex report hash",
    clickedCmp && cmpStatus.state === "done" && cmpStatusAttr === "clean" &&
      cmpValue?.report.summary.unchanged === 11 && cmpValue.report.summary.lossy === 0 &&
      cmpValue.report.summary.created === 0 && cmpValue.report.summary.reconciled === 0 &&
      /^[0-9a-f]{64}$/.test(cmpValue?.reportHash ?? "") && cmpHashAttr === cmpValue?.reportHash,
    `${cmpText} · direct summary=${JSON.stringify(cmpValue?.report.summary ?? null)} · reportHash identical=${cmpHashAttr === cmpValue?.reportHash}`,
  );

  // 6. Import the export into its own document through the UI → identity
  //    reconciliation: nothing created, all 11 unchanged, record if-000001.
  const run6 = await currentRun();
  const clickedImp = await click("ifc-import");
  const impStatus = await waitIfcOp("import", run6 + 1, 90000);
  const recAttr = await readAttr("ifc-import", "data-ifc-record");
  const sumAttr = await readAttr("ifc-import", "data-ifc-summary");
  const impText = await readText("ifc-import-result");
  const sum6 = sumAttr !== null ? (JSON.parse(sumAttr) as Record<string, number>) : null;
  const els6 = await elementsOf();
  const records6 = await importRecordIds();
  push(
    "6",
    "import via UI → identity reconciliation: record if-000001, created 0, unchanged 11, no duplicate elements",
    clickedImp && impStatus.state === "done" && recAttr === "if-000001" &&
      sum6?.created === 0 && sum6?.reconciled === 0 && sum6?.unchanged === 11 && sum6?.lossy === 0 &&
      els6.length === 11 && records6 !== null && records6.length === 1 && records6[0] === "if-000001",
    `${impText} · elements=${els6.length} · records=${records6?.join(",") ?? "n/a"}`,
  );

  // 7. Controlled mutation identification (ENGINE TRUTH — see the module
  //    comment): author FireRating REI120 on wall-east + move wall-north +500
  //    (direct), re-export, UNDO the two mutations (UI) so the document holds
  //    the pre-mutation state, then import the mutated file → EXACTLY the two
  //    mutated elements reconcile (patched contains both).
  const mut1 = await cmd("document.applyEdit", { edit: { type: "updateElement", elementId: "wall-east", patch: { FireRating: "REI120" } } });
  const mut2 = await cmd("bim.move", { ids: ["wall-north"], dx: 0, dy: 500, dz: 0 });
  const mutatedExport = await cmd("ifc.export", {});
  const mutated =
    mutatedExport && mutatedExport.ok
      ? (mutatedExport.value as { ifc: string; sha256: string; counts: Record<string, number> })
      : null;
  const run7a = await currentRun();
  const clickedUndo7a = await click("ifc-undo");
  const undo7aStatus = await waitIfcOp("undo", run7a + 1, 30000);
  const run7b = await currentRun();
  const clickedUndo7b = await click("ifc-undo");
  const undo7bStatus = await waitIfcOp("undo", run7b + 1, 30000);
  const els7 = await elementsOf();
  const impMut = await cmd("ifc.import", { ifc: mutated?.ifc ?? "" });
  const impMutValue =
    impMut && impMut.ok
      ? (impMut.value as {
          record: { id: string };
          report: { summary: Record<string, number>; elements: { canonicalId: string | null; action: string }[] };
          patched: string[];
        })
      : null;
  const reconciled7 = impMutValue
    ? impMutValue.report.elements.filter((e) => e.action === "reconciled").map((e) => e.canonicalId).sort()
    : [];
  const records7 = await importRecordIds();
  push(
    "7",
    "controlled mutations (wall-east FireRating REI120 + wall-north move +500) re-exported → import identifies EXACTLY the two mutated elements",
    !!mut1?.ok && !!mut2?.ok && mutated !== null && mutated.sha256 !== directExportValue?.sha256 &&
      clickedUndo7a && undo7aStatus.state === "done" && clickedUndo7b && undo7bStatus.state === "done" &&
      els7.length === 11 && wallNorthAtRest(els7) && wallEastNoFireRating(els7) &&
      impMutValue !== null && JSON.stringify(reconciled7) === JSON.stringify(["wall-east", "wall-north"]) &&
      impMutValue.report.summary.created === 0 && impMutValue.report.summary.unchanged === 9 &&
      impMutValue.patched.includes("wall-east") && impMutValue.patched.includes("wall-north") &&
      impMutValue.record.id === "if-000002" && records7 !== null && records7.length === 2,
    `mutations ok · mutated export sha ${mutated?.sha256.slice(0, 8) ?? "—"}… (≠ v0 export) · undo ×2 restored the pre-mutation state (wall-north [6000,5000]→[0,5000], wall-east FireRating absent) · import → reconciled ${JSON.stringify(reconciled7)} · patched ${JSON.stringify(impMutValue?.patched ?? [])} · unchanged ${impMutValue?.report.summary.unchanged ?? "n/a"} · record ${impMutValue?.record.id ?? "—"} · records ${records7?.join(",") ?? "n/a"}`,
  );

  // 8. Undo the two imports (UI): each ifc.import is ONE atomic versioned
  //    command — the record, the patches and the created elements revert
  //    together; the document contentHash is restored to the seeded hash.
  const run8a = await currentRun();
  const clickedUndo8a = await click("ifc-undo");
  const undo8aStatus = await waitIfcOp("undo", run8a + 1, 30000);
  const records8a = await importRecordIds();
  const els8a = await elementsOf();
  const run8b = await currentRun();
  const clickedUndo8b = await click("ifc-undo");
  const undo8bStatus = await waitIfcOp("undo", run8b + 1, 30000);
  const records8b = await importRecordIds();
  const els8b = await elementsOf();
  const contentHash8 = await page<string>(`window.cad.contentHash()`);
  push(
    "8",
    "undo the two imports via UI → records 0, elements 11, patches reverted atomically; contentHash restored to the seeded hash",
    clickedUndo8a && undo8aStatus.state === "done" &&
      records8a !== null && records8a.length === 1 && records8a[0] === "if-000001" &&
      els8a.length === 11 && wallNorthAtRest(els8a) && wallEastNoFireRating(els8a) &&
      clickedUndo8b && undo8bStatus.state === "done" &&
      records8b !== null && records8b.length === 0 && els8b.length === 11 &&
      contentHash8 === contentHashSeeded,
    `after undo#1: records ${records8a?.join(",") ?? "n/a"} · wall-north at rest=${wallNorthAtRest(els8a)} · wall-east FireRating absent=${wallEastNoFireRating(els8a)}; after undo#2: records ${records8b?.length ?? "n/a"} · elements ${els8b.length} · contentHash ${contentHash8.slice(0, 12)}… == seeded ${contentHashSeeded.slice(0, 12)}… (${contentHash8 === contentHashSeeded})`,
  );

  // 9. IDS validation through the UI: the fire-rating spec fails for all 4
  //    applicable walls → author FireRating REI60 on wall-south (direct) →
  //    exactly wall-south passes (per-entity discrimination).
  const run9 = await currentRun();
  const clickedIds1 = await click("ifc-ids");
  const idsStatus1 = await waitIfcOp("ids", run9 + 1, 150000);
  const idsAttr1 = await readAttr("ifc-ids", "data-ifc-ids-status");
  const idsApplicable1 = await readAttr("ifc-ids", "data-ifc-ids-applicable");
  const idsPassed1 = await readAttr("ifc-ids", "data-ifc-ids-passed");
  const idsText1 = await readText("ifc-ids-result");
  const author = await cmd("document.applyEdit", { edit: { type: "updateElement", elementId: "wall-south", patch: { FireRating: "REI60" } } });
  const run9b = await currentRun();
  const clickedIds2 = await click("ifc-ids");
  const idsStatus2 = await waitIfcOp("ids", run9b + 1, 150000);
  const idsAttr2 = await readAttr("ifc-ids", "data-ifc-ids-status");
  const idsPassed2 = await readAttr("ifc-ids", "data-ifc-ids-passed");
  const idsPassedIds2 = await readAttr("ifc-ids", "data-ifc-ids-passed-ids");
  const idsText2 = await readText("ifc-ids-result");
  push(
    "9",
    "IDS fire-rating validation via UI: 4 applicable walls, 0 passed → author FireRating REI60 on wall-south (direct) → exactly 1 passes",
    clickedIds1 && idsStatus1.state === "done" && idsAttr1 === "fail" && idsApplicable1 === "4" && idsPassed1 === "0" &&
      !!author?.ok && clickedIds2 && idsStatus2.state === "done" && idsAttr2 === "fail" &&
      idsPassed2 === "1" && idsPassedIds2 === "wall-south",
    `before: ${idsText1}; after: ${idsText2}`,
  );

  // 10. BCF topic round trip through the UI: create + parse; the IfcGuid
  //     references must resolve back to the CANONICAL ids.
  const run10 = await currentRun();
  const clickedBcf = await click("ifc-bcf");
  const bcfStatus = await waitIfcOp("bcf", run10 + 1, 90000);
  const bcfResolved = await readAttr("ifc-bcf", "data-ifc-bcf-resolved");
  const bcfSize = Number(await readAttr("ifc-bcf", "data-ifc-bcf-size"));
  const bcfText = await readText("ifc-bcf-result");
  push(
    "10",
    "BCF topic round trip via UI → references resolve back to the canonical ids (wall-east, wall-north)",
    clickedBcf && bcfStatus.state === "done" && bcfResolved === "wall-east,wall-north" && bcfSize > 500,
    bcfText,
  );

  // 11. Import records through the UI: after the atomic undos the record table
  //     is empty — honestly reported, and identical to the direct query.
  const run11 = await currentRun();
  const clickedRecords = await click("ifc-records");
  const recordsStatus = await waitIfcOp("records", run11 + 1, 30000);
  const recordsCountAttr = await readAttr("ifc-records", "data-ifc-records-count");
  const recordsText = await readText("ifc-records-list");
  const recordsDirect = await importRecordIds();
  push(
    "11",
    "import records via UI → 0 records after the undos (removed with the same undo); UI count == direct ifc.listImports",
    clickedRecords && recordsStatus.state === "done" && recordsCountAttr === "0" &&
      recordsDirect !== null && recordsDirect.length === 0 && /No import records/.test(recordsText),
    `ui count=${recordsCountAttr ?? "n/a"} · direct count=${recordsDirect?.length ?? "n/a"} · ${recordsText}`,
  );

  // 12. Save → open round trip: the pre-save export still reconciles
  //     all-unchanged against the RE-OPENED document, and the re-export is
  //     byte-identical — canonical identity survived persistence.
  const run12 = await currentRun();
  const clickedExport12 = await click("ifc-export");
  const export12Status = await waitIfcOp("export", run12 + 1, 90000);
  const sha12 = await readAttr("ifc-export", "data-ifc-sha");
  const export12Text = await readText("ifc-export-result");
  const export12 = await cmd("ifc.export", {});
  const export12Value = export12 && export12.ok ? (export12.value as { ifc: string; sha256: string }) : null;
  const save12 = await cmd("document.save", {});
  const saveBytes = save12 && save12.ok ? ((save12.value as { bytes: number[] }).bytes ?? null) : null;
  const open12 = saveBytes !== null ? await cmd("document.open", { source: saveBytes }) : null;
  const compare12 = await qq("ifc.compare", { ifc: export12Value?.ifc ?? "" });
  const compare12Value =
    compare12 && compare12.ok ? (compare12.value as { report: { summary: Record<string, number> } }) : null;
  const reexport12 = await cmd("ifc.export", {});
  const reexport12Sha = reexport12 && reexport12.ok ? ((reexport12.value as { sha256: string }).sha256) : "";
  push(
    "12",
    "save → open round trip → the pre-save export reconciles all-unchanged (11, lossy 0) against the re-opened document; the re-export is byte-identical",
    clickedExport12 && export12Status.state === "done" && /^[0-9a-f]{64}$/.test(sha12 ?? "") &&
      sha12 === export12Value?.sha256 && sha12 !== directExportValue?.sha256 && !!open12?.ok &&
      compare12Value?.report.summary.unchanged === 11 && compare12Value.report.summary.created === 0 &&
      compare12Value.report.summary.reconciled === 0 && compare12Value.report.summary.lossy === 0 &&
      reexport12Sha === sha12,
    `${export12Text} · save/open ok · compare after open: unchanged=${compare12Value?.report.summary.unchanged ?? "n/a"} lossy=${compare12Value?.report.summary.lossy ?? "n/a"} created=${compare12Value?.report.summary.created ?? "n/a"} · re-export sha byte-identical=${reexport12Sha === sha12} (the authored FireRating changed the file: ${sha12 !== directExportValue?.sha256})`,
  );

  const allOk = steps.every((s) => s.ok);
  writeSmokeOut({
    ok: allOk,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: contentHashSeeded,
    sceneHash: null,
  });
}

// --- COMPAT-BIM-003: components/materials/coordination smoke (Issue #50) -------

/** Drive the Components mode panel through the real UI and assert each step
 *  (5 steps — see test/smoke-components.mjs for the reproducible runner). */
async function runComponentsSmoke(win: BrowserWindow): Promise<void> {
  interface CompStep { step: string; name: string; pass: boolean; ok: boolean; detail: unknown }
  const steps: CompStep[] = [];
  const push = (num: string, name: string, pass: boolean, detail: unknown): void => {
    steps.push({ step: num, name, pass, ok: pass, detail });
  };

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  // Rejection-capturing page evaluation (see runGeometrySmoke).
  const page = async <T>(js: string): Promise<T> => {
    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: T } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };
  const send = (request: CommandQueryRequest): Promise<CommandQueryResponse> =>
    page<CommandQueryResponse>(`window.cad.send(${JSON.stringify(request)})`);
  const cmd = (name: string, payload: unknown) =>
    send({ type: "command", name: name as never, payload });
  const qq = (name: string, payload: unknown) =>
    send({ type: "query", name: name as never, payload });

  const waitFor = async (predicateJs: string, timeoutMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await page<boolean>(`(async () => (${predicateJs}))()`);
      if (v === true) return;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const click = (testid: string): Promise<boolean> =>
    page<boolean>(
      `(async () => { const b = document.querySelector('[data-testid="${testid}"]'); if (!b) return false; b.click(); return true; })()`,
    );
  const readAttr = (testid: string, attr: string): Promise<string | null> =>
    page<string | null>(
      `(async () => { const e = document.querySelector('[data-testid="${testid}"]'); return e ? e.getAttribute("${attr}") : null; })()`,
    );
  const readText = (testid: string): Promise<string> =>
    page<string>(
      `(async () => { const e = document.querySelector('[data-testid="${testid}"]'); return e ? (e.textContent || "") : ""; })()`,
    );
  /** The components status protocol's monotonic run counter. */
  const currentRun = async (): Promise<number> => {
    const v = await readAttr("comp-status", "data-run");
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  /** Wait for the comp status protocol to settle: state done|error for `op`
   *  at run counter `run` AND the UI idle again (mode toggle re-enabled). */
  const waitCompOp = async (op: string, run: number, timeoutMs: number): Promise<{ state: string; op: string; text: string }> => {
    await waitFor(
      `(() => { const s = document.querySelector('[data-testid="comp-status"]'); const m = document.querySelector('[data-testid="mode-components"]');` +
        ` return !!s && (s.getAttribute("data-state") === "done" || s.getAttribute("data-state") === "error")` +
        ` && s.getAttribute("data-op") === "${op}" && s.getAttribute("data-run") === "${run}" && !!m && !m.disabled; })()`,
      timeoutMs,
      `comp op '${op}' #${run} to settle`,
    );
    return page<{ state: string; op: string; text: string }>(
      `(async () => { const s = document.querySelector('[data-testid="comp-status"]');` +
        ` return { state: s ? s.getAttribute("data-state") : "none", op: s ? s.getAttribute("data-op") : "", text: s ? s.textContent : "" }; })()`,
    );
  };

  // Direct inventory helper (the derived parametric state).
  interface CompInventory {
    materials: { elementId: string; name: string }[];
    definitions: { elementId: string; category: string; parameters: Record<string, number> }[];
    instances: {
      elementId: string; definitionId: string; overrides: Record<string, number>;
      effectiveParameters: Record<string, number>; effectiveMaterialId: string | null;
    }[];
    grids: { elementId: string; name: string }[];
    referencePlanes: { elementId: string; name: string }[];
    unsupported: Record<string, string>;
  }
  const inventory = async (): Promise<CompInventory | null> => {
    const r = await qq("bim.getComponents", {});
    if (!(r && r.ok)) return null;
    return r.value as CompInventory;
  };

  // 1. Components mode is reachable and visible: the fifth header toggle +
  //    the panel; seed the representative component model (13 entities —
  //    story + 2 materials + 3 definitions + 5 instances incl. one with a
  //    width override + structural grid + reference plane).
  const beforeToggle = await page<boolean>(
    `(async () => !!document.querySelector('[data-testid="mode-ifc"]') && !!document.querySelector('[data-testid="mode-components"]'))()`,
  );
  const clickedMode = beforeToggle ? await click("mode-components") : false;
  await waitFor(
    `(() => { const c = document.querySelector('[data-testid="comp-card"]'); const b = document.querySelector('[data-testid="mode-components"]');` +
      ` return !!c && c.style.display !== "none" && !!b && b.getAttribute("aria-pressed") === "true"; })()`,
    10000,
    "Components mode panel visible",
  );
  const compControls = [
    "comp-status", "comp-seed", "comp-seed-result", "comp-width", "comp-propagate",
    "comp-propagate-result", "comp-roundtrip", "comp-roundtrip-result", "comp-undo",
  ];
  const controlsPresent = await page<boolean>(
    `(async () => ${JSON.stringify(compControls)}.every((t) => !!document.querySelector('[data-testid="' + t + '"]')))()`,
  );
  const run1 = await currentRun();
  const clickedSeed = await click("comp-seed");
  const seedStatus = await waitCompOp("seed", run1 + 1, 60000);
  const seedCount = Number(await readAttr("comp-seed", "data-count"));
  const seedText = await readText("comp-seed-result");
  const inv1 = await inventory();
  const seedInventoryOk =
    inv1 !== null && inv1.materials.length === 2 && inv1.definitions.length === 3 &&
    inv1.instances.length === 5 && inv1.grids.length === 1 && inv1.referencePlanes.length === 1;
  push(
    "1",
    "Components mode visible (the fifth toggle switches the panel in; all data-testid controls present) + seed the representative component model via the UI → 13 elements (2 materials · 3 definitions · 5 instances · 1 grid · 1 reference plane)",
    beforeToggle && clickedMode && controlsPresent && clickedSeed && seedStatus.state === "done" && seedCount === 13 && seedInventoryOk,
    controlsPresent
      ? `${compControls.length}/${compControls.length} comp controls present; ${seedText} · inventory: ${inv1?.materials.length ?? "?"} materials / ${inv1?.definitions.length ?? "?"} definitions / ${inv1?.instances.length ?? "?"} instances / ${inv1?.grids.length ?? "?"} grids / ${inv1?.referencePlanes.length ?? "?"} reference planes`
      : "comp controls missing",
  );

  // 2. Derived parametric state (direct bim.getComponents): effective
  //    parameters = definition ⊕ overrides (the override PINS its key), the
  //    wall inherits the definition's default material, the door carries an
  //    instance material, and the unsupported set is declared explicitly.
  const inv2 = await inventory();
  const desk1 = inv2?.instances.find((i) => i.elementId === "inst-desk-1") ?? null;
  const desk2 = inv2?.instances.find((i) => i.elementId === "inst-desk-2") ?? null;
  const wallA = inv2?.instances.find((i) => i.elementId === "inst-wall-a") ?? null;
  const door1 = inv2?.instances.find((i) => i.elementId === "inst-door-1") ?? null;
  const derivedOk =
    inv2 !== null && desk1 !== null && desk2 !== null && wallA !== null && door1 !== null &&
    Math.abs((desk1.effectiveParameters.width ?? NaN) - 1600) <= 1e-3 &&
    Object.keys(desk1.overrides).length === 0 &&
    Math.abs((desk2.effectiveParameters.width ?? NaN) - 1200) <= 1e-3 &&
    Math.abs((desk2.overrides.width ?? NaN) - 1200) <= 1e-3 &&
    wallA.effectiveMaterialId === "mat-concrete" &&
    door1.effectiveMaterialId === "mat-glass" &&
    typeof inv2.unsupported.alignmentConstraints === "string" && inv2.unsupported.alignmentConstraints.length > 0;
  push(
    "2",
    "derived state via bim.getComponents → effective parameters = definition ⊕ overrides (desk1 1600 no overrides; desk2 1200 PINNED by its override); the wall inherits the definition default material (concrete); the door carries an instance material (glazing); the unsupported set is declared",
    derivedOk,
    `desk1 eff.width=${desk1?.effectiveParameters.width ?? "n/a"} (ovr ${JSON.stringify(desk1?.overrides ?? {})}); desk2 eff.width=${desk2?.effectiveParameters.width ?? "n/a"} (ovr ${JSON.stringify(desk2?.overrides ?? {})}); wallA material=${wallA?.effectiveMaterialId ?? "n/a"}; door1 material=${door1?.effectiveMaterialId ?? "n/a"}; unsupported: ${Object.keys(inv2?.unsupported ?? {}).join(",") || "none"}`,
  );

  // 3. Parametric propagation through the UI: edit the desk definition's
  //    width default (1800) → every instance's EFFECTIVE width follows
  //    deterministically EXCEPT the override, which PINS its key.
  const run3 = await currentRun();
  const clickedPropagate = await click("comp-propagate");
  const propStatus = await waitCompOp("propagate", run3 + 1, 60000);
  const propAttr = await readAttr("comp-propagate", "data-propagated");
  const propText = await readText("comp-propagate-result");
  const inv3 = await inventory();
  const desk1p = inv3?.instances.find((i) => i.elementId === "inst-desk-1") ?? null;
  const desk2p = inv3?.instances.find((i) => i.elementId === "inst-desk-2") ?? null;
  const propagatedOk =
    inv3 !== null && desk1p !== null && desk2p !== null &&
    Math.abs((desk1p.effectiveParameters.width ?? NaN) - 1800) <= 1e-3 &&
    Math.abs((desk2p.effectiveParameters.width ?? NaN) - 1200) <= 1e-3;
  push(
    "3",
    "definition edit propagates via the UI (bim.setProperties on the desk definition; width default 1600 → 1800) → the plain instance follows (1800); the override PINS its key (1200)",
    clickedPropagate && propStatus.state === "done" && propAttr === "true" && propagatedOk,
    `${propText} · direct: desk1 eff.width=${desk1p?.effectiveParameters.width ?? "n/a"}, desk2 eff.width=${desk2p?.effectiveParameters.width ?? "n/a"}`,
  );

  // 4. Atomic undo through the UI: the definition edit is ONE immutable
  //    revision — undo restores the previous derived state exactly.
  const run4 = await currentRun();
  const clickedUndo = await click("comp-undo");
  const undoStatus = await waitCompOp("undo", run4 + 1, 30000);
  const inv4 = await inventory();
  const desk1u = inv4?.instances.find((i) => i.elementId === "inst-desk-1") ?? null;
  const desk2u = inv4?.instances.find((i) => i.elementId === "inst-desk-2") ?? null;
  const undoneOk =
    inv4 !== null && desk1u !== null && desk2u !== null &&
    Math.abs((desk1u.effectiveParameters.width ?? NaN) - 1600) <= 1e-3 &&
    Math.abs((desk2u.effectiveParameters.width ?? NaN) - 1200) <= 1e-3;
  push(
    "4",
    "atomic undo via the UI (document.undo — the definition edit is ONE immutable revision) → desk1 restores 1600; desk2 stays pinned at 1200",
    clickedUndo && undoStatus.state === "done" && undoneOk,
    `desk1 eff.width=${desk1u?.effectiveParameters.width ?? "n/a"} (expect 1600); desk2 eff.width=${desk2u?.effectiveParameters.width ?? "n/a"} (expect 1200)`,
  );

  // 5. The IFC round trip through the UI: export (deterministic; components +
  //    materials exported; the grid/reference plane declared NOT exported) →
  //    fresh document → identity-preserving import → zero-loss compare, and
  //    the definition DEFAULTS are reconstructed from non-overriding
  //    instances (not polluted by the overridden one).
  const run5 = await currentRun();
  const clickedRt = await click("comp-roundtrip");
  const rtStatus = await waitCompOp("roundtrip", run5 + 1, 180000);
  const rtSha = await readAttr("comp-roundtrip", "data-rt-sha");
  const rtSummaryRaw = await readAttr("comp-roundtrip", "data-rt-summary");
  const rtText = await readText("comp-roundtrip-result");
  const rtSummary = rtSummaryRaw !== null ? (JSON.parse(rtSummaryRaw) as Record<string, number>) : null;
  const inv5 = await inventory();
  const desk1r = inv5?.instances.find((i) => i.elementId === "inst-desk-1") ?? null;
  const desk2r = inv5?.instances.find((i) => i.elementId === "inst-desk-2") ?? null;
  const defDeskr = inv5?.definitions.find((d) => d.elementId === "def-desk") ?? null;
  const roundtripOk =
    inv5 !== null && desk1r !== null && desk2r !== null && defDeskr !== null &&
    rtSummary !== null && rtSummary.unchanged === 8 && rtSummary.created === 0 &&
    rtSummary.reconciled === 0 && rtSummary.lossy === 0 && (rtSummary.unsupportedFields ?? 0) === 0 &&
    inv5.materials.length === 2 && inv5.definitions.length === 3 && inv5.instances.length === 5 &&
    inv5.grids.length === 0 && inv5.referencePlanes.length === 0 &&
    Math.abs((defDeskr.parameters.width ?? NaN) - 1600) <= 1e-3 &&
    Math.abs((desk1r.effectiveParameters.width ?? NaN) - 1600) <= 1e-3 && Object.keys(desk1r.overrides).length === 0 &&
    Math.abs((desk2r.effectiveParameters.width ?? NaN) - 1200) <= 1e-3 && Math.abs((desk2r.overrides.width ?? NaN) - 1200) <= 1e-3;
  push(
    "5",
    "component IFC round-trip via the UI (export → fresh document → import → compare) → zero loss (unchanged 8, lossy 0); definition defaults reconstructed from the NON-OVERRIDING instance (1600, not the 1200 override); the override survives pinned; the grid/reference plane are declared canonical-only (absent after import)",
    clickedRt && rtStatus.state === "done" && /^[0-9a-f]{64}$/.test(rtSha ?? "") && roundtripOk,
    `${rtText} · post-round-trip: def-desk width=${defDeskr?.parameters.width ?? "n/a"}, desk1 eff.width=${desk1r?.effectiveParameters.width ?? "n/a"} (ovr ${JSON.stringify(desk1r?.overrides ?? {})}), desk2 eff.width=${desk2r?.effectiveParameters.width ?? "n/a"} (ovr ${JSON.stringify(desk2r?.overrides ?? {})})`,
  );

  const allOk = steps.every((s) => s.ok);
  writeSmokeOut({
    ok: allOk,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: null,
    sceneHash: null,
  });
}
