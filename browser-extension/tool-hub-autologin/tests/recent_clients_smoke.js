// content-recent-clients.js: the "Recent" group in every tool's Client picker.
// The server marks the logged-in user's recent picks with recentRank (one
// Chrome profile is often shared, so nothing is kept in the browser). Loads
// the real helper, then checks every task modal and manifest entry uses it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const sandbox = { document: { createElement: () => ({ style: {}, setAttribute() {} }) }, Number, Array, Object };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'content-recent-clients.js'), 'utf8'), sandbox);
const recent = sandbox.rmwRecentClients;

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name);
  if (!cond) { failures += 1; if (extra !== undefined) console.log('        ' + JSON.stringify(extra)); }
};
const labels = (list) => list.map((entry) => recent.headingLabel(entry) || entry.name);
const clients = (ranks = {}) => Array.from({ length: 40 }, (_, i) => ({
  id: i + 1, name: `Client ${i + 1}`, recentRank: ranks[i + 1] ?? null,
}));

const plain = clients();
check('no recent picks: list unchanged, no headings', recent.arrange(plain, false) === plain);

const ranked = clients({ 31: 1, 7: 2 });
const arranged = recent.arrange(ranked, false);
check('Recent group on top, most recent first',
  JSON.stringify(labels(arranged).slice(0, 5)) === JSON.stringify(['Recent', 'Client 31', 'Client 7', 'All clients', 'Client 1']),
  labels(arranged).slice(0, 5));
check('All clients still lists every client, recent ones included',
  labels(arranged).slice(4).length === 40 && labels(arranged).slice(4).includes('Client 31'));
check('while searching, matches are shown as-is', recent.arrange(ranked.slice(0, 3), true).length === 3);
check('garbage ranks are ignored', recent.arrange(clients({ 3: 'x', 4: 0 }), false).length === 40);

const modals = fs.readdirSync(ROOT).filter((name) => /^content-.*-task-modal\.js$/.test(name));
const unwired = modals.filter((name) => {
  const src = fs.readFileSync(path.join(ROOT, name), 'utf8');
  return !src.includes('recentClients.arrange(visible, Boolean(q))') || /chrome\.storage|localStorage/.test(src.match(/recentClients[\s\S]{0,400}/)?.[0] || '');
});
check(`all ${modals.length} task modals show the Recent group`, modals.length >= 11 && !unwired.length, unwired);
check('nothing about recent clients is kept in the browser',
  !/chrome\.storage|localStorage/.test(fs.readFileSync(path.join(ROOT, 'content-recent-clients.js'), 'utf8').replace(/\/\/.*$/gm, '')));

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const badEntries = manifest.content_scripts
  .map((entry) => entry.js || [])
  .filter((js) => js.some((name) => /-task-modal\.js$/.test(name)))
  .filter((js) => {
    const helper = js.indexOf('content-recent-clients.js');
    return helper === -1 || helper > js.findIndex((name) => /-task-modal\.js$/.test(name));
  });
check('manifest loads the helper before every task modal', !badEntries.length, badEntries);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
