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
  signal_id: 'github-repos-created-daily',
  title: '어제 하루 동안 생긴 공개 GitHub 저장소',
  question: '어제 세상에는 새 저장소가 몇 개 생겼을까?',
  source_name: 'GitHub REST API — 저장소 검색',
  source_home: 'https://docs.github.com/en/rest/search/search',
  unit: '개',
  // 검색 인덱스 기준이라 세는 대상이 한정된다. 화면에 그대로 밝힌다.
  scope_note: '검색 인덱스에 잡힌 공개 저장소만 · fork 제외 · private 제외',
  value_path: 'total_count',
  deadline_ms: 8000,
  // 인증 없는 검색 API는 IP당 분당 10회. 연타를 막는다.
  cooldown_ms: 7000
});

const DEADLINE = Symbol('deadline');
const DAY_MS = 86400000;

/** 조회 시각 기준으로 어제(KST)의 날짜. 이 값이 세는 대상이다. */
export function targetDateFor(isoNow) {
  const now = new Date(isoNow);
  if (Number.isNaN(now.getTime())) {
    throw new NormalizeError('조회 시각이 올바른 ISO-8601 시각이 아닙니다', 'fetched_at');
  }
  return kstDate(new Date(now.getTime() - DAY_MS).toISOString());
}

/**
 * 대상 날짜 하루치 호출 주소.
 * created 한정자에 +09:00을 명시해야 GitHub이 UTC가 아닌 KST 하루로 센다.
 */
