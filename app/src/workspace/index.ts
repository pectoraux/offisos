/**
 * CAD-PARITY-002 shared workspace core — public surface (Issue #75).
 *
 * Both hosts import from here (`@offisos/cad-app-shell/workspace`). The
 * module is engine-free and host-free (LOCK-003/018 — enforced by the
 * forbidden-import scan) and deterministic end to end.
 */

export * from "./types.js";
export {
  WORKSPACE_COMMANDS,
  WORKSPACE_COMMAND_INDEX,
  resolveCommand,
  commandById,
  searchCommands,
  isDraftingPick,
  isBimPick,
  projectOnWall,
  type WorkspaceCommand,
  type CommandSearchHit,
} from "./commands.js";
export {
  IDLE_PROMPT_STATE,
  applyPromptEvent,
  describePrompt,
  runCommandScript,
  splitEchoTiming,
  bracketOptionWords,
  type PromptEngineState,
  type PromptEvent,
  type PromptEngineOutput,
  type PromptEngineResult,
  type CommandScriptStep,
} from "./prompt-engine.js";
export {
  hitTest,
  pickAt,
  cyclePick,
  applyPickModifier,
  selectionRectangle,
  windowSelect,
  type PickCandidate,
  type PickModifier,
  type SelectionRectangle,
} from "./selection.js";
// COMPAT-CAD-007 (Issue #142): the shared command-phase selection core —
// the ALL/LAST keyword surface and the window/crossing batch resolution
// BOTH hosts route their "Select objects:" workflows through.
export {
  selectableElements,
  lastSelectableElement,
  commandWindowIds,
  commandWindowPicks,
  toEntityPicks,
} from "./command-select.js";
export {
  gripsFor,
  gripDrag,
  type GripHandle,
  type GripEditResult,
} from "./grips.js";
export {
  DEFAULT_DRAFTING_AIDS,
  DEFAULT_COORDINATE_FORMAT,
  constrainCursor,
  formatCoordinate,
  rubberInfo,
  type DraftingAids,
  type CursorFeedback,
  type CoordinateFormat,
  type RubberInfo,
} from "./feedback.js";
export {
  mapKeyEvent,
  temporaryAidOverride,
  type KeyAction,
  type KeyFocusZone,
  type NormalizedKeyEvent,
} from "./keymap.js";
export { classifyTypedInput, resolveTypedPoint, resolveTypedDistance, type TypedInput } from "./typed-input.js";
// CAD-PARITY-003 (Issue #78): the canonical 2D geometry vocabulary, the
// shared entity operations and the precision engine.
export { COMMANDS_2D } from "./commands-2d.js";
export {
  createEntities,
  modifyEntities,
  EntityOpError,
  type EntityCreateOutcome,
  type EntityModifyOp,
  type EntityOpOutcome,
} from "./entity-ops.js";
export {
  geomFromElement,
  isCanonicalEntity,
  isDraftingGeometry,
  isRectangleElement,
  layerOfElement,
  propsFromGeom,
} from "./geometry/bridge.js";
export type { Geom, GeomType } from "./geometry/types.js";
export {
  DEFAULT_PRECISION,
  OSNAP_LABELS,
  PICKBOX_SCREEN_PX,
  constrainPoint,
  gripsOf,
  pickApertureWorld,
  pickAt as pickAt2d,
  resolveSnap,
  selectWindow,
  toEntities,
  type ConstrainResult,
  type Entity as GeomEntity,
  type Grip as GeomGrip,
  type OsnapMode,
  type PrecisionSettings,
  type SnapResult,
  type TrackingPath,
  type WindowSelection,
} from "./precision-2d.js";
export { effectiveStep, optionValue, optionValueKey, type OptionCapture } from "./prompt-engine.js";
// COMPAT-CAD-006 (Issue #138): the ONE shared screen↔world view-transform
// contract (Web + Electron, every pick/render path).
export {
  CULL_MARGIN_PX,
  DESKTOP_ZOOM_LIMITS,
  WEB_ZOOM_LIMITS,
  clampZoom,
  clipSegment,
  expandRect,
  fitExtents,
  fitZoomOf,
  panBy,
  rectsIntersect,
  toScreen,
  toWorld,
  viewTransformOf,
  visibleWorldRect,
  zoomAboutPoint,
  zoomScaleAboutCenter,
  zoomWindow,
  type ViewNavigation,
  type ViewNavigationRequest,
  type ViewportSize,
  type ViewTransform,
  type WorldRect,
} from "./view.js";
export * from "./standards/index.js";
