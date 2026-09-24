# The two model prompts, verbatim

The agent uses a model for exactly two jobs. Both prompts are reproduced here as they
appear in `src/agent.js`, template literals and all. They are the seam a live model would
attach to; nothing is attached in the shipped extension.

## 1. Intent parsing

Runs after the deterministic parser, never instead of it. The rule-based
result is handed to the model as a starting point, and only fields the model *adds or
corrects* are merged back — so a model failure degrades to the rule-based parse rather
than to nothing.

```js
const PARSE_PROMPT = (input, base) => `You turn a viewer's request into a structured query for a catalogue filter.
Request: ${JSON.stringify(input)}
A rule-based parser already produced: ${JSON.stringify(AgentCore.summarizeRequest(base))}
Return ONLY JSON with any of: format ("movie"|"series"), genres (string[]), want_tags (string[]),
avoid_tags (string[]), runtime_max (int minutes), warmth_target (1-5, 5 = comforting),
energy_target (1-5), energy_max (1-5), company ("solo"|"group"|"kids"), confidence (0-1).
Only include a field you are adding or correcting. No prose.`;
```

## 2. Tone re-ranking

The model never sees the catalogue. It sees a shortlist of at most 18 titles that have
already passed every numeric and safety filter, and it reorders them on the qualities
metadata cannot express. Its answer is then validated against the catalogue by id before
anything reaches the screen.

```js
const RERANK_PROMPT = (input, req, shortlist) => `Re-rank these titles for tone fit with the request.
Request: ${JSON.stringify(input)}
Structured: ${JSON.stringify(AgentCore.summarizeRequest(req))}
Candidates: ${JSON.stringify(shortlist)}
Judge tone, pacing and feel — the numeric filters already passed. Return ONLY a JSON array of ids,
best first, at most 8. Use ids exactly as given; invent nothing.`;
```

## Why they are this small

Everything a prompt could get wrong here is bounded. The parse prompt cannot invent a
title because it does not return titles. The re-rank prompt cannot introduce one because
its output is a list of ids checked against the catalogue. Neither prompt can widen a
safety filter, because the filter runs in retrieval, before either of them is called.
