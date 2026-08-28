// record-daily.js — 실제 공개 원천을 1회 조회해 data/daily.json 에 반영합니다.
// 실패하면 값을 만들지 않고 그대로 종료합니다. 기록을 지어내지 않기 위해서입니다.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { applyOutcome, kstStamp } from '../src/core.js';
import { SIGNAL, fetchLiveOutcome } from '../src/live-adapter.js';
import { emptyStore, storeToState, stateToStore, recomputeDelta } from '../src/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const storePath = join(here, '..', 'data', 'daily.json');

async function loadStore() {
  if (!existsSync(storePath)) return emptyStore(SIGNAL.id);
  try {
    const parsed = JSON.parse(await readFile(storePath, 'utf8'));
    if (parsed && Array.isArray(parsed.daily_readings)) return parsed;
  } catch {
    /* 형식이 깨졌으면 새로 시작하지 않고 실패시킵니다. */
    throw new Error('data/daily.json 을 읽지 못했습니다. 손상 여부를 확인하세요.');
  }
  return emptyStore(SIGNAL.id);
}

async function main() {
  const store = await loadStore();
  const before = store.daily_readings.length;

  const outcome = await fetchLiveOutcome();
  const observation = outcome.meta.observation;

  console.log(`[조회] ${observation.source_url}`);
  console.log(`[관측] HTTP ${observation.http_status ?? '-'} · ${observation.elapsed_ms}ms · 남은 호출 ${observation.rate_limit_remaining ?? '-'}`);

  const nextState = applyOutcome(storeToState(store), outcome);

  if (nextState.status.freshness !== 'fresh') {
    console.log(`[실패] ${nextState.status.error_code} — ${nextState.last_run.detail ?? ''}`);
    console.log('[보존] 기존 기록을 건드리지 않고 종료합니다.');
    process.exit(0);
  }

  const reading = nextState.current_reading;
  const after = nextState.daily_readings.length;

  const nextStore = stateToStore(nextState, SIGNAL.id, reading.fetched_at);
  await writeFile(storePath, `${JSON.stringify(nextStore, null, 2)}\n`, 'utf8');

  console.log(`[성공] ${reading.normalized_value} ${reading.unit}`);
  console.log(`[대상] ${reading.source_time}`);
  console.log(`[조회] ${kstStamp(reading.fetched_at)}`);
  console.log(`[기록] record_date ${reading.record_date} · 행 ${before} → ${after}`);

  const delta = recomputeDelta(nextStore.daily_readings);
  console.log(`[변화] ${delta.state === 'comparable' ? delta.expression : delta.reason}`);
}

main().catch((error) => {
  console.error(`[오류] ${error.message}`);
  process.exit(1);
});
