import json
import logging
import os
import re
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

logging.basicConfig(level=logging.INFO)

import oracledb
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
# Database connection (Snowflake or Oracle Cloud)
# ---------------------------------------------------------------------------

DB_BACKEND = os.getenv("DB_BACKEND", "snowflake").lower()

_conn = None


def _get_conn():
    global _conn
    if _conn is not None:
        return _conn

    if DB_BACKEND == "oracle":
        _conn = oracledb.connect(
            user=os.getenv("ORACLE_USER"),
            password=os.getenv("ORACLE_PASSWORD"),
            dsn=os.getenv("ORACLE_DSN"),
            config_dir=os.getenv("ORACLE_WALLET_DIR"),
            wallet_location=os.getenv("ORACLE_WALLET_DIR"),
            wallet_password=os.getenv("ORACLE_WALLET_PASSWORD"),
        )
    else:
        _conn = snowflake.connector.connect(
            account=os.getenv("SNOWFLAKE_ACCOUNT"),
            user=os.getenv("SNOWFLAKE_USER"),
            password=os.getenv("SNOWFLAKE_PASSWORD"),
            warehouse=os.getenv("SNOWFLAKE_WAREHOUSE"),
            database=os.getenv("SNOWFLAKE_DATABASE"),
            schema=os.getenv("SNOWFLAKE_SCHEMA"),
            role=os.getenv("SNOWFLAKE_ROLE"),
            autocommit=True,
        )

    return _conn


def _sf_query(sql: str, params=None) -> list[dict]:
    cur = _get_conn().cursor()
    try:
        cur.execute(sql, params or ())
        cols = [c[0] for c in cur.description] if cur.description else []
        return [dict(zip(cols, row)) for row in cur.fetchall()]
    finally:
        cur.close()


def _ml_data_of(movieid: str) -> dict:
    rows = _oracle_query(
        "SELECT * FROM MOVIE_ML WHERE MOVIEID = :mid", {"mid": movieid}
    )
    return rows[0] if rows else {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _imdb_id_of(row: dict) -> str:
    for field in ("IMDB_ID", "IMDBID", "IMDB_TITLE_ID"):
        val = (row.get(field) or "").strip()
        if val:
            return val.lower()
    return ""


def _clean(val) -> str:
    v = (str(val) if val is not None else "").strip()
    return "" if v in ("N/A", "") else v


def _genres_imdb(movieid: str) -> list[str]:
    return [r["GENRE"] for r in _oracle_query(
        "SELECT GENRE FROM MOVIE_IMDB_GENRE WHERE MOVIEID = :mid", {"mid": movieid})]


def _genres_ml(movieid: str) -> list[str]:
    return [r["GENRE"] for r in _oracle_query(
        "SELECT GENRE FROM MOVIE_ML_GENRE WHERE MOVIEID = :mid", {"mid": movieid})]


def _tags(movieid: str) -> list[dict]:
    rows = _oracle_query(
        "SELECT TAG, COUNT FROM MOVIE_TAG WHERE MOVIEID = :mid"
        " ORDER BY COUNT DESC FETCH FIRST 20 ROWS ONLY",
        {"mid": movieid},
    )
    return [{"tag": r["TAG"], "count": int(r["COUNT"] or 0)} for r in rows]


def _ratings(movieid: str, row: dict) -> list[dict]:
    result: list[dict] = []
    ml = _ml_data_of(movieid)

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


def _people_query(movieid: str, role_table: str, person_table: str, id_col: str) -> list[dict]:
    rows = _oracle_query(
        f"SELECT p.NAME, p.GENDER, p.RACE, p.NATIONALITY, p.ETHNICITY, p.RELIGION"
        f" FROM {person_table} p JOIN {role_table} r ON p.{id_col} = r.{id_col}"
        f" WHERE r.MOVIEID = :mid",
        {"mid": movieid},
    )
    result = []
    for p in rows:
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
        "id":          movieid,
        "title":       _clean(r.get("TITLE", "")),
        "year":        _clean(r.get("YEAR", "")),
        "released":    _clean(r.get("RELEASED", "")),
        "runtime":     _clean(r.get("RUNTIME", "")),
        "country":     _clean(r.get("COUNTRY", "")),
        "language":    _clean(r.get("LANGUAGE", "")),
        "genre":       _clean(r.get("GENRE", "")),
        "director":    _clean(r.get("DIRECTOR", "")),
        "writer":      _clean(r.get("WRITER", "")),
        "cast":        _clean(r.get("ACTORS", "")),
        "plot":        _clean(r.get("PLOT", "")),
        "poster":      _clean(r.get("POSTER", "")),
        "awards":      _clean(r.get("AWARDS", "")),
        "ratings":     _ratings(movieid, r),
        "directors":   _people_query(movieid, "MOVIE_DIRECTOR", "DIRECTOR", "DIRECTORID"),
        "writers":     _people_query(movieid, "MOVIE_WRITER",   "WRITER",   "WRITERID"),
        "genres_imdb": _genres_imdb(movieid),
        "genres_ml":   _genres_ml(movieid),
        "tags":        _tags(movieid),
        "imdb_id":     imdb_id,
    }


