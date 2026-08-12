/**
 * Site adapters, as data.
 *
 * The extension this grew out of hardcoded one site across four files. Adding
 * a second would have meant a second extension. So a site here is a
 * descriptor: which hosts it covers, which of its pages carry catalogue rows,
 * and where each field lives on them. The interpreter is extract.js and it is
 * the same for every site.
 *
 * WHICH SITES ARE HERE, AND WHY ONLY THESE
 * ----------------------------------------
 * An adapter is only worth writing for a site a plain HTTP client genuinely
 * cannot read. ROMarr already has plugins for the sites it can read, and
 * duplicating one here would mean asking a person to browse pages a server
 * could have fetched on its own. The four below each fail for a different
 * reason that a real browser answers honestly, and the four that are absent
 * are listed in the README with the reason each is absent. Read that before
 * adding a fifth.
 *
 * WHAT A DESCRIPTOR MAY NOT DO
 * ----------------------------
 * There is no `crawl`, no `follow`, no `nextPage`. A descriptor describes how
 * to read the page in front of the user and nothing else, because the
 * extension's whole claim to being honest rests on it having seen only what
 * the user saw. That is enforced rather than promised: tests/no-crawling.test
 * fails the build if a fetch of a site origin appears anywhere in src/.
 */

(function (root) {
  "use strict";

  const ADAPTERS = [
    {
      id: "vimm",
      label: "Vimm's Lair",
      // Must match a key in romarr/capture.py SOURCES, which is what decides
      // the hosts ROMarr will accept rows about. A source ROMarr has never
      // heard of is refused there, by design.
      source: "vimm",
      hosts: ["vimm.net", "*.vimm.net"],
      notes: "Verified against the documented Vault structure.",
      // Why a browser is required here: Vimm has no GET URL for a ROM. The
      // download control is a form POST to dl3.vimm.net carrying a mediaId,
      // and a GET to that URL answers 400. The only way to turn it into bytes
      // is to POST from a page you are genuinely on -- which is what a person
      // browsing is already doing, and what a plugin can never do.
      pages: [
        {
          kind: "detail",
          path: /^\/vault\/(\d+)\/?$/,
          fields: {
            id: [{group: 1}],
            title: [{text: "main h1"}, {text: "h1"}, {text: "[itemprop='name']"},
                    {title: true, then: ["beforeSeparator"]}],
            // Blank on nearly every row of the previous 23,980-row capture,
            // because it only ever looked in one place. Three candidates and
            // a page that states its system in any of them now answers.
            platform: [{label: "system"}, {label: "platform"},
                       {attr: ["[data-system]", "data-system"]},
                       {text: "#dtable td.system"}],
            name: [{label: "file name"}, {label: "filename"}],
            size: [{label: "file size", then: ["bytes"]},
                   {label: "size", then: ["bytes"]}],
            region: [{attr: ["img[src*='/flags/']", "title"]}, {label: "region"}],
            version: [{label: "version"}],
            // Declared and never filled on all 23,980 rows of the previous
            // capture. It is the one actionable handle Vimm hands out, and it
            // is sitting in the download form the whole time.
            media_id: [{input: "mediaId"},
                       {shownAttr: ["a[href*='mediaId=']", "href"],
                        then: [["param", "mediaId"]]}],
            url: [{const: "https://vimm.net/vault/"}]
          },
          // The canonical detail URL, assembled from the id rather than from
          // location.href: the address bar carries tracking parameters and a
          // `?p=play` that must never be indexed as the game's page.
          urlFrom: (row) => "https://vimm.net/vault/" + row.id
        },
        {
          kind: "list",
          // /vault/<System>/<Letter> and the "#" section, which is the same
          // listing reached by a query string.
          path: /^\/vault\/(?:[A-Za-z0-9-]+\/[A-Z0-9]?|)$/,
          // Vimm's listing rows are Title | Region | Version | Languages |
          // Rating. There is no file size anywhere on the page, and ROMarr
          // refuses a row without one -- rightly, because a catalogue entry
          // whose size is unknown cannot be presented as something to stream.
          //
          // So this page enumerates and does not index. Posting its rows
          // anyway would mean every listing page reported "0 indexed, 40
          // skipped", which is a wall of noise that trains an operator to
          // ignore the one report that matters. The popup shows what is here
          // and says the sizes live on the detail pages -- and stops there,
          // because fetching those pages is precisely the crawl this
          // extension does not do.
          indexes: false,
          rows: "table tr",
          fields: {
            // shownAttr, not attr: every listing row opens with a hidden
            // decoy anchor. See extract.visible.
            id: [{shownAttr: ["a[href^='/vault/']", "href"], then: ["digits"]}],
            title: [{shownText: "a[href^='/vault/']"}],
            region: [{attr: ["img[src*='/flags/']", "title"]}],
            version: [{text: "td:nth-child(3)"}],
            platform: [{const: ""}]
          },
          urlFrom: (row) => "https://vimm.net/vault/" + row.id,
          // A listing page states the system once, in its own heading, rather
          // than on every row.
          pageFields: {
            platform: [{text: "select[name='system'] option[selected]"},
                       {text: "h1"}, {title: true, then: ["beforeSeparator"]}]
          }
        }
      ]
    },

    {
      id: "retrostic",
      label: "Retrostic",
      source: "retrostic",
      hosts: ["retrostic.com", "*.retrostic.com"],
      notes: "Detail-page shape from the plugin survey; selectors provisional.",
      // Why a browser: the download control is a form POST carrying a
      // per-render `session` token. A GET-only client cannot submit it, and
      // the token is minted for the page you are on -- so it exists only for
      // somebody who really loaded that page.
      pages: [
        {
          kind: "detail",
          path: /^\/roms\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+-(\d+)\/?$/,
          fields: {
            id: [{group: 1}],
            title: [{text: "h1"}, {title: true, then: ["beforeSeparator"]}],
            platform: [{label: "console"}, {label: "system"},
                       {text: "a[href^='/roms/'] "},
                       {input: "console_url"}],
            size: [{label: "size", then: ["bytes"]},
                   {label: "file size", then: ["bytes"]}],
            region: [{label: "region"}],
            name: [{label: "file name"}, {label: "filename"}]
          },
          urlFrom: (row, ctx) => ctx.canonical
        }
      ]
    },

    {
      id: "theromdepot",
      label: "The ROM Depot",
      source: "theromdepot",
      hosts: ["theromdepot.com", "*.theromdepot.com"],
      notes: "SPA; selectors provisional until confirmed on a signed-in page.",
      // Why a browser: every API call including the directory listing answers
      // 401 without a session. A plugin has its cookie jar cleared before
      // every request and so can never be signed in; the operator signing in
      // themselves is the only version of this that works, and it is also the
      // only version that is anybody's business but theirs.
      pages: [
        {
          kind: "list",
          // A React router path -- any browse route under the file tree.
          path: /^\/(?:browse|files|contents)(?:\/.*)?$/,
          rows: "table tbody tr, [role='row'], li[data-path]",
          fields: {
            id: [{attr: ["a[href]", "href"], then: [["match", ["([^/]+)$"]]]},
                 {attr: ["[data-path]", "data-path"], then: [["match", ["([^/]+)$"]]]}],
            title: [{text: "a[href]"}, {text: "[data-name]"}],
            size: [{text: "td:nth-child(2)", then: ["bytes"]},
                   {attr: ["[data-size]", "data-size"]}],
            name: [{text: "a[href]"}],
            platform: [{const: ""}]
          },
          urlFrom: (row, ctx) => ctx.canonical,
          pageFields: {
            platform: [{text: "h1"}, {text: "[aria-current='page']"}]
          }
        }
      ]
    },

    {
      id: "cdromance",
      label: "CDRomance",
      source: "cdromance",
      hosts: ["cdromance.org", "*.cdromance.org", "cdromance.com", "*.cdromance.com"],
      notes: "Selectors provisional -- the site could not be surveyed; see README.",
      // Why a browser: every path on the site, robots.txt included, answers a
      // Cloudflare managed challenge to a plain client. This extension does
      // not solve that challenge and contains no code that could -- the
      // operator's browser already passed it, as a person, before any of this
      // ran. That distinction is the entire justification for the adapter and
      // it is worth being precise about it: passing because you are a person
      // is not the same act as defeating a check because you are not.
      pages: [
        {
          kind: "detail",
          path: /^\/[A-Za-z0-9-]+\/([A-Za-z0-9-]+)\/?$/,
          fields: {
            id: [{group: 1}],
            title: [{text: "h1.entry-title"}, {text: "h1"},
                    {title: true, then: ["beforeSeparator"]}],
            platform: [{text: ".breadcrumb a:nth-last-child(2)"},
                       {label: "console"}, {label: "platform"}],
            size: [{label: "size", then: ["bytes"]},
                   {text: ".file-size", then: ["bytes"]}],
            region: [{label: "region"}, {text: ".region"}],
            name: [{label: "file name"}]
          },
          urlFrom: (row, ctx) => ctx.canonical
        }
      ]
    }
  ];

  /** Every host pattern, as manifest match patterns. Used by sync-manifest. */
  function matchPatterns() {
    const out = [];
    for (const adapter of ADAPTERS) {
      for (const host of adapter.hosts) out.push("https://" + host + "/*");
    }
    return out;
  }

  /** The adapter covering a hostname, or null. */
  function forHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    for (const adapter of ADAPTERS) {
      for (const pattern of adapter.hosts) {
        const bare = pattern.replace(/^\*\./, "");
        if (host === bare || host.endsWith("." + bare)) return adapter;
      }
    }
    return null;
  }

  /** The page descriptor matching a path within an adapter, or null. */
  function forPath(adapter, pathname) {
    if (!adapter) return null;
    for (const page of adapter.pages) {
      const found = page.path.exec(pathname);
      if (found) return {page, groups: found};
    }
    return null;
  }

  root.RomarrAdapters = {ADAPTERS, matchPatterns, forHost, forPath};
})(typeof globalThis !== "undefined" ? globalThis : self);
