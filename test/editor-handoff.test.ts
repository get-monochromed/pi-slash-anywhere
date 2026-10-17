import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CombinedAutocompleteProvider, type AutocompleteItem } from "@earendil-works/pi-tui";
import type { KeybindingsManager, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { InlineSlashEditor } from "../extensions/editor.js";
import { createInlineSlashAutocompleteProvider } from "../extensions/autocomplete.js";

const candidates: SlashCommandInfo[] = [
  { name: "help", source: "extension", description: "Help", sourceInfo: { path: "/test/help.ts", source: "test", scope: "temporary", origin: "top-level" } },
  { name: "review", source: "prompt", description: "Review template", sourceInfo: { path: "/test/review.md", source: "test", scope: "temporary", origin: "top-level" } },
  { name: "handoff", source: "skill", description: "Handoff skill", sourceInfo: { path: "/test/SKILL.md", source: "test", scope: "temporary", origin: "top-level" } },
];

type RequestOptions = { force: boolean; explicitTab: boolean };
type Owner = { kind: "native" } | { kind: "inline"; context: { line: number; startCol: number } };
type RequestState = {
  autocompleteRequestTask: Promise<void>;
  autocompleteRequestId: number;
  autocompleteState: "regular" | "force" | null;
  autocompleteList?: { getSelectedItem(): AutocompleteItem | null };
  pending?: { request: { owner: Owner; options: RequestOptions } };
  requestAutocomplete(options: RequestOptions): void;
  runAutocompleteRequest(
    requestId: number,
    controller: AbortController,
    snapshotText: string,
    snapshotLine: number,
    snapshotCol: number,
    options: RequestOptions,
  ): Promise<void>;
};

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
  const requests: { text: string; force: boolean }[] = [];
  const state = editor as unknown as RequestState;
  const request = state.requestAutocomplete.bind(editor);
  state.requestAutocomplete = (options) => {
    requests.push({ text: editor.getText(), force: options.force });
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
  assert.equal(requests.at(-1)?.force, false);
  await input("");
  t.diagnostic(JSON.stringify({ lastRequest: requests.at(-1), providerSnapshots: calls, menu: editor.isShowingAutocomplete() }));
  assert.deepEqual(calls, [], "terminated inline request never reaches the native provider");
  expectState(sentence, sentence.length, false);
});

test("an open inline menu cannot refresh into cwd suggestions during synchronous sentence input", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("请读取 ");
  await input("/");
  expectState("请读取 /", 5, true);
  const sentence = screenshotStem + "。";
  for (const character of sentence.slice(5)) editor.handleInput(character);
  await input("");
  expectState(sentence, sentence.length, false);
});

for (const open of [false, true]) {
  for (const stepped of [false, true]) {
    test(`inline lifecycle sentence open=${open} stepped=${stepped}`, async (t) => {
      const { editor, input, expectState } = await fixture(t);
      editor.setText("请读取 ");
      if (open) await input("/");
      else editor.handleInput("/");
      const sentence = screenshotStem + "。";
      for (const character of sentence.slice(5)) {
        if (stepped) await input(character);
        else editor.handleInput(character);
      }
      await input("");
      expectState(sentence, sentence.length, false);
    });
  }
}

for (const open of [false, true]) {
  test(`inline to native attachment chunk preserves native menu open=${open}`, async (t) => {
    const { editor, input, expectState } = await fixture(t);
    editor.setText("foo ");
    if (open) await input("/");
    else editor.handleInput("/");
    await input(" @sub/nes");
    expectState("foo / @sub/nes", 14, true);
    await input("\t");
    expectState("foo / @sub/nested.txt ", 22, false);
  });
}

test("native path menu survives cursor crossing an inline-eligible prefix", async (t) => {
  const { editor, input, expectState, cwd } = await fixture(t);
  const text = `foo ${cwd}/sub/`;
  editor.setText(text);
  await input("\t");
  expectState(text, text.length, true);
  for (let i = 0; i < `${cwd}/sub/`.length - 4; i++) await input("\u001b[D");
  expectState(text, 8, true);
  await input("\u001b[C");
  expectState(text, 9, true);
});

test("native path replacement during an inline event retains its own menu", async (t) => {
  const { editor, input, expectState, cwd } = await fixture(t);
  editor.setText("foo ");
  await input("/");
  editor.onExtensionShortcut = (data) => {
    if (data !== "\u0010") return false;
    editor.insertTextAtCursor(` ${cwd}/sub/`);
    // SAFETY: The native Tab handler exists at runtime but is private.
    (editor as unknown as { handleTabCompletion(): void }).handleTabCompletion();
    return true;
  };
  await input("\u0010");
  const text = `foo / ${cwd}/sub/`;
  expectState(text, text.length, true);
  await input("\t");
  assert.equal(editor.getText().startsWith(text), true);
  assert.equal(editor.isShowingAutocomplete(), false);
});

