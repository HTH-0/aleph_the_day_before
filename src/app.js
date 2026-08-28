import { ERROR_PRESENTATION, createEmptyState, kstStamp, lastGoodRow } from './core.js';
import { SIGNAL, applyLiveResult, fetchLive } from './live-adapter.js';
import { SEQUENCES, loadFixtures, replayDelayMs, runFixture } from './replay-adapter.js';
import { emptyStore, stateFromStore } from './store.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === '') continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}`;

let store = emptyStore(SIGNAL.signal_id);
let liveResult = null;
let liveState = createEmptyState();
let fixtures = null;
let labState = createEmptyState();
let busy = false;

$('source-link').href = SIGNAL.source_home;

/* ── 지금 값 ─────────────────────────────────────── */

function renderLive() {
  const status = liveState.status;
  const fresh = status?.freshness === 'fresh';
  const good = lastGoodRow(liveState);
  const reading = fresh ? liveState.current_reading : good?.reading ?? null;

  const value = $('value');
  value.classList.toggle('is-stale', !fresh);
  if (reading) value.textContent = String(reading.normalized_value);
  else if (status) value.textContent = '값 없음';
  else value.replaceChildren(el('span', { className: 'skel' }));
  $('unit').textContent = reading ? reading.unit : '';

  const cmp = liveState.last_comparison;
  const delta = $('delta');
  if (cmp?.state === 'comparable') {
    delta.className = `delta ${cmp.direction === 'increase' ? 'up' : cmp.direction === 'decrease' ? 'down' : 'flat'}`;
    delta.textContent = `${signed(cmp.signed)} ${cmp.unit}`;
  } else {
    delta.className = 'delta none';
    delta.textContent = store.rows.length ? '비교할 어제 기록 없음' : '보존된 기록이 아직 없음';
  }

  const badge = $('badge');
  badge.className = `badge ${fresh ? 'fresh' : 'stale'}`;
  badge.textContent = fresh
    ? '새 값'
    : status
      ? `오래된 값 · ${status.error_code}`
      : '확인 중';

  $('headline-sub').textContent = liveResult?.targetDate
    ? `${liveResult.targetDate} 하루(KST 00:00:00 ~ 23:59:59) 동안 생성된 저장소를 셉니다.`
    : '조회하는 중입니다.';

  $('failure').replaceChildren();
  if (status && !fresh) {
    $('failure').append(failureBox(status.error_code, liveState.last_run, good, runLive));
  }

  renderFacts(reading, fresh);
}

function failureBox(code, run, good, onRetry) {
  const view = ERROR_PRESENTATION[code];
  const box = el('div', { className: 'failure' });
  box.append(el('h3', {}, `${view.label} — ${view.headline}`));
  box.append(el('p', {}, view.detail));
  box.append(el('p', {}, good
    ? `위의 값은 ${good.record_date} ${kstStamp(good.last_fetched_at)}에 받은 마지막 정상값 ${good.normalized_value} ${good.unit}입니다. 지우지 않고 그대로 둡니다.`
    : '보존된 마지막 정상값이 없어 보여 줄 값이 없습니다. 값을 만들어 채우지 않습니다.'));
  box.append(el('p', { className: 'next' }, `다음 행동 · ${view.next}`));

  const tech = [
    run?.message,
    run?.retry_after_seconds ? `Retry-After ${run.retry_after_seconds}초` : null,
    run?.fixture_id
  ].filter(Boolean).join(' · ');
  if (tech) box.append(el('p', { className: 'tech' }, tech));

  if (onRetry) {
    const button = el('button', { className: 'retry', type: 'button' }, '다시 시도');
    button.addEventListener('click', onRetry);
    box.append(button);
  }
  return box;
}

function renderFacts(reading, fresh) {
  const dl = $('facts');
  dl.replaceChildren();
  const rows = [
    ['값', reading ? `${reading.normalized_value} ${reading.unit}` : '—'],
    ['단위', reading ? reading.unit : SIGNAL.unit],
    ['출처', reading
      ? el('span', {}, [reading.source_name, el('small', {}, SIGNAL.scope_note)])
      : SIGNAL.source_name],
    ['출처 관측 시각', reading
      ? el('span', {}, [kstStamp(reading.source_time), el('small', {}, '대상일의 끝. 값이 확정된 시점입니다.')])
      : '—'],
    ['조회 시각', reading
      ? el('span', {}, [kstStamp(reading.fetched_at), el('small', {}, fresh ? '방금 받은 응답입니다.' : '마지막으로 성공한 조회입니다.')])
      : '—'],
    ['기준 시간대', el('span', {}, ['Asia/Seoul', el('small', {}, '날짜 키와 화면의 모든 시각이 이 기준입니다.')])],
    ['호출 주소', reading
      ? el('a', { href: reading.source_url, target: '_blank', rel: 'noreferrer noopener', className: 'mono' }, reading.source_url)
      : '—']
  ];
  for (const [key, value] of rows) {
    dl.append(el('div', {}, [el('dt', {}, key), el('dd', {}, value)]));
  }
}

async function runLive() {
  const button = $('refetch');
  button.disabled = true;
  button.textContent = '조회 중…';
  $('value').replaceChildren(el('span', { className: 'skel' }));
  liveResult = await fetchLive();
  liveState = applyLiveResult(stateFromStore(store), liveResult);
  renderLive();
  cooldown(button);
}

