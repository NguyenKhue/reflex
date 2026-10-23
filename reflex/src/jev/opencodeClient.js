/**
 * opencodeClient.js — a Jev-shaped client (ask(state, questions), stats(), model) backed by a FREE opencode model.
 *
 * Why this shape: the runner, the agent loop and `jev_verify` already talk to "a Jev client", so a second decider is
 * a drop-in object, not a second code path. Only the two question types the runner asks are supported:
 *   choice → answers { choice, confidence }   (pick ONE id from a closed set)
 *   noul   → answers { noul }                  (probability that a statement is true)
 * The model never generates text for the device: it returns an id or a number, and a choice outside the set is an error.
 *
 * Free models only (user decision): the model id must look like `opencode/<name>-free`.
 * `opencode run` waits on stdin forever without a TTY, so stdin is closed; it runs in a temp dir so the model cannot
 * wander through the project files.
 */
const os = require('os');
const { spawn } = require('child_process');

const DEFAULT_MODEL = 'opencode/space-bunny-free';
const FREE_MODEL = /^opencode\/[A-Za-z0-9._-]+-free$/;
const OUTPUT_CAP = 1024 * 1024;

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Run `opencode run` once; resolves with the concatenated text parts of its JSON event stream. */
function runOpencode({ model, prompt, timeoutMs, cwd = os.tmpdir(), spawnFn = spawn, bin = 'opencode' }) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(bin, ['run', '-m', model, '--format', 'json', prompt], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`opencode ${model} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const collect = (chunk) => { if (out.length < OUTPUT_CAP) out += chunk; };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => finish(reject, error));
    child.on('close', () => {
      const text = [];
      const errors = [];
      for (const raw of out.split('\n')) {
        const line = raw.trim();
        if (!line.startsWith('{')) continue;
        let event;
        try { event = JSON.parse(line); } catch (error) { continue; }
        if (event.type === 'text' && event.part && event.part.text) text.push(event.part.text);
        else if (event.type === 'error') errors.push((event.error && event.error.message) || 'opencode error');
      }
      if (!text.length) return finish(reject, new Error(errors.length ? `opencode ${model}: ${errors[0]}` : `opencode ${model} returned no text`));
      return finish(resolve, text.join('\n').trim());
    });
  });
}

/** First balanced-looking {...} in the model text, parsed; models like to wrap JSON in prose or a code fence. */
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`no JSON object in the model answer: ${text.slice(0, 120)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : undefined;
}

function buildPrompt(state, name, question) {
  const header = 'You are the decision step of a mobile app test runner. Answer with ONLY one JSON object, no prose, no code fence. Do not use tools.';
  const stateText = JSON.stringify(state);
  if (question.type === 'choice') {
    return [
      header,
      `Question: ${question.instructions}`,
      `Options (id: description): ${JSON.stringify(question.criteria)}`,
      `State: ${stateText}`,
      'Reply exactly: {"choice":"<one option id>","confidence":<number between 0 and 1>}'
    ].join('\n');
  }
  return [
    header,
    `Question: ${question.instructions}`,
    `State: ${stateText}`,
    'Reply exactly: {"noul":<probability between 0 and 1 that the answer is yes>}'
  ].join('\n');
}

function createOpencodeClient({
  model = process.env.REFLEX_DECIDER_MODEL || DEFAULT_MODEL,
  timeoutMs = 120000,
  runner = runOpencode
} = {}) {
  if (!FREE_MODEL.test(model)) throw new Error(`opencode decider: "${model}" is not a free opencode model (expected opencode/<name>-free)`);
  const stats = { calls: 0, latency_ms_total: 0 };

  return {
    model,

    async ask(state, questions) {
      const startedAt = Date.now();
      const answers = {};
      for (const [name, question] of Object.entries(questions || {})) {
        if (!question || (question.type !== 'choice' && question.type !== 'noul')) {
          throw new Error(`opencode decider supports choice and noul questions, not "${question && question.type}"`);
        }
        const text = await runner({ model, prompt: buildPrompt(state, name, question), timeoutMs });
        const parsed = extractJson(text);
        if (question.type === 'choice') {
          const id = String(parsed.choice);
          if (!Object.prototype.hasOwnProperty.call(question.criteria || {}, id)) {
            throw new Error(`opencode decider chose "${id}", which is not one of the options`);
          }
          answers[name] = { choice: id, confidence: clamp01(parsed.confidence) };
        } else {
          const probability = clamp01(parsed.noul);
          if (probability === undefined) throw new Error('opencode decider returned no noul probability');
          answers[name] = { noul: probability };
        }
      }
      const latencyMs = Date.now() - startedAt;
      stats.calls += 1;
      stats.latency_ms_total += latencyMs;
      return { answers, usage: { input_tokens: 0, output_tokens: 0 }, latency_ms: latencyMs, model };
    },

    stats() {
      const calls = stats.calls;
      return {
        calls,
        input_tokens: 0,
        output_tokens: 0,
        latency_ms_total: stats.latency_ms_total,
        latency_ms_avg: calls ? Math.round(stats.latency_ms_total / calls) : 0,
        cost_usd: round(0, 6)
      };
    }
  };
}

module.exports = { createOpencodeClient, runOpencode, extractJson, buildPrompt, DEFAULT_MODEL, FREE_MODEL };
