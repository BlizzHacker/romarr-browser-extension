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

  function harvest() {
    const adapter = Adapters.forHost(location.hostname);
    if (!adapter) return null;
    const matched = Adapters.forPath(adapter, location.pathname);
    if (!matched) return {adapter, rows: [], reason: "not a catalogue page"};

    const {page, groups} = matched;
    const canonical = canonicalUrl(document);
    const base = {document, url: location.href, canonical, groups};

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
            indexes: page.indexes !== false};
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
})();
