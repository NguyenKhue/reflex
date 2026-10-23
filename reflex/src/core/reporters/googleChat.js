/**
 * googleChat.js — the reporter that posts a one-line run summary to a Google Chat webhook (report.js notifyGoogleChat).
 *
 * It does nothing unless delivery is switched on (NOTIFY_CHAT env or the workspace's report.notifyChat), exactly like
 * report.js decides today. `notify`, `shouldNotify` and `format` can be injected for tests and other chat formats.
 */
function defaultText(summary) {
  const name = (summary && (summary.plan || summary.name)) || 'run';
  const status = (summary && summary.status) || 'unknown';
  return `*${name}* — ${status}`;
}

function createGoogleChatReporter({ notify = null, shouldNotify = null, webhook = null, format = defaultText } = {}) {
  const post = notify || ((text, hook) => require('../../report/report').notifyGoogleChat(text, hook));
  const enabled = shouldNotify || (() => require('../../report/report').shouldNotifyGoogleChat());
  return {
    name: 'google-chat',
    async report(summary) {
      if (!enabled()) return { skipped: true };
      return post(format(summary), webhook || undefined);
    },
  };
}

module.exports = { createGoogleChatReporter, defaultText };
