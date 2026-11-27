/* Perturbation iteration vs brute-force BigInt iteration.
 *
 * Descends the boundary of z^d + c to a target depth, and at intervals
 * compares DeepPerturb against direct high-precision iteration at random
 * points of the view: the escape iteration must match exactly and the smooth
 * escape time closely. The analytic gradient is compared with a central
 * difference. No browser needed.
 *
 *   node math-perturb.cjs [depthBits=400] [degree=2]
 *
 * 1000 bits is ~1e-301; 1300 bits (~1e-391) exercises the path beyond the
 * double exponent range.
 */
const get = require('./load.cjs')('js/deep/deepnum.js', 'js/deep/reforbit.js', 'js/deep/deepperturb.js');
const D = get('DeepNum');
const RefOrbit = get('RefOrbit');
const P = get('DeepPerturb');

const TARGET_K = parseInt(process.argv[2] || '400', 10);
const DEGREE = parseInt(process.argv[3] || '2', 10);
const BAIL2 = 1e8;
const N = 20;

function brute(cx, cy, q, maxIter) {
    const bq = BigInt(q);
    const lim = BigInt(BAIL2) << bq;
    let zx = 0n, zy = 0n;
    for (let n = 0; ; n++) {
        const m2 = (zx * zx + zy * zy) >> bq;
        if (m2 > lim) return { n, escaped: true, mag2: D.toFloat(m2, q) };
        if (n >= maxIter) return { n, escaped: false };
        let ax = zx, ay = zy;
        for (let j = 1; j < DEGREE; j++) {
            const t = (ax * zx - ay * zy) >> bq;
            ay = (ax * zy + ay * zx) >> bq;
            ax = t;
        }
        zx = ax + cx;
        zy = ay + cy;
    }
}

function makeRef(cx, cy, q, want) {
    const orbit = new RefOrbit(cx, cy, q, DEGREE);
    const re = new Float64Array(want);
    const im = new Float64Array(want);
    orbit.run(want, re, im, 0);
    return { re, im, len: orbit.len, degree: DEGREE, escaped: orbit.escaped };
}

/* A boundary point to start from, by bisection along a ray in doubles. */
function boundaryStart() {
    const escapes = (x, y)=>{
        let zr = 0, zi = 0;
        for (let n = 0; n < 3000; n++) {
            let ar = zr, ai = zi;
            for (let j = 1; j < DEGREE; j++) {
                const t = ar * zr - ai * zi;
                ai = ar * zi + ai * zr;
                ar = t;
            }
            zr = ar + x;
            zi = ai + y;
            if (zr * zr + zi * zi > 16) return true;
        }
        return false;
    };
    const ux = Math.cos(1.1), uy = Math.sin(1.1);
    let lo = 0, hi = 1.5;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (escapes(mid * ux, mid * uy)) hi = mid; else lo = mid;
    }
    return [lo * ux, lo * uy];
}

let q = 256;
let k, cx, cy;
if (DEGREE === 2) {
    k = 4;
    cx = D.parseDecimal('-0.743643887037151', q);   // seahorse valley
    cy = D.parseDecimal('0.131825904205330', q);
} else {
    const [x, y] = boundaryStart();
    k = 30;
    cx = D.fromFloat(x, q);
    cy = D.fromFloat(y, q);
}

let maxIter = 400;
let checked = 0, compared = 0, mismatches = 0, worstMu = 0, worstGrad = 0;
let nextCheck = 40;
const g = { x: 0, y: 0 };
const t0 = Date.now();