// 인증 없는 검색 API는 IP당 분당 10회다. 연타로 스스로 제한을 부르지 않게 막는다.
function cooldown(button) {
  let left = Math.ceil(SIGNAL.cooldown_ms / 1000);
  button.disabled = true;
  button.textContent = `다시 조회 (${left})`;
  const id = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(id);
      button.disabled = false;
      button.textContent = '지금 다시 조회';
      return;
    }
    button.textContent = `다시 조회 (${left})`;
  }, 1000);
}

$('refetch').addEventListener('click', runLive);

/* ── 보존된 일별 기록 ────────────────────────────── */

function renderDaily() {
  const body = $('daily').querySelector('tbody');
  body.replaceChildren();
  const rows = [...store.rows].sort((a, b) => a.record_date.localeCompare(b.record_date));

  if (!rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: 6, className: 'empty' },
      '보존된 기록이 아직 없습니다. 첫 실제 조회가 기록되면 여기에 한 줄이 생깁니다.')));
    return;
  }

  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    let delta = '—';
    if (prev && prev.unit === row.unit) {
      const d = Math.round((row.normalized_value - prev.normalized_value) * 1e6) / 1e6;
      delta = `${signed(d)} ${row.unit}`;
    }
    body.append(el('tr', {}, [
      el('td', { className: 'mono' }, row.record_date),
      el('td', { className: 'num' }, String(row.normalized_value)),
      el('td', {}, row.unit),
      el('td', { className: 'num' }, delta),
      el('td', {}, el('span', {}, [
        kstStamp(row.reading?.source_time) ?? '—',
        row.raw_excerpt?.target_date_kst ? el('span', { className: 'sub' }, `대상 ${row.raw_excerpt.target_date_kst}`) : null
      ])),
      el('td', {}, row.reading?.source_url
        ? el('a', { href: row.reading.source_url, target: '_blank', rel: 'noreferrer noopener', className: 'mono' }, '조회 주소')
        : '—')
    ]));
  });
}

/* ── 장애 재생 ───────────────────────────────────── */

function button(label, onClick, className = '') {
  const node = el('button', { type: 'button', className }, label);
  node.addEventListener('click', onClick);
  return node;
}

function buildControls() {
  const bar = $('controls');
  bar.replaceChildren(
    button('reset', () => resetLab()),
    button('정상 3단계', () => playSequence('normal'), 'solid'),
    el('span', { className: 'spacer' }),
    ...['timeout', 'auth', 'rate', 'offline', 'schema'].map((key) =>
      button(SEQUENCES[key].title, () => playSequence(key)))
  );
}

function resetLab() {
  labState = createEmptyState();
  renderLab();
}

async function playOne(id) {
  if (busy) return;
  busy = true;
  const fixture = fixtures[id];
  await new Promise((r) => setTimeout(r, replayDelayMs(fixture)));
  labState = runFixture(labState, fixture);
  renderLab();
  busy = false;
}

let seqBusy = false;
async function playSequence(key) {
  if (busy || seqBusy) return;
  seqBusy = true;
  resetLab();
  for (const id of SEQUENCES[key].ids) await playOne(id);
  seqBusy = false;
}

function renderLab() {
  const status = labState.status;
  const good = lastGoodRow(labState);
  const cmp = labState.last_comparison;

  $('state').replaceChildren(
    stat('신선도', status ? (status.freshness === 'fresh' ? '새 값' : '오래된 값') : '—', true),
    stat('오류 코드', status ? status.error_code : '—', true),
    stat('일별 행', `${labState.daily_readings.length}건`),
    stat('마지막 정상값', good ? `${good.normalized_value} ${good.unit}` : '없음', !good),
    stat('어제 대비', cmp?.state === 'comparable' ? `${signed(cmp.signed)} ${cmp.unit}` : '—')
  );

  const wrap = $('replay-failure');
  wrap.replaceChildren();
  if (status?.freshness === 'stale') {
    wrap.append(failureBox(status.error_code, labState.last_run, good, () => playOne('T04-RECOVER-D2')));
  }

  const body = $('replay-daily').querySelector('tbody');
  body.replaceChildren();
  const rows = labState.daily_readings;
  if (!rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: 5, className: 'empty' },
      '합성 상태가 비어 있습니다. 위에서 재생을 시작하세요.')));
    return;
  }
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    const d = prev && prev.unit === row.unit
      ? Math.round((row.normalized_value - prev.normalized_value) * 1e6) / 1e6
      : null;
    body.append(el('tr', {}, [
      el('td', { className: 'mono' }, row.record_date),
      el('td', { className: 'num' }, String(row.normalized_value)),
      el('td', {}, row.unit),
      el('td', { className: 'num' }, d === null ? '—' : `${signed(d)} ${row.unit}`),
      el('td', { className: 'mono' }, row.record_id)
    ]));
  });
}

function stat(label, value, small = false) {
  return el('div', {}, [
    el('dt', {}, label),
    el('dd', { className: small ? 'small' : '' }, value)
  ]);
}

/* ── 시작 ────────────────────────────────────────── */

async function boot() {
  try {
    const response = await fetch('./data/daily.json', { cache: 'no-store' });
    if (response.ok) {
      const parsed = await response.json();
      if (Array.isArray(parsed.rows)) store = parsed;
    }
  } catch {
    // 보존 파일을 못 읽으면 빈 상태로 둔다. 값을 지어내지 않는다.
  }
  renderDaily();
  liveState = stateFromStore(store);
  renderLive();
  runLive();

  try {
    fixtures = await loadFixtures();
    buildControls();
    resetLab();
  } catch (error) {
    $('controls').replaceChildren(
      el('p', { className: 'replay-note' }, `fixture를 불러오지 못했습니다: ${error.message}`)
    );
  }
}

boot();
