// newick.js — structural Newick / NHX-carrier parser.
//
// This module is deliberately dumb about biology: it turns Newick text into a
// forest of RawNode trees and *preserves* any `[...]` comment (including NHX
// `[&&NHX:...]`) verbatim on the node it follows. Interpreting those comments
// (duplication / loss / species mapping) is nhx.js's job.
//
// RawNode = {
//   name:    string,        // "" for unlabelled internal nodes
//   length:  number|null,   // branch length after ':'
//   support: number|null,   // numeric internal-node label, if any
//   comment: string|null,   // raw text inside [...] (concatenated if several)
//   children: RawNode[],    // empty ⇒ leaf
// }
//
// Handles: nested (), branch lengths, quoted 'labels' (with '' escaping),
// numeric-vs-name internal labels, `[...]` comments in any position, multiple
// `;`-terminated trees in one string, and `#` comment lines (Clann NHX headers).

export class ParseError extends Error {
  constructor(message, pos, text) {
    super(message);
    this.name = "ParseError";
    this.pos = pos;
    let line = 1, col = 1;
    for (let i = 0; i < pos && i < text.length; i++) {
      if (text[i] === "\n") { line++; col = 1; } else col++;
    }
    this.line = line;
    this.col = col;
    this.snippet = text.slice(Math.max(0, pos - 24), pos + 24);
  }
}

const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * Parse a string containing one or more Newick trees.
 * @param {string} text
 * @returns {{ roots: object[] }}
 */
export function parseNewickForest(text) {
  const n = text.length;
  let i = 0;

  const skipWs = () => { while (i < n && isWs(text[i])) i++; };

  // text[i] must be '['. Consumes a balanced [...] and returns the inner text.
  function readComment() {
    const start = i;
    i++; // consume '['
    let depth = 1, out = "";
    while (i < n && depth > 0) {
      const c = text[i];
      if (c === "[") depth++;
      else if (c === "]") { depth--; if (depth === 0) { i++; return out; } }
      out += c; i++;
    }
    throw new ParseError("Unterminated comment '['", start, text);
  }

  // Reads a quoted or bare label. May return "".
  function readLabel() {
    if (i < n && text[i] === "'") {
      i++;
      let out = "";
      while (i < n) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") { out += "'"; i += 2; continue; } // '' escape
          i++; return out;
        }
        out += text[i]; i++;
      }
      throw new ParseError("Unterminated quoted label", i, text);
    }
    let out = "";
    while (i < n) {
      const c = text[i];
      if (c === "(" || c === ")" || c === "," || c === ":" ||
          c === ";" || c === "[" || isWs(c)) break;
      out += c; i++;
    }
    return out;
  }

  function parseNode() {
    skipWs();
    const node = { name: "", length: null, support: null, comment: null, children: [] };

    if (i < n && text[i] === "(") {
      i++; // consume '('
      for (;;) {
        node.children.push(parseNode());
        skipWs();
        if (i < n && text[i] === ",") { i++; continue; }
        if (i < n && text[i] === ")") { i++; break; }
        throw new ParseError("Expected ',' or ')' in child list", i, text);
      }
    }

    // Optional label (leaf name, or internal-node label) — not if the next
    // token is a delimiter or a comment.
    skipWs();
    let label = "";
    if (i < n && !"():,;[".includes(text[i])) label = readLabel();

    // Comments and :length may appear in either order after the label.
    for (;;) {
      skipWs();
      if (i < n && text[i] === "[") {
        const c = readComment();
        node.comment = node.comment === null ? c : node.comment + c;
        continue;
      }
      if (i < n && text[i] === ":") {
        i++; skipWs();
        let num = "";
        while (i < n) {
          const c = text[i];
          if (c === "(" || c === ")" || c === "," || c === ";" || c === "[" || isWs(c)) break;
          num += c; i++;
        }
        const v = parseFloat(num);
        if (!Number.isNaN(v)) node.length = v;
        continue;
      }
      break;
    }

    // Assign the label: leaves take it as a name; internal nodes treat a purely
    // numeric label as a support value, otherwise as a name.
    if (node.children.length === 0) {
      node.name = label;
    } else if (label !== "") {
      const v = Number(label);
      if (!Number.isNaN(v)) node.support = v;
      else node.name = label;
    }
    return node;
  }

  const roots = [];
  for (;;) {
    skipWs();
    if (i >= n) break;
    if (text[i] === "#") { while (i < n && text[i] !== "\n") i++; continue; } // header/comment line
    const root = parseNode();
    skipWs();
    if (i < n && text[i] === ";") i++;
    roots.push(root);
  }

  if (roots.length === 0) throw new ParseError("No tree found", 0, text);
  return { roots };
}
