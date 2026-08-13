/**
 * A local metadata catalogue built only from pages the operator opened.
 *
 * This deliberately stores no download or play URL. Old v0.2.6 exports can
 * be imported, but their action URLs are discarded; Vimm actions are trusted
 * only when reconstructed from the live page that currently displays them.
 */
(function (root) {
  "use strict";

  const clean = (value, max = 1000) =>
    String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);

  function pageUrl(source, id, raw) {
    if (source === "vimm" && /^\d+$/.test(id)) {
      return "https://vimm.net/vault/" + id;
    }
    try {
      const url = new URL(String(raw || ""));
      if (url.protocol !== "https:") return "";
      const adapter = root.RomarrAdapters.forHost(url.hostname);
      if (!adapter || adapter.source !== source) return "";
      url.hash = "";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function normalize(source, candidate) {
    const row = candidate || {};
    const actualSource = clean(source || row.source || (row.vault_id ? "vimm" : ""), 32);
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(actualSource)) return null;
    const id = clean(row.id || row.vault_id, 300);
    const title = clean(row.title || row.name, 500);
    const url = pageUrl(actualSource, id, row.url || row.page_url);
    if (!id || !title || !url) return null;
    const size = Number(row.size == null ? row.size_bytes : row.size);
    return {
      source: actualSource,
      id,
      title,
      platform: clean(row.platform, 160),
      region: clean(row.region, 160),
      version: clean(row.version, 160),
      name: clean(row.name || row.filename, 500),
      size: Number.isSafeInteger(size) && size > 0 ? size : null,
      url,
      media_id: /^\d+$/.test(clean(row.media_id, 40)) ? clean(row.media_id, 40) : "",
      captured_at: clean(row.captured_at, 40) || new Date().toISOString()
    };
  }

  const key = (row) => row.source + ":" + row.id;

  function merge(current, source, candidates, limit = 500000) {
    const map = new Map((current || []).map((row) => [key(row), row]));
    for (const candidate of (Array.isArray(candidates) ? candidates : [])) {
      const row = normalize(source, candidate);
      if (!row) continue;
      const old = map.get(key(row)) || {};
      map.set(key(row), Object.assign({}, old, row, {
        platform: row.platform || old.platform || "",
        region: row.region || old.region || "",
        version: row.version || old.version || "",
        name: row.name || old.name || "",
        size: row.size || old.size || null,
        media_id: row.media_id || old.media_id || ""
      }));
      if (map.size >= limit) break;
    }
    return Array.from(map.values()).sort((a, b) =>
      a.title.localeCompare(b.title) || key(a).localeCompare(key(b)));
  }

  function search(rows, query, limit = 20) {
    const terms = clean(query).toLowerCase().split(/\s+/).filter(Boolean);
    return (rows || []).filter((row) => terms.every((term) =>
      `${row.title} ${row.platform} ${row.region} ${row.source} ${row.id}`
        .toLowerCase().includes(term)))
      .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
  }

  /**
   * Flatten The ROM Depot's complete `/api/getContents` directory tree.
   *
   * The endpoint downloads one object with `path`, `name`, `children`,
   * `mtime`, `size`, and `type`. A file's containing folders become its
   * platform/region/version metadata and its URL points to the browse
   * directory. No `/api/download` action is manufactured or stored.
   */
  function fromTheRomDepotTree(root, limit = 500000) {
    if (!root || typeof root !== "object") return [];
    const rows = [];
    const stack = [{node: root, folders: [], isRoot: true}];
    const encodedPath = (parts) => parts.map((part) =>
      encodeURIComponent(part).replace(/%2F/gi, "%252F")).join("/");
    while (stack.length && rows.length < limit) {
      const entry = stack.pop();
      const node = entry.node || {};
      const name = clean(node.name, 1000);
      const children = Array.isArray(node.children) ? node.children : [];
      const isFile = clean(node.type, 20).toLowerCase() === "file"
        || (!children.length && Number(node.size) > 0);
      if (isFile && name) {
        const folders = entry.folders;
        const rawPath = clean(node.path, 2000)
          .replace(/^\.\/?files\/?/i, "").replace(/^\/+/, "");
        const relative = rawPath || folders.concat([name]).join("/");
        const size = Number(node.size);
        rows.push({
          source: "theromdepot",
          id: relative,
          title: name,
          platform: folders[0] || "",
          region: folders[1] || "",
          version: folders.slice(2).join(" / "),
          name,
          size: Number.isSafeInteger(size) && size > 0 ? size : null,
          url: "https://theromdepot.com/" + encodedPath(folders),
          captured_at: clean(node.mtime, 40) || new Date().toISOString()
        });
        continue;
      }
      const folders = entry.isRoot || !name
        ? entry.folders : entry.folders.concat([name]);
      for (let index = children.length - 1; index >= 0; index--) {
        stack.push({node: children[index], folders, isRoot: false});
      }
    }
    return rows;
  }

  root.RomarrCatalog = {normalize, merge, search, key, fromTheRomDepotTree};
})(typeof globalThis !== "undefined" ? globalThis : self);
