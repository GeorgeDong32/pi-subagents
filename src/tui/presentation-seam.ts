/**
 * Presentation seam — the versioned, in-process registration entry that lets
 * another extension replace the *drawing* of pi-subagents surfaces (the
 * below-editor Fleet roster today; async rows to follow) while this extension
 * keeps ownership of state, navigation, widgets, and coverage.
 *
 * Transport is the pi event bus (`pi.events`): string channels, unknown
 * payloads, in-process only. Every payload carries an exact `protocol` major
 * version; mismatches are "unsupported", never best-effort parsed.
 *
 * Naming note: until this ships upstream, nothing outside this repository may
 * claim these events exist. The CC-TUI repository consumes them through a
 * mirrored minimal protocol type, never by importing this module.
 */

export const PRESENTATION_PROTOCOL_VERSION = 1;

export const PRESENTATION_READY_EVENT = "pi-subagents:presentation:v1:ready";
export const PRESENTATION_PROBE_EVENT = "pi-subagents:presentation:v1:probe";
export const PRESENTATION_REGISTER_EVENT = "pi-subagents:presentation:v1:register";
export const PRESENTATION_WITHDRAW_EVENT = "pi-subagents:presentation:v1:withdraw";
export const PRESENTATION_DIAGNOSTIC_EVENT = "pi-subagents:presentation:v1:diagnostic";

export type PresentationSurface = "fleet" | "async";

/** Minimal structural mirror of the pi event bus as the seam needs it. */
export interface PresentationEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Minimal theme seam consumers may assume. Drawing must tolerate missing keys. */
export interface PresentationTheme {
	fg: (name: string, text: string) => string;
	bold?: (text: string) => string;
	getThinkingBorderColor?: (level: string) => (text: string) => string;
}

export interface PresentationUsage {
	tokens: number;
	window?: number;
}

/** Timing material. `durationMs` wins over ended-started once terminal. */
export interface PresentationTiming {
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
}

export interface PresentationWorkflowPreflightHints {
	mode?: string;
	decision?: string;
	claims?: string[];
	expectedOutput?: string;
	independence?: string;
}

/** Detail hints shared by workflow lanes and host steps. */
export interface PresentationRowDetails {
	provider?: string;
	role?: string;
	target?: string;
	detail?: string;
	reasonCode?: string;
	freshness?: { stale?: boolean; observedRef?: string };
	reportPath?: string;
}

export interface PresentationWorkflowLaneRow extends PresentationTiming, PresentationRowDetails {
	rowKind: "workflow-lane";
	rowKey: string;
	ownerKey: string;
	branch: "├─" | "└─";
	/** Present only for typed host-owned monitor rows. */
	kind?: string;
	name: string;
	context?: string;
	modelThinking?: string;
	thinking?: string;
	state: string;
	verdict?: string;
	activity?: string;
	preflight?: PresentationWorkflowPreflightHints;
	usage?: PresentationUsage;
	/** Set on the synthetic `+N hidden` row; such rows are never fully covered. */
	overflow?: number;
}

export interface PresentationWorkflowPhaseRow {
	rowKind: "workflow-phase";
	rowKey: string;
	ownerKey: string;
	branch: "├─" | "└─";
	/** Raw phase label. */
	label: string;
	/** Pre-formatted `label · counts` display text from the checklist projection. */
	text: string;
	state: string;
}

export interface PresentationNestedRow extends PresentationTiming {
	rowKind: "nested";
	rowKey: string;
	ownerKey: string;
	branch: "├─" | "└─";
	name: string;
	agentIdentity?: string;
	state: string;
	modelThinking?: string;
	thinking?: string;
	activity?: string;
	usage?: PresentationUsage;
	depth: number;
	/** Set on the synthetic `+N nested leaves` row. */
	overflow?: number;
}

export interface PresentationAgentRow extends PresentationTiming {
	rowKind: "agent";
	rowKey: string;
	/** Control target for inspector routing; defaults to rowKey. */
	targetKey?: string;
	parentKey?: string;
	branch?: "├─" | "└─";
	agentIdentity: string;
	/** Resolved display label (redaction filtered, whitespace-normalized, untruncated). */
	label?: string;
	modelThinking?: string;
	state: string;
	usage?: PresentationUsage;
	workflowWrapperUsageOnChildren?: boolean;
	projectPane?: { summary?: string; refreshedAt: number };
	external?: boolean;
	/** True while interactive selection points at this row (provider-owned). */
	selected?: boolean;
}

