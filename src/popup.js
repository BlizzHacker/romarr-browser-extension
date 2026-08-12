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

  // A page that lists games without their file sizes can be read but not
  // indexed -- ROMarr refuses a catalogue row whose size is unknown. Say so
  // plainly instead of offering a button that would report 40 rejections.
  if (rows.length && !found.indexes) {
    const why = document.createElement("small");
    why.textContent =
      "This page lists games but not their file sizes, so ROMarr cannot "
      + "index from it. Open a game to capture it. The extension will not "
      + "open them for you.";
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

look();
