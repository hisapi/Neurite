/* Entering and leaving the deep frame by ordinary zooming, the stock
 * zoom-to-node at depth, other exponents and fractal types, and the
 * main-thread fallback for the reference orbit. */
const { open, frames, check, finish, run, COORDS } = require('./harness.cjs');

run(async ()=>{
    const { browser, page, errs } = await open();
    const rect = (title)=>page.evaluate( (title)=>{
        const n = Object.values(Graph.nodes).find( (n)=>n.getTitle() === title );
        const r = n.content.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), !!n.parked];
    }, title);

    // Smooth zoom from home to ~1e-27 and back, with a stock node made at home.
    await page.evaluate( ()=>{
        const n = TextNode.create('homenode', 'made at home', 0.3, 0.2);
        n.anchorForce = 1;
        n.anchor = n.pos;
        n.draw();
    });
    await frames(page, 20);
    const before = await rect('homenode');
    const trace = await page.evaluate(async ()=>{
        const out = [];
        const target = DeepFrame.parsePoint('-0.74364', '0.13183');
        for (const factor of [Math.SQRT2, Math.SQRT1_2]) {
            for (let i = 0; i < 180; i++) {
                performZoom(factor, DeepFrame.toLocal(target));
                await new Promise( (r)=>requestAnimationFrame(r) );
                if (i % 45 === 44) out.push({ zoom: NeuriteDeep.getView().zoom, identity: DeepFrame.isIdentity, hairs: svg_bg.children.length });
            }
        }
        return out;
    });
    console.log('zoom trace', JSON.stringify(trace));
    check(trace[0].identity && !trace[1].identity, 'frame leaves the identity while zooming in', trace.slice(0, 2));
    check(!trace[3].identity && Number(trace[3].zoom) < 1e-26, 'reaches ~1e-27 by ordinary zooming', trace[3]);
    check(trace[3].hairs > 20, 'background keeps drawing past double precision', trace[3]);
    check(trace[7].identity, 'frame returns to the identity on zooming back out', trace[7]);

    await page.evaluate( ()=>DeepNav.goTo('0', '0', '1', { instant: true }) );
    await frames(page, 20);
    const after = await rect('homenode');
    check(JSON.stringify(before) === JSON.stringify(after), 'home node is where it was after the round trip', { before, after });

    // Stock autopilot zoom-to-node at depth.
    await page.evaluate( ([re, im])=>DeepNav.goTo(re, im, '3e-60', { instant: true }), [COORDS[61].re, COORDS[61].im]);
    await frames(page, 30);
    await page.evaluate( ()=>{
        const n = TextNode.create('deepnode', 'x', 0.5, 0.4);
        n.anchorForce = 1;
        n.anchor = n.pos;
        n.draw();
    });
    await frames(page, 20);
    const z = await page.evaluate(async ()=>{
        const n = Object.values(Graph.nodes).find( (n)=>n.getTitle() === 'deepnode' );
        await Animation.zoomToNodeTitle(n, 1, 2500);
        const r = n.content.getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, vw: window.innerWidth, vh: window.innerHeight };
    });
    check(Math.abs(z.cx - z.vw / 2) < 4 && Math.abs(z.cy - z.vh / 2) < 4 && z.w > z.vw * 0.4,
          'zoom-to-node centres and enlarges a node at depth', z);

    const hairsAfter = async (setup, arg)=>{
        await page.evaluate(setup, arg);
        await page.evaluate( ()=>{
            Array.from(svg_bg.children).forEach( (c)=>c.remove() );
            regenAmount += 500;
        });
        await page.waitForTimeout(3500);
        return page.evaluate( ()=>({ hairs: svg_bg.children.length, ...DeepFractal.status() }) );
    };

    const cubic = await hairsAfter(async ()=>{
        Elem.byId('exponent').value = 3;
        Fractal.updateStep();
        await DeepNav.goTo('0.2360902255639097740187131486371', '0.4360902255639097740187131486371', '1e-30', { instant: true });
    });
    check(cubic.active && cubic.hairs > 20, 'exponent 3 draws at 1e-30', cubic);

    // Types without a deep evaluation must degrade quietly, not throw.
    const ship = await hairsAfter(async ()=>{
        Elem.byId('exponent').value = 2;
        Elem.byId('fractal-select').value = 'burningShip';
        Fractal.updateStep();
        await DeepNav.goTo('-1.7964026403617497', '-0.0000006890731439710235', '1e-20', { instant: true });
    });
    check(!ship.active, 'burning ship does not use the deep evaluation', ship);

    const fallback = await hairsAfter(async ([re, im])=>{
        Elem.byId('fractal-select').value = 'mandelbrot';
        Fractal.updateStep();
        if (DeepFractal.worker) DeepFractal.worker.terminate();
        DeepFractal._fallBackToLocal();
        DeepFractal.ref = null;
        await DeepNav.goTo(re, im, '3e-60', { instant: true });
    }, [COORDS[61].re, COORDS[61].im]);
    check(fallback.worker === 'main-thread' && fallback.hairs > 20, 'reference orbit falls back to the main thread', fallback);

    await finish(browser, errs);
});
