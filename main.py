import csv
import json
import os
import re
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import snowflake.connector
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.responses import JSONResponse as _JSONResponse
from fastapi.staticfiles import StaticFiles


def _json_default(o):
    if isinstance(o, (date, datetime)):
        return o.isoformat()
    if isinstance(o, Decimal):
        return float(o)
    return str(o)


class JSONResponse(_JSONResponse):
    def render(self, content) -> bytes:
        return json.dumps(
            content,
            ensure_ascii=False,
            allow_nan=False,
            indent=None,
            separators=(",", ":"),
            default=_json_default,
        ).encode("utf-8")


load_dotenv()

app = FastAPI()
app.mount("/css", StaticFiles(directory="css"), name="css")
app.mount("/js",  StaticFiles(directory="js"),  name="js")

# ---------------------------------------------------------------------------
# Snowflake connection
# ---------------------------------------------------------------------------

_sf_conn = None


def _get_conn():
    global _sf_conn
    if _sf_conn is None:
        _sf_conn = snowflake.connector.connect(
            account=os.getenv("SNOWFLAKE_ACCOUNT"),
            user=os.getenv("SNOWFLAKE_USER"),
            password=os.getenv("SNOWFLAKE_PASSWORD"),
            warehouse=os.getenv("SNOWFLAKE_WAREHOUSE"),
            database=os.getenv("SNOWFLAKE_DATABASE"),
            schema=os.getenv("SNOWFLAKE_SCHEMA"),
            role=os.getenv("SNOWFLAKE_ROLE"),
            autocommit=True,
        )
    return _sf_conn


def _sf_query(sql: str, params=None) -> list[dict]:
    cur = _get_conn().cursor()
    try:
        cur.execute(sql, params or ())
        cols = [c[0] for c in cur.description] if cur.description else []
        return [dict(zip(cols, row)) for row in cur.fetchall()]
    finally:
        cur.close()


# ---------------------------------------------------------------------------
# In-memory data stores
# ---------------------------------------------------------------------------

_directors:       dict[str, dict]       = {}
_writers_dict:    dict[str, dict]       = {}
_movie_dirs:      dict[str, list]       = {}
_movie_wris:      dict[str, list]       = {}
_ml_data:         dict[str, dict]       = {}
_imdb_genres:     dict[str, list[str]]  = {}
_ml_genres:       dict[str, list[str]]  = {}
_movie_tags:      dict[str, list[dict]] = {}
_imdb_rows:       dict[str, dict]       = {}
_movie_languages: dict[str, list[str]]  = {}

# subtitle data: imdb → idiom → ...
_theme_data:   dict = {}   # ... → theme  → [(word, count, dialogues)]
_initcap_data: dict = {}   # ... → [(word, count, dialogues)]
_geo_data:     dict = {}   # ... → [(location, count, dialogues)]
_reg_data:     dict = {}   # ... → region → [(word, count, dialogues)]

# secondary indexes
_imdbid_to_movieid: dict[str, str]   = {}   # "tt0076759" → "1"
_title_lower_index: list[tuple]      = []   # [(title_lower, movieid), ...]


