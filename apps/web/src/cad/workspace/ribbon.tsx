"use client";

/**
 * CAD-PARITY-002 application menu, ribbon and tool palette (Web host) —
 * the CAD-P-003 workspace surfaces. Every control resolves to a canonical
 * registry command (or an explicit shell action); NOTHING here mutates
 * document state directly (§5.3).
 */

import * as React from "react";
import {
  ArrowRightToLine,
  ArrowUpRight,
  Box,
  Circle,
  CircleDot,
  Clipboard,
  Columns2,
  Compass,
  Egg,
  Expand,
  FilePlus2,
  FileSliders,
  FlipHorizontal2,
  FolderOpen,
  Grid3x3,
  HelpCircle,
  Layers,
  Link2,
  Bomb,
  Minus,
  MousePointer2,
  MoveHorizontal,
  Navigation,
  Package,
  PanelRight,
  Pentagon,
  PencilRuler,
  Redo2,
  RotateCw,
  Save,
  Scaling,
  Scissors,
  Slice,
  Spline,
  Split,
  Square,
  Squircle,
  Trash2,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { WORKSPACE_COMMANDS, commandById, type WorkspaceCommand } from "@offisos/cad-app-shell/workspace/commands";

export type WorkspaceView = "model" | "bim3d" | "docs" | "ifc" | "components";
export type WorkspacePreset = "drafting" | "bim" | "documentation" | "compact";

// ---------------------------------------------------------------------------
// Command button helper.
// ---------------------------------------------------------------------------

function CommandButton(
  props: { command: WorkspaceCommand; onCommand: (id: string) => void; active: boolean },
): React.JSX.Element {
  return (
    <Button
      size="sm"
      variant={props.active ? "default" : "ghost"}
      className="h-8 flex-col gap-0 px-2"
      title={`${props.command.description}${props.command.aliases.length > 0 ? ` (${props.command.aliases.join(", ")})` : ""}`}
      onClick={() => props.onCommand(props.command.id)}
    >
      <span className="text-[11px] font-semibold leading-4">{props.command.label}</span>
      <span className="text-[9px] leading-3 text-muted-foreground">
        {props.command.aliases[0] ?? props.command.name}
      </span>
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Application menu bar.
// ---------------------------------------------------------------------------

export interface MenuBarProps {
  readonly onCommand: (id: string) => void;
  readonly onAction: (action: "file.new" | "file.open" | "file.save") => void;
  readonly onSwitchView: (view: WorkspaceView) => void;
  readonly onPreset: (preset: WorkspacePreset) => void;
  readonly preset: WorkspacePreset;
  readonly onSearch: () => void;
}

function MenuItem(
  props: { label: string; shortcut?: string; onClick: () => void; disabled?: boolean },
): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={props.disabled}
      className="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
      onClick={props.onClick}
    >
      <span>{props.label}</span>
      {props.shortcut !== undefined && <kbd className="text-[10px] text-muted-foreground">{props.shortcut}</kbd>}
    </button>
  );
}

function Menu(
  props: { label: string; children: React.ReactNode },
): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className={"rounded px-2 py-1 text-xs font-medium " + (open ? "bg-muted" : "hover:bg-muted")}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setOpen(true)}
      >
        {props.label}
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-40 min-w-52 rounded-md border bg-background py-1 shadow-lg"
          role="menu"
          aria-label={`${props.label} menu`}
        >
          {props.children}
        </div>
      )}
    </div>
  );
}

