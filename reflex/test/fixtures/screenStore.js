/**
 * screenStore.js — build a `screens/` knowledge tree on disk from a plain JS object, so a
 * test can describe the knowledge it needs inline instead of maintaining static fixture
 * directories. Only what the object mentions is written: a screen without `normal` has no
 * `normal.yml` at all, which is how the "missing optional file = empty" rule gets covered.
 *
 * ```
 * writeStore(root, {
 *   shared: { exceptions: [rule] },                       // screens/_shared/exceptions.yml
 *   apps: {
 *     example: {                                          // screens/example/
 *       app: { context, exceptions, routes },              // screens/<app>/_app/
 *       groups: {
 *         core: {                                         // screens/<app>/core/
 *           miniapp: { context, exceptions },             // screens/<app>/core/_miniapp/
 *           screens: {
 *             home: { identify, inputs, body, normal, exceptions, id, omitId },
 *           },
 *         },
 *       },
 *     },
 *   },
 * })
 * ```
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** js-yaml dump: the readers (store.js) parse with the `yaml` package, which reads either. */
function dump(value) {
  return yaml.dump(value, { noRefs: true, lineWidth: 200, skipInvalid: true });
}

function writeYml(file, value) {
  write(file, dump(value));
}

function writeScreenMarkdown(file, group, name, screen) {
  const meta = {};
  if (screen.omitId !== true) meta.id = screen.id === undefined ? `${group}/${name}` : screen.id;
  if (screen.identify !== undefined) meta.identify = screen.identify;
  if (screen.inputs !== undefined) meta.inputs = screen.inputs;
  const body = screen.body === undefined ? '' : screen.body;
  write(file, `---\n${yaml.dump(meta, { noRefs: true, lineWidth: 200 })}---\n${body}\n`);
}

function writeGroup(dir, group) {
  if (group.miniapp) {
    const miniappDir = path.join(dir, '_miniapp');
    if (group.miniapp.context !== undefined) write(path.join(miniappDir, 'context.md'), `${group.miniapp.context}\n`);
    if (group.miniapp.exceptions !== undefined) writeYml(path.join(miniappDir, 'exceptions.yml'), group.miniapp.exceptions);
  }
  for (const [name, screen] of Object.entries(group.screens || {})) {
    const screenDir = path.join(dir, name);
    writeScreenMarkdown(path.join(screenDir, 'screen.md'), path.basename(dir), name, screen);
    if (screen.normal !== undefined) writeYml(path.join(screenDir, 'normal.yml'), screen.normal);
    if (screen.exceptions !== undefined) writeYml(path.join(screenDir, 'exceptions.yml'), screen.exceptions);
  }
}

function writeApp(dir, entry) {
  const tier = entry.app || {};
  const appTier = path.join(dir, '_app');
  if (tier.context !== undefined) write(path.join(appTier, 'context.md'), `${tier.context}\n`);
  if (tier.exceptions !== undefined) writeYml(path.join(appTier, 'exceptions.yml'), tier.exceptions);
  if (tier.routes !== undefined) writeYml(path.join(appTier, 'routes.yml'), tier.routes.map((item) => ({ path: item })));
  for (const [name, group] of Object.entries(entry.groups || {})) writeGroup(path.join(dir, name), group);
}

/** Write the tree under `<root>/screens/` and return `root`. */
function writeStore(root, tree) {
  const screens = path.join(root, 'screens');
  if (tree.shared && tree.shared.exceptions !== undefined) {
    writeYml(path.join(screens, '_shared', 'exceptions.yml'), tree.shared.exceptions);
  }
  for (const [name, app] of Object.entries(tree.apps || {})) writeApp(path.join(screens, name), app);
  return root;
}

module.exports = { writeStore };
