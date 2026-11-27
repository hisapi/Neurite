//frame();
let nodeMode_v = 0;
let current_time;
let regenAmount = 0;
let regenDebt = 0;
let avgfps = 0;

//let manualConnectionOverride = false;

Autopilot.update = function(time){
    if (this.deepFlight) {
        this.deepFlight.step(time);
        return Autopilot.showCoords();
    }
    if (this.speed === 0) return Autopilot.showCoords(); // idle: nothing to interpolate

    const oldPan = Graph.pan;
    let newPan;
    if (this.referenceFrame && this.speed !== 0) {
        if (!this.panToI_prev) {
            this.panToI_prev = this.referenceFrame.pos.scale(1);
            this.referenceScalePrev = this.referenceFrame.scale;
        }
        this.panToI = this.panToI.scale(1 - settings.autopilotRF_Iscale).plus(this.referenceFrame.pos.minus(this.panToI_prev).scale(settings.autopilotRF_Iscale));
        newPan = oldPan.scale(1 - this.speed).plus(this.referenceFrame.pos.scale(this.speed).plus(this.panToI));
        this.panToI_prev = this.referenceFrame.pos.scale(1);

        if (this.referenceFrame.scale !== this.referenceScalePrev) {
            let scaleFactor = this.referenceFrame.scale / this.referenceScalePrev;
            const maxScaleChangePerFrame = 0.1;
            scaleFactor = Math.max(Math.min(scaleFactor, 1 + maxScaleChangePerFrame), 1 - maxScaleChangePerFrame);

            this.targetZoom = this.targetZoom.scale(scaleFactor);
            this.referenceScalePrev = this.referenceFrame.scale;
        }
    } else {
        newPan = oldPan.scale(1 - this.speed)
                .plus(this.targetPan.scale(this.speed));
        this.panToI_prev = null;
    }

    const autopilot_travelDist = oldPan.minus(newPan).mag() / Graph.zoom.mag();
    if (autopilot_travelDist > settings.autopilotMaxSpeed) {
        newPan = oldPan.plus(newPan.minus(oldPan).scale(settings.autopilotMaxSpeed / autopilot_travelDist));
        const speedCoeff = Math.tanh(Math.log(settings.autopilotMaxSpeed / autopilot_travelDist + 1e-300) / 10) * 2;
        Graph.zoom_scaleBy(1 - speedCoeff * this.speed);
    } else {
        let zoom = Graph.zoom.scale(1 - this.speed)
                    .plus(this.targetZoom.scale(this.speed));
        // A target many octaves away would otherwise be reached in one
        // frame; cap the change so the motion stays continuous.
        const ratio = zoom.mag() / Graph.zoom.mag();
        if (ratio > 4) zoom = zoom.scale(4 / ratio);
        Graph.zoom_set(zoom);
    }
    Graph.pan_set(newPan);
    Autopilot.showCoords();
}
Autopilot.showCoords = function(){
    if (!App.interface.coordsLive) return;

    if (DeepFrame.isIdentity) {
        panInput.value = Graph.pan.ctostring();
        zoomInput.value = String(Graph.zoom.mag());
        return;
    }
    // Beyond float range the coordinates are shown as exact decimals.
    const view = DeepFrame.viewStrings();
    panInput.value = view.re + (view.im[0] === '-' ? '-i' + view.im.slice(1) : '+i' + view.im);
    zoomInput.value = view.zoom;
}

class NodeSimulation {
    framesLeftToSkip = 0;
    mousePath = [];
    mousePathPos = new vec2(0, 0);
    svg_mousePath = svg.getElementById('mousePath');
    current_time = undefined;

    processSelectedNodes() {
        processScalingKeys();

        const movementAngle = getDirectionAngleFromKeyState();
        if (movementAngle === null) return;

        App.selectedNodes.forEach(Node.moveAtThisAngle, movementAngle);
    }