export function MenuBar(props: MenuBarProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-0.5 border-b bg-background px-2 py-1" role="menubar" aria-label="application menu">
      <span className="mr-2 flex items-center gap-1 text-xs font-bold tracking-tight">
        <Compass className="h-4 w-4" aria-hidden /> Offisos
      </span>
      <Menu label="File">
        <MenuItem label="New" shortcut="Ctrl+N" onClick={() => props.onAction("file.new")} />
        <MenuItem label="Open…" onClick={() => props.onAction("file.open")} />
        <MenuItem label="Save" shortcut="Ctrl+S" onClick={() => props.onAction("file.save")} />
        <div className="my-1 border-t" />
        <MenuItem label="Undo" shortcut="Ctrl+Z" onClick={() => props.onCommand("undo")} />
        <MenuItem label="Redo" shortcut="Ctrl+Y" onClick={() => props.onCommand("redo")} />
      </Menu>
      <Menu label="Edit">
        <MenuItem label="Undo" shortcut="Ctrl+Z" onClick={() => props.onCommand("undo")} />
        <MenuItem label="Redo" shortcut="Ctrl+Y" onClick={() => props.onCommand("redo")} />
        <div className="my-1 border-t" />
        <MenuItem label="Erase selection" shortcut="Del" onClick={() => props.onCommand("erase")} />
        <MenuItem label="Select all" shortcut="Ctrl+A" onClick={() => props.onCommand("selectall")} />
        <MenuItem label="Deselect (Esc)" onClick={() => props.onCommand("cancel")} />
      </Menu>
      <Menu label="View">
        <MenuItem label="Model (2D plan)" onClick={() => props.onSwitchView("model")} />
        <MenuItem label="3D BIM view" onClick={() => props.onSwitchView("bim3d")} />
        <MenuItem label="Documentation" onClick={() => props.onSwitchView("docs")} />
        <MenuItem label="Interoperability (IFC)" onClick={() => props.onSwitchView("ifc")} />
        <MenuItem label="Components" onClick={() => props.onSwitchView("components")} />
        <div className="my-1 border-t" />
        <MenuItem label="Zoom extents (ZE)" onClick={() => props.onCommand("zoomextents")} />
        <MenuItem label="Navigator" onClick={() => props.onCommand("navigator")} />
        <MenuItem label="Layers palette (LA)" onClick={() => props.onCommand("layer")} />
        <MenuItem label="Properties (PR)" onClick={() => props.onCommand("properties")} />
      </Menu>
      <Menu label="Insert">
        <MenuItem label="Door (DR)" onClick={() => props.onCommand("door")} />
        <MenuItem label="Window (WN)" onClick={() => props.onCommand("window")} />
        <MenuItem label="Slab (SL)" onClick={() => props.onCommand("slab")} />
        <div className="my-1 border-t" />
        <MenuItem label="Components palette…" onClick={() => props.onSwitchView("components")} />
      </Menu>
      <Menu label="Annotate">
        <MenuItem label="Linear dimension (DLI)" onClick={() => props.onCommand("dimlinear")} />
        <MenuItem label="Radius dimension (DRA)" onClick={() => props.onCommand("dimradius")} />
      </Menu>
      <Menu label="Manage">
        <MenuItem label="Layers… (LA)" onClick={() => props.onCommand("layer")} />
        <MenuItem label="Properties… (PR)" onClick={() => props.onCommand("properties")} />
        <MenuItem label="Navigator… (NAV)" onClick={() => props.onCommand("navigator")} />
        <div className="my-1 border-t" />
        <MenuItem label="Components & materials…" onClick={() => props.onSwitchView("components")} />
        <MenuItem label="IFC interoperability…" onClick={() => props.onSwitchView("ifc")} />
      </Menu>
      <Menu label="BIM">
        <MenuItem label="Story (ST)" onClick={() => props.onCommand("story")} />
        <MenuItem label="Wall (WA)" onClick={() => props.onCommand("wall")} />
        <MenuItem label="Slab (SL)" onClick={() => props.onCommand("slab")} />
        <MenuItem label="Door (DR)" onClick={() => props.onCommand("door")} />
        <MenuItem label="Window (WN)" onClick={() => props.onCommand("window")} />
        <div className="my-1 border-t" />
        <MenuItem label="3D BIM view…" onClick={() => props.onSwitchView("bim3d")} />
      </Menu>
      <Menu label="Document">
        <MenuItem label="Documentation workbench…" onClick={() => props.onSwitchView("docs")} />
        <MenuItem label="Regenerate documentation" onClick={() => props.onSwitchView("docs")} />
      </Menu>
      <Menu label="Help">
        <MenuItem label="Command search" shortcut="Ctrl+K" onClick={props.onSearch} />
        <MenuItem label="Commands, aliases & shortcuts" shortcut="F1" onClick={() => props.onCommand("help")} />
      </Menu>
      <div className="ml-auto flex items-center gap-1">
        <select
          aria-label="workspace preset"
          title="Workspace preset"
          className="rounded border bg-background px-1.5 py-0.5 text-[11px]"
          value={props.preset}
          onChange={(e) => props.onPreset(e.target.value as WorkspacePreset)}
        >
          <option value="drafting">Drafting & Annotation</option>
          <option value="bim">BIM</option>
          <option value="documentation">Documentation</option>
          <option value="compact">Compact</option>
        </select>
        <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-[11px]" onClick={props.onSearch} title="Command search (Ctrl+K)">
          <HelpCircle className="h-3.5 w-3.5" aria-hidden /> Search
          <kbd className="rounded border px-1 text-[9px]">Ctrl+K</kbd>
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ribbon with contextual tabs.
// ---------------------------------------------------------------------------

const RIBBON_TABS: readonly { id: string; label: string }[] = [
  { id: "Home", label: "Home" },
  { id: "Insert", label: "Insert" },
  { id: "Annotate", label: "Annotate" },
  { id: "BIM", label: "BIM" },
  { id: "Document", label: "Document" },
  { id: "View", label: "View" },
];

const TAB_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  line: Minus,
  circle: Circle,
  rectangle: Square,
  polyline: PencilRuler,
  arc: Circle,
  story: FilePlus2,
  wall: Square,
  slab: Square,
  door: Square,
  window: Square,
  dimlinear: Square,
  dimradius: Circle,
  // CAD-PARITY-003 draw vocabulary.
  ellipse: Egg,
  spline: Spline,
  point: CircleDot,
  ray: ArrowUpRight,
  xline: MoveHorizontal,
  region: Pentagon,
  // CAD-PARITY-003 modify vocabulary.
  rotate: RotateCw,
  scale: Scaling,
  mirror: FlipHorizontal2,
  offset: Columns2,
  trim: Scissors,
  extend: ArrowRightToLine,
  stretch: Expand,
  fillet: Squircle,
  chamfer: Slice,
  break: Split,
  join: Link2,
  explode: Bomb,
  move: MousePointer2,
  copy: Clipboard,
  erase: Trash2,
};

