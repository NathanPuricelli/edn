// Frontend application for EDN / ECN Affectations (2017-2026)

const state = {
  years: ['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017'],
  currentYear: '2026',
  summaryCache: {},
  selectedChu: '',
  selectedSpecialty: '',
  searchQuery: '',
  sortBy: 'chu_asc',
  activeView: 'cards', // 'cards' | 'matrix' | 'by_chu' | 'directory'
  showAllInternsInCards: true,
  matrixTransposed: false,
  cardsPage: 1,
  cardsPerPage: 36,
  dirPage: 1,
  dirPerPage: 100
};

// Utility: normalize accents/case for search
function normalizeStr(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('fr-FR');
}

function computeMedian(sortedNums) {
  if (!sortedNums.length) return null;
  const mid = Math.floor(sortedNums.length / 2);
  if (sortedNums.length % 2 === 0) {
    return Math.round((sortedNums[mid - 1] + sortedNums[mid]) / 2);
  }
  return sortedNums[mid];
}

// Build summary client-side if fetched directly from raw <year>.json
function buildClientSummary(year, records) {
  const chusSet = new Set();
  const specsSet = new Set();
  const byCell = {};

  for (const r of records) {
    const chu = r.city_hospital;
    const spec = r.specialty;
    chusSet.add(chu);
    specsSet.add(spec);
    const key = `${chu}|||${spec}`;
    if (!byCell[key]) {
      byCell[key] = { chu, specialty: spec, interns: [] };
    }
    byCell[key].interns.push({
      rank: r.rank,
      civility: r.civility,
      last_name: r.last_name,
      first_names: r.first_names
    });
  }

  const cells = [];
  for (const key of Object.keys(byCell)) {
    const item = byCell[key];
    item.interns.sort((a, b) => a.rank - b.rank || a.last_name.localeCompare(b.last_name, 'fr'));
    const ranks = item.interns.map(i => i.rank);
    const sum = ranks.reduce((acc, v) => acc + v, 0);
    item.count = item.interns.length;
    item.minRank = ranks[0];
    item.limitRank = ranks[ranks.length - 1];
    item.medianRank = computeMedian(ranks);
    item.avgRank = Math.round(sum / ranks.length);
    cells.push(item);
  }

  return {
    year,
    totalInterns: records.length,
    minRank: records.length ? records[0].rank : null,
    maxRank: records.length ? records[records.length - 1].rank : null,
    chus: Array.from(chusSet).sort((a, b) => a.localeCompare(b, 'fr')),
    specialties: Array.from(specsSet).sort((a, b) => a.localeCompare(b, 'fr')),
    cells
  };
}

async function fetchYearSummary(year) {
  if (state.summaryCache[year]) {
    return state.summaryCache[year];
  }
  if (window.EDN_RAW_DATASETS && window.EDN_RAW_DATASETS[year]) {
    const built = buildClientSummary(year, window.EDN_RAW_DATASETS[year]);
    state.summaryCache[year] = built;
    return built;
  }
  try {
    const res = await fetch(`/api/summary/${year}`);
    if (res.ok) {
      const data = await res.json();
      state.summaryCache[year] = data;
      return data;
    }
  } catch (_) {
    // Fallback to raw JSON file
  }
  const rawRes = await fetch(`/${year}.json`);
  const rawRecords = await rawRes.json();
  const built = buildClientSummary(year, rawRecords);
  state.summaryCache[year] = built;
  return built;
}

async function fetchCellHistory(chu, specialty) {
  if (window.EDN_RAW_DATASETS) {
    const orderedYears = ['2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'];
    const hist = [];
    for (const y of orderedYears) {
      const sum = await fetchYearSummary(y);
      const cell = sum.cells.find(c => c.chu === chu && c.specialty === specialty);
      hist.push({
        year: y,
        count: cell ? cell.count : 0,
        minRank: cell ? cell.minRank : null,
        medianRank: cell ? cell.medianRank : null,
        limitRank: cell ? cell.limitRank : null,
        avgRank: cell ? cell.avgRank : null
      });
    }
    return hist;
  }
  const res = await fetch(
    `/api/history?chu=${encodeURIComponent(chu)}&specialty=${encodeURIComponent(specialty)}`
  );
  if (!res.ok) throw new Error('History fetch failed');
  return res.json();
}

// Render year selector pills
function renderYearPills() {
  const container = document.getElementById('yearPills');
  container.innerHTML = state.years
    .map(
      y =>
        `<button type="button" class="year-pill ${y === state.currentYear ? 'active' : ''}" data-year="${y}">${y}</button>`
    )
    .join('');

  container.querySelectorAll('.year-pill').forEach(btn => {
    btn.addEventListener('click', async () => {
      const yr = btn.getAttribute('data-year');
      if (yr === state.currentYear) return;
      state.currentYear = yr;
      state.cardsPage = 1;
      state.dirPage = 1;
      renderYearPills();
      await loadAndRenderCurrentYear();
    });
  });
}

