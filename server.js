const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const WORKSPACE_DIR = __dirname;

const YEARS = ['2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'];

// Preload all JSON datasets in memory for instant responses
const datasets = {};
const summaries = {};

function computeMedian(sortedNums) {
  if (!sortedNums.length) return null;
  const mid = Math.floor(sortedNums.length / 2);
  if (sortedNums.length % 2 === 0) {
    return Math.round((sortedNums[mid - 1] + sortedNums[mid]) / 2);
  }
  return sortedNums[mid];
}

function buildYearSummary(year, records) {
  const chusSet = new Set();
  const specsSet = new Set();
  const byCell = {}; // `${chu}|||${spec}` -> { chu, specialty, count, minRank, maxRank, medianRank, avgRank, interns: [] }

  for (const r of records) {
    const chu = r.city_hospital;
    const spec = r.specialty;
    chusSet.add(chu);
    specsSet.add(spec);
    const key = `${chu}|||${spec}`;
    if (!byCell[key]) {
      byCell[key] = {
        chu,
        specialty: spec,
        interns: []
      };
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
    item.limitRank = ranks[ranks.length - 1]; // Rang limite
    item.medianRank = computeMedian(ranks);
    item.avgRank = Math.round(sum / ranks.length);
    cells.push(item);
  }

  const chus = Array.from(chusSet).sort((a, b) => a.localeCompare(b, 'fr'));
  const specialties = Array.from(specsSet).sort((a, b) => a.localeCompare(b, 'fr'));

  return {
    year,
    totalInterns: records.length,
    minRank: records.length ? records[0].rank : null,
    maxRank: records.length ? records[records.length - 1].rank : null,
    chus,
    specialties,
    cells
  };
}

function loadAllData() {
  for (const y of YEARS) {
    const filePath = path.join(WORKSPACE_DIR, `${y}.json`);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      datasets[y] = data;
      summaries[y] = buildYearSummary(y, data);
      console.log(`Loaded ${y}.json: ${data.length} interns, ${summaries[y].cells.length} (CHU, Specialty) pairs`);
    }
  }
}

loadAllData();

// Build historical index for any (CHU, Specialty) across 2017-2026
function getCellHistory(chu, specialty) {
  const history = [];
  for (const y of YEARS) {
    const sum = summaries[y];
    if (!sum) continue;
    const cell = sum.cells.find(c => c.chu === chu && c.specialty === specialty);
    history.push({
      year: y,
      count: cell ? cell.count : 0,
      minRank: cell ? cell.minRank : null,
      medianRank: cell ? cell.medianRank : null,
      limitRank: cell ? cell.limitRank : null,
      avgRank: cell ? cell.avgRank : null
    });
  }
  return history;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // API: list available years and overview counts
  if (pathname === '/api/years') {
    const result = YEARS.filter(y => summaries[y]).map(y => ({
      year: y,
      totalInterns: summaries[y].totalInterns,
      chusCount: summaries[y].chus.length,
      specialtiesCount: summaries[y].specialties.length,
      cellsCount: summaries[y].cells.length
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // API: full summary (cells + interns + limitRank + count) for a year
  if (pathname.startsWith('/api/summary/')) {
    const year = pathname.split('/')[3];
    if (!summaries[year]) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Year not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(summaries[year]));
  }

  // API: historical evolution for a specific CHU and Specialty
  if (pathname === '/api/history') {
    const chu = parsedUrl.searchParams.get('chu');
    const specialty = parsedUrl.searchParams.get('specialty');
    if (!chu || !specialty) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Missing chu or specialty parameter' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(getCellHistory(chu, specialty)));
  }

  // Serve static files from public/ or workspace root (for 2017.json..2026.json)
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '') {
    safePath = '/index.html';
  }

  let filePath = path.join(WORKSPACE_DIR, 'public', safePath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(WORKSPACE_DIR, safePath);
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`EDN/ECN Affectations Webapp listening on http://localhost:${PORT}`);
});
