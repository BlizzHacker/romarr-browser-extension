/**
 * The service worker: settings, the outbox, and the one request this
 * extension is allowed to make.
 *
 * Exactly one `fetch` exists in this codebase and it is in this file, aimed at
 * the ROMarr the operator configured. That is a deliberate structural choice
 * rather than a coincidence -- a fetch anywhere else would let the extension
 * read a page nobody opened, which is the one thing it promises not to do.
 * tests/no-crawling.test asserts the count.
 *
 * The API key lives in chrome.storage.local because the operator pasted it
 * into the options page. It is sent as X-Api-Key to their own server and to
 * nowhere else; it is never written into a page, never put in a URL, and
 * never logged.
 */

"use strict";

importScripts("adapters.js", "catalog.js");

const SETTINGS_KEY = "romarr_settings_v1";
const OUTBOX_KEY = "romarr_outbox_v1";
const LOG_KEY = "romarr_log_v1";
const CATALOG_KEY = "romarr_catalog_v1";

//: Matches romarr/capture.py MAX_ITEMS. A page with more rows than this is
//: split rather than refused, because the server is right to cap it and the
//: operator is not wrong to have opened a long listing.
const BATCH = 500;

//: Kept small on purpose. The outbox exists to survive ROMarr being briefly
//: down, not to become a second catalogue living in the browser -- which is
//: what the previous extension's 100,000-item local store turned into.
const MAX_OUTBOX = 50;
const MAX_LOG = 40;
const MAX_CATALOG = 500000;

const DEFAULTS = {
  url: "",
  apiKey: "",
  automatic: true,
  enabled: {}
};

async function settings() {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return Object.assign({}, DEFAULTS, got[SETTINGS_KEY] || {});
}

async function saveSettings(patch) {
  const merged = Object.assign(await settings(), patch || {});
  await chrome.storage.local.set({[SETTINGS_KEY]: merged});
  return merged;
}

async function readCatalog() {
  const got = await chrome.storage.local.get(CATALOG_KEY);
  return Array.isArray(got[CATALOG_KEY]) ? got[CATALOG_KEY] : [];
}

async function remember(source, rows) {
  const merged = globalThis.RomarrCatalog.merge(
    await readCatalog(), source, rows, MAX_CATALOG);
  await chrome.storage.local.set({[CATALOG_KEY]: merged});
  return merged;
}

/** Whether the operator has switched this adapter on. Default is on. */
function adapterEnabled(config, id) {
  return config.enabled[id] !== false;
}

/**
 * The ROMarr base URL, normalised, or "".
 *
 * Trailing slashes and a pasted `/api/v1/capture` are both things people
 * genuinely paste into this box, and silently accepting either is cheaper
 * than an error message about a URL that is obviously what they meant.
 */
function baseUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : "http://" + text);
    return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/api\/v1\/capture.*$/, "");
  } catch (_) {
    return "";
  }
}

async function note(entry) {
  const got = await chrome.storage.local.get(LOG_KEY);
  const log = [Object.assign({at: new Date().toISOString()}, entry)]
    .concat(got[LOG_KEY] || []).slice(0, MAX_LOG);
  await chrome.storage.local.set({[LOG_KEY]: log});
  return log;
}

/**
 * Post one batch to ROMarr and report exactly what it said.
 *
 * The server's reply is passed through rather than summarised into a
 * tick: it reports rows it skipped and platforms it could not map, and those
 * are the two things an operator actually needs to see. An extension that
 * reported "sent" while ROMarr indexed nothing would be the same defect the
 * previous capture had, where 23,980 rows carried an empty field nobody
 * noticed for months.
 */
async function post(config, source, items) {
  const base = baseUrl(config.url);
  if (!base) return {ok: false, error: "no ROMarr URL configured"};
  if (!config.apiKey) return {ok: false, error: "no API key configured"};
  let response;
  try {
    response = await fetch(base + "/api/v1/capture", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": config.apiKey
      },
      // The extension's own request, carrying no page's cookies. `omit` is
      // what keeps a capture from riding on whatever session the operator
      // happens to have with their own server.
      credentials: "omit",
      body: JSON.stringify({source, items})
    });
  } catch (error) {
    return {ok: false, error: "could not reach ROMarr: " + error.message};
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    payload = {};
  }
  if (response.status === 401) {
    return {ok: false, status: 401,
            error: "ROMarr refused the API key"};
  }
  if (!response.ok) {
    return {ok: false, status: response.status,
            error: payload.error || ("ROMarr answered " + response.status)};
  }
  return Object.assign({ok: true, status: response.status}, payload);
}

/** Split a page into server-sized batches and send each. */
async function submit(source, items) {
  const config = await settings();
  const rows = Array.isArray(items) ? items : [];
  if (!source) return {ok: false, error: "the page matched no adapter"};
  if (!rows.length) return {ok: false, error: "nothing on this page to send"};

  const totals = {indexed: 0, already_indexed: 0, skipped: 0, seen: 0,
                  unmapped_platforms: [], skipped_reason: {}};
  for (let at = 0; at < rows.length; at += BATCH) {
    const result = await post(config, source, rows.slice(at, at + BATCH));
    if (!result.ok) {
      await queue(source, rows.slice(at));
      await note({source, ok: false, error: result.error});
      return Object.assign(result, {queued: rows.length - at});
    }
    totals.seen += result.seen || 0;
    totals.indexed += result.indexed || 0;
    totals.already_indexed += result.already_indexed || 0;
    totals.skipped += result.skipped || 0;
    for (const row of result.unmapped_platforms || []) {
      totals.unmapped_platforms.push(row);
    }
    for (const key of Object.keys(result.skipped_reason || {})) {
      totals.skipped_reason[key] =
        (totals.skipped_reason[key] || 0) + result.skipped_reason[key];
    }
  }
  await note({source, ok: true, indexed: totals.indexed,
              already: totals.already_indexed, skipped: totals.skipped});
  return Object.assign({ok: true}, totals);
}