function populateSelectDropdowns(summary) {
  const chuSelect = document.getElementById('chuSelect');
  const specSelect = document.getElementById('specialtySelect');

  // Compute counts per CHU and per Specialty for helpful dropdown labels
  const chuCounts = {};
  const specCounts = {};
  for (const c of summary.cells) {
    chuCounts[c.chu] = (chuCounts[c.chu] || 0) + c.count;
    specCounts[c.specialty] = (specCounts[c.specialty] || 0) + c.count;
  }

  const prevChu = state.selectedChu;
  const prevSpec = state.selectedSpecialty;

  chuSelect.innerHTML =
    `<option value="">Tous les CHU (${summary.chus.length})</option>` +
    summary.chus
      .map(
        chu =>
          `<option value="${escapeHtml(chu)}" ${chu === prevChu ? 'selected' : ''}>${escapeHtml(chu)} (${chuCounts[chu] || 0} int.)</option>`
      )
      .join('');

  specSelect.innerHTML =
    `<option value="">Toutes les spécialités (${summary.specialties.length})</option>` +
    summary.specialties
      .map(
        sp =>
          `<option value="${escapeHtml(sp)}" ${sp === prevSpec ? 'selected' : ''}>${escapeHtml(sp)} (${specCounts[sp] || 0} int.)</option>`
      )
      .join('');
}

// Check if an intern's name (last_name + first_names) matches all search tokens
function matchesPersonName(intern, rawQuery) {
  const tokens = normalizeStr(rawQuery)
    .split(/[\s,;/-]+/)
    .filter(Boolean);
  if (!tokens.length) return false;
  const hay = normalizeStr(
    `${intern.last_name} ${(intern.first_names || []).join(' ')}`
  ).replace(/-/g, ' ');
  return tokens.every(tok => hay.includes(tok));
}

// Search people by name across the current year's summary
function searchPeopleByName(summary, rawQuery) {
  const q = (rawQuery || '').trim();
  if (!q) return [];
  const results = [];
  for (const cell of summary.cells) {
    cell.interns.forEach((intern, idx) => {
      if (matchesPersonName(intern, q)) {
        results.push({
          rank: intern.rank,
          civility: intern.civility,
          last_name: intern.last_name,
          first_names: intern.first_names || [],
          chu: cell.chu,
          specialty: cell.specialty,
          pos: idx + 1,
          cellCount: cell.count,
          limitRank: cell.limitRank
        });
      }
    });
  }
  results.sort((a, b) => a.rank - b.rank || a.last_name.localeCompare(b.last_name, 'fr'));
  return results;
}

function renderSearchResultsDropdown() {
  const dropdown = document.getElementById('searchResultsDropdown');
  const summary = state.summaryCache[state.currentYear];
  const q = state.searchQuery.trim();

  if (!summary || !q) {
    dropdown.hidden = true;
    dropdown.innerHTML = '';
    return;
  }

  const matches = searchPeopleByName(summary, q);
  dropdown.hidden = false;

  if (!matches.length) {
    dropdown.innerHTML = `<div class="search-empty">Aucune personne trouvée pour « ${escapeHtml(q)} » en ${summary.year}.</div>`;
    return;
  }

  const shown = matches.slice(0, 60);
  dropdown.innerHTML =
    `<div class="search-results-header">${formatNumber(matches.length)} personne(s) trouvée(s) en ${summary.year} — cliquez pour ouvrir son CHU et sa spécialité</div>` +
    shown
      .map(
        (p, idx) => `<button type="button" class="search-result-item" data-idx="${idx}">
          <div class="search-result-top">
            <span class="search-result-name">${escapeHtml(p.civility)} ${escapeHtml(p.last_name)} (${escapeHtml(p.first_names.join(', '))})</span>
            <span class="rank-pill">Rang #${formatNumber(p.rank)}</span>
          </div>
          <div class="search-result-meta">
            <span class="badge badge-chu">${escapeHtml(p.chu)}</span>
            <span><strong>${escapeHtml(p.specialty)}</strong></span>
            <span>· Place ${p.pos}/${p.cellCount} (Rang lim. ${formatNumber(p.limitRank)})</span>
          </div>
        </button>`
      )
      .join('');

  dropdown.querySelectorAll('.search-result-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = shown[Number(btn.getAttribute('data-idx'))];
      if (p) selectPersonFromSearch(p);
    });
  });
}

