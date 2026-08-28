#!/usr/bin/env node
// 실제 공개 원천을 한 번 조회해 data/daily.json에 하루 한 줄로 기록한다.
// 비밀키를 쓰지 않는다. 환경변수도 읽지 않는다.
// 같은 Asia/Seoul 날짜에 여러 번 돌려도 행 수는 늘지 않는다.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ERROR_PRESENTATION, kstStamp } from '../src/core.js';
import { SIGNAL, applyLiveResult, fetchLive, rawExcerpt } from '../src/live-adapter.js';
import { emptyStore, recomputeDelta, upsertReading } from '../src/store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const storePath = join(root, 'data', 'daily.json');

async function readStore() {
  try {
    const text = await readFile(storePath, 'utf8');
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.rows)) throw new Error('rows가 배열이 아닙니다');
    return parsed;
  } catch {
    return emptyStore(SIGNAL.signal_id);
  }
}

const before = await readStore();
const beforeCount = before.rows.length;

const result = await fetchLive();

if (result.outcome !== 'success') {
  const view = ERROR_PRESENTATION[result.errorCode];
  console.error(`[실패] ${result.errorCode} — ${view.headline}`);
  console.error(`  ${result.message ?? ''}`);
  console.error(`  보존된 행 ${beforeCount}건은 그대로 둡니다. 값을 만들어 넣지 않습니다.`);
  process.exit(1);
}

const { store, state } = upsertReading(before, result.reading, rawExcerpt(result.raw));
await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');

const delta = recomputeDelta(store.rows);
const row = state.daily_readings.find((r) => r.record_date === result.reading.record_date);

console.log('[성공] 실제 공개 원천 조회');
console.log(`  값        ${result.reading.normalized_value} ${result.reading.unit}`);
console.log(`  출처      ${result.reading.source_name}`);
console.log(`  출처 시각  ${kstStamp(result.reading.source_time)}`);
console.log(`  조회 시각  ${kstStamp(result.reading.fetched_at)}`);
console.log(`  기록 날짜  ${result.reading.record_date} (${result.reading.record_timezone})`);
console.log(`  행         ${beforeCount} → ${store.rows.length} (같은 날 ${row.update_count}회 갱신)`);
console.log(`  전일 대비  ${delta.state === 'comparable' ? delta.formula : '기록 1건이라 아직 계산하지 않음'}`);
