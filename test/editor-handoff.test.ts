import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import type { KeybindingsManager, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { InlineSlashEditor } from "../extensions/editor.js";
import { createInlineSlashAutocompleteProvider } from "../extensions/autocomplete.js";

const candidates: SlashCommandInfo[] = [
  { name: "help", source: "extension", description: "Help", sourceInfo: { path: "/test/help.ts", source: "test", scope: "temporary", origin: "top-level" } },
  { name: "review", source: "prompt", description: "Review template", sourceInfo: { path: "/test/review.md", source: "test", scope: "temporary", origin: "top-level" } },
  { name: "handoff", source: "skill", description: "Handoff skill", sourceInfo: { path: "/test/SKILL.md", source: "test", scope: "temporary", origin: "top-level" } },
];

type RequestState = { autocompleteRequestTask: Promise<void> };

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "slash-editor-handoff-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".claude"));
  await mkdir(join(cwd, "sub", "directory"), { recursive: true });
  await writeFile(join(cwd, "notes.txt"), "notes");
  await writeFile(join(cwd, "sub", "nested.txt"), "nested");
  await writeFile(join(cwd, "two words.txt"), "quoted");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const editor = new InlineSlashEditor(
    { requestRender() {}, invalidate() {} } as any,
    { borderColor: (text: string) => text, selectList: {} } as any,
    { matches: () => false, getKeybinding: () => undefined } as unknown as KeybindingsManager,
  );
  const native = new CombinedAutocompleteProvider(
    [{ name: "native-only", description: "Native command" }],
    cwd,
    "fd",
  );
  editor.setAutocompleteProvider(createInlineSlashAutocompleteProvider(native, () => candidates));

  async function input(data: string) {
    editor.handleInput(data);
    t.mock.timers.runAll();
    const state = editor as unknown as RequestState;
    let task: Promise<void>;
    do {
      task = state.autocompleteRequestTask;
      await task;
    } while (task !== state.autocompleteRequestTask);
  }

  function expectState(text: string, col: number, menu: boolean, line = 0) {
    assert.equal(editor.getText(), text, "editor text");
    assert.deepEqual(editor.getCursor(), { line, col }, "editor cursor");
    assert.equal(editor.isShowingAutocomplete(), menu, "autocomplete menu");
  }

  return { editor, input, expectState, cwd };
}

test("inline slash SPACE closes the menu without replacing the typed token", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("foo ");
  await input("/");
  expectState("foo /", 5, true);
  await input(" ");
  expectState("foo / ", 6, false);
});

test("Tab after inline slash SPACE opens files without inserting .claude", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("foo ");
  await input("/");
  expectState("foo /", 5, true);
  await input(" ");
  await input("\t");
  expectState("foo / ", 6, true);
});

test("immediate Tab after SPACE cannot accept the stale inline slash menu", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("foo ");
  await input("/");
  expectState("foo /", 5, true);
  editor.handleInput(" ");
  expectState("foo / ", 6, false);
  await input("\t");
  expectState("foo / ", 6, true);
  await input("\t");
  expectState("foo / .claude/", 14, false);
});

test("immediate typing, SPACE, and Tab cannot accept a stale inline slash prefix", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("foo ");
  await input("/");
  expectState("foo /", 5, true);
  editor.handleInput("h");
  editor.handleInput(" ");
  editor.handleInput("\t");
  await (editor as unknown as RequestState).autocompleteRequestTask;
  expectState("foo /h ", 7, true);
  await input("\t");
  expectState("foo /h .claude/", 15, false);
});

test("empty-prefix native directory completion does not append a space", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("foo ");
  await input("\t");
  expectState("foo ", 4, true);
  await input("\t");
  expectState("foo .claude/", 12, false);
});

test("native directory completion with a path prefix does not append a space", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("foo ./sub/dir");
  await input("\t");
  expectState("foo ./sub/directory/", 20, false);
});

test("native file completion retains its no-space suffix", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("foo ./sub/nes");
  await input("\t");
  expectState("foo ./sub/nested.txt", 20, false);
});

test("native quoted file completion retains quotes and cursor", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText('foo "two');
  await input("\t");
  expectState('foo "two words.txt"', 19, false);
});

test("native file attachment completion keeps @ and appends one space", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("foo @sub/nes");
  await input("\t");
  expectState("foo @sub/nested.txt ", 20, false);
});

test("typing an attachment opens the native menu and completes the selected file", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("foo ");
  await input("@");
  expectState("foo @", 5, true);
  for (const character of "sub/nes") await input(character);
  expectState("foo @sub/nes", 12, true);
  await input("\t");
  expectState("foo @sub/nested.txt ", 20, false);
});

test("native directory attachment completion keeps @ without a space", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("foo @sub/dir");
  await input("\t");
  expectState("foo @sub/directory/", 19, false);
});

