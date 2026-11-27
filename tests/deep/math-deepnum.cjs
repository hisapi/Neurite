/* BigInt fixed-point helpers: float round trips, decimal parse/format,
 * mantissa-exponent scales, serialization. No browser needed. */
const assert = require('assert');
const D = require('./load.cjs')('js/deep/deepnum.js')('DeepNum');

for (const x of [1, -1, 0.1, 3.5e-300, -7.25e250, 5e-324, 123456789.125, Math.PI]) {
    const { m, e } = D.split(x);
    assert.strictEqual(D.ldexp(Number(m), e), x, 'split ' + x);
    assert.strictEqual(D.toFloat(D.fromFloat(x, 1200), 1200), x, 'round trip ' + x);
}
assert.strictEqual(D.fromFloat(0.75, 2), 3n);
assert.strictEqual(D.fromFloat(-0.75, 1), -1n);              // -1.5 rounds half up
assert.strictEqual(D.toFloat(1n << 5000n, 5000), 1);
assert.strictEqual(D.toFloat((1n << 5000n) + 12345n, 0), Infinity);
assert.strictEqual(D.toFloat(3n, 5000), 0);
assert.strictEqual(D.toFloat(-(3n << 4000n), 4001), -1.5);
assert.strictEqual(D.bitLength(255n), 8);
assert.strictEqual(D.bitLength(256n), 9);
assert.strictEqual(D.bitLength(-1n), 1);

const p = 400;
const long = '-0.7677840466850392123456789012345678901234567890123456789';
assert.strictEqual(D.toDecimal(D.parseDecimal(long, p), p, 55), long);
assert.strictEqual(D.toDecimal(D.parseDecimal('1.5e-30', 300), 300, 32), '0.00000000000000000000000000000150');
assert.strictEqual(D.toDecimal(D.parseDecimal('2.5e3', 10), 10, 1), '2500.0');
assert.strictEqual(D.toDecimal(D.parseDecimal('.5', 10), 10, 2), '0.50');
assert.strictEqual(D.parseDecimal('abc', 10), null);

assert.deepStrictEqual(D.sx(0.75), { m: 1.5, e: -1 });
assert.strictEqual(D.sxToFloat(D.sx(1.5, -3000), 3000), 1.5);
assert.strictEqual(D.sxToString(D.sx(1.25, -10000), 6).slice(-6), 'e-3011');
const q = D.sxParse('3.25e-4500');
assert.ok(Math.abs(D.sxLog2(q) - (Math.log2(3.25) - 4500 * Math.log2(10))) < 1e-9);
assert.strictEqual(D.sxToString(q, 6), '3.25e-4500');
assert.strictEqual(D.sxToString(D.sx(1), 6), '1e0');

for (const b of [0n, -1n, 12345678901234567890123n, -(1n << 300n)]) {
    assert.strictEqual(D.fromHex(D.toHex(b)), b);
}
console.log('PASS');
