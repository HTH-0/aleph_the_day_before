// store.js — data/daily.json 의 형식과 규칙
// 브라우저 저장소(localStorage·쿠키)를 쓰지 않습니다.
// 보존 기록은 저장소에 커밋된 파일 하나이므로 시크릿 창에서도 그대로 보입니다.

import { applySuccessfulReading, comparisonFor, resetEvaluationState, clone } from './core.js';

export const STORE_SCHEMA = 't04-daily-store-v1';

export function emptyStore(signalId) {
  return {
    schema_version: STORE_SCHEMA,
    signal_id: signalId,
    record_timezone: 'Asia/Seoul',
    generated_at: null,
    daily_readings: []
  };
}

export function storeToState(store) {
  const state = resetEvaluationState();
  state.daily_readings = clone(store.daily_readings || []);
  state.daily_readings.sort((a, b) => a.record_date.localeCompare(b.record_date));
  const newest = state.daily_readings[state.daily_readings.length - 1];
  if (newest) {
    state.current_reading = clone(newest.reading);
    state.status = { freshness: 'fresh', error_code: 'none' };
    state.last_comparison = comparisonFor(state.daily_readings, newest);
    state.last_delta = state.last_comparison.magnitude;
  }
  return state;
}

export function stateToStore(state, signalId, generatedAt) {
  return {
    schema_version: STORE_SCHEMA,
    signal_id: signalId,
    record_timezone: 'Asia/Seoul',
    generated_at: generatedAt,
    daily_readings: clone(state.daily_readings)
  };
}

/** 정상 조회 한 건을 저장소에 반영합니다. 같은 KST 날짜면 행을 늘리지 않습니다. */
export function upsertReading(store, reading) {
  const state = storeToState(store);
  const next = applySuccessfulReading(state, reading);
  return stateToStore(next, reading.signal_id, reading.fetched_at);
}

/**
 * 보존된 두 행에서 어제 대비 변화를 다시 계산합니다.
 * 저장 시점에 계산해 둔 값을 쓰지 않고 매번 뺄셈을 다시 합니다.
 */
export function recomputeDelta(rows) {
  const sorted = [...(rows || [])].sort((a, b) => a.record_date.localeCompare(b.record_date));
  if (sorted.length < 2) {
    return { state: 'insufficient', rows: sorted, reason: `보존된 기록이 ${sorted.length}건이라 아직 계산하지 않습니다.` };
  }
  const previous = sorted[sorted.length - 2];
  const current = sorted[sorted.length - 1];
  if (previous.unit !== current.unit) {
    return { state: 'unit_mismatch', rows: sorted, previous, current, reason: '두 기록의 단위가 다릅니다.' };
  }
  const signed = current.normalized_value - previous.normalized_value;
  return {
    state: 'comparable',
    rows: sorted,
    previous,
    current,
    signed,
    magnitude: Math.abs(signed),
    direction: signed > 0 ? 'increase' : signed < 0 ? 'decrease' : 'unchanged',
    unit: current.unit,
    expression: `${current.normalized_value} − ${previous.normalized_value} = ${signed}`
  };
}
