import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { quote, tmux, sleep, hash, snapshotExtensionHashes } from './inline-skill-verification-helpers.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.env.INLINE_VERIFY_CLI ?? '/Users/rolex/Library/pnpm/bin/pi';
const ccRoot = process.env.INLINE_VERIFY_CC_ROOT ?? `${process.env.HOME}/.pi/agent/npm/node_modules/pi-cc-extensions`;
const cc = `${ccRoot}/extensions/index.ts`;
const project = `${repo}/extensions/index.ts`;
const observer = `${repo}/scripts/observe-inline-skill-interaction.ts`;
const base = `${repo}/.agents/notes/inline-skill-runtime/interaction`;
mkdirSync(base, { recursive: true });
const out = mkdtempSync(`${base}/run.`);
const before = snapshotExtensionHashes(ccRoot);
writeFileSync(`${out}/cc-hashes-before.json`, JSON.stringify(before, null, 2));
const sourcePaths = [cli, cc, project, `${repo}/extensions/skill-cards.ts`, observer];
const sources = sourcePaths.map(path => ({ path, realpath: realpathSync(path), sha256: hash(path) }));
writeFileSync(`${out}/sources-before.json`, JSON.stringify(sources, null, 2));
const reports = [];
function record(gate, status, detail) {
  reports.push({ gate, status, detail });
  writeFileSync(`${out}/assertions.json`, JSON.stringify(reports, null, 2));
  console.log(`${status} ${gate} ${detail}`);
}
const name = `inline-interaction-${process.pid}`;
let started = false;
const kill = () => { if (started) { try { tmux('kill-session', '-t', name); } catch {} started = false; } };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { kill(); process.exit(130); });
const names = ['first', 'second', 'third'];
const body = card => `${card.toUpperCase()}_BODY_SENTINEL`;
function text(identity, long = false) {
  return names.map(card => `<skill name="${card}" location="/tmp/${card}/SKILL.md">\n${body(card)}\n${long && card === 'second' ? Array.from({ length: 60 }, (_, index) => `LONG_LINE_${String(index).padStart(2, '0')} long narrow wrapping content with words repeated across a terminal width of forty eight columns.`).join('\n') + '\nLONG_CONTENT_END_MARKER\n' : ''}</skill>`).join('\n\n') + `\n\n${identity}\nUSER_TAIL_SENTINEL\ntrailing marker`;
}
mkdirSync(`${out}/agent/sessions`, { recursive: true });
mkdirSync(`${out}/work`);
writeFileSync(`${out}/agent/settings.json`, JSON.stringify({ quietStartup: false, telemetry: false }));
function fixture(label, long = false) {
  const id = randomUUID(), timestamp = new Date().toISOString();
  const path = `${out}/agent/sessions/${label}.jsonl`;
  writeFileSync(path, [
    { type: 'session', version: 3, id, timestamp, cwd: `${out}/work` },
    { type: 'session_info', id: randomUUID().slice(0, 8), parentId: null, timestamp, name: label },
    { type: 'message', id: randomUUID().slice(0, 8), parentId: null, timestamp, message: { role: 'user', content: [{ type: 'text', text: text(label, long) }], timestamp: Date.now() } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  return { id, path, label };
}
const initial = fixture('INTERACTION_INITIAL');
const replacement = fixture('INTERACTION_REPLACEMENT');
const longFixture = fixture('INTERACTION_LONG', true);
writeFileSync(`${out}/fixtures.json`, JSON.stringify({ initial, replacement, longFixture }, null, 2));
let captureIndex = 0;
function capture(step) {
  const prefix = `${out}/${String(++captureIndex).padStart(3, '0')}-${step}`;
  const plain = tmux('capture-pane', '-p', '-t', name);
  const ansi = tmux('capture-pane', '-e', '-p', '-t', name);
  writeFileSync(`${prefix}.txt`, plain);
  writeFileSync(`${prefix}.ansi.txt`, ansi);
  return { plain, ansi, prefix };
}
async function wait(step, predicate, attempts = 40) {
  let screen;
  for (let attempt = 0; attempt < attempts; attempt++) {
    screen = capture(step);
    if (predicate(screen.plain)) return screen;
    await sleep(250);
  }
  throw new Error(`${step} not visible in current pane; ${screen.prefix}`);
}
async function packet(code, col, row, final = 'M') {
  writeFileSync(`${out}/packets.jsonl`, JSON.stringify({ code, col, row, final, timestamp: new Date().toISOString() }) + '\n', { flag: 'a' });
  tmux('send-keys', '-t', name, '-l', `\x1b[<${code};${col};${row}${final}`);
  await sleep(250);
}
function coords(card) {
  const lines = tmux('capture-pane', '-p', '-t', name).split('\n');
  const matches = lines.map((line, index) => line.includes(`✓ Skill ${card}`) ? index : -1).filter(index => index >= 0);
  assert.equal(matches.length, 1, `one visible ${card} title, no history search`);
  const row = matches[0], line = lines[row];
  const hint = /click to show more|click to show less|ctrl\+o to show more/.exec(line);
  return { col: (hint?.index ?? line.indexOf(`Skill ${card}`)) + 2, row: row + 1 };
}
async function click(card) {
  const { col, row } = coords(card);
  await packet(0, col, row);
  await packet(0, col, row, 'm');
}
async function command(value) {
  tmux('send-keys', '-t', name, 'C-u');
  tmux('send-keys', '-t', name, '-l', value);
  tmux('send-keys', '-t', name, 'Enter');
  await sleep(400);
  let pane = tmux('capture-pane', '-p', '-t', name);
  if (pane.split('\n').some(line => line.trim() === value)) {
    tmux('send-keys', '-t', name, 'Enter');
    await sleep(400);
    pane = tmux('capture-pane', '-p', '-t', name);
  }
  assert(!pane.split('\n').some(line => line.trim() === value), `${value} not left in editor`);
}
async function observe(step, rebuild = false) {
  writeFileSync(`${out}/observation.json`, '{}');
  await command(`/interaction-observe${rebuild ? ' rebuild' : ''}`);
  let value;
  for (let attempt = 0; attempt < 12; attempt++) {
    value = JSON.parse(readFileSync(`${out}/observation.json`, 'utf8'));
    if (value.id || value.error) break;
    await sleep(100);
  }
  writeFileSync(`${out}/${step}.state.json`, JSON.stringify(value, null, 2));
  assert(!value.error, value.error);
  assert.equal(value.cards?.length, 3, 'three actual public host skill cards');
  return value;
}
async function state(step, expected, identity = initial, rebuild = false) {
  const screen = capture(step);
  const value = await observe(step, rebuild);
  assert.equal(value.id, identity.id, 'current session identity matches fixture');
  assert.equal(realpathSync(value.file), realpathSync(identity.path));
  assert.deepEqual(value.cards.map(card => card.expanded), expected);
  return { screen, value };
}
async function gate(label, action) {
  try { await action(); record(label, 'PASS', 'current-pane captures and public host state assertions passed'); }
  catch (error) { record(label, 'ISSUES', String(error)); }
}
function launch(session) {
  const env = { PI_CODING_AGENT_DIR: `${out}/agent`, PI_CODING_AGENT_SESSION_DIR: `${out}/agent/sessions`, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', PI_TUI_WRITE_LOG: `${out}/${session.label}.ansi.raw`, INLINE_INTERACTION_OBSERVATIONS: out, INLINE_INTERACTION_SECOND: replacement.path };
  const argv = [cli, '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--tui-mode', 'fullscreen', '--session', session.path, '-e', cc, '-e', project, '-e', observer];
  const path = `${out}/${session.label}.command.sh`;
  writeFileSync(path, `exec env ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(' ')} ${argv.map(quote).join(' ')}\n`);
  tmux('new-session', '-d', '-s', name, '-x', '120', '-y', '65', '-c', `${out}/work`, `bash ${quote(path)}`);
  started = true;
}
try {
  const version = execFileSync(cli, ['--no-extensions', '--version'], { encoding: 'utf8', env: { ...process.env, PI_CODING_AGENT_DIR: `${out}/agent`, PI_OFFLINE: '1' } }).trim();
  writeFileSync(`${out}/version.txt`, version + '\n');
  assert.equal(version, '1.2.0');
  launch(initial);
  await wait('initial-ready', pane => pane.includes(initial.label) && pane.includes('✓ Skill third'));
  await gate('fullscreen-production-initial', async () => {
    const { screen } = await state('initial', [false, false, false]);
    for (const card of names) assert.match(screen.plain, new RegExp(`✓ Skill ${card}[^\\n]*click to show more`));
    assert(screen.plain.includes('USER_TAIL_SENTINEL') && screen.plain.includes('trailing marker'));
    assert(!screen.plain.includes('[skill]') && !/<\/?skill[\s>]/.test(screen.plain));
  });
  for (const card of names) await gate(`fullscreen-hover-${card}`, async () => {
    await packet(35, 115, 1);
    const beforeHover = capture(`unhover-${card}`);
    const { col, row } = coords(card);
    await packet(35, col, row);
    const hovered = capture(`hover-${card}`);
    const line = screen => screen.ansi.split('\n').find(value => value.includes(`Skill ${card}`));
    assert.notEqual(line(hovered), line(beforeHover), 'ANSI hint changed while hovered');
    await packet(35, 115, 1);
    const restored = capture(`hover-restored-${card}`);
    assert.equal(line(restored), line(beforeHover), 'ANSI hint restored after leaving');
  });
  for (const [index, card] of names.entries()) await gate(`fullscreen-click-collapse-${card}`, async () => {
    await click(card);
    const expected = names.map((_name, cardIndex) => cardIndex === index);
    const { screen } = await state(`click-${card}`, expected);
    for (const [cardIndex, other] of names.entries()) assert.equal(screen.plain.includes(body(other)), cardIndex === index);
    await click(card);
    const collapsed = await state(`collapse-${card}`, [false, false, false]);
    for (const other of names) assert(!collapsed.screen.plain.includes(body(other)));
  });
  await gate('single-expand-later-card', async () => {
    await click('first');
    await state('single-first', [true, false, false]);
    await click('second');
    const { screen } = await state('single-second', [false, true, false]);
    assert(screen.plain.includes(body('second')) && !screen.plain.includes(body('first')));
    await packet(0, 115, 1); await packet(0, 115, 1, 'm');
    await state('outside-click', [false, true, false]);
  });
  await gate('independent-state-rebuild-resize-recollapse', async () => {
    await state('same-padding-rebuild', [false, true, false], initial, true);
    await state('post-rebuild', [false, true, false]);
    tmux('resize-window', '-t', name, '-x', '48', '-y', '35'); await sleep(500);
    await state('narrow-resize', [false, true, false]);
    await click('second');
    await state('narrow-recollapsed', [false, false, false]);
    tmux('resize-window', '-t', name, '-x', '120', '-y', '65'); await sleep(500);
    await state('wide-restored', [false, false, false]);
  });
  await gate('interactive-resume-global-expanded', async () => {
    tmux('send-keys', '-t', name, 'C-o'); await sleep(400);
    const { value } = await state('pre-resume-expanded', [true, true, true]);
    assert.equal(value.globalExpanded, true);
    await command('/resume');
    await wait('resume-selector', pane => /Resume Session \((?:Current Folder|All)\)/.test(pane) && pane.includes('tab scope') && pane.includes('ctrl+s sort'));
    tmux('send-keys', '-t', name, '-l', replacement.label); await sleep(500);
    capture('resume-filtered');
    tmux('send-keys', '-t', name, 'Enter');
    await wait('replacement-ready', pane => pane.includes(replacement.label) && pane.includes('✓ Skill third'));
    const replaced = await state('replacement-expanded', [true, true, true], replacement);
    assert.equal(replaced.value.globalExpanded, true);
    for (const card of names) assert(replaced.screen.plain.includes(body(card)));
    assert(!replaced.screen.plain.includes(initial.label), 'old transcript absent from current pane');
    const events = readFileSync(`${out}/session-events.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert(events.some(event => event.id === replacement.id && event.expanded === true), 'session_start identity and inherited global expansion');
  });
  kill();
  launch(longFixture);
  await wait('long-ready', pane => pane.includes(longFixture.label) && pane.includes('✓ Skill second'));
  await gate('long-content-narrow-scroll-tail', async () => {
    await click('second');
    const expanded = await observe('long-expanded');
    assert.deepEqual(expanded.cards.map(card => card.expanded), [false, true, false]);
    assert.equal(expanded.id, longFixture.id);
    tmux('resize-window', '-t', name, '-x', '48', '-y', '30'); await sleep(500);
    const narrow = await observe('long-narrow');
    assert.deepEqual(narrow.cards.map(card => card.expanded), [false, true, false]);
    const scrollBudget = 300;
    let endVisible = false, tailVisible = false;
    for (let attempt = 0; attempt < scrollBudget; attempt++) {
      await packet(65, 22, 8);
      const pane = capture(`long-scroll-down-${attempt}`).plain;
      endVisible ||= pane.includes('LONG_CONTENT_END_MARKER');
      tailVisible ||= pane.includes('USER_TAIL_SENTINEL') && pane.includes('trailing marker');
      if (endVisible && tailVisible) break;
    }
    assert(endVisible, 'long card end marker observed in actual current fullscreen viewport');
    assert(tailVisible, 'tail intact after long card scroll');
    let titleVisible = false;
    for (let attempt = 0; attempt < scrollBudget; attempt++) {
      await packet(64, 22, 8);
      const pane = capture(`long-scroll-up-${attempt}`).plain;
      if (pane.includes('✓ Skill second')) { titleVisible = true; break; }
    }
    assert(titleVisible, 'scroll back to actual second title');
    await click('second');
    const collapsed = await observe('long-recollapsed');
    assert.deepEqual(collapsed.cards.map(card => card.expanded), [false, false, false]);
    tmux('resize-window', '-t', name, '-x', '120', '-y', '65'); await sleep(500);
    const final = capture('long-tail-restored');
    assert(final.plain.includes(longFixture.label) && final.plain.includes('USER_TAIL_SENTINEL') && final.plain.includes('trailing marker'));
    assert(!final.plain.includes('LONG_CONTENT_END_MARKER'));
  });
} catch (error) { record('environment', 'BLOCKED', String(error)); }
finally {
  kill();
  const after = snapshotExtensionHashes(ccRoot);
  writeFileSync(`${out}/cc-hashes-after.json`, JSON.stringify(after, null, 2));
  record('installed-cc-hashes', JSON.stringify(before) === JSON.stringify(after) ? 'PASS' : 'ISSUES', `${before.length} CC extension files compared`);
  const sourcesAfter = sourcePaths.map(path => ({ path, realpath: realpathSync(path), sha256: hash(path) }));
  writeFileSync(`${out}/sources-after.json`, JSON.stringify(sourcesAfter, null, 2));
  record('immutable-production-sources', JSON.stringify(sources) === JSON.stringify(sourcesAfter) ? 'PASS' : 'ISSUES', 'CLI, installed CC, production entries, observer hashes compared');
  writeFileSync(`${out}/summary.json`, JSON.stringify({ command: 'node scripts/verify-inline-skill-interaction.mjs', reports, scope: 'original installed CC plus production project, fullscreen mouse and session replacement; no CC clone execution, no configuration reads, no behavior patch, no model requests', out }, null, 2));
  console.log(`Artifacts ${out}`);
  if (reports.some(report => report.status !== 'PASS')) process.exitCode = 1;
}