test("inline menu navigation and native Enter confirmation run before cleanup", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("foo ");
  await input("/");
  await input("\u001b[B");
  expectState("foo /", 5, true);
  const submitted: string[] = [];
  editor.onSubmit = (text) => submitted.push(text);
  await input("\r");
  assert.deepEqual(submitted, ["foo /review"]);
  expectState("", 0, false);
});

test("late inline result cannot reopen after its context ends", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  let release!: (value: SlashCommandInfo[]) => void;
  editor.setAutocompleteProvider(createInlineSlashAutocompleteProvider(
    new CombinedAutocompleteProvider([], process.cwd(), "fd"),
    () => new Promise((resolve) => { release = resolve; }),
  ));
  editor.setText("foo ");
  editor.handleInput("/");
  await Promise.resolve();
  assert.equal(typeof release, "function");
  editor.handleInput("/outside");
  release(candidates);
  await input("");
  expectState("foo //outside", 13, false);
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

test("synchronous inline punctuation and no-change input retain completion", async (t) => {
  const { editor, input, expectState, cwd } = await fixture(t);
  editor.setAutocompleteProvider(createInlineSlashAutocompleteProvider(
    new CombinedAutocompleteProvider([], cwd, "fd"),
    () => [{ ...candidates[0], name: "help.doc" }],
  ));
  let handled = false;
  editor.onExtensionShortcut = (data) => {
    if (data !== "\u0010") return false;
    handled = true;
    return true;
  };
  for (const character of "foo /help.") editor.handleInput(character);
  await input("\u0010");
  assert.equal(handled, true, "extension shortcut handled the key without editing");
  expectState("foo /help.", 10, true);
  await input("\t");
  expectState("foo /help.doc ", 14, false);
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

test("queued cursor movement keeps a native forced path menu", async (t) => {
  const { editor, input, expectState, cwd } = await fixture(t);
  const text = `foo ${cwd}/sub/`;
  editor.setText(text);
  await input("\t");
  expectState(text, text.length, true);
  const moves = `${cwd}/sub/`.length - 4;
  for (let i = 0; i < moves; i++) editor.handleInput("\u001b[D");
  await input("");
  expectState(text, 8, true);
  const state = editor as unknown as RequestState;
  assert.equal(state.autocompleteState, "force");
  assert.equal(state.pending?.request.owner.kind, "native");
  assert.equal(state.pending?.request.options.force, true);
  for (let i = 0; i < 4; i++) editor.handleInput("\u001b[C");
  await input("");
  expectState(text, 12, true);
  assert.equal(state.autocompleteState, "force");
});

test("a forced native request survives the next inline-looking cursor before it runs", async (t) => {
  const { editor, input, expectState, cwd } = await fixture(t);
  const text = `foo ${cwd}/sub/nested.txt`;
  editor.setText(text);
  const inlineCol = text.indexOf(cwd) + 1;
  const forces: boolean[] = [];
  const native = new CombinedAutocompleteProvider([], cwd, "fd");
  const provider = createInlineSlashAutocompleteProvider(native, () => candidates);
  editor.setAutocompleteProvider({
    ...provider,
    shouldTriggerFileCompletion: () => true,
    getSuggestions(lines, line, col, options) {
      forces.push(options.force === true);
      return provider.getSuggestions(lines, line, col, options);
    },
  });
  editor.handleInput("\t");
  for (let col = text.length; col > inlineCol; col--) editor.handleInput("\u001b[D");
  const state = editor as unknown as RequestState;
  assert.equal(state.pending?.request.owner.kind, "native");
  assert.equal(state.pending?.request.options.force, true);
  await input("");
  assert.deepEqual(forces, [true]);
  expectState(text, inlineCol, true);
  assert.equal(state.autocompleteState, "force");
  assert.equal(state.pending?.request.owner.kind, "native");
});

test("a refused force request does not replace the pending inline request", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  for (const character of "foo /hel") editor.handleInput(character);
  const state = editor as unknown as RequestState;
  const pending = state.pending?.request;
  assert.equal(pending?.owner.kind, "inline");
  assert.equal(pending?.options.force, false);
  editor.setAutocompleteProvider({
    ...createInlineSlashAutocompleteProvider(new CombinedAutocompleteProvider([], process.cwd(), "fd"), () => candidates),
    shouldTriggerFileCompletion: () => false,
  });
  state.requestAutocomplete({ force: true, explicitTab: true });
  assert.equal(state.pending?.request, pending);
  assert.equal(state.pending?.request.options.force, false);
  await input("");
  expectState("foo /hel", 8, true);
  await input("\t");
  expectState("foo /help ", 10, false);
});

test("leaving and returning to the same slash anchor confirms the replacement, not the ignored abort", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  let releaseFirst: ((items: AutocompleteItem[]) => void) | undefined;
  const provider = createInlineSlashAutocompleteProvider(
    new CombinedAutocompleteProvider([], process.cwd(), "fd"),
    () => candidates,
  );
  let calls = 0;
  editor.setAutocompleteProvider({
    ...provider,
    getSuggestions() {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          releaseFirst = (items) => resolve({ prefix: "/", items });
        });
      }
      return Promise.resolve({ prefix: "/", items: [{ value: "/beta", label: "/beta" }] });
    },
  });
  editor.setText("foo ");
  editor.handleInput("/");
  await Promise.resolve();
  assert.equal(typeof releaseFirst, "function");
  releaseFirst!([{ value: "/alpha", label: "/alpha" }]);
  editor.handleInput("x");
  editor.handleInput("\x7f");
  await input("");
  const selected = (editor as unknown as RequestState).autocompleteList?.getSelectedItem();
  assert.deepEqual(selected && { value: selected.value, label: selected.label }, { value: "/beta", label: "/beta" });
  releaseFirst!([{ value: "/alpha", label: "/alpha" }]);
  await input("");
  const afterLate = (editor as unknown as RequestState).autocompleteList?.getSelectedItem();
  assert.deepEqual(afterLate && { value: afterLate.value, label: afterLate.label }, { value: "/beta", label: "/beta" });
  await input("\t");
  expectState("foo /beta ", 10, false);
});

