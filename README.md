# Clann tree viewer

A standalone, browser-only viewer for phylogenetic trees, including the
**NHX** reconciliation files [Clann](https://github.com/ChrisCreevey/clann)
produces, with their duplications, losses, and species mappings.

Everything runs in the browser. You open a file, the page parses it, and you
reroot / collapse / zoom / export entirely client-side. **Nothing is uploaded to
a server**, so it can be hosted as a static site (e.g. GitHub Pages) or dropped
onto any web host.

## Features

- **Formats:** Newick (`.nwk`, `.newick`, `.tree`) and NHX (`.nhx`) — including
  multi-tree files.
- **Reconciliation rendering:** duplication (■), speciation (●), and loss (dashed
  ✕ stubs), read straight from NHX `[&&NHX:S=…:D=Y/N]` tags and `*LOST` leaves.
- **Interactive:** reroot on any branch, collapse/expand clades, ladderize,
  highlight taxa, cladogram/phylogram layouts, zoom & pan.
- **Export:** SVG, PDF, and Newick of the current rooting — all generated in-page
  with no external libraries.
- **Multi-tree navigation:** filter and step through every tree in a file.

## Usage

Open `index.html` and choose a file (button or drag-and-drop). To try it
immediately, load a bundled example via a deep link:

```
index.html?tree=examples/reconciled.nhx
```

The `?tree=<url>` parameter fetches and displays any same-origin tree file, which
is handy for linking a specific result from another page.

### Producing NHX files with Clann

```
clann> execute mytrees.ph
clann> hs                                   # build a supertree in memory
clann> reconstruct speciestree=memory nhxfile=my_reconstructions.nhx
```

## Development

No build step — the app is plain ES modules and runs from any static server:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/index.html
```

Run the parser tests (Node ≥ 18, no dependencies):

```sh
node --test
```

## Layout

```
index.html            App shell (upload UI + viewer markup)
styles/viewer.css     Styles (theme-aware, light/dark)
src/
  app.js              Upload glue: File → parse() → viewer
  viewer.js           Interactive renderer: mountViewer(container, data)
  parse/
    newick.js         Structural Newick / NHX-carrier parser
    nhx.js            NHX interpretation (events, species, dup/loss counts)
    index.js          detectFormat() + parse() → ViewerData
examples/             Sample trees
test/                 Fixture-driven parser tests
```

The renderer in `src/viewer.js` is a faithful port of the viewer Clann embeds in
its `htmlview` output (`tools/clannview.template.html`), so fixes can flow
between the two. It consumes a `ViewerData` document
(`{ type, meta, trees:[{ name, score?, dups?, losses?, tree }] }`); the parsers'
only job is to turn uploaded text into that shape.

## License

See [LICENSE](LICENSE).
