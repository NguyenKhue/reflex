/**
 * builtins.js — today's implementations, registered under stable names. Requires are lazy: the optional
 * dependencies (agent-device, @typesafe-ai/sdk) may not be installed, and a registry must still build.
 */
const { createRegistry } = require('./registry');

function createDefaultRegistry() {
  const registry = createRegistry();
  registry.register('device', 'agent-device', (options) => require('../device/deviceBackend').createDeviceBackend(options));
  registry.register('device', 'mock', (options) => require('../device/deviceBackend').createMockBackend(options));
  registry.register('decider', 'jev', (options = {}) => {
    const jev = options.jev || require('../jev/jevClient').createJevClient(options.client);
    return require('./deciders/jev').createJevDecider(jev);
  });
  registry.register('decider', 'opencode', (options = {}) => {
    const client = options.jev || require('../jev/opencodeClient').createOpencodeClient(options.client);
    return require('./deciders/jev').createJevDecider(client);
  });
  registry.register('account', 'env', (options = {}) => require('./accounts/env').createEnvAccountProvider(options));
  registry.register('otp', 'http', (options = {}) => require('./otp/http').createHttpOtpProvider(options));
  registry.register('reporter', 'upload', (options = {}) => require('./reporters/upload').createUploadReporter(options));
  registry.register('reporter', 'google-chat', (options = {}) => require('./reporters/googleChat').createGoogleChatReporter(options));
  return registry;
}

module.exports = { createDefaultRegistry };
