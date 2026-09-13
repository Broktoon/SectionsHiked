#!/usr/bin/env node
/**
 * build-pct-data.js
 *
 * Rebuilds the Pacific Crest Trail data files on the canonical points.json
 * schema, using the Pacific Crest Trail Association's own published GIS.
 *
 * Why a rebuild rather than a field-fill: the previous points.json was
 * interpolated from a simplified shapefile and then linearly rescaled to an
 * assumed 2,653.0-mile total. Uniform rescaling of a simplified line does not
 * reproduce official mileage — measured against PCTA's 2026 mile markers, the
 * old axis drifted up to 7 miles (worst around miles 250-750, back to ~0 north
 * of mile 1000). It also carried no section or region structure at all.
 *
 * Sources (all PCTA, ArcGIS Online org ZldHa25efPFpMmfB):
 *   PCT Mile Markers 2026   — official half-mile markers with lat/lon.
 *                             THIS IS THE MILE AXIS. 5,311 markers with
 *                             coordinates, miles 0.5 - 2,655.5.
 *   PCT Letter Sections     — PCTA's 29 lettered sections (CA A-R, OR B-G,
 *                             WA H-L).
 *   PCTA Centerline Regions — PCTA's 6 administrative regions.
 *
 * Section and region boundaries are derived by snapping each mile marker to
 * the nearest section/region geometry, NOT by reading the section layer's own
 * southern_mileage/northern_mileage fields. Those fields sit on a different,
 * longer axis (they sum to 2,662.38) and disagree with the marker axis by up
 * to ~2 miles. Snapping keeps every boundary on one axis.
 *
 * Note: PCTA's letter sections deliberately do NOT follow state lines. CA
 * Section R runs to Interstate 5 near Ashland, ~27 miles inside Oregon. The
 * per-point `state` field is therefore computed independently, by polygon
 * test — never inferred from the section's letter prefix.
 *
 * Termini: the marker set starts at 0.5 and ends at 2,655.5 (lat 48.998, just
 * short of the border). Mile 0 and the northern terminus are taken from the
 * endpoints of PCTA's own Full_PCT shapefile, giving a 0 - 2,655.6 axis.
 *
 * Elevation: OpenTopoData SRTM 90m, cached and resume-safe.
 *
 * Run: node scripts/build-pct-data.js
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const CACHE = path.join(__dirname, 'cache');
const DATA  = path.join(__dirname, '..', 'public', 'trails', 'pacific-crest-trail', 'data');

const MARKERS_CACHE  = path.join(CACHE, 'pcta_mile_markers_2026.json');
const SECTIONS_CACHE = path.join(CACHE, 'pcta_letter_sections.geojson');
const REGIONS_CACHE  = path.join(CACHE, 'pcta_regions.geojson');
const ASSIGN_CACHE   = path.join(CACHE, 'pcta_assignment.json');
const ELEV_CACHE     = path.join(CACHE, 'pct_elevations.json');

// Census TIGERweb boundaries for CA/OR/WA, not the coarse us_states.geojson the
// AT pipeline uses. That file is generalised enough to put the Columbia River
// crossing 2.5 miles late and the 42nd-parallel crossing 1.5 miles late.
// Refetch with:
//   https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/
//     MapServer/0/query?where=STATE IN ('06','41','53')&outFields=NAME,STATE
//     &outSR=4326&f=geojson
const STATES_CACHE   = path.join(CACHE, 'census_states_ca_or_wa.geojson');

// The CA/OR border is the 42nd parallel by law, so the parallel beats any
// digitised polygon. TIGER's line sits a few hundred metres north of it.
const LAT_CA_OR = 42.0;

const SIMPLIFIED = path.join(DATA, 'Full_PCT_Simplified.geojson');

const FS_BASE = 'https://services5.arcgis.com/ZldHa25efPFpMmfB/arcgis/rest/services';

const REGION_IDS = {
  'Southern California'                   : 'socal',
  'Southern Sierra'                       : 'southern-sierra',
  'Northern Sierra'                       : 'northern-sierra',
  'Northern California / Southern Oregon' : 'norcal-soor',
  'Central Cascades'                      : 'central-cascades',
  'North Cascades'                        : 'north-cascades',
};

const STATE_NAMES = { CA: 'California', OR: 'Oregon', WA: 'Washington' };

// ── Geometry helpers ──────────────────────────────────────────────────────────

function haversine(la1, lo1, la2, lo2) {
  const R = 3958.8, t = Math.PI / 180;
  const dLa = (la2 - la1) * t, dLo = (lo2 - lo1) * t;
  const s = Math.sin(dLa / 2) ** 2
    + Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

// Ray-casting point-in-polygon for one ring of [lon, lat] pairs.
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat)
      && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inFeature(lon, lat, geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) {
    const [outer, ...holes] = poly;
    if (!inRing(lon, lat, outer)) continue;
    if (holes.some(h => inRing(lon, lat, h))) continue;
    return true;
  }
  return false;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location));
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('bad JSON from ' + url + ': ' + e.message)); }
      });
    }).on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Stage 1: fetch sources ────────────────────────────────────────────────────

async function fetchMarkers() {
  if (fs.existsSync(MARKERS_CACHE)) {
    console.log('  markers: cached');
    return JSON.parse(fs.readFileSync(MARKERS_CACHE, 'utf8'));
  }
  console.log('  markers: fetching PCT_Mile_Markers_2026...');
  let all = [];
  for (let off = 0; ; off += 2000) {
    const u = FS_BASE + '/PCT_Mile_Markers_2026/FeatureServer/0/query'
      + '?where=1%3D1&outFields=Mile,lat,lon,RouteID,Input&returnGeometry=false'
      + '&resultOffset=' + off + '&resultRecordCount=2000&f=json';
    const j = await get(u);
    const feats = j.features || [];
    all = all.concat(feats.map(f => f.attributes));
    if (feats.length < 2000) break;
  }
  fs.writeFileSync(MARKERS_CACHE, JSON.stringify(all));
  return all;
}

async function fetchLayer(service, cacheFile, label) {
  if (fs.existsSync(cacheFile)) {
    console.log('  ' + label + ': cached');
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  console.log('  ' + label + ': fetching ' + service + ' (large, may take a minute)...');
  const u = FS_BASE + '/' + service + '/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson';
  const j = await get(u);
  fs.writeFileSync(cacheFile, JSON.stringify(j));
  return j;
}

// ── Stage 2: assign each marker to a section and region ───────────────────────

const CELL = 0.02;

function buildIndex(geojson, nameProp) {
  const names = [], grid = new Map();
  geojson.features.forEach((f, fi) => {
    names.push(f.properties[nameProp]);
    const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const part of parts) for (const c of part) {
      const k = Math.floor(c[1] / CELL) + ':' + Math.floor(c[0] / CELL);
      let a = grid.get(k);
      if (!a) { a = []; grid.set(k, a); }
      a.push(c[1], c[0], fi);
    }
  });
  return { names, grid };
}

function nearestFeature(idx, la, lo) {
  let best = null, bd = Infinity;
  for (let r = 1; r <= 8; r++) {
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      if (r > 1 && Math.abs(i) < r && Math.abs(j) < r) continue;
      const a = idx.grid.get((Math.floor(la / CELL) + i) + ':' + (Math.floor(lo / CELL) + j));
      if (!a) continue;
      for (let k = 0; k < a.length; k += 3) {
        const d = haversine(la, lo, a[k], a[k + 1]);
        if (d < bd) { bd = d; best = a[k + 2]; }
      }
    }
    // Stop once the ring searched is provably wider than the best hit so far.
    if (best !== null && bd < r * CELL * 60) break;
  }
  return { fi: best, dist: bd };
}

async function assignMarkers(markers) {
  if (fs.existsSync(ASSIGN_CACHE)) {
    console.log('  assignment: cached');
    return JSON.parse(fs.readFileSync(ASSIGN_CACHE, 'utf8'));
  }
  const sections = await fetchLayer('PCT_Letter_Sections', SECTIONS_CACHE, 'sections');
  const regions  = await fetchLayer('PCTA_Centerline_Regions', REGIONS_CACHE, 'regions');
  const sIdx = buildIndex(sections, 'Section_Name');
  const rIdx = buildIndex(regions, 'PCTA_Region');

  let maxSd = 0, maxRd = 0;
  const out = markers.map(m => {
    const s = nearestFeature(sIdx, m.lat, m.lon);
    const r = nearestFeature(rIdx, m.lat, m.lon);
    maxSd = Math.max(maxSd, s.dist);
    maxRd = Math.max(maxRd, r.dist);
    return { mile: m.Mile, lat: m.lat, lon: m.lon, section: sIdx.names[s.fi], region: rIdx.names[r.fi] };
  });
  console.log('  assignment: max snap ' + maxSd.toFixed(3) + 'mi (section), '
    + maxRd.toFixed(3) + 'mi (region)');
  fs.writeFileSync(ASSIGN_CACHE, JSON.stringify(out));
  return out;
}

// ── Stage 3: elevation ────────────────────────────────────────────────────────

async function fetchElevations(pts) {
  const cache = fs.existsSync(ELEV_CACHE) ? JSON.parse(fs.readFileSync(ELEV_CACHE, 'utf8')) : {};
  const todo = pts.filter(p => cache[p.mile] === undefined);
  if (todo.length === 0) { console.log('  elevation: all cached'); return cache; }
  console.log('  elevation: ' + todo.length + ' points to fetch ('
    + Math.ceil(todo.length / 100) + ' batches)');

  for (let i = 0; i < todo.length; i += 100) {
    const batch = todo.slice(i, i + 100);
    const locs = batch.map(p => p.lat.toFixed(6) + ',' + p.lon.toFixed(6)).join('|');
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const j = await get('https://api.opentopodata.org/v1/srtm90m?locations=' + locs);
        if (!j.results) throw new Error(j.error || 'no results');
        j.results.forEach((r, k) => {
          cache[batch[k].mile] = r.elevation != null ? Math.round(r.elevation * 3.28084) : null;
        });
        ok = true;
      } catch (e) {
        console.warn('    batch ' + (i / 100 + 1) + ' attempt ' + attempt + ': ' + e.message);
        if (attempt < 3) await sleep(4000);
      }
    }
    if (!ok) batch.forEach(p => { cache[p.mile] = null; });
    fs.writeFileSync(ELEV_CACHE, JSON.stringify(cache));
    if ((i / 100) % 10 === 0) console.log('    ' + (i + batch.length) + '/' + todo.length);
    await sleep(1100);
  }
  return cache;
}

// ── Stage 4: build outputs ────────────────────────────────────────────────────

function parseSection(name) {
  const m = /^([A-Z]{2})\s+Section\s+([A-Z])$/.exec(name);
  if (!m) throw new Error('unexpected section name: ' + name);
  return { st: m[1], letter: m[2] };
}

// "CA Section A" -> "ca-a"
function slugSection(name) {
  const { st, letter } = parseSection(name);
  return st.toLowerCase() + '-' + letter.toLowerCase();
}

// "CA Section A" -> "California Section A"
function expandSection(name) {
  const { st, letter } = parseSection(name);
  return STATE_NAMES[st] + ' Section ' + letter;
}

function padMile(mile) {
  return String(Math.round(mile * 1000)).padStart(7, '0');
}

function makeStateLookup() {
  const g = JSON.parse(fs.readFileSync(STATES_CACHE, 'utf8'));
  const wanted = g.features
    .filter(f => ['California', 'Oregon', 'Washington'].includes(f.properties.name || f.properties.NAME))
    .map(f => {
      const n = f.properties.name || f.properties.NAME;
      return { abbr: Object.keys(STATE_NAMES).find(k => STATE_NAMES[k] === n), geometry: f.geometry };
    });
  if (wanted.length !== 3) throw new Error('expected 3 states in ' + path.basename(STATES_CACHE) + ', got ' + wanted.length);
  const wa = wanted.find(s => s.abbr === 'WA');
  return { inWA: (lat, lon) => inFeature(lon, lat, wa.geometry) };
}

/**
 * The PCT enters each state exactly once, so `state` is settled by locating the
 * two crossings and splitting the mile axis, rather than by testing each point.
 * Per-point testing is what put three points near the 42nd parallel, and both
 * terminus monuments, on the wrong side: all five sit within a few hundred
 * metres of a border, which is inside the digitising error of any polygon.
 *
 *   CA -> OR  the 42nd parallel, exact by law.
 *   OR -> WA  the Columbia River, crossed on the Bridge of the Gods. No
 *             parallel to appeal to, so the TIGER polygon decides — it puts
 *             the crossing on the bridge itself.
 *
 * Both crossings are asserted to be unique so that a future data refresh fails
 * loudly instead of silently mis-assigning a state.
 */
