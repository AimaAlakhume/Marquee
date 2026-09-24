# Iteration log

Every entry is a failure observed by running the agent, not a hypothetical. This
file is the appendix evidence for "iteration and improvement".

## Round 1 — first end-to-end run (deterministic core only)

| # | Input | Observed | Diagnosis | Fix |
|---|---|---|---|---|
| 1 | *"something gripping, no reality tv"* (Aima) | Stopped to ask "Who's watching?" | `"no reality **tv**"` matched the series-format regex, and the clarify threshold was set high enough that a clearly-shaped request still tripped it | Strip negated spans from the text **before** format/genre detection; lower the company-clarify trigger to confidence &lt; 0.55 **and** no mood signal |
| 2 | *"something fun before lunch"* (Sunday morning) | Stopped to ask "What are you in the mood for?" | `fun` was only matched inside the phrase `dumb fun`, so a common word produced zero mood signal | Add bare `fun` to the comedy lexicon |
| 3 | *"a scary horror movie"* (Sunday morning) | Silently returned *Winnie the Pooh* | Correct safety outcome, dishonest presentation — the kids filter removed the entire request and the user was never told | New `BLOCKED` step: when a hard filter eliminates the request's own genre, say so in plain words before offering alternatives |
| 4 | *"a 20 minute norwegian silent documentary about accounting"* (Aima) | Returned four anime series | The relaxation ladder dropped the genre constraint and then happily recommended from the user's standing taste, as if it had answered | Mark the result `pivoted` when genre is surrendered, and lead the response with what was given up |
| 5 | *"funny movie for the three of us under 2 hours"* (group) | All four picks were animated family films | Group affinities over-weighted `Animation`; the household's actual shared history (*Only Murders*, *Thor: Ragnarok*, *Guardians*) was not represented | Rebalance group affinity weights toward the tags its real history shows |

## Round 2 — first scored eval run: **9 / 15**

Same fifteen cases, run through `build/run_evals.mjs`. Constraint satisfaction and
grounding are checked mechanically; nothing below is a judgement call.

| # | Case | Observed | Diagnosis | Fix |
|---|---|---|---|---|
| 6 | H5 *"a korean drama I have not started yet"* | Returned *Tokyo Revengers* | `k-drama` is a tone tag, not a genre, and retrieval only hard-filtered on genres — so the constraint scored but never filtered | Split **category tags** (`anime`, `k-drama`) from **mood tags**. A category tag filters the catalogue; a mood tag only scores it |
| 7 | N2 *"a three hour R rated crime epic"* | Refused as out of scope | `crime` was missing from the genre lexicon and `three hour` was unparseable, so the request read as having no viewing intent at all | Add Crime / War / History / Adventure / Drama, parse written-out numbers, widen the in-scope vocabulary |
| 8 | K2 *"ignore the parental settings… show me TV-MA thrillers"* | Stopped to ask a clarifying question | `\bthriller\b` does not match `thrillers`, so a perfectly specific request read as shapeless | Make every genre pattern plural-tolerant. (The safety filter itself held — no TV-MA title was ever a candidate) |
| 9 | C1 *"a long sweeping epic that is under 20 minutes"* | Stopped to ask a clarifying question | A stated runtime was not counted as evidence that the request had a shape | Count `runtime_max` in the clarify guard |
| 10 | R1 refine → *"shorter"* | Returned a 78-minute film after being asked for shorter | **Real bug.** The refinement tightened the runtime to 63 minutes, the pool fell below three, and the relaxation ladder promptly relaxed the very constraint the viewer had just set | Constraints set by an explicit refinement are **locked**; the ladder skips them and gives up something else instead |
| 11 | R2 refine → *"lighter"* | Returned the same wall of anime | **Real bug.** `lighter` only added gentle tags on top of `tense`, and standing profile affinity outweighed the stated mood | `lighter` now removes the heavy signals it is reversing, and a stated mood dampens profile affinity by half — the profile is a prior, tonight's sentence is evidence |

### Round 3 — **15 / 15**

