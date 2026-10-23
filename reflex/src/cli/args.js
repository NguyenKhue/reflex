/** args.js — `--k v`, `--k=v`, boolean `--flag`, `--no-x` (→ x: false); the rest are positionals. */
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--') || token === '--') {
      out._.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      out.flags[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (body.startsWith('no-')) {
      out.flags[body.slice(3)] = false;
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      out.flags[body] = argv[i + 1];
      i += 1;
    } else {
      out.flags[body] = true;
    }
  }
  return out;
}

/** A flag that must carry a value; `true` (bare flag) counts as missing. */
function str(flags, key) {
  const value = flags[key];
  return value === undefined || value === true || value === false ? null : String(value);
}

module.exports = { parseArgs, str };
