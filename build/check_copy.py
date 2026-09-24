#!/usr/bin/env python3
"""Spelling, grammar and readability over everything a person reads.

Covers the quiz, the panel's own sentences, the agent's messages, the two READMEs,
the iteration log and the deck. LanguageTool (en-GB — the project writes British
spelling) does spelling and grammar; textstat does readability.

Run it twice: the second pass is what proves a fix did not introduce a new problem.
"""
import json, os, re, sys, html

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Words LanguageTool does not know but that are correct here.
ALLOW = {
    "Marquee", "Disney", "Disney+", "Pixar", "TMDB", "Chrome", "JSON", "MV3",
    "Encanto", "Moana", "Zootopia", "Bao", "Piper", "Aristocats", "Aladdin",
    "Bluey", "Andor", "Hulu", "anime", "Anime", "Nat", "Geo", "DOM", "SPA",
    "BrainStation", "aria", "href", "hrefs", "CSP", "CSS", "HTML", "URL", "URLs",
    "runtime", "runtimes", "lexicon", "lexicons", "catalogue", "catalogues",
    "K-drama", "K-dramas", "kid", "rewatch", "rewatchable", "Sing", "Along",
    "unofficial", "concierge", "SparkShorts", "Luna", "Purl", "Burrow",
    "Rodrick", "Samsik", "Ranma", "Elio", "Bhutan", "Nano", "Gemini", "LLM",
    "eval", "evals", "Marvel", "pre", "de", "wordmark", "Synapse", "korean", "shōnen",
    "Aima", "Alakhume", "json", "Ragnarok", "Thor",
    "READMEs", "textstat", "LanguageTool",
}

def strip_md(text):
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"`[^`]*`", "code", text)   # a word, so articles keep a noun
    text = re.sub(r"^\|.*$", " ", text, flags=re.M)        # tables
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.M)
    text = re.sub(r"[*_>#]", "", text)
    return text

def strip_html(text):
    text = re.sub(r"<aside>.*?</aside>", " ", text, flags=re.S)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    return html.unescape(text)

PROSE = re.compile(r"^[\"“(]?[A-Z0-9I].*")
def js_strings(src):
    """Pull out the string literals that are sentences rather than selectors."""
    out = []
    for m in re.finditer(r'"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`', src):
        raw = m.group(1) or m.group(2) or ""
        s = raw.encode().decode("unicode_escape", "ignore")
        s = re.sub(r"\$\{[^}]*\}", " something ", s)
        s = re.sub(r"<[^>]+>", " ", s)
        s = re.sub(r"(?:\bsomething\b[ ,]*){2,}", "something ", s).strip()
        if len(s.split()) < 4:
            continue
        if re.search(r"[{};<>]|https?://|^\.|^#|=\s*$", s):
            continue
        if not PROSE.match(s):
            continue
        out.append(s)
    return out

def sources():
    q = json.load(open(os.path.join(ROOT, "data", "quiz.json"), encoding="utf-8"))
    lines = []
    def walk(qs):
        for item in qs:
            lines.append(item["q"])
            lines.extend(c["label"] for c in item["chips"])
    walk(q["shared"])
    for group in q["by_persona"].values():
        walk(group)
    walk(q["kids_mode"])
    yield "quiz.json", "\n".join(lines)

    for rel in ("extension/panel.js", "src/agent.js"):
        src = open(os.path.join(ROOT, rel), encoding="utf-8").read()
        yield rel, "\n".join(js_strings(src))

    for rel in ("extension/README.md", "docs/README.md", "docs/iteration_log.md"):
        yield rel, strip_md(open(os.path.join(ROOT, rel), encoding="utf-8").read())

    deck = os.path.join(ROOT, "deckproj", "project", "slides")
    for name in sorted(os.listdir(deck)):
        if name.endswith(".html"):
            yield "deck/" + name, strip_html(open(os.path.join(deck, name), encoding="utf-8").read())

def main():
    import language_tool_python as lt
    import textstat
    tool = lt.LanguageTool("en-GB")
    tool.disabled_rules.update({
        "EN_QUOTES",           # typographic quotes are deliberate in the UI copy
        "DASH_RULE",
        "WHITESPACE_RULE",
        "COMMA_PARENTHESIS_WHITESPACE",
        "UPPERCASE_SENTENCE_START",   # chip labels and fragments are not sentences
        "PUNCTUATION_PARAGRAPH_END",
        "SENTENCE_WHITESPACE",
        "OXFORD_SPELLING_Z_NOT_S",    # -ise is correct en-GB; Oxford -ize is a preference
        "CONSECUTIVE_SPACES",         # an artefact of stripping code spans out
        "EN_DIACRITICS_REPLACE_ORTHOGRAPHY_RAGNAROK",  # the release title carries no diacritic
    })
    total = 0
    print(f"{'source':28} {'issues':>7}  {'reading ease':>12} {'grade':>6}")
    print("-" * 62)
    details = []
    for name, text in sources():
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{2,}", "\n\n", text).strip()
        if not text:
            continue
        matches = []
        for m in tool.check(text):
            bad = text[m.offset:m.offset + m.error_length]
            if bad.strip("’'s") in ALLOW or bad in ALLOW:
                continue
            # A filename is not a spelling: catalog.json is what the file is called.
            if re.match(r"^\w+\.(json|js|mjs|py|md|html|css|png|zip)\b",
                        text[m.offset:m.offset + m.error_length + 6]):
                continue
            matches.append(m)
        ease = textstat.flesch_reading_ease(text)
        grade = textstat.text_standard(text, float_output=True)
        total += len(matches)
        print(f"{name:28} {len(matches):>7}  {ease:>12.1f} {grade:>6.1f}")
        for m in matches:
            details.append((name, m))
    print("-" * 62)
    print(f"{'TOTAL':28} {total:>7}")
    if details:
        print("\nissues:")
        for name, m in details:
            frag = m.context.strip().replace("\n", " ")
            print(f"  [{name}] {m.rule_id}: {m.message}")
            print(f"      …{frag}…")
            if m.replacements:
                print(f"      suggests: {m.replacements[:4]}")
    tool.close()
    return 0 if total == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