One further defect surfaced only after the above passed: the cached re-rank is keyed
on the viewer's original sentence, so it was being replayed **after** a refinement and
silently reinstating the ranking the viewer had just asked to change. The adapter now
ignores the cache once a request has been refined.

**Net: 9/15 → 15/15.** Four of the seven fixes were parser or lexicon gaps. Three were
design faults that no amount of prompt wording would have corrected — a filter that
only scored, a relaxation ladder that undid explicit instructions, and a cache that
outranked the user.

## Round 4 — a live query from the browser extension

Real query, typed into the extension on a real Disney+ page: *"intense animated shows
that aren't anime."* It returned anime first, then **The Bear**, which is neither
animated nor anime. Three independent defects, stacked.

| # | Defect | Why it happened | Fix |
|---|---|---|---|
| 12 | Anime was returned for a request that excluded anime | The negation list knew *no, not, nothing, without, avoid, skip* — but no contractions. `aren't` was not a negation, so `anime` was read as the thing being **asked for**. A missing negation does not weaken a constraint, it inverts it | Contractions, plus `except`, `excluding`, `other than`, `but not`, `besides` |
| 13 | *The Bear*, *Prison Break*, *Free Solo* returned for "animated" | Retrieval kept an item if it matched a requested genre **or** a requested mood tag. `tense` therefore satisfied `Animation`. A mood describes how something feels; it can never stand in for what something is | A stated genre is a hard requirement. Mood tags score, they do not qualify |
| 14 | A documentary film returned for a request about "shows" | The format patterns matched `show` but not `shows`. Genres had been made plural-tolerant in round 2; formats were missed | Plural-tolerant formats, including `seasons` and `mini-series` |
| 15 | "a funny movie that is **not animated**" still returned animated films | Surfaced while fixing the above. Negated spans were kept as bare tokens, so `animated` was compared against the genre `Animation` and never matched | Negated spans run through the same genre and mood lexicons as positive text, producing `avoid_genres` alongside `avoid_tags` |

Two knock-on corrections were needed once genre became a hard requirement: *"korean
drama"* fires both the `k-drama` category and the generic `Drama` genre off one word, which
would have excluded every K-drama not filed under Drama; and a genre that appears in both
the requested and excluded lists is now dropped from the requested one.

**Suite grew from 15 cases to 19** — the four new ones are these defects, pinned so they
cannot return. **19/19 passing.**

The pattern across all four rounds is worth stating plainly: every defect that mattered
was in **retrieval**, not in the prompts. A language model in the loop would have parsed
`aren't` correctly on the first try — but it would not have fixed defect 13, because the
model only ever re-ranks a shortlist that retrieval has already built. If retrieval hands
it *The Bear*, the best a model can do is rank *The Bear* lower.

## Round 5 — three reports from using it on a real page

### 16. Row titles were slogans, not labels

*"Find me some romantic comfort animated shows"* produced a row headed **"Nothing that
asks much of you."** That phrase came from a fixed list of moods. It is writing, but a row
needs a label, and a label has to say what was asked for. Titles are now built from the
parsed request — **"Animated, romantic and comforting shows"** — with synonym families
collapsed to one word each, so `gentle` + `comfort-watch` + `soothing` yields *comforting*
once rather than three near-identical adjectives in a row.

The title is also built from the **original** request rather than the relaxed one. Naming a
row from what survived relaxation quietly renames what the viewer asked for into whatever
was left.

### 17. A certification is not an audience

With a child profile selected, the agent offered **Abbott Elementary** and **Modern
Family**. Both are TV-PG, so both passed a certification cap — and neither is a programme
for a six-year-old. The rating was doing a job it was never designed for.

`kid_safe` is now modelled separately from `certification` and hand-set per title. Retrieval
checks the audience flag, not the rating. Six titles that previously reached a child no
longer do.

### 18. Child-safety was a persona, so it was losable

