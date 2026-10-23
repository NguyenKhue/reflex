/** A 6-digit numeric login password doubles as the wallet PIN. */
function isSixDigitPin(value) {
  return /^\d{6}$/.test(String(value || '').trim());
}

module.exports = { isSixDigitPin };
