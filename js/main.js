// ── State ───────────────────────────────────────────────────────────────────

let _currentQuery  = '';
let _currentPage   = 1;
let _totalResults  = 0;
let _currentImdbId = '';
const PER_PAGE     = 20;

const POSTER_PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450">' +
  '<rect width="300" height="450" fill="#e0ddd8"/>' +
  '<text x="150" y="225" text-anchor="middle" fill="#aaa" font-family="sans-serif" font-size="14">No Poster</text>' +
  '</svg>'
)}`;

// ── DOM refs ─────────────────────────────────────────────────────────────────

const searchInput      = document.getElementById('searchInput');
const btnSearch        = document.getElementById('btnSearch');
const searchMsg        = document.getElementById('searchMsg');
const loadingOverlay   = document.getElementById('loadingOverlay');
const resultsSection   = document.getElementById('resultsSection');
const resultsCount     = document.getElementById('resultsCount');
const resultsBody      = document.getElementById('resultsBody');
const resultsPagination= document.getElementById('resultsPagination');
const movieDetail      = document.getElementById('movieDetail');

// ── Section-toggle (collapse/expand) ─────────────────────────────────────────

document.addEventListener('click', e => {
  const btn = e.target.closest('.section-toggle');
  if (!btn) return;
  const targetId = btn.dataset.target;
  const content  = document.getElementById(targetId);
  if (!content) return;
  const collapsed = content.style.display === 'none';
  content.style.display = collapsed ? '' : 'none';
  btn.textContent = collapsed ? '−' : '+';
});

// ── Search ──────────────────────────────────────────────────────────────────

btnSearch.addEventListener('click', () => doSearch(1));
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(1); });

async function doSearch(page) {
  const q = searchInput.value.trim();
  if (!q) { searchInput.focus(); return; }

  _currentQuery = q;
  _currentPage  = page;

  showMsg('');
  loadingOverlay.hidden = false;
  btnSearch.disabled = true;

  try {
    const res  = await fetch(`/search?q=${encodeURIComponent(q)}&page=${page}&per_page=${PER_PAGE}`);
    const data = await res.json();
    _totalResults = data.total;

    if (data.total === 0) {
      hideResults();
      hideDetail();
      showMsg('No movies found for that search.', 'empty');
      return;
    }

    if (data.total === 1) {
      // Single result: go straight to detail
      hideResults();
      await showMovieDetail(data.movies[0].id);
      return;
    }

    // Multiple results: show table
    renderResultsTable(data.movies, data.total, page);
    hideDetail();
  } catch {
    showMsg('Search failed. Please try again.', 'error');
  } finally {
    loadingOverlay.hidden = true;
    btnSearch.disabled = false;
  }
}

// ── Results table ────────────────────────────────────────────────────────────

function renderResultsTable(movies, total, page) {
  resultsBody.innerHTML = '';
  resultsCount.textContent = `${total} result${total !== 1 ? 's' : ''}`;

  let activeRow = null;

  movies.forEach(m => {
    const tr = document.createElement('tr');

    // Poster thumbnail
    const tdPoster = document.createElement('td');
    const img = document.createElement('img');
    img.className = 'poster-thumb';
    img.src   = m.poster || POSTER_PLACEHOLDER;
    img.alt   = m.title;
    img.title = `Movie ID: ${m.id}${m.imdb_id ? ' | IMDB: ' + m.imdb_id : ''}`;
    img.loading = 'lazy';
    img.onerror = () => { img.onerror = null; img.src = POSTER_PLACEHOLDER; };
    tdPoster.appendChild(img);

    // Title
    const tdTitle = document.createElement('td');
    tdTitle.className = 'title-cell';
    tdTitle.textContent = m.title;

    // Year
    const tdYear = document.createElement('td');
    tdYear.className = 'year-cell';
    tdYear.textContent = m.year;

    // Genre (first genre only to save space)
    const tdGenre = document.createElement('td');
    const genres = (m.genre || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3);
    const genreWrap = document.createElement('div');
    genreWrap.className = 'chip-cell';
    genres.forEach(g => {
      const chip = document.createElement('span');
      chip.className = 'chip chip--genre';
      chip.textContent = g;
      genreWrap.appendChild(chip);
    });
    tdGenre.appendChild(genreWrap);

    // Director
    const tdDir = document.createElement('td');
    tdDir.textContent = (m.director || '').split(',')[0].trim();
    tdDir.style.fontSize = '0.82rem';

    // IMDb rating
    const tdImdb = document.createElement('td');
    tdImdb.className = 'imdb-cell';
    if (m.imdb) {
      tdImdb.innerHTML = `<strong>${m.imdb}</strong>/10`;
    } else if (m.ml) {
      tdImdb.innerHTML = `<strong>${m.ml}</strong>/5 ML`;
    }

    tr.appendChild(tdPoster);
    tr.appendChild(tdTitle);
    tr.appendChild(tdYear);
    tr.appendChild(tdGenre);
    tr.appendChild(tdDir);
    tr.appendChild(tdImdb);

    tr.addEventListener('click', async () => {
      if (activeRow) activeRow.classList.remove('active');
      tr.classList.add('active');
      activeRow = tr;
      await showMovieDetail(m.id);
      movieDetail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    resultsBody.appendChild(tr);
  });

  resultsSection.hidden = false;
  renderPagination(total, page);
}

function renderPagination(total, page) {
  const totalPages = Math.ceil(total / PER_PAGE);
  resultsPagination.innerHTML = '';

  if (totalPages <= 1) {
    resultsPagination.style.display = 'none';
    return;
  }

  resultsPagination.style.display = '';

  const btnPrev = document.createElement('button');
  btnPrev.className = 'btn btn--sm';
  btnPrev.textContent = '‹ Prev';
  btnPrev.disabled = page === 1;
  btnPrev.addEventListener('click', () => doSearch(page - 1));

  const info = document.createElement('span');
  info.className = 'pagination-info';
  info.textContent = `${page} / ${totalPages}  (${total} movies)`;

  const btnNext = document.createElement('button');
  btnNext.className = 'btn btn--sm';
  btnNext.textContent = 'Next ›';
  btnNext.disabled = page >= totalPages;
  btnNext.addEventListener('click', () => doSearch(page + 1));

  resultsPagination.appendChild(btnPrev);
  resultsPagination.appendChild(info);
  resultsPagination.appendChild(btnNext);
}

// ── Movie detail ─────────────────────────────────────────────────────────────

async function showMovieDetail(movieid) {
  try {
    loadingOverlay.hidden = false;
    const res  = await fetch(`/movie/${encodeURIComponent(movieid)}`);
    const data = await res.json();
    if (!data.title) return;
    populateDetail(data);
    movieDetail.hidden = false;
    // Ensure content is visible
    const content = document.getElementById('movieDetailContent');
    if (content && content.style.display === 'none') {
      content.style.display = '';
      const btn = document.querySelector('.section-toggle[data-target="movieDetailContent"]');
      if (btn) btn.textContent = '−';
    }
  } catch { /* silently ignore */ } finally {
    loadingOverlay.hidden = true;
  }
}

function populateDetail(movie) {
  const detailPoster = document.getElementById('detailPoster');
  detailPoster.alt   = movie.title;
  detailPoster.title = `Movie ID: ${movie.id}${movie.imdb_id ? ' | IMDB: ' + movie.imdb_id : ''}`;
  detailPoster.onerror = () => { detailPoster.onerror = null; detailPoster.src = POSTER_PLACEHOLDER; };
  detailPoster.src = movie.poster || POSTER_PLACEHOLDER;

  document.getElementById('detailTitle').textContent    = movie.title;
  document.getElementById('detailYear').textContent     = movie.year;
  document.getElementById('detailReleased').textContent = formatDate(movie.released);
  document.getElementById('detailRuntime').textContent  = movie.runtime;
  document.getElementById('detailCountry').textContent  = movie.country;
  document.getElementById('detailLanguage').textContent = movie.language;
  document.getElementById('detailGenre').textContent    = movie.genre;
  document.getElementById('detailDirector').textContent = movie.director;
  document.getElementById('detailWriter').textContent   = movie.writer;
  document.getElementById('detailCast').textContent     = movie.cast;
  document.getElementById('detailAwards').textContent   = movie.awards || '—';
  document.getElementById('detailPlot').textContent     = movie.plot;

  renderRatings(movie.ratings);
  renderGenresTags(movie.genres_imdb, movie.genres_ml, movie.tags);
  renderSubtitleData(movie);
  initDiversity(movie.id);
  initSimilarMovies(movie.id);
  initCrewData(movie.id);
}

// ── Ratings badges ───────────────────────────────────────────────────────────

function renderRatings(ratings) {
  const container = document.getElementById('detailRatings');
  container.innerHTML = '';
  if (!ratings || ratings.length === 0) return;

  const sourceClass = {
    'Movie Lens':      'rb-ml',
    'IMDb':            'rb-imdb',
    'Rotten Tomatoes': 'rb-rt',
    'Metacritic':      'rb-mc',
  };

  ratings.forEach(({ source, score, votes }) => {
    const badge = document.createElement('div');
    badge.className = `rating-badge ${sourceClass[source] ?? ''}`.trim();

    const src = document.createElement('span');
    src.className   = 'rb-source';
    src.textContent = source;

    const sc = document.createElement('span');
    sc.className   = 'rb-score';
    sc.textContent = score;

    badge.appendChild(src);
    badge.appendChild(sc);

    if (votes) {
      const v = document.createElement('span');
      v.className   = 'rb-votes';
      v.textContent = `${votes} votes`;
      badge.appendChild(v);
    }

    container.appendChild(badge);
  });
}

// ── Crew Diversity ───────────────────────────────────────────────────────────

const DIV_GENDER_ORDER = ['Male', 'Female', 'Unknown'];
const DIV_AGE_ORDER    = ['Under 20','20-30','30-40','40-50','50-60','60-70','Over 70','Unknown'];

const DIV_GENDER_CLASS = { Male: 'dc-male', Female: 'dc-female', Unknown: 'dc-unknown' };
const DIV_AGE_CLASS    = {
  'Under 20': 'dc-age-u20', '20-30': 'dc-age-20', '30-40': 'dc-age-30',
  '40-50':    'dc-age-40',  '50-60': 'dc-age-50', '60-70': 'dc-age-60',
  'Over 70':  'dc-age-o70', 'Unknown': 'dc-unknown',
};

function _divChip(label, count, cls) {
  const chip = document.createElement('span');
  chip.className   = `div-chip ${cls}`;
  chip.textContent = `${label} (${count})`;
  return chip;
}

function _divCell(counts, ordered, classFn) {
  const wrap = document.createElement('div');
  wrap.className = 'div-chips';
  const keys = ordered
    ? ordered.filter(k => counts[k])
    : Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  keys.forEach(k => {
    if (counts[k]) wrap.appendChild(_divChip(k, counts[k], classFn(k)));
  });
  if (!wrap.children.length) wrap.innerHTML = '<span class="div-chip dc-unknown">Unknown</span>';
  return wrap;
}

function _divRow(label, dirData, wriData, castData, ordered, classFn) {
  const tr = document.createElement('tr');
  const th = document.createElement('th');
  th.className   = 'div-row-label';
  th.textContent = label;
  tr.appendChild(th);
  [dirData, wriData, castData].forEach(d => {
    const td = document.createElement('td');
    td.appendChild(_divCell(d || {}, ordered, classFn));
    tr.appendChild(td);
  });
  return tr;
}

async function initDiversity(movieid) {
  const section = document.getElementById('crewDiversity');
  if (!movieid) { section.hidden = true; return; }

  document.getElementById('diversityBody').innerHTML =
    `<tr><td colspan="4" class="tab-loading">Loading…</td></tr>`;
  _resetSection(section);

  try {
    const res  = await fetch(`/diversity/${encodeURIComponent(movieid)}`);
    const data = await res.json();
    _renderDiversityTable(data);
  } catch {
    document.getElementById('diversityBody').innerHTML =
      `<tr><td colspan="4" class="tab-loading">(Error loading data)</td></tr>`;
  }
}

function _renderDiversityTable(data) {
  const tbody = document.getElementById('diversityBody');
  tbody.innerHTML = '';

  const d = data.director, w = data.writer, c = data.cast;
  const neutral = k => 'dc-other';

  tbody.appendChild(_divRow('Gender',      d.gender,      w.gender,      c.gender,      DIV_GENDER_ORDER, k => DIV_GENDER_CLASS[k] || 'dc-unknown'));
  tbody.appendChild(_divRow('Race',        d.race,        w.race,        c.race,        null,             neutral));
  tbody.appendChild(_divRow('Age',         d.age,         w.age,         c.age,         DIV_AGE_ORDER,    k => DIV_AGE_CLASS[k]    || 'dc-unknown'));
  tbody.appendChild(_divRow('Nationality', d.nationality, w.nationality, c.nationality, null,             neutral));
  tbody.appendChild(_divRow('Ethnicity',   d.ethnicity,   w.ethnicity,   c.ethnicity,   null,             neutral));
}

// ── Similar Movies ───────────────────────────────────────────────────────────

const SIM_PER_PAGE = 5;
let _simMovieId = '';
let _simPage    = 1;
let _simTotal   = 0;

async function initSimilarMovies(movieid) {
  const section = document.getElementById('similarMovies');
  _simMovieId = movieid || '';
  _simPage    = 1;

  if (!_simMovieId) { section.hidden = true; return; }

  document.getElementById('similarBody').innerHTML =
    `<tr><td colspan="6" class="tab-loading">Loading…</td></tr>`;
  document.getElementById('similarPagination').style.display = 'none';
  _resetSection(section);

  await _loadSimilarPage(1);
}

async function _loadSimilarPage(page) {
  _simPage = page;
  try {
    const res  = await fetch(`/similar/${encodeURIComponent(_simMovieId)}?page=${page}&per_page=${SIM_PER_PAGE}`);
    const data = await res.json();
    _simTotal  = data.total;
    _renderSimilarTable(data.movies);
    _renderSimilarPagination(data.total, page);
  } catch {
    document.getElementById('similarBody').innerHTML =
      `<tr><td colspan="6" class="tab-loading">(Error loading data)</td></tr>`;
  }
}

function _renderSimilarTable(movies) {
  const tbody = document.getElementById('similarBody');
  tbody.innerHTML = '';

  movies.forEach(m => {
    const tr = document.createElement('tr');

    // Poster
    const tdPoster = document.createElement('td');
    const img = document.createElement('img');
    img.className = 'poster-thumb';
    img.src     = m.poster || POSTER_PLACEHOLDER;
    img.alt     = m.title;
    img.title   = `Movie ID: ${m.id}${m.imdb_id ? ' | IMDB: ' + m.imdb_id : ''}`;
    img.loading = 'lazy';
    img.onerror = () => { img.onerror = null; img.src = POSTER_PLACEHOLDER; };
    tdPoster.appendChild(img);

    // Title
    const tdTitle = document.createElement('td');
    tdTitle.className   = 'title-cell';
    tdTitle.textContent = m.title;

    // Year
    const tdYear = document.createElement('td');
    tdYear.className   = 'year-cell';
    tdYear.textContent = m.year;

    // Genre (até 3 chips)
    const tdGenre = document.createElement('td');
    const genres  = (m.genre || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3);
    const wrap    = document.createElement('div');
    wrap.className = 'chip-cell';
    genres.forEach(g => {
      const chip = document.createElement('span');
      chip.className   = 'chip chip--genre';
      chip.textContent = g;
      wrap.appendChild(chip);
    });
    tdGenre.appendChild(wrap);

    // ML Rating
    const tdMl = document.createElement('td');
    tdMl.className = 'imdb-cell';
    if (m.ml) tdMl.innerHTML = `<strong>${m.ml}</strong>/5`;

    // Similarity
    const tdSim = document.createElement('td');
    tdSim.className = 'sim-cell';
    if (m.similarity) {
      const pct = (parseFloat(m.similarity) * 100).toFixed(1);
      tdSim.innerHTML = `<span class="sim-bar-wrap"><span class="sim-bar" style="width:${pct}%"></span></span><span class="sim-value">${m.similarity}</span>`;
    }

    tr.appendChild(tdPoster);
    tr.appendChild(tdTitle);
    tr.appendChild(tdYear);
    tr.appendChild(tdGenre);
    tr.appendChild(tdMl);
    tr.appendChild(tdSim);

    tr.addEventListener('click', async () => {
      await showMovieDetail(m.id);
      movieDetail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    tbody.appendChild(tr);
  });
}

function _renderSimilarPagination(total, page) {
  const el = document.getElementById('similarPagination');
  const totalPages = Math.ceil(total / SIM_PER_PAGE);

  if (totalPages <= 1) { el.style.display = 'none'; return; }

  el.style.display = '';
  el.innerHTML = '';

  const btnPrev = document.createElement('button');
  btnPrev.className   = 'btn btn--sm';
  btnPrev.textContent = '‹ Prev';
  btnPrev.disabled    = page === 1;
  btnPrev.addEventListener('click', () => _loadSimilarPage(page - 1));

  const info = document.createElement('span');
  info.className   = 'pagination-info';
  info.textContent = `${page} / ${totalPages}  (${total} movies)`;

  const btnNext = document.createElement('button');
  btnNext.className   = 'btn btn--sm';
  btnNext.textContent = 'Next ›';
  btnNext.disabled    = page >= totalPages;
  btnNext.addEventListener('click', () => _loadSimilarPage(page + 1));

  el.appendChild(btnPrev);
  el.appendChild(info);
  el.appendChild(btnNext);
}

// ── Crew Detail ──────────────────────────────────────────────────────────────

function _weightsTooltip(weights) {
  return Object.entries(weights)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}%`)
    .join(' · ');
}