    updateMousePath() {
        // The orbit of c lives at unit scale. In a deep frame it is off any
        // conceivable screen, and local coordinates are not absolute anyway.
        if (!DeepFrame.isIdentity) {
            if (this.mousePath.length > 0) this.mousePath = [];
            return;
        }

        if (this.mousePath.length < 1) {
            this.mousePathPos = Graph.vecToZ();
            this.mousePath = ["M ", this.mousePathPos.toSvg(), " L "];
        }

        const step = Fractal.step;
        for (let i = 0; i < settings.orbitStepRate; i += 1) {
            this.mousePathPos = step(this.mousePathPos, Graph.vecToZ());
            const vecSvg = this.mousePathPos.toSvg();
            if (vecSvg.isFinite() && vecSvg.mag2() < 1e60) {
                this.mousePath.push(vecSvg, " ")
            }
        }
    }

    updateMousePathWidth() {
        const svg_mousePath = this.svg_mousePath;
        let width = Graph.zoom.mag() * 0.0005 * Svg.zoom;

        if (Node.prev) {
            const m = Node.prev.pos.toSvg();
            const l = Graph.vecToZ().toSvg();
            svg_mousePath.setAttribute('d', "M " + m + " L " + l);
            width *= 50;
        } else {
            svg_mousePath.setAttribute('d', this.mousePath.join(''));
        }

        if (!App.nodeMode && !Node.prev) {
            Node.prev = null;
            this.mousePath = [];
            svg_mousePath.setAttribute('d', '');
        }

        svg_mousePath.setAttribute('stroke-width', String(width));
    }

    updateFPS(time) {
        if (this.current_time === undefined) {
            this.current_time = time;
        }
        let dt = time - this.current_time;
        this.current_time = time;
        if (dt > 0) {
            const alpha = Math.exp(-1 * dt / 1000);
            avgfps = avgfps * alpha + (1 - alpha) * 1000 / dt;
        }
        const rounded = (avgfps > 1) ? Math.round(avgfps)
                      : Math.round(avgfps * 10) / 10;
        Elem.byId('debug_layer').children[1].textContent = "fps:" + rounded;
        Elem.byId('fps').textContent = rounded + " fps";
        return dt;
    }

    updateNodes(dt) {
        dt *= (1 - nodeMode_v) ** 5;
        Graph.forEachNode(this.updateForThisDt, dt);
        return this;
    }
    updateForThisDt(item){
        item.step(this);
        //let d = Graph.vecToZ().minus(n.pos);
    }
    updateEdges(dt) {
        Graph.forEachEdge(this.updateForThisDt, dt);
        return this;
    }

    updateRegen() {
        const lerp = Math.lerp;
        const random = Math.random;
        regenDebt = Math.min(16, regenDebt + lerp(settings.regenDebtAdjustmentFactor, regenAmount, Math.min(1, (nodeMode_v ** 5) * 1.01)));
        // Deep hairs can each cost thousands of iterations per point. Draw as
        // many as fit the frame budget and carry the rest over, so depth
        // slows the background's refresh instead of the frame rate.
        const deadline = (DeepFractal.active ? performance.now() + DeepPerf.hairBudgetMs : Infinity);
        DeepFractal.deadline = deadline + DeepPerf.hairBudgetMs; // a hair in progress may run this far over
        for (; regenDebt > 0; regenDebt--) {
            Fractal.render_hair(random() * settings.renderSteps);
            if (performance.now() > deadline) break;
        }
        regenAmount = 0;
        nodeMode_v = lerp(nodeMode_v, App.nodeMode, 0.125);
    }

    nodeStep = (time)=>{
        this.framesLeftToSkip -= 1;
        if (this.framesLeftToSkip > 0) {
            return window.requestAnimationFrame(this.nodeStep)
        }

        const delay = settings.framesDelay;
        this.framesLeftToSkip = Math.round((delay + 2) ** 2 / 4);

        if (App.selectedNodes.uuids.size > 0) this.processSelectedNodes();

        DeepFrame.maintain();
        Autopilot.update(time);
        DeepFrame.maintain();   // the autopilot may have moved the view a long way
        DeepFractal.update();
        DeepPerf.beginFrame();
        DeepStore.frame();
        Svg.updateViewbox();
        this.updateMousePath();
        this.updateMousePathWidth();
        const dt = this.updateFPS(time);
        this.updateNodes(dt).updateEdges(dt).updateRegen();
        DeepPerf.endFrame();

        window.requestAnimationFrame(this.nodeStep);
    }

    start() {
        window.requestAnimationFrame(this.nodeStep);
    }
}
