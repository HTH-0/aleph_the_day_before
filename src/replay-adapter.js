// 공개 결정론 fixture 재생.
// 여기서 쓰는 값은 전부 합성 시험값이다. 실제 사람이나 실제 관측이 아니다.
// live adapter와 같은 core 함수(applySuccessfulReading / applyError)만 호출한다.

import { applyError, applySuccessfulReading, classifyTransport } from './core.js';

export const FIXTURE_FILES = Object.freeze([
  { id: 'T04-NORMAL-D1-A', file: 'normal-d1-a.json' },
  { id: 'T04-NORMAL-D1-B', file: 'normal-d1-b.json' },
  { id: 'T04-NORMAL-D2', file: 'normal-d2.json' },
  { id: 'T04-TIMEOUT', file: 'timeout.json' },
  { id: 'T04-AUTH-401', file: 'auth-401.json' },
  { id: 'T04-RATE-429', file: 'rate-429.json' },
  { id: 'T04-OFFLINE', file: 'offline.json' },
  { id: 'T04-SCHEMA-BREAK', file: 'schema-break.json' },
  { id: 'T04-RECOVER-D2', file: 'recover-d2.json' }
]);

export const SEQUENCES = Object.freeze({
  normal: {
    title: '정상 · 일별 저장',
    ids: ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-NORMAL-D2']
  },
  timeout: { title: '느린 응답', ids: ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-TIMEOUT'] },
  auth: { title: '401 거절', ids: ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-AUTH-401'] },
  rate: { title: '호출 제한', ids: ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-RATE-429'] },
  offline: { title: '오프라인', ids: ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-OFFLINE'] },
  schema: { title: '형식 변경', ids: ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-SCHEMA-BREAK'] },
  recover: {
    title: '오류 뒤 회복',
    ids: ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-TIMEOUT', 'T04-RECOVER-D2']
  }
});

export const BASE_PATH = './vendor/aleph-t04/';

export async function loadFixtures(fetchImpl = fetch, basePath = BASE_PATH) {
  const entries = await Promise.all(
    FIXTURE_FILES.map(async ({ id, file }) => {
      const response = await fetchImpl(`${basePath}fixtures/${file}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`fixture ${file}를 읽지 못했습니다 (HTTP ${response.status})`);
      const fixture = await response.json();
      if (fixture.fixture_id !== id) throw new Error(`fixture_id 불일치: ${file}`);
      return [id, fixture];
    })
  );
  return Object.fromEntries(entries);
}

/** fixture 한 건을 core로 흘려보낸다. 상태 전이 규칙은 live와 동일하다. */
export function runFixture(state, fixture) {
  const retryAfter = fixture.transport.headers && fixture.transport.headers['retry-after']
    ? Number(fixture.transport.headers['retry-after'])
    : null;
  const meta = {
    fixture_id: fixture.fixture_id,
    origin: 'replay',
    virtual_now: fixture.virtual_now,
    retry_after_seconds: retryAfter
  };

  const transportError = classifyTransport(fixture.transport);
  if (transportError) {
    return applyError(state, transportError, {
      ...meta,
      message: describeTransport(fixture)
    });
  }
  try {
    return applySuccessfulReading(state, fixture.payload, {
      ...meta,
      raw_excerpt: { note: '합성 fixture payload', fixture_id: fixture.fixture_id }
    });
  } catch (error) {
    return applyError(state, 'schema_error', { ...meta, message: error.message });
  }
}

function describeTransport(fixture) {
  const t = fixture.transport;
  if (t.mode === 'timeout') return `합성 응답 ${t.delay_ms}ms > 마감 ${t.deadline_ms}ms`;
  if (t.mode === 'offline') return '합성 네트워크 단절';
  return `합성 HTTP ${t.status}`;
}

/** 재생 시 실제로 기다리는 시간. 합성 지연을 짧게 흉내만 낸다. */
export function replayDelayMs(fixture) {
  const t = fixture.transport;
  if (t.mode === 'timeout') return 900;
  return Math.min(t.delay_ms, 200);
}
