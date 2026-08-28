// core.js — 정규화 검증 · 일별 저장 · 전일 대비 · 오류 분류
// live-adapter와 replay-adapter가 반드시 이 파일의 같은 함수만 통과합니다.
// 오류 처리 경로를 따로 만들 수 없게 하려는 의도입니다.

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

export const RECORD_TIMEZONE = 'Asia/Seoul';

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** ISO 문자열을 Asia/Seoul 기준 YYYY-MM-DD 로 바꿉니다. */
export function kstDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('fetched_at must be a valid ISO-8601 date-time');
  }
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: RECORD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

/** 화면 표시용 KST 문자열: 2026-08-28 09:31:04 (KST) */
export function kstStamp(isoString) {
  if (isoString === null || isoString === undefined) return null;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: RECORD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} (KST)`;
}

/** 어제의 KST 날짜 (YYYY-MM-DD) */
export function kstYesterday(nowIso) {
  const today = kstDate(nowIso);
  const [y, m, d] = today.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d));
  shifted.setUTCDate(shifted.getUTCDate() - 1);
  return shifted.toISOString().slice(0, 10);
}

/**
 * normalized-reading.schema.json 과 같은 의미로 검증합니다.
 * 실패하면 throw 합니다. 호출부는 이를 schema_error 로 분류합니다.
 */
export function validateNormalizedReading(reading) {
  if (!reading || typeof reading !== 'object' || Array.isArray(reading)) {
    throw new TypeError('정규화 결과가 객체가 아닙니다');
  }

  const actualKeys = Object.keys(reading).sort();
  const expectedKeys = [...NORMALIZED_KEYS].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(`정규화 키가 정확히 ${NORMALIZED_KEYS.join(', ')} 이어야 합니다`);
  }

  if (typeof reading.signal_id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(reading.signal_id) || reading.signal_id.length > 100) {
    throw new TypeError('signal_id 형식이 올바르지 않습니다');
  }
  if (typeof reading.normalized_value !== 'number' || !Number.isFinite(reading.normalized_value)) {
    throw new TypeError('normalized_value 가 유한한 수가 아닙니다');
  }
  for (const field of ['unit', 'source_name']) {
    if (typeof reading[field] !== 'string' || reading[field].trim() === '') {
      throw new TypeError(`${field} 가 비어 있습니다`);
    }
  }

  let sourceUrl;
  try {
    sourceUrl = new URL(reading.source_url);
  } catch {
    throw new TypeError('source_url 이 절대 주소가 아닙니다');
  }
  if (sourceUrl.protocol !== 'https:') {
    throw new TypeError('source_url 이 HTTPS 가 아닙니다');
  }

  if (reading.source_time !== null && Number.isNaN(new Date(reading.source_time).getTime())) {
    throw new TypeError('source_time 이 올바른 시각이 아닙니다');
  }
  if (Number.isNaN(new Date(reading.fetched_at).getTime())) {
    throw new TypeError('fetched_at 이 올바른 시각이 아닙니다');
  }
  if (reading.record_timezone !== RECORD_TIMEZONE) {
    throw new TypeError('record_timezone 이 Asia/Seoul 이 아닙니다');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reading.record_date) || reading.record_date !== kstDate(reading.fetched_at)) {
    throw new TypeError('record_date 가 fetched_at 의 Asia/Seoul 날짜와 다릅니다');
  }

  return true;
}

export function validateStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return false;
  if (status.freshness === 'fresh') return status.error_code === 'none';
  if (status.freshness === 'stale') return ERROR_CODES.includes(status.error_code);
  return false;
}

/** 빈 평가 상태. replay reset 계약과 같은 의미입니다. */
export function resetEvaluationState() {
  return {
    schema_version: 'aleph-t04-evaluation-state-v1',
    daily_readings: [],
    current_reading: null,
    status: null,
    last_delta: null,
    last_comparison: {
      state: 'insufficient',
      direction: null,
      magnitude: null,
      unit: null
    },
    last_run: null,
    sequence: 0
  };
}

export function recordIdFor(reading) {
  return `t04-${reading.signal_id}-${reading.record_date}`;
}

/**
 * 전일 대비를 저장된 행에서 다시 계산합니다.
 * 미리 계산해 둔 값을 쓰지 않습니다.
 */
export function comparisonFor(rows, current) {
  const previous = rows
    .filter((row) => row.signal_id === current.signal_id && row.record_date < current.record_date)
    .sort((left, right) => right.record_date.localeCompare(left.record_date))[0];

  if (!previous) {
    return { state: 'insufficient', direction: null, magnitude: null, unit: null, previous: null, current: clone(current) };
  }
  if (previous.unit !== current.unit) {
    return { state: 'unit_mismatch', direction: null, magnitude: null, unit: null, previous: clone(previous), current: clone(current) };
  }
  const signed = current.normalized_value - previous.normalized_value;
  return {
    state: 'comparable',
    direction: signed > 0 ? 'increase' : signed < 0 ? 'decrease' : 'unchanged',
    magnitude: Math.abs(signed),
    signed,
    unit: current.unit,
    previous: clone(previous),
    current: clone(current)
  };
}

/**
 * 정상 조회 반영.
 * 같은 signal_id + record_date 이면 새 행을 만들지 않고 같은 행을 갱신합니다.
 */
export function applySuccessfulReading(inputState, reading, runMeta = {}) {
  validateNormalizedReading(reading);
  const state = clone(inputState);

  const existingIndex = state.daily_readings.findIndex(
    (row) => row.signal_id === reading.signal_id && row.record_date === reading.record_date
  );
  const existing = existingIndex >= 0 ? state.daily_readings[existingIndex] : null;

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
    observation: runMeta.observation ? clone(runMeta.observation) : null,
    // 하루 안의 6시간 구간 분포. 저장되는 값을 만들지 않는 딸린 정보이며,
    // 같은 날 재조회에서도 이미 얻은 분포를 잃지 않도록 이어받습니다.
    breakdown: runMeta.breakdown ? clone(runMeta.breakdown) : existing ? existing.breakdown || null : null
  };

  if (existingIndex >= 0) state.daily_readings[existingIndex] = row;
  else state.daily_readings.push(row);
  state.daily_readings.sort((left, right) => left.record_date.localeCompare(right.record_date));

  state.current_reading = clone(reading);
  state.status = { freshness: 'fresh', error_code: 'none' };
  state.last_comparison = comparisonFor(state.daily_readings, row);
  state.last_delta = state.last_comparison.magnitude;
  state.sequence += 1;
  state.last_run = {
    fixture_id: runMeta.fixture_id || null,
    virtual_now: runMeta.virtual_now || reading.fetched_at,
    attempted_at: runMeta.attempted_at || reading.fetched_at,
    outcome: 'success',
    error_code: 'none',
    retry_after_seconds: null,
    detail: runMeta.detail || null
  };
  return state;
}

/**
 * 실패 반영.
 * status 만 바꿉니다. daily_readings 와 current_reading 은 건드리지 않습니다.
 * 즉 실패가 저장된 정상값을 지우거나 덮어쓰는 일이 구조적으로 불가능합니다.
 */
export function applyError(inputState, errorCode, runMeta = {}) {
  if (!ERROR_CODES.includes(errorCode)) {
    throw new TypeError(`지원하지 않는 오류 코드: ${errorCode}`);
  }
  const state = clone(inputState);
  state.status = { freshness: 'stale', error_code: errorCode };
  state.sequence += 1;
  state.last_run = {
    fixture_id: runMeta.fixture_id || null,
    virtual_now: runMeta.virtual_now || null,
    attempted_at: runMeta.attempted_at || runMeta.virtual_now || null,
    outcome: 'error',
    error_code: errorCode,
    retry_after_seconds: runMeta.retry_after_seconds ?? null,
    detail: runMeta.detail || null
  };
  return state;
}

/**
 * adapter 가 만든 outcome 을 상태에 반영하는 단일 통로.
 * live 든 replay 든 여기만 지나갑니다.
 */
export function applyOutcome(state, outcome) {
  if (outcome && outcome.kind === 'success') {
    try {
      return applySuccessfulReading(state, outcome.reading, outcome.meta || {});
    } catch (error) {
      return applyError(state, 'schema_error', {
        ...(outcome.meta || {}),
        detail: error.message
      });
    }
  }
  return applyError(state, outcome.code, outcome.meta || {});
}

/**
 * 전송 계층의 관측값을 오류 코드로 나눕니다.
 * mode: 'http' | 'timeout' | 'offline'
 */
export function classifyTransport({ mode, status, headers = {} }) {
  if (mode === 'timeout') return 'timeout';
  if (mode === 'offline') return 'offline';
  if (status === 401 || status === 403) {
    const remaining = headers['x-ratelimit-remaining'];
    if (remaining !== undefined && remaining !== null && Number(remaining) === 0) return 'rate_limit';
    return 'auth';
  }
  if (status === 429) return 'rate_limit';
  if (typeof status === 'number' && status >= 200 && status < 300) return null;
  return 'schema_error';
}

export const ERROR_PRESENTATION = Object.freeze({
  timeout: {
    label: '느린 응답',
    code: 'timeout',
    headline: '출처가 제한시간 안에 답하지 않았습니다',
    detail: '요청은 나갔지만 마감 시간 안에 응답이 도착하지 않았습니다. 값이 틀린 것이 아니라 아직 도착하지 않은 상태입니다.',
    next_action: '잠시 뒤 다시 시도하세요. 아래 값은 마지막으로 성공한 조회 결과입니다.',
    retry_label: '다시 시도'
  },
  auth: {
    label: '출처의 거절 (401 / 403)',
    code: 'auth',
    headline: '외부 출처가 이 요청을 거절했습니다',
    detail: '출처가 401 또는 403으로 응답했습니다. 이 정보판의 로그인 문제가 아니라 외부 출처 쪽 접근 정책 문제입니다.',
    next_action: '출처의 공개 정책이 바뀌었는지 확인이 필요합니다. 다시 시도해도 같은 응답이면 조회 주소를 점검하세요.',
    retry_label: '다시 시도'
  },
  rate_limit: {
    label: '호출 제한',
    code: 'rate_limit',
    headline: '짧은 시간에 너무 많이 조회했습니다',
    detail: '출처가 호출 횟수 제한을 알렸습니다. GitHub 검색 API는 인증 없이 분당 10회까지 허용합니다.',
    next_action: '제한이 풀릴 때까지 기다렸다가 다시 시도하세요. 남은 대기 시간은 아래에 표시됩니다.',
    retry_label: '기다린 뒤 다시 시도'
  },
  offline: {
    label: '오프라인',
    code: 'offline',
    headline: '네트워크에 연결되어 있지 않습니다',
    detail: '요청이 출처까지 가지 못했습니다. 출처의 문제가 아니라 이 기기의 연결 문제입니다.',
    next_action: '연결을 확인한 뒤 다시 시도하세요. 연결이 없어도 아래 보존된 기록은 그대로 남습니다.',
    retry_label: '연결 확인 후 다시 시도'
  },
  schema_error: {
    label: '응답 형식 변경',
    code: 'schema_error',
    headline: '응답은 왔지만 형식이 약속과 다릅니다',
    detail: 'HTTP는 성공했지만 필요한 값의 자리나 타입이 바뀌었습니다. 이런 응답은 저장하지 않습니다. 모양이 맞지 않는 값을 억지로 숫자로 바꾸면 기록이 오염되기 때문입니다.',
    next_action: '출처의 응답 구조가 바뀌었을 수 있습니다. 정규화 규칙을 점검한 뒤 다시 시도하세요.',
    retry_label: '다시 시도'
  }
});

export function formatSigned(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value > 0) return `+${formatNumber(value)}`;
  if (value < 0) return `−${formatNumber(Math.abs(value))}`;
  return '0';
}

export function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('ko-KR').format(value);
}
