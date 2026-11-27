/* =============================================================================
 * deepframe.js — floating origin for unbounded zoom depth
 * -----------------------------------------------------------------------------
 * Neurite's world coordinates (Graph.pan, Graph.zoom, node.pos, edge lengths…)
 * are doubles. A double resolves ~1e-16 of its own magnitude, so once the view
 * is narrower than about 1e-13 of |pan| every pixel maps to the same number.
 *
 * Rather than replace doubles everywhere, the meaning of a world coordinate is
 * changed: it is now relative to a movable frame
 *
 *     absolute = origin + local * 2^-k
 *
 * where origin is an arbitrary-precision BigInt pair and k an integer. The
 * frame is re-centred on the view whenever the view drifts or zooms far from
 * it, so local coordinates near the screen are always small, well-conditioned
 * doubles. All existing geometry code keeps working unchanged on local values.
 *
 * At shallow zoom the frame is the identity (origin 0, k 0) and local values
 * ARE the absolute ones, exactly as before.
 *
 * A rebase maps every live quantity through  P' = P * s + t  (positions) or
 * L' = L * s  (lengths), with s a power of two so the scaling is exact.
 * Objects that would leave double range in the new frame (a node 2^400 times
 * larger than the screen, say) are "parked": their absolute position is kept
 * in BigInt and they are restored if the view ever returns to their scale.
 * ========================================================================== */

