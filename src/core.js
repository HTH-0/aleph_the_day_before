// T04 공용 코어.
// live adapter와 replay adapter가 반드시 같은 정규화·저장·계산 함수를 부른다.
// 브라우저(ESM)와 Node 22(ESM) 양쪽에서 그대로 import 한다.

export const RECORD_TIMEZONE = 'Asia/Seoul';

export const NORMALIZED_KEYS = Object.freeze([
  'signal_id',
  'normalized_value',
  'unit',
  'source_name',
  'source_url',
  'source_time',
  'fetched_at',
  'record_timezone',
  'record_date'
]);

export const ERROR_CODES = Object.freeze([
  'timeout',
  'auth',
  'rate_limit',
  'offline',
  'schema_error'
]);

// 실패 종류마다 다른 설명과 다른 다음 행동을 준다. UI가 이 표만 읽는다.
export const ERROR_PRESENTATION = Object.freeze({
  timeout: {
    label: '응답 지연',
    headline: '출처가 제한시간 안에 답하지 않았습니다.',
    detail: '요청은 나갔지만 마감(deadline) 안에 응답이 오지 않아 끊었습니다. 값이 틀린 것이 아니라 아직 오지 않은 상태입니다.',
    next: '잠시 뒤 다시 조회하세요. 계속 반복되면 출처의 응답 속도를 의심하세요.'
  },
  auth: {
    label: '출처 접근 거절',
    headline: '외부 출처가 이 요청을 401/403으로 거절했습니다.',
    detail: '이 화면의 로그인과는 무관합니다. 정보판은 계속 로그인 없이 열립니다. 거절한 쪽은 외부 데이터 원천입니다.',
    next: '출처의 공개 접근 정책과 호출 주소를 확인하세요. 이 화면에서 할 수 있는 일은 없습니다.'
  },
  rate_limit: {
    label: '호출 제한',
    headline: '출처가 호출 횟수를 제한했습니다(429).',
    detail: '값이 없는 것이 아니라 지금 더 물어보지 말라는 뜻입니다. 응답의 Retry-After 값을 그대로 보여 줍니다.',
    next: 'Retry-After 만큼 기다린 뒤 다시 조회하세요.'
  },
  offline: {
    label: '연결 끊김',
    headline: '네트워크에 연결되어 있지 않습니다.',
    detail: '요청이 출처까지 가지도 못했습니다. 출처 상태는 알 수 없습니다.',
    next: '연결을 확인한 뒤 다시 조회하세요.'
  },
  schema_error: {
    label: '형식 변경',
    headline: '응답은 200이지만 값을 읽을 수 없는 형식입니다.',
    detail: '필수 항목의 타입이나 구조가 계약과 달라 정규화에 실패했습니다. 잘못 읽은 값을 저장하는 대신 저장을 거부했습니다.',
    next: '출처 응답 형식 변경을 확인하고 매핑을 고치세요. 그때까지 마지막 정상값을 보여 줍니다.'
  }
});

export class NormalizeError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'NormalizeError';
    this.field = field || null;
  }
}

