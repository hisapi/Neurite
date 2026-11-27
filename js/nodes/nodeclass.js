class Node {
    static prev = null;

    anchor = new vec2(0, 0);
    anchorForce = 0;
    createdAt = new Date().toISOString();
    edges = [];
    init = Function.nop;
    mouseAnchor = new vec2(0, 0);
    save_extras = [];
    view = null;

    constructor(thing, createEdges = true){
        if (thing) {
            this.content = thing;
            const dataset = thing.dataset;

            const nodeData = JSON.parse(dataset.node_json)
            const vecProps = ['anchor', 'mouseAnchor', 'vel', 'pos', 'force'];
            for (const k in nodeData) {
                if (k === 'frame' || k === 'parkedAt') continue;
                const val = nodeData[k];
                this[k] = (vecProps.includes(k) ? new vec2(val) : val);
            }
            // Saved coordinates are relative to the frame they were saved in.
            DeepFrame.adoptNode(this, nodeData.frame, nodeData.parkedAt);

            if (dataset.node_extras) {
                const extraData = JSON.parse(dataset.node_extras);
                for (const e of extraData) Node.Extensions[e.f](this, e.a);
            }

            if (dataset.edges !== undefined && createEdges) {
                const edgesData = JSON.parse(dataset.edges);
                this.init = ()=>{
                    for (const edgeData of edgesData) {
                        edgeFromJSON(edgeData)
                    }
                };
            }
        } else {
            this.content = Html.new.div();
            this.uuid = String(Graph.nextUuid);
            this.pos = Graph.vecToZ();

            this.vel = new vec2(0, 0);
            this.force = new vec2(0, 0);
            this.frictionConstant = 0.2;
            this.intervalID = null;
            this.followingMouse = 0;

            this.randomNodeFlowRange = (Math.random() - 0.5) * settings.flowDirectionRandomRange;
            this.removed = false;
            this.sensor = new NodeSensor(this, 3);
        }

        this.addListeners();
        DeepPerf.observe(this);
    }
    addListeners() {
        const div = this.content;
        On.click(div, this.onClick);
        On.dblclick(div, this.onDblClick);
        On.mousedown(div, this.onMouseDown);
        On.mousemove(document, this.onMouseMove);
        On.mouseup(document, this.onMouseUp);
        On.wheel(div, this.onWheel);
    }
    static transientKeys = new Set([
        "content", "edges", "save_extras", "viewer",
        "aiResponseEditor", "aiNodeMessageLoop", "sensor", "responseHandler",
        "view", "agent", "typeNode",
        // per-session draw / deep-zoom state
        "deep", "parked", "culled", "layoutW", "layoutH", "drawn",
        "fractalGrad", "fractalGradEpoch", "deepRecord"
    ]);
    toJSON() {
        const data = {...this};
        // Positions are relative to the current deep frame; record which, so
        // they can be placed correctly when loaded at another depth.
        if (this.parked) {
            data.parkedAt = DeepFrame.describeParked(this);
        } else if (!DeepFrame.isIdentity) {
            data.frame = DeepFrame.serialize();
        }
        return JSON.stringify(data, (k, v) => (Node.transientKeys.has(k) ? undefined : v));
    }
    updateNodeData() {
        const saveExtras = [];
        for (const extra of this.save_extras) {
            saveExtras.push(typeof extra === "function" ? extra(this) : extra);
        }
        this.content.dataset.node_extras = JSON.stringify(saveExtras);
        this.content.dataset.node_json = this.toJSON();
    }
    push_extra_cb(f) {
        this.save_extras.push(f);
        return this;
    }
    push_extra(func_name, args = undefined) {
        this.save_extras.push({
            f: func_name,
            a: args
        });
    }

    updateSensor() {
        this.sensor.callUpdate();
        Logger.debug(this.sensor.nearbyNodes);
        Logger.debug("extended radius", this.sensor.nodesWithinExtendedRadius);
    }

    hasBoundingRectangle(){
        const bb = this.content.getBoundingClientRect();
        return bb && bb.width > 0 && bb.height > 0;
    }

    draw() {
        const e = this.content;
        const perf = DeepPerf;
        if (perf.frame === 0) perf.beginFrame(); // drawn before the first frame

        if (this.parked) return this.setCulled(true);

        const s = this.intrinsicScale * this.scale * perf.contentZoom;

        // Centre of the node in pixels: ((pos - pan) / zoom) mapped to the view.
        const dx = this.pos.x - perf.panX;
        const dy = this.pos.y - perf.panY;
        const cx = ((dx * perf.izx - dy * perf.izy) / 2 + .5) * perf.scale + perf.offX;
        const cy = ((dy * perf.izx + dx * perf.izy) / 2 + .5) * perf.scale + perf.offY;

        // Layout size is tracked by a ResizeObserver; measuring here would
        // force a synchronous layout for every node on every frame.
        let w = this.layoutW;
        let h = this.layoutH;
        if (w === undefined && !this.culled) {
            w = e.offsetWidth;
            h = e.offsetHeight;
            if (w > 0 && h > 0) {
                this.layoutW = w;
                this.layoutH = h;
            }
        }
        w ||= 0;
        h ||= 0;

        // Worth drawing only if it overlaps the (padded) viewport at a size
        // between a few pixels and a few screens.
        const mx = perf.width * perf.margin;
        const my = perf.height * perf.margin;
        const hw = (w || 300) * s / 2;
        const hh = (h || 200) * s / 2;
        const visible = s >= perf.minScale && s <= perf.maxScale
            && cx + hw > -mx && cx - hw < perf.width + mx
            && cy + hh > -my && cy - hh < perf.height + my
            && Number.isFinite(cx) && Number.isFinite(cy);
        if (!visible && !(this.culled === false && perf.isHeld(this) && Number.isFinite(s))) {
            return this.setCulled(true);
        }
        this.setCulled(false);
        perf.shownNow += 1;

        const left = cx - w / 2;
        const top = cy - h / 2;
        const drawn = this.drawn ||= { s: NaN, left: NaN, top: NaN };
        if (drawn.s !== s) {
            drawn.s = s;
            e.style.transform = 'scale(' + s + ',' + s + ')';
        }
        if (drawn.left !== left) {
            drawn.left = left;
            e.style.left = left + 'px';
        }
        if (drawn.top !== top) {
            drawn.top = top;
            e.style.top = top + 'px';
        }

        //e.style['margin-top'] = "-"+(e.offsetHeight/2)+'px';//"-50%";
        //e.style['margin-left'] = "-"+(e.offsetWidth/2)+'px';//"-50%";
        //e.style['vertical-align']= 'middle';
        //e.style['text-align']= 'center';
    }

    setCulled(culled) {
        if (this.culled === culled) return;

        const style = this.content.style;
        if (culled) {
            style.display = 'none';
        } else {
            style.position = 'absolute';
            style.display = 'initial';
            // Edge forces were not consumed while hidden; do not release them at once.
            if (this.culled !== undefined && DeepPerf.freezeHidden) {
                this.vel = new vec2(0, 0);
                this.force = new vec2(0, 0);
            }
        }
        this.culled = culled;
    }
    get isAsleep() {
        return this.parked || (this.culled === true && DeepPerf.freezeHidden && !this.followingMouse);
    }

    step(dt) {
        // Hidden nodes only re-test their visibility.
        if (this.isAsleep) return this.draw();

        dt = this.clampDt(dt);
        this.updatePosition(dt);
        this.applyMandelbrotForce();
        this.applyAnchorForce();
        this.handleMouseInteraction(dt);
        this.draw();
    }

    clampDt(dt) {
        return (isNaN(dt) ? 0 : Math.min(dt, 1))
    }

    updatePosition(dt) {
        if (!this.followingMouse && this.anchorForce == 0) {
            this.pos = this.pos.plus(this.vel.scale(dt / 2));
            this.vel = this.vel.plus(this.force.scale(dt));
            this.pos = this.pos.plus(this.vel.scale(dt / 2));
            this.force = this.vel.scale(-Math.min(this.vel.mag() + this.frictionConstant + this.anchorForce, 1 / (dt + 1e-300)));
        } else {
            this.vel = new vec2(0, 0);
            this.force = new vec2(0, 0);
        }
    }

    applyMandelbrotForce() {
        if (this.anchorForce !== 0) return;

        const g = DeepPerf.gradFor(this);

        if (settings.useFlowDirection && g.mag2() > 0) {
            const randomRotation = this.randomNodeFlowRange;
            const flowDirection = g.rot(settings.flowDirectionRotation + randomRotation).normed();
            const forceMagnitude = g.mag();

            this.force = this.force.plus(flowDirection.scale(forceMagnitude).unscale((g.mag2() + 1e-10) * 300));
        }

        if (!settings.useFlowDirection && g.mag2() > 0) {
            this.force = this.force.plus(g.unscale((g.mag2() + 1e-10) * 300))
        }
    }

    applyAnchorForce() {
        this.force = this.force.plus(this.anchor.minus(this.pos).scale(this.anchorForce))
    }

    handleMouseInteraction(dt) {
        if (!this.followingMouse) return;

        const p = Graph.vecToZ().minus(this.mouseAnchor);
        const velocity = p.minus(this.pos).unscale(App.nodeMode ? 1 : dt);

        this.vel = velocity;
        this.pos = p;
        this.anchor = this.pos;

        if (App.nodeMode === 1) updateNodeEdgesLength(this);

        if (!App.selectedNodes.uuids.has(this.uuid)) return;

        App.selectedNodes.forEach(node => {
            if (node.uuid === this.uuid || node.anchorForce === 1) return;

            node.vel = velocity;
            if (App.nodeMode === 1) updateNodeEdgesLength(node);
        });
    }

    moveNode(angle, forceMagnitude = 0.01) {
        const adjustedForce = forceMagnitude * this.scale; // Scale the force
        const forceDirection = new vec2(Math.cos(angle) * adjustedForce, Math.sin(angle) * adjustedForce);

        // Apply the force to the node
        this.force = this.force.plus(forceDirection);
        return forceDirection; // optional
    }

    moveTo(x, y, baseTolerance = 1, onComplete = ()=>{} ) {
        const targetComplexCoords = new vec2(x, y);
        const tolerance = baseTolerance * this.scale;

        const update = () => {
            const distanceVector = targetComplexCoords.minus(this.pos);
            const distance = distanceVector.mag();
            if (distance < tolerance) {
                clearInterval(this.intervalID);
                clearTimeout(this.timeoutID);
                this.intervalID = null;
                onComplete();
            } else {
                const forceMagnitude = Math.min(0.002 * this.scale, distance);
                const forceDirection = distanceVector.normed().scale(forceMagnitude);
                this.force = this.force.plus(forceDirection);
            }
        };

        if (this.intervalID !== null) clearInterval(this.intervalID);
        if (this.timeoutID !== null) clearTimeout(this.timeoutID);

        this.intervalID = setInterval(update, 20); // Start the movement updates

        // Set a fixed timeout to stop the movement after 4 seconds
        this.timeoutID = setTimeout(() => {
            clearInterval(this.intervalID);
            this.intervalID = null;
            Logger.debug("Movement stopped after 4 seconds.");
            onComplete(); // even if the target hasn't been reached
        }, 4000); // 4 secs
    }

    searchStrings() {
        function* search(e) {
            yield e.textContent;
            if (e.value) yield e.value;
            for (const c of e.children) yield* search(c);
        }
        return search(this.content);
    }
    onClick = (e)=>{

    }
    toggleWindowAnchored(anchored) {
        const windowDiv = this.view.div;
        if (windowDiv.classList.contains('collapsed')) return;

        windowDiv.classList.toggle('window-anchored', anchored);
    }
    onDblClick = (e) => {
    }
    onMouseDown = (e) => {
        this.mouseAnchor = Graph.xyToZ(e.clientX, e.clientY).minus(this.pos);
        this.followingMouse = 1;
        Graph.draggedNode = this;
        Graph.movingNode = this;

        if (Node.prev) {
            connectNodes(this, Node.prev);
            Node.prev = null;
        } else if (App.nodeMode) {
            Node.prev = this;
        }

        clearTextSelections();

        this._initialMousePos = { x: e.clientX, y: e.clientY };
        this._hasAddedGrabbing = false;

        On.mousemove(window, this._maybeAddGrabbing);
        On.mouseup(window, this.stopFollowingMouse);

        e.stopPropagation();
    }
    _maybeAddGrabbing = (e) => {
        if (this._hasAddedGrabbing) return;

        const dx = e.clientX - this._initialMousePos.x;
        const dy = e.clientY - this._initialMousePos.y;
        const distanceSq = dx * dx + dy * dy;

        if (distanceSq > 4) {
            this._hasAddedGrabbing = true;
            OverlayHelper.add('grabbing');
            Off.mousemove(window, this._maybeAddGrabbing); // Remove listener after adding
        }
    }
    stopFollowingMouse = (e) => {
        this.followingMouse = 0;
        Graph.movingNode = undefined;

        Off.mousemove(window, this._maybeAddGrabbing);
        Off.mouseup(window, this.stopFollowingMouse);
        OverlayHelper.remove(); // Clean up just in case
    }

    disableEmbedPointerEvents(){this.setEmbedPointerEvents('none')};
    enableEmbedPointerEvents(){ this.setEmbedPointerEvents('auto')};
    setEmbedPointerEvents(value) {
        this.content.querySelectorAll('iframe, webview').forEach(embed => {
            embed.style.pointerEvents = value;
        });
    }

    onMouseUp = (e)=>{
        if (this === Graph.draggedNode) {
            this.followingMouse = 0;
            Graph.draggedNode = undefined;
        }
    }
    onMouseMove = (e)=>{
        if (this === Graph.draggedNode) Node.prev = null;
        /*if (this.followingMouse){
        this.pos = this.pos.plus(toDZ(new vec2(e.movementX,e.movementY)));
        this.draw()
        //e.stopPropagation();
        }*/
    }
    onWheel = (e)=>{
        if (!App.nodeMode) return;

        const amount = Math.exp(e.wheelDelta * -settings.zoomSpeed);

        if (Autopilot.isMoving() && this.uuid === Autopilot.referenceFrame.uuid) {
            Autopilot.targetZoom_scaleBy(1 / amount);
        } else {
            // Scale selected nodes or individual node
            const targetWindow = e.target.closest('.window');
            if (targetWindow && targetWindow.classList.contains('selected')) {
                App.selectedNodes.forEach((node) => {
                    node.scale *= amount;

                    // Only update position if the node is not anchored
                    if (node.anchorForce !== 1) {
                        node.pos = node.pos.lerpto(Graph.vecToZ(), 1 - amount);
                    }

                    updateNodeEdgesLength(node);
                });
            } else {
                this.scale *= amount;

                // Only update position if not anchored
                if (this.anchorForce !== 1) {
                    this.pos = this.pos.lerpto(Graph.vecToZ(), 1 - amount);
                }
            }
        }
        e.stopPropagation();
    }
    disableEmbedPointerEvents(){this.setEmbedPointerEvents('none')};
    enableEmbedPointerEvents(){ this.setEmbedPointerEvents('auto')};
    setEmbedPointerEvents(value) {
        this.content.querySelectorAll('iframe, webview').forEach(embed => {
            embed.style.pointerEvents = value;
        });
    }

    getText(){
        return (this.textarea || this.contentEditableDiv)?.value || ''
    }
    getTitle(){ return this.view.titleInput.value }

    getEdgeDirectionalities() {
        return this.edges.map( (edge)=>({
            edge,
            directionality: edge.getDirectionRelativeTo(this)
        }) );
    }

    addEdge(edge) {
        this.edges.push(edge);
        this.updateEdgeData();
    }
    static addEdgeThis(node){ node.addEdge(this) }

    updateEdgeData() {
        const es = JSON.stringify(this.edges.map(Edge.dataForEdge));
        Logger.debug("Saving edge data:", es);
        this.content.dataset.edges = es;
    }

    removeEdgeByIndex(index){
        this.edges[index].remove();
        this.edges.splice(index, 1);
    }
    removeEdgeByTitle(targetTitle) {
        const edges = this.node.edges;
        let removed = false;

        for (let i = edges.length - 1; i >= 0; i--) {
            if (edges[i].pts.some(pt => pt.getTitle() === targetTitle)) {
                Logger.debug(`Disconnecting edge to node: ${targetTitle}`);
                edges[i].remove(); // Directly remove the edge
                removed = true;
            }
        }

        if (!removed) {
            Logger.warn(`No edge found connecting to node: ${targetTitle}`);
        }
    }
    removeConnectedNodes(nodes) {
        const nodeUUIDs = new Set(nodes.map(node => String.uuidOf(node)));

        for (let i = this.edges.length - 1; i >= 0; i--) {
            const edge = this.edges[i];
            if (edge.pts.some(pt => nodeUUIDs.has(pt.uuid))) {
                edge.remove();
            }
        }
    }

    remove(){ Graph.deleteNode(this) }

    static byUuid(uuid){ return Graph.nodes[uuid] }
    static filterEdgesToThis(node){
        node.edges = node.edges.filter( (edge)=>!edge.pts.includes(this) )
    }
    static getType(node){
        if (node.isTextNode) return 'text';
        if (node.isLLM) return 'llm';
        if (node.isLink) return 'link';
        return 'base';
    }
    static remove(node){ node.remove() }
    static removeThisEdge(node){
        const index = node.edges.indexOf(this);
        if (index < 0) return;

        node.edges.splice(index, 1);
        node.updateEdgeData();
    }
}

