/* NeuriteCrawl: plant a list of notes in one unbroken descent, then return to
 * the first and confirm the chain is intact.
 *
 *   node crawl.cjs [notes=60]
 *
 * 60 notes end near 1e-48, well past the old double-precision floor; 400 end
 * near 1e-325, past the smallest double (about 3.5 minutes). */
const { open, shot, check, finish, run } = require('./harness.cjs');
const N = parseInt(process.argv[2] || '60', 10);

run(async ()=>{
    const { browser, page, errs } = await open();
    await page.evaluate(async ()=>{
        await DeepStore.open('test-crawl');
        await DeepStore.clear();
    });

    const t0 = Date.now();
    const res = await page.evaluate(async (N)=>{
        const items = Array.from({ length: N }, (_, i)=>`Thought ${i + 1}\nbody of thought ${i + 1}`);
        const log = [];
        const run = NeuriteCrawl.crawl(items, {
            store: 'test-crawl', dwellMs: 0, speed: 0.3, verbose: false,
            onStep: ({ index })=>{
                if ((index + 1) % 20 === 0) log.push({ note: index + 1, zoom: NeuriteDeep.getView().zoom, iterations: Fractal.maxIter(), fps: Elem.byId('fps').textContent });
            }
        });
        const notes = await run.promise;
        return { count: notes.length, chapters: new Set(notes.map( (n)=>n.chapter )).size, last: notes.at(-1), log, zoomLog2: DeepFrame.zoomLog2() };
    }, N);
    console.log(`${N} notes in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    for (const line of res.log) console.log('  ', JSON.stringify(line));

    check(res.count === N, 'every note is planted', res.count);
    check(res.chapters === 1, 'the descent is unbroken (no surfacing)', res.chapters);
    // Each note descends by descent * plungeFactor = 0.153, about 2.7 octaves.
    check(res.zoomLog2 < -2.5 * (N - 1), 'the view ends at the expected depth', { zoomLog2: res.zoomLog2, zoom: res.last.zoom });
    await page.waitForTimeout(2500);
    await shot(page, 'crawl-end');

    const back = await page.evaluate(async ()=>{
        const first = await DeepStore.find('Thought 1\n', 1);
        const ok = await DeepStore.goTo(first[0].id, { speed: 0.3 });
        await new Promise( (r)=>setTimeout(r, 1500) );
        const node = DeepStore.active.get(first[0].id);
        let links = 0;
        for (let id = first[0].id; ;) {
            const rec = await DeepStore.get(id);
            const next = rec.ed.find( (e)=>e > id );
            if (next === undefined) break;
            links += 1;
            id = next;
        }
        return { ok, title: node && node.getTitle(), links };
    });
    check(back.ok === true && back.title === 'Thought 1', 'the first note is reachable again from the bottom', back);
    check(back.links === N - 1, 'the chain of links is complete', back.links);

    await page.evaluate( ()=>DeepStore.clear() );
    await finish(browser, errs);
});
