/**
 * jev.js — adapt a Jev client (ask(state, questions)) to the decider contract (decide({ state, instruction, options })).
 *
 * The core asks one closed-set question: pick one id from `options` ({ id: description }). Jev answers that as a `choice`
 * question; any other model plugs in by implementing `decide` directly. Confidence is passed through untouched: deciding
 * what an absent confidence means is the caller's policy (resolver.js treats it as 1).
 */
const { choice } = require('../../jev/jevClient');

function createJevDecider(jev) {
  if (!jev || typeof jev.ask !== 'function') {
    throw new Error('createJevDecider needs a Jev client with ask(state, questions)');
  }
  return {
    async decide({ state, instruction, options }) {
      const response = await jev.ask(state, { nextAction: choice(instruction, options) });
      const answer = (response && response.answers && response.answers.nextAction) || {};
      return {
        choice: answer.choice,
        confidence: answer.confidence,
        usage: response && response.usage,
        latency_ms: response && response.latency_ms,
        model: response && response.model,
      };
    },
  };
}

module.exports = { createJevDecider };