#!/usr/bin/env python3
"""Derive the tone layer for titles nobody hand-audited.

The curated 115 carry energy, warmth and tone tags written by hand. A catalogue
of thousands cannot, so these are inferred from what TMDB does give: genres,
keywords, certification, runtime and language.

The one rule that matters: derived tags are drawn from the SAME vocabulary the
request lexicon maps onto. A tag the parser has never heard of is a tag that can
never be asked for, and inventing a private vocabulary here would quietly break
every mood query outside the audited tier.
"""

# The tags MOOD_LEXICON in src/agent.js actually maps requests onto. Anything
# outside this set is reachable only through literal text search.
MOOD_TAGS = {
    "gentle", "comfort-watch", "soothing", "tense", "nail-biting", "tearjerker",
    "emotional", "comedic", "witty", "music-forward", "grim", "bleak", "cerebral",
    "slow-burn", "classic", "nostalgic", "subtitled", "rewatchable",
}

# TMDB files television under compound genres and spells science fiction out in
# full. The request lexicon speaks neither, so they are translated on the way in
# rather than left to miss every query.
GENRE_ALIAS = {
    "Action & Adventure": ["Action", "Adventure"],
    "Sci-Fi & Fantasy":   ["Sci-Fi", "Fantasy"],
    "Science Fiction":    ["Sci-Fi"],
    "Kids":               ["Family"],
    "War & Politics":     ["War"],
}

def normalize_genres(genres, language=None):
    out = []
    for g in genres:
        for x in GENRE_ALIAS.get(g, [g]):
            if x not in out:
                out.append(x)
    # Anime is a real category to a viewer and no category at all to TMDB, which
    # files it as Animation with a Japanese original language. Without this, "anime"
    # matches nothing outside the hand-curated titles.
    if language == "ja" and "Animation" in out and "Anime" not in out:
        out.append("Anime")
    return out


# energy, warmth: what the genre alone implies, before keywords move it.
GENRE_TONE = {
    "Action":          (5, 3), "Adventure":   (4, 4), "Animation":  (3, 5),
    "Comedy":          (3, 5), "Crime":       (4, 2), "Documentary":(2, 3),
    "Drama":           (3, 3), "Family":      (2, 5), "Fantasy":    (3, 4),
    "History":         (2, 3), "Horror":      (5, 1), "Music":      (3, 5),
    "Mystery":         (3, 3), "Romance":     (2, 5), "Science Fiction": (4, 3),
    "Sci-Fi":          (4, 3), "TV Movie":    (3, 4), "Thriller":   (5, 2),
    "War":             (5, 2), "Western":     (3, 3),
    "Action & Adventure": (5, 3), "Sci-Fi & Fantasy": (4, 3), "Musical": (3, 5),
    "Kids":            (2, 5), "News":        (2, 3), "Reality":    (3, 4),
    "Soap":            (2, 4), "Talk":        (2, 4), "War & Politics": (4, 2),
}

# Tags that describe strain. They cancel the calm ones, and a children's action
# cartoon should not collect them from its genre list alone.
TENSION = ("tense", "nail-biting", "dread", "grim", "bleak", "brutal",
           "unsettling", "anxiety-inducing", "uneasy")

GENRE_TAGS = {
    "Comedy": ["comedic"], "Family": ["gentle"],
    "Horror": ["tense", "grim"], "Thriller": ["tense", "nail-biting"],
    "Action": ["tense"], "Music": ["music-forward"], "Romance": ["emotional"],
    "Documentary": ["cerebral"], "Mystery": ["cerebral", "slow-burn"],
    "Musical": ["music-forward"],
    "War": ["grim"], "Crime": ["grim"], "Drama": ["emotional"],
    "Science Fiction": ["cerebral"], "Sci-Fi & Fantasy": ["cerebral"],
    "Action & Adventure": ["tense"],
}

# Keyword substrings → (energy delta, warmth delta, tags). Substring rather than
# exact match because TMDB's keyword vocabulary is long-tailed and inconsistent.
KEYWORD_RULES = [
    (("slice of life", "friendship", "feel-good", "heartwarming", "wholesome",
      "small town", "cooking", "baking", "gardening"),      -1,  1, ["gentle", "comfort-watch"]),
    (("murder", "serial killer", "torture", "massacre", "genocide", "atrocity",
      "brutality", "gore"),                                  1, -2, ["grim", "bleak"]),
    (("chase", "battle", "combat", "survival", "explosion", "heist", "shootout",
      "manhunt", "car chase"),                               1, -1, ["tense", "nail-biting"]),
    (("grief", "loss", "terminal illness", "funeral", "orphan", "bereavement",
      "dying"),                                              0, -1, ["tearjerker", "emotional"]),
    (("love", "romance", "wedding", "first love", "courtship"),
                                                            -1,  1, ["emotional"]),
    (("satire", "parody", "slapstick", "sitcom", "stand-up comedy", "farce"),
                                                             0,  1, ["comedic", "witty"]),
    (("musical", "singer", "band", "concert", "songwriter", "opera", "dance"),
                                                             0,  1, ["music-forward"]),
    (("philosophy", "existentialism", "investigation", "conspiracy", "puzzle",
      "time loop", "artificial intelligence"),               0,  0, ["cerebral"]),
    (("nostalgia", "1980s", "1990s", "childhood", "coming of age"),
                                                             0,  1, ["nostalgic"]),
    (("dystopia", "post-apocalyptic", "nuclear", "pandemic", "totalitarian"),
                                                             1, -2, ["bleak", "grim"]),
    (("anime", "based on manga", "shounen", "shonen", "isekai"),
                                                             0,  0, ["anime"]),
    (("animal", "dog", "cat", "wildlife", "nature", "ocean", "bird"),
                                                            -1,  1, ["gentle"]),
]

