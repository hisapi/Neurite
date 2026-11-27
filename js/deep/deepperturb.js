/* =============================================================================
 * deepperturb.js — perturbation iteration against a reference orbit
 * -----------------------------------------------------------------------------
 * For a point c = C + dc near the reference C, write z_n = Z_n + dz_n. Then
 *
 *     dz_{n+1} = (Z_n + dz_n)^d - Z_n^d + dc
 *
 * involves only small quantities, so doubles resolve it no matter how deep C
 * is. Two details make it work at any depth:
 *
 *   Scaled deltas. dz and dc are far below the smallest double once the view
 *   is deeper than ~1e-308, so they are carried as w * 2^-q with an explicit
 *   integer exponent q. w is renormalised whenever it leaves double range.
 *
 *   Rebasing. Whenever |Z_n + dz_n| < |dz_n| the delta is no longer small
 *   relative to the orbit; we then restart the reference from Z_0 = 0 with
 *   dz := z. This is exact, removes "glitches", and also lets a reference
 *   that has ended (escaped) keep serving points that have not.
 *
 * The derivative dz/dc is tracked alongside, likewise with its own exponent,
 * which gives an analytic gradient of the smooth escape-time field instead of
 * the fixed-epsilon finite difference the float path uses.
 *
 * Results are left in the fields of DeepPerturb to keep the hot loop free of
 * allocation. DOM-free.
 * ========================================================================== */