for (const scenario of [
  { query: "hel", text: "foo /help ", col: 10 },
  { query: "rev", text: "foo /review ", col: 12 },
  { query: "skill:han", text: "foo /skill:handoff ", col: 19 },
]) {
  test(`inline slash completion preserves ${scenario.query}`, async (t) => {
    const { editor, input, expectState } = await fixture(t);
    editor.setText("foo ");
    await input("/");
    expectState("foo /", 5, true);
    for (const character of scenario.query) await input(character);
    expectState(`foo /${scenario.query}`, 5 + scenario.query.length, true);
    await input("\t");
    expectState(scenario.text, scenario.col, false);
  });
}

const screenshotStem = "请读取 /tmp/pi-subagents-migration-handoff-20261017.md，按交接文档继续。以已安装插件源码确认功能，不新增模型实测";

for (const stem of [screenshotStem, "请继续写中文"]) {
  for (const punctuation of ["。", "."]) {
    test(`typing ${punctuation} after ${stem} keeps the editor menu closed`, async (t) => {
      const { editor, input, expectState } = await fixture(t);
      editor.setText(stem);
      await input(punctuation);
      expectState(stem + punctuation, stem.length + punctuation.length, false);
    });
  }
}

test("synchronous raw sentence input cannot reuse a queued inline slash request", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  const calls: string[] = [];
  const requests: { text: string; inline: boolean }[] = [];
  const state = editor as unknown as {
    requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void;
  };
  const request = state.requestAutocomplete.bind(editor);
  state.requestAutocomplete = (options) => {
    requests.push({ text: editor.getText(), inline: new Error().stack!.includes("checkAndTriggerInlineSlash") });
    request(options);
  };
  const native = new CombinedAutocompleteProvider([], process.cwd(), "fd");
  const provider = createInlineSlashAutocompleteProvider(native, () => candidates);
  editor.setAutocompleteProvider({
    ...provider,
    getSuggestions(lines, line, col, options) {
      calls.push(lines[line].slice(0, col));
      return provider.getSuggestions(lines, line, col, options);
    },
  });
  const sentence = screenshotStem + "。";
  for (const character of sentence) editor.handleInput(character);
  assert.deepEqual(calls, [], "request has not captured its snapshot before microtasks");
  assert.equal(requests.at(-1)?.text, "请读取 /tmp");
  assert.equal(requests.at(-1)?.inline, true, "last queued request originates in the plugin");
  await input("");
  t.diagnostic(JSON.stringify({ lastRequest: requests.at(-1), providerSnapshots: calls, menu: editor.isShowingAutocomplete() }));
  assert.deepEqual(calls, [], "terminated inline request never reaches the native provider");
  expectState(sentence, sentence.length, false);
});

test("synchronous inline input and pending Tab retain inline completion", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  for (const character of "foo /hel") editor.handleInput(character);
  editor.handleInput("\t");
  await input("");
  expectState("foo /hel", 8, true);
  await input("\t");
  expectState("foo /help ", 10, false);
});

test("synchronous native path input retains pending Tab completion", async (t) => {
  const { editor, input, expectState, cwd } = await fixture(t);
  for (const character of `foo ${cwd}/sub/nes`) editor.handleInput(character);
  editor.handleInput("\t");
  await input("");
  const completed = `foo ${cwd}/sub/nested.txt`;
  expectState(completed, completed.length, false);
});

test("synchronous native attachment input retains its automatic menu", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  for (const character of "foo @sub/nes") editor.handleInput(character);
  await input("");
  expectState("foo @sub/nes", 12, true);
  await input("\t");
  expectState("foo @sub/nested.txt ", 20, false);
});

test("Tab accepts a native absolute path with multiple separators", async (t) => {
  const { editor, input, expectState, cwd } = await fixture(t);
  editor.setText(`foo ${cwd}/sub/nes`);
  await input("\t");
  const completed = `foo ${cwd}/sub/nested.txt`;
  expectState(completed, completed.length, false);
});

test("an active inline slash menu yields to native path Tab after another separator", async (t) => {
  const { editor, input, expectState, cwd } = await fixture(t);
  editor.setText("foo ");
  await input("/");
  expectState("foo /", 5, true);
  for (const character of `${cwd.slice(1)}/sub/nes`) await input(character);
  const path = `foo ${cwd}/sub/nes`;
  expectState(path, path.length, false);
  await input("\t");
  const completed = `foo ${cwd}/sub/nested.txt`;
  expectState(completed, completed.length, false);
});

test("line-start slash delegates native command names rather than inline candidates", async (t) => {
  const { input, expectState } = await fixture(t);
  await input("/");
  expectState("/", 1, true);
  await input("n");
  expectState("/n", 2, true);
  await input("\t");
  expectState("/native-only ", 13, false);
});
