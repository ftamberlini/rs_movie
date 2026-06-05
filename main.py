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
        "imdb_id": _imdb_id_of(r),
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
            "SELECT * FROM MOVIE_IMDB WHERE LOWER(IMDBID) = :imdb",
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
    global _conn

    def _run(conn):
        cur = conn.cursor()
        try:
            cur.execute(sql, params or {})
            cols = [c[0] for c in cur.description] if cur.description else []
            return [dict(zip(cols, row)) for row in cur.fetchall()]
        finally:
            cur.close()

    try:
        return _run(_get_conn())
    except (oracledb.InterfaceError, oracledb.DatabaseError) as e:
        # DPY-1001: not connected  |  DPY-4011: connection closed by server
        if any(code in str(e) for code in ("DPY-1001", "DPY-4011")):
            logging.warning("Conexão perdida (%s), reconectando...", e)
            _conn = None
            return _run(_get_conn())
        raise


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/")
async def index():
    return FileResponse("index.html")


@app.get("/diversity/{movieid}")
async def crew_diversity(movieid: str):
    mid = int(movieid)

    movie_row = _oracle_query("SELECT YEAR FROM MOVIE_IMDB WHERE MOVIEID = :mid", {"mid": mid})
    try:
        movie_year = int(movie_row[0]["YEAR"]) if movie_row else None
    except (TypeError, ValueError):
        movie_year = None

    # Queries incluem campos OUTPUT_* como fonte secundária
    dir_rows = _oracle_query("""
        SELECT d.GENDER  AS GENDER_LLM, o.GENDER   AS GENDER_API,
               d.RACE, d.NATIONALITY, d.ETHNICITY,
               d.BIRTHYEAR, o.BIRTHDATE, o.BIRTHLOCATION
        FROM DIRECTOR d
        JOIN MOVIE_DIRECTOR md ON d.DIRECTORID = md.DIRECTORID
        LEFT JOIN OUTPUT_DIRECTOR o ON o.DIRECTORID = d.DIRECTORID
        WHERE md.MOVIEID = :mid
    """, {"mid": mid})

    wri_rows = _oracle_query("""
        SELECT w.GENDER  AS GENDER_LLM, o.GENDER   AS GENDER_API,
               w.RACE, w.NATIONALITY, w.ETHNICITY,
               w.BIRTHYEAR, o.BIRTHDATE, o.BIRTHLOCATION
        FROM WRITER w
        JOIN MOVIE_WRITER mw ON w.WRITERID = mw.WRITERID
        LEFT JOIN OUTPUT_WRITER o ON o.WRITERID = w.WRITERID
        WHERE mw.MOVIEID = :mid
    """, {"mid": mid})

    cast_rows = _oracle_query("""
        SELECT NULL AS GENDER_LLM, o.GENDER AS GENDER_API,
               NULL AS RACE, NULL AS NATIONALITY, NULL AS ETHNICITY,
               c.BIRTHYEAR, o.BIRTHDATE, o.BIRTHLOCATION
        FROM CAST c
        JOIN (SELECT DISTINCT NCONST FROM MOVIE_CAST
              WHERE IMDBID = (SELECT IMDBID FROM MOVIE_IMDB WHERE MOVIEID = :mid)
                AND CATEGORY NOT IN ('director', 'writer')) mc ON c.NCONST = mc.NCONST
        LEFT JOIN OUTPUT_CAST o ON o.NCONST = c.NCONST
    """, {"mid": mid})

    AGE_BANDS    = ['Under 20', '20-30', '30-40', '40-50', '50-60', '60-70', 'Over 70', 'Unknown']
    GENDER_ORDER = ['Male', 'Female', 'Unknown']
    _UNDEF       = {'', 'UNDEFINED', 'UNKNOWN', 'N/A', 'U'}

    def _resolve_gender(r) -> str:
        """LLM gender (MALE/FEMALE) tem prioridade; API (M/F) como fallback."""
        llm = (str(r.get('GENDER_LLM') or '')).strip().upper()
        api = (str(r.get('GENDER_API') or '')).strip().upper()
        for v in (llm, api):
            if v in ('MALE',   'M'): return 'Male'
            if v in ('FEMALE', 'F'): return 'Female'
        return 'Unknown'

    def _resolve_birthyear(r):
        """BIRTHYEAR da tabela principal; extrai do BIRTHDATE (OUTPUT) como fallback."""
        by = r.get('BIRTHYEAR')
        if by:
            try: return int(by)
            except (TypeError, ValueError): pass
        bd = r.get('BIRTHDATE')
        if bd is not None:
            try:
                return bd.year if hasattr(bd, 'year') else int(str(bd)[:4])
            except (TypeError, ValueError): pass
        return None

    def _age_band(birthyear):
        if not birthyear or not movie_year:
            return 'Unknown'
        try:
            age = int(movie_year) - int(birthyear)
            if age < 0:  return 'Unknown'
            if age < 20: return 'Under 20'
            if age < 30: return '20-30'
            if age < 40: return '30-40'
            if age < 50: return '40-50'
            if age < 60: return '50-60'
            if age < 70: return '60-70'
            return 'Over 70'
        except (TypeError, ValueError):
            return 'Unknown'

    def _agg(rows):
        gender = {k: 0 for k in GENDER_ORDER}
        age    = {b: 0 for b in AGE_BANDS}
        race, nat, eth = {}, {}, {}

        for r in rows:
            gender[_resolve_gender(r)]               += 1
            age[_age_band(_resolve_birthyear(r))]    += 1

            rc = _clean(r.get('RACE'))        or 'Unknown'
            e  = _clean(r.get('ETHNICITY'))   or 'Unknown'

            n = _clean(r.get('NATIONALITY'))
            if not n:
                loc = _clean(r.get('BIRTHLOCATION'))
                if loc:
                    n = loc.rsplit(',', 1)[-1].strip()
            n = n or 'Unknown'
            race[rc] = race.get(rc, 0) + 1
            nat[n]   = nat.get(n,   0) + 1
            eth[e]   = eth.get(e,   0) + 1

        return {
            "total":       len(rows),
            "gender":      {k: v for k, v in gender.items() if v},
            "age":         {k: v for k, v in age.items()    if v},
            "race":        dict(sorted(race.items(), key=lambda x: -x[1])),
            "nationality": dict(sorted(nat.items(),  key=lambda x: -x[1])),
            "ethnicity":   dict(sorted(eth.items(),  key=lambda x: -x[1])),
        }

    return JSONResponse({
        "movie_year": movie_year,
        "director":   _agg(dir_rows),
        "writer":     _agg(wri_rows),
        "cast":       _agg(cast_rows),
    })