const DeepPerturb = {
    // --- outputs of run() ---
    n: 0,               // iterations completed
    escaped: false,
    zr: 0, zi: 0,       // z_n
    mag2: 0,            // |z_n|^2
    vr: 0, vi: 0,       // derivative dz_n/dl = (vr + i vi) * 2^-vq, l = local coords
    vq: 0,
    minN: 0,            // index n >= 1 of the smallest |z_n| seen
    capZr: 0, capZi: 0, // z and derivative captured at n === captureAt
    capVr: 0, capVi: 0, capVq: 0,
    captured: false,

    DOWN: 2 ** -400,
    BIG2: 1e240,        // ~ (2^400)^2

    /* ref:        { re, im, len, degree } reference orbit as doubles
     * dr, di, k:  the point is C + (dr + i di) * 2^-k
     * maxIter:    stop after this many iterations
     * bail2:      stop when |z|^2 exceeds this
     * deriv:      track dz/dl
     * captureAt:  optionally record z and its derivative at this iteration,
     *             after which derivative tracking stops (interior flows need
     *             the derivative at one fixed iteration, not at the end) */
    run(ref, dr, di, k, maxIter, bail2, deriv, captureAt = -1){
        if (ref.degree !== 2) {
            return this.runDegree(ref, dr, di, k, maxIter, bail2, deriv, captureAt);
        }

        const re = ref.re;
        const im = ref.im;
        const last = ref.len - 1;
        const ldexp = DeepNum.ldexp;
        const DOWN = this.DOWN;
        const BIG2 = this.BIG2;

        let wr = 0, wi = 0;             // dz = w * 2^-q
        let q = k;
        let Sq = ldexp(1, -q);          // 2^-q; 0 once q passes ~1074
        let dqr = dr, dqi = di;         // dc in units of 2^-q
        let vr = 0, vi = 0, vq = k;     // derivative, units of 2^-vq
        let vadd = 1;                   // the "+1" of the recurrence, in those units
        let m = 0;
        let n = 0;
        let zr = 0, zi = 0, mag2 = 0;
        let minMag2 = Infinity, minN = 0;
        this.captured = false;

        for (;;) {
            let Ar = re[m], Ai = im[m];
            let br = wr * Sq, bi = wi * Sq;
            zr = Ar + br;
            zi = Ai + bi;
            mag2 = zr * zr + zi * zi;
            if (mag2 > bail2 || n >= maxIter) break;

            if (n > 0 && mag2 < minMag2) {
                minMag2 = mag2;
                minN = n;
            }

            if (deriv) {
                if (n === captureAt) {
                    this.capZr = zr; this.capZi = zi;
                    this.capVr = vr; this.capVi = vi; this.capVq = vq;
                    this.captured = true;
                    deriv = false;
                } else {
                    const tr = 2 * (zr * vr - zi * vi) + vadd;
                    vi = 2 * (zr * vi + zi * vr);
                    vr = tr;
                    if (vr * vr + vi * vi > BIG2) {
                        vr *= DOWN; vi *= DOWN; vadd *= DOWN;
                        vq -= 400;
                    }
                }
            }

            if (m === last || mag2 < br * br + bi * bi) {
                // Rebase: delta becomes the full value, reference restarts.
                if (mag2 > 0) {
                    q = -Math.floor(0.5 * Math.log2(mag2));
                    wr = ldexp(zr, q);
                    wi = ldexp(zi, q);
                } else {
                    q = k;
                    wr = 0; wi = 0;
                }
                Sq = ldexp(1, -q);
                dqr = ldexp(dr, q - k);
                dqi = ldexp(di, q - k);
                Ar = 0; Ai = 0;
                br = zr; bi = zi;
                m = 0;
            }

            // w' = (2 Z + dz) w + dc
            const sr = 2 * Ar + br;
            const si = 2 * Ai + bi;
            const nr = sr * wr - si * wi + dqr;
            wi = sr * wi + si * wr + dqi;
            wr = nr;
            m += 1;
            n += 1;

            if (wr * wr + wi * wi > BIG2) {
                wr *= DOWN; wi *= DOWN; dqr *= DOWN; dqi *= DOWN;
                q -= 400;
                Sq = ldexp(1, -q);
            }
        }

        this.n = n;
        this.escaped = mag2 > bail2;
        this.zr = zr; this.zi = zi; this.mag2 = mag2;
        this.vr = vr; this.vi = vi; this.vq = vq;
        this.minN = minN;
        return this;
    },

    /* Same as run() for z^d + c with integer d > 2. The delta step is
     *   dz' = dz * sum_{j=1..d} C(d,j) Z^(d-j) dz^(j-1) + dc
     * evaluated by Horner in dz. */
    runDegree(ref, dr, di, k, maxIter, bail2, deriv, captureAt = -1){
        const re = ref.re;
        const im = ref.im;
        const last = ref.len - 1;
        const d = ref.degree;
        const binom = this.binomials(d);
        const ldexp = DeepNum.ldexp;
        const DOWN = this.DOWN;
        const BIG2 = this.BIG2;
        const pr = this.powRe;
        const pi = this.powIm;

        let wr = 0, wi = 0;
        let q = k;
        let Sq = ldexp(1, -q);
        let dqr = dr, dqi = di;
        let vr = 0, vi = 0, vq = k;
        let vadd = 1;
        let m = 0;
        let n = 0;
        let zr = 0, zi = 0, mag2 = 0;
        let minMag2 = Infinity, minN = 0;
        this.captured = false;

        for (;;) {
            let Ar = re[m], Ai = im[m];
            let br = wr * Sq, bi = wi * Sq;
            zr = Ar + br;
            zi = Ai + bi;
            mag2 = zr * zr + zi * zi;
            if (mag2 > bail2 || n >= maxIter) break;

            if (n > 0 && mag2 < minMag2) {
                minMag2 = mag2;
                minN = n;
            }

            if (deriv) {
                if (n === captureAt) {
                    this.capZr = zr; this.capZi = zi;
                    this.capVr = vr; this.capVi = vi; this.capVq = vq;
                    this.captured = true;
                    deriv = false;
                } else {
                    // v' = d z^(d-1) v + 1
                    let xr = 1, xi = 0;
                    for (let j = 1; j < d; j++) {
                        const t = xr * zr - xi * zi;
                        xi = xr * zi + xi * zr;
                        xr = t;
                    }
                    const tr = d * (xr * vr - xi * vi) + vadd;
                    vi = d * (xr * vi + xi * vr);
                    vr = tr;
                    if (vr * vr + vi * vi > BIG2) {
                        vr *= DOWN; vi *= DOWN; vadd *= DOWN;
                        vq -= 400;
                    }
                }
            }

            if (m === last || mag2 < br * br + bi * bi) {
                if (mag2 > 0) {
                    q = -Math.floor(0.5 * Math.log2(mag2));
                    wr = ldexp(zr, q);
                    wi = ldexp(zi, q);
                } else {
                    q = k;
                    wr = 0; wi = 0;
                }
                Sq = ldexp(1, -q);
                dqr = ldexp(dr, q - k);
                dqi = ldexp(di, q - k);
                Ar = 0; Ai = 0;
                br = zr; bi = zi;
                m = 0;
            }

            // Powers of Z: pr[j] + i pi[j] = Z^j
            pr[0] = 1; pi[0] = 0;
            for (let j = 1; j < d; j++) {
                pr[j] = pr[j - 1] * Ar - pi[j - 1] * Ai;
                pi[j] = pr[j - 1] * Ai + pi[j - 1] * Ar;
            }
            // H = sum_{j=1..d} C(d,j) Z^(d-j) dz^(j-1), Horner from j = d down
            let hr = binom[d], hi = 0;
            for (let j = d - 1; j >= 1; j--) {
                const t = hr * br - hi * bi + binom[j] * pr[d - j];
                hi = hr * bi + hi * br + binom[j] * pi[d - j];
                hr = t;
            }
            const nr = hr * wr - hi * wi + dqr;
            wi = hr * wi + hi * wr + dqi;
            wr = nr;
            m += 1;
            n += 1;

            if (wr * wr + wi * wi > BIG2) {
                wr *= DOWN; wi *= DOWN; dqr *= DOWN; dqi *= DOWN;
                q -= 400;
                Sq = ldexp(1, -q);
            }
        }

        this.n = n;
        this.escaped = mag2 > bail2;
        this.zr = zr; this.zi = zi; this.mag2 = mag2;
        this.vr = vr; this.vi = vi; this.vq = vq;
        this.minN = minN;
        return this;
    },

    powRe: new Float64Array(16),
    powIm: new Float64Array(16),
    binomCache: {},
    binomials(d){
        let row = this.binomCache[d];
        if (!row) {
            row = [1];
            for (let j = 1; j <= d; j++) row[j] = row[j - 1] * (d - j + 1) / j;
            this.binomCache[d] = row;
        }
        return row;
    },

    /* Smooth escape time of the last run, in the same form Fractal.dist uses. */
    mu(){
        return this.n - Math.log2(Math.log2(this.mag2) / 2);
    },

    /* Gradient of mu with respect to local coordinates, from the last run
     * (which must have escaped with deriv = true). Writes out.x / out.y.
     *
     *   mu = n - log2(log2|z|)   =>   grad mu = -conj(z'/z) / (ln2 * ln|z|)
     */
    gradMu(out){
        const zr = this.zr, zi = this.zi;
        const mag2 = this.mag2;
        // z'/z = v * conj(z) / |z|^2
        let rr = (this.vr * zr + this.vi * zi) / mag2;
        let ri = (this.vi * zr - this.vr * zi) / mag2;
        const f = -1 / (Math.LN2 * 0.5 * Math.log(mag2));
        rr *= f;
        ri *= f;
        const vq = this.vq;
        if (vq > 2000) {
            out.x = 0; out.y = 0;
        } else if (vq < -900) {
            const s = 1e150 / Math.hypot(rr, ri);
            out.x = rr * s; out.y = -ri * s;
        } else {
            out.x = DeepNum.ldexp(rr, -vq);
            out.y = DeepNum.ldexp(-ri, -vq);
        }
        return out;
    }
};
