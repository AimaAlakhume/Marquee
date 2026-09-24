/* ============================================================================
 * Marquee — agent core
 *
 * One file, no DOM, no network. The extension and the eval harness both import
 * this, so what you see demoed on stage is byte-for-byte what the eval numbers
 * were measured against.
 *
 * No model runs here. `run()` accepts an optional `llm` adapter with a `parse`
 * and a `rerank` hook and falls back to the deterministic path whenever it
 * returns nothing — which, in the shipped extension, is always: the adapter
 * only reads four answers frozen into data/cached_runs.json at build time.
 *
 * The loop:
 *   1 PARSE     free text            -> structured request
 *   2 CLARIFY   decision point       -> ask one question, or proceed
 *   3 RETRIEVE  tool call            -> deterministic filter over the catalog
 *   4 RANK      hybrid               -> deterministic score, optional LLM re-rank
 *   5 VALIDATE  guardrail            -> every id must exist; drop and retry otherwise
 *   6 EXPLAIN   grounded rationale   -> cites the profile and the constraints
 *   7 REFINE    revision loop        -> re-enter at 3 with amended constraints
 *
 * Every step appends to `trace`, which is what the debug panel renders.
 * ==========================================================================*/

const AgentCore = (() => {
  "use strict";

  /* ---------------------------------------------------------------- config */

  const MAX_CLARIFY_TURNS = 2;
  const MAX_VALIDATE_RETRIES = 2;
  const DEFAULT_RESULT_COUNT = 6;

  // Ranked order in which constraints are surrendered when nothing matches.
  // Published deliberately: the user is always told what was given up.
  const RELAXATION_LADDER = [
    { key: "runtime_max",  label: "runtime limit",      apply: r => ({ ...r, runtime_max: r.runtime_max ? Math.round(r.runtime_max * 1.35) : null }) },
    { key: "year_min",     label: "how recent it is",   apply: r => ({ ...r, year_min: null }) },
    { key: "format",       label: "movie-vs-series",    apply: r => ({ ...r, format: null }) },
    { key: "genre_mode",   label: "matching every genre at once",
      apply: r => (r.genre_mode === "all" ? { ...r, genre_mode: "any" } : r) },
    { key: "genres",       label: "the exact genre",    apply: r => ({ ...r, genres: [], genre_adjacent: r.genres }) },
    { key: "text_terms",   label: "the words I searched the descriptions for",
      apply: r => ({ ...r, text_terms: [] }) },
  ];

  // Child-appropriateness is a mode any household can switch on, and a request
  // can switch on for itself ("kid-friendly detective shows"). Keeping it inside
  // one persona meant losing it the moment someone picked a different persona.
  const KIDS_MODE = {
    kid_safe_only: true,
    allowed_certifications: ["G", "TV-G", "TV-Y", "TV-Y7", "TV-PG", "PG"],
    runtime_max: 130,
    reason: "Kids mode is on. This filter runs before ranking and cannot be overridden by the request text.",
  };

  // "Kids mode" is one switch for a room that might hold a three-year-old or a
  // twelve-year-old, and those are not the same filter. The age answer sets an
  // explicit certificate allow-list — PG is parental guidance, which is not a
  // thing you hand to a four-year-old.
  // Round 13. Two changes, both from one report: Gargoyles came back for a
  // five-to-eight-year-old.
  //
  // TV-PG left the 5-to-8 band. "Parental guidance" is not a rating you hand to
  // a five-year-old unattended, and it was in the list only because the band
  // above it needed it.
  //
  // `avoid_tags` is new, and it is the part that actually fixed the report.
  // Gargoyles is rated TV-Y7, so no certificate rule was ever going to catch it:
  // the rating says seven and up and the programme is a dark action series. The
  // certificate is a legal classification; the tone layer is the only thing in
  // this data that describes what watching it is like. So the band now carries
  // an intensity ceiling as well as a rating ceiling, and both sit inside
  // retrieval, off the relaxation ladder, where prompt text cannot reach them.
  const AGE_TENSION = ["tense", "nail-biting", "dread", "grim", "bleak", "brutal",
                       "unsettling", "anxiety-inducing", "uneasy", "body-horror",
                       "serial-killer", "paranoid-thriller", "war-film"];
  const AGE_BANDS = {
    preschool: { label: "under 5", runtime_max: 90,
                 certs: ["TV-Y", "TV-G", "G"],
                 avoid_tags: AGE_TENSION },
    young:     { label: "5 to 8", runtime_max: 110,
                 certs: ["TV-Y", "TV-G", "G", "TV-Y7"],
                 avoid_tags: AGE_TENSION },
    tween:     { label: "9 to 12", runtime_max: 130,
                 certs: ["TV-Y", "TV-G", "G", "TV-Y7", "TV-PG", "PG"],
                 avoid_tags: ["grim", "bleak", "brutal", "body-horror",
                              "serial-killer", "unsettling", "anxiety-inducing"] },
  };
  const AGE_RE = [
    [/\b(under\s*(five|5)\b|pre-?school|toddler|(three|four|3|4)[- ]year[- ]old)/i, "preschool"],
    [/\b(for\s*)?(five to eight|5\s*(to|-)\s*8)\b|\b(five|six|seven|eight|5|6|7|8)[- ]year[- ]old/i, "young"],
    [/\b(for\s*)?(nine to twelve|9\s*(to|-)\s*12)\b|\b(nine|ten|eleven|twelve|9|10|11|12)[- ]year[- ]old/i, "tween"],
  ];

  const CERT_RANK = {
    "TV-Y": 0, "TV-Y7": 1, "G": 1, "TV-G": 1, "TV-PG": 2, "PG": 2,
    "PG-13": 3, "TV-14": 3, "R": 4, "TV-MA": 4, "NC-17": 5,
  };

  // The agent does one job. Anything else gets one line and a redirect rather
  // than a confident answer from a system that has no business giving one.
  const WATCH_WORDS = /\b(watch|watching|movie|movies|film|films|show|shows|series|episode|episodes|binge|stream|streaming|anime|drama|dramas|documentary|documentaries|playlist|recommend|recommendation|something|anything|see|viewing|rewatch|marvel|pixar|disney|star wars|rated|rating|epic|pg|tv-ma|feature|title|titles|catalog|catalogue)\b/i;

  function outOfScope(req) {
    if (req.genres.length || req.want_tags.length || req.format || req.runtime_max) return false;
    return !WATCH_WORDS.test(req.raw);
  }

  /* ------------------------------------------------------------- 1. PARSE */

  // Deterministic lexicon. This is the floor: it runs with no model available,
  // and the LLM parse (when present) is merged on top of it, never under it.
  const MOOD_LEXICON = [
    { re: /\b(comfort(ing)?|cozy|cosy|gentle|soothing|easy|warm|feel[- ]good|wholesome)\b/i,
      set: { warmth_target: 5, energy_max: 3 }, tags: ["gentle", "comfort-watch", "soothing"] },
    { re: /\b(intense|thrill(ing)?|edge of my seat|gripping|tense|adrenaline)\b/i,
      set: { energy_target: 5 }, tags: ["tense", "nail-biting"] },
    { re: /\b(sad|cry|tearjerker|emotional|move me)\b/i,
      set: {}, tags: ["tearjerker", "emotional"] },
    { re: /\b(funn?y|fun|laugh|comedy|light|silly|lighthearted)\b/i,
      set: { warmth_target: 4 }, tags: ["comedic", "witty"] },
    { re: /\b(great music|music|musical|soundtrack|score|songs?)\b/i,
      set: {}, tags: ["music-forward"] },
    { re: /\b(dark|bleak|grim|heavy|brutal)\b/i,
      set: { warmth_target: 2 }, tags: ["grim", "bleak"] },
    { re: /\b(smart|clever|cerebral|thought[- ]provoking|slow burn)\b/i,
      set: { energy_max: 4 }, tags: ["cerebral", "slow-burn"] },
    { re: /\b(nostalgi\w+|childhood|grew up|classics?)\b/i, set: {}, tags: ["classic", "nostalgic"] },
    // Two things the quiz can now ask for, which means the lexicon has to be able
    // to hear them. A word the interface offers and the parser cannot read is the
    // same defect as a question the data cannot answer.
    { re: /\b(rewatch(es|ing|able)?|seen it before|something familiar)\b/i,
      set: {}, tags: ["rewatchable", "comfort-watch"] },
    { re: /\b(recent(ly)?|newer|new releases?|latest|came out recently)\b/i,
      set: { year_min: 2020 }, tags: [] },
    { re: /\b(rainy|raining|sunday|lazy|hungover|tired|long day|wind down|unwind)\b/i,
      set: { warmth_target: 5, energy_max: 3 }, tags: ["gentle", "comfort-watch"] },
    { re: /\b(subtitles?|subtitled|subbed|foreign[- ]language)\b/i,
      set: {}, tags: ["subtitled"] },
    { re: /\b(background|half.?watch|something on)\b/i,
      set: { energy_max: 3 }, tags: ["rewatchable", "comfort-watch"] },
  ];

  // Patterns are plural-tolerant on purpose: "thrillers" and "documentaries"
  // are the way people actually type. A third element marks a CATEGORY tag —
  // one that filters the catalogue, unlike a mood tag, which only scores it.
  const GENRE_LEXICON = [
    [/\banime\b/i, "Anime"],
    [/\b(k[- ]?dramas?|korean)\b/i, null, "k-drama"],
    [/\banimat(ed|ion)\b/i, "Animation"],
    [/\bdocumentar(y|ies)\b|\bdocs?\b/i, "Documentary"],
    [/\bhorrors?\b|\bscary\b/i, "Horror"],
    [/\bromance\b|\bromantic\b|\brom[- ]?coms?\b/i, "Romance"],
    [/\bsci[- ]?fi\b|\bscience fiction\b/i, "Sci-Fi"],
    [/\bfantas(y|ies)\b/i, "Fantasy"],
    [/\bmyster(y|ies)\b|\bwhodunn?its?\b/i, "Mystery"],
    [/\bcomed(y|ies)\b|\bsitcoms?\b/i, "Comedy"],
    [/\bmusicals?\b/i, "Musical"],
    [/\bsuperheroe?s?\b|\bmarvel\b/i, "Superhero"],
    [/\baction\b/i, "Action"],
    [/\bthrillers?\b/i, "Thriller"],
    [/\bcrime\b|\bcrimes?\b|\bheist\b|\bgangster\b/i, "Crime"],
    [/\bwar\b|\bwartime\b/i, "War"],
    [/\bhistor(y|ical)\b|\bperiod (piece|drama)\b/i, "History"],
    [/\badventures?\b/i, "Adventure"],
    [/\bdramas?\b/i, "Drama"],
    // Animals are a subject, and a subject is not only a genre: the catalogue
    // carries it as a tone tag on titles filed under Animation or Family. Round 18
    // said a MOOD can never stand in for a genre, and that still holds — this is
    // the narrower claim that a subject can be written down in two places.
    [/\bnature\b|\bwildlife\b|\banimals?\b/i, "Nature", null, ["animals", "nature"]],
  ];

  const WORD_NUM = { one:1, two:2, three:3, four:4, five:5, ninety:90, sixty:60, thirty:30, twenty:20, fifteen:15, "forty five":45 };

  function parseRuntime(text) {
    let m;
    for (const [w, n] of Object.entries(WORD_NUM)) {
      if (new RegExp(`\\b${w}[- ]?h(ou)?rs?\\b`, "i").test(text)) return n * 60;
      if (new RegExp(`\\b${w}[- ]?min(ute)?s?\\b`, "i").test(text)) return n;
    }
    if ((m = text.match(/\b(\d{2,3})\s*[- ]?\s*(?:min(?:ute)?s?)\b/i)))        return +m[1];
    if ((m = text.match(/\bunder\s+(?:an?\s+)?(\d+(?:\.\d+)?)\s*h(?:ou)?rs?\b/i))) return Math.round(+m[1] * 60);
    if ((m = text.match(/\b(\d+(?:\.\d+)?)\s*h(?:ou)?rs?\s*(?:or\s*less|max)\b/i))) return Math.round(+m[1] * 60);
    if (/\bunder\s+an\s+hour\b/i.test(text)) return 60;
    if (/\b(short|quick|bite[- ]?sized)\b/i.test(text)) return 45;
    if (/\bbefore\s+(lunch|bed|dinner)\b/i.test(text)) return 100;
    return null;
  }

  // People negate with contractions far more often than with "not". Missing
  // them does not merely lose the constraint — it inverts it, because the word
  // being excluded is then read as the thing being asked for.
  const NEG_RE = /\b(?:no|not|nothing|none|without|avoid|skip|except|excluding|other than|but not|besides|aren'?t|isn'?t|ain'?t|wasn'?t|weren'?t|won'?t|can'?t|doesn'?t|didn'?t|do not|don'?t(?:\s+want)?)\s+([a-z0-9\- ]{3,30})/gi;

  const FORMAT_MOVIE_RE  = /\b(movies?|films?|flicks?)\b/i;
  const FORMAT_SERIES_RE = /\b(shows?|series|tv|binge|episodes?|seasons?|mini[- ]?series)\b/i;
  // "shorts" and "short film" name a format. The bare adjective "short" does not —
  // it describes a runtime, and it is read that way by parseRuntime.
  const FORMAT_SHORT_RE  = /\b(shorts|short films?|a short\b)/i;
  // Live action is not a genre. It is the absence of one, so it is parsed as an
  // exclusion rather than as something to match on.
  const LIVE_ACTION_RE   = /\blive[- ]?action\b/i;
  const COMPANY_RE = /\b(we|us|group|friends|everyone|together|alone|myself|solo|kids?|child|children|toddlers?|preschool|family|son|daughter|niece|nephew|date|partner)\b/i;
  const TIME_RE = /\b(min|mins|minute|minutes|hour|hours|hr|hrs|long|short|quick|under|over|less|max|about|around)\b/i;

  // Words that carry no request content. Anything left after these and the
  // lexicons is something the parser genuinely does not understand — and saying
  // so is the whole point, because silently dropping it is what made
  // "mythical 90-minute movies with dragons" come back as "movies under 90 min".
  const VOCAB_STOP = new Set(["find","show","give","get","some","any","the","and","for","with","about",
    "that","this","these","those","are","aren","isn","was","were","have","has","had","want","wanted",
    "looking","look","need","feel","feeling","like","something","anything","everything","nothing",
    "watch","watching","see","seen","play","tonight","today","now","later","good","great","best","really",
    "very","just","but","not","from","into","out","off","please","recommend","recommendation","pick","picks",
    "picked","put","list","row","make","made","build","new","old","more","less","other","another","again",
    "what","which","who","when","where","why","how","can","could","would","should","will","there","their",
    "your","yours","mine","ours","one","two","few","lot","lots","bit","kind","sort","type","stuff","things",
    "thing","only","also","then","than","been","being","its","his","her","them","they",
    // number words and time-of-day context: never the subject of a request
    "one","once","two","three","four","five","six","seven","eight","nine","ten","couple","dozen",
    "half","both","each","every","most","many","much","several","other","others","rest",
    "night","evening","morning","afternoon","weekend","weekday","tomorrow","yesterday",
    "while","during","after","before","between","around","maybe","perhaps","actually","probably",
    "thanks","thank","okay","yeah","yes","sure","right","well","still","even","ever","never"]);

  // Deliberately crude. It only has to bridge the gap between how someone types
  // a word and how a one-line synopsis happens to spell it.
  function stems(term) {
    const t = term.toLowerCase();
    const out = new Set([t]);
    for (const [re, rep] of [[/ies$/, "y"], [/s$/, ""], [/ing$/, ""], [/ed$/, ""], [/es$/, ""]]) {
      if (re.test(t)) out.add(t.replace(re, rep));
    }
    return [...out].filter(x => x.length >= 4);
  }

  const matchesText = (item, terms) => {
    const hay = (item.title + " " + item.overview + " " + item.tone_tags.join(" ") + " " +
                 item.genres.join(" ") + " " + item.brand).toLowerCase();
    return terms.some(t => stems(t).some(st => hay.includes(st)));
  };

  function unknownTerms(positive) {
    const toks = (positive.toLowerCase().match(/[a-z][a-z'\-]{3,}/g) || []);
    const out = [];
    for (const t of toks) {
      if (VOCAB_STOP.has(t)) continue;
      if (FORMAT_MOVIE_RE.test(t) || FORMAT_SERIES_RE.test(t) || FORMAT_SHORT_RE.test(t) ||
          COMPANY_RE.test(t) || TIME_RE.test(t)) continue;
      let known = false;
      for (const entry of GENRE_LEXICON) if (entry[0].test(t)) { known = true; break; }
      if (!known) for (const m of MOOD_LEXICON) if (m.re.test(t)) { known = true; break; }
      if (!known) out.push(t);
    }
    return [...new Set(out)].slice(0, 5);
  }

  function parseDeterministic(text) {
    const t = String(text || "");

    // Pull the negated spans out FIRST. "no reality tv" must not leave the word
    // "tv" behind to be read as a format request.
    const negSpans = [];
    const raw_positive = t.replace(NEG_RE, (m, body) => { negSpans.push(body.trim().toLowerCase()); return " "; });

    // "live-action" contains the word "action", which the genre lexicon reads as a
    // request for action films — the opposite of a neutral instruction. So the
    // phrase is consumed here, before any lexicon sees the text, and turned into
    // the exclusion it actually is.
    const wantsLiveAction = LIVE_ACTION_RE.test(raw_positive);
    const positive = wantsLiveAction ? raw_positive.replace(LIVE_ACTION_RE, " ") : raw_positive;

    const req = {
      raw: t, format: null, genres: [], category_tags: [], want_tags: [],
      avoid_tags: [], avoid_genres: [],
      runtime_max: parseRuntime(t), year_min: null,
      energy_target: null, energy_max: null, warmth_target: null,
      company: null, confidence: 0.5, source: "deterministic",
    };

    if (FORMAT_MOVIE_RE.test(positive)) req.format = "movie";
    if (FORMAT_SERIES_RE.test(positive)) req.format = "series";
    // Last, and deliberately: "short film" also matches the movie pattern, and the
    // more specific reading is the one the person meant.
    if (FORMAT_SHORT_RE.test(positive)) {
      req.format = "short";
      // parseRuntime reads the adjective in "short film" as a 45-minute ceiling.
      // Once the format is known that ceiling says nothing — every short is far
      // below it — and it would otherwise show up in the row title as a limit the
      // viewer never asked for.
      if (req.runtime_max === 45) req.runtime_max = null;
      // Someone who asks for shorts has three minutes, not two hours. The ladder
      // is allowed to give up the genre before it gives up the format, so this
      // one is locked the way an explicit refinement would be.
      req.locked = [...(req.locked || []), "format"];
    }
    if (wantsLiveAction) req.avoid_genres.push("Animation", "Anime");

    req.genre_alts = {};
    for (const entry of GENRE_LEXICON) {
      const [re, genre, tag, altTags] = entry;
      if (re.test(positive)) {
        if (genre) req.genres.push(genre);
        if (tag) { req.category_tags.push(tag); req.want_tags.push(tag); }
        if (genre && altTags) req.genre_alts[genre] = altTags;
      }
    }
    for (const m of MOOD_LEXICON) {
      if (m.re.test(positive)) { Object.assign(req, m.set); req.want_tags.push(...m.tags); }
    }

    // Negations become avoid-tags. Stopwords are dropped so "no reality tv"
    // yields ["reality"], not ["reality","tv"].
    const NEG_STOP = new Set(["tv","show","shows","stuff","things","movies","movie","series","kind","of","the","a","any"]);
    for (const body of negSpans) {
      // Run the negated span through the SAME lexicon the positive text uses.
      // Without this, "not animated" produced the bare token "animated", which
      // never matches the genre "Animation" — so the exclusion silently did
      // nothing. What someone excludes deserves the same reading as what they ask for.
      for (const [re, genre, tag] of GENRE_LEXICON) {
        if (!re.test(body)) continue;
        if (genre) req.avoid_genres.push(genre);
        if (tag) req.avoid_tags.push(tag);
      }
      for (const m of MOOD_LEXICON) if (m.re.test(body)) req.avoid_tags.push(...m.tags);
      for (const w of body.split(/\s+/)) if (w.length > 2 && !NEG_STOP.has(w)) req.avoid_tags.push(w);
    }

    if (/\b(we|us|group|friends|everyone|together|three of us|two of us)\b/i.test(positive)) req.company = "group";
    if (/\b(kids?|child|children|toddlers?|preschool|little ones?|family|my (son|daughter|niece|nephew))\b/i.test(positive) ||
        /\b(kid|family|child)[- ]friendly\b/i.test(positive)) req.company = "kids";
    if (/\b(alone|myself|solo|just me)\b/i.test(positive)) req.company = "solo";

    for (const [re, band] of AGE_RE) {
      if (re.test(positive)) { req.age_band = band; req.company = "kids"; break; }
    }

    req.live_action = wantsLiveAction;
    req.want_tags = [...new Set(req.want_tags)];
    req.category_tags = [...new Set(req.category_tags)];
    // "romantic animated shows" asks for one thing, not a choice between two.
    // A single genre is unambiguous; several are treated as a conjunction, and
    // the relaxation ladder can loosen that to "any of them" before it gives up
    // on genre altogether.
    req.genre_mode = req.genres.length > 1 ? "all" : "any";

    // "korean drama" fires both the k-drama category and the generic Drama
    // genre off the same word. With genre now a hard requirement, that double
    // count would quietly exclude every K-drama that is not filed under Drama.
    if (req.category_tags.includes("k-drama")) req.genres = req.genres.filter(g => g !== "Drama");
    req.avoid_tags = [...new Set(req.avoid_tags)];
    req.avoid_genres = [...new Set(req.avoid_genres)];
    // An excluded genre can never also be a requested one.
    req.genres = req.genres.filter(g => !req.avoid_genres.includes(g));

    // Whatever the lexicons could not account for. Reported either way; it only
    // becomes a filter if it actually matches something in the catalogue.
    req.unknown_terms = unknownTerms(positive);
    req.text_terms = [];
    req.ignored_terms = [];

    // Confidence: how much of the request we actually resolved.
    let signals = 0;
    if (req.format) signals++;
    if (req.genres.length) signals++;
    if (req.runtime_max) signals++;
    if (req.want_tags.length) signals++;
    if (req.company) signals++;
    if (req.avoid_tags.length) signals++;
    if (req.unknown_terms.length) signals++;
    req.confidence = Math.min(0.95, 0.25 + signals * 0.15);
    return req;
  }

  /* ----------------------------------------------------------- 2. CLARIFY */

  // Returns a question only when the answer would actually change the result.
  // A question that cannot reorder the candidate set is noise, so we don't ask it.
  function needsClarification(req, ctx) {
    if (ctx.clarifyTurns >= MAX_CLARIFY_TURNS) return null;

    // Who is watching changes the hard filters. This one always matters.
    if (!req.company && !ctx.profile.hard_filters?.allowed_certifications &&
        !req.want_tags.length && !req.genres.length && !req.runtime_max &&
        !(req.text_terms || []).length && req.confidence < 0.55) {
      return {
        field: "company",
        question: "Who's watching?",
        chips: [
          { label: "Just me",        value: "solo" },
          { label: "With friends",   value: "group" },
          { label: "Kids are here",  value: "kids" },
        ],
      };
    }
    // A wide-open request with no shape at all.
    if (req.confidence < 0.45 && !req.want_tags.length && !req.genres.length && !req.runtime_max &&
        !(req.text_terms || []).length) {
      return {
        field: "mood",
        question: "What are you in the mood for?",
        chips: [
          { label: "Something comforting", value: "comforting" },
          { label: "Something gripping",   value: "gripping" },
          { label: "Something funny",      value: "funny" },
          { label: "Surprise me",          value: "__skip__" },
        ],
      };
    }
    return null;
  }

  function applyClarification(req, field, value) {
    if (value === "__skip__") return { ...req, confidence: Math.max(req.confidence, 0.6) };
    if (field === "company") return { ...req, company: value, confidence: req.confidence + 0.15 };
    if (field === "mood") {
      const merged = parseDeterministic(req.raw + " " + value);
      return { ...req, want_tags: [...new Set([...req.want_tags, ...merged.want_tags])],
               warmth_target: merged.warmth_target ?? req.warmth_target,
               energy_max: merged.energy_max ?? req.energy_max,
               confidence: req.confidence + 0.2 };
    }
    return req;
  }

  /* ---------------------------------------------------------- 3. RETRIEVE */

  function certAllowed(item, hard) {
    if (!hard || !hard.allowed_certifications) return true;
    return hard.allowed_certifications.includes(item.certification);
  }

  // The kids-safety filter runs HERE, before ranking, and is not reachable from
  // the request text. No phrasing in the prompt can widen it.
  function retrieve(catalog, req, profile) {
    const hard = profile.hard_filters || {};
    const kidsPresent = req.company === "kids" || !!hard.kid_safe_only ||
                        (hard.allowed_certifications || []).length > 0;

    return catalog.filter(item => {
      if (!certAllowed(item, hard)) return false;
      // A rating is a legal classification, not an audience. Abbott Elementary is
      // TV-PG and is not a programme for a six-year-old, so the audience flag is
      // modelled separately and it is the one that decides.
      if (kidsPresent && item.kid_safe !== true) return false;
      if (kidsPresent && CERT_RANK[item.certification] > CERT_RANK["PG"]) return false;
      // The age band narrows that further and is not on the relaxation ladder:
      // it is a household rule, like the kids switch it came from.
      const band = AGE_BANDS[req.age_band];
      if (band) {
        if (!band.certs.includes(item.certification)) return false;
        if (item.runtime > band.runtime_max) return false;
        if ((band.avoid_tags || []).some(t => (item.tone_tags || []).includes(t))) return false;
      }
      if (hard.runtime_max && item.runtime > hard.runtime_max) return false;
      if (req.format && item.kind !== req.format) return false;
      // A six-minute short is a real answer to "something short" and a wrong one
      // to "a film for tonight". Shorts stay out of the pool unless they were
      // asked for by name.
      if (item.kind === "short" && req.format !== "short") return false;
      if (req.runtime_max && item.runtime > req.runtime_max) return false;
      if (req.year_min && item.year < req.year_min) return false;
      if ((req.category_tags || []).length) {
        if (!req.category_tags.every(t => item.tone_tags.includes(t))) return false;
      }
      // A stated genre is a requirement. It used to be satisfiable by a mood tag
      // instead, which is how "intense animated shows" returned Prison Break —
      // not animated, but tagged `tense`. A mood describes how something feels;
      // it can never stand in for what something IS.
      if (req.genres.length) {
        const has = g => item.genres.includes(g)
          || ((req.genre_alts || {})[g] || []).some(t => (item.tone_tags || []).includes(t));
        const ok = req.genre_mode === "all" ? req.genres.every(has) : req.genres.some(has);
        if (!ok) return false;
      }
      if ((req.text_terms || []).length && !matchesText(item, req.text_terms)) return false;
      if ((req.avoid_genres || []).some(g => item.genres.includes(g))) return false;
      if (req.avoid_tags.length) {
        if (req.avoid_tags.some(a => item.tone_tags.some(t => t.includes(a)) ||
                                     item.genres.some(g => g.toLowerCase().includes(a)))) return false;
      }
      return true;
    });
  }

  /* -------------------------------------------------------------- 4. RANK */

  function scoreItem(item, req, profile, history) {
    const aff = profile.affinities || {};
    const avd = profile.avoid || {};
    const parts = {};

    parts.genre = (item.genres || []).reduce((s, g) => s + (aff.genres?.[g] || 0), 0);
    parts.tone  = (item.tone_tags || []).reduce((s, t) => s + (aff.tone_tags?.[t] || 0), 0);
    parts.brand = aff.brands?.[item.brand] || 0;

    parts.penalty = (item.genres || []).reduce((s, g) => s + (avd.genres?.[g] || 0), 0)
                  + (item.tone_tags || []).reduce((s, t) => s + (avd.tone_tags?.[t] || 0), 0);

    // Requested tags are worth more than standing taste — this request beats the profile.
    parts.request = req.want_tags.reduce(
      (s, t) => s + (item.tone_tags.includes(t) ? 2.2 : 0), 0);

    // Tone fit against the mood the request asked for.
    // Weighted above profile affinity on purpose: what someone asks for tonight
    // beats what they usually watch. Before this, "make it lighter" returned the
    // same wall of anime, because standing taste outscored the stated mood.
    parts.tone_fit = 0;
    if (req.warmth_target != null) parts.tone_fit += 3.0 - Math.abs(item.warmth - req.warmth_target) * 2.1;
    if (req.energy_target != null) parts.tone_fit += 3.0 - Math.abs(item.energy - req.energy_target) * 2.1;
    if (req.energy_max != null && item.energy > req.energy_max) parts.tone_fit -= (item.energy - req.energy_max) * 2.4;

    // Runtime fit: reward comfortably inside the limit, not just barely under.
    parts.runtime_fit = 0;
    if (req.runtime_max) {
      const slack = (req.runtime_max - item.runtime) / req.runtime_max;
      parts.runtime_fit = slack >= 0 ? Math.min(1.2, slack * 3) : -4;
    }

    // Don't re-recommend what they just finished; do reward resuming.
    const h = history[item.id];
    parts.history = 0;
    if (h) parts.history = h.completed ? -2.5 : (h.progress > 0.05 ? 1.8 : -0.5);
    if (h && h.abandoned) parts.history = -4.0;

    // When someone states a mood, standing taste is dampened rather than
    // deleted: a profile is a prior, and tonight's sentence is evidence.
    const moodStated = req.warmth_target != null || req.energy_target != null || req.energy_max != null;
    if (moodStated) {
      parts.genre *= 0.5; parts.tone *= 0.5; parts.brand *= 0.5;
    }

    // Two tiers of tone data, and the score says which it trusts. An audited
    // title's energy, warmth and tags were written and checked by hand; a derived
    // title's were inferred from genres and keywords, which is good enough to
    // retrieve on and not good enough to win a tie. Worth roughly one matched
    // mood tag — enough to break a tie, not enough to bury a better answer.
    parts.tier = item.tier === "derived" ? 0 : 1.6;

    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    return { total: Math.round(total * 100) / 100, parts };
  }

  function rankDeterministic(candidates, req, profile) {
    const history = Object.fromEntries((profile.recent_history || []).map(h => [h.id, h]));
    return candidates
      .map(item => ({ item, score: scoreItem(item, req, profile, history) }))
      .sort((a, b) => b.score.total - a.score.total);
  }

  /* ---------------------------------------------------------- 5. VALIDATE */

  // Anything the model names that is not in the catalog by id is dropped here.
  // This is the guardrail that makes a hallucinated title structurally unable to
  // reach the screen.
  function validateIds(ids, catalog) {
    const byId = new Map(catalog.map(c => [c.id, c]));
    const kept = [], dropped = [];
    for (const id of ids) (byId.has(id) ? kept : dropped).push(id);
    return { kept, dropped, items: kept.map(id => byId.get(id)) };
  }

  /* ----------------------------------------------------------- 6. EXPLAIN */

  // Runtime and certification already appear on the card, so the rationale never
  // repeats them. `used` carries reasons already spent in this result set, so six
  // picks do not all say the same sentence.
  function explainDeterministic(item, req, profile, used) {
    const spent = used || new Set();
    const aff = profile.affinities?.tone_tags || {};
    const take = r => { spent.add(r); return r; };

    for (const t of (req.want_tags || [])) {
      const r = t.replace(/-/g, " ");
      if (item.tone_tags.includes(t) && !spent.has(r)) return take(r);
    }
    const leaning = (item.tone_tags || [])
      .filter(t => (aff[t] || 0) > 0)
      .sort((a, b) => (aff[b] || 0) - (aff[a] || 0));
    for (const t of leaning) {
      const r = "you lean " + t.replace(/-/g, " ");
      if (!spent.has(r)) return take(r);
    }
    for (const g of (item.genres || [])) {
      const r = "more " + g.toLowerCase() + ", which you watch a lot of";
      if ((profile.affinities?.genres?.[g] || 0) >= 1.5 && !spent.has(r)) return take(r);
    }
    for (const t of (item.tone_tags || [])) {
      const r = t.replace(/-/g, " ");
      if (!spent.has(r)) return take(r);
    }
    return (item.tone_tags || []).slice(0, 2).join(", ").replace(/-/g, " ");
  }


  /* ------------------------------------------------------------- the loop */

  async function run(input, opts) {
    const {
      catalog, profile, llm = null, count = DEFAULT_RESULT_COUNT,
      clarifyTurns = 0, priorRequest = null, refinement = null,
    } = opts;

    const trace = [];
    const t0 = Date.now();
    const step = (name, status, detail) =>
      trace.push({ step: name, status, detail, ms: Date.now() - t0 });

    /* 1. PARSE ----------------------------------------------------------- */
    let req = priorRequest ? { ...priorRequest } : parseDeterministic(input);
    if (refinement) req = applyRefinement(req, refinement);

    let llmUsed = false;
    if (llm && !priorRequest) {
      try {
        const extra = await llm.parse(input, req);
        if (extra && typeof extra === "object") {
          req = mergeParse(req, extra);
          llmUsed = true;
        }
      } catch (e) {
        step("PARSE", "degraded", `model unreachable (${e.message}) — deterministic parse stands`);
      }
    }
    // An unrecognised word becomes a search term only if it actually appears
    // somewhere in the catalogue. One that matches nothing would filter every
    // result away, so it is reported as not understood instead.
    if ((req.unknown_terms || []).length) {
      // A term is only worth searching on if it is distinctive. One that matches
      // nothing would filter every result away; one that matches a large slice of
      // the catalogue is a common word doing no work. Both get reported instead.
      const MAX_SHARE = 0.15;
      const searchable = [], ignored = [], byModel = [];
      // Round 14: a word the model turned into real tags is not an unused word.
      // The deterministic lexicon has no entry for "mythical", so it was reported
      // as unused while the model was quietly resolving it to mythic and folklore
      // and the results were good. Saying both things at once is just wrong.
      const resolved = new Set((req.resolved_terms || []).map(t => t.toLowerCase()));
      for (const t of req.unknown_terms) {
        if (resolved.has(t.toLowerCase())) { byModel.push(t); continue; }
        const hits = catalog.reduce((n, i) => n + (matchesText(i, [t]) ? 1 : 0), 0);
        (hits > 0 && hits <= Math.ceil(catalog.length * MAX_SHARE) ? searchable : ignored).push(t);
      }
      req.text_terms = searchable;
      req.ignored_terms = ignored;
      req.model_terms = byModel;
    }

    step("PARSE", "ok", {
      mode: llmUsed ? "deterministic + model" : "deterministic (local mode)",
      request: summarizeRequest(req),
      confidence: Math.round(req.confidence * 100) / 100,
      read_literally: req.text_terms,
      read_by_model: req.model_terms,
      not_understood: req.ignored_terms,
    });

    /* 1b. SCOPE ---------------------------------------------------------- */
    if (outOfScope(req)) {
      step("SCOPE", "refused", "no viewing intent detected \u2014 this agent only searches the catalogue");
      return {
        kind: "out_of_scope", request: req, trace,
        message: "That one is outside what I do \u2014 I only look through this catalogue for something to watch. Ask me for a mood, a runtime or a kind of story and I will get to work.",
      };
    }

    /* 2. CLARIFY --------------------------------------------------------- */
    const q = needsClarification(req, { clarifyTurns, profile });
    if (q) {
      step("CLARIFY", "asking", { question: q.question, reason:
        `confidence ${Math.round(req.confidence * 100)}% · turn ${clarifyTurns + 1} of ${MAX_CLARIFY_TURNS}` });
      return { kind: "clarify", question: q, request: req, trace, clarifyTurns: clarifyTurns + 1,
               readLiterally: req.text_terms, notUnderstood: req.ignored_terms,
               readByModel: req.model_terms };
    }
    step("CLARIFY", "skipped", clarifyTurns >= MAX_CLARIFY_TURNS
      ? `turn cap reached (${MAX_CLARIFY_TURNS}) — proceeding on best guess`
      : "request is specific enough to act on");

    /* 3. RETRIEVE (+ relaxation ladder) ---------------------------------- */

    // Before relaxing anything, check whether a HARD filter — not a preference —
    // is what emptied the result. If so the honest answer is "I can't", said out
    // loud, not a quiet substitution.
    const hardBlocked = detectHardBlock(catalog, req, profile);
    if (hardBlocked) {
      step("BLOCKED", "refused", hardBlocked);
    }

    // When someone names a specific thing, one exact match is a better answer
    // than five near-misses, so the bar for "enough" drops.
    const MIN_POOL = (req.text_terms || []).length ? 1 : 3;
    // What someone asked to WATCH is the last thing to go. Runtime, year and
    // format are surrendered to find three results; the subject itself is only
    // surrendered when there is nothing at all. Before this, "animals" on a
    // live-action kids request matched one title, fell below the pool minimum,
    // and the genre was dropped — leaving the row titled "animals" and filled
    // with family sitcoms, chosen by standing taste because nothing else was
    // left to choose by.
    const SUBJECT_RUNGS = new Set(["genres", "genre_mode", "text_terms"]);
    let working = req, relaxed = [], pool = retrieve(catalog, working, profile);
    for (const rung of RELAXATION_LADDER) {
      const floor = SUBJECT_RUNGS.has(rung.key) ? 1 : MIN_POOL;
      if (pool.length >= floor) break;
      if ((req.locked || []).includes(rung.key)) continue;   // user asked for this; it stays
      const next = rung.apply(working);
      if (JSON.stringify(next) === JSON.stringify(working)) continue;
      working = next; relaxed.push(rung.label);
      pool = retrieve(catalog, working, profile);
    }
    step("RETRIEVE", pool.length ? (relaxed.length ? "relaxed" : "ok") : "empty", {
      matched: pool.length,
      of: catalog.length,
      gave_up: relaxed,
      hard_filters: profile.hard_filters?.allowed_certifications
        ? `certification ≤ PG (${profile.hard_filters.reason || "household rule"})` : "none",
    });

    if (!pool.length) {
      return { kind: "empty", request: req, trace,
               readLiterally: req.text_terms, notUnderstood: req.ignored_terms,
               readByModel: req.model_terms,
               message: "Nothing in the catalogue matches, even after relaxing everything I'm allowed to relax." };
    }

    /* 4. RANK ------------------------------------------------------------ */
    let ranked = rankDeterministic(pool, working, profile);
    const shortlist = ranked.slice(0, Math.min(18, ranked.length));
    let rerankNote = "deterministic only (local mode)";

    if (llm) {
      try {
        const order = await llm.rerank(input, working, shortlist.map(r => ({
          id: r.item.id, title: r.item.title, tone_tags: r.item.tone_tags,
          energy: r.item.energy, warmth: r.item.warmth, overview: r.item.overview,
        })), { refined: !!refinement });
        if (Array.isArray(order) && order.length) {
          /* 5. VALIDATE — model output is untrusted until it survives this ---- */
          let attempt = 0, v = validateIds(order, catalog);
          while (!v.kept.length && attempt < MAX_VALIDATE_RETRIES) { attempt++; v = validateIds(order, catalog); }
          if (v.dropped.length) {
            step("VALIDATE", "caught", {
              dropped: v.dropped,
              note: "not present in the catalog — dropped before display",
            });
          }
          if (v.kept.length) {
            const pos = new Map(v.kept.map((id, i) => [id, i]));
            ranked = [...ranked].sort((a, b) =>
              (pos.has(a.item.id) ? pos.get(a.item.id) : 999) -
              (pos.has(b.item.id) ? pos.get(b.item.id) : 999));
            rerankNote = `model re-ranked ${v.kept.length} of ${shortlist.length}`;
          }
        }
      } catch (e) {
        rerankNote = `model unreachable (${e.message}) — deterministic order stands`;
      }
    }
    step("RANK", "ok", {
      method: rerankNote,
      top: ranked.slice(0, 3).map(r => `${r.item.title} (${r.score.total})`),
    });

    const picks = ranked.slice(0, count);
    const check = validateIds(picks.map(p => p.item.id), catalog);
    step("VALIDATE", check.dropped.length ? "caught" : "ok", {
      checked: picks.length, in_catalog: check.kept.length, dropped: check.dropped,
    });

    /* 6. EXPLAIN --------------------------------------------------------- */
    const usedReasons = new Set();
    const results = picks.map(p => ({
      ...p.item,
      _score: p.score.total,
      _parts: p.score.parts,
      _why: explainDeterministic(p.item, working, profile, usedReasons),
    }));
    step("EXPLAIN", "ok", { grounded_in: "catalog metadata + this profile's history, no free text" });

    const pivoted = relaxed.includes("the exact genre");

    return {
      kind: "results", results, request: working, relaxed, trace,
      pivoted, blocked: hardBlocked,
      readLiterally: req.text_terms, notUnderstood: req.ignored_terms,
               readByModel: req.model_terms,
      headline: buildHeadline({ req, relaxed, pivoted, blocked: hardBlocked, profile }),
      // Named from the ORIGINAL request. A row titled from the relaxed one would
      // quietly rename what the viewer asked for into whatever was left. When the
      // subject itself was given up, the title says so rather than promising on
      // the page something the panel already admitted it could not deliver.
      playlistName: pivoted ? "Closest I have to " + lower1(namePlaylist(req, results))
                            : namePlaylist(req, results),
    };
  }

  /* --------------------------------------------------------------- 7. REFINE */

  const HEAVY_TAGS = new Set(["tense","nail-biting","grim","bleak","brutal","dread","anxiety-inducing","tragic"]);
  const LIGHT_TAGS = new Set(["gentle","comfort-watch","soothing","preschool-safe","low-stakes"]);

  const REFINEMENTS = {
    shorter:  r => ({ ...r, runtime_max: Math.round((r.runtime_max || 120) * 0.7) }),
    longer:   r => ({ ...r, runtime_max: r.runtime_max ? Math.round(r.runtime_max * 1.5) : null }),
    // "Lighter" has to REMOVE the signals that made it heavy, not just add a
    // gentle one on top — otherwise the original "gripping" keeps winning and
    // the refinement looks ignored.
    lighter:  r => ({ ...r, warmth_target: 5, energy_max: 3, energy_target: null,
                      want_tags: [...new Set([...(r.want_tags||[]), "gentle", "comfort-watch"])]
                        .filter(t => !HEAVY_TAGS.has(t)),
                      avoid_tags: [...new Set([...(r.avoid_tags||[]), "grim", "bleak", "brutal", "dread"])] }),
    heavier:  r => ({ ...r, warmth_target: 2, energy_target: 5, energy_max: null,
                      want_tags: [...new Set([...(r.want_tags||[]), "tense"])]
                        .filter(t => !LIGHT_TAGS.has(t)),
                      avoid_tags: (r.avoid_tags||[]).filter(t => !["grim","bleak","brutal","dread"].includes(t)) }),
    weirder:  r => ({ ...r, want_tags: [...new Set([...(r.want_tags||[]), "surreal", "stylized", "cult-favorite"])] }),
  };

  // A refinement is an explicit instruction. Whatever it tightened is locked,
  // so the relaxation ladder cannot quietly undo the thing the user just asked
  // for — the single worst way for an assistant to lose someone's trust.
  const REFINEMENT_LOCKS = { shorter: ["runtime_max"], longer: ["runtime_max"],
                             lighter: ["warmth_target", "energy_max"], heavier: ["energy_target", "warmth_target"] };

  function applyRefinement(req, refinement) {
    if (typeof refinement === "string" && REFINEMENTS[refinement]) {
      const out = REFINEMENTS[refinement](req);
      out.locked = [...new Set([...(req.locked || []), ...(REFINEMENT_LOCKS[refinement] || [])])];
      return out;
    }
    if (refinement && refinement.more_like) {
      return { ...req, want_tags: [...new Set([...(req.want_tags||[]), ...(refinement.more_like.tone_tags||[])])] };
    }
    return req;
  }


  /* ------------------------------------------------- honesty about limits */

  // A hard filter is a household rule, not a preference. When it is what killed
  // the request, the user is told which rule and why — never silently rerouted.
  function detectHardBlock(catalog, req, profile) {
    const hard = profile.hard_filters || {};
    const kidsPresent = req.company === "kids" || !!hard.kid_safe_only ||
                        (hard.allowed_certifications || []).length > 0;
    if (!kidsPresent) return null;
    if (!req.genres.length && !req.want_tags.length) return null;

    const withoutCert = catalog.filter(item => {
      if (req.format && item.kind !== req.format) return false;
      if (req.genres.length) {
        const hit = req.genres.some(g => item.genres.includes(g));
        const tagHit = req.want_tags.some(t => item.tone_tags.includes(t));
        if (!hit && !tagHit) return false;
      }
      return true;
    });
    const withCert = withoutCert.filter(item =>
      item.kid_safe === true && certAllowed(item, hard) && CERT_RANK[item.certification] <= CERT_RANK["PG"]);

    if (withoutCert.length > 0 && withCert.length === 0) {
      return {
        rule: hard.reason || KIDS_MODE.reason,
        requested: req.genres.concat(req.want_tags).slice(0, 3),
        removed: withoutCert.length,
        message: `Nothing matching that request is suitable for a child, and kids mode is on. The whole request is removed by that filter, so here is the closest thing I am allowed to offer instead.`,
      };
    }
    return null;
  }

  function buildHeadline({ req, relaxed, pivoted, blocked }) {
    if (blocked) return blocked.message;
    if (pivoted) {
      const asked = [...(req.genres || [])].slice(0, 2).join(" / ");
      const gaveUp = relaxed.join(", ");
      return `Nothing here is ${asked ? asked.toLowerCase() : "what you described"}${req.runtime_max ? " at that length" : ""}. I gave up ${gaveUp} to find anything at all \u2014 so these are not what you asked for, they are what this catalogue actually has.`;
    }
    if (relaxed.length) return `Nothing matched exactly, so I gave up ${relaxed.join(" and ")}.`;
    return null;
  }

  /* ------------------------------------------------------------- helpers */

  function mergeParse(base, extra) {
    const out = { ...base, source: "deterministic + model" };
    for (const k of ["format", "runtime_max", "year_min", "energy_target", "energy_max", "warmth_target", "company"]) {
      if (extra[k] != null && base[k] == null) out[k] = extra[k];
    }
    out.genres     = [...new Set([...(base.genres||[]),     ...(extra.genres||[])])];
    out.want_tags  = [...new Set([...(base.want_tags||[]),  ...(extra.want_tags||[])])];
    out.avoid_tags = [...new Set([...(base.avoid_tags||[]), ...(extra.avoid_tags||[])])];
    // Only words that are actually in the sentence count. A model naming a term
    // the user never typed does not get to silence a vocabulary report.
    const said = new Set((base.unknown_terms || []).map(t => t.toLowerCase()));
    out.resolved_terms = [...new Set((extra.resolved_terms || [])
      .map(t => String(t || "").trim().toLowerCase())
      .filter(t => said.has(t)))];
    out.confidence = Math.min(0.98, Math.max(base.confidence, extra.confidence || 0) + 0.1);
    return out;
  }

  function summarizeRequest(r) {
    const o = {};
    if (r.format) o.format = r.format;
    if (r.genres?.length) o.genres = r.genres;
    if (r.category_tags?.length) o.category = r.category_tags;
    if (r.genres?.length > 1) o.genre_mode = r.genre_mode;
    if (r.locked?.length) o.locked = r.locked;
    if (r.runtime_max) o.runtime_max = r.runtime_max;
    if (r.want_tags?.length) o.mood = r.want_tags;
    if (r.avoid_tags?.length) o.avoid = r.avoid_tags;
    if (r.avoid_genres?.length) o.avoid_genres = r.avoid_genres;
    if (r.text_terms?.length) o.searched_text_for = r.text_terms;
    if (r.warmth_target != null) o.warmth_target = r.warmth_target;
    if (r.energy_max != null) o.energy_max = r.energy_max;
    if (r.energy_target != null) o.energy_target = r.energy_target;
    if (r.company) o.company = r.company;
    return o;
  }

  // A row title should say what was asked for, not offer a mood slogan. The
  // previous version picked from a fixed set of phrases, so "romantic comfort
  // animated shows" came back titled "Nothing that asks much of you" — which is
  // writing, but it is not a label, and a label is what a row needs.
  const GENRE_WORD = {
    Animation: "animated", Anime: "anime", Romance: "romantic", Comedy: "funny",
    Documentary: "documentary", Horror: "scary", Musical: "musical", Thriller: "thriller",
    Crime: "crime", "Sci-Fi": "sci-fi", Fantasy: "fantasy", Action: "action",
    Mystery: "mystery", Family: "family", Drama: "drama", Adventure: "adventure",
    Superhero: "superhero", Nature: "nature", War: "war", History: "period",
    Music: "music", Competition: "competition", Reality: "reality",
  };

  // A genre reads differently as a request than as an exclusion: "scary films"
  // is idiomatic, "no scary" is not. Only the ones that change get an entry.
  const EXCLUDE_WORD = { Horror: "horror", Animation: "animation", Comedy: "comedy",
    Musical: "musicals", Nature: "nature documentaries", History: "period drama" };

  const MOOD_WORD = {
    // One canonical word per family, so "gentle" + "comfort-watch" + "soothing"
    // yields "comforting" once rather than "comforting and comfort and calm".
    gentle: "comforting", "comfort-watch": "comforting", soothing: "comforting",
    tense: "intense", "nail-biting": "intense", comedic: "funny", witty: "funny",
    "music-forward": "music-led", tearjerker: "emotional", emotional: "emotional",
    romance: "romantic", tender: "tender", cerebral: "thoughtful", "slow-burn": "slow-burn",
    grim: "bleak", nostalgic: "nostalgic", classic: "classic", surreal: "surreal",
    "low-stakes": "low-stakes", "k-drama": "K-drama", anime: "anime",
    "cozy-mystery": "cosy mystery", "needle-drops": "music-led", prestige: "prestige",
    warm: "comforting", "preschool-safe": "gentle",
  };

  function describeRequest(req) {
    const used = new Set();
    const take = (w) => { const k = w.toLowerCase(); if (used.has(k)) return null; used.add(k); return w; };

    const genreWords = [];
    for (const t of (req.category_tags || [])) {
      const w = MOOD_WORD[t] || t.replace(/-/g, " ");
      const kept = take(w); if (kept) genreWords.push(kept);
      if (genreWords.length >= 2) break;
    }
    for (const g of (req.genres || [])) {
      if (genreWords.length >= 2) break;
      const w = GENRE_WORD[g]; if (!w) continue;
      const kept = take(w); if (kept) genreWords.push(kept);
    }

    const moodWords = [];
    const budget = Math.max(1, 3 - genreWords.length);
    for (const t of (req.want_tags || [])) {
      if (moodWords.length >= budget) break;
      const w = MOOD_WORD[t]; if (!w) continue;
      const kept = take(w); if (kept) moodWords.push(kept);
    }

    const noun = req.format === "movie" ? "movies" : req.format === "series" ? "shows"
               : req.format === "short" ? "shorts" : "picks";
    const head = [...genreWords.slice(0, 2), ...moodWords].join(" and ").replace(/ and (?=[^ ]+ and )/g, ", ");
    let title = head ? `${head} ${noun}` : noun;
    if ((req.text_terms || []).length) title += ` about ${req.text_terms.slice(0, 2).join(" and ")}`;
    if (req.company === "kids") title = "kid-friendly " + title;
    else if (!head && !(req.text_terms || []).length && noun === "picks") title = "picked for tonight";
    if (req.runtime_max) title += `, under ${req.runtime_max} min`;
    // "Live-action comedies" reads better than "comedies, no animated or anime",
    // and it is what the viewer actually said.
    if (req.live_action) title = "live-action " + title;
    const excl = (req.avoid_genres || [])
      .filter(g => !(req.live_action && (g === "Animation" || g === "Anime")))
      .map(g => EXCLUDE_WORD[g] || GENRE_WORD[g] || g.toLowerCase()).slice(0, 2);
    if (excl.length) title += `, no ${excl.join(" or ")}`;

    return title.charAt(0).toUpperCase() + title.slice(1);
  }

  const namePlaylist = describeRequest;
  const lower1 = t => t.charAt(0).toLowerCase() + t.slice(1);


  return {
    run, parseDeterministic, retrieve, rankDeterministic, scoreItem,
    validateIds, explainDeterministic, applyClarification, applyRefinement,
    detectHardBlock, buildHeadline, outOfScope,
    namePlaylist, summarizeRequest,
    RELAXATION_LADDER, MAX_CLARIFY_TURNS, CERT_RANK, REFINEMENTS, KIDS_MODE,
    describeRequest,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = AgentCore;
if (typeof globalThis !== "undefined") globalThis.AgentCore = AgentCore;
