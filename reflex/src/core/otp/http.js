/**
 * http.js — a generic OTP provider: GET a URL that returns the current login OTP of a test phone.
 *
 * Nothing about a service is built in: the URL and the bearer token come from the environment (a gitignored .env),
 * so the code stays app-neutral (hygiene) and a token is never committed. The URL carries `{phone}` where the
 * number goes; without it the phone is appended as the last path segment. The OTP and the token never appear in
 * an error message: only the HTTP status or the shape problem does.
 */
const DEFAULT_TIMEOUT_MS = 10000;

/** The first 4–8 digit value under the usual keys, at the top level or one `data` level down. */
function otpFromBody(body) {
  const candidates = [body, body && body.data, body && body.result];
  for (const holder of candidates) {
    if (!holder || typeof holder !== 'object') continue;
    for (const key of ['otp', 'code', 'otpCode']) {
      const value = String(holder[key] ?? '').trim();
      if (/^\d{4,8}$/.test(value)) return value;
    }
  }
  return null;
}

function urlFor(template, phone) {
  const encoded = encodeURIComponent(phone);
  if (template.includes('{phone}')) return template.split('{phone}').join(encoded);
  return `${template.replace(/\/+$/, '')}/${encoded}`;
}

function createHttpOtpProvider({ env = process.env, url = null, token = null, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = null } = {}) {
  const template = String(url || env.REFLEX_OTP_URL || '').trim();
  const bearer = String(token || env.REFLEX_OTP_TOKEN || '').trim().replace(/^Bearer\s+/i, '');
  const doFetch = fetchImpl || globalThis.fetch;
  return {
    name: 'http',
    async getOtp(phone) {
      const number = String(phone || '').trim();
      if (!number) throw new Error('getOtp needs a phone number');
      if (!template) throw new Error('no OTP URL: set REFLEX_OTP_URL in workspace/.env (use {phone} where the number goes)');
      const response = await doFetch(urlFor(template, number), {
        method: 'GET',
        headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        // The service's own description ("OTP expired" before the app asked for one) is not a secret and says why.
        let reason = '';
        try {
          const error = await response.json();
          reason = String((error && (error.errorDesc || error.message)) || '').slice(0, 160);
        } catch (_) { /* no JSON body: the status alone */ }
        throw new Error(`OTP API answered HTTP ${response.status}${reason ? `: ${reason}` : ''}`);
      }
      let body;
      try {
        body = await response.json();
      } catch (_) {
        throw new Error('OTP API did not answer JSON');
      }
      const otp = otpFromBody(body);
      if (!otp) throw new Error('OTP API answer has no 4-8 digit otp/code field');
      return otp;
    },
  };
}

module.exports = { createHttpOtpProvider, otpFromBody, urlFor };
