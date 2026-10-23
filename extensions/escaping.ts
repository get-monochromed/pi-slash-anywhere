/**
 * Escape-aware scanning for inline slash tokens.
 *
 * A slash token is inert when it is escaped with a backslash (`\/skill:name`)
 * or sits inside a quoted span ("...", '...', or `...`).
 */

const QUOTE_CHARS = new Set(["'", '"', "`"]);

/** A quote opens at the start of text or after whitespace, before a non-space char. */
function opensQuote(text: string, index: number): boolean {
  const quote = text[index];
  if (quote === undefined || !QUOTE_CHARS.has(quote)) return false;
  const prev = index > 0 ? text[index - 1] : "";
  const next = text[index + 1] ?? "";
  if (prev && !/\s/.test(prev)) return false;
  return next !== "" && !/\s/.test(next);
}

/** A quote closes before whitespace, punctuation, or the end of the text. */
function closesQuote(text: string, index: number): boolean {
  const next = text[index + 1] ?? "";
  return next === "" || /[\s.,;:!?)\]}]/.test(next);
}

/** The quote character that is still open at `index`, or null outside quotes. */
export function openQuoteAt(text: string, index: number): string | null {
  let open: string | null = null;
  for (let i = 0; i < index; i++) {
    const ch = text[i];
    if (ch === undefined) break;
    if (ch === "\\") {
      i++; // skip the escaped character
      continue;
    }
    if (open) {
      if (ch === open && closesQuote(text, i)) open = null;
    } else if (opensQuote(text, i)) {
      open = ch;
    }
  }
  return open;
}

/** True when the character at `index` is preceded by an odd number of backslashes. */
export function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

/** True when a slash at `index` must not trigger inline slash behavior. */
export function isInertSlash(text: string, index: number): boolean {
  return isEscaped(text, index) || openQuoteAt(text, index) !== null;
}

/** Removes the escape backslash from `\/skill:` sequences. */
export function unescapeSkillTokens(text: string): string {
  return text.replace(/\\\/(?=skill:)/g, "/");
}
