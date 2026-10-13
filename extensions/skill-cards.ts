import * as Host from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import type { MarkdownTransformer, ParsedSkillBlock } from "@earendil-works/pi-coding-agent";
import type { Component, Container, MarkdownTheme } from "@earendil-works/pi-tui";
import { scanLeadingSkills } from "./skill-display.js";

type UserFields = Container & {
  text: string;
  markdownTheme: MarkdownTheme;
  outputPad: number;
  markdownTransformers: MarkdownTransformer[];
};
type Rebuild = (this: UserFields) => void;
type SetExpanded = (this: UserFields, expanded: boolean) => void;
type Card = Component & { expanded: boolean; setExpanded: (expanded: boolean) => void };
type HostABI = {
  VERSION: string;
  UserMessageComponent: { prototype: { rebuild: Rebuild; setExpanded?: SetExpanded } };
  SkillInvocationMessageComponent: { new(block: ParsedSkillBlock, theme: MarkdownTheme, padding: number): Card; prototype: Card };
  parseSkillBlock: (text: string) => ParsedSkillBlock | null;
};
type TuiABI = {
  Container: typeof Tui.Container;
  Spacer: typeof Tui.Spacer;
};
type MountedCards = { entries: { raw: string; ordinal: number; card: Card }[]; pendingInitialSync: boolean };
type PatchOwner = {
  active: boolean;
  descriptors: Map<PropertyKey, PropertyDescriptor | undefined>;
  wrappers: Map<string, Rebuild | SetExpanded>;
  mounted: WeakMap<UserFields, MountedCards>;
  refs: Set<WeakRef<UserFields>>;
  registered: WeakSet<UserFields>;
  registrations: number;
  sweepAt: number;
  dispose: () => string[];
};
const slot = Symbol.for("pi-slash-anywhere.skill-cards.v1");

