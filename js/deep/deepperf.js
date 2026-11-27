/* =============================================================================
 * deepperf.js — per-frame budgets and visibility culling
 * -----------------------------------------------------------------------------
 * The frame loop used to do, for every node on every frame: a fractal gradient
 * (three escape-time evaluations), two forced layouts (getBoundingClientRect
 * before and after writing styles), and unconditional style writes. That cost
 * is linear in the node count and independent of how many nodes are visible.
 *
 * This module holds the state that lets Node.draw / Node.step / Edge.step
 * avoid it:
 *   - the viewport rectangle and view transform, read once per frame;
 *   - each node's layout size, kept current by a ResizeObserver instead of
 *     being re-measured;
 *   - the rule for which nodes are worth drawing at all;
 *   - a time budget for fractal forces, shared fairly between nodes.
 * ========================================================================== */

const DeepPerf = {
    hairBudgetMs: 5,    // background hairs per frame, deep zoom only
    forceBudgetMs: 3,   // fractal force evaluations per frame

    minScale: 0.012,    // nodes drawn smaller than this (CSS scale) are skipped
    maxScale: 24,       // nodes magnified beyond this are hidden: they would
                        //   cover the screen and swallow every pointer event
    margin: 0.3,        // viewport fraction kept live beyond each edge
    freezeHidden: true, // hidden nodes skip physics until they reappear

    frame: 0,
    width: 0, height: 0,
    scale: 1, offX: 0, offY: 0,
    panX: 0, panY: 0,
    izx: 1, izy: 0,     // 1 / Graph.zoom
    contentZoom: 1,
    shown: 0,           // nodes drawn last frame

    forceChance: 1,
    forceCost: 0.01,    // ms per evaluation, running average
    forceAsked: 0,
    forceSpent: 0,
    forceDone: 0,

    beginFrame(){
        this.frame += 1;

        const bb = svg.getBoundingClientRect();
        const w = Math.min(bb.width, bb.height);
        const off = (bb.width < bb.height ? bb.right : bb.bottom);
        this.width = bb.width;
        this.height = bb.height;
        this.scale = w;
        this.offX = -(off - bb.right) / 2;
        this.offY = -(off - bb.bottom) / 2;

        const zoom = Graph.zoom;
        const m2 = zoom.mag2();
        this.izx = zoom.x / m2;
        this.izy = -zoom.y / m2;
        this.panX = Graph.pan.x;
        this.panY = Graph.pan.y;
        this.contentZoom = m2 ** -settings.zoomContentExp;

        // Share the force budget: if last frame's requests would have cost
        // more than the budget, each node now evaluates with the matching
        // probability and otherwise reuses its previous gradient.
        if (this.forceDone > 0) {
            const cost = this.forceSpent / this.forceDone;
            this.forceCost += (cost - this.forceCost) * 0.2;
        }
        const demand = this.forceAsked * this.forceCost;
        this.forceChance = (demand > this.forceBudgetMs ? this.forceBudgetMs / demand : 1);
        this.forceAsked = 0;
        this.forceSpent = 0;
        this.forceDone = 0;
        this.shownNow = 0;
    },

    endFrame(){ this.shown = this.shownNow },

    /* Fractal gradient at a node, refreshed as the budget allows. */
    gradFor(node){
        this.forceAsked += 1;
        const fresh = node.fractalGrad && node.fractalGradEpoch === DeepFrame.epoch;
        if (fresh && Math.random() > this.forceChance) return node.fractalGrad;

        const start = performance.now();
        const g = Fractal.grad(Fractal.maxIter(), node.pos);
        this.forceSpent += performance.now() - start;
        this.forceDone += 1;
        node.fractalGrad = g;
        node.fractalGradEpoch = DeepFrame.epoch;
        return g;
    },

    // ------------------------------------------------------ size cache --

    sizes: null,
    observe(node){
        if (!this.sizes) {
            if (typeof ResizeObserver === 'undefined') return;
            this.owners = new WeakMap();
            this.sizes = new ResizeObserver((entries)=>{
                for (const entry of entries) {
                    const owner = this.owners.get(entry.target);
                    if (!owner) continue;

                    const box = entry.borderBoxSize?.[0];
                    const w = box ? box.inlineSize : entry.target.offsetWidth;
                    const h = box ? box.blockSize : entry.target.offsetHeight;
                    if (w > 0 && h > 0) { // zero while display:none; keep the last size
                        owner.layoutW = w;
                        owner.layoutH = h;
                    }
                }
            });
        }
        this.owners.set(node.content, node);
        this.sizes.observe(node.content);
    },
    unobserve(node){
        if (this.sizes && node.content) this.sizes.unobserve(node.content);
    },

    /* Nodes the user is actively working with are never culled. */
    isHeld(node){
        if (node.followingMouse || node === Autopilot.referenceFrame) return true;
        if (App.selectedNodes.uuids.has(node.uuid)) return true;
        const active = document.activeElement;
        return !!active && active !== document.body && node.content.contains(active);
    }
};
