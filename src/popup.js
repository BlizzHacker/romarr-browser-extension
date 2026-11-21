/**
 * The toolbar popup: what this page would send, before it sends it.
 *
 * The preview is the point. Several adapters carry selectors that were
 * written from a site's documented structure rather than from the live page,
 * and the honest way to ship those is to let the operator see what came out
 * before anything leaves the browser. A wrong selector reads as "no rows
 * found here", which is a bug report; the alternative is rubbish arriving
 * silently in a library.
 */

"use strict";

const $ = (id) => document.getElementById(id);

function say(text, kind) {
  $("result").textContent = text;
  $("result").className = "result " + (kind || "");
}

/** Built with the DOM, not innerHTML: every value here came off a web page. */
function renderRows(rows) {
  const host = $("preview");
  host.textContent = "";
  for (const row of rows.slice(0, 8)) {
    const item = document.createElement("div");
    item.className = "item";
    const name = document.createElement("b");
    name.textContent = row.title || "(untitled)";
    const meta = document.createElement("small");
    meta.textContent = [row.platform || "platform not found",
                        row.size ? row.size + " bytes" : "size not found",
                        "id " + row.id].join(" · ");
    item.appendChild(name);
    item.appendChild(meta);
    host.appendChild(item);
  }
  if (rows.length > 8) {
    const more = document.createElement("p");
    more.className = "note small";
    more.textContent = `…and ${rows.length - 8} more on this page.`;
    host.appendChild(more);
  }
}

let current = null;
let pageFiles = [];
let activeTabInfo = {url: "", title: ""};
const selectedUrls = new Set();

function filteredFiles() {
  const q = ($("file-filter") ? $("file-filter").value : "").trim().toLowerCase();
  if (!q) return pageFiles;
  return pageFiles.filter((f) =>
    (f.filename || "").toLowerCase().includes(q)
    || (f.label || "").toLowerCase().includes(q)
    || (f.ext || "").toLowerCase().includes(q)
  );
}

//: A file-host landing page is HTML; downloading its URL saves the page.
const isMirror = (f) => f.kind === "mirror";

function updateDownloadButtons() {
  const chosen = selectedFileItems();
  const files = chosen.filter((f) => !isMirror(f)).length;
  const pages = chosen.length - files;
  if ($("dl-server")) $("dl-server").disabled = files === 0;
  if ($("dl-local")) $("dl-local").disabled = files === 0;
  if ($("dl-open")) $("dl-open").disabled = pages === 0;
  if ($("dl-copy")) $("dl-copy").disabled = chosen.length === 0;
}

/** One line per multi-part set: its host, how many parts, which are missing. */
function renderSets() {
  const host = $("sets-list");
  if (!host || !globalThis.RomarrMirrors) return;
  host.textContent = "";
  for (const group of globalThis.RomarrMirrors.groupSets(pageFiles)) {
    if (group.parts.length < 2 && !group.missing.length) continue;
    const item = document.createElement("div");
    item.className = "item";
    const name = document.createElement("b");
    name.textContent = group.set;
    const meta = document.createElement("small");
    meta.textContent = [
      group.host_label || "direct files",
      `${group.parts.length} part${group.parts.length === 1 ? "" : "s"}`,
      group.complete ? "complete" : "missing part " + group.missing.join(", ")
    ].join(" · ");
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "secondary";
    pick.style.cssText = "padding:1px 6px;font-size:11px;margin-left:6px";
    pick.textContent = "Select set";
    pick.onclick = () => {
      selectedUrls.clear();
      for (const part of group.parts) selectedUrls.add(part.url);
      renderFiles();
    };
    name.appendChild(pick);
    item.appendChild(name);
    item.appendChild(meta);
    host.appendChild(item);
  }
}

