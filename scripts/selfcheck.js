// selfcheck.js — 공개 fixture 의 기대 상태와 이 앱의 실제 상태를 대조합니다.
// 재생 순서 7가지 + 같은 날 중복 방지 + 실패 5종 구분을 확인합니다.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { applyOutcome, resetEvaluationState, ERROR_PRESENTATION } from '../src/core.js';
import { FIXTURE_FILES, REPLAY_SEQUENCES, FAILURE_FIXTURES, fixtureToOutcome } from '../src/replay-adapter.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', 'vendor', 'aleph-t04', 'fixtures');

const cache = new Map();
async function fixture(id) {
  if (cache.has(id)) return cache.get(id);
  const file = FIXTURE_FILES[id];
  if (!file) throw new Error(`알 수 없는 fixture: ${id}`);
  const parsed = JSON.parse(await readFile(join(fixtureDir, file), 'utf8'));
  cache.set(id, parsed);
  return parsed;
}

let pass = 0;
let fail = 0;

function report(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  통과  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  실패  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function runSequence(steps) {
  let state = resetEvaluationState();
  let last = null;
  for (const id of steps) {
    last = await fixture(id);
    state = applyOutcome(state, fixtureToOutcome(last));
  }
  return { state, last };
}

async function main() {
  console.log('재생 순서 7가지');
  for (const sequence of REPLAY_SEQUENCES) {
    const { state, last } = await runSequence(sequence.steps);
    const expected = last.expected;
    const storedValue = state.current_reading ? state.current_reading.normalized_value : null;
    const actual = {
      freshness: state.status.freshness,
      error_code: state.status.error_code,
      row_count: state.daily_readings.length,
      stored_value: storedValue,
      delta: state.last_delta ?? null
    };
    const diffs = Object.entries(actual)
      .filter(([key, value]) => value !== (expected[key] ?? null))
      .map(([key, value]) => `${key}: ${value} ≠ ${expected[key] ?? null}`);
    report(
      sequence.title,
      diffs.length === 0,
      diffs.length === 0
        ? `${actual.freshness}/${actual.error_code} · 행 ${actual.row_count} · 값 ${actual.stored_value} · 변화 ${actual.delta ?? '—'}`
        : diffs.join(', ')
    );
  }

  console.log('\n같은 KST 날짜 중복 방지');
  {
    let state = resetEvaluationState();
    state = applyOutcome(state, fixtureToOutcome(await fixture('T04-NORMAL-D1-A')));
    const firstId = state.daily_readings[0].record_id;
    state = applyOutcome(state, fixtureToOutcome(await fixture('T04-NORMAL-D1-B')));
    state = applyOutcome(state, fixtureToOutcome(await fixture('T04-NORMAL-D1-B')));
    const row = state.daily_readings[0];
    report(
      '같은 날짜 3회 성공 → 행 1건',
      state.daily_readings.length === 1 && row.record_id === firstId,
      `행 ${state.daily_readings.length}건 · 갱신 ${row.update_count}회 · record_id 동일`
    );

    state = applyOutcome(state, fixtureToOutcome(await fixture('T04-NORMAL-D2')));
    report(
      '다음 날짜 성공 → 새 행',
      state.daily_readings.length === 2,
      `행 ${state.daily_readings.length}건 · 변화 ${state.last_delta}`
    );
  }

  console.log('\n실패 5종이 서로 다른 상태·문장·다음 행동인지');
  {
    const seen = new Map();
    for (const id of FAILURE_FIXTURES) {
      const { state } = await runSequence(['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', id]);
      const code = state.status.error_code;
      const info = ERROR_PRESENTATION[code];
      seen.set(code, info);
      report(
        `${id} → ${code}`,
        state.status.freshness === 'stale' &&
          state.daily_readings.length === 1 &&
          state.current_reading.normalized_value === 105,
        `마지막 정상값 ${state.current_reading.normalized_value} 보존 · 행 ${state.daily_readings.length}건`
      );
    }
    const headlines = new Set([...seen.values()].map((info) => info.headline));
    const actions = new Set([...seen.values()].map((info) => info.next_action));
    report('오류 코드 5종이 서로 다름', seen.size === 5, [...seen.keys()].join(', '));
    report('설명 문장 5종이 서로 다름', headlines.size === 5);
    report('다음 행동 5종이 서로 다름', actions.size === 5);
  }

  console.log('\n회복 전이 (T04-C19)');
  {
    let state = resetEvaluationState();
    state = applyOutcome(state, fixtureToOutcome(await fixture('T04-NORMAL-D1-A')));
    state = applyOutcome(state, fixtureToOutcome(await fixture('T04-NORMAL-D1-B')));
    state = applyOutcome(state, fixtureToOutcome(await fixture('T04-TIMEOUT')));
    const before = {
      freshness: state.status.freshness,
      error_code: state.status.error_code,
      rows: state.daily_readings.length,
      lastGood: state.current_reading.normalized_value
    };
    report(
      '다시 시도 직전',
      before.freshness === 'stale' && before.error_code === 'timeout' && before.rows === 1 && before.lastGood === 105,
      `${before.freshness}/${before.error_code} · 행 ${before.rows} · 값 ${before.lastGood}`
    );

    const datesBefore = new Set(state.daily_readings.map((r) => r.record_date));
    state = applyOutcome(state, fixtureToOutcome(await fixture('T04-RECOVER-D2')));
    const added = state.daily_readings.filter((r) => !datesBefore.has(r.record_date));
    report(
      '다시 시도 직후',
      state.status.freshness === 'fresh' &&
        state.status.error_code === 'none' &&
        state.daily_readings.length === 2 &&
        added.length === 1 &&
        added[0].record_date === '2026-08-25' &&
        state.current_reading.normalized_value === 120 &&
        state.last_delta === 15,
      `${state.status.freshness}/${state.status.error_code} · 행 ${state.daily_readings.length} · 신규 ${added.length}건(${added[0]?.record_date}) · 값 ${state.current_reading.normalized_value} · 변화 +${state.last_delta}`
    );
  }

  console.log(`\n합계: 통과 ${pass} · 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
