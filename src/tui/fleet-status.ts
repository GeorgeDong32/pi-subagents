import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type EditorComponent, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { snapshotExternalRuns } from "../api/external-runs.ts";
import { formatModelThinking } from "../shared/formatters.ts";
import type { AsyncJobState, AsyncJobStep, FleetViewPlacement, HerdrProjectPaneSnapshot, HostStepState, HostStepVerdict, NestedRunSummary, NestedStepSummary, SubagentState } from "../shared/types.ts";
import { projectAsyncWorkflowRows, type AsyncStatusWorkflowRow } from "../runs/shared/async-status-projection.ts";
import { contextModeLabel } from "../runs/shared/context-mode.ts";
import { formatWorkflowJsonPreview } from "../workflows/scripted-workflow.ts";
import { hostStepReportName, hostStepVerdictLabel } from "../runs/shared/host-step-status.ts";
import { isStaleExtensionContextError } from "../shared/extension-context.ts";
import { inlineWorkflowRenderKey } from "./render.ts";
import { runningTone } from "./running-tone.ts";
import { childThinkingLevel, type ThinkingLevel } from "../shared/model-info.ts";
import { formatWorkflowChecklistBottleneck, formatWorkflowChecklistPhase, formatWorkflowChecklistSummary, projectWorkflowChecklist, type WorkflowChecklistPhase, type WorkflowChecklistProjection } from "../workflows/workflow-checklist.ts";
import type { PresentationAgentRow, PresentationDrawResult, PresentationFleetFrame, PresentationFleetRow, PresentationNestedRow, PresentationWorkflowLaneRow, PresentationWorkflowPhaseRow } from "./presentation-seam.ts";
import { PRESENTATION_PROTOCOL_VERSION } from "./presentation-seam.ts";

export const FLEET_STATUS_WIDGET_KEY = "subagent-fleet-status";

// Six rows fit the accepted collapsed hierarchy: one owner, four visible descendants, and overflow.
const MAX_AGENT_ROWS = 6;
const REFRESH_MS = 500;

type Theme = ExtensionContext["ui"]["theme"];

const FLEET_AGENT_IDENTITY_COLORS = [
	"mdLink",
	"mdHeading",
	"syntaxFunction",
	"syntaxKeyword",
	"syntaxNumber",
	"syntaxType",
	"syntaxVariable",
	"customMessageLabel",
	"toolTitle",
	"thinkingMedium",
	"thinkingHigh",
	"mdQuote",
	"bashMode",
	"userMessageText",
	"mdCode",
	"syntaxOperator",
] as const satisfies readonly Exclude<Parameters<Theme["fg"]>[0], "accent" | "success" | "error" | "warning" | "muted" | "dim">[];