def _build_list_item(movieid: str, r: dict) -> dict:
    ml = _ml_data_of(movieid)
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


def _do_search(query: str, page: int = 1, per_page: int = 20) -> tuple[list, int]:
    q = query.strip()

    # 1. Exact numeric MOVIEID
    if re.match(r"^\d+$", q):
        rows = _oracle_query("SELECT * FROM MOVIE_IMDB WHERE MOVIEID = :mid", {"mid": int(q)})
        return [(str(r["MOVIEID"]), r) for r in rows], len(rows)

    # 2. IMDB tt-id (e.g. tt0076759)
    if re.match(r"^tt\d+", q, re.IGNORECASE):
        rows = _oracle_query(
            "SELECT * FROM MOVIE_IMDB WHERE LOWER(IMDB_ID) = :imdb",
            {"imdb": q.lower()},
        )
        return [(str(r["MOVIEID"]), r) for r in rows], len(rows)

    # 3. Title substring — count + paginated query
    total = (_oracle_query(
        "SELECT COUNT(*) AS CNT FROM MOVIE_IMDB WHERE UPPER(TITLE) LIKE UPPER(:q)",
        {"q": f"%{q}%"},
    ) or [{"CNT": 0}])[0]["CNT"]

    offset = (page - 1) * per_page
    rows = _oracle_query(
        "SELECT * FROM MOVIE_IMDB WHERE UPPER(TITLE) LIKE UPPER(:q)"
        " ORDER BY TITLE OFFSET :off ROWS FETCH NEXT :n ROWS ONLY",
        {"q": f"%{q}%", "off": offset, "n": per_page},
    )
    return [(str(r["MOVIEID"]), r) for r in rows], int(total)


# ---------------------------------------------------------------------------
# Oracle-specific query (named bind variables)
# ---------------------------------------------------------------------------

def _oracle_query(sql: str, params: dict | None = None) -> list[dict]:
    cur = _get_conn().cursor()
    try:
        cur.execute(sql, params or {})
        cols = [c[0] for c in cur.description] if cur.description else []
        return [dict(zip(cols, row)) for row in cur.fetchall()]
    finally:
        cur.close()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/")
async def index():
    return FileResponse("index.html")


@app.get("/status")
async def status():
    return JSONResponse({"status": "ok"})


@app.get("/search")
async def search(q: str = "", page: int = 1, per_page: int = 20):
    if not q.strip():
        return JSONResponse({"total": 0, "page": 1, "per_page": per_page, "movies": []})

    page_items, total = _do_search(q, page, per_page)

    return JSONResponse({
        "total":    total,
        "page":     page,
        "per_page": per_page,
        "movies":   [_build_list_item(mid, r) for mid, r in page_items],
    })


@app.get("/movie/{movieid}")
async def movie_detail(movieid: str):
    rows = _oracle_query("SELECT * FROM MOVIE_IMDB WHERE MOVIEID = :mid", {"mid": int(movieid)})
    if not rows:
        return JSONResponse({})
    return JSONResponse(_build_movie_payload(movieid, rows[0]))


@app.get("/subtitle-data/{imdbid}/themes")
async def subtitle_data_themes(imdbid: str):
    rows = _oracle_query(
        "SELECT IDIOM, THEME, WORD, COUNT, DIALOGUES FROM RS.SUBTITLE_THEME"
        " WHERE IMDB = :imdb ORDER BY IDIOM, THEME, COUNT DESC",
        {"imdb": imdbid.lower()},
    )
    result: dict = {}
    for r in rows:
        (result
         .setdefault(r["IDIOM"], {})
         .setdefault(r["THEME"], [])
         .append({"word": r["WORD"], "count": r["COUNT"], "dialogues": r["DIALOGUES"] or ""}))
    return JSONResponse(result)