export function endpointFor(targetDate) {
  const query = `created:${targetDate}T00:00:00+09:00..${targetDate}T23:59:59+09:00`;
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=1`;
}

/** 대상 날짜의 끝. 값이 확정된 시점이므로 이것을 출처 관측 시각으로 쓴다. */
export function sourceTimeFor(targetDate) {
  const time = new Date(`${targetDate}T23:59:59+09:00`);
  if (Number.isNaN(time.getTime())) {
    throw new NormalizeError('대상 날짜를 시각으로 읽지 못했습니다', 'source_time');
  }
  return time.toISOString();
}

/** 원자료 → 정규화 항목. 실패하면 NormalizeError를 던진다. */
export function normalizeRaw(raw, fetchedAtIso, endpoint, targetDate) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NormalizeError('응답 본문이 객체가 아닙니다');
  }
  if (typeof raw.total_count !== 'number' || !Number.isFinite(raw.total_count)) {
    throw new NormalizeError('total_count가 숫자가 아닙니다', 'total_count');
  }
  if (raw.total_count < 0 || !Number.isInteger(raw.total_count)) {
    throw new NormalizeError('total_count가 0 이상의 정수가 아닙니다', 'total_count');
  }
  return {
    signal_id: SIGNAL.signal_id,
    normalized_value: raw.total_count,
    unit: SIGNAL.unit,
    source_name: SIGNAL.source_name,
    source_url: endpoint,
    source_time: sourceTimeFor(targetDate),
    fetched_at: fetchedAtIso,
    record_timezone: RECORD_TIMEZONE,
    record_date: kstDate(fetchedAtIso)
  };
}

/** 원자료에서 실제로 읽은 자리와 조회 맥락. 화면 대조표와 저장 기록에 함께 남긴다. */
export function buildExcerpt(raw, context = {}) {
  return {
    total_count: raw?.total_count ?? null,
    incomplete_results: raw?.incomplete_results ?? null,
    target_date_kst: context.targetDate ?? null,
    created_range: context.targetDate
      ? `${context.targetDate}T00:00:00+09:00 .. ${context.targetDate}T23:59:59+09:00`
      : null,
    rate_limit_remaining: context.rateRemaining ?? null
  };
}

function readRate(response) {
  try {
    const remaining = response.headers?.get?.('x-ratelimit-remaining');
    const reset = response.headers?.get?.('x-ratelimit-reset');
    return {
      rateRemaining: remaining === null || remaining === undefined ? null : Number(remaining),
      rateReset: reset ? Number(reset) : null
    };
  } catch {
    return { rateRemaining: null, rateReset: null };
  }
}

/**
 * 실제 조회 한 번.
 * 반환: { outcome, reading, raw, excerpt, targetDate, status, errorCode, message, retryAfterSeconds, attemptedAt }
 */
export async function fetchLive({ now, deadlineMs = SIGNAL.deadline_ms, fetchImpl = fetch } = {}) {
  const attemptedAt = now || new Date().toISOString();
  const targetDate = targetDateFor(attemptedAt);
  const endpoint = endpointFor(targetDate);
  const base = { attemptedAt, targetDate, endpoint };

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ...base, outcome: 'error', errorCode: 'offline', message: '브라우저가 오프라인 상태입니다.' };
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
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28'
        },
        cache: 'no-store'
      }),
      deadline
    ]);
  } catch (error) {
    if (timer) clearTimeout(timer);
    const aborted = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    if (aborted) {
      return { ...base, outcome: 'error', errorCode: 'timeout', message: `제한시간 ${deadlineMs}ms 안에 응답이 오지 않았습니다.` };
    }
    return { ...base, outcome: 'error', errorCode: 'offline', message: '요청이 출처까지 도달하지 못했습니다.' };
  }
  if (timer) clearTimeout(timer);

  if (response === DEADLINE) {
    return { ...base, outcome: 'error', errorCode: 'timeout', message: `제한시간 ${deadlineMs}ms 안에 응답이 오지 않았습니다.` };
  }

  const { rateRemaining, rateReset } = readRate(response);
  const meta = { ...base, status: response.status, rateRemaining, rateReset };

  // GitHub은 호출 제한을 403으로도 알린다. 남은 호출 수가 0이면 인증 거절이 아니라 제한이다.
  if (response.status === 403 && rateRemaining === 0) {
    const wait = rateReset ? Math.max(0, Math.ceil(rateReset - Date.now() / 1000)) : null;
    return {
      ...meta,
      outcome: 'error',
      errorCode: 'rate_limit',
      retryAfterSeconds: Number(response.headers?.get?.('retry-after')) || wait,
      message: '인증 없는 검색은 IP당 분당 10회입니다. 남은 호출 0회.'
    };
  }

  const transportError = classifyTransport({ mode: 'http', status: response.status });
  if (transportError) {
    return {
      ...meta,
      outcome: 'error',
      errorCode: transportError,
      retryAfterSeconds: Number(response.headers?.get?.('retry-after')) || null,
      message: `출처가 HTTP ${response.status}로 응답했습니다.`
    };
  }

  let raw;
  try {
    raw = await response.json();
  } catch {
    return { ...meta, outcome: 'error', errorCode: 'schema_error', message: '응답 본문을 JSON으로 읽지 못했습니다.' };
  }

  try {
    const reading = normalizeRaw(raw, attemptedAt, endpoint, targetDate);
    return {
      ...meta,
      outcome: 'success',
      reading,
      raw,
      excerpt: buildExcerpt(raw, { targetDate, rateRemaining }),
      incomplete: raw.incomplete_results === true
    };
  } catch (error) {
    return {
      ...meta,
      outcome: 'error',
      errorCode: 'schema_error',
      raw,
      message: error instanceof NormalizeError ? error.message : '정규화에 실패했습니다.'
    };
  }
}

/** 조회 결과를 core 저장 함수로 넘긴다. live와 replay가 같은 경로를 쓴다. */
export function applyLiveResult(state, result) {
  if (result.outcome === 'success') {
    return applySuccessfulReading(state, result.reading, {
      origin: 'live',
      raw_excerpt: result.excerpt
    });
  }
  return applyError(state, result.errorCode, {
    origin: 'live',
    message: result.message ?? null,
    retry_after_seconds: result.retryAfterSeconds ?? null,
    attempted_at: result.attemptedAt ?? null
  });
}
