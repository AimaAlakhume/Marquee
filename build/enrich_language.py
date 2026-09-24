#!/usr/bin/env python3
"""
Original language, and the `subtitled` tag that follows from it.

The quiz asks group watchers whether anyone dislikes subtitles, which is only a
real question if the catalogue knows which titles are subtitled. Before this,
exactly one did — so the answer changed nothing.

Strictly, subtitles are a property of the TRACK a viewer picks, not of the title;
most anime here ships a dub. But for the purpose of "someone in the room will not
read tonight", the useful signal is whether the title is originally in English.
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
path = os.path.join(ROOT, "data", "catalog.json")
cat = json.load(open(path, encoding="utf-8"))

KOREAN = {"moving","big-bet","connect","vigilante","the-worst-of-evil","blood-free",
          "uncle-samsik","call-it-love","soundtrack-1","the-impossible-heir"}
JAPANESE = {"bleach-thousand-year-blood-war","tokyo-revengers","summer-time-rendering",
            "black-rock-shooter-dawn-fall","ranma1-2","shogun","star-wars-visions"}

# The anime here all ship an English dub, so "no subtitles" does not rule them
# out — the viewer just picks the other track. Tagging every non-English title
# `subtitled` made "anime without subtitles" impossible, which is wrong: it is a
# perfectly ordinary request. The tag now means what it says — you will have to
# read this one — rather than merely "not originally in English".
DUB_AVAILABLE = {"bleach-thousand-year-blood-war","tokyo-revengers","summer-time-rendering",
                 "black-rock-shooter-dawn-fall","ranma1-2","star-wars-visions"}

n = subs = 0
for item in cat:
    lang = "ko" if item["id"] in KOREAN else "ja" if item["id"] in JAPANESE else "en"
    item["original_language"] = lang
    item["dub_available"] = lang == "en" or item["id"] in DUB_AVAILABLE
    must_read = lang != "en" and item["id"] not in DUB_AVAILABLE
    if must_read and "subtitled" not in item["tone_tags"]:
        item["tone_tags"].append("subtitled")
    if not must_read and "subtitled" in item["tone_tags"]:
        item["tone_tags"].remove("subtitled")
    n += lang != "en"
    subs += must_read

json.dump(cat, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{n} titles originally non-English; {subs} of them have no dub and are tagged `subtitled`")
print("  dubbed and therefore watchable without reading:", len(DUB_AVAILABLE))
