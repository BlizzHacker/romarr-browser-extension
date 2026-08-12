/**
 * The options page.
 *
 * Three jobs: hold the ROMarr address and key, let the operator turn adapters
 * on and off, and prove the connection actually works. The third is the one
 * that matters -- see `test` in background.js for why it calls an
 * authenticated route rather than /api/health.
 */

"use strict";

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

/** Text, never HTML: an adapter label is data and this page is not a place to
 * find out that somebody put a tag in one. */
function say(element, text, kind) {
  element.textContent = text;
  element.className = "result " + (kind || "");
}

/**
 * Ask for permission to talk to the operator's ROMarr.
 *
 * The manifest does not claim access to every host; it asks for the one host
 * the operator typed, when they type it. An extension that shipped with
 * `https://*/*` in host_permissions would be asking for the whole web in
 * order to reach one LAN address.
 */
async function grant(url) {
  let origin;
  try {
    origin = new URL(/^https?:\/\//i.test(url) ? url : "http://" + url).origin + "/*";
  } catch (_) {
    return false;
  }
  if (await chrome.permissions.contains({origins: [origin]})) return true;
  try {
    return await chrome.permissions.request({origins: [origin]});
  } catch (_) {
    return false;
  }
}

async function load() {
  const config = await send({type: "settings:get"});
  $("url").value = config.url || "";
  $("key").value = config.apiKey || "";
  $("automatic").checked = config.automatic !== false;

  const list = await send({type: "adapters:list"});
  const host = $("adapters");
  host.textContent = "";
  for (const adapter of list.adapters || []) {
    const label = document.createElement("label");
    label.className = "check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = adapter.enabled;
    box.dataset.adapter = adapter.id;
    const name = document.createElement("span");
    name.textContent = adapter.label + " ";
    const hosts = document.createElement("code");
    hosts.textContent = adapter.hosts.join(", ");
    name.appendChild(hosts);
    if (adapter.notes) {
      const note = document.createElement("small");
      note.textContent = adapter.notes;
      name.appendChild(note);
    }
    label.appendChild(box);
    label.appendChild(name);
    host.appendChild(label);
  }
  await refreshOutbox();
}

async function refreshOutbox() {
  const state = await send({type: "outbox:read"});
  $("pending").textContent = (state.pending || 0) + " waiting";
  const log = $("log");
  log.textContent = "";
  for (const entry of (state.log || []).slice(0, 10)) {
    const line = document.createElement("li");
    line.className = entry.ok ? "ok" : "bad";
    line.textContent = entry.ok
      ? `${entry.at.slice(11, 19)} ${entry.source}: ${entry.indexed} indexed, `
        + `${entry.already} already there, ${entry.skipped} skipped`
      : `${entry.at.slice(11, 19)} ${entry.source}: ${entry.error}`;
    log.appendChild(line);
  }
}

function currentEnabled() {
  const enabled = {};
  for (const box of document.querySelectorAll("[data-adapter]")) {
    enabled[box.dataset.adapter] = box.checked;
  }
  return enabled;
}

$("save").onclick = async () => {
  const url = $("url").value.trim();
  if (url && !(await grant(url))) {
    return say($("result"),
               "Chrome would not grant access to that address, so captures "
               + "could not be sent to it.", "bad");
  }
  await send({type: "settings:set", value: {
    url, apiKey: $("key").value.trim(),
    automatic: $("automatic").checked, enabled: currentEnabled()
  }});
  say($("result"), "Saved.", "ok");
};

$("test").onclick = async () => {
  const url = $("url").value.trim();
  say($("result"), "Testing…", "");
  if (url && !(await grant(url))) {
    return say($("result"), "Chrome would not grant access to that address.", "bad");
  }
  const result = await send({type: "settings:test", value: {
    url, apiKey: $("key").value.trim()
  }});
  say($("result"),
      result.ok
        ? `Connected to ${result.base} — ${result.detail}. It accepts captures `
          + `from: ${(result.sources || []).join(", ") || "no sources"}.`
        : result.error,
      result.ok ? "ok" : "bad");
};

$("flush").onclick = async () => {
  const result = await send({type: "outbox:flush"});
  say($("result"),
      result.sent
        ? `Sent ${result.sent}; ${result.remaining} still waiting.`
        : (result.remaining ? `Still could not send ${result.remaining}.`
                            : "Nothing waiting."),
      result.ok ? "ok" : "bad");
  await refreshOutbox();
};

load();
