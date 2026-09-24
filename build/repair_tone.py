#!/usr/bin/env python3
"""Round 13: repair three contradictions in the derived tone layer.

The harvest stored the tags derive_tone.py produced, not the keywords it read,
so the fix is applied to the catalogue in place. derive_tone.py carries the same
three rules so a future harvest does not reintroduce them.

  1. An episode length is not a mood. "runtime <= 25 -> gentle" was written for
     Pixar shorts and was firing on every 22-minute television episode, which is
     how Gargoyles came to be described as gentle.
  2. Tension and gentleness cancel. The first version of this rule only covered
     grim/bleak; tense and nail-biting leaked straight past it, leaving 38
     titles tagged "tense, gentle" — a pair that makes a mood query meaningless.
  3. Action in a children's cartoon is not tension. Kim Possible and Gargoyles
     both carry the Action genre. The one that is made for children also carries
     Family, and that is the signal that separates them.

Only the derived tier is touched. The 115 audited titles were written by hand
and are never rewritten by a script.
"""
import json, os, sys

ROOT    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(ROOT, "data", "catalog.json")

TENSION = ("tense", "nail-biting", "dread", "grim", "bleak", "brutal",
           "unsettling", "anxiety-inducing", "uneasy")
CALM    = ("gentle", "comfort-watch", "soothing")
FAMILY_GENRES = ("Family", "Kids")
ACTION_GENRES = ("Action", "Adventure", "Action & Adventure")


def repair(item):
    """Return the corrected tag list and a note of what changed."""
    tags = list(item.get("tone_tags") or [])
    before = list(tags)
    genres = item.get("genres") or []
    why = []

    # 3. action in a children's cartoon is not tension
    if any(g in FAMILY_GENRES for g in genres) and any(g in ACTION_GENRES for g in genres):
        if any(t in tags for t in TENSION):
            tags = [t for t in tags if t not in TENSION]
            why.append("family action, not tension")

    # 1. an episode length is not a mood
    if item.get("kind") != "short" and (item.get("runtime") or 0) <= 25:
        if "gentle" in tags and any(t in tags for t in TENSION):
            tags = [t for t in tags if t != "gentle"]
            why.append("short episode, not gentle")

    # 2. tension and gentleness cancel
    if any(t in tags for t in TENSION):
        kept = [t for t in tags if t not in CALM]
        if kept != tags:
            tags = kept
            why.append("tense strips calm")

    return tags, before, why


def main(apply=False):
    catalog = json.load(open(CATALOG, encoding="utf-8"))
    changed = 0
    for item in catalog:
        if item.get("tier") != "derived":
            continue
        tags, before, why = repair(item)
        if tags == before:
            continue
        changed += 1
        if changed <= 40 or not apply:
            print(f"  {item['title'][:36]:38} {','.join(before):<52} -> {','.join(tags)}   [{'; '.join(why)}]")
        if apply:
            item["tone_tags"] = tags

    print(f"\n{changed} derived titles corrected"
          f"{' — written' if apply else ' — dry run, nothing written'}")
    if apply:
        json.dump(catalog, open(CATALOG, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(apply="--apply" in sys.argv)
