import test from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stripFrontmatter,
  transformPromptWithSkills,
  registerInlineSkillInterceptor,
  type SkillResolver,
} from "../extensions/interceptor.js";
import slashAnywhereExtension from "../extensions/index.js";

test("stripFrontmatter: removes standard yaml frontmatter", () => {
  const content = `---
name: test-skill
description: A test skill
---
# Actual Skill Content
Here is the documentation.`;

  const stripped = stripFrontmatter(content);
  assert.equal(stripped.trim(), "# Actual Skill Content\nHere is the documentation.");
});

test("stripFrontmatter: returns unchanged content if no frontmatter present", () => {
  const content = "# Pure Markdown\nNo frontmatter here.";
  assert.equal(stripFrontmatter(content), content);
});

test("matches all inline /skill:<name> tokens and prepends resolved skills", async () => {
  const mockResolver: SkillResolver = (name: string) => {
    if (name === "git-flow") {
      return {
        name: "git-flow",
        filePath: "/path/to/skills/git-flow/SKILL.md",
        baseDir: "/path/to/skills/git-flow",
        content: "---\ntitle: Git Flow\n---\nGit Flow instructions.",
      };
    }
    return null;
  };

  const input = "Please help me review according to /skill:git-flow in this branch.";
  const result = await transformPromptWithSkills(input, mockResolver);

  assert.ok(result !== null);
  assert.ok(
    result.startsWith(
      '<skill name="git-flow" location="/path/to/skills/git-flow/SKILL.md">\nReferences are relative to /path/to/skills/git-flow.\n\nGit Flow instructions.\n</skill>'
    )
  );
  assert.ok(result.endsWith(input));
});

test("deduplicates multiple references to the same skill", async () => {
  let resolveCount = 0;
  const mockResolver: SkillResolver = (name: string) => {
    if (name === "tdd") {
      resolveCount++;
      return {
        name: "tdd",
        filePath: "/skills/tdd/SKILL.md",
        baseDir: "/skills/tdd",
        content: "TDD guide.",
      };
    }
    return null;
  };

  const input = "Let's use /skill:tdd and later revisit /skill:tdd again.";
  const result = await transformPromptWithSkills(input, mockResolver);

  assert.ok(result !== null);
  // Must only resolve once and have one <skill block
  assert.equal(resolveCount, 1);
  const skillOccurrences = (result.match(/<skill name="tdd"/g) || []).length;
  assert.equal(skillOccurrences, 1);
  assert.ok(result.endsWith(input));
});

test("leaves unresolved/unknown skills intact as plain text without throwing", async () => {
  const mockResolver: SkillResolver = () => null;

  const input = "Check /skill:non-existent skill.";
  const result = await transformPromptWithSkills(input, mockResolver);

  // When no skills resolve, transformPromptWithSkills returns null
  assert.equal(result, null);
});

test("partially resolved skills prepend only resolved ones and leave unknown intact", async () => {
  const mockResolver: SkillResolver = (name: string) => {
    if (name === "known") {
      return {
        name: "known",
        filePath: "/skills/known/SKILL.md",
        baseDir: "/skills/known",
        content: "Known skill.",
      };
    }
    return null;
  };

  const input = "Use /skill:known and /skill:unknown.";
  const result = await transformPromptWithSkills(input, mockResolver);

  assert.ok(result !== null);
  assert.ok(result.includes('<skill name="known"'));
  assert.ok(!result.includes('<skill name="unknown"'));
  assert.ok(result.includes("Use /skill:known and /skill:unknown."));
});

test("treats non-starting interactive commands (/clear, /model) as plain text", async () => {
  const mockResolver: SkillResolver = () => null;

  const input = "What does /clear or /model do?";
  const result = await transformPromptWithSkills(input, mockResolver);

  assert.equal(result, null);
});

