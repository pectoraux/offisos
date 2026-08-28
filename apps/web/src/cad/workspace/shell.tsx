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
  createDoc,
  getGraphEvents,
  getHistory,
  getImpactCascade,
  getSelection,
  getState,
  openFromText,
  replayModel,
  save,
  send,
  setSelection as setDocumentSelection,
  unwrapGraphEvents,
  unwrapHistory,
  unwrapImpactCascade,
  unwrapReplay,
  unwrapSaveBytes,
} from "@/cad/client/http-transport";
import { commandById, WORKSPACE_COMMANDS, type WorkspaceCommand } from "@offisos/cad-app-shell/workspace/commands";
import {
  IDLE_PROMPT_STATE,
  applyPromptEvent,
  describePrompt,
  type PromptEngineState,
} from "@offisos/cad-app-shell/workspace/prompt-engine";
import { mapKeyEvent } from "@offisos/cad-app-shell/workspace/keymap";
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
import { CommandLine } from "@/cad/workspace/command-line";
import { StatusBar } from "@/cad/workspace/status-bar";
import { CommandPalette } from "@/cad/workspace/command-palette";
import { BimWorkbench } from "@/cad/bim/workbench";
import { DocsWorkbench } from "@/cad/docs/workbench";
import { IfcWorkbench } from "@/cad/ifc/workbench";
import { ComponentsWorkbench } from "@/cad/components/workbench";

