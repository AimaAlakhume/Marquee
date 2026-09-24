/* Marquee — the on-device model adapter.
 *
 * This is the whole seam between a language model and the agent. agent.js has
 * always accepted an optional `llm` with a `parse` and a `rerank` hook and falls
 * back to the deterministic core whenever either one returns nothing; this file
 * is the first thing to fill that slot.
 *
 * Two rules hold here, and they are the reason a model is safe to add at all:
 *
 *   1. The model can only ADD. mergeParse in agent.js writes a scalar field only
 *      where the deterministic parse left a gap, and unions the tag lists. It
 *      never overwrites a filter the sentence already established.
 *   2. The model cannot say who is watching. `company` is not in the schema and
 *      is stripped if it appears anyway, so no model output can turn off the
 *      certificate cap or the age band. Kid safety stays where it was: inside
 *      retrieval, unreachable from prompt text.
 *
 * Everything the model returns is checked against the catalogue's own
 * vocabulary before agent.js sees it. A genre that does not exist, a tag nobody
 * wrote, a runtime of 4,000 minutes — all dropped here, silently.
 */
const MarqueeLLM = (() => {
  "use strict";

  const MODEL = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

  const GENRES = ["Action","Adventure","Animation","Anime","Anthology","Comedy","Competition",
    "Crime","Documentary","Drama","Family","Fantasy","History","Horror","Music","Musical",
    "Mystery","Nature","Reality","Romance","Sci-Fi","Soap","Superhero","TV Movie","Thriller","War"];

  /* Shown to the model as examples. Anything it returns is validated against the
     catalogue's full tag set at runtime, so a real tag outside this list is kept. */
  const TAG_HINTS = ["comfort-watch","gentle","soothing","cozy-mystery","cozy-action","warm",
    "tender","quiet","low-stakes","uplifting","hopeful","joyful","upbeat","whimsical","witty",
    "absurd","nostalgic","epic","spectacle","mythic","tense","nail-biting","dread","grim","bleak",
    "downbeat","melancholy","tearjerker","slow-burn","cerebral","psychological","surreal",
    "underdog","found-family","coming-of-age","romance","rom-com","true-story","period",
    "short-runtime","very-long","subtitled","bingeable","rewatchable","stylized"];

  let tagSet = null;
  function tags() {
    if (tagSet) return tagSet;
    tagSet = new Set();
    try {
      for (const item of (typeof CATALOG !== "undefined" ? CATALOG : []))
        for (const t of (item.tone_tags || [])) tagSet.add(t);
    } catch (_) {}
    return tagSet;
  }

  const genreByLower = new Map(GENRES.map(g => [g.toLowerCase(), g]));

  /* ----------------------------------------------------------- transport */

  const listeners = new Set();
  let state = { phase: "off", progress: 0, text: "", error: null };

  /* Outside an extension context (the offline fixture, the test harness) there
     is no chrome.runtime. The adapter still loads and simply never becomes
     ready, which is the same as the model being switched off. */
  const HAS_RUNTIME = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.sendMessage);

  if (HAS_RUNTIME && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(msg => {
      if (!msg || msg.mq !== "llm-event") return;
      if (msg.event === "state" && msg.state) {
        state = msg.state;
        listeners.forEach(fn => { try { fn(state); } catch (_) {} });
      }
    });
  }

  function send(op, payload) {
    if (!HAS_RUNTIME) return Promise.reject(new Error("no extension runtime in this context"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error("the model host did not answer")); }
      }, op === "load" ? 30000 : 60000);
      chrome.runtime.sendMessage({ mq: "llm", op, ...payload }, reply => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!reply || reply.ok === false) return reject(new Error((reply && reply.error) || "model unavailable"));
        resolve(reply);
      });
    });
  }

  /* ------------------------------------------------------------ prompts */

  const PARSE_SYSTEM = [
    "You turn one sentence about what someone wants to watch into JSON.",
    "",
    "Return only JSON. Use the fields you are sure about and leave the rest empty:",
    "0 for a number you were not told, [] for a list you were not told.",
    "",
    "Never invent a genre that is not in this list:",
    GENRES.join(", "),
    "",
    "want_tags and avoid_tags are moods and textures, lowercase and hyphenated.",
    "Prefer these where they fit: " + TAG_HINTS.join(", "),
    "",
    "energy and warmth run 1 to 5. energy 1 is still and slow, 5 is loud and fast.",
    "warmth 1 is cold and bleak, 5 is tender and kind.",
    "energy_max is a ceiling, energy_target is an aim. Use one, not both.",
    "runtime_max is in minutes. year_min is a four-digit year.",
    "format is exactly one of movie, series, short, or an empty string.",
    "",
    "resolved_terms: list any word from the sentence that you turned into a genre",
    "or a tag above. Use the word exactly as it was typed. If you used none, [].",
    "",
    "Do not guess who is watching. Do not comment. JSON only.",
  ].join("\n");

  const PARSE_SCHEMA = {
    type: "object",
    properties: {
      format:        { type: "string" },
      runtime_max:   { type: "integer" },
      year_min:      { type: "integer" },
      energy_target: { type: "integer" },
      energy_max:    { type: "integer" },
      warmth_target: { type: "integer" },
      genres:        { type: "array", items: { type: "string" } },
      want_tags:     { type: "array", items: { type: "string" } },
      avoid_tags:    { type: "array", items: { type: "string" } },
      resolved_terms:{ type: "array", items: { type: "string" } },
      confidence:    { type: "number" },
    },
    required: ["format","runtime_max","year_min","energy_target","energy_max",
               "warmth_target","genres","want_tags","avoid_tags","resolved_terms","confidence"],
    additionalProperties: false,
  };

  const RERANK_SYSTEM = [
    "You are given a request and a shortlist that has already been filtered.",
    "Return the ids in a better order for that request, best first.",
    "Return only ids from the list. Do not add, invent or explain anything.",
  ].join("\n");

  const RERANK_SCHEMA = {
    type: "object",
    properties: { ids: { type: "array", items: { type: "string" } } },
    required: ["ids"],
    additionalProperties: false,
  };

  /* --------------------------------------------------------- validation */

  const int = (v, lo, hi) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };

  function cleanParse(raw) {
    let o;
    try { o = JSON.parse(raw); } catch (_) { return null; }
    if (!o || typeof o !== "object") return null;

    const out = {};
    if (["movie", "series", "short"].includes(o.format)) out.format = o.format;

    const rt = int(o.runtime_max, 1, 600);           if (rt != null) out.runtime_max = rt;
    const yr = int(o.year_min, 1900, 2100);          if (yr != null) out.year_min = yr;
    const et = int(o.energy_target, 1, 5);           if (et != null) out.energy_target = et;
    const em = int(o.energy_max, 1, 5);              if (em != null) out.energy_max = em;
    const wt = int(o.warmth_target, 1, 5);           if (wt != null) out.warmth_target = wt;

    const known = tags();
    const listOf = (v, keep) => Array.isArray(v)
      ? [...new Set(v.map(x => String(x || "").trim()).filter(Boolean).map(keep).filter(Boolean))]
      : [];

    out.genres     = listOf(o.genres, g => genreByLower.get(g.toLowerCase()) || null);
    out.want_tags  = listOf(o.want_tags,  t => known.has(t.toLowerCase()) ? t.toLowerCase() : null);
    out.avoid_tags = listOf(o.avoid_tags, t => known.has(t.toLowerCase()) ? t.toLowerCase() : null);

    /* Words the model says it used. agent.js checks these against the sentence
       before they are allowed to silence anything. */
    out.resolved_terms = Array.isArray(o.resolved_terms)
      ? [...new Set(o.resolved_terms.map(x => String(x || "").trim().toLowerCase()).filter(Boolean))]
      : [];

    const c = Number(o.confidence);
    out.confidence = Number.isFinite(c) && c >= 0 && c <= 1 ? c : 0.5;

    /* `company` decides kid safety. The model is never allowed a say in it. */
    delete out.company;
    delete out.age_band;
    delete out.hard_filters;

    const contributed = out.format || out.runtime_max || out.year_min ||
      out.energy_target || out.energy_max || out.warmth_target ||
      out.genres.length || out.want_tags.length || out.avoid_tags.length;

    return contributed ? out : null;
  }

  /* -------------------------------------------------------------- public */

  async function load() {
    if (!HAS_RUNTIME) {
      state = { phase: "error", progress: 0, text: "", error: "not running as an extension" };
      listeners.forEach(fn => { try { fn(state); } catch (_) {} });
      return state;
    }
    state = { phase: "loading", progress: 0, text: "starting", error: null };
    listeners.forEach(fn => { try { fn(state); } catch (_) {} });
    const started = await send("load", { model: MODEL });
    poll();
    return started;
  }

  /* Events can be missed if the service worker is restarted mid-download. The
     offscreen document is the one that actually knows, so ask it periodically
     until it is no longer loading. */
  let polling = null;
  function poll() {
    if (polling) return;
    polling = setInterval(async () => {
      try {
        const r = await send("status", {});
        if (r && r.state) {
          state = r.state;
          listeners.forEach(fn => { try { fn(state); } catch (_) {} });
          if (state.phase !== "loading") { clearInterval(polling); polling = null; }
        }
      } catch (_) { /* a restarting worker is not an error worth showing */ }
    }, 3000);
  }

  function onState(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function current() { return state; }
  function ready() { return state.phase === "ready"; }

  function adapter() {
    return {
      async parse(input) {
        const r = await send("chat", { args: {
          system: PARSE_SYSTEM,
          user: input,
          schema: PARSE_SCHEMA,
          maxTokens: 360,
        }});
        return cleanParse(r.content);
      },

      async rerank(input, req, candidates) {
        const lines = candidates.map(c =>
          `${c.id} · ${c.title} · energy ${c.energy} · warmth ${c.warmth} · ${(c.tone_tags || []).slice(0, 6).join(", ")}`
        ).join("\n");
        const r = await send("chat", { args: {
          system: RERANK_SYSTEM,
          user: `Request: ${input}\n\nShortlist:\n${lines}`,
          schema: RERANK_SCHEMA,
          maxTokens: 400,
        }});
        let o; try { o = JSON.parse(r.content); } catch (_) { return null; }
        return Array.isArray(o && o.ids) ? o.ids.map(String) : null;
      },
    };
  }

  return { MODEL, load, onState, current, ready, adapter };
})();
