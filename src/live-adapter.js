// 실제 공개 원천 조회.
// 비밀키가 필요 없는 공개 API만 쓴다. 브라우저에서 그대로 호출해도 노출할 키가 없다.
// 정규화 결과는 replay adapter와 완전히 같은 core 함수로 넘어간다.

import {
  RECORD_TIMEZONE,
  applyError,
  applySuccessfulReading,
  classifyTransport,
  kstDate,
  NormalizeError
} from './core.js';

export const SIGNAL = Object.freeze({
  signal_id: 'seoul-temperature-2m',
  title: '서울 지상 2m 기온',
  question: '오늘 서울은 어제 이 시각보다 더울까?',
  source_name: 'Open-Meteo 공개 기상 API',
  source_home: 'https://open-meteo.com/',
  // 서울시청 좌표. 개인 위치가 아니라 공개 지점이다.
  endpoint:
    'https://api.open-meteo.com/v1/forecast' +
    '?latitude=37.5665&longitude=126.9780' +
    '&current=temperature_2m&timezone=Asia%2FSeoul',
  value_path: 'current.temperature_2m',
  unit_path: 'current_units.temperature_2m',
  source_time_path: 'current.time (+ utc_offset_seconds)',
  deadline_ms: 8000,
  precision: 1
});

const DEADLINE = Symbol('deadline');

function offsetString(seconds) {
  const sign = seconds < 0 ? '-' : '+';
  const abs = Math.abs(seconds);
  const hh = String(Math.floor(abs / 3600)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/** 원자료 → 정규화 항목. 실패하면 NormalizeError를 던진다. */
export function normalizeRaw(raw, fetchedAtIso, endpoint = SIGNAL.endpoint) {
  if (!raw || typeof raw !== 'object') {
    throw new NormalizeError('응답 본문이 객체가 아닙니다');
  }
  const current = raw.current;
  const units = raw.current_units;
  if (!current || typeof current !== 'object') {
    throw new NormalizeError('current 항목이 없습니다', 'current');
  }
  const value = current.temperature_2m;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new NormalizeError('current.temperature_2m가 숫자가 아닙니다', 'current.temperature_2m');
  }
  const unit = units && typeof units.temperature_2m === 'string' ? units.temperature_2m : null;
  if (!unit) {
    throw new NormalizeError('current_units.temperature_2m가 없습니다', 'current_units.temperature_2m');
  }
  if (typeof current.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(current.time)) {
    throw new NormalizeError('current.time 형식이 올바르지 않습니다', 'current.time');
  }
  if (typeof raw.utc_offset_seconds !== 'number') {
    throw new NormalizeError('utc_offset_seconds가 없습니다', 'utc_offset_seconds');
  }
  const localTime = current.time.length === 16 ? `${current.time}:00` : current.time;
  const sourceTime = new Date(`${localTime}${offsetString(raw.utc_offset_seconds)}`);
  if (Number.isNaN(sourceTime.getTime())) {
    throw new NormalizeError('current.time을 시각으로 읽지 못했습니다', 'current.time');
  }

  return {
    signal_id: SIGNAL.signal_id,
    normalized_value: value,
    unit,
    source_name: SIGNAL.source_name,
    source_url: endpoint,
    source_time: sourceTime.toISOString(),
    fetched_at: fetchedAtIso,
    record_timezone: RECORD_TIMEZONE,
    record_date: kstDate(fetchedAtIso)
  };
}

/** 원자료에서 실제로 읽은 자리만 뽑아 둔다. 화면 대조표와 저장 기록에 함께 남긴다. */
export function rawExcerpt(raw) {
  return {
    'current.temperature_2m': raw?.current?.temperature_2m ?? null,
    'current_units.temperature_2m': raw?.current_units?.temperature_2m ?? null,
    'current.time': raw?.current?.time ?? null,
    utc_offset_seconds: raw?.utc_offset_seconds ?? null,
    timezone: raw?.timezone ?? null
  };
}

/**
 * 실제 조회 한 번.
 * 반환: { outcome, reading, raw, status, errorCode, message, retryAfterSeconds, attemptedAt }
 */
export async function fetchLive({ endpoint = SIGNAL.endpoint, deadlineMs = SIGNAL.deadline_ms, fetchImpl = fetch } = {}) {
  const attemptedAt = new Date().toISOString();

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { outcome: 'error', errorCode: 'offline', attemptedAt, message: '브라우저가 오프라인 상태입니다.' };
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  // 마감은 두 겹으로 건다. abort 신호를 무시하는 전송 계층에서도 timeout으로 끊긴다.
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      resolve(DEADLINE);
    }, deadlineMs);
  });

  let response;
  try {
    response = await Promise.race([
      fetchImpl(endpoint, {
        signal: controller ? controller.signal : undefined,
        headers: { accept: 'application/json' },
        cache: 'no-store'
      }),
      deadline
    ]);
  } catch (error) {
    if (timer) clearTimeout(timer);
    const aborted = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    if (aborted) {
      return {
        outcome: 'error',
        errorCode: 'timeout',
        attemptedAt,
        message: `제한시간 ${deadlineMs}ms 안에 응답이 오지 않았습니다.`
      };
    }
    return {
      outcome: 'error',
      errorCode: 'offline',
      attemptedAt,
      message: '요청이 출처까지 도달하지 못했습니다.'
    };
  }
  if (timer) clearTimeout(timer);

  if (response === DEADLINE) {
    return {
      outcome: 'error',
      errorCode: 'timeout',
      attemptedAt,
      message: `제한시간 ${deadlineMs}ms 안에 응답이 오지 않았습니다.`
    };
  }

  const transportError = classifyTransport({ mode: 'http', status: response.status });
  if (transportError) {
    return {
      outcome: 'error',
      errorCode: transportError,
      status: response.status,
      attemptedAt,
      retryAfterSeconds: Number(response.headers.get('retry-after')) || null,
      message: `출처가 HTTP ${response.status}로 응답했습니다.`
    };
  }

  let raw;
  try {
    raw = await response.json();
  } catch {
    return {
      outcome: 'error',
      errorCode: 'schema_error',
      status: response.status,
      attemptedAt,
      message: '응답 본문을 JSON으로 읽지 못했습니다.'
    };
  }

  try {
    const reading = normalizeRaw(raw, attemptedAt, endpoint);
    return { outcome: 'success', reading, raw, status: response.status, attemptedAt };
  } catch (error) {
    return {
      outcome: 'error',
      errorCode: 'schema_error',
      status: response.status,
      raw,
      attemptedAt,
      message: error instanceof NormalizeError ? error.message : '정규화에 실패했습니다.'
    };
  }
}

/** 조회 결과를 core 저장 함수로 넘긴다. live와 replay가 같은 경로를 쓴다. */
export function applyLiveResult(state, result) {
  if (result.outcome === 'success') {
    return applySuccessfulReading(state, result.reading, {
      origin: 'live',
      raw_excerpt: rawExcerpt(result.raw)
    });
  }
  return applyError(state, result.errorCode, {
    origin: 'live',
    message: result.message ?? null,
    retry_after_seconds: result.retryAfterSeconds ?? null,
    attempted_at: result.attemptedAt ?? null
  });
}
