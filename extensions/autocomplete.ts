import type { AutocompleteProvider, AutocompleteSuggestions, AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

/**
 * Regex matching the trigger condition for inline slash commands:
 * Must start either at line start or after whitespace (space or tab),
 * followed by a slash and optional non-whitespace characters until the cursor.
 */
export const INLINE_SLASH_TRIGGER = /(?:^|[ \t])\/([^\s]*)$/;

/**
 * Regex checking if text before cursor is currently a slash command prefix without path separators.
 */
export const SLASH_TOKEN_BEFORE_CURSOR = /(?:^|[ \t])\/[^\s/]*$/;

/**
 * Regex checking if text before cursor contains path separators after a slash token.
 */
export const PATH_SEPARATOR_BEFORE_CURSOR = /(?:^|[ \t])\/[^\s/]*\//;

/**
 * Regex matching slash token at line start (optional leading whitespace followed by slash and optional non-whitespace chars).
 */
export const LINE_START_SLASH_REGEX = /^\s*\/[^\s]*$/;

/**
 * Checks whether the cursor is in a line-start slash command context (not inline).
 */
export function isLineStartSlashContext(lines: string[], cursorLine: number, cursorCol: number): boolean {
  const line = lines[cursorLine] ?? "";
  const beforeCursor = line.slice(0, cursorCol);
  return LINE_START_SLASH_REGEX.test(beforeCursor);
}

export function getInlineSlashPrefix(beforeCursor: string): string | null {
  if (LINE_START_SLASH_REGEX.test(beforeCursor)) {
    return null;
  }
  const match = beforeCursor.match(INLINE_SLASH_TRIGGER);
  const token = match?.[1];
  return token !== undefined && !token.includes("/") ? `/${token}` : null;
}

/**
 * Creates an AutocompleteProvider that layers inline slash command, prompt template,
 * and skill completion on top of the existing provider.
 */
export function createInlineSlashAutocompleteProvider(
  current: AutocompleteProvider,
  getCandidates: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[]
): AutocompleteProvider {
  return {
    triggerCharacters: Array.from(new Set([...(current.triggerCharacters ?? []), "/"])),

    async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null> {
      if (options.force) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const trimmed = beforeCursor.trimEnd();
      // A terminated inline token must not turn into native empty-prefix file suggestions.
      if (trimmed !== beforeCursor && getInlineSlashPrefix(trimmed) !== null) {
        return null;
      }

      const prefix = getInlineSlashPrefix(beforeCursor);
      if (prefix === null) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      const token = prefix.slice(1);

      const rawCandidates = await getCandidates();

      // Intermediate candidate structure for fuzzy matching and label/value formatting
      interface InternalCandidate {
        item: AutocompleteItem;
        isSkill: boolean;
        skillName?: string;
        commandName: string;
      }

      const candidates: InternalCandidate[] = [];

      for (const item of rawCandidates) {
        const isSkill = item.source === "skill" || item.name.startsWith("skill:");
        let value: string;
        let label: string;
        let skillName: string | undefined;

        if (isSkill) {
          skillName = item.name.startsWith("skill:")
            ? item.name.slice("skill:".length)
            : item.name;
          value = `/skill:${skillName}`;
          label = `/skill:${skillName}`;
        } else {
          value = `/${item.name}`;
          label = `/${item.name}`;
        }

        candidates.push({
          item: {
            value,
            label,
            description: item.description,
          },
          isSkill,
          skillName,
          commandName: item.name,
        });
      }

      let matchedItems: AutocompleteItem[] = [];

      if (!token) {
        // When query is empty (just "/"), return all candidates
        matchedItems = candidates.map((c) => c.item);
      } else if (token.startsWith("skill:")) {
        // Explicit skill narrowing: only skills match, query without "skill:"
        const skillQuery = token.slice("skill:".length);
        const skillCandidates = candidates.filter((c) => c.isSkill);
        if (!skillQuery) {
          matchedItems = skillCandidates.map((c) => c.item);
        } else {
          const filtered = fuzzyFilter(
            skillCandidates,
            skillQuery,
            (c) => c.skillName ?? ""
          );
          matchedItems = filtered.map((c) => c.item);
        }
      } else {
        // General query: both commands and skills match
        // For skills, match against bare skillName or commandName, so /h matches hypothesis/handoff
        const filtered = fuzzyFilter(
          candidates,
          token,
          (c) => (c.isSkill ? (c.skillName ?? c.commandName) : c.commandName)
        );
        matchedItems = filtered.map((c) => c.item);
      }

      return {
        items: matchedItems,
        prefix,
      };
    },

    applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const afterCursor = line.slice(cursorCol);

      // Replace the matched prefix (the `/` and token) with item.value + " "
      // and advance cursor column to right after the space.
      if (prefix === getInlineSlashPrefix(beforeCursor)) {
        const newLine = beforeCursor.slice(0, beforeCursor.length - prefix.length) + item.value + " " + afterCursor;
        const newCol = cursorCol - prefix.length + item.value.length + 1;
        const newLines = [...lines];
        newLines[cursorLine] = newLine;
        return {
          lines: newLines,
          cursorLine,
          cursorCol: newCol,
        };
      }

      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines: string[], line: number, col: number): boolean {
      const currentLine = lines[line] ?? "";
      const beforeCursor = currentLine.slice(0, col);

      // If text before cursor matches `/(?:^|[ \t])\/[^\s/]*$/`, return false.
      if (SLASH_TOKEN_BEFORE_CURSOR.test(beforeCursor)) {
        return false;
      }

      // If contains path separators (`/(?:^|[ \t])\/[^\s/]*\//`), return true (yield to file completion).
      if (PATH_SEPARATOR_BEFORE_CURSOR.test(beforeCursor)) {
        return true;
      }

      // Otherwise delegate to `current.shouldTriggerFileCompletion?.(lines, line, col) ?? true`.
      return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
    },
  };
}
