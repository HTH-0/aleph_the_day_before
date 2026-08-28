// app.js — 화면 로직
// live 경로와 replay 경로가 모두 core.js 의 applyOutcome 만 통과합니다.

import {
  applyOutcome,
  resetEvaluationState,
  ERROR_PRESENTATION,
  formatNumber,
  formatSigned,
  kstStamp,
  kstDate
} from './core.js';

import { SIGNAL, fetchLiveOutcome } from './live-adapter.js';
import { emptyStore, storeToState, recomputeDelta, reconcileBreakdown } from './store.js';
import {
  FIXTURE_FILES,
  FAILURE_FIXTURES,
  REPLAY_SEQUENCES,
  fixtureToOutcome,
  loadFixtureInBrowser
} from './replay-adapter.js';

const $ = (id) => document.getElementById(id);
const COOLDOWN_MS = 6000;

const app = {
  store: emptyStore(SIGNAL.id),
  liveState: resetEvaluationState(),
  lastSuccess: null, // { raw, reading, observation }
  lastObservation: null,
  replayState: resetEvaluationState(),
  replayLog: [],
  fixtureCache: new Map(),
  cooldownUntil: 0,
  busy: false
};

/* ---------------- 시계 ---------------- */

function tickClock() {
  $('clock').textContent = kstStamp(new Date().toISOString()).replace(' (KST)', '');
}

/* ---------------- 01 지금 값 ---------------- */

function renderNow() {
  $('signal-question').textContent = SIGNAL.question;
  $('signal-title').textContent = SIGNAL.title;
  $('signal-def').textContent = SIGNAL.definition;

  const state = app.liveState;
  const reading = state.current_reading;
  const status = state.status;

  if (!reading) {
    $('value-main').textContent = '—';
    $('value-unit').textContent = '';
    $('target-line').textContent = '아직 성공한 조회가 없습니다. 아래 버튼으로 조회하세요.';
    for (const id of ['fact-value', 'fact-unit', 'fact-source', 'fact-source-time', 'fact-fetched-at']) {
      $(id).textContent = '—';
    }
    $('fact-timezone').textContent = 'Asia/Seoul';
  } else {
    $('value-main').textContent = formatNumber(reading.normalized_value);
    $('value-unit').textContent = reading.unit;

    const targetDate = reading.source_time ? reading.source_time.slice(0, 10) : null;
    $('target-line').innerHTML = targetDate
      ? `대상 구간: <strong>${targetDate} 00:00 ~ 23:59 (KST)</strong> 하루 동안 만들어진 저장소를 셉니다.`
      : '대상 구간 정보가 없습니다.';

    $('fact-value').textContent = formatNumber(reading.normalized_value);
    $('fact-unit').textContent = reading.unit;
    const sourceCell = $('fact-source');
    sourceCell.textContent = '';
    sourceCell.append(reading.source_name, document.createElement('br'));
    const link = document.createElement('a');
    link.setAttribute('href', reading.source_url);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    link.textContent = reading.source_url;
    sourceCell.append(link);
    $('fact-source-time').textContent = kstStamp(reading.source_time) || '—';
    $('fact-fetched-at').textContent = kstStamp(reading.fetched_at) || '—';
    $('fact-timezone').textContent = reading.record_timezone;
  }

  // 전일 대비 배지 — 저장된 값에서 다시 계산
  const cmp = recomputeDelta(state.daily_readings);
  const badge = $('delta-badge');
  badge.className = 'delta';
  if (cmp.state === 'comparable') {
    badge.textContent = `어제 대비 ${formatSigned(cmp.signed)} ${cmp.unit}`;
    if (cmp.signed > 0) badge.classList.add('delta--up');
    else if (cmp.signed < 0) badge.classList.add('delta--down');
  } else {
    badge.textContent = `어제 대비 — (기록 ${state.daily_readings.length}건)`;
  }

  // 정직 스트립
  const freshEl = $('honesty-freshness');
  freshEl.className = 'honesty__value';
  if (!status) {
    freshEl.textContent = '아직 없음';
    freshEl.classList.add('honesty__value--muted');
  } else if (status.freshness === 'fresh') {
    freshEl.textContent = state.last_run ? 'fresh — 방금 확인한 값' : 'fresh — 보존된 마지막 정상값';
    freshEl.classList.add('honesty__value--fresh');
  } else {
    freshEl.textContent = 'stale — 오래된 값';
    freshEl.classList.add('honesty__value--stale');
  }

  const lastGoodEl = $('honesty-lastgood');
  lastGoodEl.className = 'honesty__value';
  if (reading) {
    lastGoodEl.textContent = kstStamp(reading.fetched_at).replace(' (KST)', '');
  } else {
    lastGoodEl.textContent = '—';
    lastGoodEl.classList.add('honesty__value--muted');
  }

  const attemptEl = $('honesty-attempt');
  attemptEl.className = 'honesty__value';
  const run = state.last_run;
  if (!run) {
    attemptEl.textContent = '아직 조회하지 않음';
    attemptEl.classList.add('honesty__value--muted');
  } else if (run.outcome === 'success') {
    attemptEl.textContent = '성공 · none';
    attemptEl.classList.add('honesty__value--fresh');
  } else {
    attemptEl.textContent = `실패 · ${run.error_code}`;
    attemptEl.classList.add('honesty__value--stale');
  }

  // 실패 안내 상자
  const alertBox = $('live-alert');
  if (status && status.freshness === 'stale') {
    const info = ERROR_PRESENTATION[status.error_code];
    $('live-alert-code').textContent = `${info.label} · ${info.code}`;
    $('live-alert-headline').textContent = info.headline;
    let detail = info.detail;
    if (run && run.detail) detail += ` (관측: ${run.detail})`;
    $('live-alert-detail').textContent = detail;
    let next = info.next_action;
    if (run && run.retry_after_seconds) next += ` 출처가 알려 준 대기 시간은 ${run.retry_after_seconds}초입니다.`;
    $('live-alert-next').textContent = next;
    $('btn-retry').textContent = info.retry_label;
    alertBox.hidden = false;
  } else {
    alertBox.hidden = true;
  }

  $('now-status-note').textContent = status ? `${status.freshness} / ${status.error_code}` : '대기';
}