@app.get("/similar/{movieid}")
async def similar_movies(movieid: str, page: int = 1, per_page: int = 5):
    mid = int(movieid)
    offset = (page - 1) * per_page

    total_rows = _oracle_query(
        "SELECT COUNT(*) AS CNT FROM ITEM_SIMILARITY WHERE MOVIE_ID = :mid",
        {"mid": mid},
    )
    total = int((total_rows or [{"CNT": 0}])[0]["CNT"])

    rows = _oracle_query("""
        SELECT i.SIMILAR_MOVIE_ID AS MOVIEID,
               m.TITLE, m.YEAR, m.GENRE, m.POSTER, m.IMDBID,
               ml.RATING_ML,
               i.SIMILARITY
        FROM ITEM_SIMILARITY i
        JOIN MOVIE_IMDB m  ON m.MOVIEID  = i.SIMILAR_MOVIE_ID
        LEFT JOIN MOVIE_ML ml ON ml.MOVIEID = i.SIMILAR_MOVIE_ID
        WHERE i.MOVIE_ID = :mid
        ORDER BY i.SIMILARITY DESC
        OFFSET :off ROWS FETCH NEXT :n ROWS ONLY
    """, {"mid": mid, "off": offset, "n": per_page})

    movies = [{
        "id":         str(r["MOVIEID"]),
        "imdb_id":    _clean(r.get("IMDBID", "")).lower(),
        "title":      _clean(r.get("TITLE", "")),
        "year":       _clean(r.get("YEAR", "")),
        "genre":      _clean(r.get("GENRE", "")),
        "poster":     _clean(r.get("POSTER", "")),
        "ml":         f"{float(r['RATING_ML']):.2f}" if r.get("RATING_ML") else "",
        "similarity": f"{float(r['SIMILARITY']):.4f}" if r.get("SIMILARITY") else "",
    } for r in rows]

    return JSONResponse({"total": total, "page": page, "per_page": per_page, "movies": movies})


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
        "SELECT IDIOM, THEME, WORD, COUNT, DIALOGUES FROM SUBTITLE_THEME"
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
        "SELECT IDIOM, LOCATION AS ENTITY, COUNT, DIALOGUES FROM SUBTITLE_GEO"
        " WHERE IMDB = :imdb AND IDIOM = 'EN' ORDER BY COUNT DESC",
        {"imdb": imdbid.lower()},
    )
    rows_pt = _oracle_query(
        "SELECT IDIOM, ENTITY, COUNT, DIALOGUES FROM SUBTITLE_BERT"
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
        "SELECT IDIOM, WORD, COUNT, DIALOGUES FROM SUBTITLE_INITCAP"
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
        "SELECT IDIOM, REGION, WORD, COUNT, DIALOGUES FROM SUBTITLE_REGION"
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
    "racism":     "SUBTITLE_RACISM",
    "women":      "SUBTITLE_WOMEN",
    "xenophobia": "SUBTITLE_XENOPHOBIA",
    "religion":   "SUBTITLE_RELIGION",
    "ableism":    "SUBTITLE_ABLEISM",
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


@app.get("/crew/{movieid}")
async def crew_detail(movieid: str):
    mid = int(movieid)

    directors = _oracle_query("""
        SELECT d.DIRECTORID AS PERSON_ID,
               d.NAME, d.GENDER AS GENDER_LLM, d.RACE, d.NATIONALITY, d.ETHNICITY, d.RELIGION,
               o.PRIMARYIMAGEURL, o.GENDER AS GENDER_API, o.BIRTHDATE, o.BIRTHLOCATION, o.BIOGRAPHY
        FROM DIRECTOR d
        JOIN MOVIE_DIRECTOR md ON d.DIRECTORID = md.DIRECTORID
        LEFT JOIN OUTPUT_DIRECTOR o ON o.DIRECTORID = d.DIRECTORID
        WHERE md.MOVIEID = :mid
    """, {"mid": mid})

    writers = _oracle_query("""
        SELECT w.WRITERID AS PERSON_ID,
               w.NAME, w.GENDER AS GENDER_LLM, w.RACE, w.NATIONALITY, w.ETHNICITY, w.RELIGION,
               o.PRIMARYIMAGEURL, o.GENDER AS GENDER_API, o.BIRTHDATE, o.BIRTHLOCATION, o.BIOGRAPHY
        FROM WRITER w
        JOIN MOVIE_WRITER mw ON w.WRITERID = mw.WRITERID
        LEFT JOIN OUTPUT_WRITER o ON o.WRITERID = w.WRITERID
        WHERE mw.MOVIEID = :mid
    """, {"mid": mid})

    cast = _oracle_query("""
        SELECT c.NCONST AS PERSON_ID,
               c.PRIMARYNAME AS NAME, NULL AS GENDER_LLM, NULL AS RACE, NULL AS NATIONALITY,
               NULL AS ETHNICITY, NULL AS RELIGION,
               o.PRIMARYIMAGEURL, o.GENDER AS GENDER_API, o.BIRTHDATE, o.BIRTHLOCATION, o.BIOGRAPHY,
               mc.CATEGORY, mc.JOB, mc.CHARACTERS
        FROM CAST c
        JOIN MOVIE_CAST mc ON c.NCONST = mc.NCONST
        LEFT JOIN OUTPUT_CAST o ON o.NCONST = c.NCONST
        WHERE mc.IMDBID = (SELECT IMDBID FROM MOVIE_IMDB WHERE MOVIEID = :mid)
          AND mc.CATEGORY NOT IN ('director', 'writer')
        ORDER BY mc.ORDERING
    """, {"mid": mid})

    def _read_lob(val):
        """Lê CLOB/LOB se necessário, senão converte direto para str."""
        if val is None:
            return ""
        if hasattr(val, "read"):
            return val.read()
        return str(val)

    def _chars_to_list(val) -> list[str]:
        """Converte JSON array '["Woody","Rex"]' → ['Woody', 'Rex'].
        Se já for string simples, retorna lista com um elemento."""
        s = _clean(str(val) if val is not None else "")
        if not s:
            return []
        try:
            parsed = json.loads(s)
            if isinstance(parsed, list):
                return [str(x).strip() for x in parsed if x]
        except (ValueError, TypeError):
            pass
        return [s]

    def _dedupe_cast(rows: list[dict]) -> list[dict]:
        """Agrupa linhas do cast pelo PERSON_ID (NCONST), concatenando
        CATEGORY, JOB e CHARACTERS distintos sem repetição."""
        seen: dict[str, dict] = {}
        order: list[str] = []

        for r in rows:
            pid = r.get("PERSON_ID") or r.get("NAME") or ""
            if pid not in seen:
                entry = dict(r)
                entry["_cats"]  = [c for c in [_clean(r.get("CATEGORY"))] if c]
                entry["_jobs"]  = [j for j in [_clean(r.get("JOB"))]      if j]
                entry["_chars"] = _chars_to_list(r.get("CHARACTERS"))
                seen[pid] = entry
                order.append(pid)
            else:
                entry = seen[pid]
                cat = _clean(r.get("CATEGORY"))
                if cat and cat not in entry["_cats"]:
                    entry["_cats"].append(cat)
                job = _clean(r.get("JOB"))
                if job and job not in entry["_jobs"]:
                    entry["_jobs"].append(job)
                for ch in _chars_to_list(r.get("CHARACTERS")):
                    if ch not in entry["_chars"]:
                        entry["_chars"].append(ch)

        result = []
        for pid in order:
            entry = seen[pid]
            entry["CATEGORY"]   = ", ".join(entry.pop("_cats"))
            entry["JOB"]        = ", ".join(entry.pop("_jobs"))
            entry["CHARACTERS"] = ", ".join(entry.pop("_chars"))
            result.append(entry)
        return result

    def normalize(rows: list[dict]) -> list[dict]:
        return [{
            "person_id":     _clean(r.get("PERSON_ID")),
            "name":          _clean(r.get("NAME")),
            "gender_llm":    _clean(r.get("GENDER_LLM")),
            "gender_api":    _clean(r.get("GENDER_API")),
            "race":          _clean(r.get("RACE")),
            "nationality":   _clean(r.get("NATIONALITY")),
            "ethnicity":     _clean(r.get("ETHNICITY")),
            "religion":      _clean(r.get("RELIGION")),
            "photo":         _clean(r.get("PRIMARYIMAGEURL")),
            "birthdate":     _clean(r.get("BIRTHDATE")),
            "birthlocation": _clean(r.get("BIRTHLOCATION")),
            "biography":     _clean(_read_lob(r.get("BIOGRAPHY"))),
            "category":      _clean(r.get("CATEGORY")),
            "job":           _clean(r.get("JOB")),
            "characters":    _clean(r.get("CHARACTERS")),  # já parseado por _dedupe_cast
        } for r in rows]

    return JSONResponse({
        "directors": normalize(directors),
        "writers":   normalize(writers),
        "cast":      normalize(_dedupe_cast(cast)),
    })


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
