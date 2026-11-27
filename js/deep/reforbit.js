/* =============================================================================
 * reforbit.js — high-precision reference orbit for perturbation rendering
 * -----------------------------------------------------------------------------
 * Iterates Z -> Z^d + C from Z = 0 in BigInt fixed point with q fractional
 * bits, and emits each Z_n rounded to a double. One orbit like this is the
 * only arbitrary-precision work deep zoom needs: every other point on screen
 * is computed in doubles as a small difference from it (see deepfractal.js).
 *
 * DOM-free. Runs in refworker.js, or on the main thread in time slices when
 * workers are unavailable.
 * ========================================================================== */

class RefOrbit {
    static ESCAPE2 = 1e10; // run well past the perturbation bailout (1e8)

    constructor(cx, cy, q, degree = 2){
        this.cx = cx;           // BigInt, q fractional bits
        this.cy = cy;
        this.q = q;
        this.degree = degree;
        this.zx = 0n;
        this.zy = 0n;
        this.len = 0;           // points emitted so far: Z_0 .. Z_{len-1}
        this.escaped = false;

        this.bq = BigInt(q);
        const sh = Math.max(0, q - 62);
        this.bsh = BigInt(sh);
        this.conv = 2 ** -(q - sh);
    }

    /* Rounded to double with full relative precision even when |v| is tiny:
     * the orbit passes close to zero near minibrots, and that is exactly where
     * the perturbation needs it most. */
    #toDouble(v){
        const t = Number(v >> this.bsh);
        if (t > 1099511627776 || t < -1099511627776) return t * this.conv;
        return DeepNum.toFloat(v, this.q);
    }

    /* Emit up to `count` further points into re/im starting at index `at`.
     * Returns how many were written. Stops early once the orbit escapes. */
    run(count, re, im, at){
        const q = this.bq;
        const cx = this.cx;
        const cy = this.cy;
        const degree = this.degree;
        let zx = this.zx;
        let zy = this.zy;
        let written = 0;

        while (written < count && !this.escaped) {
            const x = this.#toDouble(zx);
            const y = this.#toDouble(zy);
            re[at + written] = x;
            im[at + written] = y;
            written += 1;
            if (x * x + y * y > RefOrbit.ESCAPE2) {
                this.escaped = true;
                break;
            }

            if (degree === 2) {
                const nx = ((zx * zx - zy * zy) >> q) + cx;
                zy = ((zx * zy) >> (q - 1n)) + cy;
                zx = nx;
            } else {
                let ax = zx;
                let ay = zy;
                for (let j = 1; j < degree; j++) {
                    const tx = (ax * zx - ay * zy) >> q;
                    ay = (ax * zy + ay * zx) >> q;
                    ax = tx;
                }
                zx = ax + cx;
                zy = ay + cy;
            }
        }

        this.zx = zx;
        this.zy = zy;
        this.len += written;
        return written;
    }
}
