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

  // ---------- model ----------
  function build(n, parent) {
    n.id = ID++; n.parent = parent || null; n.collapsed = false;
    n.children = (n.children || []).map((c) => build(c, n));
    n.isLeaf = n.children.length === 0 && n.event !== "loss";
    n.isLoss = n.event === "loss";
    n.lost = n.children.length ? n.children.every((c) => c.lost) : n.isLoss;
    return n;
  }
  function leaves(n, acc) { acc = acc || []; if (n.collapsed || (!n.children.length)) { if (!n.lost || showLoss) acc.push(n); } else n.children.forEach((c) => leaves(c, acc)); return acc; }
  function each(n, f) { f(n); n.children.forEach((c) => each(c, f)); }
  function depthOf(n) { let d = 0, p = n; while (p.parent) { d++; p = p.parent; } return d; }
  function maxDepth(r) { let m = 0; each(r, (n) => { if (!n.collapsed) m = Math.max(m, depthOf(n)); }); return m; }
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
  function setLayout(v) {
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
    const wrapW = $("wrap").clientWidth || 900;
    const W = Math.max(360, wrapW - 160);
    const xstep = Math.max(26, W / (md + 1));
    each(root, (n) => {
      if (layout === "phylo" && maxLen > 0) n._x = (n._cl / maxLen) * (W - 10);
      else n._x = depthOf(n) * xstep;
    });
    root._x = 0;
    return { ls, W, maxLen };
  }

  // ---------- render ----------
  const el = (t, a) => { const e = document.createElementNS("http://www.w3.org/2000/svg", t); for (const k in a) e.setAttribute(k, a[k]); return e; };
  function render() {
    const { W, maxLen } = computeLayout();
    scene.innerHTML = "";
    const tipX = Math.max(...leaves(root).map((n) => n._x));
    each(root, (n) => {
      if (!n.parent) return;
      if (n.lost && !showLoss) return;
      const p = n.parent;
      const cls = n.lost ? "lossbranch" : "branch";
      const path = `M${p._x},${p._y} V${n._y} H${n._x}`;
      scene.appendChild(el("path", { d: path, class: cls }));
      if (!n.lost) {
        const hit = el("path", { d: path, class: "branch hit", "data-id": n.id });
        hit.addEventListener("click", (ev) => { ev.stopPropagation(); if (rerootOn) doReroot(n); else selectBranch(n); });
        hit.addEventListener("mousemove", (e) => showTip(e, n, true));
        hit.addEventListener("mouseleave", hideTip);
        scene.appendChild(hit);
      }
    });
    each(root, (n) => {
      if (n.collapsed || n.children.length < 2) return;
      const vis = n.children.filter((c) => !c.lost || showLoss);
      if (vis.length < 2) return;
      const y0 = Math.min(...vis.map((c) => c._y)), y1 = Math.max(...vis.map((c) => c._y));
      scene.appendChild(el("path", { d: `M${n._x},${y0} V${y1}`, class: n.lost ? "lossbranch" : "branch" }));
    });
    each(root, (n) => {
      if (n.isLoss) {
        if (showLoss) {
          scene.appendChild(el("circle", { cx: n._x, cy: n._y, r: 3.2, fill: "none", stroke: "var(--loss)", "stroke-width": 1.4 }));
          const t = el("text", { x: n._x + 7, y: n._y + 3.5, class: "intlabel", "font-size": Math.max(9, fsize - 2) });
          t.textContent = "✕ " + (n.species || "loss"); t.style.fill = "var(--loss)"; scene.appendChild(t);
        }
        return;
      }
      if (n.collapsed) {
        const nleaf = leaves(n).length || 1, h = Math.min(60, 6 + nleaf * 3);
        const tri = el("path", { d: `M${n._x},${n._y} L${n._x + 34},${n._y - h / 2} L${n._x + 34},${n._y + h / 2} Z`, class: "collapsed" });
        tri.addEventListener("click", (ev) => { ev.stopPropagation(); n.collapsed = false; render(); });
        scene.appendChild(tri);
        const t = el("text", { x: n._x + 40, y: n._y + 4, class: "leaflabel", "font-size": fsize });
        t.textContent = (n.name || ("▸ " + nleaf + " taxa")); scene.appendChild(t);
        return;
      }
      if (n.isLeaf) {
        const lx = opt.align ? tipX + 8 : n._x + 7;
        if (opt.align && lx > n._x + 7) scene.appendChild(el("path", { d: `M${n._x},${n._y} H${lx - 3}`, class: "lossbranch" }));
        const t = el("text", { x: lx, y: n._y + fsize * 0.34, class: "leaflabel", "font-size": fsize });
        t.textContent = n.name || "?";
        if (hlSet.size) { if (matchHL(n)) t.classList.add("hl"); else t.classList.add("dim"); }
        t.addEventListener("mousemove", (e) => showTip(e, n, false));
        t.addEventListener("mouseleave", hideTip);
        scene.appendChild(t);
      }
      if (n.lost) { /* no glyph on lost internal nodes */ }
      else if (isRecon && n.children.length) {
        let g;
        if (n.event === "duplication") g = el("rect", { x: n._x - 4, y: n._y - 4, width: 8, height: 8, fill: "var(--dup)", class: "nodeglyph" });
        else g = el("circle", { cx: n._x, cy: n._y, r: 3, fill: "var(--spec)", class: "nodeglyph" });
        g.setAttribute("data-id", n.id);
        g.addEventListener("click", (ev) => { ev.stopPropagation(); n.collapsed = !n.collapsed; render(); });
        g.addEventListener("mousemove", (e) => showTip(e, n, false));
        g.addEventListener("mouseleave", hideTip);
        scene.appendChild(g);
      } else if (!isRecon && n.children.length) {
        const g = el("circle", { cx: n._x, cy: n._y, r: 2.6, fill: "var(--branch)", class: "nodeglyph" });
        g.addEventListener("click", (ev) => { ev.stopPropagation(); n.collapsed = !n.collapsed; render(); });
        scene.appendChild(g);
      }
      if (n.children.length && !n.collapsed) {
        if (opt.support && n.support != null) {
          const t = el("text", { x: n._x - 4, y: n._y - 5, class: "support", "text-anchor": "end" }); t.textContent = n.support; scene.appendChild(t);
        }
        if (opt.intl && n.name) {
          const t = el("text", { x: n._x + 5, y: n._y - 5, class: "intlabel" }); t.textContent = n.name; scene.appendChild(t);
        }
      }
    });
    if (opt.len) {
      each(root, (n) => { if (n.parent && n.length && !n.isLoss) { const t = el("text", { x: (n.parent._x + n._x) / 2, y: n._y - 3, class: "support", "text-anchor": "middle" }); t.textContent = (+n.length).toFixed(3); scene.appendChild(t); } });
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
    applyView();
    drawLegend();
  }
  // round to the nearest 1/2/5 × 10ⁿ, for a tidy scale-bar distance
  function niceNumber(x) {
    if (!(x > 0)) return x;
    const e = Math.floor(Math.log10(x)), f = x / Math.pow(10, e);
    const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
    return nf * Math.pow(10, e);
  }
  function selectBranch() { container.querySelectorAll(".branch.sel").forEach((e) => e.classList.remove("sel")); }
  function matchHL(n) { const s = (n.name || "") + " " + (n.species || ""); return [...hlSet].some((q) => s.toLowerCase().includes(q)); }

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
    if (!n.children.length) return (n.name || "").replace(/[(),:;]/g, "_") + (n.length != null ? ":" + n.length : "");
    return "(" + n.children.filter((c) => !c.isLoss).map(toNewick).join(",") + ")" + (n.support != null ? n.support : "") + (n.length != null ? ":" + n.length : "");
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
    if (n.isLeaf || !n.children.length) { h = `<b>${n.name || "?"}</b>`; if (n.species) h += `<br>species: <b>${n.species}</b>`; }
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
    const sel = $("selT"); if ([...sel.options].some((o) => +o.value === i)) sel.value = i;
    navCounter(); updateMeta(); render();
  }
  function stepTree(d) {
    if (!filtered.length) return;
    let pos = filtered.indexOf(curIdx); if (pos < 0) pos = d > 0 ? -1 : 0;
    loadTree(filtered[(pos + d + filtered.length) % filtered.length]);
  }
  function applyTreeFilter(q) {
    const box = $("treeSearch");
    q = (q || "").trim().toLowerCase();
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
        if (!n.children || !n.children.length) { if (n.name) taxa.add(String(n.name).toLowerCase()); if (n.species) taxa.add(String(n.species).toLowerCase()); }
        else (n.children || []).forEach(walk);
      })(e.tree);
      e._search = String(e.name || ("tree_" + i)).toLowerCase() + " " + [...taxa].join(" ");
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

  // ---------- static control wiring (once) ----------
  $("segLayout").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    [...e.currentTarget.children].forEach((x) => x.classList.remove("on")); b.classList.add("on"); layout = b.dataset.v;
    $("rowScale").style.display = layout === "phylo" ? "flex" : "none"; render();
  });
  $("vspace").oninput = (e) => { vspace = +e.target.value; render(); };
  $("fsize").oninput = (e) => { fsize = +e.target.value; render(); };
  const chk = (id, k) => { $(id).onchange = (e) => { opt[k] = e.target.checked; render(); }; };
  chk("tSupport", "support"); chk("tLen", "len"); chk("tInt", "intl"); chk("tAlign", "align"); chk("tScale", "scale");
  $("tLoss").onchange = (e) => { showLoss = e.target.checked; render(); };
  $("find").oninput = (e) => { hlSet = new Set(e.target.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)); render(); };
  $("rerootMode").onchange = (e) => { rerootOn = e.target.checked; svg.classList.toggle("reroot", rerootOn); };
  $("ladder").onclick = () => { (function lad(n) { n.children.sort((a, b) => countLeaves(a) - countLeaves(b)); n.children.forEach(lad); })(root); render(); };
  $("expandAll").onclick = () => { each(root, (n) => n.collapsed = false); render(); };
  $("reset").onclick = () => loadTree(curIdx);
  const themeBtn = $("themeBtn");
  if (themeBtn) themeBtn.onclick = () => { const r = document.documentElement; r.dataset.theme = r.dataset.theme === "dark" ? "light" : "dark"; };
  $("expSvg").onclick = exportSvg;
  $("expPdf").onclick = exportPdf;
  $("expNwk").onclick = copyNewick;

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
    curIdx = 0; staleWarn = false; hlSet = new Set(); rerootOn = false;
    filtered = TREES.map((_, i) => i);
    $("rowLoss").style.display = isRecon ? "flex" : "none";
    if (!isRecon) $("legend").style.display = "none";
    // Default to phylogram when the first tree has branch lengths, cladogram otherwise.
    setLayout(TREES.length && treeHasLengths(TREES[0].tree) ? "phylo" : "clado");
    $("rerootMode").checked = false; svg.classList.remove("reroot");
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
