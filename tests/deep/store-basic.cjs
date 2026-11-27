/* Deep store basics: notes far too small to draw are dots and cost nothing;
 * zooming in hydrates the visible ones into real nodes with their edges;
 * links drawn or removed are persisted; deleting removes the record. */
const { open, fps, shot, check, finish, run } = require('./harness.cjs');

run(async ()=>{
    const { browser, page, errs } = await open();
    await page.evaluate(async ()=>{
        await DeepStore.open('test-basic');
        await DeepStore.clear();
    });

    const ids = await page.evaluate( ()=>{
        const ids = [];
        for (let j = 0; j < 40; j++) {
            for (let i = 0; i < 50; i++) {
                ids.push(DeepStore.addNote({ title: 'n' + (j * 50 + i), text: `body ${i},${j}`, x: -1.5 + i * 0.06, y: -1.2 + j * 0.06, scale: 0.04 }));
            }
        }
        for (let i = 1; i < 200; i++) DeepStore.link(ids[i - 1], ids[i]);
        return ids;
    });
    await page.waitForTimeout(1500);
    const far = await page.evaluate( ()=>({ ...DeepStore.stats(), live: Object.keys(Graph.nodes).length }) );
    console.log('zoomed out', JSON.stringify(far), JSON.stringify(await fps(page)));
    check(far.total === 2000 && far.hydrated === 0 && far.live === 0, 'small notes are not hydrated', far);
    check(far.dots > 1000, 'small notes are drawn as dots', far);
    await shot(page, 'store-dots');

    await page.evaluate( ()=>DeepNav.goTo('-1.47', '-1.17', '0.15', { instant: true }) );
    await page.waitForTimeout(1500);
    const near = await page.evaluate( ()=>({ ...DeepStore.stats(), live: Object.keys(Graph.nodes).length, edges: Object.keys(Graph.edges).length }) );
    console.log('zoomed in', JSON.stringify(near), JSON.stringify(await fps(page)));
    check(near.hydrated > 10 && near.hydrated <= 64 && near.live === near.hydrated, 'visible notes hydrate, within the cap', near);
    check(near.edges > 10, 'edges between hydrated notes (and ghosts) are drawn', near);
    await shot(page, 'store-windows');

    const content = await page.evaluate( (id)=>{
        const n = DeepStore.active.get(id);
        return n && { title: n.getTitle(), text: n.deepText.value };
    }, ids[0]);
    check(content && content.title === 'n0' && content.text === 'body 0,0', 'hydrated note shows its title and text', content);

    // Linking two hydrated notes through the stock connect persists; so does removal.
    const linked = await page.evaluate(async ([a, b])=>{
        const na = DeepStore.active.get(a), nb = DeepStore.active.get(b);
        if (!na || !nb) return null;
        connectNodes(na, nb);
        await new Promise( (r)=>setTimeout(r, 300) );
        const afterLink = (await DeepStore.get(a)).ed.includes(b) && (await DeepStore.get(b)).ed.includes(a);
        na.edges.find( (e)=>e.pts.includes(nb) ).remove();
        await new Promise( (r)=>setTimeout(r, 300) );
        const afterUnlink = !(await DeepStore.get(a)).ed.includes(b) && !(await DeepStore.get(b)).ed.includes(a);
        return { afterLink, afterUnlink };
    }, [ids[0], ids[51]]);
    check(linked && linked.afterLink && linked.afterUnlink, 'drawing and deleting an edge updates both records', linked);

    const removed = await page.evaluate(async (id)=>{
        DeepStore.active.get(id).remove();
        await new Promise( (r)=>setTimeout(r, 300) );
        await DeepStore.flush();
        return { gone: (await DeepStore.get(id)) === null, total: DeepStore.count(), neighbour: (await DeepStore.get(id + 1)).ed.includes(id) };
    }, ids[1]);
    check(removed.gone && removed.total === 1999 && !removed.neighbour, 'deleting a note removes it and its links', removed);

    await page.evaluate( ()=>DeepStore.clear() );
    await finish(browser, errs);
});