function assignStates(pts, states) {
  const northOf42 = pts.map(p => p.lat >= LAT_CA_OR);
  const inWA      = pts.map(p => states.inWA(p.lat, p.lon));

  const flips = (arr) => arr.reduce((n, v, i) => n + (i > 0 && v !== arr[i - 1] ? 1 : 0), 0);
  if (flips(northOf42) !== 1) throw new Error('expected exactly 1 crossing of the 42nd parallel, got ' + flips(northOf42));

  const iCaOr = northOf42.indexOf(true);
  const iOrWa = inWA.indexOf(true);
  if (iOrWa < 0) throw new Error('trail never enters the Washington polygon');
  // Everything from the Columbia north should test inside Washington. The one
  // permitted exception is the final point: the northern terminus monument
  // stands a few metres over the 49th parallel, outside the state polygon.
  const strays = [];
  for (let i = iOrWa; i < inWA.length; i++) if (!inWA[i] && i !== inWA.length - 1) strays.push(pts[i].mile);
  if (strays.length) throw new Error('points north of the Columbia fell outside Washington: miles ' + strays.join(', '));
  console.log('  CA -> OR at mile ' + pts[iCaOr].mile + ' (42nd parallel)');
  console.log('  OR -> WA at mile ' + pts[iOrWa].mile + ' (Columbia River)');
  return pts.map((_, i) => (i < iCaOr ? 'CA' : i < iOrWa ? 'OR' : 'WA'));
}

