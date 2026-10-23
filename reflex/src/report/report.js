/**
 * report.js — generates a self-contained report folder: index.html + copied artifacts.
 * Each row's screenshots and recordings are copied into assets/<rowId>/ so the folder
 * can be zipped and uploaded to any static host.
 */
const fs = require('fs');
const path = require('path');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(ms) {
  if (ms == null) return '—';
  const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes} phút ${seconds} giây`;
  return `${seconds} giây`;
}

function copyArtifacts(artifacts, rowDir) {
  fs.mkdirSync(rowDir, { recursive: true });
  const out = [];
  for (const src of (artifacts || [])) {
    if (!src || !fs.existsSync(src)) continue;
    const dest = path.join(rowDir, path.basename(src));
    fs.copyFileSync(src, dest);
    out.push(dest);
  }
  return out;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function collectArtifacts(item) {
  const artifacts = [...(item.artifacts || [])];
  for (const step of (item.steps || [])) {
    if (step.screenshot) artifacts.push(step.screenshot);
    if (step.artifact) artifacts.push(step.artifact);
    if (Array.isArray(step.artifacts)) artifacts.push(...step.artifacts);
  }
  return unique(artifacts);
}

function copyArtifactsWithMap(artifacts, rowDir, reportDir) {
  fs.mkdirSync(rowDir, { recursive: true });
  const relBySource = {};
  const rels = [];
  for (const raw of unique(artifacts)) {
    const candidates = path.isAbsolute(raw) ? [raw] : [path.join(reportDir, raw), raw];
    const src = candidates.find((p) => fs.existsSync(p));
    if (!src) continue;
    const dest = path.join(rowDir, path.basename(src));
    const sameFile = path.resolve(src) === path.resolve(dest);
    if (!sameFile) fs.copyFileSync(src, dest);
    const rel = path.relative(reportDir, dest).replace(/\\/g, '/');
    rels.push(rel);
    relBySource[raw] = rel;
    relBySource[path.resolve(src)] = rel;
  }
  return { rels: unique(rels), relBySource };
}

function artifactRel(raw, relBySource, reportDir) {
  if (!raw) return '';
  if (relBySource[raw]) return relBySource[raw];
  if (path.isAbsolute(raw) && relBySource[path.resolve(raw)]) return relBySource[path.resolve(raw)];
  const candidate = path.join(reportDir, raw);
  if (!path.isAbsolute(raw) && fs.existsSync(candidate)) return raw.replace(/\\/g, '/');
  return raw;
}

function renderScreenshot(shots) {
  if (!shots.length) return '<div class="no-shot"><span style="font-size:24px">📷</span>No screenshot</div>';
  return shots.map((s) => `
    <a class="shot-link" href="${esc(s)}" onclick="openLightbox(this);return false;" title="Click to enlarge">
      <img class="shot-img" src="${esc(s)}" alt="screenshot" loading="lazy"/>
      <span class="shot-zoom-icon">⤢</span>
    </a>`).join('');
}

function renderVideo(videos) {
  if (!videos.length) return '';
  return `<div class="col-video"><div class="video-section">
    <div class="section-label">Recording</div>
    ${videos.map((v) => `
    <div class="video-wrap">
      <div class="video-header">
        <span class="video-rec-dot"></span>${esc(path.basename(v))}
      </div>
      <video controls preload="metadata" class="video-player" playsinline>
        <source src="${esc(v)}" type="video/mp4"/>
      </video>
    </div>`).join('')}
  </div></div>`;
}

function isUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function renderData(data) {
  if (!data || !Object.keys(data).length) return '<span class="muted">—</span>';
  const secretKey = /(?:password|passcode|pin|otp|token|authorization|secret)/i;
  return `<table class="data-table"><tbody>${
    Object.entries(data).map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td>${esc(secretKey.test(k) ? '••••••' : v)}</td></tr>`
    ).join('')
  }</tbody></table>`;
}

function authLabel(auth) {
  const status = typeof auth === 'string' ? auth : auth && (auth.status || auth.state);
  if (status === 'authenticated') return 'Authenticated';
  if (status === 'unauthenticated') return 'Unauthenticated';
  if (status === 'not_required') return 'Not required';
  if (status === 'required') return 'Required';
  return status ? String(status) : 'Unknown';
}