export function installSkillCards(
  { getExpanded, fallbackTransformer }: { getExpanded: () => boolean | undefined; fallbackTransformer: MarkdownTransformer },
  namespaces: { host: unknown; tui: unknown } = { host: Host, tui: Tui },
): { installed: boolean; dispose: () => string[]; synchronizePendingExpansion: () => void } {
  const host = namespaces.host as Partial<HostABI>;
  const tui = namespaces.tui as Partial<TuiABI>;
  const proto = host.UserMessageComponent?.prototype;
  const skill = host.SkillInvocationMessageComponent;
  const parse = host.parseSkillBlock;
  const ContainerClass = tui.Container;
  const SpacerClass = tui.Spacer;
  if ((host.VERSION !== "1.1.0" && host.VERSION !== "1.2.0") || !proto || typeof proto.rebuild !== "function" ||
      typeof skill !== "function" || typeof skill.prototype?.setExpanded !== "function" ||
      typeof parse !== "function" || typeof ContainerClass !== "function" || typeof SpacerClass !== "function") {
    return { installed: false, dispose: () => [], synchronizePendingExpansion: () => {} };
  }
  const previousOwner = Object.getOwnPropertyDescriptor(proto, slot)?.value as PatchOwner | undefined;
  const priorErrors = previousOwner?.dispose() ?? [];
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>(
    ["rebuild", "setExpanded", slot].map(key => [key, Object.getOwnPropertyDescriptor(proto, key)]),
  );
  if ([...descriptors.values()].some(descriptor => descriptor?.configurable === false) || !Object.isExtensible(proto)) {
    return { installed: false, dispose: () => priorErrors, synchronizePendingExpansion: () => {} };
  }
  const originalRebuild = proto.rebuild;
  const originalExpanded = proto.setExpanded;
  const owner: PatchOwner = { active: true, descriptors, wrappers: new Map(), mounted: new WeakMap(), refs: new Set(), registered: new WeakSet(), registrations: 0, sweepAt: 1, dispose: () => [] };
  const rebuild: Rebuild = function () {
    if (!owner.active) return originalRebuild.call(this);
    const previous = owner.mounted.get(this);
    try {
      if (!(this instanceof ContainerClass) || typeof this.text !== "string" ||
          !this.markdownTheme || typeof this.markdownTheme !== "object" || typeof this.outputPad !== "number" ||
          !Array.isArray(this.markdownTransformers) || !Array.isArray(this.children)) throw new Error("unsupported user-message ABI");
      const plan = scanLeadingSkills(this.text);
      if (!plan.valid || !plan.blocks.length) throw new Error("no valid leading skills");
      const tail = new ContainerClass() as UserFields;
      Object.assign(tail, { text: plan.tail, markdownTheme: this.markdownTheme, outputPad: this.outputPad,
        markdownTransformers: this.markdownTransformers.filter(transformer => transformer !== fallbackTransformer) });
      originalRebuild.call(tail);
      const expanded = getExpanded();
      let pendingInitialSync = previous?.pendingInitialSync ?? false;
      const entries = plan.blocks.map(block => {
        const parsed = parse(block.raw);
        if (!parsed || parsed.userMessage !== undefined) throw new Error("invalid skill block");
        const card = new skill(parsed, this.markdownTheme, this.outputPad);
        const previousEntry = previous?.entries[block.ordinal];
        const old = previousEntry && previousEntry.raw === block.raw ? previousEntry : undefined;
        if (!old && expanded === undefined) pendingInitialSync = true;
        card.setExpanded(old ? old.card.expanded : expanded ?? false);
        return { raw: block.raw, ordinal: block.ordinal, card };
      });
      const children: Component[] = [new SpacerClass(1)];
      for (const entry of entries) children.push(entry.card, new SpacerClass(1));
      children.push(...tail.children);
      this.children = children;
      owner.mounted.set(this, { entries, pendingInitialSync });
      if (!previous && !owner.registered.has(this)) {
        owner.registered.add(this);
        owner.refs.add(new WeakRef(this));
        owner.registrations += 1;
        if (owner.registrations >= owner.sweepAt) {
          for (const ref of owner.refs) if (!ref.deref()) owner.refs.delete(ref);
          owner.sweepAt *= 2;
        }
      }
    } catch {
      owner.mounted.delete(this);
      originalRebuild.call(this);
    }
  };
  const setExpanded: SetExpanded = function (expanded) {
    if (typeof originalExpanded === "function") originalExpanded.call(this, expanded);
    if (!owner.active) return;
    for (const entry of owner.mounted.get(this)?.entries ?? []) entry.card.setExpanded(expanded);
  };
  owner.wrappers.set("rebuild", rebuild);
  owner.wrappers.set("setExpanded", setExpanded);
  owner.dispose = () => {
    if (!owner.active) return [];
    owner.active = false;
    const errors = [...priorErrors];
    for (const ref of owner.refs) {
      const parent = ref.deref();
      if (!parent) continue;
      try { originalRebuild.call(parent); } catch (error) { errors.push(String(error)); }
    }
    owner.refs.clear();
    owner.mounted = new WeakMap();
    for (const [key, value] of [...owner.wrappers, [slot, owner] as const]) {
      if (Object.getOwnPropertyDescriptor(proto, key)?.value !== value) continue;
      const old = owner.descriptors.get(key);
      try {
        if (old) Object.defineProperty(proto, key, old);
        else if (!Reflect.deleteProperty(proto, key)) throw new Error(`cannot restore ${String(key)}`);
      } catch (error) { errors.push(String(error)); }
    }
    return errors;
  };
  for (const [key, value] of owner.wrappers) Object.defineProperty(proto, key, { configurable: true, writable: true, value });
  Object.defineProperty(proto, slot, { configurable: true, writable: true, value: owner });
  return {
    installed: true,
    dispose: owner.dispose,
    synchronizePendingExpansion: () => {
      if (!owner.active) return;
      const expanded = getExpanded();
      if (expanded === undefined) return;
      for (const ref of owner.refs) {
        const parent = ref.deref();
        if (!parent) { owner.refs.delete(ref); continue; }
        const mounted = owner.mounted.get(parent);
        if (!mounted?.pendingInitialSync) continue;
        for (const entry of mounted.entries) entry.card.setExpanded(expanded);
        mounted.pendingInitialSync = false;
      }
    },
  };
}