/** Hold a page ROMarr could not take, so a restart does not lose it. */
async function queue(source, items) {
  const got = await chrome.storage.local.get(OUTBOX_KEY);
  const outbox = (got[OUTBOX_KEY] || []).concat([{
    source, items, at: new Date().toISOString()
  }]).slice(-MAX_OUTBOX);
  await chrome.storage.local.set({[OUTBOX_KEY]: outbox});
}

/** Try the outbox again. Called from the options page, never on a timer. */
async function flush() {
  const got = await chrome.storage.local.get(OUTBOX_KEY);
  const outbox = got[OUTBOX_KEY] || [];
  if (!outbox.length) return {ok: true, sent: 0, remaining: 0};
  const config = await settings();
  const left = [];
  let sent = 0;
  for (const item of outbox) {
    const result = await post(config, item.source, item.items);
    if (result.ok) sent += 1;
    else left.push(item);
  }
  await chrome.storage.local.set({[OUTBOX_KEY]: left});
  return {ok: !left.length, sent, remaining: left.length};
}

/**
 * The connection test behind the options page's button.
 *
 * Calls an authenticated route on purpose. `/api/health` answers strangers,
 * so testing against it would report a healthy connection for a key ROMarr
 * had rejected -- a green tick that means nothing is worse than no tick.
 */
async function test(candidate) {
  const config = Object.assign(await settings(), candidate || {});
  const base = baseUrl(config.url);
  if (!base) return {ok: false, error: "enter your ROMarr address first"};
  if (!config.apiKey) return {ok: false, error: "enter your ROMarr API key first"};
  let response;
  try {
    response = await fetch(base + "/api/v1/capture/status", {
      headers: {"X-Api-Key": config.apiKey},
      credentials: "omit"
    });
  } catch (error) {
    return {ok: false, error: "could not reach " + base + ": " + error.message};
  }
  if (response.status === 401) {
    return {ok: false, error: "reached ROMarr, but it refused the API key"};
  }
  if (response.status === 404) {
    return {ok: false,
            error: "reached ROMarr, but it has no capture endpoint -- "
                   + "this needs a ROMarr new enough to accept captures"};
  }
  if (!response.ok) {
    return {ok: false, error: "ROMarr answered " + response.status};
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    return {ok: false, error: "ROMarr answered something that was not JSON"};
  }
  if (payload.index_writable === false) {
    return {ok: false,
            error: "reached ROMarr and the key works, but its index "
                   + "directory is not writable -- a capture would go nowhere"};
  }
  return {
    ok: true,
    base,
    sources: (payload.sources || []).map((s) => s.source),
    detail: "connected, key accepted, index writable"
  };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    if (!message || !message.type) return respond({ok: false, error: "no message"});

    if (message.type === "capture:offer") {
      // The page found rows. Whether they go anywhere is this side's
      // decision, because this is the side that knows what the operator
      // asked for.
      await remember(message.source, message.items);
      const config = await settings();
      if (!config.automatic || !adapterEnabled(config, message.adapter)) {
        return respond({ok: true, sent: false, reason: "automatic capture off"});
      }
      return respond(await submit(message.source, message.items));
    }
    if (message.type === "capture:submit") {
      await remember(message.source, message.items);
      return respond(await submit(message.source, message.items));
    }
    if (message.type === "catalog:remember") {
      const items = await remember(message.source, message.items);
      return respond({ok: true, count: items.length});
    }
    if (message.type === "catalog:read") {
      const items = await readCatalog();
      return respond(Object.assign(
        {ok: true, count: items.length},
        message.items === true ? {items} : {}
      ));
    }
    if (message.type === "catalog:search") {
      return respond({
        ok: true,
        items: globalThis.RomarrCatalog.search(
          await readCatalog(), message.query, message.limit)
      });
    }
    if (message.type === "catalog:import") {
      const items = await remember("", message.items);
      return respond({ok: true, count: items.length});
    }
    if (message.type === "settings:get") return respond(await settings());
    if (message.type === "settings:set") return respond(await saveSettings(message.value));
    if (message.type === "settings:test") return respond(await test(message.value));
    if (message.type === "outbox:flush") return respond(await flush());
    if (message.type === "outbox:read") {
      const got = await chrome.storage.local.get([OUTBOX_KEY, LOG_KEY]);
      return respond({
        ok: true,
        pending: (got[OUTBOX_KEY] || []).length,
        log: got[LOG_KEY] || []
      });
    }
    if (message.type === "adapters:list") {
      const config = await settings();
      return respond({
        ok: true,
        adapters: globalThis.RomarrAdapters.ADAPTERS.map((a) => ({
          id: a.id, label: a.label, source: a.source, notes: a.notes,
          hosts: a.hosts, enabled: adapterEnabled(config, a.id)
        }))
      });
    }
    return respond({ok: false, error: "unknown message " + message.type});
  })().catch((error) => respond({ok: false, error: String(error)}));
  return true;
});