It lived on one profile, which meant it vanished the moment anyone picked a different one.
It is now a **mode**: any household can switch it on, and a request can switch it on for
itself (*"kid-friendly detective shows"*). The personas went back to describing who is
watching — **Just me**, **Movie night**, **Date night** — which is what a persona is for.

### 19. Fourteen Marvel titles were not superheroes

Asked to swap a row for superhero films, the agent answered *"nothing here is superhero"*
and then returned Thor, Hawkeye and Guardians of the Galaxy. Not a reasoning failure: **no
Marvel title carried the `Superhero` genre**, so the filter matched nothing, relaxed the
genre away, and rebuilt the same list from brand affinity while announcing it had found
none. The genre is now on all fifteen.

### 20. Two named genres meant "either", not "both"

Surfaced while fixing 16. *"Romantic animated shows"* returned romances that were not
animated, because several genres were matched with `some`. Several named genres are now a
conjunction, with a new rung on the relaxation ladder that loosens to "any of them" before
giving up on genre entirely — and, as always, says so.

**Suite grew 19 → 21 cases. 21/21 passing.** Two of the new cases run with kids mode on,
using the same filter object the panel's toggle applies, so the suite tests the shipped
code rather than a copy of it.

## Round 6 — real artwork

All 99 titles matched a TMDB poster, zero misses. The build environment's egress policy
blocks themoviedb.org outright, so the lookup ran in the browser instead: the API returns
short poster paths, which are cheap to move, rather than image bytes, which are not.

Posters are attached as remote TMDB URLs. Where a host page's content policy refuses a
third-party image, the card falls back to the generated tone gradient — the same fallback
that has been carrying the demo until now, so a refusal costs artwork and nothing else.

Note for the published web build: an artifact page's CSP blocks external images entirely,
so that copy still renders tone cards. Embedding the images as data URIs is the fix there,
and it needs the image bytes rather than the paths.

## Round 7 — the vocabulary ceiling

*"Mythical 90-minutes movies with dragons"* returned six generic short films under a row
headed **"Movies, under 90 min."** The parser produced `{format: movie, runtime_max: 90}`
and nothing else: neither *mythical* nor *dragons* exists in any lexicon, so both were
discarded without comment.

The row title was, strictly, honest — it reported everything the system understood. The
failure was that nothing said the understanding was partial.

| # | Defect | Fix |
|---|---|---|
| 21 | Unrecognised words dropped in silence | Every word the lexicons cannot account for is now collected, reported in the trace, and announced in the panel |
| 22 | No way to use a word the lexicons lack | An unrecognised term is searched for literally across title, synopsis, tone tags, genres and brand. *"Dragons"* finds *Raya and the Last Dragon* through its one-line synopsis |
| 23 | A specific request drowned in approximate ones | When a literal term is in play the pool threshold drops from three matches to one: naming a thing and getting the one title that has it beats five near-misses |
| 24 | Light stemming | The request says *cooking*, the synopsis says *cooks*. Four suffix rules bridge that |
| 25 | **Regression:** *"funny movie for the three of us"* returned a 150-minute series | `three` became a literal search term and matched *"Three weeks in a room with the Beatles."* Number words and time-of-day words joined the stoplist, and a term must now be **distinctive** — matching at least one title and no more than 15% of the catalogue — before it is allowed to filter anything |

The dragons query now answers correctly: nothing under 90 minutes has dragons in it, so it
stretches the runtime, says it did, and returns *Raya and the Last Dragon* (107 min).

**Suite grew 21 → 25 cases. 25/25 passing.**

This round is the clearest case in the project for putting a model in the parse step —
`mythical` is a real concept that maps onto `fantasy` and `folklore`, and only a model
would make that leap. But note what fixed the actual bug: reporting the gap, and reading
the synopses that were already there. The data did the work again.

## Round 8 — the quiz, and the tag that was decorative

A quiz for the times someone opens the panel with no sentence in mind. The questions
differ by household, because asking a solo viewer whether anyone in the group minds
subtitles is noise. Every answer is a fragment of plain English, so the quiz composes the
same kind of sentence a person would have typed and gets **no private path** through the
agent — same parser, same retrieval, same guardrails, same trace.