function renderCaseContext(item) {
  if (!item.auth) return '';
  const rows = [
    ['Status', authLabel(item.auth)],
    ['Phone', item.auth.phone],
    ['Password', item.auth.password],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
  return `<div class="context-box">
    ${rows.map(([label, value]) => `<div><span>Auth ${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}
  </div>`;
}

function failureSummary(error) {
  if (!error) return 'Case thất bại nhưng runner không trả về lý do cụ thể. Cần xem step fail và evidence đi kèm.';
  return `Case thất bại do: ${error}`;
}

function targetBusinessLabel(target = '') {
  const quoted = String(target).match(/(?:text|content-desc)=["']([^"']+)["']/i)?.[1]
    || String(target).match(/contains\(@(?:text|content-desc),["']([^"']+)["']\)/i)?.[1]
    || String(target).match(/\[([^\]]{3,80})\]/)?.[1];
  return quoted ? `Tương tác với “${quoted.replace(/\|text$/, '')}”` : 'Thao tác với thành phần của luồng';
}

function businessStepTitle(step, data = {}) {
  if (step.title || step.name) return step.title || step.name;
  const tool = String(step.tool || '');
  const args = step.args || {};
  const target = args.target || step.target || step.result?.target || step.result?.selector || '';
  if (target) {
    const label = targetBusinessLabel(target);
    if (tool === 'tap_if_present') {
      return /xuất hiện$/i.test(label) ? label : `${label} nếu xuất hiện`;
    }
    return label;
  }
  return tool ? `Thực hiện thao tác “${tool}”` : 'Thực hiện thao tác đã cấu hình';
}

function normalizeStep(step, index) {
  const status = step.status || (step.ok === false || step.error ? 'fail' : 'pass');
  const title = businessStepTitle(step, step._data);
  return { ...step, status, title };
}

function renderStepSummary(step) {
  const parts = [];
  if (step.result && step.result.found === true) parts.push('Đã hiển thị và sẵn sàng');
  if (step.result && step.result.dismissed === true) parts.push('Đã đóng');
  if (step.result && step.result.tapped === false) parts.push('Không cần xử lý');
  if (step.tool === 'pay_with_pin' && step.result?.timings) {
    const timing = step.result.timings;
    const seconds = (value) => `${(Math.max(0, Number(value) || 0) / 1000).toFixed(1).replace(/\.0$/, '')}s`;
    parts.push([
      `PIN ${seconds(timing.pin_entry_ms)}`,
      `OTP ${seconds(timing.otp_probe_ms)}${step.result.otp?.handled ? ` + nhập ${seconds(timing.otp_handling_ms)}` : ' (không hiển thị)'}`,
      `KQGD ${seconds(timing.result_wait_ms)}`,
      `settle ${seconds(timing.post_success_settle_ms)}`,
      `HOME ${seconds(timing.home_return_verify_ms)}`,
    ].join(' · '));
  }
  if (step.error) parts.push(step.error);
  return parts.length ? parts.join(' · ') : (step.summary || '');
}

function renderSteps(steps) {
  const normalized = (steps || []).map(normalizeStep);
  if (!normalized.length) return '<div class="muted">No step details were recorded for this flow.</div>';
  return `<ol class="step-list">${
    normalized.map((step, idx) => {
      const isPass = step.status === 'pass';
      const isSkipped = step.status === 'skipped';
      const status = isPass ? 'pass' : isSkipped ? 'skipped' : 'fail';
      const shot = step._screenshot || '';
      return `<li class="step step-${status}">
        <div class="step-main">
          <span class="step-index">${idx + 1}</span>
          <div class="step-copy">
            <div class="step-title">${esc(step.title)}</div>
            ${renderStepSummary(step) ? `<div class="step-summary">${esc(renderStepSummary(step))}</div>` : ''}
          </div>
          <span class="step-duration">${fmt(step.duration_ms)}</span>
          <span class="badge badge-${status}">${isPass ? 'PASS' : isSkipped ? 'SKIPPED' : 'FAIL'}</span>
        </div>
        ${shot ? `<div class="step-shot">${renderScreenshot([shot])}</div>` : ''}
      </li>`;
    }).join('')
  }</ol>`;
}

function renderNarrativeSteps(steps) {
  if (!steps || !steps.length) return '';
  return `<details class="narrative-wrap"><summary class="section-label">Tham chiếu flow definition</summary><ol class="narrative-list">${
    steps.map((step) => `<li>${esc(typeof step === 'string' ? step : step.text || step.title || String(step))}</li>`).join('')
  }</ol></details>`;
}

function infoValue(summary, keys) {
  for (const key of keys) {
    const value = key.split('.').reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined), summary);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function formatGmt7Time(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const local = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const z = (n) => String(n).padStart(2, '0');
  return [
    local.getUTCFullYear(),
    z(local.getUTCMonth() + 1),
    z(local.getUTCDate()),
  ].join('-') + ' ' + [
    z(local.getUTCHours()),
    z(local.getUTCMinutes()),
    z(local.getUTCSeconds()),
  ].join(':') + ' (GMT+7)';
}

function computedEndTime(summary) {
  const explicit = infoValue(summary, ['ended_at', 'endedAt', 'end_at', 'endAt']);
  if (explicit) return explicit;
  const started = infoValue(summary, ['started_at', 'startedAt']);
  if (!started || summary.duration_ms == null) return null;
  const startedDate = new Date(started);
  if (Number.isNaN(startedDate.getTime())) return null;
  return new Date(startedDate.getTime() + Number(summary.duration_ms));
}

function normalizeBuildMeta(value) {
  const raw = typeof value === 'string' ? { input: value } : (value && typeof value === 'object' ? value : {});
  const store = raw.store && typeof raw.store === 'object' ? raw.store : {};
  const input = raw.input || raw.requestedBuild || raw.requested_build || raw.store_url || store.store_url || null;
  const name = raw.name || raw.app || raw.fileName || raw.file_name || store.fileName || store.file_name ||
    (input && !isUrl(input) ? input : null);
  return {
    name: name || null,
    version: raw.appVersion || raw.version || raw.app_version || store.version || null,
    buildNumber: raw.buildNumber || raw.build_number || store.buildNumber || store.build_number || null,
    versionCode: raw.versionCode || raw.version_code || store.versionCode || store.version_code || null,
    commit: raw.commit || store.commit || null,
    url: raw.url || raw.buildUrl || raw.build_url || raw.downloadUrl || raw.download_url || raw.store_url || store.store_url || (isUrl(input) ? input : null),
  };
}

function mergeBuildMeta(preferred, fallback) {
  const first = normalizeBuildMeta(preferred);
  const second = normalizeBuildMeta(fallback);
  return Object.fromEntries(Object.keys(first).map((key) => [key, first[key] || second[key] || null]));
}

function buildFromInstallSteps(rows, toolNames, fallback) {
  for (const row of rows || []) {
    const step = (row.steps || []).find((candidate) => toolNames.includes(candidate.tool));
    if (!step) continue;
    const result = step.result && typeof step.result === 'object' ? step.result : {};
    return mergeBuildMeta({ ...result, ...(result.store || {}) }, fallback || row.data || {});
  }
  return normalizeBuildMeta(fallback);
}

function buildInfo(summary, rows = []) {
  const build = summary.build && typeof summary.build === 'object' ? summary.build : {};
  const checklistInput = build.checklist || build.checklistBuild || build.checklist_build || null;
  const oldInput = build.old || build.oldBuild || build.old_build || null;
  return {
    checklist: buildFromInstallSteps(rows, ['install_checklist_build', 'upgrade_checklist_build'], checklistInput),
    old: buildFromInstallSteps(rows, ['install_old_build'], oldInput),
    generic: normalizeBuildMeta({ ...build, input: summary.app || build.input || null }),
  };
}

function buildDetail(build) {
  return [
    build.version && `Version ${build.version}`,
    build.buildNumber && `Build #${build.buildNumber}`,
    build.versionCode && `VersionCode ${build.versionCode}`,
    build.commit && `Commit ${build.commit}`,
  ].filter(Boolean).join(' · ');
}

function renderInfoRows(rows) {
  const filtered = rows.filter((row) => row.value !== undefined && row.value !== null && row.value !== '');
  if (!filtered.length) return '';
  return `<div class="session-info">${filtered.map((row) =>
    `<div><span>${esc(row.label)}</span><strong>${row.html || esc(row.value)}</strong>${row.detail ? `<em>${esc(row.detail)}</em>` : ''}</div>`
  ).join('')}</div>`;
}

