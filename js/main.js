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
    img.src = m.poster || POSTER_PLACEHOLDER;
    img.alt = m.title;
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
  detailPoster.alt = movie.title;
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
  renderPeople(movie.directors, movie.writers);
  renderGenresTags(movie.genres_imdb, movie.genres_ml, movie.tags);
  renderSubtitleData(movie);
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

// ── People ───────────────────────────────────────────────────────────────────

function renderPeople(directors, writers) {
  const container = document.getElementById('detailPeople');
  container.innerHTML = '';

  function capitalize(text) {
    return text.toLowerCase().split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  [['Directors', directors], ['Writers', writers]].forEach(([label, people]) => {
    if (!people || people.length === 0) return;

    const group = document.createElement('div');
    group.className = 'people-group';

    const heading = document.createElement('span');
    heading.className   = 'meta-label';
    heading.textContent = label;
    group.appendChild(heading);

    people.forEach(p => {
      const attrs = ['gender', 'race', 'nationality', 'ethnicity', 'religion']
        .filter(k => p[k]).map(k => p[k].toLowerCase()).join(' · ');

      const line = document.createElement('div');
      line.className = 'person-line';

      const nameSpan = document.createElement('span');
      nameSpan.className   = 'person-line-name';
      nameSpan.textContent = capitalize(p.name || '');
      line.appendChild(nameSpan);

      if (attrs) line.appendChild(document.createTextNode(' — ' + attrs));
      group.appendChild(line);
    });

    container.appendChild(group);
  });
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

const SUBTITLE_SECTIONS = ['subtitleRaw', 'subtitleThemes', 'subtitleInitcap', 'subtitleGeo', 'subtitleReg'];

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

function renderSubtitleRaw(imdbId) {
  const section = document.getElementById('subtitleRaw');
  if (!imdbId) { section.hidden = true; return; }
  document.querySelectorAll('input[name="subtitleLang"]').forEach(r => { r.checked = r.value === 'EN'; });
  _resetSection(section);
  loadSubtitleRaw(imdbId, 'EN');
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
  renderSubtitleThemes('subtitleThemes',  movie.subtitle_themes);
  renderSubtitleThemes('subtitleReg',     movie.subtitle_reg, 'Region / Word');
  renderSubtitleList('subtitleInitcap', movie.subtitle_initcap, 'word',     'Word');
  renderSubtitleList('subtitleGeo',     movie.subtitle_geo,     'location', 'Location');
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