/* ---------------- 02 시간대 분포 ---------------- */

function renderHours() {
  const rows = app.liveState.daily_readings.filter((r) => r.breakdown && Array.isArray(r.breakdown.segments));
  const chart = $('hours-chart');
  const empty = $('hours-empty');
  const reconcile = $('hours-reconcile');
  const tableWrap = $('hours-table-wrap');

  if (!rows.length) {
    chart.innerHTML = '';
    empty.hidden = false;
    reconcile.hidden = true;
    tableWrap.hidden = true;
    $('hours-note').textContent = '0건';
    return;
  }
  empty.hidden = true;

  const latest = rows[rows.length - 1];
  const segments = latest.breakdown.segments;
  const values = segments.filter((seg) => typeof seg.value === 'number').map((seg) => seg.value);
  const max = values.length ? Math.max(...values) : 0;
  const total = values.reduce((a, b) => a + b, 0);
  const peak = segments.find((seg) => seg.value === max && max > 0);

  chart.innerHTML =
    (peak
      ? `<p class="peak-note">${escapeHtml(latest.breakdown.target_date)} 에는 <strong>${escapeHtml(
          peak.label
        )} (KST)</strong> 구간에 가장 많이 생겼습니다.</p>`
      : '') +
    '<div class="bars">' +
    segments
      .map((seg) => {
        const has = typeof seg.value === 'number';
        const width = has && max > 0 ? Math.max(2, Math.round((seg.value / max) * 100)) : 100;
        const share = has && total > 0 ? `${((seg.value / total) * 100).toFixed(1)}%` : '—';
        const fillClass = !has ? 'bar-row__fill--none' : seg.value === max ? 'bar-row__fill--peak' : '';
        return `<div class="bar-row">
          <div class="bar-row__label">${escapeHtml(seg.label)}</div>
          <div class="bar-row__track"><div class="bar-row__fill ${fillClass}" style="width:${width}%"></div></div>
          <div class="bar-row__value${has ? '' : ' bar-row__value--none'}">${
            has ? `${formatNumber(seg.value)} <span class="bar-row__share">${share}</span>` : `실패 · ${escapeHtml(seg.error_code)}`
          }</div>
        </div>`;
      })
      .join('') +
    '</div>' +
    `<p class="bars-caption">구간은 대상 날짜 ${escapeHtml(
      latest.breakdown.target_date
    )} 의 Asia/Seoul 시각으로 나눕니다. 각 구간은 하루 합계와 같은 검색 조건에 시각 범위만 좁힌 별도 조회입니다.</p>`;

  // 합계 대조
  const check = reconcileBreakdown(latest);
  reconcile.hidden = false;
  if (check.state === 'match') {
    $('hours-reconcile-expr').textContent = `${formatNumber(check.sum)} = ${formatNumber(check.total)} ${latest.unit}`;
    $('hours-reconcile-note').textContent =
      '네 구간의 합이 하루 합계와 같습니다. 화면에 쓰는 값은 언제나 하루 전체 조회 한 건이고, 구간은 그 숫자의 구성만 보여 줍니다.';
  } else if (check.state === 'drift') {
    $('hours-reconcile-expr').textContent = `${formatNumber(check.sum)} ≠ ${formatNumber(check.total)} ${
      latest.unit
    } (차이 ${formatSigned(check.diff)})`;
    $('hours-reconcile-note').textContent =
      '구간 합계가 하루 합계와 어긋납니다. 검색 인덱스가 조회 사이에 갱신되면 생길 수 있는 차이입니다. 어느 쪽도 고치지 않고 그대로 보여 줍니다. 저장되는 값은 하루 합계 쪽입니다.';
  } else {
    $('hours-reconcile-expr').textContent = '대조하지 않습니다';
    $('hours-reconcile-note').textContent = `구간 ${
      check.missing ? check.missing.length : 0
    }개를 얻지 못했습니다. 빠진 구간을 추정해 채우지 않습니다.`;
  }

  // 날짜별 표
  if (rows.length > 1) {
    tableWrap.hidden = false;
    $('hours-table-body').innerHTML = rows
      .map((row) => {
        const cells = row.breakdown.segments
          .map((seg) => `<td>${typeof seg.value === 'number' ? formatNumber(seg.value) : '—'}</td>`)
          .join('');
        return `<tr><td>${escapeHtml(row.record_date)}</td><td>${escapeHtml(
          row.breakdown.target_date
        )}</td>${cells}<td>${
          typeof row.breakdown.sum === 'number' ? formatNumber(row.breakdown.sum) : '—'
        }</td></tr>`;
      })
      .join('');
  } else {
    tableWrap.hidden = true;
  }

  $('hours-note').textContent = `${rows.length}일치 · 6시간 구간`;
}

