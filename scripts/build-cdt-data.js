#!/usr/bin/env node
/**
 * build-cdt-data.js
 *
 * Rebuilds the Continental Divide Trail data files on the canonical
 * points.json schema, using the Continental Divide Trail Coalition's own
 * published GIS.
 *
 * Why a rebuild rather than a field-fill. The previous files came from a USFS
 * ArcGIS snapshot dated 2019-04-15 and carried three separate problems:
 *
 *   1. No section structure. "Sections" were four latitude bands (NM <37,
 *      CO <41, WY <45, MT) invented by the old builder. Because the trail runs
 *      the Idaho/Montana border ridge well south of 45 degrees, 260 miles of
 *      axis (old miles 2045-2300) were labelled state "WY" while sitting in
 *      Idaho and Montana, and "ID" never appeared in points.json at all.
 *   2. The Rocky Mountain National Park inversion. The 2019 USFS layer carried
 *      only the short western bypass connector, so the mile axis ran along the
 *      bypass and the real route through the park was modelled as a 40-mile
 *      "alternate" with default_id "rmnp". CDTC's own data has it the other way
 *      round: the Primary Route goes through the park (section 067, "Rocky
 *      Mountain National Park", 28.7 mi) and the 4.4-mile Tonahutu Creek Route
 *      is the alternate.
 *   3. cdt_meta.json had been hand-edited after its last build and the old
 *      builder could no longer reproduce it — re-running it would have silently
 *      dropped default_id, the top-level delta_miles that app.js depends on,
 *      and the "Western Bypass" label.
 *
 * Unlike the PCT, the old CDT axis was NOT linearly rescaled — it was measured
 * off the source geometry. It is replaced because the source is stale and
 * structureless, not because the arithmetic was wrong.
 *
 * Sources (CDTC, ArcGIS Online org WyuHwdftppQLa5KO, fetched 2026-09-13):
 *   Mile_Markers/0                — 6,155 half-mile markers, Label-separated
 *                                   per route. The Primary Route's 6,079
 *                                   markers run 0.000 - 3,039.979 with no
 *                                   duplicates and no step other than 0.5
 *                                   (plus a 1.479 tail into the terminus).
 *                                   THIS IS THE MILE AXIS.
 *   2026_CDT_Trail_Sections_view/0 — 128 official sections. 126 are Primary
 *                                   Route; the other two are the Tonahutu
 *                                   Creek Route (068) and the Chief Mountain
 *                                   Border Crossing (128). Every section
 *                                   carries a "X to Y" Sec_Desc, used as
 *                                   section_name.
 *   Continental_Divide_Trail_2/0   — CDTC centerline, 7 features. Used for
 *                                   trail.geojson rendering geometry.
 *
 * Section and region boundaries are derived by snapping each mile marker to the
 * nearest section geometry, NOT by accumulating the section layer's own Mileage
 * field. Those sum to 3,042.96 against a 3,039.979 marker axis — a 0.1% drift
 * that would compound into a visible offset by Montana. Snapping keeps every
 * boundary on one axis. This is the same rule the PCT build follows.
 *
 * Snapping is to the nearest section *vertex*, so the reported max snap distance
 * overstates the true offset wherever the source is sparse: the worst case,
 * ~1.0 mi around mile 453 in section 018, is a dead-straight New Mexico roadwalk
 * whose line carries a vertex only every 2 miles. Those markers sit on the
 * section line to within 0.000 mi measured perpendicular.
 *
 * Regions are CDTC's five State_1 groups, in trail order: New Mexico,
 * Colorado, Wyoming, Montana/Idaho, Montana. "Montana/Idaho" is CDTC's own
 * label for the border-ridge stretch and is kept verbatim rather than resolved
 * to one state, because there the trail *is* the state line.
 *
 * The per-point `state` field is computed independently by polygon test against
 * Census TIGERweb boundaries, never inferred from the section's State_1 — the
 * trail crosses between Idaho and Montana dozens of times along that ridge.
 * TIGERweb is used rather than the coarse us_states.geojson the AT pipeline
 * shares: on a border that follows the divide itself, a generalised polygon is
 * not good enough.
 *
 * Alternates. Two are official (from CDTC's own section layer); three are
 * popular unofficial routes carried forward from the previous build's cached
 * OpenStreetMap relations, and are tagged `official: false` in cdt_meta.json:
 *
 *   tonahutu       4.4 mi  CDTC section 068  official
 *   chief-mtn     27.2 mi  CDTC section 128  official, alternate northern terminus
 *   gila         106.7 mi  OSM relation 7917427
 *   anaconda      53.1 mi  OSM relation 8107272
 *   spotted-bear  27.8 mi  OSM relation 8034122 + way 891724062
 *
 * The Anaconda and Spotted Bear figures are 4.5 and 8.9 miles shorter than the
 * previous build reported. That build's chainer only ever appended to the tail
 * of the growing chain, so whichever OSM way sorted first became the seed and
 * everything upstream of it was stranded; each route came out as two pieces
 * joined by a straight line across open country, and that straight line was
 * counted as tread. chainPaths here grows from both ends, after which all three
 * routes stitch into one continuous chain with no step over 0.9 mi.
 *
 * Spotted Bear needed one further fix. Relation 8034122 stops 1.21 mi short of
 * the CDT at its north end: its Clack Creek member T-junctions into the middle
 * of the Big River trail (Flathead NF #155, OSM way 891724062) and the relation
 * does not include the rest of that trail up to the Bowl Creek / Strawberry
 * Creek junction, where the CDT actually crosses. That stretch is borrowed via
 * `connectorWays`, which lands the endpoint 0.18 mi from the spine instead of
 * 1.21 mi — in line with every other alternate.
 *
 * Spotted Bear is therefore 27.8 mi against the 43.5 mi of spine it replaces,
 * a genuine 15.7 mi saving rather than the "+20.5 mi scenic detour" the old
 * files claimed. Both of the old numbers were artifacts: its 35.5 mi came from
 * an 8.9 mi phantom straight line, and its 15 mi "main" span came from branch
 * and rejoin points derived from the same broken chain. A shorter alternate is
 * not itself suspicious here — the CDT follows the divide through this stretch
 * while the alternate drops into the Spotted Bear River drainage and cuts
 * across, and the straight-line distance between the two junctions is ~18 mi.
 *
 * The old build's fourth OSM alternate, relation 6747529 ("RMNP Loop"), is
 * deliberately dropped: under CDTC's routing that geometry is the main spine,
 * not an alternate. Keeping it would have re-created the inversion.
 *
 * Alt points follow the IAT/AZT convention: `mile` is interpolated across the
 * alternate's branch->rejoin span so it stays strictly increasing and can be
 * mapped back, while `sec_mile` restarts at 0 for every section including
 * alternate sections. Chief Mountain branches but never rejoins (it ends at a
 * different border crossing), so its `mile` runs from its branch point to
 * branch + its own length.
 *
 * Elevation: OpenTopoData SRTM 90m, cached in scripts/cache/cdt_elevations.json
 * and resume-safe.
 *
 * Run: node scripts/build-cdt-data.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

const CACHE = path.join(__dirname, 'cache');
const DATA  = path.join(__dirname, '..', 'public', 'trails', 'continental-divide-trail', 'data');

const MARKERS_CACHE    = path.join(CACHE, 'cdtc_half_mile_markers.json');
const SECTIONS_CACHE   = path.join(CACHE, 'cdtc_sections.geojson');
const CENTERLINE_CACHE = path.join(CACHE, 'cdtc_centerline.geojson');
const STATES_CACHE     = path.join(CACHE, 'census_states_cdt.geojson');
const ELEV_CACHE       = path.join(CACHE, 'cdt_elevations.json');
const OSM_CACHE        = id => path.join(CACHE, 'cdt_osm_' + id + '.json');

const LABEL_MAIN     = 'CDT Primary Route';
const LABEL_TONAHUTU = 'CDT Tonahutu Creek Route';

// Point spacing, miles. Matches CDTC's own half-mile marker resolution, so
// every spine point is an official marker rather than an interpolation.
const SPACING = 0.5;

// CDTC's five State_1 groups, in trail order.
const REGIONS = [
  { id: 'new-mexico',    name: 'New Mexico',     state1: 'New Mexico'    },
  { id: 'colorado',      name: 'Colorado',       state1: 'Colorado'      },
  { id: 'wyoming',       name: 'Wyoming',        state1: 'Wyoming'       },
  { id: 'montana-idaho', name: 'Montana/Idaho',  state1: 'Montana/Idaho' },
  { id: 'montana',       name: 'Montana',        state1: 'Montana'       },
];

const STATE_ABBR = {
  'New Mexico': 'NM', 'Colorado': 'CO', 'Wyoming': 'WY',
  'Idaho': 'ID', 'Montana': 'MT',
};

// Unofficial alternates carried forward from the previous build's OSM caches.
// maxGapMi is the previous builder's tuned stitching cutoff; do not change
// without re-checking the step-distance distribution (see TrailTemps CLAUDE.md,
// "CDT Build Script — Key Parameters").
const OSM_ALTS = [
  { id: 'gila',         name: 'Gila River Route',   relation: 7917427, maxGapMi: 1.0  },
  { id: 'anaconda',     name: 'Anaconda Cutoff',    relation: 8107272, maxGapMi: 5.0  },
  // Relation 8034122 stops 1.21mi short of the CDT at its north end: its last
  // member, the Clack Creek way, T-junctions into the middle of the Big River
  // trail (Flathead NF #155, OSM way 891724062) and the relation simply does not
  // include the rest of that trail up to the Bowl Creek / Strawberry Creek
  // junction, which is where the CDT actually crosses. Borrowing that stretch
  // closes the route: the north endpoint then lands 0.18mi from the spine
  // instead of 1.21mi, in line with every other alternate. See connectorWays.
  { id: 'spotted-bear', name: 'Spotted Bear Route', relation: 8034122, maxGapMi: 10.0,
    connectorWays: [891724062] },
];

// Any step longer than this in a stitched OSM chain would be a hole in OSM's
// coverage rather than tread. The chain is cut there: each side becomes its own
// GeoJSON feature, no point is placed in the hole, and its length is left out of
// the alternate's mileage — the New England Trail's treatment of the
// Connecticut River gap.
//
// As of the 2026-09 build no alternate actually trips this: with bidirectional
// chaining the longest step in any of the three is the Anaconda's 0.86 mi. It is
// kept because the OSM relations are third-party data that can lose a way at any
// time, and a silent straight line across the hole is the failure this prevents.
const OSM_GAP_MI = 1.0;

// ── Geometry helpers ──────────────────────────────────────────────────────────

function haversine(la1, lo1, la2, lo2) {
  const R = 3958.8, t = Math.PI / 180;
  const dLa = (la2 - la1) * t, dLo = (lo2 - lo1) * t;
  const s = Math.sin(dLa / 2) ** 2
    + Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

// coords are [lon, lat] pairs throughout, matching GeoJSON order.
function pathLen(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    d += haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  return d;
}

// Point at `target` miles along coords, linearly interpolated within the
// straddling vertex pair.
function interpolateAt(coords, target) {
  if (target <= 0) return coords[0];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    if (acc + seg >= target) {
      const f = seg === 0 ? 0 : (target - acc) / seg;
      return [
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f,
      ];
    }
    acc += seg;
  }
  return coords[coords.length - 1];
}

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

// ── Spatial index for nearest-feature snapping ────────────────────────────────

const CELL = 0.02;

function buildIndex(features, keyFn) {
  const keys = [], grid = new Map();
  features.forEach((f, fi) => {
    keys.push(keyFn(f));
    const g = f.geometry;
    const parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
    for (const part of parts) for (const c of part) {
      const k = Math.floor(c[1] / CELL) + ':' + Math.floor(c[0] / CELL);
      let a = grid.get(k);
      if (!a) { a = []; grid.set(k, a); }
      a.push(c[1], c[0], fi);
    }
  });
  return { keys, grid };
}

function nearestFeature(idx, la, lo) {
  let best = null, bd = Infinity;
  for (let r = 1; r <= 10; r++) {
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

// Perpendicular distance in miles from a point to the nearest segment of a
// polyline, using a local planar approximation (exact enough well under a mile).
//
// This exists because nearest-*vertex* distance badly overstates how far a point
// sits from a line whenever the line is sparsely sampled, and it produced two
// false alarms while this trail was being built:
//
//   * section 018's mile markers read up to 1.003 mi from their own section
//     line. Perpendicular: 0.000 mi. The line is a dead-straight New Mexico
//     roadwalk carrying a vertex only every 2 miles.
//   * the Spotted Bear route's rejoin endpoint read 1.21 mi from the spine even
//     after its real 1.21 mi gap was closed, because the spine is sampled every
//     0.5 mi so anything can read a quarter mile out. Perpendicular: 0.007 mi.
//
// Endpoint offsets are therefore reported this way. Branch and rejoin MILES
// still come from the nearest sampled point, which is what puts them on the
// axis; only the distance is measured against the line.
function distToLine(lat, lon, line) {
  const t = Math.PI / 180;
  const kx = 69.17 * Math.cos(lat * t), ky = 69.17;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    // Cheap bounding-box reject before the segment maths.
    if (Math.abs(a[1] - lat) > 0.2 && Math.abs(b[1] - lat) > 0.2) continue;
    if (Math.abs(a[0] - lon) > 0.2 && Math.abs(b[0] - lon) > 0.2) continue;
    const px = (lon - a[0]) * kx, py = (lat - a[1]) * ky;
    const bx = (b[0] - a[0]) * kx, by = (b[1] - a[1]) * ky;
    const L2 = bx * bx + by * by;
    const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / L2));
    const dx = px - u * bx, dy = py - u * by;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < best) best = d;
  }
  return best;
}

// Borrow the stretch of a neighbouring OSM way that closes the gap between a
// relation's loose end and the spine. Only the portion between where the way
// meets the chain and where it comes nearest the spine is kept; the rest of the
// way carries on elsewhere and is discarded.
function connectorSlice(way, chainEnd, spineLine) {
  const g = way.geometry.map(n => [n.lon, n.lat]);
  let ti = 0, td = Infinity, si = 0, sd = Infinity;
  g.forEach((c, i) => {
    const dt = haversine(chainEnd[1], chainEnd[0], c[1], c[0]);
    if (dt < td) { td = dt; ti = i; }
    const ds = distToLine(c[1], c[0], spineLine);
    if (ds < sd) { sd = ds; si = i; }
  });
  const [lo, hi] = ti <= si ? [ti, si] : [si, ti];
  const slice = g.slice(lo, hi + 1);
  // Run it outward from the chain, so it appends in the right direction.
  if (ti > si) slice.reverse();
  return { slice, joinDist: td, spineDist: sd };
}

// ── OSM chaining (ported from the previous builder, parameters unchanged) ─────

// Greedy nearest-endpoint stitching of OSM way geometries into one polyline.
//
// Grows from BOTH ends of the chain. The previous builder only appended to the
// tail, so whichever way happened to sort first became the seed and everything
// upstream of it was stranded: the Anaconda and Spotted Bear chains both came
// out starting at an interior coverage gap rather than at a trail junction,
// which put their branch points several miles off the spine.
function chainPaths(paths, maxGapMi) {
  const segs = paths.filter(p => p.length >= 2);
  if (!segs.length) return [];
  const used = new Set([0]);
  let chain = segs[0].slice();
  chainPaths.stranded = 0;
  chainPaths.strandedMi = 0;

  while (used.size < segs.length) {
    const head = chain[0];
    const tail = chain[chain.length - 1];
    let bestDist = Infinity, bestIdx = -1, bestRev = false, atHead = false;

    segs.forEach((seg, i) => {
      if (used.has(i)) return;
      const s = seg[0], e = seg[seg.length - 1];
      // Append to the tail: whichever end of the candidate is nearer it.
      const t1 = haversine(tail[1], tail[0], s[1], s[0]);
      const t2 = haversine(tail[1], tail[0], e[1], e[0]);
      // Prepend to the head: the candidate's far end meets the head.
      const h1 = haversine(head[1], head[0], e[1], e[0]);
      const h2 = haversine(head[1], head[0], s[1], s[0]);
      if (t1 < bestDist) { bestDist = t1; bestIdx = i; bestRev = false; atHead = false; }
      if (t2 < bestDist) { bestDist = t2; bestIdx = i; bestRev = true;  atHead = false; }
      if (h1 < bestDist) { bestDist = h1; bestIdx = i; bestRev = false; atHead = true;  }
      if (h2 < bestDist) { bestDist = h2; bestIdx = i; bestRev = true;  atHead = true;  }
    });
    if (bestIdx === -1 || bestDist > maxGapMi) {
      chainPaths.stranded = segs.length - used.size;
      chainPaths.strandedMi = segs.reduce((s, seg, i) => used.has(i) ? s : s + pathLen(seg), 0);
      return chain;
    }

    const seg = bestRev ? segs[bestIdx].slice().reverse() : segs[bestIdx].slice();
    if (atHead) {
      const joint = haversine(head[1], head[0], seg[seg.length - 1][1], seg[seg.length - 1][0]);
      chain = (joint < 0.001 ? seg.slice(0, -1) : seg).concat(chain);
    } else {
      const joint = haversine(tail[1], tail[0], seg[0][1], seg[0][0]);
      chain = chain.concat(joint < 0.001 ? seg.slice(1) : seg);
    }
    used.add(bestIdx);
  }
  return chain;
}

// Split a chain at any step > maxStepMi, returning all runs of >= 2 vertices.
// Removes the straight-line artifacts left by badly ordered OSM relations.
function splitAtSteps(chain, maxStepMi) {
  const out = [];
  let cur = [chain[0]];
  for (let i = 1; i < chain.length; i++) {
    const step = haversine(chain[i - 1][1], chain[i - 1][0], chain[i][1], chain[i][0]);
    if (step > maxStepMi) { if (cur.length >= 2) out.push(cur); cur = [chain[i]]; }
    else cur.push(chain[i]);
  }
  if (cur.length >= 2) out.push(cur);
  return out.length ? out : [chain];
}

function thinCoords(coords, minDistM) {
  if (coords.length <= 2) return coords;
  const minMi = minDistM / 1609.34;
  const kept = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const last = kept[kept.length - 1];
    if (haversine(last[1], last[0], coords[i][1], coords[i][0]) >= minMi) kept.push(coords[i]);
  }
  kept.push(coords[coords.length - 1]);
  return kept;
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

const CDTC_FS = 'https://services8.arcgis.com/WyuHwdftppQLa5KO/arcgis/rest/services';

// The marker layer pages at 2,000 features; ask for geometry so the axis carries
// its own coordinates rather than being re-derived from the centerline.
async function ensureMarkers() {
  if (fs.existsSync(MARKERS_CACHE)) { console.log('  markers: cached'); return; }
  console.log('  markers: fetching CDTC Mile_Markers...');
  let all = [];
  for (let off = 0; ; off += 2000) {
    const j = await get(CDTC_FS + '/Mile_Markers/FeatureServer/0/query'
      + '?where=1%3D1&outFields=Label,MileText&returnGeometry=true&outSR=4326'
      + '&resultOffset=' + off + '&resultRecordCount=2000&f=json');
    const feats = j.features || [];
    all = all.concat(feats.map(f => ({
      label: f.attributes.Label, mile: f.attributes.MileText,
      lat: f.geometry.y, lon: f.geometry.x,
    })));
    if (feats.length < 2000) break;
  }
  fs.writeFileSync(MARKERS_CACHE, JSON.stringify(all));
}

// Sections and centerline come back at full resolution — roughly 64MB each, so
// they are gitignored and refetched on demand.
async function ensureLayer(service, cacheFile, label) {
  if (fs.existsSync(cacheFile)) { console.log('  ' + label + ': cached'); return; }
  console.log('  ' + label + ': fetching ' + service + ' (~64MB, may take a minute)...');
  const j = await get(CDTC_FS + '/' + service
    + '/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson');
  fs.writeFileSync(cacheFile, JSON.stringify(j));
}

// ── Elevation ─────────────────────────────────────────────────────────────────

// Keyed by "<route_id>:<mile>" so alternate points cannot collide with spine
// points that happen to share a mile value.
async function fetchElevations(pts) {
  const cache = fs.existsSync(ELEV_CACHE)
    ? JSON.parse(fs.readFileSync(ELEV_CACHE, 'utf8')) : {};
  const key = p => p.route_id + ':' + p.mile;
  const todo = pts.filter(p => cache[key(p)] === undefined);
  if (!todo.length) { console.log('  elevation: all ' + pts.length + ' cached'); return cache; }
  console.log('  elevation: ' + todo.length + ' to fetch (' + Math.ceil(todo.length / 100) + ' batches)');

  for (let i = 0; i < todo.length; i += 100) {
    const batch = todo.slice(i, i + 100);
    const locs = batch.map(p => p.lat.toFixed(6) + ',' + p.lon.toFixed(6)).join('|');
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const j = await get('https://api.opentopodata.org/v1/srtm90m?locations=' + locs);
        if (!j.results) throw new Error(j.error || 'no results');
        j.results.forEach((r, k) => {
          cache[key(batch[k])] = r.elevation != null ? Math.round(r.elevation * 3.28084) : null;
        });
        ok = true;
      } catch (e) {
        console.warn('    batch ' + (i / 100 + 1) + ' attempt ' + attempt + ': ' + e.message);
        if (attempt < 3) await sleep(4000);
      }
    }
    if (!ok) batch.forEach(p => { cache[key(p)] = null; });
    fs.writeFileSync(ELEV_CACHE, JSON.stringify(cache));
    if ((i / 100) % 10 === 0) console.log('    ' + (i + batch.length) + '/' + todo.length);
    await sleep(1100);
  }
  return cache;
}

// ── Output helpers ────────────────────────────────────────────────────────────

const r6 = n => Math.round(n * 1e6) / 1e6;
const r3 = n => Math.round(n * 1000) / 1000;
const r1 = n => Math.round(n * 10) / 10;

function padMile(mile) {
  return String(Math.round(mile * 1000)).padStart(7, '0');
}

function pointId(routeId, mile) {
  return 'cdt-' + routeId + '-mi' + padMile(mile);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Stage 1: load sources ──────────────────────────────────────────────────
  console.log('=== Stage 1: sources ===');
  await ensureMarkers();
  await ensureLayer('2026_CDT_Trail_Sections_view', SECTIONS_CACHE, 'sections');
  await ensureLayer('Continental_Divide_Trail_2', CENTERLINE_CACHE, 'centerline');
  if (!fs.existsSync(STATES_CACHE)) {
    console.log('  states: fetching Census TIGERweb boundaries...');
    const u = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County'
      + '/MapServer/0/query?where=' + encodeURIComponent("STATE IN ('35','08','56','16','30')")
      + '&outFields=NAME,STATE&outSR=4326&f=geojson';
    fs.writeFileSync(STATES_CACHE, JSON.stringify(await get(u)));
  }
  for (const id of OSM_ALTS.map(a => a.id)) {
    if (!fs.existsSync(OSM_CACHE(id))) {
      throw new Error('missing OSM cache: ' + OSM_CACHE(id)
        + '\n  These are committed. If one is genuinely gone, refetch the relation'
        + '\n  from Overpass as [out:json];relation(<id>);>>;out geom qt; and store'
        + '\n  the way elements as a bare JSON array.');
    }
  }
  const markers    = JSON.parse(fs.readFileSync(MARKERS_CACHE, 'utf8'));
  const sectionsFC = JSON.parse(fs.readFileSync(SECTIONS_CACHE, 'utf8'));
  const centerFC   = JSON.parse(fs.readFileSync(CENTERLINE_CACHE, 'utf8'));
  const statesFC   = JSON.parse(fs.readFileSync(STATES_CACHE, 'utf8'));
  console.log('  markers    ' + markers.length);
  console.log('  sections   ' + sectionsFC.features.length);
  console.log('  centerline ' + centerFC.features.length);

  const spineMarkers = markers
    .filter(m => m.label === LABEL_MAIN)
    .sort((a, b) => a.mile - b.mile);
  const axisEnd = spineMarkers[spineMarkers.length - 1].mile;
  console.log('  spine axis ' + spineMarkers.length + ' markers, 0 - ' + axisEnd);

  // Assert the axis is clean before anything is built on it.
  for (let i = 1; i < spineMarkers.length; i++) {
    const step = r3(spineMarkers[i].mile - spineMarkers[i - 1].mile);
    const isTail = i === spineMarkers.length - 1;
    if (step !== SPACING && !isTail) {
      throw new Error('mile axis step ' + step + ' at mile ' + spineMarkers[i].mile + ' (expected ' + SPACING + ')');
    }
  }

  const primarySections = sectionsFC.features
    .filter(f => f.properties.CDT_Label === LABEL_MAIN)
    .sort((a, b) => a.properties.Section_Number.localeCompare(b.properties.Section_Number));
  console.log('  primary sections ' + primarySections.length
    + ' (' + r1(primarySections.reduce((s, f) => s + f.properties.Mileage, 0)) + ' mi by their own Mileage field)');

  // ── Stage 2: snap each spine marker to its section ─────────────────────────
  console.log('\n=== Stage 2: sections ===');
  const secIdx = buildIndex(primarySections, f => f.properties.Section_Number);
  let maxSnap = 0;
  const spine = spineMarkers.map(m => {
    const hit = nearestFeature(secIdx, m.lat, m.lon);
    if (hit.fi === null) throw new Error('marker at mile ' + m.mile + ' snapped to no section');
    maxSnap = Math.max(maxSnap, hit.dist);
    const props = primarySections[hit.fi].properties;
    return {
      mile: m.mile, lat: m.lat, lon: m.lon,
      section_id: props.Section_Number,
      section_name: props.Sec_Desc,
      state1: props.State_1,
    };
  });
  console.log('  max snap distance ' + maxSnap.toFixed(3) + ' mi');

  // Sections must appear in one contiguous run each, in numeric order. If a
  // section reappears after another has started, the snap has gone wrong and a
  // silently scrambled axis would be the result.
  const order = [];
  for (const p of spine) if (order[order.length - 1] !== p.section_id) order.push(p.section_id);
  const dupes = order.filter((s, i) => order.indexOf(s) !== i);
  if (dupes.length) throw new Error('sections not contiguous along the axis: ' + [...new Set(dupes)].join(', '));
  const sorted = [...order].sort((a, b) => a.localeCompare(b));
  if (order.join() !== sorted.join()) throw new Error('section order along the axis is not numeric order');
  console.log('  ' + order.length + ' sections, contiguous and in order');

  // Region per point, from the section's State_1.
  const regionOf = {};
  for (const r of REGIONS) regionOf[r.state1] = r;
  for (const p of spine) {
    const reg = regionOf[p.state1];
    if (!reg) throw new Error('unmapped State_1 value: ' + p.state1);
    p.region_id = reg.id;
    p.region_name = reg.name;
  }

  // sec_mile: distance from the first point of this section, section-local.
  const secStart = {};
  for (const p of spine) if (secStart[p.section_id] === undefined) secStart[p.section_id] = p.mile;
  for (const p of spine) p.sec_mile = r3(p.mile - secStart[p.section_id]);

  // ── Stage 3: alternates ────────────────────────────────────────────────────
  console.log('\n=== Stage 3: alternates ===');

  // The CDTC centerline, chained into one line. Needed here so endpoint offsets
  // can be measured against the real trail rather than the 0.5-mile sample, and
  // reused for trail.geojson in stage 7.
  const centerParts = [];
  for (const f of centerFC.features.filter(f => f.properties.Label === LABEL_MAIN)) {
    const g = f.geometry;
    centerParts.push(...(g.type === 'LineString' ? [g.coordinates] : g.coordinates));
  }
  const spineLine = chainPaths(centerParts, 5.0);
  console.log('  centerline chained: ' + spineLine.length + ' verts, '
    + r1(pathLen(spineLine)) + ' mi');

  // Nearest spine mile to an arbitrary coordinate — used to find where an
  // alternate leaves and rejoins the spine. Called ten times, so a linear scan
  // over the 6,079 spine points is cheaper than indexing them.
  function nearestSpineMile(lat, lon) {
    let best = null, bd = Infinity;
    for (let i = 0; i < spine.length; i++) {
      const d = haversine(lat, lon, spine[i].lat, spine[i].lon);
      if (d < bd) { bd = d; best = i; }
    }
    // The mile comes from the sampled point; the offset is measured against the
    // centerline, which is the only fair reading of "how far off the trail".
    return { mile: spine[best].mile, dist: distToLine(lat, lon, spineLine) };
  }

  const altDefs = [];

  // Official CDTC alternates, straight from the section layer.
  for (const f of sectionsFC.features) {
    const p = f.properties;
    if (p.CDT_Label === LABEL_MAIN) continue;
    const id = p.CDT_Label === LABEL_TONAHUTU ? 'tonahutu' : 'chief-mtn';
    const g = f.geometry;
    const parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
    const chain = parts.length === 1 ? parts[0] : chainPaths(parts, 1.0);
    altDefs.push({
      id,
      name: p.CDT_Label === LABEL_TONAHUTU ? 'Tonahutu Creek Route' : 'Chief Mountain Border Crossing',
      section_id: p.Section_Number,
      section_name: p.Sec_Desc,
      state1: p.State_1,
      official: true,
      source: 'CDTC section ' + p.Section_Number,
      segments: [chain],
    });
  }

  // Unofficial alternates, from the previous build's cached OSM relations.
  for (const a of OSM_ALTS) {
    const file = OSM_CACHE(a.id);
    if (!fs.existsSync(file)) throw new Error('missing OSM cache: ' + file);
    const ways = JSON.parse(fs.readFileSync(file, 'utf8'));
    const paths = ways.filter(w => w.geometry && w.geometry.length >= 2)
      .map(w => w.geometry.map(n => [n.lon, n.lat]));
    let chain = chainPaths(paths, a.maxGapMi);

    for (const wayId of (a.connectorWays || [])) {
      const wf = path.join(CACHE, 'cdt_osm_connector_' + wayId + '.json');
      if (!fs.existsSync(wf)) throw new Error('missing connector way cache: ' + wf);
      const way = JSON.parse(fs.readFileSync(wf, 'utf8'))[0];
      // Try both ends of the chain; the connector attaches to whichever it meets.
      const head = connectorSlice(way, chain[0], spineLine);
      const tail = connectorSlice(way, chain[chain.length - 1], spineLine);
      const at = head.joinDist <= tail.joinDist ? head : tail;
      if (at.joinDist > 0.05) {
        throw new Error('connector way ' + wayId + ' for ' + a.id
          + ' does not meet the chain (nearest ' + at.joinDist.toFixed(3) + ' mi)');
      }
      const added = pathLen(at.slice);
      chain = at === head
        ? at.slice.slice().reverse().concat(chain)
        : chain.concat(at.slice);
      console.log('  ' + a.id + ': +' + r1(added) + ' mi from OSM way ' + wayId
        + ' (' + (way.tags?.name || 'unnamed') + (way.tags?.ref ? ' #' + way.tags.ref : '')
        + '), closing its loose end to '
        + at.spineDist.toFixed(3) + ' mi from the spine');
    }

    if (chainPaths.stranded) {
      console.log('  ' + a.id + ': ' + chainPaths.stranded + ' of ' + paths.length
        + ' OSM ways left unstitched (' + r1(chainPaths.strandedMi) + ' mi) — '
        + 'nothing within maxGapMi ' + a.maxGapMi + ' of either end');
    }
    const segs = splitAtSteps(chain, OSM_GAP_MI);
    if (segs.length > 1) {
      console.log('  ' + a.id + ': OSM coverage breaks into ' + segs.length
        + ' segments (' + segs.map(s => r1(pathLen(s))).join(' + ') + ' mi); '
        + 'gaps carry no points and no mileage');
    }
    altDefs.push({
      id: a.id, name: a.name,
      section_id: 'alt-' + a.id,
      section_name: a.name,
      official: false,
      source: 'OSM relation ' + a.relation
        + ((a.connectorWays || []).length
            ? ' + way ' + a.connectorWays.join(', way ') + ' (connector)'
            : ''),
      segments: segs,
    });
  }

  // Orient, locate on the spine, and cut points for each alternate.
  const altPoints = [];
  const altMeta = [];
  for (const alt of altDefs) {
    const first = alt.segments[0];
    const last = alt.segments[alt.segments.length - 1];
    const ep1 = first[0], ep2 = last[last.length - 1];
    const m1 = nearestSpineMile(ep1[1], ep1[0]);
    const m2 = nearestSpineMile(ep2[1], ep2[0]);
    // Run the whole alternate in spine order (south to north): reverse the
    // order of the segments and the vertices within each.
    if (m1.mile > m2.mile) {
      alt.segments = alt.segments.slice().reverse().map(s => s.slice().reverse());
    }
    const branchMile = Math.min(m1.mile, m2.mile);
    const rejoinMile = Math.max(m1.mile, m2.mile);
    // Re-read the far end after any reversal above.
    const tailSeg = alt.segments[alt.segments.length - 1];
    const tailCoord = tailSeg[tailSeg.length - 1];
    // Tread only. A gap between segments adds no length.
    const segLens = alt.segments.map(pathLen);
    const altLen = segLens.reduce((a, b) => a + b, 0);

    // Chief Mountain ends at its own border crossing rather than rejoining, so
    // its far endpoint's "nearest spine mile" is meaningless — it is simply the
    // closest the spine ever gets. Lay its axis out forward from the branch.
    const isSpur = alt.id === 'chief-mtn';
    const span = isSpur ? altLen : (rejoinMile - branchMile);
    const axisFrom = branchMile;
    const axisTo = branchMile + span;

    // Locate a tread distance on whichever segment contains it, so points are
    // never placed inside a coverage gap.
    function coordAtTread(local) {
      let acc = 0;
      for (let i = 0; i < alt.segments.length; i++) {
        if (local <= acc + segLens[i] || i === alt.segments.length - 1) {
          return interpolateAt(alt.segments[i], local - acc);
        }
        acc += segLens[i];
      }
    }

    const mk = (local, coord) => ({
      route_id: alt.id,
      alt_of: 'main',
      // Spread the alternate's own tread evenly across the span of spine it
      // replaces, so `mile` stays strictly increasing and can be mapped back.
      mile: r3(axisFrom + (altLen === 0 ? 0 : local / altLen) * (axisTo - axisFrom)),
      sec_mile: r3(local),
      lat: r6(coord[1]), lon: r6(coord[0]),
      section_id: alt.section_id,
      section_name: alt.section_name,
    });

    const n = Math.floor(altLen / SPACING);
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const local = Math.min(k * SPACING, altLen);
      pts.push(mk(local, coordAtTread(local)));
    }
    // Always carry the far end, so the alternate's drawn extent and its point
    // extent agree. The previous build stopped at the last whole 5-mile mark
    // and left every alternate's final partial mile unrepresented.
    if (altLen - n * SPACING > 0.01) pts.push(mk(altLen, tailCoord));

    // Region from the spine point it branches off, so alternates inherit the
    // region of the stretch they replace rather than needing one of their own.
    const branchPt = spine.reduce((b, p) =>
      Math.abs(p.mile - branchMile) < Math.abs(b.mile - branchMile) ? p : b, spine[0]);
    for (const p of pts) { p.region_id = branchPt.region_id; p.region_name = branchPt.region_name; }

    altPoints.push(...pts);
    altMeta.push({
      id: alt.id, name: alt.name, official: alt.official, source: alt.source,
      section_id: alt.section_id, section_name: alt.section_name,
      branch_mile: r1(branchMile),
      rejoin_mile: isSpur ? null : r1(rejoinMile),
      alt_miles: r1(altLen),
      main_miles: isSpur ? null : r1(rejoinMile - branchMile),
      delta_miles: isSpur ? null : r1(altLen - (rejoinMile - branchMile)),
      segments: alt.segments.length,
      points: pts.length,
    });
    console.log('  ' + alt.id.padEnd(13)
      + (alt.official ? 'official  ' : 'OSM       ')
      + 'branch ' + r1(branchMile)
      + (isSpur ? ' -> own terminus' : ' rejoin ' + r1(rejoinMile))
      + ', ' + r1(altLen) + ' mi, ' + pts.length + ' pts'
      + ' (branch offset ' + (m1.mile <= m2.mile ? m1.dist : m2.dist).toFixed(3) + ' mi'
      + (isSpur ? '' : ', rejoin offset ' + (m1.mile <= m2.mile ? m2.dist : m1.dist).toFixed(3) + ' mi') + ')');
  }

  // ── Stage 4: state by polygon test ─────────────────────────────────────────
  console.log('\n=== Stage 4: states ===');
  const statePolys = statesFC.features.map(f => ({
    abbr: STATE_ABBR[f.properties.NAME], geometry: f.geometry,
  }));
  if (statePolys.some(s => !s.abbr)) throw new Error('unexpected state in ' + path.basename(STATES_CACHE));

  const allPts = [
    ...spine.map(p => ({ ...p, route_id: 'main' })),
    ...altPoints,
  ];
  const stateCount = {};
  let unplaced = 0;
  for (const p of allPts) {
    const hit = statePolys.find(s => inFeature(p.lon, p.lat, s.geometry));
    p.state = hit ? hit.abbr : null;
    if (!hit) unplaced++;
    stateCount[p.state] = (stateCount[p.state] || 0) + 1;
  }
  console.log('  ' + Object.entries(stateCount)
    .map(([k, v]) => k + ' ' + v).join(', '));
  if (unplaced) {
    console.log('  ' + unplaced + ' point(s) outside every state polygon '
      + '(expected: the northern terminus sits on the Canadian border)');
  }

  // ── Stage 5: elevation ─────────────────────────────────────────────────────
  console.log('\n=== Stage 5: elevation ===');
  const elev = await fetchElevations(allPts);

  // ── Stage 6: points.json ───────────────────────────────────────────────────
  console.log('\n=== Stage 6: points.json ===');
  const points = allPts
    .map(p => {
      const e = elev[p.route_id + ':' + p.mile];
      const rec = {
        id: pointId(p.route_id, p.route_id === 'main' ? p.mile : p.sec_mile),
        lat: r6(p.lat), lon: r6(p.lon),
        mile: p.route_id === 'main' ? p.mile : r3(p.mile),
        region_id: p.region_id, region_name: p.region_name,
        section_id: p.section_id, section_name: p.section_name,
        sec_mile: p.sec_mile,
        route_id: p.route_id,
      };
      if (p.state) rec.state = p.state;
      if (e != null) rec.trail_elev = e;
      if (p.alt_of) rec.alt_of = p.alt_of;
      return rec;
    })
    // Spine first in mile order, then each alternate in its own mile order.
    .sort((a, b) => {
      if (a.route_id !== b.route_id) {
        if (a.route_id === 'main') return -1;
        if (b.route_id === 'main') return 1;
        return a.route_id.localeCompare(b.route_id);
      }
      return a.mile - b.mile;
    });

  const dupIds = points.map(p => p.id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dupIds.length) throw new Error('duplicate point ids: ' + [...new Set(dupIds)].slice(0, 5).join(', '));

  fs.writeFileSync(path.join(DATA, 'points.json'), JSON.stringify(points, null, 2));
  console.log('  ' + points.length + ' points ('
    + points.filter(p => p.route_id === 'main').length + ' spine, '
    + points.filter(p => p.route_id !== 'main').length + ' alternate)');

  // ── Stage 7: trail.geojson ─────────────────────────────────────────────────
  console.log('\n=== Stage 7: trail.geojson ===');
  // One spine feature per region, cut at the region's first and last mile, so
  // map.js concatenates them in trail order with no teleports.
  const regionBounds = [];
  for (const p of spine) {
    const last = regionBounds[regionBounds.length - 1];
    if (!last || last.region_id !== p.region_id) {
      regionBounds.push({ region_id: p.region_id, region_name: p.region_name, from: p.mile, to: p.mile });
    } else last.to = p.mile;
  }

  // Build one continuous spine line from CDTC's centerline, then cut it by
  // region. The centerline arrives as four state features that already run
  // south to north; chain them so any vertex-level gap at a state line is
  // closed the same way the alternates are.
  const spineLineLen = pathLen(spineLine);

  const thinned = thinCoords(spineLine, 20);
  const thinnedLen = pathLen(thinned);
  console.log('  thinned to 20m: ' + thinned.length + ' verts, ' + r1(thinnedLen) + ' mi');

  // Cut the thinned line at the region boundaries by proportion of measured
  // length. The drawn line and the marker axis differ slightly in total, so the
  // boundary is placed at the same fraction along each rather than at an
  // absolute mile — map.js matches clicks to this line geometrically, not by
  // mile, so a fractional cut is exact enough for rendering.
  function cutIndexAt(line, targetMi) {
    let acc = 0;
    for (let i = 1; i < line.length; i++) {
      acc += haversine(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]);
      if (acc >= targetMi) return i;
    }
    return line.length - 1;
  }

  const features = [];
  let prevIdx = 0;
  regionBounds.forEach((rb, i) => {
    const isLast = i === regionBounds.length - 1;
    const endIdx = isLast ? thinned.length - 1
      : cutIndexAt(thinned, (rb.to / axisEnd) * thinnedLen);
    const coords = thinned.slice(prevIdx, endIdx + 1);
    prevIdx = endIdx;
    features.push({
      type: 'Feature',
      properties: {
        segment_type: 'trail',
        route_id: 'main',
        region_id: rb.region_id,
        region_name: rb.region_name,
      },
      geometry: { type: 'LineString', coordinates: coords.map(c => [r6(c[0]), r6(c[1])]) },
    });
  });

  // One feature per tread segment. map.js appends every feature sharing a
  // route_id into the same branch, so a multi-segment alternate stays one
  // branch while its coverage gaps stay undrawn.
  let altFeatureCount = 0;
  for (const alt of altDefs) {
    alt.segments.forEach((seg, i) => {
      altFeatureCount++;
      features.push({
        type: 'Feature',
        properties: {
          segment_type: 'alternate',
          route_id: alt.id,
          alt_of: 'main',
          label: alt.name,
          official: alt.official,
          part: i + 1,
          parts: alt.segments.length,
        },
        geometry: { type: 'LineString', coordinates: seg.map(c => [r6(c[0]), r6(c[1])]) },
      });
    });
  }

  fs.writeFileSync(path.join(DATA, 'trail.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features }));
  console.log('  ' + features.length + ' features ('
    + regionBounds.length + ' spine + ' + altFeatureCount + ' alternate)');

  // ── Stage 8: cdt_meta.json ─────────────────────────────────────────────────
  console.log('\n=== Stage 8: cdt_meta.json ===');
  const sectionMeta = order.map(sid => {
    const pts = spine.filter(p => p.section_id === sid);
    const props = primarySections.find(f => f.properties.Section_Number === sid).properties;
    return {
      id: sid,
      name: props.Sec_Desc,
      display_name: props.Sec_Name || null,
      region_id: regionOf[props.State_1].id,
      state1: props.State_1,
      mile_start: pts[0].mile,
      mile_end: pts[pts.length - 1].mile,
      route_id: 'main',
    };
  });
  // Each section runs to the start of the next, so the axis tiles with no gaps.
  for (let i = 0; i < sectionMeta.length - 1; i++) {
    sectionMeta[i].mile_end = sectionMeta[i + 1].mile_start;
  }
  sectionMeta[sectionMeta.length - 1].mile_end = axisEnd;

  const regionMeta = regionBounds.map(rb => {
    const secs = sectionMeta.filter(s => s.region_id === rb.region_id);
    return {
      id: rb.region_id,
      name: REGIONS.find(r => r.id === rb.region_id).name,
      mile_start: secs[0].mile_start,
      mile_end: secs[secs.length - 1].mile_end,
      sections: secs.length,
    };
  });

  const chiefMtn = altMeta.find(a => a.id === 'chief-mtn');
  const meta = {
    trail: {
      name: 'Continental Divide Trail',
      total_miles: axisEnd,
      point_spacing_miles: SPACING,
      map_center: [40.0, -109.5],
      map_zoom: 5,
      termini: {
        south: 'Crazy Cook Monument, NM (US/Mexico border)',
        north: 'Waterton Lake, MT/AB (US/Canada border)',
        north_alternate: 'Chief Mountain, MT (US/Canada border)',
      },
      source: {
        axis: 'CDTC Half_Mile_Markers (Mile_Markers/FeatureServer/0), Label "CDT Primary Route"',
        sections: 'CDTC 2026_CDT_Trail_Sections_view/FeatureServer/0',
        geometry: 'CDTC Continental_Divide_Trail_2/FeatureServer/0',
        org: 'https://services8.arcgis.com/WyuHwdftppQLa5KO/arcgis/rest/services',
        fetched: '2026-09-13',
      },
    },
    regions: regionMeta,
    sections: sectionMeta,
    alternates: altMeta,
    direction_options: [
      { id: 'nobo_waterton',  label: 'Northbound — Crazy Cook → Waterton Lake',  total_miles: axisEnd, is_nobo: true,  terminus: 'waterton'   },
      { id: 'nobo_chief_mtn', label: 'Northbound — Crazy Cook → Chief Mountain', total_miles: r1(chiefMtn.branch_mile + chiefMtn.alt_miles), is_nobo: true,  terminus: 'chief_mtn' },
      { id: 'sobo_waterton',  label: 'Southbound — Waterton Lake → Crazy Cook',  total_miles: axisEnd, is_nobo: false, terminus: 'waterton'   },
      { id: 'sobo_chief_mtn', label: 'Southbound — Chief Mountain → Crazy Cook', total_miles: r1(chiefMtn.branch_mile + chiefMtn.alt_miles), is_nobo: false, terminus: 'chief_mtn' },
    ],
  };
  fs.writeFileSync(path.join(DATA, 'cdt_meta.json'), JSON.stringify(meta, null, 2));
  console.log('  ' + regionMeta.length + ' regions, ' + sectionMeta.length
    + ' sections, ' + altMeta.length + ' alternates');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n=== Summary ===');
  console.log('  axis          0 - ' + axisEnd + ' mi');
  console.log('  points        ' + points.length);
  console.log('  regions       ' + regionMeta.map(r => r.name + ' ' + r1(r.mile_end - r.mile_start)).join(', '));
  console.log('  sec_mile min  ' + Math.min(...sectionMeta.map(s =>
    Math.min(...points.filter(p => p.section_id === s.id).map(p => p.sec_mile)))));
}

main().catch(e => { console.error('\nFATAL: ' + e.message); process.exit(1); });
