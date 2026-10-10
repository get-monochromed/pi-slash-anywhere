import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { TUI, EditorTheme } from "@earendil-works/pi-tui";
import { getInlineSlashPrefix, INLINE_SLASH_TRIGGER } from "./autocomplete.js";

/**
 * InlineSlashEditor wraps CustomEditor to trigger autocomplete for inline slash commands.
 * Pi's base Editor intentionally filters '/' from triggerCharacters and only checks
 * slash contexts at the start of a message. By intercepting handleInput, InlineSlashEditor
 * detects inline slash patterns and explicitly triggers autocomplete.
 */
export class InlineSlashEditor extends CustomEditor {
  private readonly getToolsExpanded?: () => boolean;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    options?: { embedWorkingStatus?: boolean; getToolsExpanded?: () => boolean }
  ) {
    super(tui, theme, keybindings, options);
    this.getToolsExpanded = options?.getToolsExpanded;
  }

  private checkAndTriggerInlineSlash(): void {
    if (this.isShowingAutocomplete()) {
      return;
    }
    const cursor = this.getCursor();
    const lines = this.getLines();
    const currentLine = lines[cursor.line] || "";
    const beforeCursor = currentLine.slice(0, cursor.col);

    // Skip if cursor is at line-start slash context (handled natively by Editor)
    if (/^\s*\/[^\s]*$/.test(beforeCursor)) {
      return;
    }

    // If text before cursor matches inline slash trigger (e.g. " /" or " /cmd")
    if (INLINE_SLASH_TRIGGER.test(beforeCursor)) {
      // SAFETY: Native Editor implements this method at runtime but declares it private.
      (this as unknown as { tryTriggerAutocomplete?: (explicitTab?: boolean) => void }).tryTriggerAutocomplete?.();
    }
  }

  override handleInput(data: string): void {
    if (data === " " && this.isShowingAutocomplete()) {
      const cursor = this.getCursor();
      const beforeCursor = (this.getLines()[cursor.line] ?? "").slice(0, cursor.col);
      const prefix = getInlineSlashPrefix(beforeCursor);
      // SAFETY: Native Editor owns these runtime members but declares them private.
      const autocomplete = this as unknown as { autocompletePrefix?: string; cancelAutocomplete?: () => void };
      // Async refresh can leave a shorter prefix from the same slash token selectable.
      const menuPrefix = autocomplete.autocompletePrefix;
      if (prefix !== null && menuPrefix?.startsWith("/") && prefix.startsWith(menuPrefix)) {
        autocomplete.cancelAutocomplete?.();
      }
    }

    // Intercept Tab key when inline slash trigger is present and autocomplete isn't currently open
    if ((data === "\t" || data === "\x1b[Z") && !this.isShowingAutocomplete()) {
      const cursor = this.getCursor();
      const lines = this.getLines();
      const currentLine = lines[cursor.line] || "";
      const beforeCursor = currentLine.slice(0, cursor.col);
      // Only handle inline triggers, not line-start triggers (line-start is native)
      if (!/^\s*\/[^\s]*$/.test(beforeCursor) && INLINE_SLASH_TRIGGER.test(beforeCursor)) {
        // SAFETY: Native Editor implements this method at runtime but declares it private.
        (this as unknown as { tryTriggerAutocomplete?: (explicitTab?: boolean) => void }).tryTriggerAutocomplete?.(true);
        return;
      }
    }

    // Delegate to CustomEditor standard input handling (keybindings, actions, text insertion)
    const wasExpanded = this.getToolsExpanded?.();
    super.handleInput(data);
    if (wasExpanded !== this.getToolsExpanded?.()) {
      // Native toggles skip user Markdown, whose same-width cache must also expire.
      this.tui.invalidate();
    }

    // Check if we typed or deleted characters that now form an inline slash trigger
    this.checkAndTriggerInlineSlash();
  }
}
