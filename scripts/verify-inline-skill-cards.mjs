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
const base = `${repo}/.agents/notes/inline-skill-runtime/final`;
mkdirSync(base, { recursive: true });
const out = mkdtempSync(`${base}/run.`);
const reports = [];
const owned = new Set();
const kill = name => { try { tmux('kill-session', '-t', name); } catch {} owned.delete(name); };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const name of owned) kill(name); process.exit(130); });
const before = snapshotExtensionHashes(ccRoot);
writeFileSync(`${out}/cc-hashes-before.json`, JSON.stringify(before, null, 2));
const tail = 'USER_TAIL_SENTINEL';
const names = ['first', 'second', 'third'];
const text = names.map(name => `<skill name="${name}" location="/tmp/${name}/SKILL.md">\n${name.toUpperCase()}_BODY_SENTINEL\n</skill>`).join('\n\n') + `\n\n  ${tail}\t\ninner line\ntrailing marker`;
writeFileSync(`${out}/sources.json`, JSON.stringify([cli, cc, project, `${repo}/extensions/skill-cards.ts`].map(path => ({ path, realpath: realpathSync(path), sha256: hash(path) })), null, 2));
const scenarios = [
  { label: 'cc-first', extensions: [cc, project], hasCc: true },
  { label: 'project-first', extensions: [project, cc], hasCc: true },
  { label: 'no-cc', extensions: [project], hasCc: false },
];
try {
  mkdirSync(`${out}/version-agent`, { recursive: true });
  const version = execFileSync(cli, ['--no-extensions', '--version'], { encoding: 'utf8', env: { ...process.env, PI_CODING_AGENT_DIR: `${out}/version-agent`, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' } }).trim();
  writeFileSync(`${out}/version.txt`, `${version}\n`);
  assert.equal(version, '1.1.0');
  for (const scenario of scenarios) {
    const { label, extensions, hasCc } = scenario;
    const dir = `${out}/${label}`;
    mkdirSync(`${dir}/agent/sessions`, { recursive: true });
    mkdirSync(`${dir}/work`);
    writeFileSync(`${dir}/agent/settings.json`, JSON.stringify({ quietStartup: false, telemetry: false }));
    const timestamp = new Date().toISOString();
    writeFileSync(`${dir}/session.jsonl`, [
      { type: 'session', version: 3, id: randomUUID(), timestamp, cwd: `${dir}/work` },
      { type: 'message', id: '11111111', parentId: null, timestamp, message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const env = { PI_CODING_AGENT_DIR: `${dir}/agent`, PI_CODING_AGENT_SESSION_DIR: `${dir}/agent/sessions`, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', PI_TUI_WRITE_LOG: `${dir}/ansi.raw` };
    const argv = [cli, '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--tui-mode', 'regular', '--session', `${dir}/session.jsonl`, ...extensions.flatMap(path => ['-e', path])];
    writeFileSync(`${dir}/command.sh`, `exec env ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(' ')} ${argv.map(quote).join(' ')}\n`);
    const name = `inline-production-${process.pid}-${label}`;
    const steps = [];
    const record = (step, status, detail, capture) => {
      const result = { step, status, detail, capture };
      steps.push(result);
      writeFileSync(`${dir}/assertions.json`, JSON.stringify(steps, null, 2));
      console.log(`${status} ${label}/${step} ${detail}`);
      return status === 'PASS';
    };
    function capture(step) {
      const pane = tmux('capture-pane', '-p', '-t', name);
      writeFileSync(`${dir}/${step}.txt`, pane);
      writeFileSync(`${dir}/${step}.ansi.txt`, tmux('capture-pane', '-e', '-p', '-t', name));
      return pane;
    }
    function inspect(pane, style, expanded) {
      const lines = pane.split('\n');
      const starts = lines.map((line, index) => /(?:✓ Skill first|\[skill\] first)/.test(line) || (/^\s*\[skill\]\s*$/.test(line) && /^\s*first\s*$/.test(lines[index + 1] ?? '')) ? index : -1).filter(index => index >= 0);
      const tails = lines.map((line, index) => line.includes(tail) ? index : -1).filter(index => index >= 0);
      const errors = [];
      if (starts.length !== 1 || tails.length !== 1) return { errors: [`ambiguous visible transcript boundaries starts=${starts.length} tails=${tails.length}`] };
      if (starts[0] >= tails[0]) return { errors: ['tail is not after first card'] };
      const block = lines.slice(starts[0], tails[0] + 3).join('\n');
      for (const card of names) {
        const title = style === 'cc' ? new RegExp(`✓ Skill ${card}(?:$|[^a-z])`, 'gm') : new RegExp(`\\[skill\\]\\s+${card}(?:$|[^a-z])`, 'gm');
        if ((block.match(title) ?? []).length !== 1) errors.push(`${card} title does not occur exactly once in ${style} style`);
        const body = block.includes(`${card.toUpperCase()}_BODY_SENTINEL`);
        if (body !== expanded) errors.push(`${card} body visible=${body}, expected=${expanded}`);
        if (!expanded) {
          const hint = style === 'cc' ? new RegExp(`✓ Skill ${card}[^\\n]*ctrl\\+o to show more`) : new RegExp(`\\[skill\\] ${card}[^\\n]*ctrl\\+o to expand`);
          if (!hint.test(block)) errors.push(`${card} incorrect collapsed hint`);
        }
      }
      if (/<\/?skill[\s>]/.test(block)) errors.push('raw skill tag leaked');
      if (style === 'cc' && block.includes('[skill]')) errors.push('duplicate fallback card');
      if (!block.includes('inner line') || !block.includes('trailing marker')) errors.push('tail clipped');
      return { block, errors };
    }
    async function state(step, style, expanded) {
      let observation;
      for (let attempt = 0; attempt < 24; attempt++) {
        observation = inspect(capture(step), style, expanded);
        if (!observation.errors.length) break;
        await sleep(125);
      }
      if (observation.block) writeFileSync(`${dir}/${step}.cards.txt`, observation.block + '\n');
      return record(step, observation.errors.length ? 'ISSUES' : 'PASS', observation.errors.join('; ') || `${style} all three expanded=${expanded}, exact regular hint and intact tail`, `${dir}/${step}.txt`);
    }
    async function command(value) {
      tmux('send-keys', '-t', name, 'C-u');
      tmux('send-keys', '-t', name, '-l', value);
      tmux('send-keys', '-t', name, 'Enter');
      await sleep(300);
      let pane = capture('command-latest');
      for (let attempt = 0; attempt < 3 && pane.split('\n').some(line => line.trim() === value); attempt++) {
        tmux('send-keys', '-t', name, 'Enter');
        await sleep(300);
        pane = capture('command-latest');
      }
      assert(!pane.split('\n').some(line => line.trim() === value), `${value} remains in editor; not executed`);
      const mode = /^\/ccstyle (on|off)$/.exec(value)?.[1];
      if (mode) {
        const configText = readFileSync(`${dir}/agent/pi-cc-extensions.json`, 'utf8');
        writeFileSync(`${dir}/mode-${steps.length}-${mode}.json`, configText);
        assert.equal(JSON.parse(configText).mode, mode, 'isolated CC configuration proves executed mode command');
      }
    }
    async function toggle(step, style, expanded) {
      tmux('send-keys', '-t', name, 'C-o');
      return state(step, style, expanded);
    }
    async function reload(step, style, expanded) {
      await command('/reload');
      let pane = '';
      let response = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        pane = capture(`${step}-response`);
        response = /Reloaded|reloaded/.test(pane) && !/^\s*\/reload\s*$/m.test(pane);
        if (response) break;
        await sleep(150);
      }
      record(`${step}-response`, response ? 'PASS' : 'BLOCKED', response ? pane.split('\n').filter(line => /[Rr]eload|extension/.test(line)).join(' | ') : 'No actual reload response; command echo is not success', `${dir}/${step}-response.txt`);
      await state(step, style, expanded);
      await toggle(`${step}-ctrl-o`, style, !expanded);
      await toggle(`${step}-ctrl-o-restored`, style, expanded);
    }
    try {
      owned.add(name);
      tmux('new-session', '-d', '-s', name, '-x', '120', '-y', '65', '-c', `${dir}/work`, `bash ${quote(`${dir}/command.sh`)}`);
      await sleep(1000);
      const style = hasCc ? 'cc' : 'native';
      await state('initial', style, false);
      await toggle('initial-ctrl-o', style, true);
      const resources = capture('loaded-resources');
      const resourcesOk = resources.includes('pi-slash-anywhere/extensions') && (!hasCc || resources.includes('pi-cc-extensions/extensions')) && !resources.includes('probe.ts');
      record('loaded-resources', resourcesOk ? 'PASS' : 'BLOCKED', 'Actual expanded startup resource list contains production entries only', `${dir}/loaded-resources.txt`);
      await toggle('initial-recollapsed', style, false);
      if (hasCc) {
        await command('/ccstyle off');
        await state('cc-off', 'native', false);
        await toggle('cc-off-ctrl-o', 'native', true);
        await command('/ccstyle on');
        await state('off-ctrl-o-on', 'cc', true);
        await toggle('off-ctrl-o-on-recollapsed', 'cc', false);
        await toggle('off-ctrl-o-on-expanded', 'cc', true);
        await reload('reload-on', 'cc', true);
        await command('/ccstyle off');
        await state('before-reload-off', 'native', true);
        await reload('reload-off', 'native', true);
        await command('/ccstyle on');
        await state('after-reload-off-on', 'cc', true);
        await toggle('final-recollapsed', 'cc', false);
      }
    } catch (error) {
      record('environment', 'BLOCKED', String(error), dir);
    } finally {
      kill(name);
      reports.push({ label, steps });
    }
  }
} finally {
  const after = snapshotExtensionHashes(ccRoot);
  writeFileSync(`${out}/cc-hashes-after.json`, JSON.stringify(after, null, 2));
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  writeFileSync(`${out}/summary.json`, JSON.stringify({ reports, ccHashesUnchanged: unchanged, ccFiles: before.length, command: 'node scripts/verify-inline-skill-cards.mjs', scope: 'regular short three-card initial, global expansion, CC mode and actual reload' }, null, 2));
  console.log(`${unchanged ? 'PASS' : 'ISSUES'} installed CC hashes unchanged (${before.length} files)`);
  console.log(`Artifacts ${out}`);
  if (!unchanged || reports.some(report => report.steps.some(step => step.status !== 'PASS'))) process.exitCode = 1;
}
