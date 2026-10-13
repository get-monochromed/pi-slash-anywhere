import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import * as LocalHost from "@earendil-works/pi-coding-agent";
import * as LocalTui from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { installSkillCards } from "../extensions/skill-cards.js";
import { formatSkillDisplay, scanLeadingSkills } from "../extensions/skill-display.js";

const block = (name: string, body = `${name.toUpperCase()} BODY`) => `<skill name="${name}" location="/${name}/SKILL.md">\n${body}\n</skill>`;
const payload = `${block("one")}\n\n${block("two")}\n\n  tail\t\nlast  \n`;
const fallback: MarkdownTransformer = text => formatSkillDisplay(text, false, "ctrl+o to expand");

const hostEntry = process.env.PI_PACKAGE_DIR ? pathToFileURL(`${process.env.PI_PACKAGE_DIR}/dist/index.js`).href : undefined;
const RealHost: typeof LocalHost = hostEntry ? await import(hostEntry) : LocalHost;
const RealTui: typeof LocalTui = hostEntry
  ? await import(pathToFileURL(createRequire(hostEntry).resolve("@earendil-works/pi-tui")).href)
  : LocalTui;
const supported = RealHost.VERSION === "1.1.0" || RealHost.VERSION === "1.2.0";
if (supported) {
  RealHost.initTheme("dark");
  const originalBindings = RealTui.getKeybindings();
  RealTui.setKeybindings(new RealTui.KeybindingsManager({
    ...RealTui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o" },
  }));
  test.after(() => RealTui.setKeybindings(originalBindings));
}
const namespaces = { host: RealHost, tui: RealTui };
type Parent = LocalTui.Container & {
  text: string;
  rebuild: () => void;
  setExpanded: (value: boolean) => void;
};
type Card = LocalTui.Component & {
  expanded: boolean;
  setExpanded: (value: boolean) => void;
  skillBlock: { name: string };
};
function parent(text = payload, transformers: MarkdownTransformer[] = [fallback]) {
  return new RealHost.UserMessageComponent(text, RealHost.getMarkdownTheme(), 1, transformers) as unknown as Parent;
}
function cards(value: Parent) {
  return value.children.filter(child => child instanceof RealHost.SkillInvocationMessageComponent) as unknown as Card[];
}
function visible(value: Parent) {
  return stripVTControlCharacters(value.render(100).join("\n"));
}
const supportedTest = (name: string, run: () => void) => test(name, { skip: !supported && "requires real Pi 1.1.0 or 1.2.0 via PI_PACKAGE_DIR" }, run);

test("unsupported versions and missing capabilities leave the host unpatched", () => {
  const before = Object.getOwnPropertyDescriptor(LocalHost.UserMessageComponent.prototype, "rebuild");
  for (const host of [{ ...LocalHost, VERSION: "0.86.0" }, { ...LocalHost, VERSION: "1.2.1" }, { VERSION: "1.1.0" }, { VERSION: "1.2.0" }]) {
    const adapter = installSkillCards({ getExpanded: () => false, fallbackTransformer: fallback }, { host, tui: LocalTui });
    assert.equal(adapter.installed, false);
    assert.deepEqual(Object.getOwnPropertyDescriptor(LocalHost.UserMessageComponent.prototype, "rebuild"), before);
    assert.equal(fallback(payload, { messageType: "user", isStreaming: false, availableWidth: 100 }),
      "[skill] one (ctrl+o to expand)\n\n[skill] two (ctrl+o to expand)\n\n  tail\t\nlast  \n");
    assert.deepEqual(adapter.dispose(), []);
  }
});

