/* Shared helpers for the browser tests.
 *
 * The tests drive the real app in headless Chromium through Playwright. They
 * expect the dev server to be running (npm start) at NEURITE_URL, default
 * http://localhost:8080/.
 *
 * NEURITE_CDN_DIR  optional. A node_modules directory holding the libraries
 *                  index.html loads from CDNs (codemirror@5, localforage,
 *                  pdfjs-dist, prismjs, dompurify, marked@4). When set, CDN
 *                  requests are served from it, for machines without CDN access.
 * NEURITE_SHOTS    optional. Directory to write screenshots into.
 */
const fs = require('fs');
const path = require('path');

let chromium;
try {
    ({ chromium } = require('playwright'));
} catch (err) {
    console.error("These tests need Playwright:  npm install --no-save playwright && npx playwright install chromium");
    process.exit(2);
}

const URL = process.env.NEURITE_URL || 'http://localhost:8080/';
const CDN = process.env.NEURITE_CDN_DIR;
const SHOTS = process.env.NEURITE_SHOTS;
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

function localFor(url) {
    let m;
    if ((m = url.match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/(@?[^@/]+)(?:@[^/]+)?\/(.+)$/))) {
        return path.join(CDN, m[1], m[2]);
    }
    if ((m = url.match(/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/codemirror\/[^/]+\/(.+)$/))) {
        return path.join(CDN, 'codemirror', m[1].replace('.min.js', '.js'));
    }
    if ((m = url.match(/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/prism\/[^/]+\/(.+)$/))) {
        return path.join(CDN, 'prismjs', m[1] === 'prism.min.js' ? 'prism.js' : m[1]);
    }
    if (/dompurify\/[^/]+\/purify\.min\.js/.test(url)) return path.join(CDN, 'dompurify/dist/purify.min.js');
    return null;
}

// Console noise from optional local services that are not running under test.
const IGNORED = /Failed to load resource|ERR_|localhost:7070|Localhost Servers|11434|model tags/;

const failures = [];

/* Record a failed expectation; the run exits non-zero in finish(). */
function check(ok, message, detail) {
    if (ok) return true;
    failures.push(message);
    console.log('FAIL: ' + message + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
    return false;
}

async function open(opts = {}) {
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: opts.viewport || { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errs = [];
    page.on('pageerror', (e)=>errs.push('PAGEERR ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
    page.on('console', (m)=>{
        if (m.type() === 'error' && !IGNORED.test(m.text())) errs.push('CONSOLE ' + m.text().slice(0, 400));
    });
    if (CDN) {
        const origin = new globalThis.URL(URL).origin;
        await page.route( (u)=>!u.toString().startsWith(origin), (route)=>{
            const file = localFor(route.request().url());
            if (file && fs.existsSync(file)) {
                return route.fulfill({
                    status: 200,
                    contentType: TYPES[path.extname(file)] || 'text/plain',
                    body: fs.readFileSync(file)
                });
            }
            return route.abort();
        });
    }
    try {
        await page.goto(URL, { waitUntil: 'load' });
    } catch (err) {
        console.error("Could not reach " + URL + " — start the dev server first (npm start).");
        await browser.close();
        process.exit(2);
    }
    await page.waitForFunction( ()=>window.appReady === true, null, { timeout: 60000 });
    await page.waitForTimeout(opts.settle ?? 1500);
    return { browser, page, errs };
}

/* Frames per second over `ms`, with the worst single frame. Informational:
 * it depends on the machine, so tests print it rather than assert on it. */
function fps(page, ms = 2000) {
    return page.evaluate( (ms)=>new Promise( (resolve)=>{
        let n = 0, worst = 0, last = performance.now();
        const t0 = last;
        function tick() {
            const now = performance.now();
            worst = Math.max(worst, now - last);
            last = now;
            n += 1;
            if (now - t0 > ms) resolve({ fps: Math.round(n / (now - t0) * 1000), worstMs: Math.round(worst) });
            else requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
    }), ms);
}

function frames(page, n) {
    return page.evaluate( (n)=>new Promise( (resolve)=>{
        let i = 0;
        (function tick() { if (++i > n) resolve(); else requestAnimationFrame(tick); })();
    }), n);
}

async function shot(page, name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}

/* Close the browser, assert the page raised no errors, set the exit code. */
async function finish(browser, errs) {
    if (browser) await browser.close();
    if (errs) check(errs.length === 0, 'page raised no errors', errs.slice(0, 5));
    console.log(failures.length === 0 ? 'PASS' : `${failures.length} FAILED`);
    process.exit(failures.length === 0 ? 0 : 1);
}

function run(main) {
    main().catch( (err)=>{
        console.error(err);
        process.exit(1);
    });
}

// Boundary coordinates found by math-perturb.cjs, used as flight targets.
const COORDS = {
    61: {
        re: '-0.74938808121558323096724033415053661527536711712929195480496671550',
        im: '0.13567015479653154261294311892173596538398871692019705784360678165'
    },
    301: {
        re: '-0.749388081215583230967240334150536615275367117129291954804966677478684634586233819311721862831855912176804354781270852660020502839508548955065153729102003700152519946169711836359928294649266525932081296798135814111607703552253258282356003044620691311690617437930667635327318977454939448422087531365315785074',
        im: '0.135670154796531542612943118921735965383988716920197057843606664449558497845175234775259143739597958803648484667490795191942924647534434128652456256503416790587289591314950920928486462770652892624568280238330531554423816441550699204194869400981338116568305054354332138268663118891864049845622585826251715115'
    },
    391: {
        re: '-0.749388081215583230967240334150536615275367117129291954804966677478684634586233819311721862831855912176804354781270852660020502839508548955065153729102003700152519946169711836359928294649266525932081296798135814111607703552253258282356003044620691311690617437930667635327318977454939448422087531365315734212222081171444894525962740640978149401016198012687528443731966825011159572716682556231004137',
        im: '0.135670154796531542612943118921735965383988716920197057843606664449558497845175234775259143739597958803648484667490795191942924647534434128652456256503416790587289591314950920928486462770652892624568280238330531554423816441550699204194869400981338116568305054354332138268663118891864049845622585826251666892182956483125398914412017399269177663306874730356780975702258963970395834747155197492399228'
    }
};

module.exports = { open, fps, frames, shot, check, finish, run, COORDS };
