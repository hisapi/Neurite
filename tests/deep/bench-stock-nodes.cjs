/* Benchmark, not a test: frame rate against the number of stock text nodes
 * all on screen. Prints numbers for comparison between builds; asserts only
 * that nothing throws. */
const { open, fps, finish, run } = require('./harness.cjs');

run(async ()=>{
    const { browser, page, errs } = await open();
    console.log('nodes 0', JSON.stringify(await fps(page)));
    for (const target of [50, 200, 500]) {
        const ms = await page.evaluate( (target)=>{
            const t0 = performance.now();
            for (let i = Object.keys(Graph.nodes).length; i < target; i++) {
                TextNode.create('n' + i, 'text of node ' + i, (Math.random() - 0.5) * 1.8, (Math.random() - 0.5) * 1.8).draw();
            }
            return Math.round(performance.now() - t0);
        }, target);
        const dom = await page.evaluate( ()=>document.getElementsByTagName('*').length );
        console.log(`nodes ${target}`, JSON.stringify(await fps(page)), `created in ${ms} ms, ${dom} DOM elements`);
    }
    await finish(browser, errs);
});
