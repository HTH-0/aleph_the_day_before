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
// 표에는 같은 행에 날짜 열이 이미 있어서, 시각 열은 날짜를 반복하지 않고 시:분:초만 남긴다
const kstTime = (iso) => kstStamp(iso)?.slice(11, 19) ?? '—';

let store = emptyStore(SIGNAL.signal_id);
let liveResult = null;
let liveState = createEmptyState();
let fixtures = null;
let labState = createEmptyState();
let labSteps = [];
let busy = false;
let seqBusy = false;

/* ── 실측 맞춤 (헤드라인 숫자 + 통계 카드 숫자 공용) ─────
   CSS clamp()은 대부분 화면에 맞는 '이상적' 크기를 잡아 두고,
   실제로 컨테이너보다 넓게 렌더링될 때만 필요한 만큼만 줄인다.
   stat-row는 overflow:hidden이라 안 맞으면 조용히 잘리므로,
   숫자뿐 아니라 카드 쪽에도 같은 안전장치를 건다. */
function fitText(target, container, minRatio = 0.5) {
  target.style.fontSize = '';
  requestAnimationFrame(() => {
    const available = container.clientWidth;
    if (!available || container.scrollWidth <= available) return;
    const naturalPx = parseFloat(getComputedStyle(target).fontSize) || 0;
    if (!naturalPx) return;
    const minPx = naturalPx * minRatio;
    let size = naturalPx;
    for (let i = 0; i < 6 && size > minPx; i += 1) {
      const ratio = available / container.scrollWidth;
      size = Math.max(minPx, Math.floor(size * ratio * 0.97));
      target.style.fontSize = `${size}px`;
      if (container.scrollWidth <= available) break;
    }
  });
}

function fitValueLine() {
  const value = $('value');
  const line = value.closest('.value-line');
  if (line) fitText(value, line, 0.35);
}

function fitStatFigures() {
  document.querySelectorAll('.stat-figure').forEach((figure) => {
    if (figure.parentElement) fitText(figure, figure.parentElement, 0.55);
  });
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    fitValueLine();
    fitStatFigures();
  }, 120);
});

/* ── 헤드라인 ────────────────────────────────────── */

function renderLive() {
  const status = liveState.status;
  const fresh = status?.freshness === 'fresh';
  const good = lastGoodRow(liveState);
  const reading = fresh ? liveState.current_reading : good?.reading ?? null;

  const value = $('value');
  value.classList.toggle('is-stale', !fresh);
  if (reading) {
    const text = comma(reading.normalized_value);
    value.textContent = text;
    value.dataset.trueText = text;
  } else if (status) {
    value.textContent = '—';
    delete value.dataset.trueText;
  } else {
    value.replaceChildren(el('span', { className: 'skel' }));
    delete value.dataset.trueText;
  }
  $('unit').textContent = reading ? reading.unit : '';
  fitValueLine();


  const target = liveResult?.targetDate ?? reading?.raw_excerpt?.target_date_kst;
  $('eyebrow').replaceChildren(
    document.createTextNode('어제 하루, GitHub에 새로 생긴 공개 저장소'),
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
  pill.textContent = fresh ? '정상 수집됨' : status ? `지연 중 · ${status.error_code}` : '확인 중';

  // C06~C09: 출처 · 출처 관측 시각 · 조회 시각 · 기준 시간대를 상시 노출.
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
    ['왜 값이 바뀌나요', 'GitHub 검색 인덱스는 실시간으로 갱신됩니다. 같은 날짜를 다시 조회해도 그 사이 저장소가 삭제·비공개 전환되면 답이 달라질 수 있습니다.'],
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

/* ── 다시 조회 버튼: 진짜 재조회 동안 숫자가 스크램블(로딩 표시)되고,
   응답이 오면 실제 값에 맞춰진다. 기록값(HISTORY)과 다르면 안내를 띄운다.
   저장된 data/daily.json은 절대 건드리지 않는다 — 화면(CURRENT)에만 반영된다. */
let refreshLoopTimer = null;
let refreshBusy = false;

function startRefreshScramble() {
  const value = $('value');
  const trueText = value.dataset.trueText || value.textContent;
  const digits = '0123456789';
  value.classList.add('is-scrambling');
  (function tick() {
    value.textContent = trueText.replace(/\d/g, () => digits[Math.floor(Math.random() * 10)]);
    refreshLoopTimer = setTimeout(tick, 70);
  })();
}
function stopRefreshScramble() {
  clearTimeout(refreshLoopTimer);
  $('value').classList.remove('is-scrambling');
}

function cooldownRefresh(btn) {
  let left = Math.ceil(SIGNAL.cooldown_ms / 1000);
  btn.disabled = true;
  btn.title = `${left}초 후 다시 조회 가능`;
  const id = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(id);
      btn.disabled = false;
      btn.title = '다시 조회';
      return;
    }
    btn.title = `${left}초 후 다시 조회 가능`;
  }, 1000);
}

