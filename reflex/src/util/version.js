/**
 * version.js — what `reflex version` reports: the package version, the plugin contract version and the Node it runs on.
 */
const { CONTRACT_VERSION } = require('../core/contracts');
const pkg = require('../../package.json');

function versionInfo() {
  return { version: pkg.version, contracts: CONTRACT_VERSION, node: process.version };
}

function versionLine(info = versionInfo()) {
  return `reflex ${info.version} (contracts ${info.contracts}, node ${info.node})`;
}

module.exports = { versionInfo, versionLine };
