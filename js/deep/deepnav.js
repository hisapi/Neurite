/* =============================================================================
 * deepnav.js — camera flights between absolute positions at any depth
 * -----------------------------------------------------------------------------
 * The stock autopilot interpolates pan and zoom linearly in world coordinates.
 * That cannot express a move whose endpoints differ by hundreds of orders of
 * magnitude, and its targets are doubles. A Flight instead works on the
 * absolute BigInt target and in log-zoom:
 *
 *   - if the target is off screen, zoom out until it is in view while sliding
 *     toward it;
 *   - then zoom toward the target zoom, keeping the target point fixed on
 *     screen and easing it to the centre;
 *   - on arrival, snap exactly onto the target.
 *
 * Long hauls accelerate in proportion to the octaves remaining, so a dive of
 * thousands of octaves takes seconds rather than minutes.
 * ========================================================================== */

const DeepNav = {
    /* Resolves true on arrival, false if interrupted (any user navigation
     * stops the autopilot, which cancels the flight). */
    flyTo(target, zoomSx, opts = {}){
        if (Autopilot.deepFlight) Autopilot.stop();

        if (opts.instant) {
            DeepFrame.setView(target, zoomSx);
            return Promise.resolve(true);
        }
        return new Promise( (resolve)=>{
            const flight = new DeepNav.Flight(target, zoomSx || DeepFrame.zoomSx(), opts.speed, resolve);
            Autopilot.setNode();
            Autopilot.deepFlight = flight;
            Autopilot.speed = flight.speed;
        });
    },

    Flight: class {
        IN_VIEW = 0.6;      // target counts as visible within this many half-screens
        MAX_SLIDE = 0.25;   // half-screens per frame while the target is far
        ARRIVED = 0.002;

        constructor(target, zoomSx, speed, resolve){
            speed = Number(speed);
            if (!(speed > 0) || speed > 1) speed = settings.autopilotSpeed;
            this.speed = Math.min(speed, 0.9);
            this.target = target;
            this.zoom = zoomSx;
            this.resolve = resolve;
            this.lastTime = null;
        }

        finish(arrived){
            if (Autopilot.deepFlight === this) {
                Autopilot.deepFlight = null;
                Autopilot.speed = 0;
            }
            const resolve = this.resolve;
            this.resolve = null;
            if (resolve) resolve(arrived);
        }

        step(time){
            let frames = (this.lastTime === null ? 1 : (time - this.lastTime) / (1000 / 60));
            frames = Math.min(Math.max(frames, 0.25), 4);
            this.lastTime = time;

            const mag = Graph.zoom.mag();
            const zl = Math.log2(mag);
            const goalZoom = DeepNum.sxLog2(this.zoom) + DeepFrame.k; // local log2
            const T = DeepFrame.toLocal(this.target);
            const dx = T.x - Graph.pan.x;
            const dy = T.y - Graph.pan.y;
            const offset = Math.hypot(dx, dy);
            const reachable = Number.isFinite(offset);
            const dist = (reachable ? offset / mag : Infinity);

            if (reachable && dist < this.ARRIVED && Math.abs(goalZoom - zl) < this.ARRIVED) {
                DeepFrame.setView(this.target, this.zoom);
                return this.finish(true);
            }

            // Zoom level to aim for this frame: the target zoom, unless the
            // target is out of view, in which case the level that reveals it.
            let goal = goalZoom;
            if (dist > this.IN_VIEW) {
                goal = (reachable ? Math.max(goalZoom, Math.log2(offset / this.IN_VIEW)) : Infinity);
            }

            const base = -Math.log2(1 - this.speed) * frames;          // octaves per frame
            const remaining = Math.min(Math.abs(goal - zl), 4000);
            const rate = base * Math.max(1, remaining / 24);
            const dz = Math.max(-rate, Math.min(rate, goal - zl));
            const f = 2 ** dz;

            if (reachable) {
                const centring = Math.min(0.5, this.speed * 1.5 * frames);
                // Zooming in holds the target fixed on screen (factor f) and
                // eases it to the centre; otherwise slide toward it.
                const keep = (dz < 0) ? f * (1 - centring)
                           : 1 - Math.min(centring, this.MAX_SLIDE * frames / dist);
                Graph.pan = new vec2(T.x - dx * keep, T.y - dy * keep);
            }
            Graph.zoom = Graph.zoom.scale(f);
            regenAmount += 6 * Math.abs(dz) + 40 * Math.min(dist, 1) * (reachable ? 1 : 0);
        }
    },

    /* Convenience: decimal strings in, flight out. zoom may be omitted. */
    goTo(re, im, zoom, opts){
        const zs = (zoom === undefined || zoom === null) ? null : DeepNum.sxParse(String(zoom));
        const target = DeepFrame.parsePoint(String(re), String(im), zs || DeepFrame.zoomSx());
        if (!target) return Promise.resolve(false);
        return this.flyTo(target, zs, opts);
    }
};
