"use client";

/**
 * CAD-PARITY-002 professional workspace shell (Web host) — Issue #75.
 *
 * The command-first information architecture of spec/cad-bim/ui.md:
 *   menu / ribbon+toolbars+command search → tool palette | canvas with
 *   view tabs | properties/layers/navigator → command line → status bar.
 *
 * EVERY mutation flows through the shared prompt engine → App API command
 * plans (§5.3). The same engine drives the ribbon, menu, tool palette,
 * command palette (Ctrl+K), keyboard shortcuts and the command line — one
 * semantic path, deterministic and host-parity (LOCK-004). Selection,
 * camera, aids and palette state are host-local (LOCK-015). No engine
 * loads in the renderer (LOCK-003/018).
 */

import * as React from "react";
import { PanelRightClose, PanelRightOpen, AlertCircle, History, GitBranch, Workflow } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { CADDocumentSnapshot, VersionMeta } from "@offisos/cad-app-shell/contracts/caddocument";
import type { Vec2 } from "@offisos/cad-app-shell/drafting/precision";
import type { Command, CommandQueryResponse } from "@offisos/cad-app-shell/contracts/app-api";
import {
  parametricsCapabilities,
  assocReport,
  unwrapParametricsCapabilities,
  unwrapAssocReport,
  createDoc,
  getGraphEvents,
  getHistory,
  getImpactCascade,
  getSelection,
  getState,
  materialsBom,
  materialsList,
  coordinationClash,
  openFromText,
  replayModel,
  revisionsList,
  save,
  schedulesList,
  // CAD-PARITY-015 (Issue #110): the properties/quantities surfaces.
  propertiesList,
  quantitiesRun,
  unwrapPropertiesList,
  unwrapQuantityReport,
  // CAD-PARITY-016 (Issue #112): the collaboration/recovery/scale surfaces
  // (the report.recovery/report.collab/report.xrefs/report.budgets actions).
  recoveryList,
  collabState,
  collabTransactions,
  xrefsStatus,
  perfBudgets,
  unwrapRecoveryList,
  unwrapCollabState,
  unwrapCollabTransactions,
  unwrapXrefsStatus,
  unwrapPerfBudgets,
  // CAD-PARITY-017 (Issue #116): the automation/extension surfaces (the
  // report.automation action).
  automationCapabilities,
  automationPrincipals,
  automationScripts,
  automationRuns,
  automationExtensions,
  automationEvents,
  unwrapAutomationCapabilities,
  unwrapAutomationPrincipals,
  unwrapAutomationScripts,
  unwrapAutomationRuns,
  unwrapAutomationExtensions,
  unwrapAutomationEvents,
  // CAD-PARITY-018 (Issue #118): the specialized-toolsets surfaces (the
  // report.toolsets action — the capability discovery, the record
  // inventory, the MEP clash report, the raster status/trace).
  toolsetCapabilities,
  toolsetListRecords,
  toolsetMepValidateRoute,
  toolsetMepClashReport,
  toolsetRasterStatus,
  toolsetRasterTrace,
  unwrapToolsetCapabilities,
  unwrapToolsetListRecords,
  unwrapMepClashReport,
  unwrapRasterStatus,
  unwrapRasterTrace,
  send,
  setSelection as setDocumentSelection,
  unwrapCoordinationClash,
  unwrapGraphEvents,
  unwrapHistory,
  unwrapImpactCascade,
  unwrapMaterialsBom,
  unwrapMaterialsList,
  unwrapReplay,
  unwrapRevisionsList,
  unwrapSaveBytes,
  unwrapSchedulesList,
} from "@/cad/client/http-transport";
import { commandById, WORKSPACE_COMMANDS, type WorkspaceCommand } from "@offisos/cad-app-shell/workspace/commands";
// COMPAT-CAD-006 (Issue #138): the shared navigation request vocabulary
// (ZOOM/PAN/REGEN ui actions → ViewNavigation requests for the canvas).
import type { ViewNavigation, ViewNavigationRequest } from "@offisos/cad-app-shell/workspace/view";
import {
  IDLE_PROMPT_STATE,
  applyPromptEvent,
  describePrompt,
  splitEchoTiming,
  type PromptEngineState,
} from "@offisos/cad-app-shell/workspace/prompt-engine";
import { mapKeyEvent } from "@offisos/cad-app-shell/workspace/keymap";
import { PICKBOX_SCREEN_PX } from "@offisos/cad-app-shell/workspace/precision-2d";
import {
  DEFAULT_DRAFTING_AIDS,
  type DraftingAids,
} from "@offisos/cad-app-shell/workspace/feedback";
import type { CommandContext, CommandPlan, EntityPick } from "@offisos/cad-app-shell/workspace/types";
import { defaultCommandContext } from "@offisos/cad-app-shell/workspace/types";
import type { GripEditResult } from "@offisos/cad-app-shell/workspace/grips";

import { MenuBar, Ribbon, ToolPalette, type WorkspacePreset, type WorkspaceView } from "@/cad/workspace/ribbon";
import { RightDock, type DockTab } from "@/cad/workspace/palettes";
import { ModelCanvas } from "@/cad/workspace/model-canvas";
import { LayoutCanvas } from "@/cad/workspace/layout-canvas";
import { PlotPreview } from "@/cad/workspace/plot-preview";
import { Model3DViewport } from "@/cad/model3d/viewport";
import { CommandLine } from "@/cad/workspace/command-line";
import { StatusBar } from "@/cad/workspace/status-bar";
import { CommandPalette } from "@/cad/workspace/command-palette";
import { BimWorkbench } from "@/cad/bim/workbench";
import { DocsWorkbench } from "@/cad/docs/workbench";
import { IfcWorkbench } from "@/cad/ifc/workbench";
import { ComponentsWorkbench } from "@/cad/components/workbench";
// CAD-PARITY-015 (Issue #110): the Schedules/Properties/Quantities workbench.
import { SchedulesWorkbench } from "@/cad/schedules/workbench";
// CAD-PARITY-016 (Issue #112): the Collaboration/Recovery/Scale workbench.
import { CollabWorkbench } from "@/cad/collab/workbench";
// CAD-PARITY-017 (Issue #116): the automation/extension/API workbench (the
// capability discovery, principals, scripts, runs, events, extensions).
import { AutomationWorkbench } from "@/cad/automation/workbench";
// CAD-PARITY-018 (Issue #118): the specialized-toolsets workbench (the
// architecture/MEP/mechanical/raster workflows over the governed App API).
import { ToolsetsWorkbench } from "@/cad/toolsets/workbench";
// COMPAT-CAD-004 (Issue #121): the Parametrics workbench (the consolidated
// parametrics/associative/patterns workflows over the governed App API).
import { ParametricsWorkbench } from "@/cad/parametrics/workbench";
// CAD-PARITY-019 (Issue #122): the Certification workbench (the version-
// pinned corpus catalog + the live interoperability classification probes
// over the governed App API).
import { CertificationWorkbench } from "@/cad/certification/workbench";
// CAD-PARITY-012 (Issue #102): the shared material display helpers — the
// SAME resolution the canvas paint loop and the Coordination palette run;
// materialViewsOf derives the id-sorted table rows from the snapshot (the
// SAME data the materials.list query serves) that feed the CommandContext
// materials table the MATSET builder resolves names against (LOCK-004
// parity by construction).
import {
  DEFAULT_LINEWEIGHT,
  materialColorHex,
  materialViewsOf,
} from "@/cad/workspace/material-display";

const VIEW_TABS: readonly { id: WorkspaceView; label: string }[] = [
  { id: "model", label: "Model" },
  // CAD-PARITY-009 (Issue #90): the 3D Model view — the canonical 3D scene
  // (UCS/workplane + solids + the persisted camera) rendered through the
  // SHARED model3d core; a model-space "3D" mode beside the Model view.
  { id: "model3d", label: "3D" },
  { id: "bim3d", label: "3D BIM" },
  { id: "docs", label: "Documentation" },
  { id: "ifc", label: "Interoperability" },
  { id: "components", label: "Components" },
  // CAD-PARITY-015 (Issue #110): the schedules/indexes/properties/quantity
  // workflows surface.
  { id: "schedules", label: "Schedules" },
  // CAD-PARITY-016 (Issue #112): the collaboration/recovery/scale surface.
  { id: "collab", label: "Collab" },
  // CAD-PARITY-017 (Issue #116): the automation/extension/API surface.
  { id: "automation", label: "Automation" },
  // CAD-PARITY-018 (Issue #118): the specialized-toolsets surface
  // (architecture, MEP, mechanical, raster).
  { id: "toolsets", label: "Toolsets" },
  // COMPAT-CAD-004 (Issue #121): the consolidated parametrics surface
  // (constraints, associations, symbols, patterns).
  { id: "parametrics", label: "Parametrics" },
  // CAD-PARITY-019 (Issue #122): the certification surface (the version-
  // pinned corpus catalog + the live interop classification).
  { id: "certification", label: "Certification" },
];

