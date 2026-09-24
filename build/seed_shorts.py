#!/usr/bin/env python3
"""Add Disney and Pixar animated shorts to the catalogue.

A quiz option the data cannot answer is the defect this project keeps finding, so
'just a few minutes' had to come with something to return. Sixteen shorts, all on
Disney+, all animated — which is also why the shorts chip only appears when the
viewer has not asked for live action.

Energy, warmth and tone tags are hand-set here, the same derived layer the rest of
the catalogue carries. Runtimes are rounded to the nearest minute.
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, "data", "catalog.json")

SHORTS = [
    # id, title, year, runtime, brand, cert, genres, energy, warmth, tone_tags, overview
    ("for-the-birds", "For the Birds", 2000, 3, "Pixar", "G", ["Animation", "Comedy", "Family"],
     3, 4,
     ["slapstick", "near-silent", "very-short", "comedic"],
     "A row of small birds on a telephone wire take against a larger one who wants to join them."),
    ("presto", "Presto", 2008, 5, "Pixar", "G", ["Animation", "Comedy", "Family"],
     4, 4,
     ["slapstick", "near-silent", "very-short", "comedic"],
     "A stage magician who forgets to feed his rabbit loses control of his own act."),
    ("day-and-night", "Day & Night", 2010, 6, "Pixar", "G", ["Animation", "Comedy", "Family"],
     3, 4,
     ["inventive", "near-silent", "very-short", "whimsical"],
     "Two figures, one holding daylight and one holding darkness, learn what the other can see."),
    ("la-luna", "La Luna", 2011, 7, "Pixar", "G", ["Animation", "Family", "Fantasy"],
     2, 5,
     ["gentle", "whimsical", "very-short", "father-son", "storybook"],
     "A boy joins his father and grandfather at sea for the family trade of sweeping the moon."),
    ("paperman", "Paperman", 2012, 7, "Disney", "G", ["Animation", "Romance", "Family"],
     3, 5,
     ["romance", "near-silent", "very-short", "longing", "new-york"],
     "A clerk in mid-century Manhattan throws paper planes at the window of a woman he met once."),
    ("feast", "Feast", 2014, 6, "Disney", "G", ["Animation", "Romance", "Comedy", "Family"],
     3, 5,
     ["food", "gentle", "very-short", "romance", "animals"],
     "A Boston terrier follows his owner's love life through the meals he is fed."),
    ("lava", "Lava", 2014, 7, "Pixar", "G", ["Animation", "Musical", "Romance", "Family"],
     2, 5,
     ["music-forward", "gentle", "very-short", "island", "longing"],
     "A lonely volcano sings across the ocean for someone to share it with."),
    ("piper", "Piper", 2016, 6, "Pixar", "G", ["Animation", "Family", "Nature"],
     3, 5,
     ["animals", "gentle", "very-short", "gorgeous-animation", "growing-up"],
     "A sandpiper chick learns to face the surf and find food on her own."),
    ("lou", "Lou", 2017, 7, "Pixar", "G", ["Animation", "Comedy", "Family"],
     3, 4,
     ["whimsical", "very-short", "growing-up", "misfit"],
     "Something living in a playground lost-and-found box takes on the boy who steals from it."),
    ("bao", "Bao", 2018, 8, "Pixar", "G", ["Animation", "Drama", "Family"],
     2, 5,
     ["food", "tearjerker", "very-short", "mother-daughter", "immigrant-story"],
     "A dumpling comes to life and gives a Chinese-Canadian mother a second child to raise."),
    ("purl", "Purl", 2019, 9, "Pixar", "TV-G", ["Animation", "Comedy"],
     3, 4,
     ["workplace", "satire", "very-short", "misfit"],
     "A ball of yarn starts a job at a finance firm where nobody else is made of wool."),
    ("float", "Float", 2019, 7, "Pixar", "TV-G", ["Animation", "Drama", "Family"],
     2, 4,
     ["parenthood", "tearjerker", "very-short", "father-son"],
     "A father discovers his son can float, and hides it from the neighbourhood."),
    ("burrow", "Burrow", 2020, 6, "Pixar", "G", ["Animation", "Comedy", "Family"],
     3, 5,
     ["animals", "gentle", "very-short", "found-family", "whimsical"],
     "A young rabbit digging her first home keeps hitting her neighbours' burrows."),
    ("us-again", "Us Again", 2021, 7, "Disney", "G", ["Animation", "Musical", "Romance"],
     4, 5,
     ["dance", "music-forward", "very-short", "near-silent", "tender"],
     "An elderly man and his wife dance through a rainstorm that gives them back their younger selves."),
    ("far-from-the-tree", "Far From the Tree", 2021, 8, "Disney", "G", ["Animation", "Family", "Drama"],
     3, 4,
     ["parents-and-children", "very-short", "animals", "generational"],
     "A raccoon parent's caution and a curious kit repeat themselves across two generations."),
    ("twenty-something", "Twenty Something", 2021, 9, "Pixar", "TV-G", ["Animation", "Comedy", "Drama"],
     3, 4,
     ["coming-of-age", "surreal", "very-short", "anxiety"],
     "A woman turning twenty-two feels like three children stacked inside one adult body."),
]

def main():
    catalog = json.load(open(PATH, encoding="utf-8"))
    have = {c["id"] for c in catalog}
    added = 0
    for cid, title, year, runtime, brand, cert, genres, energy, warmth, tags, overview in SHORTS:
        if cid in have:
            continue
        catalog.append({
            "id": cid, "title": title, "kind": "short", "year": year,
            "runtime": runtime, "seasons": 0,
            "genres": genres,
            "certification": cert, "brand": brand,
            "energy": energy, "warmth": warmth,
            "tone_tags": tags, "overview": overview,
            "poster_url": None, "tmdb_id": None,
            "kid_safe": True, "original_language": "en", "dub_available": True,
        })
        added += 1
    json.dump(catalog, open(PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"shorts added: {added} · catalogue now {len(catalog)} titles")

if __name__ == "__main__":
    main()