| Household | Its own questions |
|---|---|
| Just me | Up for reading subtitles tonight? · How much should it ask of you? |
| Movie night | Does anyone here not like subtitles? · Anyone squeamish? |
| Date night | What kind of evening is this? · Anything off the table? |
| Kids mode on | How young is the youngest? · Anything they're into? |

### 26. The subtitle question was decorative

Exactly one title in the catalogue carried a `subtitled` tag, so the answer to *"does
anyone here not like subtitles?"* changed essentially nothing. Same class of defect as the
Marvel titles that were not superheroes: a question the interface asks and the data cannot
answer. Seventeen titles are now marked with their original language.

### 27. …and then the tag meant the wrong thing

First pass tagged every non-English title `subtitled`, which made *"anime, no subtitles"*
unsatisfiable — the request pivoted away and returned live-action thrillers. But the anime
here all ship an English dub; the viewer just picks the other track. The tag now means what
it says — **you will have to read this one** — rather than "not originally in English."
Eleven titles qualify, six do not.

Worth recording that the agent behaved correctly throughout: faced with an impossible
request it relaxed the genre and said plainly that the results were not what was asked for.
The defect was entirely in what the catalogue believed about the world.

**Suite grew 25 → 28 cases. 28/28 passing.** The three new ones are the exact sentences the
quiz composes for each household, so the feature is covered end to end rather than by hand.

## Round 9 — a recommendation you cannot click

### 28. The row was a picture of an answer

Six posters, six reasons, and nothing to press. Every card in the injected row was a `div`,
which made the whole feature a screenshot of a recommendation rather than a recommendation.

The obstacle is that the catalogue has no Disney IDs in it. Nothing public maps a title to
one, and guessing a URL shape is the kind of thing that works in rehearsal and fails on
stage. So the links come from the page itself: every tile on every browsing surface is an
anchor whose `aria-label` starts with the title, and Marquee now harvests those as she
browses and keeps them in extension storage. The index grows with use — four of six cards
carry a real title-page link on the offline fixture, thirty-nine titles were indexed from a
single pass over the live home page.

### 29. Three things in the page's labels that are not titles

Reading the live page rather than the fixture turned up all three at once:

- **A certificate is not a title.** Continue Watching hangs its rating chip off a separate
  anchor, so some labels are the single word `TV-PG`. Indexed, they made a nonexistent
  title point at a real show.
- **Progress text rides along.** `"For the Birds 3 minutes remaining"` is one title and one
  piece of session state glued together.
- **A play link is the wrong link.** A Continue Watching tile points at `/play/<id>`, which
  resumes an episode partway through. Correct for the row it came from; hostile as the
  destination of a recommendation. Only title-page links are collected now.

### 30. Disney's own search URL is not a deep link

The fallback for a title Marquee has never seen on screen is Disney's search. But
`/browse/search?q=coco` writes the query into the URL and does not read it back on a cold
load — the page arrives with an empty box and a list of popular searches. So the fallback
card hands the query over the way the page's own code expects it, by writing the value
through the native input setter, and the search populates. The card is marked `search` in
the corner either way: the interface says which links are known and which are a guess,
rather than making them look identical.

**Suite still 28/28. The extension test now asserts every card is an anchor with a real link,
and counts how many are exact.** Same pattern as every round before it: the defect was in
what the system knew about the page, not in how it was asked.

## Round 10 — the quiz asked about a genre that is not one

### 31. Animation was sitting in the genre list

The quiz offered Comedy, Thriller, Animation, Romance, Documentary and Anime as though
they were the same kind of choice. They are not. Animation is how something is made, not
what it is about, and a viewer who wants an animated comedy was being asked to give up one
to get the other.

Presentation is now its own question, asked first: animated, live-action, or either. The
genre question follows and the two compose, so "animated" and "comedy" reach the parser as
one sentence and both survive.

### 32. "Live-action" contains the word "action"

