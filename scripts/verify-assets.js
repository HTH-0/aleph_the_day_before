#!/usr/bin/env node
// vendor/aleph-t04의 파일 바이트를 asset-manifest.json의 sha256과 대조한다.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(root, 'vendor', 'aleph-t04');
const manifest = JSON.parse(await readFile(join(base, 'asset-manifest.json'), 'utf8'));

console.log(`package_id: ${manifest.package_id}`);
let bad = 0;
for (const entry of manifest.files) {
  const bytes = await readFile(join(base, entry.path));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const ok = hash === entry.sha256 && bytes.length === entry.bytes;
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${entry.path} (${bytes.length}B) ${hash.slice(0, 16)}…`);
}
console.log(bad === 0 ? '전체 일치' : `불일치 ${bad}건`);
process.exit(bad === 0 ? 0 : 1);