export function WorkspaceShell(): React.JSX.Element {
  // --- document state -------------------------------------------------------
  const [snapshot, setSnapshot] = React.useState<CADDocumentSnapshot | null>(null);
  const [selection, setSel] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // --- workspace state --------------------------------------------------------
  const [view, setView] = React.useState<WorkspaceView>("model");
  const [preset, setPreset] = React.useState<WorkspacePreset>("drafting");
  const [dockTab, setDockTab] = React.useState<DockTab>("properties");
  const [dockVisible, setDockVisible] = React.useState(true);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [aids, setAids] = React.useState<DraftingAids>(DEFAULT_DRAFTING_AIDS);
  const [activeStoryId, setActiveStoryId] = React.useState<string | null>(null);
  const [cursor, setCursor] = React.useState<Vec2 | null>(null);
  const [engineState, setEngineState] = React.useState<PromptEngineState>(IDLE_PROMPT_STATE);
  const [historyLines, setHistoryLines] = React.useState<string[]>([]);
  // COMPAT-CAD-006 (Issue #138): the ONE navigation request channel — the
  // ZOOM/PAN/REGEN/ZOOMEXTENTS command ui-actions land here and the Model
  // canvas (the view-state owner) applies them through the SHARED
  // view-transform module. seq is monotonic (the canvas effect keys on it).
  const navigationSeq = React.useRef(0);
  const [navigation, setNavigation] = React.useState<ViewNavigation | null>(null);
  /** COMPAT-CAD-006: translate one ui action into a navigation request. */
  const navigate = React.useCallback((request: ViewNavigationRequest): void => {
    navigationSeq.current += 1;
    setNavigation({ seq: navigationSeq.current, request });
  }, []);
  // COMPAT-CAD-005: NEW/view reset signal — the Model canvas restores the
  // (new) document's persisted view when this increments (a document swap
  // must never keep the previous document's pan/zoom: DEF-003's dangling
  // view state made NEW leave a stale viewport).
  const [viewResetSignal, setViewResetSignal] = React.useState(0);
  const [showHistory, setShowHistory] = React.useState(false);
  const [historyData, setHistoryData] = React.useState<{ revisions: number; graphEvents: number; replayNote: string | null }>({ revisions: 0, graphEvents: 0, replayNote: null });
  // CAD-PARITY-008: the paper-space editor surface — the selected viewport
  // (frame grip editing on the paper canvas) and the plot preview overlay.
  const [selectedViewportId, setSelectedViewportId] = React.useState<string | null>(null);
  const [plotPreviewOpen, setPlotPreviewOpen] = React.useState(false);

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // --- data refresh -----------------------------------------------------------

  const refresh = React.useCallback(async () => {
    const [stateRes, selQuery] = await Promise.all([getState(), getSelection()]);
    const snap = stateRes.ok ? (stateRes.value as CADDocumentSnapshot) : null;
    const sel = selQuery.ok ? (selQuery.value as string[]) : [];
    if (snap !== null) {
      setSnapshot(snap);
      setSel(sel);
      setError(null);
    } else if (!stateRes.ok) {
      setError(`[getState] ${stateRes.code}: ${stateRes.message}`);
    }
  }, []);

  // COMPAT-CAD-005: authoritative snapshot adoption. Many App API commands
  // return the post-commit document snapshot in their response value; the
  // shell adopts it IMMEDIATELY (guarded by the version counter so a
  // late-arriving response can never roll the client back to an older
  // revision). This closes the stale-context window between commit and the
  // next refresh — the root of the CAD-BENCH-RW-001 layer-identity desync
  // (DEF-001/DEF-002: the client's layer table/activeLayer lagged one
  // roundtrip behind the canonical document, so creation landed on '0' and
  // CLAYER could not resolve names the document provably contained).
  const adoptSnapshot = React.useCallback((snap: unknown) => {
    if (typeof snap !== "object" || snap === null) return;
    const next = snap as CADDocumentSnapshot;
    if (typeof next?.version?.version_number !== "number" || !Array.isArray(next?.layers)) return;
    setSnapshot((current) => {
      if (current !== null && next.version.version_number < current.version.version_number) {
        // A stale response (older revision) never replaces newer state.
        return current;
      }
      return next;
    });
  }, []);

  /** COMPAT-CAD-005: adopt the server's effective selection from a
   *  document.setSelection response ({ selection }) — the canonical,
   * live-pruned selection state (DEF-014/DEF-008). */
  const adoptSelection = React.useCallback((value: unknown, fallback: readonly string[]) => {
    const eff = (value as { selection?: unknown } | null)?.selection;
    if (Array.isArray(eff) && eff.every((x) => typeof x === "string")) setSel(eff as string[]);
    else setSel([...fallback]);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // CAD-PARITY-004: the ACTIVE layer is persisted document editor state
  // (draftingSettings.activeLayer — CLAYER class, survives save/open and is
  // identical on both hosts). Falls back to the first existing layer when
  // the persisted id is stale; switched ONLY through layer.setActive.
  const activeLayer = React.useMemo(() => {
    const layers = snapshot?.layers ?? [];
    const persisted = snapshot?.draftingSettings?.activeLayer;
    if (persisted !== undefined && layers.some((l) => l.id === persisted)) return persisted;
    return layers[0]?.id ?? "0";
  }, [snapshot]);
  const onActiveLayer = React.useCallback(
    (layerId: string) => {
      void (async () => {
        const res = await send({ type: "command", name: "layer.setActive" as Command["name"], payload: { layerId } });
        if (!res.ok) setError(`[layer.setActive] ${res.code}: ${res.message}`);
        else {
          // COMPAT-CAD-005: adopt the authoritative layer table + activeLayer
          // the command returns — the next create stamps THIS layer
          // (DEF-001: active-layer changes must affect entity creation).
          adoptSnapshot((res.value as { snapshot?: CADDocumentSnapshot } | null)?.snapshot);
        }
        await refresh();
      })();
    },
    [refresh, adoptSnapshot],
  );
  // The status bar shows the layer NAME (the id stays canonical).
  const activeLayerName = React.useMemo(
    () => (snapshot?.layers ?? []).find((l) => l.id === activeLayer)?.name ?? activeLayer,
    [snapshot, activeLayer],
  );
  // COMPAT-CAD-005: THE canonical selection read model — the selection
  // intersected with the live elements of the current snapshot. Every read
  // site (status-bar count, Properties palette, command currentSelection,
  // canvas highlight) observes THIS ONE value, so command-driven selection
  // and click-driven selection can never disagree (CAD-BENCH-RW-001
  // DEF-008: "Sel 1" while the palette said "No selection").
  const liveSelection = React.useMemo(() => {
    const ids = new Set((snapshot?.elements ?? []).map((el) => el.id));
    return selection.filter((id) => ids.has(id));
  }, [snapshot, selection]);

  // --- engine context -----------------------------------------------------------

  const engineCtx = React.useCallback((): CommandContext => {
    const elements = snapshot?.elements ?? [];
    const stories = elements.filter((el) => el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.story");
    const currentSelection: EntityPick[] = elements
      .filter((el) => liveSelection.includes(el.id))
      .map((el) => ({ id: el.id, kind: el.kind, props: el.props as Record<string, unknown> }));
    return defaultCommandContext({
      activeLayer,
      activeStoryId: activeStoryId ?? (stories.length > 0 ? (stories[stories.length - 1]!.id) : null),
      elementCount: elements.length,
      storyCount: stories.length,
      currentSelection,
      // COMPAT-CAD-007 (Issue #142): the document's live elements — the
      // deterministic ALL/LAST resolution surface for "Select objects:"
      // prompts (the SAME snapshot state the Electron context passes).
      documentElements: elements,
      // CAD-PARITY-004: the layer table (name resolution for -LAYER/CHPROP/
      // LAYON builders — the SAME document state both hosts pass).
      layers: snapshot?.layers ?? [],
      // CAD-PARITY-005: the user style tables + the current style names
      // (TEXT/MTEXT resolve style-fixed heights; every annotation command
      // stamps ctx.currentTextStyle / ctx.currentDimStyle — the SAME
      // persisted editor state both hosts pass).
      textStyles: snapshot?.textStyles ?? [],
      dimStyles: snapshot?.dimStyles ?? [],
      currentTextStyle: snapshot?.draftingSettings?.textStyle ?? "Standard",
      currentDimStyle: snapshot?.draftingSettings?.dimStyle ?? "Standard",
      // CAD-PARITY-006: the block-definition + external-reference tables
      // (BLOCK/INSERT/ATTDEF/ATTEDIT/XATTACH/XDETACH/XLIST builders + the
      // dynamic attribute prompts — the SAME document state both hosts pass).
      blocks: snapshot?.blockDefs ?? [],
      xrefs: snapshot?.xrefs ?? [],
      // CAD-PARITY-007: the declared constraint graph
      // (CONSTRAINTLIST/DELCONSTRAINT builders — the SAME document state
      // both hosts pass).
      constraints: snapshot?.constraints ?? [],
      // CAD-PARITY-008: the paper-space layout/viewport tables + the
      // TILEMODE-class editor context (the SAME document state both hosts
      // pass — the layout command builders resolve names/active defaults).
      layouts: snapshot?.layouts ?? [],
      viewports: snapshot?.viewports ?? [],
      activeLayoutId: snapshot?.draftingSettings?.activeLayout ?? snapshot?.layouts?.[0]?.id ?? null,
      space: snapshot?.draftingSettings?.space ?? "model",
      // CAD-PARITY-009: the named-UCS table + the active workplane + the
      // persisted 3D camera + the solid count (the SAME document state the
      // Electron host passes — the UCS/model3d builders resolve through it).
      ucs: snapshot?.ucs ?? [],
      activeUcsId: snapshot?.draftingSettings?.activeUcs ?? "world",
      view3d: snapshot?.draftingSettings?.view3d ?? null,
      model3dSolidCount: (snapshot?.elements ?? []).filter(
        (el) => (el.props as { type?: unknown } | null)?.type === "model3d.solid",
      ).length,
      // CAD-PARITY-012 (Issue #102): the document material table (the
      // bim.material elements with the parity fields) — the MATERIAL/MATSET
      // builders resolve names through it (the SAME document state the
      // App API queries serve; absent parity fields stay absent).
      materials: materialViewsOf(elements),
      // CAD-PARITY-013 (Issue #104): the documentation-production context
      // tables — the saved docs views, the navigator nodes (View Map folders
      // + Layout Book subsets), the title blocks and the publisher sets.
      // The NAVASSIGN/TITLEPLACE/PUBSET builders resolve names through them
      // (the SAME document state the App API queries serve; the snapshot's
      // optional fields are absent-when-empty, so legacy documents pass
      // empty tables — the additive defaultCommandContext fields keep
      // legacy contexts valid).
      docsViews: snapshot?.docsViews ?? [],
      navigatorNodes: snapshot?.navigatorNodes ?? [],
      titleBlocks: snapshot?.titleBlocks ?? [],
      publisherSets: snapshot?.publisherSets ?? [],
    });
  }, [snapshot, liveSelection, activeLayer, activeStoryId]);

  const executeFileSave = React.useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await save();
      if (!res.ok) {
        setError(`[Save] ${res.code}: ${res.message}`);
        return false;
      }
      const data = unwrapSaveBytes(res);
      if (data === null) return true;
      const blob = new Blob([new Uint8Array(data.bytes)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "offisos-workspace.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setHistoryLines((h) => [...h, "SAVE: document downloaded."]);
      return true;
    } finally {
      setBusy(false);
      await refresh();
    }
  }, [refresh]);

  /** COMPAT-CAD-005: NEW is a FULL editor-session reset driven by the
   *  canonical create response (the fresh document IS the response value),
   *  applied SYNCHRONOUSLY before any further input can read stale state.
   *  The CAD-BENCH-RW-001 benchmark (DEF-003) proved the previous flow left
   *  the previous document's active-layer reference live across NEW: the
   *  next create stamped a layer the fresh document does not contain,
   *  failed with drafting_invalid, and left the document undrawable. Also
   *  resets (DEF-014): the entity cache (snapshot), the selection (client
   *  + document), the transient command state, story/viewport selection
   *  and the canvas view (viewResetSignal). */
  const executeFileNew = React.useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await createDoc({});
      if (!res.ok) {
        setError(`[New] ${res.code}: ${res.message}`);
        return false;
      }
      const snap = res.value as CADDocumentSnapshot;
      if (typeof snap?.version?.version_number !== "number") {
        setError("[New] unexpected response shape from document.create");
        return false;
      }
      setSnapshot(snap);
      setSel([]);
      setActiveStoryId(null);
      setSelectedViewportId(null);
      setPlotPreviewOpen(false);
      if (engineState.commandId !== null) {
        // A document swap cancels the running command (AutoCAD class).
        setEngineState(IDLE_PROMPT_STATE);
        setHistoryLines((h) => [...h, "*Cancel*"]);
      }
      setViewResetSignal((n) => n + 1);
      setHistoryLines((h) => [...h, "NEW: fresh document created."]);
      return true;
    } finally {
      setBusy(false);
    }
  }, [engineState.commandId]);


  // --- plan execution -------------------------------------------------------------

  // COMPAT-CAD-005: executePlan runs a command plan COMMIT-AUTHORATIVELY.
  //  - A failed App API entry is THE one authoritative failure outcome: the
  //    *ERROR* history line + the error banner, ABORT of the remaining plan
  //    entries, and SUPPRESSION of the plan's outcome echoes (deferredEcho)
  //    — a success claim can never precede or follow a rejected canonical
  //    transaction (CAD-BENCH-RW-001 DEF-027's success-then-*ERROR* pairs).
  //  - Every successful entry's response snapshot is ADOPTED immediately
  //    (see adoptSnapshot) so the next event reads post-commit state.
  const executePlan = React.useCallback(
    async (plan: CommandPlan, deferredEcho: readonly string[] = []): Promise<boolean> => {
      let failed = false;
      for (const entry of plan.appApi) {
        setBusy(true);
        const res = await send({ type: "command", name: entry.name as Command["name"], payload: entry.payload });
        if (!res.ok) {
          setHistoryLines((h) => [...h, `*ERROR* ${entry.name}: ${res.code} — ${res.message}`]);
          setError(`[${entry.name}] ${res.code}: ${res.message}`);
          failed = true;
          setBusy(false);
          break;
        }
        // COMPAT-CAD-005: adopt the authoritative post-commit snapshot many
        // commands return (layers/activeLayer/elements/version) — closes the
        // stale-context window between commit and refresh (DEF-001/002).
        adoptSnapshot((res.value as { snapshot?: CADDocumentSnapshot } | null)?.snapshot);
        if (entry.name === "bim.createElements") {
          const value = res.value as { created?: string[] } | null;
          if (value !== null && Array.isArray(value.created) && value.created.length > 0) {
            // story.activateCreated UI action binding.
            const created = await getState();
            if (created.ok) {
              const snap = created.value as CADDocumentSnapshot;
              const story = (snap.elements ?? []).find(
                (el) => value.created!.includes(el.id) && el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.story",
              );
              if (story !== undefined) setActiveStoryId(story.id);
            }
          }
        } else if (entry.name === "plot.export" || entry.name === "plot.publish") {
          // CAD-PARITY-008: PLOT/PUBLISH deliver the deterministic artifact —
          // download the exported bytes (SVG text or PDF base64).
          const value = res.value as {
            format?: string; text?: string; bytesBase64?: string; sha256?: string;
            layoutName?: string; pageCount?: number;
          };
          try {
            const isPdf = value.bytesBase64 !== undefined;
            const bytes: Uint8Array = isPdf
              ? Uint8Array.from(atob(value.bytesBase64 ?? ""), (c) => c.charCodeAt(0))
              : new TextEncoder().encode(value.text ?? "");
            const blob = new Blob([bytes as unknown as BlobPart], { type: isPdf ? "application/pdf" : value.format === "svg" || value.format === "plot-ir" ? "image/svg+xml" : "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            const base = (value.layoutName ?? "layouts").replace(/\s+/g, "-").toLowerCase();
            const ext = value.format === "pdf" ? "pdf" : value.format === "svg" ? "svg" : "json";
            a.download = `offisos-${base}${value.pageCount !== undefined && value.pageCount > 1 ? "-set" : ""}.${ext}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            setHistoryLines((h) => [
              ...h,
              `PLOT: ${value.pageCount !== undefined && value.pageCount > 1 ? `${value.pageCount} layouts published` : `${value.layoutName ?? "layout"} exported`} as ${(value.format ?? "?").toUpperCase()} (sha256 ${(value.sha256 ?? "").slice(0, 12)}…) — downloaded.`,
            ]);
          } catch {
            // Download is best-effort in headless contexts; the command itself
            // already succeeded (the artifact hash is in the response).
          }
        }
        setBusy(false);
      }
      // Declarative UI actions.
      for (const action of plan.ui) {
        switch (action.action) {
          case "story.activateCreated":
            // handled above via the created-ids binding
            break;
          case "palette.show": {
            const palette = (action.payload as { palette?: string } | undefined)?.palette;
            if (palette === "search") setPaletteOpen(true);
            else if (palette === "help") setHelpOpen(true);
            else if (palette === "layers") {
              setDockTab("layers");
              setDockVisible(true);
            } else if (palette === "properties") {
              setDockTab("properties");
              setDockVisible(true);
            } else if (palette === "navigator") {
              setDockTab("navigator");
              setDockVisible(true);
            } else if (palette === "linetypes" || palette === "textStyles" || palette === "dimStyles") {
              // CAD-PARITY-004: the style managers (LTYPE/STYLE/DIMSTYLE).
              setDockTab("styles");
              setDockVisible(true);
            } else if (palette === "layerStates") {
              // CAD-PARITY-004: LAYERSTATE — the states section of the Layers
              // manager.
              setDockTab("layers");
              setDockVisible(true);
            } else if (palette === "blocks") {
              // CAD-PARITY-006: XREF — the Blocks & References manager (the
              // definitions list + the external-reference manager).
              setDockTab("blocks");
              setDockVisible(true);
            } else if (palette === "constraints") {
              // CAD-PARITY-007: CONSTRAINTS — the parametric manager (live
              // diagnostics, dimensional value editing, removal).
              setDockTab("constraints");
              setDockVisible(true);
            } else if (palette === "layouts") {
              // CAD-PARITY-008: LAYOUT/VPORTS — the layouts manager (the
              // layout table, page setup, viewport scale/rotation/lock + the
              // per-viewport layer visibility).
              setDockTab("layouts");
              setDockVisible(true);
            } else if (palette === "coordination") {
              // CAD-PARITY-012 (Issue #102): MATLIST/BOM/CLASH — the
              // Coordination palette (materials, components, grids, the
              // clash result and the bill of materials).
              setDockTab("coordination");
              setDockVisible(true);
            } else if (palette === "documentation") {
              // CAD-PARITY-013 (Issue #104): REVLIST/SCHLIST — the
              // Documentation palette (the navigator View Map + Layout Book,
              // title blocks, revisions, schedules, publisher).
              setDockTab("documentation");
              setDockVisible(true);
            } else if (palette === "schedules") {
              // CAD-PARITY-015 (Issue #110): PROPLIST/SCHLIST/QTO — the
              // Schedules workbench (the property registry, the schedules
              // run surface with groups/totals, the quantity takeoff). The
              // P013 SCHLIST instant command emits palette "schedules" — it
              // now maps onto the dedicated workbench view.
              setView("schedules");
            } else if (palette === "collab") {
              // CAD-PARITY-016 (Issue #112): CKPTLIST/COLLABSTATE/TXNLIST/
              // XREFSTATUS/BUDGETS — the Collaboration/Recovery/Scale
              // workbench (members/presence, comments, transactions +
              // conflicts + merge lineage, checkpoints + recovery, jobs,
              // streaming + budgets).
              setView("collab");
            } else if (palette === "automation") {
              // CAD-PARITY-017 (Issue #116): AUTOCAPS/AUTOLIST/AUTOEVENTS —
              // the Automation/Extension/API workbench (capability
              // discovery, principals, scripts, deterministic runs, the
              // scoped event feeds, extension manifests).
              setView("automation");
            } else if (palette === "toolsets") {
              // CAD-PARITY-018 (Issue #118): WALLRUN/PLACEOPENING/ROOFCREATE/
              // STAIRRUN/SPACEGRID/DIMCHAIN/COMPARRAY/MEPRUN/MEPCONNECT/
              // EQUIPADD/EQUIPARRAY/RASTERATTACH + the TOOLSETREPORT/
              // MEPREPORT/RASTERSTATUS/RASTERTRACE report surfaces — the
              // Specialized Toolsets workbench.
              setView("toolsets");
            } else if (palette === "parametrics") {
              // COMPAT-CAD-004 (Issue #121): PATTERNMIRROR/ASSOCREFRESH +
              // the PARAMETRICS report surface — the Parametrics workbench
              // (capability discovery, constraints, the associative report,
              // symbols, patterns).
              setView("parametrics");
            } else if (palette === "workspace") {
              setPreset((p) => (p === "compact" ? "drafting" : "compact"));
            }
            break;
          }
          // CAD-PARITY-012 (Issue #102): the report ui actions — the host
          // intercepts them and renders the REAL query results to the
          // command-line history (deterministic formatting; failures print
          // a typed *ERROR* history line, never crash the shell).
          case "report.matlist": {
            try {
              const res = await materialsList();
              const rows = unwrapMaterialsList(res);
              if (rows === null) {
                setHistoryLines((h) => [
                  ...h,
                  `*ERROR* report.matlist: ${res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`}`,
                ]);
                break;
              }
              const lines = [`MATLIST: ${rows.length} material${rows.length === 1 ? "" : "s"}.`];
              for (const row of rows) {
                lines.push(
                  `MATLIST: ${row.name} | ${row.category ?? "(no category)"} | ${materialColorHex(row)} | ${(row.lineweight ?? DEFAULT_LINEWEIGHT).toFixed(2)} mm`,
                );
              }
              setHistoryLines((h) => [...h, ...lines]);
            } catch {
              setHistoryLines((h) => [...h, "*ERROR* report.matlist: the query failed."]);
            }
            break;
          }
          case "report.bom": {
            try {
              const res = await materialsBom();
              const bom = unwrapMaterialsBom(res);
              if (bom === null) {
                setHistoryLines((h) => [
                  ...h,
                  `*ERROR* report.bom: ${res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`}`,
                ]);
                break;
              }
              const lines = [`BOM: ${bom.rows.length} row${bom.rows.length === 1 ? "" : "s"} (${bom.unit}).`];
              for (const row of bom.rows) {
                lines.push(
                  `BOM: ${row.name} | ${row.count} | ${row.length.toFixed(2)} | ${row.area.toFixed(2)}`,
                );
              }
              setHistoryLines((h) => [...h, ...lines]);
            } catch {
              setHistoryLines((h) => [...h, "*ERROR* report.bom: the query failed."]);
            }
            break;
          }
          case "report.clash": {
            try {
              const res = await coordinationClash();
              const clash = unwrapCoordinationClash(res);
              if (clash === null) {
                setHistoryLines((h) => [
                  ...h,
                  `*ERROR* report.clash: ${res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`}`,
                ]);
                break;
              }
              const lines = [
                `CLASH: ${clash.pairs.length} pair${clash.pairs.length === 1 ? "" : "s"} (checked ${clash.checked}, excluded ${clash.excluded}).`,
              ];
              for (const pair of clash.pairs) {
                lines.push(`CLASH: ${pair.a} ↔ ${pair.b} at ${pair.points.length} point${pair.points.length === 1 ? "" : "s"}.`);
              }
              setHistoryLines((h) => [...h, ...lines]);
            } catch {
              setHistoryLines((h) => [...h, "*ERROR* report.clash: the query failed."]);
            }
            break;
          }
          // CAD-PARITY-013 (Issue #104): the report ui actions — the host
          // intercepts them and renders the REAL query results to the
          // command-line history (deterministic formatting; failures print
          // a typed *ERROR* history line, never crash the shell — the
          // report.matlist precedent).
          case "report.revisions": {
            try {
              const res = await revisionsList();
              const rows = unwrapRevisionsList(res);
              if (rows === null) {
                setHistoryLines((h) => [
                  ...h,
                  `*ERROR* report.revisions: ${res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`}`,
                ]);
                break;
              }
              const lines = [`REVISIONS: ${rows.length} revision${rows.length === 1 ? "" : "s"}.`];
              for (const row of rows) {
                lines.push(
                  `REVISIONS: ${row.code} | ${row.description} | ${row.issued ? "issued" : "draft"} | ${row.layoutIds.length} layout${row.layoutIds.length === 1 ? "" : "s"}.`,
                );
              }
              setHistoryLines((h) => [...h, ...lines]);
            } catch {
              setHistoryLines((h) => [...h, "*ERROR* report.revisions: the query failed."]);
            }
            break;
          }
          // CAD-PARITY-015 (Issue #110): the properties/quantities report ui
          // actions (the report.schedule precedent — the host renders the
          // REAL query results to the command-line history; failures print a
          // typed *ERROR* history line, never crash the shell).
          case "report.properties": {
            try {
              const res = await propertiesList();
              const rows = unwrapPropertiesList(res);
              if (rows === null) {
                setHistoryLines((h) => [
                  ...h,
                  `*ERROR* report.properties: ${res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`}`,
                ]);
                break;
              }
              const lines = [`PROPERTIES: ${rows.length} definition${rows.length === 1 ? "" : "s"} (values counted from the element property-set overlay).`];
              for (const row of rows) {
                lines.push(
                  `PROPERTIES: ${row.name} | ${row.set}.${row.key} | ${row.type}${row.unit !== undefined ? ` ${row.unit}` : ""} | ${row.elementsWithValue} value(s), ${row.typeMatches} match, ${row.typeMismatches} mismatch.`,
                );
              }
              setHistoryLines((h) => [...h, ...lines]);
            } catch {
              setHistoryLines((h) => [...h, "*ERROR* report.properties: the query failed."]);
            }
            break;
          }
          case "report.quantities": {
            try {
              const payload = (action.payload as { source?: unknown; groupBy?: unknown; filter?: unknown } | undefined) ?? {};
              const res = await quantitiesRun({
                source: (typeof payload.source === "string" ? payload.source : "elements") as "elements" | "components" | "materials",
                groupBy: (typeof payload.groupBy === "string" ? payload.groupBy : "none") as "none" | "type" | "story" | "material",
              });
              const report = unwrapQuantityReport(res);
              if (report === null) {
                setHistoryLines((h) => [
                  ...h,
                  `*ERROR* report.quantities: ${res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`}`,
                ]);
                break;
              }
              const lines = [
                `QTO: ${report.source} grouped by ${report.groupBy} — rev ${report.revision.revision_number}, ${report.rows.length + report.bom.length} row(s), ${report.skipped.length} skipped.`,
              ];
              if (report.bom.length > 0) {
                for (const row of report.bom) {
                  lines.push(
                    `QTO: ${row.materialName} | ${row.count} | vol ${row.volume === null ? "-" : String(row.volume)} mm3 | mass ${row.mass === null ? "-" : String(row.mass)} kg.`,
                  );
                }
              } else if (report.totals !== null) {
                lines.push(
                  `QTO: totals | ${report.totals.count} | length ${report.totals.length === null ? "-" : String(report.totals.length)} mm | area ${report.totals.area === null ? "-" : String(report.totals.area)} mm2 | volume ${report.totals.volume === null ? "-" : String(report.totals.volume)} mm3.`,
                );
              }
              lines.push(`QTO: sha256 ${report.reportSha256.slice(0, 12)}.`);
              setHistoryLines((h) => [...h, ...lines]);
            } catch {
              setHistoryLines((h) => [...h, "*ERROR* report.quantities: the query failed."]);
            }
            break;
          }
          case "report.schedule": {
            try {
              const res = await schedulesList();
              const rows = unwrapSchedulesList(res);
              if (rows === null) {
                setHistoryLines((h) => [
                  ...h,
                  `*ERROR* report.schedule: ${res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`}`,
                ]);
                break;
              }
              const lines = [`SCHEDULES: ${rows.length} schedule${rows.length === 1 ? "" : "s"}.`];
              for (const row of rows) {
                lines.push(
                  `SCHEDULES: ${row.name} | ${row.source} | ${row.columnCount} column${row.columnCount === 1 ? "" : "s"}.`,
                );
              }
              setHistoryLines((h) => [...h, ...lines]);
            } catch {
              setHistoryLines((h) => [...h, "*ERROR* report.schedule: the query failed."]);
            }
            break;
          }
          // CAD-PARITY-016 (Issue #112): the collaboration/recovery/scale
          // report surfaces (the report.properties precedent — the host
          // renders the REAL query results to the command-line history;
          // failures print a typed *ERROR* history line, never crash).
          case "report.recovery": {
            try {
              const res = await recoveryList();
              const view = unwrapRecoveryList(res);
              if (view === null) {
                setHistoryLines((h) => [
                  ...h,
                  `*ERROR* report.recovery: ${res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`}`,
                ]);
                break;
              }
              const lines = [
                `RECOVERY: ${view.checkpoints.length} checkpoint(s) retained (policy: autosave every ${view.policy.autosaveEvery}, keep ${view.policy.keep}; autosaves ${view.counters.autosaves}, restores ${view.counters.restores}, since-autosave ${view.counters.mutationsSinceAutosave}).`,
              ];
              for (const c of [...view.checkpoints].reverse()) {
                lines.push(
                  `RECOVERY: ${c.id} ${c.cause} v${c.documentVersionNumber} r${c.modelRevisionNumber} sha ${c.contentHash.slice(0, 12)}… ${c.elementCount} el(s) t=${c.at}.`,
                );
              }
              setHistoryLines((h) => [...h, ...lines]);
            } catch {
              setHistoryLines((h) => [...h, "*ERROR* report.recovery: the query failed."]);
            }
            break;
          }
          case "report.collab": {
            try {
              const [stateRes, txnRes] = await Promise.all([collabState(), collabTransactions()]);
              const state = unwrapCollabState(stateRes);
              const txns = unwrapCollabTransactions(txnRes);
              if (state === null || txns === null) {
                setHistoryLines((h) => [
                  ...h,
                  `*ERROR* report.collab: ${stateRes.ok ? "unexpected state shape" : `${stateRes.code} — ${stateRes.message}`}`,
                ]);
                break;
              }
              const lines = [
                `COLLAB: ${state.members.length} member(s), ${state.members.filter((m) => m.active).length} active (TTL ${state.presenceTtl}, clock t=${state.clock}, doc v${state.documentVersion}, store ${state.persistence.backend}).`,
              ];
              for (const m of state.members) {
                lines.push(
                  `COLLAB: ${m.userId} ${m.role} joined t=${m.joinedAt} last-seen ${m.lastSeenAt !== null ? `t=${m.lastSeenAt}` : "—"} viewing v${m.lastSeenVersion ?? "—"} ${m.active ? "ACTIVE" : "STALE"}.`,
                );
              }
              lines.push(`COLLAB: ${txns.length} transaction(s).`);
              for (const t of txns) {
                lines.push(
                  `COLLAB: ${t.id} ${t.status} v${t.baseVersion}→${t.resultingVersion ?? "—"} by ${t.author}${t.conflict !== null ? ` (conflict head v${t.conflict.currentVersion}, overlap ${t.conflict.overlappingElementIds.length})` : ""}${t.merge !== null ? ` [merge ${t.merge.mergeId} ${t.merge.strategy} (${t.merge.parents.join("+")})]` : ""}.`,
                );
              }
              setHistoryLines((h) => [...h, ...lines]);
            } catch {
              setHistoryLines((h) => [...h, "*ERROR* report.collab: the query failed."]);
            }
            break;
          }
          case "report.xrefs": {
            try {
              const res = await xrefsStatus();
              const rows = unwrapXrefsStatus(res);
              if (rows === null) {
                setHistoryLines((h) => [
                  ...h,
                  `*ERROR* report.xrefs: ${res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`}`,
                ]);
                break;
              }
              const lines = [`XREFS: ${rows.length} external reference(s) (fresh outcomes at v${rows[0]?.revisionBinding.documentVersionNumber ?? "—"}).`];
              for (const x of rows) {
                lines.push(`XREFS: ${x.name} ${x.outcome} — ${x.detail}`);
              }
              setHistoryLines((h) => [...h, ...lines]);
            } catch {
              setHistoryLines((h) => [...h, "*ERROR* report.xrefs: the query failed."]);
            }
            break;
          }
          case "report.budgets": {
            try {
              const res = await perfBudgets();
              const view = unwrapPerfBudgets(res);
              if (view === null) {
                setHistoryLines((h) => [
                  ...h,
                  `*ERROR* report.budgets: ${res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`}`,
                ]);
                break;
              }
              const lines = [
                `BUDGETS: revision-bound v${view.revision.documentVersionNumber} r${view.revision.modelRevisionNumber} sha ${view.revision.contentHash.slice(0, 12)}… (${view.revision.elementCount} elements).`,
                `BUDGETS: ${Object.entries(view.counters).map(([k, v]) => `${k}=${v}`).join(" ")}.`,
                ...view.budgets.map((b) => `BUDGETS: ${b.workflow} <= ${b.thresholdMs} ${b.unit} (${b.measuredBy}).`),
              ];
              setHistoryLines((h) => [...h, ...lines]);
            } catch {
              setHistoryLines((h) => [...h, "*ERROR* report.budgets: the query failed."]);
            }
            break;
          }
          case "report.automation": {
            // CAD-PARITY-017 (Issue #116): AUTOCAPS/AUTOLIST/AUTOEVENTS — the
            // host renders the REAL automation query results (the capability
            // discovery + the inventory; the scoped event feed when the
            // action carries a principalId).
            try {
              const principalId = (action.payload as { principalId?: unknown } | undefined)?.principalId;
              const [capsRes, principalsRes, scriptsRes, runsRes, extRes] = await Promise.all([
                automationCapabilities(),
                automationPrincipals(),
                automationScripts(),
                automationRuns(),
                automationExtensions(),
              ]);
              const caps = unwrapAutomationCapabilities(capsRes);
              const principalRows = unwrapAutomationPrincipals(principalsRes);
              const scriptRows = unwrapAutomationScripts(scriptsRes);
              const runRows = unwrapAutomationRuns(runsRes);
              const extRows = unwrapAutomationExtensions(extRes);
              if (caps === null || principalRows === null || scriptRows === null || runRows === null || extRows === null) {
                const failed = [capsRes, principalsRes, scriptsRes, runsRes, extRes].find((r) => !r.ok) ?? capsRes;
                setHistoryLines((h) => [
                  ...h,
                  `*ERROR* report.automation: ${failed.ok ? "unexpected response shape" : `${failed.code} — ${failed.message}`}`,
                ]);
                break;
              }
              const mutating = caps.capabilities.filter((c) => c.mutating).length;
              const lines = [
                `AUTOMATION: api v${caps.apiVersion} profile ${caps.profile.profileId} — ${caps.capabilities.length} capabilities (${mutating} mutating), bound to doc v${caps.documentVersion} sha ${caps.contentHash.slice(0, 12)}….`,
                `AUTOMATION: ${principalRows.length} principal(s), ${scriptRows.length} script(s), ${runRows.length} run(s), ${extRows.length} extension(s).`,
              ];
              for (const p of principalRows) {
                lines.push(`AUTOMATION: principal ${p.principalId} ${p.role} registered t=${p.registeredAt}${p.lastRunAt !== null ? `, last run t=${p.lastRunAt}` : ""}.`);
              }
              for (const s of scriptRows) {
                lines.push(
                  `AUTOMATION: script ${s.id} '${s.name}' by ${s.principalId}${s.extensionId !== null ? ` (ext ${s.extensionId})` : ""} — ${s.stepCount} step(s): ${s.stepSummary.join(" -> ")}.`,
                );
              }
              for (const r of runRows.slice(-5)) {
                lines.push(
                  `AUTOMATION: run ${r.id} '${r.scriptName}' by ${r.principalId} ${r.status} v${r.startVersion}->v${r.endVersion} digest ${r.outcomeDigest.slice(0, 12)}… (reproducible).`,
                );
              }
              for (const x of extRows) {
                lines.push(
                  `AUTOMATION: extension ${x.extensionId} '${x.name}' v${x.version} — ${x.capabilities.length} declared capabilit${x.capabilities.length === 1 ? "y" : "ies"}, ${x.scriptIds.length} script(s), by ${x.registeredBy}.`,
                );
              }
              if (typeof principalId === "string" && principalId.length > 0) {
                const evRes = await automationEvents(principalId);
                const feed = unwrapAutomationEvents(evRes);
                if (feed === null) {
                  lines.push(
                    `*ERROR* report.automation: events for '${principalId}' — ${evRes.ok ? "unexpected response shape" : `${evRes.code} — ${evRes.message}`}`,
                  );
                } else {
                  lines.push(
                    `AUTOMATION: events for '${principalId}' — ${feed.subscriptions} subscription(s), ${feed.events.length} delivered (bounded, authoritative:false, clock t=${feed.clock}).`,
                  );
                  for (const e of feed.events.slice(-5)) {
                    lines.push(
                      `AUTOMATION: event t=${e.clock} ${e.scope} ${e.kind} — ${e.revisionBinding.recordKind}:${e.revisionBinding.recordId} — ${e.detail}`,
                    );
                  }
                }
              }
              setHistoryLines((h) => [...h, ...lines]);
            } catch {
              setHistoryLines((h) => [...h, "*ERROR* report.automation: the query failed."]);
            }
            break;
          }
          case "report.toolsets": {
            // CAD-PARITY-018 (Issue #118): TOOLSETREPORT/MEPREPORT/
            // RASTERSTATUS/RASTERTRACE — the host renders the REAL
            // specialized-toolsets query results (the capability discovery +
            // the specialized-record inventory by default; the report-specific
            // surface when the action payload carries a report kind).
            try {
              const payload = (action.payload as { report?: unknown; clearanceMm?: unknown; referenceId?: unknown } | undefined) ?? {};
              const report = payload.report;
              const lines: string[] = [];
              if (report === "mep-clash") {
                const clearanceMm = typeof payload.clearanceMm === "number" ? payload.clearanceMm : undefined;
                const res = await toolsetMepClashReport(clearanceMm);
                const view = unwrapMepClashReport(res);
                if (view === null) {
                  lines.push(`*ERROR* report.toolsets: ${res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`}`);
                } else {
                  lines.push(`TOOLSETS: MEP clash report — ${view.runCount} run(s) at ${view.clearanceMm}mm clearance, ${view.diagnostics.length} diagnostic(s).`);
                  for (const d of view.diagnostics) {
                    lines.push(`TOOLSETS: clash ${d.runId} seg ${d.segmentIndex} vs ${d.elementId} — ${d.kindOfClash} at ${d.distanceMm.toFixed(1)}mm (required ${d.clearanceMm}mm).`);
                  }
                }
              } else if (report === "raster-status") {
                const res = await toolsetRasterStatus();
                const view = unwrapRasterStatus(res);
                if (view === null) {
                  lines.push(`*ERROR* report.toolsets: ${res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`}`);
                } else {
                  lines.push(`TOOLSETS: raster status — ${view.referenceCount} reference(s).`);
                  for (const s of view.statuses) {
                    lines.push(`TOOLSETS: reference ${s.referenceId} '${s.sourceRef}' ${s.status} — ${s.reason}`);
                  }
                }
              } else if (report === "raster-trace") {
                const referenceId = typeof payload.referenceId === "string" ? payload.referenceId : "";
                const res = await toolsetRasterTrace(referenceId);
                const view = unwrapRasterTrace(res);
                if (view === null) {
                  lines.push(`*ERROR* report.toolsets: ${res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`}`);
                } else {
                  lines.push(`TOOLSETS: trace of ${view.referenceId} ('${view.sourceRef}') — ${view.vectors.length} vector(s), authoritative:${String(view.authoritative)} — ${view.notice}`);
                  for (const [i, v] of view.vectors.slice(0, 5).entries()) {
                    lines.push(`TOOLSETS: vector ${i}: (${v.from.x.toFixed(1)}, ${v.from.y.toFixed(1)}) -> (${v.to.x.toFixed(1)}, ${v.to.y.toFixed(1)}).`);
                  }
                }
              } else {
                const [capsRes, recordsRes] = await Promise.all([toolsetCapabilities(), toolsetListRecords()]);
                const caps = unwrapToolsetCapabilities(capsRes);
                const records = unwrapToolsetListRecords(recordsRes);
                if (caps === null || records === null) {
                  const failed = !capsRes.ok ? capsRes : recordsRes;
                  lines.push(`*ERROR* report.toolsets: ${failed.ok ? "unexpected response shape" : `${failed.code} — ${failed.message}`}`);
                } else {
                  const commands = caps.capabilities.filter((c) => c.kind === "command").length;
                  lines.push(`TOOLSETS: api v${caps.apiVersion} — ${caps.capabilities.length} capabilities (${commands} commands, ${caps.capabilities.length - commands} queries), bound to doc v${caps.documentVersion} sha ${caps.contentHash.slice(0, 12)}….`);
                  lines.push(`TOOLSETS: ${records.count} specialized record(s).`);
                  for (const r of records.records) {
                    lines.push(`TOOLSETS: record ${r.id} ${r.toolset} ${r.kind}.`);
                  }
                }
              }
              setHistoryLines((h) => [...h, ...lines]);
            } catch {
              setHistoryLines((h) => [...h, "*ERROR* report.toolsets: the query failed."]);
            }
            break;
          }
          case "report.parametrics": {
            // COMPAT-CAD-004 (Issue #121): PARAMETRICS/PAR — the host
            // renders the REAL parametrics query results (the capability
            // discovery + the consolidated associative report).
            try {
              const [capsRes, reportRes] = await Promise.all([parametricsCapabilities(), assocReport()]);
              const caps = unwrapParametricsCapabilities(capsRes);
              const report = unwrapAssocReport(reportRes);
              const lines: string[] = [];
              if (caps === null || report === null) {
                const failed = !capsRes.ok ? capsRes : reportRes;
                lines.push(`*ERROR* report.parametrics: ${failed.ok ? "unexpected response shape" : `${failed.code} — ${failed.message}`}`);
              } else {
                const commands = caps.capabilities.filter((c) => c.kind === "command").length;
                const added = caps.capabilities.filter((c) => c.origin === "compat-cad-004").length;
                lines.push(`PARAMETRICS: api v${caps.apiVersion} — ${caps.capabilities.length} capabilities (${commands} commands, ${caps.capabilities.length - commands} queries; ${added} added by COMPAT-CAD-004), bound to doc v${caps.documentVersion} sha ${caps.contentHash.slice(0, 12)}….`);
                lines.push(`PARAMETRICS: associative report — ${report.counts.total} row(s), ${report.counts.ok} ok, ${report.counts.notOk} not ok, digest ${report.reportSha256.slice(0, 12)}….`);
                for (const row of report.rows) {
                  lines.push(`PARAMETRICS: ${row.kind} ${row.id} ${row.outcome}${row.code !== undefined ? ` (${row.code})` : ""} — ${row.reason}`);
                }
              }
              setHistoryLines((h) => [...h, ...lines]);
            } catch {
              setHistoryLines((h) => [...h, "*ERROR* report.parametrics: the query failed."]);
            }
            break;
          }
          case "toggle.lweight": {
            // CAD-PARITY-004: LWEIGHT — the lineweight display toggle
            // (persisted drafting setting; identical on both hosts).
            const enabled = !(snapshot?.draftingSettings?.lineweightDisplay ?? false);
            const res = await send({ type: "command", name: "drafting.setSettings" as Command["name"], payload: { settings: { lineweightDisplay: enabled } } });
            if (!res.ok) setError(`[drafting.setSettings] ${res.code}: ${res.message}`);
            break;
          }
          case "toggle.ortho":
            setAids((a) => ({ ...a, ortho: !a.ortho }));
            break;
          case "toggle.polar":
            setAids((a) => ({ ...a, polar: !a.polar }));
            break;
          case "toggle.otrack":
            setAids((a) => ({ ...a, otrack: !a.otrack }));
            break;
          case "toggle.osnap":
            setHistoryLines((h) => [...h, "OSNAP modes are configured in the layers palette settings."]);
            break;
          case "toggle.grid":
          case "toggle.snap": {
            const key = action.action === "toggle.grid" ? "grid" : "snap";
            const settings = snapshot?.draftingSettings;
            const enabled = key === "grid" ? !(settings?.grid.enabled ?? true) : !(settings?.snap.enabled ?? true);
            const res = await send({ type: "command", name: "drafting.setSettings" as Command["name"], payload: { settings: { [key]: { enabled } } } });
            if (!res.ok) setError(`[drafting.setSettings] ${res.code}: ${res.message}`);
            break;
          }
          case "view.zoomExtents":
            navigate({ kind: "zoomExtents" });
            break;
          // COMPAT-CAD-006 (Issue #138): the navigation vocabulary — the
          // ZOOM/PAN/REGEN builders emit these ui actions; the canvas owns
          // the view state and the shared module owns the math.
          case "view.zoomWindow": {
            const payload = (action.payload as { corner1?: [number, number]; corner2?: [number, number] } | undefined) ?? undefined;
            if (
              payload !== undefined && Array.isArray(payload.corner1) && Array.isArray(payload.corner2) &&
              payload.corner1.length === 2 && payload.corner2.length === 2
            ) {
              navigate({ kind: "zoomWindow", corner1: [payload.corner1[0]!, payload.corner1[1]!], corner2: [payload.corner2[0]!, payload.corner2[1]!] });
            }
            break;
          }
          case "view.zoomScale": {
            const payload = (action.payload as { factor?: number; relative?: boolean } | undefined) ?? undefined;
            if (payload !== undefined && typeof payload.factor === "number" && Number.isFinite(payload.factor)) {
              navigate({ kind: "zoomScale", factor: payload.factor, relative: payload.relative === true });
            }
            break;
          }
          case "view.pan": {
            const payload = (action.payload as { delta?: [number, number] } | undefined) ?? undefined;
            if (payload !== undefined && Array.isArray(payload.delta) && payload.delta.length === 2) {
              navigate({ kind: "pan", delta: [payload.delta[0]!, payload.delta[1]!] });
            }
            break;
          }
          case "view.zoomPrevious":
            navigate({ kind: "zoomPrevious" });
            break;
          case "view.regen":
            navigate({ kind: "regen" });
            break;
          // CAD-PARITY-008: the paper-space context switches + the plot
          // preview surface (host-local view state, LOCK-015).
          case "space.model":
            setView("model");
            break;
          case "space.paper":
            setView("layout");
            break;
          // CAD-PARITY-009 (Issue #90): the 3D Model view switch (host-local
          // view state, LOCK-015 — the UCS/VPOINT/ZOOM3D/3DSTATE commands hint it).
          case "view.model3d":
            setView("model3d");
            break;
          case "plot.preview":
            setPlotPreviewOpen(true);
            break;
          case "plot.download":
            // The download already happened inline with the plot.export /
            // plot.publish response (see the appApi loop above).
            break;
          case "selection.clear":
            await setDocumentSelection([]);
            setSel([]);
            break;
          case "selection.selectAll": {
            // COMPAT-CAD-005: SELECTALL computes from the AUTHORITATIVE
            // document state (a fresh document.getState — not the possibly
            // stale closure snapshot), adopts that state, and adopts the
            // server's effective (live-pruned) selection — the CAD-BENCH-
            // RW-001 DEF-014 phantom counts came from stale client ids: the
            // status bar counted entities that neither render nor pick.
            const stateRes = await getState();
            if (!stateRes.ok) {
              setError(`[getState] ${stateRes.code}: ${stateRes.message}`);
              failed = true;
              break;
            }
            const fresh = stateRes.value as CADDocumentSnapshot;
            setSnapshot(fresh);
            const visible = new Set((fresh.layers ?? []).filter((l) => l.visible).map((l) => l.id));
            const ids = (fresh.elements ?? [])
              .filter((el) => {
                const props = el.props as Record<string, unknown>;
                if (el.kind === "bim") return props.type === "bim.wall" || props.type === "bim.slab";
                return typeof props.layer === "string" && visible.has(props.layer);
              })
              .map((el) => el.id);
            const selRes = await setDocumentSelection(ids);
            adoptSelection(selRes.ok ? selRes.value : null, ids);
            break;
          }
          case "file.new":
            if (!(await executeFileNew())) failed = true;
            break;
          case "file.save":
            if (!(await executeFileSave())) failed = true;
            break;
          default:
            break;
        }
      }
      await refresh();
      // COMPAT-CAD-005: the deferred outcome echoes print ONLY after every
      // plan entry (App API + ui actions) committed — the commit-authoritative
      // feedback channel (DEF-027).
      if (!failed && deferredEcho.length > 0) {
        setHistoryLines((h) => [...h, ...deferredEcho]);
      }
      return !failed;
    },
    [snapshot, refresh, adoptSnapshot, adoptSelection, executeFileNew, executeFileSave],
  );

  // --- file actions (existing CAD-IMPLEMENT-001 workflows preserved) ----------------

  const onFileOpen = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file === undefined) return;
      setBusy(true);
      try {
        const text = await file.text();
        const res = await openFromText(text);
        if (!res.ok) setError(`[Open] ${res.code}: ${res.message}`);
        else {
          // COMPAT-CAD-005: OPEN is the same full editor reset class as NEW —
          // the opened document IS the response value; adopt it (plus the
          // reset of selection/story/viewport state) synchronously.
          const snap = res.value as CADDocumentSnapshot;
          if (typeof snap?.version?.version_number === "number") {
            setSnapshot(snap);
            setSel([]);
            setActiveStoryId(null);
            setSelectedViewportId(null);
            setViewResetSignal((n) => n + 1);
          }
          setHistoryLines((h) => [...h, `OPEN: ${file.name}.`]);
        }
        await refresh();
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = "";
        setBusy(false);
      }
    },
    [refresh],
  );

  // --- engine dispatch -------------------------------------------------------------

  const dispatchEngine = React.useCallback(
    (event: Parameters<typeof applyPromptEvent>[1]) => {
      const result = applyPromptEvent(engineState, event, engineCtx());
      setEngineState(result.state);
      // COMPAT-CAD-005: interactive echoes (input acknowledgments) render
      // immediately; the plan's OUTCOME claims are deferred until every plan
      // entry commits in executePlan — no success echo before the canonical
      // transaction (CAD-BENCH-RW-001 DEF-027).
      const { interactive, deferred } = splitEchoTiming(result.output.lines, result.output.plan);
      if (interactive.length > 0) {
        setHistoryLines((h) => [...h, ...interactive]);
      }
      if (result.output.plan !== null) void executePlan(result.output.plan, deferred);
    },
    [engineState, engineCtx, executePlan],
  );

  const startCommand = React.useCallback(
    (commandId: string) => {
      dispatchEngine({ type: "start", commandId });
    },
    [dispatchEngine],
  );

  // CAD-PARITY-006: start a command with a PRE-TYPED first text answer (the
  // Blocks palette's Insert button starts INSERT with the definition name —
  // the dynamic attribute prompts then appear). The typed event composes over
  // the STARTED engine state (two synchronous dispatchEngine calls would both
  // read the stale pre-start state), so both events apply through the shared
  // prompt engine and commit once.
  const startCommandWithText = React.useCallback(
    (commandId: string, text: string) => {
      const started = applyPromptEvent(engineState, { type: "start", commandId }, engineCtx());
      const typed = applyPromptEvent(started.state, { type: "typed", text }, engineCtx());
      setEngineState(typed.state);
      // COMPAT-CAD-005: same echo-timing split as dispatchEngine (see there).
      const a = splitEchoTiming(started.output.lines, started.output.plan);
      const b = splitEchoTiming(typed.output.lines, typed.output.plan);
      const interactive = [...a.interactive, ...b.interactive];
      if (interactive.length > 0) {
        setHistoryLines((h) => [...h, ...interactive]);
      }
      if (started.output.plan !== null) void executePlan(started.output.plan, a.deferred);
      if (typed.output.plan !== null) void executePlan(typed.output.plan, b.deferred);
    },
    [engineState, engineCtx, executePlan],
  );

  // --- selection -----------------------------------------------------------------

  const onSelectionChange = React.useCallback(
    async (ids: readonly string[]) => {
      setSel([...ids]);
      // COMPAT-CAD-005: adopt the server's effective (live-pruned) selection
      // — the same canonical state every read site observes (DEF-008).
      const res = await setDocumentSelection([...ids]);
      if (res.ok) adoptSelection(res.value, ids);
    },
    [adoptSelection],
  );

  // --- keyboard (keymap.ts drives both hosts) --------------------------------------

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const action = mapKeyEvent(
        { key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey },
        inInput ? "commandLine" : "canvas",
      );
      if (action === null) return;
      e.preventDefault();
      switch (action.type) {
        case "command":
          startCommand(action.commandId);
          break;
        case "toggle":
          if (action.aid === "ortho" || action.aid === "polar" || action.aid === "otrack") {
            setAids((a) => ({ ...a, [action.aid]: !a[action.aid] }));
          } else if (action.aid === "grid" || action.aid === "snap") {
            const settings = snapshot?.draftingSettings;
            const enabled = action.aid === "grid" ? !(settings?.grid.enabled ?? true) : !(settings?.snap.enabled ?? true);
            void send({ type: "command", name: "drafting.setSettings" as Command["name"], payload: { settings: { [action.aid]: { enabled } } } }).then(refresh);
          } else {
            setHistoryLines((h) => [...h, "OSNAP modes are configured in the layers palette settings."]);
          }
          break;
        case "palette":
          if (action.palette === "search") setPaletteOpen(true);
          else if (action.palette === "help") setHelpOpen(true);
          else {
            setDockVisible(true);
            setDockTab(action.palette === "layers" ? "layers" : action.palette === "navigator" ? "navigator" : "properties");
          }
          break;
        case "cancel":
          if (engineState.commandId !== null) dispatchEngine({ type: "cancel" });
          else void onSelectionChange([]);
          break;
        case "enter":
          dispatchEngine({ type: "enter" });
          break;
        case "zoomExtents":
          navigate({ kind: "zoomExtents" });
          break;
        case "selectionAll":
          void executePlan({ appApi: [], ui: [{ action: "selection.selectAll" }], echo: [] });
          break;
        case "fileSave":
          void executeFileSave();
          break;
        case "fileNew":
          void executeFileNew();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startCommand, dispatchEngine, engineState.commandId, snapshot, refresh, onSelectionChange, executePlan, executeFileSave, executeFileNew]);

  // --- presets -----------------------------------------------------------------------

  const applyPreset = React.useCallback((next: WorkspacePreset) => {
    setPreset(next);
    if (next === "drafting") {
      setView("model");
      setDockTab("properties");
      setDockVisible(true);
    } else if (next === "bim") {
      setView("bim3d");
      setDockTab("navigator");
      setDockVisible(true);
    } else if (next === "documentation") {
      setView("docs");
      setDockTab("navigator");
      setDockVisible(true);
    } else {
      setView("model");
      setDockVisible(false);
    }
  }, []);

  // --- history/impact surfaces (CAD-IMPLEMENT-003 + RESEARCH-CAD-007 preserved) --------

  const loadHistory = React.useCallback(async () => {
    const [historyRes, eventsRes] = await Promise.all([getHistory(), getGraphEvents()]);
    const history = unwrapHistory(historyRes);
    const events = unwrapGraphEvents(eventsRes);
    setHistoryData({
      revisions: history?.revisions.length ?? 0,
      graphEvents: events?.events.length ?? 0,
      replayNote: null,
    });
  }, []);

  const onReplay = React.useCallback(async (revision: number) => {
    const res = await replayModel(revision);
    const replay = unwrapReplay(res);
    if (replay !== null) {
      setHistoryData((d) => ({ ...d, replayNote: `Replayed to revision ${replay.revision_number} — ${replay.elements.length} elements, hash ${replay.content_hash.slice(0, 10)}…${replay.verified ? " (verified)" : ""}.` }));
    }
  }, []);

  const onImpact = React.useCallback(async () => {
    const res = await getImpactCascade();
    const impact = unwrapImpactCascade(res);
    if (impact !== null) {
      setHistoryData((d) => ({ ...d, replayNote: `Impact cascade: ${impact.quantities.deltas.length} quantity deltas; estimate total ${impact.estimate.current?.total ?? 0} ${impact.estimate.current?.currency ?? ""}.` }));
    }
  }, []);

  // --- palette / help run ---------------------------------------------------------------

  const onPaletteRun = React.useCallback(
    (command: WorkspaceCommand) => {
      if (command.id === "help") setHelpOpen(true);
      else startCommand(command.id);
    },
    [startCommand],
  );

  // --- derived ---------------------------------------------------------------------------

  const version: VersionMeta | null = snapshot?.version ?? null;
  const activeStoryName = React.useMemo(() => {
    const story = (snapshot?.elements ?? []).find((el) => el.id === activeStoryId);
    const name = story !== undefined ? (story.props as Record<string, unknown>).name : undefined;
    return typeof name === "string" ? name : null;
  }, [snapshot, activeStoryId]);

  const compact = preset === "compact";
  const currentCommandName = engineState.commandId !== null ? (commandById(engineState.commandId)?.name ?? null) : null;

  // --- render ------------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col bg-background p-6" aria-busy="true">
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="mb-2 h-10 w-full" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }

  return (
    <div className="flex h-screen min-h-screen flex-col overflow-hidden bg-background text-foreground" data-testid="workspace-shell">
      <input ref={fileInputRef} type="file" accept=".json" className="hidden" aria-hidden onChange={onFileOpen} data-testid="file-input" />

      <MenuBar
        onCommand={startCommand}
        onAction={(action) => {
          if (action === "file.new") void executeFileNew();
          else if (action === "file.save") void executeFileSave();
          else if (action === "file.open") fileInputRef.current?.click();
        }}
        onSwitchView={setView}
        onPreset={applyPreset}
        preset={preset}
        onSearch={() => setPaletteOpen(true)}
        onShowPalette={(palette) => {
          // CAD-PARITY-013 (Issue #104): the Documentation panel… menu item —
          // the palette.show ui-action channel surfaced for the menu.
          setDockTab(palette);
          setDockVisible(true);
        }}
      />
      <Ribbon activeCommand={engineState.commandId} onCommand={startCommand} view={view} onSwitchView={setView} compact={compact} />

      {error !== null && (
        <div role="alert" className="flex items-start gap-2 border-b border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="flex-1">{error}</span>
          <button type="button" className="underline" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <ToolPalette activeCommand={engineState.commandId} onCommand={startCommand} visible={!compact} />

        <main className="flex min-w-0 flex-1 flex-col" aria-label="workspace content">
          {/* Document/view tabs — the fixed views + ONE tab per paper-space
              layout (CAD-PARITY-008: layout tabs are DISTINCT from the Model
              tab; clicking one activates the layout through layout.activate). */}
          <div className="flex items-center gap-0.5 border-b bg-muted/30 px-2 pt-1" role="tablist" aria-label="document and view tabs">
            {VIEW_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={view === tab.id}
                className={
                  "rounded-t border border-b-0 px-3 py-1 text-xs font-medium " +
                  (view === tab.id ? "bg-background text-foreground" : "bg-transparent text-muted-foreground hover:bg-background/60")
                }
                onClick={() => setView(tab.id)}
              >
                {tab.label}
              </button>
            ))}
            {(snapshot?.layouts ?? []).length > 0 && <div className="mx-1 h-4 w-px self-center bg-border" aria-hidden />}
            {(snapshot?.layouts ?? []).map((layout) => {
              const isActiveLayout = (snapshot?.draftingSettings?.activeLayout ?? snapshot?.layouts?.[0]?.id) === layout.id;
              return (
                <button
                  key={layout.id}
                  type="button"
                  role="tab"
                  aria-selected={view === "layout" && isActiveLayout}
                  data-testid={"layout-tab-" + layout.id}
                  className={
                    "rounded-t border border-b-0 px-3 py-1 text-xs font-medium " +
                    (view === "layout" && isActiveLayout
                      ? "bg-background text-foreground"
                      : "bg-transparent text-muted-foreground hover:bg-background/60")
                  }
                  onClick={() => {
                    setSelectedViewportId(null);
                    void (async () => {
                      const res = await send({ type: "command", name: "layout.activate" as Command["name"], payload: { name: layout.name } });
                      if (!res.ok) setError(`[layout.activate] ${res.code}: ${res.message}`);
                      setView("layout");
                    })();
                  }}
                  title={`Activate the '${layout.name}' layout (${layout.pageSetup.paperSize} ${layout.pageSetup.orientation})`}
                >
                  {layout.name}
                </button>
              );
            })}
            <div className="ml-auto flex items-center gap-1 pb-1">
              {currentCommandName !== null && (
                <Badge variant="default" className="font-mono text-[10px]" data-testid="active-command">
                  {currentCommandName}
                </Badge>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => {
                  setShowHistory((s) => !s);
                  if (!showHistory) void loadHistory();
                }}
                aria-pressed={showHistory}
                title="Model revisions, graph events, replay and impact"
              >
                <History className="h-3.5 w-3.5" aria-hidden /> Revisions
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-7 p-0"
                aria-label={dockVisible ? "hide palettes" : "show palettes"}
                title={dockVisible ? "Hide palettes" : "Show palettes"}
                onClick={() => setDockVisible((d) => !d)}
              >
                {dockVisible ? <PanelRightClose className="h-4 w-4" aria-hidden /> : <PanelRightOpen className="h-4 w-4" aria-hidden />}
              </Button>
            </div>
          </div>

          {showHistory && (
            <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="history-panel">
              <GitBranch className="h-3.5 w-3.5" aria-hidden />
              <span>{historyData.revisions} revisions</span>
              <span>·</span>
              <span>{historyData.graphEvents} graph events</span>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => void onReplay(0)}>
                Replay to base
              </Button>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => void onReplay(Math.max(0, historyData.revisions))}>
                Replay to latest
              </Button>
              <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={() => void onImpact()}>
                <Workflow className="h-3 w-3" aria-hidden /> Impact cascade
              </Button>
              {historyData.replayNote !== null && <span className="font-mono">{historyData.replayNote}</span>}
            </div>
          )}

          {/* The view content */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {view === "model" && (
              <ModelCanvas
                snapshot={snapshot}
                selection={liveSelection}
                aids={aids}
                engineState={engineState}
                busy={busy}
                onCursor={(world) => setCursor(world)}
                onPickPoint={(world) => dispatchEngine({ type: "pick", point: world })}
                onPickEntity={(pick) => dispatchEngine({ type: "entity", entity: pick })}
                onPickEntities={(picks) => dispatchEngine({ type: "entities", entities: picks })}
                onPickEntityPoint={(pick, worldPoint) => dispatchEngine({ type: "entityPoint", entity: pick, point: [worldPoint[0], worldPoint[1]] })}
                onPickMiss={(world) => {
                  // COMPAT-CAD-005: a pick MISS is visible feedback (AutoCAD's
                  // "0 found"), never a silent drop — the benchmark's DEF-006
                  // repro depended on clicks vanishing without a trace.
                  setHistoryLines((h) => [
                    ...h,
                    `0 found — nothing within the ${PICKBOX_SCREEN_PX} px pickbox at (${world[0].toFixed(0)}, ${world[1].toFixed(0)}).`,
                  ]);
                }}
                onSelectionChange={onSelectionChange}
                onGripEdit={(result: GripEditResult) => {
                  setHistoryLines((h) => [...h, ...result.echo]);
                  void executePlan({ appApi: result.appApi, ui: [], echo: [] });
                }}
                onCommandStart={startCommand}
                navigation={navigation}
                onViewFeedback={(line) => setHistoryLines((h) => [...h, line])}
                viewResetSignal={viewResetSignal}
                onContextAction={(action, payload) => {
                  // CAD-PARITY-004: the canvas context-menu actions (layer
                  // toggles/isolation/managers — one App API command each).
                  void (async () => {
                    setBusy(true);
                    try {
                      if (action === "layer.toggleVisible" || action === "layer.toggleFrozen" || action === "layer.toggleLocked") {
                        const layerId = payload as string;
                        const layer = (snapshot?.layers ?? []).find((l) => l.id === layerId);
                        if (layer !== undefined) {
                          const patch: Record<string, unknown> =
                            action === "layer.toggleVisible"
                              ? { visible: !layer.visible }
                              : action === "layer.toggleFrozen"
                                ? { frozen: layer.frozen !== true }
                                : { locked: layer.locked !== true };
                          const res = await send({ type: "command", name: "drafting.updateLayer" as Command["name"], payload: { layerId, patch } });
                          if (!res.ok) setError(`[drafting.updateLayer] ${res.code}: ${res.message}`);
                        }
                      } else if (action === "layer.isolate") {
                        const res = await send({ type: "command", name: "layer.isolate" as Command["name"], payload: { layerIds: [payload as string] } });
                        if (!res.ok) setError(`[layer.isolate] ${res.code}: ${res.message}`);
                        else setHistoryLines((h) => [...h, "LAYISO: 1 layer isolated. LAYUNISO restores."]);
                      } else if (action === "layer.setActive") {
                        const res = await send({ type: "command", name: "layer.setActive" as Command["name"], payload: { layerId: payload as string } });
                        if (!res.ok) setError(`[layer.setActive] ${res.code}: ${res.message}`);
                      } else if (action === "layer.allOn") {
                        const edits = (snapshot?.layers ?? []).map((l) => ({ type: "updateLayer" as const, layerId: l.id, patch: { visible: true } }));
                        if (edits.length > 0) {
                          const res = await send({ type: "command", name: "document.applyEdit" as Command["name"], payload: { edit: { type: "applyEdits", edits } } });
                          if (!res.ok) setError(`[LAYON] ${res.code}: ${res.message}`);
                          else setHistoryLines((h) => [...h, `LAYON: ${edits.length} layer(s) turned on.`]);
                        }
                      } else if (action === "layer.unisolate") {
                        const res = await send({ type: "command", name: "layer.unisolate" as Command["name"], payload: {} });
                        if (!res.ok) setError(`[LAYUNISO] ${res.code}: ${res.message}`);
                        else setHistoryLines((h) => [...h, "LAYUNISO: layer table restored."]);
                      } else if (action === "palette.layers") {
                        setDockTab("layers");
                        setDockVisible(true);
                      } else if (action === "palette.properties") {
                        setDockTab("properties");
                        setDockVisible(true);
                      }
                    } finally {
                      await refresh();
                      setBusy(false);
                    }
                  })();
                }}
              />
            )}
            {view === "bim3d" && <BimWorkbench />}
            {view === "model3d" && (
              <Model3DViewport snapshot={snapshot} selection={selection} onRefresh={refresh} />
            )}
            {view === "docs" && <DocsWorkbench />}
            {view === "ifc" && <IfcWorkbench />}
            {view === "components" && <ComponentsWorkbench />}
            {view === "schedules" && <SchedulesWorkbench />}
            {view === "collab" && <CollabWorkbench />}
            {view === "automation" && <AutomationWorkbench />}
            {/* CAD-PARITY-018 (Issue #118): the specialized-toolsets
                workbench (the architecture/MEP/mechanical/raster workflows
                over the governed App API). */}
            {view === "toolsets" && <ToolsetsWorkbench />}
            {/* COMPAT-CAD-004 (Issue #121): the Parametrics workbench (the
                consolidated parametrics/associative/patterns workflows
                over the governed App API). */}
            {view === "parametrics" && <ParametricsWorkbench />}
            {/* CAD-PARITY-019 (Issue #122): the certification surface — the
                version-pinned corpus catalog + the live interop
                classification probes over the governed App API. */}
            {view === "certification" && <CertificationWorkbench />}
            {view === "layout" && (
              <LayoutCanvas
                snapshot={snapshot}
                engineState={engineState}
                busy={busy}
                selectedViewportId={selectedViewportId}
                onSelectedViewport={setSelectedViewportId}
                onCursor={(paper) => setCursor(paper)}
                onPickPoint={(paper) => dispatchEngine({ type: "pick", point: paper })}
                onViewportUpdate={(id, patch) => {
                  void (async () => {
                    setBusy(true);
                    try {
                      const res = await send({ type: "command", name: "viewport.update" as Command["name"], payload: { id, patch } });
                      if (!res.ok) {
                        setHistoryLines((h) => [...h, `*ERROR* viewport.update: ${res.code} — ${res.message}`]);
                        setError(`[viewport.update] ${res.code}: ${res.message}`);
                      } else {
                        setHistoryLines((h) => [...h, `Viewport ${id} frame updated.`]);
                      }
                    } finally {
                      await refresh();
                      setBusy(false);
                    }
                  })();
                }}
                onCommandStart={startCommand}
              />
            )}
          </div>

          <CommandLine
            history={historyLines}
            prompt={describePrompt(engineState).prompt}
            commandName={describePrompt(engineState).commandName}
            onSubmit={(text) => {
              if (text.length === 0) dispatchEngine({ type: "enter" });
              else dispatchEngine({ type: "typed", text, cursor });
            }}
            onCancel={() => dispatchEngine({ type: "cancel" })}
          />
          <StatusBar
            cursor={cursor}
            aids={aids}
            gridEnabled={snapshot?.draftingSettings?.grid.enabled ?? true}
            snapEnabled={snapshot?.draftingSettings?.snap.enabled ?? true}
            units={snapshot?.draftingSettings?.units ?? "mm"}
            activeLayer={activeLayerName}
            lineweightDisplay={snapshot?.draftingSettings?.lineweightDisplay ?? false}
            spaceLabel={
              (snapshot?.layouts ?? []).length > 0
                ? (snapshot?.draftingSettings?.space ?? "model") === "model"
                  ? "Model"
                  : `Paper · ${(snapshot?.layouts ?? []).find((l) => l.id === (snapshot?.draftingSettings?.activeLayout ?? snapshot?.layouts?.[0]?.id))?.name ?? "—"}`
                : null
            }
            onActiveLayerClick={() => {
              setDockTab("layers");
              setDockVisible(true);
            }}
            activeStoryName={activeStoryName}
            selectionCount={liveSelection.length}
            version={version?.version_number ?? 0}
            onToggle={(aid) => {
              if (aid === "ortho" || aid === "polar" || aid === "otrack") {
                setAids((a) => ({ ...a, [aid]: !a[aid] }));
                return;
              }
              if (aid === "grid" || aid === "snap") {
                const settings = snapshot?.draftingSettings;
                const enabled = aid === "grid" ? !(settings?.grid.enabled ?? true) : !(settings?.snap.enabled ?? true);
                void send({ type: "command", name: "drafting.setSettings" as Command["name"], payload: { settings: { [aid]: { enabled } } } }).then(refresh);
                return;
              }
              if (aid === "lweight") {
                void send({ type: "command", name: "drafting.setSettings" as Command["name"], payload: { settings: { lineweightDisplay: !(snapshot?.draftingSettings?.lineweightDisplay ?? false) } } }).then(refresh);
                return;
              }
              setHistoryLines((h) => [...h, "OSNAP modes are configured in the layers palette settings."]);
            }}
          />
        </main>

        <RightDock
          snapshot={snapshot}
          selection={liveSelection}
          activeTab={dockTab}
          onTab={setDockTab}
          activeLayer={activeLayer}
          onActiveLayer={onActiveLayer}
          activeStoryId={activeStoryId}
          onActiveStory={setActiveStoryId}
          onSelection={(ids) => void onSelectionChange(ids)}
          onRunCommand={(commandId, typed) => {
            if (typed === undefined) startCommand(commandId);
            else startCommandWithText(commandId, typed);
          }}
          onCommitEdit={(label, fn) => {
            setBusy(true);
            void (async () => {
              const res = await fn();
              if (!res.ok) setError(`[${label}] ${res.code}: ${res.message}`);
              else {
                // COMPAT-CAD-005: adopt the authoritative post-commit snapshot
                // (the palette editors commit through the App API; the
                // response snapshot is the canonical state).
                adoptSnapshot((res.value as { snapshot?: CADDocumentSnapshot } | null)?.snapshot);
              }
              await refresh();
              setBusy(false);
            })();
          }}
          visible={dockVisible}
        />
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onRun={onPaletteRun} />

      {plotPreviewOpen && (
        <PlotPreview
          snapshot={snapshot}
          onClose={() => setPlotPreviewOpen(false)}
          onEcho={(line) => setHistoryLines((h) => [...h, line])}
        />
      )}

      {helpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" role="dialog" aria-modal="true" aria-label="Help" onClick={() => setHelpOpen(false)}>
          <div className="max-h-[70vh] w-[min(640px,92vw)] overflow-y-auto rounded-lg border bg-background p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-sm font-semibold">Offisos workspace — commands, aliases & shortcuts</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Type any name or alias in the command line. Ctrl+K opens the command search. F-keys toggle the drafting aids.
            </p>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1 pr-2">Command</th>
                  <th className="py-1 pr-2">Aliases</th>
                  <th className="py-1 pr-2">Shortcut</th>
                  <th className="py-1">Description</th>
                </tr>
              </thead>
              <tbody>
                {WORKSPACE_COMMANDS.map(
                  (command: WorkspaceCommand) => (
                    <tr key={command.id} className="border-b border-border/40">
                      <td className="py-1 pr-2 font-mono font-semibold">{command.name}</td>
                      <td className="py-1 pr-2 font-mono text-[10px] text-muted-foreground">{command.aliases.join(", ")}</td>
                      <td className="py-1 pr-2 font-mono text-[10px]">{command.shortcut ?? ""}</td>
                      <td className="py-1 text-muted-foreground">{command.description}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
