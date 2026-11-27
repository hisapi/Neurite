/* =============================================================================
 * deepstore.js — a virtualized, disk-backed store for very large node counts
 * -----------------------------------------------------------------------------
 * A regular Neurite node is a live object with ~50 DOM elements, listeners and
 * per-frame work. That is fine for hundreds; it cannot reach 100,000.
 *
 * Notes kept here are plain records in IndexedDB instead:
 *
 *   { id, t: title, x: text, px, py, pp: absolute position (hex BigInt, bits),
 *     sm, se: absolute scale as mantissa * 2^exponent, ed: [linked ids],
 *     an: anchored, cell: index key }
 *
 * Only the few dozen records that are on screen at a readable size are
 * "hydrated" into real nodes, drawn from a small reusable pool; when the view
 * moves on they are written back and released. Cost per frame therefore
 * depends on what is visible, not on how many notes exist.
 *
 * Finding what is visible without scanning everything uses a scale-aware grid.
 * A note of scale s lives at level L = floor(log2 s), in a square cell of side
 * 2^(L + G) — about 128..256 note-widths. A view at zoom z can only show notes
 * within a few levels of log2 z, and at each such level only the handful of
 * cells that overlap the screen, so a query is a few dozen map lookups however
 * deep the view or large the store. Cells load from disk on demand and are
 * evicted when far away, like map tiles.
 *
 * Notes too small to hydrate are drawn as dots on a canvas, so a dense region
 * is visible as a cloud before it resolves into windows.
 *
 * Edges are stored as id lists on both ends. An edge is drawn whenever at
 * least one end is hydrated; the other end is then a position-only "ghost".
 * ========================================================================== */