export function fleetAgentIdentityColor(identity: string): (typeof FLEET_AGENT_IDENTITY_COLORS)[number] {
	let hash = 2166136261;
	for (let i = 0; i < identity.length; i++) {
		hash ^= identity.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return FLEET_AGENT_IDENTITY_COLORS[(hash >>> 0) % FLEET_AGENT_IDENTITY_COLORS.length]!;
}

type FleetStatusTui = {
	requestRender(): void;
};
type FleetStatusEntry = {
	runLabel?: string;
	workflowKey?: string;
	key: string;
	surface?: "project-pane";
	parentKey?: string;
	workflowWrapper?: boolean;
	agent: string;
	displayLabel?: string;
	modelThinking?: string;
	description?: string;
	startedAt: number;
	tokens: number;
	window?: number;
	state: string;
	external?: true;
	projectPane?: HerdrProjectPaneSnapshot;
	nestedChildren?: NestedRunSummary[];
	workflowRows?: AsyncStatusWorkflowRow[];
	workflowChecklist?: WorkflowChecklistProjection;
};

type FleetNestedRow = {
	name: string;
	agentIdentity?: string;
	state: NestedRunSummary["state"] | NestedStepSummary["status"];
	modelThinking?: string;
	/** Thinking level of the child this row stands for; it colors the running glyph. */
	thinking?: ThinkingLevel;
	activity?: string;
	startedAt?: number;
	endedAt?: number;
	/** Total tokens reported by the child run; shown once the run reports usage. */
	tokens?: number;
	depth: number;
	overflow?: number;
};

type FleetTreeRow =
	| { kind: "owner"; entry: FleetStatusEntry }
	| { kind: "child"; entry: FleetStatusEntry; last: boolean }
	| { kind: "workflow-phase"; ownerKey: string; phase: WorkflowChecklistPhase; last: boolean }
	| { kind: "workflow"; ownerKey: string; row: AsyncStatusWorkflowRow; last: boolean; fullIndex?: number }
	| { kind: "nested"; ownerKey: string; row: FleetNestedRow; last: boolean };

export interface FleetStatusOptions {
	refreshMs?: number;
	maxAgentRows?: number;
	placement?: FleetViewPlacement;
	onWorkflowCoverageChange?: (ui: ExtensionContext["ui"], coverage: ReadonlyMap<string, string>) => void;
	/** Presentation seam dispatcher; draws frames through the registered adapter with native fallback. */
	seamDraw?: (frame: PresentationFleetFrame) => PresentationDrawResult;
}

export function resolveFleetViewPlacement(value: unknown): FleetViewPlacement {
	return value === "aboveEditor" ? "aboveEditor" : "belowEditor";
}

export function formatFleetElapsed(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function detailElapsed(row: Pick<AsyncStatusWorkflowRow, "startedAt" | "endedAt" | "durationMs"> & { state: string }): string | undefined {
	const duration = row.state === "running" && row.startedAt !== undefined
		? Date.now() - row.startedAt
		: row.durationMs ?? (row.startedAt !== undefined && row.endedAt !== undefined ? row.endedAt - row.startedAt : undefined);
	return duration !== undefined ? formatFleetElapsed(duration) : undefined;
}

export function formatFleetTokens(count: number, window?: number, windowCount = 1): string {
	const compact = (value: number): string => value >= 1_000_000
		? `${(value / 1_000_000).toFixed(1)}M`
		: value >= 1_000
			? `${(value / 1_000).toFixed(1)}k`
			: `${Math.max(0, Math.round(value))}`;
	return window !== undefined
		? `↓ ${compact(window)} ${windowCount > 1 ? "Σ windows" : "window"} · ${compact(count)} spent`
		: `↓ ${compact(count)} tokens`;
}

/** CC-compact token count for tight row columns (e.g. `8.1k`). */
function compactTokenCount(value: number): string {
	return value >= 1_000_000
		? `${(value / 1_000_000).toFixed(1)}M`
		: value >= 1_000
			? `${(value / 1_000).toFixed(1)}k`
			: `${Math.max(0, Math.round(value))}`;
}

/**
 * Tree branch rows (any depth): indent + connector + single space. The
 * caller appends the glyph right after — the selection arrow REPLACES the
 * glyph cell in place (see rowGlyph), so branch rows stay tight and
 * same-depth glyphs share one column with zero reserved padding.
 */
function treeBranch(depth: number, branch: string): string {
	return `${"    ".repeat(depth)}${branch} `;
}

/** The selection arrow takes over the glyph cell in place — a CC-style cursor. */
function rowGlyph(selected: boolean, glyph: string, theme: Theme): string {
	return selected ? theme.fg("accent", ">") : glyph;
}

function rightAlign(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const maxLeftWidth = Math.max(0, width - rightWidth - 1);
	const leftClamped = truncateToWidth(left, maxLeftWidth);
	const gap = Math.max(1, width - visibleWidth(leftClamped) - rightWidth);
	return truncateToWidth(`${leftClamped}${" ".repeat(gap)}${right}`, width);
}

// ---- Presentation seam: native fleet drawing ---------------------------------
//
// The functions below are the native adapter: they consume a projected
// PresentationFleetFrame and produce the exact bytes the inline renderer drew
// before the seam existed. Byte-identity with the pre-seam renderer is pinned
// by test/unit/fleet-status.test.ts; any visual change must stay a drawing
// decision, never a state change.

function frameDetailElapsed(row: { startedAt?: number; endedAt?: number; durationMs?: number; state: string }, now: number): string | undefined {
	const duration = row.state === "running" && row.startedAt !== undefined
		? now - row.startedAt
		: row.durationMs ?? (row.startedAt !== undefined && row.endedAt !== undefined ? row.endedAt - row.startedAt : undefined);
	return duration === undefined ? undefined : formatFleetElapsed(duration);
}

function laneRowGlyph(row: PresentationWorkflowLaneRow, theme: Theme): string {
	if (!row.kind) return nestedStatusGlyph(row.state as FleetNestedRow["state"], theme, row.thinking as ThinkingLevel | undefined);
	const state = row.state as HostStepState;
	if (state === "pending") return theme.fg("muted", "◦");
	if (state === "running") return theme.fg("accent", "●");
	if (state === "done") return row.verdict === "pass" ? theme.fg("success", "✓") : row.verdict === "fail" ? theme.fg("error", "✗") : theme.fg("warning", "■");
	if (state === "error") return theme.fg("error", "✗");
	return theme.fg("warning", "■");
}

function laneRowStateLabel(row: PresentationWorkflowLaneRow, theme: Theme): string {
	const state = row.kind ? hostStepVerdictLabel(row.state as HostStepState, row.verdict as HostStepVerdict | undefined) : row.state;
	if (state === "running") return row.kind ? theme.fg("accent", state) : runningTone(theme, row.thinking as ThinkingLevel | undefined)(state);
	if (state === "pending" || state === "queued") return theme.fg("muted", state);
	if (state === "pass" || state === "complete" || state === "completed") return theme.fg("success", state === "pass" ? "pass" : "complete");
	if (state === "fail" || state === "failed" || state === "error") return theme.fg("error", state === "fail" ? "fail" : state);
	return theme.fg("warning", state);
}

function drawAgentRow(row: PresentationAgentRow, width: number, theme: Theme, now: number): { line: string; unclipped: string } {
	// Upstream-native roster row (spec P5): displayLabel (or agent) colored by
	// agent identity, state word, checklist summary on workflow wrappers, and
	// the full token format on the right.
	const label = row.displayLabel ?? row.agentIdentity;
	const agent = row.modelThinking ? `${label} (${row.modelThinking})` : label;
	const prefix = row.branch ? `    ${row.branch}` : " ";
	const checklist = row.checklistSummary !== undefined
		? ` · checklist ${row.checklistSummary}${row.checklistBottleneck ? ` · bottleneck ${row.checklistBottleneck}` : ""}`
		: "";
	const left = `${prefix} ${rowGlyph(row.selected === true, " ", theme)} ${theme.fg(fleetAgentIdentityColor(row.agentIdentity), agent)} · ${row.state}${checklist}`;
	const elapsed = now - (row.startedAt ?? now);
	const rightText = row.projectPane
		? `${row.projectPane.summary ?? "—"} · ${formatFleetElapsed(now - row.projectPane.refreshedAt)} ago`
		: row.external
			? formatFleetElapsed(elapsed)
			: `${formatFleetElapsed(elapsed)} · ${row.workflowWrapperUsageOnChildren ? "usage on child rows" : formatFleetTokens(row.usage?.tokens ?? 0, row.usage?.window)}`;
	const right = theme.fg("dim", rightText);
	const unclipped = `${left} ${right}`;
	return { line: rightAlign(left, right, width), unclipped };
}

function drawLaneRow(row: PresentationWorkflowLaneRow, width: number, theme: Theme, now: number): { line: string; unclipped: string } {
	if (row.overflow !== undefined) {
		const line = truncateToWidth(`${treeBranch(1, row.branch)}${theme.fg("dim", `+${row.overflow} hidden workflow steps`)}`, width);
		return { line, unclipped: line };
	}
	const context = contextModeLabel(row.context as Parameters<typeof contextModeLabel>[0]);
	const modelThinking = row.modelThinking ? ` (${row.modelThinking})` : "";
	const activity = row.activity ? ` · ${row.activity}` : "";
	const kind = row.kind ? `${row.kind}: ` : "";
	const hints = row.preflight ? [
		row.preflight.mode ? `mode:${row.preflight.mode}` : undefined,
		row.preflight.decision ? `decision:${row.preflight.decision}` : undefined,
		row.preflight.claims?.length ? `claims:${row.preflight.claims.join(",")}` : undefined,
		row.preflight.expectedOutput ? `expected:${row.preflight.expectedOutput}` : undefined,
		row.preflight.independence ? `independence:${row.preflight.independence}` : undefined,
	].filter((value): value is string => Boolean(value)).join(" · ") : "";
	const left = `${treeBranch(1, row.branch)}${laneRowGlyph(row, theme)} ${theme.fg("muted", `${kind}${row.name}${context ? ` ${context}` : ""}${modelThinking}`)} · ${laneRowStateLabel(row, theme)}${activity}${hints ? ` · ${hints}` : ""}`;
	const details = [
		frameDetailElapsed(row, now),
		row.usage?.tokens !== undefined ? formatFleetTokens(row.usage.tokens, row.usage.window) : undefined,
		row.provider ? `provider:${row.provider}` : undefined,
		row.role ? `role:${row.role}` : undefined,
		row.target,
		row.detail,
		row.reasonCode ? `reason:${row.reasonCode}` : undefined,
		row.freshness?.stale ? "stale" : row.freshness?.observedRef ? `ref:${row.freshness.observedRef}` : undefined,
		row.reportPath ? `out:${hostStepReportName(row.reportPath)}` : undefined,
	].filter(Boolean).join(" · ");
	const unclipped = `${left}${details ? theme.fg("dim", ` · ${details}`) : ""}`;
	return { line: truncateToWidth(unclipped, width), unclipped };
}

function drawPhaseRow(row: PresentationWorkflowPhaseRow, width: number, theme: Theme): { line: string; unclipped: string } {
	const glyph = row.state === "complete"
		? theme.fg("success", "✓")
		: row.state === "running"
			? runningTone(theme)("●")
			: row.state === "blocked" || row.state === "failed"
				? theme.fg("error", row.state === "blocked" ? "!" : "✗")
					: row.state === "queued"
						? theme.fg("muted", "◦")
						: theme.fg("warning", "■");
	const unclipped = `${treeBranch(1, row.branch)}${glyph} ${theme.fg("muted", row.text)}`;
	return { line: truncateToWidth(unclipped, width), unclipped };
}

function drawNestedRow(row: PresentationNestedRow, width: number, theme: Theme, now: number): { line: string; unclipped: string } {
	if (row.overflow !== undefined) {
		const line = truncateToWidth(`${treeBranch(row.depth + 1, row.branch)}${theme.fg("dim", `+${row.overflow} nested leaves`)}`, width);
		return { line, unclipped: line };
	}
	const modelThinking = row.modelThinking ? ` (${row.modelThinking})` : "";
	const activity = row.activity ? ` · ${row.activity}` : "";
	const left = `${treeBranch(row.depth + 1, row.branch)}${nestedStatusGlyph(row.state as FleetNestedRow["state"], theme, row.thinking as ThinkingLevel | undefined)} ${theme.fg(fleetAgentIdentityColor(row.agentIdentity ?? row.name), `${row.name}${modelThinking}`)} · ${row.state}${activity}`;
	const elapsed = frameDetailElapsed(row, now);
	const tokens = row.usage?.tokens !== undefined ? ` · ${compactTokenCount(row.usage.tokens)} tok` : "";
	const unclipped = `${left}${elapsed !== undefined ? theme.fg("dim", ` · ${elapsed}`) : ""}${theme.fg("dim", tokens)}`;
	return { line: truncateToWidth(unclipped, width), unclipped };
}

// ---- Presentation seam: frame projection ------------------------------------
// Entry → frame-row projections. Label resolution (displayLabel → runLabel →
// workflowKey → description, redaction filtered) is projection; width budgets
// are drawing decisions and stay in the adapters.

function fleetAgentFrameRow(entry: FleetStatusEntry, selected: boolean, branch?: "├─" | "└─"): PresentationAgentRow {
	let label = String(entry.displayLabel ?? entry.runLabel ?? entry.workflowKey ?? entry.description ?? "").replace(/\s+/g, " ").trim();
	if (label === "[prompt redacted]") label = "";
	return {
		rowKind: "agent",
		rowKey: entry.key,
		...(entry.parentKey ? { parentKey: entry.parentKey } : {}),
		...(branch ? { branch } : {}),
		agentIdentity: entry.agent ?? "subagent",
		...(label ? { label } : {}),
		...(entry.modelThinking ? { modelThinking: entry.modelThinking } : {}),
		state: entry.state,
		usage: { tokens: entry.tokens, ...(entry.window !== undefined ? { window: entry.window } : {}) },
		...(entry.workflowWrapper ? { workflowWrapperUsageOnChildren: true } : {}),
		...(entry.projectPane ? { projectPane: { summary: entry.projectPane.summary, refreshedAt: entry.projectPane.refreshedAt } } : {}),
		...(entry.external ? { external: true } : {}),
		...(selected ? { selected: true } : {}),
		startedAt: entry.startedAt,
		...(entry.displayLabel ? { displayLabel: entry.displayLabel } : {}),
		...(entry.workflowWrapper && entry.workflowChecklist ? {
			checklistSummary: formatWorkflowChecklistSummary(entry.workflowChecklist),
			...(entry.workflowChecklist.bottleneck ? { checklistBottleneck: formatWorkflowChecklistBottleneck(entry.workflowChecklist.bottleneck) } : {}),
		} : {}),
	};
}

function fleetLaneFrameRow(rowKey: string, ownerKey: string, row: AsyncStatusWorkflowRow, branch: "├─" | "└─", fullIndex?: number): PresentationWorkflowLaneRow {
	return {
		rowKind: "workflow-lane",
		rowKey,
		ownerKey,
		branch,
		...(row.kind ? { kind: row.kind } : {}),
		name: row.name,
		...(row.context !== undefined ? { context: row.context } : {}),
		...(row.modelThinking ? { modelThinking: row.modelThinking } : {}),
		...(row.thinking ? { thinking: row.thinking } : {}),
		state: row.state,
		...(row.verdict !== undefined ? { verdict: row.verdict } : {}),
		...(row.activity ? { activity: row.activity } : {}),
		...(row.preflight ? { preflight: {
			...(row.preflight.mode ? { mode: row.preflight.mode } : {}),
			...(row.preflight.decision ? { decision: row.preflight.decision } : {}),
			...(row.preflight.claims?.length ? { claims: row.preflight.claims } : {}),
			...(row.preflight.expectedOutput ? { expectedOutput: row.preflight.expectedOutput } : {}),
			...(row.preflight.independence ? { independence: row.preflight.independence } : {}),
		} } : {}),
		...(row.tokens !== undefined ? { usage: { tokens: row.tokens, ...(row.window !== undefined ? { window: row.window } : {}) } } : {}),
		...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
		...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
		...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
		...(row.provider ? { provider: row.provider } : {}),
		...(row.role ? { role: row.role } : {}),
		...(row.target ? { target: row.target } : {}),
		...(row.detail ? { detail: row.detail } : {}),
		...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
		...(row.freshness ? { freshness: {
			...(row.freshness.stale ? { stale: true } : {}),
			...(row.freshness.observedRef ? { observedRef: row.freshness.observedRef } : {}),
		} } : {}),
		...(row.reportPath ? { reportPath: row.reportPath } : {}),
		...(row.overflow !== undefined ? { overflow: row.overflow } : {}),
	};
}

function fleetPhaseFrameRow(rowKey: string, ownerKey: string, phase: WorkflowChecklistPhase, branch: "├─" | "└─"): PresentationWorkflowPhaseRow {
	return {
		rowKind: "workflow-phase",
		rowKey,
		ownerKey,
		branch,
		label: phase.label,
		text: formatWorkflowChecklistPhase(phase),
		state: phase.state,
	};
}

function fleetNestedFrameRow(rowKey: string, ownerKey: string, row: FleetNestedRow, branch: "├─" | "└─"): PresentationNestedRow {
	return {
		rowKind: "nested",
		rowKey,
		ownerKey,
		branch,
		name: row.name,
		...(row.agentIdentity ? { agentIdentity: row.agentIdentity } : {}),
		state: row.state,
		...(row.modelThinking ? { modelThinking: row.modelThinking } : {}),
		...(row.thinking ? { thinking: row.thinking } : {}),
		...(row.activity ? { activity: row.activity } : {}),
		...(row.tokens !== undefined ? { usage: { tokens: row.tokens } } : {}),
		depth: row.depth,
		...(row.overflow !== undefined ? { overflow: row.overflow } : {}),
		...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
		...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
	};
}

/**
 * The native fleet adapter: renders a projected frame with the pre-seam
 * inline rendering, byte for byte, and reports per-row layout facts (fit vs
 * truncated) from the same pass the coverage decision consumes.
 */
export function drawNativeFleetFrame(frame: PresentationFleetFrame): PresentationDrawResult {
	// Upstream-native roster (spec P5): collapsed one-line summary while
	// interactive selection is off; help line + expanded tree when on. The
	// CC look lives in the CC-TUI adapter — this is the fallback and the
	// no-CC-TUI default.
	const theme = frame.theme as unknown as Theme;
	const lines: string[] = [];
	const layout: PresentationDrawResult["layout"] = [];
	const push = (rowKey: string, produced: Array<{ line: string; unclipped: string } | string>): void => {
		const from = lines.length;
		for (const item of produced) lines.push(typeof item === "string" ? item : item.line);
		const to = lines.length - 1;
		const truncated = produced.some((item) => typeof item !== "string" && visibleWidth(item.unclipped) > frame.width);
		layout.push({ rowKey, fromLine: from, toLine: to, truncated });
	};
	if (!frame.selection.active) {
		// Collapsed summary — mirrors the pre-seam native roster line. No row
		// layout entries: nothing in the tree is displayed, so coverage stays
		// empty (equivalent to the upstream early-return clear).
		const summary = frame.summary;
		const nativeUsage = formatFleetTokens(summary.nativeUsage.tokens, summary.nativeUsage.window, summary.nativeUsage.count);
		const showNativeSummary = summary.nativeUsage.count > 0 || summary.hasWorkflowWrapper || (summary.capacity?.used ?? 0) > 0;
		const asyncRuns = summary.capacity && showNativeSummary && (summary.capacity.used > 0 || summary.capacity.limit > 0)
			? `Async runs ${summary.capacity.used}/${summary.capacity.limit || "∞"}`
			: "";
		const noun = summary.anyExternal ? "job" : "agent";
		const agents = summary.activeLeafAgents > 0 ? `${summary.activeLeafAgents} active ${noun}${summary.activeLeafAgents === 1 ? "" : "s"}` : "";
		const panes = summary.panes.total > 0 ? `${summary.panes.total} pane${summary.panes.total === 1 ? "" : "s"}${summary.panes.attention ? ` (${summary.panes.attention} ⚠)` : ""}` : "";
		const label = [agents, asyncRuns, panes].filter(Boolean).join(" · ");
		const usage = summary.hasWorkflowWrapper
			? summary.nativeUsage.count > 0 ? `standalone: ${nativeUsage} · workflow usage on child rows` : "usage on child rows"
			: nativeUsage;
		const detail = [showNativeSummary ? usage : undefined, "↓/← to inspect"].filter(Boolean).join(" · ");
		lines.push(truncateToWidth(`  ${theme.fg("muted", label)}${label && detail ? " · " : ""}${theme.fg("dim", detail)}`, frame.width));
		layout.push({ rowKey: "native:summary", fromLine: 0, toLine: 0, truncated: false });
		return { lines, layout };
	}
	// Expanded: upstream help line + blank separator, then the roster.
	lines.push(truncateToWidth(`  ${theme.fg("dim", "↑↓/jk select · enter inspect · esc back")}`, frame.width));
	lines.push("");
	layout.push({ rowKey: "native:help", fromLine: 0, toLine: 1, truncated: false });
	for (const row of frame.rows) {
		switch (row.rowKind) {
			case "main": {
				const line = truncateToWidth(`  ${rowGlyph(row.selected === true, " ", theme)} main`, frame.width);
				push(row.rowKey, [{ line, unclipped: line }]);
				break;
			}
			case "overflow": {
				const line = rightAlign("", theme.fg("dim", `${row.direction === "above" ? "↑" : "↓"} ${row.hidden} more`), frame.width);
				push(row.rowKey, [{ line, unclipped: line }]);
				break;
			}
			case "agent":
				push(row.rowKey, [drawAgentRow(row, frame.width, theme, frame.now)]);
				break;
			case "workflow-lane":
				push(row.rowKey, [drawLaneRow(row, frame.width, theme, frame.now)]);
				break;
			case "workflow-phase":
				push(row.rowKey, [drawPhaseRow(row, frame.width, theme)]);
				break;
			case "nested":
				push(row.rowKey, [drawNestedRow(row, frame.width, theme, frame.now)]);
				break;
			case "section-header": {
				const from = lines.length;
				lines.push("", truncateToWidth(`  ${theme.fg("dim", row.text)}`, frame.width));
				layout.push({ rowKey: row.rowKey, fromLine: from, toLine: from + 1, truncated: false });
				break;
			}
		}
	}
	return { lines, layout };
}

function isActiveState(value: string): boolean {
	return value === "running" || value === "queued" || value === "pending";
}

function nestedRunLabel(run: NestedRunSummary): string {
	if (run.agent) return run.agent;
	if (run.agents?.length) return run.agents.length === 1 ? run.agents[0]! : `${run.agents.slice(0, 2).join(", ")}${run.agents.length > 2 ? ` +${run.agents.length - 2}` : ""}`;
	return run.id;
}

function nestedActivity(node: NestedRunSummary | NestedStepSummary): string | undefined {
	if (node.currentTool) return `tool ${node.currentTool}`;
	if (node.currentPath) return node.currentPath.split(/[\\/]/).at(-1);
	if (node.activityState === "needs_attention") return "needs attention";
	if (node.activityState === "active_long_running") return "long-running";
	return undefined;
}

/** Indexed variant of visibleWorkflowRows so frame row keys stay stable. */
function visibleWorkflowRowsIndexed(rows: AsyncStatusWorkflowRow[] | undefined, visibleLimit: number): Array<{ row: AsyncStatusWorkflowRow; fullIndex?: number }> {
	if (!rows?.length) return [];
	if (rows.length <= visibleLimit) return rows.map((row, index) => ({ row, fullIndex: index }));
	const selected = new Set<number>();
	for (const [index, row] of rows.entries()) {
		if (!isWorkflowRowTerminal(row)) selected.add(index);
		if (selected.size >= visibleLimit) break;
	}
	for (let index = rows.length - 1; index >= 0 && selected.size < visibleLimit; index--) selected.add(index);
	const visible = [...selected].sort((left, right) => left - right).map((index) => ({ row: rows[index]!, fullIndex: index }));
	return [{ row: { name: `… +${rows.length - visible.length} hidden workflow steps`, state: "complete", overflow: rows.length - visible.length } }, ...visible];
}

function visibleWorkflowPhases(checklist: WorkflowChecklistProjection | undefined, visibleLimit: number): WorkflowChecklistPhase[] {
	const phases = checklist?.phases ?? [];
	if (phases.length <= visibleLimit) return phases;
	const selected = new Set<number>();
	for (const [index, phase] of phases.entries()) {
		if (phase.state !== "complete") selected.add(index);
		if (selected.size >= visibleLimit) break;
	}
	for (let index = phases.length - 1; index >= 0 && selected.size < visibleLimit; index--) selected.add(index);
	return [...selected].sort((left, right) => left - right).map((index) => phases[index]!);
}

function isWorkflowRowTerminal(row: AsyncStatusWorkflowRow): boolean {
	if (row.kind) return row.state === "done" || row.state === "cancelled" || row.state === "error";
	return row.state === "complete" || row.state === "completed";
}

function nestedStatusGlyph(state: FleetNestedRow["state"] | "planned", theme: Theme, thinking?: ThinkingLevel): string {
	if (state === "running") return runningTone(theme, thinking)("●");
	if (state === "queued" || state === "pending" || state === "planned") return theme.fg("muted", "◦");
	if (state === "complete" || state === "completed") return theme.fg("success", "✓");
	if (state === "failed" || state === "rejected") return theme.fg("error", "✗");
	return theme.fg("warning", "■");
}

function nestedStepDisplayCount(steps: NestedStepSummary[] | undefined, start = 0): number {
	let count = 0;
	for (let index = start; index < (steps?.length ?? 0); index++) {
		count += 1 + nestedDisplayCount(steps![index]!.children);
	}
	return count;
}

function nestedDisplayCount(children: NestedRunSummary[] | undefined, start = 0): number {
	let count = 0;
	for (let index = start; index < (children?.length ?? 0); index++) {
		const child = children![index]!;
		const steps = (child.mode === "parallel" || child.mode === "chain") ? child.steps ?? [] : [];
		count += steps.length > 0 ? nestedStepDisplayCount(steps) : 1;
		count += nestedDisplayCount(child.children);
	}
	return count;
}

function nestedFleetRows(children: NestedRunSummary[] | undefined, visibleLimit: number): FleetNestedRow[] {
	const rows: FleetNestedRow[] = [];
	let omitted = 0;
	const appendRuns = (runs: NestedRunSummary[] | undefined, depth: number): boolean => {
		for (let runIndex = 0; runIndex < (runs?.length ?? 0); runIndex++) {
			const child = runs![runIndex]!;
			const steps = (child.mode === "parallel" || child.mode === "chain") ? child.steps ?? [] : [];
			if (steps.length > 0) {
				for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
					if (rows.length >= visibleLimit) {
						omitted += nestedStepDisplayCount(steps, stepIndex);
						omitted += nestedDisplayCount(child.children);
						omitted += nestedDisplayCount(runs, runIndex + 1);
						return false;
					}
					const step = steps[stepIndex]!;
					const modelThinking = formatModelThinking(step.model, step.thinking) || undefined;
					const thinking = childThinkingLevel(step);
					const activity = nestedActivity(step);
					rows.push({
						name: step.agent,
						agentIdentity: step.agent,
						state: step.status,
						depth,
						...(modelThinking ? { modelThinking } : {}),
						...(thinking ? { thinking } : {}),
						...(activity ? { activity } : {}),
						...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
						...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
					});
					if (!appendRuns(step.children, depth + 1)) {
						omitted += nestedStepDisplayCount(steps, stepIndex + 1);
						omitted += nestedDisplayCount(child.children);
						omitted += nestedDisplayCount(runs, runIndex + 1);
						return false;
					}
				}
			} else {
				if (rows.length >= visibleLimit) {
					omitted += nestedDisplayCount(runs, runIndex);
					return false;
				}
				const modelThinking = formatModelThinking(child.model, child.thinking) || undefined;
				const thinking = childThinkingLevel(child);
				const activity = nestedActivity(child);
				rows.push({
					name: nestedRunLabel(child),
					agentIdentity: child.agent ?? child.agents?.join("\0") ?? child.id,
					state: child.state,
					depth,
					...(modelThinking ? { modelThinking } : {}),
					...(thinking ? { thinking } : {}),
					...(activity ? { activity } : {}),
					...(child.startedAt !== undefined ? { startedAt: child.startedAt } : {}),
					...(child.endedAt !== undefined ? { endedAt: child.endedAt } : {}),
					...(child.totalTokens?.total !== undefined ? { tokens: child.totalTokens.total } : {}),
				});
			}
			if (!appendRuns(child.children, depth + 1)) {
				omitted += nestedDisplayCount(runs, runIndex + 1);
				return false;
			}
		}
		return true;
	};
	appendRuns(children, 0);
	if (omitted > 0) rows.push({ name: `… +${omitted} more nested leaves`, state: "complete", depth: 0, overflow: omitted });
	return rows;
}

function fleetTreeRows(entries: FleetStatusEntry[]): FleetTreeRow[] {
	const rows: FleetTreeRow[] = [];
	const entryKeys = new Set(entries.map((entry) => entry.key));
	const childrenByParent = new Map<string, FleetStatusEntry[]>();
	for (const entry of entries) {
		if (!entry.parentKey || !entryKeys.has(entry.parentKey)) continue;
		const children = childrenByParent.get(entry.parentKey) ?? [];
		children.push(entry);
		childrenByParent.set(entry.parentKey, children);
	}
	for (const entry of entries) {
		if (entry.parentKey && entryKeys.has(entry.parentKey)) continue;
		rows.push({ kind: "owner", entry });
		const attached = childrenByParent.get(entry.key) ?? [];
		const workflowPhases = visibleWorkflowPhases(entry.workflowChecklist, attached.length > 0 ? 2 : 4);
		const workflowRows = visibleWorkflowRowsIndexed(entry.workflowRows, attached.length > 0 ? 2 : 4);
		for (const [index, child] of attached.entries()) {
			const nested = nestedFleetRows(child.nestedChildren, 3);
			const laterRows = index < attached.length - 1 || workflowPhases.length > 0 || workflowRows.length > 0 || Boolean(entry.nestedChildren?.length);
			rows.push({ kind: "child", entry: child, last: !laterRows && nested.length === 0 });
			for (const [nestedIndex, row] of nested.entries()) rows.push({
				kind: "nested",
				ownerKey: child.key,
				row: { ...row, depth: row.depth + 1 },
				last: nestedIndex === nested.length - 1 && !laterRows,
			});
		}
		for (const [index, phase] of workflowPhases.entries()) rows.push({
			kind: "workflow-phase",
			ownerKey: entry.key,
			phase,
			last: index === workflowPhases.length - 1 && workflowRows.length === 0 && !entry.nestedChildren?.length,
		});
		for (const [index, { row, fullIndex }] of workflowRows.entries()) rows.push({ kind: "workflow", ownerKey: entry.key, row, last: index === workflowRows.length - 1 && !entry.nestedChildren?.length, ...(fullIndex !== undefined ? { fullIndex } : {}) });
		const nested = nestedFleetRows(entry.nestedChildren, attached.length > 0 ? 3 : 4);
		for (const [index, row] of nested.entries()) rows.push({ kind: "nested", ownerKey: entry.key, row, last: index === nested.length - 1 });
	}
	return rows;
}

function foregroundDescription(control: { parentWorkflowRunId?: string; workflowKey?: string }, description: string | undefined): string | undefined {
	if (!control.parentWorkflowRunId) return description;
	const workflow = `workflow child: ${control.parentWorkflowRunId}${control.workflowKey ? ` (${control.workflowKey})` : ""}`;
	return description ? `${workflow} · ${description}` : workflow;
}

function workflowIdentityCandidates(step: Pick<AsyncJobStep, "workflowKey" | "runId">): string[] {
	return [...new Set([step.workflowKey, step.runId].filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function asyncJobIdentityCandidates(job: AsyncJobState): string[] {
	return [...new Set([job.workflowKey, job.asyncId].filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function linkedWorkflowParentKey(parentWorkflowRunId: string | undefined, activeWorkflowKeys: ReadonlySet<string>): string | undefined {
	if (!parentWorkflowRunId) return undefined;
	const parentKey = `async:${parentWorkflowRunId}`;
	return activeWorkflowKeys.has(parentKey) ? parentKey : undefined;
}

function workflowStepsWithoutMaterializedChildren(steps: AsyncJobStep[] | undefined, materializedChildIds: ReadonlySet<string> | undefined): AsyncJobStep[] | undefined {
	if (!steps?.length || !materializedChildIds?.size) return steps;
	return steps.filter((step) => !workflowIdentityCandidates(step).some((identity) => materializedChildIds.has(identity)));
}

function activeLeafAgentCount(entries: FleetStatusEntry[]): number {
	return entries.filter((entry) => !entry.workflowWrapper && !entry.surface).length;
}

function projectPaneNeedsAttention(pane: HerdrProjectPaneSnapshot): boolean {
	return ["attention", "blocked", "paused", "failed", "error"].some((status) => pane.agentStatus.includes(status))
		|| pane.summary?.includes("⚠") === true;
}

function projectName(projectRoot: string): string {
	return projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? projectRoot;
}

function projectPaneEntries(state: SubagentState): FleetStatusEntry[] {
	return [...(state.herdrProjectPanes?.values() ?? [])]
		.filter((pane) => pane.state === "open")
		.sort((left, right) => left.openedAt.localeCompare(right.openedAt) || left.projectRoot.localeCompare(right.projectRoot))
		.map((pane) => ({
			key: `project-pane:${pane.projectRoot}`,
			surface: "project-pane" as const,
			agent: `${projectName(pane.projectRoot)} · ${pane.paneId}`,
			description: pane.summary,
			startedAt: Date.parse(pane.openedAt) || pane.refreshedAt,
			tokens: 0,
			state: pane.agentStatus || "unknown",
			projectPane: pane,
		}));
}

export function collectFleetStatusEntries(state: SubagentState): FleetStatusEntry[] {
	const now = Date.now();
	const entries: FleetStatusEntry[] = [];
	const activeWorkflowKeys = new Set([...state.asyncJobs.values()]
		.filter((job) => job.mode === "workflow" && isActiveState(job.status))
		.map((job) => `async:${job.asyncId}`));
	const materializedChildrenByWorkflow = new Map<string, Set<string>>();
	for (const job of state.asyncJobs.values()) {
		if (!isActiveState(job.status) || !job.parentWorkflowRunId) continue;
		const parentKey = linkedWorkflowParentKey(job.parentWorkflowRunId, activeWorkflowKeys);
		if (!parentKey) continue;
		const childIds = materializedChildrenByWorkflow.get(parentKey) ?? new Set<string>();
		for (const identity of asyncJobIdentityCandidates(job)) childIds.add(identity);
		materializedChildrenByWorkflow.set(parentKey, childIds);
	}
	for (const control of state.foregroundControls.values()) {
		const linkedParentKey = linkedWorkflowParentKey(control.parentWorkflowRunId, activeWorkflowKeys);
		if (control.activeChildren) {
			const nestedChildren = control.nestedChildren ?? [];
			const nestedChildrenByParentStep = new Map<number, NestedRunSummary[]>();
			for (const nested of nestedChildren) {
				if (nested.parentStepIndex === undefined) continue;
				const children = nestedChildrenByParentStep.get(nested.parentStepIndex) ?? [];
				children.push(nested);
				nestedChildrenByParentStep.set(nested.parentStepIndex, children);
			}
			for (const child of [...control.activeChildren.values()].sort((left, right) => left.index - right.index)) {
				const modelThinking = formatModelThinking(child.model, child.thinking) || undefined;
				const childNestedChildren = nestedChildrenByParentStep.get(child.index)
					?? (control.activeChildren.size === 1 && nestedChildren.length ? nestedChildren : undefined);
				entries.push({
					key: `foreground-active:${control.runId}:${child.index}`,
					...(linkedParentKey ? { parentKey: linkedParentKey } : {}),
					agent: child.agent,
					...(modelThinking ? { modelThinking } : {}),
					description: foregroundDescription(control, child.description),
					startedAt: child.startedAt,
					tokens: child.tokens ?? 0,
					...(child.window !== undefined ? { window: child.window } : {}),
					state: "running",
					...(childNestedChildren?.length ? { nestedChildren: childNestedChildren } : {}),
				});
			}
			continue;
		}
		const modelThinking = formatModelThinking(control.model, control.thinking) || undefined;
		entries.push({
			key: `foreground-active:${control.runId}:${control.currentIndex ?? 0}`,
			...(linkedParentKey ? { parentKey: linkedParentKey } : {}),
			agent: control.currentAgent ?? control.mode,
			...(modelThinking ? { modelThinking } : {}),
			description: foregroundDescription(control, control.description),
			startedAt: control.startedAt,
			tokens: control.tokens ?? 0,
			...(control.window !== undefined ? { window: control.window } : {}),
			state: "running",
			...(control.nestedChildren?.length ? { nestedChildren: control.nestedChildren } : {}),
		});
	}

	for (const job of state.asyncJobs.values()) {
		if (!isActiveState(job.status)) continue;
		const startedAt = job.startedAt ?? job.updatedAt ?? now;
		const linkedParentKey = linkedWorkflowParentKey(job.parentWorkflowRunId, activeWorkflowKeys);
		if (job.mode === "workflow") {
			const latestEmit = job.workflow?.emits?.length ? formatWorkflowJsonPreview(job.workflow.emits.at(-1), 120) : undefined;
			const workflowSteps = workflowStepsWithoutMaterializedChildren(job.steps, materializedChildrenByWorkflow.get(`async:${job.asyncId}`));
			const workflowRows = projectAsyncWorkflowRows(workflowSteps, job.workflowGraph ?? job.hostSteps, job.preflight);
			const workflowChecklist = projectWorkflowChecklist({
				graph: job.workflowGraph,
				steps: job.steps,
				hostSteps: job.hostSteps,
				preflight: job.preflight,
				trace: job.workflow?.trace,
				now,
			});
			entries.push({
				key: `async:${job.asyncId}`,
				...(linkedParentKey ? { parentKey: linkedParentKey } : {}),
				workflowWrapper: true,
				agent: "workflow",
				description: latestEmit !== undefined ? `latest emit: ${latestEmit}` : job.description,
				...(job.label ? { runLabel: job.label } : {}),
				startedAt,
				tokens: job.totalTokens?.total ?? 0,
				...(job.totalTokens?.window !== undefined ? { window: job.totalTokens.window } : {}),
				state: job.status,
				...(workflowRows.length ? { workflowRows } : {}),
				...(workflowChecklist.total ? { workflowChecklist } : {}),
				...(job.nestedChildren?.length ? { nestedChildren: job.nestedChildren } : {}),
			});
			continue;
		}
		const steps: AsyncJobStep[] | undefined = job.steps?.length
			? job.steps
			: job.agents?.map((agent, index) => {
				const pending = job.status === "queued"
					|| (job.mode === "chain" && !job.activeParallelGroup && index !== (job.currentStep ?? 0));
				return { agent, index, status: pending ? "pending" : "running" };
			});
		if (!steps?.length) {
			entries.push({
				key: `async:${job.asyncId}`,
				...(linkedParentKey ? { parentKey: linkedParentKey } : {}),
				agent: job.mode ?? "subagent",
				description: job.description,
				...(job.label ? { runLabel: job.label } : {}),
				startedAt,
				tokens: job.totalTokens?.total ?? 0,
				...(job.totalTokens?.window !== undefined ? { window: job.totalTokens.window } : {}),
				state: job.status,
				...(job.nestedChildren?.length ? { nestedChildren: job.nestedChildren } : {}),
			});
			continue;
		}
		for (const [offset, step] of steps.entries()) {
			if (!isActiveState(step.status)) continue;
			const index = step.index ?? offset;
			if (step.status === "pending" && job.mode === "chain" && !job.activeParallelGroup && index !== (job.currentStep ?? 0)) continue;
			const modelThinking = formatModelThinking(step.model, step.thinking) || undefined;
			entries.push({
				key: `async:${job.asyncId}:${index}`,
				...(linkedParentKey ? { parentKey: linkedParentKey } : {}),
				agent: step.agent,
				...(step.label ? { displayLabel: `${step.label} (${step.agent})` } : {}),
				...(modelThinking ? { modelThinking } : {}),
				description: step.description ?? job.description,
				...(job.label && !step.label ? { runLabel: job.label } : {}),
				...(job.workflowKey ? { workflowKey: job.workflowKey } : {}),
				startedAt: step.startedAt ?? startedAt,
				tokens: step.tokens?.total ?? (steps.length === 1 ? job.totalTokens?.total ?? 0 : 0),
				...((step.tokens?.window ?? (steps.length === 1 ? job.totalTokens?.window : undefined)) !== undefined
					? { window: step.tokens?.window ?? job.totalTokens?.window }
					: {}),
				state: step.status,
				...((step.children?.length ?? 0) > 0
					? { nestedChildren: step.children }
					: job.nestedChildren?.filter((nested) => nested.parentStepIndex === index).length
						? { nestedChildren: job.nestedChildren.filter((nested) => nested.parentStepIndex === index) }
						: {}),
			});
		}
	}

	if (state.currentSessionId) {
		try {
			for (const run of snapshotExternalRuns(state.currentSessionId, { ignoreMalformed: true, onMalformedRecord: (message) => console.warn(`[pi-subagents] Removed ${message}`) })) {
				if (!isActiveState(run.state)) continue;
				entries.push({
					key: `external:${run.id}`,
					agent: `external · ${run.label}`,
					description: run.currentAction ?? `source: ${run.source}`,
					startedAt: run.startedAt,
					tokens: 0,
					state: run.state,
					external: true,
				});
			}
		} catch (cause) {
			console.warn(`[pi-subagents] Failed to inspect external jobs: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}

	entries.push(...projectPaneEntries(state));
	return entries.sort((left, right) => left.startedAt - right.startedAt || left.key.localeCompare(right.key));
}

export class SubagentFleetStatus {
	private ctx: ExtensionContext | undefined;
	private ui: ExtensionContext["ui"] | undefined;
	private tui: FleetStatusTui | undefined;
	private inputUnsubscribe: (() => void) | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private widgetRegistered = false;
	private active = false;
	private selectedKey = "main";
	private inspectorOpen = false;
	private lastRenderKey = "";
	private lastPaint: { width: number; theme: Theme } | undefined;
	private prepaint: { key: string; width: number; theme: Theme; lines: string[] } | undefined;
	private entries: FleetStatusEntry[] = [];
	private workflowSnapshots = new Map<string, { snapshot: string; childRows: Set<string> }>();
	private readonly onWorkflowCoverageChange: FleetStatusOptions["onWorkflowCoverageChange"];
	private readonly seamDraw: FleetStatusOptions["seamDraw"];
	private readonly state: SubagentState;
	private readonly openInspector: (itemKey: string) => Promise<void> | void;
	private readonly refreshMs: number;
	private readonly maxAgentRows: number;
	private readonly placement: FleetViewPlacement;

	constructor(
		state: SubagentState,
		openInspector: (itemKey: string) => Promise<void> | void,
		options: FleetStatusOptions = {},
	) {
		this.state = state;
		this.openInspector = openInspector;
		this.refreshMs = options.refreshMs ?? REFRESH_MS;
		this.maxAgentRows = options.maxAgentRows ?? MAX_AGENT_ROWS;
		this.placement = options.placement ?? "belowEditor";
		this.onWorkflowCoverageChange = options.onWorkflowCoverageChange;
		this.seamDraw = options.seamDraw;
	}

	setContext(ctx: ExtensionContext): void {
		if (!ctx.hasUI) {
			this.clearUiRegistration();
			return;
		}
		const ui = ctx.ui;
		if (this.ui === ui) {
			this.ctx = ctx;
			this.refresh();
			return;
		}
		this.clearUiRegistration();
		this.ctx = ctx;
		this.ui = ui;
		if (typeof ui.onTerminalInput === "function") {
			this.inputUnsubscribe = ui.onTerminalInput((data) => this.handleKey(data));
		}
		this.timer = setInterval(() => this.refresh(), this.refreshMs);
		this.timer.unref?.();
		this.refresh();
	}

	dispose(): void {
		this.clearUiRegistration();
		this.ctx = undefined;
		this.ui = undefined;
		this.entries = [];
		this.active = false;
		this.selectedKey = "main";
		this.inspectorOpen = false;
		this.lastRenderKey = "";
	}

	refresh(): void {
		this.prepaint = undefined;
		const ctx = this.getActiveUiContext();
		if (!ctx) return;
		if (this.state.widgetsSuspended) {
			this.clearWidget();
			return;
		}
		this.entries = collectFleetStatusEntries(this.state);
		this.workflowSnapshots.clear();
		if (this.active && !this.inspectorOpen && !this.state.fleetInspectorOpen && this.onWorkflowCoverageChange) {
			const childrenByParent = new Map<string, AsyncJobState[]>();
			for (const child of this.state.asyncJobs.values()) {
				if (!child.parentWorkflowRunId) continue;
				const children = childrenByParent.get(child.parentWorkflowRunId) ?? [];
				children.push(child);
				childrenByParent.set(child.parentWorkflowRunId, children);
			}
			const attachedByParent = new Map<string, FleetStatusEntry[]>();
			for (const entry of this.entries) {
				if (!entry.parentKey) continue;
				const attached = attachedByParent.get(entry.parentKey) ?? [];
				attached.push(entry);
				attachedByParent.set(entry.parentKey, attached);
			}
			for (const job of this.state.asyncJobs.values()) {
				// Fleet does not expand attached workflow wrappers or step descendants.
				// Unknown/unsupported coverage deliberately retains the async tree.
				if (job.mode !== "workflow" || !isActiveState(job.status) || job.parentWorkflowRunId
					|| job.nestedChildren?.length || job.steps?.some((step) => step.children?.length)) continue;
				const key = `async:${job.asyncId}`;
				const children = childrenByParent.get(job.asyncId) ?? [];
				const attached = attachedByParent.get(key) ?? [];
				if (children.length && job.status !== "running") continue;
				// Even without workflow rows, these children plus their owner cannot fit.
				if (attached.length >= this.maxAgentRows) continue;
				const rowKeys = new Set<string>();
				let unsupported = false;
				for (const child of children) {
					if (!isActiveState(child.status) || (child.mode !== "single" && child.mode !== "parallel" && child.mode !== "chain")
						|| child.hostSteps?.length || child.workflowGraph
						|| childrenByParent.has(child.asyncId) || child.nestedChildren?.length
						|| child.steps?.some((step) => step.children?.length || step.runner || !isActiveState(step.status))) {
						unsupported = true; break;
					}
					const count = child.steps?.length || child.agents?.length || 0;
					if (!count || (child.stepsTotal ?? 0) > count || (child.chainStepCount ?? 0) > count) {
						unsupported = true; break;
					}
					for (let index = 0; index < count; index++) rowKeys.add(`async:${child.asyncId}:${child.steps?.[index]?.index ?? index}`);
				}
				if (unsupported || attached.length !== rowKeys.size || attached.some((entry) => !rowKeys.has(entry.key))) continue;
				this.workflowSnapshots.set(key, { snapshot: inlineWorkflowRenderKey(job, children), childRows: rowKeys });
			}
		}
		this.clampSelection();
		if (this.inspectorOpen || this.state.fleetInspectorOpen) {
			this.lastRenderKey = "";
			this.clearWidget();
			return;
		}
		if (!this.hasInlineSurface()) {
			this.active = false;
			this.selectedKey = "main";
			this.lastRenderKey = "";
			this.clearWidget();
			return;
		}

		const renderKey = this.getRenderKey();
		if (!this.active) this.clearWorkflowCoverage();
		// The async widget paints above the roster, so recompute coverage (structure and row fit) now.
		// Clearing it instead would flash the full workflow tree on every live-stat tick.
		else if (renderKey !== this.lastRenderKey && this.lastPaint) {
			const { width, theme } = this.lastPaint;
			this.prepaint = { key: renderKey, width, theme, lines: this.render(width, theme) };
		}
		if (!this.widgetRegistered) {
			ctx.ui.setWidget(FLEET_STATUS_WIDGET_KEY, (tui, theme) => {
				this.tui = tui;
				return {
					render: (width: number) => {
						this.lastPaint = { width, theme };
						const prepaint = this.prepaint;
						this.prepaint = undefined;
						if (prepaint && prepaint.key === this.lastRenderKey && prepaint.key === this.getRenderKey()
							&& prepaint.width === width && prepaint.theme === theme && !this.state.widgetsSuspended
							&& !this.inspectorOpen && !this.state.fleetInspectorOpen) return prepaint.lines;
						return this.render(width, theme);
					},
					invalidate: () => {
						this.lastRenderKey = "";
						this.prepaint = undefined;
					},
					dispose: () => {
						if (this.tui !== tui) return;
						this.prepaint = undefined;
						this.lastPaint = undefined;
						this.clearWorkflowCoverage();
						this.widgetRegistered = false;
						this.tui = undefined;
					},
				};
			}, { placement: this.placement });
			this.widgetRegistered = true;
			this.lastRenderKey = renderKey;
			return;
		}
		if (renderKey === this.lastRenderKey) {
			// Repaint anyway while anything is running so the wall-clock
			// spinner animates between state changes (500ms tick).
			if (this.entries.some((entry) => entry.state === "running")) this.tui?.requestRender();
			return;
		}
		this.lastRenderKey = renderKey;
		this.tui?.requestRender();
	}

	handleKey(data: string): { consume?: boolean; data?: string } | undefined {
		if (this.state.widgetsSuspended) return undefined;
		const ctx = this.getActiveUiContext();
		if (!ctx || this.entries.length === 0 || isKeyRelease(data)) return undefined;
		if (this.inspectorOpen) return undefined;
		if (!this.editorHasFocus()) {
			if (this.active) this.deactivate();
			return undefined;
		}
		if (!this.active) {
			const activates = matchesKey(data, "down") || matchesKey(data, "left");
			if (!activates || ctx.ui.getEditorText() !== "") return undefined;
			this.active = true;
			this.selectedKey = "main";
			this.refresh();
			return { consume: true };
		}

		// Surface tuning (CC parity): the roster renders expanded by default —
		// a flat agent list under a `● main` row. The `active` flag now only
		// gates interactive selection (↓/← , jk, enter), so key handling is
		// unchanged.
		const roster = this.rosterKeys();
		const selectedIndex = Math.max(0, roster.indexOf(this.selectedKey));
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selectedKey = roster[Math.min(roster.length - 1, selectedIndex + 1)] ?? "main";
			this.refresh();
			return { consume: true };
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (selectedIndex === 0) {
				this.deactivate();
				return { consume: true };
			}
			this.selectedKey = roster[selectedIndex - 1] ?? "main";
			this.refresh();
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			this.deactivate();
			return { consume: true };
		}
		if (matchesKey(data, Key.enter)) {
			if (this.selectedKey === "main") {
				this.deactivate();
				return { consume: true };
			}
			this.inspectorOpen = true;
			this.refresh();
			const selectedKey = this.selectedKey;
			void Promise.resolve()
				.then(() => this.openInspector(selectedKey))
				.catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"))
				.finally(() => {
					this.inspectorOpen = false;
					this.refresh();
				});
			return { consume: true };
		}

		this.deactivate();
		return undefined;
	}

	render(width: number, theme: Theme): string[] {
		if (!this.hasInlineSurface() || this.state.widgetsSuspended || this.inspectorOpen || this.state.fleetInspectorOpen) {
			this.clearWorkflowCoverage();
			return [];
		}
		// Surface tuning (CC parity): the roster renders expanded by default —
		// a flat agent list under a `● main` row. The `active` flag now only
		// gates interactive selection (↓/← , jk, enter), so key handling is
		// unchanged. Rendering projects a read-only PresentationFleetFrame and
		// delegates drawing to the seam (native adapter by default); state,
		// windowing, and coverage stay owned by this class.
		const workEntries = this.entries.filter((entry) => !entry.surface);
		const tree = fleetTreeRows(workEntries);
		const selectedTreeIndex = Math.max(0, tree.findIndex((row) => (row.kind === "owner" || row.kind === "child") && row.entry.key === this.selectedKey));
		const visibleCount = Math.min(this.maxAgentRows, tree.length);
		const start = selectedTreeIndex < visibleCount ? 0 : selectedTreeIndex - visibleCount + 1;
		const hiddenBelow = tree.length - (start + visibleCount);
		const { frame, treeKeyByIndex } = this.buildFleetFrame(tree, { start, visibleCount, hiddenBelow }, width, theme);
		const drawn = (this.seamDraw ?? drawNativeFleetFrame)(frame);
		this.applyWorkflowCoverage(tree, { start, visibleCount }, treeKeyByIndex, drawn.layout);
		return drawn.lines;
	}

	private buildFleetFrame(tree: FleetTreeRow[], window: { start: number; visibleCount: number; hiddenBelow: number }, width: number, theme: Theme): { frame: PresentationFleetFrame; treeKeyByIndex: Array<string | undefined> } {
		const rows: PresentationFleetRow[] = [];
		const treeKeyByIndex: Array<string | undefined> = new Array(tree.length).fill(undefined);
		const nestedSeq = new Map<string, number>();
		const isSelected = (key: string): boolean => this.active && this.selectedKey === key;
		rows.push({ rowKind: "main", rowKey: "main", ...(isSelected("main") ? { selected: true } : {}) });
		if (window.start > 0 && tree.length > 0) rows.push({ rowKind: "overflow", rowKey: "overflow:above", direction: "above", hidden: window.start });
		for (let index = window.start; index < window.start + window.visibleCount; index++) {
			const row = tree[index]!;
			if (row.kind === "owner" || row.kind === "child") {
				treeKeyByIndex[index] = row.entry.key;
				rows.push(fleetAgentFrameRow(row.entry, isSelected(row.entry.key), row.kind === "child" ? (row.last ? "└─" : "├─") : undefined));
			} else if (row.kind === "workflow") {
				const key = row.fullIndex !== undefined ? `${row.ownerKey}:wf:${row.fullIndex}` : `${row.ownerKey}:wf:overflow`;
				treeKeyByIndex[index] = key;
				rows.push(fleetLaneFrameRow(key, row.ownerKey, row.row, row.last ? "└─" : "├─", row.fullIndex));
			} else if (row.kind === "workflow-phase") {
				const key = `${row.ownerKey}:phase:${row.phase.key}`;
				treeKeyByIndex[index] = key;
				rows.push(fleetPhaseFrameRow(key, row.ownerKey, row.phase, row.last ? "└─" : "├─"));
			} else {
				const seq = (nestedSeq.get(row.ownerKey) ?? 0) + 1;
				nestedSeq.set(row.ownerKey, seq);
				const key = `${row.ownerKey}:nested:${seq}`;
				treeKeyByIndex[index] = key;
				rows.push(fleetNestedFrameRow(key, row.ownerKey, row.row, row.last ? "└─" : "├─"));
			}
		}
		if (window.hiddenBelow > 0) rows.push({ rowKind: "overflow", rowKey: "overflow:below", direction: "below", hidden: window.hiddenBelow });
		const panes = this.entries.filter((entry) => entry.surface === "project-pane");
		if (panes.length) {
			rows.push({ rowKind: "section-header", rowKey: "section:project-panes", text: "project panes" });
			for (const entry of panes) rows.push(fleetAgentFrameRow(entry, isSelected(entry.key)));
		}
		// Native collapsed-summary material (upstream roster semantics).
		const workEntries = this.entries.filter((entry) => !entry.surface);
		const nativeEntries = workEntries.filter((entry) => !entry.external && !entry.workflowWrapper && !entry.parentKey);
		const capacity = this.state.activeAsyncCapacity;
		const projectEntries = this.entries.filter((entry) => entry.surface === "project-pane");
		return {
			frame: {
				protocol: PRESENTATION_PROTOCOL_VERSION,
				surface: "fleet",
				revision: this.getRenderKey(),
				session: this.state.currentSessionId,
				runtimeGeneration: 0,
				width,
				theme: theme as unknown as PresentationFleetFrame["theme"],
				now: Date.now(),
				rows,
				selection: { active: this.active, selectedKey: this.selectedKey },
				budget: { visibleRows: window.visibleCount, hiddenAbove: window.start, hiddenBelow: window.hiddenBelow, maxRows: this.maxAgentRows },
				summary: {
					activeLeafAgents: activeLeafAgentCount(workEntries),
					anyExternal: workEntries.some((entry) => entry.external),
					...(capacity ? { capacity: { used: capacity.used, limit: capacity.limit } } : {}),
					nativeUsage: {
						tokens: nativeEntries.reduce((total, entry) => total + entry.tokens, 0),
						...(nativeEntries.length > 0 && nativeEntries.every((entry) => entry.window !== undefined)
							? { window: nativeEntries.reduce((total, entry) => total + entry.window!, 0) }
							: {}),
						count: nativeEntries.length,
					},
					hasWorkflowWrapper: workEntries.some((entry) => entry.workflowWrapper),
					panes: {
						total: projectEntries.length,
						attention: projectEntries.filter((entry) => entry.projectPane && projectPaneNeedsAttention(entry.projectPane)).length,
					},
				},
			},
			treeKeyByIndex,
		};
	}

	private applyWorkflowCoverage(tree: FleetTreeRow[], window: { start: number; visibleCount: number }, treeKeyByIndex: ReadonlyArray<string | undefined>, layout: PresentationDrawResult["layout"]): void {
		if (!this.ui || !this.widgetRegistered || !this.onWorkflowCoverageChange) return;
		const truncatedByKey = new Map(layout.map((entry) => [entry.rowKey, entry.truncated]));
		const fits = (treeIndex: number): boolean => truncatedByKey.get(treeKeyByIndex[treeIndex] ?? "") === false;
		const coverage = new Map<string, string>();
		for (const [key, { snapshot, childRows }] of this.workflowSnapshots) {
			const ownerIndex = tree.findIndex((row) => row.kind === "owner" && row.entry.key === key);
			const owner = tree[ownerIndex];
			if (owner?.kind !== "owner" || ownerIndex < window.start) continue;
			const count = childRows.size + (owner.entry.workflowRows?.length ?? 0) + (owner.entry.workflowChecklist?.phases.length ?? 0);
			if (!count || ownerIndex + count >= window.start + window.visibleCount) continue;
			const descendants = tree.slice(ownerIndex + 1, ownerIndex + count + 1);
			// Coverage trusts the actual drawn layout: a row counts as shown only
			// when its layout entry exists and reports an untruncated render.
			if (!descendants.every((row, offset) => {
				const treeIndex = ownerIndex + 1 + offset;
				if (row.kind === "workflow") return row.ownerKey === key && row.row.overflow === undefined && fits(treeIndex);
				if (row.kind === "workflow-phase") return row.ownerKey === key && fits(treeIndex);
				if (row.kind === "child") return childRows.has(row.entry.key) && fits(treeIndex);
				return false;
			})) continue;
			if (childRows.size && !fits(ownerIndex)) continue;
			coverage.set(key.slice("async:".length), snapshot);
		}
		this.onWorkflowCoverageChange(this.ui, coverage);
	}

	private rosterKeys(): string[] {
		return ["main", ...this.entries.map((entry) => entry.key)];
	}

	private clampSelection(): void {
		if (!this.rosterKeys().includes(this.selectedKey)) this.selectedKey = "main";
	}

	private deactivate(): void {
		this.active = false;
		this.selectedKey = "main";
		this.refresh();
	}

	private editorHasFocus(): boolean {
		// pi-tui exposes focus mutation but no focus getter, so inspect the focused
		// component structurally. instanceof is unreliable across jiti module boundaries.
		const focused = (this.tui as unknown as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		if (!focused || typeof focused !== "object") return false;
		const candidate = focused as Partial<EditorComponent>;
		return typeof candidate.render === "function"
			&& typeof candidate.invalidate === "function"
			&& typeof candidate.handleInput === "function"
			&& typeof candidate.getText === "function"
			&& typeof candidate.setText === "function";
	}

	private getRenderKey(): string {
		const now = Date.now();
		return JSON.stringify({
			active: this.active,
			selected: this.selectedKey,
			inspectorOpen: this.inspectorOpen,
			entries: this.entries.map((entry) => this.active
				? [
					entry.key,
					entry.surface,
					entry.parentKey,
					entry.agent,
					entry.displayLabel,
					entry.state,
					entry.modelThinking,
					entry.description,
					entry.external,
					Math.round((now - entry.startedAt) / 1000),
					entry.tokens,
					entry.workflowChecklist ? [
						entry.workflowChecklist.total,
						entry.workflowChecklist.done,
						entry.workflowChecklist.running,
						entry.workflowChecklist.queued,
						entry.workflowChecklist.blocked,
						entry.workflowChecklist.failed,
						entry.workflowChecklist.phases.map((phase) => [phase.key, phase.state, phase.done, phase.total, phase.running, phase.queued, phase.blocked, phase.failed, phase.items.map((item) => [item.key, item.state, item.currentTool, item.currentPath, item.durationMs, item.toolCount, item.error])]),
					] : undefined,
					visibleWorkflowRowsIndexed(entry.workflowRows, entry.parentKey ? 2 : 4).map(({ row }) => [
						row.kind,
						row.name,
						row.state,
						row.context,
						row.modelThinking,
						row.activity,
						row.startedAt,
						row.endedAt,
						row.durationMs,
						row.tokens,
						row.provider,
						row.role,
						row.verdict,
						row.reasonCode,
						row.detail,
						row.target,
						row.freshness,
						row.reportPath,
						row.overflow,
					]),
					nestedFleetRows(entry.nestedChildren, entry.parentKey ? 3 : 4).map((row) => [
						row.name,
						row.agentIdentity,
						row.state,
						row.modelThinking,
						row.activity,
						row.startedAt,
						row.endedAt,
						row.depth,
						row.overflow,
					]),
				]
				: [entry.key, entry.state, entry.external, entry.surface, entry.tokens, entry.projectPane?.refreshedAt, entry.projectPane?.summary]),
		});
	}

	private hasInlineSurface(): boolean {
		return this.entries.length > 0 || Boolean(this.state.activeAsyncCapacity?.used);
	}

	private getActiveUiContext(): ExtensionContext | undefined {
		const ctx = this.ctx;
		if (!ctx) return undefined;
		try {
			return ctx.hasUI ? ctx : undefined;
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
			this.clearUiRegistration();
			return undefined;
		}
	}

	private clearWidget(): void {
		this.prepaint = undefined;
		this.clearWorkflowCoverage();
		if (!this.widgetRegistered) return;
		try {
			this.ui?.setWidget(FLEET_STATUS_WIDGET_KEY, undefined);
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
			this.clearUiRegistration();
			return;
		}
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	private clearUiRegistration(): void {
		this.prepaint = undefined;
		this.clearWorkflowCoverage();
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;

		const inputUnsubscribe = this.inputUnsubscribe;
		const ui = this.ui;
		const widgetRegistered = this.widgetRegistered;
		this.inputUnsubscribe = undefined;
		this.ctx = undefined;
		this.ui = undefined;
		this.widgetRegistered = false;
		this.tui = undefined;

		const cleanupErrors: unknown[] = [];
		try {
			inputUnsubscribe?.();
		} catch (error) {
			if (!isStaleExtensionContextError(error)) cleanupErrors.push(error);
		}
		if (ui && widgetRegistered) {
			try {
				ui.setWidget(FLEET_STATUS_WIDGET_KEY, undefined);
			} catch (error) {
				if (!isStaleExtensionContextError(error)) cleanupErrors.push(error);
			}
		}
		if (cleanupErrors.length === 1) throw cleanupErrors[0];
		if (cleanupErrors.length > 1) {
			throw new AggregateError(cleanupErrors, "Failed to clean up FleetView UI registration");
		}
	}

	private clearWorkflowCoverage(): void {
		if (this.ui) this.onWorkflowCoverageChange?.(this.ui, new Map());
	}
}
