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
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toLocaleString('ko-KR')}`;
const comma = (n) => Number(n).toLocaleString('ko-KR');

let store = emptyStore(SIGNAL.signal_id);
let liveResult = null;
let liveState = createEmptyState();
let fixtures = null;
let labState = createEmptyState();
let busy = false;
let seqBusy = false;

$('source-link').href = SIGNAL.source_home;
$('subject').textContent = SIGNAL.title;

/* ── 스탯 스트립 ─────────────────────────────────── */

function renderStrip() {
  const good = lastGoodRow(liveState);
  $('s-source').textContent = 'GitHub REST API';
  $('s-target').textContent = liveResult?.targetDate ?? '—';
  $('s-rows').textContent = `${store.rows.length}건`;
  $('s-last').textContent = good ? kstStamp(good.last_fetched_at) : '없음';
}

/* ── CURRENT ─────────────────────────────────────── */

function renderLive() {
  const status = liveState.status;
  const fresh = status?.freshness === 'fresh';
  const good = lastGoodRow(liveState);
  const reading = fresh ? liveState.current_reading : good?.reading ?? null;

  const value = $('value');
  value.classList.toggle('is-stale', !fresh);
  if (reading) value.textContent = comma(reading.normalized_value);
  else if (status) value.textContent = '값 없음';
  else value.replaceChildren(el('span', { className: 'skel' }));
  $('unit').textContent = reading ? reading.unit : '';

  const cmp = liveState.last_comparison;
  const delta = $('delta');
  if (cmp?.state === 'comparable') {
    const dir = cmp.direction === 'increase' ? 'up' : cmp.direction === 'decrease' ? 'down' : 'flat';
    delta.className = `delta ${dir}`;
    delta.replaceChildren(
      el('span', { className: 'caret' }, dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'),
      el('span', {}, `${signed(cmp.signed)} ${cmp.unit}`)
    );
  } else {
    delta.className = 'delta none';
    delta.textContent = store.rows.length ? '비교할 어제 기록 없음' : '보존된 기록이 아직 없음';
  }

  const tag = $('tag');
  tag.className = `tag ${fresh ? 'fresh' : 'stale'}`;
  tag.textContent = fresh ? '새 값' : status ? `오래된 값 · ${status.error_code}` : '확인 중';
  $('tag-note').textContent = good && !fresh
    ? `마지막 성공 ${kstStamp(good.last_fetched_at)}`
    : reading ? `조회 ${kstStamp(reading.fetched_at)}` : '';

  $('failure').replaceChildren();
  if (status && !fresh) {
    $('failure').append(failureBox(status.error_code, liveState.last_run, good, runLive));
  }

  renderFacts(reading, fresh);
  renderStrip();
}

function failureBox(code, run, good, onRetry) {
  const view = ERROR_PRESENTATION[code];
  const box = el('div', { className: 'failure' });
  box.append(el('h3', {}, `${view.label} — ${view.headline}`));
  box.append(el('p', {}, view.detail));
  box.append(el('p', {}, good
    ? `위의 값은 ${good.record_date} ${kstStamp(good.last_fetched_at)}에 받은 마지막 정상값 ${comma(good.normalized_value)} ${good.unit}입니다. 지우지 않고 그대로 둡니다.`
    : '보존된 마지막 정상값이 없어 보여 줄 값이 없습니다. 값을 만들어 채우지 않습니다.'));
  box.append(el('p', { className: 'next' }, `다음 행동 · ${view.next}`));

  const tech = [
    run?.message,
    run?.retry_after_seconds ? `Retry-After ${run.retry_after_seconds}초` : null,
    run?.fixture_id
  ].filter(Boolean).join(' · ');
  if (tech) box.append(el('p', { className: 'tech' }, tech));

  if (onRetry) {
    const b = el('button', { className: 'retry', type: 'button' }, '다시 시도');
    b.addEventListener('click', onRetry);
    box.append(b);
  }
  return box;
}

function renderFacts(reading, fresh) {
  const dl = $('facts');
  dl.replaceChildren();
  const rows = [
    ['값', reading ? `${comma(reading.normalized_value)} ${reading.unit}` : '—'],
    ['단위', reading ? reading.unit : SIGNAL.unit],
    ['출처', reading
      ? el('span', {}, [reading.source_name, el('small', {}, SIGNAL.scope_note)])
      : SIGNAL.source_name],
    ['출처 관측 시각', reading
      ? el('span', {}, [kstStamp(reading.source_time), el('small', {}, '대상일의 끝. 값이 확정된 시점입니다.')])
      : '—'],
    ['조회 시각', reading
      ? el('span', {}, [kstStamp(reading.fetched_at), el('small', {}, fresh ? '방금 받은 응답' : '마지막으로 성공한 조회')])
      : '—'],
    ['기준 시간대', el('span', {}, ['Asia/Seoul', el('small', {}, '날짜 키와 화면의 모든 시각 기준')])],
    ['호출 주소', reading
      ? el('a', { href: reading.source_url, target: '_blank', rel: 'noreferrer noopener' }, '조회 주소 열기')
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
  const paint = () => { button.textContent = `다시 조회 · ${left}s`; };
  button.disabled = true;
  paint();
  const id = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(id);
      button.disabled = false;
      button.textContent = '지금 다시 조회';
      return;
    }
    paint();
  }, 1000);
}

$('refetch').addEventListener('click', runLive);

/* ── HISTORY ─────────────────────────────────────── */

function renderDaily() {
  const body = $('daily').querySelector('tbody');
  body.replaceChildren();
  const rows = [...store.rows].sort((a, b) => a.record_date.localeCompare(b.record_date));

  if (!rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: 6, className: 'empty' },
      '보존된 기록이 아직 없습니다. 첫 실제 조회가 기록되면 여기에 한 줄이 생깁니다.')));
    return;
  }

  const max = Math.max(...rows.map((r) => r.normalized_value), 1);
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    let delta = '—';
    let cls = 'num';
    if (prev && prev.unit === row.unit) {
      const d = Math.round((row.normalized_value - prev.normalized_value) * 1e6) / 1e6;
      delta = `${signed(d)} ${row.unit}`;
      cls = `num ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`;
    }
    body.append(el('tr', {}, [
      el('td', { className: 'mono' }, row.record_date),
      el('td', { className: 'num big' }, el('span', {}, [
        comma(row.normalized_value),
        el('span', { className: 'bar', style: 'margin-top:5px' },
          el('i', { style: `width:${Math.round((row.normalized_value / max) * 100)}%` }))
      ])),
      el('td', {}, row.unit),
      el('td', { className: cls }, delta),
      el('td', {}, el('span', {}, [
        kstStamp(row.reading?.source_time) ?? '—',
        row.raw_excerpt?.target_date_kst ? el('span', { className: 'sub' }, `대상 ${row.raw_excerpt.target_date_kst}`) : null
      ])),
      el('td', {}, row.reading?.source_url
        ? el('a', { href: row.reading.source_url, target: '_blank', rel: 'noreferrer noopener' }, 'API')
        : '—')
    ]));
  });
}

/* ── FALLBACK ────────────────────────────────────── */

function button(label, onClick, className = '') {
  const node = el('button', { type: 'button', className }, label);
  node.addEventListener('click', onClick);
  return node;
}

function buildControls() {
  $('controls').replaceChildren(
    button('정상 3단계', () => playSequence('normal'), 'solid'),
    button('reset', () => resetLab()),
    el('span', { className: 'break' }),
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
    stat('FRESHNESS', status ? (status.freshness === 'fresh' ? '새 값' : '오래된 값') : '—', true),
    stat('ERROR_CODE', status ? status.error_code : '—', true),
    stat('ROWS', `${labState.daily_readings.length}`),
    stat('LAST GOOD', good ? `${good.normalized_value}` : '없음', !good),
    stat('DELTA', cmp?.state === 'comparable' ? signed(cmp.signed) : '—')
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
      el('td', { className: 'num big' }, String(row.normalized_value)),
      el('td', {}, row.unit),
      el('td', { className: `num ${d > 0 ? 'up' : d < 0 ? 'down' : ''}` }, d === null ? '—' : `${signed(d)} ${row.unit}`),
      el('td', { className: 'mono' }, row.record_id)
    ]));
  });
}

function stat(label, value, small = false) {
  return el('div', {}, [el('dt', {}, label), el('dd', { className: small ? 'sm' : '' }, value)]);
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
      el('p', { className: 'note' }, `fixture를 불러오지 못했습니다: ${error.message}`)
    );
  }
}

boot();
