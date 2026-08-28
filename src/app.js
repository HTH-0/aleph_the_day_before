import { ERROR_PRESENTATION, createEmptyState, kstStamp, lastGoodRow } from './core.js';
import { SIGNAL, applyLiveResult, fetchLive } from './live-adapter.js';
import { SEQUENCES, loadFixtures, replayDelayMs, runFixture } from './replay-adapter.js';
import { emptyStore, stateFromStore } from './store.js';

const NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === '') continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};
const svg = (tag, attrs = {}, text) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = String(text);
  return node;
};
const comma = (n) => Number(n).toLocaleString('ko-KR');
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${comma(Math.abs(n))}`;

let store = emptyStore(SIGNAL.signal_id);
let liveResult = null;
let liveState = createEmptyState();
let fixtures = null;
let labState = createEmptyState();
let labSteps = [];
let busy = false;
let seqBusy = false;

/* ── 헤드라인 ────────────────────────────────────── */

function renderLive() {
  const status = liveState.status;
  const fresh = status?.freshness === 'fresh';
  const good = lastGoodRow(liveState);
  const reading = fresh ? liveState.current_reading : good?.reading ?? null;

  const value = $('value');
  value.classList.toggle('is-stale', !fresh);
  if (reading) value.textContent = comma(reading.normalized_value);
  else if (status) value.textContent = '—';
  else value.replaceChildren(el('span', { className: 'skel' }));
  $('unit').textContent = reading ? reading.unit : '';

  const target = liveResult?.targetDate ?? reading?.raw_excerpt?.target_date_kst;
  $('eyebrow').replaceChildren(
    document.createTextNode('어제 하루 동안 생긴 공개 GITHUB 저장소'),
    target ? el('b', {}, `  ·  ${target}`) : ''
  );

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
    delta.textContent = '';
  }

  const pill = $('pill');
  pill.className = `pill ${fresh ? 'fresh' : 'stale'}`;
  pill.textContent = fresh ? '새 값' : status ? `오래된 값 · ${status.error_code}` : '확인 중';

  // C06~C09: 출처 · 출처 관측 시각 · 조회 시각 · 기준 시간대를 한 줄로 유지한다.
  const meta = $('meta');
  meta.replaceChildren(
    ...(reading
      ? [
          el('span', {}, reading.source_name),
          el('span', {}, `관측 ${kstStamp(reading.source_time)}`),
          el('span', {}, `조회 ${kstStamp(reading.fetched_at)}`),
          el('span', {}, reading.record_timezone)
        ]
      : [el('span', {}, SIGNAL.source_name), el('span', {}, 'Asia/Seoul')])
  );

  $('failure').replaceChildren();
  if (status && !fresh) {
    $('failure').append(failureBox(status.error_code, liveState.last_run, good, runLive));
  }

  renderDetail(reading);
}

function renderDetail(reading) {
  const dl = $('detail');
  dl.replaceChildren();
  const rows = [
    ['집계 범위', SIGNAL.scope_note],
    ['세는 구간', liveResult?.targetDate
      ? `${liveResult.targetDate}T00:00:00+09:00 .. T23:59:59+09:00`
      : '어제 하루 (KST)'],
    ['집계 완전성', liveResult?.outcome === 'success'
      ? (liveResult.incomplete ? 'incomplete_results: true — 실제보다 적을 수 있음' : 'incomplete_results: false')
      : '—'],
    ['남은 호출', typeof liveResult?.rateRemaining === 'number' ? `${liveResult.rateRemaining} / 10 per min` : '—'],
    ['호출 주소', reading
      ? el('a', { href: reading.source_url, target: '_blank', rel: 'noreferrer noopener' }, reading.source_url)
      : '—'],
    ['record_date', reading ? reading.record_date : '—']
  ];
  for (const [k, v] of rows) dl.append(el('dt', {}, k), el('dd', {}, v));
}

function failureBox(code, run, good, onRetry) {
  const view = ERROR_PRESENTATION[code];
  const box = el('div', { className: 'failure' });
  box.append(el('h3', {}, `${view.label} — ${view.headline}`));
  box.append(el('p', {}, view.detail));
  box.append(el('p', {}, good
    ? `위 숫자는 ${good.record_date} ${kstStamp(good.last_fetched_at)}에 받은 마지막 정상값 ${comma(good.normalized_value)} ${good.unit}입니다. 지우지 않고 그대로 둡니다.`
    : '보존된 마지막 정상값이 없어 보여 줄 값이 없습니다. 값을 만들어 채우지 않습니다.'));
  box.append(el('p', { className: 'next' }, `다음 행동 · ${view.next}`));

  const tech = [run?.message, run?.retry_after_seconds ? `Retry-After ${run.retry_after_seconds}s` : null, run?.fixture_id]
    .filter(Boolean).join(' · ');
  if (tech) box.append(el('p', { className: 'tech' }, tech));

  if (onRetry) {
    const b = el('button', { className: 'retry', type: 'button' }, '다시 시도');
    b.addEventListener('click', async () => {
      // 인증 없는 검색은 IP당 분당 10회다. 연타로 스스로 제한을 부르지 않게 막는다.
      b.disabled = true;
      b.textContent = '다시 시도 중…';
      await onRetry();
    });
    box.append(b);
  }
  return box;
}

async function runLive() {
  liveResult = await fetchLive();
  liveState = applyLiveResult(stateFromStore(store), liveResult);
  renderLive();
}

/* ── 차트 ────────────────────────────────────────── */

function renderChart(rows) {
  const node = $('chart');
  node.replaceChildren();
  const W = 1000;
  const H = 280;
  const pad = { top: 34, right: 60, bottom: 34, left: 60 };
  node.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  if (!rows.length) {
    node.append(svg('line', { class: 'placeholder', x1: pad.left, y1: H / 2, x2: W - pad.right, y2: H / 2 }));
    node.append(svg('text', { class: 'hint', x: W / 2, y: H / 2 - 16, 'text-anchor': 'middle' },
      '보존된 기록이 아직 없습니다'));
    return;
  }

  const values = rows.map((r) => r.normalized_value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(Math.abs(max) * 0.1, 1);
  const lo = min - span * 0.45;
  const hi = max + span * 0.45;

  const x = (i) => rows.length === 1
    ? W / 2
    : pad.left + (i * (W - pad.left - pad.right)) / (rows.length - 1);
  const y = (v) => pad.top + ((hi - v) / (hi - lo)) * (H - pad.top - pad.bottom);

  // 가로 격자 3줄
  for (let i = 0; i <= 2; i += 1) {
    const gy = pad.top + (i * (H - pad.top - pad.bottom)) / 2;
    node.append(svg('line', { class: 'grid', x1: pad.left - 14, y1: gy, x2: W - pad.right + 14, y2: gy }));
  }
  node.append(svg('text', { class: 'axis', x: pad.left - 20, y: pad.top + 4, 'text-anchor': 'end' }, comma(Math.round(hi))));
  node.append(svg('text', { class: 'axis', x: pad.left - 20, y: H - pad.bottom + 4, 'text-anchor': 'end' }, comma(Math.round(lo))));

  if (rows.length > 1) {
    const d = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(r.normalized_value)}`).join(' ');
    node.append(svg('path', { class: 'line', d }));
  }

  rows.forEach((row, i) => {
    const cx = x(i);
    const cy = y(row.normalized_value);
    node.append(svg('circle', { class: 'dot', cx, cy, r: 5 }));
    const anchor = rows.length === 1 ? 'middle' : i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle';
    node.append(svg('text', { class: 'dot-label', x: cx, y: cy - 16, 'text-anchor': anchor }, comma(row.normalized_value)));
    node.append(svg('text', { class: 'axis', x: cx, y: H - 8, 'text-anchor': anchor }, row.record_date.slice(5)));
  });
}