/** ISO 시각을 Asia/Seoul 기준 YYYY-MM-DD로 바꾼다. */
export function kstDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    throw new NormalizeError('fetched_at이 올바른 ISO-8601 시각이 아닙니다', 'fetched_at');
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: RECORD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const by = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${by.year}-${by.month}-${by.day}`;
}

/** ISO 시각을 Asia/Seoul 로컬 표기로 바꾼다. 화면 표시 전용. */
export function kstStamp(isoString) {
  if (isoString === null || isoString === undefined) return null;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: RECORD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const by = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hour = by.hour === '24' ? '00' : by.hour;
  return `${by.year}-${by.month}-${by.day} ${hour}:${by.minute}:${by.second} KST`;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * normalized-reading.schema.json과 같은 의미로 검사한다.
 * 실패하면 NormalizeError를 던지고, 호출부는 이것을 schema_error로 바꾼다.
 */
export function validateNormalizedReading(reading) {
  if (!reading || typeof reading !== 'object' || Array.isArray(reading)) {
    throw new NormalizeError('정규화 결과가 객체가 아닙니다');
  }
  const actual = Object.keys(reading).sort();
  const expected = [...NORMALIZED_KEYS].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
    throw new NormalizeError(`정규화 항목은 정확히 ${NORMALIZED_KEYS.join(', ')} 여야 합니다`);
  }
  if (typeof reading.signal_id !== 'string' || reading.signal_id.length > 100 ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(reading.signal_id)) {
    throw new NormalizeError('signal_id 형식이 올바르지 않습니다', 'signal_id');
  }
  if (typeof reading.normalized_value !== 'number' || !Number.isFinite(reading.normalized_value)) {
    throw new NormalizeError('normalized_value가 유한한 숫자가 아닙니다', 'normalized_value');
  }
  for (const field of ['unit', 'source_name']) {
    if (typeof reading[field] !== 'string' || reading[field].trim() === '') {
      throw new NormalizeError(`${field}가 비어 있습니다`, field);
    }
  }
  let url;
  try {
    url = new URL(reading.source_url);
  } catch {
    throw new NormalizeError('source_url이 절대 URL이 아닙니다', 'source_url');
  }
  if (url.protocol !== 'https:') {
    throw new NormalizeError('source_url은 HTTPS여야 합니다', 'source_url');
  }
  if (reading.source_time !== null && Number.isNaN(new Date(reading.source_time).getTime())) {
    throw new NormalizeError('source_time이 올바른 시각이나 null이 아닙니다', 'source_time');
  }
  if (Number.isNaN(new Date(reading.fetched_at).getTime())) {
    throw new NormalizeError('fetched_at이 올바른 시각이 아닙니다', 'fetched_at');
  }
  if (reading.record_timezone !== RECORD_TIMEZONE) {
    throw new NormalizeError('record_timezone은 Asia/Seoul이어야 합니다', 'record_timezone');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reading.record_date) ||
      reading.record_date !== kstDate(reading.fetched_at)) {
    throw new NormalizeError('record_date는 fetched_at의 Asia/Seoul 날짜여야 합니다', 'record_date');
  }
  return true;
}

export function validateStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return false;
  if (status.freshness === 'fresh') return status.error_code === 'none';
  if (status.freshness === 'stale') return ERROR_CODES.includes(status.error_code);
  return false;
}

/** 합성 평가 상태만 빈 상태로 되돌린다. */
export function createEmptyState() {
  return {
    schema_version: 'aleph-t04-evaluation-state-v1',
    daily_readings: [],
    current_reading: null,
    last_good_reading: null,
    status: null,
    last_delta: null,
    last_comparison: { state: 'insufficient', direction: null, magnitude: null, signed: null, unit: null },
    last_run: null,
    sequence: 0
  };
}

export function recordIdFor(reading) {
  return `${reading.signal_id}:${reading.record_date}`;
}

/** 전일 대비: 같은 signal의 바로 앞 날짜 행과 비교한다. */
export function compareWithPrevious(rows, current) {
  const previous = rows
    .filter((row) => row.signal_id === current.signal_id && row.record_date < current.record_date)
    .sort((a, b) => b.record_date.localeCompare(a.record_date))[0];
  if (!previous) {
    return { state: 'insufficient', direction: null, magnitude: null, signed: null, unit: null, previous: null };
  }
  if (previous.unit !== current.unit) {
    return { state: 'unit_mismatch', direction: null, magnitude: null, signed: null, unit: null, previous };
  }
  const signed = round6(current.normalized_value - previous.normalized_value);
  return {
    state: 'comparable',
    direction: signed > 0 ? 'increase' : signed < 0 ? 'decrease' : 'unchanged',
    magnitude: Math.abs(signed),
    signed,
    unit: current.unit,
    previous
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * 정상 조회 저장.
 * 같은 signal_id + record_date면 새 행을 만들지 않고 같은 record_id를 원자적으로 갱신한다.
 * 다음 Asia/Seoul 날짜면 새 행을 만든다.
 */
export function applySuccessfulReading(inputState, reading, meta = {}) {
  validateNormalizedReading(reading);
  const state = clone(inputState);
  const index = state.daily_readings.findIndex(
    (row) => row.signal_id === reading.signal_id && row.record_date === reading.record_date
  );
  const existing = index >= 0 ? state.daily_readings[index] : null;
  const row = {
    record_id: existing ? existing.record_id : recordIdFor(reading),
    signal_id: reading.signal_id,
    record_date: reading.record_date,
    normalized_value: reading.normalized_value,
    unit: reading.unit,
    first_fetched_at: existing ? existing.first_fetched_at : reading.fetched_at,
    last_fetched_at: reading.fetched_at,
    update_count: existing ? (existing.update_count || 1) + 1 : 1,
    reading: clone(reading),
    raw_excerpt: clone(meta.raw_excerpt) ?? (existing ? existing.raw_excerpt : null)
  };

  if (index >= 0) state.daily_readings[index] = row;
  else state.daily_readings.push(row);
  state.daily_readings.sort((a, b) => a.record_date.localeCompare(b.record_date));

  state.current_reading = clone(reading);
  state.last_good_reading = clone(reading);
  state.status = { freshness: 'fresh', error_code: 'none' };
  state.last_comparison = compareWithPrevious(state.daily_readings, row);
  state.last_delta = state.last_comparison.signed;
  state.sequence += 1;
  state.last_run = {
    fixture_id: meta.fixture_id || null,
    origin: meta.origin || 'live',
    virtual_now: meta.virtual_now || reading.fetched_at,
    outcome: 'success',
    error_code: 'none',
    retry_after_seconds: null,
    message: null
  };
  return state;
}

/**
 * 실패 기록.
 * 저장된 일별 행과 마지막 정상값은 건드리지 않는다. 상태만 stale로 바꾼다.
 */
export function applyError(inputState, errorCode, meta = {}) {
  if (!ERROR_CODES.includes(errorCode)) {
    throw new NormalizeError(`지원하지 않는 오류 코드: ${errorCode}`);
  }
  const state = clone(inputState);
  state.status = { freshness: 'stale', error_code: errorCode };
  state.sequence += 1;
  state.last_run = {
    fixture_id: meta.fixture_id || null,
    origin: meta.origin || 'live',
    virtual_now: meta.virtual_now || null,
    outcome: 'error',
    error_code: errorCode,
    retry_after_seconds: meta.retry_after_seconds ?? null,
    message: meta.message ?? null,
    attempted_at: meta.attempted_at ?? null
  };
  return state;
}

/** 전송 계층 결과를 오류 코드로 분류한다. 정상이면 null. */
export function classifyTransport({ mode, status }) {
  if (mode === 'timeout') return 'timeout';
  if (mode === 'offline') return 'offline';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (typeof status === 'number' && status >= 200 && status < 300) return null;
  return 'schema_error';
}

/** 마지막 정상값이 담긴 행. 실패해도 사라지지 않는다. */
export function lastGoodRow(state) {
  if (!state.daily_readings.length) return null;
  return state.daily_readings[state.daily_readings.length - 1];
}
