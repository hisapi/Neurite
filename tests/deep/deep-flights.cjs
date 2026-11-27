/* Deep frame: a node keeps its exact place across many re-centrings, is parked
 * at shallow zoom and restored at depth; flights reach 2e-300 and 4e-390 (past
 * the smallest double) with the background drawn. */
const { open, fps, shot, check, finish, run, COORDS } = require('./harness.cjs');

run(async ()=>{
    const { browser, page, errs } = await open();
    const status = ()=>page.evaluate( ()=>({ ...DeepFractal.status(), hairs: svg_bg.children.length, epoch: DeepFrame.epoch }) );
    const rectOf = (title)=>page.evaluate( (title)=>{
        const n = Object.values(Graph.nodes).find( (n)=>n.getTitle() === title );
        const r = n.content.getBoundingClientRect();
        return { x: +(r.x + r.width / 2).toFixed(1), y: +(r.y + r.height / 2).toFixed(1), w: +r.width.toFixed(1), parked: !!n.parked };
    }, title);
    const jump = (c, zoom)=>page.evaluate( ([re, im, zoom])=>DeepNav.goTo(re, im, zoom, { instant: true }), [c.re, c.im, zoom]);

    // A node made at 3e-60, zoomed into by 2^120 and back out.
    await jump(COORDS[61], '3e-60');
    await page.waitForTimeout(500);
    await page.evaluate( ()=>{
        const n = TextNode.create('deepnode', 'made at 3e-60', 0.2, -0.1);
        n.anchorForce = 1;
        n.anchor = n.pos;
        n.draw();
    });
    await page.waitForTimeout(300);
    const before = await rectOf('deepnode');

    await page.evaluate(async ()=>{
        const n = Object.values(Graph.nodes).find( (n)=>n.getTitle() === 'deepnode' );
        for (let i = 0; i < 240; i++) {
            performZoom(Math.SQRT2, n.pos);
            await new Promise( (r)=>requestAnimationFrame(r) );
        }
    });
    const deepest = await status();
    check(deepest.k > 300 && deepest.epoch >= 6, 'zooming in re-centred the frame repeatedly', deepest);

    await page.evaluate(async ()=>{
        const n = Object.values(Graph.nodes).find( (n)=>n.getTitle() === 'deepnode' );
        for (let i = 0; i < 240; i++) {
            const at = (n.parked ? DeepFrame.toLocal(n.deep.pos) : n.pos);
            performZoom(Math.SQRT1_2, at);
            await new Promise( (r)=>requestAnimationFrame(r) );
        }
    });
    await page.waitForTimeout(300);
    const after = await rectOf('deepnode');
    check(JSON.stringify(before) === JSON.stringify(after), 'node returns to the same pixel after +-120 octaves', { before, after });

    // Out to the home view (where a double cannot hold its position) and back.
    await page.evaluate( ()=>DeepNav.goTo('-0.3', '0', '1.3', { instant: true }) );
    await page.waitForTimeout(300);
    check((await rectOf('deepnode')).parked, 'node is parked at shallow zoom');
    check(await page.evaluate( ()=>DeepFrame.isIdentity ), 'frame is the identity at shallow zoom');
    await jump(COORDS[61], '3e-60');
    await page.waitForTimeout(300);
    const back = await rectOf('deepnode');
    check(JSON.stringify(before) === JSON.stringify(back), 'node is restored exactly on returning to depth', { before, back });

    // Flights.
    for (const [depth, zoom] of [[301, '2e-300'], [391, '4e-390']]) {
        const t = Date.now();
        const arrived = await page.evaluate( ([re, im, zoom])=>DeepNav.goTo(re, im, zoom, { speed: 0.1 }), [COORDS[depth].re, COORDS[depth].im, zoom]);
        const ms = Date.now() - t;
        await page.waitForTimeout(5000);
        const st = await status();
        const view = await page.evaluate( ()=>NeuriteDeep.getView() );
        console.log(`flight to ${zoom}: ${ms} ms`, JSON.stringify(st), JSON.stringify(await fps(page)));
        check(arrived === true, `flight to ${zoom} arrives`);
        check(view.re.startsWith(COORDS[depth].re.slice(0, 60)), `view centre matches the target at ${zoom}`);
        check(st.active && st.hairs > 20, `background is drawn at ${zoom}`, st);
        await shot(page, 'flight-' + zoom);
    }

    await finish(browser, errs);
});
