// replay-adapter.js — 공개 합성 fixture 9종 재생
//
// 여기서 만들어지는 값은 전부 vendor/aleph-t04/fixtures 의 합성 시험값입니다.
// 실제 조회 결과와 섞이지 않도록 별도 상태에서만 돌아갑니다.

import { classifyTransport } from './core.js';

export const FIXTURE_DIR = 'vendor/aleph-t04/fixtures';

export const FIXTURE_FILES = Object.freeze({
  'T04-NORMAL-D1-A': 'normal-d1-a.json',
  'T04-NORMAL-D1-B': 'normal-d1-b.json',
  'T04-NORMAL-D2': 'normal-d2.json',
  'T04-TIMEOUT': 'timeout.json',
  'T04-AUTH-401': 'auth-401.json',
  'T04-RATE-429': 'rate-429.json',
  'T04-OFFLINE': 'offline.json',
  'T04-SCHEMA-BREAK': 'schema-break.json',
  'T04-RECOVER-D2': 'recover-d2.json'
});

export const FAILURE_FIXTURES = Object.freeze([
  'T04-TIMEOUT',
  'T04-AUTH-401',
  'T04-RATE-429',
  'T04-OFFLINE',
  'T04-SCHEMA-BREAK'
]);

/** README 의 재생 순서 7가지 */
export const REPLAY_SEQUENCES = Object.freeze([
  { id: 'daily-save', title: '정상 · 일별 저장', steps: ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-NORMAL-D2'] },
  { id: 'fail-timeout', title: '실패 · 느린 응답', steps: ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-TIMEOUT'] },
  { id: 'fail-auth', title: '실패 · 401 거절', steps: ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-AUTH-401'] },
  { id: 'fail-rate', title: '실패 · 호출 제한', steps: ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-RATE-429'] },
  { id: 'fail-offline', title: '실패 · 오프라인', steps: ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-OFFLINE'] },
  { id: 'fail-schema', title: '실패 · 형식 변경', steps: ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-SCHEMA-BREAK'] },
  { id: 'recover', title: '오류 뒤 회복', steps: ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-TIMEOUT', 'T04-RECOVER-D2'] }
]);

/** fixture 한 건을 outcome 으로 바꿉니다. 상태를 직접 바꾸지 않습니다. */
export function fixtureToOutcome(fixture) {
  const meta = {
    fixture_id: fixture.fixture_id,
    virtual_now: fixture.virtual_now,
    attempted_at: fixture.virtual_now,
    retry_after_seconds: fixture.transport.headers['retry-after']
      ? Number(fixture.transport.headers['retry-after'])
      : null,
    synthetic: true,
    observation: {
      target_date: null,
      source_url: fixture.payload && fixture.payload.source_url ? fixture.payload.source_url : null,
      attempted_at: fixture.virtual_now,
      deadline_ms: fixture.transport.deadline_ms,
      http_status: fixture.transport.status,
      elapsed_ms: fixture.transport.delay_ms,
      retry_after_seconds: fixture.transport.headers['retry-after']
        ? Number(fixture.transport.headers['retry-after'])
        : null,
      raw_excerpt: fixture.payload ? JSON.stringify(fixture.payload) : null
    }
  };

  const failure = classifyTransport({
    mode: fixture.transport.mode,
    status: fixture.transport.status,
    headers: fixture.transport.headers
  });

  if (failure) {
    return { kind: 'error', code: failure, meta };
  }
  return { kind: 'success', reading: fixture.payload, meta, raw: fixture.payload };
}

/** 브라우저용 로더 */
export async function loadFixtureInBrowser(fixtureId, baseUrl = '') {
  const file = FIXTURE_FILES[fixtureId];
  if (!file) throw new Error(`알 수 없는 fixture: ${fixtureId}`);
  const response = await fetch(`${baseUrl}${FIXTURE_DIR}/${file}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`fixture 를 읽지 못했습니다: ${file}`);
  return response.json();
}
