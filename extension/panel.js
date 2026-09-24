/* ===========================================================================
   Marquee — content script.
   Runs on the streaming home page. Three jobs:
     1. find the rows the page is already showing (the honest "before")
     2. host the concierge, which is AgentCore, unchanged from the web build
     3. inject the row the concierge builds into the live page
   Job 1 is the fragile one, so nothing else depends on it succeeding.
   ========================================================================= */
(() => {
  "use strict";
  if (window.__marqueeLoaded) return;
  window.__marqueeLoaded = true;

  const A = globalThis.AgentCore;
  const byId = new Map(CATALOG.map(c => [c.id, c]));
  const state = { personaId: PROFILES[0].id, kidsMode: false, clarifyTurns: 0, rows: [], injected: null };
  const profile = () => PROFILES.find(p => p.id === state.personaId);

  // Kids mode is orthogonal to the household: any of the three can have a child
  // in the room. It is applied as a hard filter on the profile handed to the
  // agent, so it sits in retrieval and no phrasing in the request can widen it.
  // The households where a child could be watching. Kids mode is still not a
  // persona — round 18 stands — it is a toggle, shown where it can apply.
  const KIDS_PERSONAS = new Set(["movie-night"]);

  const effectiveProfile = () => state.kidsMode
    ? { ...profile(), hard_filters: A.KIDS_MODE }
    : profile();

  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = (paths, cls) => {
    const n = document.createElementNS(SVG_NS, "svg");
    n.setAttribute("viewBox", "0 0 24 24");
    n.setAttribute("fill", "none");
    n.setAttribute("stroke", "currentColor");
    n.setAttribute("stroke-width", "2");
    n.setAttribute("stroke-linecap", "round");
    n.setAttribute("stroke-linejoin", "round");
    n.setAttribute("aria-hidden", "true");
    if (cls) n.setAttribute("class", cls);
    for (const [tag, attrs] of paths) {
      const p = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
      n.appendChild(p);
    }
    return n;
  };

  // The concierge only belongs on the browsing surfaces. A title page, a player,
  // an account screen — all of those are somewhere the viewer has already decided,
  // so the button would just be clutter. Exact paths, not prefixes: /browse/movies
  // is a shelf to choose from, /browse/movies/<something> is a decision already made.
  const ALLOWED_PATHS = new Set([
    "/home",
    "/browse/originals",
    "/browse/movies",
    "/browse/series",
    "/browse/watchlist",
    // The brand tabs are shelves too, and the ones where the mismatch is widest:
    // the Hulu tab is where a viewer meets several thousand titles chosen for
    // nobody in particular.
    "/browse/disneyplus",
    "/browse/hulu",
  ]);

  const currentPath = () => {
    const p = location.pathname.replace(/\/+$/, "");
    return p === "" ? "/" : p;
  };
  // The allow-list describes Disney's routes, so it only means anything on a real
  // web page. The offline fixture is opened from a file:// URL, which has no routes
  // at all — gating it there would just hide the panel from its own smoke test.
  const onAllowedPage = () =>
    !/^https?:$/.test(location.protocol) || ALLOWED_PATHS.has(currentPath());

  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ----------------------------- 0. title -> Disney URL, harvested from the page

     A recommendation you cannot click is a screenshot. The catalogue has no
     Disney ids in it — nothing public maps a title to one — so the links come
     from the page itself: every tile on every browsing surface is an anchor
     whose aria-label starts with the title. Harvest those as she browses, keep
     them, and the injected row points at the real thing.                      */

  const LINK_KEY = "mq_links_v1";
  const LINK_CAP = 4000;
  const SEARCH_URL = "/browse/search?q=";
  // Narrower than TILE_HINT: a nav link to /browse/movies is a shelf, not a title,
  // and a Continue Watching tile links to /play/<id>, which resumes an episode
  // halfway through. A recommendation must open the title page and let her decide,
  // so only entity links are collected.
  const LINK_HINT = /\/(?:browse\/)?entity-/i;
  const linkIndex = new Map();      // normalised title -> path on the host
  let saveTimer = null;

  const normTitle = s => String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[‘’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  // Disney writes the whole tile into one label:
  //   "Cars 2 Rated G Released 2011. Comedy, Animation Select for details on this title."
  // and sometimes prefixes a badge: "New Episode Badge Dancing with the Stars ...".
  // The title is what is left once the badge and the metadata tail are cut off.
  const BADGE = /^(?:new\s+)?(?:episode|season|series|movie|content)?\s*badge\s+/i;
  const TAIL  = /\s+(?:Rated\s|Released\s|Season\s+\d|Episode\s+\d|Disney\+ Original\b|Select for details\b|\d+\s+(?:seconds?|minutes?|hours?)\s+remaining\b)/;
  // Continue Watching hangs a rating chip off its own anchor, so some labels are
  // nothing but "TV-PG". A certificate is not a title.
  const CERT_ONLY = /^(?:G|PG|PG-13|R|NC-17|NR|TV-Y|TV-Y7(?:-FV)?|TV-G|TV-PG|TV-14|TV-MA)$/i;


  function titleFromLabel(raw) {
    let t = String(raw || "").replace(/\s+/g, " ").trim().replace(BADGE, "");
    t = t.split(TAIL)[0].trim().replace(/[.,;:·\-–]+$/, "").trim();
    if (!t || t.length > 80) return null;
    // A label with no title in it is the hero's own button, not a tile.
    if (/^(select|details|play|watch)\b/i.test(t)) return null;
    if (CERT_ONLY.test(t)) return null;
    return t;
  }

  // Deliberately broad: any anchor that looks like it points at a title page.
  // Rows Marquee never detected still contribute links, and so does the search
  // page, which is the densest source of all.
  function harvestLinks(scope) {
    let added = 0;
    const roots = (scope || document).querySelectorAll('a[href]');
    for (const a of roots) {
      const href = a.getAttribute("href");
      if (!href || !LINK_HINT.test(href)) continue;
      if (a.closest(OWN)) continue;
      const label = a.getAttribute("aria-label")
        || a.querySelector("img[alt]")?.getAttribute("alt")
        || a.getAttribute("title") || "";
      const t = titleFromLabel(label);
      if (!t) continue;
      const key = normTitle(t);
      if (!key) continue;
      if (linkIndex.has(key)) continue;
      linkIndex.set(key, href);
      added++;
    }
    if (added) { saveLinks(); if (state.injected) relinkCards(); }
    return added;
  }

  function saveLinks() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const obj = {}; let n = 0;
        for (const [k, v] of linkIndex) { if (n++ >= LINK_CAP) break; obj[k] = v; }
        if (typeof chrome !== "undefined" && chrome.storage) chrome.storage.local.set({ [LINK_KEY]: obj });
      } catch (e) { /* storage is a convenience, never a dependency */ }
    }, 1500);
  }

  function loadLinks() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage) return;
      chrome.storage.local.get(LINK_KEY, o => {
        const saved = o && o[LINK_KEY];
        if (!saved) return;
        for (const [k, v] of Object.entries(saved)) if (!linkIndex.has(k)) linkIndex.set(k, v);
        if (state.injected) relinkCards();
      });
    } catch (e) { /* file:// fixture has no extension storage */ }
  }

  // Two kinds of link, and the card says which it got. A harvested path opens the
  // title page directly; otherwise the card hands the title to Disney's own search,
  // which is honest about what Marquee knows rather than guessing at a URL shape.
  function linkFor(item) {
    const direct = linkIndex.get(normTitle(item.title));
    return direct
      ? { href: direct, exact: true }
      : { href: SEARCH_URL + encodeURIComponent(item.title), exact: false };
  }

  function relinkCards() {
    if (!state.injected) return;
    for (const card of state.injected.querySelectorAll("a.mq-card[data-mq-id]")) {
      const item = byId.get(card.dataset.mqId);
      if (!item) continue;
      const link = linkFor(item);
      if (link.href !== card.getAttribute("href")) applyLink(card, item, link);
    }
  }

  function applyLink(card, item, link) {
    card.href = link.href;
    // A new tab on purpose: the injected row is the thing being demonstrated, and
    // following a link in place would tear it off the page mid-sentence.
    card.target = "_blank";
    card.rel = "noopener";
    card.dataset.mqExact = String(link.exact);
    card.title = link.exact
      ? `Open ${item.title} on Disney+`
      : `Marquee has no direct link for ${item.title} yet — this opens Disney+ search`;
  }

  // Disney's search page writes ?q= into the URL but does not read it back on a
  // cold load, so the fallback link would land on an empty search box. Marquee
  // finishes the handoff: type the query in the way the page's own code expects.
  let hydrated = null;
  function hydrateSearch() {
    if (!/^https?:$/.test(location.protocol)) return;
    if (currentPath() !== "/browse/search") return;
    const q = new URLSearchParams(location.search).get("q");
    if (!q || hydrated === q) return;
    hydrated = q;
    let tries = 0;
    const tick = () => {
      const box = document.querySelector('input[type="search"], [role="search"] input, input[name="q"]');
      if (box) {
        if (box.value === q) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(box, q); else box.value = q;
        box.dispatchEvent(new Event("input", { bubbles: true }));
        box.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      if (tries++ < 24) setTimeout(tick, 300);
    };
    tick();
  }

  /* ------------------------------------------------- 1. read the host page */

  // No Disney selectors are hardcoded. A carousel is recognised by its SHAPE:
  // a horizontally overflowing box holding several sibling tiles that link to
  // content. That survives a class-name change, which a selector would not.
  const TILE_HINT = /\/(browse|video|movies|series|entity|play)\//i;
  const OWN = ".mq-row, .mq-root, .mq-fab";

  // Page chrome is not content. A site header is a horizontal run of icon links
  // — the same shape as a content row — so shape alone cannot tell them apart.
  // These three signals can: it is inside a landmark, it is pinned to the
  // viewport, or it belongs to Marquee itself.
  function isChrome(node) {
    if (node.closest(OWN)) return true;
    if (node.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="toolbar"], [role="contentinfo"]')) return true;
    let n = node;
    for (let i = 0; i < 6 && n && n !== document.body; i++, n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === "fixed" || pos === "sticky") return true;
    }
    return false;
  }

  function looksLikeStrip(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (isChrome(node)) return false;
    const kids = Array.from(node.children);
    if (kids.length < 3 || kids.length > 60) return false;
    const r = node.getBoundingClientRect();
    if (r.width < 400 || r.height < 90 || r.height > 900) return false;

    // Content tiles are poster-sized. Navigation items are not, which is the
    // other half of telling a row apart from a header.
    let widest = 0, tallest = 0;
    for (const k of kids.slice(0, 5)) {
      const kr = k.getBoundingClientRect();
      widest = Math.max(widest, kr.width);
      tallest = Math.max(tallest, kr.height);
    }
    if (widest < 90 || tallest < 60) return false;

    const cs = getComputedStyle(node);
    const scrolls = /auto|scroll|hidden/.test(cs.overflowX) && node.scrollWidth > node.clientWidth + 40;
    const flexRow = /flex|grid/.test(cs.display) && !/column/.test(cs.flexDirection || "");
    if (!scrolls && !flexRow) return false;

    // the children have to look like tiles, not like paragraphs
    let tiles = 0;
    for (const k of kids.slice(0, 12)) {
      const a = k.matches?.("a") ? k : k.querySelector?.("a[href]");
      const img = k.querySelector?.("img, picture, video");
      if (img || (a && TILE_HINT.test(a.getAttribute("href") || ""))) tiles++;
    }
    return tiles >= 3;
  }

  // Returns { text, el } — the element matters as much as the string, because
  // it is the page's own row heading and therefore the thing to match type with.
  function titleFor(strip) {
    let node = strip;
    for (let depth = 0; depth < 5 && node; depth++) {
      let sib = node.previousElementSibling;
      while (sib) {
        const t = (sib.innerText || "").trim().split("\n")[0];
        if (t && t.length <= 70 && !strip.contains(sib)) return { text: t, el: sib };
        sib = sib.previousElementSibling;
      }
      const parent = node.parentElement;
      if (parent) {
        // Only a heading that actually PRECEDES this strip can be its title.
        // Without the document-order check, a strip with no heading of its own
        // adopts the first heading on the page — which is how the hero ended up
        // labelled with the first row's name.
        for (const h of parent.querySelectorAll("h1,h2,h3,h4,[role='heading']")) {
          if (strip.contains(h)) continue;
          if (!(h.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
          const t = (h.innerText || "").trim();
          if (t && t.length <= 70) return { text: t, el: h };
        }
      }
      node = parent;
    }
    return { text: null, el: null };
  }

  // The topmost carousel on a streaming home page is the hero, not a row: its
  // slides are full-bleed and it stands half a screen tall. Injecting above it
  // pushes the page's own headline off screen, so it is never the anchor.
  function isHeroish(strip) {
    const first = strip.firstElementChild;
    if (!first) return false;
    const slide = first.getBoundingClientRect();
    const box = strip.getBoundingClientRect();
    const vw = window.innerWidth || 1440, vh = window.innerHeight || 900;
    return slide.width > vw * 0.45 || box.height > vh * 0.5;
  }

  function tileNames(strip) {
    const out = [];
    for (const k of Array.from(strip.children).slice(0, 10)) {
      const img = k.querySelector?.("img[alt]");
      const a = k.querySelector?.("a[aria-label]") || (k.matches?.("a[aria-label]") ? k : null);
      const name = (img?.getAttribute("alt") || a?.getAttribute("aria-label") || k.innerText || "").trim().split("\n")[0];
      if (name && name.length < 90) out.push(name);
    }
    return out;
  }

  function scanPage() {
    const seen = new Set(), found = [];
    for (const node of document.querySelectorAll("div,ul,section")) {
      if (found.length >= 25) break;
      if (!looksLikeStrip(node)) continue;
      if (Array.from(seen).some(s => s.contains(node) || node.contains(s))) continue;
      seen.add(node);
      const t = titleFor(node);
      found.push({ el: node, title: t.text, titleEl: t.el, hero: isHeroish(node),
                   tiles: node.children.length, names: tileNames(node) });
    }
    found.sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top);
    state.rows = found;
    harvestLinks();
    return found;
  }

  /* --------------------------------------------- 2. inject a row in place */

  function toneVars(node, item) {
    const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
    const warm = item.warmth >= 3;
    const base = warm ? 8 + (item.warmth - 1) * 11 : 196 + (item.energy - 1) * 14;
    const drift = (hash(item.id) % 54) - 27;
    const sat = 42 + (hash(item.title) % 26);
    // CSSOM property writes, not a style attribute — the host page's CSP
    // blocks the second and permits the first.
    node.style.setProperty("--mq-angle", `${118 + item.energy * 14}deg`);
    node.style.setProperty("--mq-g1", `hsl(${base + drift} ${sat}% ${18 + item.warmth * 5}%)`);
    node.style.setProperty("--mq-g2", `hsl(${(base + drift + 34) % 360} ${sat - 12}% ${7 + item.energy * 2}%)`);
  }

  // Take the page's own type rather than guessing at it: the family from the
  // row heading it will sit beside, and that heading's size and weight for the
  // Marquee row's own title, so the two read as siblings.
  function matchTypography(row, target) {
    const src = target?.titleEl || document.body;
    const cs = getComputedStyle(src);
    const body = getComputedStyle(document.body);
    const family = cs.fontFamily || body.fontFamily;
    if (family) row.style.setProperty("--mq-font", family);
    if (target?.titleEl) {
      row.style.setProperty("--mq-title-size", cs.fontSize);
      row.style.setProperty("--mq-title-weight", cs.fontWeight);
      row.style.setProperty("--mq-title-spacing", cs.letterSpacing === "normal" ? "0" : cs.letterSpacing);
    }
  }

  // The element to insert before is the whole row BLOCK — heading included —
  // but not an ancestor that holds the rest of the page. Walk up only while the
  // ancestor still starts where this row starts and stays about its height;
  // closest("section") would happily return a wrapper containing every row.
  function rowBlock(anchor) {
    const a = anchor.getBoundingClientRect();
    let node = anchor, best = anchor;
    for (let i = 0; i < 4 && node.parentElement && node.parentElement !== document.body; i++) {
      node = node.parentElement;
      const r = node.getBoundingClientRect();
      if (a.top - r.top > 140) break;          // it reaches above this row's heading
      if (r.height > a.height * 2.2) break;    // it is taller than one row
      best = node;
    }
    return best;
  }

  function injectRow(name, results) {
    if (state.injected) { state.injected.remove(); state.injected = null; }
    const row = el("div", "mq-row");
    const head = el("div", "mq-row-head");
    head.appendChild(el("h3", null, name));
    head.appendChild(el("span", "note", "built by Marquee"));
    row.appendChild(head);

    const strip = el("div", "mq-strip");
    harvestLinks();
    for (const item of results) {
      const card = el("a", "mq-card");
      card.dataset.mqId = item.id;
      applyLink(card, item, linkFor(item));
      const art = el("div", "mq-art");
      toneVars(art, item);
      if (item.poster_url) {
        const img = el("img"); img.src = item.poster_url; img.alt = "";
        img.addEventListener("error", () => { img.remove(); art.appendChild(el("div", "mq-tt", item.title)); });
        art.appendChild(img);
      } else {
        art.appendChild(el("div", "mq-tt", item.title));
      }
      card.appendChild(art);
      const length = item.kind === "series"
        ? item.seasons + " season" + (item.seasons > 1 ? "s" : "")
        : item.runtime + " min";
      card.appendChild(el("div", "t", `${item.year} · ${length}`));
      card.appendChild(el("div", "w", item._why));
      strip.appendChild(card);
    }
    row.appendChild(strip);
    row.appendChild(el("div", "mq-flag", "Unofficial student concept · not affiliated with Disney"));

    // First real row, not the hero. Falls back to whatever was found if every
    // candidate looks heroish.
    const target = state.rows.find(r => !r.hero) || state.rows[0];
    const anchor = target?.el;
    const host = anchor ? rowBlock(anchor) : null;
    matchTypography(row, target);
    if (host && host.parentElement) {
      // Borrow the host page's own horizontal rhythm. A row that starts at a
      // different left edge than every other row reads as bolted on, however
      // good the contents are.
      const cs = getComputedStyle(host);
      row.style.setProperty("--mq-pad-l", cs.paddingLeft);
      row.style.setProperty("--mq-pad-r", cs.paddingRight);
      host.parentElement.insertBefore(row, host);
    } else {
      row.style.setProperty("--mq-pad-l", "40px");
      row.style.setProperty("--mq-pad-r", "40px");
      document.body.insertBefore(row, document.body.firstChild);
    }

    state.injected = row;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    return !!host;
  }

  /* ------------------------------------------------------- 3. the panel */

  let root, thread, consoleBody, input, fabEl;

  function build() {
    const fab = el("button", "mq-fab");
    fab.type = "button";
    fab.id = "mq-fab";
    fab.textContent = "✦ Ask Marquee";
    fab.addEventListener("click", () => open(true));
    document.body.appendChild(fab);
    fabEl = fab;

    root = el("aside", "mq-root");
    root.dataset.open = "false";

    const head = el("div", "mq-head");
    const titles = el("div");
    titles.appendChild(el("h3", null, "Marquee"));
    const sub = el("div", "mq-sub", profile().subtitle);
    sub.id = "mq-sub";
    titles.appendChild(sub);
    head.appendChild(titles);
    head.appendChild(el("div", "mq-spacer"));
    const badge = el("span", "mq-badge", "local mode");
    badge.id = "mq-badge";
    badge.title = "No model in this view. Retrieval, ranking and every guardrail run locally; re-ranking uses cached and deterministic order.";
    head.appendChild(badge);
    const modelBtn = el("button", "mq-model", "Load model");
    modelBtn.id = "mq-model";
    modelBtn.type = "button";
    modelBtn.title = "Download Llama-3.2-3B once and run it in this browser on WebGPU. Nothing is uploaded, and the agent works without it.";
    modelBtn.addEventListener("click", loadModel);
    head.appendChild(modelBtn);
    const x = el("button", "mq-x", "×");
    x.addEventListener("click", () => open(false));
    head.appendChild(x);
    root.appendChild(head);

    const personas = el("div", "mq-personas");
    personas.id = "mq-personas";
    root.appendChild(personas);

    const body = el("div", "mq-body");
    body.id = "mq-body";
    thread = el("div", "mq-thread");
    body.appendChild(thread);

    const con = el("div", "mq-console");
    const ch = el("button", "mq-console-head");
    ch.type = "button";
    ch.appendChild(el("span", "mq-label", "Agent trace"));
    ch.appendChild(el("span", "mq-spacer"));
    const count = el("span", "mq-label", "idle");
    count.id = "mq-count";
    ch.appendChild(count);
    con.appendChild(ch);
    consoleBody = el("div");
    ch.addEventListener("click", () => { consoleBody.hidden = !consoleBody.hidden; });
    con.appendChild(consoleBody);
    body.appendChild(con);
    root.appendChild(body);

    const form = el("form", "mq-foot");
    input = el("input");
    input.type = "text";
    input.id = "mq-ask";
    input.autocomplete = "off";
    input.placeholder = "a comforting 90-minute animated movie…";
    form.appendChild(input);
    const go = el("button", null, "Ask");
    go.type = "submit";
    form.appendChild(go);
    form.addEventListener("submit", e => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      input.value = "";
      ask(v);
    });
    root.appendChild(form);
    document.body.appendChild(root);

    if (typeof MarqueeLLM !== "undefined") {
      MarqueeLLM.onState(paintModel);
      paintModel(MarqueeLLM.current());
    }

    document.addEventListener("keydown", e => { if (e.key === "Escape") open(false); });
  }

  // The household a request is made in changes what the agent is allowed to
  // return, so switching it has to reset the conversation as well: a clarifying
  // turn or a refinement from the previous profile would carry the wrong rules.
  // Switching household or toggling kids mode changes the rules a request is
  // judged under, so anything said under the old rules has to go.
  function resetConversation() {
    state.clarifyTurns = 0;
    if (state.injected) { state.injected.remove(); state.injected = null; }
    thread.innerHTML = "";
    consoleBody.innerHTML = "";
    const c = document.getElementById("mq-count");
    if (c) c.textContent = "idle";
    const sub = document.getElementById("mq-sub");
    if (sub) sub.textContent = profile().subtitle;
    renderPersonas();
    greet();
  }

  function renderPersonas() {
    const box = document.getElementById("mq-personas");
    if (!box) return;
    box.innerHTML = "";
    for (const p of PROFILES) {
      const b = el("button", "mq-persona");
      b.type = "button";
      b.setAttribute("aria-pressed", String(p.id === state.personaId));
      const dot = el("span", "mq-dot");
      dot.style.setProperty("--h", p.avatar_hue);
      b.appendChild(dot);
      b.appendChild(el("span", null, p.display_name));
      b.addEventListener("click", () => {
        if (p.id === state.personaId) return;
        state.personaId = p.id;
        // Kids mode is offered where a child could plausibly be in the room, which
        // is movie night. Leaving it switched on but hidden after a persona change
        // would be a filter nobody can see — the worst kind to debug and the worst
        // kind to trust.
        const dropped = state.kidsMode && !KIDS_PERSONAS.has(p.id);
        state.kidsMode = state.kidsMode && KIDS_PERSONAS.has(p.id);
        resetConversation();
        if (dropped) {
          say("notice", "Kids watching is off: it only applies to " +
              "<b>Movie night</b>, the household that might have a child in the room.");
        }
      });
      box.appendChild(b);
    }

    const refresh = el("button", "mq-refresh");
    refresh.type = "button";
    refresh.id = "mq-refresh";
    refresh.setAttribute("aria-label", "Start over");
    refresh.title = "Start over \u2014 clears the conversation, removes the injected row and rescans the page";
    refresh.appendChild(svg([
      ["polyline", { points: "23 4 23 10 17 10" }],
      ["path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36L23 10" }],
    ], "mq-refresh-icon"));
    refresh.addEventListener("click", () => resetConversation());
    box.appendChild(refresh);

    // Only where it means something. "Just me" is one adult and "Date night" is
    // two; a child in the room makes it a movie night by definition. A control
    // that cannot change the answer is clutter, and a safety control that appears
    // to do nothing is worse than clutter.
    if (KIDS_PERSONAS.has(state.personaId)) {
      const kids = el("button", "mq-kids");
      kids.type = "button";
      kids.id = "mq-kids";
      kids.setAttribute("aria-pressed", String(state.kidsMode));
      kids.title = "Restrict everything to titles made for children. Applied before ranking; the request cannot widen it.";
      kids.appendChild(el("span", "mq-kids-dot"));
      kids.appendChild(el("span", null, "Kids watching"));
      kids.addEventListener("click", () => { state.kidsMode = !state.kidsMode; resetConversation(); });
      box.appendChild(kids);
    }
  }

  // Re-checked on every route change, because a single-page app can move between
  // a shelf and a title page without the extension reloading.
  function applyVisibility() {
    const ok = onAllowedPage();
    if (fabEl) fabEl.hidden = !ok;
    if (!ok && root && root.dataset.open === "true") open(false);
    return ok;
  }

  function open(o) {
    root.dataset.open = o ? "true" : "false";
    if (o) setTimeout(() => input.focus(), 260);
  }

  function say(kind, html, opts = {}) {
    const b = el("div", "mq-bubble " + kind + (opts.stop ? " stop" : ""));
    if (opts.lede) b.appendChild(el("span", "mq-lede", opts.lede));
    const d = el("div");
    d.innerHTML = html;
    b.appendChild(d);
    thread.appendChild(b);
    scroll();
    return b;
  }
  function scroll() { const b = document.getElementById("mq-body"); if (b) b.scrollTop = b.scrollHeight; }

  function chips(items, onPick, primaryFirst, awaiting) {
    const wrap = el("div", "mq-chips" + (awaiting ? " mq-awaiting" : ""));
    items.forEach((c, i) => {
      const b = el("button", "mq-chip" + (primaryFirst && i === 0 ? " primary" : ""), c.label);
      b.type = "button";
      b.addEventListener("click", () => { wrap.remove(); onPick(c); });
      wrap.appendChild(b);
    });
    thread.appendChild(wrap);
    scroll();
  }

  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  /* The model seam. When the on-device model is loaded it answers first; if it
     is off, fails or times out, the cached build-time parses stand in, and if
     there is no cached run either this returns null and agent.js proceeds on
     the deterministic parse alone. Nothing here can break a query. */
  const llm = {
    async parse(input) {
      if (typeof MarqueeLLM !== "undefined" && MarqueeLLM.ready()) {
        try {
          const live = await MarqueeLLM.adapter().parse(input);
          if (live) { state.lastParseBy = "on-device model"; return live; }
        } catch (e) { note("model parse failed — " + e.message); }
      }
      state.lastParseBy = "cached";
      return CACHED_RUNS[norm(input)]?.parse ?? null;
    },
    async rerank(input, req, list, meta) {
      if (typeof MarqueeLLM !== "undefined" && MarqueeLLM.ready()) {
        try {
          const order = await MarqueeLLM.adapter().rerank(input, req, list, meta);
          if (order && order.length) return order;
        } catch (e) { note("model re-rank failed — " + e.message); }
      }
      return (meta && meta.refined) ? null : (CACHED_RUNS[norm(input)]?.order ?? null);
    },
  };

  function note(msg) { try { console.info("[Marquee] " + msg); } catch (_) {} }

  /* ---------------------------------------------------------- model load */

  function badgeEl() { return document.getElementById("mq-badge"); }
  function modelBtnEl() { return document.getElementById("mq-model"); }

  function paintModel(st) {
    const b = badgeEl(), btn = modelBtnEl();
    if (!b) return;
    if (!st || st.phase === "off" || st.phase === "idle") {
      b.textContent = "local mode";
      b.title = "No model in this view. Retrieval, ranking and every guardrail run locally.";
      if (btn) { btn.textContent = "Load model"; btn.disabled = false; btn.hidden = false; }
      return;
    }
    if (st.phase === "loading") {
      const pct = Math.round((st.progress || 0) * 100);
      b.textContent = "loading " + pct + "%";
      b.title = st.text || "downloading the model";
      if (btn) { btn.textContent = "Loading…"; btn.disabled = true; }
      return;
    }
    if (st.phase === "ready") {
      b.textContent = "on-device model";
      b.title = MarqueeLLM.MODEL + " — running in this browser on WebGPU. Nothing leaves the machine; every field it returns is still validated against the catalogue.";
      if (btn) { btn.hidden = true; }
      return;
    }
    if (st.phase === "error") {
      b.textContent = "local mode";
      b.title = "The model did not load. " + (st.error || "reason unknown") + ". Everything else still works.";
      if (btn) { btn.textContent = "Retry model"; btn.disabled = false; btn.hidden = false; }
      if (state.modelErrorShown === st.error) return;
      state.modelErrorShown = st.error;
      say("notice", "The on-device model did not load: " + esc(st.error || "unknown") +
                    ". Marquee is running deterministically, which is the normal mode \u2014 nothing is broken.");
    }
  }

  async function loadModel() {
    if (typeof MarqueeLLM === "undefined") return;
    say("notice", "Downloading <b>" + esc(MarqueeLLM.MODEL) + "</b> \u2014 about 2.3\u00a0GB the first time, then it is cached in this browser. " +
                  "You can keep using Marquee while it loads; it stays deterministic until the model is ready.");
    try { await MarqueeLLM.load(); }
    catch (e) { paintModel({ phase: "error", error: e.message }); }
  }

  async function ask(text, opts = {}) {
    if (!opts.silent) say("user", esc(text));
    const t = say("agent", "<em>Working…</em>");
    const res = await A.run(text, {
      catalog: CATALOG, profile: effectiveProfile(), llm,
      clarifyTurns: state.clarifyTurns,
      priorRequest: opts.priorRequest || null,
      refinement: opts.refinement || null,
      count: 6,
    });
    t.remove();

    sayVocab(res);

    if (res.kind === "clarify") {
      state.clarifyTurns = res.clarifyTurns;
      say("agent", esc(res.question.question));
      chips(res.question.chips, c => ask(text, { silent: true, priorRequest: A.applyClarification(res.request, res.question.field, c.value) }), true);
      trace(res.trace); return;
    }
    state.clarifyTurns = 0;

    if (res.kind === "out_of_scope" || res.kind === "empty") {
      say("agent", esc(res.message), { lede: res.kind === "empty" ? "no match" : "outside my job", stop: true });
      trace(res.trace); return;
    }
    if (res.blocked) say("notice", esc(res.blocked.message), { lede: "blocked by a household rule", stop: true });
    else if (res.headline) say("notice", esc(res.headline), { lede: res.pivoted ? "not what you asked for" : "loosened" });

    const wrap = say("agent", "");
    const list = el("div", "mq-picks");
    for (const item of res.results) {
      const p = el("div", "mq-pick");
      const th = el("div", "mq-thumb");
      toneVars(th, item);
      if (item.poster_url) { const i = el("img"); i.src = item.poster_url; i.alt = ""; th.appendChild(i); }
      const m = el("div");
      m.appendChild(el("div", "t", item.title));
      m.appendChild(el("div", "m", `${item.year} · ${item.certification}`));
      m.appendChild(el("div", "w", item._why));
      p.appendChild(th); p.appendChild(m);
      list.appendChild(p);
    }
    wrap.querySelector("div").appendChild(list);

    chips([
      { label: "Put this on the page", value: "__inject__" },
      { label: "Shorter", value: "shorter" },
      { label: "Lighter", value: "lighter" },
      { label: "More intense", value: "heavier" },
    ], c => {
      if (c.value === "__inject__") {
        const placed = injectRow(res.playlistName, res.results);
        say("agent", placed
          ? `Added <b>${esc(res.playlistName)}</b> above the first row on this page.`
          : `Added <b>${esc(res.playlistName)}</b>, but I could not find a row to sit above, so it went to the top of the document.`);
        open(false);
        return;
      }
      say("user", esc(c.value[0].toUpperCase() + c.value.slice(1)));
      ask(text, { silent: true, priorRequest: res.request, refinement: c.value });
    }, true);

    trace(res.trace);
  }

  // For the times someone opens the panel with nothing in mind. The questions
  // differ by household — asking a solo viewer whether anyone in the group minds
  // subtitles is noise — and every answer is a fragment of plain English, so the
  // quiz composes exactly the kind of sentence a person would have typed. It gets
  // no private path through the agent.
  function quizQuestions() {
    const tail = state.kidsMode
      ? (QUIZ.kids_mode || [])
      : (QUIZ.by_persona && QUIZ.by_persona[state.personaId]) || [];
    return [...(QUIZ.shared || []), ...tail];
  }

  // A chip can depend on an earlier answer. Offering "documentary" to someone who
  // just said "animated", or "just a few minutes" when every short in the
  // catalogue is animated, is the interface promising something the data cannot
  // deliver — the same defect as a question with no answer behind it.
  function allowedChip(chip, answers) {
    if (!chip.requires) return true;
    return Object.entries(chip.requires).every(([id, values]) => {
      const given = answers.find(a => a.id === id);
      return given ? values.includes(given.value) : true;
    });
  }

  function runQuiz(step, answers) {
    const qs = quizQuestions();
    if (step >= qs.length) {
      const composed = answers.map(a => a.value).filter(Boolean).join(", ");
      if (!composed) {
        say("agent", "Nothing narrowed down, so I will just go on what this profile usually likes.");
        ask("something to watch", { silent: true });
      } else {
        say("user", esc(composed));
        ask(composed, { silent: true });
      }
      return;
    }
    const q = qs[step];
    const options = q.chips.filter(c => allowedChip(c, answers));
    // Every chip ruled out means the question no longer applies. Skip it rather
    // than showing an empty row.
    if (!options.length) { runQuiz(step + 1, answers); return; }
    say("agent", esc(q.q));
    chips(options.map(c => ({ label: c.label, value: c.value })), c => {
      say("user", esc(c.label));
      runQuiz(step + 1, [...answers, { id: q.id, value: c.value }]);
    });
  }

  // Words the lexicons could not account for. Saying this is the whole point:
  // dropping a constraint silently is what makes an answer feel broken.
  function sayVocab(res) {
    const read = res.readLiterally || [], lost = res.notUnderstood || [],
          byModel = res.readByModel || [];
    if (!read.length && !lost.length && !byModel.length) return;
    const q = w => "\u201c" + esc(w) + "\u201d";
    const bits = [];
    if (byModel.length) {
      bits.push(`My own lexicon has no entry for ${byModel.map(q).join(" or ")} \u2014 ` +
                `the on-device model read ${byModel.length > 1 ? "them" : "it"} and I used what it returned.`);
    }
    if (read.length) {
      bits.push(`I have no category for ${read.map(q).join(" or ")}, so I searched every description for ` +
                (read.length > 1 ? "them" : "it") + ".");
    }
    if (lost.length) {
      bits.push(`Nothing in my data mentions ${lost.map(q).join(" or ")}, so ` +
                (lost.length > 1 ? "those went" : "that went") + " unused.");
    }
    say("notice", bits.join(" "), {
      lede: byModel.length && !lost.length ? "the model filled a gap" : "outside my vocabulary",
      stop: !read.length && !byModel.length,
    });
  }

  function trace(steps) {
    consoleBody.innerHTML = "";
    for (const s of steps) {
      const row = el("div", "mq-step");
      row.dataset.status = s.status;
      const n = el("div", "name", s.step);
      n.appendChild(el("span", "bar"));
      row.appendChild(n);
      const d = el("div", "detail");
      const v = s.detail;
      d.innerHTML = v == null ? esc(s.status)
        : typeof v === "string" ? esc(v)
        : Object.entries(v).filter(([, x]) => x != null && !(Array.isArray(x) && !x.length))
            .map(([k, x]) => `<span class="mq-kv"><span>${esc(k)}</span> ${Array.isArray(x) ? esc(x.join(", "))
              : typeof x === "object" ? esc(JSON.stringify(x).replace(/[{}"]/g, "").replace(/,/g, ", "))
              : "<b>" + esc(String(x)) + "</b>"}</span>`).join("");
      row.appendChild(d);
      consoleBody.appendChild(row);
    }
    const c = document.getElementById("mq-count");
    if (c) c.textContent = `${steps.length} steps`;
    consoleBody.hidden = false;
    requestAnimationFrame(scroll);
  }

  /* ------------------------------------------------------------- startup */

  function reportScan() {
    const rows = scanPage();
    const box = el("div", "mq-scan");
    if (!rows.length) {
      box.appendChild(el("h4", null, "I could not find any rows on this page."));
      const p = el("p", "miss", "The concierge still works — it just cannot show you what the page was already offering. Press Rescan once the page has finished loading.");
      box.appendChild(p);
    } else {
      box.appendChild(el("h4", null, `What this page is showing you right now (${rows.length} rows)`));
      const ol = el("ol");
      for (const r of rows.slice(0, 10)) {
        ol.appendChild(el("li", null, `${r.title || "(untitled row)"} — ${r.tiles} tiles`));
      }
      box.appendChild(ol);
    }
    thread.appendChild(box);
    chips([
      { label: "Rescan the page", value: "__rescan__" },
      { label: "Copy diagnostics", value: "__diag__" },
    ], c => {
      if (c.value === "__rescan__") { reportScan(); return; }
      const diag = {
        url: location.href, ranAt: new Date().toISOString(),
        rows: state.rows.map(r => ({ title: r.title, tiles: r.tiles, names: r.names.slice(0, 4),
                                     tag: r.el.tagName, cls: (r.el.className || "").slice(0, 120) })),
        sample: document.body.innerHTML.length,
      };
      navigator.clipboard.writeText(JSON.stringify(diag, null, 1))
        .then(() => say("agent", "Diagnostics copied to your clipboard — paste them to me and I will fix the scan."))
        .catch(() => say("agent", "Clipboard was blocked. Open the console and run <b>copy(window.__marqueeDiag())</b> instead."));
    });
    scroll();
  }

  window.__marqueeDiag = () => JSON.stringify({
    url: location.href,
    path: currentPath(),
    onAllowedPage: onAllowedPage(),
    links: linkIndex.size,
    linkSample: Array.from(linkIndex).slice(0, 5),
    rows: scanPage().map(r => ({ title: r.title, tiles: r.tiles, names: r.names.slice(0, 4),
                                 tag: r.el.tagName, cls: (r.el.className || "").slice(0, 120) })),
  }, null, 1);

  function greet() {
    say("agent",
      "Tell me what you are in the mood for, and I will look through the catalogue and put the answer on this page as a row." +
      (state.kidsMode
        ? " <b>Kids watching is on</b>, so everything is restricted to titles actually made for children \u2014 not merely rated PG. That filter runs before ranking, and I cannot talk myself out of it."
        : " You can also just ask for something kid-friendly and I will apply it to that one request."),
      { lede: "concierge" });
    chips([
      { label: "Help me decide", value: "__quiz__" },
      { label: "I'll describe it", value: "__type__" },
    ], c => {
      if (c.value === "__quiz__") { say("user", "Help me decide"); runQuiz(0, []); }
      else { say("agent", "Go ahead \u2014 a plain sentence works better than keywords."); input.focus(); }
    }, false, true);
    reportScan();
  }

  function boot() {
    loadLinks();
    hydrateSearch();
    build();
    renderPersonas();
    greet();
    applyVisibility();

    // The host is a single-page app: when it swaps views, the rows change and so
    // does the path. History is patched by the page in its own JS world, which a
    // content script cannot intercept, so the DOM churn is the reliable signal.
    let t = null;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { applyVisibility(); hydrateSearch(); scanPage(); }, 900);
    }).observe(document.body, { childList: true, subtree: true });

    window.addEventListener("popstate", applyVisibility);
    window.addEventListener("hashchange", applyVisibility);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