function renderFiles() {
  const host = $("files-list");
  if (!host) return;
  host.textContent = "";
  const list = filteredFiles();
  $("file-count").textContent = `${selectedUrls.size}/${pageFiles.length}`;
  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "note small";
    empty.textContent = pageFiles.length ? "No files match filter." : "No downloadable file links found on this page.";
    host.appendChild(empty);
    updateDownloadButtons();
    return;
  }
  for (const file of list.slice(0, 100)) {
    const row = document.createElement("label");
    row.className = "item";
    row.style.display = "flex";
    row.style.alignItems = "flex-start";
    row.style.gap = "6px";
    row.style.cursor = "pointer";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedUrls.has(file.url);
    cb.onchange = () => {
      if (cb.checked) selectedUrls.add(file.url);
      else selectedUrls.delete(file.url);
      $("file-count").textContent = `${selectedUrls.size}/${pageFiles.length}`;
      updateDownloadButtons();
    };
    const info = document.createElement("div");
    const name = document.createElement("b");
    name.textContent = file.filename || file.label;
    const meta = document.createElement("small");
    meta.style.display = "block";
    meta.textContent = [
      file.host_label ? file.host_label + (isMirror(file) ? " page" : " file") : (file.ext || "file"),
      file.part ? "part " + file.part : "",
      file.size_text || ""
    ].filter(Boolean).join(" · ");
    info.appendChild(name);
    info.appendChild(meta);
    row.appendChild(cb);
    row.appendChild(info);
    host.appendChild(row);
  }
  updateDownloadButtons();
}

async function scanPageFiles(tab) {
  if (!tab || !tab.id || !/^https?:\/\//i.test(tab.url || "")) {
    renderFiles();
    return;
  }
  activeTabInfo = {url: tab.url || "", title: tab.title || ""};
  try {
    await chrome.scripting.executeScript({
      target: {tabId: tab.id},
      files: ["src/mirrors.js", "src/extract.js"]
    });
    const [{result}] = await chrome.scripting.executeScript({
      target: {tabId: tab.id},
      func: () => (globalThis.RomarrExtract
        ? globalThis.RomarrExtract.extractDownloadLinks(document, location.href)
        : [])
    });
    pageFiles = Array.isArray(result) ? result : [];
    for (const f of pageFiles) selectedUrls.add(f.url);
  } catch (_) {
    pageFiles = [];
  }
  renderSets();
  renderFiles();
}

async function look() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab || !tab.id) return say("No page here.", "");
  scanPageFiles(tab);
  let found;
  try {
    found = await chrome.tabs.sendMessage(tab.id, {type: "page:scan"});
  } catch (_) {
    // No catalog adapter on this tab; universal Page Files extractor still runs.
    $("where").textContent =
      "No catalog adapter on this site — use Page Files below to extract & download.";
    $("send").disabled = true;
    return;
  }
  current = found;
  if (found.error) {
    $("where").textContent = "This page could not be read: " + found.error;
    $("send").disabled = true;
    return;
  }
  const rows = found.rows || [];
  $("where").textContent = rows.length
    ? `${found.label} — ${rows.length} row${rows.length === 1 ? "" : "s"} on this `
      + `${found.kind} page.`
    : `${found.label} — nothing to capture on this page`
      + (found.reason ? ` (${found.reason}).` : ".");
  if (found.notes) {
    const note = document.createElement("small");
    note.textContent = found.notes;
    $("where").appendChild(note);
  }
  renderRows(rows);
  if (rows.length) {
    await chrome.runtime.sendMessage({
      type: "catalog:remember", source: found.source || "", items: rows
    });
  }

  // Some pages are useful as metadata previews but deliberately not eligible
  // for indexing. Explain the descriptor's exact reason instead of offering
  // a button that is guaranteed to be refused or unsafe.
  if (rows.length && !found.indexes) {
    const why = document.createElement("small");
    why.textContent = found.reason
      ? found.reason.charAt(0).toUpperCase() + found.reason.slice(1) + "."
      : "This page is metadata preview only and cannot be sent to ROMarr.";
    $("where").appendChild(why);
  }
  $("send").disabled = rows.length === 0 || !found.indexes;
}

$("send").onclick = async () => {
  if (!current) return;
  say("Sending…", "");
  const result = await chrome.runtime.sendMessage({
    type: "capture:submit",
    source: current.source || "",
    items: current.rows || []
  });
  if (!result || !result.ok) {
    return say((result && result.error) || "Could not send.", "bad");
  }
  const unmapped = (result.unmapped_platforms || [])
    .map((row) => `${row.platform} (${row.count})`).join(", ");
  say(`${result.indexed} indexed, ${result.already_indexed} already there, `
      + `${result.skipped} skipped.`
      + (unmapped ? ` ROMarr has no platform for: ${unmapped}.` : ""),
      "ok");
};

$("options").onclick = () => chrome.runtime.openOptionsPage();

