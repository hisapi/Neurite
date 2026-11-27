/* 100,000 notes: a 316 x 316 plane at one scale plus a 500-note linked chain
 * descending to ~1e-260. Checks that only what is visible is live, that the
 * store reopens from IndexedDB after a reload, that the bottom of the chain
 * is reachable, and that an edit made there persists. Frame rates are printed. */
const { open, shot, check, finish, run } = require('./harness.cjs');

run(async ()=>{
    const { browser, page, errs } = await open();
    const fpsDuring = (body, count)=>page.evaluate(async ([body, count])=>{
        const step = new Function('i', body);
        const times = [];
        let last = performance.now();
        const t0 = last;
        for (let i = 0; i < count; i++) {
            step(i);
            await new Promise( (r)=>requestAnimationFrame(r) );
            const now = performance.now();
            times.push(now - last);
            last = now;
        }
        times.sort( (a, b)=>a - b );
        return { fps: Math.round(count / (last - t0) * 1000), p95ms: Math.round(times[Math.floor(count * 0.95)]), worstMs: Math.round(times[count - 1]) };
    }, [body, count]);
    const stats = ()=>page.evaluate( ()=>({ ...DeepStore.stats(), live: Object.keys(Graph.nodes).length, dom: document.getElementsByTagName('*').length }) );

    await page.evaluate(async ()=>{
        await DeepStore.open('test-100k');
        await DeepStore.clear();
    });
    const add = await page.evaluate(async ()=>{
        const t0 = performance.now();
        const N = 316, spacing = 0.012;
        for (let j = 0; j < N; j++) {
            for (let i = 0; i < N; i++) {
                DeepStore.addNote({ title: `p${i},${j}`, text: `plane note ${i},${j}`, x: -1.9 + i * spacing, y: -1.9 + j * spacing, scale: 0.008 });
            }
        }
        // Chain: each note 0.3x the scale of the previous, just beside it.
        let at = DeepFrame.toAbs(-0.7436, 0.1318);
        let s = DeepNum.sx(0.05);
        let prev = null, last = null;
        const digits = (e)=>Math.ceil(-e * 0.30103) + 8;
        for (let i = 0; i < 500; i++) {
            const id = DeepStore.addNote({
                title: 'chain ' + i, text: 'depth step ' + i,
                re: DeepNum.toDecimal(at.x, at.p, digits(s.e)),
                im: DeepNum.toDecimal(at.y, at.p, digits(s.e)),
                scaleAbs: DeepNum.sxToString(s, 15)
            });
            if (prev !== null) DeepStore.link(prev, id);
            prev = last = id;
            const p = Math.max(at.p, -s.e + 128);
            at = {
                x: DeepNum.rescale(at.x, at.p, p) + DeepNum.fromFloat(0.8 * s.m, p + s.e),
                y: DeepNum.rescale(at.y, at.p, p) + DeepNum.fromFloat(0.3 * s.m, p + s.e),
                p
            };
            s = DeepNum.sxFromLog2(DeepNum.sxLog2(s) + Math.log2(0.3));
        }
        const addMs = Math.round(performance.now() - t0);
        await DeepStore.flush();
        return { addMs, flushedMs: Math.round(performance.now() - t0), last, lastScale: DeepNum.sxToString(s, 4) };
    });
    console.log('added', JSON.stringify(add));
    await page.waitForTimeout(1500);

    const home = await stats();
    console.log('home view', JSON.stringify(home), 'idle', JSON.stringify(await fpsDuring('', 180)));
    check(home.total === 100356, 'all notes are in the store', home.total);
    check(home.live === 0 && home.dom < 3000, 'nothing is live while every note is tiny', home);
    await shot(page, '100k-home');

    await page.evaluate( ()=>DeepNav.goTo('-1.0', '-1.0', '0.03', { instant: true }) );
    await page.waitForTimeout(1000);
    const plane = await stats();
    console.log('in the plane', JSON.stringify(plane));
    check(plane.hydrated > 20 && plane.hydrated <= 72 && plane.dom < 6000, 'only the visible notes are live', plane);
    console.log('panning', JSON.stringify(await fpsDuring('Graph.pan_incBy(new vec2(Graph.zoom.mag()*0.03, Graph.zoom.mag()*0.012)); regenAmount += 5;', 360)));
    const panned = await stats();
    check(panned.hydrated <= 72 && panned.live === panned.hydrated, 'live count stays bounded while panning', panned);
    console.log('zooming', JSON.stringify(await fpsDuring('performZoom(i < 150 ? 0.97 : 1.03, Graph.pan); regenAmount += 5;', 300)));
    await shot(page, '100k-plane');

    // Reload: the store must come back from IndexedDB.
    let t = Date.now();
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction( ()=>window.appReady === true );
    await page.evaluate( ()=>DeepStore.open('test-100k') );
    const reopened = await stats();
    console.log('reload + open', Date.now() - t, 'ms', JSON.stringify(reopened));
    check(reopened.total === 100356 && reopened.recordsLoaded === 0, 'store reopens without loading its records', reopened);

    // Fly to the bottom of the chain.
    t = Date.now();
    const arrived = await page.evaluate( (id)=>DeepStore.goTo(id, { speed: 0.12 }), add.last);
    await page.waitForTimeout(1500);
    const end = await page.evaluate( (id)=>{
        const n = DeepStore.active.get(id);
        return { title: n && n.getTitle(), text: n && n.deepText.value, edges: n && n.edges.length, zoom: NeuriteDeep.getView().zoom };
    }, add.last);
    console.log('chain end in', Date.now() - t, 'ms', JSON.stringify(end), 'fps', JSON.stringify(await fpsDuring('', 180)));
    check(arrived === true && end.title === 'chain 499' && end.text === 'depth step 499', 'bottom of the chain is reachable and hydrated', end);
    check(end.edges >= 1, 'its link to the previous note is drawn', end);
    check(Number(end.zoom) < 1e-250, 'the view is at the depth of the note', end.zoom);
    await shot(page, '100k-chain-end');

    // Edit there, reload, verify.
    await page.evaluate( (id)=>{
        const n = DeepStore.active.get(id);
        n.deepText.value = 'EDITED at depth';
        n.deepText.dispatchEvent(new Event('input'));
        return DeepStore.flush();
    }, add.last);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction( ()=>window.appReady === true );
    const kept = await page.evaluate(async (id)=>{
        await DeepStore.open('test-100k');
        const rec = await DeepStore.get(id);
        const found = await DeepStore.find('EDITED', 5);
        return { text: rec.x, found: found.length };
    }, add.last);
    check(kept.text === 'EDITED at depth' && kept.found === 1, 'an edit made at depth persists and is searchable', kept);

    await page.evaluate( ()=>DeepStore.clear() );
    await finish(browser, errs);
});