@app.get("/subtitle-data/{imdbid}/geo")
async def subtitle_data_geo(imdbid: str):
    rows_en = _oracle_query(
        "SELECT IDIOM, LOCATION AS ENTITY, COUNT, DIALOGUES FROM RS.SUBTITLE_GEO"
        " WHERE IMDB = :imdb AND IDIOM = 'EN' ORDER BY COUNT DESC",
        {"imdb": imdbid.lower()},
    )
    rows_pt = _oracle_query(
        "SELECT IDIOM, ENTITY, COUNT, DIALOGUES FROM RS.SUBTITLE_BERT"
        " WHERE IMDB = :imdb AND ENTITY_TYPE = 'LOC' ORDER BY COUNT DESC",
        {"imdb": imdbid.lower()},
    )
    result: dict = {}
    for r in rows_en + rows_pt:
        result.setdefault(r["IDIOM"], []).append(
            {"location": r["ENTITY"], "count": r["COUNT"], "dialogues": r["DIALOGUES"] or ""}
        )
    return JSONResponse(result)


@app.get("/subtitle-data/{imdbid}/initcap")
async def subtitle_data_initcap(imdbid: str):
    rows = _oracle_query(
        "SELECT IDIOM, WORD, COUNT, DIALOGUES FROM RS.SUBTITLE_INITCAP"
        " WHERE IMDB = :imdb ORDER BY IDIOM, COUNT DESC",
        {"imdb": imdbid.lower()},
    )
    result: dict = {}
    for r in rows:
        result.setdefault(r["IDIOM"], []).append(
            {"word": r["WORD"], "count": r["COUNT"], "dialogues": r["DIALOGUES"] or ""}
        )
    return JSONResponse(result)


@app.get("/subtitle-data/{imdbid}/regions")
async def subtitle_data_regions(imdbid: str):
    rows = _oracle_query(
        "SELECT IDIOM, REGION, WORD, COUNT, DIALOGUES FROM RS.SUBTITLE_REGION"
        " WHERE IMDB = :imdb ORDER BY IDIOM, REGION, COUNT DESC",
        {"imdb": imdbid.lower()},
    )
    result: dict = {}
    for r in rows:
        (result
         .setdefault(r["IDIOM"], {})
         .setdefault(r["REGION"], [])
         .append({"word": r["WORD"], "count": r["COUNT"], "dialogues": r["DIALOGUES"] or ""}))
    return JSONResponse(result)


_MINORITY_TABLES = {
    "racism":     "RS.SUBTITLE_RACISM",
    "women":      "RS.SUBTITLE_WOMEN",
    "xenophobia": "RS.SUBTITLE_XENOPHOBIA",
    "religion":   "RS.SUBTITLE_RELIGION",
    "ableism":    "RS.SUBTITLE_ABLEISM",
}


@app.get("/minority-data/{imdbid}/{topic}")
async def minority_data(imdbid: str, topic: str):
    table = _MINORITY_TABLES.get(topic.lower())
    if not table:
        return JSONResponse({})
    rows = _oracle_query(
        f"SELECT IDIOM, CATEGORY, WORD, COUNT, DIALOGUES FROM {table}"
        " WHERE IMDB = :imdb ORDER BY IDIOM, CATEGORY, COUNT DESC",
        {"imdb": imdbid.lower()},
    )
    result: dict = {}
    for r in rows:
        (result
         .setdefault(r["IDIOM"], {})
         .setdefault(r["CATEGORY"], [])
         .append({"word": r["WORD"], "count": r["COUNT"], "dialogues": r["DIALOGUES"] or ""}))
    return JSONResponse(result)


def _subtitle_path(imdbid: str, lang: str) -> Path:
    imdb = imdbid.lower()
    return Path("subtitle") / imdb[:4] / imdb[:6] / f"{imdb}_{lang.upper()}.srt"


@app.get("/subtitle/{imdbid}/{lang}/count")
async def subtitle_dialogue_count(imdbid: str, lang: str):
    path = _subtitle_path(imdbid, lang)
    if not path.exists():
        return JSONResponse({"count": 0, "available": False})
    text = path.read_text(encoding="utf-8")
    count = len(re.findall(r"(?m)^\d+$", text))
    return JSONResponse({"count": count, "available": True})


@app.get("/subtitle/{imdbid}/{lang}")
async def subtitle_file(imdbid: str, lang: str):
    path = _subtitle_path(imdbid, lang)
    if not path.exists():
        return PlainTextResponse("", status_code=404)
    return PlainTextResponse(path.read_text(encoding="utf-8"))