const DeepFrame = {
    enabled: true,

    ox: 0n,             // origin, fixed point with p fractional bits
    oy: 0n,
    p: 192,
    k: 0,               // one local unit is 2^-k absolute units
    epoch: 0,           // bumped on every rebase

    ENTER: -24,         // leave the identity frame when zoom < 2^ENTER
    EXIT: -16,          // return to it when zoom > 2^EXIT
    RANGE: 16,          // re-centre when |log2 zoom| or log2(|pan|/zoom) passes this
    PARK: 300,          // park objects beyond 2^+-PARK local units
    RESOLVE: 2 ** 40,   // ...or further than this many of their own sizes away

    listeners: [],
    onRebase(fn){ this.listeners.push(fn) },

    get isIdentity(){ return this.k === 0 && this.ox === 0n && this.oy === 0n },

    // ------------------------------------------------------- conversions --

    /* Local point -> absolute { x, y, p }. */
    toAbs(x, y){
        const s = this.p - this.k;
        return {
            x: this.ox + DeepNum.fromFloat(x, s),
            y: this.oy + DeepNum.fromFloat(y, s),
            p: this.p
        };
    },

    /* Absolute { x, y, p } -> local vec2. Components may be +-Infinity when
     * the point is beyond double range in this frame. */
    toLocal(pt){
        let { x, y } = pt;
        let ox = this.ox;
        let oy = this.oy;
        let p = this.p;
        if (pt.p > p) {
            const d = BigInt(pt.p - p);
            ox <<= d; oy <<= d;
            p = pt.p;
        } else if (pt.p < p) {
            const d = BigInt(p - pt.p);
            x <<= d; y <<= d;
        }
        const s = p - this.k;
        return new vec2(DeepNum.toFloat(x - ox, s), DeepNum.toFloat(y - oy, s));
    },

    /* Local length <-> absolute scale as an sx ({ m, e }). */
    lengthToSx(len){ return DeepNum.sx(len, -this.k) },
    sxToLength(sx){ return DeepNum.sxToFloat(sx, this.k) },

    /* The origin as plain doubles (meaningful only at shallow depth). */
    originFloat(){
        return new vec2(DeepNum.toFloat(this.ox, this.p), DeepNum.toFloat(this.oy, this.p));
    },

    // ---------------------------------------------------- view accessors --

    /* log2 of the absolute zoom magnitude. Never under- or overflows. */
    zoomLog2(){ return Math.log2(Graph.zoom.mag()) - this.k },
    zoomSx(){ return DeepNum.sx(Graph.zoom.mag(), -this.k) },

    /* Absolute view: { x, y, p, zoom: sx }. */
    view(){
        const abs = this.toAbs(Graph.pan.x, Graph.pan.y);
        abs.zoom = this.zoomSx();
        return abs;
    },

    /* Decimal digits needed to pin a position to well below a pixel. */
    digits(){
        return Math.max(17, Math.ceil(-this.zoomLog2() * Math.LOG10E * Math.LN2) + 6);
    },

    /* Absolute view as decimal strings: { re, im, zoom }. */
    viewStrings(){
        const abs = this.view();
        const digits = this.digits();
        const z = abs.zoom;
        return {
            re: DeepNum.toDecimal(abs.x, abs.p, digits),
            im: DeepNum.toDecimal(abs.y, abs.p, digits),
            zoom: (z.e > -1000 ? String(DeepNum.sxToFloat(z)) : DeepNum.sxToString(z, 15))
        };
    },

    /* Parse decimal strings into an absolute point at adequate precision. */
    parsePoint(re, im, zoomSx){
        const depth = zoomSx ? Math.max(0, -DeepNum.sxLog2(zoomSx)) : 0;
        const decimals = Math.max(String(re).length, String(im).length) * 3.33;
        const p = 64 * Math.ceil((Math.max(depth, decimals, this.p - 160) + 160) / 64);
        const x = DeepNum.parseDecimal(re, p);
        const y = DeepNum.parseDecimal(im, p);
        return (x === null || y === null) ? null : { x, y, p };
    },

    // ------------------------------------------------------------ rebase --

    /* Called once per frame, before anything reads the view. */
    maintain(){
        if (!this.enabled) return;

        const pan = Graph.pan;
        const zl = Graph.zoom.mag();
        if (!(zl > 0) || !Number.isFinite(zl) || !pan.isFinite()) return;

        const lz = Math.log2(zl);
        const panMag = Math.hypot(pan.x, pan.y);

        if (this.isIdentity) {
            if (lz >= this.ENTER && panMag <= zl * 2 ** 26) return;
            return this.recentre();
        }

        if (lz - this.k > this.EXIT) {
            const o = this.originFloat();
            const zoomAbs = DeepNum.ldexp(zl, -this.k);
            const far = Math.hypot(o.x, o.y) + DeepNum.ldexp(panMag, -this.k);
            if (far <= zoomAbs * 2 ** 24) return this.rebaseTo(0n, 0n, this.p, 0);
        }

        if (Math.abs(lz) > this.RANGE || panMag > zl * 2 ** this.RANGE) this.recentre();
    },

    /* Move the origin to the view centre and make zoom ~1. */
    recentre(){
        const abs = this.toAbs(Graph.pan.x, Graph.pan.y);
        const nk = this.k - Math.floor(Math.log2(Graph.zoom.mag()));
        this.rebaseTo(abs.x, abs.y, abs.p, nk);
    },

    /* Switch to the frame (nox, noy at precision np; exponent nk), carrying
     * every live world-space quantity along. */
    rebaseTo(nox, noy, np, nk){
        // Common precision, with headroom below the new unit.
        const P = 64 * Math.ceil(Math.max(this.p, np, nk + 160) / 64);
        const ox = DeepNum.rescale(this.ox, this.p, P);
        const oy = DeepNum.rescale(this.oy, this.p, P);
        nox = DeepNum.rescale(nox, np, P);
        noy = DeepNum.rescale(noy, np, P);

        const dk = nk - this.k;
        const tx = DeepNum.toFloat(ox - nox, P - nk);
        const ty = DeepNum.toFloat(oy - noy, P - nk);
        const s = DeepNum.ldexp(1, dk);
        const soft = Math.abs(dk) < 600 && Math.abs(tx) < 1e180 && Math.abs(ty) < 1e180;

        const oldFrame = { ox: this.ox, oy: this.oy, p: this.p, k: this.k };
        const newFrame = { ox: nox, oy: noy, p: P, k: nk };
        const xf = {
            s, tx, ty, dk, soft, oldFrame, newFrame,
            point: soft
                ? (v)=>new vec2(v.x * s + tx, v.y * s + ty)
                : (v)=>DeepFrame.toLocal.call(newFrame, DeepFrame.toAbs.call(oldFrame, v.x, v.y)),
            len: (v)=>new vec2(DeepNum.ldexp(v.x, dk), DeepNum.ldexp(v.y, dk)),
            num: (l)=>DeepNum.ldexp(l, dk)
        };

        // Nodes and edges that will not fit the new frame are parked while
        // the old frame is still current.
        const nodes = Graph.nodes;
        for (const uuid in nodes) this.rebaseNode(nodes[uuid], xf);
        const edges = Graph.edges;
        for (const key in edges) this.rebaseEdge(edges[key], xf);

        const pan = xf.point(Graph.pan);
        const zoom = xf.len(Graph.zoom);

        this.ox = nox;
        this.oy = noy;
        this.p = P;
        this.k = nk;
        this.epoch += 1;

        Graph.pan = pan;
        Graph.zoom = zoom;
        Graph.lastPos = this.finiteOr(xf.point(Graph.lastPos), pan);
        this.rebaseSvg(xf);
        this.rebaseAutopilot(xf);
        if (typeof Animation.rebaseActive === 'function') Animation.rebaseActive(xf);

        const sim = (typeof App !== 'undefined') && App.nodeSimulation;
        if (sim) {
            sim.mousePathPos = this.finiteOr(xf.point(sim.mousePathPos), pan);
            if (!soft) sim.mousePath = [];
        }
        if (typeof gestureStartParams !== 'undefined') {
            gestureStartParams.pan = this.finiteOr(xf.point(gestureStartParams.pan), pan);
            gestureStartParams.zoom = xf.len(gestureStartParams.zoom);
        }

        for (const uuid in nodes) this.tryUnparkNode(nodes[uuid]);
        for (const key in edges) this.tryUnparkEdge(edges[key]);

        for (const fn of this.listeners) fn(xf);
        Logger.debug("Deep frame rebased: k =", nk, "epoch", this.epoch);
    },

    finiteOr(v, dflt){ return v.isFinite() ? v : new vec2(dflt.x, dflt.y) },

    /* Can this frame hold an object of the given size at this position?
     * Besides staying inside double range, the position must resolve to a
     * small fraction of the object's own size: a double keeps 53 bits, so an
     * object more than ~2^40 of its own widths from the origin is parked and
     * keeps its exact BigInt position instead. `slack` adds hysteresis. */
    inRange(pos, scale, slack = 1){
        const lim = 2 ** this.PARK;
        const reach = Math.max(Math.abs(pos.x), Math.abs(pos.y));
        return Number.isFinite(reach) && reach < lim
            && scale > 1 / lim && scale < lim
            && reach <= scale * this.RESOLVE * slack;
    },

    rebaseNode(node, xf){
        if (node.parked || !node.pos) return;

        const pos = xf.point(node.pos);
        const scale = xf.num(node.scale ?? 1);
        if (!this.inRange(pos, scale)) return this.parkNode(node);

        node.anchor = this.finiteOr(xf.point(node.anchor), pos);
        node.pos = pos;
        if (node.scale !== undefined) node.scale = scale;
        if (node.vel) node.vel = xf.len(node.vel);
        if (node.force) node.force = xf.len(node.force);
        if (node.mouseAnchor) node.mouseAnchor = xf.len(node.mouseAnchor);
    },

    /* Record a node's absolute placement and take it out of the simulation.
     * Uses the frame that is current at the time of the call. */
    parkNode(node){
        const pos = node.pos;
        const scale = node.scale ?? 1;
        const rel = node.anchor.minus(pos).unscale(scale);
        node.deep = {
            pos: this.toAbs(pos.x, pos.y),
            scale: this.lengthToSx(scale),
            anchorRel: (rel.isFinite() ? rel : new vec2(0, 0))
        };
        node.parked = true;
        node.vel = new vec2(0, 0);
        node.force = new vec2(0, 0);
        node.followingMouse = 0;
        if (node.setCulled) node.setCulled(true);
        if (Autopilot.referenceFrame === node) Autopilot.reset();
    },

    tryUnparkNode(node){
        if (!node.parked) return;

        const deep = node.deep;
        const scale = this.sxToLength(deep.scale);
        const pos = this.toLocal(deep.pos);
        if (!this.inRange(pos, scale, 0.25)) return;

        node.pos = pos;
        node.scale = scale;
        node.anchor = pos.plus(deep.anchorRel.scale(scale));
        node.parked = false;
        node.deep = null;
    },

    rebaseEdge(edge, xf){
        if (edge.parked) return;

        const length = xf.num(edge.length);
        const lim = 2 ** this.PARK;
        if (length > 1 / lim && length < lim) {
            edge.length = length;
            edge.currentLength = xf.num(edge.currentLength);
            return;
        }
        edge.deepLength = this.lengthToSx(edge.length);
        edge.parked = true;
    },

    tryUnparkEdge(edge){
        if (!edge.parked) return;

        const length = this.sxToLength(edge.deepLength);
        const lim = 2 ** this.PARK;
        if (!(length > 1 / lim && length < lim)) return;

        edge.length = length;
        edge.currentLength = length;
        edge.parked = false;
        edge.deepLength = null;
    },

    /* Svg-space coordinates are (P - Svg.pan) * Svg.zoom. Moving Svg.pan and
     * Svg.zoom with the frame leaves every existing path coordinate valid. */
    rebaseSvg(xf){
        const zoomOk = Number.isFinite(Svg.zoom / xf.s) && Svg.zoom / xf.s > 0;
        if (xf.soft && zoomOk) {
            Svg.pan = xf.point(Svg.pan);
            Svg.oldPan = xf.point(Svg.oldPan);
            Svg.zoom /= xf.s;
            Svg.oldZoom /= xf.s;
            return;
        }

        // Too large a jump to carry the drawing across: start a fresh canvas.
        Array.from(svg_bg.children).forEach(Elem.remove);
        Svg.pan = new vec2(Graph.pan.x, Graph.pan.y);
        Svg.oldPan = Svg.pan;
        Svg.zoom = Svg.rezoomFactor / (2 * Graph.zoom.mag());
        Svg.oldZoom = Svg.zoom;
        Svg.needsRecalc = false;
    },

    rebaseAutopilot(xf){
        const ap = Autopilot;
        ap.targetPan = (ap.referenceFrame ? xf.len(ap.targetPan) : xf.point(ap.targetPan));
        ap.targetZoom = xf.len(ap.targetZoom);
        ap.panToI = xf.len(ap.panToI);
        if (ap.panToI_prev) ap.panToI_prev = xf.point(ap.panToI_prev);
        ap.referenceScalePrev = xf.num(ap.referenceScalePrev);
        const ok = ap.targetPan.isFinite() && ap.targetZoom.isFinite() && ap.targetZoom.mag() > 0
                && ap.panToI.isFinite();
        if (!ok) {
            // The stock autopilot's target cannot be expressed in this frame.
            // A deep flight keeps its own BigInt target and is unaffected.
            if (!ap.deepFlight) ap.speed = 0;
            ap.referenceFrame = null;
            ap.targetPan = new vec2(Graph.pan.x, Graph.pan.y);
            ap.targetZoom = new vec2(Graph.zoom.x, Graph.zoom.y);
            ap.panToI = new vec2(0, 0);
            ap.panToI_prev = null;
        }
    },

    // -------------------------------------------------------------- jumps --

    /* Place the view at an absolute point (and optionally zoom) instantly.
     * Rotation is preserved. */
    setView(pt, zoomSx){
        const zs = zoomSx || this.zoomSx();
        const mag = Graph.zoom.mag();
        const rot = (mag > 0 && Number.isFinite(mag)) ? Graph.zoom.unscale(mag) : new vec2(1, 0);

        const lz = DeepNum.sxLog2(zs);
        const fx = DeepNum.toFloat(pt.x, pt.p);
        const fy = DeepNum.toFloat(pt.y, pt.p);
        const shallow = !this.enabled
            || (lz >= this.ENTER && Math.hypot(fx, fy) <= DeepNum.sxToFloat(zs) * 2 ** 24);

        if (shallow) {
            if (!this.isIdentity) this.rebaseTo(0n, 0n, this.p, 0);
            Graph.pan = new vec2(fx, fy);
            Graph.zoom = rot.scale(DeepNum.sxToFloat(zs));
        } else {
            this.rebaseTo(pt.x, pt.y, pt.p, -zs.e);
            Graph.pan = this.toLocal(pt);
            Graph.zoom = rot.scale(zs.m);
        }
    },

    /* A node whose fields were saved relative to another frame (identity if
     * none is given), or saved while parked: bring it into this frame. */
    adoptNode(node, frameData, parkedAt){
        if (parkedAt) {
            node.deep = {
                pos: { x: DeepNum.fromHex(parkedAt.x), y: DeepNum.fromHex(parkedAt.y), p: parkedAt.p },
                scale: { m: parkedAt.sm, e: parkedAt.se },
                anchorRel: new vec2(parkedAt.ax || 0, parkedAt.ay || 0)
            };
        } else {
            if (!frameData && this.isIdentity) return;
            if (!node.pos) return;

            const from = (frameData ? this.parse(frameData) : { ox: 0n, oy: 0n, p: 64, k: 0 });
            const scale = node.scale ?? 1;
            const rel = (node.anchor || node.pos).minus(node.pos).unscale(scale);
            node.deep = {
                pos: this.toAbs.call(from, node.pos.x, node.pos.y),
                scale: DeepNum.sx(scale, -from.k),
                anchorRel: (rel.isFinite() ? rel : new vec2(0, 0))
            };
        }
        node.parked = true;
        node.vel = new vec2(0, 0);
        node.force = new vec2(0, 0);
        this.tryUnparkNode(node);
    },
    describeParked(node){
        const deep = node.deep;
        return {
            x: DeepNum.toHex(deep.pos.x), y: DeepNum.toHex(deep.pos.y), p: deep.pos.p,
            sm: deep.scale.m, se: deep.scale.e,
            ax: deep.anchorRel.x, ay: deep.anchorRel.y
        };
    },

    /* Describe / restore the frame, for data saved in local coordinates. */
    serialize(){
        return {
            ox: DeepNum.toHex(this.ox),
            oy: DeepNum.toHex(this.oy),
            p: this.p,
            k: this.k
        };
    },
    parse(data){
        return {
            ox: DeepNum.fromHex(data.ox),
            oy: DeepNum.fromHex(data.oy),
            p: data.p,
            k: data.k
        };
    },
    /* Converters from another frame's local coordinates into this one's. */
    converterFrom(data){
        const from = this.parse(data);
        const dk = this.k - from.k;
        return {
            point: (v)=>this.toLocal(DeepFrame.toAbs.call(from, v.x, v.y)),
            len: (v)=>new vec2(DeepNum.ldexp(v.x, dk), DeepNum.ldexp(v.y, dk)),
            num: (l)=>DeepNum.ldexp(l, dk)
        };
    }
};
