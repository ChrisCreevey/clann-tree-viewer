# Clann tree viewer

A standalone, browser-only viewer for phylogenetic trees, including the
**NHX** reconciliation files [Clann](https://github.com/ChrisCreevey/clann)
produces, with their duplications, losses, and species mappings.

Everything runs in the browser. You open a file, the page parses it, and you
reroot / collapse / zoom / export entirely client-side. **Nothing is uploaded to
a server**, so it can be hosted as a static site (e.g. GitHub Pages) or dropped
onto any web host.

You can use the deployed version to visualise trees here: [https://chriscreevey.github.io/clann-tree-viewer/](https://chriscreevey.github.io/clann-tree-viewer/).

## What's new

- **NEXUS input** — reads the `TREES` block of a NEXUS file, resolving the
  `translate` table and dropping `[&…]` comments, alongside Newick and NHX.
- **Paste a tree** — paste Newick text straight into the window (⌘/Ctrl-V) to
  load it; more extensions accepted (`.ph`, `.phy`, `.nex`, `.nexus`).
- **Rename tips** — the left box is pre-filled with the current taxa; type or
  paste each new name on the matching line in the right box (or load a
  two-column tab/comma file). Renames apply live, survive tree switches, revert
  with one click, and are written into the exported Newick.
- **Underscore / space convention** — following Newick, `_` in a name is shown as
  a space and exported back to `_`, so `Homo_sapiens` reads as “Homo sapiens”.
  Searching matches either spelling.
- **Radial layout** — a circular view with the root at the centre and tips on the
  outer ring, alongside the existing cladogram and phylogram modes.
- **Clade colouring** — pick from a palette and click a branch to colour that
  clade; colours inherit down the subtree (and nested clades override), and carry
  through to every export.
- **Collapse mode** — a dedicated click-to-collapse mode. A collapsed clade is
  drawn as a triangle whose near/far edges match its shortest/longest tip
  distance, so the shape hints at the diversity it hides.
- **Collapse by support** — a threshold slider that folds away poorly supported
  clades.
- **Midpoint rooting** — one-click rooting at the midpoint of the tree's longest
  tip-to-tip path.
- **Line thickness** and **PNG export**, plus **search that recentres** the view
  on the first match.

The persistent **Clann Tree Viewer** name now sits in the header, with the
current tree's name beside it.

## Features

- **Formats:** Newick (`.nwk`, `.newick`, `.tree`, `.ph`, `.phy`), NHX (`.nhx`),
  and NEXUS (`.nex`, `.nexus`) — including multi-tree files. Open a file, drag
  it in, or paste the tree text.
- **Reconciliation rendering:** duplication (■), speciation (●), and loss (dashed
  ✕ stubs), read straight from NHX `[&&NHX:S=…:D=Y/N]` tags and `*LOST` leaves.
- **Layouts:** cladogram, phylogram, and radial, with adjustable row spacing,
  font size, and branch-line thickness.
- **Interactive:** reroot (interactive or midpoint) on any branch, collapse/expand
  clades (by click or support threshold), ladderize, highlight taxa, zoom & pan.
- **Colouring:** click-to-colour clades from a palette, inherited down each
  subtree.
- **Renaming:** map current tip names to new ones from a pasted or uploaded
  two-column list.
- **Export:** SVG, PNG, PDF, and Newick of the current rooting — all generated
  in-page with no external libraries.
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
    nexus.js          NEXUS TREES block (translate table, comment stripping)
    index.js          detectFormat() + parse() → ViewerData
examples/             Sample trees
test/                 Fixture-driven parser tests
```

The renderer in `src/viewer.js` began as a faithful port of the viewer Clann
embeds in its `htmlview` output (`tools/clannview.template.html`); core parsing
and reconciliation fixes can still flow between the two, though the features
above are currently specific to this standalone viewer. It consumes a
`ViewerData` document
(`{ type, meta, trees:[{ name, score?, dups?, losses?, tree }] }`); the parsers'
only job is to turn uploaded text into that shape.

## License

See [LICENSE](LICENSE).