async function main() {
  console.log('=== PCT build-pct-data.js ===\n');

  console.log('1. Sources');
  const rawMarkers = await fetchMarkers();
  const markers = rawMarkers
    .filter(m => m.lat != null && m.lon != null)
    .sort((a, b) => a.Mile - b.Mile);
  console.log('  ' + rawMarkers.length + ' markers, ' + markers.length + ' with coordinates'
    + ' (miles ' + markers[0].Mile + ' - ' + markers[markers.length - 1].Mile + ')');

  console.log('\n2. Section / region assignment');
  const assigned = await assignMarkers(markers);

  // Terminus points come from PCTA's Full_PCT shapefile endpoints.
  const simp = JSON.parse(fs.readFileSync(SIMPLIFIED, 'utf8')).features[0].geometry.coordinates;
  const south = simp[0], north = simp[simp.length - 1];
  const first = assigned[0], last = assigned[assigned.length - 1];
  const northMile = +(last.mile + haversine(last.lat, last.lon, north[1], north[0])).toFixed(2);
  const pts = [
    { mile: 0, lat: +south[1].toFixed(6), lon: +south[0].toFixed(6), section: first.section, region: first.region },
    ...assigned.map(a => ({
      mile: a.mile, lat: +a.lat.toFixed(6), lon: +a.lon.toFixed(6),
      section: a.section, region: a.region,
    })),
    { mile: northMile, lat: +north[1].toFixed(6), lon: +north[0].toFixed(6), section: last.section, region: last.region },
  ];
  console.log('  termini: mile 0 (' + pts[0].lat + ', ' + pts[0].lon + ')'
    + ' -> mile ' + northMile + ' (' + pts[pts.length - 1].lat + ', ' + pts[pts.length - 1].lon + ')');

  console.log('\n3. Elevation');
  const elev = await fetchElevations(pts);

  console.log('\n4. Assembling points.json');
  const stateOf = makeStateLookup();
  const sectionStart = new Map();
  for (const p of pts) if (!sectionStart.has(p.section)) sectionStart.set(p.section, p.mile);

  const filled = assignStates(pts, stateOf);

  let nullState = 0;
  const points = pts.map((p, i) => {
    const st = filled[i];
    if (!st) nullState++;
    const rec = {
      id          : 'pct-main-mi' + padMile(p.mile),
      lat         : p.lat,
      lon         : p.lon,
      mile        : p.mile,
      region_id   : REGION_IDS[p.region],
      region_name : p.region,
      section_id  : slugSection(p.section),
      section_name: expandSection(p.section),
      sec_mile    : +(p.mile - sectionStart.get(p.section)).toFixed(2),
      route_id    : 'main-spine',
    };
    if (st) rec.state = st;
    if (elev[p.mile] != null) rec.trail_elev = elev[p.mile];
    return rec;
  });
  if (nullState) console.warn('  WARNING: ' + nullState + ' points fell outside all three state polygons');

  fs.writeFileSync(path.join(DATA, 'points.json'), JSON.stringify(points, null, 2));
  console.log('  wrote points.json — ' + points.length + ' points');

  // ── trail.geojson: re-split the simplified line at the 6 region boundaries
  console.log('\n5. Rebuilding trail.geojson (6 region features)');
  const boundaries = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].region !== pts[i - 1].region) boundaries.push(pts[i]);
  }
  const cutIdx = boundaries.map(b => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < simp.length; i++) {
      const d = haversine(b.lat, b.lon, simp[i][1], simp[i][0]);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  });

  const order = [];
  for (const p of pts) if (!order.includes(p.region)) order.push(p.region);

  const feats = [];
  let start = 0;
  order.forEach((region, i) => {
    const end = i < cutIdx.length ? cutIdx[i] : simp.length - 1;
    const coords = simp.slice(start, end + 1);
    const inRegion = points.filter(p => p.region_name === region);
    feats.push({
      type: 'Feature',
      properties: {
        region_id  : REGION_IDS[region],
        region_name: region,
        route_id   : 'main-spine',
        mile_start : inRegion[0].mile,
        mile_end   : inRegion[inRegion.length - 1].mile,
      },
      geometry: { type: 'LineString', coordinates: coords },
    });
    console.log('  ' + region.padEnd(38)
      + ' miles ' + String(inRegion[0].mile).padStart(7)
      + ' - ' + String(inRegion[inRegion.length - 1].mile).padStart(7)
      + '  verts=' + coords.length);
    start = end;
  });
  fs.writeFileSync(path.join(DATA, 'trail.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features: feats }));
  console.log('  wrote trail.geojson');

  // ── pct_meta.json
  console.log('\n6. Writing pct_meta.json');
  const secOrder = [];
  for (const p of points) {
    if (!secOrder.some(s => s.section_id === p.section_id)) {
      secOrder.push({ section_id: p.section_id, section_name: p.section_name, region_id: p.region_id });
    }
  }
  const meta = {
    trail: {
      name: 'Pacific Crest Trail',
      total_miles: northMile,
      source: 'Pacific Crest Trail Association — PCT Mile Markers 2026, PCT Letter Sections, PCTA Centerline Regions',
      source_org: FS_BASE,
      built: new Date().toISOString().slice(0, 10),
      termini: { south: 'Campo, CA (Mexican border)', north: 'Monument 78, WA (Canadian border)' },
    },
    regions: order.map(r => {
      const inR = points.filter(p => p.region_name === r);
      return {
        region_id: REGION_IDS[r],
        region_name: r,
        mile_start: inR[0].mile,
        mile_end: inR[inR.length - 1].mile,
        miles: +(inR[inR.length - 1].mile - inR[0].mile).toFixed(2),
      };
    }),
    sections: secOrder.map(s => {
      const inS = points.filter(p => p.section_id === s.section_id);
      return Object.assign({}, s, {
        mile_start: inS[0].mile,
        mile_end: inS[inS.length - 1].mile,
        miles: +(inS[inS.length - 1].mile - inS[0].mile).toFixed(2),
        states: [...new Set(inS.map(p => p.state).filter(Boolean))],
      });
    }),
  };
  fs.writeFileSync(path.join(DATA, 'pct_meta.json'), JSON.stringify(meta, null, 2));
  console.log('  wrote pct_meta.json — ' + meta.regions.length + ' regions, '
    + meta.sections.length + ' sections');

  console.log('\nDone.');
}

main().catch(e => { console.error('\nFATAL:', e); process.exit(1); });