function renderSessionInfo(summary, rows) {
  const builds = buildInfo(summary, rows);
  const hasChecklist = !!(builds.checklist.name || builds.checklist.url);
  const hasOld = !!(builds.old.name || builds.old.url);
  const buildRows = hasChecklist || hasOld ? [
    ...(hasChecklist ? [{ label: 'Build checklist', value: builds.checklist.name || builds.checklist.url, detail: buildDetail(builds.checklist) }] : []),
    ...(hasOld ? [{ label: 'Build cũ', value: builds.old.name || builds.old.url, detail: buildDetail(builds.old) }] : []),
  ] : [
    { label: 'Build', value: builds.generic.name || builds.generic.url, detail: buildDetail(builds.generic) },
  ];
  return renderInfoRows([
    { label: 'Device', value: infoValue(summary, ['device.name', 'device.model', 'device.udid', 'udid']) },
    ...buildRows,
    { label: 'Platform', value: infoValue(summary, ['platform']) },
    { label: 'OS version', value: infoValue(summary, ['device.osLabel', 'device.osVersion', 'osVersion', 'platformVersion']) },
    { label: 'Started', value: formatGmt7Time(infoValue(summary, ['started_at', 'startedAt'])) },
    { label: 'End', value: formatGmt7Time(computedEndTime(summary)) },
  ]);
}

function renderRunSummary(summary, rows) {
  if (summary.reportSummary || summary.report_summary) {
    return `<section class="run-summary"><div class="section-label">Summary</div><p>${esc(summary.reportSummary || summary.report_summary)}</p></section>`;
  }
  const failedRows = rows.filter((row) => row.status === 'fail');
  const skippedRows = rows.filter((row) => row.status === 'skipped');
  const flakyRows = rows.filter((row) => row.flaky);
  const text = failedRows.length
    ? `Luồng test có ${failedRows.length}/${rows.length} scenario fail. Cần ưu tiên kiểm tra: ${failedRows.map((row) => row.title || row.flow || row._rowId).join(', ')}.`
    : `Luồng test hoàn tất ${rows.length} scenario: ${rows.length - skippedRows.length} scenario pass${skippedRows.length ? `, ${skippedRows.length} scenario skipped` : ''}.${flakyRows.length ? ` Có ${flakyRows.length} scenario flaky cần theo dõi thêm.` : ' Chưa ghi nhận điểm bất thường nổi bật.'}`;
  return `<section class="run-summary"><div class="section-label">Summary</div><p>${esc(text)}</p></section>`;
}

/** Render only lifecycle records produced by the journey runner itself. */
function renderLifecycle(summary) {
  const gates = Array.isArray(summary.lifecycle) ? summary.lifecycle : [];
  if (!gates.length) return '';
  return `<section class="lifecycle"><div class="section-label">Build lifecycle</div>${gates.map((gate) => {
    const status = String(gate.status || 'fail').toLowerCase() === 'pass' ? 'pass' : 'fail';
    const detail = [gate.detail, gate.fromBuild && `Từ: ${gate.fromBuild}`, gate.toBuild && `Đến: ${gate.toBuild}`]
      .filter(Boolean).join(' · ');
    return `<div class="lifecycle-gate lifecycle-${status}">
      <span class="lifecycle-icon">${status === 'pass' ? '✓' : '✗'}</span>
      <div><strong>${esc(gate.title || 'Lifecycle gate')}</strong>${detail ? `<p>${esc(detail)}</p>` : ''}</div>
      ${gate.duration_ms != null ? `<span class="dur-tag">${fmt(gate.duration_ms)}</span>` : ''}
      <span class="badge badge-${status}">${status === 'pass' ? 'PASS' : 'FAIL'}</span>
    </div>`;
  }).join('')}</section>`;
}

function domId(value, fallback) {
  return String(value || fallback || 'item').replace(/[^A-Za-z0-9_-]+/g, '-');
}

/** The four statuses a scenario can render as: `blocked` (environment) is not a plain failure. */
function rowStatusOf(row) {
  if (row.status === 'blocked') return 'blocked';
  if (row.status === 'skipped') return 'skipped';
  return row.status === 'pass' ? 'pass' : 'fail';
}

/** "Knowledge changes": what the run added to `screens/` (and how it moved); hidden when empty. */
function renderKnowledge(events) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return '';
  const line = (event) => `<tr><td>${esc(event.action || '')}</td><td class="k-file">${esc(event.file || '')}</td><td>${esc(event.key || '')}</td></tr>`;
  return `<section class="knowledge">
    <div class="section-label">Knowledge changes</div>
    <table class="knowledge-table">
      <thead><tr><th>Action</th><th>File</th><th>Key</th></tr></thead>
      <tbody>${list.map(line).join('')}</tbody>
    </table>
  </section>`;
}

/**
 * @param {object} opts { title, kind, summary, items, reportDir, knowledge }
 *   items: [{ id, title, status, error, duration_ms, data, artifacts, steps }]
 *   knowledge: [{ action, file, key }] — what the run changed in screens/*.yml (empty → hidden)
 * @returns {string} path to index.html
 */
