// verify-assets.js — vendor/aleph-t04 의 파일이 공개 asset-manifest.json 과 바이트 단위로 같은지 확인합니다.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(here, '..', 'vendor', 'aleph-t04');

const manifest = JSON.parse(await readFile(join(vendorDir, 'asset-manifest.json'), 'utf8'));

console.log(`package_id: ${manifest.package_id}`);
console.log(`대조 대상: ${manifest.files.length}개 파일 (asset-manifest.json 자신은 제외)\n`);

let ok = 0;
let bad = 0;

for (const entry of manifest.files) {
  const buffer = await readFile(join(vendorDir, entry.path));
  const hex = createHash('sha256').update(buffer).digest('hex');
  const sizeOk = buffer.length === entry.bytes;
  const hashOk = hex === entry.sha256;
  if (sizeOk && hashOk) {
    ok += 1;
    console.log(`  일치   ${entry.path.padEnd(34)} ${entry.bytes}B  ${hex.slice(0, 16)}…`);
  } else {
    bad += 1;
    console.log(`  불일치 ${entry.path}`);
    if (!sizeOk) console.log(`         크기 ${buffer.length}B ≠ ${entry.bytes}B`);
    if (!hashOk) console.log(`         해시 ${hex}\n              ≠ ${entry.sha256}`);
  }
}

console.log(`\n합계: 일치 ${ok} · 불일치 ${bad}`);
process.exit(bad === 0 ? 0 : 1);
