// Parser tests — run with:  node --test
//
// Fixture-driven: each *.{nwk,nhx} in fixtures/ is parsed and compared against
// its *.expected.json sibling. Plus a few targeted assertions for the tricky
// cases (dup/loss counts, format detection, error reporting).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parse, detectFormat } from "../src/parse/index.js";
import { parseNewickForest, ParseError } from "../src/parse/newick.js";
import { parseNhxTags, parseNhxForest } from "../src/parse/nhx.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const examples = join(here, "..", "examples");
const read = (name) => readFileSync(join(fixtures, name), "utf8");
const readJson = (name) => JSON.parse(read(name));

// ---- fixture round-trips ---------------------------------------------------

for (const [input, expected] of [
  ["plain.nwk", "plain.expected.json"],
  ["multi.nwk", "multi.expected.json"],
  ["recon_small.nhx", "recon_small.expected.json"],
]) {
  test(`parse ${input} matches ${expected}`, () => {
    const got = parse(read(input), { filename: input });
    assert.deepEqual(got, readJson(expected));
  });
}

// ---- format detection ------------------------------------------------------

test("detectFormat", () => {
  assert.equal(detectFormat("(A,B);"), "newick");
  assert.equal(detectFormat("(A[&&NHX:S=A:D=N],B);"), "nhx");
});

// ---- NHX tag parsing -------------------------------------------------------

test("parseNhxTags with and without &&NHX prefix", () => {
  assert.deepEqual(parseNhxTags("&&NHX:S=Human:D=Y"), { S: "Human", D: "Y" });
  assert.deepEqual(parseNhxTags(":S=Rat:D=N"), { S: "Rat", D: "N" });
  assert.deepEqual(parseNhxTags(null), {});
});

// ---- dup / loss counting against the full Clann sample ---------------------

test("reconciled.nhx: 8 trees with expected dup/loss counts", () => {
  const trees = parseNhxForest(readFileSync(join(examples, "reconciled.nhx"), "utf8"));
  assert.equal(trees.length, 8);
  const counts = trees.map((t) => [t.name, t.dups, t.losses]);
  assert.deepEqual(counts, [
    ["tree_0", 0, 0],
    ["tree_1", 0, 1],
    ["tree_2", 0, 0],
    ["tree_3", 2, 0],
    ["tree_4", 5, 2],
    ["tree_5", 4, 0],
    ["tree_6", 1, 2],
    ["tree_7", 3, 12],
  ]);
});

test("loss leaf strips *LOST suffix and carries species + event", () => {
  const [t] = parseNhxForest(read("recon_small.nhx"));
  const gorilla = t.tree.children[0].children[1];
  assert.deepEqual(gorilla, { name: "Gorilla", species: "Gorilla", event: "loss" });
});

// ---- newick edge cases -----------------------------------------------------

test("quoted labels, lengths and numeric-support internal labels", () => {
  const { roots } = parseNewickForest("((A:0.1,'q, name':0.4)95:0.3,C);");
  const inner = roots[0].children[0];
  assert.equal(inner.support, 95);
  assert.equal(inner.children[1].name, "q, name");
  assert.equal(roots[0].children[1].name, "C");
});

test("multiple trees in one string", () => {
  const { roots } = parseNewickForest("(A,B);\n(C,D);");
  assert.equal(roots.length, 2);
});

test("malformed input throws ParseError with position", () => {
  assert.throws(() => parseNewickForest("((A,B)"), (err) => {
    assert.ok(err instanceof ParseError);
    assert.equal(typeof err.line, "number");
    assert.equal(typeof err.col, "number");
    return true;
  });
});

test("empty input throws", () => {
  assert.throws(() => parseNewickForest("   "), ParseError);
});
