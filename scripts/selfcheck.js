#!/usr/bin/env node
// 9개 fixture를 계약이 정한 순서대로 재생하고 expected와 대조한다.
// 브라우저 화면의 '자동 자가검증' 패널과 같은 규칙을 쓴다.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createEmptyState, lastGoodRow } from '../src/core.js';
import { FIXTURE_FILES, SEQUENCES, runFixture } from '../src/replay-adapter.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(root, 'vendor', 'aleph-t04');

const fixtures = {};
for (const { id, file } of FIXTURE_FILES) {
  fixtures[id] = JSON.parse(await readFile(join(base, 'fixtures', file), 'utf8'));
}

export function checkStep(state, fixture, seenRecordIds) {
  const expected = fixture.expected;
  const rows = state.daily_readings;
  const good = lastGoodRow(state);
  const row = expected.record_date
    ? rows.find((r) => r.record_date === expected.record_date)
    : null;
  const checks = [
    ['freshness', state.status?.freshness, expected.freshness],
    ['error_code', state.status?.error_code, expected.error_code],
    ['row_count', rows.length, expected.row_count],
    ['stored_value', good ? good.normalized_value : null, expected.stored_value],
    ['delta', state.last_delta === null ? null : Math.abs(state.last_delta), expected.delta],
    ['preserve_last_good', good !== null, expected.preserve_last_good]
  ];
  if (expected.record_date) {
    checks.push(['record_date', row ? row.record_date : null, expected.record_date]);
  }
  if (expected.same_record_id_as) {
    checks.push([
      'same_record_id',
      row ? row.record_id : null,
      seenRecordIds[expected.same_record_id_as] ?? '(이전 record_id 없음)'
    ]);
  }
  if (row) seenRecordIds[fixture.fixture_id] = row.record_id;
  return checks.map(([name, actual, want]) => ({
    name,
    actual,
    expected: want,
    ok: JSON.stringify(actual) === JSON.stringify(want)
  }));
}

let failures = 0;
for (const [key, seq] of Object.entries(SEQUENCES)) {
  let state = createEmptyState();
  const seen = {};
  console.log(`\n■ ${seq.title} (reset → ${seq.ids.join(' → ')})`);
  for (const id of seq.ids) {
    state = runFixture(state, fixtures[id]);
    const results = checkStep(state, fixtures[id], seen);
    const bad = results.filter((r) => !r.ok);
    failures += bad.length;
    const mark = bad.length ? '✗' : '✓';
    console.log(
      `  ${mark} ${id.padEnd(16)} ${state.status.freshness}/${state.status.error_code}` +
      ` · 행 ${state.daily_readings.length}건` +
      ` · 마지막 정상값 ${lastGoodRow(state)?.normalized_value ?? '없음'}` +
      ` · 변화 ${state.last_delta ?? '—'}`
    );
    for (const b of bad) {
      console.log(`      ${b.name}: 기대 ${JSON.stringify(b.expected)} / 실제 ${JSON.stringify(b.actual)}`);
    }
  }
  if (key === 'recover') {
    const rows = state.daily_readings.map((r) => r.record_date);
    console.log(`      회복 후 일별 날짜: ${rows.join(', ')}`);
  }
}

console.log(failures === 0 ? '\n전체 통과' : `\n실패 ${failures}건`);
process.exit(failures === 0 ? 0 : 1);
