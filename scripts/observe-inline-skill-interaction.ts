import { appendFileSync, writeFileSync } from 'node:fs';
import { UserMessageComponent, SkillInvocationMessageComponent, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';

export default function observe(pi: ExtensionAPI) {
  const out = process.env.INLINE_INTERACTION_OBSERVATIONS!;
  pi.on('session_start', (_event, ctx) => {
    appendFileSync(`${out}/session-events.jsonl`, JSON.stringify({ id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(), expanded: ctx.ui.getToolsExpanded() }) + '\n');
  });
  pi.registerCommand('interaction-observe', {
    description: 'Record public host card state. Optional same-padding rebuild.',
    handler: async (args, ctx) => {
      await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
        setTimeout(() => {
          try {
            const components: Component[] = [];
            const seen = new Set<Component>();
            const visit = (component: Component) => {
              if (seen.has(component)) return;
              seen.add(component);
              components.push(component);
              for (const child of (component as { children?: Component[] }).children ?? []) visit(child);
            };
            for (const component of tui.children) visit(component);
            if (args.trim() === 'rebuild') {
              for (const component of components) if (component instanceof UserMessageComponent) component.setOutputPad(1);
              components.length = 0;
              seen.clear();
              for (const component of tui.children) visit(component);
              tui.requestRender();
            }
            const cards = components.filter(component => component instanceof SkillInvocationMessageComponent);
            if (args.trim() === 'layout') {
              const host = tui as Component & { currentLayout?: { root?: unknown }; terminal?: { columns: number } };
              const boxes: unknown[] = [];
              const walkBox = (box: any, path: string) => {
                if (!box) return;
                const width = (() => {
                  for (let current = box; current; current = current.parent) {
                    if (typeof current.scrollView?.getContentWidth === 'function') return current.scrollView.getContentWidth(host.terminal?.columns ?? 120);
                  }
                  return host.terminal?.columns ?? 120;
                })();
                const rows: unknown[] = [];
                const walkRows = (component: any, offset: number, componentPath: string) => {
                  const lines = component.render?.(width) ?? [];
                  rows.push({ path: componentPath, className: component.constructor.name, name: component.skillBlock?.name, offset, count: lines.length, lines });
                  let childOffset = offset;
                  for (const [index, child] of (component.children ?? []).entries()) {
                    walkRows(child, childOffset, `${componentPath}/${index}`);
                    childOffset += child.render?.(width)?.length ?? 0;
                  }
                };
                if (!box.children?.length) walkRows(box.component, 0, path);
                boxes.push({ path, className: box.component?.constructor.name, rect: box.rect, clip: box.clip, lines: box.lines, width, rows });
                for (const [index, child] of (box.children ?? []).entries()) walkBox(child, `${path}/${index}`);
              };
              walkBox(host.currentLayout?.root, 'root');
              writeFileSync(`${out}/layout.json`, JSON.stringify({ boxes }, null, 2));
            }
            writeFileSync(`${out}/observation.json`, JSON.stringify({
              id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(),
              globalExpanded: ctx.ui.getToolsExpanded(), action: args.trim(),
              cards: cards.map(card => ({ className: card.constructor.name, expanded: Reflect.get(card, 'expanded') })),
            }, null, 2));
          } catch (error) {
            writeFileSync(`${out}/observation.json`, JSON.stringify({ error: String(error) }));
          } finally { done(); }
        }, 30);
        return { render: () => [], invalidate() {} };
      }, { overlay: true });
    },
  });
  pi.registerCommand('interaction-api-switch', {
    description: 'API seam only. Actual public session replacement, not interactive resume.',
    handler: async (_args, ctx) => {
      const result = await ctx.switchSession(process.env.INLINE_INTERACTION_SECOND!);
      writeFileSync(`${out}/api-seam.json`, JSON.stringify(result));
    },
  });
}