@app.on_event("startup")
def _load_static_data():
    _directors.update({r["DIRECTORID"]: r for r in _sf_query("SELECT * FROM DIRECTOR")})
    _writers_dict.update({r["WRITERID"]: r for r in _sf_query("SELECT * FROM WRITER")})

    for _r in _sf_query("SELECT MOVIEID, DIRECTORID FROM MOVIE_DIRECTOR"):
        _movie_dirs.setdefault(str(_r["MOVIEID"]), []).append(_r["DIRECTORID"])

    for _r in _sf_query("SELECT MOVIEID, WRITERID FROM MOVIE_WRITER"):
        _movie_wris.setdefault(str(_r["MOVIEID"]), []).append(_r["WRITERID"])

    _ml_data.update({str(r["MOVIEID"]): r for r in _sf_query("SELECT * FROM MOVIE_ML")})

    for _r in _sf_query("SELECT MOVIEID, GENRE FROM MOVIE_IMDB_GENRE"):
        _imdb_genres.setdefault(str(_r["MOVIEID"]), []).append(_r["GENRE"])

    for _r in _sf_query("SELECT MOVIEID, GENRE FROM MOVIE_ML_GENRE"):
        _ml_genres.setdefault(str(_r["MOVIEID"]), []).append(_r["GENRE"])

    for _r in _sf_query("SELECT MOVIEID, TAG, COUNT FROM MOVIE_TAG"):
        try:
            count = int(_r["COUNT"])
        except (ValueError, KeyError):
            count = 0
        _movie_tags.setdefault(str(_r["MOVIEID"]), []).append({"tag": _r["TAG"], "count": count})

    for _r in _sf_query("SELECT * FROM MOVIE_IMDB"):
        mid = str(_r.get("MOVIEID") or "").strip()
        if not mid:
            continue
        _imdb_rows[mid] = _r

        # Build IMDB ID index (field may be called IMDB_ID, IMDBID, or IMDB_TITLE_ID)
        for _field in ("IMDB_ID", "IMDBID", "IMDB_TITLE_ID"):
            val = (_r.get(_field) or "").strip().lower()
            if val:
                _imdbid_to_movieid[val] = mid
                break

    for _r in _sf_query("SELECT MOVIEID, LANGUAGE FROM MOVIE_LANGUAGE"):
        _movie_languages.setdefault(str(_r["MOVIEID"]), []).append(_r["LANGUAGE"])

    # Build title index
    _title_lower_index.clear()
    for mid, r in _imdb_rows.items():
        title = (r.get("TITLE") or "").strip()
        if title:
            _title_lower_index.append((title.lower(), mid))

    # Load subtitle TSV files
    data_dir = Path("data")

    def _int(v):
        try:
            return int(v)
        except (ValueError, TypeError):
            return 0

    with open(data_dir / "theme_occurrences.tsv", newline="", encoding="utf-8") as _f:
        for _row in csv.DictReader(_f, delimiter="\t"):
            (_theme_data
             .setdefault(_row["IMDB"].strip().lower(), {})
             .setdefault(_row["IDIOM"].strip(), {})
             .setdefault(_row["THEME"].strip(), [])
             .append((_row["WORD"].strip(), _int(_row.get("COUNT")), _row.get("DIALOGUES", "").strip())))

    with open(data_dir / "initcap_occurrences.tsv", newline="", encoding="utf-8") as _f:
        for _row in csv.DictReader(_f, delimiter="\t"):
            (_initcap_data
             .setdefault(_row["IMDB"].strip().lower(), {})
             .setdefault(_row["IDIOM"].strip(), [])
             .append((_row["WORD"].strip(), _int(_row.get("COUNT")), _row.get("DIALOGUES", "").strip())))

    with open(data_dir / "geo_occurrences.tsv", newline="", encoding="utf-8") as _f:
        for _row in csv.DictReader(_f, delimiter="\t"):
            (_geo_data
             .setdefault(_row["IMDB"].strip().lower(), {})
             .setdefault(_row["IDIOM"].strip(), [])
             .append((_row["LOCATION"].strip(), _int(_row.get("COUNT")), _row.get("DIALOGUES", "").strip())))

    with open(data_dir / "reg_occurrences.tsv", newline="", encoding="utf-8") as _f:
        for _row in csv.DictReader(_f, delimiter="\t"):
            (_reg_data
             .setdefault(_row["IMDB"].strip().lower(), {})
             .setdefault(_row["IDIOM"].strip(), {})
             .setdefault(_row["REGION"].strip(), [])
             .append((_row["WORD"].strip(), _int(_row.get("COUNT")), _row.get("DIALOGUES", "").strip())))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _imdb_id_of(row: dict) -> str:
    for field in ("IMDB_ID", "IMDBID", "IMDB_TITLE_ID"):
        val = (row.get(field) or "").strip()
        if val:
            return val.lower()
    return ""