while (k < TARGET_K) {
    if (q < k + 128) {
        const nq = k + 320;
        cx <<= BigInt(nq - q);
        cy <<= BigInt(nq - q);
        q = nq;
    }
    const ref = makeRef(cx, cy, q, maxIter + 2);
    const lim = ref.escaped ? maxIter : Math.min(maxIter, ref.len - 1);

    // Sample the view [-1, 1]^2 * 2^-k.
    const mu = new Float64Array(N * N);
    let inside = 0;
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            P.run(ref, (i / (N - 1)) * 2 - 1, (j / (N - 1)) * 2 - 1, k, lim, BAIL2, false);
            if (P.escaped) mu[j * N + i] = P.mu();
            else { mu[j * N + i] = lim; inside += 1; }
        }
    }
    if (inside > 0.5 * N * N && maxIter < 3e5) {
        maxIter = Math.ceil(maxIter * 1.5);
        continue;
    }

    if (k >= nextCheck || k + 6 >= TARGET_K) {
        nextCheck = k + Math.max(40, TARGET_K / 6);
        for (let s = 0; s < 6; s++) {
            const dr = Math.random() * 2 - 1;
            const di = Math.random() * 2 - 1;
            P.run(ref, dr, di, k, lim, BAIL2, true);
            const pn = P.n, pesc = P.escaped;
            const pmu = pesc ? P.mu() : lim;
            if (pesc) P.gradMu(g);
            const gx = g.x, gy = g.y;

            const b = brute(cx + D.fromFloat(dr, q - k), cy + D.fromFloat(di, q - k), q, lim);
            checked += 1;
            if (b.escaped !== pesc || b.n !== pn) {
                mismatches += 1;
                console.log(`MISMATCH at 2^-${k}: perturbation ${pn}/${pesc}, brute force ${b.n}/${b.escaped}`);
                continue;
            }
            if (!pesc) continue;

            compared += 1;
            worstMu = Math.max(worstMu, Math.abs(b.n - Math.log2(Math.log2(b.mag2) / 2) - pmu));

            const h = 1e-6;
            const at = (x, y)=>{ P.run(ref, x, y, k, lim, BAIL2, false); return P.mu() };
            const fx = (at(dr + h, di) - at(dr - h, di)) / (2 * h);
            const fy = (at(dr, di + h) - at(dr, di - h)) / (2 * h);
            const gm = Math.hypot(gx, gy);
            // Only where the difference quotient is itself trustworthy.
            if (gm * h < 0.05 && gm * h > 1e-9) {
                worstGrad = Math.max(worstGrad, Math.hypot(fx - gx, fy - gy) / gm);
            }
        }
    }

    // Step to the strongest boundary sample, discounting very high iteration
    // counts so the walk does not drift into a cusp.
    let best = -1, bi = 0, bj = 0;
    for (let j = 1; j < N - 1; j++) {
        for (let i = 1; i < N - 1; i++) {
            const c = mu[j * N + i];
            const contrast = Math.max(
                Math.abs(c - mu[j * N + i - 1]), Math.abs(c - mu[j * N + i + 1]),
                Math.abs(c - mu[(j - 1) * N + i]), Math.abs(c - mu[(j + 1) * N + i])
            );
            const r = Math.hypot((i / (N - 1)) * 2 - 1, (j / (N - 1)) * 2 - 1);
            const score = Math.min(contrast, 3) / (1 + c / (20 + 4 * k))
                        * Math.exp(-r * r * 2) * (c >= lim ? 0.2 : 1);
            if (score > best) { best = score; bi = i; bj = j; }
        }
    }
    cx += D.fromFloat((bi / (N - 1)) * 2 - 1, q - k);
    cy += D.fromFloat((bj / (N - 1)) * 2 - 1, q - k);
    k += 3;
}

console.log(`degree ${DEGREE}, depth 2^-${k} (~1e-${Math.round(k * 0.30103)}): `
    + `${checked} points checked, ${compared} escaping, ${mismatches} mismatches, `
    + `worst |mu error| ${worstMu.toExponential(2)}, worst gradient error ${worstGrad.toExponential(2)}, `
    + `${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('re ' + D.toDecimal(cx, q, Math.ceil(k * 0.30103) + 4));
console.log('im ' + D.toDecimal(cy, q, Math.ceil(k * 0.30103) + 4));

const failures = [];
if (mismatches > 0) failures.push('escape iterations differ from brute force');
if (compared < 6) failures.push('too few escaping points compared to be meaningful');
if (worstMu > 1e-4) failures.push('smooth escape time differs from brute force');
if (worstGrad > 1e-3) failures.push('analytic gradient disagrees with central difference');
for (const f of failures) console.log('FAIL: ' + f);
console.log(failures.length === 0 ? 'PASS' : `${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