export type PresentationFleetRow =
	| { rowKind: "main"; rowKey: "main"; selected?: boolean }
	| { rowKind: "overflow"; rowKey: string; direction: "above" | "below"; hidden: number }
	| PresentationAgentRow
	| PresentationWorkflowLaneRow
	| PresentationWorkflowPhaseRow
	| PresentationNestedRow
	| { rowKind: "section-header"; rowKey: string; text: string };

export interface PresentationFrameBase {
	protocol: typeof PRESENTATION_PROTOCOL_VERSION;
	surface: PresentationSurface;
	/** Opaque revision: any visible change produces a new value. */
	revision: string;
	session: string | null;
	runtimeGeneration: number;
	/** Draw environment, owner-provided per frame. */
	width: number;
	theme: PresentationTheme;
	now: number;
}

export interface PresentationFleetFrame extends PresentationFrameBase {
	surface: "fleet";
	rows: PresentationFleetRow[];
	selection: { active: boolean; selectedKey: string | null };
	budget: { visibleRows: number; hiddenAbove: number; hiddenBelow: number; maxRows: number };
}

export type PresentationFrame = PresentationFleetFrame;

export interface PresentationLayoutRow {
	rowKey: string;
	fromLine: number;
	toLine: number;
	/** True when the row's full content did not fit the width. */
	truncated: boolean;
}

export interface PresentationDrawResult {
	lines: string[];
	layout: PresentationLayoutRow[];
}

export type PresentationDraw = (frame: PresentationFrame) => PresentationDrawResult;

export interface PresentationAdapterRequest {
	/** Stable identity of the registering extension/adapter. */
	identity: string;
	/** Session the adapter registered from; must match the host session. */
	session?: string | null;
	/** Runtime generation the adapter observed; stale generations are rejected. */
	runtimeGeneration?: number;
	surfaces: Partial<Record<PresentationSurface, PresentationDraw>>;
}

export interface PresentationRegistrationHandle {
	token: string;
	identity: string;
	generation: number;
	surfaces: PresentationSurface[];
	dispose(): void;
}

export type PresentationRegistrationStatus =
	| { status: "activated"; handle: PresentationRegistrationHandle; surfaces: PresentationSurface[] }
	| { status: "replaced"; handle: PresentationRegistrationHandle; surfaces: PresentationSurface[] }
	| { status: "not-ready"; reason: string }
	| { status: "incompatible"; reason: string }
	| { status: "conflict"; reason: string };

interface PresentationRegisterEnvelope {
	protocol: number;
	replyChannel: string;
	request: PresentationAdapterRequest;
}

interface PresentationWithdrawEnvelope {
	protocol: number;
	token: string;
}

export interface PresentationReadyPayload {
	protocol: number;
	surfaces: PresentationSurface[];
	session: string | null;
	runtimeGeneration: number;
	events: {
		ready: typeof PRESENTATION_READY_EVENT;
		register: typeof PRESENTATION_REGISTER_EVENT;
		withdraw: typeof PRESENTATION_WITHDRAW_EVENT;
		diagnostic: typeof PRESENTATION_DIAGNOSTIC_EVENT;
	};
}

export interface PresentationDiagnosticPayload {
	protocol: number;
	identity: string;
	surface: PresentationSurface;
	reason: string;
	/** Per session+identity+reason occurrence count; emitted only on first occurrence. */
	occurrence: number;
}

export interface PresentationSeamHostOptions {
	events: PresentationEventBus;
	session: () => string | null;
	/** Increments whenever the host runtime is replaced (disable/session_shutdown). */
	runtimeGeneration?: () => number;
	/** Native drawing per surface — the fallback and default owner of last resort. */
	native: Partial<Record<PresentationSurface, PresentationDraw>>;
	onAdapterChange?: (surface: PresentationSurface, active: string | undefined) => void;
	/** Non-TUI hosts never activate; registration replies "not-ready". */
	activated?: () => boolean;
}

