import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { keyText } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

const bindings = (key = "ctrl+o") => new KeybindingsManager({
  ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o" },
}, { "app.tools.expand": key as any });
import slashAnywhereExtension from "../extensions/index.js";
import { InlineSlashEditor } from "../extensions/editor.js";

const payload = '<skill name="two" location="/two/SKILL.md">\nTWO body\n</skill>\n\n  user  \n';
const theme = { borderColor: (text: string) => text, selectList: {} } as any;

function register() {
  const handlers = new Map<string, Function>();
  let transform: Function | undefined;
  slashAnywhereExtension({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: () => {},
    registerMarkdownTransformer: (handler: Function) => { transform = handler; },
  } as any);
  return { handlers, render: (text: string, messageType = "user") => transform!(text, { messageType, isStreaming: false, availableWidth: 80 }) };
}

test("display transformer uses live session getter and only formats user markdown", () => {
  const { handlers, render } = register();
  assert.equal(render(payload), payload);
  let expanded = false;
  let factory: Function | undefined;
  handlers.get("session_start")!({}, {
    hasUI: true,
    ui: {
      getToolsExpanded() { return expanded; },
      addAutocompleteProvider: () => {},
      setEditorComponent: (value: Function) => { factory = value; },
    },
  });
  assert.equal(render(payload), `[skill] two (${keyText("app.tools.expand")} to expand)\n\n  user  \n`);
  assert.equal(render(payload, "assistant"), payload);
  assert.equal(render(payload, "assistant-thinking"), payload);
  expanded = true;
  assert.equal(render(payload), payload);
  const editor = factory!({ requestRender() {}, invalidate() {}, terminal: { rows: 24 } }, theme, bindings());
  editor.setWorkingStatusIndicator({ renderInBorder: () => "WORKING", renderSpinnerInBorder: () => "*" });
  assert.ok(editor.render(80)[0].includes("WORKING"));
  handlers.get("session_shutdown")!({}, { hasUI: true, ui: { notify() {} } });
  expanded = false;
  assert.equal(render(payload), payload);
});

test("real host entry constructs before session_start and preserves independent states across reload and replacement", {
  skip: !process.env.PI_PACKAGE_DIR && "requires real Pi 1.1.0 or 1.2.0 via PI_PACKAGE_DIR",
}, async (t) => {
  const hostEntry = pathToFileURL(`${process.env.PI_PACKAGE_DIR}/dist/index.js`).href;
  const host = await import(hostEntry);
  if (host.VERSION !== "1.1.0" && host.VERSION !== "1.2.0") {
    t.skip("requires real Pi 1.1.0 or 1.2.0 via PI_PACKAGE_DIR");
    return;
  }
  host.initTheme("dark");
  const { loadExtensions } = await import(pathToFileURL(`${process.env.PI_PACKAGE_DIR}/dist/core/extensions/loader.js`).href);
  const loaded = await loadExtensions([new URL("../extensions/index.ts", import.meta.url).pathname], process.cwd());
  assert.deepEqual(loaded.errors, []);
  let extension = loaded.extensions[0];
  const message = payload.replace("\n\n  user", '\n\n<skill name="three" location="/three/SKILL.md">\nTHREE body\n</skill>\n\n  user');
  const construct = () => new host.UserMessageComponent(message, host.getMarkdownTheme(), 1, [extension.markdownTransformer]);
  const cards = (parent: any) => parent.children.filter((child: any) => child instanceof host.SkillInvocationMessageComponent);
  const states = (parent: any) => cards(parent).map((card: any) => card.expanded);
  const ctx = (getToolsExpanded: () => boolean) => ({
    hasUI: true,
    ui: { getToolsExpanded, addAutocompleteProvider() {}, setEditorComponent() {}, notify() {} },
  });
  const emit = async (name: string, context: any) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name }, context);
  };
  let expanded = true;
  const context = ctx(() => expanded);
  try {
    const first = construct();
    assert.deepEqual(states(first), [false, false]);
    first.rebuild();
    await emit("session_start", context);
    assert.deepEqual(states(first), [true, true]);
    assert.match(stripVTControlCharacters(first.render(100).join("\n")), /TWO body[\s\S]*THREE body[\s\S]*user/);
    cards(first)[0].setExpanded(false);
    await emit("session_start", context);
    first.rebuild();
    assert.deepEqual(states(first), [false, true]);

    const replacement = construct();
    assert.deepEqual(states(replacement), [true, true]);
    cards(replacement)[1].setExpanded(false);
    await emit("session_start", ctx(() => expanded));
    replacement.rebuild();
    assert.deepEqual(states(replacement), [true, false]);
    expanded = false;
    const collapsedReplacement = construct();
    await emit("session_start", ctx(() => expanded));
    assert.deepEqual(states(collapsedReplacement), [false, false]);

    await emit("session_shutdown", context);
    const reloaded = await loadExtensions([new URL("../extensions/index.ts", import.meta.url).pathname], process.cwd());
    assert.deepEqual(reloaded.errors, []);
    extension = reloaded.extensions[0];
    expanded = true;
    const reload = construct();
    reload.rebuild();
    assert.deepEqual(states(reload), [false, false]);
    await emit("session_start", context);
    assert.deepEqual(states(reload), [true, true]);
    cards(reload)[1].setExpanded(false);
    await emit("session_start", context);
    reload.rebuild();
    assert.deepEqual(states(reload), [true, false]);
  } finally { await emit("session_shutdown", context); }
});

test("missing getter and headless sessions preserve original display", () => {
  const { handlers, render } = register();
  handlers.get("session_start")!({}, { hasUI: true, ui: { addAutocompleteProvider() {}, setEditorComponent() {} } });
  assert.equal(render(payload), payload);
  handlers.get("session_start")!({}, { hasUI: false, ui: {} });
  assert.equal(render(payload), payload);
});

for (const [binding, input] of [["ctrl+o", "\x0f"], ["ctrl+y", "\x19"]]) {
  test(`editor invalidates synchronously on native ${binding} expansion in both directions`, () => {
    let expanded = false;
    const states: boolean[] = [];
    const editor = new InlineSlashEditor({ requestRender() {}, invalidate() { states.push(expanded); } } as any,
      theme, bindings(binding) as any,
      { getToolsExpanded: () => expanded } as any);
    editor.onAction("app.tools.expand", () => { expanded = !expanded; });
    editor.handleInput(input!);
    assert.equal(expanded, true);
    assert.deepEqual(states, [true]);
    editor.handleInput("a");
    assert.equal(editor.getText(), "a");
    assert.deepEqual(states, [true]);
    editor.handleInput(input!);
    assert.deepEqual(states, [true, false]);
  });
}

test("editor without options retains native app actions and typing", () => {
  let expanded = false;
  const editor = new InlineSlashEditor({ requestRender() {} } as any, theme, bindings() as any);
  editor.onAction("app.tools.expand", () => { expanded = !expanded; });
  editor.handleInput("\x0f");
  editor.handleInput("z");
  assert.equal(expanded, true);
  assert.equal(editor.getText(), "z");
});
