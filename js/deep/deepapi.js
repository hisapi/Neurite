/* =============================================================================
 * deepapi.js — scripting surface for deep zoom and the deep store
 * -----------------------------------------------------------------------------
 * window.NeuriteDeep gathers what a console script or add-on needs:
 *
 *   NeuriteDeep.getView()                    -> { re, im, zoom, zoomLog2 }
 *   NeuriteDeep.goTo(re, im, zoom, opts)     -> Promise<arrived>
 *   NeuriteDeep.zoomBy(factor, opts)         -> Promise<arrived>
 *   NeuriteDeep.localToAbs(x, y)             -> { re, im }
 *   NeuriteDeep.absToLocal(re, im)           -> vec2
 *   NeuriteDeep.sample(x, y)                 -> { mu, inside, gx, gy }
 *   NeuriteDeep.fieldGrid(n, span)           -> escape-time samples over the view
 *   NeuriteDeep.whenFieldReady()             -> Promise
 *   NeuriteDeep.store                        -> DeepStore (addNote, link, goTo…)
 *   NeuriteDeep.status()
 *
 * Positions cross this API as decimal strings, because at depth they carry
 * far more digits than a number can. "Local" coordinates are the ordinary
 * doubles Graph.pan and node.pos use, relative to the current deep frame;
 * they are only meaningful until the frame next re-centres, so convert to
 * absolute for anything that must outlive the current view.
 * ========================================================================== */

const NeuriteDeep = {
    num: DeepNum,
    frame: DeepFrame,
    fractal: DeepFractal,
    nav: DeepNav,
    perf: DeepPerf,
    store: DeepStore,

    getView(){
        const view = DeepFrame.viewStrings();
        view.zoomLog2 = DeepFrame.zoomLog2();
        return view;
    },

    /* opts: { speed, instant }. zoom may be omitted to keep the current zoom. */
    goTo(re, im, zoom, opts){ return DeepNav.goTo(re, im, zoom, opts) },

    /* Zoom about the centre of the view; factor < 1 goes deeper. */
    zoomBy(factor, opts){
        const view = DeepFrame.view();
        const zoom = DeepNum.sxFromLog2(DeepNum.sxLog2(view.zoom) + Math.log2(factor));
        return DeepNav.flyTo(view, zoom, opts);
    },

    /* Fly to a local point (as returned by Graph.xyToZ, fieldGrid…). */
    flyToLocal(x, y, zoomFactor = 1, opts){
        const target = DeepFrame.toAbs(x, y);
        const zoom = DeepNum.sxFromLog2(DeepFrame.zoomLog2() + Math.log2(zoomFactor));
        return DeepNav.flyTo(target, zoom, opts);
    },

    localToAbs(x, y){
        const abs = DeepFrame.toAbs(x, y);
        const digits = DeepFrame.digits();
        return {
            re: DeepNum.toDecimal(abs.x, abs.p, digits),
            im: DeepNum.toDecimal(abs.y, abs.p, digits)
        };
    },
    absToLocal(re, im){
        const pt = DeepFrame.parsePoint(String(re), String(im), DeepFrame.zoomSx());
        return pt && DeepFrame.toLocal(pt);
    },

    /* The fractal field at a local point, at any depth. */
    sample(x, y){
        const pt = new vec2(x, y);
        const limit = Fractal.maxIter();
        const mu = Fractal.dist(limit, pt);
        const g = Fractal.grad(limit, pt);
        return { mu, inside: mu >= limit, gx: g.x, gy: g.y, limit };
    },

    /* n x n escape-time samples over the central `span` fraction of the
     * screen. Returns { n, mu, x, y, limit, inside } with x/y local. */
    fieldGrid(n = 64, span = 1){
        const limit = Fractal.maxIter();
        const mu = new Float64Array(n * n);
        const xs = new Float64Array(n * n);
        const ys = new Float64Array(n * n);
        const w = window.innerWidth;
        const h = window.innerHeight;
        const pt = new vec2(0, 0);
        let inside = 0;
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const z = Graph.xyToZ(w * (0.5 + span * (i / (n - 1) - 0.5)),
                                      h * (0.5 + span * (j / (n - 1) - 0.5)));
                pt.x = z.x;
                pt.y = z.y;
                const m = Fractal.dist(limit, pt);
                const at = j * n + i;
                mu[at] = m;
                xs[at] = z.x;
                ys[at] = z.y;
                if (m >= limit) inside += 1;
            }
        }
        return { n, mu, x: xs, y: ys, limit, inside };
    },

    /* Resolves once the fractal can be evaluated for the current view (at
     * depth, the reference orbit may still be computing after a long move). */
    whenFieldReady(timeoutMs = 60000){
        const start = performance.now();
        return new Promise( (resolve)=>{
            const check = ()=>{
                const ref = DeepFractal.ref;
                const ready = !DeepFractal.active
                    || (DeepFractal.ready && !DeepFractal.pending
                        && (ref.escaped || ref.len > DeepFractal.maxIter));
                if (ready || performance.now() - start > timeoutMs) return resolve(ready);
                requestAnimationFrame(check);
            };
            check();
        });
    },

    status(){
        return {
            view: this.getView(),
            frame: { k: DeepFrame.k, bits: DeepFrame.p, epoch: DeepFrame.epoch, identity: DeepFrame.isIdentity },
            fractal: DeepFractal.status(),
            store: DeepStore.stats(),
            nodes: { live: Object.keys(Graph.nodes).length, drawn: DeepPerf.shown }
        };
    }
};
window.NeuriteDeep = NeuriteDeep;

// Function-calling panel / AI access, alongside the existing neurite* names.
registerFunctions([
    {
        baseFunctionName: 'neuriteDeepGoTo',
        baseFunction: (re, im, zoom, speed)=>NeuriteDeep.goTo(re, im, zoom, { speed }),
        alternateNames: ['deepGoTo', 'setDeepCoords']
    },
    {
        baseFunctionName: 'neuriteDeepView',
        baseFunction: ()=>NeuriteDeep.getView(),
        alternateNames: ['deepView', 'getDeepCoords']
    },
    {
        baseFunctionName: 'neuriteDeepAddNote',
        baseFunction: (title, text, opts)=>DeepStore.ready.then( ()=>DeepStore.addNote({ title, text, ...opts }) ),
        alternateNames: ['deepAddNote']
    },
    {
        baseFunctionName: 'neuriteDeepGoToNote',
        baseFunction: (id, speed)=>DeepStore.goTo(id, { speed }),
        alternateNames: ['deepGoToNote']
    }
]);
initializeFunctionMappings();
