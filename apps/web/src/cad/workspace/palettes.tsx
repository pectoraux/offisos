"use client";

/**
 * CAD-PARITY-002 right-dock palettes (Web host): Properties inspector,
 * Layers palette and the project Navigator (CAD-P-003 "tool palettes,
 * properties/inspector, layers palette, navigator/project browser").
 *
 * Property edits go through the App API with explicit validation — drafting
 * entities are re-validated through the canonical strict constructors
 * (LOCK-007); BIM properties through bim.setProperties. The Navigator is
 * the Archicad-class project map (stories + elements grouped by kind);
 * selection in the navigator IS document selection (document.setSelection).
 */

import * as React from "react";
import { Eye, EyeOff, Layers as LayersIcon, Navigation, Plus, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { CADDocumentSnapshot, Element, LayerRecord } from "@offisos/cad-app-shell/contracts/caddocument";
import type { CommandQueryResponse } from "@offisos/cad-app-shell/contracts/app-api";
import { geomFromElement } from "@offisos/cad-app-shell/workspace/geometry/bridge";
import { GEOM_LABEL } from "@offisos/cad-app-shell/workspace/geometry/types";
import { draftingAddLayer, draftingUpdateLayer, setSelection } from "@/cad/client/http-transport";

export type DockTab = "properties" | "layers" | "navigator";

export interface PalettesProps {
  readonly snapshot: CADDocumentSnapshot | null;
  readonly selection: readonly string[];
  readonly activeTab: DockTab;
  readonly onTab: (tab: DockTab) => void;
  readonly activeLayer: string;
  readonly onActiveLayer: (layer: string) => void;
  readonly activeStoryId: string | null;
  readonly onActiveStory: (id: string) => void;
  readonly onSelection: (ids: readonly string[]) => void;
  readonly onCommitEdit: (label: string, fn: () => Promise<CommandQueryResponse>) => void;
  readonly visible: boolean;
}

// ---------------------------------------------------------------------------
// Properties inspector.
// ---------------------------------------------------------------------------

function PropRow(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5 text-xs">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="flex items-center gap-1">{props.children}</span>
    </label>
  );
}

const NUM_INPUT =
  "w-20 rounded border bg-background px-1 py-0.5 text-right font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function NumberField(
  props: { value: number; onCommit: (v: number) => void; step?: number; ariaLabel: string },
): React.JSX.Element {
  // Controlled while the user edits; mirrors the committed value otherwise
  // (no effects — the commit boundary is blur/Enter).
  const [editing, setEditing] = React.useState<string | null>(null);
  const text = editing ?? String(props.value);
  const commit = () => {
    const n = Number(text);
    if (editing !== null && Number.isFinite(n) && n !== props.value) props.onCommit(n);
    setEditing(null);
  };
  return (
    <input
      type="number"
      step={props.step ?? "any"}
      aria-label={props.ariaLabel}
      className={NUM_INPUT}
      value={text}
      onChange={(e) => setEditing(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(null);
      }}
    />
  );
}

