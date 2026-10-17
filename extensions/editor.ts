import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { TUI, EditorTheme } from "@earendil-works/pi-tui";
import { getInlineSlashPrefix } from "./autocomplete.js";

type InlineContext = Readonly<{ line: number; startCol: number }>;
type Owner = Readonly<{ kind: "native" }> | Readonly<{ kind: "inline"; context: InlineContext }>;
type RequestOptions = { force: boolean; explicitTab: boolean };
type OwnedRequest = Readonly<{ owner: Owner; options: RequestOptions }>;
type MenuState = "regular" | "force";
type SuggestionBatch = { prefix: string; items: unknown[] };

type NativeAutocomplete = {
	autocompleteStartToken: number;
	autocompleteList?: object;
	autocompleteState: MenuState | null;
	autocompleteTriggerPattern: { test(text: string): boolean };
	isInSlashCommandContext(textBeforeCursor: string): boolean;
	requestAutocomplete(options: RequestOptions): void;
	runAutocompleteRequest(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
		options: RequestOptions,
	): Promise<void>;
	applyAutocompleteSuggestions(suggestions: SuggestionBatch, state: MenuState): void;
	cancelAutocompleteRequest(): void;
	clearAutocompleteUi(): void;
	cancelAutocomplete(): void;
};

/**
 * InlineSlashEditor wraps CustomEditor to trigger autocomplete for inline slash commands.
 * Pi's base Editor intentionally filters '/' from triggerCharacters and only checks
 * slash contexts at the start of a message. By intercepting handleInput, InlineSlashEditor
 * detects inline slash patterns and explicitly triggers autocomplete.
 */
