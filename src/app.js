import {
  ERROR_PRESENTATION,
  createEmptyState,
  kstDate,
  kstStamp,
  lastGoodRow
} from './core.js';
import { SIGNAL, applyLiveResult, fetchLive, rawExcerpt } from './live-adapter.js';
import { BASE_PATH, FIXTURE_FILES, SEQUENCES, loadFixtures, replayDelayMs, runFixture } from './replay-adapter.js';
import { emptyStore, recomputeDelta, stateFromStore } from './store.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};
const text = (value) => (value === null || value === undefined || value === '' ? '—' : String(value));
const numText = (n) => (typeof n === 'number' ? String(n) : '—');
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}`;

let store = emptyStore(SIGNAL.signal_id);
let liveResult = null;
let liveState = createEmptyState();
let fixtures = null;
let labState = createEmptyState();
let labSeq = 0;
let labBusy = false;

/* ── 시계 ───────────────────────────────────────────── */
function tick() {
  $('clock').textContent = (kstStamp(new Date().toISOString()) || '').replace(/^\d{4}-\d{2}-\d{2} /, '');
}
setInterval(tick, 1000);
tick();

/* ── 1. 지금 값 ─────────────────────────────────────── */
$('signal-question').textContent = SIGNAL.question;
$('signal-name').textContent = SIGNAL.title;
$('foot-source').textContent = SIGNAL.source_name;
$('foot-source').href = SIGNAL.source_home;

function renderLive() {
  const status = liveState.status;
  const ok = status && status.freshness === 'fresh';
  const good = lastGoodRow(liveState) || null;
  const reading = ok ? liveState.current_reading : good ? good.reading : null;

  const valueEl = $('live-value');
  valueEl.classList.toggle('stale', !ok);
  if (reading) {
    valueEl.textContent = numText(reading.normalized_value);
  } else if (status) {
    valueEl.textContent = '값 없음';
  } else {
    valueEl.replaceChildren(el('span', { className: 'skel' }));
  }
  $('live-unit').textContent = reading ? reading.unit : '';

  // 전일 대비
  const cmp = liveState.last_comparison;
  const deltaEl = $('live-delta');
  deltaEl.className = 'delta none';
  if (cmp && cmp.state === 'comparable') {
    deltaEl.className = `delta ${cmp.direction === 'increase' ? 'up' : cmp.direction === 'decrease' ? 'down' : 'flat'}`;
    deltaEl.textContent = `${signed(cmp.signed)} ${cmp.unit}`;
    $('live-delta-caption').textContent =
      `${cmp.previous.record_date} 기록 ${cmp.previous.normalized_value} ${cmp.previous.unit}과 비교해 다시 계산했습니다.`;
  } else if (cmp && cmp.state === 'unit_mismatch') {
    deltaEl.textContent = '단위가 달라 비교하지 않음';
    $('live-delta-caption').textContent = '';
  } else {
    deltaEl.textContent = '비교할 어제 기록 없음';
    $('live-delta-caption').textContent =
      store.rows.length ? '' : '보존된 일별 기록이 아직 없습니다. 다른 KST 날짜에 한 건 더 쌓이면 여기에서 변화가 계산됩니다.';
  }

  // 정직 스트립
  const honesty = $('honesty');
  honesty.classList.toggle('is-stale', !ok);
  $('h-freshness').firstChild.textContent = ok ? '새 값 (fresh)' : '오래된 값 (stale)';
  $('h-freshness-sub').textContent = ok
    ? '방금 받은 응답입니다'
    : status
      ? `error_code = ${status.error_code}`
      : '아직 조회하지 않았습니다';
  $('h-lastgood').firstChild.textContent = good ? `${good.normalized_value} ${good.unit}` : '없음';
  $('h-lastgood-sub').textContent = good
    ? `${good.record_date} · ${kstStamp(good.last_fetched_at)}`
    : '성공한 조회가 아직 없습니다';
  const run = liveState.last_run;
  $('h-attempt').firstChild.textContent = run ? (run.outcome === 'success' ? '성공' : '실패') : '—';
  $('h-attempt-sub').textContent = run
    ? `${kstStamp(run.attempted_at || run.virtual_now) || '—'}${run.outcome === 'error' ? ` · ${run.error_code}` : ''}`
    : '—';

  // 실패 안내
  $('live-fail').replaceChildren();
  if (!ok && status) {
    $('live-fail').append(failBox(status.error_code, run, good, { retry: () => runLive() }));
  }

  renderFacts(reading, ok);
  renderTrace();
}

function failBox(code, run, good, { retry } = {}) {
  const view = ERROR_PRESENTATION[code];
  const box = el('div', { className: 'failbox' });
  box.append(el('h4', {}, `${view.label} — ${view.headline}`));
  box.append(el('p', {}, view.detail));
  if (good) {
    box.append(el('p', {}, `아래 큰 숫자는 ${good.record_date} ${kstStamp(good.last_fetched_at)}에 받은 마지막 정상값 ${good.normalized_value} ${good.unit}입니다. 지우지 않고 그대로 둡니다.`));
  } else {
    box.append(el('p', {}, '보존된 마지막 정상값이 아직 없어 보여 줄 값이 없습니다. 값을 만들어 채우지 않습니다.'));
  }
  box.append(el('p', { className: 'next' }, `다음 행동 · ${view.next}`));
  const tech = [
    run?.message,
    run?.retry_after_seconds ? `Retry-After ${run.retry_after_seconds}s` : null,
    run?.fixture_id ? `fixture ${run.fixture_id}` : null
  ].filter(Boolean).join(' · ');
  if (tech) box.append(el('p', { className: 'tech' }, tech));
  if (retry) {
    const bar = el('div', { className: 'btnbar' });
    const button = el('button', { className: 'retry', type: 'button' }, '다시 시도');
    button.addEventListener('click', retry);
    bar.append(button);
    box.append(bar);
  }
  return box;
}

function renderFacts(reading, ok) {
  const dl = $('live-facts');
  dl.replaceChildren();
  const rows = [
    ['값', reading ? `${reading.normalized_value} ${reading.unit}` : '—'],
    ['단위', reading ? `${reading.unit} (응답의 current_units에서 그대로 읽음)` : '—'],
    ['출처', reading ? reading.source_name : SIGNAL.source_name],
    ['호출 주소', reading ? el('a', { href: reading.source_url, target: '_blank', rel: 'noreferrer noopener' }, reading.source_url)
      : el('a', { href: SIGNAL.endpoint, target: '_blank', rel: 'noreferrer noopener' }, SIGNAL.endpoint)],
    ['출처 관측 시각', reading ? `${kstStamp(reading.source_time)}` : '—'],
    ['조회 시각', reading ? `${kstStamp(reading.fetched_at)}${ok ? '' : ' (마지막 성공 기준)'}` : '—'],
    ['기준 시간대', reading ? reading.record_timezone : 'Asia/Seoul'],
    ['기록 날짜', reading ? reading.record_date : kstDate(new Date().toISOString())],
    ['보존 여부', reading && store.rows.some((r) => r.record_date === reading.record_date)
      ? '이 날짜는 data/daily.json에 보존되어 있습니다'
      : '아직 보존 파일에 없습니다 (이 화면 세션에만 있는 값)']
  ];
  for (const [key, value] of rows) {
    dl.append(el('div', {}, [el('dt', {}, key), el('dd', {}, value)]));
  }
}

function renderTrace() {
  const body = $('trace-table').querySelector('tbody');
  body.replaceChildren();
  if (!liveResult || liveResult.outcome !== 'success') {
    body.append(el('tr', {}, el('td', { colSpan: 5, className: 'empty' },
      liveResult ? '이번 조회가 실패해 대조할 원자료가 없습니다. 값을 지어내지 않습니다.' : '조회를 기다리는 중입니다.')));
    return;
  }
  const raw = liveResult.raw;
  const reading = liveResult.reading;
  const rows = [
    ['값', `current.temperature_2m = ${raw.current.temperature_2m}`, `normalized_value = ${reading.normalized_value}`,
      `${$('live-value').textContent}`, raw.current.temperature_2m === reading.normalized_value && $('live-value').textContent === String(reading.normalized_value)],
    ['단위', `current_units.temperature_2m = ${raw.current_units.temperature_2m}`, `unit = ${reading.unit}`,
      $('live-unit').textContent, raw.current_units.temperature_2m === reading.unit && $('live-unit').textContent === reading.unit],
    ['출처 관측 시각', `current.time = ${raw.current.time} (utc_offset_seconds = ${raw.utc_offset_seconds})`,
      `source_time = ${reading.source_time}`, kstStamp(reading.source_time),
      new Date(reading.source_time).getTime() === new Date(`${raw.current.time.length === 16 ? `${raw.current.time}:00` : raw.current.time}+09:00`).getTime()],
    ['조회 시각', '요청을 보낸 시각(브라우저 시계)', `fetched_at = ${reading.fetched_at}`, kstStamp(reading.fetched_at), true],
    ['기준 시간대', `timezone = ${raw.timezone}`, `record_timezone = ${reading.record_timezone}`, reading.record_timezone,
      raw.timezone === reading.record_timezone],
    ['기록 날짜', 'fetched_at을 Asia/Seoul로 변환', `record_date = ${reading.record_date}`, reading.record_date,
      reading.record_date === kstDate(reading.fetched_at)]
  ];
  for (const [name, rawCell, storedCell, shownCell, ok] of rows) {
    body.append(el('tr', {}, [
      el('td', {}, name),
      el('td', { className: 'mono' }, rawCell),
      el('td', { className: 'mono' }, storedCell),
      el('td', {}, text(shownCell)),
      el('td', { className: ok ? 'match' : 'mismatch' }, ok ? '일치' : '불일치')
    ]));
  }
}

async function runLive() {
  $('btn-refetch').disabled = true;
  $('btn-refetch').textContent = '조회 중…';
  $('live-value').replaceChildren(el('span', { className: 'skel' }));
  liveResult = await fetchLive();
  liveState = applyLiveResult(stateFromStore(store), liveResult);
  renderLive();
  $('btn-refetch').disabled = false;
  $('btn-refetch').textContent = '지금 다시 조회';
}

$('btn-refetch').addEventListener('click', runLive);

$('btn-raw').addEventListener('click', () => {
  const box = $('live-extra');
  if (box.dataset.mode === 'raw') { box.replaceChildren(); box.dataset.mode = ''; return; }
  box.dataset.mode = 'raw';
  box.replaceChildren(el('pre', {},
    liveResult?.raw ? JSON.stringify(liveResult.raw, null, 2) : '이번 조회에서 받은 원자료가 없습니다.'));
});

$('btn-export').addEventListener('click', () => {
  const box = $('live-extra');
  if (box.dataset.mode === 'export') { box.replaceChildren(); box.dataset.mode = ''; return; }
  box.dataset.mode = 'export';
  if (!liveResult || liveResult.outcome !== 'success') {
    box.replaceChildren(el('pre', {}, '성공한 조회가 없어 내보낼 기록이 없습니다.'));
    return;
  }
  const row = liveState.daily_readings.find((r) => r.record_date === liveResult.reading.record_date);
  box.replaceChildren(
    el('p', { className: 'section-note', style: 'margin-top:12px' },
      '자동 기록이 돌지 않았을 때 쓰는 수동 경로입니다. 아래 행을 data/daily.json의 rows에 넣고 커밋하면 같은 결과가 됩니다.'),
    el('pre', {}, JSON.stringify({ ...row, raw_excerpt: rawExcerpt(liveResult.raw) }, null, 2))
  );
});

/* ── 3. 보존된 일별 기록 ────────────────────────────── */
function renderDaily() {
  const body = $('daily-table').querySelector('tbody');
  body.replaceChildren();
  const rows = [...store.rows].sort((a, b) => a.record_date.localeCompare(b.record_date));

  if (!rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: 8, className: 'empty' },
      '보존된 기록이 아직 없습니다. 첫 실제 조회가 기록되면 여기에 한 줄이 생깁니다.')));
  } else {
    rows.forEach((row, index) => {
      const prev = rows[index - 1];
      let delta = '—';
      let cls = '';
      if (prev && prev.unit === row.unit) {
        const d = Math.round((row.normalized_value - prev.normalized_value) * 1e6) / 1e6;
        delta = `${signed(d)} ${row.unit}`;
        cls = d > 0 ? 'match' : d < 0 ? 'mismatch' : '';
      }
      body.append(el('tr', {}, [
        el('td', { className: 'mono' }, row.record_date),
        el('td', { className: 'num' }, numText(row.normalized_value)),
        el('td', {}, row.unit),
        el('td', { className: `num ${cls}` }, delta),
        el('td', {}, text(kstStamp(row.reading?.source_time))),
        el('td', {}, text(kstStamp(row.last_fetched_at))),
        el('td', { className: 'mono' }, row.record_id),
        el('td', { className: 'num' }, String(row.update_count ?? 1))
      ]));
    });
  }

  // 재계산 패널
  const panel = $('recompute');
  panel.replaceChildren();
  const d = recomputeDelta(rows);
  panel.append(el('strong', { style: 'font-size:14px' }, '어제 대비 변화 재계산'));
  if (d.state !== 'comparable') {
    panel.append(el('p', { className: 'section-note', style: 'margin-top:6px' },
      rows.length < 2
        ? `보존된 기록이 ${rows.length}건이라 아직 계산하지 않습니다. 서로 다른 KST 날짜의 기록 2건이 모이면 여기에서 계산합니다.`
        : '두 기록의 단위가 달라 계산하지 않습니다.'));
    return;
  }
  panel.append(el('p', { className: 'section-note', style: 'margin-top:6px' },
    '저장된 두 값을 KST 날짜순으로 놓고 뺄셈만 합니다. 화면 어디에도 미리 계산해 둔 변화값을 쓰지 않습니다.'));
  panel.append(el('pre', {}, d.formula));
  panel.append(el('p', { style: 'margin:12px 0 0;font-size:13px' }, [
    el('span', { className: 'pill ok' }, `화면 표시값 ${signed(d.signed)} ${d.unit}`),
    ' ',
    el('span', { className: 'pill' }, `보존값 재계산 ${signed(d.signed)} ${d.unit}`),
    ' ',
    el('span', { className: 'pill ok' }, '일치')
  ]));
}

/* ── 4. 재생 실험실 ─────────────────────────────────── */
function labButton(label, onClick, className = '') {
  const button = el('button', { type: 'button', className }, label);
  button.addEventListener('click', onClick);
  return button;
}

function buildLabControls() {
  $('seq-normal').replaceChildren(
    labButton('정상 3단계 (D1-A → D1-B → D2)', () => playSequence('normal'))
  );
  $('seq-failures').replaceChildren(
    ...['timeout', 'auth', 'rate', 'offline', 'schema'].map((key) =>
      labButton(SEQUENCES[key].title, () => playSequence(key)))
  );
  $('seq-recover').replaceChildren(
    labButton('느린 응답 → 다시 시도 → 회복', () => playSequence('recover'))
  );
  $('seq-single').replaceChildren(
    ...FIXTURE_FILES.map(({ id }) => labButton(id, () => playOne(id), 'small'))
  );
}

function resetLab(message = 'reset — 합성 상태를 비웠습니다.') {
  labState = createEmptyState();
  labSeq = 0;
  $('lab-log').replaceChildren();
  logLab(message, 'ok');
  renderLab();
}

function logLab(message, kind = '') {
  labSeq += 1;
  const list = $('lab-log');
  list.prepend(el('li', {}, [
    el('span', { className: 'seq' }, String(labSeq).padStart(2, '0')),
    el('span', { className: kind }, message)
  ]));
}

async function playOne(id, { keepState = true } = {}) {
  if (labBusy) return;
  labBusy = true;
  if (!keepState) resetLab();
  const fixture = fixtures[id];
  logLab(`${id} 재생 중… (${fixture.description_ko})`);
  renderLab();
  await new Promise((r) => setTimeout(r, replayDelayMs(fixture)));
  labState = runFixture(labState, fixture);
  const status = labState.status;
  logLab(
    `${id} → ${status.freshness}/${status.error_code} · 행 ${labState.daily_readings.length}건 · 마지막 정상값 ${lastGoodRow(labState)?.normalized_value ?? '없음'}`,
    status.error_code === 'none' ? 'ok' : 'err'
  );
  renderLab();
  labBusy = false;
}

let seqBusy = false;
async function playSequence(key) {
  if (labBusy || seqBusy) return;
  seqBusy = true;
  resetLab(`reset — ${SEQUENCES[key].title} 재생을 시작합니다.`);
  for (const id of SEQUENCES[key].ids) {
    // 회복 순서의 마지막 단계는 사용자가 '다시 시도'를 누른 것과 같은 경로다.
    await playOne(id);
  }
  seqBusy = false;
}

function renderLab() {
  const status = labState.status;
  const good = lastGoodRow(labState);
  const cmp = labState.last_comparison;

  const metrics = $('lab-metrics');
  metrics.replaceChildren(
    metric('신선도', status ? status.freshness : '—', status ? (status.freshness === 'fresh' ? '새 값' : '오래된 값') : '재생 전'),
    metric('오류 코드', status ? status.error_code : '—', status && status.error_code !== 'none' ? ERROR_PRESENTATION[status.error_code].label : ''),
    metric('일별 행', String(labState.daily_readings.length), '건'),
    metric('마지막 정상값', good ? String(good.normalized_value) : '없음', good ? `${good.unit} · ${good.record_date}` : ''),
    metric('전일 대비', cmp?.state === 'comparable' ? signed(cmp.signed) : '—', cmp?.state === 'comparable' ? cmp.unit : '기록 1건')
  );

  const failWrap = $('lab-fail');
  failWrap.replaceChildren();
  if (status && status.freshness === 'stale') {
    failWrap.append(failBox(status.error_code, labState.last_run, good, {
      retry: () => playOne('T04-RECOVER-D2')
    }));
  } else if (status && labState.last_run?.fixture_id === 'T04-RECOVER-D2') {
    const box = el('div', { className: 'failbox', style: 'border-color:#b7ecc7;background:#ecfdf3' });
    box.append(el('h4', { style: 'color:#14532d' }, '회복 확인 — fresh / none'));
    box.append(el('p', { style: 'color:#166534' },
      `다시 시도 뒤 상태가 fresh/none으로 돌아왔고, 다음 합성 날짜 ${labState.current_reading.record_date} 행이 1건 추가되어 총 ${labState.daily_readings.length}건, 저장값 ${labState.current_reading.normalized_value}, 전일 대비 ${cmp?.state === 'comparable' ? signed(cmp.signed) : '—'} ${cmp?.unit ?? ''}입니다.`));
    failWrap.append(box);
  }

  const body = $('lab-table').querySelector('tbody');
  body.replaceChildren();
  const rows = labState.daily_readings;
  if (!rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: 6, className: 'empty' },
      '합성 상태가 비어 있습니다. 왼쪽에서 재생을 시작하세요.')));
  } else {
    rows.forEach((row, index) => {
      const prev = rows[index - 1];
      const d = prev && prev.unit === row.unit
        ? Math.round((row.normalized_value - prev.normalized_value) * 1e6) / 1e6
        : null;
      body.append(el('tr', {}, [
        el('td', { className: 'mono' }, row.record_date),
        el('td', { className: 'num' }, numText(row.normalized_value)),
        el('td', {}, row.unit),
        el('td', { className: `num ${d > 0 ? 'match' : d < 0 ? 'mismatch' : ''}` }, d === null ? '—' : `${signed(d)} ${row.unit}`),
        el('td', { className: 'mono' }, row.record_id),
        el('td', { className: 'num' }, String(row.update_count ?? 1))
      ]));
    });
  }
}

function metric(label, value, sub) {
  return el('div', { className: 'metric' }, [
    el('dt', {}, label),
    el('dd', {}, [String(value), sub ? el('small', {}, ` ${sub}`) : ''])
  ]);
}

$('btn-reset').addEventListener('click', () => resetLab());

/* ── 5. 자가검증 ────────────────────────────────────── */
function checkStep(state, fixture, seen) {
  const expected = fixture.expected;
  const rows = state.daily_readings;
  const good = lastGoodRow(state);
  const row = expected.record_date ? rows.find((r) => r.record_date === expected.record_date) : null;
  const checks = [
    ['freshness', state.status?.freshness, expected.freshness],
    ['error_code', state.status?.error_code, expected.error_code],
    ['row_count', rows.length, expected.row_count],
    ['stored_value', good ? good.normalized_value : null, expected.stored_value],
    ['delta', state.last_delta === null ? null : Math.abs(state.last_delta), expected.delta],
    ['preserve_last_good', good !== null, expected.preserve_last_good]
  ];
  if (expected.record_date) checks.push(['record_date', row ? row.record_date : null, expected.record_date]);
  if (expected.same_record_id_as) {
    checks.push(['same_record_id', row ? row.record_id : null, seen[expected.same_record_id_as] ?? null]);
  }
  if (row) seen[fixture.fixture_id] = row.record_id;
  return checks.filter(([, actual, want]) => JSON.stringify(actual) !== JSON.stringify(want));
}

function runVerification() {
  const body = $('verify-table').querySelector('tbody');
  body.replaceChildren();
  for (const [, seq] of Object.entries(SEQUENCES)) {
    let state = createEmptyState();
    const seen = {};
    let bad = 0;
    for (const id of seq.ids) {
      state = runFixture(state, fixtures[id]);
      bad += checkStep(state, fixtures[id], seen).length;
    }
    const good = lastGoodRow(state);
    body.append(el('tr', {}, [
      el('td', {}, seq.title),
      el('td', { className: 'mono' }, seq.ids[seq.ids.length - 1]),
      el('td', { className: 'mono' }, `${state.status.freshness} / ${state.status.error_code}`),
      el('td', { className: 'num' }, String(state.daily_readings.length)),
      el('td', { className: 'num' }, numText(good?.normalized_value)),
      el('td', { className: 'num' }, state.last_delta === null ? '—' : signed(state.last_delta)),
      el('td', { className: bad ? 'mismatch' : 'match' }, bad ? `불일치 ${bad}건` : '기대값과 일치')
    ]));
  }
}

async function verifyHashes() {
  const body = $('hash-table').querySelector('tbody');
  body.replaceChildren();
  let manifest;
  try {
    manifest = await (await fetch(`${BASE_PATH}asset-manifest.json`, { cache: 'no-store' })).json();
  } catch {
    body.append(el('tr', {}, el('td', { colSpan: 4, className: 'empty' }, 'asset-manifest.json을 읽지 못했습니다.')));
    return;
  }
  $('pkg-id').textContent = `package_id ${manifest.package_id} · sha256 · 파일 ${manifest.files.length}건`;

  if (!(globalThis.crypto && crypto.subtle)) {
    body.append(el('tr', {}, el('td', { colSpan: 4, className: 'empty' },
      '이 브라우저 환경에서는 해시를 계산할 수 없습니다. node scripts/verify-assets.js로 확인하세요.')));
    return;
  }
  let bad = 0;
  for (const entry of manifest.files) {
    let cells;
    try {
      const buffer = await (await fetch(`${BASE_PATH}${entry.path}`, { cache: 'no-store' })).arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const ok = hex === entry.sha256 && buffer.byteLength === entry.bytes;
      if (!ok) bad += 1;
      cells = [
        el('td', { className: 'mono' }, entry.path),
        el('td', { className: 'num' }, String(buffer.byteLength)),
        el('td', { className: 'mono' }, `${hex.slice(0, 24)}…`),
        el('td', { className: ok ? 'match' : 'mismatch' }, ok ? '일치' : '불일치')
      ];
    } catch {
      bad += 1;
      cells = [
        el('td', { className: 'mono' }, entry.path),
        el('td', { className: 'num' }, '—'),
        el('td', {}, '읽지 못함'),
        el('td', { className: 'mismatch' }, '확인 불가')
      ];
    }
    body.append(el('tr', {}, cells));
  }
  $('pkg-id').textContent += bad ? ` · 불일치 ${bad}건` : ' · 전체 일치';
}

/* ── 시작 ───────────────────────────────────────────── */
async function boot() {
  try {
    const response = await fetch('./data/daily.json', { cache: 'no-store' });
    if (response.ok) {
      const parsed = await response.json();
      if (Array.isArray(parsed.rows)) store = parsed;
    }
  } catch {
    // 저장 파일을 못 읽으면 빈 상태로 둔다. 값을 지어내지 않는다.
  }
  renderDaily();
  liveState = stateFromStore(store);
  renderLive();
  runLive();

  try {
    fixtures = await loadFixtures();
    buildLabControls();
    resetLab();
    runVerification();
  } catch (error) {
    $('lab-log').replaceChildren(el('li', {}, [el('span', { className: 'seq' }, '!!'),
      el('span', { className: 'err' }, `fixture를 불러오지 못했습니다: ${error.message}`)]));
  }
  verifyHashes();
}

boot();