test("an old inline result cannot replace a native menu installed while it was pending", async (t) => {
  const { editor, input, expectState, cwd } = await fixture(t);
  let releaseInline: ((items: SlashCommandInfo[]) => void) | undefined;
  editor.setAutocompleteProvider(createInlineSlashAutocompleteProvider(
    new CombinedAutocompleteProvider([], cwd, "fd"),
    () => new Promise((resolve) => { releaseInline = resolve; }),
  ));
  editor.setText("foo ");
  editor.handleInput("/");
  await Promise.resolve();
  assert.equal(typeof releaseInline, "function");
  releaseInline!([]);
  editor.onExtensionShortcut = (data) => {
    if (data !== "\u0010") return false;
    editor.insertTextAtCursor(` ${cwd}/sub/`);
    (editor as unknown as { handleTabCompletion(): void }).handleTabCompletion();
    return true;
  };
  await input("\u0010");
  const text = `foo / ${cwd}/sub/`;
  expectState(text, text.length, true);
  const nativeSelected = (editor as unknown as RequestState).autocompleteList?.getSelectedItem()?.value;
  releaseInline!(candidates);
  await input("");
  expectState(text, text.length, true);
  assert.equal((editor as unknown as RequestState).autocompleteList?.getSelectedItem()?.value, nativeSelected);
  await input("\t");
  assert.equal(editor.getText().startsWith(text), true);
  assert.equal(editor.isShowingAutocomplete(), false);
});

test("clearing an old inline menu preserves a newer native request", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("foo ");
  await input("/");
  expectState("foo /", 5, true);
  editor.handleInput(" @sub/nes");
  const state = editor as unknown as RequestState;
  assert.equal(state.pending?.request.owner.kind, "native");
  assert.equal(editor.isShowingAutocomplete(), false);
  await input("");
  expectState("foo / @sub/nes", 14, true);
  assert.equal(state.autocompleteList?.getSelectedItem()?.value, "@sub/nested.txt");
  await input("\t");
  expectState("foo / @sub/nested.txt ", 22, false);
});

test("a different slash anchor cannot inherit the previous inline request", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("foo /hel");
  await input("");
  expectState("foo /hel", 8, true);
  editor.handleInput(" /rev");
  await input("");
  expectState("foo /hel /rev", 13, true);
  await input("\t");
  expectState("foo /hel /review ", 17, false);
});

test("an untagged autocomplete request stays native", async (t) => {
  const { editor, input, expectState, cwd } = await fixture(t);
  const text = `foo ${cwd}/sub/`;
  editor.setText(text);
  const state = editor as unknown as RequestState;
  const controller = new AbortController();
  await state.runAutocompleteRequest(state.autocompleteRequestId, controller, editor.getText(), 0, text.length, {
    force: true,
    explicitTab: false,
  });
  expectState(text, text.length, true);
  assert.equal(state.autocompleteState, "force");
  editor.handleInput("\u001b[D");
  await input("");
  expectState(text, text.length - 1, true);
  assert.equal(state.autocompleteState, "force");
  assert.equal(state.pending?.request.owner.kind, "native");
});

test("bracketed paste cancels an open inline menu and inserts the literal text", async (t) => {
  const { editor, input, expectState } = await fixture(t);
  editor.setText("foo ");
  await input("/");
  expectState("foo /", 5, true);
  await input("\x1b[200~beta\x1b[201~");
  expectState("foo /beta", 9, false);
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
