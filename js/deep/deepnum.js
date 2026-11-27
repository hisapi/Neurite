/* =============================================================================
 * deepnum.js — arbitrary-precision helpers for deep-zoom coordinates
 * -----------------------------------------------------------------------------
 * Everything "absolute" in deep mode is a BigInt fixed-point number: the pair
 * (m, p) means m * 2^-p. Doubles are only ever used for quantities that are
 * small relative to the current view, which is where 53 bits is plenty.
 *
 * Two representations are used throughout:
 *   fixed   BigInt m with an explicit precision p     -> positions
 *   sx      { m: double in [1,2), e: integer }        -> positive scales, where
 *           only ~15 significant digits matter but the exponent is unbounded
 *
 * This file is DOM-free and is loaded both by the page and by the reference
 * orbit worker.
 * ========================================================================== */

const DeepNum = (() => {
    'use strict';

    const view = new DataView(new ArrayBuffer(8));
    const P1000 = 2 ** 1000;
    const N1000 = 2 ** -1000;

    /* x * 2^e without intermediate overflow, for any integer e. */
    function ldexp(x, e) {
        if (x === 0 || !Number.isFinite(x) || e === 0) return x;
        while (e > 1000) {
            x *= P1000; e -= 1000;
            if (!Number.isFinite(x)) return x;
        }
        while (e < -1000) {
            x *= N1000; e += 1000;
            if (x === 0) return x;
        }
        return x * 2 ** e;
    }

    /* Finite double -> { m: BigInt, e } with x === m * 2^e exactly. */
    function split(x) {
        if (x === 0 || !Number.isFinite(x)) return { m: 0n, e: 0 };
        view.setFloat64(0, x);
        const hi = view.getUint32(0);
        const lo = view.getUint32(4);
        const biased = (hi >>> 20) & 0x7ff;
        let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
        let e = -1074;
        if (biased !== 0) {
            m |= 1n << 52n;
            e = biased - 1075;
        }
        return { m: (hi >>> 31) ? -m : m, e };
    }

    /* round(x * 2^p) as a BigInt. */
    function fromFloat(x, p) {
        const { m, e } = split(x);
        const s = e + p;
        if (s >= 0) return m << BigInt(s);
        if (s < -64) return 0n; // |m| < 2^53, so it rounds away entirely
        const sh = BigInt(-s);
        return (m + (1n << (sh - 1n))) >> sh;
    }

    function bitLength(m) {
        if (m < 0n) m = -m;
        if (m === 0n) return 0;
        const hex = m.toString(16);
        return (hex.length - 1) * 4 + (32 - Math.clz32(parseInt(hex[0], 16)));
    }

    /* m * 2^-p as a double. Returns +-Infinity or 0 when out of range. */
    function toFloat(m, p) {
        if (m === 0n) return 0;
        // Fast path: anything below 2^960 converts exactly-rounded by Number().
        const n = Number(m);
        if (Math.abs(n) < 1e289) return ldexp(n, -p);
        const sh = bitLength(m) - 64;
        return ldexp(Number(m >> BigInt(sh)), sh - p);
    }

    /* Shift by a signed bit count; right shifts round toward -infinity. */
    function shift(m, bits) {
        if (bits === 0) return m;
        return bits > 0 ? m << BigInt(bits) : m >> BigInt(-bits);
    }

    /* Re-express a fixed-point value at another precision. */
    function rescale(m, pFrom, pTo) { return shift(m, pTo - pFrom) }

    // ------------------------------------------------------------------ sx --

    /* Positive double (optionally with an extra binary exponent) -> sx. */
    function sx(v, extraExp = 0) {
        if (!(v > 0) || !Number.isFinite(v)) return { m: 1, e: -Infinity };
        let e = Math.floor(Math.log2(v));
        let m = ldexp(v, -e);
        if (m >= 2) { m /= 2; e += 1; }
        else if (m < 1) { m *= 2; e -= 1; }
        return { m, e: e + extraExp };
    }
    function sxToFloat(s, extraExp = 0) { return ldexp(s.m, s.e + extraExp) }
    function sxLog2(s) { return s.e + Math.log2(s.m) }
    function sxFromLog2(l) {
        const e = Math.floor(l);
        return { m: 2 ** (l - e), e };
    }

    // ------------------------------------------------------------ decimals --

    const DEC = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/;

    /* Decimal string -> round(value * 2^p). Returns null if unparseable. */
    function parseDecimal(str, p) {
        const mt = DEC.exec(String(str));
        if (!mt || (!mt[2] && !mt[3])) return null;
        const frac = mt[3] || '';
        const digits = BigInt((mt[2] || '0') + frac);
        const exp10 = (mt[4] ? parseInt(mt[4], 10) : 0) - frac.length;
        let val;
        if (exp10 >= 0) {
            val = shift(digits * 10n ** BigInt(exp10), p);
        } else {
            const den = 10n ** BigInt(-exp10);
            val = shift(digits, p + 1) / den;        // one guard bit
            val = (val + 1n) >> 1n;
        }
        return mt[1] === '-' ? -val : val;
    }

    /* m * 2^-p -> decimal string with fracDigits digits after the point. */
    function toDecimal(m, p, fracDigits) {
        const neg = m < 0n;
        if (neg) m = -m;
        const scaled = m * 10n ** BigInt(fracDigits);
        const q = p > 0 ? (scaled + (1n << BigInt(p - 1))) >> BigInt(p)
                        : scaled << BigInt(-p);
        let s = q.toString();
        if (fracDigits > 0) {
            s = s.padStart(fracDigits + 1, '0');
            s = s.slice(0, -fracDigits) + '.' + s.slice(-fracDigits);
        }
        return (neg && q !== 0n ? '-' : '') + s;
    }

    /* sx -> "1.2345e-4500". */
    function sxToString(s, digits = 12) {
        if (s.e === -Infinity) return '0';
        const l10 = sxLog2(s) * Math.LOG10E * Math.LN2;
        let e10 = Math.floor(l10);
        let mant = 10 ** (l10 - e10);
        const shown = Number(mant.toPrecision(digits));
        if (shown >= 10) { mant = shown / 10; e10 += 1; }
        return Number(mant.toPrecision(digits)) + 'e' + e10;
    }

    /* "1.2345e-4500" (or any positive decimal) -> sx. Returns null if bad. */
    function sxParse(str) {
        const mt = DEC.exec(String(str));
        if (!mt || (!mt[2] && !mt[3]) || mt[1] === '-') return null;
        const mant = parseFloat((mt[2] || '0') + '.' + (mt[3] || '0'));
        if (!(mant > 0)) return null;
        const e10 = mt[4] ? parseInt(mt[4], 10) : 0;
        return sxFromLog2(Math.log2(mant) + e10 * Math.LOG2E * Math.LN10);
    }

    // -------------------------------------------------------- serialization --

    function toHex(m) { return m < 0n ? '-' + (-m).toString(16) : m.toString(16) }
    function fromHex(s) {
        return s[0] === '-' ? -BigInt('0x' + s.slice(1)) : BigInt('0x' + s);
    }

    return {
        ldexp, split, fromFloat, toFloat, bitLength, shift, rescale,
        sx, sxToFloat, sxLog2, sxFromLog2, sxToString, sxParse,
        parseDecimal, toDecimal, toHex, fromHex
    };
})();
