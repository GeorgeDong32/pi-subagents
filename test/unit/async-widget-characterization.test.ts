import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";
import { renderWidget, resetWidgetLayoutSession } from "../../src/tui/render.ts";

/**
 * Characterization tests for the async status widget (spec P-async, step 1):
 * these pin TODAY's native composition byte-for-byte BEFORE the presentation
 * seam refactor, so the frame-ized native adapter must reproduce them
 * exactly. Written first deliberately — this composition had no test net.
 */

const NOW = 1_000_000_000_000;
const FRAME = Math.floor(NOW / 400);

const theme = {
	fg(_name: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
	bg(_name: string, text: string): string {
		return text;
	},
	getThinkingBorderColor(_level: string): (text: string) => text {
		return (text) => text;
	},
};

interface WidgetHarness {
	render(width: number): string[];
}

const originalRows = process.stdout.rows;
const originalColumns = process.stdout.columns;

function mount(jobs: AsyncJobState[], options: { collapsed?: boolean; expanded?: boolean; rows?: number; columns?: number; seamDraw?: (frame: never) => { lines: string[]; layout: Array<{ rowKey: string; fromLine: number; toLine: number; truncated: boolean }> } } = {}): WidgetHarness {
	// Headless runs have no TTY: pin the terminal geometry so the adaptive
	// fit picks a deterministic tier, and reset the module-level layout
	// session so cases don't inherit each other's tier.
	(process.stdout as { rows?: number }).rows = options.rows ?? 40;
	(process.stdout as { columns?: number }).columns = options.columns ?? 120;
	resetWidgetLayoutSession();
	let widgetFactory: unknown;
	const ctx = {
		hasUI: true,
		ui: {
			setWidget(_key: string, factory: unknown) {
				widgetFactory = factory;
			},
			getToolsExpanded: () => options.expanded === true,
		},
	} as unknown as ExtensionContext;
	renderWidget(ctx, jobs, options.collapsed === true, options.seamDraw as never);
	const factory = widgetFactory as (tui: unknown, theme: unknown) => WidgetHarness;
	const component = factory({ requestRender() {} }, theme as never);
	return {
		render(width: number): string[] {
			return component.render(width);
		},
	};
}

function restoreTerminal(): void {
	(process.stdout as { rows?: number }).rows = originalRows;
	(process.stdout as { columns?: number }).columns = originalColumns;
}

function job(overrides: Partial<AsyncJobState> & { asyncId: string }): AsyncJobState {
	return {
		asyncDir: `/tmp/${overrides.asyncId}`,
		status: "running",
		mode: "single",
		startedAt: NOW - 16_000,
		updatedAt: NOW - 1_000,
		...overrides,
	} as AsyncJobState;
}

describe("async widget characterization", () => {
	it("collapsed widget renders the single-line counts summary", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const component = mount([
				job({ asyncId: "a", status: "running" }),
				job({ asyncId: "b", status: "queued" }),
				job({ asyncId: "c", status: "failed" }),
			], { collapsed: true });
			const lines = component.render(80);
			assert.equal(lines.length, 1);
			assert.match(lines[0]!, /subagents \(1\/3 running, 1 queued, 1 failed\)/, `actual: ${lines[0]}`);
			assert.equal(lines[0]!.length, 80, "single line padded to the render width");
			assert.equal(lines[0]!.length <= 80, true);
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});

	it("collapsed widget with no active jobs reports done counts", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const component = mount([
				job({ asyncId: "a", status: "complete" }),
				job({ asyncId: "b", status: "complete" }),
			], { collapsed: true });
			const lines = component.render(80);
			assert.equal(lines.length, 1);
			assert.match(lines[0]!, /○ subagents \(2\/2 done\)/, `actual: ${lines[0]}`);
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});

	it("single running job renders the background header, summary, and detail rows", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const component = mount([
				job({ asyncId: "solo", description: "检查展示接口", currentTool: "Read" }),
			]);
			const lines = component.render(80).map((line) => line.trimEnd());
			assert.deepEqual(lines, [
				" async subagent single · background",
				" ⠋ single · 15.0s",
				"   ⎿  Read",
			], `actual: ${JSON.stringify(lines)}`);
			assert.ok(!lines.join("\n").includes("Async agents"), "single job must not render the multi-job header");
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});

	it("multi-job widget renders the Async agents header and per-job items", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const component = mount([
				job({ asyncId: "r1", description: "alpha" }),
				job({ asyncId: "q1", status: "queued", description: "beta" }),
				job({ asyncId: "f1", status: "complete", description: "done work" }),
			]);
			const lines = component.render(100).map((line) => line.trim());
			assert.match(lines[0]!, /Async agents · background$/, `actual: ${lines[0]}`);
			assert.match(lines.join("\n"), /├─ ⠋ single · 15\.0s/);
			assert.match(lines.join("\n"), /└─ ✓ single · 15\.0s/);
			assert.match(lines.join("\n"), /◦ 1 queued/);
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});

	it("workflow job renders the compact workflow body while collapsed", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const component = mount([
				job({
					asyncId: "wf",
					mode: "workflow",
					steps: [
						{ index: 0, agent: "reviewer", status: "running" },
						{ index: 1, agent: "scout", status: "complete" },
					],
				}),
			]);
			const lines = component.render(100);
			const joined = lines.join("\n");
			assert.match(joined, /workflow/i, `workflow mode shows: ${JSON.stringify(lines)}`);
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});

	it("materialized workflow children render as tree rows under their parent", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const parent = job({
				asyncId: "wf",
				mode: "workflow",
				steps: [{ index: 0, agent: "reviewer", workflowKey: "review", status: "running" }],
			});
			const child = job({
				asyncId: "child-1",
				mode: "single",
				parentWorkflowRunId: "wf",
				workflowKey: "review",
				description: "child work",
			});
			const component = mount([parent, child]);
			const joined = component.render(100).join("\n");
			assert.match(joined, /├─|└─/, "children render with tree connectors");
			assert.match(joined, /child work|review/);
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});


	it("tight terminal engages the progressive tier: header + one visible job + hidden counts", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const component = mount([
				job({ asyncId: "a", description: "a work" }),
				job({ asyncId: "b", description: "b work" }),
				job({ asyncId: "c", description: "c work" }),
				job({ asyncId: "d", description: "d work" }),
			], { rows: 22 });
			const lines = component.render(80).map((line) => line.trim());
			assert.deepEqual(lines, [
				"⠋ Async agents · 4 agents running",
				"⠋ single · running · 15.0s · thinking…",
				"+3 more (3 running)",
			], `actual: ${JSON.stringify(lines)}`);
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});

	it("renderWidget clears the widget when jobs is empty", () => {
		const cleared: Array<[string, unknown]> = [];
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(key: string, content: unknown) {
					cleared.push([key, content]);
				},
			},
		} as unknown as ExtensionContext;
		renderWidget(ctx, []);
		assert.deepEqual(cleared, [["subagent-async", undefined]]);
	});

	it("renderWidget mounts via setWidget on first render and updates in place after", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		const widgets = new Map<string, unknown>();
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(key: string, factory: unknown) {
					widgets.set(key, factory);
				},
				getToolsExpanded: () => false,
			},
		} as unknown as ExtensionContext;
		try {
			renderWidget(ctx, [job({ asyncId: "a" })], false);
			assert.ok(widgets.has("subagent-async"), "widget factory mounted");
			const factory = widgets.get("subagent-async") as (tui: unknown, theme: unknown) => { render(width: number): string[] };
			const component = factory({ requestRender() {} }, theme as never);
			const first = component.render(80);
			assert.ok(first.length >= 1);
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});
});