/* ---------------- 03 대조표 ---------------- */

function verdict(ok) {
  return ok
    ? '<span class="verdict verdict--ok">일치</span>'
    : '<span class="verdict verdict--no">불일치</span>';
}

function renderCompare() {
  const body = $('compare-body');
  const success = app.lastSuccess;

  if (!success) {
    body.innerHTML = '<tr><td colspan="5" class="label">아직 성공한 조회가 없습니다.</td></tr>';
    $('compare-note').textContent = '대기';
    return;
  }

  const { raw, reading } = success;
  const row = app.liveState.daily_readings.find(
    (r) => r.signal_id === reading.signal_id && r.record_date === reading.record_date
  );
  if (!row) {
    body.innerHTML = '<tr><td colspan="5" class="label">저장된 행을 찾지 못했습니다.</td></tr>';
    return;
  }

  // 화면값은 DOM 에서 실제로 읽어 옵니다.
  const shownValue = Number(($('fact-value').textContent || '').replace(/[^\d.-]/g, ''));
  const shownUnit = ($('fact-unit').textContent || '').trim();
  const shownSourceLink = $('fact-source').querySelector('a');
  const shownSourceUrl = shownSourceLink ? shownSourceLink.getAttribute('href') : '';
  const shownSourceTime = ($('fact-source-time').textContent || '').trim();
  const shownFetchedAt = ($('fact-fetched-at').textContent || '').trim();
  const shownTz = ($('fact-timezone').textContent || '').trim();

  const rows = [
    {
      label: '값',
      raw: String(raw.total_count),
      stored: String(row.normalized_value),
      shown: String(shownValue),
      ok: raw.total_count === row.normalized_value && row.normalized_value === shownValue
    },
    {
      label: '단위',
      raw: `total_count 의 단위 = ${SIGNAL.unit} (정규화 규칙 상수)`,
      stored: row.unit,
      shown: shownUnit,
      ok: row.unit === SIGNAL.unit && row.unit === shownUnit
    },
    {
      label: '출처 주소',
      raw: success.observation.source_url,
      stored: row.reading.source_url,
      shown: shownSourceUrl,
      ok: success.observation.source_url === row.reading.source_url && row.reading.source_url === shownSourceUrl
    },
    {
      label: '출처 시각',
      raw: `${success.observation.target_date}T23:59:59+09:00`,
      stored: row.reading.source_time,
      shown: shownSourceTime,
      ok:
        `${success.observation.target_date}T23:59:59+09:00` === row.reading.source_time &&
        kstStamp(row.reading.source_time) === shownSourceTime
    },
    {
      label: '조회 시각',
      raw: success.observation.attempted_at,
      stored: row.reading.fetched_at,
      shown: shownFetchedAt,
      ok:
        success.observation.attempted_at === row.reading.fetched_at &&
        kstStamp(row.reading.fetched_at) === shownFetchedAt
    },
    {
      label: '기준 시간대',
      raw: 'Asia/Seoul (record_date 계산 기준)',
      stored: row.reading.record_timezone,
      shown: shownTz,
      ok: row.reading.record_timezone === 'Asia/Seoul' && shownTz === 'Asia/Seoul'
    }
  ];

  body.innerHTML = rows
    .map(
      (r) =>
        `<tr><td class="label">${r.label}</td><td>${escapeHtml(r.raw)}</td><td>${escapeHtml(
          r.stored
        )}</td><td>${escapeHtml(r.shown)}</td><td>${verdict(r.ok)}</td></tr>`
    )
    .join('');

  const allOk = rows.every((r) => r.ok);
  const origin = success.restored ? '보존된 기록' : '방금 조회';
  $('compare-note').textContent = allOk ? `${origin} · ${rows.length}행 전부 일치` : `${origin} · 불일치 있음`;
}

