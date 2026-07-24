// viewer.js — the interactive tree/reconciliation renderer.
//
// Ported (near verbatim) from Clann's embedded viewer
// (tools/clannview.template.html) so bug fixes can flow either direction. The
// only structural change is encapsulation: instead of reading a global `DATA`
// and the whole `document`, everything lives in a closure scoped to a mount
// container, and `setData()` lets the same instance swap in a freshly uploaded
// document without a page reload.
//
//   const handle = mountViewer(containerEl, viewerData);
//   handle.setData(otherViewerData);   // re-render with new trees
//   handle.destroy();                  // detach global listeners
//
// `containerEl` must contain the viewer markup (see index.html): #svg, #scene,
// #tip, #legend, the sidebar controls, and the #nav cluster.

export function mountViewer(container, initialData) {
  const $ = (id) => container.querySelector("#" + id);
  const svg = $("svg"), scene = $("scene"), tip = $("tip");

  // ---------- state (rebuilt by setData) ----------
  let DATA, isRecon, TREES, curIdx = 0, root, ID = 0;
  let showLoss = true, layout = "clado", vspace = 20, fsize = 12;
  let opt = { support: true, len: false, intl: false, align: false, scale: true };
  let view = { k: 1, x: 40, y: 20 };
  let rerootOn = false, hlSet = new Set(), staleWarn = false;
  let filtered = [];
  let colorOn = false, collapseOn = false, activeColor = null, pendingCenter = false;
  let renameMap = new Map();   // originalTipName -> displayName
  const PALETTE = ["#C56347", "#D99A2B", "#5F6E33", "#149589", "#3B6EA5", "#7A4FA3", "#B03060", "#8C6D3F"];

  // ---------- name conventions ----------
  // Newick uses '_' to stand for a space in unquoted names. We store names as
  // given, but *display* underscores as spaces, and *export* spaces back to
  // underscores — so a tree round-trips and "Homo_sapiens" reads as "Homo sapiens".
  const disp = (s) => String(s == null ? "" : s).replace(/_/g, " ");
  // token for a leaf name in exported Newick: spaces → underscores, plus the
  // existing guard against characters that are structural in Newick.
  const newickName = (s) => String(s == null ? "" : s).replace(/ /g, "_").replace(/[(),:;]/g, "_");
  // Collapse underscores and whitespace to a single key so a search or a rename
  // matches whichever spelling ("Homo sapiens" / "Homo_sapiens") the user uses.
  const normName = (s) => String(s == null ? "" : s).toLowerCase().replace(/[_\s]+/g, " ").trim();
  const keyName = (s) => String(s == null ? "" : s).replace(/^\s+|\s+$/g, "").replace(/[_\s]+/g, "_");

  // ---------- model ----------
  function build(n, parent) {
    n.id = ID++; n.parent = parent || null; n.collapsed = false;
    n._orig = n.name;   // original tip name, so renames can match & revert against it
    n.children = (n.children || []).map((c) => build(c, n));
    n.isLeaf = n.children.length === 0 && n.event !== "loss";
    n.isLoss = n.event === "loss";
    n.lost = n.children.length ? n.children.every((c) => c.lost) : n.isLoss;
    return n;
  }
  function leaves(n, acc) { acc = acc || []; if (n.collapsed || (!n.children.length)) { if (!n.lost || showLoss) acc.push(n); } else n.children.forEach((c) => leaves(c, acc)); return acc; }
  function each(n, f) { f(n); n.children.forEach((c) => each(c, f)); }
  function depthOf(n) { let d = 0, p = n; while (p.parent) { d++; p = p.parent; } return d; }
  // deepest *visible* node — recursion stops at collapsed clades so their hidden
  // descendants don't inflate the depth (and shrink the horizontal spacing).
  function maxDepth(r) { let m = 0; (function w(n, d) { m = Math.max(m, d); if (!n.collapsed) n.children.forEach((c) => w(c, d + 1)); })(r, 0); return m; }
  // Is this node hidden because an ancestor is collapsed? (n itself may be the collapsed one.)
  function hiddenByCollapse(n) { for (let p = n.parent; p; p = p.parent) if (p.collapsed) return true; return false; }
  // Shortest/longest root-to-tip distance inside a clade, measured both as
  // cumulative branch length (mnLen/mxLen) and as edge count (mnEdge/mxEdge).
  // Used to draw a collapsed triangle whose near/far edges echo the clade's spread.
  function cladeTipStats(n) {
    let mnLen = Infinity, mxLen = 0, mnEdge = Infinity, mxEdge = 0;
    (function walk(m, acc, e) {
      const kids = (m.children || []).filter((c) => !c.lost || showLoss);
      if (!kids.length) { mnLen = Math.min(mnLen, acc); mxLen = Math.max(mxLen, acc); mnEdge = Math.min(mnEdge, e); mxEdge = Math.max(mxEdge, e); return; }
      kids.forEach((c) => walk(c, acc + (c.length || 0), e + 1));
    })(n, 0, 0);
    if (mnLen === Infinity) { mnLen = mxLen = 0; mnEdge = mxEdge = 0; }
    return { mnLen, mxLen, mnEdge, mxEdge };
  }
  function curEntry() { return TREES[curIdx] || {}; }
  // Does this tree carry meaningful (non-zero) branch lengths? If so we open in
  // phylogram mode so the lengths are actually visible — otherwise a length-
  // bearing tree (e.g. NJ) looks misleadingly like a cladogram.
  function treeHasLengths(node) {
    let found = false;
    (function walk(n, isRoot) {
      if (!isRoot && n.length != null && n.length > 0) found = true;
      (n.children || []).forEach((c) => walk(c, false));
    })(node, true);
    return found;
  }
  // ---------- tip renaming ----------
  // Tips of the current tree, in display order (real leaves, not losses).
  function tipNodes() { const a = []; each(root, (n) => { if (!n.children.length && !n.isLoss) a.push(n); }); return a; }
  // Rebuild renameMap (keyed by keyName of the original tip name) from the two
  // aligned text boxes: original name on line i, new name on line i.
  function readRenameBoxes() {
    const os = $("renameOrig").value.split(/\r?\n/), ns = $("renameNew").value.split(/\r?\n/);
    renameMap = new Map();
    for (let i = 0; i < os.length; i++) {
      const o = (os[i] || "").replace(/^\s+|\s+$/g, ""), nw = (ns[i] || "").replace(/^\s+|\s+$/g, "");
      if (o && nw) renameMap.set(keyName(o), nw);
    }
  }
  // Fill the left box with the current tree's original taxa, and the right box
  // with any new names already known for them (aligned line-for-line).
  function refreshRenameBoxes() {
    if (!$("renameOrig")) return;
    const tips = tipNodes();
    $("renameOrig").value = tips.map((n) => n._orig || "").join("\n");
    $("renameNew").value = tips.map((n) => renameMap.get(keyName(n._orig)) || "").join("\n");
  }
  // Apply the current rename map to the live tree and update the matched counter.
  // Match is on keyName(original), so "Homo sapiens"/"Homo_sapiens" are equivalent.
  function applyRenames() {
    if (!root) return;
    each(root, (n) => { if (!n.children.length) { const k = keyName(n._orig); n.name = renameMap.has(k) ? renameMap.get(k) : n._orig; } });
    const el = $("renameCount"); if (!el) return;
    if (!renameMap.size) { el.textContent = ""; return; }
    const present = new Set(); each(root, (n) => { if (!n.children.length) present.add(keyName(n._orig)); });
    let matched = 0; renameMap.forEach((_, k) => { if (present.has(k)) matched++; });
    el.textContent = matched + " of " + renameMap.size + " names matched";
  }

  function setLayout(v) {
    if (v === "radial" && layout !== "radial") pendingCenter = true;
    layout = v;
    [...$("segLayout").children].forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    $("rowScale").style.display = v === "phylo" ? "flex" : "none";
  }

  // ---------- layout ----------
  function computeLayout() {
    const ls = []; (function order(n) { if (n.collapsed || !n.children.length) { if (!n.lost || showLoss) ls.push(n); } else n.children.forEach(order); })(root);
    ls.forEach((n, i) => n._y = i * vspace);
    (function setY(n) {
      if (n.collapsed || !n.children.length) return n._y;
      const ys = n.children.filter((c) => !c.lost || showLoss).map(setY);
      n._y = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : (n._y || 0);
      return n._y;
    })(root);
    const md = Math.max(1, maxDepth(root));
    let maxLen = 0; (function cl(n, acc) { n._cl = acc; maxLen = Math.max(maxLen, acc); if (!n.collapsed) n.children.forEach((c) => cl(c, acc + (c.length || 0))); })(root, 0);
    // height = longest path (in edges) from a node to a visible descendant tip.
    // Cladograms position by height so every tip lands on the same outer level
    // (dendrogram style) — visibly a cladogram, not a tree with equal lengths.
    (function ht(n) {
      if (n.collapsed || !n.children.length) return (n._h = 0);
      const hs = n.children.filter((c) => !c.lost || showLoss).map(ht);
      return (n._h = hs.length ? 1 + Math.max(...hs) : 0);
    })(root);
    const H = Math.max(1, root._h);
    const wrapW = $("wrap").clientWidth || 900;
    const W = Math.max(360, wrapW - 160);
    const xstep = Math.max(26, W / (H + 1));
    each(root, (n) => {
      if (layout === "phylo" && maxLen > 0) n._x = (n._cl / maxLen) * (W - 10);
      else n._x = (H - n._h) * xstep;   // tips (h=0) align at the far edge; root (h=H) at 0
    });
    root._x = 0;
    return { ls, W, maxLen, xstep };
  }

  // ---------- render ----------
  const el = (t, a) => { const e = document.createElementNS("http://www.w3.org/2000/svg", t); for (const k in a) e.setAttribute(k, a[k]); return e; };
  // Polar geometry state, recomputed each render when in radial mode.
  let radial = false, cx = 0, cy = 0, rMax = 0;
  const ANG0 = -Math.PI / 2;
  const SX = (n) => radial ? cx + n._r * Math.cos(n._ang) : n._x;
  const SY = (n) => radial ? cy + n._r * Math.sin(n._ang) : n._y;
  const polar = (r, a) => `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
  // Branch path from a node's parent to the node, in the current layout.
  function branchPath(n) {
    const p = n.parent;
    if (!radial) return `M${p._x},${p._y} V${n._y} H${n._x}`;
    const a0 = p._ang, a1 = n._ang, r0 = p._r;
    const arc = r0 > 0 ? `M${polar(r0, a0)} A${r0},${r0} 0 0 ${a1 > a0 ? 1 : 0} ${polar(r0, a1)}` : `M${cx},${cy}`;
    return `${arc} L${polar(n._r, a1)}`;
  }
  function render() {
    const { W, maxLen, xstep } = computeLayout();
    // colour inheritance: preorder walk fills _color from the nearest coloured ancestor
    each(root, (n) => { n._color = n.color || (n.parent && n.parent._color) || null; });
    radial = layout === "radial";
    if (radial) {
      // Spread tips evenly over the FULL circle. Leaves sit at _y = 0..(n-1)·vspace;
      // dividing by n·vspace (one extra slot) makes the wrap-around gap equal to the
      // rest, so a polytomy's children fan out evenly instead of crowding at the seam.
      const yMax = Math.max(1, ...leaves(root).map((n) => n._y));
      const denom = yMax + vspace;
      rMax = 0;
      each(root, (n) => { n._ang = ANG0 + (n._y / denom) * 2 * Math.PI; n._r = n._x; rMax = Math.max(rMax, n._x); });
      cx = rMax; cy = rMax;
    }
    scene.innerHTML = "";
    const tipX = Math.max(...leaves(root).map((n) => n._x));
    each(root, (n) => {
      if (!n.parent) return;
      if (hiddenByCollapse(n)) return;   // inside a collapsed clade — the triangle stands in for it
      if (n.lost && !showLoss) return;
      const cls = n.lost ? "lossbranch" : "branch";
      const path = branchPath(n);
      const b = el("path", { d: path, class: cls });
      if (!n.lost && n._color) b.style.stroke = n._color;  // inline style beats the .branch stylesheet rule
      scene.appendChild(b);
      if (!n.lost) {
        const hit = el("path", { d: path, class: "branch hit", "data-id": n.id });
        hit.addEventListener("click", (ev) => { ev.stopPropagation(); if (colorOn) applyColor(n); else if (collapseOn) { if (n.children.length) { n.collapsed = !n.collapsed; render(); } } else if (rerootOn) doReroot(n); else selectBranch(n); });
        hit.addEventListener("mousemove", (e) => showTip(e, n, true));
        hit.addEventListener("mouseleave", hideTip);
        scene.appendChild(hit);
      }
    });
    if (!radial) each(root, (n) => {
      // vertical child-connector (linear only; radial arcs already join siblings)
      if (n.collapsed || hiddenByCollapse(n) || n.children.length < 2) return;
      const vis = n.children.filter((c) => !c.lost || showLoss);
      if (vis.length < 2) return;
      const y0 = Math.min(...vis.map((c) => c._y)), y1 = Math.max(...vis.map((c) => c._y));
      const b = el("path", { d: `M${n._x},${y0} V${y1}`, class: n.lost ? "lossbranch" : "branch" });
      if (!n.lost && n._color) b.style.stroke = n._color;
      scene.appendChild(b);
    });
    each(root, (n) => {
      if (hiddenByCollapse(n)) return;   // descendants of a collapsed clade aren't drawn
      const X = SX(n), Y = SY(n);
      if (n.isLoss) {
        if (showLoss) {
          scene.appendChild(el("circle", { cx: X, cy: Y, r: 3.2, fill: "none", stroke: "var(--loss)", "stroke-width": 1.4 }));
          const t = el("text", { x: X + 7, y: Y + 3.5, class: "intlabel", "font-size": Math.max(9, fsize - 2) });
          t.textContent = "✕ " + (disp(n.species) || "loss"); t.style.fill = "var(--loss)"; scene.appendChild(t);
        }
        return;
      }
      if (n.collapsed) {
        const nleaf = countLeaves(n) || 1, h = Math.min(60, 6 + nleaf * 3);
        // near/far = distance from the node to the closest/furthest tip in the
        // clade, in the same x-units the tree is drawn in. The triangle's two
        // outer corners sit at those depths, so its slanted edge shows how much
        // branch-length variation the collapsed clade hides.
        const st = cladeTipStats(n);
        let near, far;
        if (layout === "phylo" && maxLen > 0) { const ppu = (W - 10) / maxLen; near = st.mnLen * ppu; far = st.mxLen * ppu; }
        else { near = st.mnEdge * xstep; far = st.mxEdge * xstep; }
        near = Math.max(near, 12); far = Math.max(far, near + 4);
        let tri;
        if (radial) {
          const dA = (h / 2) / (n._r + far);
          tri = el("path", { d: `M${polar(n._r, n._ang)} L${polar(n._r + near, n._ang - dA)} L${polar(n._r + far, n._ang + dA)} Z`, class: "collapsed" });
        } else {
          tri = el("path", { d: `M${X},${Y} L${X + near},${Y - h / 2} L${X + far},${Y + h / 2} Z`, class: "collapsed" });
        }
        if (n._color) tri.style.fill = n._color;
        tri.addEventListener("click", (ev) => { ev.stopPropagation(); n.collapsed = false; render(); });
        scene.appendChild(tri);
        placeLabel(n, (n.name ? disp(n.name) : ("▸ " + nleaf + " taxa")), radial ? n._r + far + 6 : X + far + 6, "leaflabel", fsize);
        return;
      }
      if (n.isLeaf) {
        if (radial) {
          const lr = (opt.align ? rMax : n._r) + 7;
          if (opt.align && lr > n._r + 7) scene.appendChild(el("path", { d: `M${polar(n._r, n._ang)} L${polar(lr - 3, n._ang)}`, class: "lossbranch" }));
          const t = placeLabel(n, disp(n.name) || "?", lr, "leaflabel", fsize);
          if (hlSet.size) t.classList.add(matchHL(n) ? "hl" : "dim");
          t.addEventListener("mousemove", (e) => showTip(e, n, false));
          t.addEventListener("mouseleave", hideTip);
        } else {
          const lx = opt.align ? tipX + 8 : X + 7;
          if (opt.align && lx > X + 7) scene.appendChild(el("path", { d: `M${X},${Y} H${lx - 3}`, class: "lossbranch" }));
          const t = el("text", { x: lx, y: Y + fsize * 0.34, class: "leaflabel", "font-size": fsize });
          t.textContent = disp(n.name) || "?";
          if (hlSet.size) { if (matchHL(n)) t.classList.add("hl"); else t.classList.add("dim"); }
          t.addEventListener("mousemove", (e) => showTip(e, n, false));
          t.addEventListener("mouseleave", hideTip);
          scene.appendChild(t);
        }
      }
      if (n.lost) { /* no glyph on lost internal nodes */ }
      else if (isRecon && n.children.length) {
        let g;
        if (n.event === "duplication") g = el("rect", { x: X - 4, y: Y - 4, width: 8, height: 8, fill: "var(--dup)", class: "nodeglyph" });
        else g = el("circle", { cx: X, cy: Y, r: 3, fill: "var(--spec)", class: "nodeglyph" });
        g.setAttribute("data-id", n.id);
        g.addEventListener("click", (ev) => { ev.stopPropagation(); n.collapsed = !n.collapsed; render(); });
        g.addEventListener("mousemove", (e) => showTip(e, n, false));
        g.addEventListener("mouseleave", hideTip);
        scene.appendChild(g);
      } else if (!isRecon && n.children.length && n.parent) {
        // no glyph on the root itself — it's not a real bifurcation, just the
        // drawing origin (and a trifurcating root means the tree is unrooted).
        const g = el("circle", { cx: X, cy: Y, r: 2.6, fill: "var(--branch)", class: "nodeglyph" });
        g.addEventListener("click", (ev) => { ev.stopPropagation(); n.collapsed = !n.collapsed; render(); });
        scene.appendChild(g);
      }
      if (n.children.length && !n.collapsed) {
        if (opt.support && n.support != null) {
          const t = el("text", { x: X - 4, y: Y - 5, class: "support", "text-anchor": "end" }); t.textContent = n.support; scene.appendChild(t);
        }
        if (opt.intl && n.name) {
          const t = el("text", { x: X + 5, y: Y - 5, class: "intlabel" }); t.textContent = disp(n.name); scene.appendChild(t);
        }
      }
    });
    if (opt.len) {
      each(root, (n) => {
        if (!(n.parent && n.length && !n.isLoss) || hiddenByCollapse(n)) return;
        let lx, ly;
        if (radial) { const mr = (n.parent._r + n._r) / 2; lx = cx + mr * Math.cos(n._ang); ly = cy + mr * Math.sin(n._ang) - 3; }
        else { lx = (n.parent._x + n._x) / 2; ly = n._y - 3; }
        const t = el("text", { x: lx, y: ly, class: "support", "text-anchor": "middle" }); t.textContent = (+n.length).toFixed(3); scene.appendChild(t);
      });
    }
    // scale bar (phylogram only — branch x-positions are proportional there)
    if (opt.scale && layout === "phylo" && maxLen > 0) {
      const pxPerUnit = (W - 10) / maxLen;
      const dist = niceNumber((W - 10) * 0.2 / pxPerUnit);
      const barW = dist * pxPerUnit;
      const ys = leaves(root).map((n) => n._y);
      const yb = (ys.length ? Math.max(...ys) : 0) + vspace * 1.25;
      const x0 = 4;
      scene.appendChild(el("path", { d: `M${x0},${yb} H${x0 + barW}`, class: "branch" }));
      scene.appendChild(el("path", { d: `M${x0},${yb - 4} V${yb + 4}`, class: "branch" }));
      scene.appendChild(el("path", { d: `M${x0 + barW},${yb - 4} V${yb + 4}`, class: "branch" }));
      const t = el("text", { x: x0 + barW / 2, y: yb + 15, class: "support", "text-anchor": "middle" });
      t.textContent = String(dist); scene.appendChild(t);
    }
    if (radial && pendingCenter) {
      pendingCenter = false;
      const w = $("wrap").clientWidth || 900, h = $("wrap").clientHeight || 600;
      const b = scene.getBBox(), pad = 30;   // fit the whole radial tree (labels included) into view
      view.k = Math.min(8, Math.max(0.15, Math.min(w / (b.width + pad), h / (b.height + pad))));
      view.x = (w - b.width * view.k) / 2 - b.x * view.k;
      view.y = (h - b.height * view.k) / 2 - b.y * view.k;
    }
    applyView();
    drawLegend();
  }
  // Place a leaf/collapsed label. In radial mode `coord` is the label radius
  // (text is rotated to the node's angle, flipped on the left half); in linear
  // mode `coord` is the label's x.
  function placeLabel(n, str, coord, cls, fs) {
    let t;
    if (radial) {
      const x = cx + coord * Math.cos(n._ang), y = cy + coord * Math.sin(n._ang);
      let deg = n._ang * 180 / Math.PI, anchor = "start";
      if (Math.cos(n._ang) < 0) { deg += 180; anchor = "end"; }
      t = el("text", { x, y, class: cls, "font-size": fs, "text-anchor": anchor, "dominant-baseline": "central", transform: `rotate(${deg} ${x} ${y})` });
    } else {
      t = el("text", { x: coord, y: SY(n) + 4, class: cls, "font-size": fs });
    }
    t.textContent = str; scene.appendChild(t); return t;
  }
  function applyColor(n) { if (activeColor) n.color = activeColor; else delete n.color; render(); }
  // round to the nearest 1/2/5 × 10ⁿ, for a tidy scale-bar distance
  function niceNumber(x) {
    if (!(x > 0)) return x;
    const e = Math.floor(Math.log10(x)), f = x / Math.pow(10, e);
    const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
    return nf * Math.pow(10, e);
  }
  function selectBranch() { container.querySelectorAll(".branch.sel").forEach((e) => e.classList.remove("sel")); }
  function matchHL(n) { const s = normName([n.name, n._orig, n.species].filter(Boolean).join(" ")); return [...hlSet].some((q) => s.includes(q)); }

  // ---------- reroot ----------
  function doReroot(node) {
    if (!node.parent) return;
    const nr = { name: "", children: [], event: isRecon ? "speciation" : null };
    let cur = node, par = node.parent;
    removeChild(par, cur);
    nr.children.push(cur); cur.parent = nr;
    let prev = nr, child = par;
    while (child) {
      const up = child.parent;
      if (up) removeChild(up, child);
      child.parent = prev; prev.children.push(child);
      prev = child; child = up;
    }
    ID = 0; root = build(nr, null);
    if (isRecon) { each(root, (n) => { if (n.children.length && !n.isLoss) n.event = n.event || "speciation"; }); staleWarn = true; updateMeta(); }
    render();
  }
  function removeChild(p, c) { p.children = p.children.filter((x) => x !== c); }

  // ---------- newick ----------
  function toNewick(n) {
    if (!n.children.length) return newickName(n.name) + (n.length != null ? ":" + n.length : "");
    return "(" + n.children.filter((c) => !c.isLoss).map(toNewick).join(",") + ")" + (n.support != null ? n.support : "") + (n.length != null ? ":" + n.length : "");
  }
  // Serialise back to Clann-style NHX, preserving events / species / losses that
  // plain Newick would drop:  gene leaf  Name:len[&&NHX:S=Sp:D=N]
  //                           loss leaf  Sp*LOST:len[&&NHX:S=Sp]
  //                           dup/spec   (…)sup:len[&&NHX:D=Y|N(:S=Sp)]
  function toNhx(n) {
    const len = n.length != null ? ":" + n.length : "";
    if (!n.children.length) {
      if (n.isLoss || n.event === "loss") {
        const tag = n.species != null ? "[&&NHX:S=" + n.species + "]" : "";
        return newickName(n.name) + "*LOST" + len + tag;
      }
      return n.species != null ? newickName(n.name) + len + "[&&NHX:S=" + n.species + ":D=N]" : newickName(n.name) + len;
    }
    const inner = n.children.map(toNhx).join(",");           // keep loss clades, unlike toNewick
    const parts = [];
    if (n.species != null) parts.push("S=" + n.species);
    if (n.event === "duplication") parts.push("D=Y");
    else if (n.event === "speciation") parts.push("D=N");
    const tag = parts.length ? "[&&NHX:" + parts.join(":") + "]" : "";
    return "(" + inner + ")" + (n.support != null ? n.support : "") + len + tag;
  }

  // ---------- view / zoom / pan ----------
  function applyView() { scene.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`); }
  const onWheel = (e) => {
    e.preventDefault(); const r = svg.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * 0.0015); const nk = Math.min(8, Math.max(0.15, view.k * f));
    view.x = mx - (mx - view.x) * (nk / view.k); view.y = my - (my - view.y) * (nk / view.k); view.k = nk; applyView();
  };
  let drag = null;
  const onDown = (e) => { if (e.target.classList.contains("branch") && e.target.classList.contains("hit")) return; drag = { x: e.clientX - view.x, y: e.clientY - view.y }; svg.classList.add("grab"); };
  const onMove = (e) => { if (drag) { view.x = e.clientX - drag.x; view.y = e.clientY - drag.y; applyView(); } };
  const onUp = () => { drag = null; svg.classList.remove("grab"); };

  // ---------- tooltip ----------
  function showTip(e, n, isBranch) {
    const r = $("wrap").getBoundingClientRect();
    let h = "";
    if (n.isLeaf || !n.children.length) { h = `<b>${disp(n.name) || "?"}</b>`; if (n.species) h += `<br>species: <b>${disp(n.species)}</b>`; }
    else {
      h = `<span class="ev" style="color:${n.event === "duplication" ? "var(--dup)" : "var(--spec)"}">${(n.event || "node").toUpperCase()}</span>`;
      h += `<br>${countLeaves(n)} descendant tips`; if (n.support != null) h += `<br>support: ${n.support}`;
    }
    if (isBranch && n.length != null) h += `<br>length: ${(+n.length).toFixed(4)}`;
    if (isBranch) h += `<br><span style="color:var(--muted)">${rerootOn ? "click: reroot here" : "click a node dot to collapse"}</span>`;
    tip.innerHTML = h; tip.style.display = "block";
    tip.style.left = Math.min(r.width - tip.offsetWidth - 6, e.clientX - r.left + 12) + "px";
    tip.style.top = (e.clientY - r.top + 12) + "px";
  }
  function hideTip() { tip.style.display = "none"; }
  function countLeaves(n) { let c = 0; each(n, (x) => { if (!x.children.length && !x.isLoss) c++; }); return c; }

  // ---------- legend ----------
  function drawLegend() {
    const L = $("legend");
    if (!isRecon) { L.style.display = "none"; return; }
    L.style.display = "block";
    L.innerHTML = `<div><span class="sw" style="background:var(--dup)"></span>Duplication</div>` +
      `<div><span class="sw" style="background:var(--spec);border-radius:50%"></span>Speciation</div>` +
      (showLoss ? `<div><span class="sw" style="border:1.4px dashed var(--loss)"></span>Loss</div>` : "");
  }

  // ---------- controls / meta / nav ----------
  function updateMeta() {
    const m = DATA.meta || {}, e = curEntry();
    $("hTitle").textContent = e.name || m.title || (isRecon ? "Reconciliation" : "Tree");
    const s = [];
    if (m.dataset) s.push(m.dataset);
    if (m.criterion) s.push("criterion: <b>" + m.criterion + "</b>");
    if (m.lossmodel) s.push("lossmodel: <b>" + m.lossmodel + "</b>");
    if (e.score != null) s.push("score: <b>" + e.score + "</b>");
    if (e.dups != null) s.push("<b>" + e.dups + "</b> dup");
    if (e.losses != null) s.push("<b>" + e.losses + "</b> loss");
    if (staleWarn) s.push('<span style="color:var(--dup)">⚠ re-rooted: mapping stale</span>');
    $("hMeta").innerHTML = s.join(" · ");
  }
  function treeLabel(i) { const t = TREES[i]; return (t.name || ("tree " + (i + 1))) + (t.score != null ? "  (" + t.score + ")" : ""); }
  function navCounter() {
    const c = $("cntT"), pos = filtered.indexOf(curIdx);
    if (filtered.length === TREES.length) c.textContent = (curIdx + 1) + " / " + TREES.length;
    else c.textContent = (pos >= 0 ? (pos + 1) : "–") + " / " + filtered.length + " matched (of " + TREES.length + ")";
  }
  function rebuildDropdown() {
    const sel = $("selT"); sel.innerHTML = "";
    filtered.forEach((i) => { const o = document.createElement("option"); o.value = i; o.textContent = treeLabel(i); sel.appendChild(o); });
    if (filtered.indexOf(curIdx) >= 0) sel.value = curIdx;
  }
  function loadTree(i) {
    curIdx = i;
    ID = 0; root = build(structuredClone(curEntry().tree), null);
    staleWarn = false; hlSet = new Set(); $("find").value = "";
    view = { k: 1, x: 40, y: 20 };
    if (layout === "radial") pendingCenter = true;
    if ($("supCollapse")) { $("supCollapse").value = 0; $("supVal").textContent = "0"; }
    const sel = $("selT"); if ([...sel.options].some((o) => +o.value === i)) sel.value = i;
    refreshRenameBoxes(); applyRenames();   // show this tree's taxa + re-apply the map
    navCounter(); updateMeta(); render();
  }
  function stepTree(d) {
    if (!filtered.length) return;
    let pos = filtered.indexOf(curIdx); if (pos < 0) pos = d > 0 ? -1 : 0;
    loadTree(filtered[(pos + d + filtered.length) % filtered.length]);
  }
  function applyTreeFilter(q) {
    const box = $("treeSearch");
    q = normName(q);
    filtered = !q ? TREES.map((_, i) => i)
      : TREES.map((_, i) => i).filter((i) => TREES[i]._search.includes(q) || String(i + 1) === q);
    box.classList.toggle("hit", !!q && filtered.length > 0);
    box.classList.toggle("miss", !!q && filtered.length === 0);
    rebuildDropdown(); navCounter();
    if (filtered.length && filtered.indexOf(curIdx) < 0) loadTree(filtered[0]);
  }
  function setupNav() {
    const nav = $("nav");
    TREES.forEach((e, i) => {
      const taxa = new Set();
      (function walk(n) {
        if (!n) return;
        if (!n.children || !n.children.length) { if (n.name) taxa.add(normName(n.name)); if (n.species) taxa.add(normName(n.species)); }
        else (n.children || []).forEach(walk);
      })(e.tree);
      e._search = normName(e.name || ("tree_" + i)) + " " + [...taxa].join(" ");
    });
    if (TREES.length < 2) { nav.style.display = "none"; return; }
    nav.style.display = "inline-flex";
    rebuildDropdown();
    $("selT").onchange = (e) => loadTree(+e.target.value);
    $("prevT").onclick = () => stepTree(-1);
    $("nextT").onclick = () => stepTree(1);
    $("treeSearch").oninput = (e) => applyTreeFilter(e.target.value);
    navCounter();
  }

  // ---------- export ----------
  function exportTitle() { return (DATA.meta && (DATA.meta.title || DATA.meta.dataset)) || "tree"; }
  function serializeSvgInlined() {
    const rect = svg.getBoundingClientRect();
    const clone = svg.cloneNode(true);
    const props = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap",
      "stroke-linejoin", "opacity", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline"];
    const srcEls = svg.querySelectorAll("*"), clEls = clone.querySelectorAll("*");
    for (let i = 0; i < srcEls.length; i++) {
      const cs = getComputedStyle(srcEls[i]); let st = "";
      for (const p of props) { const v = cs.getPropertyValue(p); if (v && v !== "none" || p === "fill" || p === "stroke") st += p + ":" + v + ";"; }
      clEls[i].setAttribute("style", st); clEls[i].removeAttribute("class");
    }
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", rect.width); clone.setAttribute("height", rect.height);
    clone.setAttribute("viewBox", "0 0 " + rect.width + " " + rect.height);
    return { svg: new XMLSerializer().serializeToString(clone), w: rect.width, h: rect.height };
  }
  function jpegToPdf(jpg, imgW, imgH, pageW, pageH) {
    const enc = (s) => new TextEncoder().encode(s);
    const chunks = []; let len = 0; const off = [];
    const push = (u8) => { chunks.push(u8); len += u8.length; };
    const put = (s) => push(enc(s));
    const pw = Math.round(pageW), ph = Math.round(pageH);
    const content = "q " + pw + " 0 0 " + ph + " 0 0 cm /Im0 Do Q";
    put("%PDF-1.3\n");
    const obj = (n, body) => { off[n] = len; put(n + " 0 obj\n" + body + "\nendobj\n"); };
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + pw + " " + ph + "] "
      + "/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>");
    off[4] = len;
    put("4 0 obj\n<< /Type /XObject /Subtype /Image /Width " + imgW + " /Height " + imgH
      + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + jpg.length + " >>\nstream\n");
    push(jpg); put("\nendstream\nendobj\n");
    obj(5, "<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream");
    const xrefAt = len;
    let xref = "xref\n0 6\n0000000000 65535 f \n";
    for (let i = 1; i <= 5; i++) xref += String(off[i]).padStart(10, "0") + " 00000 n \n";
    put(xref + "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xrefAt + "\n%%EOF");
    const out = new Uint8Array(len); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  function exportSvg() {
    const s = serializeSvgInlined().svg;
    const b = new Blob([s], { type: "image/svg+xml" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = exportTitle() + ".svg"; a.click();
  }
  function exportPng() {
    const { svg: s, w, h } = serializeSvgInlined();
    const scale = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    const img = new Image();
    const url = URL.createObjectURL(new Blob([s], { type: "image/svg+xml;charset=utf-8" }));
    img.onload = () => {
      const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
      const ctx = cv.getContext("2d"); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch); URL.revokeObjectURL(url);
      cv.toBlob((bl) => { const a = document.createElement("a"); a.href = URL.createObjectURL(bl); a.download = exportTitle() + ".png"; a.click(); }, "image/png");
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }
  // Centre the viewport on the first search match (search only highlights otherwise).
  function centerOnMatch() {
    if (!hlSet.size) return;
    const m = leaves(root).find((n) => matchHL(n));
    if (!m) return;
    const w = $("wrap").clientWidth || 900, h = $("wrap").clientHeight || 600;
    view.x = w / 2 - SX(m) * view.k; view.y = h / 2 - SY(m) * view.k; applyView();
  }
  function exportPdf() {
    const btn = $("expPdf"), label = btn.textContent;
    btn.textContent = "Rendering…"; btn.disabled = true;
    const done = (ok) => { btn.disabled = false; btn.textContent = ok ? label : "PDF failed — try SVG"; if (!ok) setTimeout(() => btn.textContent = label, 1800); };
    try {
      const { svg: s, w, h } = serializeSvgInlined();
      const scale = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
      const img = new Image();
      const url = URL.createObjectURL(new Blob([s], { type: "image/svg+xml;charset=utf-8" }));
      img.onload = () => {
        try {
          const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
          const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
          const ctx = cv.getContext("2d"); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch); URL.revokeObjectURL(url);
          const b64 = cv.toDataURL("image/jpeg", 0.92).split(",")[1], bin = atob(b64);
          const jpg = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) jpg[i] = bin.charCodeAt(i);
          const pdf = jpegToPdf(jpg, cw, ch, w, h);
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
          a.download = exportTitle() + ".pdf"; a.click();
          done(true);
        } catch (err) { URL.revokeObjectURL(url); done(false); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); done(false); };
      img.src = url;
    } catch (err) { done(false); }
  }
  function copyNewick() {
    const nwk = toNewick(root) + ";";
    if (navigator.clipboard) navigator.clipboard.writeText(nwk);
    $("expNwk").textContent = "Copied ✓";
    setTimeout(() => $("expNwk").textContent = "Copy Newick (current rooting)", 1200);
  }
  function copyNhx() {
    const nhx = toNhx(root) + ";";
    if (navigator.clipboard) navigator.clipboard.writeText(nhx);
    $("expNhx").textContent = "Copied ✓";
    setTimeout(() => $("expNhx").textContent = "Copy NHX (current rooting)", 1200);
  }

  // ---------- static control wiring (once) ----------
  $("segLayout").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.v === layout) return;
    setLayout(b.dataset.v);
    view = { k: 1, x: 40, y: 20 };   // refit: previous pan/zoom won't suit a new layout
    render();
  });
  $("vspace").oninput = (e) => { vspace = +e.target.value; render(); };
  $("fsize").oninput = (e) => { fsize = +e.target.value; render(); };
  // branch line thickness — drives the --bw CSS var the .branch rule reads
  const applyLineW = (v) => svg.style.setProperty("--bw", v);
  $("lineW").oninput = (e) => applyLineW(e.target.value);
  applyLineW($("lineW").value);
  const chk = (id, k) => { $(id).onchange = (e) => { opt[k] = e.target.checked; render(); }; };
  chk("tSupport", "support"); chk("tLen", "len"); chk("tInt", "intl"); chk("tAlign", "align"); chk("tScale", "scale");
  $("tLoss").onchange = (e) => { showLoss = e.target.checked; render(); };
  $("find").oninput = (e) => { hlSet = new Set(e.target.value.split(",").map((s) => normName(s)).filter(Boolean)); render(); centerOnMatch(); };

  // ---------- rename tips ----------
  const runRename = () => { readRenameBoxes(); applyRenames(); render(); };
  $("applyRename").onclick = runRename;
  $("clearRename").onclick = () => { renameMap = new Map(); $("renameNew").value = ""; applyRenames(); render(); };
  // A two-column (tab/comma) file fills the right box, matched by original name.
  function loadPairFile(text) {
    const pairs = new Map();
    for (const raw of String(text || "").split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const sep = raw.includes("\t") ? "\t" : ",";
      const i = raw.indexOf(sep); if (i < 0) continue;
      const from = raw.slice(0, i).replace(/^\s+|\s+$/g, ""), to = raw.slice(i + 1).replace(/^\s+|\s+$/g, "");
      if (from && to) pairs.set(keyName(from), to);
    }
    const origLines = $("renameOrig").value.split(/\r?\n/);
    $("renameNew").value = origLines.map((l) => pairs.get(keyName(l)) || "").join("\n");
    runRename();
  }
  $("loadRename").onclick = () => $("renameFile").click();
  $("renameFile").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (f) loadPairFile(await f.text());
  });
  const rbox = $("renameNew");
  rbox.addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); rbox.classList.add("drop"); } });
  rbox.addEventListener("dragleave", () => rbox.classList.remove("drop"));
  rbox.addEventListener("drop", async (e) => {
    if (!(e.dataTransfer && [...e.dataTransfer.types].includes("Files"))) return;
    e.preventDefault(); e.stopPropagation(); rbox.classList.remove("drop");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadPairFile(await f.text());
  });
  // Only one branch-click mode is active at a time; enabling one clears the others.
  function setMode(mode) {
    rerootOn = mode === "reroot"; colorOn = mode === "color"; collapseOn = mode === "collapse";
    $("rerootMode").checked = rerootOn; $("colorMode").checked = colorOn; $("collapseMode").checked = collapseOn;
    svg.classList.toggle("reroot", rerootOn);
    svg.classList.toggle("coloring", colorOn);
    svg.classList.toggle("collapsing", collapseOn);
  }
  $("rerootMode").onchange = (e) => setMode(e.target.checked ? "reroot" : null);
  $("collapseMode").onchange = (e) => setMode(e.target.checked ? "collapse" : null);

  // ---------- colour palette ----------
  function buildPalette() {
    const p = $("palette"); if (!p || p.childElementCount) return;
    const swatches = [];
    const select = (sw, color) => {
      activeColor = color;
      swatches.forEach((s) => s.classList.toggle("on", s === sw));
      setMode("color");   // picking a swatch enters colour mode (and clears reroot/collapse)
    };
    PALETTE.forEach((color) => {
      const sw = document.createElement("span");
      sw.className = "sw"; sw.style.background = color; sw.title = color;
      sw.onclick = () => select(sw, color);
      p.appendChild(sw); swatches.push(sw);
    });
    const clr = document.createElement("span");
    clr.className = "sw clear"; clr.textContent = "✕"; clr.title = "Clear colour";
    clr.onclick = () => select(clr, null);
    p.appendChild(clr); swatches.push(clr);
    if (swatches[0]) { activeColor = PALETTE[0]; swatches[0].classList.add("on"); }
  }
  buildPalette();
  $("colorMode").onchange = (e) => setMode(e.target.checked ? "color" : null);

  // ---------- collapse by support threshold ----------
  $("supCollapse").oninput = (e) => {
    const thr = +e.target.value; $("supVal").textContent = thr;
    each(root, (n) => {
      if (!n.parent || !n.children.length) return;
      if (n.support != null && +n.support < thr) n.collapsed = true;
      else if (n.support != null) n.collapsed = false;
    });
    render();
  };

  // ---------- midpoint rooting ----------
  function farthestLeaf(from) {
    let best = from, bestD = -1;
    const seen = new Set();
    (function dfs(n, prev, d) {
      seen.add(n);
      if (!n.children.length && !n.isLoss && d > bestD) { bestD = d; best = n; }
      const nbrs = [n.parent, ...n.children].filter(Boolean);
      for (const m of nbrs) if (m !== prev && !seen.has(m)) dfs(m, n, d + (m === n.parent ? (n.length || 0) : (m.length || 0)));
    })(from, null, 0);
    return { leaf: best, dist: bestD };
  }
  function pathBetween(a, b) {
    // ancestor chains → path a..b as an ordered node list
    const up = (x) => { const c = []; for (let p = x; p; p = p.parent) c.push(p); return c; };
    const ca = up(a), cb = up(b), setb = new Map(cb.map((n, i) => [n, i]));
    let lca = null, ia = 0; for (; ia < ca.length; ia++) if (setb.has(ca[ia])) { lca = ca[ia]; break; }
    const ib = setb.get(lca);
    return ca.slice(0, ia + 1).concat(cb.slice(0, ib).reverse());
  }
  function midpointRoot() {
    if (!treeHasLengths(root)) { flash($("midpoint"), "needs branch lengths"); return; }
    const a = farthestLeaf(root).leaf, { leaf: b } = farthestLeaf(a);
    const path = pathBetween(a, b);
    let total = 0; for (let i = 1; i < path.length; i++) total += edgeLen(path[i - 1], path[i]);
    const half = total / 2;
    let acc = 0;
    for (let i = 1; i < path.length; i++) {
      const seg = edgeLen(path[i - 1], path[i]);
      if (acc + seg >= half) { const node = path[i].parent === path[i - 1] ? path[i] : path[i - 1]; if (node.parent) doReroot(node); break; }
      acc += seg;
    }
  }
  function edgeLen(x, y) { return (x.parent === y ? x.length : y.length) || 0; }
  function flash(btn, msg) { const t = btn.textContent; btn.textContent = msg; setTimeout(() => (btn.textContent = t), 1500); }
  $("midpoint").onclick = midpointRoot;
  $("ladder").onclick = () => { (function lad(n) { n.children.sort((a, b) => countLeaves(a) - countLeaves(b)); n.children.forEach(lad); })(root); render(); };
  $("expandAll").onclick = () => { each(root, (n) => n.collapsed = false); render(); };
  $("reset").onclick = () => loadTree(curIdx);
  // NB: the light/dark toggle is a shell-level control wired in app.js, so it
  // works before any tree is loaded (this module only mounts once a file opens).
  $("expSvg").onclick = exportSvg;
  $("expPng").onclick = exportPng;
  $("expPdf").onclick = exportPdf;
  $("expNwk").onclick = copyNewick;
  $("expNhx").onclick = copyNhx;

  svg.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  const onKey = (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "r" || e.key === "R") { const c = $("rerootMode"); c.checked = !c.checked; c.onchange({ target: c }); }
    else if (e.key === "ArrowLeft" && TREES.length > 1) stepTree(-1);
    else if (e.key === "ArrowRight" && TREES.length > 1) stepTree(1);
  };
  window.addEventListener("keydown", onKey);
  const onResize = () => render();
  window.addEventListener("resize", onResize);

  // ---------- (re)load a document ----------
  function setData(data) {
    DATA = data;
    isRecon = DATA.type === "reconciliation";
    TREES = Array.isArray(DATA.trees) ? DATA.trees
      : [{ name: (DATA.meta && DATA.meta.title) || (isRecon ? "reconciliation" : "tree"), tree: DATA.tree, score: DATA.meta && DATA.meta.score, dups: DATA.meta && DATA.meta.dups, losses: DATA.meta && DATA.meta.losses }];
    curIdx = 0; staleWarn = false; hlSet = new Set();
    renameMap = new Map(); if ($("renameNew")) { $("renameNew").value = ""; $("renameCount").textContent = ""; }
    setMode(null);   // clear reroot / colour / collapse click-modes
    filtered = TREES.map((_, i) => i);
    $("rowLoss").style.display = isRecon ? "flex" : "none";
    $("expNhx").style.display = isRecon ? "" : "none";   // NHX export only meaningful for reconciliations
    if (!isRecon) $("legend").style.display = "none";
    // Default to phylogram when the first tree has branch lengths, cladogram otherwise.
    setLayout(TREES.length && treeHasLengths(TREES[0].tree) ? "phylo" : "clado");
    setupNav();
    loadTree(0);
  }

  setData(initialData);

  return {
    setData,
    destroy() {
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    },
  };
}
