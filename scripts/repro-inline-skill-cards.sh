#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd -P)
cli=/Users/rolex/Library/pnpm/bin/pi
cc="$HOME/.pi/agent/npm/node_modules/pi-cc-extensions/extensions/index.ts"
mode=mismatch
case "${1:-}" in
  '') ;;
  --expect-parity) mode=parity ;;
  *) printf 'Usage: bash scripts/repro-inline-skill-cards.sh [--expect-parity]\n' >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || exit 2
for tool in node tmux; do command -v "$tool" >/dev/null || { printf 'Missing %s\n' "$tool" >&2; exit 2; }; done
[[ -x "$cli" && -f "$cc" && -f "$repo/extensions/index.ts" ]] || { printf 'Missing fixed runtime or extension entry\n' >&2; exit 2; }
base="$repo/.agents/notes/inline-skill-runtime/before"
mkdir -p "$base"
out=$(mktemp -d "$base/run.XXXXXX")
mkdir -p "$out/agent/sessions" "$out/work"
name="slash-inline-$$-${out##*.}"
trap 'tmux kill-session -t "$name" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Artifacts %s\n' "$out"
export PI_CODING_AGENT_DIR="$out/agent" PI_CODING_AGENT_SESSION_DIR="$out/agent/sessions"
export PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1
"$cli" --no-extensions --version > "$out/version.txt"
grep -Eq '^1\.1\.0$' "$out/version.txt" || { printf 'Expected Pi 1.1.0\n' >&2; exit 2; }
node --input-type=module - "$out" "$cc" "$cli" "$repo" <<'NODE'
import {writeFileSync, readFileSync, realpathSync} from 'node:fs';
import {randomUUID, createHash} from 'node:crypto';
const [out, cc, cli, repo] = process.argv.slice(2);
const timestamp = new Date().toISOString();
const text = '<skill name="first" location="/tmp/first/SKILL.md">\nFIRST_BODY_SENTINEL\n</skill>\n\n<skill name="second" location="/tmp/second/SKILL.md">\nSECOND_BODY_SENTINEL\n</skill>\n\nUSER_TAIL_SENTINEL';
writeFileSync(`${out}/session.jsonl`, [
  {type:'session',version:3,id:randomUUID(),timestamp,cwd:`${out}/work`},
  {type:'message',id:'11111111',parentId:null,timestamp,message:{role:'user',content:[{type:'text',text}],timestamp:Date.now()}}
].map(entry => JSON.stringify(entry)).join('\n') + '\n');
writeFileSync(`${out}/agent/settings.json`, JSON.stringify({quietStartup:false,telemetry:false}));
writeFileSync(`${out}/sources.json`, JSON.stringify([cli, cc, `${repo}/extensions/index.ts`].map(path => ({path,realpath:realpathSync(path),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})), null, 2));
NODE
printf '%q ' env PI_CODING_AGENT_DIR="$out/agent" PI_CODING_AGENT_SESSION_DIR="$out/agent/sessions" PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 PI_TUI_WRITE_LOG="$out/ansi.raw" "$cli" --offline --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --no-themes --tui-mode regular --session "$out/session.jsonl" -e "$cc" -e "$repo/extensions/index.ts" > "$out/command.sh"
printf '\n' >> "$out/command.sh"
printf 'printf "%%s\\n" "$?" > %q; sleep 300\n' "$out/exit-code.txt" >> "$out/command.sh"
printf -v launch 'bash %q' "$out/command.sh"
tmux new-session -d -s "$name" -x 120 -y 45 -c "$out/work" "$launch"
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  tmux capture-pane -p -S -200 -t "$name" > "$out/collapsed.txt"
  if [[ -f "$out/exit-code.txt" ]]; then printf 'Pi exited before capture; inspect artifacts\n' >&2; exit 2; fi
  if grep -q '✓ Skill first' "$out/collapsed.txt" && grep -q USER_TAIL_SENTINEL "$out/collapsed.txt"; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { printf 'Timed out waiting for first CC card and user tail\n' >&2; exit 2; }
tmux capture-pane -e -p -S -200 -t "$name" > "$out/collapsed.ansi.txt"
tmux send-keys -t "$name" C-o
ready=false
for ((attempt=0; attempt<30; attempt++)); do
  tmux capture-pane -p -S -200 -t "$name" > "$out/expanded.txt"
  if grep -q FIRST_BODY_SENTINEL "$out/expanded.txt" && grep -q SECOND_BODY_SENTINEL "$out/expanded.txt"; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { printf 'Timed out waiting for both expanded bodies\n' >&2; exit 2; }
tmux capture-pane -e -p -S -200 -t "$name" > "$out/expanded.ansi.txt"
node --input-type=module - "$out" "$mode" <<'NODE'
import {readFileSync, writeFileSync} from 'node:fs';
const [out, mode] = process.argv.slice(2);
const collapsed = readFileSync(`${out}/collapsed.txt`, 'utf8');
const expanded = readFileSync(`${out}/expanded.txt`, 'utf8');
const checks = [
  ['first card uses original CC hint', /✓ Skill first[^\n]*ctrl\+o to show more/.test(collapsed)],
  ['collapsed bodies are hidden', !/FIRST_BODY_SENTINEL|SECOND_BODY_SENTINEL/.test(collapsed)],
  ['collapsed user tail remains', collapsed.includes('USER_TAIL_SENTINEL')],
  ['Ctrl+O reveals both bodies and tail in order', /FIRST_BODY_SENTINEL[\s\S]*SECOND_BODY_SENTINEL[\s\S]*USER_TAIL_SENTINEL/.test(expanded)],
  [mode === 'parity' ? 'second card matches original CC hint' : 'second card retains mismatched legacy hint', mode === 'parity' ? /✓ Skill second[^\n]*ctrl\+o to show more/.test(collapsed) && !collapsed.includes('[skill]') : /\[skill\] second[^\n]*ctrl\+o to expand/.test(collapsed)]
];
const report = checks.map(([label, ok]) => `${ok ? 'PASS' : 'FAIL'} ${label}`).join('\n') + '\n';
writeFileSync(`${out}/assertions.txt`, report);
process.stdout.write(report);
if (checks.some(([,ok]) => !ok)) process.exitCode = 1;
NODE