const VIEW_TABS: readonly { id: WorkspaceView; label: string }[] = [
  { id: "model", label: "Model" },
  { id: "bim3d", label: "3D BIM" },
  { id: "docs", label: "Documentation" },
  { id: "ifc", label: "Interoperability" },
  { id: "components", label: "Components" },
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
  const [activeLayer, setActiveLayer] = React.useState("0");
  const [activeStoryId, setActiveStoryId] = React.useState<string | null>(null);
  const [cursor, setCursor] = React.useState<Vec2 | null>(null);
  const [engineState, setEngineState] = React.useState<PromptEngineState>(IDLE_PROMPT_STATE);
  const [historyLines, setHistoryLines] = React.useState<string[]>([]);
  const [zoomExtentsSignal, setZoomExtentsSignal] = React.useState(0);
  const [showHistory, setShowHistory] = React.useState(false);
  const [historyData, setHistoryData] = React.useState<{ revisions: number; graphEvents: number; replayNote: string | null }>({ revisions: 0, graphEvents: 0, replayNote: null });

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // --- data refresh -----------------------------------------------------------

  const refresh = React.useCallback(async () => {
    const [stateRes, selQuery] = await Promise.all([getState(), getSelection()]);
    const snap = stateRes.ok ? (stateRes.value as CADDocumentSnapshot) : null;
    const sel = selQuery.ok ? (selQuery.value as string[]) : [];
    if (snap !== null) {
      setSnapshot(snap);
      setSel(sel);
      if (!(snap.layers ?? []).some((l) => l.id === activeLayer)) {
        setActiveLayer(snap.layers?.[0]?.id ?? "0");
      }
      const story = (snap.elements ?? []).find((el) => el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.story");
      if (activeStoryId === null && story !== undefined) setActiveStoryId(story.id);
      setError(null);
    } else if (!stateRes.ok) {
      setError(`[getState] ${stateRes.code}: ${stateRes.message}`);
    }
  }, [activeLayer, activeStoryId]);

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

  // --- engine context -----------------------------------------------------------

  const engineCtx = React.useCallback((): CommandContext => {
    const elements = snapshot?.elements ?? [];
    const stories = elements.filter((el) => el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.story");
    const currentSelection: EntityPick[] = elements
      .filter((el) => selection.includes(el.id))
      .map((el) => ({ id: el.id, kind: el.kind, props: el.props as Record<string, unknown> }));
    return defaultCommandContext({
      activeLayer,
      activeStoryId: activeStoryId ?? (stories.length > 0 ? (stories[stories.length - 1]!.id) : null),
      elementCount: elements.length,
      storyCount: stories.length,
      currentSelection,
    });
  }, [snapshot, selection, activeLayer, activeStoryId]);

  const executeFileSave = React.useCallback(async () => {
    setBusy(true);
    try {
      const res = await save();
      if (!res.ok) {
        setError(`[Save] ${res.code}: ${res.message}`);
        return;
      }
      const data = unwrapSaveBytes(res);
      if (data === null) return;
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
    } finally {
      setBusy(false);
      await refresh();
    }
  }, [refresh]);

  const executeFileNew = React.useCallback(async () => {
    setBusy(true);
    try {
      const res = await createDoc({});
      if (!res.ok) setError(`[New] ${res.code}: ${res.message}`);
      else setHistoryLines((h) => [...h, "NEW: fresh document created."]);
      setActiveStoryId(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);


  // --- plan execution -------------------------------------------------------------

  const executePlan = React.useCallback(
    async (plan: CommandPlan): Promise<void> => {
      for (const entry of plan.appApi) {
        setBusy(true);
        const res = await send({ type: "command", name: entry.name as Command["name"], payload: entry.payload });
        if (!res.ok) {
          setHistoryLines((h) => [...h, `*ERROR* ${entry.name}: ${res.code} — ${res.message}`]);
          setError(`[${entry.name}] ${res.code}: ${res.message}`);
        } else if (entry.name === "bim.createElements") {
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
            } else if (palette === "workspace") {
              setPreset((p) => (p === "compact" ? "drafting" : "compact"));
            }
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
            setZoomExtentsSignal((n) => n + 1);
            break;
          case "selection.clear":
            await setDocumentSelection([]);
            setSel([]);
            break;
          case "selection.selectAll": {
            const visible = new Set((snapshot?.layers ?? []).filter((l) => l.visible).map((l) => l.id));
            const ids = (snapshot?.elements ?? [])
              .filter((el) => {
                const props = el.props as Record<string, unknown>;
                if (el.kind === "bim") return props.type === "bim.wall" || props.type === "bim.slab";
                return typeof props.layer === "string" && visible.has(props.layer);
              })
              .map((el) => el.id);
            await setDocumentSelection(ids);
            setSel(ids);
            break;
          }
          case "file.new":
            await executeFileNew();
            break;
          case "file.save":
            await executeFileSave();
            break;
          default:
            break;
        }
      }
      await refresh();
    },
    [snapshot, refresh],
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
        else setHistoryLines((h) => [...h, `OPEN: ${file.name}.`]);
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
      if (result.output.lines.length > 0) {
        setHistoryLines((h) => [...h, ...result.output.lines]);
      }
      if (result.output.plan !== null) void executePlan(result.output.plan);
    },
    [engineState, engineCtx, executePlan],
  );

  const startCommand = React.useCallback(
    (commandId: string) => {
      dispatchEngine({ type: "start", commandId });
    },
    [dispatchEngine],
  );

  // --- selection -----------------------------------------------------------------

  const onSelectionChange = React.useCallback(
    async (ids: readonly string[]) => {
      setSel([...ids]);
      await setDocumentSelection([...ids]);
    },
    [],
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
          setZoomExtentsSignal((n) => n + 1);
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
          {/* Document/view tabs */}
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
                selection={selection}
                aids={aids}
                engineState={engineState}
                busy={busy}
                onCursor={(world) => setCursor(world)}
                onPickPoint={(world) => dispatchEngine({ type: "pick", point: world })}
                onPickEntity={(pick) => dispatchEngine({ type: "entity", entity: pick })}
                onPickEntityPoint={(pick, worldPoint) => dispatchEngine({ type: "entityPoint", entity: pick, point: [worldPoint[0], worldPoint[1]] })}
                onSelectionChange={onSelectionChange}
                onGripEdit={(result: GripEditResult) => {
                  setHistoryLines((h) => [...h, ...result.echo]);
                  void executePlan({ appApi: result.appApi, ui: [], echo: [] });
                }}
                onCommandStart={startCommand}
                zoomExtentsSignal={zoomExtentsSignal}
              />
            )}
            {view === "bim3d" && <BimWorkbench />}
            {view === "docs" && <DocsWorkbench />}
            {view === "ifc" && <IfcWorkbench />}
            {view === "components" && <ComponentsWorkbench />}
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
            activeLayer={activeLayer}
            activeStoryName={activeStoryName}
            selectionCount={selection.length}
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
              setHistoryLines((h) => [...h, "OSNAP modes are configured in the layers palette settings."]);
            }}
          />
        </main>

        <RightDock
          snapshot={snapshot}
          selection={selection}
          activeTab={dockTab}
          onTab={setDockTab}
          activeLayer={activeLayer}
          onActiveLayer={setActiveLayer}
          activeStoryId={activeStoryId}
          onActiveStory={setActiveStoryId}
          onSelection={(ids) => void onSelectionChange(ids)}
          onCommitEdit={(label, fn) => {
            setBusy(true);
            void (async () => {
              const res = await fn();
              if (!res.ok) setError(`[${label}] ${res.code}: ${res.message}`);
              await refresh();
              setBusy(false);
            })();
          }}
          visible={dockVisible}
        />
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onRun={onPaletteRun} />

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
