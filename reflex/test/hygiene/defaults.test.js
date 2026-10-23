/**
 * defaults.test.js — hygiene: no internal defaults baked into the code.
 *
 * The report upload endpoint and the report branding must all come from the
 * environment or the workspace manifest. A hard-coded internal host would leak with the source
 * and would silently point a run at an endpoint nobody chose here, so every case below builds its
 * own temp workspace and asserts the generic behaviour instead.
 *
 * No device, no network: the missing-endpoint cases must fail before any curl is spawned.
 * Only reserved, non-routable hostnames (cdn.invalid) appear here, never a real one.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { writeReport, uploadReport } = require('../../src/report/report');
const workspace = require('../../src/util/workspace');

const MANIFEST = 'reflex.workspace.json';

const NO_UPLOAD_ENDPOINT =
  'uploadReport: no endpoint configured (set REPORT_UPLOAD_URL or report.uploadUrl in the workspace manifest)';

const ENV_KEYS = ['BYPASS_LOGIN_OTP_BASE_URL', 'BYPASS_LOGIN_OTP_TOKEN', 'UAT_OTP_TOKEN', 'REPORT_UPLOAD_URL'];

/**
 * Fresh workspace + clean env for one case: the manifest is written by hand and the override is
 * reset in `finally`, so no case can see the next one's configuration.
 */
async function withWorkspace(manifest, run) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-hygiene-')));
  fs.writeFileSync(path.join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  workspace.setOverride(root);
  try {
    return await run(root);
  } finally {
    workspace.reset();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** A report folder that already holds an index.html, so an upload would have something to send. */
function reportDirIn(root, name = 'reports/run-1') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>report</body></html>\n');
  return dir;
}

function writeMinimalReport(root, name = 'html') {
  const dir = path.join(root, name);
  const out = writeReport({
    title: 'Hygiene',
    kind: 'spec',
    summary: { plan: 'hygiene', status: 'pass', total: 0, duration_ms: 0, started_at: '2026-01-01T00:00:00Z' },
    items: [],
    reportDir: dir,
  });
  return fs.readFileSync(out, 'utf8');
}

test('6. uploadReport without an endpoint fails before it touches the network', async () => {
  await withWorkspace({ name: 't', apps: {} }, (root) => {
    assert.throws(() => uploadReport(reportDirIn(root)), { message: NO_UPLOAD_ENDPOINT });
  });
});

test('7. a configured upload endpoint gets past the guard (curl is never reached here)', async () => {
  // Only the guard is under test: the endpoint is a reserved .invalid host, so even if a future
  // change moved the check the upload could not succeed against a real service. The assertion is
  // "not the no-endpoint error", whatever else happens.
  await withWorkspace({ name: 't', apps: {} }, (root) => {
    process.env.REPORT_UPLOAD_URL = 'http://upload.invalid/upload';
    const dir = reportDirIn(root);
    let thrown = null;
    try {
      uploadReport(dir);
    } catch (err) {
      thrown = err;
    }
    assert.notEqual(thrown && thrown.message, NO_UPLOAD_ENDPOINT);
  });
});

test('8. a report built with no branding carries generic text and no logo', async () => {
  await withWorkspace({ name: 't', apps: {} }, (root) => {
    const html = writeMinimalReport(root, 'reports/plain');
    assert.ok(html.includes('AUTOMATION TEST REPORT'), 'default eyebrow');
    assert.ok(html.includes('reflex'), 'default footer');
    assert.ok(!html.includes('ACME APP DEVELOPMENT'), 'no product eyebrow');
    assert.ok(!html.includes('Acme App Testing'), 'no product footer');
    const headerLogo = html.slice(html.indexOf('class="header"'));
    assert.ok(!headerLogo.slice(0, headerLogo.indexOf('stats-strip')).includes('<img'), 'no logo image');
    assert.ok(!/<img[^>]+src="http/.test(html), 'no remote image source');
  });
});

test('9. report.brand in the manifest drives the logo, the eyebrow and the footer', async () => {
  const brand = { logoUrl: 'https://cdn.invalid/logo.svg', eyebrow: 'ACME REPORT', footer: 'Acme QA' };
  await withWorkspace({ name: 't', apps: {}, report: { brand } }, (root) => {
    const html = writeMinimalReport(root, 'reports/branded');
    assert.ok(html.includes('https://cdn.invalid/logo.svg'), 'logo url from the manifest');
    assert.ok(html.includes('ACME REPORT'), 'eyebrow from the manifest');
    assert.ok(html.includes('Acme QA'), 'footer from the manifest');
    assert.ok(!html.includes('AUTOMATION TEST REPORT'), 'the default eyebrow is replaced');
  });
});