async function runRefresh() {
  if (refreshBusy) return;
  refreshBusy = true;
  const btn = $('refresh-btn');
  btn.classList.add('is-loading');
  startRefreshScramble();

  liveResult = await fetchLive();
  liveState = applyLiveResult(stateFromStore(store), liveResult);

  stopRefreshScramble();
  btn.classList.remove('is-loading');
  renderLive();

  cooldownRefresh(btn);
  refreshBusy = false;
}

/* ── 통계 카드 ───────────────────────────────────── */
// 데이터가 하루치뿐이어도 세 값(최고·최저·변동폭)과 기록 일수는 항상 계산된다.

function renderStats(rows) {
  const dl = $('stats');
  dl.replaceChildren();
  if (!rows.length) {
    dl.append(
      cell('LATEST', '—', null, ''),
      cell('HIGH', '—', null, ''),
      cell('LOW', '—', null, ''),
      cell('TRACKED', '0', 'DAYS', '', 'teal')
    );
    return;
  }
  const values = rows.map((r) => r.normalized_value);
  const unit = rows[rows.length - 1].unit;
  const high = Math.max(...values);
  const low = Math.min(...values);
  const highRow = rows.find((r) => r.normalized_value === high);
  const lowRow = rows.find((r) => r.normalized_value === low);
  const latest = rows[rows.length - 1];

  dl.append(
    cell('LATEST', comma(latest.normalized_value), unit, latest.record_date, 'accent'),
    cell('HIGH', comma(high), unit, highRow.record_date, 'up'),
    cell('LOW', comma(low), unit, lowRow.record_date, 'down'),
    cell('TRACKED', String(rows.length), rows.length === 1 ? 'DAY' : 'DAYS', '', 'teal')
  );
}

function cell(label, value, unit, sub, tone = '') {
  return el('div', { className: `stat-cell ${tone}` }, [
    el('dt', {}, label),
    el('dd', {}, [
      el('span', { className: 'stat-figure' }, [
        value,
        unit ? el('span', { className: 'stat-unit' }, ` ${unit}`) : ''
      ]),
      sub ? el('small', {}, sub) : null
    ])
  ]);
}

/* ── 차트 ────────────────────────────────────────── */

