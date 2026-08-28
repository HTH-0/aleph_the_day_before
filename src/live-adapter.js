// live-adapter.js — 실제 공개 원천 조회
//
// 신호: 어제(KST) 하루 동안 새로 만들어진 공개 GitHub 저장소 수
//       GitHub 검색 인덱스 기준 · fork 제외 · public 만
//
// 비밀키가 필요 없습니다. 인증 헤더도 토큰도 쓰지 않습니다.
// 그래서 브라우저 코드·배포 파일·네트워크 응답·Git 기록 어디에도 비밀값이 남지 않습니다.

import { classifyTransport, kstDate, kstYesterday, RECORD_TIMEZONE } from './core.js';

export const SIGNAL = {
  id: 'github-public-repos-created',
  title: '어제 하루 동안 새로 생긴 공개 GitHub 저장소',
  question: '어제 세상에 새 저장소가 몇 개 생겼을까요.',
  unit: '개',
  source_name: 'GitHub REST API — 저장소 검색',
  source_home: 'https://docs.github.com/en/rest/search/search#search-repositories',
  definition: '검색 인덱스 기준 · fork 제외 · public 저장소만',
  endpoint: 'https://api.github.com/search/repositories',
  deadline_ms: 8000
};

/** KST 기준 6시간 구간 네 개. 하루를 나누는 방식은 여기 한 곳에서만 정합니다. */
export const SEGMENTS = Object.freeze([
  { id: 'kst-00-06', label: '00–06시', from: '00:00:00', to: '05:59:59' },
  { id: 'kst-06-12', label: '06–12시', from: '06:00:00', to: '11:59:59' },
  { id: 'kst-12-18', label: '12–18시', from: '12:00:00', to: '17:59:59' },
  { id: 'kst-18-24', label: '18–24시', from: '18:00:00', to: '23:59:59' }
]);

/** 지정한 KST 구간을 가리키는 검색 주소를 만듭니다. */
export function buildRangeUrl(targetDate, from = '00:00:00', to = '23:59:59') {
  const start = encodeURIComponent(`${targetDate}T${from}+09:00`);
  const end = encodeURIComponent(`${targetDate}T${to}+09:00`);
  return `${SIGNAL.endpoint}?q=is:public+created:${start}..${end}&per_page=1`;
}

/** 어제 하루(KST) 전체를 가리키는 검색 주소입니다. 저장되는 값의 출처는 항상 이 주소입니다. */
export function buildSourceUrl(targetDate) {
  return buildRangeUrl(targetDate);
}

export function targetDateFor(nowIso) {
  return kstYesterday(nowIso);
}

/**
 * 원자료 → 정규화.
 * 실패하면 throw 하고, 호출부가 schema_error 로 분류합니다.
 */
export function normalizeRaw(raw, context) {
  const { targetDate, sourceUrl, fetchedAt } = context;

  if (!raw || typeof raw !== 'object') {
    throw new TypeError('응답 본문이 객체가 아닙니다');
  }
  if (typeof raw.total_count !== 'number' || !Number.isFinite(raw.total_count)) {
    throw new TypeError('total_count 가 숫자가 아닙니다');
  }

  return {
    signal_id: SIGNAL.id,
    normalized_value: raw.total_count,
    unit: SIGNAL.unit,
    source_name: SIGNAL.source_name,
    source_url: sourceUrl,
    source_time: `${targetDate}T23:59:59+09:00`,
    fetched_at: fetchedAt,
    record_timezone: RECORD_TIMEZONE,
    record_date: kstDate(fetchedAt)
  };
}

/**
 * 실제 조회 한 번.
 * 반환값은 core.applyOutcome 이 그대로 받는 outcome 입니다.
 * 여기서 상태를 직접 바꾸지 않는 것이 핵심입니다.
 */