Node.Extensions = {
    "window": (node, a)=>{
        const odiv = node.content;
        odiv.dataset.viewType = 'nodeViews';
        odiv.dataset.viewId = node.uuid;

        const view = node.view = new NodeView(node);
        view.buttons = odiv.querySelector('.button-container');
        view.headerContainer = odiv.querySelector('.header-container');
        view.innerContent = odiv.querySelector('.content');
        view.resizeHandle = odiv.querySelector('.resize-handle');
        view.titleInput = odiv.querySelector('.title-input');
        view.div = odiv.querySelector('.window');
        view.rewindowify();
    },
    "textarea": (node, o) => {
        let e = node.content;
        for (const w of o.p) {
            e = e.children[w];
        }

        const p = o.p;
        e.value = o.v;

        node.push_extra_cb( (n)=>({
            f: "textarea",
            a: { p, v: e.value }
        }) );
    },
    "textareaId": (node, o) => {
        const textarea = node.content.querySelector('#' + o.p);
        if (textarea) textarea.value = o.v;

        node.push_extra_cb( (n)=>({
            f: "textareaId",
            a: {
                p: textarea.id,
                v: textarea.value
            }
        }) );
    },
    "checkboxId": (node, o) => {
        // Query for checkboxes based on a specific ID and update their state
        const checkbox = node.content.querySelector(`input[type="checkbox"][id='${o.p}']`);
        if (!checkbox) return;

        checkbox.checked = o.v;
        node.push_extra_cb( (n)=>({
            f: "checkboxId",
            a: {
                p: o.p,  // Pass the ID of the checkbox
                v: checkbox.checked  // Save the current state
            }
        }) );
    },
    "sliderId": (node, o) => {
        // Query for sliders based on a specific ID and update their value
        const slider = node.content.querySelector(`input[type="range"][id='${o.p}']`);
        if (!slider) return;

        slider.value = o.v ?? o.d;  // Set the slider's value based on the value provided or the default value
        node.push_extra_cb( (n)=>({
            f: "sliderId",
            a: {
                p: o.p,  // Pass the ID of the slider
                v: slider.value  // Save the current value
            }
        }) );
    },
}
