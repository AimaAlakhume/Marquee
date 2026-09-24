#!/usr/bin/env python3
"""Merge the harvested titles into the hand-curated catalogue.

Two tiers, and the difference is recorded rather than hidden:

  audited  — the 115 titles whose energy, warmth and tone tags were written and
             checked by hand. Nothing here is overwritten by a harvest.
  derived  — titles whose tone layer was inferred from genres, keywords, runtime
             and language by build/derive_tone.py.

kid_safe is recomputed here rather than trusted from the harvest, because the
harvest's copy of the rule counted Animation as a signal that something was made
for children. It is not: a TV-PG shonen battle series is animated and is not
Bluey. Only an explicit Family or Kids genre counts.
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "build"))

CATALOG = os.path.join(ROOT, "data", "catalog.json")
HARVEST = os.path.join(ROOT, "data", "harvest")
POSTERS = os.path.join(ROOT, "data", "poster_urls.json")
IMG     = "https://image.tmdb.org/t/p/w500"

KID_CERTS  = {"G", "TV-G", "TV-Y", "TV-Y7", "TV-Y7-FV"}
MILD_CERTS = {"PG", "TV-PG"}

norm = lambda s: re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()

def kid_safe(cert, genres):
    if cert in KID_CERTS:
        return True
    if cert in MILD_CERTS:
        return any(g in ("Family", "Kids") for g in genres)
    return False

def main():
    catalog = json.load(open(CATALOG, encoding="utf-8"))
    for item in catalog:
        item.setdefault("tier", "audited")
    have = {norm(c["title"]) for c in catalog}
    ids  = {c["id"] for c in catalog}

    posters = json.load(open(POSTERS, encoding="utf-8")) if os.path.exists(POSTERS) else {}
    added, skipped = 0, 0

    for name in sorted(os.listdir(HARVEST)):
        if not name.startswith("extra-"):
            continue
        for line in open(os.path.join(HARVEST, name), encoding="utf-8"):
            f = line.rstrip("\n").split("\t")
            if len(f) < 17:
                continue
            (sid, kind, title, year, runtime, seasons, genres, cert, brand,
             energy, warmth, tags, _kid, lang, poster, tmdb, overview) = f[:17]
            if norm(title) in have:
                skipped += 1
                continue
            while sid in ids:
                sid += "-" + tmdb
            gs = [g for g in genres.split("|") if g]
            item = {
                "id": sid, "title": title, "kind": kind, "year": int(year),
                "runtime": int(runtime or 0), "seasons": int(seasons or 0),
                "genres": gs, "certification": cert, "brand": brand,
                "energy": int(energy), "warmth": int(warmth),
                "tone_tags": [t for t in tags.split("|") if t],
                "overview": overview,
                "poster_url": IMG + poster if poster else None,
                "tmdb_id": int(tmdb) if tmdb.isdigit() else None,
                "kid_safe": kid_safe(cert, gs),
                "original_language": lang,
                "dub_available": lang == "en" or "Anime" in gs,
                "tier": "derived",
            }
            catalog.append(item)
            have.add(norm(title)); ids.add(sid)
            if poster:
                posters[sid] = IMG + poster
            added += 1

    json.dump(catalog, open(CATALOG, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(posters, open(POSTERS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    audited = sum(1 for c in catalog if c.get("tier") == "audited")
    kids    = sum(1 for c in catalog if c["kid_safe"])
    anime   = sum(1 for c in catalog if "Anime" in c["genres"])
    print(f"added {added}, skipped {skipped} already present")
    print(f"catalogue now {len(catalog)}: {audited} audited, {len(catalog)-audited} derived")
    print(f"  movies {sum(1 for c in catalog if c['kind']=='movie')} · "
          f"series {sum(1 for c in catalog if c['kind']=='series')} · "
          f"shorts {sum(1 for c in catalog if c['kind']=='short')}")
    print(f"  kid-safe {kids} · anime {anime}")

if __name__ == "__main__":
    main()
