/* Runs the whole suite in order and summarises.  node tests/deep/run.cjs
 * Pass --quick to skip the 100,000-note store test. */
const { spawnSync } = require('child_process');
const path = require('path');

const quick = process.argv.includes('--quick');
const suite = [
    ['math-deepnum.cjs'],
    ['math-perturb.cjs', '400'],
    ['math-perturb.cjs', '1300'],
    ['math-perturb.cjs', '130', '3'],
    ['deep-flights.cjs'],
    ['transitions.cjs'],
    ['stock-notes.cjs'],
    ['store-basic.cjs'],
    ['crawl.cjs', '60'],
    ...(quick ? [] : [['store-100k.cjs']])
];

const results = [];
for (const [file, ...args] of suite) {
    const label = [file, ...args].join(' ');
    console.log('\n=== ' + label + ' ===');
    const t0 = Date.now();
    const out = spawnSync(process.execPath, [path.join(__dirname, file), ...args], { stdio: 'inherit' });
    results.push({ label, ok: out.status === 0, seconds: ((Date.now() - t0) / 1000).toFixed(1) });
    if (out.status === 2) break; // environment problem (no server / no Playwright): stop
}

console.log('\n=== summary ===');
for (const r of results) console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.label}  (${r.seconds}s)`);
process.exit(results.length === suite.length && results.every( (r)=>r.ok ) ? 0 : 1);
