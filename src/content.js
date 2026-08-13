/**
 * Reads the page the user is looking at. Nothing else, ever.
 *
 * This runs at document_idle on a page the operator opened themselves. It
 * looks up the adapter for the host, applies the descriptor for the path, and
 * hands the rows to the service worker. It does not follow links, does not
 * fetch, does not schedule anything, and does not run on a page nobody
 * opened. If you are reading this file to work out whether the extension
 * crawls: it cannot, and tests/no-crawling.test fails the build if a fetch of
 * a site origin is ever added to src/.
 *
 * The previous, site-specific version of this extension DID crawl -- it had a
 * frontier, a visited set and a delay control -- and that is exactly how it
 * ended up following a hidden decoy anchor into a catalogue entry for a game
 * called "9" that does not exist. Reading one real page has no equivalent
 * failure mode.
 */

(function () {
  "use strict";

  const Extract = globalThis.RomarrExtract;
  const Adapters = globalThis.RomarrAdapters;

  /** Fields every row must have before it is worth sending. */
  function usable(row) {
    return Boolean(row && row.id && row.title && row.url);
  }

  /**
   * The page's canonical URL.
   *
   * `location.href` carries whatever tracking parameters the visit picked up,
   * plus -- on Vimm -- a `?p=play` that turns a catalogue page into a player
   * session. Neither belongs in a library row, so the canonical link wins
   * when the page publishes one.
   */
  function canonicalUrl(doc) {
    const link = doc.querySelector("link[rel='canonical']");
    const href = link && link.getAttribute("href");
    return Extract.httpsUrl(href || location.href.split("#")[0], location.href);
  }

  /**
   * The JSON of a document that IS a JSON response, or null.
   *
   * A browser shown `application/json` renders it as a document with the text
   * in a <pre>; some builds wrap it in a viewer instead, so the <pre> is
   * tried first and the body's text second. Either way this is reading the
   * document the content script was injected into -- the same act as reading
   * a table, and emphatically not a fetch. The operator navigated here.
   */
  function documentJson() {
    const pre = document.querySelector("pre");
    for (const text of [pre && pre.textContent, document.body && document.body.innerText]) {
      const raw = String(text || "").trim();
      if (!raw || (raw[0] !== "{" && raw[0] !== "[")) continue;
      try {
        return JSON.parse(raw);
      } catch (_) {
        // Fall through to the next candidate rather than reporting the page
        // as broken: a viewer's rendering is not always valid JSON on its own.
      }
    }
    return null;
  }

  function harvest() {
    const adapter = Adapters.forHost(location.hostname);
    if (!adapter) return null;
    const matched = Adapters.forPath(adapter, location.pathname);
    if (!matched) return {adapter, rows: [], reason: "not a catalogue page"};

    const {page, groups} = matched;
    const canonical = canonicalUrl(document);
    const base = {document, url: location.href, canonical, groups};

    // A page that is a JSON document rather than markup. The rows are objects
    // in that document, so the pickers read keys instead of selectors; every
    // other rule -- the required fields, the urlFrom, ROMarr's validation --
    // is unchanged, because a row is a row however it arrived.
    if (page.kind === "json") {
      const payload = documentJson();
      if (payload === null) {
        return {adapter, page: page.kind, rows: [],
                reason: "this page is not the JSON document the adapter expects "
                        + "-- if you are signed out it is probably an error page",
                url: canonical, indexes: page.indexes !== false};
      }
      const items = Extract.jsonFiles(payload, page.collect || {});
      const found = [];
      for (const item of items) {
        const ctx = Object.assign({}, base, {scope: document, item});
        const row = Extract.record(page.fields, ctx);
        row._href = item.path || item.url || item.href || "";
        if (page.urlFrom) {
          try {
            row.url = page.urlFrom(Object.assign({}, row, item), ctx) || "";
          } catch (_) {
            row.url = "";
          }
        }
        delete row._href;
        if (usable(row)) found.push(row);
      }
      const seenJson = new Set();
      return {adapter, page: page.kind, url: canonical,
              indexes: page.indexes !== false,
              reason: items.length && !found.length
                ? "found " + items.length + " entries but none carried an id, a "
                  + "title and a usable link -- check the popup's key names"
                : "",
              rows: found.filter((row) => {
                if (seenJson.has(row.id)) return false;
                seenJson.add(row.id);
                return true;
              })};
    }

    // Facts a listing page states once, in a heading, rather than on every
    // row -- the system a whole page of games belongs to, most often.
    const shared = page.pageFields
      ? Extract.record(page.pageFields, Object.assign({}, base, {scope: document}))
      : {};

    const scopes = page.kind === "list"
      ? Array.from(document.querySelectorAll(page.rows || "*"))
      : [document];

    const rows = [];
    for (const scope of scopes) {
      const ctx = Object.assign({}, base, {scope});
      const row = Extract.record(page.fields, ctx);
      for (const key of Object.keys(shared)) {
        if (!row[key] && shared[key]) row[key] = shared[key];
      }
      if (page.urlFrom) {
        try {
          row.url = page.urlFrom(row, ctx) || row.url;
        } catch (_) {
          row.url = "";
        }
      }
      if (usable(row)) rows.push(row);
    }

    // A listing can legitimately repeat a title across sections; the page is
    // reporting one game either way.
    const seen = new Set();
    const unique = rows.filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });

    // Some pages can be read but cannot produce an index row -- a listing
    // that carries no file size, most often. They are still worth reading, so
    // the popup can show what is there; they are just not worth posting.
    return {adapter, page: page.kind, rows: unique, url: canonical,
            indexes: page.indexes !== false, reason: page.reason || ""};
  }

  let latest = null;

  function scan() {
    try {
      latest = harvest();
    } catch (error) {
      latest = {error: String(error && error.message ? error.message : error)};
    }
    return latest;
  }

  function rememberPage(found) {
    if (!found || !found.adapter || !found.rows || !found.rows.length) return;
    chrome.runtime.sendMessage({
      type: "catalog:remember",
      source: found.adapter.source,
      items: found.rows
    }).catch(() => {
      // Reloading the extension can retire this content-script context while
      // a message is in flight. The next scan or popup open will retry it.
    });
  }

  // The popup asks what is on this page so the operator can look at the rows
  // before any of them are sent. That preview is the whole answer to an
  // adapter whose selectors are provisional: a wrong selector shows up as
  // "no rows found", not as rubbish in somebody's library.
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message && message.type === "page:scan") {
      const found = scan();
      respond({
        ok: true,
        adapter: found && found.adapter ? found.adapter.id : "",
        // The popup posts this straight back as the capture's source, so it
        // has to travel with the preview rather than be looked up again.
        source: found && found.adapter ? found.adapter.source : "",
        label: found && found.adapter ? found.adapter.label : "",
        notes: found && found.adapter ? found.adapter.notes : "",
        kind: (found && found.page) || "",
        indexes: Boolean(found && found.indexes),
        reason: (found && found.reason) || "",
        error: (found && found.error) || "",
        rows: (found && found.rows) || []
      });
      return true;
    }
    if (message && message.type === "page:send") {
      const found = latest || scan();
      chrome.runtime.sendMessage({
        type: "capture:submit",
        source: found && found.adapter ? found.adapter.source : "",
        items: (found && found.rows) || []
      }, respond);
      return true;
    }
    return false;
  });

  const found = scan();
  rememberPage(found);
  if (found && found.indexes && found.rows && found.rows.length) {
    // Offered to the service worker, which decides whether the operator asked
    // for automatic capture. The decision lives there because that is where
    // the settings are; sending it here and dropping it there would mean the
    // page's rows left the tab before anyone had consented to it.
    chrome.runtime.sendMessage({
      type: "capture:offer",
      source: found.adapter.source,
      adapter: found.adapter.id,
      url: found.url,
      items: found.rows
    });
  }

  // React/virtual-list pages often have no rows at document_idle and paint
  // them a moment later. Debouncing subtree changes lets those visible rows
  // join the local catalog without following a link or requesting a page.
  // Automatic ROMarr submission is intentionally not repeated here.
  let rememberTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(() => rememberPage(scan()), 350);
  });
  observer.observe(document.documentElement, {childList: true, subtree: true});
})();
