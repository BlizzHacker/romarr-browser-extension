/**
 * The vocabulary site adapters are written in.
 *
 * Adapters are data (see adapters.js). This file is the small interpreter
 * that data is written against: a handful of ways to pick a value out of a
 * page, and a handful of ways to clean it up. Adding a site should mean
 * writing a descriptor, not writing code -- so anything a new site needs that
 * is genuinely new belongs here, once, rather than in that site's adapter.
 *
 * Every picker reads the DOM of the page the user is looking at. Nothing here
 * fetches anything, and nothing here ever will: the extension's one honest
 * claim is that it only sees what the person browsing saw, and a fetch in
 * this file would quietly make that false.
 */

(function (root) {
  "use strict";

  /** Whitespace folded to single spaces, trimmed. */
  function clean(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  /**
   * Whether an element is actually shown.
   *
   * Load-bearing, not cosmetic. Vimm's listing rows each begin with
   * `<a href="/vault/999999" style="display:none">9</a>` -- a hidden anchor
   * pointing at a vault id that does not exist. The estate's previous crawler
   * followed it and put a game called "9" with id 999999 at the top of a
   * 23,980-row catalogue.
   *
   * Running in a real browser makes this cheap and exact: getComputedStyle
   * settles it, where a server-side scraper has to pattern-match the style
   * attribute and hope the trap keeps wearing the same disguise.
   */
  function visible(el) {
    if (!el || el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (!style) return true;
    return style.display !== "none" && style.visibility !== "hidden"
      && style.opacity !== "0";
  }

  /**
   * The value sitting next to a label, for pages that lay facts out as
   * `<th>File Size</th><td>1.2 MB</td>` or a definition list.
   *
   * Matched on the label's exact text once case and a trailing colon are
   * folded away -- not on a substring, because "Size" is inside "File Size"
   * and the two are different rows on the same page.
   */
  function labelled(scope, name) {
    const wanted = clean(name).toLowerCase().replace(/:$/, "");
    const nodes = scope.querySelectorAll("th, dt, b, strong, label, td");
    for (const node of nodes) {
      if (clean(node.textContent).toLowerCase().replace(/:$/, "") !== wanted) continue;
      const next = node.nextElementSibling;
      if (next) return clean(next.textContent);
    }
    return "";
  }

  /** "1.2 MB" -> bytes. Returns null rather than guessing at a unit. */
  function bytes(value) {
    const match = clean(value).match(/([\d.,]+)\s*(bytes|B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)\b/i);
    if (!match) return null;
    // Thousands separators only. A European "1,2 GB" would be misread as
    // 12 GB, so a comma followed by exactly two digits at the end is treated
    // as a decimal point instead of stripped.
    let digits = match[1];
    digits = /,\d{1,2}$/.test(digits) && !/\./.test(digits)
      ? digits.replace(",", ".") : digits.replace(/,/g, "");
    const size = Number(digits);
    if (!isFinite(size) || size <= 0) return null;
    const power = {b: 0, bytes: 0, kb: 1, kib: 1, mb: 2, mib: 2,
                   gb: 3, gib: 3, tb: 4, tib: 4}[match[2].toLowerCase()];
    return Math.round(size * Math.pow(1024, power));
  }

  /** A query parameter out of a URL, e.g. Vimm's `mediaId`. */
  function param(value, name, base) {
    try {
      return new URL(String(value), base || undefined).searchParams.get(name) || "";
    } catch (_) {
      return "";
    }
  }

  /** An absolute https URL, or "" -- never an http one, and never a guess. */
  function httpsUrl(value, base) {
    try {
      const url = new URL(String(value), base || undefined);
      return url.protocol === "https:" ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  /** The first run of digits, for ids embedded in a slug like `contra-388`. */
  function digits(value) {
    const found = clean(value).match(/\d+/);
    return found ? found[0] : "";
  }

  //: name -> how to pull a raw value out of a scope. A descriptor names one.
  const PICKERS = {
    /** textContent of the first match. */
    text(ctx, selector) {
      const el = ctx.scope.querySelector(selector);
      return el ? clean(el.textContent) : "";
    },
    /** An attribute of the first match: ["a.download", "href"]. */
    attr(ctx, spec) {
      const el = ctx.scope.querySelector(spec[0]);
      return el ? clean(el.getAttribute(spec[1])) : "";
    },
    /** Like `attr`, but skipping anything the page is hiding. See `visible`. */
    shownAttr(ctx, spec) {
      for (const el of ctx.scope.querySelectorAll(spec[0])) {
        if (visible(el)) return clean(el.getAttribute(spec[1]));
      }
      return "";
    },
    /** textContent of the first match the page is actually showing. */
    shownText(ctx, selector) {
      for (const el of ctx.scope.querySelectorAll(selector)) {
        if (visible(el)) return clean(el.textContent);
      }
      return "";
    },
    /** The value beside a `<th>`/`<dt>`/`<b>` label. */
    label(ctx, name) { return labelled(ctx.scope, name); },
    /** A capture group from the page-match regex, e.g. the id in the path. */
    group(ctx, index) { return clean((ctx.groups || [])[index]); },
    /** A `<meta property=...>` value. */
    meta(ctx, property) {
      const el = ctx.scope.querySelector
        && ctx.document.querySelector('meta[property="' + property + '"], meta[name="'
                                      + property + '"]');
      return el ? clean(el.getAttribute("content")) : "";
    },
    /** The value of a form's hidden input, by name. */
    input(ctx, name) {
      const el = ctx.scope.querySelector('input[name="' + name + '"]');
      return el ? clean(el.getAttribute("value") || el.value) : "";
    },
    /** A fixed value, for a page that states a fact only the adapter knows. */
    const_(ctx, value) { return clean(value); },
    /** The whole page title, last resort for a name. */
    title(ctx) { return clean(ctx.document.title); }
  };

  //: name -> how to clean a picked value up. Applied in order.
  const TRANSFORMS = {
    bytes: (value) => bytes(value),
    digits: (value) => digits(value),
    https: (value, arg, ctx) => httpsUrl(value, ctx.url),
    param: (value, name, ctx) => param(value, name, ctx.url),
    lower: (value) => clean(value).toLowerCase(),
    /** Everything before the first "|" or " - ", for `<title>`-derived names. */
    beforeSeparator: (value) => clean(String(value).split(/\s+[|–-]\s+/)[0]),
    /** A regex capture, written as [pattern, group]. */
    match: (value, spec) => {
      const found = String(value).match(new RegExp(spec[0]));
      return found ? clean(found[spec[1] == null ? 1 : spec[1]]) : "";
    }
  };

  /**
   * Resolve one field's list of candidate rules; the first that yields
   * something wins.
   *
   * Candidates rather than a single rule because pages are inconsistent with
   * themselves -- a title is in `<h1>` on most detail pages and only in
   * `<title>` on the ones that predate a redesign -- and an adapter that can
   * say "try this, then that" stays data instead of growing an if.
   */
  function field(rules, ctx) {
    for (const rule of [].concat(rules || [])) {
      const names = Object.keys(rule).filter((k) => k !== "then");
      if (!names.length) continue;
      const picker = PICKERS[names[0] === "const" ? "const_" : names[0]];
      if (!picker) continue;
      let value = picker(ctx, rule[names[0]]);
      for (const step of [].concat(rule.then || [])) {
        const name = typeof step === "string" ? step : step[0];
        const arg = typeof step === "string" ? undefined : step[1];
        const transform = TRANSFORMS[name];
        if (!transform) { value = ""; break; }
        value = transform(value, arg, ctx);
        if (value === null || value === undefined || value === "") break;
      }
      if (value !== null && value !== undefined && value !== "") return value;
    }
    return "";
  }

  /** Every field of one descriptor, against one scope. */
  function record(fields, ctx) {
    const out = {};
    for (const name of Object.keys(fields || {})) out[name] = field(fields[name], ctx);
    return out;
  }

  root.RomarrExtract = {
    clean, visible, labelled, bytes, param, httpsUrl, digits,
    field, record, PICKERS, TRANSFORMS
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