supportedTest("real host cards hide bodies, expand every broadcast, and preserve independent rebuild state", () => {
  let expanded = true;
  const adapter = installSkillCards({ getExpanded: () => expanded, fallbackTransformer: fallback }, namespaces);
  try {
    assert.equal(adapter.installed, true);
    const value = parent();
    assert.deepEqual(cards(value).map(card => card.expanded), [true, true]);
    assert.match(visible(value), /ONE BODY[\s\S]*TWO BODY[\s\S]*tail/);
    value.setExpanded(false);
    const collapsed = visible(value);
    assert.match(collapsed, /\[skill\] one \(ctrl\+o to expand\)[\s\S]*\[skill\] two \(ctrl\+o to expand\)[\s\S]*tail/);
    assert.equal(collapsed.includes("ONE BODY"), false);
    assert.equal(collapsed.includes("TWO BODY"), false);
    cards(value)[0]!.setExpanded(true);
    value.rebuild();
    assert.deepEqual(cards(value).map(card => card.expanded), [true, false]);
    assert.match(visible(value), /ONE BODY[\s\S]*\[skill\] two \(ctrl\+o to expand\)/);
    value.setExpanded(false);
    cards(value)[0]!.setExpanded(true);
    value.setExpanded(false);
    assert.deepEqual(cards(value).map(card => card.expanded), [false, false]);
    expanded = true;
    value.text = payload.replace("ONE BODY", "REPLACED BODY");
    value.rebuild();
    assert.deepEqual(cards(value).map(card => card.expanded), [true, false]);
    assert.match(visible(value), /REPLACED BODY/);
    assert.equal(Object.hasOwn(value, "updateDisplay"), false);
    assert.equal(Object.hasOwn(value, "toolCallId"), false);
  } finally { assert.deepEqual(adapter.dispose(), []); }
});

supportedTest("compact mounted cards keep user-message boundary markers off clickable titles", () => {
  class CompactCard extends RealHost.SkillInvocationMessageComponent {
    override render() {
      return [`✓ Skill ${Reflect.get(this, "skillBlock").name} · click to show more`];
    }
  }
  const adapter = installSkillCards({ getExpanded: () => false, fallbackTransformer: fallback }, {
    host: { ...RealHost, SkillInvocationMessageComponent: CompactCard }, tui: RealTui,
  });
  try {
    const value = parent();
    const lines = value.render(100);
    assert.equal(stripVTControlCharacters(lines[0]!), "");
    assert.equal(lines[1], "✓ Skill one · click to show more");
    assert.equal(lines[3], "✓ Skill two · click to show more");
    if (RealHost.VERSION === "1.2.0") assert.equal(lines[0], "\x1b]133;A\x07");
    value.setExpanded(true);
    value.rebuild();
    const rebuilt = value.render(100);
    assert.equal(stripVTControlCharacters(rebuilt[0]!), "");
    assert.equal(rebuilt[1], "✓ Skill one · click to show more");
    assert.equal(rebuilt[3], "✓ Skill two · click to show more");
  } finally { assert.deepEqual(adapter.dispose(), []); }
});

for (const initialExpanded of [true, false]) {
  supportedTest(`delayed getter synchronizes pending mounts once to ${initialExpanded} across premature rebuilds`, () => {
    let getter: (() => boolean) | null | undefined;
    let expanded = initialExpanded;
    const adapter = installSkillCards({ getExpanded: () => getter?.(), fallbackTransformer: fallback }, namespaces);
    try {
      const first = parent();
      getter = null;
      first.rebuild();
      const second = parent();
      assert.deepEqual(cards(first).map(card => card.expanded), [false, false]);
      assert.deepEqual(cards(second).map(card => card.expanded), [false, false]);
      adapter.synchronizePendingExpansion();
      getter = () => expanded;
      first.rebuild();
      adapter.synchronizePendingExpansion();
      assert.deepEqual(cards(first).map(card => card.expanded), [initialExpanded, initialExpanded]);
      assert.deepEqual(cards(second).map(card => card.expanded), [initialExpanded, initialExpanded]);
      assert.equal(visible(first).includes("ONE BODY"), initialExpanded);
      assert.equal(visible(first).includes("TWO BODY"), initialExpanded);
      cards(first)[0]!.setExpanded(!initialExpanded);
      cards(second)[1]!.setExpanded(!initialExpanded);
      expanded = !initialExpanded;
      adapter.synchronizePendingExpansion();
      first.rebuild();
      second.rebuild();
      adapter.synchronizePendingExpansion();
      assert.deepEqual(cards(first).map(card => card.expanded), [!initialExpanded, initialExpanded]);
      assert.deepEqual(cards(second).map(card => card.expanded), [initialExpanded, !initialExpanded]);
      const ready = parent();
      assert.deepEqual(cards(ready).map(card => card.expanded), [!initialExpanded, !initialExpanded]);
      cards(ready)[0]!.setExpanded(initialExpanded);
      adapter.synchronizePendingExpansion();
      ready.rebuild();
      assert.deepEqual(cards(ready).map(card => card.expanded), [initialExpanded, !initialExpanded]);
    } finally { assert.deepEqual(adapter.dispose(), []); }
  });
}