interface RegisteredAdapter {
	token: string;
	identity: string;
	generation: number;
	surfaces: Map<PresentationSurface, PresentationDraw>;
	disposed: boolean;
}

/**
 * Host side of the seam. Owns adapter registration, validation, draw dispatch
 * with native fallback, and deduped diagnostics. The host never exposes task
 * executors or state maps through the seam — only frames in, draw results out.
 */
export class PresentationSeamHost {
	private readonly options: PresentationSeamHostOptions;
	private readonly adapters = new Map<PresentationSurface, RegisteredAdapter>();
	private readonly adaptersByToken = new Map<string, RegisteredAdapter>();
	private readonly diagnostics = new Map<string, number>();
	private generation = 0;
	private active = false;
	private sessionValue: string | null = null;
	private readonly unsubscribers: Array<() => void> = [];

	constructor(options: PresentationSeamHostOptions) {
		this.options = options;
		this.unsubscribers.push(
			options.events.on(PRESENTATION_PROBE_EVENT, (raw) => {
				if (this.isValidProtocol(raw) && this.isReady()) this.broadcastReady();
			}),
			options.events.on(PRESENTATION_REGISTER_EVENT, (raw) => { void this.handleRegister(raw); }),
			options.events.on(PRESENTATION_WITHDRAW_EVENT, (raw) => this.handleWithdraw(raw)),
		);
	}

	/** Activate on session_start (TUI only): records session, broadcasts ready. */
	activate(session: string | null): void {
		this.active = true;
		this.sessionValue = session;
		this.broadcastReady();
	}

	/** Withdraw point (disable/session_shutdown): drops adapters, bumps generation. */
	deactivate(): void {
		this.generation += 1;
		this.active = false;
		this.sessionValue = null;
		for (const adapter of [...this.adaptersByToken.values()]) this.disposeAdapter(adapter);
		this.diagnostics.clear();
	}

	dispose(): void {
		this.deactivate();
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.unsubscribers.length = 0;
	}

	currentSession(): string | null {
		return this.sessionValue;
	}

	currentGeneration(): number {
		return this.options.runtimeGeneration?.() ?? this.generation;
	}

	activeAdapterIdentity(surface: PresentationSurface): string | undefined {
		return this.adapters.get(surface)?.identity;
	}

	/**
	 * Dispatch one frame. Adapter failures, invalid layouts, and missing
	 * adapters all fall back to the native drawing for that frame; failures
	 * emit deduped diagnostics and clear coverage expectations by marking the
	 * result as native-drawn.
	 */
	draw(surface: PresentationSurface, frame: PresentationFrame): { result: PresentationDrawResult; native: boolean } {
		const native = this.options.native[surface];
		if (!native) return { result: { lines: [], layout: [] }, native: true };
		if (!this.isReady()) return { result: native(frame), native: true };
		const adapter = this.adapters.get(surface);
		if (!adapter) return { result: native(frame), native: true };
		try {
			const result = adapter.surfaces.get(surface)?.(frame);
			if (this.isValidDrawResult(result, frame)) return { result, native: false };
			this.reportDiagnostic(adapter, surface, result === undefined ? "adapter returned undefined" : "adapter layout does not match frame rows");
		} catch (error) {
			this.reportDiagnostic(adapter, surface, error instanceof Error ? error.message : String(error));
		}
		return { result: native(frame), native: true };
	}

	private isReady(): boolean {
		return this.active && (this.options.activated?.() ?? true);
	}

	private broadcastReady(): void {
		const surfaces = Object.keys(this.options.native) as PresentationSurface[];
		this.options.events.emit(PRESENTATION_READY_EVENT, {
			protocol: PRESENTATION_PROTOCOL_VERSION,
			surfaces,
			session: this.sessionValue,
			runtimeGeneration: this.currentGeneration(),
			events: {
				ready: PRESENTATION_READY_EVENT,
				register: PRESENTATION_REGISTER_EVENT,
				withdraw: PRESENTATION_WITHDRAW_EVENT,
				diagnostic: PRESENTATION_DIAGNOSTIC_EVENT,
			},
		} satisfies PresentationReadyPayload);
	}

