# Marquee — Chrome extension (unpacked)

An unofficial student concept. It adds a concierge panel to a streaming home page,
reads the rows the page is already showing you, and injects a row built from what
you actually asked for.

## Load it (about two minutes)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `extension/` folder.
4. Go to `disneyplus.com` and sign in. The **✦ Ask Marquee** button appears bottom-right.

## Households, and kids mode

The bar under the panel header has two different kinds of control.

**Three households**, which change how results are ranked:

- **Just me** — anime and K-drama, penalises reality and dance.
- **Movie night** — friends over, optimised for the lowest veto.
- **Date night** — two people, warm, and nothing three hours long.

**Kids watching**, which is a mode rather than a household, because any of the three can
have a child in the room. Switching it on restricts everything to titles actually made for
children — an audience flag set per title, not the certification, since Abbott Elementary
is TV-PG and is not a programme for a six-year-old. The filter runs inside retrieval,
before ranking, so no phrasing in the request can widen it. Ask it for TV-MA thrillers with
kids mode on and it refuses and names the rule. That refusal is the thing worth showing.

You can also just ask for something kid-friendly, and it applies the same filter to that one
request, without touching the toggle.

Changing either clears the conversation and removes any injected row, because a clarifying
turn or a refinement made under the old rules would carry the wrong ones.

## Where it appears

The **✦ Ask Marquee** button only shows on the five browsing surfaces:

```
/home   /browse/originals   /browse/movies   /browse/series   /browse/watchlist
```

Exact paths, not prefixes — `/browse/movies` is a shelf to choose from, while
`/browse/movies/<title>` is a decision already made, and a player or an account screen is
neither. The check re-runs on every route change, so navigating from a shelf to a title
hides the button and closes the panel without a reload.

The offline fixture is exempt, because a `file://` URL has no Disney routes to match and
gating it there would hide the panel from its own smoke test.

## When you have nothing in mind

**Help me decide** runs a short quiz instead of waiting for a sentence. The questions
change with the household — movie night is asked whether anyone dislikes subtitles, which
is a meaningless question for a solo viewer — and kids mode swaps in its own two.

Every answer is a fragment of plain English. Four taps compose something like *"comedy,
under 2 hours, no subtitles, nothing grim"*, which then runs through the same parser,
retrieval, ranking and guardrails as anything typed by hand. The quiz has no private path
through the agent, and the trace shows the same six steps.

The questions live in `data/quiz.json`, not in the code.

## What to check first

Open the panel. Before you type anything, it tells you what it found on the page:

- **It lists your rows** — good. The scan works, and the "before" in your demo is real.
- **"I could not find any rows"** — press **Rescan the page** once the page has finished
  loading. Disney+ loads rows lazily, so a scan that runs too early finds nothing.
- **Still nothing** — press **Copy diagnostics** and paste the result to me. That gives me
  the shape of the markup and I can fix the scan without guessing.

The concierge works either way. The row scan only affects whether it can show you what
the page was already offering, and where it inserts its own row.

## How it finds rows

No Disney class names are hardcoded, because they change. A row is recognised by its
shape: a horizontally overflowing box holding several sibling tiles that link to content.
The title comes from the nearest short piece of text above it. This survives a redesign
in a way that a CSS selector would not — but it is still a heuristic, and heuristics miss.

## How the cards link out

The catalogue has no Disney IDs in it, so the links are harvested rather than constructed.
Every tile on every browsing surface is an anchor whose `aria-label` begins with the title,
so as you browse, Marquee reads those and keeps a title → URL index in extension storage.
A card whose title is in the index opens that title page in a new tab. A card whose title
Marquee has not seen yet falls back to Disney's own search, marked `search` in the corner,
and fills the search box on arrival — the page writes `?q=` into its URL but does not read
it back on a cold load.

Only title-page links are collected. A Continue Watching tile points into the player
partway through an episode, which is the right link for that row and the wrong one for a
recommendation.

## What is in here

| File | What it does |
|---|---|
| `agent.js` | The agent, copied byte-for-byte from `src/agent.js`. The same file the eval harness runs. |
| `data.js` | Catalogue, profiles and cached runs, generated by `build/build_extension.py`. |
| `panel.js` | Page scan, the concierge panel, row injection. |
| `panel.css` | All styling. Extension CSS is exempt from the host page's CSP, which is why no style attributes are used. |

Rebuild `agent.js` and `data.js` after any change to the sources:

```
python3 build/build_extension.py
```

## Known limits

- No live model. The extension runs the deterministic core plus cached responses for the
  demo queries. The badge says "local mode", which is accurate.
- Watch histories in the three profiles are written by hand. The extension reads the rows
  on the page but does not yet feed them into ranking.
- `kid_safe` is a hand-set judgement per title, not a derived value. It is the right call
  to make explicitly, but it does not scale past a curated catalogue.
- Posters are the generated tone cards unless `data/posters.json` exists at build time.
- The link index starts empty. Straight after install, most cards fall back to search;
  they turn into direct links as you browse past those titles.
- Disney+ is a single-page app. Navigating between sections re-runs the scan automatically
  after a short delay, but an injected row does not follow you to a new view.

## The on-device model

Marquee ships with an optional language model that runs **in your browser**, on
WebGPU, through [WebLLM](https://github.com/mlc-ai/web-llm). It is off until you
press **Load model** in the panel header.

- Model: `Llama-3.2-3B-Instruct-q4f16_1-MLC`, about 2.3 GB.
- The weights are downloaded once from the Hugging Face CDN and cached by the
  browser. Load it once on a good connection and it is instant afterwards.
- Nothing is uploaded. There is no API key, no account and no backend.

### Why an offscreen document

WebGPU is not available inside an MV3 service worker, so the engine lives in
`offscreen.html`. That page has the extension's own origin and CSP, which means
the model never depends on what content-security policy the streaming site
happens to send. `background.js` creates that page on demand and relays messages;
`llm.js` is the content-script side.

```
panel.js  ->  llm.js  ->  background.js  ->  offscreen.js  ->  WebLLM  ->  WebGPU
              (validate)   (service worker)  (offscreen doc)
```

### What the model is allowed to do

It fills gaps in the parse and it re-orders a shortlist. That is all.

- `mergeParse` in `agent.js` writes a scalar field only where the deterministic
  parse left a gap, and unions the tag lists. The model cannot overwrite a
  constraint the sentence already established.
- `company` is not in the model's schema and is stripped if it appears anyway,
  so no model output can switch off the certificate cap or the age band. Kid
  safety stays inside retrieval, where prompt text cannot reach it.
- Every genre, tag and number it returns is checked against the catalogue's own
  vocabulary in `llm.js` before `agent.js` sees it. Invented values are dropped.
- Re-ranked IDs still go through VALIDATE. A title that is not in the catalogue
  never reaches the screen.

### If it does not load

Nothing breaks. The badge stays on `local mode`, the panel says why once, and
the deterministic core answers exactly as it did before — which is the mode the
39 eval cases are run in.
