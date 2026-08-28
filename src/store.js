// 보존 저장소(data/daily.json)의 형식과 순수 갱신 함수.
// 브라우저는 읽기만 하고, GitHub Actions의 기록 스크립트가 같은 함수로 쓴다.

import { RECORD_TIMEZONE, applySuccessfulReading, compareWithPrevious, createEmptyState } from './core.js';

export const STORE_SCHEMA = 't04-daily-store-v1';
export const STORE_PATH = './data/daily.json';

export function emptyStore(signalId) {
  return {
    schema_version: STORE_SCHEMA,
    signal_id: signalId,
    record_timezone: RECORD_TIMEZONE,
    generated_at: null,
    rows: []
  };
}

export function stateFromStore(store) {
  const state = createEmptyState();
  state.daily_readings = Array.isArray(store?.rows) ? JSON.parse(JSON.stringify(store.rows)) : [];
  state.daily_readings.sort((a, b) => a.record_date.localeCompare(b.record_date));
  const last = state.daily_readings[state.daily_readings.length - 1];
  if (last) {
    state.last_good_reading = last.reading;
    state.current_reading = last.reading;
    state.last_comparison = compareWithPrevious(state.daily_readings, last);
    state.last_delta = state.last_comparison.signed;
  }
  return state;
}

/**
 * 정상 조회 한 건을 보존 저장소에 반영한다.
 * 같은 Asia/Seoul 날짜면 같은 행을 갱신하고, 다음 날짜면 새 행을 만든다.
 */
export function upsertReading(store, reading, rawExcerpt) {
  const state = applySuccessfulReading(stateFromStore(store), reading, {
    origin: 'live',
    raw_excerpt: rawExcerpt
  });
  return {
    store: {
      ...emptyStore(reading.signal_id),
      generated_at: new Date().toISOString(),
      rows: state.daily_readings
    },
    state
  };
}

/** 저장소 두 행으로 어제 대비 변화를 다시 계산한다. C24 재계산 규칙과 같은 함수. */
export function recomputeDelta(rows) {
  const sorted = [...rows].sort((a, b) => a.record_date.localeCompare(b.record_date));
  if (sorted.length < 2) return { state: 'insufficient', signed: null, unit: null };
  const previous = sorted[sorted.length - 2];
  const current = sorted[sorted.length - 1];
  if (previous.unit !== current.unit) return { state: 'unit_mismatch', signed: null, unit: null };
  const signed = Math.round((current.normalized_value - previous.normalized_value) * 1e6) / 1e6;
  return {
    state: 'comparable',
    signed,
    unit: current.unit,
    previous,
    current,
    formula: `${current.normalized_value} ${current.unit} (${current.record_date}) − ${previous.normalized_value} ${previous.unit} (${previous.record_date}) = ${signed > 0 ? '+' : ''}${signed} ${current.unit}`
  };
}