export class InlineSlashEditor extends CustomEditor {
	private readonly getToolsExpanded?: () => boolean;
	private readonly ownership = new WeakMap<RequestOptions, OwnedRequest>();
	private pending?: { startToken: number; request: OwnedRequest };
	private running?: OwnedRequest;
	private inlineMenu?: { list: object; context: InlineContext };
	private queuedOwner?: Owner;
	private nativeRequest!: NativeAutocomplete["requestAutocomplete"];
	private nativeRun!: NativeAutocomplete["runAutocompleteRequest"];
	private nativeApply!: NativeAutocomplete["applyAutocompleteSuggestions"];

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		options?: { embedWorkingStatus?: boolean; getToolsExpanded?: () => boolean },
	) {
		super(tui, theme, keybindings, options);
		this.getToolsExpanded = options?.getToolsExpanded;
		this.installOwnershipAdapters();
	}

	private nativeSurface(): NativeAutocomplete {
		// SAFETY: Native Editor declares these members private. One assertion adapts the instance; scheduling stays native.
		return this as unknown as NativeAutocomplete;
	}

	private installOwnershipAdapters(): void {
		const native = this.nativeSurface();
		this.nativeRequest = native.requestAutocomplete.bind(this);
		this.nativeRun = native.runAutocompleteRequest.bind(this);
		this.nativeApply = native.applyAutocompleteSuggestions.bind(this);
		native.requestAutocomplete = this.requestOwnedAutocomplete.bind(this);
		native.runAutocompleteRequest = this.runOwnedAutocomplete.bind(this);
		native.applyAutocompleteSuggestions = this.applyOwnedSuggestions.bind(this);
	}

	private currentInlineContext(): InlineContext | undefined {
		const cursor = this.getCursor();
		const beforeCursor = (this.getLines()[cursor.line] ?? "").slice(0, cursor.col);
		const prefix = getInlineSlashPrefix(beforeCursor);
		if (prefix === null) return undefined;
		return { line: cursor.line, startCol: cursor.col - prefix.length };
	}

	private ownsCurrentContext(context: InlineContext): boolean {
		const current = this.currentInlineContext();
		return current?.line === context.line && current.startCol === context.startCol;
	}

	private livePending(): OwnedRequest | undefined {
		const pending = this.pending;
		if (!pending || pending.startToken !== this.nativeSurface().autocompleteStartToken) return undefined;
		return pending.request;
	}

	private nativeTriggerAtCursor(): boolean {
		const cursor = this.getCursor();
		const beforeCursor = (this.getLines()[cursor.line] ?? "").slice(0, cursor.col);
		const native = this.nativeSurface();
		return native.autocompleteTriggerPattern.test(beforeCursor) || native.isInSlashCommandContext(beforeCursor);
	}

	private ownerForIncoming(options: RequestOptions): Owner | undefined {
		if (options.force || this.nativeTriggerAtCursor()) return { kind: "native" };
		const menu = this.inlineMenu;
		const native = this.nativeSurface();
		if (menu && native.autocompleteList === menu.list && native.autocompleteState === "regular") {
			return this.ownsCurrentContext(menu.context) ? { kind: "inline", context: menu.context } : undefined;
		}
		return { kind: "native" };
	}

	private requestInlineAutocomplete(explicitTab: boolean): void {
		const context = this.currentInlineContext();
		if (!context) return;
		this.queuedOwner = { kind: "inline", context };
		this.nativeSurface().requestAutocomplete({ force: false, explicitTab });
	}

	private requestOwnedAutocomplete(options: RequestOptions): void {
		const explicit = this.queuedOwner;
		this.queuedOwner = undefined;
		const owner = explicit ?? this.ownerForIncoming(options);
		if (!owner) {
			this.invalidateOwnedInline();
			return;
		}
		const cloned: RequestOptions = { force: options.force, explicitTab: options.explicitTab };
		const request: OwnedRequest = { owner, options: cloned };
		this.ownership.set(cloned, request);
		const native = this.nativeSurface();
		const before = native.autocompleteStartToken;
		this.nativeRequest(cloned);
		if (native.autocompleteStartToken !== before) {
			this.pending = { startToken: native.autocompleteStartToken, request };
		}
	}

	private invalidateOwnedInline(): void {
		const native = this.nativeSurface();
		const pending = this.pending;
		if (
			pending &&
			pending.startToken === native.autocompleteStartToken &&
			pending.request.owner.kind === "inline"
		) {
			native.cancelAutocompleteRequest();
			if (this.pending === pending) this.pending = undefined;
		}
		this.clearInstalledInlineMenu();
	}

	private clearInstalledInlineMenu(context?: InlineContext): void {
		const menu = this.inlineMenu;
		if (!menu) return;
		if (context && (menu.context.line !== context.line || menu.context.startCol !== context.startCol)) return;
		const native = this.nativeSurface();
		if (native.autocompleteList !== menu.list) return;
		native.clearAutocompleteUi();
		this.inlineMenu = undefined;
		this.tui.requestRender();
	}

	private runOwnedAutocomplete(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
		options: RequestOptions,
	): Promise<void> {
		const owned = this.ownership.get(options) ?? { owner: { kind: "native" as const }, options };
		const skipped = owned.owner.kind === "inline" && !this.ownsCurrentContext(owned.owner.context);
		if (skipped) this.clearInstalledInlineMenu(owned.owner.context);
		else this.running = owned;
		const run = skipped
			? Promise.resolve()
			: this.nativeRun(requestId, controller, snapshotText, snapshotLine, snapshotCol, options);
		return run.finally(() => {
			if (this.running === owned) this.running = undefined;
			if (this.pending?.request === owned && this.nativeSurface().autocompleteState === null) {
				this.pending = undefined;
			}
		});
	}

	private applyOwnedSuggestions(suggestions: SuggestionBatch, state: MenuState): void {
		this.nativeApply(suggestions, state);
		const list = this.nativeSurface().autocompleteList;
		const running = this.running;
		if (running?.owner.kind === "inline" && state === "regular" && list) {
			this.inlineMenu = { list, context: running.owner.context };
		} else {
			this.inlineMenu = undefined;
		}
	}

	private reconcileOwnership(): void {
		const native = this.nativeSurface();
		const pending = this.pending;
		if (
			pending &&
			pending.startToken === native.autocompleteStartToken &&
			pending.request.owner.kind === "inline" &&
			!this.ownsCurrentContext(pending.request.owner.context)
		) {
			native.cancelAutocompleteRequest();
			if (this.pending === pending) this.pending = undefined;
		}
		const menu = this.inlineMenu;
		if (menu && native.autocompleteList === menu.list && !this.ownsCurrentContext(menu.context)) {
			this.clearInstalledInlineMenu();
		}
	}

	private checkAndTriggerInlineSlash(): void {
		if (this.isShowingAutocomplete()) return;
		// The forced request is queued before its menu exists. An inline refresh must not replace it.
		const pending = this.livePending();
		if (pending?.owner.kind === "native" && pending.options.force) return;
		if (this.currentInlineContext()) this.requestInlineAutocomplete(false);
	}

	override handleInput(data: string): void {
		if (data === " ") {
			const menu = this.inlineMenu;
			const native = this.nativeSurface();
			if (menu && native.autocompleteList === menu.list && this.ownsCurrentContext(menu.context)) {
				const pending = this.livePending();
				if (pending && pending.owner.kind !== "inline") {
					this.clearInstalledInlineMenu();
				} else {
					native.cancelAutocomplete();
					this.inlineMenu = undefined;
					this.pending = undefined;
				}
			}
		}

		if ((data === "\t" || data === "\x1b[Z") && !this.isShowingAutocomplete()) {
			if (this.currentInlineContext()) {
				this.requestInlineAutocomplete(true);
				return;
			}
		}

		const wasExpanded = this.getToolsExpanded?.();
		super.handleInput(data);
		if (wasExpanded !== this.getToolsExpanded?.()) {
			this.tui.invalidate();
		}
		this.reconcileOwnership();
		this.checkAndTriggerInlineSlash();
	}
}