	private async handleRegister(raw: unknown): Promise<void> {
		const envelope = this.asRegisterEnvelope(raw);
		if (!envelope) return;
		const { replyChannel, request } = envelope;
		const reply = (payload: unknown): void => { this.options.events.emit(replyChannel, payload); };
		if (!this.isValidProtocol(raw)) return reply({ status: "incompatible", reason: `protocol ${PRESENTATION_PROTOCOL_VERSION} required` });
		if (!this.isReady()) return reply({ status: "not-ready", reason: "presentation host is not active (non-TUI or between sessions)" });
		if (typeof request?.identity !== "string" || !request.identity) return reply({ status: "incompatible", reason: "adapter identity is required" });
		const session = this.sessionValue;
		if (request.session !== undefined && request.session !== null && request.session !== session) {
			return reply({ status: "not-ready", reason: "adapter registered for a different session" });
		}
		const generation = this.currentGeneration();
		if (request.runtimeGeneration !== undefined && request.runtimeGeneration !== generation) {
			return reply({ status: "not-ready", reason: "adapter observed a stale runtime generation" });
		}
		const requested = Object.entries(request.surfaces ?? {}) as Array<[PresentationSurface, unknown]>;
		const surfaces: PresentationSurface[] = [];
		for (const [surface, draw] of requested) {
			if (surface !== "fleet" && surface !== "async") continue;
			if (typeof draw !== "function") continue;
			if (!(surface in this.options.native)) continue;
			surfaces.push(surface);
		}
		if (!surfaces.length) return reply({ status: "incompatible", reason: "no supported surface with a drawing function" });

		const conflicts = surfaces.filter((surface) => {
			const incumbent = this.adapters.get(surface);
			return incumbent !== undefined && incumbent.identity !== request.identity;
		});
		if (conflicts.length) {
			return reply({ status: "conflict", reason: `surface already owned by ${this.adapters.get(conflicts[0]!)?.identity ?? "another adapter"}` });
		}

		// Same-identity re-registration replaces the earlier handle (the old
		// token cannot withdraw the newer registration).
		const previous = surfaces.map((surface) => this.adapters.get(surface)).find(Boolean);
		if (previous) this.disposeAdapter(previous);

		const token = `presentation:${request.identity}:${generation}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
		const adapter: RegisteredAdapter = {
			token,
			identity: request.identity,
			generation,
			surfaces: new Map(surfaces.map((surface) => [surface, request.surfaces![surface]!])),
			disposed: false,
		};
		this.adaptersByToken.set(token, adapter);
		for (const surface of surfaces) {
			this.adapters.set(surface, adapter);
			this.diagnostics.delete(`${adapter.identity}:${surface}`);
			this.options.onAdapterChange?.(surface, adapter.identity);
		}
		const handle: PresentationRegistrationHandle = {
			token,
			identity: adapter.identity,
			generation,
			surfaces,
			dispose: () => this.disposeByToken(token),
		};
		reply({ status: previous ? "replaced" : "activated", handle, surfaces });
	}

	private handleWithdraw(raw: unknown): void {
		if (!this.isValidProtocol(raw)) return;
		const envelope = raw as PresentationWithdrawEnvelope;
		if (typeof envelope.token !== "string") return;
		this.disposeByToken(envelope.token);
	}

	private disposeByToken(token: string): void {
		const adapter = this.adaptersByToken.get(token);
		if (!adapter) return;
		this.disposeAdapter(adapter);
	}

	private disposeAdapter(adapter: RegisteredAdapter): void {
		adapter.disposed = true;
		this.adaptersByToken.delete(adapter.token);
		for (const [surface, incumbent] of [...this.adapters.entries()]) {
			if (incumbent === adapter) {
				this.adapters.delete(surface);
				this.options.onAdapterChange?.(surface, undefined);
			}
		}
	}

	private isValidProtocol(raw: unknown): boolean {
		return typeof raw === "object" && raw !== null && (raw as { protocol?: unknown }).protocol === PRESENTATION_PROTOCOL_VERSION;
	}

	private asRegisterEnvelope(raw: unknown): PresentationRegisterEnvelope | undefined {
		if (typeof raw !== "object" || raw === null) return undefined;
		const envelope = raw as PresentationRegisterEnvelope;
		if (typeof envelope.replyChannel !== "string" || !envelope.replyChannel) return undefined;
		return envelope;
	}

	/**
	 * Layout validation: row keys must reference frame rows, line ranges must
	 * be within bounds and not overlap. Trusted for coverage decisions only
	 * after this check.
	 */
	private isValidDrawResult(result: unknown, frame: PresentationFrame): result is PresentationDrawResult {
		if (typeof result !== "object" || result === null) return false;
		const candidate = result as Partial<PresentationDrawResult>;
		if (!Array.isArray(candidate.lines) || !Array.isArray(candidate.layout)) return false;
		if (!candidate.lines.every((line) => typeof line === "string")) return false;
		if (candidate.layout.length !== frame.rows.length) return false;
		const rowKeys = new Set(frame.rows.map((row) => row.rowKey));
		let previousEnd = -1;
		for (const entry of candidate.layout) {
			if (typeof entry?.rowKey !== "string" || !rowKeys.has(entry.rowKey)) return false;
			if (!Number.isInteger(entry.fromLine) || !Number.isInteger(entry.toLine)) return false;
			if (entry.fromLine < 0 || entry.toLine < entry.fromLine || entry.toLine >= candidate.lines.length) return false;
			if (entry.fromLine <= previousEnd) return false;
			previousEnd = entry.toLine;
		}
		return true;
	}

	private reportDiagnostic(adapter: RegisteredAdapter, surface: PresentationSurface, reason: string): void {
		const key = `${adapter.identity}:${surface}:${reason}`;
		const occurrence = (this.diagnostics.get(key) ?? 0) + 1;
		this.diagnostics.set(key, occurrence);
		if (occurrence > 1) return;
		this.options.events.emit(PRESENTATION_DIAGNOSTIC_EVENT, {
			protocol: PRESENTATION_PROTOCOL_VERSION,
			identity: adapter.identity,
			surface,
			reason,
			occurrence,
		} satisfies PresentationDiagnosticPayload);
	}
}

/** Client-side registration helper (for in-repo consumers and contract tests). */
export async function requestPresentationRegistration(options: {
	events: PresentationEventBus;
	identity: string;
	surfaces: Partial<Record<PresentationSurface, PresentationDraw>>;
	session?: string | null;
	runtimeGeneration?: number;
	/** Bounded handshake wait; no permanent retry timers. */
	timeoutMs?: number;
}): Promise<PresentationRegistrationStatus> {
	const nonce = Math.random().toString(36).slice(2, 10);
	const replyChannel = `pi-subagents:presentation:v1:reply:${nonce}`;
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const unsubscribe = options.events.on(replyChannel, (payload) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			unsubscribe();
			resolve(payload as PresentationRegistrationStatus);
		});
		if (options.timeoutMs !== undefined) {
			timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				unsubscribe();
				resolve({ status: "not-ready", reason: "registration handshake timed out" });
			}, options.timeoutMs);
			timer.unref?.();
		}
		options.events.emit(PRESENTATION_REGISTER_EVENT, {
			protocol: PRESENTATION_PROTOCOL_VERSION,
			replyChannel,
			request: {
				identity: options.identity,
				session: options.session,
				runtimeGeneration: options.runtimeGeneration,
				surfaces: options.surfaces,
			},
		});
	});
}

/** Client-side probe: resolves with the ready payload, or null when no host answers in time. */
export async function probePresentationHost(options: {
	events: PresentationEventBus;
	timeoutMs?: number;
}): Promise<PresentationReadyPayload | null> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const unsubscribe = options.events.on(PRESENTATION_READY_EVENT, (payload) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			unsubscribe();
			resolve(payload as PresentationReadyPayload);
		});
		timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			unsubscribe();
			resolve(null);
		}, options.timeoutMs ?? 1_000);
		timer.unref?.();
		options.events.emit(PRESENTATION_PROBE_EVENT, { protocol: PRESENTATION_PROTOCOL_VERSION });
	});
}