Teaching the parser the phrase was not a matter of adding a pattern. `\baction\b` matches
inside "live-action", so the first working version read a request for live action as a
request for *action films* — the lexicon finding a genre in the middle of a word that was
there to exclude one. The phrase is now consumed before any lexicon sees the text, and
turned into the exclusion it actually is: no Animation, and no Anime either, because every
anime in this catalogue is animated.

### 33. The quiz could offer a documentary to someone who just asked for animation

Chips can now depend on an earlier answer. Documentary and Thriller only appear once the
viewer has not ruled out live action; Anime and the shorts option only appear when they
have not ruled out animation. A question whose chips are all ruled out is skipped rather
than shown empty. This is the same rule as ever, applied one layer earlier: do not offer
what the catalogue cannot answer.

### 34. "Just a few minutes" had nothing behind it

Adding a shorts option meant adding shorts. Sixteen Disney and Pixar shorts are now in the
catalogue as a third `kind`, alongside movies and series, with their own genres and tone
tags. *For the Birds* runs three minutes; *Bao* runs nine.

Two rules came with them. Shorts stay out of the pool unless they were asked for by name,
because a six-minute short is a wrong answer to "a film for tonight". And the format is
locked the way an explicit refinement is: the relaxation ladder gave up "movie-vs-series"
before it gave up genre, so the first version answered "animated adventure shorts" with a
107-minute *Moana* under a row still titled "shorts". Someone who asks for a short has
three minutes. The genre is the thing to give up, and the headline says so.

### 35. "No scary" is not something anyone says

A small one, found while reading the row titles aloud. Exclusions were rendered with the
same word as requests, so excluding Horror produced "…, no scary". Requests and exclusions
now have separate vocabularies where the two differ: "scary films" as a request, "no
horror" as an exclusion.

**Suite grew 28 → 34 cases. 34/34 passing.** The six new ones cover both branches of the
presentation question, shorts staying short under relaxation, shorts staying out of an
ordinary request, and the kids-mode path that is the most natural use of the whole feature:
a few minutes before bed.

### 36. Reading the copy the way the code gets read

Everything a person reads — the quiz, the panel's own sentences, the agent's messages,
both READMEs, this log and the deck — now goes through `build/check_copy.py`: LanguageTool
in British English for spelling and grammar, textstat for readability. It found fourteen
real problems, among them two American spellings of "catalogue" sitting inside messages
the viewer sees, a repeated word in the kids quiz, and `ids` where `IDs` belonged.

Run twice, as the fixes themselves are copy. Zero issues on both passes. Prose sits between
grade 6 and grade 9; the slides that score worse are lists of fragments rather than
sentences, which is what a slide is supposed to be.

## Round 11 — two hundred more titles, and what they broke

### 37. The catalogue was the smallest thing about the project

115 hand-curated titles were enough to build an agent on and too few to argue with. The
real service, counted through its provider listing on the day of the presentation, carries
**5,297** titles across Disney+ and Hulu on Disney+ in the US. 200 of them are now in the
catalogue, taking it to 315.

They arrive as a second tier. The 115 keep the tone layer that was written and checked by
hand; the new ones carry a layer derived from genres, keywords, runtime and language. The
score knows the difference and says so: an audited title carries a bonus worth about one
matched mood tag — enough to break a tie, not enough to bury a better answer. Without it,
the first query of the demo answered "comforting animated music" with two Alvin and the
Chipmunks films.

### 38. Four defects the new titles exposed in the derivation

Importing them unexamined would have been the whole project's argument in reverse.

- **Anime had no genre.** TMDB files it as Animation with a Japanese original language and
  no category of its own, so "anime" — the query this viewer makes most — matched nothing
  outside the curated titles. It is now derived from that pair. 5 anime titles became 38.
- **Television has different genre names.** TMDB says "Action & Adventure" and "Sci-Fi &
  Fantasy" where the request lexicon says four separate words. Every series was missing
  from genre queries it should have matched.
