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

async function openFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = parse(text, { filename: file.name });
    loadData(data);
  } catch (err) {
    const where = err && err.line ? ` (line ${err.line}, col ${err.col})` : "";
    showError(`Couldn't parse ${file.name}${where}: ${err && err.message ? err.message : err}`);
  }
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