function writeReport({ title, kind, summary, items, reportDir, knowledge = [] }) {
  fs.mkdirSync(reportDir, { recursive: true });

  const rows = (items || []).map((it, idx) => {
    const rowId = it.id || `row_${String(idx + 1).padStart(2, '0')}`;
    const rowDir = path.join(reportDir, 'assets', rowId);
    const copied = copyArtifactsWithMap(collectArtifacts(it), rowDir, reportDir);
    const steps = (it.steps || []).map((step) => ({
      ...step,
      _data: it.data || {},
      _flowName: it.flow || '',
      _screenshot: artifactRel(step.screenshot, copied.relBySource, reportDir),
    }));
    // A scenario timer covers the complete orchestration envelope (preflight,
    // recipe steps, cleanup and recovery). Keep the measured step total next
    // to it so rounded per-step labels cannot look as though they were omitted
    // from the scenario duration.
    const stepDurationMs = steps.reduce((sum, step) => sum + Math.max(0, Number(step.duration_ms) || 0), 0);
    const scenarioDurationMs = Math.max(0, Number(it.duration_ms) || 0);
    return {
      ...it,
      steps,
      _rowId: rowId,
      _arts: copied.rels,
      _stepDurationMs: stepDurationMs,
      _overheadDurationMs: Math.max(0, scenarioDurationMs - stepDurationMs),
    };
  });

  // One rendered card is one test scenario. Composite journeys are expanded
  // into their subflows before reaching here, so never reuse the wrapper row's
  // spec total (which would misleadingly be 1).
  const passed = rows.filter((r) => r.status === 'pass').length;
  const skipped = rows.filter((r) => r.status === 'skipped').length;
  // A blocked scenario is an environment problem, not a broken test: it gets its own tile.
  const blocked = rows.filter((r) => r.status === 'blocked').length;
  const failed = rows.filter((r) => r.status !== 'pass' && r.status !== 'skipped' && r.status !== 'blocked').length;
  const total = rows.length;
  const executableTotal = passed + failed + blocked;
  const passRate = executableTotal > 0 ? Math.round((passed / executableTotal) * 100) : 0;
  const totalDur = summary.duration_ms ?? rows.reduce((s, r) => s + (r.duration_ms || 0), 0);
  // The donut visualizes the distribution of every scenario, including a
  // deliberately skipped one. Pass Rate remains the executable-only metric.
  const chartPassRate = total > 0 ? Math.round((passed / total) * 100) : 0;
  const chartFailRate = total > 0 ? Math.round((failed / total) * 100) : 0;
  const chartBlockedRate = total > 0 ? Math.round((blocked / total) * 100) : 0;
  const chartSkipRate = total > 0 ? Math.round((skipped / total) * 100) : 0;
  const chartPassDeg = total > 0 ? (passed / total) * 360 : 0;
  const chartFailDeg = total > 0 ? chartPassDeg + (failed / total) * 360 : 0;
  const chartBlockedDeg = total > 0 ? chartFailDeg + (blocked / total) * 360 : 0;
  const genTime = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const brand = reportBrand();

  const workflowNav = rows.map((it, index) => {
    const status = rowStatusOf(it);
    const id = domId(it._rowId, `workflow-${index + 1}`);
    return `<a class="workflow-link workflow-${status}" href="#${esc(id)}">
      <span class="workflow-index">${index + 1}</span>
      <span class="workflow-name">${esc(it.menuTitle || it.title || it.flow || it.name || it._rowId)}</span>
      <span class="workflow-dot"></span>
    </a>`;
  }).join('');

  const cards = rows.map((it, index) => {
    const status = rowStatusOf(it);
    const isPass = status === 'pass';
    const isSkipped = status === 'skipped';
    const isBlocked = status === 'blocked';
    const badge = isPass ? '✓ PASS' : isSkipped ? '⊘ SKIPPED' : isBlocked ? '⚠ BLOCKED' : '✗ FAIL';
    const videos = it._arts.filter((a) => /\.(mp4|webm|mov)$/i.test(a));
    const videoHtml = renderVideo(videos);
    const cardId = domId(it._rowId, `workflow-${index + 1}`);
    return `
  <details id="${esc(cardId)}" class="card card-${status}" ${isPass ? '' : 'open'}>
    <summary class="card-head">
      <div class="head-left">
        <span class="row-id">${esc(it.displayId || it._rowId)}</span>
        <span class="flow-title">${esc(it.title || it.flow || it.name || it._rowId)}</span>
        <span class="badge badge-${status}">${badge}</span>
        ${it.flaky ? '<span class="badge badge-flaky">⚠ FLAKY</span>' : ''}
      </div>
      ${it.duration_ms != null ? `<span class="dur-tag">${fmt(it.duration_ms)}</span>` : ''}
      <span class="disclosure" aria-hidden="true"></span>
    </summary>

    <div class="card-body">
      <div class="col-right">
        <div class="col-info">
          ${isSkipped ? `
          <div class="status-box skipped">
            <div class="status-icon">⊘</div>
            <div class="status-body"><div class="status-title">Scenario được bỏ qua có chủ đích</div><div class="err-msg">${esc(it.skippedReason || it.error || 'Known issue')}</div></div>
          </div>` : isBlocked ? `
          <div class="status-box blocked">
            <div class="status-icon">⚠</div>
            <div class="status-body">
              <div class="status-title">Scenario bị chặn bởi môi trường (blocked)</div>
              <div class="err-msg">${esc(it.error || 'Môi trường/dữ liệu không cho phép chạy tiếp (bảo trì, hết hàng, thiếu dữ liệu test).')}</div>
            </div>
          </div>` : it.error ? `
          <div class="status-box fail">
            <div class="status-icon">✗</div>
            <div class="status-body">
              <div class="status-title">Scenario thất bại</div>
              <div class="err-msg">${esc(failureSummary(it.error))}</div>
            </div>
          </div>` : `
          <div class="status-box pass">
            <div class="status-icon">✓</div>
            <div class="status-body">
              <div class="status-title">Scenario hoàn tất thành công</div>
            </div>
          </div>`}

          <div>
            <div class="section-label">Test Data</div>
            ${renderData(it.data)}
          </div>
          ${it.duration_ms != null ? `<div class="scenario-timing"><span>Tổng step: <strong>${fmt(it._stepDurationMs)}</strong></span><span>Orchestration / cleanup: <strong>${fmt(it._overheadDurationMs)}</strong></span><span>Tổng scenario: <strong>${fmt(it.duration_ms)}</strong></span></div>` : ''}
          ${renderCaseContext(it)}
          <div>
            <div class="section-label">Các bước đã thực hiện</div>
            ${renderSteps(it.steps)}
          </div>
          ${renderNarrativeSteps(it.narrativeSteps)}
        </div>
        ${videoHtml}
      </div>
    </div>
  </details>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root {
  --bg:         #f5f6fa;
  --surface:    #ffffff;
  --surface2:   #f8f9fc;
  --border:     #e4e7ef;
  --border2:    #d0d5e8;
  --text:       #1a1d2e;
  --text2:      #6b7594;
  --text3:      #9aa3c2;
  --pink:       #d82d8b;
  --pink-light: #fdf0f7;
  --pink-mid:   #f5c6e3;
  --pass:       #0fa968;
  --pass-light: #edfbf5;
  --pass-mid:   #a7e8cc;
  --fail:       #e53e3e;
  --fail-light: #fff5f5;
  --fail-mid:   #feb2b2;
  --amber:      #b7791f;
  --amber-light: #fffaf0;
  --amber-mid:  #f0d8a8;
  --blue:       #3b5bdb;
  --blue-light: #eef2ff;
  --orange:     #e67e22;
  --orange-light: #fef5e7;
  --mono:       'JetBrains Mono', monospace;
  --sans:       'Inter', system-ui, sans-serif;
  --radius:     10px;
  --shadow-sm:  0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md:  0 4px 16px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04);
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.6;
  min-height: 100vh;
}

/* ─── HEADER ─── */
.header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0 48px;
}
.header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 0 18px;
  gap: 24px;
}
.header-left { display: flex; align-items: center; gap: 16px; }
.header-logo {
  width: 42px; height: 42px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
}
.header-logo img { width: 100%; height: 100%; object-fit: contain; display: block; }
.header-brand { display: flex; flex-direction: column; gap: 2px; }
.header-eyebrow {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--pink);
  font-weight: 500;
}
.header-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.3px;
  line-height: 1.2;
}
.header-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.meta-chip {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text2);
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px 10px;
  white-space: nowrap;
}
.meta-chip.chip-kind  { color: var(--blue); background: var(--blue-light); border-color: #c5d0fa; }
.meta-chip.chip-flow  { color: var(--pink); background: var(--pink-light); border-color: var(--pink-mid); }
.meta-chip.chip-platform { color: var(--orange); background: var(--orange-light); border-color: #f6cfa0; }
.meta-chip.chip-build { color: #2b8a3e; background: #ebfbee; border-color: #b2f2bb; font-weight: 600; }
.meta-chip.chip-runner { color: var(--text2); background: var(--surface2); border-color: var(--border); }

/* ─── STATS STRIP ─── */
.stats-strip {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 16px 48px;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: stretch;
}
.stat {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 18px;
  min-width: 110px;
}
.stat-icon {
  width: 36px; height: 36px;
  border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px;
  flex-shrink: 0;
}
.stat-icon.ic-total   { background: var(--blue-light); }
.stat-icon.ic-pass    { background: var(--pass-light); }
.stat-icon.ic-fail    { background: var(--fail-light); }
.stat-icon.ic-blocked { background: var(--amber-light); }
.stat-icon.ic-skip    { background: var(--orange-light); }
.stat-icon.ic-rate    { background: var(--pink-light); }
.stat-icon.ic-dur     { background: var(--orange-light); }
.stat-body { display: flex; flex-direction: column; gap: 1px; }
.stat-val {
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
  color: var(--text);
}
.stat.s-pass .stat-val { color: var(--pass); }
.stat.s-fail .stat-val { color: var(--fail); }
.stat.s-blocked .stat-val { color: var(--amber); }
.stat.s-skip .stat-val { color: var(--orange); }
.stat.s-rate .stat-val { color: var(--pink); }
.stat.s-dur  .stat-val { color: var(--orange); font-size: 18px; }
.stat-lbl {
  font-size: 11px;
  font-weight: 500;
  color: var(--text3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.chart-card {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 210px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 18px;
}
.donut {
  --pass-deg: 0deg;
  --fail-deg: 0deg;
  --blocked-deg: 0deg;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: conic-gradient(var(--pass) 0 var(--pass-deg), var(--fail) var(--pass-deg) var(--fail-deg), var(--amber) var(--fail-deg) var(--blocked-deg), var(--orange) var(--blocked-deg) 360deg);
  position: relative;
  flex-shrink: 0;
}
.donut::after {
  content: "";
  position: absolute;
  inset: 11px;
  border-radius: 50%;
  background: var(--surface2);
}
.chart-copy { display: flex; flex-direction: column; gap: 2px; }
.chart-copy strong { font-size: 18px; color: var(--text); line-height: 1; }
.chart-copy span { font-size: 11px; color: var(--text2); }
.chart-legend { display: flex; flex-wrap: wrap; gap: 3px 8px; font-family: var(--mono); font-size: 10px; color: var(--text2); }
.chart-legend span { display: inline-flex; align-items: center; gap: 3px; }
.chart-legend i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.chart-legend .legend-pass i { background: var(--pass); }
.chart-legend .legend-fail i { background: var(--fail); }
.chart-legend .legend-blocked i { background: var(--amber); }
.chart-legend .legend-skip i { background: var(--orange); }

/* ─── MAIN CONTENT ─── */
.main {
  padding: 28px 32px;
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  gap: 20px;
  max-width: none;
  margin: 0;
  width: 100%;
  align-items: start;
}
.workflow-nav {
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.workflow-nav-inner {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  box-shadow: var(--shadow-sm);
  max-height: min(460px, calc(100vh - 120px));
  overflow: auto;
}
.workflow-nav-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text3);
  margin-bottom: 8px;
}
.workflow-link {
  display: grid;
  grid-template-columns: 24px 1fr 8px;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 7px 8px;
  border-radius: 8px;
  text-decoration: none;
  color: var(--text);
}
.workflow-link:hover { background: var(--surface2); }
.workflow-index {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  background: var(--surface2);
  border: 1px solid var(--border);
}
.workflow-name {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: normal;
  word-break: normal;
}
.workflow-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.workflow-pass .workflow-dot { background: var(--pass); }
.workflow-fail .workflow-dot { background: var(--fail); }
.workflow-blocked .workflow-dot { background: var(--amber); }
.workflow-skipped .workflow-dot { background: var(--orange); }
.report-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}
.run-summary {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 18px;
  box-shadow: var(--shadow-sm);
}
.run-summary p {
  color: var(--text);
  font-size: 14px;
  line-height: 1.6;
}
.lifecycle { display:flex; flex-direction:column; gap:8px; }
.lifecycle-gate { display:flex; align-items:center; gap:10px; padding:12px 14px; border:1px solid var(--border); border-radius:10px; background:var(--surface); }
.lifecycle-gate p { margin:3px 0 0; color:var(--muted); font-size:12px; }
.lifecycle-icon { width:24px; height:24px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-weight:800; }
.lifecycle-pass { border-left:4px solid var(--pass); }.lifecycle-pass .lifecycle-icon { color:var(--pass); background:var(--pass-light); }
.lifecycle-fail { border-left:4px solid var(--fail); }.lifecycle-fail .lifecycle-icon { color:var(--fail); background:var(--fail-light); }
.lifecycle-gate .dur-tag { margin-left:auto; }
.session-info {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}
.session-info div {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.scenario-timing { display:flex; flex-wrap:wrap; gap:8px; margin-top:2px; color:var(--text2); font-size:12px; }
.scenario-timing span { background:var(--surface2); border:1px solid var(--border); border-radius:6px; padding:4px 8px; }
.scenario-timing strong { color:var(--text); font-family:var(--mono); font-weight:500; }
.session-info span {
  display: block;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text3);
}
.session-info strong {
  display: block;
  margin-top: 2px;
  color: var(--text);
  font-size: 12px;
  word-break: break-word;
}
.session-info em {
  display: block;
  margin-top: 4px;
  color: var(--text3);
  font-family: var(--mono);
  font-size: 10px;
  font-style: normal;
  overflow-wrap: anywhere;
}
.context-box {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px;
}
.context-box div {
  background: var(--blue-light);
  border: 1px solid #c5d0fa;
  border-radius: 8px;
  padding: 10px 12px;
}
.context-box span {
  display: block;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text2);
}
.context-box strong {
  display: block;
  margin-top: 2px;
  color: var(--blue);
  font-size: 12px;
}

/* ─── CARD ─── */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  transition: box-shadow 0.2s;
}
.card:hover { box-shadow: var(--shadow-md); }
.card-pass { border-left: 4px solid var(--pass); background: var(--pass-light); }
.card-fail { border-left: 4px solid var(--fail); background: var(--fail-light); }
.card-blocked { border-left: 4px solid var(--amber); background: var(--amber-light); }
.card-skipped { border-left: 4px solid var(--orange); background: var(--orange-light); }
.card[open] { background: var(--surface); }

/* card header */
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  background: var(--surface2);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  list-style: none;
  gap: 12px;
}
.card-head::-webkit-details-marker { display: none; }
.head-left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
.row-id {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 6px;
  padding: 3px 12px;
}
.flow-title {
  font-weight: 700;
  color: var(--text);
  word-break: break-word;
  min-width: 0;
  flex: 1;
}
.badge {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 3px 12px;
  border-radius: 99px;
  display: flex; align-items: center; gap: 5px;
}
.badge-pass { background: var(--pass-light); color: var(--pass); border: 1px solid var(--pass-mid); }
.badge-fail { background: var(--fail-light); color: var(--fail); border: 1px solid var(--fail-mid); }
.badge-blocked { background: var(--amber-light); color: var(--amber); border: 1px solid var(--amber-mid); }
.badge-skipped { background: var(--orange-light); color: var(--orange); border: 1px solid #f6cfa0; }
.badge-flaky { background: var(--orange-light); color: var(--orange); border: 1px solid var(--orange); }
.dur-tag {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px 10px;
  white-space: nowrap;
  flex-shrink: 0;
}
.disclosure {
  width: 30px;
  height: 30px;
  border: 1px solid var(--border2);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-family: var(--mono);
  font-size: 18px;
  font-weight: 600;
  line-height: 1;
}
.disclosure::before { content: '+'; }
.card[open] .disclosure::before { content: '−'; }
.card-head:hover .disclosure { border-color: var(--pink-mid); color: var(--pink); }
}

/* card content */
.card-body {
  display: block;
}
.col-shot {
  display: none;
  border-right: 1px solid var(--border);
  background: #f0f2f8;
  align-items: center;
  justify-content: center;
  position: relative;
  padding: 12px;
}
.col-right {
  display: flex;
  flex-direction: column;
}
.col-info {
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
}
.col-video {
  border-top: 1px solid var(--border);
  padding: 16px 24px;
  background: #fafbfe;
}

/* screenshot */
.shot-link {
  display: block;
  width: 100%;
  position: relative;
  cursor: zoom-in;
  text-decoration: none;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: var(--shadow-sm);
}
.shot-img {
  width: 100%;
  height: auto;
  max-height: 500px;
  object-fit: contain;
  display: block;
  background: #fff;
}
.shot-zoom-icon {
  position: absolute;
  bottom: 8px; right: 8px;
  background: rgba(255,255,255,0.9);
  color: var(--text2);
  font-size: 12px;
  width: 26px; height: 26px;
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  opacity: 0;
  transition: opacity 0.15s;
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border);
}
.shot-link:hover .shot-zoom-icon { opacity: 1; }
.no-shot {
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 8px;
  color: var(--text3);
  font-family: var(--mono);
  font-size: 12px;
  padding: 40px;
}

/* status box */
.status-box {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
}
.status-box.pass { background: var(--pass-light); color: var(--pass); border: 1px solid var(--pass-mid); }
.status-box.fail { background: var(--fail-light); color: var(--fail); border: 1px solid var(--fail-mid); }
.status-box.blocked { background: var(--amber-light); color: var(--amber); border: 1px solid var(--amber-mid); }
.status-box.skipped { background: var(--orange-light); color: var(--orange); border: 1px solid #f6cfa0; }
.status-icon { font-size: 15px; flex-shrink: 0; margin-top: 1px; }
.status-body { display: flex; flex-direction: column; gap: 4px; }
.status-title { font-weight: 600; }
.err-msg {
  font-family: var(--mono);
  font-size: 11.5px;
  color: #c53030;
  line-height: 1.6;
  word-break: break-word;
  font-weight: 400;
}

/* section label */
.section-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text3);
  margin-bottom: 6px;
}

/* data table */
.data-table {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  font-family: var(--mono);
  font-size: 12px;
}
.data-table tr:not(:last-child) td { border-bottom: 1px solid var(--border); }
.data-table td { padding: 7px 14px; }
.data-table td:first-child {
  color: var(--text2);
  background: var(--surface2);
  font-weight: 500;
  white-space: nowrap;
  width: 1%;
  border-right: 1px solid var(--border);
}
.data-table td:last-child { color: var(--blue); background: var(--surface); }

/* steps */
.step-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  list-style: none;
}
.step {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface);
}
.step-pass { border-color: var(--pass-mid); background: var(--pass-light); }
.step-fail { border-color: var(--fail-mid); background: var(--fail-light); }
.step-skipped { border-color: #f6cfa0; background: var(--orange-light); }
.narrative-wrap { margin-top: 4px; }
.narrative-list { margin: 0; padding: 10px 14px 10px 32px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface2); }
.narrative-list li { padding: 3px 0; color: var(--text2); line-height: 1.55; }
.step-main {
  display: grid;
  grid-template-columns: 28px 1fr auto auto;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
}
.step-index {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  background: var(--surface);
  border: 1px solid var(--border);
}
.step-title { font-weight: 700; color: var(--text); }
.step-summary {
  margin-top: 2px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text2);
  word-break: break-word;
}
.step-duration {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text2);
}
.step-shot {
  border-top: 1px solid var(--border);
  padding: 12px;
  background: var(--surface);
  max-width: 320px;
}

/* video */
.video-section { display: flex; flex-direction: column; gap: 8px; }
.video-wrap {
  background: #0a0a0a;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.video-header {
  padding: 8px 14px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text3);
  background: var(--surface2);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.video-rec-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--fail);
  flex-shrink: 0;
  animation: blink 2s infinite;
}
@keyframes blink { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
.video-player { width: 100%; max-height: 420px; display: block; }

/* ─── LIGHTBOX ─── */
.lightbox-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(10,10,20,0.85);
  z-index: 9999;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(8px);
  cursor: zoom-out;
}
.lightbox-overlay.open { display: flex; }
.lightbox-img {
  max-width: 88vw;
  max-height: 88vh;
  object-fit: contain;
  border-radius: 12px;
  box-shadow: 0 32px 80px rgba(0,0,0,0.6);
  cursor: default;
}
.lightbox-close {
  position: fixed;
  top: 20px; right: 24px;
  background: rgba(255,255,255,0.15);
  border: 1px solid rgba(255,255,255,0.2);
  color: #fff;
  font-size: 18px;
  width: 38px; height: 38px;
  border-radius: 8px;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  backdrop-filter: blur(4px);
  transition: background 0.15s;
}
.lightbox-close:hover { background: rgba(255,255,255,0.25); }

/* ─── FOOTER ─── */
.footer {
  border-top: 1px solid var(--border);
  padding: 16px 48px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--text3);
  background: var(--surface);
  margin-top: 8px;
}
.footer-brand {
  display: flex; align-items: center; gap: 8px;
  font-weight: 600;
  color: var(--pink);
}
.footer-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--pink);
}

.muted { color: var(--text3); font-style: italic; font-size: 12px; }

/* ─── KNOWLEDGE CHANGES ─── */
.knowledge { padding: 0 48px 8px; }
.knowledge-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  font-size: 12px;
}
.knowledge-table th, .knowledge-table td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.knowledge-table th {
  color: var(--text2);
  font-weight: 600;
  background: var(--surface2);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.knowledge-table td:first-child { font-weight: 600; color: var(--amber); }
.knowledge-table td.k-file { font-family: var(--mono); color: var(--text2); word-break: break-all; }
.knowledge-table tr:last-child td { border-bottom: none; }

@media (max-width: 900px) {
  .header, .stats-strip, .main, .footer, .knowledge { padding-left: 20px; padding-right: 20px; }
  .main { grid-template-columns: 1fr; }
  .workflow-nav { position: static; }
  .workflow-nav-inner { max-height: 220px; overflow: auto; }
  .stats-strip { gap: 8px; }
}
</style>
</head>
<body>

<div class="lightbox-overlay" id="lightbox" onclick="closeLightbox()">
  <button class="lightbox-close" onclick="closeLightbox()">✕</button>
  <img class="lightbox-img" id="lightbox-img" src="" alt="" onclick="event.stopPropagation()"/>
</div>

<div class="header">
  <div class="header-inner">
    <div class="header-left">
      ${brand.logoUrl ? `<div class="header-logo">
        <img src="${esc(brand.logoUrl)}" alt="${esc(brand.footer)}"/>
      </div>` : ''}
      <div class="header-brand">
        <div class="header-eyebrow">${esc(brand.eyebrow)}</div>
        <div class="header-title">${esc(title)}</div>
      </div>
    </div>
  </div>
</div>

<div class="stats-strip">
  <div class="chart-card">
    <div class="donut" style="--pass-deg:${chartPassDeg}deg;--fail-deg:${chartFailDeg}deg;--blocked-deg:${chartBlockedDeg}deg"></div>
    <div class="chart-copy">
      <strong>Scenario distribution</strong>
      <div class="chart-legend">
        <span class="legend-pass"><i></i>PASS ${chartPassRate}%</span>
        <span class="legend-fail"><i></i>FAIL ${chartFailRate}%</span>
        ${blocked ? `<span class="legend-blocked"><i></i>BLOCKED ${chartBlockedRate}%</span>` : ''}
        ${skipped ? `<span class="legend-skip"><i></i>SKIP ${chartSkipRate}%</span>` : ''}
      </div>
    </div>
  </div>
  <div class="stat">
    <div class="stat-icon ic-total">📋</div>
    <div class="stat-body"><div class="stat-val">${total}</div><div class="stat-lbl">Total</div></div>
  </div>
  <div class="stat s-pass">
    <div class="stat-icon ic-pass">✅</div>
    <div class="stat-body"><div class="stat-val">${passed}</div><div class="stat-lbl">Passed</div></div>
  </div>
  <div class="stat s-fail">
    <div class="stat-icon ic-fail">❌</div>
    <div class="stat-body"><div class="stat-val">${failed}</div><div class="stat-lbl">Failed</div></div>
  </div>
  ${blocked ? `<div class="stat s-blocked">
    <div class="stat-icon ic-blocked">⚠</div>
    <div class="stat-body"><div class="stat-val">${blocked}</div><div class="stat-lbl">Blocked</div></div>
  </div>` : ''}
  ${skipped ? `<div class="stat s-skip">
    <div class="stat-icon ic-skip">⊘</div>
    <div class="stat-body"><div class="stat-val">${skipped}</div><div class="stat-lbl">Skipped</div></div>
  </div>` : ''}
  <div class="stat s-rate">
    <div class="stat-icon ic-rate">🎯</div>
    <div class="stat-body"><div class="stat-val">${passRate}%</div><div class="stat-lbl">Pass Rate</div></div>
  </div>
  <div class="stat s-dur">
    <div class="stat-icon ic-dur">⏱</div>
    <div class="stat-body"><div class="stat-val">${fmt(totalDur)}</div><div class="stat-lbl">Duration</div></div>
  </div>
</div>

${renderKnowledge(knowledge)}

<div class="main">
  <aside class="workflow-nav">
    <div class="workflow-nav-inner">
      <div class="workflow-nav-title">Scenarios Test</div>
      ${workflowNav}
    </div>
  </aside>
  <section class="report-content">
    ${renderRunSummary(summary, rows)}
    ${renderSessionInfo(summary, rows)}
    ${renderLifecycle(summary)}
    ${cards}
  </section>
</div>

<div class="footer">
  <div class="footer-brand">
    <div class="footer-dot"></div>
    ${esc(brand.footer)}
  </div>
  <span>Generated ${genTime}</span>
</div>

<script>
function openLightbox(el) {
  document.getElementById('lightbox-img').src = el.querySelector('img').src;
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
}
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeLightbox(); });
</script>
</body>
</html>`;

  const out = path.join(reportDir, 'index.html');
  fs.writeFileSync(out, html);
  return out;
}

/**
 * Report branding (logo, eyebrow, footer) from the workspace manifest's `report.brand`.
 * The defaults are generic so a report never carries a specific product's brand unless the
 * workspace asks for it.
 */
function reportBrand() {
  let cfg = {};
  try {
    const workspace = require('../util/workspace');
    cfg = (workspace.manifest() || {}).report?.brand || {};
  } catch { /* no workspace */ }
  return {
    logoUrl: typeof cfg.logoUrl === 'string' ? cfg.logoUrl : '',
    eyebrow: cfg.eyebrow || 'AUTOMATION TEST REPORT',
    footer: cfg.footer || 'reflex',
  };
}

/** Upload endpoint: REPORT_UPLOAD_URL env → workspace manifest report.uploadUrl → nothing. */
function uploadEndpoint() {
  if (process.env.REPORT_UPLOAD_URL) return process.env.REPORT_UPLOAD_URL;
  try {
    const workspace = require('../util/workspace');
    const cfg = (workspace.manifest() || {}).report || {};
    if (cfg.uploadUrl) return cfg.uploadUrl;
  } catch { /* no workspace */ }
  // No built-in endpoint on purpose: a hard-coded internal host would leak here and would
  // silently upload to whatever the network happens to route to. Callers must configure one.
  return null;
}

/**
 * Upload report folder to CDN.
 *
 * CDN stores all files flat at the root of the report (no subdirectories).
 * Strategy:
 *   1. Walk all allowed files, compute a flat field name for each
 *      e.g. assets/ct_01/fail.png → ct_01_fail.png
 *   2. Patch index.html in memory: replace every old relative path with the flat name
 *   3. Write patched index.html to a temp file, upload it + all assets with flat field names
 *   4. Clean up temp file
 *
 * @param {string} reportDir  absolute path to the report folder
 * @param {string} [endpoint]
 * @returns {{ reportUrl?: string, [key: string]: any }} parsed JSON from CDN
 */
function uploadReport(reportDir, endpoint = uploadEndpoint(), options = {}) {
  // Fail before touching the filesystem or spawning curl, so a missing endpoint is a clear
  // configuration error instead of an upload against an unknown host.
  if (!endpoint) {
    throw new Error(
      'uploadReport: no endpoint configured (set REPORT_UPLOAD_URL or report.uploadUrl in the workspace manifest)'
    );
  }

  const { spawnSync } = require('child_process');
  const os = require('os');

  const ALLOWED_EXT = new Set(['css','htm','html','ico','jpeg','jpg','js','json','mp4','png','svg']);

  // Walk all files recursively
  function walk(dir, base) {
    let files = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel  = path.join(base, e.name).replace(/\\/g, '/');
      if (e.isDirectory()) files = files.concat(walk(full, rel));
      else files.push({ rel, abs: full });
    }
    return files;
  }

  // Flatten nested path → single filename (assets/ct_01/fail.png → ct_01_fail.png)
  function flatName(rel) {
    const parts = rel.split('/').filter(Boolean);
    if (parts.length === 1) return parts[0];
    const meaningful = parts[0] === 'assets' ? parts.slice(1) : parts;
    return meaningful.join('_');
  }

  const allFiles = walk(reportDir, '');
  const uploadable = allFiles.filter(({ rel }) => {
    if (options.singleFile === true) return rel === 'index.html';
    return ALLOWED_EXT.has(rel.split('.').pop().toLowerCase());
  });
  if (!uploadable.length) throw new Error('uploadReport: no uploadable files found in ' + reportDir);

  // Build old-rel → flat-name mapping for HTML patching
  const renameMap = {};
  for (const f of uploadable) {
    if (f.rel !== 'index.html') renameMap[f.rel] = flatName(f.rel);
  }

  // Patch index.html:
  // 1. Replace every allowed asset's old relative path with its flat name
  // 2. Replace <video> blocks (mp4 not supported by CDN) with an offline note
  const indexPath = path.join(reportDir, 'index.html');
  let indexHtml = fs.readFileSync(indexPath, 'utf8');
  for (const [oldRel, flat] of Object.entries(renameMap)) {
    const escaped = oldRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    indexHtml = indexHtml.replace(new RegExp(escaped, 'g'), flat);
  }
  // Write patched index.html to a temp file
  const tmpIndex = path.join(os.tmpdir(), `report_index_${Date.now()}.html`);
  fs.writeFileSync(tmpIndex, indexHtml);

  try {
    const args = ['-s', '-X', 'POST', endpoint, '--insecure', '-F', 'reportType=automation'];

    // index.html — use patched temp file, force filename so curl doesn't use the tmp path
    args.push('-F', `index.html=@${tmpIndex};filename=index.html`);

    // all other uploadable files with flat field names
    for (const { rel, abs } of uploadable) {
      if (rel === 'index.html') continue;
      const flat = renameMap[rel];
      args.push('-F', `${flat}=@${abs};filename=${flat}`);
    }

    const r = spawnSync('curl', args, { encoding: 'utf8', timeout: 60000 });
    if (r.error) throw new Error('curl error: ' + r.error.message);
    if (r.status !== 0) throw new Error('curl exited ' + r.status + ': ' + (r.stderr || r.stdout).trim());

    const raw = (r.stdout || '').trim();
    try { return JSON.parse(raw); } catch { return { raw }; }
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch {}
  }
}

/**
 * Chat delivery is intentionally opt-in. A webhook identity (for example
 * "QC Engineer AI") is controlled by Google Chat, not by the report payload;
 * never keep a shared webhook hard-coded in the execution engine.
 */
function chatWebhook() {
  if (process.env.GOOGLE_CHAT_WEBHOOK) return process.env.GOOGLE_CHAT_WEBHOOK;
  try {
    const workspace = require('../util/workspace');
    const cfg = (workspace.manifest() || {}).report || {};
    if (cfg.chatWebhook) return cfg.chatWebhook;
  } catch { /* no workspace */ }
  return null;
}

/** Explicit delivery switch: env wins, otherwise workspace report.notifyChat. */
function shouldNotifyGoogleChat() {
  if (process.env.NOTIFY_CHAT !== undefined) return process.env.NOTIFY_CHAT === 'true';
  try {
    const workspace = require('../util/workspace');
    return (workspace.manifest() || {}).report?.notifyChat === true;
  } catch { return false; }
}

/**
 * Post a plain-text message to a Google Chat space via incoming webhook.
 * Synchronous (curl), best-effort. Text supports Chat formatting: *bold*, <url|label>.
 *
 * @param {string} text       message body
 * @param {string} [webhook]  override the resolved webhook URL
 * @returns {{ [key: string]: any }} parsed JSON from Chat (or { raw })
 */
function notifyGoogleChat(text, webhook = chatWebhook()) {
  const { spawnSync } = require('child_process');
  if (!webhook) throw new Error('notifyGoogleChat: no webhook configured');
  const body = JSON.stringify({ text });
  const args = ['-s', '-X', 'POST', '-H', 'Content-Type: application/json; charset=UTF-8', '-d', body, webhook];
  const r = spawnSync('curl', args, { encoding: 'utf8', timeout: 30000 });
  if (r.error) throw new Error('curl error: ' + r.error.message);
  if (r.status !== 0) throw new Error('curl exited ' + r.status + ': ' + (r.stderr || r.stdout).trim());
  const raw = (r.stdout || '').trim();
  try { return JSON.parse(raw); } catch { return { raw }; }
}

module.exports = { writeReport, uploadReport, notifyGoogleChat, shouldNotifyGoogleChat };
