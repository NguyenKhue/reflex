/**
 * jevClient.js — the Jev (TypeSafe System One) text model client.
 *
 * Decisions are closed-set questions over a small state object, so this module only
 * builds the question payloads, tracks token/latency/cost stats and keeps the API key
 * out of logs. The SDK is required lazily (`@typesafe-ai/sdk` is an optional dep) and
 * the question builders are plain objects, so they need no SDK at all.
 */
const NOT_CONFIGURED = 'TYPESAFE_API_KEY is not set — Jev tools are unavailable';
const SDK_NOT_INSTALLED = '@typesafe-ai/sdk is not installed — run: npm install --prefix reflex';
const DEFAULT_USD_PER_MILLION = 0.042;

/** Question builders — same plain objects the SDK produces. */
function noul(instructions) {
  return { type: 'noul', instructions };
}

function choice(instructions, criteria) {
  return { type: 'choice', instructions, criteria };
}

function score(instructions, criteria) {
  return { type: 'score', instructions, criteria };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function createJevClient({
  apiKey = process.env.TYPESAFE_API_KEY,
  model = process.env.TYPESAFE_MODEL || 'jev-latest',
  timeoutMs = 15000,
  clientFactory,
  usdPerMillion = Number(process.env.JEV_INPUT_USD_PER_MILLION) || DEFAULT_USD_PER_MILLION
} = {}) {
  let client = null;
  const stats = { calls: 0, input_tokens: 0, output_tokens: 0, latency_ms_total: 0 };

  function getClient() {
    if (client) return client;
    if (clientFactory) {
      client = clientFactory();
      return client;
    }
    if (!apiKey) throw new Error(NOT_CONFIGURED);
    let sdk;
    try {
      sdk = require('@typesafe-ai/sdk');
    } catch (error) {
      throw new Error(SDK_NOT_INSTALLED);
    }
    client = new sdk.TypeSafeClient({ apiKey, timeout: timeoutMs, retry: { maxRetries: 0 }, logLevel: 'off' });
    return client;
  }

  return {
    model,

    async ask(state, questions) {
      // Credentials are resolved on the first call, so a missing key never breaks
      // a caller that only inspects stats or builds a question.
      const client_ = getClient();
      const startedAt = Date.now();
      let response;
      try {
        response = await client_.systemOne({ model, state, questions });
      } catch (error) {
        error.phase = 'jev';
        throw error;
      }
      const latencyMs = Date.now() - startedAt;
      const usage = (response && response.usage) || {};
      const inputTokens = Number(usage.input_tokens) || 0;
      const outputTokens = Number(usage.output_tokens) || 0;
      stats.calls += 1;
      stats.input_tokens += inputTokens;
      stats.output_tokens += outputTokens;
      stats.latency_ms_total += latencyMs;
      return {
        answers: (response && response.answers) || {},
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        latency_ms: latencyMs,
        model
      };
    },

    stats() {
      const calls = stats.calls;
      return {
        calls,
        input_tokens: stats.input_tokens,
        output_tokens: stats.output_tokens,
        latency_ms_total: stats.latency_ms_total,
        latency_ms_avg: calls ? Math.round(stats.latency_ms_total / calls) : 0,
        cost_usd: round((stats.input_tokens / 1e6) * usdPerMillion, 6)
      };
    }
  };
}

/** Jev stand-in for tests: `responder(state, questions, callIndex)` returns the answers. */
function createMockJev(responder) {
  const stats = { calls: 0, input_tokens: 0, output_tokens: 0, latency_ms_total: 0 };

  return {
    model: 'mock',

    async ask(state, questions) {
      const callIndex = stats.calls;
      const startedAt = Date.now();
      const answers = (await responder(state, questions, callIndex)) || {};
      const latencyMs = Date.now() - startedAt;
      stats.calls += 1;
      stats.input_tokens += 100;
      stats.output_tokens += 10;
      stats.latency_ms_total += latencyMs;
      return {
        answers,
        usage: { input_tokens: 100, output_tokens: 10 },
        latency_ms: latencyMs,
        model: 'mock'
      };
    },

    stats() {
      const calls = stats.calls;
      return {
        calls,
        input_tokens: stats.input_tokens,
        output_tokens: stats.output_tokens,
        latency_ms_total: stats.latency_ms_total,
        latency_ms_avg: calls ? Math.round(stats.latency_ms_total / calls) : 0,
        cost_usd: round((stats.input_tokens / 1e6) * DEFAULT_USD_PER_MILLION, 6)
      };
    }
  };
}

module.exports = { createJevClient, createMockJev, noul, choice, score };
