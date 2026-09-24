/* Runs every case in data/eval_set.json against the same agent the page uses.
   Checks are mechanical: constraint satisfaction and grounding. Taste is the
   one column a person still has to fill in. */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const A        = require("../src/agent.js");
const CATALOG  = require("../data/catalog.json");
const PROFILES = require("../data/profiles.json").profiles;
const CACHED   = require("../data/cached_runs.json");
const SUITE    = require("../data/eval_set.json");

const CERT = A.CERT_RANK;
const byId = new Map(CATALOG.map(c => [c.id, c]));
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Same three-tier adapter as the page, minus the live tier (CI has no viewer).
const llm = {
  async parse(input)  { return CACHED[norm(input)]?.parse ?? null; },
  async rerank(input, req, shortlist, meta) { return (meta && meta.refined) ? null : (CACHED[norm(input)]?.order ?? null); },
};

function check(res, e, profile) {
  const fails = [];
  const R = res.results || [];
  const has = (i, t) => i.tone_tags.includes(t);

  if (e.kind && res.kind !== e.kind) fails.push(`kind=${res.kind}, wanted ${e.kind}`);
  if (e.min_results && R.length < e.min_results) fails.push(`only ${R.length} results`);
  if (e.all_runtime_max) for (const i of R) if (i.runtime > e.all_runtime_max) fails.push(`${i.title} runs ${i.runtime}>${e.all_runtime_max}`);
  if (e.all_kind) for (const i of R) if (i.kind !== e.all_kind) fails.push(`${i.title} is a ${i.kind}`);
  if (e.all_have_genre) for (const i of R) if (!i.genres.includes(e.all_have_genre)) fails.push(`${i.title} is not ${e.all_have_genre}`);
  if (e.all_have_tag) for (const i of R) if (!has(i, e.all_have_tag)) fails.push(`${i.title} lacks ${e.all_have_tag}`);
  for (const key of ["none_have_genre", "none_have_genre_2"]) {
    if (!e[key]) continue;
    for (const i of R) if (i.genres.includes(e[key])) fails.push(`${i.title} IS ${e[key]}`);
  }
  if (e.none_have_tag) for (const i of R) if (has(i, e.none_have_tag)) fails.push(`${i.title} is tagged ${e.none_have_tag}`);
  if (e.none_have_tags) for (const i of R) for (const t of e.none_have_tags)
    if (has(i, t)) fails.push(`${i.title} is tagged ${t}`);
  if (e.none_titles) for (const i of R) for (const t of e.none_titles)
    if (i.title.toLowerCase().includes(t.toLowerCase())) fails.push(`${i.title} should not be here`);
  if (e.cert_at_most) for (const i of R) if (CERT[i.certification] > CERT[e.cert_at_most]) fails.push(`${i.title} is ${i.certification}`);
  if (e.none_completed) {
    const done = new Set((profile.recent_history || []).filter(h => h.completed).map(h => h.id));
    for (const i of R) if (done.has(i.id)) fails.push(`${i.title} already finished`);
  }
  if (e.reads_text) {
    const got = (res.readLiterally || []).slice().sort().join(",");
    const want = e.reads_text.slice().sort().join(",");
    if (got !== want) fails.push(`searched text for [${got}], wanted [${want}]`);
  }
  if (e.not_understood) for (const t of e.not_understood)
    if (!(res.notUnderstood || []).includes(t)) fails.push(`did not report "${t}" as unrecognised`);
  if (e.all_kid_safe) for (const i of R) if (i.kid_safe !== true) fails.push(`${i.title} is not child-appropriate`);
  if (e.top_warmth_min && R[0] && R[0].warmth < e.top_warmth_min) fails.push(`top pick warmth ${R[0].warmth}<${e.top_warmth_min}`);
  if (e.mean_warmth_above && R.length) {
    const m = R.reduce((s, i) => s + i.warmth, 0) / R.length;
    if (m <= e.mean_warmth_above) fails.push(`mean warmth ${m.toFixed(2)}<=${e.mean_warmth_above}`);
  }
  if (e.pivoted && !res.pivoted) fails.push("did not report pivoting");
  if (e.blocked && !res.blocked) fails.push("hard block not reported");
  if (e.has_headline && !res.headline) fails.push("no headline explaining what it gave up");
  if (e.asks_field && res.question?.field !== e.asks_field) fails.push(`asked about ${res.question?.field}`);

  // Grounding is checked on every case, not only where the suite asks.
  for (const i of R) if (!byId.has(i.id)) fails.push(`GROUNDING: ${i.id} is not in the catalogue`);
  return fails;
}

const rows = [];
let pass = 0;
for (const c of SUITE.cases) {
  const base = PROFILES.find(p => p.id === c.profile);
  if (!base) throw new Error(`eval ${c.id}: no profile "${c.profile}"`);
  // Kids mode is applied exactly as the panel applies it, so the suite tests the
  // shipped filter rather than a copy of it.
  const profile = c.kids ? { ...base, hard_filters: A.KIDS_MODE } : base;
  let res = await A.run(c.input, { catalog: CATALOG, profile, llm, count: 6 });
  if (c.refine && res.kind === "results")
    res = await A.run(c.input, { catalog: CATALOG, profile, llm, count: 6,
                                 priorRequest: res.request, refinement: c.refine });
  const fails = check(res, c.expect, profile);
  if (!fails.length) pass++;
  rows.push({ ...c, ok: !fails.length, fails, got: res.kind,
              top: (res.results || []).slice(0, 3).map(r => r.title) });
}

const w = [22, 13, 8];
console.log(`\n  ${"case".padEnd(w[0])}${"group".padEnd(w[1])}${"result".padEnd(w[2])}notes`);
console.log("  " + "-".repeat(78));
for (const r of rows) {
  console.log(`  ${(r.id + " " + r.input).slice(0, w[0] - 1).padEnd(w[0])}${r.group.padEnd(w[1])}${(r.ok ? "PASS" : "FAIL").padEnd(w[2])}${r.ok ? r.top.join(", ").slice(0, 44) : r.fails[0]}`);
}
console.log(`\n  ${pass}/${rows.length} passing\n`);

writeFileSync(new URL("../data/eval_results.json", import.meta.url),
  JSON.stringify({ ran_at: new Date().toISOString(), passing: pass, total: rows.length, rows }, null, 1));
process.exit(pass === rows.length ? 0 : 1);