const CREW_TABS = ['crewDirectors', 'crewWriters', 'crewCast'];

const PERSON_PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160">' +
  '<rect width="120" height="160" fill="#e0ddd8"/>' +
  '<text x="60" y="85" text-anchor="middle" fill="#aaa" font-family="sans-serif" font-size="11">Unavailable</text>' +
  '</svg>'
)}`;

document.querySelectorAll('[data-crewtab]').forEach(btn => {
  btn.addEventListener('click', () => _activateCrewTab(btn.dataset.crewtab));
});

function _activateCrewTab(tabId) {
  document.querySelectorAll('[data-crewtab]').forEach(b =>
    b.classList.toggle('tab-btn--active', b.dataset.crewtab === tabId));
  CREW_TABS.forEach(id => { document.getElementById(id).hidden = (id !== tabId); });
}

function _buildCrewCard(person, horizontal = false) {
  const card = document.createElement('div');
  card.className = 'crew-card' + (horizontal ? ' crew-card--horizontal' : '');

  // Photo
  const img = document.createElement('img');
  img.className = 'crew-photo';
  img.alt     = person.name || '';
  img.title   = person.person_id || '';
  img.loading = 'lazy';
  img.onerror = () => { img.onerror = null; img.src = PERSON_PLACEHOLDER; };
  img.src     = person.photo || PERSON_PLACEHOLDER;
  card.appendChild(img);

  // Info block
  const info = document.createElement('div');
  info.className = 'crew-info';

  const nameEl = document.createElement('div');
  nameEl.className   = 'crew-name';
  nameEl.textContent = person.name || '—';
  info.appendChild(nameEl);

  const FIELDS = [
    ['Category',   person.category],
    ['Job',        person.job],
    ['Characters', person.characters],
    ['Nationality', person.nationality],
    ['Ethnicity',   person.ethnicity],
    ['Religion',    person.religion],
    ['Born',        [person.birthdate, person.birthlocation].filter(Boolean).join(' · ')],
  ];

  const fieldsGrid = document.createElement('div');
  fieldsGrid.className = 'crew-fields';

  // Gender — multi-source: "Gender (LLM | IMDB | DeepFace): Male | Female | Male"
  const srcs = person.gender_sources || [];
  if (srcs.length > 0) {
    const gRow = document.createElement('div');
    gRow.className = 'crew-field';
    const gLbl = document.createElement('span');
    gLbl.className   = 'crew-field-label';
    gLbl.textContent = `Gender (${srcs.map(s => s.source).join(' | ')})`;
    const gVal = document.createElement('span');
    gVal.className = 'crew-field-value';
    srcs.forEach((src, i) => {
      if (i > 0) gVal.append(' | ');
      if (src.source === 'DeepFace' && (src.male_pct > 0 || src.female_pct > 0)) {
        const span = document.createElement('span');
        span.className   = 'df-has-tooltip';
        span.textContent = src.value;
        span.title       = `Male: ${src.male_pct}% · Female: ${src.female_pct}%`;
        gVal.appendChild(span);
      } else {
        gVal.append(src.value);
      }
    });
    gRow.appendChild(gLbl);
    gRow.appendChild(gVal);
    fieldsGrid.appendChild(gRow);
  }

  // Race — LLM (director/writer) e/ou DeepFace
  const hasRaceLlm = !!person.race;
  const hasRaceDf  = !!(person.deepface_race && person.deepface_race.value);
  if (hasRaceLlm || hasRaceDf) {
    const raceRow = document.createElement('div');
    raceRow.className = 'crew-field';
    const raceLbl = document.createElement('span');
    raceLbl.className = 'crew-field-label';
    if (hasRaceLlm && hasRaceDf)      raceLbl.textContent = 'Race (LLM | DeepFace)';
    else if (hasRaceLlm)              raceLbl.textContent = 'Race';
    else                              raceLbl.textContent = 'Race (DeepFace)';
    const raceVal = document.createElement('span');
    raceVal.className = 'crew-field-value';
    if (hasRaceLlm) {
      raceVal.append(person.race);
    }
    if (hasRaceLlm && hasRaceDf) {
      raceVal.append(' | ');
    }
    if (hasRaceDf) {
      const dfSpan = document.createElement('span');
      dfSpan.className   = 'df-has-tooltip';
      dfSpan.textContent = person.deepface_race.value;
      dfSpan.title       = _weightsTooltip(person.deepface_race.weights);
      raceVal.appendChild(dfSpan);
    }
    raceRow.appendChild(raceLbl);
    raceRow.appendChild(raceVal);
    fieldsGrid.appendChild(raceRow);
  }

  FIELDS.forEach(([label, value]) => {
    if (!value) return;
    const row = document.createElement('div');
    row.className = 'crew-field';
    const lbl = document.createElement('span');
    lbl.className   = 'crew-field-label';
    lbl.textContent = label;
    const val = document.createElement('span');
    val.className   = 'crew-field-value';
    val.textContent = value;
    row.appendChild(lbl);
    row.appendChild(val);
    fieldsGrid.appendChild(row);
  });

  info.appendChild(fieldsGrid);

  // Biography (máx 300 chars + botão expandir)
  if (person.biography) {
    const BIO_LIMIT = 300;
    const bio = document.createElement('div');
    bio.className = 'crew-bio';

    if (person.biography.length <= BIO_LIMIT) {
      bio.textContent = person.biography;
    } else {
      const shortSpan = document.createElement('span');
      shortSpan.textContent = person.biography.slice(0, BIO_LIMIT);

      const restSpan = document.createElement('span');
      restSpan.textContent = person.biography.slice(BIO_LIMIT);
      restSpan.hidden = true;

      const expandBtn = document.createElement('button');
      expandBtn.className   = 'bio-expand-btn';
      expandBtn.title       = 'Show full biography';
      expandBtn.textContent = ' …';
      expandBtn.addEventListener('click', () => {
        restSpan.hidden = false;
        expandBtn.remove();
      });

      bio.appendChild(shortSpan);
      bio.appendChild(expandBtn);
      bio.appendChild(restSpan);
    }

    info.appendChild(bio);
  }

  card.appendChild(info);
  return card;
}

function _renderCrewPanel(panelId, people, horizontal = false) {
  const panel = document.getElementById(panelId);
  panel.innerHTML = '';
  if (!people || people.length === 0) {
    panel.innerHTML = '<div class="tab-loading">No data available.</div>';
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'crew-grid' + (horizontal ? ' crew-grid--horizontal' : '');
  people.forEach(p => grid.appendChild(_buildCrewCard(p, horizontal)));
  panel.appendChild(grid);
}

async function initCrewData(movieid) {
  const section = document.getElementById('detailCrew');
  if (!movieid) { section.hidden = true; return; }

  _activateCrewTab('crewDirectors');
  CREW_TABS.forEach((id, i) => {
    document.getElementById(id).innerHTML = '<div class="tab-loading">Loading…</div>';
    document.getElementById(id).hidden    = (i !== 0);
  });
  _resetSection(section);

  try {
    const res  = await fetch(`/crew/${encodeURIComponent(movieid)}`);
    const data = await res.json();
    _renderCrewPanel('crewDirectors', data.directors, true);
    _renderCrewPanel('crewWriters',   data.writers,   true);
    _renderCrewPanel('crewCast',      data.cast,      false);
  } catch {
    CREW_TABS.forEach(id => {
      document.getElementById(id).innerHTML = '<div class="tab-loading">(Error loading data)</div>';
    });
  }
}

// ── Genres & Tags ─────────────────────────────────────────────────────────────

function renderGenresTags(genresImdb, genresMl, tags) {
  const container = document.getElementById('detailGenresTags');
  container.innerHTML = '';

  function addChipRow(label, items, chipClass, textFn) {
    if (!items || items.length === 0) return;
    const row = document.createElement('div');
    row.className = 'chip-row';
    const lbl = document.createElement('span');
    lbl.className   = 'meta-label';
    lbl.textContent = label;
    row.appendChild(lbl);
    items.forEach(item => {
      const chip = document.createElement('span');
      chip.className   = `chip ${chipClass}`;
      chip.textContent = textFn(item);
      row.appendChild(chip);
    });
    container.appendChild(row);
  }

  addChipRow('Genres IMDB', genresImdb, 'chip--genre', g => g);
  addChipRow('Genres ML',   genresMl,   'chip--genre', g => g);
  addChipRow('Tags', tags, 'chip--tag', ({ tag, count }) => `${tag} (${count})`);
}

// ── Subtitle sections ────────────────────────────────────────────────────────

const SUBTITLE_SECTIONS = ['crewDiversity', 'similarMovies', 'detailCrew', 'subtitleRaw', 'subtitleThemes', 'subtitleInitcap', 'subtitleGeo', 'subtitleReg', 'minoritiesData', 'subtitleData'];

const IDIOM_LABELS = {
  'EN':    'English',
  'PT-BR': 'Portuguese (Brazil)',
  'ES':    'Español',
  'FR':    'Français',
  'DE':    'Deutsch',
  'IT':    'Italiano',
};

const DIALOGUES_LIMIT = 15;

function makeDialoguesTd(raw) {
  const td = document.createElement('td');
  td.className = 'dialogues-cell';

  if (!raw) { td.textContent = '—'; return td; }

  const all = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (all.length <= DIALOGUES_LIMIT) {
    td.textContent = all.join(', ');
    return td;
  }

  const visible = all.slice(0, DIALOGUES_LIMIT);
  const hidden  = all.slice(DIALOGUES_LIMIT);

  td.appendChild(document.createTextNode(visible.join(', ') + ', '));

  const more = document.createElement('span');
  more.className = 'dialogues-more';
  more.textContent = '…';
  more.title = `Click to show ${hidden.length} more`;
  more.addEventListener('click', e => {
    e.stopPropagation();
    more.replaceWith(document.createTextNode(hidden.join(', ')));
  });
  td.appendChild(more);

  return td;
}

function makeTh(text, cls) {
  const th = document.createElement('th');
  th.textContent = text;
  if (cls) th.className = cls;
  return th;
}

function makeTd(text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function buildIdiomBlock(idiomCode) {
  const wrap = document.createElement('div');
  wrap.className = 'subtitle-idiom';
  const hdr = document.createElement('div');
  hdr.className = 'subtitle-idiom-header';
  hdr.textContent = IDIOM_LABELS[idiomCode] || idiomCode;
  wrap.appendChild(hdr);
  return wrap;
}

function renderSubtitleThemes(sectionId, data, groupLabel = 'Theme / Word') {
  const section = document.getElementById(sectionId);
  const content = document.getElementById(sectionId + 'Content');
  content.innerHTML = '';

  if (!data || Object.keys(data).length === 0) { section.hidden = true; return; }

  for (const [idiom, themes] of Object.entries(data)) {
    const wrap = buildIdiomBlock(idiom);

    const table = document.createElement('table');
    table.className = 'subtitle-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.appendChild(makeTh(groupLabel));
    headRow.appendChild(makeTh('Occurrences', 'count-th'));
    headRow.appendChild(makeTh('Dialogues', 'dialogues-th'));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const [theme, words] of Object.entries(themes)) {
      const themeRow = document.createElement('tr');
      themeRow.className = 'subtitle-theme-row';
      const td = document.createElement('td');
      td.colSpan = 3;
      td.textContent = theme;
      themeRow.appendChild(td);
      tbody.appendChild(themeRow);

      for (const { word, count, dialogues } of words) {
        const tr = document.createElement('tr');
        tr.appendChild(makeTd(word, 'subtitle-word'));
        tr.appendChild(makeTd(count, 'count-cell'));
        tr.appendChild(makeDialoguesTd(dialogues));
        tbody.appendChild(tr);
      }
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    content.appendChild(wrap);
  }

  _resetSection(section);
}

function renderSubtitleList(sectionId, data, keyProp, keyLabel) {
  const section = document.getElementById(sectionId);
  const content = document.getElementById(sectionId + 'Content');
  content.innerHTML = '';

  if (!data || Object.keys(data).length === 0) { section.hidden = true; return; }

  for (const [idiom, items] of Object.entries(data)) {
    const wrap = buildIdiomBlock(idiom);

    const table = document.createElement('table');
    table.className = 'subtitle-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.appendChild(makeTh(keyLabel));
    headRow.appendChild(makeTh('Occurrences', 'count-th'));
    headRow.appendChild(makeTh('Dialogues', 'dialogues-th'));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const item of items) {
      const tr = document.createElement('tr');
      tr.appendChild(makeTd(item[keyProp]));
      tr.appendChild(makeTd(item.count, 'count-cell'));
      tr.appendChild(makeDialoguesTd(item.dialogues));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    content.appendChild(wrap);
  }

  _resetSection(section);
}

function _resetSection(section) {
  const contentEl = section.querySelector('[id$="Content"]');
  if (contentEl) contentEl.style.display = '';
  const btn = section.querySelector('.section-toggle');
  if (btn) btn.textContent = '−';
  section.hidden = false;
}

async function loadSubtitleRaw(imdbId, lang) {
  const ta = document.getElementById('subtitleRawText');
  ta.value = 'Loading…';
  try {
    const res = await fetch(`/subtitle/${encodeURIComponent(imdbId)}/${encodeURIComponent(lang)}`);
    ta.value = res.ok ? await res.text() : '(Subtitle not available)';
  } catch {
    ta.value = '(Error loading subtitle)';
  }
}

async function updateSubtitleTooltips(imdbId) {
  const radios = [...document.querySelectorAll('input[name="subtitleLang"]')];
  const results = await Promise.all(radios.map(async r => {
    try {
      const res = await fetch(`/subtitle/${encodeURIComponent(imdbId)}/${encodeURIComponent(r.value)}/count`);
      return res.ok ? await res.json() : { count: 0, available: false };
    } catch {
      return { count: 0, available: false };
    }
  }));
  radios.forEach((radio, i) => {
    const label = radio.closest('label');
    if (!label) return;
    const { count, available } = results[i];
    label.title = available ? `${count.toLocaleString()} dialogues` : 'Subtitle not available';
  });
}

function renderSubtitleRaw(imdbId) {
  const section = document.getElementById('subtitleRaw');
  if (!imdbId) { section.hidden = true; return; }
  document.querySelectorAll('input[name="subtitleLang"]').forEach(r => { r.checked = r.value === 'EN'; });
  _resetSection(section);
  loadSubtitleRaw(imdbId, 'EN');
  updateSubtitleTooltips(imdbId);
}

document.querySelectorAll('input[name="subtitleLang"]').forEach(radio => {
  radio.addEventListener('change', () => {
    if (_currentImdbId) loadSubtitleRaw(_currentImdbId, radio.value);
  });
});

function goToDialogue(num) {
  const ta = document.getElementById('subtitleRawText');
  const lines = ta.value.split('\n');
  let targetLine = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === String(num) && (i === 0 || lines[i - 1].trim() === '')) {
      targetLine = i;
      break;
    }
  }

  if (targetLine === -1) return;

  let pos = 0;
  for (let i = 0; i < targetLine; i++) pos += lines[i].length + 1;

  ta.focus();
  ta.setSelectionRange(pos, pos + String(num).length);

  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, targetLine * lh - ta.clientHeight / 3);
}

document.getElementById('subtitleGotoBtn').addEventListener('click', () => {
  const num = parseInt(document.getElementById('subtitleGotoInput').value, 10);
  if (!isNaN(num) && num > 0) goToDialogue(num);
});

document.getElementById('subtitleGotoInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const num = parseInt(e.target.value, 10);
    if (!isNaN(num) && num > 0) goToDialogue(num);
  }
});

function renderSubtitleData(movie) {
  _currentImdbId = movie.imdb_id || '';
  renderSubtitleRaw(_currentImdbId);
  initMinoritiesData(_currentImdbId);
  initSubtitleData(_currentImdbId);
}

// ── Minorities Data — tabbed Oracle section ──────────────────────────────────

const MD_TABS = ['mdRacism', 'mdWomen', 'mdXenophobia', 'mdReligion', 'mdAbleism'];
const MD_SLUGS = { mdRacism: 'racism', mdWomen: 'women', mdXenophobia: 'xenophobia', mdReligion: 'religion', mdAbleism: 'ableism' };
let _mdImdbId = '';
let _mdCache  = {};

document.querySelectorAll('[data-mdtab]').forEach(btn => {
  btn.addEventListener('click', () => {
    _activateMdTab(btn.dataset.mdtab);
    _loadMdTab(btn.dataset.mdtab);
  });
});

function _activateMdTab(tabId) {
  document.querySelectorAll('[data-mdtab]').forEach(b =>
    b.classList.toggle('tab-btn--active', b.dataset.mdtab === tabId));
  MD_TABS.forEach(id => { document.getElementById(id).hidden = (id !== tabId); });
}

async function _loadMdTab(tabId) {
  if (!_mdImdbId) return;
  if (_mdCache[tabId] !== undefined) { _renderMdTab(tabId, _mdCache[tabId]); return; }

  const panel = document.getElementById(tabId);
  panel.innerHTML = '<div class="tab-loading">Loading…</div>';

  try {
    const res  = await fetch(`/minority-data/${encodeURIComponent(_mdImdbId)}/${MD_SLUGS[tabId]}`);
    const data = await res.json();
    _mdCache[tabId] = data;
    _renderMdTab(tabId, data);
  } catch {
    _mdCache[tabId] = {};
    document.getElementById(tabId).innerHTML = '<div class="tab-loading">(Error loading data)</div>';
  }
}

function _renderMdTab(tabId, data) {
  const panel = document.getElementById(tabId);
  panel.innerHTML = '';
  if (!data || Object.keys(data).length === 0) {
    panel.innerHTML = '<div class="tab-loading">No data available.</div>';
    return;
  }
  _renderSdThemes(panel, data, 'Category / Word');
}

function initMinoritiesData(imdbId) {
  _mdImdbId = imdbId;
  _mdCache  = {};
  const section = document.getElementById('minoritiesData');
  if (!imdbId) { section.hidden = true; return; }
  _activateMdTab('mdRacism');
  _resetSection(section);
  _loadMdTab('mdRacism');
}

// ── Subtitle Data — tabbed Oracle section ────────────────────────────────────

const SD_TABS = ['sdThemes', 'sdGeo', 'sdInitcap', 'sdRegions'];
let _sdImdbId = '';
let _sdCache  = {};

document.querySelectorAll('[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    _activateTab(btn.dataset.tab);
    _loadTab(btn.dataset.tab);
  });
});

function _activateTab(tabId) {
  document.querySelectorAll('[data-tab]').forEach(b =>
    b.classList.toggle('tab-btn--active', b.dataset.tab === tabId));
  SD_TABS.forEach(id => { document.getElementById(id).hidden = (id !== tabId); });
}

async function _loadTab(tabId) {
  if (!_sdImdbId) return;
  if (_sdCache[tabId] !== undefined) { _renderTab(tabId, _sdCache[tabId]); return; }

  const panel = document.getElementById(tabId);
  panel.innerHTML = '<div class="tab-loading">Loading…</div>';

  const slug = { sdThemes: 'themes', sdGeo: 'geo', sdInitcap: 'initcap', sdRegions: 'regions' }[tabId];
  try {
    const res  = await fetch(`/subtitle-data/${encodeURIComponent(_sdImdbId)}/${slug}`);
    const data = await res.json();
    _sdCache[tabId] = data;
    _renderTab(tabId, data);
  } catch {
    _sdCache[tabId] = {};
    document.getElementById(tabId).innerHTML = '<div class="tab-loading">(Error loading data)</div>';
  }
}

function _renderTab(tabId, data) {
  const panel = document.getElementById(tabId);
  panel.innerHTML = '';
  if (!data || Object.keys(data).length === 0) {
    panel.innerHTML = '<div class="tab-loading">No data available.</div>';
    return;
  }
  if (tabId === 'sdThemes')  { _renderSdThemes(panel, data);                       return; }
  if (tabId === 'sdGeo')     { _renderSdList(panel, data, 'location', 'Location'); return; }
  if (tabId === 'sdInitcap') { _renderSdList(panel, data, 'word', 'Word');         return; }
  if (tabId === 'sdRegions') { _renderSdGrouped(panel, data);                      return; }
}

function _renderSdThemes(panel, data, groupLabel = 'Theme / Word') {
  for (const [idiom, themes] of Object.entries(data)) {
    const wrap = buildIdiomBlock(idiom);
    const table = document.createElement('table');
    table.className = 'subtitle-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    hr.appendChild(makeTh(groupLabel));
    hr.appendChild(makeTh('Occurrences', 'count-th'));
    hr.appendChild(makeTh('Dialogues', 'dialogues-th'));
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const [theme, words] of Object.entries(themes)) {
      const thRow = document.createElement('tr');
      thRow.className = 'subtitle-theme-row';
      const td = document.createElement('td'); td.colSpan = 3; td.textContent = theme;
      thRow.appendChild(td); tbody.appendChild(thRow);
      for (const { word, count, dialogues } of words) {
        const tr = document.createElement('tr');
        tr.appendChild(makeTd(word, 'subtitle-word'));
        tr.appendChild(makeTd(count, 'count-cell'));
        tr.appendChild(makeDialoguesTd(dialogues));
        tbody.appendChild(tr);
      }
    }
    table.appendChild(tbody); wrap.appendChild(table); panel.appendChild(wrap);
  }
}

function _renderSdList(panel, data, keyProp, keyLabel) {
  for (const [idiom, items] of Object.entries(data)) {
    const wrap = buildIdiomBlock(idiom);
    const table = document.createElement('table');
    table.className = 'subtitle-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    hr.appendChild(makeTh(keyLabel));
    hr.appendChild(makeTh('Occurrences', 'count-th'));
    hr.appendChild(makeTh('Dialogues', 'dialogues-th'));
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const item of items) {
      const tr = document.createElement('tr');
      tr.appendChild(makeTd(item[keyProp]));
      tr.appendChild(makeTd(item.count, 'count-cell'));
      tr.appendChild(makeDialoguesTd(item.dialogues));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody); wrap.appendChild(table); panel.appendChild(wrap);
  }
}

function _renderSdGrouped(panel, data) {
  for (const [idiom, regions] of Object.entries(data)) {
    const wrap = buildIdiomBlock(idiom);
    const table = document.createElement('table');
    table.className = 'subtitle-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    hr.appendChild(makeTh('Region / Word'));
    hr.appendChild(makeTh('Occurrences', 'count-th'));
    hr.appendChild(makeTh('Dialogues', 'dialogues-th'));
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const [region, words] of Object.entries(regions)) {
      const rRow = document.createElement('tr');
      rRow.className = 'subtitle-theme-row';
      const td = document.createElement('td'); td.colSpan = 3; td.textContent = region;
      rRow.appendChild(td); tbody.appendChild(rRow);
      for (const { word, count, dialogues } of words) {
        const tr = document.createElement('tr');
        tr.appendChild(makeTd(word, 'subtitle-word'));
        tr.appendChild(makeTd(count, 'count-cell'));
        tr.appendChild(makeDialoguesTd(dialogues));
        tbody.appendChild(tr);
      }
    }
    table.appendChild(tbody); wrap.appendChild(table); panel.appendChild(wrap);
  }
}

function initSubtitleData(imdbId) {
  _sdImdbId = imdbId;
  _sdCache  = {};
  const section = document.getElementById('subtitleData');
  if (!imdbId) { section.hidden = true; return; }
  _activateTab('sdThemes');
  _resetSection(section);
  _loadTab('sdThemes');
}

function hideSubtitleSections() {
  SUBTITLE_SECTIONS.forEach(id => { document.getElementById(id).hidden = true; });
}

// ── Utilities ────────────────────────────────────────────────────────────────

function formatDate(raw) {
  if (!raw) return '';
  const d = new Date(raw + 'T00:00:00');
  if (isNaN(d)) return raw;
  const dd  = String(d.getUTCDate()).padStart(2, '0');
  const mmm = d.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  return `${dd} - ${mmm} - ${d.getUTCFullYear()}`;
}

function showMsg(text, type = 'error') {
  if (!text) { searchMsg.style.display = 'none'; return; }
  searchMsg.className = `msg-box msg-box--${type}`;
  searchMsg.textContent = text;
  searchMsg.style.display = '';
}

function hideResults() {
  resultsSection.hidden = true;
}

function hideDetail() {
  movieDetail.hidden = true;
  hideSubtitleSections();
}