function PropertiesPanel(props: PalettesProps): React.JSX.Element {
  const selected = React.useMemo(() => {
    const els = props.snapshot?.elements ?? [];
    if (props.selection.length !== 1) return null;
    return els.find((el) => el.id === props.selection[0]) ?? null;
  }, [props.snapshot, props.selection]);

  if (selected === null) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        {props.selection.length > 1
          ? `${props.selection.length} entities selected — properties show a single selection.`
          : "No selection. Pick an entity in the Model viewport or the Navigator."}
      </div>
    );
  }

  const el: Element = selected;
  const p = el.props as Record<string, unknown>;
  const commit = props.onCommitEdit;
  const patchBim = (patch: Record<string, unknown>) =>
    commit("bim.setProperties", async () => {
      const { bimSetProperties } = await import("@/cad/client/http-transport");
      return bimSetProperties(el.id, patch);
    });
  // CAD-PARITY-003: the canonical geometry view of the selection (both
  // storage conventions decode through the bridge — dims/BIM return null).
  const canonicalGeom = el.kind === "geometry" && p.drafting === true ? geomFromElement(el) : null;

  const rows: React.JSX.Element[] = [];
  rows.push(<PropRow key="id" label="id"><code className="font-mono text-[11px]">{el.id}</code></PropRow>);
  rows.push(<PropRow key="kind" label="kind"><Badge variant="secondary">{el.kind}</Badge></PropRow>);
  if (canonicalGeom !== null) {
    rows.push(<PropRow key="type" label="type"><Badge variant="secondary">{GEOM_LABEL[canonicalGeom.type]}</Badge></PropRow>);
  } else if (typeof p.type === "string") {
    rows.push(<PropRow key="type" label="type"><code className="font-mono text-[11px]">{p.type}</code></PropRow>);
  }
  if (typeof p.layer === "string") {
    rows.push(
      <PropRow key="layer" label="layer">
        <select
          aria-label="entity layer"
          className="rounded border bg-background px-1 py-0.5 text-xs"
          value={p.layer}
          onChange={(e) => {
            const layer = e.target.value;
            commit("set layer", async () => {
              const { applyEdit } = await import("@/cad/client/http-transport");
              return applyEdit({ type: "updateElement", elementId: el.id, patch: { ...p, layer } });
            });
          }}
        >
          {(props.snapshot?.layers ?? []).map((l: LayerRecord) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </PropRow>,
    );
  }

  // BIM numeric properties (validated server-side by bim.setProperties).
  if (el.kind === "bim") {
    const numeric: readonly { key: string; label: string }[] = [
      { key: "width", label: "width" },
      { key: "height", label: "height" },
      { key: "thickness", label: "thickness" },
      { key: "level", label: "level" },
      { key: "baseOffset", label: "base offset" },
      { key: "sill", label: "sill" },
    ];
    for (const { key, label } of numeric) {
      if (typeof p[key] === "number") {
        rows.push(
          <PropRow key={key} label={label}>
            <NumberField
              ariaLabel={`${el.id} ${label}`}
              value={p[key] as number}
              onCommit={(v) => patchBim({ [key]: v })}
            />
          </PropRow>,
        );
      }
    }
    if (typeof p.name === "string") {
      rows.push(
        <PropRow key="name" label="name">
          <input
            aria-label={`${el.id} name`}
            className="w-36 rounded border bg-background px-1 py-0.5 text-xs"
            defaultValue={p.name}
            onBlur={(e) => {
              if (e.target.value !== p.name) patchBim({ name: e.target.value });
            }}
          />
        </PropRow>,
      );
    }
  }

  // Drafting entity numerics — re-validated through the strict constructors.
  if (el.kind === "geometry" && p.drafting === true) {
    const setDraft = (patch: Record<string, unknown>) =>
      commit("update entity", async () => {
        const { applyEdit } = await import("@/cad/client/http-transport");
        return applyEdit({ type: "updateElement", elementId: el.id, patch: { ...p, ...patch } });
      });
    if (p.type === "circle" && Array.isArray(p.center)) {
      rows.push(
        <PropRow key="radius" label="radius">
          <NumberField
            ariaLabel="circle radius"
            value={p.radius as number}
            onCommit={(v) => setDraft({ radius: v })}
          />
        </PropRow>,
      );
    }
    if (p.type === "line" && Array.isArray(p.from) && Array.isArray(p.to)) {
      const from = p.from as [number, number];
      const to = p.to as [number, number];
      rows.push(
        <PropRow key="from" label="from x,y">
          <NumberField ariaLabel="line from x" value={from[0]} onCommit={(v) => setDraft({ from: [v, from[1]] })} />
          <NumberField ariaLabel="line from y" value={from[1]} onCommit={(v) => setDraft({ from: [from[0], v] })} />
        </PropRow>,
      );
      rows.push(
        <PropRow key="to" label="to x,y">
          <NumberField ariaLabel="line to x" value={to[0]} onCommit={(v) => setDraft({ to: [v, to[1]] })} />
          <NumberField ariaLabel="line to y" value={to[1]} onCommit={(v) => setDraft({ to: [to[0], v] })} />
        </PropRow>,
      );
    }
    if (p.type === "polyline" && Array.isArray(p.points)) {
      rows.push(<PropRow key="pts" label="vertices"><span>{(p.points as unknown[]).length}</span></PropRow>);
    }
  }

  // CAD-PARITY-003 canonical entities: read-only key geometry display in the
  // same style as the legacy rows (the new vocabulary + flat-convention
  // records of the classic types).
  if (canonicalGeom !== null) {
    const g = canonicalGeom;
    const num = (v: number): string => String(Number(v.toFixed(3)));
    const value = (text: string): React.JSX.Element => <code className="font-mono text-[11px]">{text}</code>;
    switch (g.type) {
      case "ellipse":
        rows.push(<PropRow key="axes" label="axes">{value(`${num(g.rx)} × ${num(g.ry)}`)}</PropRow>);
        rows.push(<PropRow key="rotation" label="rotation">{value(`${num((g.rotation * 180) / Math.PI)}°`)}</PropRow>);
        rows.push(<PropRow key="center" label="center">{value(`${num(g.cx)}, ${num(g.cy)}`)}</PropRow>);
        break;
      case "spline":
        rows.push(<PropRow key="cpts" label="control points">{value(String(g.controlPoints.length))}</PropRow>);
        rows.push(<PropRow key="degree" label="degree">{value(String(g.degree))}</PropRow>);
        break;
      case "point":
        rows.push(<PropRow key="position" label="position">{value(`${num(g.x)}, ${num(g.y)}`)}</PropRow>);
        break;
      case "ray":
      case "xline": {
        const dirDeg = (((Math.atan2(g.y2 - g.y1, g.x2 - g.x1) * 180) / Math.PI + 360) % 360);
        rows.push(<PropRow key="base" label="base">{value(`${num(g.x1)}, ${num(g.y1)}`)}</PropRow>);
        rows.push(<PropRow key="through" label="through">{value(`${num(g.x2)}, ${num(g.y2)}`)}</PropRow>);
        rows.push(<PropRow key="direction" label="direction">{value(`${num(dirDeg)}°`)}</PropRow>);
        break;
      }
      case "region":
        rows.push(<PropRow key="boundary" label="boundary">{value(g.boundary.kind)}</PropRow>);
        rows.push(<PropRow key="area" label="area">{value(num(g.area))}</PropRow>);
        rows.push(<PropRow key="perimeter" label="perimeter">{value(num(g.perimeter))}</PropRow>);
        rows.push(<PropRow key="centroid" label="centroid">{value(`${num(g.centroid.x)}, ${num(g.centroid.y)}`)}</PropRow>);
        break;
      case "line":
        if (!Array.isArray(p.from)) {
          rows.push(<PropRow key="from" label="from">{value(`${num(g.x1)}, ${num(g.y1)}`)}</PropRow>);
          rows.push(<PropRow key="to" label="to">{value(`${num(g.x2)}, ${num(g.y2)}`)}</PropRow>);
        }
        break;
      case "circle":
        if (!Array.isArray(p.center)) {
          rows.push(<PropRow key="center" label="center">{value(`${num(g.cx)}, ${num(g.cy)}`)}</PropRow>);
          rows.push(<PropRow key="radius" label="radius">{value(num(g.r))}</PropRow>);
        }
        break;
      case "arc":
        if (!Array.isArray(p.center)) {
          rows.push(<PropRow key="center" label="center">{value(`${num(g.cx)}, ${num(g.cy)}`)}</PropRow>);
          rows.push(<PropRow key="radius" label="radius">{value(num(g.r))}</PropRow>);
          rows.push(
            <PropRow key="sweep" label="sweep">
              {value(`${num((((g.endAngle - g.startAngle) * 180) / Math.PI + 360) % 360)}°`)}
            </PropRow>,
          );
        }
        break;
      case "polyline":
        if (!Array.isArray(p.points)) {
          rows.push(<PropRow key="pts" label="vertices">{value(String(g.vertices.length))}</PropRow>);
          rows.push(<PropRow key="closed" label="closed">{value(g.closed ? "yes" : "no")}</PropRow>);
        }
        break;
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-3">{rows}</div>
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------
// Layers palette.
// ---------------------------------------------------------------------------

function LayersPanel(props: PalettesProps): React.JSX.Element {
  const layers = props.snapshot?.layers ?? [];
  const [newName, setNewName] = React.useState("");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b p-2">
        <input
          aria-label="new layer name"
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs"
          placeholder="New layer name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newName.trim().length > 0) {
              const name = newName.trim();
              props.onCommitEdit("add layer", () => draftingAddLayer({ name }));
              setNewName("");
            }
          }}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-7 p-0"
          aria-label="add layer"
          title="Add layer"
          disabled={newName.trim().length === 0}
          onClick={() => {
            const name = newName.trim();
            if (name.length === 0) return;
            props.onCommitEdit("add layer", () => draftingAddLayer({ name }));
            setNewName("");
          }}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <ul className="p-1" aria-label="layers list">
          {layers.map((layer: LayerRecord) => (
            <li
              key={layer.id}
              className={
                "flex items-center gap-2 rounded px-2 py-1 text-xs " +
                (props.activeLayer === layer.id ? "bg-muted font-medium" : "hover:bg-muted/50")
              }
            >
              <button
                type="button"
                aria-label={`${layer.name} set active`}
                className="flex flex-1 items-center gap-2 text-left"
                onClick={() => props.onActiveLayer(layer.id)}
              >
                <span className="h-3 w-3 shrink-0 rounded-sm border" style={{ background: layer.color }} aria-hidden />
                {layer.name}
                {props.activeLayer === layer.id && <Badge variant="secondary" className="h-4 px-1 text-[9px]">active</Badge>}
              </button>
              <button
                type="button"
                aria-label={`${layer.name} ${layer.visible ? "hide" : "show"}`}
                title={layer.visible ? "Hide layer" : "Show layer"}
                onClick={() =>
                  props.onCommitEdit("layer visibility", () => draftingUpdateLayer(layer.id, { visible: !layer.visible }))
                }
              >
                {layer.visible ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Navigator / project browser.
// ---------------------------------------------------------------------------

function NavigatorPanel(props: PalettesProps): React.JSX.Element {
  const elements = props.snapshot?.elements ?? [];
  const stories = elements.filter((el) => el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.story");
  const drafting = elements.filter((el) => el.kind === "geometry" && (el.props as Record<string, unknown>).drafting === true);
  const bim = elements.filter((el) => el.kind === "bim" && (el.props as Record<string, unknown>).type !== "bim.story");

  const elementLabel = (el: Element): string => {
    const p = el.props as Record<string, unknown>;
    if (typeof p.name === "string") return p.name;
    if (typeof p.type === "string") return p.type;
    return el.kind;
  };

  const renderElementList = (title: string, items: readonly Element[]) => (
    <div className="mb-2">
      <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title} ({items.length})</div>
      <ul aria-label={title}>
        {items.slice(0, 200).map((el) => (
          <li key={el.id}>
            <button
              type="button"
              className={
                "flex w-full items-center gap-2 rounded px-2 py-0.5 text-left text-xs " +
                (props.selection.includes(el.id) ? "bg-muted font-medium" : "hover:bg-muted/50")
              }
              onClick={() => props.onSelection(props.selection.includes(el.id) ? props.selection.filter((id) => id !== el.id) : [...props.selection, el.id])}
              aria-pressed={props.selection.includes(el.id)}
            >
              <span className="truncate font-mono text-[10px] text-muted-foreground">{el.id}</span>
              <span className="truncate">{elementLabel(el)}</span>
            </button>
          </li>
        ))}
        {items.length > 200 && <li className="px-2 text-[10px] text-muted-foreground">… {items.length - 200} more</li>}
      </ul>
    </div>
  );

  return (
    <ScrollArea className="h-full">
      <div className="p-1">
        <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Stories ({stories.length})</div>
        <ul aria-label="stories">
          {stories.map((story) => {
            const p = story.props as Record<string, unknown>;
            const active = props.activeStoryId === story.id;
            return (
              <li key={story.id}>
                <button
                  type="button"
                  className={
                    "flex w-full items-center justify-between gap-2 rounded px-2 py-0.5 text-left text-xs " +
                    (active ? "bg-muted font-semibold" : "hover:bg-muted/50")
                  }
                  onClick={() => props.onActiveStory(story.id)}
                  aria-pressed={active}
                  title="Set as the active story for BIM authoring"
                >
                  <span>{typeof p.name === "string" ? p.name : story.id}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {typeof p.level === "number" ? `z ${p.level}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
          {stories.length === 0 && (
            <li className="px-2 py-1 text-xs text-muted-foreground">No stories — run STORY (ST) to create one.</li>
          )}
        </ul>
        <Separator className="my-1" />
        {renderElementList("BIM elements", bim)}
        <Separator className="my-1" />
        {renderElementList("Drafting entities", drafting)}
      </div>
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------
// The dock.
// ---------------------------------------------------------------------------

export function RightDock(props: PalettesProps): React.JSX.Element | null {
  if (!props.visible) return null;
  const tabs: readonly { id: DockTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: "properties", label: "Properties", icon: Wrench },
    { id: "layers", label: "Layers", icon: LayersIcon },
    { id: "navigator", label: "Navigator", icon: Navigation },
  ];
  return (
    <div className="flex w-64 shrink-0 flex-col border-l bg-background" role="complementary" aria-label="palettes">
      <div className="flex border-b" role="tablist" aria-label="palette tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={props.activeTab === tab.id}
            className={
              "flex flex-1 items-center justify-center gap-1 px-1 py-1.5 text-[11px] font-medium " +
              (props.activeTab === tab.id
                ? "border-b-2 border-foreground text-foreground"
                : "text-muted-foreground hover:bg-muted/50")
            }
            onClick={() => props.onTab(tab.id)}
          >
            <tab.icon className="h-3.5 w-3.5" aria-hidden />
            {tab.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {props.activeTab === "properties" && <PropertiesPanel {...props} />}
        {props.activeTab === "layers" && <LayersPanel {...props} />}
        {props.activeTab === "navigator" && <NavigatorPanel {...props} />}
      </div>
      <div className="border-t p-2 text-[10px] text-muted-foreground">
        Snap tol {props.snapshot?.draftingSettings?.snap.tolerance ?? 0.5} mm · grid {props.snapshot?.draftingSettings?.grid.size ?? 1} mm · {props.snapshot?.draftingSettings?.units ?? "mm"}
      </div>
    </div>
  );
}

export { setSelection };
