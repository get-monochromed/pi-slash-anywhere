import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Helpers = {
  hash: (path: string) => string;
  quote: (value: string) => string;
  snapshotExtensionHashes: (ccRoot: string) => { path: string; sha256: string }[];
};
const helpers = await import(new URL("../scripts/inline-skill-verification-helpers.mjs", import.meta.url).href) as Helpers;
const { hash, quote, snapshotExtensionHashes } = helpers;

const digest = (content: string) => createHash("sha256").update(content).digest("hex");

test("snapshotExtensionHashes yields sorted relative paths with sha256 digests and symlink entries", () => {
  const ccRoot = mkdtempSync(join(tmpdir(), "pi-verify-cc-"));
  try {
    mkdirSync(join(ccRoot, "extensions", "nested"), { recursive: true });
    writeFileSync(join(ccRoot, "extensions", "b.md"), "B");
    writeFileSync(join(ccRoot, "extensions", "a.md"), "A");
    writeFileSync(join(ccRoot, "extensions", "nested", "d.md"), "D");
    writeFileSync(join(ccRoot, "extensions", "nested", "c.md"), "C");
    symlinkSync("a.md", join(ccRoot, "extensions", "link.md"));
    const expected = [
      { path: "extensions/a.md", sha256: digest("A") },
      { path: "extensions/b.md", sha256: digest("B") },
      { path: "extensions/link.md", sha256: digest("A") },
      { path: "extensions/nested/c.md", sha256: digest("C") },
      { path: "extensions/nested/d.md", sha256: digest("D") },
    ];
    assert.deepEqual(snapshotExtensionHashes(ccRoot), expected);
  } finally {
    rmSync(ccRoot, { recursive: true, force: true });
  }
});

test("quote single-quote escapes and sha256 hashing match the extracted inline implementations", () => {
  assert.equal(quote("/tmp/it's a test"), "'/tmp/it'\\''s a test'");
  const ccRoot = mkdtempSync(join(tmpdir(), "pi-verify-hash-"));
  try {
    const file = join(ccRoot, "sources.json");
    writeFileSync(file, '{"path":"a"}');
    assert.equal(hash(file), digest('{"path":"a"}'));
  } finally {
    rmSync(ccRoot, { recursive: true, force: true });
  }
});
