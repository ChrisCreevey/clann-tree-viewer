// nexus.js — minimal NEXUS reader, limited to what a tree viewer needs.
//
// A NEXUS file is a `#NEXUS` header followed by `begin <name>; … end;` blocks.
// We only care about the TREES block, which holds:
//   - an optional `translate` table mapping short keys → taxon labels, and
//   - one or more `tree <name> = <newick>;` (or `utree …`) statements.
//
// We strip `[ … ]` comments (including FigTree/BEAST `[&…]` annotations), pull
// each tree's Newick, parse it with the shared Newick parser, then swap any
// translate keys back to their taxon names. Node metadata inside `[&…]` is not
// interpreted — it's dropped with the comments.

import { parseNewickForest } from "./newick.js";

/** Quick sniff: does this text start with a NEXUS header? */
export function looksLikeNexus(text) {
  return /^﻿?\s*#nexus\b/i.test(text || "");
}

/** Strip surrounding single quotes from a NEXUS token ('' → literal '). */
function unquote(s) {
  s = String(s == null ? "" : s).trim();
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Extract the inner text of `begin <name>; … end;` (case-insensitive), or null. */
function matchBlock(text, name) {
  const m = new RegExp("begin\\s+" + name + "\\s*;([\\s\\S]*?)\\bend\\s*;", "i").exec(text);
  return m ? m[1] : null;
}

/** Parse a `translate a name, b name, …;` table into a key→label Map, or null. */
function parseTranslate(block) {
  const m = /\btranslate\b([\s\S]*?);/i.exec(block);
  if (!m) return null;
  const map = new Map();
  for (const part of m[1].split(",")) {
    const s = part.trim();
    if (!s) continue;
    const mm = /^('(?:[^']|'')*'|\S+)\s+(.+)$/.exec(s);
    if (mm) map.set(unquote(mm[1]), unquote(mm[2]));
  }
  return map.size ? map : null;
}

/** Replace leaf names that are translate keys with their taxon labels. */
function applyTranslate(node, map) {
  if (!node.children || !node.children.length) {
    if (node.name != null && map.has(node.name)) node.name = map.get(node.name);
  } else node.children.forEach((c) => applyTranslate(c, map));
}

/**
 * Parse a NEXUS document into a list of raw trees.
 * @param {string} text
 * @returns {{ name: string, root: object }[]}  root is a RawNode (see newick.js)
 */
export function parseNexus(text) {
  const clean = String(text || "").replace(/\[[^\]]*\]/g, " "); // drop NEXUS comments / [&…] annotations
  const block = matchBlock(clean, "trees");
  if (!block) throw new Error("no TREES block found in NEXUS file");
  const translate = parseTranslate(block);

  const out = [];
  // tree [*] <name> = <newick> ;   (also `utree`)
  const re = /\bu?tree\s+(?:\*\s*)?('(?:[^']|'')*'|[^\s=]+)\s*=\s*([^;]*);/gi;
  let m;
  while ((m = re.exec(block))) {
    const nwk = m[2].trim();
    if (!nwk) continue;
    const { roots } = parseNewickForest(nwk + ";");
    if (!roots.length) continue;
    const root = roots[0];
    if (translate) applyTranslate(root, translate);
    out.push({ name: unquote(m[1]), root });
  }
  if (!out.length) throw new Error("no tree statements found in NEXUS TREES block");
  return out;
}
