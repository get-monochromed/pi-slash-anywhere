export interface ScanPlan {
  blocks: { name: string; raw: string; ordinal: number; start: number; end: number }[];
  tail: string;
  valid: boolean;
}

export function scanLeadingSkills(markdown: string): ScanPlan {
  const blocks: ScanPlan["blocks"] = [];
  let start = 0;
  let end = 0;
  let valid = true;
  while (markdown.startsWith("<skill", start)) {
    const match = markdown.slice(start).match(
      /^<skill name="([^"\n]+)" location="([^"\n]+)">\n([\s\S]*?)\n<\/skill>(?=\n\n|$)/
    );
    if (!match || /<\/?skill(?:[\s/>])/.test(match[3]!)) {
      valid = false;
      break;
    }
    end = start + match[0].length;
    blocks.push({ name: match[1]!, raw: match[0], ordinal: blocks.length, start, end });
    if (!markdown.startsWith("\n\n", end)) break;
    start = end + 2;
  }
  return { blocks, tail: markdown.slice(end), valid };
}

export function formatSkillDisplay(markdown: string, expanded: boolean, hint?: string): string {
  if (expanded) return markdown;
  const { blocks, tail } = scanLeadingSkills(markdown);
  if (!blocks.length) return markdown;
  return blocks.map(({ name }) => `[skill] ${name}${hint ? ` (${hint})` : ""}`).join("\n\n") + tail;
}