export interface RibbonProps {
  readonly activeCommand: string | null;
  readonly onCommand: (id: string) => void;
  readonly view: WorkspaceView;
  readonly onSwitchView: (view: WorkspaceView) => void;
  readonly compact: boolean;
}

export function Ribbon(props: RibbonProps): React.JSX.Element {
  const [tab, setTab] = React.useState("Home");
  const commands = React.useMemo(
    () => WORKSPACE_COMMANDS.filter((c) => c.ribbonTab === tab && c.steps.length > 0 && c.instant === undefined && c.category !== "settings" && c.category !== "help" && c.category !== "view"),
    [tab],
  );
  const instantCommands = React.useMemo(
    () => WORKSPACE_COMMANDS.filter((c) => c.ribbonTab === tab && c.instant !== undefined),
    [tab],
  );

  if (props.compact) {
    return (
      <div className="flex items-center gap-1 border-b bg-muted/40 px-2 py-1" role="toolbar" aria-label="quick toolbar">
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[11px]" onClick={() => props.onCommand("line")} title="Line (L)">
          <Minus className="h-3.5 w-3.5" aria-hidden /> Line
        </Button>
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[11px]" onClick={() => props.onCommand("circle")} title="Circle (C)">
          <Circle className="h-3.5 w-3.5" aria-hidden /> Circle
        </Button>
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[11px]" onClick={() => props.onCommand("wall")} title="Wall (WA)">
          <Square className="h-3.5 w-3.5" aria-hidden /> Wall
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => props.onCommand("undo")} title="Undo (Ctrl+Z)">
          <Undo2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => props.onCommand("redo")} title="Redo (Ctrl+Y)">
          <Redo2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => props.onCommand("zoomextents")} title="Zoom extents (ZE)">
          <Box className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <div className="border-b bg-muted/40" role="region" aria-label="ribbon">
      <div className="flex items-end gap-1 px-2 pt-1" role="tablist" aria-label="ribbon tabs">
        {RIBBON_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={
              "rounded-t border border-b-0 px-3 py-1 text-xs font-medium " +
              (tab === t.id ? "bg-background text-foreground" : "bg-transparent text-muted-foreground hover:bg-background/60")
            }
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1 pb-1">
          <Button
            size="sm"
            variant={props.view === "model" ? "default" : "outline"}
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => props.onSwitchView("model")}
          >
            <Grid3x3 className="h-3.5 w-3.5" aria-hidden /> Model
          </Button>
          <Button
            size="sm"
            variant={props.view === "bim3d" ? "default" : "outline"}
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => props.onSwitchView("bim3d")}
          >
            <Box className="h-3.5 w-3.5" aria-hidden /> 3D BIM
          </Button>
          <Button
            size="sm"
            variant={props.view === "docs" ? "default" : "outline"}
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => props.onSwitchView("docs")}
          >
            <FileSliders className="h-3.5 w-3.5" aria-hidden /> Docs
          </Button>
          <Button
            size="sm"
            variant={props.view === "ifc" ? "default" : "outline"}
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => props.onSwitchView("ifc")}
          >
            <FolderOpen className="h-3.5 w-3.5" aria-hidden /> IFC
          </Button>
          <Button
            size="sm"
            variant={props.view === "components" ? "default" : "outline"}
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => props.onSwitchView("components")}
          >
            <Package className="h-3.5 w-3.5" aria-hidden /> Components
          </Button>
        </div>
      </div>
      <div className="flex min-h-[46px] flex-wrap items-center gap-1 border-t bg-background px-2 py-1" role="tabpanel">
        {commands.map((command) => {
          const Icon = TAB_ICONS[command.id] ?? PencilRuler;
          return (
            <Button
              key={command.id}
              size="sm"
              variant={props.activeCommand === command.id ? "default" : "ghost"}
              className="h-9 flex-col gap-0 px-3"
              title={`${command.description}${command.aliases.length > 0 ? ` (${command.aliases.join(", ")})` : ""}`}
              onClick={() => props.onCommand(command.id)}
            >
              <Icon className="h-4 w-4" aria-hidden />
              <span className="text-[10px] font-medium leading-3">{command.label}</span>
            </Button>
          );
        })}
        {instantCommands.length > 0 && <div className="mx-1 h-8 w-px bg-border" />}
        {instantCommands.map((command) => (
          <CommandButton key={command.id} command={command} onCommand={props.onCommand} active={props.activeCommand === command.id} />
        ))}
        {tab === "View" && (
          <>
            <div className="mx-1 h-8 w-px bg-border" />
            <Button size="sm" variant="ghost" className="h-9 flex-col gap-0 px-3" title="Layers palette (LA)" onClick={() => props.onCommand("layer")}>
              <Layers className="h-4 w-4" aria-hidden />
              <span className="text-[10px] leading-3">Layers</span>
            </Button>
            <Button size="sm" variant="ghost" className="h-9 flex-col gap-0 px-3" title="Properties (PR)" onClick={() => props.onCommand("properties")}>
              <PanelRight className="h-4 w-4" aria-hidden />
              <span className="text-[10px] leading-3">Properties</span>
            </Button>
            <Button size="sm" variant="ghost" className="h-9 flex-col gap-0 px-3" title="Navigator (NAV)" onClick={() => props.onCommand("navigator")}>
              <Navigation className="h-4 w-4" aria-hidden />
              <span className="text-[10px] leading-3">Navigator</span>
            </Button>
          </>
        )}
        {tab === "Home" && (
          <>
            <div className="mx-1 h-8 w-px bg-border" />
            <Button size="sm" variant="ghost" className="h-9 flex-col gap-0 px-3" title="Erase (E / Del)" onClick={() => props.onCommand("erase")}>
              <Trash2 className="h-4 w-4" aria-hidden />
              <span className="text-[10px] leading-3">Erase</span>
            </Button>
            <Button size="sm" variant="ghost" className="h-9 flex-col gap-0 px-3" title="Move (M)" onClick={() => props.onCommand("move")}>
              <MousePointer2 className="h-4 w-4" aria-hidden />
              <span className="text-[10px] leading-3">Move</span>
            </Button>
            <Button size="sm" variant="ghost" className="h-9 flex-col gap-0 px-3" title="Copy (CO)" onClick={() => props.onCommand("copy")}>
              <Clipboard className="h-4 w-4" aria-hidden />
              <span className="text-[10px] leading-3">Copy</span>
            </Button>
            <Button size="sm" variant="ghost" className="h-9 flex-col gap-0 px-3" title="Save (Ctrl+S)" onClick={() => props.onCommand("save")}>
              <Save className="h-4 w-4" aria-hidden />
              <span className="text-[10px] leading-3">Save</span>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool palette (left dock).
// ---------------------------------------------------------------------------

export interface ToolPaletteProps {
  readonly activeCommand: string | null;
  readonly onCommand: (id: string) => void;
  readonly visible: boolean;
}

export function ToolPalette(props: ToolPaletteProps): React.JSX.Element | null {
  if (!props.visible) return null;
  const groups: readonly { label: string; ids: readonly string[] }[] = [
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
  return (
    <div className="flex w-14 shrink-0 flex-col gap-2 overflow-y-auto border-r bg-muted/30 py-2" role="toolbar" aria-label="tool palette">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="px-1 pb-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            {group.label}
          </div>
          <div className="flex flex-col items-center gap-0.5">
            {group.ids.map((id) => {
              const command = commandById(id);
              if (command === null) return null;
              const Icon = TAB_ICONS[id] ?? PencilRuler;
              return (
                <Button
                  key={id}
                  size="sm"
                  variant={props.activeCommand === id ? "default" : "ghost"}
                  className="h-8 w-11 flex-col gap-0 px-0"
                  title={`${command.description} (${command.aliases.join(", ")})`}
                  aria-label={command.label}
                  aria-pressed={props.activeCommand === id}
                  onClick={() => props.onCommand(id)}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  <span className="text-[8px] leading-3">{command.aliases[0] ?? command.label}</span>
                </Button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
