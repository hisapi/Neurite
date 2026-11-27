/* =============================================================================
 * refworker.js — computes reference orbits off the main thread
 * -----------------------------------------------------------------------------
 * Protocol (all messages carry the job id):
 *   -> { type: 'start',  id, cx, cy, q, degree, want }   cx/cy are hex BigInts
 *   -> { type: 'extend', id, want }
 *   -> { type: 'abort',  id }
 *   <- { type: 'chunk',  id, at, re, im, escaped, done }
 *
 * Jobs are advanced round-robin in ~20 ms slices so that an abort or a newer
 * job is picked up promptly even while a very deep orbit is in flight.
 * ========================================================================== */

importScripts('deepnum.js', 'reforbit.js');

const jobs = new Map();
let pumping = false;
const SLICE_MS = 20;

onmessage = (e)=>{
    const msg = e.data;
    switch (msg.type) {
        case 'start':
            jobs.set(msg.id, {
                id: msg.id,
                orbit: new RefOrbit(DeepNum.fromHex(msg.cx), DeepNum.fromHex(msg.cy), msg.q, msg.degree),
                want: msg.want,
                batch: 64
            });
            break;
        case 'extend': {
            const job = jobs.get(msg.id);
            if (job) job.want = Math.max(job.want, msg.want);
            break;
        }
        case 'abort':
            jobs.delete(msg.id);
            break;
    }
    if (!pumping) {
        pumping = true;
        setTimeout(pump, 0);
    }
}

function pump(){
    let busy = false;
    for (const job of jobs.values()) {
        const orbit = job.orbit;
        if (orbit.escaped || orbit.len >= job.want) continue;

        busy = true;
        const start = performance.now();
        const at = orbit.len;
        const count = Math.min(job.batch, job.want - orbit.len);
        const re = new Float64Array(count);
        const im = new Float64Array(count);
        const written = orbit.run(count, re, im, 0);
        const elapsed = performance.now() - start;

        // Aim each batch at the slice length; deep orbits are far slower per step.
        if (elapsed < SLICE_MS / 2) job.batch = Math.min(job.batch * 2, 65536);
        else if (elapsed > SLICE_MS * 2) job.batch = Math.max(job.batch >> 1, 8);

        const done = orbit.escaped || orbit.len >= job.want;
        const outRe = (written === count) ? re : re.slice(0, written);
        const outIm = (written === count) ? im : im.slice(0, written);
        postMessage(
            { type: 'chunk', id: job.id, at, re: outRe, im: outIm, escaped: orbit.escaped, done },
            [outRe.buffer, outIm.buffer]
        );
    }

    if (busy) {
        setTimeout(pump, 0);
    } else {
        pumping = false;
    }
}