test("supports configuration: enabled=false disables transformation", async () => {
  const mockResolver: SkillResolver = () => ({
    name: "test",
    filePath: "/skills/test/SKILL.md",
    content: "Content",
  });

  const input = "Run /skill:test";
  const result = await transformPromptWithSkills(input, mockResolver, { enabled: false });

  assert.equal(result, null);
});

test("error tolerance: resolver error does not throw or disrupt submission", async () => {
  const mockResolver: SkillResolver = () => {
    throw new Error("File read failure");
  };

  const input = "Run /skill:broken";
  const result = await transformPromptWithSkills(input, mockResolver);

  assert.equal(result, null);
});

test("registerInlineSkillInterceptor: ignores event.source === 'extension' to prevent re-entrancy", async () => {
  let registeredHandler: ((event: any) => Promise<any>) | undefined;
  const mockPi = {
    on: (event: string, handler: any) => {
      if (event === "input") {
        registeredHandler = handler;
      }
      return () => {};
    },
    getCommands: () => [],
    getFlag: () => undefined,
  };

  registerInlineSkillInterceptor(mockPi as any, {
    resolveSkill: () => ({
      name: "test",
      filePath: "/test.md",
      content: "test",
    }),
  });

  assert.ok(registeredHandler !== undefined);

  const res = await registeredHandler({
    type: "input",
    source: "extension",
    text: "Here is /skill:test",
  });

  assert.deepEqual(res, { action: "continue" });
});

test("registerInlineSkillInterceptor: transforms user interactive input", async () => {
  let registeredHandler: ((event: any) => Promise<any>) | undefined;
  const mockPi = {
    on: (event: string, handler: any) => {
      if (event === "input") {
        registeredHandler = handler;
      }
      return () => {};
    },
    getCommands: () => [],
    getFlag: () => undefined,
  };

  registerInlineSkillInterceptor(mockPi as any, {
    resolveSkill: () => ({
      name: "test",
      filePath: "/skills/test/SKILL.md",
      baseDir: "/skills/test",
      content: "Hello Skill",
    }),
  });

  assert.ok(registeredHandler !== undefined);

  const res = await registeredHandler({
    type: "input",
    source: "interactive",
    text: "Here is /skill:test for you",
  });

  assert.equal(res.action, "transform");
  assert.ok(res.text.startsWith('<skill name="test"'));
  assert.ok(res.text.includes("Here is /skill:test for you"));
});

test("smoke test: index entry registers both autocomplete and interceptor", () => {
  const eventsRegistered: string[] = [];
  const mockPi = {
    registerMarkdownTransformer: () => {},
    on: (event: string, _handler: any) => {
      eventsRegistered.push(event);
      return () => {};
    },
  };

  slashAnywhereExtension(mockPi as any);
  assert.ok(eventsRegistered.includes("session_start"));
  assert.ok(eventsRegistered.includes("input"));
});

test("inline skill expansion uses the skill directory as its reference base", async () => {
  const skillPath = fileURLToPath(new URL("fixtures/demo-skill/SKILL.md", import.meta.url));
  const skillDir = dirname(skillPath);

  let registeredHandler: ((event: any) => Promise<any>) | undefined;
  const mockPi = {
    on: (event: string, handler: any) => {
      if (event === "input") {
        registeredHandler = handler;
      }
      return () => {};
    },
    getCommands: () => [
      {
        name: "skill:demo-skill",
        source: "skill",
        // The registration root holds the skills tree, so it sits above the skill itself.
        sourceInfo: { path: skillPath, baseDir: dirname(skillDir) },
      },
    ],
    getFlag: () => undefined,
  };

  registerInlineSkillInterceptor(mockPi as any);
  assert.ok(registeredHandler !== undefined);

  const res = await registeredHandler({
    type: "input",
    source: "interactive",
    text: "Read /skill:demo-skill before you start.",
  });

  assert.equal(res.action, "transform");
  assert.ok(res.text.includes(`References are relative to ${skillDir}.`));
  assert.ok(res.text.includes("Demo skill content."));
});
