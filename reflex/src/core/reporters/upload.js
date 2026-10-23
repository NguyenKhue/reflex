/**
 * upload.js — the reporter that uploads a finished report directory to an HTTP endpoint (report.js uploadReport).
 *
 * report.js is large, so it is required only when a report is actually sent. `upload` can be injected for tests.
 */
function createUploadReporter({ upload = null, endpoint = null, options = {} } = {}) {
  const send = upload || ((reportDir, target, opts) => require('../../report/report').uploadReport(reportDir, target, opts));
  return {
    name: 'upload',
    async report(summary, { reportDir } = {}) {
      if (!reportDir) throw new Error('upload reporter needs a reportDir');
      return send(reportDir, endpoint || undefined, options);
    },
  };
}

module.exports = { createUploadReporter };
