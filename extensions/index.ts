import { keyText, type ExtensionAPI, type MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { createInlineSlashAutocompleteProvider } from "./autocomplete.js";
import { registerInlineSkillInterceptor } from "./interceptor.js";
import { InlineSlashEditor } from "./editor.js";
import { formatSkillDisplay } from "./skill-display.js";
import { installSkillCards } from "./skill-cards.js";

/**
 * Entry point for pi-slash-anywhere extension.
 * Provides inline autocomplete and expansion for slash commands, skills, and prompt templates.
 */
export default function slashAnywhereExtension(pi: ExtensionAPI): void {
  let getToolsExpanded: (() => boolean) | undefined;
  const fallbackTransformer: MarkdownTransformer = (markdown, { messageType }) => {
    if (messageType !== "user" || !getToolsExpanded) return markdown;
    return formatSkillDisplay(markdown, getToolsExpanded(), `${keyText("app.tools.expand")} to expand`);
  };
  pi.registerMarkdownTransformer(fallbackTransformer);
  const skillCards = installSkillCards({ getExpanded: () => getToolsExpanded?.(), fallbackTransformer });
  pi.on("session_shutdown", (_event, ctx) => {
    const errors = skillCards.dispose();
    getToolsExpanded = undefined;
    if (errors.length) {
      const message = `Inline skill card cleanup failed: ${errors.join("; ")}`;
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      else console.error(message);
    }
  });

  // Register inline slash autocomplete provider and custom editor in TUI sessions
  pi.on("session_start", (_event, ctx) => {
    getToolsExpanded = ctx.hasUI && typeof ctx.ui.getToolsExpanded === "function"
      ? () => ctx.ui.getToolsExpanded()
      : undefined;
    skillCards.synchronizePendingExpansion();
    if (ctx.hasUI) {
      ctx.ui.addAutocompleteProvider((current) =>
        createInlineSlashAutocompleteProvider(current, () => pi.getCommands())
      );

      // Register CustomEditor wrapper so inline "/" triggers autocomplete
      if (typeof ctx.ui.setEditorComponent === "function") {
        ctx.ui.setEditorComponent((tui, theme, keybindings) =>
          new InlineSlashEditor(tui, theme, keybindings, { embedWorkingStatus: true, getToolsExpanded })
        );
      }
    }
  });

  // Register inline skill input interceptor & prepend expansion
  registerInlineSkillInterceptor(pi);
}