const DeepStore = {
    G: 7,                   // log2(cell side / note scale)
    LEVELS_BELOW: 7,        // note levels below / above the zoom level that
    LEVELS_ABOVE: 5,        //   can be on screen at a drawable size

    hydrateMin: 0.05,       // CSS scale range in which a record becomes a node
    hydrateMax: 20,
    dotMin: 0.006,          // below hydrateMin and above this: drawn as a dot
    maxActive: 64,          // hydrated nodes at once
    maxDots: 40000,
    hydrateBudgetMs: 5,     // per frame
    queryIntervalMs: 90,
    maxLoadedRecords: 250000,
    flushIntervalMs: 400,

    backend: null,
    name: null,
    ready: null,            // Promise resolved when the store is open
    isOpen: false,

    directory: new Map(),   // cell key -> record count, for every cell on disk
    cells: new Map(),       // cell key -> loaded cell
    records: new Map(),     // id -> record, for every loaded record
    active: new Map(),      // id -> hydrated node
    pool: [],               // released nodes awaiting reuse
    edges: new Map(),       // "a-b" -> Edge between two hydrated nodes
    ghostEdges: new Map(),  // "a>b" -> { edge, ghost } from hydrated a to ghost b
    ghostRecords: new Map(),// id -> record fetched only to place a ghost
    dirty: new Map(),       // id -> record awaiting write
    deleted: new Set(),     // ids awaiting delete
    nextId: 1,
    total: 0,

    queue: [],              // records waiting to be hydrated, best first
    dots: [],               // records drawn as dots this query
    stale: true,
    lastQuery: 0,
    lastFlush: 0,
    lastView: { epoch: -1, x: NaN, y: NaN, zx: NaN, zy: NaN },
    loading: 0,

    // =================================================================== //
    //  Opening                                                             //
    // =================================================================== //

    open(name = 'default'){
        if (this.isOpen && this.name === name) return this.ready;

        const previous = (this.isOpen ? this.flush() : Promise.resolve());
        this.ready = previous.then( ()=>{
            this.releaseAll();
            this.directory.clear();
            this.cells.clear();
            this.records.clear();
            this.ghostRecords.clear();
            this.dirty.clear();
            this.deleted.clear();
            this.name = name;
            return DeepStore.Idb.open(name).catch( (err)=>{
                Logger.warn("Deep store: IndexedDB unavailable, keeping notes in memory only.", err);
                return new DeepStore.Memory();
            });
        }).then( (backend)=>{
            this.backend = backend;
            return backend.summary();
        }).then( (summary)=>{
            for (const key of summary.cells) this.directory.set(key, 0);
            this.nextId = summary.nextId;
            this.total = summary.count;
            this.isOpen = true;
            this.stale = true;
            Logger.info("Deep store '" + name + "' open:", this.total, "notes in", this.directory.size, "cells");
        });
        return this.ready;
    },

    // =================================================================== //
    //  Records                                                             //
    // =================================================================== //

    cellKeyFor(rec){
        const shift = rec.pp + rec.se + this.G;
        const ix = DeepNum.shift(DeepNum.fromHex(rec.px), -shift);
        const iy = DeepNum.shift(DeepNum.fromHex(rec.py), -shift);
        return rec.se + ':' + ix.toString(36) + ':' + iy.toString(36);
    },

    /* Add a note. Position and scale default to the centre of the view at a
     * comfortable size. Returns the new id immediately; the write is batched.
     *
     *   title, text
     *   x, y        local coordinates          (or)
     *   re, im      absolute decimal strings
     *   scale       local scale (node.scale units); default 0.5 * zoom
     *   anchored    default true: the note stays where it was put
     *   links       ids to connect to
     */
    addNote(opts = {}){
        if (!this.isOpen) throw new Error("Deep store is not open yet; await DeepStore.open() first.");

        let abs;
        if (opts.re !== undefined) {
            abs = DeepFrame.parsePoint(String(opts.re), String(opts.im), DeepFrame.zoomSx());
            if (!abs) throw new Error("Deep store: could not parse position " + opts.re + ", " + opts.im);
        } else {
            abs = DeepFrame.toAbs(opts.x ?? Graph.pan.x, opts.y ?? Graph.pan.y);
        }
        const sx = (opts.scaleAbs)
            ? DeepNum.sxParse(String(opts.scaleAbs))
            : DeepFrame.lengthToSx(opts.scale ?? Graph.zoom.mag() * 0.5);

        const rec = {
            id: this.nextId++,
            t: String(opts.title ?? ''),
            x: String(opts.text ?? ''),
            px: DeepNum.toHex(abs.x),
            py: DeepNum.toHex(abs.y),
            pp: abs.p,
            sm: sx.m,
            se: sx.e,
            ed: [],
            an: (opts.anchored === false ? 0 : 1),
            cell: ''
        };
        rec.cell = this.cellKeyFor(rec);
        this.place(rec);
        this.total += 1;
        this.dirty.set(rec.id, rec);
        if (opts.links) for (const other of opts.links) this.link(rec.id, other);
        this.stale = true;
        return rec.id;
    },

    addMany(list){ return list.map(this.addNote, this) },

    /* Put a record into the in-memory structures for its cell. */
    place(rec){
        const key = rec.cell;
        const known = this.directory.has(key);
        this.directory.set(key, (this.directory.get(key) || 0) + 1);

        let cell = this.cells.get(key);
        if (!cell && !known) {
            // A brand-new cell has nothing on disk, so it is complete in memory.
            cell = this.makeCell(key);
            cell.loaded = true;
            this.cells.set(key, cell);
        }
        if (cell) {
            cell.recs.set(rec.id, rec);
            cell.cacheEpoch = -1;
        }
        this.records.set(rec.id, rec);
    },

    displace(rec){
        const key = rec.cell;
        const left = (this.directory.get(key) || 1) - 1;
        const cell = this.cells.get(key);
        if (cell) {
            cell.recs.delete(rec.id);
            cell.cacheEpoch = -1;
        }
        // The count only tracks this session's changes; a cell stays listed
        // until it is known to be empty.
        if (cell?.loaded && cell.recs.size === 0) {
            this.directory.delete(key);
            this.cells.delete(key);
        } else {
            this.directory.set(key, Math.max(left, 0));
        }
    },

    makeCell(key){
        return { key, recs: new Map(), loaded: false, promise: null, cacheEpoch: -1, cache: null, used: 0 };
    },

    /* Record by id: from memory if loaded, otherwise from disk. */
    get(id){
        const rec = this.records.get(id) || this.dirty.get(id) || this.ghostRecords.get(id);
        if (rec) return Promise.resolve(rec);
        return this.backend.get(id).then( (found)=>found || null );
    },

    update(id, changes){
        return this.get(id).then( (rec)=>{
            if (!rec) return null;

            if (changes.title !== undefined) rec.t = String(changes.title);
            if (changes.text !== undefined) rec.x = String(changes.text);
            this.dirty.set(id, rec);
            const node = this.active.get(id);
            if (node) this.fillNode(node, rec);
            return rec;
        });
    },

    remove(id){
        return this.get(id).then( (rec)=>{
            if (!rec) return false;

            const node = this.active.get(id);
            if (node) this.release(node, false);
            for (const other of rec.ed.slice()) this.unlinkRecords(rec, other);
            this.displace(rec);
            this.records.delete(id);
            this.dirty.delete(id);
            this.deleted.add(id);
            this.total -= 1;
            this.stale = true;
            return true;
        });
    },

    link(a, b){
        if (a === b) return Promise.resolve(false);

        return Promise.all([this.get(a), this.get(b)]).then( ([ra, rb])=>{
            if (!ra || !rb) return false;

            if (!ra.ed.includes(b)) ra.ed.push(b);
            if (!rb.ed.includes(a)) rb.ed.push(a);
            this.dirty.set(a, ra);
            this.dirty.set(b, rb);
            this.edgesDirty = true;
            return true;
        });
    },

    unlink(a, b){
        return this.get(a).then( (ra)=>{
            if (ra) this.unlinkRecords(ra, b);
            return !!ra;
        });
    },
    unlinkRecords(ra, b){
        const drop = (rec, id)=>{
            const i = rec.ed.indexOf(id);
            if (i < 0) return;

            rec.ed.splice(i, 1);
            this.dirty.set(rec.id, rec);
        };
        drop(ra, b);
        this.get(b).then( (rb)=>{ if (rb) drop(rb, ra.id) });
        this.edgesDirty = true;
    },

    /* Case-insensitive substring search over titles and text, on disk. */
    find(text, limit = 20){
        return this.flush().then( ()=>this.backend.search(String(text).toLowerCase(), limit) )
            .then( (recs)=>recs.map( (rec)=>({ id: rec.id, title: rec.t, text: rec.x }) ) );
    },

    count(){ return this.total },

    /* Fly to a note so that it fills a comfortable part of the screen. */
    goTo(id, opts = {}){
        return this.get(id).then( (rec)=>{
            if (!rec) return false;

            const target = { x: DeepNum.fromHex(rec.px), y: DeepNum.fromHex(rec.py), p: rec.pp };
            const fill = opts.fill ?? 0.9; // CSS scale the note should end at
            const zoom = DeepNum.sxFromLog2(DeepNum.sxLog2({ m: rec.sm, e: rec.se }) - Math.log2(fill));
            return DeepNav.flyTo(target, zoom, opts);
        });
    },

    clear(){
        this.releaseAll();
        this.directory.clear();
        this.cells.clear();
        this.records.clear();
        this.ghostRecords.clear();
        this.dirty.clear();
        this.deleted.clear();
        this.queue = [];
        this.dots = [];
        this.total = 0;
        this.nextId = 1;
        this.stale = true;
        this.drawDots();
        return this.backend.clear();
    },

    // =================================================================== //
    //  Persistence                                                         //
    // =================================================================== //

    flush(){
        if (!this.backend) return Promise.resolve();
        if (this.dirty.size === 0 && this.deleted.size === 0) return this.flushing || Promise.resolve();

        const puts = Array.from(this.dirty.values());
        const dels = Array.from(this.deleted);
        this.dirty.clear();
        this.deleted.clear();
        const prior = this.flushing || Promise.resolve();
        const mine = this.flushing = prior
            .then( ()=>this.backend.write(puts, dels, this.nextId) )
            .then( ()=>{
                // Records written into cells that are not loaded need not stay in memory.
                for (const rec of puts) {
                    const cell = this.cells.get(rec.cell);
                    if (!cell?.recs.has(rec.id) && !this.active.has(rec.id) && !this.dirty.has(rec.id)) {
                        this.records.delete(rec.id);
                    }
                }
            })
            .catch( (err)=>{
                Logger.err("Deep store: write failed; will retry.", err);
                for (const rec of puts) if (!this.dirty.has(rec.id)) this.dirty.set(rec.id, rec);
                for (const id of dels) this.deleted.add(id);
            })
            .then( ()=>{ if (this.flushing === mine) this.flushing = null });
        return mine;
    },

    loadCell(cell){
        if (cell.promise) return cell.promise;

        this.loading += 1;
        // Pending writes must land first or the load would miss them.
        cell.promise = this.flush()
            .then( ()=>this.backend.cell(cell.key) )
            .then( (recs)=>{
                for (const rec of recs) {
                    if (this.deleted.has(rec.id)) continue;
                    // Anything already in memory is newer than the disk copy.
                    const mine = this.records.get(rec.id) || this.dirty.get(rec.id);
                    if (mine && mine.cell !== cell.key) continue;
                    const use = mine || rec;
                    cell.recs.set(use.id, use);
                    this.records.set(use.id, use);
                    this.ghostRecords.delete(use.id);
                }
                cell.loaded = true;
                cell.cacheEpoch = -1;
                this.stale = true;
            })
            .catch( (err)=>Logger.err("Deep store: could not load cell", cell.key, err) )
            .then( ()=>{ this.loading -= 1 });
        return cell.promise;
    },

    /* Drop the least recently used cells once too much is loaded. */
    evict(){
        if (this.records.size <= this.maxLoadedRecords) return;

        const idle = [];
        for (const cell of this.cells.values()) {
            if (cell.loaded && cell.used < this.lastQuery) idle.push(cell);
        }
        idle.sort( (a, b)=>a.used - b.used );
        for (const cell of idle) {
            if (this.records.size <= this.maxLoadedRecords * 0.8) break;

            let busy = false;
            for (const id of cell.recs.keys()) {
                if (this.active.has(id) || this.dirty.has(id)) { busy = true; break; }
            }
            if (busy) continue;

            for (const id of cell.recs.keys()) this.records.delete(id);
            this.cells.delete(cell.key);
        }
    },

    // =================================================================== //
    //  Per frame                                                           //
    // =================================================================== //

    frame(){
        if (!this.isOpen) return;

        const now = performance.now();
        if (now - this.lastFlush > this.flushIntervalMs) {
            this.lastFlush = now;
            this.syncActive();
            this.flush();
        }
        if (this.total === 0 && this.active.size === 0) {
            if (this.dots.length) { this.dots = []; this.drawDots(); }
            return;
        }

        const moved = this.viewMoved();
        if ((this.stale || moved) && now - this.lastQuery > this.queryIntervalMs) {
            this.lastQuery = now;
            this.stale = false;
            this.rememberView();
            this.query();
        }
        this.hydrateQueued(now + this.hydrateBudgetMs);
        if (this.edgesDirty) this.reconcileEdges();
        if (moved || this.dotsDirty) this.drawDots();
    },

    viewMoved(){
        const v = this.lastView;
        return v.epoch !== DeepFrame.epoch
            || v.x !== Graph.pan.x || v.y !== Graph.pan.y
            || v.zx !== Graph.zoom.x || v.zy !== Graph.zoom.y;
    },
    rememberView(){
        const v = this.lastView;
        v.epoch = DeepFrame.epoch;
        v.x = Graph.pan.x; v.y = Graph.pan.y;
        v.zx = Graph.zoom.x; v.zy = Graph.zoom.y;
    },

    /* Which cells overlap the view, and which of their records to show. */
    query(){
        const perf = DeepPerf;
        const zl = Graph.zoom.mag();
        if (!(zl > 0) || !Number.isFinite(zl) || !(perf.scale > 0)) return;

        const frame = DeepFrame;
        const centre = frame.toAbs(Graph.pan.x, Graph.pan.y);
        const p = centre.p;
        const reach = zl * Math.max(perf.width, perf.height) / perf.scale * (1 + 2 * perf.margin);
        const R = DeepNum.fromFloat(reach, p - frame.k);
        const zoomLevel = Math.floor(Math.log2(zl)) - frame.k;
        const stamp = this.lastQuery;

        const wanted = [];
        for (let level = zoomLevel - this.LEVELS_BELOW; level <= zoomLevel + this.LEVELS_ABOVE; level++) {
            const shift = p + level + this.G;
            const x0 = DeepNum.shift(centre.x - R, -shift);
            const x1 = DeepNum.shift(centre.x + R, -shift);
            const y0 = DeepNum.shift(centre.y - R, -shift);
            const y1 = DeepNum.shift(centre.y + R, -shift);
            if (x1 - x0 > 16n || y1 - y0 > 16n) continue; // cannot happen with these bands

            for (let ix = x0; ix <= x1; ix++) {
                const prefix = level + ':' + ix.toString(36) + ':';
                for (let iy = y0; iy <= y1; iy++) {
                    const key = prefix + iy.toString(36);
                    if (!this.directory.has(key)) continue;

                    let cell = this.cells.get(key);
                    if (!cell) {
                        cell = this.makeCell(key);
                        this.cells.set(key, cell);
                    }
                    cell.used = stamp;
                    if (cell.loaded) wanted.push(cell);
                    else this.loadCell(cell);
                }
            }
        }

        // Project every record of the wanted cells to the screen.
        const izx = perf.izx, izy = perf.izy;
        const panX = Graph.pan.x, panY = Graph.pan.y;
        const mx = perf.width * perf.margin;
        const my = perf.height * perf.margin;
        const candidates = [];
        const dots = [];
        for (const cell of wanted) {
            const cache = this.cellCache(cell);
            const n = cache.ids.length;
            for (let i = 0; i < n; i++) {
                const s = cache.ls[i] * perf.contentZoom;
                if (s < this.dotMin || s > this.hydrateMax * 1.3) continue;

                const dx = cache.lx[i] - panX;
                const dy = cache.ly[i] - panY;
                const u = dx * izx - dy * izy;
                const v = dy * izx + dx * izy;
                const cx = (u / 2 + .5) * perf.scale + perf.offX;
                const cy = (v / 2 + .5) * perf.scale + perf.offY;
                const hw = 150 * s, hh = 100 * s;
                if (!(cx + hw > -mx && cx - hw < perf.width + mx
                   && cy + hh > -my && cy - hh < perf.height + my)) continue;

                const id = cache.ids[i];
                if (s >= this.hydrateMin && s <= this.hydrateMax) {
                    candidates.push({ id, score: Math.hypot(u, v) + Math.abs(Math.log(s / 0.5)) * 0.25 });
                } else if (s < this.hydrateMin) {
                    dots.push(id);
                }
            }
        }

        candidates.sort( (a, b)=>a.score - b.score );
        const keep = new Set();
        const queue = [];
        for (const c of candidates) {
            if (keep.size >= this.maxActive) {
                dots.push(c.id); // over the cap: still visible as a dot
                continue;
            }
            keep.add(c.id);
            if (!this.active.has(c.id)) queue.push(c.id);
        }

        // Release hydrated nodes that have left the picture.
        for (const [id, node] of this.active) {
            if (keep.has(id) || DeepPerf.isHeld(node)) continue;
            if (!node.culled && keep.size < this.maxActive) {
                keep.add(id); // still visibly on screen: hysteresis
                continue;
            }
            this.release(node, true);
        }

        this.queue = queue;
        this.dotsTotal = dots.length;
        // Too many to draw: thin evenly rather than cut off part of the picture.
        if (dots.length > this.maxDots) {
            const stride = Math.ceil(dots.length / this.maxDots);
            const thinned = [];
            for (let i = 0; i < dots.length; i += stride) thinned.push(dots[i]);
            this.dots = thinned;
        } else {
            this.dots = dots;
        }
        this.dotsDirty = true;
        this.evict();
    },

    /* Local coordinates of a cell's records, recomputed once per frame change. */
    cellCache(cell){
        if (cell.cacheEpoch === DeepFrame.epoch && cell.cache) return cell.cache;

        const n = cell.recs.size;
        const cache = {
            ids: new Array(n),
            lx: new Float64Array(n),
            ly: new Float64Array(n),
            ls: new Float64Array(n)
        };
        let i = 0;
        for (const rec of cell.recs.values()) {
            const l = this.localOf(rec);
            cache.ids[i] = rec.id;
            cache.lx[i] = l.x;
            cache.ly[i] = l.y;
            cache.ls[i] = DeepNum.ldexp(rec.sm, rec.se + DeepFrame.k);
            i += 1;
        }
        cell.cache = cache;
        cell.cacheEpoch = DeepFrame.epoch;
        return cache;
    },

    localOf(rec){
        return DeepFrame.toLocal({ x: DeepNum.fromHex(rec.px), y: DeepNum.fromHex(rec.py), p: rec.pp });
    },
    /* As localOf, remembered per frame epoch. Held outside the record so it
     * is never written to disk. */
    localCache: new WeakMap(),
    localCached(rec){
        let entry = this.localCache.get(rec);
        if (!entry || entry.epoch !== DeepFrame.epoch || entry.px !== rec.px || entry.py !== rec.py) {
            entry = { epoch: DeepFrame.epoch, px: rec.px, py: rec.py, pos: this.localOf(rec) };
            this.localCache.set(rec, entry);
        }
        return entry.pos;
    },

    // =================================================================== //
    //  Hydration                                                           //
    // =================================================================== //

    hydrateQueued(deadline){
        const queue = this.queue;
        let made = 0;
        while (queue.length > 0 && this.active.size < this.maxActive + 8) {
            const rec = this.records.get(queue.shift());
            if (rec && !this.active.has(rec.id)) {
                this.hydrate(rec);
                made += 1;
            }
            if (performance.now() > deadline) break;
        }
        if (made > 0) this.edgesDirty = true;
    },

    hydrate(rec){
        const node = this.pool.pop() || this.makeNode();
        const uuid = 'd' + rec.id;
        node.uuid = uuid;
        node.view.id = uuid;
        node.content.dataset.viewId = uuid;
        node.deepRecord = rec;
        node.removed = false;

        const pos = this.localOf(rec);
        node.pos = pos;
        node.anchor = new vec2(pos.x, pos.y);
        node.vel = new vec2(0, 0);
        node.force = new vec2(0, 0);
        node.scale = DeepNum.ldexp(rec.sm, rec.se + DeepFrame.k);
        node.anchorForce = rec.an;
        node.parked = false;
        node.culled = undefined;
        node.drawn = null;
        node.edges = [];
        node.followingMouse = 0;
        this.fillNode(node, rec);
        node.view.div.classList.toggle('window-anchored', rec.an === 1);
        node.view.div.classList.remove('selected');

        Graph.appendNode(node);
        Graph.addNode(node);
        this.active.set(rec.id, node);
        node.draw();
        return node;
    },

    fillNode(node, rec){
        const title = node.view.titleInput;
        if (title.value !== rec.t) title.value = rec.t;
        if (node.deepText.value !== rec.x) node.deepText.value = rec.x;
    },

    /* A window with a title and a plain text area. Deliberately not a
     * TextNode: those are mirrored line-by-line into the Zettelkasten
     * document, which cannot hold a hundred thousand notes. */
    makeNode(){
        const textarea = Html.make.textarea('custom-scrollbar deep-note-text');
        On.mousedown(textarea, Event.stopPropagation);
        On.wheel(textarea, (e)=>{ if (!App.nodeMode) e.stopPropagation() });

        const node = new Node();
        node.uuid = 'd-new';
        NodeView.addAtNaturalScale(node, '', [textarea]);
        // addAtNaturalScale registered it under the placeholder id.
        delete Graph.nodes[node.uuid];
        delete Graph.nodeViews[node.uuid];

        node.isDeepNote = true;
        node.deepText = textarea;
        node.textarea = textarea;
        node.view.div.classList.add('deep-note');
        node.remove = ()=>{ if (node.deepRecord) DeepStore.remove(node.deepRecord.id) };

        On.input(node.view.titleInput, ()=>{
            const rec = node.deepRecord;
            if (!rec) return;
            rec.t = node.view.titleInput.value;
            DeepStore.dirty.set(rec.id, rec);
        });
        On.input(textarea, ()=>{
            const rec = node.deepRecord;
            if (!rec) return;
            rec.x = textarea.value;
            DeepStore.dirty.set(rec.id, rec);
        });
        return node;
    },

    /* Write a hydrated node's placement back to its record if it changed. */
    syncNode(node){
        const rec = node.deepRecord;
        if (!rec || !Graph.nodes[node.uuid]) return;

        let pos, sx;
        if (node.parked) {
            pos = node.deep.pos;
            sx = node.deep.scale;
        } else {
            const was = this.localOf(rec);
            const scaleWas = DeepNum.ldexp(rec.sm, rec.se + DeepFrame.k);
            const tol = node.scale * 1e-7;
            const moved = Math.abs(node.pos.x - was.x) > tol || Math.abs(node.pos.y - was.y) > tol;
            const rescaled = Math.abs(node.scale - scaleWas) > scaleWas * 1e-9;
            const anchored = (node.anchorForce === 1 ? 1 : 0);
            if (!moved && !rescaled && anchored === rec.an) return;

            rec.an = anchored;
            if (!moved && !rescaled) {
                this.dirty.set(rec.id, rec);
                return;
            }
            pos = DeepFrame.toAbs(node.pos.x, node.pos.y);
            sx = DeepFrame.lengthToSx(node.scale);
        }

        this.displace(rec);
        rec.px = DeepNum.toHex(pos.x);
        rec.py = DeepNum.toHex(pos.y);
        rec.pp = pos.p;
        rec.sm = sx.m;
        rec.se = sx.e;
        rec.cell = this.cellKeyFor(rec);
        this.place(rec);
        this.dirty.set(rec.id, rec);
    },

    syncActive(){
        for (const [id, node] of this.active) {
            if (Graph.nodes[node.uuid] !== node) {
                this.active.delete(id); // removed behind our back (e.g. Graph.clear)
                continue;
            }
            this.syncNode(node);
        }
    },

    /* Take a hydrated node off the canvas. With `reuse`, it returns to the pool. */
    release(node, reuse){
        const rec = node.deepRecord;
        if (reuse) this.syncNode(node);

        for (const edge of node.edges.slice()) this.dropEdge(edge);
        node.edges = [];

        const uuid = node.uuid;
        if (Graph.nodes[uuid] === node) {
            App.selectedNodes.uuids.delete(uuid);
            delete Graph.nodeViews[uuid];
            delete Graph.nodes[uuid];
        }
        if (Graph.draggedNode === node) Graph.draggedNode = undefined;
        if (Graph.movingNode === node) Graph.movingNode = undefined;
        if (Node.prev === node) Node.prev = null;
        if (Autopilot.referenceFrame === node) Autopilot.reset();
        node.content.remove();
        node.deepRecord = null;
        if (rec) this.active.delete(rec.id);
        if (reuse && this.pool.length < this.maxActive) this.pool.push(node);
        this.edgesDirty = true;
    },

    releaseAll(){
        for (const node of Array.from(this.active.values())) this.release(node, true);
        this.queue = [];
    },

    // =================================================================== //
    //  Edges                                                               //
    // =================================================================== //

    EDGE_STYLE: { stroke: "none", "stroke-width": "0.005", fill: "lightcyan", opacity: "0.5" },

    makeEdge(a, b){
        const length = a.pos.minus(b.pos).mag() * 0.5;
        const edge = new Edge([a, b], length || 1e-300, 0.1, { ...this.EDGE_STYLE });
        edge.isDeepEdge = true;
        a.edges.push(edge);
        b.edges.push(edge);
        Graph.addEdge(edge);
        return edge;
    },

    dropEdge(edge){
        for (const [key, e] of this.edges) if (e === edge) this.edges.delete(key);
        for (const [key, g] of this.ghostEdges) if (g.edge === edge) this.ghostEdges.delete(key);
        edge.isDeepEdge = false; // so removal is not mistaken for an unlink
        for (const pt of edge.pts) {
            const i = pt.edges.indexOf(edge);
            if (i >= 0) pt.edges.splice(i, 1);
        }
        Graph.deleteEdgeView(edge.view);
        delete Graph.edges[edge.edgeKey];
    },

    /* Make the drawn edges match the records of the hydrated nodes. */
    reconcileEdges(){
        this.edgesDirty = false;
        const wantReal = new Set();
        const wantGhost = new Set();

        for (const [id, node] of this.active) {
            const rec = node.deepRecord;
            if (!rec) continue;

            for (const other of rec.ed) {
                const peer = this.active.get(other);
                if (peer) {
                    const key = (id < other ? id + '-' + other : other + '-' + id);
                    wantReal.add(key);
                    if (!this.edges.has(key)) this.edges.set(key, this.makeEdge(node, peer));
                } else {
                    const key = id + '>' + other;
                    wantGhost.add(key);
                    if (!this.ghostEdges.has(key)) this.addGhostEdge(key, node, other);
                }
            }
        }

        for (const [key, edge] of this.edges) if (!wantReal.has(key)) this.dropEdge(edge);
        for (const [key, g] of this.ghostEdges) {
            if (wantGhost.has(key)) continue;
            if (g.edge) this.dropEdge(g.edge);
            this.ghostEdges.delete(key);
        }
    },

    addGhostEdge(key, node, otherId){
        const entry = { edge: null, ghost: null };
        this.ghostEdges.set(key, entry);

        const build = (rec)=>{
            if (!rec || this.ghostEdges.get(key) !== entry || !node.deepRecord) return;

            const ghost = entry.ghost = this.makeGhost(rec);
            if (!ghost.parked) entry.edge = this.makeEdge(node, ghost);
        };
        const rec = this.records.get(otherId) || this.ghostRecords.get(otherId);
        if (rec) return build(rec);

        this.backend.get(otherId).then( (found)=>{
            if (!found) return;
            if (this.ghostRecords.size > 4096) this.ghostRecords.clear();
            this.ghostRecords.set(otherId, found);
            build(found);
        });
    },

    /* The far end of an edge whose note is not hydrated: position and scale
     * only, never drawn, never simulated. */
    makeGhost(rec){
        const pos = this.localOf(rec);
        const scale = DeepNum.ldexp(rec.sm, rec.se + DeepFrame.k);
        const ok = pos.isFinite() && scale > 0 && Number.isFinite(scale);
        return {
            uuid: 'g' + rec.id,
            isGhost: true,
            deepRecord: rec,
            pos: (ok ? pos : new vec2(0, 0)),
            scale: (ok ? scale : 1),
            anchorForce: 1,
            force: new vec2(0, 0),
            edges: [],
            culled: true,
            parked: !ok,
            isAsleep: true,
            getTitle: ()=>rec.t,
            updateEdgeData(){}
        };
    },

    onRebase(){
        const store = DeepStore;
        store.stale = true;
        for (const node of Array.from(store.active.values())) {
            // Out of range in the new frame: hand it back to the store.
            if (node.parked) store.release(node, true);
        }
        for (const [key, g] of store.ghostEdges) {
            if (!g.ghost) continue;

            const fresh = store.makeGhost(g.ghost.deepRecord);
            if (fresh.parked) {
                if (g.edge) store.dropEdge(g.edge);
                store.ghostEdges.delete(key);
            } else {
                g.ghost.pos = fresh.pos;
                g.ghost.scale = fresh.scale;
            }
        }
        store.edgesDirty = true;
    },

    /* Called when the user draws or deletes an edge between two store notes. */
    onEdgeAdded(edge){
        const [a, b] = edge.pts;
        if (edge.isDeepEdge || !a?.deepRecord || !b?.deepRecord || a.isGhost || b.isGhost) return;

        edge.isDeepEdge = true;
        const ia = a.deepRecord.id, ib = b.deepRecord.id;
        this.edges.set(ia < ib ? ia + '-' + ib : ib + '-' + ia, edge);
        this.link(ia, ib);
    },
    onEdgeDeleted(edge){
        if (!edge.isDeepEdge) return;

        const [a, b] = edge.pts;
        if (a?.deepRecord && b?.deepRecord) this.unlink(a.deepRecord.id, b.deepRecord.id);
    },

    // =================================================================== //
    //  Dots                                                                //
    // =================================================================== //

    canvas: null,
    drawDots(){
        this.dotsDirty = false;
        const dots = this.dots;
        let canvas = this.canvas;
        if (!canvas) {
            if (dots.length === 0) return;

            canvas = this.canvas = Html.new.canvas();
            canvas.id = 'deep-dots';
            svg.insertAdjacentElement('afterend', canvas);
        }

        const perf = DeepPerf;
        const ratio = window.devicePixelRatio || 1;
        const w = Math.round(perf.width * ratio);
        const h = Math.round(perf.height * ratio);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, perf.width, perf.height);
        if (dots.length === 0) return;

        const izx = perf.izx, izy = perf.izy;
        const panX = Graph.pan.x, panY = Graph.pan.y;
        const k = DeepFrame.k;
        ctx.fillStyle = 'rgba(150, 170, 230, 0.55)';
        for (const id of dots) {
            const rec = this.records.get(id);
            if (!rec || this.active.has(id)) continue;

            const l = this.localCached(rec);
            const s = DeepNum.ldexp(rec.sm, rec.se + k) * perf.contentZoom;
            const dx = l.x - panX;
            const dy = l.y - panY;
            const cx = ((dx * izx - dy * izy) / 2 + .5) * perf.scale + perf.offX;
            const cy = ((dy * izx + dx * izy) / 2 + .5) * perf.scale + perf.offY;
            const bw = Math.max(2, 260 * s);
            const bh = Math.max(2, 120 * s);
            ctx.fillRect(cx - bw / 2, cy - bh / 2, bw, bh);
        }
    },

    stats(){
        return {
            name: this.name,
            total: this.total,
            cellsOnDisk: this.directory.size,
            cellsLoaded: this.cells.size,
            recordsLoaded: this.records.size,
            hydrated: this.active.size,
            pooled: this.pool.length,
            dots: this.dots.length,
            queued: this.queue.length,
            pendingWrites: this.dirty.size,
            backend: this.backend?.kind
        };
    }
};