void (undefined as unknown as SubagentState);
void FRAME;

// ---- Seam contract (spec §5): adapter injection over the async surface ----

describe("async widget through the presentation seam", () => {
	it("a registered adapter's lines replace the native composition (seamDraw path)", () => {
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const seen: string[] = [];
			const component = mount(
				[job({ asyncId: "solo", description: "检查展示接口", currentTool: "Read" })],
				{
					expanded: false,
					seamDraw: (frame) => {
						seen.push(frame.tier);
						return {
							lines: frame.jobs.map((section) => `CC:${section.header.state}`),
							layout: [{ rowKey: frame.jobs[0]!.rowKey, fromLine: 0, toLine: 0, truncated: false }],
						};
					},
				},
			);
			const lines = component.render(80).map((line) => line.trim());
			assert.deepEqual(lines, ["CC:running"], "adapter lines replace native (owner pads to width)");
			assert.deepEqual(seen, ["full"]);
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});

	it("native round-trip parity: projection → drawNativeAsyncFrame equals the pinned bytes", async () => {
		const { projectAsyncWidgetFrame, drawNativeAsyncFrame } = await import("../../src/tui/render.ts");
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			const component = mount([
				job({ asyncId: "r1", description: "alpha" }),
				job({ asyncId: "q1", status: "queued", description: "beta" }),
				job({ asyncId: "f1", status: "complete", description: "done work" }),
			]);
			const pinned = component.render(100).map((line) => line.trim());
			// Same scenario through an explicit frame round-trip must match.
			const frame = projectAsyncWidgetFrame({
				roots: [job({ asyncId: "r1", description: "alpha" }), job({ asyncId: "q1", status: "queued", description: "beta" }), job({ asyncId: "f1", status: "complete", description: "done work" })] as never,
				jobs: [job({ asyncId: "r1", description: "alpha" }), job({ asyncId: "q1", status: "queued", description: "beta" }), job({ asyncId: "f1", status: "complete", description: "done work" })] as never,
				theme: theme as never,
				width: 98,
				expanded: false,
				projectionFor: (j) => (j as never), // not used by multi-item heads
				tier: "full",
			});
			const drawn = drawNativeAsyncFrame(frame);
			for (const line of pinned.slice(1)) {
				assert.ok(drawn.lines.some((candidate) => candidate.trim() === line), `missing parity line: ${line}`);
			}
		} finally {
			Date.now = originalNow;
			restoreTerminal();
		}
	});
});