export async function fetchLiveOutcome(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const fetchedAt = now.toISOString();
  const targetDate = targetDateFor(fetchedAt);
  const sourceUrl = buildSourceUrl(targetDate);
  const deadline = options.deadline_ms || SIGNAL.deadline_ms;

  const observation = {
    target_date: targetDate,
    source_url: sourceUrl,
    attempted_at: fetchedAt,
    deadline_ms: deadline,
    http_status: null,
    rate_limit_remaining: null,
    rate_limit_reset: null,
    retry_after_seconds: null,
    incomplete_results: null,
    raw_excerpt: null,
    elapsed_ms: null
  };

  const started = Date.now();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  let timedOut = false;
  if (controller) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadline);
  }

  let response;
  try {
    response = await fetch(sourceUrl, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller ? controller.signal : undefined
    });
  } catch (error) {
    if (timer) clearTimeout(timer);
    observation.elapsed_ms = Date.now() - started;
    const mode = timedOut ? 'timeout' : 'offline';
    observation.transport_note = timedOut
      ? `${deadline}ms 안에 응답이 오지 않았습니다`
      : `요청이 출처에 도달하지 못했습니다 (${error.name})`;
    return {
      kind: 'error',
      code: classifyTransport({ mode }),
      meta: { attempted_at: fetchedAt, detail: observation.transport_note, observation }
    };
  }
  if (timer) clearTimeout(timer);
  observation.elapsed_ms = Date.now() - started;

  const headers = {};
  for (const key of ['x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']) {
    const value = response.headers.get(key);
    if (value !== null) headers[key] = value;
  }
  observation.http_status = response.status;
  observation.rate_limit_remaining = headers['x-ratelimit-remaining'] ?? null;
  observation.rate_limit_reset = headers['x-ratelimit-reset'] ?? null;
  observation.retry_after_seconds = headers['retry-after'] ? Number(headers['retry-after']) : null;

  const failure = classifyTransport({ mode: 'http', status: response.status, headers });
  if (failure) {
    let bodyText = '';
    try {
      bodyText = (await response.text()).slice(0, 240);
    } catch {
      bodyText = '';
    }
    observation.raw_excerpt = { body: bodyText };
    return {
      kind: 'error',
      code: failure,
      meta: {
        attempted_at: fetchedAt,
        retry_after_seconds: observation.retry_after_seconds,
        detail: `HTTP ${response.status}`,
        observation
      }
    };
  }

  let raw;
  try {
    raw = await response.json();
  } catch {
    return {
      kind: 'error',
      code: 'schema_error',
      meta: { attempted_at: fetchedAt, detail: '응답을 JSON 으로 읽지 못했습니다', observation }
    };
  }

  observation.incomplete_results = raw && typeof raw.incomplete_results === 'boolean' ? raw.incomplete_results : null;
  observation.raw_excerpt = {
    total_count: raw ? raw.total_count : null,
    incomplete_results: raw ? raw.incomplete_results : null,
    items_length: raw && Array.isArray(raw.items) ? raw.items.length : null
  };

  let reading;
  try {
    reading = normalizeRaw(raw, { targetDate, sourceUrl, fetchedAt });
  } catch (error) {
    return {
      kind: 'error',
      code: 'schema_error',
      meta: { attempted_at: fetchedAt, detail: error.message, observation }
    };
  }

  return {
    kind: 'success',
    reading,
    meta: { attempted_at: fetchedAt, observation },
    raw
  };
}


/**
 * 하루를 6시간 구간 네 개로 나눠 각각 조회합니다.
 *
 * 이 값은 저장되는 값(normalized_value)을 만들지 않습니다.
 * 하루 합계는 언제나 하루 전체 구간 조회 한 건에서 나오고,
 * 여기서 얻는 네 값은 그 숫자가 어떻게 구성되는지 보여 주는 딸린 정보입니다.
 *
 * 구간 하나라도 실패하면 그 구간은 null 로 남깁니다. 추정해 채우지 않습니다.
 */
export async function fetchBreakdown(targetDate, options = {}) {
  const gapMs = options.gap_ms ?? 1200;
  const deadline = options.deadline_ms || SIGNAL.deadline_ms;
  const segments = [];

  for (const segment of SEGMENTS) {
    if (segments.length > 0 && gapMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }

    const sourceUrl = buildRangeUrl(targetDate, segment.from, segment.to);
    const fetchedAt = new Date().toISOString();
    const entry = {
      segment_id: segment.id,
      label: segment.label,
      range_start: `${targetDate}T${segment.from}+09:00`,
      range_end: `${targetDate}T${segment.to}+09:00`,
      value: null,
      unit: SIGNAL.unit,
      source_url: sourceUrl,
      fetched_at: fetchedAt,
      error_code: null
    };

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    let timedOut = false;
    if (controller) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, deadline);
    }

    try {
      const response = await fetch(sourceUrl, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller ? controller.signal : undefined
      });
      if (timer) clearTimeout(timer);

      const headers = {};
      for (const key of ['x-ratelimit-remaining', 'retry-after']) {
        const value = response.headers.get(key);
        if (value !== null) headers[key] = value;
      }

      const failure = classifyTransport({ mode: 'http', status: response.status, headers });
      if (failure) {
        entry.error_code = failure;
      } else {
        const raw = await response.json();
        if (typeof raw.total_count !== 'number' || !Number.isFinite(raw.total_count)) {
          entry.error_code = 'schema_error';
        } else {
          entry.value = raw.total_count;
        }
      }
    } catch (error) {
      if (timer) clearTimeout(timer);
      entry.error_code = timedOut ? 'timeout' : 'offline';
    }

    segments.push(entry);
  }

  const values = segments.filter((s) => typeof s.value === 'number').map((s) => s.value);
  return {
    target_date: targetDate,
    unit: SIGNAL.unit,
    segments,
    complete: values.length === SEGMENTS.length,
    sum: values.length === SEGMENTS.length ? values.reduce((a, b) => a + b, 0) : null
  };
}