supportedTest("successful mount preserves raw text and sends exact tail through other transformers in order", () => {
  const inputs: string[] = [];
  const first: MarkdownTransformer = text => { inputs.push(text); return text + "\nFIRST"; };
  const second: MarkdownTransformer = text => { inputs.push(text); return text + "\nSECOND"; };
  const adapter = installSkillCards({ getExpanded: () => false, fallbackTransformer: fallback }, namespaces);
  try {
    const value = parent(payload, [first, fallback, second]);
    const rendered = visible(value);
    assert.deepEqual(inputs, ["\n\n  tail\t\nlast  \n", "\n\n  tail\t\nlast  \n\nFIRST"]);
    assert.match(rendered, /tail[\s\S]*last[\s\S]*FIRST[\s\S]*SECOND/);
    assert.deepEqual(cards(value).map(card => card.skillBlock.name), ["one", "two"]);
    assert.equal(value.text, payload);
  } finally { assert.deepEqual(adapter.dispose(), []); }
});

supportedTest("malformed later skills reject adaptation and retain full-input named fallback", () => {
  const text = `${block("one")}\n\n<skill name="bad">\nbroken`;
  const inputs: string[] = [];
  const observer: MarkdownTransformer = text => { inputs.push(text); return text; };
  const adapter = installSkillCards({ getExpanded: () => false, fallbackTransformer: fallback }, namespaces);
  try {
    const value = parent(text, [observer, fallback]);
    assert.match(visible(value), /\[skill\] one \(ctrl\+o to expand\)[\s\S]*broken/);
    assert.deepEqual(inputs, [text]);
    assert.equal(cards(value).length, 0);
    assert.equal(value.text, text);
  } finally { assert.deepEqual(adapter.dispose(), []); }
});

supportedTest("constructor fault prepares without changing live tree and restores full fallback", () => {
  let value: Parent | undefined;
  let oldChildren: LocalTui.Component[] | undefined;
  const observations: { childrenUnchanged: boolean; text: string }[] = [];
  class BrokenCard extends RealHost.SkillInvocationMessageComponent {
    constructor(...args: ConstructorParameters<typeof RealHost.SkillInvocationMessageComponent>) {
      super(...args);
      if (value) observations.push({ childrenUnchanged: value.children === oldChildren, text: value.text });
      throw new Error("card construction failed");
    }
  }
  const adapter = installSkillCards({ getExpanded: () => true, fallbackTransformer: fallback },
    { host: { ...RealHost, SkillInvocationMessageComponent: BrokenCard }, tui: RealTui });
  try {
    value = parent();
    oldChildren = value.children;
    value.rebuild();
    assert.deepEqual(observations, [{ childrenUnchanged: true, text: payload }]);
    assert.match(visible(value), /\[skill\] one \(ctrl\+o to expand\)[\s\S]*\[skill\] two \(ctrl\+o to expand\)/);
    assert.equal(visible(value).includes("ONE BODY"), false);
    assert.equal(cards(value).length, 0);
  } finally { assert.deepEqual(adapter.dispose(), []); }
});

