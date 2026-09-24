#!/usr/bin/env python3
"""
Two catalogue corrections.

1. `Superhero` as a genre. Fourteen Marvel titles carried none, so a request for
   superhero content matched nothing, relaxed the genre away, and then returned
   Marvel titles anyway while announcing it had found no superhero content.

2. `kid_safe`, modelled separately from certification. A rating is a legal
   classification, not an audience: Abbott Elementary and Modern Family are TV-PG
   workplace comedies, and a PG cap alone put them in front of a six-year-old.
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
path = os.path.join(ROOT, "data", "catalog.json")
cat = json.load(open(path, encoding="utf-8"))

SUPERHERO = {
 "guardians-of-the-galaxy","guardians-of-the-galaxy-vol-3","thor-ragnarok","black-panther",
 "avengers-endgame","shang-chi-and-the-legend-of-the-ten-rings","captain-america-the-winter-soldier",
 "loki","wandavision","ms-marvel","moon-knight","hawkeye","agatha-all-along","x-men-97",
 "the-incredibles","big-hero-6",
}

# Rated for children AND made for them. Everything else is false.
ALWAYS_KID = {"G","TV-Y","TV-Y7","TV-G"}
KID_TRUE = {  # PG / TV-PG titles that really are children's viewing
 "encanto","moana","moana-2","frozen","zootopia","big-hero-6","tangled","wreck-it-ralph",
 "lilo-stitch","raya-and-the-last-dragon","treasure-planet","atlantis-the-lost-empire","bolt",
 "soul","coco","inside-out","inside-out-2","up","luca","turning-red","onward","elemental","brave",
 "the-incredibles","skeleton-crew","star-wars-a-new-hope","secrets-of-the-elephants",
 "the-greatest-showman","mary-poppins-returns",
}
KID_FALSE = {  # rated low enough to slip through, but not children's content
 "abbott-elementary","modern-family","dancing-with-the-stars","the-rescue",
 "the-empire-strikes-back","the-lion-king",
}

changed = {"superhero": 0, "kid_safe": 0}
for item in cat:
    if item["id"] in SUPERHERO and "Superhero" not in item["genres"]:
        item["genres"].append("Superhero"); changed["superhero"] += 1

    if item["id"] in KID_FALSE:
        safe = False
    elif item["id"] in KID_TRUE:
        safe = True
    else:
        safe = item["certification"] in ALWAYS_KID
    if item.get("kid_safe") != safe:
        item["kid_safe"] = safe; changed["kid_safe"] += 1

json.dump(cat, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
safe = [c["title"] for c in cat if c["kid_safe"]]
print(f"Superhero genre added to {changed['superhero']} titles")
print(f"kid_safe set on {changed['kid_safe']} titles — {len(safe)} are child-appropriate")
print("\nno longer reaching a six-year-old:")
for t in ("Abbott Elementary","Modern Family","Dancing with the Stars","The Rescue","The Empire Strikes Back","The Lion King"):
    print(f"  {t}")
