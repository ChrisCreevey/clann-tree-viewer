// nhx.js — interpret NHX annotations on top of the structural Newick parser.
//
// Recognises Clann's reconciliation conventions (see reconcile.c `print_nhx_tree`):
//   Gene-copy leaf:   Name[&&NHX:S=Species:D=N]
//   Loss leaf:        Species*LOST[&&NHX:S=Species]
//   Duplication node: (...)[&&NHX:D=Y]   (optionally :S=Species)
//   Speciation node:  (...)[&&NHX:D=N]   (optionally :S=Species)
//
// Output nodes match the shape the Clann viewer (clannview.template.html)
// consumes directly:
//   { name, length?, support?, event?, species?, children? }
//   event ∈ { "speciation" | "duplication" | "loss" | undefined }
//
// General NHX tags beyond S/D are parsed into `tags` too, but only S and D
// drive rendering. Branch lengths / support pass straight through from Newick.

import { parseNewickForest } from "./newick.js";

const LOST_SUFFIX = "*LOST";

/**
 * Parse an NHX comment body into a key→value map.
 * Accepts with or without the leading "&&NHX". e.g. "&&NHX:S=Human:D=Y".
 * @param {string|null} comment
 * @returns {Record<string,string>}
 */
export function parseNhxTags(comment) {
  const tags = {};
  if (!comment) return tags;
  let s = comment.trim();
  if (s.startsWith("&&NHX")) s = s.slice("&&NHX".length);
  for (const part of s.split(":")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq >= 0) tags[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return tags;
}

/**
 * Convert one RawNode tree (from newick.js) into a viewer Node, folding NHX
 * annotations into event/species.
 * @param {object} rawRoot
 * @returns {{ node: object, dups: number, losses: number }}
 */
export function applyNhx(rawRoot) {
  let dups = 0, losses = 0;

  // visit returns { node, fullyLost }. `fullyLost` is true when every leaf at
  // or below this node is a loss. Losses are counted per *maximal* fully-lost
  // subtree (a whole clade lost together is a single loss event), not per lost
  // leaf: a fully-lost child is only tallied once its parent is not itself
  // fully lost (so the count lands on the top edge of the lost clade).
  function visit(raw) {
    const tags = parseNhxTags(raw.comment);
    const isLeaf = raw.children.length === 0;
    const node = { name: raw.name || "" };
    if (raw.length != null) node.length = raw.length;
    if (raw.support != null) node.support = raw.support;

    // Loss leaves are marked by a "*LOST" name suffix.
    let isLoss = false;
    if (isLeaf && node.name.endsWith(LOST_SUFFIX)) {
      isLoss = true;
      node.name = node.name.slice(0, -LOST_SUFFIX.length);
    }

    if (tags.S) node.species = tags.S;

    let fullyLost;
    if (isLeaf) {
      if (isLoss) node.event = "loss";
      // Non-loss leaves carry species (from S=) but no event — gene copies.
      fullyLost = isLoss;
    } else {
      // Only assign an event when NHX actually tells us; leaving it undefined
      // keeps plain (non-reconciled) internal nodes honest.
      if (tags.D === "Y") { node.event = "duplication"; dups++; }
      else if (tags.D === "N") node.event = "speciation";

      const kids = raw.children.map(visit);
      node.children = kids.map((k) => k.node);
      fullyLost = kids.every((k) => k.fullyLost);
      if (!fullyLost) {
        // Each fully-lost child under this surviving node is one loss event.
        for (const k of kids) if (k.fullyLost) losses++;
      }
    }

    return { node, fullyLost };
  }

  const { node, fullyLost } = visit(rawRoot);
  // Degenerate case: the entire tree is a lost clade — count it as one loss.
  if (fullyLost) losses++;
  return { node, dups, losses };
}

/**
 * Parse a whole NHX file (possibly many trees, with Clann `# tree_N (score=..)`
 * headers) into viewer TreeEntry objects.
 * @param {string} text
 * @returns {Array<{name:string, score?:number, dups:number, losses:number, tree:object}>}
 */
export function parseNhxForest(text) {
  const { roots } = parseNewickForest(text);

  // Pull Clann-style headers in document order to recover names + scores.
  const headers = [];
  const re = /#\s*(\S+)[^\n]*?\(score=([-+0-9.eE]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    headers.push({ name: m[1], score: parseFloat(m[2]) });
  }

  return roots.map((raw, idx) => {
    const { node, dups, losses } = applyNhx(raw);
    const h = headers[idx];
    const entry = { name: h ? h.name : `tree_${idx + 1}`, dups, losses, tree: node };
    if (h && !Number.isNaN(h.score)) entry.score = h.score;
    return entry;
  });
}

/** True if the text carries any NHX annotation (used for format detection). */
export function looksLikeNhx(text) {
  return /\[&&NHX/i.test(text);
}