/**
 * 이번 접속에서 아직 성공한 조회가 없어도, 보존된 기록에 함께 남긴 관측 원자료로
 * 대조표를 채웁니다. 값을 만들어 내는 것이 아니라 저장된 조회 한 건을 그대로 다시 펴 보는 것입니다.
 */
function seedCompareFromStore() {
  const rows = app.liveState.daily_readings;
  const row = rows[rows.length - 1];
  if (!row || !row.observation || !row.observation.raw_excerpt) return;
  if (typeof row.observation.raw_excerpt.total_count !== 'number') return;
  app.lastSuccess = {
    raw: row.observation.raw_excerpt,
    reading: row.reading,
    observation: row.observation,
    restored: true
  };
  app.lastObservation = row.observation;
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '—' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------- 04 보존 기록 ---------------- */

function renderHistory() {
  const rows = app.liveState.daily_readings;
  const body = $('history-body');
  const empty = $('history-empty');

  if (!rows.length) {
    body.innerHTML = '';
    empty.hidden = false;
    $('history-note').textContent = '0건';
  } else {
    empty.hidden = true;
    body.innerHTML = rows
      .map(
        (r) => `<tr>
          <td>${escapeHtml(r.record_date)}</td>
          <td>${formatNumber(r.normalized_value)}</td>
          <td>${escapeHtml(r.unit)}</td>
          <td>${escapeHtml(kstStamp(r.reading.source_time) || '—')}</td>
          <td>${escapeHtml(kstStamp(r.first_fetched_at) || '—')}</td>
          <td>${escapeHtml(kstStamp(r.last_fetched_at) || '—')}</td>
          <td>${escapeHtml(r.update_count || 1)}</td>
        </tr>`
      )
      .join('');
    $('history-note').textContent = `${rows.length}건 · 서로 다른 KST 날짜`;
  }

  const cmp = recomputeDelta(rows);
  if (cmp.state === 'comparable') {
    $('recalc-expr').textContent = `${formatNumber(cmp.current.normalized_value)} − ${formatNumber(
      cmp.previous.normalized_value
    )} = ${formatSigned(cmp.signed)} ${cmp.unit}`;
    $('recalc-note').textContent = `${cmp.previous.record_date} 기록과 ${cmp.current.record_date} 기록을 조회 날짜순으로 놓고 뺐습니다. 저장 시점에 계산해 둔 값이 아니라 화면을 그릴 때마다 다시 계산합니다.`;
  } else {
    $('recalc-expr').textContent = '아직 계산하지 않습니다';
    $('recalc-note').textContent = cmp.reason;
  }
}

/* ---------------- 실제 조회 ---------------- */

function setBusy(busy) {
  app.busy = busy;
  $('btn-fetch').disabled = busy;
  $('btn-retry').disabled = busy;
  if (busy) $('btn-fetch').textContent = '조회하는 중…';
  else $('btn-fetch').textContent = '지금 다시 조회';
}

function startCooldown() {
  app.cooldownUntil = Date.now() + COOLDOWN_MS;
  const timer = setInterval(() => {
    const left = Math.ceil((app.cooldownUntil - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(timer);
      $('btn-fetch').disabled = false;
      $('btn-retry').disabled = false;
      renderQuota();
      return;
    }
    $('btn-fetch').disabled = true;
    $('btn-retry').disabled = true;
    $('quota').textContent = `연타를 막기 위해 ${left}초 뒤에 다시 조회할 수 있습니다`;
  }, 250);
}

function renderQuota() {
  const obs = app.lastObservation;
  if (obs && obs.rate_limit_remaining !== null && obs.rate_limit_remaining !== undefined) {
    $('quota').textContent = `출처가 알려 준 남은 호출 수: ${obs.rate_limit_remaining} (인증 없이 분당 10회)`;
  } else {
    $('quota').textContent = '출처 호출 제한: 인증 없이 분당 10회';
  }
}

async function runLiveFetch() {
  if (app.busy || Date.now() < app.cooldownUntil) return;
  setBusy(true);
  try {
    const outcome = await fetchLiveOutcome();
    app.lastObservation = outcome.meta.observation;
    app.liveState = applyOutcome(app.liveState, outcome);
    if (outcome.kind === 'success' && app.liveState.status.error_code === 'none') {
      app.lastSuccess = {
        raw: outcome.raw,
        reading: outcome.reading,
        observation: outcome.meta.observation
      };
    }
    renderNow();
    renderHours();
    renderCompare();
    renderHistory();
    renderQuota();
  } finally {
    setBusy(false);
    startCooldown();
  }
}

/* ---------------- 05 장애 재생 ---------------- */

async function getFixture(fixtureId) {
  if (app.fixtureCache.has(fixtureId)) return app.fixtureCache.get(fixtureId);
  const fixture = await loadFixtureInBrowser(fixtureId);
  app.fixtureCache.set(fixtureId, fixture);
  return fixture;
}

function buildChips() {
  const normal = ['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-NORMAL-D2'];
  const recover = ['T04-RECOVER-D2'];

  $('chips-normal').innerHTML = normal
    .map((id) => `<button class="chip" type="button" data-fixture="${id}">${id.replace('T04-', '')}</button>`)
    .join('');

  $('chips-failure').innerHTML = FAILURE_FIXTURES.map((id) => {
    const code = fixtureErrorCode(id);
    return `<button class="chip chip--danger" type="button" data-fixture="${id}">${ERROR_PRESENTATION[code].label}</button>`;
  }).join('');

  $('chips-recover').innerHTML =
    recover
      .map((id) => `<button class="chip chip--recover" type="button" data-fixture="${id}">회복 · ${id.replace('T04-', '')}</button>`)
      .join('') + '<button class="chip" type="button" data-reset="1">합성 상태 초기화</button>';

  document.querySelectorAll('[data-fixture]').forEach((el) => {
    el.addEventListener('click', () => playFixture(el.dataset.fixture));
  });
  document.querySelectorAll('[data-reset]').forEach((el) => {
    el.addEventListener('click', () => {
      app.replayState = resetEvaluationState();
      app.replayLog = [];
      renderReplay();
    });
  });
}

function fixtureErrorCode(fixtureId) {
  return {
    'T04-TIMEOUT': 'timeout',
    'T04-AUTH-401': 'auth',
    'T04-RATE-429': 'rate_limit',
    'T04-OFFLINE': 'offline',
    'T04-SCHEMA-BREAK': 'schema_error'
  }[fixtureId];
}

async function playFixture(fixtureId) {
  let fixture;
  try {
    fixture = await getFixture(fixtureId);
  } catch (error) {
    app.replayLog.unshift({ text: `fixture 를 읽지 못했습니다: ${error.message}`, kind: 'err' });
    renderReplay();
    return;
  }
  const outcome = fixtureToOutcome(fixture);
  app.replayState = applyOutcome(app.replayState, outcome);
  const status = app.replayState.status;
  app.replayLog.unshift({
    seq: app.replayState.sequence,
    text: `${fixtureId} → ${status.freshness} / ${status.error_code} · 행 ${app.replayState.daily_readings.length}건`,
    kind: status.error_code === 'none' ? 'ok' : 'err'
  });
  renderReplay();
}

function renderReplay() {
  const state = app.replayState;
  const status = state.status;

  $('replay-freshness').textContent = status ? status.freshness : '—';
  $('replay-error').textContent = status ? status.error_code : '—';
  $('replay-rows').textContent = String(state.daily_readings.length);
  $('replay-lastgood').textContent = state.current_reading
    ? `${state.current_reading.normalized_value} ${state.current_reading.unit}${
        status && status.freshness === 'stale' ? ' · 오래된 값' : ''
      }`
    : '—';

  const alertBox = $('replay-alert');
  if (status && status.freshness === 'stale') {
    const info = ERROR_PRESENTATION[status.error_code];
    $('replay-alert-code').textContent = `${info.label} · ${info.code}`;
    $('replay-alert-headline').textContent = info.headline;
    $('replay-alert-detail').textContent = info.detail;
    let next = info.next_action;
    if (state.last_run && state.last_run.retry_after_seconds) {
      next += ` 출처가 알려 준 대기 시간은 ${state.last_run.retry_after_seconds}초입니다.`;
    }
    $('replay-alert-next').textContent = next;
    $('btn-replay-retry').textContent = `${info.retry_label} (T04-RECOVER-D2 재생)`;
    alertBox.hidden = false;
  } else {
    alertBox.hidden = true;
  }

  const body = $('replay-rows-body');
  if (!state.daily_readings.length) {
    body.innerHTML = '<tr><td colspan="4" class="label">아직 재생하지 않았습니다.</td></tr>';
  } else {
    body.innerHTML = state.daily_readings
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.record_date)}</td><td>${formatNumber(r.normalized_value)}</td><td>${escapeHtml(
            r.unit
          )}</td><td>${escapeHtml(r.update_count || 1)}</td></tr>`
      )
      .join('');
  }

  $('replay-log').innerHTML = app.replayLog
    .slice(0, 30)
    .map(
      (entry) =>
        `<div class="log__row"><span class="log__seq">${escapeHtml(entry.seq ?? '·')}</span><span class="log__${
          entry.kind
        }">${escapeHtml(entry.text)}</span></div>`
    )
    .join('');
}