function renderCatalog(rows) {
  const host = $("catalog-results");
  host.textContent = "";
  for (const row of rows || []) {
    const item = document.createElement("div");
    item.className = "item";
    const name = document.createElement("b");
    name.textContent = row.title;
    const meta = document.createElement("small");
    meta.textContent = [row.source, row.platform || "platform unknown",
                        row.region || "region unknown"].join(" · ");
    item.appendChild(name);
    item.appendChild(meta);
    host.appendChild(item);
  }
}

async function searchCatalog() {
  const result = await chrome.runtime.sendMessage({
    type: "catalog:search", query: $("catalog-query").value, limit: 12
  });
  renderCatalog(result.items || []);
}

$("catalog-search").onclick = searchCatalog;
$("catalog-query").onkeydown = (event) => {
  if (event.key === "Enter") searchCatalog();
};

async function refreshCatalogCount() {
  const result = await chrome.runtime.sendMessage({type: "catalog:read"});
  $("catalog-count").textContent = `${result.count || 0} saved locally`;
}

if ($("file-filter")) $("file-filter").oninput = () => renderFiles();
if ($("dl-select-all")) {
  $("dl-select-all").onclick = () => {
    for (const f of filteredFiles()) selectedUrls.add(f.url);
    renderFiles();
  };
}
if ($("dl-select-none")) {
  $("dl-select-none").onclick = () => {
    for (const f of filteredFiles()) selectedUrls.delete(f.url);
    renderFiles();
  };
}

function selectedFileItems() {
  return pageFiles.filter((f) => selectedUrls.has(f.url));
}

/** Selected direct files, and the folder a single selected set should use. */
function selectedDownloads() {
  const items = selectedFileItems().filter((f) => !isMirror(f));
  const sets = new Set(items.map((f) => f.set || ""));
  const typed = ($("dl-dest") && $("dl-dest").value.trim()) || "";
  const only = sets.size === 1 ? [...sets][0] : "";
  const destination = typed || (only ? only.replace(/\.[^.]+$/, "") : "");
  return {items, destination};
}

if ($("dl-server")) {
  $("dl-server").onclick = async () => {
    const {items, destination} = selectedDownloads();
    if (!items.length) return;
    say(`Queueing ${items.length} file(s) on ROMarr server…`, "");
    const res = await chrome.runtime.sendMessage({
      type: "downloads:send_server",
      items,
      pageUrl: activeTabInfo.url,
      pageTitle: activeTabInfo.title,
      platform: ($("dl-platform") && $("dl-platform").value.trim()) || "",
      destination
    });
    if (!res || !res.ok) {
      return say((res && res.error) || "Server download failed.", "bad");
    }
    say(`Server queued ${res.queued} file(s) → ${res.dest_dir}`, "ok");
  };
}

if ($("dl-local")) {
  $("dl-local").onclick = async () => {
    const {items, destination} = selectedDownloads();
    if (!items.length) return;
    say(`Starting ${items.length} local Chrome download(s)…`, "");
    const res = await chrome.runtime.sendMessage({
      type: "downloads:start_local",
      items,
      pageUrl: activeTabInfo.url,
      platform: ($("dl-platform") && $("dl-platform").value.trim()) || "",
      destination,
      autoSendCompleted: Boolean($("dl-after-complete") && $("dl-after-complete").checked),
      adopt: Boolean($("dl-adopt") && $("dl-adopt").checked)
    });
    if (!res || !res.ok) {
      return say((res && res.error) || "Could not start local downloads.", "bad");
    }
    say(`Started ${res.started} local download(s).`
        + (res.errors && res.errors.length ? ` Errors: ${res.errors.length}` : ""), "ok");
  };
}

if ($("dl-open")) {
  $("dl-open").onclick = async () => {
    const urls = selectedFileItems().filter(isMirror).map((f) => f.url);
    if (!urls.length) return;
    const res = await chrome.runtime.sendMessage({type: "mirrors:open", urls});
    if (!res || !res.ok) return say((res && res.error) || "Could not open pages.", "bad");
    say(`Opened ${res.opened} page(s) in background tabs.`, "ok");
  };
}

if ($("dl-copy")) {
  $("dl-copy").onclick = async () => {
    const chosen = selectedFileItems();
    const ordered = chosen.slice().sort((a, b) => (a.part || 0) - (b.part || 0));
    try {
      await navigator.clipboard.writeText(ordered.map((f) => f.url).join("\n"));
      say(`Copied ${ordered.length} link(s), one per line.`, "ok");
    } catch (_) {
      say("The clipboard refused the copy.", "bad");
    }
  };
}

look().then(refreshCatalogCount);