function selectPersonFromSearch(person) {
  state.selectedChu = person.chu;
  state.selectedSpecialty = person.specialty;
  state.selectedPerson = person;
  state.cardsPage = 1;
  state.dirPage = 1;

  document.getElementById('chuSelect').value = person.chu;
  document.getElementById('specialtySelect').value = person.specialty;
  document.getElementById('searchInput').value = `${person.last_name} ${person.first_names.join(' ')}`;
  document.getElementById('clearSearchBtn').hidden = false;
  document.getElementById('searchResultsDropdown').hidden = true;

  // Automatically switch to the CHU & Specialty detail view
  state.activeView = 'cards';
  document.querySelectorAll('.view-tab').forEach(t => {
    t.classList.toggle('active', t.getAttribute('data-view') === 'cards');
  });

  renderActiveView();

  // Scroll highlighted person into view inside the card if needed
  setTimeout(() => {
    const matchRow = document.querySelector('.interns-mini-table tr.search-match');
    if (matchRow) {
      matchRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, 50);
}

// Filter cells according to selected CHU and Specialty
function getFilteredCells(summary) {
  let filtered = summary.cells.filter(cell => {
    if (state.selectedChu && cell.chu !== state.selectedChu) return false;
    if (state.selectedSpecialty && cell.specialty !== state.selectedSpecialty) return false;
    return true;
  });

  // Sort cells
  filtered.sort((a, b) => {
    switch (state.sortBy) {
      case 'chu_asc':
        return a.chu.localeCompare(b.chu, 'fr') || a.specialty.localeCompare(b.specialty, 'fr');
      case 'spec_asc':
        return a.specialty.localeCompare(b.specialty, 'fr') || a.chu.localeCompare(b.chu, 'fr');
      case 'limit_asc':
        return a.limitRank - b.limitRank || a.chu.localeCompare(b.chu, 'fr');
      case 'limit_desc':
        return b.limitRank - a.limitRank || a.chu.localeCompare(b.chu, 'fr');
      case 'count_desc':
        return b.count - a.count || a.limitRank - b.limitRank;
      case 'count_asc':
        return a.count - b.count || a.limitRank - b.limitRank;
      case 'min_asc':
        return a.minRank - b.minRank || a.limitRank - b.limitRank;
      default:
        return 0;
    }
  });

  return filtered;
}

function updateKPIs(summary, filteredCells) {
  document.getElementById('kpiYear').textContent = summary.year;
  document.getElementById('kpiYearSub').textContent =
    summary.year >= '2024' ? 'EDN (Groupes de spécialités)' : 'ECN (Classement unique)';

  let internsCount = 0;
  let minR = Infinity;
  let maxR = -Infinity;
  const chusPresent = new Set();
  const specsPresent = new Set();

  for (const c of filteredCells) {
    internsCount += c.count;
    if (c.minRank < minR) minR = c.minRank;
    if (c.limitRank > maxR) maxR = c.limitRank;
    chusPresent.add(c.chu);
    specsPresent.add(c.specialty);
  }

  document.getElementById('kpiInternsCount').textContent = formatNumber(internsCount);
  document.getElementById('kpiInternsTotal').textContent = `sur ${formatNumber(summary.totalInterns)} au total en ${summary.year}`;
  document.getElementById('kpiCellsCount').textContent = formatNumber(filteredCells.length);
  document.getElementById('kpiChusSpecsCount').textContent = `${chusPresent.size} CHU · ${specsPresent.size} spécialités`;
  document.getElementById('kpiMinRank').textContent = minR === Infinity ? '—' : formatNumber(minR);
  document.getElementById('kpiLimitRank').textContent = maxR === -Infinity ? '—' : formatNumber(maxR);
}

// View 1: Cards per (CHU, Specialty)
function renderCardsView(summary, filteredCells) {
  const grid = document.getElementById('cardsGrid');
  const statusEl = document.getElementById('cardsStatusText');
  const pagEl = document.getElementById('cardsPagination');

  const totalCards = filteredCells.length;
  const totalPages = Math.max(1, Math.ceil(totalCards / state.cardsPerPage));
  if (state.cardsPage > totalPages) state.cardsPage = totalPages;

  const startIdx = (state.cardsPage - 1) * state.cardsPerPage;
  const pageCells = filteredCells.slice(startIdx, startIdx + state.cardsPerPage);

  statusEl.innerHTML = `Affichage de <strong>${formatNumber(pageCells.length)}</strong> sur <strong>${formatNumber(totalCards)}</strong> couples (CHU × Spécialité) — <strong>Effectif</strong>, <strong>Rang limite</strong> et <strong>liste des internes affectés</strong>.`;

  if (!pageCells.length) {
    grid.innerHTML = `<div class="kpi-card" style="grid-column: 1 / -1; text-align:center; padding: 32px;">Aucun résultat ne correspond à vos critères de recherche.</div>`;
    pagEl.innerHTML = '';
    return;
  }

  grid.innerHTML = pageCells
    .map(cell => {
      const rowsHtml = cell.interns
        .map((intern, idx) => {
          const isLast = idx === cell.interns.length - 1;
          const isSelectedPerson =
            state.selectedPerson &&
            state.selectedPerson.rank === intern.rank &&
            state.selectedPerson.last_name === intern.last_name;
          const isMatch =
            isSelectedPerson ||
            (state.searchQuery.trim() && matchesPersonName(intern, state.searchQuery));
          const rowClass = [
            isLast ? 'is-limit-row' : '',
            isMatch ? 'search-match' : ''
          ]
            .filter(Boolean)
            .join(' ');

          return `<tr class="${rowClass}">
            <td class="pos-idx">${idx + 1}/${cell.count}</td>
            <td><span class="rank-pill">${formatNumber(intern.rank)}</span></td>
            <td>${escapeHtml(intern.civility)}</td>
            <td><strong>${escapeHtml(intern.last_name)}</strong> (${escapeHtml((intern.first_names || []).join(', '))})</td>
          </tr>`;
        })
        .join('');

      return `<article class="cell-card">
        <div class="cell-card-header">
          <div class="cell-card-titles">
            <div class="badge-row">
              <span class="badge badge-chu">${escapeHtml(cell.chu)}</span>
              <span class="badge badge-year">${escapeHtml(summary.year)}</span>
            </div>
            <h3 class="cell-specialty-title">${escapeHtml(cell.specialty)}</h3>
          </div>
          <button type="button" class="btn-history" data-chu="${escapeHtml(cell.chu)}" data-spec="${escapeHtml(cell.specialty)}">
            📈 Détails &amp; 2017–2026
          </button>
        </div>

        <div class="cell-metrics">
          <div class="metric-box count-highlight">
            <span class="metric-label">Nb d'internes</span>
            <span class="metric-val">${formatNumber(cell.count)}</span>
          </div>
          <div class="metric-box limit-highlight">
            <span class="metric-label">Rang limite</span>
            <span class="metric-val">${formatNumber(cell.limitRank)}</span>
          </div>
          <div class="metric-box">
            <span class="metric-label">1er Rang</span>
            <span class="metric-val">${formatNumber(cell.minRank)}</span>
          </div>
          <div class="metric-box">
            <span class="metric-label">Rang médian</span>
            <span class="metric-val">${formatNumber(cell.medianRank)}</span>
          </div>
        </div>

        <div class="cell-interns-wrap ${state.showAllInternsInCards ? 'expanded' : ''}">
          <table class="interns-mini-table">
            <thead>
              <tr>
                <th>Place</th>
                <th>Rang</th>
                <th>Civ.</th>
                <th>Nom (Prénoms)</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </article>`;
    })
    .join('');

  grid.querySelectorAll('.btn-history').forEach(btn => {
    btn.addEventListener('click', () => {
      openCellModal(btn.getAttribute('data-chu'), btn.getAttribute('data-spec'));
    });
  });

  renderPagination(pagEl, state.cardsPage, totalPages, newPage => {
    state.cardsPage = newPage;
    renderCardsView(summary, filteredCells);
    window.scrollTo({ top: 180, behavior: 'smooth' });
  });
}

// Heatmap helper for Matrix view
function getHeatClass(limitRank, maxOverallRank) {
  if (!limitRank || !maxOverallRank) return '';
  const ratio = limitRank / maxOverallRank;
  if (ratio <= 0.18) return 'heat-1';
  if (ratio <= 0.36) return 'heat-2';
  if (ratio <= 0.56) return 'heat-3';
  if (ratio <= 0.78) return 'heat-4';
  return 'heat-5';
}

// View 2: 2D Matrix CHU x Specialty
function renderMatrixView(summary, filteredCells) {
  const container = document.getElementById('matrixContainer');

  const cellMap = {};
  for (const c of filteredCells) {
    cellMap[`${c.chu}|||${c.specialty}`] = c;
  }

  const chus = state.selectedChu ? [state.selectedChu] : summary.chus;
  const specs = state.selectedSpecialty ? [state.selectedSpecialty] : summary.specialties;

  const rows = state.matrixTransposed ? chus : specs;
  const cols = state.matrixTransposed ? specs : chus;
  const rowHeaderLabel = state.matrixTransposed ? 'CHU \\ Spécialité' : 'Spécialité \\ CHU';

  const maxRank = summary.maxRank || 10000;

  let html = `<table class="matrix-table"><thead><tr><th>${rowHeaderLabel}</th>`;
  for (const col of cols) {
    html += `<th>${escapeHtml(col)}</th>`;
  }
  html += `<th>Total Internes</th><th>Rang Limite Max</th></tr></thead><tbody>`;

  for (const row of rows) {
    let rowTotalInterns = 0;
    let rowMaxLimit = 0;
    html += `<tr><th>${escapeHtml(row)}</th>`;

    for (const col of cols) {
      const chu = state.matrixTransposed ? row : col;
      const spec = state.matrixTransposed ? col : row;
      const cell = cellMap[`${chu}|||${spec}`];

      if (cell) {
        rowTotalInterns += cell.count;
        if (cell.limitRank > rowMaxLimit) rowMaxLimit = cell.limitRank;
        const heatClass = getHeatClass(cell.limitRank, maxRank);
        html += `<td class="matrix-cell ${heatClass}" data-chu="${escapeHtml(chu)}" data-spec="${escapeHtml(spec)}" title="${escapeHtml(chu)} — ${escapeHtml(spec)} : ${cell.count} internes, Rang limite ${cell.limitRank}">
          <span class="m-limit">${formatNumber(cell.limitRank)}</span>
          <span class="m-count">${cell.count} int.</span>
        </td>`;
      } else {
        html += `<td class="matrix-empty">—</td>`;
      }
    }

    html += `<td style="text-align:center;font-weight:700;background:#f8fafc;">${formatNumber(rowTotalInterns)}</td>`;
    html += `<td style="text-align:center;font-weight:700;background:#fffbeb;color:#b45309;">${rowMaxLimit ? formatNumber(rowMaxLimit) : '—'}</td>`;
    html += `</tr>`;
  }

  html += `</tbody></table>`;
  container.innerHTML = html;

  container.querySelectorAll('.matrix-cell').forEach(td => {
    td.addEventListener('click', () => {
      openCellModal(td.getAttribute('data-chu'), td.getAttribute('data-spec'));
    });
  });
}

// View 3: Synthesis by CHU
function renderByChuView(summary, filteredCells) {
  const container = document.getElementById('byChuContainer');
  const byChu = {};

  for (const c of filteredCells) {
    if (!byChu[c.chu]) {
      byChu[c.chu] = {
        chu: c.chu,
        totalInterns: 0,
        minRank: Infinity,
        limitRank: -Infinity,
        cells: []
      };
    }
    const g = byChu[c.chu];
    g.totalInterns += c.count;
    if (c.minRank < g.minRank) g.minRank = c.minRank;
    if (c.limitRank > g.limitRank) g.limitRank = c.limitRank;
    g.cells.push(c);
  }

  const chuGroups = Object.values(byChu).sort((a, b) => a.chu.localeCompare(b.chu, 'fr'));
  if (!chuGroups.length) {
    container.innerHTML = `<div class="kpi-card">Aucun CHU trouvé pour ce filtre.</div>`;
    return;
  }

  container.innerHTML = chuGroups
    .map(g => {
      g.cells.sort((a, b) => a.specialty.localeCompare(b.specialty, 'fr'));
      const rowsHtml = g.cells
        .map(cell => {
          const internsChips = cell.interns
            .map(
              i =>
                `<span class="intern-inline-chip"><strong>#${formatNumber(i.rank)}</strong> ${escapeHtml(i.civility)} ${escapeHtml(i.last_name)} (${escapeHtml((i.first_names || []).join(', '))})</span>`
            )
            .join('');

          return `<tr>
            <td><strong>${escapeHtml(cell.specialty)}</strong></td>
            <td style="font-weight:700;color:var(--success);">${formatNumber(cell.count)}</td>
            <td>${formatNumber(cell.minRank)}</td>
            <td>${formatNumber(cell.medianRank)}</td>
            <td style="font-weight:800;color:var(--warning);background:#fffbeb;">${formatNumber(cell.limitRank)}</td>
            <td>${internsChips}</td>
            <td>
              <button type="button" class="btn-history" data-chu="${escapeHtml(cell.chu)}" data-spec="${escapeHtml(cell.specialty)}">
                Détails
              </button>
            </td>
          </tr>`;
        })
        .join('');

      return `<div class="chu-panel">
        <div class="chu-panel-header">
          <div class="chu-panel-title">
            <span class="badge badge-chu" style="font-size:13px;padding:4px 10px;">${escapeHtml(g.chu)}</span>
            <h3>${escapeHtml(g.chu)} — ${formatNumber(g.totalInterns)} internes (${g.cells.length} spécialités)</h3>
          </div>
          <div class="chu-panel-stats">
            <span>1er rang : <strong>${formatNumber(g.minRank)}</strong></span>
            <span>Rang limite global du CHU : <strong style="color:var(--warning);">${formatNumber(g.limitRank)}</strong></span>
          </div>
        </div>
        <div class="chu-panel-body">
          <div class="table-responsive" style="border:none;border-radius:0;">
            <table class="data-table compact">
              <thead>
                <tr>
                  <th style="width:210px;">Spécialité</th>
                  <th style="width:85px;">Nb Internes</th>
                  <th style="width:85px;">1er Rang</th>
                  <th style="width:95px;">Rang Médian</th>
                  <th style="width:105px;">Rang Limite</th>
                  <th>Internes affectés (Rang &amp; Identité)</th>
                  <th style="width:80px;">Historique</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
    })
    .join('');

  container.querySelectorAll('.btn-history').forEach(btn => {
    btn.addEventListener('click', () => {
      openCellModal(btn.getAttribute('data-chu'), btn.getAttribute('data-spec'));
    });
  });
}

// View 4: Directory of all matching interns
function renderDirectoryView(summary, filteredCells) {
  const tbody = document.getElementById('directoryTableBody');
  const statusEl = document.getElementById('directoryStatusText');
  const pagEl = document.getElementById('directoryPagination');

  const hasNameQuery = Boolean(state.searchQuery.trim());
  const flatInterns = [];

  for (const cell of filteredCells) {
    cell.interns.forEach((intern, idx) => {
      if (hasNameQuery && !matchesPersonName(intern, state.searchQuery)) {
        return;
      }
      flatInterns.push({
        rank: intern.rank,
        civility: intern.civility,
        last_name: intern.last_name,
        first_names: intern.first_names,
        chu: cell.chu,
        specialty: cell.specialty,
        pos: idx + 1,
        cellCount: cell.count,
        limitRank: cell.limitRank
      });
    });
  }

  flatInterns.sort((a, b) => a.rank - b.rank || a.last_name.localeCompare(b.last_name, 'fr'));

  const total = flatInterns.length;
  const totalPages = Math.max(1, Math.ceil(total / state.dirPerPage));
  if (state.dirPage > totalPages) state.dirPage = totalPages;

  const startIdx = (state.dirPage - 1) * state.dirPerPage;
  const pageItems = flatInterns.slice(startIdx, startIdx + state.dirPerPage);

  statusEl.innerHTML = `<strong>${formatNumber(total)}</strong> internes trouvés en <strong>${summary.year}</strong> (triés par rang).`;

  tbody.innerHTML = pageItems
    .map(
      item => `<tr>
      <td><span class="rank-pill">${formatNumber(item.rank)}</span></td>
      <td>${escapeHtml(item.civility)}</td>
      <td><strong>${escapeHtml(item.last_name)}</strong></td>
      <td>${escapeHtml((item.first_names || []).join(', '))}</td>
      <td><span class="badge badge-chu">${escapeHtml(item.chu)}</span></td>
      <td>${escapeHtml(item.specialty)}</td>
      <td><strong>${item.pos}</strong> / ${item.cellCount}</td>
      <td style="font-weight:700;color:var(--warning);">${formatNumber(item.limitRank)}</td>
      <td>
        <button type="button" class="btn-history" data-chu="${escapeHtml(item.chu)}" data-spec="${escapeHtml(item.specialty)}">
          Voir le poste
        </button>
      </td>
    </tr>`
    )
    .join('');

  tbody.querySelectorAll('.btn-history').forEach(btn => {
    btn.addEventListener('click', () => {
      openCellModal(btn.getAttribute('data-chu'), btn.getAttribute('data-spec'));
    });
  });

  renderPagination(pagEl, state.dirPage, totalPages, newPage => {
    state.dirPage = newPage;
    renderDirectoryView(summary, filteredCells);
    window.scrollTo({ top: 180, behavior: 'smooth' });
  });
}

function renderPagination(container, currentPage, totalPages, onPageChange) {
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }
  const pages = [];
  pages.push(1);
  for (let p = Math.max(2, currentPage - 2); p <= Math.min(totalPages - 1, currentPage + 2); p++) {
    pages.push(p);
  }
  if (totalPages > 1) pages.push(totalPages);
  const uniquePages = Array.from(new Set(pages)).sort((a, b) => a - b);

  let html = `<button type="button" class="page-btn" data-p="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>← Précédent</button>`;
  let prev = 0;
  for (const p of uniquePages) {
    if (p - prev > 1) {
      html += `<span style="padding:0 6px;color:var(--text-light);">…</span>`;
    }
    html += `<button type="button" class="page-btn ${p === currentPage ? 'active' : ''}" data-p="${p}">${p}</button>`;
    prev = p;
  }
  html += `<button type="button" class="page-btn" data-p="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>Suivant →</button>`;

  container.innerHTML = html;
  container.querySelectorAll('.page-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      onPageChange(Number(btn.getAttribute('data-p')));
    });
  });
}

function renderActiveView() {
  const summary = state.summaryCache[state.currentYear];
  if (!summary) return;

  const filteredCells = getFilteredCells(summary);
  updateKPIs(summary, filteredCells);

  document.getElementById('viewCards').hidden = state.activeView !== 'cards';
  document.getElementById('viewMatrix').hidden = state.activeView !== 'matrix';
  document.getElementById('viewByChu').hidden = state.activeView !== 'by_chu';
  document.getElementById('viewDirectory').hidden = state.activeView !== 'directory';

  if (state.activeView === 'cards') {
    renderCardsView(summary, filteredCells);
  } else if (state.activeView === 'matrix') {
    renderMatrixView(summary, filteredCells);
  } else if (state.activeView === 'by_chu') {
    renderByChuView(summary, filteredCells);
  } else if (state.activeView === 'directory') {
    renderDirectoryView(summary, filteredCells);
  }
}

async function loadAndRenderCurrentYear() {
  const summary = await fetchYearSummary(state.currentYear);
  populateSelectDropdowns(summary);
  renderActiveView();
}

// Modal for inspecting a specific (CHU, Specialty) and its 2017-2026 history
async function openCellModal(chu, specialty) {
  const summary = state.summaryCache[state.currentYear];
  if (!summary) return;
  const cell = summary.cells.find(c => c.chu === chu && c.specialty === specialty);

  document.getElementById('modalChuBadge').textContent = chu;
  document.getElementById('modalYearBadge').textContent = `Promotion ${state.currentYear}`;
  document.getElementById('modalTitle').textContent = specialty;

  document.getElementById('modalCount').textContent = cell ? formatNumber(cell.count) : '0';
  document.getElementById('modalLimitRank').textContent = cell ? formatNumber(cell.limitRank) : '—';
  document.getElementById('modalMinRank').textContent = cell ? formatNumber(cell.minRank) : '—';
  document.getElementById('modalMedianRank').textContent = cell ? formatNumber(cell.medianRank) : '—';

  const internsBody = document.getElementById('modalInternsBody');
  if (cell && cell.interns.length) {
    internsBody.innerHTML = cell.interns
      .map((i, idx) => {
        const isLast = idx === cell.interns.length - 1;
        return `<tr class="${isLast ? 'is-limit-row' : ''}">
          <td>${idx + 1}/${cell.count}</td>
          <td><span class="rank-pill">${formatNumber(i.rank)}</span></td>
          <td>${escapeHtml(i.civility)}</td>
          <td><strong>${escapeHtml(i.last_name)}</strong> (${escapeHtml((i.first_names || []).join(', '))})</td>
        </tr>`;
      })
      .join('');
  } else {
    internsBody.innerHTML = `<tr><td colspan="4">Aucun interne affecté sur ce poste en ${state.currentYear}.</td></tr>`;
  }

  const modal = document.getElementById('cellModal');
  modal.hidden = false;

  // Fetch 2017-2026 history
  const histBody = document.getElementById('modalHistoryBody');
  const histChart = document.getElementById('modalHistoryChart');
  histBody.innerHTML = `<tr><td colspan="5">Chargement de l'historique 2017–2026...</td></tr>`;

  try {
    const history = await fetchCellHistory(chu, specialty);
    if (history && history.length) {
      const maxLim = Math.max(...history.map(h => h.limitRank || 0), 1);

      histChart.innerHTML =
        `<div style="font-size:11.5px;color:var(--text-muted);font-weight:600;margin-bottom:4px;">Évolution du Rang Limite (2017–2026)</div>` +
        `<div class="hist-bars">` +
        history
          .map(h => {
            const pct = h.limitRank ? Math.max(8, Math.round((h.limitRank / maxLim) * 75)) : 0;
            const isCur = h.year === state.currentYear;
            return `<div class="hist-bar-col">
              <span class="hist-val">${h.limitRank ? formatNumber(h.limitRank) : '—'}</span>
              <div class="hist-bar ${isCur ? 'current-year' : ''}" style="height:${pct}px;" title="${h.year}: Rang limite ${h.limitRank ?? '—'} (${h.count} internes)"></div>
              <span class="hist-yr">${h.year}</span>
            </div>`;
          })
          .join('') +
        `</div>`;

      histBody.innerHTML = history
        .slice()
        .reverse()
        .map(
          h => `<tr style="${h.year === state.currentYear ? 'background:#fffbeb;font-weight:700;' : ''}">
          <td><strong>${h.year}</strong></td>
          <td>${formatNumber(h.count)}</td>
          <td>${formatNumber(h.minRank)}</td>
          <td>${formatNumber(h.medianRank)}</td>
          <td style="color:var(--warning);font-weight:700;">${formatNumber(h.limitRank)}</td>
        </tr>`
        )
        .join('');
    }
  } catch (e) {
    histBody.innerHTML = `<tr><td colspan="5">Historique indisponible.</td></tr>`;
  }
}

// Export currently filtered selection to CSV
function exportCurrentSelectionCsv() {
  const summary = state.summaryCache[state.currentYear];
  if (!summary) return;
  const filteredCells = getFilteredCells(summary);

  const lines = [
    ['Annee', 'CHU', 'Specialite', 'Effectif_Poste', 'Premier_Rang_Poste', 'Rang_Median_Poste', 'Rang_Limite_Poste', 'Position_Interne', 'Rang_Interne', 'Civilite', 'Nom', 'Prenoms'].join(';')
  ];

  for (const c of filteredCells) {
    c.interns.forEach((i, idx) => {
      lines.push(
        [
          summary.year,
          `"${c.chu}"`,
          `"${c.specialty}"`,
          c.count,
          c.minRank,
          c.medianRank,
          c.limitRank,
          idx + 1,
          i.rank,
          `"${i.civility}"`,
          `"${i.last_name}"`,
          `"${(i.first_names || []).join(', ')}"`
        ].join(';')
      );
    });
  }

  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `affectations_internes_${state.currentYear}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Wire up UI events
document.addEventListener('DOMContentLoaded', async () => {
  renderYearPills();

  document.getElementById('chuSelect').addEventListener('change', e => {
    state.selectedChu = e.target.value;
    state.cardsPage = 1;
    state.dirPage = 1;
    renderActiveView();
  });

  document.getElementById('specialtySelect').addEventListener('change', e => {
    state.selectedSpecialty = e.target.value;
    state.cardsPage = 1;
    state.dirPage = 1;
    renderActiveView();
  });

  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  const searchGroup = document.getElementById('searchGroup');
  const searchDropdown = document.getElementById('searchResultsDropdown');

  searchInput.addEventListener('input', e => {
    state.searchQuery = e.target.value;
    state.selectedPerson = null;
    clearSearchBtn.hidden = !state.searchQuery;
    renderSearchResultsDropdown();
    if (state.activeView === 'directory') {
      state.dirPage = 1;
      renderActiveView();
    }
  });

  searchInput.addEventListener('focus', () => {
    if (state.searchQuery.trim()) {
      renderSearchResultsDropdown();
    }
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const summary = state.summaryCache[state.currentYear];
      if (!summary) return;
      const matches = searchPeopleByName(summary, state.searchQuery);
      if (matches.length > 0) {
        selectPersonFromSearch(matches[0]);
      }
    } else if (e.key === 'Escape') {
      searchDropdown.hidden = true;
    }
  });

  document.addEventListener('click', e => {
    if (searchGroup && !searchGroup.contains(e.target)) {
      searchDropdown.hidden = true;
    }
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    state.selectedPerson = null;
    clearSearchBtn.hidden = true;
    searchDropdown.hidden = true;
    renderActiveView();
  });

  document.getElementById('sortSelect').addEventListener('change', e => {
    state.sortBy = e.target.value;
    state.cardsPage = 1;
    renderActiveView();
  });

  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.activeView = tab.getAttribute('data-view');
      renderActiveView();
    });
  });

  document.getElementById('showAllInternsToggle').addEventListener('change', e => {
    state.showAllInternsInCards = e.target.checked;
    document.querySelectorAll('.cell-interns-wrap').forEach(el => {
      el.classList.toggle('expanded', state.showAllInternsInCards);
    });
  });

  document.getElementById('transposeMatrixBtn').addEventListener('click', () => {
    state.matrixTransposed = !state.matrixTransposed;
    renderActiveView();
  });

  document.getElementById('resetFiltersBtn').addEventListener('click', () => {
    state.selectedChu = '';
    state.selectedSpecialty = '';
    state.searchQuery = '';
    state.selectedPerson = null;
    state.sortBy = 'chu_asc';
    state.cardsPage = 1;
    state.dirPage = 1;
    document.getElementById('chuSelect').value = '';
    document.getElementById('specialtySelect').value = '';
    document.getElementById('searchInput').value = '';
    document.getElementById('clearSearchBtn').hidden = true;
    document.getElementById('searchResultsDropdown').hidden = true;
    document.getElementById('sortSelect').value = 'chu_asc';
    renderActiveView();
  });

  document.getElementById('exportCsvBtn').addEventListener('click', exportCurrentSelectionCsv);

  const modal = document.getElementById('cellModal');
  document.getElementById('closeModalBtn').addEventListener('click', () => {
    modal.hidden = true;
  });
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.hidden = true;
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });

  await loadAndRenderCurrentYear();
});