/* ---------------- 06 자가검증 ---------------- */

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function checkRow(name, ok, detail) {
  return `<div class="check">
    <span class="verdict verdict--${ok === null ? 'na' : ok ? 'ok' : 'no'}">${
      ok === null ? '확인 불가' : ok ? '통과' : '실패'
    }</span>
    <span class="check__name">${escapeHtml(name)}</span>
    <span class="check__detail">${escapeHtml(detail)}</span>
  </div>`;
}

async function runSelfcheck() {
  const list = $('selfcheck-list');
  list.innerHTML = checkRow('실행 중…', null, '');
  const results = [];

  // 1) 공개 꾸러미 파일 해시
  try {
    const manifest = await (await fetch('vendor/aleph-t04/asset-manifest.json', { cache: 'no-store' })).json();
    let matched = 0;
    let mismatched = [];
    if (!crypto || !crypto.subtle) {
      results.push({ name: '공개 꾸러미 파일 해시 대조', ok: null, detail: '이 브라우저에서 SHA-256 을 쓸 수 없습니다' });
    } else {
      for (const file of manifest.files) {
        const response = await fetch(`vendor/aleph-t04/${file.path}`, { cache: 'no-store' });
        const buffer = await response.arrayBuffer();
        const hex = await sha256Hex(buffer);
        if (hex === file.sha256) matched += 1;
        else mismatched.push(file.path);
      }
      results.push({
        name: `공개 꾸러미 파일 해시 대조 · ${manifest.package_id}`,
        ok: mismatched.length === 0,
        detail: mismatched.length === 0 ? `${matched}/${manifest.files.length} 일치` : `불일치: ${mismatched.join(', ')}`
      });
    }
  } catch (error) {
    results.push({ name: '공개 꾸러미 파일 해시 대조', ok: false, detail: error.message });
  }

  // 2) 재생 순서 7가지
  for (const sequence of REPLAY_SEQUENCES) {
    try {
      let state = resetEvaluationState();
      let lastFixture = null;
      for (const fixtureId of sequence.steps) {
        const fixture = await getFixture(fixtureId);
        lastFixture = fixture;
        state = applyOutcome(state, fixtureToOutcome(fixture));
      }
      const expected = lastFixture.expected;
      const storedValue = state.current_reading ? state.current_reading.normalized_value : null;
      const checks = [
        ['freshness', state.status.freshness, expected.freshness],
        ['error_code', state.status.error_code, expected.error_code],
        ['row_count', state.daily_readings.length, expected.row_count],
        ['stored_value', storedValue, expected.stored_value],
        ['delta', state.last_delta ?? null, expected.delta ?? null]
      ];
      const failed = checks.filter(([, actual, want]) => actual !== want);
      results.push({
        name: `재생 순서 · ${sequence.title}`,
        ok: failed.length === 0,
        detail:
          failed.length === 0
            ? `${expected.freshness}/${expected.error_code} · 행 ${expected.row_count} · 값 ${expected.stored_value}`
            : failed.map(([key, actual, want]) => `${key}: ${actual}≠${want}`).join(', ')
      });
    } catch (error) {
      results.push({ name: `재생 순서 · ${sequence.title}`, ok: false, detail: error.message });
    }
  }

  // 3) 같은 KST 날짜 재실행이 행을 늘리지 않는지
  try {
    let state = resetEvaluationState();
    const a = await getFixture('T04-NORMAL-D1-A');
    const b = await getFixture('T04-NORMAL-D1-B');
    state = applyOutcome(state, fixtureToOutcome(a));
    const firstId = state.daily_readings[0].record_id;
    state = applyOutcome(state, fixtureToOutcome(b));
    state = applyOutcome(state, fixtureToOutcome(b));
    const sameId = state.daily_readings[0].record_id === firstId;
    results.push({
      name: '같은 KST 날짜 3회 성공 → 행 1건 유지',
      ok: state.daily_readings.length === 1 && sameId,
      detail: `행 ${state.daily_readings.length}건 · 갱신 ${state.daily_readings[0].update_count}회 · record_id 동일 ${sameId}`
    });
  } catch (error) {
    results.push({ name: '같은 KST 날짜 3회 성공 → 행 1건 유지', ok: false, detail: error.message });
  }

  // 4) 브라우저 저장소 미사용
  let storageUsed = false;
  try {
    storageUsed = (window.localStorage && window.localStorage.length > 0) || document.cookie.length > 0;
  } catch {
    storageUsed = false;
  }
  results.push({
    name: '브라우저 저장소 · 쿠키 미사용',
    ok: !storageUsed,
    detail: storageUsed ? '저장된 항목이 있습니다' : 'localStorage 0건 · 쿠키 0건'
  });

  list.innerHTML = results.map((r) => checkRow(r.name, r.ok, r.detail)).join('');
  const passed = results.filter((r) => r.ok === true).length;
  $('selfcheck-note').textContent = `${passed}/${results.length} 통과`;
}

/* ---------------- 시작 ---------------- */

async function boot() {
  tickClock();
  setInterval(tickClock, 1000);

  $('tz-chip').textContent = `기준 시간대 Asia/Seoul`;

  try {
    const response = await fetch('data/daily.json', { cache: 'no-store' });
    if (response.ok) {
      const store = await response.json();
      if (store && Array.isArray(store.daily_readings)) {
        app.store = store;
        app.liveState = storeToState(store);
        seedCompareFromStore();
      }
    }
  } catch {
    /* 보존 기록을 읽지 못해도 화면은 뜹니다. */
  }

  renderNow();
  renderHours();
  renderHistory();
  renderCompare();
  buildChips();
  renderReplay();

  $('btn-fetch').addEventListener('click', runLiveFetch);
  $('btn-retry').addEventListener('click', runLiveFetch);
  $('btn-selfcheck').addEventListener('click', runSelfcheck);
  $('btn-replay-retry').addEventListener('click', () => playFixture('T04-RECOVER-D2'));

  $('footer-line').textContent = `공개 심사용 정보판 · 기준 시간대 Asia/Seoul · 오늘(KST) ${kstDate(
    new Date().toISOString()
  )}`;

  await runLiveFetch();
}

boot();
