# Deep zoom tests

Tests for `js/deep/`. Two kinds:

- `math-*.cjs` run in plain Node and need nothing else.
- The rest drive the real app in headless Chromium through Playwright.

## Running

```bash
npm start
```

```bash
npm install --no-save playwright
```

```bash
npx playwright install chromium
```

```bash
npm run test:deep
```

`npm run test:deep -- --quick` skips the 100,000-note test. Any file can be run
by itself, for example `node tests/deep/crawl.cjs 400`.

| Variable | Meaning |
| --- | --- |
| `NEURITE_URL` | Where the app is served. Default `http://localhost:8080/`. |
| `NEURITE_CDN_DIR` | A `node_modules` directory containing `codemirror@5`, `localforage`, `pdfjs-dist`, `prismjs`, `dompurify` and `marked@4`. When set, the CDN scripts in `index.html` are served from it — for machines that cannot reach the CDNs. |
| `NEURITE_SHOTS` | Directory to write screenshots into. |

## What each covers

| File | Checks |
| --- | --- |
| `math-deepnum.cjs` | BigInt fixed-point helpers, decimal parsing and formatting |
| `math-perturb.cjs [bits] [degree]` | Perturbation iteration and analytic gradient against brute-force BigInt iteration |
| `deep-flights.cjs` | Node placement across re-centrings, parking at shallow zoom, flights to 2e-300 and 4e-390 |
| `transitions.cjs` | Entering and leaving the deep frame by zooming, zoom-to-node at depth, exponent 3, unsupported fractal types, worker fallback |
| `stock-notes.cjs` | Stock notes and edges at depth, save/load round trip across depths, exported coordinates |
| `store-basic.cjs` | Dots, hydration, edges, link and delete persistence |
| `store-100k.cjs` | 100,000 notes plus a 500-note chain to ~1e-260: bounded live nodes, reopen after reload, edit persistence |
| `crawl.cjs [notes]` | `NeuriteCrawl` in one unbroken descent, chain integrity |
| `bench-stock-nodes.cjs` | Benchmark only: frame rate vs stock node count |

Frame rates are printed, not asserted: they depend on the machine.
