# Deep zoom and the deep store

These modules remove two limits from Neurite: the zoom floor at double
precision (~1e-14), and the node count at which the frame rate collapses.

## How it works

| File | Role |
| --- | --- |
| `deepnum.js` | BigInt fixed-point helpers, decimal parsing/formatting, mantissa–exponent scales |
| `deepframe.js` | Floating origin. World coordinates are relative to a frame `absolute = origin + local · 2^-k` that re-centres on the view, so existing float geometry works at any depth. Out-of-range nodes are parked with exact positions. |
| `reforbit.js`, `refworker.js` | High-precision reference orbit, computed in a worker (main-thread fallback) |
| `deepperturb.js` | Perturbation iteration with rebasing and scaled deltas; analytic gradient |
| `deepfractal.js` | Reference management, automatic iteration budget, deep versions of the hair renderer |
| `deepnav.js` | Camera flights to absolute targets in log-zoom |
| `deepperf.js` | Per-frame view cache, visibility culling, fractal-force time budget |
| `deepstore.js` | IndexedDB note store indexed by scale level and grid cell; hydrates only on-screen notes into pooled nodes; dots for the rest |
| `deepapi.js` | `window.NeuriteDeep` scripting surface |
| `fractalcrawl.js` | `NeuriteCrawl`: plant a list of notes down the boundary |

At shallow zoom the frame is the identity and behaviour is as before. The frame
leaves the identity below a zoom of 2^-24 and returns above 2^-16.

## Scripting

```js
NeuriteDeep.getView()                       // { re, im, zoom } as decimal strings
await NeuriteDeep.goTo(re, im, '1e-250')    // fly; { instant: true } to jump
await NeuriteDeep.zoomBy(0.5)
NeuriteDeep.status()

const store = NeuriteDeep.store;            // opened as 'default' at startup
const a = store.addNote({ title: 'A', text: '…' });        // at the view centre
const b = store.addNote({ title: 'B', text: '…', x, y, scale });
store.link(a, b);
await store.goTo(b);
await store.find('text');
await store.open('another-space');          // separate database
await store.clear();

const run = NeuriteCrawl.crawl(['one', 'two', 'three']);
run.stop();  await run.promise;
```

The stock `neuriteSetMandelbrotCoords(zoom, re, im, speed)` accepts decimal
strings of any length, and saved views store them.

## Limits

- Deep rendering covers `z^d + c` (the Mandelbrot option, integer exponent ≥ 2).
  Other fractal types still navigate at any depth but draw no background past
  float precision.
- A position costs as many bits as its depth, and the reference orbit costs
  more per iteration the deeper it is. Navigation stays cheap; background
  refresh slows gradually with depth.
- Store notes are their own lightweight note type. They are not part of the
  Zettelkasten document, AI context, or a saved graph; the store persists by
  itself in IndexedDB.

## Tests

`tests/deep/` holds the math and browser tests for these modules; see its
README. `npm run test:deep` runs them against a running dev server.
