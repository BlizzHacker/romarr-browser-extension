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

async function look() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab || !tab.id) return say("No page here.", "");
  let found;
  try {
    found = await chrome.tabs.sendMessage(tab.id, {type: "page:scan"});
  } catch (_) {
    // No content script in this tab: the page is not one of the covered
    // sites, so there is nothing to read and nothing was injected into it.
    $("where").textContent =
      "This site has no adapter, so the extension is not running here.";
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

look().then(refreshCatalogCount);
