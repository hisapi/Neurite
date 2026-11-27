/* =============================================================================
 * fractalcrawl.js — tell a list of notes down the fractal's Z axis
 * -----------------------------------------------------------------------------
 * Seeds an array of strings into Neurite one at a time while descending the
 * Mandelbrot boundary. Before each note it samples the visible field, picks a
 * stretch of boundary, flies there one level deeper, plants the note beside
 * the descent axis, links it to the previous one, holds, and keeps falling.
 *
 *   const run = NeuriteCrawl.crawl(['first', 'second', 'third', …]);
 *   run.stop();                  // interrupt
 *   await run.promise;           // -> [{ id, title, re, im, zoom }, …]
 *   NeuriteCrawl.replay(run.notes)   // fly back through them
 *
 * This is the successor of the console add-on that had to surface and start a
 * new "chapter" every ~18 notes when doubles ran out near 1e-14. Here the
 * descent simply continues: coordinates are arbitrary precision (deepframe.js),
 * the field is evaluated by perturbation (deepfractal.js), and the notes live
 * in the deep store (deepstore.js), so neither depth nor note count is a wall.
 * A chapter break remains available as an option (maxDepth) for pacing, or to
 * keep the background rendering quick: deeper views need more iterations.
 * ========================================================================== */

const NeuriteCrawl = {
    DEFAULTS: {
        descent: 0.34,        // zoom multiplier for the approach (<1 = deeper)
        notePhase: 0.6,       // fraction of the approach made before planting,
                              //   so the note is left a little larger than the
                              //   view it is read in
        plungeFactor: 0.45,   // further descent after the hold (1 = none)
        dwellMs: 2000,        // hold on each note
        speed: 0.06,          // flight speed; lower is slower
        samples: 64,          // n x n probe grid over the view
        viewSpan: 0.9,        // fraction of the screen probed
        ringRadius: 0.4,      // prefer boundary this far from the centre…
        ringWidth: 0.3,       //   …so the camera does not fall through the
                              //   note it just planted
        minSeparation: 0.08,  // keep clear of earlier picks, in view-heights
        noteRadius: 0.34,     // note offset from the descent axis, in half-views
        noteJitter: 0.35,
        noteAngleStep: 137.5, // degrees between successive notes (golden angle)
        noteScale: 0.5,       // note size relative to the view when planted
        connect: true,
        titlePrefix: '',
        origin: { re: '-0.5', im: '0', zoom: '3' },   // false = start from here
        maxDepth: null,       // e.g. '1e-200': on reaching it, return to the
                              //   origin and begin a new dive elsewhere
        store: 'default',     // deep store to write into
        verbose: true,
        onStep: null
    },

    /* The strongest usable stretch of boundary in the current view.
     * score = contrast with neighbours, discounted for very high iteration
     * counts (which mark cusps where every later step would be slow), for
     * distance from the preferred ring, and for closeness to earlier picks. */
    pick(opts, avoid){
        const grid = NeuriteDeep.fieldGrid(opts.samples, opts.viewSpan);
        const n = grid.n;
        const mu = grid.mu;
        const limit = grid.limit;

        const escaped = [];
        for (let i = 0; i < mu.length; i++) if (mu[i] < limit) escaped.push(mu[i]);
        if (escaped.length === 0) return null;
        escaped.sort( (a, b)=>a - b );
        const median = escaped[escaped.length >> 1];

        const zoom = Graph.zoom.mag();
        const avoidLocal = avoid.map( (a)=>NeuriteDeep.absToLocal(a.re, a.im) )
            .filter( (l)=>l && l.isFinite() );
        let best = null;
        let bestScore = 0;
        for (let j = 1; j < n - 1; j++) {
            for (let i = 1; i < n - 1; i++) {
                const at = j * n + i;
                const c = mu[at];
                const contrast = Math.max(
                    Math.abs(c - mu[at - 1]), Math.abs(c - mu[at + 1]),
                    Math.abs(c - mu[at - n]), Math.abs(c - mu[at + n])
                );
                if (contrast === 0) continue;

                const u = (i / (n - 1)) * 2 - 1;
                const v = (j / (n - 1)) * 2 - 1;
                const r = Math.hypot(u, v);
                const d = (r - opts.ringRadius) / opts.ringWidth;
                let score = Math.min(contrast, 4) * Math.exp(-0.5 * d * d);
                score /= 1 + Math.max(0, c - median) / (median + 16);
                if (c >= limit) score *= 0.3; // inside the set: a last resort

                for (const local of avoidLocal) {
                    const sep = Math.hypot(grid.x[at] - local.x, grid.y[at] - local.y) / zoom;
                    if (sep < opts.minSeparation) { score = 0; break; }
                }
                if (score > bestScore) {
                    bestScore = score;
                    best = { x: grid.x[at], y: grid.y[at], mu: c };
                }
            }
        }
        return best;
    },

    crawl(items, options){
        if (!Array.isArray(items) || items.length === 0) {
            throw new Error("NeuriteCrawl.crawl(): pass a non-empty array of strings");
        }
        const opts = Object.assign({}, this.DEFAULTS, options);
        const notes = [];
        const state = { stopped: false };
        const sleep = (ms)=>new Promise( (resolve)=>setTimeout(resolve, ms) );
        const stopped = ()=>state.stopped;
        const speed = { speed: opts.speed };

        const goHome = async ()=>{
            const o = opts.origin;
            if (o) await NeuriteDeep.goTo(o.re, o.im, o.zoom, { speed: Math.max(opts.speed, 0.12) });
        };

        const promise = (async ()=>{
            await DeepStore.open(opts.store);
            if (opts.origin !== false) await goHome();

            const angle0 = Math.random() * 2 * Math.PI;
            const maxDepth = opts.maxDepth ? DeepNum.sxLog2(DeepNum.sxParse(String(opts.maxDepth))) : -Infinity;
            let avoid = [];
            let prevId = null;
            let chapter = 1;
            let opening = true; // the next note opens a dive

            for (let i = 0; i < items.length && !stopped(); i++) {
                if (DeepFrame.zoomLog2() < maxDepth) {
                    chapter += 1;
                    opening = true;
                    // Start the new dive away from where earlier ones began.
                    avoid = notes.filter( (note)=>note.first ).slice(-12);
                    await goHome();
                    if (stopped()) break;
                }

                // 1. Find boundary in view. A flat view (deep inside or far
                //    outside the set) has none: back out until some appears.
                let point = null;
                for (let tries = 0; tries < 6 && !point && !stopped(); tries++) {
                    await NeuriteDeep.whenFieldReady();
                    point = this.pick(opts, avoid);
                    if (!point) await NeuriteDeep.zoomBy(4, speed);
                }
                if (stopped()) break;
                if (!point) point = { x: Graph.pan.x, y: Graph.pan.y, mu: 0 };

                // 2. Fly most of the way there.
                const phase = Math.min(1, Math.max(0, opts.notePhase));
                const leg1 = opts.descent ** phase;
                const target = NeuriteDeep.localToAbs(point.x, point.y);
                await NeuriteDeep.flyToLocal(point.x, point.y, leg1, speed);
                if (stopped()) break;

                // 3. Plant the note beside the axis; successive notes fan out.
                const zoom = Graph.zoom.mag();
                const angle = angle0 + i * opts.noteAngleStep * Math.PI / 180;
                const radius = opts.noteRadius * zoom * (1 + (Math.random() * 2 - 1) * opts.noteJitter);
                const offset = new vec2(Math.cos(angle) * radius, Math.sin(angle) * radius)
                    .cmult(Graph.zoom.unscale(zoom)); // screen-aligned under rotation
                const raw = String(items[i]);
                const title = opts.titlePrefix
                    ? opts.titlePrefix + (i + 1)
                    : (raw.split('\n')[0].slice(0, 48).trim() || 'note ' + (i + 1));
                const id = DeepStore.addNote({
                    title,
                    text: raw,
                    x: Graph.pan.x + offset.x,
                    y: Graph.pan.y + offset.y,
                    scale: opts.noteScale * zoom
                });
                if (opts.connect && prevId !== null) DeepStore.link(prevId, id);
                prevId = id;

                const view = NeuriteDeep.getView();
                const note = { id, title, re: target.re, im: target.im, zoom: view.zoom, chapter, first: opening };
                opening = false;
                notes.push(note);

                // 4. Finish the approach, hold, then keep falling.
                await NeuriteDeep.zoomBy(opts.descent / leg1, speed);
                if (stopped()) break;
                if (typeof opts.onStep === 'function') {
                    try { opts.onStep({ index: i, text: raw, note, point }) } catch (err) { Logger.warn(err) }
                }
                await sleep(opts.dwellMs);
                if (stopped()) break;
                if (opts.plungeFactor !== 1 && i < items.length - 1) {
                    await NeuriteDeep.zoomBy(opts.plungeFactor, speed);
                }

                if (opts.verbose) {
                    Logger.info(`[crawl] ${i + 1}/${items.length} "${title}" — zoom ${NeuriteDeep.getView().zoom}`
                        + `, iterations ${Fractal.maxIter()}`);
                }
            }
            await DeepStore.flush();
            return notes;
        })();

        return {
            promise,
            notes,
            stop(){
                state.stopped = true;
                Autopilot.stop();
            }
        };
    },

    /* Fly through notes in order (as returned by crawl, or any list of ids). */
    async replay(notes, opts = {}){
        for (const note of notes) {
            const arrived = await DeepStore.goTo(note.id ?? note, { speed: opts.speed ?? 0.1 });
            if (!arrived) return false;
            await new Promise( (resolve)=>setTimeout(resolve, opts.dwellMs ?? 1500) );
        }
        return true;
    }
};
window.NeuriteCrawl = NeuriteCrawl;