/* ── HISTORY ─────────────────────────────────────── */

function renderDaily() {
  const rows = [...store.rows].sort((a, b) => a.record_date.localeCompare(b.record_date));
  renderChart(rows);

  const body = $('daily').querySelector('tbody');
  body.replaceChildren();
  if (!rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: 6, className: 'empty' },
      '첫 실제 조회가 기록되면 여기에 한 줄이 생깁니다.')));
    return;
  }
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
      el('td', { className: 'num big' }, comma(row.normalized_value)),
      el('td', {}, row.unit),
      el('td', { className: cls }, delta),
      el('td', { className: 'mono' }, kstStamp(row.reading?.source_time) ?? '—'),
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
    ...['timeout', 'auth', 'rate', 'offline', 'schema'].map((k) =>
      button(SEQUENCES[k].title, () => playSequence(k)))
  );
}

function resetLab() {
  labState = createEmptyState();
  labSteps = [];
  renderLab();
}

async function playOne(id) {
  if (busy) return;
  busy = true;
  const fixture = fixtures[id];
  await new Promise((r) => setTimeout(r, replayDelayMs(fixture)));
  labState = runFixture(labState, fixture);
  labSteps.push({
    id,
    freshness: labState.status.freshness,
    code: labState.status.error_code,
    rows: labState.daily_readings.length
  });
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

  const timeline = $('timeline');
  timeline.replaceChildren(
    ...labSteps.map((step) => el('div', { className: `step ${step.freshness === 'fresh' ? 'ok' : 'err'}` }, [
      el('div', { className: 'rail' }),
      el('span', { className: 'id' }, step.id.replace('T04-', '')),
      el('span', { className: 'st' }, step.freshness === 'fresh' ? 'fresh' : step.code)
    ]))
  );

  $('state').replaceChildren(
    stat('FRESHNESS', status ? status.freshness : '—', true),
    stat('ERROR_CODE', status ? status.error_code : '—', true),
    stat('ROWS', String(labState.daily_readings.length)),
    stat('LAST GOOD', good ? String(good.normalized_value) : '—'),
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
    body.append(el('tr', {}, el('td', { colSpan: 5, className: 'empty' }, '재생 전')));
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
    $('controls').replaceChildren(el('p', { className: 'note' }, `fixture 로드 실패: ${error.message}`));
  }
}

boot();
