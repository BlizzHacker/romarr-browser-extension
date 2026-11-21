/**
 * File-host mirrors and multi-part sets, read off a page you opened.
 *
 * Release pages (NXBrew and its kind) do not link files. They link a file
 * host's landing page -- 1Fichier, DataNodes, MultiUp, FileKeeper -- once per
 * part of a split archive, usually once per host. This module tells those two
 * kinds of link apart and groups the parts, so the popup can say "this game is
 * six parts on DataNodes, part 4 is missing" instead of offering six HTML
 * pages as if they were files.
 *
 * It only classifies URLs it is handed. It makes no request and follows no
 * link: a landing page is opened only when the operator presses the button
 * that opens it, and the file host's own wait, captcha and download button are
 * left to the person in front of it.
 */

(function (root) {
  "use strict";

  //: Known file hosts. Every domain listed belongs to the host named.
  //: 1Fichier answers on a family of domains; all of them serve the same
  //: landing page.
  const HOSTS = [
    {id: "1fichier", label: "1Fichier", domains: [
      "1fichier.com", "alterupload.com", "cjoint.net", "desfichiers.com",
      "dfichiers.com", "megadl.fr", "mesfichiers.org", "piecejointe.net",
      "pjointe.com", "tenvoi.com", "dl4free.com"]},
    {id: "datanodes", label: "DataNodes", domains: ["datanodes.to"]},
    {id: "multiup", label: "MultiUp", domains: ["multiup.io", "multiup.org"]},
    {id: "filekeeper", label: "FileKeeper", domains: ["fetchio.cc", "filekeeper.com"]}
  ];

  //: Pages that list mirror links but are not file hosts themselves. A tab
  //: opened from one of these is treated like one opened from a file host
  //: by the pop-up closer.
  const RELEASE_SITES = ["nxbrew.net", "nxbrew.com"];

  function hostOf(urlStr) {
    try {
      return new URL(urlStr).hostname.toLowerCase().replace(/\.$/, "");
    } catch (_) {
      return "";
    }
  }

  function onDomain(host, domain) {
    return host === domain || host.endsWith("." + domain);
  }

  /** The known file host a URL belongs to, or null. */
  function fileHost(urlStr) {
    const host = hostOf(urlStr);
    if (!host) return null;
    return HOSTS.find((h) => h.domains.some((d) => onDomain(host, d))) || null;
  }

  function isReleaseSite(urlStr) {
    const host = hostOf(urlStr);
    return Boolean(host) && RELEASE_SITES.some((d) => onDomain(host, d));
  }

  /**
   * Whether a known-host URL is the file itself rather than its landing page.
   *
   * FileKeeper hands out signed edge links (`/f/<token>?sig=`), and 1Fichier's
   * final link lives on a numbered download subdomain. Everything else on a
   * known host is a landing page, even when its path ends in `.rar` --
   * DataNodes and MultiUp put the file name in the landing page's URL, and
   * saving that URL saves their HTML.
   */
  function isDirect(urlStr) {
    const host = fileHost(urlStr);
    if (!host) return false;
    let url;
    try {
      url = new URL(urlStr);
    } catch (_) {
      return false;
    }
    const name = url.hostname.toLowerCase();
    if (host.id === "filekeeper") {
      return /^\/f\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && url.searchParams.has("sig");
    }
    if (host.id === "1fichier") {
      const sub = name.slice(0, -"1fichier.com".length).replace(/\.$/, "");
      return onDomain(name, "1fichier.com") && sub !== "" && sub !== "www";
    }
    return false;
  }

  /**
   * Part number and set name of one file name, or null when it is not a part.
   *
   * Four spellings are in use: `name.part3.rar`, `name.7z.003`, the old RAR
   * volumes `name.rar` + `name.r00`, `name.r01`..., and split ZIPs
   * `name.z01`, `name.z02`... + `name.zip`. The set name is what the parts
   * share, so parts from two different games never merge.
   */
  function partInfo(filename) {
    const name = String(filename || "").trim();
    let m = name.match(/^(.+)\.part0*(\d{1,4})\.rar$/i);
    if (m) return {set: m[1] + ".rar", part: Number(m[2]), scheme: "part"};
    m = name.match(/^(.+\.(?:7z|zip|rar|tar|iso|bin|nsp|xci))\.0*(\d{1,4})$/i);
    if (m && /\.\d{3,4}$/.test(name)) return {set: m[1], part: Number(m[2]), scheme: "split"};
    m = name.match(/^(.+)\.r(\d{2,3})$/i);
    if (m) return {set: m[1] + ".rar", part: Number(m[2]) + 2, scheme: "rar-volume"};
    m = name.match(/^(.+)\.z(\d{2,3})$/i);
    if (m) return {set: m[1] + ".zip", part: Number(m[2]), scheme: "zip-split"};
    return null;
  }

  /** A part number read from link text such as "Part 3" or "Pt.3", or 0. */
  function partFromLabel(label) {
    const m = String(label || "").match(/\bp(?:ar)?t\.?\s*0*(\d{1,4})\b/i);
    return m ? Number(m[1]) : 0;
  }

  /**
   * Describe one link: its host, whether it is direct, and its part.
   *
   * `filename` is what the page or URL calls the file; `label` is the link
   * text, which on release pages is often all there is ("Part 2").
   */
  function describe(urlStr, filename, label) {
    const host = fileHost(urlStr);
    const info = partInfo(filename) || null;
    const out = {
      host: host ? host.id : "",
      host_label: host ? host.label : "",
      kind: host && !isDirect(urlStr) ? "mirror" : "file",
      part: info ? info.part : partFromLabel(label),
      set: info ? info.set : ""
    };
    if (info && info.scheme === "rar-volume") out.scheme = info.scheme;
    return out;
  }

  /**
   * Group described links into sets, per host, with any missing part named.
   *
   * A plain `name.rar` whose `name.r00` sibling is present is part 1 of the
   * old volume scheme; a `name.zip` next to `name.z01` is that split's last
   * part. Links without a set name but with a part number (release pages
   * labelled "Part 1", "Part 2") are grouped per host.
   */
  function groupSets(links) {
    const rows = (links || []).map((link) => Object.assign({}, link));
    const volumeSets = new Set(rows.filter((r) => r.scheme === "rar-volume").map((r) => r.set));
    const zipSets = new Set(rows.filter((r) => /\.zip$/i.test(r.set || "") && r.part
                                         && /\.z\d{2,3}$/i.test(r.filename || "")).map((r) => r.set));
    for (const row of rows) {
      const name = String(row.filename || "");
      if (!row.set && volumeSets.has(name)) {
        row.set = name;
        row.part = 1;
      }
    }
    for (const row of rows) {
      const name = String(row.filename || "");
      if (!row.set && zipSets.has(name)) {
        const siblings = rows.filter((r) => r.set === name && r.part).map((r) => r.part);
        row.set = name;
        row.part = Math.max(0, ...siblings) + 1;
      }
    }
    const groups = new Map();
    for (const row of rows) {
      if (!row.part) continue;
      const setName = row.set || (row.host_label ? row.host_label + " parts" : "parts");
      const key = (row.host || "") + "\u0000" + setName.toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, {set: setName, host: row.host || "", host_label: row.host_label || "",
                         kind: row.kind || "file", parts: []});
      }
      const group = groups.get(key);
      if (row.kind === "mirror") group.kind = "mirror";
      if (!group.parts.some((p) => p.part === row.part)) group.parts.push(row);
    }
    const out = [];
    for (const group of groups.values()) {
      group.parts.sort((a, b) => a.part - b.part);
      const highest = group.parts.length ? group.parts[group.parts.length - 1].part : 0;
      const have = new Set(group.parts.map((p) => p.part));
      group.missing = [];
      for (let n = 1; n <= highest; n += 1) if (!have.has(n)) group.missing.push(n);
      group.complete = group.missing.length === 0;
      out.push(group);
    }
    return out.sort((a, b) => a.set.localeCompare(b.set) || a.host.localeCompare(b.host));
  }

  /**
   * Whether a tab opened from `openerUrl` to `targetUrl` is a pop-up to close.
   *
   * Only tabs spawned by a file host or release page are judged. A tab that
   * goes to a file host, or stays on the opener's own site, is kept: that is
   * the download itself, or the host's next step.
   */
  function isPopup(openerUrl, targetUrl) {
    if (!(fileHost(openerUrl) || isReleaseSite(openerUrl))) return false;
    const target = hostOf(targetUrl);
    if (!target || !/^https?:/i.test(String(targetUrl))) return false;
    if (fileHost(targetUrl) || isReleaseSite(targetUrl)) return false;
    const opener = hostOf(openerUrl);
    const site = (h) => h.split(".").slice(-2).join(".");
    return site(opener) !== site(target);
  }

  root.RomarrMirrors = {
    HOSTS, RELEASE_SITES, fileHost, isReleaseSite, isDirect, partInfo,
    partFromLabel, describe, groupSets, isPopup
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
