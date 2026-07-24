// app.js — upload shell: File → parse() → mountViewer().
//
// Pure client side. Files are read with FileReader; nothing leaves the browser.

import { parse } from "./parse/index.js";
import { mountViewer } from "./viewer.js";

const container = document.getElementById("viewer");
const fileInput = document.getElementById("fileInput");
const empty = document.getElementById("empty");
const drop = document.getElementById("drop");
const errBox = document.getElementById("err");
const wrap = document.getElementById("wrap");

let handle = null; // the live viewer instance, once a file is loaded

function showError(msg) {
  errBox.textContent = msg;
  errBox.style.display = "block";
  clearTimeout(showError._t);
  showError._t = setTimeout(() => (errBox.style.display = "none"), 5000);
}

function loadData(data) {
  empty.style.display = "none";
  if (handle) handle.setData(data);
  else handle = mountViewer(container, data);
}

function openText(text, name) {
  try {
    const data = parse(text, { filename: name });
    loadData(data);
  } catch (err) {
    const where = err && err.line ? ` (line ${err.line}, col ${err.col})` : "";
    showError(`Couldn't parse ${name}${where}: ${err && err.message ? err.message : err}`);
  }
}

async function openFile(file) {
  if (!file) return;
  let text;
  try { text = await file.text(); }
  catch { showError(`Couldn't read ${file.name}`); return; }
  openText(text, file.name);
}

// --- file input / buttons ---
fileInput.addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  openFile(f);
  fileInput.value = ""; // allow re-opening the same filename
});
const pick = () => fileInput.click();
document.getElementById("uploadBtn").addEventListener("click", pick);
document.getElementById("emptyOpen").addEventListener("click", pick);

// --- paste Newick text anywhere (except into a field) to load it ---
window.addEventListener("paste", (e) => {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return; // don't hijack form paste
  const text = e.clipboardData && e.clipboardData.getData("text");
  if (!text || !/\(/.test(text) || !/\)/.test(text)) return; // needs to at least look like a tree
  e.preventDefault();
  openText(text, "pasted tree");
});

// --- light/dark toggle (shell-level: active even before a tree is loaded) ---
document.getElementById("themeBtn").addEventListener("click", () => {
  const r = document.documentElement;
  r.dataset.theme = r.dataset.theme === "dark" ? "light" : "dark";
});

// --- drag & drop over the canvas ---
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
wrap.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (dragDepth++ === 0) drop.classList.add("on"); });
wrap.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
wrap.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove("on"); } });
wrap.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; drop.classList.remove("on");
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  openFile(f);
});

// --- optional deep link: index.html?tree=examples/reconciled.nhx ---
const q = new URLSearchParams(location.search).get("tree");
if (q) {
  fetch(q)
    .then((r) => { if (!r.ok) throw new Error(r.status + " " + r.statusText); return r.text(); })
    .then((text) => loadData(parse(text, { filename: q.split("/").pop() })))
    .catch((err) => showError(`Couldn't load ${q}: ${err.message}`));
}