supportedTest("scratch rebuild faults leave the live parent intact before full-input fallback", () => {
  const proto = RealHost.UserMessageComponent.prototype as unknown as Parent;
  const old = Object.getOwnPropertyDescriptor(proto, "rebuild")!;
  const original = proto.rebuild;
  let value: Parent | undefined;
  let oldChildren: LocalTui.Component[] | undefined;
  const observations: boolean[] = [];
  proto.rebuild = function () {
    if (!(this instanceof RealHost.UserMessageComponent)) {
      if (value) observations.push(value.children === oldChildren);
      throw new Error("scratch rebuild failed");
    }
    original.call(this);
  };
  const adapter = installSkillCards({ getExpanded: () => true, fallbackTransformer: fallback }, namespaces);
  try {
    value = parent();
    oldChildren = value.children;
    value.rebuild();
    assert.deepEqual(observations, [true]);
    assert.match(visible(value), /\[skill\] one \(ctrl\+o to expand\)[\s\S]*\[skill\] two \(ctrl\+o to expand\)/);
    assert.equal(cards(value).length, 0);
  } finally {
    assert.deepEqual(adapter.dispose(), []);
    Object.defineProperty(proto, "rebuild", old);
  }
});

supportedTest("identical raw blocks keep independent ordinal state on rebuild", () => {
  const adapter = installSkillCards({ getExpanded: () => false, fallbackTransformer: fallback }, namespaces);
  try {
    const value = parent(`${block("one")}\n\n${block("one")}\n\nTAIL`);
    cards(value)[1]!.setExpanded(true);
    value.rebuild();
    assert.deepEqual(cards(value).map(card => card.expanded), [false, true]);
    assert.match(visible(value), /\[skill\] one \(ctrl\+o to expand\)[\s\S]*ONE BODY[\s\S]*TAIL/);
  } finally { assert.deepEqual(adapter.dispose(), []); }
});

supportedTest("dispose restores live trees, retained foreign wrappers delegate, and reinstall owns one patch", () => {
  const proto = RealHost.UserMessageComponent.prototype as unknown as Parent;
  const oldRebuild = Object.getOwnPropertyDescriptor(proto, "rebuild")!;
  const oldExpanded = Object.getOwnPropertyDescriptor(proto, "setExpanded");
  let getterCalls = 0;
  const options = { getExpanded: () => { getterCalls++; return true; }, fallbackTransformer: fallback };
  const first = installSkillCards(options, namespaces);
  const value = parent();
  const second = installSkillCards(options, namespaces);
  try {
    assert.deepEqual(first.dispose(), []);
    value.rebuild();
    assert.equal(cards(value).length, 2);
    const held = proto.rebuild;
    const outer = function (this: Parent) { return held.call(this); };
    proto.rebuild = outer;
    assert.deepEqual(second.dispose(), []);
    assert.equal(proto.rebuild, outer);
    assert.deepEqual(Object.getOwnPropertyDescriptor(proto, "setExpanded"), oldExpanded);
    const callsBefore = getterCalls;
    value.rebuild();
    assert.equal(getterCalls, callsBefore);
    assert.match(visible(value), /\[skill\] one \(ctrl\+o to expand\)[\s\S]*\[skill\] two \(ctrl\+o to expand\)/);
    assert.equal(cards(value).length, 0);
    assert.deepEqual(second.dispose(), []);
  } finally {
    second.dispose();
    Object.defineProperty(proto, "rebuild", oldRebuild);
  }
});

