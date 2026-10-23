const fs = require('fs');
const path = require('path');

function safeLabel(value) {
  return String(value || 'evidence').replace(/[^A-Za-z0-9._-]+/g, '_');
}

/**
 * Capture artifacts into an existing report directory.
 * Page source is the decision source; screenshots remain visual evidence.
 */
async function captureEvidence(driver, {
  dir,
  label = 'evidence',
  pageSource = true,
  screenshot = true,
} = {}) {
  if (!driver) return [];
  if (!dir) throw new Error('captureEvidence requires "dir"');

  fs.mkdirSync(dir, { recursive: true });
  const base = safeLabel(label);
  const artifacts = [];

  if (pageSource) {
    try {
      const xmlPath = path.join(dir, `${base}.xml`);
      fs.writeFileSync(xmlPath, await driver.getPageSource());
      artifacts.push(xmlPath);
    } catch {}
  }

  if (screenshot) {
    try {
      const imagePath = path.join(dir, `${base}.png`);
      await driver.saveScreenshot(imagePath);
      artifacts.push(imagePath);
    } catch {}
  }

  return artifacts;
}

module.exports = { captureEvidence };