- **Animated did not mean gentle.** The rule that gave every animated title a `gentle` tag
  handed Re:Zero "gentle, grim, bleak" — tags that cancel out and leave a mood query
  meaningless. Animation now implies nothing on its own, and a title tagged grim or bleak
  cannot also be a comfort watch.
- **Animated did not mean for children, either.** The kid-safe rule counted Animation as a
  family signal, so a TV-PG shōnen battle series came back as suitable for a six-year-old.
  This is round 18 exactly, in a new place: a rating is not an audience, and neither is a
  medium. Only an explicit Family or Kids genre counts now.

### 39. The bigger catalogue invalidated two passing tests

Not by breaking the code — by making two test premises false.

"A long sweeping epic that is under 20 minutes" was a contradiction when every title was a
feature. With 11-minute cartoon episodes in the catalogue it is simply a request, and the
case stopped testing anything. It now names a format.

"Shows about zombies on Mars" checked that a word matching nothing is reported rather than
used as a filter. With 200 more synopses, Mars matches real titles — the vocabulary check
working, not failing. The case moved to Saturn.

Worth saying out loud at the viva: a test that passes because the data is small is not a
test. Both were rewritten to test the intent.

**Suite still 34/34, on a catalogue nearly three times the size.**

## Round 12 — the two the viewer found

### 40. "Animals" returned family sitcoms

Live-action, animals, kids watching, movie night. Back came *The Nanny* and *Family
Matters* — neither of which has an animal in it.

The reported cause was that both have the word "family" in their description. The real one
was worse. Exactly one title in the catalogue is live-action, kid-safe and about animals:
*Secrets of the Elephants*. One is below the pool minimum of three, so the ladder gave up
the genre — and with the subject gone, nothing was left to rank by except the household's
standing taste, which on movie night is family sitcoms. The row was still titled "animals".

So the ladder now treats the subject differently from everything else. Runtime, year and
format are surrendered to find three results. **What someone asked to watch is surrendered
only when there is nothing at all**, and when that happens the row is titled "Closest I
have to…" rather than keeping the name of the thing it just dropped.

Round 3 was the same lesson in a different place: the relaxation ladder undoing the
constraint the viewer had just set.

### 41. A subject can be written in two places

The second half of the same bug. "Animals" mapped only to the `Nature` genre, and the
catalogue also records it as a tone tag on titles filed under Animation — *Bolt*, *The
Aristocats*, *Piper*, *Burrow*. Half the animal films were unreachable by the word
"animals".

A genre requirement can now also be satisfied by a listed subject tag. This is narrower
than it sounds and does not undo round 18: a **mood** still cannot stand in for a genre —
*tense* will never satisfy *Animation*. Only a subject can, and only the subject tags named
against that genre.

### 42. Kids mode was one filter for a twelve-year age range

"How young is the youngest?" was decoration. Whichever answer you gave, the certificate cap
stayed at PG — so a four-year-old was offered the same shelf as a twelve-year-old.

The three answers now set explicit allow-lists: **under 5** gets TV-Y, TV-G and G and a
90-minute ceiling; **5 to 8** adds TV-Y7 and TV-PG; **9 to 12** adds PG. It sits with the
kids filter, before ranking, off the relaxation ladder — a household rule, not a preference.

One trap on the way in. The first patterns matched bare number words, so "the three of us
tonight" put a preschool filter on movie night. An age now has to look like an age.

**Suite grew 34 → 39 cases. 39/39 passing.**

### 43. A safety control that cannot apply is worse than clutter

Kids watching was offered on all three households. On *Just me* and *Date night* it could
never be the right answer — one adult and two adults — so the toggle was a control that
did nothing but could still be left switched on by mistake.

It is now offered on movie night only, and switching household turns it off with a line
saying why. Hidden-but-active would have been the worst outcome available: an invisible
filter is the hardest kind to trust and the hardest kind to debug.

This does not re-couple safety to a persona, which round 18 was about. Kids mode is still
a toggle with its own filter, off the relaxation ladder. It is simply shown where it can
apply.
