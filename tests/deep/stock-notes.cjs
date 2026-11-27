/* Stock Neurite notes and edges at depth: creation through the note API,
 * edges across re-centrings, and a save -> clear -> load round trip that is
 * loaded from a different depth than it was saved at. */
const { open, check, finish, run, COORDS } = require('./harness.cjs');

run(async ()=>{
    const { browser, page, errs } = await open();
    const toDepth = ()=>page.evaluate( ([re, im])=>DeepNav.goTo(re, im, '3e-60', { instant: true }), [COORDS[61].re, COORDS[61].im]);
    // Placement of every node, plus whether it is linked and how long the
    // edge is relative to the view. (Not the raw edge count: connecting two
    // text notes lists the same edge twice on one of them, on any build, and
    // a save/load collapses that duplicate.)
    const snap = ()=>page.evaluate( ()=>Object.values(Graph.nodes).map( (n)=>{
        const r = n.content.getBoundingClientRect();
        const edge = n.edges[0];
        return {
            t: n.getTitle(),
            x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width),
            linked: n.edges.length > 0,
            edgeLength: edge ? +(edge.length / Graph.zoom.mag()).toFixed(9) : null,
            edgeHidden: edge ? edge.hidden : null,
            parked: !!n.parked
        };
    }).sort( (p, q)=>p.t.localeCompare(q.t) ) );

    await toDepth();
    await page.waitForTimeout(800);
    const made = await page.evaluate(async ()=>{
        const a = await neuriteAddNote('alpha', 'first');
        const b = await neuriteAddNote('beta', 'second');
        connectNodes(a, b);
        for (const n of [a, b]) {
            n.anchorForce = 1;
            n.anchor = n.pos;
        }
        await new Promise( (r)=>setTimeout(r, 1500) );
        const edge = a.edges[0];
        const box = edge && edge.view.svgLink.getBoundingClientRect();
        return { edgesA: a.edges.length, edgesB: b.edges.length, hidden: edge && edge.hidden, drawn: !!box && box.width > 0 };
    });
    check(made.edgesA > 0 && made.edgesB > 0 && made.hidden === false && made.drawn, 'notes connect and the edge is drawn at depth', made);

    // Edge and nodes across re-centrings.
    const across = await page.evaluate(async ()=>{
        const a = Object.values(Graph.nodes).find( (n)=>n.getTitle() === 'alpha' );
        const rect = ()=>{
            const r = a.content.getBoundingClientRect();
            return [Math.round(r.x), Math.round(r.y), Math.round(r.width)];
        };
        const before = rect();
        const lenBefore = a.edges[0].length / Graph.zoom.mag();
        for (const factor of [Math.SQRT2, Math.SQRT1_2]) {
            for (let i = 0; i < 100; i++) {
                performZoom(factor, Graph.pan);
                await new Promise( (r)=>requestAnimationFrame(r) );
            }
        }
        await new Promise( (r)=>setTimeout(r, 300) );
        return { before, after: rect(), lenRatio: (a.edges[0].length / Graph.zoom.mag()) / lenBefore, hidden: a.edges[0].hidden };
    });
    check(JSON.stringify(across.before) === JSON.stringify(across.after), 'node unmoved after +-50 octaves', across);
    check(Math.abs(across.lenRatio - 1) < 1e-9 && across.hidden === false, 'edge length and visibility survive re-centring', across);

    const before = await snap();
    const call = await page.evaluate( ()=>Graph.getCoords(true) );
    check(/^setMandelbrotCoords\("[^"]+e-60", "-0\.7493/.test(call), 'coordinates export as exact decimal strings', call.slice(0, 80));

    // Save as the Saver does, clear, and load from the home view.
    const data = await page.evaluate( ()=>{
        Graph.forEachNode( (n)=>{ n.updateEdgeData(); n.updateNodeData(); });
        return Elem.byId('nodes').innerHTML;
    });
    await page.evaluate( ()=>{
        Graph.clear();
        return DeepNav.goTo('-0.3', '0', '1.3', { instant: true });
    });
    await page.waitForTimeout(300);
    const loaded = await page.evaluate( (data)=>{
        const div = document.createElement('div');
        div.innerHTML = data;
        const nodes = [];
        for (const child of Array.from(div.children)) {
            const node = new Node(child);
            nodes.push(node);
            Graph.addNode(node);
        }
        for (const child of div.children) {
            const e = child.dataset.edges;
            if (e) JSON.parse(e).forEach(Graph.setEdgeDirectionalityFromData, Graph);
        }
        for (const node of nodes) {
            Graph.appendNode(node);
            node.init();
            if (node.isTextNode) TextNode.init(node);
            node.sensor = new NodeSensor(node, 3);
        }
        return nodes.map( (n)=>!!n.parked );
    }, data);
    check(loaded.length === 2 && loaded.every(Boolean), 'deep notes loaded at home are parked, not misplaced', loaded);

    await toDepth();
    await page.waitForTimeout(800);
    const after = await snap();
    check(JSON.stringify(before) === JSON.stringify(after), 'save/load round trip is exact', { before, after });

    // The exported function call brings the view back.
    await page.evaluate( ()=>DeepNav.goTo('-0.3', '0', '1.3', { instant: true }) );
    await page.evaluate( (call)=>eval(call.replace('setMandelbrotCoords', 'neuriteSetMandelbrotCoords').replace('0.1);', '0.5)')), call);
    await page.waitForTimeout(500);
    check(JSON.stringify(await snap()) === JSON.stringify(before), 'exported coordinates return to the same view');

    await finish(browser, errs);
});
