// scan-secrets.js — 배포되는 파일과 소스에 비밀값 원문이 없는지 검색합니다.

import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.github']);
const TEXT_EXT = /\.(js|mjs|cjs|json|html|css|yml|yaml|md|txt)$/i;

const PATTERNS = [
  { name: 'GitHub 토큰 (ghp_/gho_/ghs_/github_pat_)', re: /\b(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'AWS 액세스 키', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Google API 키', re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { name: 'OpenAI 키', re: /\bsk-[A-Za-z0-9]{32,}\b/g },
  { name: 'Slack 토큰', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'private key 블록', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'Authorization: Bearer 하드코딩', re: /Authorization["'\s:]+(Bearer|token)\s+[A-Za-z0-9._-]{16,}/gi },
  { name: 'api_key/secret 하드코딩 대입', re: /\b(api[_-]?key|secret|password|access[_-]?token)\b\s*[:=]\s*["'][A-Za-z0-9._-]{12,}["']/gi }
];

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), out);
    } else if (TEXT_EXT.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const files = await walk(root);
let hits = 0;

for (const file of files) {
  const text = await readFile(file, 'utf8');
  for (const pattern of PATTERNS) {
    const matches = text.match(pattern.re);
    if (matches) {
      hits += matches.length;
      console.log(`  발견 ${relative(root, file)} — ${pattern.name} × ${matches.length}`);
    }
  }
}

console.log(`검사한 파일: ${files.length}개`);
console.log(`검사한 규칙: ${PATTERNS.length}종`);
console.log(`발견한 비밀값: ${hits}건`);
process.exit(hits === 0 ? 0 : 1);
