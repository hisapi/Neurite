/* =============================================================================
 * deepfractal.js — the Mandelbrot field at any depth
 * -----------------------------------------------------------------------------
 * Manages the reference orbit that deepperturb.js iterates against, and offers
 * deep-zoom versions of the fractal queries Neurite makes: escape time,
 * gradient, and the two kinds of "hair" (level-set traces outside the set,
 * flows toward the basin inside it).
 *
 * In use whenever the view has left the identity frame (see deepframe.js) and
 * the fractal is z^d + c. Other fractal types fall back to float evaluation.
 *
 * The reference orbit is the only arbitrary-precision computation. It runs in
 * a worker and is reused for as long as the view stays within its precision
 * and neighbourhood, typically across ~70 octaves of further zoom.
 * ========================================================================== */

const DeepFractal = {
    BAIL2: 1e8,             // matches Fractal.dist
    PRECISION_PAD: 128,     // reference bits beyond the current depth
    PRECISION_MIN: 56,      // replace the reference when fewer than this remain
    MAX_OFFSET: 2 ** 18,    // ...or when it is this many views away
    iterCap: 400000,        // ceiling on the automatic iteration budget
    MAX_WIDTH: 0.008,       // hair stroke width limit, as a fraction of the view

    ref: null,              // reference in use
    pending: null,          // replacement being computed
    maxIter: 0,
    stats: { total: 0, inside: 0 },

    worker: null,
    workerFailed: false,
    local: new Map(),       // id -> RefOrbit, when computing on the main thread
    nextId: 1,
    grad: { x: 0, y: 0 },

    degree(){ return parseInt(Fractal.exponentValue, 10) || 2 },
    supported(){
        const select = Elem.byId('fractal-select');
        const d = Number(Fractal.exponentValue);
        return (!select || select.value === 'mandelbrot') && Number.isInteger(d) && d >= 2 && d <= 12;
    },
    get active(){ return !DeepFrame.isIdentity && this.supported() },
    get ready(){ return !!this.ref && this.ref.len > 2 },

    /* How many iterations the current reference can serve. */
    limit(){
        const ref = this.ref;
        return ref.escaped ? this.maxIter : Math.min(this.maxIter, ref.len - 1);
    },

    // ------------------------------------------------------- per frame --

    update(){
        if (!this.active) {
            if (this.pending) this._abort(this.pending);
            this.pending = null;
            return;
        }

        const depth = -DeepFrame.zoomLog2();
        const floor = Math.max(settings.iterations, 96 + Math.round(10 * depth));
        if (this.maxIter < floor) this.maxIter = floor;

        const degree = this.degree();
        if (this.pending && !this._fits(this.pending, degree)) {
            this._abort(this.pending);
            this.pending = null;
        }
        if (!this.pending && !(this.ref && this._fits(this.ref, degree))) {
            this.pending = this._start(degree);
        }
        if (this.ref && this.ref.degree !== degree) {
            this._abort(this.ref);
            this.ref = null;
        }

        this._extend(this.pending || this.ref);
        if (this.local.size > 0) this._pumpLocal();
        this._adapt(floor);
    },

    _fits(ref, degree){
        if (ref.degree !== degree) return false;
        if (ref.q < DeepFrame.k + this.PRECISION_MIN) return false;

        const zl = Graph.zoom.mag();
        const d = Math.hypot(ref.lx - Graph.pan.x, ref.ly - Graph.pan.y);
        return d <= zl * this.MAX_OFFSET;
    },

    _start(degree){
        const q = 64 * Math.ceil((DeepFrame.k + this.PRECISION_PAD) / 64);
        const abs = DeepFrame.toAbs(Graph.pan.x, Graph.pan.y);
        const cap = 4096;
        const ref = {
            id: this.nextId++,
            ax: DeepNum.rescale(abs.x, abs.p, q),
            ay: DeepNum.rescale(abs.y, abs.p, q),
            q,
            degree,
            re: new Float64Array(cap),
            im: new Float64Array(cap),
            len: 0,
            escaped: false,
            want: Math.ceil(this.maxIter * 1.25) + 64,
            lx: Graph.pan.x,
            ly: Graph.pan.y
        };

        const worker = this._getWorker();
        if (worker) {
            worker.postMessage({
                type: 'start', id: ref.id, q, degree, want: ref.want,
                cx: DeepNum.toHex(ref.ax), cy: DeepNum.toHex(ref.ay)
            });
        } else {
            this.local.set(ref.id, new RefOrbit(ref.ax, ref.ay, q, degree));
        }
        return ref;
    },

    _extend(ref){
        if (!ref || ref.escaped) return;

        const want = Math.ceil(this.maxIter * 1.25) + 64;
        if (want <= ref.want) return;

        ref.want = want;
        if (this.worker) this.worker.postMessage({ type: 'extend', id: ref.id, want });
    },

    _abort(ref){
        if (this.worker) this.worker.postMessage({ type: 'abort', id: ref.id });
        this.local.delete(ref.id);
    },

    _getWorker(){
        if (this.worker || this.workerFailed) return this.worker;
        try {
            this.worker = new Worker('js/deep/refworker.js');
            this.worker.onmessage = (e)=>{
                const m = e.data;
                this._receive(m.id, m.at, m.re, m.im, m.escaped);
            };
            this.worker.onerror = (err)=>{
                Logger.warn("Reference orbit worker failed; computing on the main thread.", err.message);
                this._fallBackToLocal();
            };
        } catch (err) {
            this._fallBackToLocal();
        }
        return this.worker;
    },

    _fallBackToLocal(){
        this.workerFailed = true;
        this.worker = null;
        for (const ref of [this.ref, this.pending]) {
            if (!ref || ref.escaped || this.local.has(ref.id)) continue;

            // Restart from scratch: the worker's state is gone.
            ref.len = 0;
            this.local.set(ref.id, new RefOrbit(ref.ax, ref.ay, ref.q, ref.degree));
        }
    },

    /* Main-thread fallback: a few milliseconds of orbit per frame. */
    _pumpLocal(){
        const deadline = performance.now() + 3;
        for (const [id, orbit] of this.local) {
            const ref = (this.pending?.id === id) ? this.pending
                      : (this.ref?.id === id) ? this.ref : null;
            if (!ref) { this.local.delete(id); continue; }

            while (!orbit.escaped && orbit.len < ref.want && performance.now() < deadline) {
                const count = Math.min(32, ref.want - orbit.len);
                const re = new Float64Array(count);
                const im = new Float64Array(count);
                const at = orbit.len;
                const written = orbit.run(count, re, im, 0);
                this._receive(id, at, re.subarray(0, written), im.subarray(0, written), orbit.escaped);
            }
        }
    },

    _receive(id, at, re, im, escaped){
        const ref = (this.pending?.id === id) ? this.pending
                  : (this.ref?.id === id) ? this.ref : null;
        if (!ref || at !== ref.len) return;

        const need = at + re.length;
        if (need > ref.re.length) {
            const cap = Math.max(need, ref.re.length * 2);
            const nre = new Float64Array(cap);
            const nim = new Float64Array(cap);
            nre.set(ref.re.subarray(0, ref.len));
            nim.set(ref.im.subarray(0, ref.len));
            ref.re = nre;
            ref.im = nim;
        }
        ref.re.set(re, at);
        ref.im.set(im, at);
        ref.len = need;
        ref.escaped = escaped;

        if (ref === this.pending && (escaped || ref.len > this.maxIter || ref.len >= ref.want)) {
            if (this.ref) this._abort(this.ref);
            this.ref = ref;
            this.pending = null;
        }
    },

    /* Grow the iteration budget while most samples fail to escape; let it
     * settle back when nearly all do. */
    _adapt(floor){
        const stats = this.stats;
        if (stats.total < 40) return;

        const frac = stats.inside / stats.total;
        stats.total = 0;
        stats.inside = 0;

        const ref = this.ref;
        if (!ref || !(ref.escaped || ref.len > this.maxIter)) return; // still catching up

        if (frac > 0.5) {
            this.maxIter = Math.min(this.iterCap, Math.ceil(this.maxIter * 1.3) + 32);
        } else if (frac < 0.1 && this.maxIter > floor) {
            this.maxIter = Math.max(floor, Math.floor(this.maxIter * 0.97));
        }
        if (this.maxIter < floor) this.maxIter = Math.min(floor, this.iterCap);
    },

    onRebase(){
        for (const ref of [DeepFractal.ref, DeepFractal.pending]) {
            if (!ref) continue;

            const l = DeepFrame.toLocal({ x: ref.ax, y: ref.ay, p: ref.q });
            ref.lx = l.x;
            ref.ly = l.y;
        }
    },

    // ----------------------------------------------------------- queries --

    /* Iterate the local point (x, y). Results are in DeepPerturb. */
    run(x, y, deriv, captureAt){
        const ref = this.ref;
        return DeepPerturb.run(ref, x - ref.lx, y - ref.ly, DeepFrame.k,
                               this.limit(), this.BAIL2, deriv, captureAt);
    },

    /* Smooth escape time; equals the iteration limit inside the set. */
    dist(c){
        if (!this.ready) return 0;
        const r = this.run(c.x, c.y, false);
        return r.escaped ? r.mu() : this.limit();
    },

    /* Gradient of the smooth escape time in local units; zero inside. */
    gradAt(c){
        if (!this.ready) return new vec2(0, 0);
        const r = this.run(c.x, c.y, true);
        if (!r.escaped) return new vec2(0, 0);

        const g = r.gradMu(this.grad);
        return (Number.isFinite(g.x) && Number.isFinite(g.y)) ? new vec2(g.x, g.y) : new vec2(0, 0);
    },

    isInside(c){
        if (!this.ready) return false;
        return !this.run(c.x, c.y, false).escaped;
    },

    /* Same contract as Fractal.generate_path_data. */
    pathData(pt, numPtsMax){
        if (!this.ready || !pt?.isFinite?.()) return null;

        const r = this.run(pt.x, pt.y, true);
        this.stats.total += 1;
        if (!r.escaped) {
            this.stats.inside += 1;
            return this._interiorPath(pt, numPtsMax, r.minN);
        }
        return this._levelPath(pt, numPtsMax, r.mu(), r.gradMu(this.grad));
    },

    /* Outside the set: follow the level curve of the smooth escape time. */
    _levelPath(pt, numPtsMax, level, g0){
        if (level < settings.maxDist) return null;

        const step = (Math.random() > 0.5 ? settings.renderStepSize : -settings.renderStepSize);
        const maxJump = Graph.zoom.mag() * 2;
        const points = [pt];
        let length = 0;
        let z = pt;
        let val = level;
        let gx = g0.x, gy = g0.y;
        let prevGradMag2 = Infinity;
        let prevAngle = null;
        let totalAngle = 0;

        while (points.length <= numPtsMax) {
            const gradMag2 = gx * gx + gy * gy;
            if (!(gradMag2 > 0) || !Number.isFinite(gradMag2)) break;
            if (Math.abs(val - level) > 1) break;
            if (gradMag2 > prevGradMag2 * 4) break;

            // delta = grad * (residual + i step) / |grad|^2
            const residual = level - val;
            const dx = (gx * residual - gy * step) / gradMag2;
            const dy = (gy * residual + gx * step) / gradMag2;
            const dMag = Math.hypot(dx, dy);
            if (!Number.isFinite(dMag) || dMag > maxJump) break;

            const angle = Math.atan2(dy, dx);
            if (prevAngle !== null) {
                totalAngle += Math.abs(angle - prevAngle);
                if (totalAngle > 2 * Math.PI) break;
            }
            prevAngle = angle;
            prevGradMag2 = gradMag2;

            z = new vec2(z.x + dx, z.y + dy);
            const r = this.run(z.x, z.y, true);
            if (!r.escaped) break;

            points.push(z);
            length += dMag;
            val = r.mu();
            const g = r.gradMu(this.grad);
            gx = g.x;
            gy = g.y;
        }

        const count = points.length - 1;
        if (count < 1 || length === 0) return null;

        return {
            originalPoints: points,
            width: Math.min(settings.renderWidthMult * length / count, Graph.zoom.mag() * this.MAX_WIDTH),
            color: Color.strRgb(level),
            opacity: settings.outerOpacity,
            length
        };
    },

    /* Inside the set: descend |z_p| toward the nucleus, where p is the
     * iteration at which the orbit comes closest to zero. */
    _interiorPath(pt, numPtsMax, p){
        if (p < 1) return null;

        const stride = Graph.zoom.mag() * 0.1 * settings.renderStepSize;
        const points = [pt];
        let length = 0;
        let z = pt;

        let r = this.run(z.x, z.y, true, p);
        while (points.length <= numPtsMax && r.captured && !r.escaped) {
            // gradient of |z_p|^2 is 2 z_p conj(z_p'); only its direction is used
            const dx = r.capZr * r.capVr + r.capZi * r.capVi;
            const dy = r.capZi * r.capVr - r.capZr * r.capVi;
            const mag = Math.hypot(dx, dy);
            if (!(mag > 0) || !Number.isFinite(mag)) break;

            const next = new vec2(z.x - dx / mag * stride, z.y - dy / mag * stride);
            r = this.run(next.x, next.y, true, p);
            if (r.escaped) break;

            points.push(next);
            length += stride;
            z = next;
        }

        const count = points.length - 1;
        if (count < 1) return null;

        length /= 4;
        return {
            originalPoints: points,
            width: Math.min(settings.renderWidthMult * length / count, Graph.zoom.mag() * this.MAX_WIDTH),
            // legacy colours by the index of the infimum counted from z_1
            color: Color.strRgb((p - 1) * 123 + 2, (1 - nodeMode_v), 128, 32 + (1 - nodeMode_v) * 48),
            opacity: settings.innerOpacity / 10,
            length
        };
    },

    status(){
        const ref = this.ref;
        return {
            active: this.active,
            depth: DeepNum.sxToString(DeepFrame.zoomSx(), 4),
            k: DeepFrame.k,
            maxIter: this.maxIter,
            refLen: ref ? ref.len : 0,
            refEscaped: ref ? ref.escaped : null,
            refBits: ref ? ref.q : 0,
            pending: this.pending ? this.pending.len : null,
            worker: this.worker ? 'worker' : (this.workerFailed ? 'main-thread' : 'idle')
        };
    }
};

DeepFrame.onRebase(DeepFractal.onRebase);
