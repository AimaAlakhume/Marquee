/* The seam between the model and the agent, tested with a stub instead of a
 * 2.3GB download. What matters here is not what a model says — it is what the
 * agent does with it, and what it refuses to do with it.
 */
import fs from "fs";

const src = fs.readFileSync("src/agent.js", "utf8");
const catalog = JSON.parse(fs.readFileSync("data/catalog.json", "utf8"));
const profiles = JSON.parse(fs.readFileSync("data/profiles.json", "utf8")).profiles;
const mod = { exports: {} };
new Function("module", "exports", "window", src)(mod, mod.exports, {});
const A = mod.exports.Agent || mod.exports;
const solo = profiles.find(p => p.id === "solo");
const night = profiles.find(p => p.id === "movie-night");

const stub = extra => ({ parse: async () => extra, rerank: async () => null });
const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "   " + detail}`);
  if (!ok) fails.push(name);
};

const Q = "a mythical 90-minute adventure";

/* 1. with no model, an unknown word is reported as unused */
let r = await A.run(Q, { catalog, profile: solo, count: 5 });
check("without a model, “mythical” is reported as not understood",
  (r.notUnderstood || []).includes("mythical"),
  JSON.stringify({ lost: r.notUnderstood, byModel: r.readByModel }));

/* 2. with a model that resolves it, it is no longer reported as unused */
r = await A.run(Q, { catalog, profile: solo, count: 5, llm: stub({
  want_tags: ["mythic", "folklore"], genres: ["Fantasy"],
  resolved_terms: ["mythical"], confidence: 0.8,
}) });
check("with a model, it is credited to the model, not called unused",
  (r.readByModel || []).includes("mythical") && !(r.notUnderstood || []).includes("mythical"),
  JSON.stringify({ lost: r.notUnderstood, byModel: r.readByModel }));

/* 3. a model cannot silence a word the user never typed */
r = await A.run(Q, { catalog, profile: solo, count: 5, llm: stub({
  want_tags: ["mythic"], resolved_terms: ["zombies", "mythical"], confidence: 0.8,
}) });
check("a word the user never typed cannot be claimed",
  !(r.readByModel || []).includes("zombies"),
  JSON.stringify(r.readByModel));

/* 4. the model cannot put a child in the room, or take one out */
r = await A.run("something funny for under 5", { catalog, profile: night, count: 5,
  llm: stub({ company: "solo", age_band: "tween", want_tags: ["comedic"],
              hard_filters: { allowed_certifications: ["R"] }, confidence: 0.9 }) });
const certs = (r.results || []).map(x => (x.item || x).certification);
check("the model cannot widen the age band",
  certs.length > 0 && certs.every(c => ["TV-Y", "TV-G", "G"].includes(c)),
  JSON.stringify(certs));

/* 5. an invented id is dropped before display */
r = await A.run("a comforting animated movie", { catalog, profile: solo, count: 5,
  llm: { parse: async () => null,
         rerank: async () => ["not-a-real-id", "also-fake"] } });
const ids = new Set(catalog.map(c => c.id));
check("invented ids never reach the screen",
  (r.results || []).every(x => ids.has((x.item || x).id)),
  JSON.stringify((r.results || []).map(x => (x.item || x).id)));

/* 6. a model that throws costs nothing */
r = await A.run(Q, { catalog, profile: solo, count: 5, llm: {
  parse: async () => { throw new Error("gpu fell over"); },
  rerank: async () => { throw new Error("gpu fell over"); } } });
check("a model that throws still returns results",
  r.kind === "results" && (r.results || []).length > 0, r.kind);

console.log(`\n  ${6 - fails.length}/6 passing`);
process.exit(fails.length ? 1 : 0);