// ======================================================================= //
//  Backends                                                                //
// ======================================================================= //

/* IndexedDB: one object store of records keyed by id, indexed by cell. */
DeepStore.Idb = class {
    kind = 'indexeddb';
    constructor(db){ this.db = db }

    static open(name){
        return new Promise( (resolve, reject)=>{
            if (typeof indexedDB === 'undefined') return reject(new Error("no indexedDB"));

            const req = indexedDB.open('NeuriteDeepStore:' + name, 1);
            req.onupgradeneeded = ()=>{
                const db = req.result;
                const nodes = db.createObjectStore('nodes', { keyPath: 'id' });
                nodes.createIndex('cell', 'cell', { unique: false });
                db.createObjectStore('meta');
            };
            req.onsuccess = ()=>resolve(new DeepStore.Idb(req.result));
            req.onerror = ()=>reject(req.error);
            req.onblocked = ()=>reject(new Error("blocked"));
        });
    }

    #done(tx){
        return new Promise( (resolve, reject)=>{
            tx.oncomplete = ()=>resolve();
            tx.onerror = ()=>reject(tx.error);
            tx.onabort = ()=>reject(tx.error || new Error("aborted"));
        });
    }
    #request(req){
        return new Promise( (resolve, reject)=>{
            req.onsuccess = ()=>resolve(req.result);
            req.onerror = ()=>reject(req.error);
        });
    }

    /* Every distinct cell key, the record count, and the next free id. */
    summary(){
        const tx = this.db.transaction(['nodes', 'meta'], 'readonly');
        const nodes = tx.objectStore('nodes');
        const out = { cells: [], count: 0, nextId: 1 };
        nodes.count().onsuccess = (e)=>{ out.count = e.target.result };
        nodes.openKeyCursor(null, 'prev').onsuccess = (e)=>{
            const cursor = e.target.result;
            if (cursor) out.nextId = Math.max(out.nextId, cursor.key + 1);
        };
        tx.objectStore('meta').get('nextId').onsuccess = (e)=>{
            if (e.target.result) out.nextId = Math.max(out.nextId, e.target.result);
        };
        nodes.index('cell').openKeyCursor(null, 'nextunique').onsuccess = (e)=>{
            const cursor = e.target.result;
            if (!cursor) return;
            out.cells.push(cursor.key);
            cursor.continue();
        };
        return this.#done(tx).then( ()=>out );
    }

    write(puts, dels, nextId){
        const tx = this.db.transaction(['nodes', 'meta'], 'readwrite');
        const nodes = tx.objectStore('nodes');
        for (const rec of puts) nodes.put(rec);
        for (const id of dels) nodes.delete(id);
        tx.objectStore('meta').put(nextId, 'nextId');
        return this.#done(tx);
    }

    get(id){
        return this.#request(this.db.transaction('nodes').objectStore('nodes').get(id));
    }
    cell(key){
        return this.#request(this.db.transaction('nodes').objectStore('nodes').index('cell').getAll(key));
    }

    search(needle, limit){
        return new Promise( (resolve, reject)=>{
            const found = [];
            const req = this.db.transaction('nodes').objectStore('nodes').openCursor();
            req.onerror = ()=>reject(req.error);
            req.onsuccess = ()=>{
                const cursor = req.result;
                if (!cursor) return resolve(found);

                const rec = cursor.value;
                if (rec.t.toLowerCase().includes(needle) || rec.x.toLowerCase().includes(needle)) {
                    found.push(rec);
                    if (found.length >= limit) return resolve(found);
                }
                cursor.continue();
            };
        });
    }

    clear(){
        const tx = this.db.transaction(['nodes', 'meta'], 'readwrite');
        tx.objectStore('nodes').clear();
        tx.objectStore('meta').clear();
        return this.#done(tx);
    }
}

/* Same interface without persistence, for when IndexedDB is unavailable. */
DeepStore.Memory = class {
    kind = 'memory';
    recs = new Map();
    summary(){ return Promise.resolve({ cells: [], count: 0, nextId: 1 }) }
    write(puts, dels){
        for (const rec of puts) this.recs.set(rec.id, rec);
        for (const id of dels) this.recs.delete(id);
        return Promise.resolve();
    }
    get(id){ return Promise.resolve(this.recs.get(id)) }
    cell(key){
        const out = [];
        for (const rec of this.recs.values()) if (rec.cell === key) out.push(rec);
        return Promise.resolve(out);
    }
    search(needle, limit){
        const out = [];
        for (const rec of this.recs.values()) {
            if (rec.t.toLowerCase().includes(needle) || rec.x.toLowerCase().includes(needle)) out.push(rec);
            if (out.length >= limit) break;
        }
        return Promise.resolve(out);
    }
    clear(){
        this.recs.clear();
        return Promise.resolve();
    }
}

DeepFrame.onRebase(DeepStore.onRebase);
On.visibilitychange(document, ()=>{
    if (document.visibilityState === 'hidden' && DeepStore.isOpen) {
        DeepStore.syncActive();
        DeepStore.flush();
    }
});