def _subtitle_themes(imdb_id: str) -> dict:
    out: dict = {}
    for idiom, themes in _theme_data.get(imdb_id, {}).items():
        sorted_themes = sorted(themes.items(), key=lambda kv: sum(w[1] for w in kv[1]), reverse=True)
        out[idiom] = {
            theme: sorted([{"word": w, "count": c, "dialogues": d} for w, c, d in words],
                          key=lambda x: x["count"], reverse=True)
            for theme, words in sorted_themes
        }
    return out


def _subtitle_initcap(imdb_id: str) -> dict:
    out: dict = {}
    for idiom, words in _initcap_data.get(imdb_id, {}).items():
        out[idiom] = sorted([{"word": w, "count": c, "dialogues": d} for w, c, d in words],
                            key=lambda x: x["count"], reverse=True)
    return out


def _subtitle_reg(imdb_id: str) -> dict:
    out: dict = {}
    for idiom, regions in _reg_data.get(imdb_id, {}).items():
        sorted_regions = sorted(regions.items(), key=lambda kv: sum(w[1] for w in kv[1]), reverse=True)
        out[idiom] = {
            region: sorted([{"word": w, "count": c, "dialogues": d} for w, c, d in words],
                           key=lambda x: x["count"], reverse=True)
            for region, words in sorted_regions
        }
    return out


def _subtitle_geo(imdb_id: str) -> dict:
    out: dict = {}
    for idiom, locs in _geo_data.get(imdb_id, {}).items():
        out[idiom] = sorted([{"location": loc, "count": c, "dialogues": d} for loc, c, d in locs],
                            key=lambda x: x["count"], reverse=True)
    return out


def _clean(val) -> str:
    v = (str(val) if val is not None else "").strip()
    return "" if v in ("N/A", "") else v


def _genres_imdb(movieid: str) -> list[str]:
    return _imdb_genres.get(movieid, [])


def _genres_ml(movieid: str) -> list[str]:
    return _ml_genres.get(movieid, [])


def _tags(movieid: str) -> list[dict]:
    return sorted(_movie_tags.get(movieid, []), key=lambda x: x["count"], reverse=True)[:20]


def _ratings(movieid: str, row: dict) -> list[dict]:
    result: list[dict] = []
    ml = _ml_data.get(movieid, {})

    ml_score = _clean(ml.get("RATING_ML"))
    if ml_score:
        entry: dict = {"source": "Movie Lens", "score": f"{float(ml_score):.1f}/5"}
        ml_votes = _clean(ml.get("VOTES_ML"))
        if ml_votes:
            entry["votes"] = ml_votes
        result.append(entry)

    imdb_score = _clean(row.get("IMDBRATING"))
    if imdb_score:
        entry = {"source": "IMDb", "score": f"{float(imdb_score):.1f}/10"}
        imdb_votes = _clean(row.get("IMDBVOTES"))
        if imdb_votes:
            entry["votes"] = imdb_votes
        result.append(entry)

    rt = _clean(row.get("RTRATING"))
    if rt:
        result.append({"source": "Rotten Tomatoes", "score": f"{float(rt):.0f}/100"})

    mc = _clean(row.get("MCRATING"))
    if mc:
        result.append({"source": "Metacritic", "score": f"{float(mc):.0f}/100"})

    return result


def _people(movieid: str, role_map: dict, person_dict: dict) -> list[dict]:
    result = []
    for pid in role_map.get(movieid, []):
        p = person_dict.get(pid)
        if not p:
            continue
        entry = {}
        for key, col in [("name", "NAME"), ("gender", "GENDER"), ("race", "RACE"),
                          ("nationality", "NATIONALITY"), ("ethnicity", "ETHNICITY"),
                          ("religion", "RELIGION")]:
            val = (p.get(col) or "").strip()
            if val and val != "N/A":
                entry[key] = val
        if entry.get("name"):
            result.append(entry)
    return result


