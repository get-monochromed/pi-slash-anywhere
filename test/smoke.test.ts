import test from "node:test";
import assert from "node:assert/strict";
import slashAnywhereExtension from "../extensions/index.js";
import { InlineSlashEditor } from "../extensions/editor.js";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

test("smoke test: extension entry point exports a function", () => {
  assert.equal(typeof slashAnywhereExtension, "function");
});

test("smoke test: extension entry can be invoked with mock pi context", () => {
  let registered = false;
  const mockPi = {
    on: () => {},
    registerMarkdownTransformer: () => {},
    registerCommand: () => {
      registered = true;
    },
  };

  assert.doesNotThrow(() => {
    slashAnywhereExtension(mockPi as any);
  });
});

test("InlineSlashEditor: triggers autocomplete when inline slash is typed", () => {
  const requests: { force: boolean; explicitTab: boolean }[] = [];
  const mockTui = {
    requestRender: () => {},
    invalidate: () => {},
  } as any;
  const mockTheme = {
    borderColor: (t: string) => t,
    selectList: {},
  } as any;
  const mockKeybindings: KeybindingsManager = {
    matches: () => false,
    getKeybinding: () => undefined,
  } as any;

  const editor = new InlineSlashEditor(mockTui, mockTheme, mockKeybindings);
  const state = editor as unknown as {
    requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void;
  };
  const nativeRequest = state.requestAutocomplete.bind(editor);
  state.requestAutocomplete = (options) => {
    requests.push({ force: options.force, explicitTab: options.explicitTab });
    nativeRequest(options);
  };

  editor.handleInput("h");
  editor.handleInput("e");
  editor.handleInput("l");
  editor.handleInput("l");
  editor.handleInput("o");
  assert.deepEqual(requests, []);

  editor.handleInput(" ");
  editor.handleInput("/");
  assert.deepEqual(requests, [{ force: false, explicitTab: false }]);
  assert.equal(editor.getText(), "hello /");
  assert.equal(editor.isShowingAutocomplete(), false);

  editor.handleInput("h");
  assert.deepEqual(requests, [
    { force: false, explicitTab: false },
    { force: false, explicitTab: false },
  ]);
  assert.equal(editor.getText(), "hello /h");

  editor.handleInput("\t");
  assert.deepEqual(requests, [
    { force: false, explicitTab: false },
    { force: false, explicitTab: false },
    { force: false, explicitTab: true },
  ]);
  assert.equal(editor.getText(), "hello /h");

  const lineStartEditor = new InlineSlashEditor(mockTui, mockTheme, mockKeybindings);
  const lineState = lineStartEditor as unknown as typeof state;
  const lineRequests: { force: boolean; explicitTab: boolean }[] = [];
  const lineNative = lineState.requestAutocomplete.bind(lineStartEditor);
  lineState.requestAutocomplete = (options) => {
    lineRequests.push({ force: options.force, explicitTab: options.explicitTab });
    lineNative(options);
  };
  lineStartEditor.handleInput("/");
  lineStartEditor.handleInput("t");
  assert.deepEqual(lineRequests, [
    { force: false, explicitTab: false },
    { force: false, explicitTab: false },
  ]);
  lineStartEditor.handleInput("\t");
  assert.equal(lineStartEditor.getText(), "/t");
});
