// index.js — parse dispatcher: file text → ViewerData.
//
// ViewerData is exactly what the Clann viewer (clannview.template.html)
// consumes:
//   { type:"tree"|"reconciliation", meta:{...}, trees:[ TreeEntry ] }
//   TreeEntry = { name, score?, dups?, losses?, tree: Node }
//   Node      = { name, length?, support?, event?, species?, children? }

import { parseNewickForest } from "./newick.js";
import { parseNhxForest, looksLikeNhx } from "./nhx.js";

/**
 * Decide how to read a blob of text.
 * @param {string} text
 * @returns {"nhx"|"newick"}
 */
export function detectFormat(text) {
  return looksLikeNhx(text) ? "nhx" : "newick";
}

/** Strip a RawNode tree down to the viewer Node shape (no NHX interpretation). */
function rawToNode(raw) {
  const node = { name: raw.name || "" };
  if (raw.length != null) node.length = raw.length;
  if (raw.support != null) node.support = raw.support;
  if (raw.children.length) node.children = raw.children.map(rawToNode);
  return node;
}

/**
 * Parse one uploaded file's text into a ViewerData document.
 * @param {string} text
 * @param {{ filename?: string, format?: "auto"|"newick"|"nhx", datasetName?: string }} [opts]
 * @returns {object} ViewerData
 */
export function parse(text, opts = {}) {
  const fmt = opts.format && opts.format !== "auto" ? opts.format : detectFormat(text);

  const meta = {};
  const ds = opts.datasetName || opts.filename;
  if (ds) meta.dataset = ds;
  if (opts.filename) meta.source = opts.filename;

  if (fmt === "nhx") {
    const trees = parseNhxForest(text);
    // "reconciliation" only if some tree actually carries events.
    const hasEvents = trees.some((t) => t.dups > 0 || t.losses > 0 || treeHasEvent(t.tree));
    meta.criterion = "recon";
    return { type: hasEvents ? "reconciliation" : "tree", meta, trees };
  }

  // Plain Newick: structural only, no events/species.
  const { roots } = parseNewickForest(text);
  const trees = roots.map((raw, idx) => ({
    name: `tree_${idx + 1}`,
    tree: rawToNode(raw),
  }));
  return { type: "tree", meta, trees };
}

function treeHasEvent(node) {
  if (node.event) return true;
  return (node.children || []).some(treeHasEvent);
}