KID_CERTS  = {"G", "TV-G", "TV-Y", "TV-Y7", "TV-Y7-FV"}
MILD_CERTS = {"PG", "TV-PG"}
# Words that disqualify a PG/TV-PG title from being "made for children" — the
# distinction round 18 was built on: a rating is a legal classification, not an
# audience.
NOT_FOR_KIDS = (
    "adultery", "alcohol", "divorce", "drug", "infidelity", "murder", "prostitut",
    "sex", "suicide", "terrorism", "war", "workplace", "office", "dating",
    "politics", "corruption", "addiction",
)

def clamp(n, lo=1, hi=5):
    return max(lo, min(hi, int(round(n))))

def derive(genres, keywords, cert, runtime, language, year, vote, title="", kind=""):
    """Returns (energy, warmth, tone_tags, kid_safe). Genres arrive normalized."""
    gs = [g for g in genres if g in GENRE_TONE]
    if gs:
        energy = sum(GENRE_TONE[g][0] for g in gs) / len(gs)
        warmth = sum(GENRE_TONE[g][1] for g in gs) / len(gs)
    else:
        energy, warmth = 3.0, 3.0

    tags = []
    # Round 13: Action in a children's cartoon is not tension. Kim Possible and
    # Gargoyles both carry Action; the one made for children also carries Family,
    # and that is the only signal in the data that separates them.
    family_action = (any(g in ("Family", "Kids") for g in genres)
                     and any(g in ("Action", "Adventure", "Action & Adventure") for g in genres))
    for g in genres:
        for t in GENRE_TAGS.get(g, []):
            if family_action and t in TENSION:
                continue
            tags.append(t)

    kw = " ".join(keywords).lower()
    for needles, de, dw, kt in KEYWORD_RULES:
        if any(n in kw for n in needles):
            energy += de
            warmth += dw
            tags.extend(kt)

    # A feature over two and a half hours asks more of a viewer than a 90-minute one.
    if runtime and runtime >= 150:
        tags.append("slow-burn")
    # Round 13: this was written for Pixar shorts and was firing on every
    # 22-minute television episode, which is how Gargoyles came to be gentle.
    if kind == "short" and runtime and runtime <= 25:
        tags.append("gentle")

    if year and year <= 1990:
        tags.append("classic")

    # Round 27's lesson: a non-English title is only "you will have to read this"
    # when no dub is the norm. Anime almost always ships one; little else does.
    # Anime ships an English dub as a matter of course; little else does. Round 27
    # learned this the hard way, and the genre has to count as well as the tag.
    is_anime = "anime" in tags or "Anime" in genres
    if language and language != "en" and not is_anime:
        tags.append("subtitled")
    if is_anime and "anime" not in tags:
        tags.append("anime")

    # Highly-rated and widely-seen is the closest honest proxy for a rewatch.
    if vote and vote >= 7.5:
        tags.append("rewatchable")

    kid_safe = False
    if cert in KID_CERTS:
        kid_safe = True
    elif cert in MILD_CERTS:
        family = any(g in ("Family", "Animation", "Kids") for g in genres)
        kid_safe = family and not any(n in kw for n in NOT_FOR_KIDS)

    # A title cannot be both a comfort watch and bleak. Genre and keywords pull in
    # opposite directions often enough that the first version handed Re:Zero
    # "gentle, grim, bleak" and CSI "grim, comfort-watch" — tags that cancel each
    # other out and make a mood query meaningless.
    # Round 13: the first version of this only covered grim and bleak, so "tense"
    # and "nail-biting" walked straight past it and 38 titles ended up tagged
    # "tense, gentle" — a pair that makes a mood query meaningless.
    if set(TENSION) & set(tags):
        tags = [t for t in tags if t not in ("gentle", "comfort-watch", "soothing")]

    seen, ordered = set(), []
    for t in tags:
        if t not in seen:
            seen.add(t)
            ordered.append(t)
    return clamp(energy), clamp(warmth), ordered[:6], kid_safe