def _build_movie_payload(movieid: str, r: dict) -> dict:
    imdb_id = _imdb_id_of(r)
    return {
        "id":               movieid,
        "title":            _clean(r.get("TITLE", "")),
        "year":             _clean(r.get("YEAR", "")),
        "released":         _clean(r.get("RELEASED", "")),
        "runtime":          _clean(r.get("RUNTIME", "")),
        "country":          _clean(r.get("COUNTRY", "")),
        "language":         _clean(r.get("LANGUAGE", "")),
        "genre":            _clean(r.get("GENRE", "")),
        "director":         _clean(r.get("DIRECTOR", "")),
        "writer":           _clean(r.get("WRITER", "")),
        "cast":             _clean(r.get("ACTORS", "")),
        "plot":             _clean(r.get("PLOT", "")),
        "poster":           _clean(r.get("POSTER", "")),
        "awards":           _clean(r.get("AWARDS", "")),
        "ratings":          _ratings(movieid, r),
        "directors":        _people(movieid, _movie_dirs, _directors),
        "writers":          _people(movieid, _movie_wris, _writers_dict),
        "genres_imdb":      _genres_imdb(movieid),
        "genres_ml":        _genres_ml(movieid),
        "tags":             _tags(movieid),
        "imdb_id":          imdb_id,
        "subtitle_themes":  _subtitle_themes(imdb_id),
        "subtitle_reg":     _subtitle_reg(imdb_id),
        "subtitle_initcap": _subtitle_initcap(imdb_id),
        "subtitle_geo":     _subtitle_geo(imdb_id),
    }


def _build_list_item(movieid: str, r: dict) -> dict:
    ml = _ml_data.get(movieid, {})
    imdb_score = _clean(r.get("IMDBRATING"))
    ml_score   = _clean(ml.get("RATING_ML"))
    return {
        "id":      movieid,
        "title":   _clean(r.get("TITLE", "")),
        "year":    _clean(r.get("YEAR", "")),
        "genre":   _clean(r.get("GENRE", "")),
        "director":_clean(r.get("DIRECTOR", "")),
        "poster":  _clean(r.get("POSTER", "")),
        "imdb":    f"{float(imdb_score):.1f}" if imdb_score else "",
        "ml":      f"{float(ml_score):.1f}"   if ml_score   else "",
    }


def _do_search(query: str) -> list[tuple[str, dict]]:
    q = query.strip()

    # 1. Exact numeric MOVIEID
    if re.match(r"^\d+$", q):
        r = _imdb_rows.get(q)
        return [(q, r)] if r else []

    # 2. IMDB tt-id  (e.g. tt0076759)
    if re.match(r"^tt\d+", q, re.IGNORECASE):
        mid = _imdbid_to_movieid.get(q.lower())
        if mid:
            return [(mid, _imdb_rows[mid])]
        return []

    # 3. Title substring (case-insensitive), sorted by title
    ql = q.lower()
    matches = [(mid, _imdb_rows[mid]) for title_l, mid in _title_lower_index if ql in title_l]
    matches.sort(key=lambda x: x[1].get("TITLE", "").lower())
    return matches


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/")
async def index():
    return FileResponse("index.html")


@app.get("/search")
async def search(q: str = "", page: int = 1, per_page: int = 20):
    if not q.strip():
        return JSONResponse({"total": 0, "page": 1, "per_page": per_page, "movies": []})

    all_matches = _do_search(q)
    total = len(all_matches)
    start = (page - 1) * per_page
    page_slice = all_matches[start:start + per_page]

    return JSONResponse({
        "total":    total,
        "page":     page,
        "per_page": per_page,
        "movies":   [_build_list_item(mid, r) for mid, r in page_slice],
    })


@app.get("/movie/{movieid}")
async def movie_detail(movieid: str):
    r = _imdb_rows.get(movieid)
    if not r:
        return JSONResponse({})
    return JSONResponse(_build_movie_payload(movieid, r))


@app.get("/subtitle/{imdbid}/{lang}")
async def subtitle_file(imdbid: str, lang: str):
    path = Path("subtitle") / f"{imdbid.lower()}_{lang.upper()}.srt"
    if not path.exists():
        return PlainTextResponse("", status_code=404)
    return PlainTextResponse(path.read_text(encoding="utf-8"))
