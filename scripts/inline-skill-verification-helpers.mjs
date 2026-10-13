import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export const sleep = ms => new Promise(done => setTimeout(done, ms));

export const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export function snapshotExtensionHashes(ccRoot) {
  const files = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push({ path: file.slice(ccRoot.length + 1), sha256: hash(file) });
    }
  }
  walk(`${ccRoot}/extensions`);
  return files;
}