function renderChart(rows) {
  const node = $('chart');
  node.replaceChildren();
  const W = 1040;
  const H = 320;
  const pad = { top: 40, right: 24, bottom: 40, left: 24 };

  const defs = svg('defs');
  const grad = svg('linearGradient', { id: 'areaFill', x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(
    svg('stop', { offset: '0%', 'stop-color': '#7069e8', 'stop-opacity': 0.26 }),
    svg('stop', { offset: '100%', 'stop-color': '#7069e8', 'stop-opacity': 0 })
  );
  defs.append(grad);
  node.append(defs);

  if (!rows.length) {
    node.append(svg('line', { class: 'placeholder', x1: pad.left, y1: H / 2, x2: W - pad.right, y2: H / 2 }));
    node.append(svg('text', { class: 'hint', x: W / 2, y: H / 2 - 20, 'text-anchor': 'middle' },
      '보존된 기록이 아직 없습니다'));
    return;
  }

  const values = rows.map((r) => r.normalized_value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(Math.abs(max) * 0.12, 1);
  const lo = min - span * 0.5;
  const hi = max + span * 0.5;

  const x = (i) => rows.length === 1
    ? W / 2
    : pad.left + (i * (W - pad.left - pad.right)) / (rows.length - 1);
  const y = (v) => pad.top + ((hi - v) / (hi - lo)) * (H - pad.top - pad.bottom);
  const base = H - pad.bottom;

  // 촘촘한 가로 격자 5줄. 값 자체는 각 포인트 위에 이미 표시되므로
  // 눈금 숫자는 그리지 않는다 — 겹칠 여지를 아예 없앤다.
  for (let i = 0; i <= 4; i += 1) {
    const gy = pad.top + (i * (H - pad.top - pad.bottom)) / 4;
    node.append(svg('line', { class: `grid${i === 4 ? ' zero' : ''}`, x1: pad.left, y1: gy, x2: W - pad.right, y2: gy }));
  }

  if (rows.length > 1) {
    const linePath = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(r.normalized_value)}`).join(' ');
    const areaPath = `${linePath} L${x(rows.length - 1)},${base} L${x(0)},${base} Z`;
    node.append(svg('path', { class: 'area', d: areaPath }));
    node.append(svg('path', { class: 'line', d: linePath }));
  } else {
    // 점 하나뿐이어도 영역감을 준다.
    const cx = x(0);
    const cy = y(rows[0].normalized_value);
    node.append(svg('path', { class: 'area', d: `M${cx - 40},${cy} L${cx + 40},${cy} L${cx + 40},${base} L${cx - 40},${base} Z` }));
  }

  rows.forEach((row, i) => {
    const cx = x(i);
    const cy = y(row.normalized_value);
    node.append(svg('circle', { class: 'dot-outer', cx, cy, r: 7 }));
    node.append(svg('circle', { class: 'dot-inner', cx, cy, r: 3 }));
    const anchor = rows.length === 1 ? 'middle' : i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle';
    node.append(svg('text', { class: 'dot-label', x: cx, y: cy - 18, 'text-anchor': anchor }, comma(row.normalized_value)));
    node.append(svg('text', { class: 'axis', x: cx, y: base + 24, 'text-anchor': anchor }, row.record_date.slice(5)));
  });
}

/* ── HISTORY ─────────────────────────────────────── */

function renderDaily() {
  const rows = [...store.rows].sort((a, b) => a.record_date.localeCompare(b.record_date));
  renderStats(rows);
  fitStatFigures();
  renderChart(rows);
  renderStrip(rows);

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
    const tr = el('tr', {}, [
      el('td', { className: 'mono' }, row.record_date),
      el('td', { className: 'num big' }, comma(row.normalized_value)),
      el('td', {}, row.unit),
      el('td', { className: cls }, delta),
      el('td', { className: 'mono' }, kstTime(row.reading?.source_time)),
      el('td', {}, row.reading?.source_url
        ? el('a', { href: row.reading.source_url, target: '_blank', rel: 'noreferrer noopener' }, 'API')
        : '—')
    ]);
    tr.dataset.date = row.record_date; // el()의 Object.assign은 dataset을 직접 못 받아 따로 지정한다
    body.append(tr);
  });
}

/* ── 히스토리 스트립 ─────────────────────────────────
   칸 수 = 기록된 날 수. 빈 칸을 미리 그리지 않는다.
   색은 그 날의 값이 지금까지의 최저~최고 사이 어디쯤인지로 정한다.
   1건뿐이면 비교 대상이 없으니 중간 톤 하나로 둔다. */
const WEEKDAY_LABELS = ['', '월', '', '수', '', '금', ''];

function renderStrip(rows) {
  const strip = $('history-strip');
  const count = $('strip-count');
  strip.replaceChildren();

  if (!rows.length) {
    count.textContent = '';
    return;
  }
  count.textContent = `${rows.length}일째 기록 중`;

  const values = rows.map((r) => r.normalized_value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;

  // GitHub 잔디와 같은 구조: 세로 7칸(요일), 가로는 주 단위 칼럼.
  // 실제로 기록된 날에만 칸을 그린다 — 기록 없는 날은 빈칸으로 남긴다(칸을 만들지 않는다).
  const first = new Date(`${rows[0].record_date}T00:00:00Z`);
  const firstSunday = new Date(first);
  firstSunday.setUTCDate(first.getUTCDate() - first.getUTCDay());

  // 요일 라벨(월/수/금)
  WEEKDAY_LABELS.forEach((label, i) => {
    if (!label) return;
    const node = el('span', { className: 'strip-wd' }, label);
    node.style.gridRow = String(i + 1);
    node.style.gridColumn = '1';
    strip.append(node);
  });

  rows.forEach((row) => {
    const level = span === 0
      ? 3
      : Math.min(4, 1 + Math.floor(((row.normalized_value - min) / span) * 3.999));
    const idx = rows.indexOf(row);
    const prev = idx > 0 ? rows[idx - 1] : null;
    const deltaText = prev && prev.unit === row.unit
      ? `${signed(Math.round((row.normalized_value - prev.normalized_value) * 1e6) / 1e6)} ${row.unit}`
      : '기준일';

    const d = new Date(`${row.record_date}T00:00:00Z`);
    const weekday = d.getUTCDay(); // 0=일 ~ 6=토
    const week = Math.floor((d - firstSunday) / (7 * 86400000));

    const cellNode = el('button', {
      type: 'button',
      className: `strip-cell lvl-${level}`,
      title: `${row.record_date} · ${comma(row.normalized_value)} ${row.unit} · ${deltaText}`
    });
    cellNode.style.gridRow = String(weekday + 1);
    cellNode.style.gridColumn = String(week + 2); // 1번 칼럼은 요일 라벨용
    cellNode.setAttribute('aria-label', `${row.record_date} ${comma(row.normalized_value)} ${row.unit}`);
    cellNode.addEventListener('mouseenter', () => highlightRow(row.record_date, true));
    cellNode.addEventListener('mouseleave', () => highlightRow(row.record_date, false));
    cellNode.addEventListener('focus', () => highlightRow(row.record_date, true));
    cellNode.addEventListener('blur', () => highlightRow(row.record_date, false));
    strip.append(cellNode);
  });
}

function highlightRow(date, on) {
  const row = document.querySelector(`tr[data-date="${date}"]`);
  if (row) row.classList.toggle('row-highlight', on);
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
    code: labState.status.error_code
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

  $('timeline').replaceChildren(
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

/* ── 로고: 마우스를 올리면 짧은 커밋 해시처럼 빠르게 굴러가다 REPO에 멈춘다 ── */
function wireWordmark() {
  const roll = $('wm-roll');
  const word = $('wordmark');
  if (!roll || !word) return;

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const hex = '0123456789abcdef';
  const randomHex = (len) =>
    Array.from({ length: len }, () => hex[Math.floor(Math.random() * 16)]).join('');

  let timer = null;
  function rollTo(target, duration) {
    clearTimeout(timer);
    if (reduceMotion) {
      roll.textContent = target;
      return;
    }
    const start = performance.now();
    (function step() {
      const elapsed = performance.now() - start;
      if (elapsed >= duration) {
        roll.textContent = target;
        return;
      }
      roll.textContent = randomHex(6);
      // 처음엔 빠르게 굴리다가 끝에 갈수록 느려져서 '착' 멈추는 느낌을 준다
      const delay = 26 + (elapsed / duration) * 90;
      timer = setTimeout(step, delay);
    })();
  }

  word.addEventListener('mouseenter', () => rollTo('REPO', 480));
  word.addEventListener('mouseleave', () => rollTo('BEFORE', 260));
}

/* ── 시작 ────────────────────────────────────────── */

async function boot() {
  wireWordmark();
  $('refresh-btn')?.addEventListener('click', runRefresh);
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