supportedTest("dispose reports each failed live-tree restore and continues to healthy parents", () => {
  const proto = RealHost.UserMessageComponent.prototype as unknown as Parent;
  const old = Object.getOwnPropertyDescriptor(proto, "rebuild")!;
  const original = proto.rebuild;
  let bad: Parent | undefined;
  proto.rebuild = function () {
    if (this === bad) throw new Error("restore failed");
    original.call(this);
  };
  const adapter = installSkillCards({ getExpanded: () => true, fallbackTransformer: fallback }, namespaces);
  try {
    bad = parent();
    const healthy = parent();
    assert.deepEqual(adapter.dispose(), ["Error: restore failed"]);
    assert.match(visible(healthy), /\[skill\] one \(ctrl\+o to expand\)[\s\S]*\[skill\] two \(ctrl\+o to expand\)/);
    assert.equal(cards(healthy).length, 0);
  } finally {
    adapter.dispose();
    Object.defineProperty(proto, "rebuild", old);
    bad?.rebuild();
  }
});

test("scanner retains UTF-16 offsets, repeated raw ordinals and exact tail, and rejects nested or broken prefixes", () => {
  const raw = block("同名", "é😀 body");
  const text = `${raw}\n\n${raw}\n\n \t尾\r\n  `;
  const plan = scanLeadingSkills(text);
  assert.deepEqual(plan.blocks.map(({ raw, ordinal, start, end }) => ({ raw, ordinal, start, end })), [
    { raw, ordinal: 0, start: 0, end: raw.length },
    { raw, ordinal: 1, start: raw.length + 2, end: raw.length * 2 + 2 },
  ]);
  assert.equal(plan.tail, "\n\n \t尾\r\n  ");
  assert.equal(plan.valid, true);
  for (const text of [block("outer", raw), block("outer", "</skill> literal"), `${raw}\n\n<skill name="bad">\nbroken`, raw.replace("\n", "\r\n")]) {
    assert.equal(scanLeadingSkills(text).valid, false);
  }
});

supportedTest("mount tracking sweeps tracked references on a doubling schedule instead of once per mount", () => {
  const originalDeref = WeakRef.prototype.deref;
  let derefs = 0;
  WeakRef.prototype.deref = function (this: WeakRef<object>) {
    derefs += 1;
    return originalDeref.call(this);
  };
  const adapter = installSkillCards({ getExpanded: () => false, fallbackTransformer: fallback }, namespaces);
  const firstBatch: Parent[] = [];
  const secondBatch: Parent[] = [];
  try {
    for (let index = 0; index < 64; index += 1) firstBatch.push(parent());
    const firstScan = derefs;
    for (let index = 0; index < 64; index += 1) secondBatch.push(parent());
    const secondScan = derefs - firstScan;
    assert.ok(firstScan > 0, "registration must sweep tracked references at least once");
    assert.ok(secondScan <= firstScan * 2,
      `second 64 mounts scanned ${secondScan} references versus ${firstScan} for the first 64; expected amortized doubling, not a full scan per mount`);
  } finally {
    WeakRef.prototype.deref = originalDeref;
    assert.deepEqual(adapter.dispose(), []);
  }
});

supportedTest("fallback then remount registers one reference so dispose restores the parent exactly once", () => {
  const proto = RealHost.UserMessageComponent.prototype as unknown as Parent;
  const old = Object.getOwnPropertyDescriptor(proto, "rebuild")!;
  const original = proto.rebuild;
  let target: Parent | undefined;
  let disposing = false;
  let restores = 0;
  proto.rebuild = function () {
    if (disposing && this === target) restores += 1;
    return original.call(this);
  };
  const adapter = installSkillCards({ getExpanded: () => true, fallbackTransformer: fallback }, namespaces);
  try {
    target = parent();
    target.text = "no leading skill";
    target.rebuild();
    target.text = payload;
    target.rebuild();
    disposing = true;
    assert.deepEqual(adapter.dispose(), []);
    assert.equal(restores, 1);
  } finally {
    disposing = false;
    adapter.dispose();
    Object.defineProperty(proto, "rebuild", old);
  }
});
