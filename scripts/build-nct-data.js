#!/usr/bin/env node
/**
 * build-nct-data.js
 *
 * Rebuilds the North Country Trail data files on the canonical points.json
 * schema, using the North Country Trail Association's own published GIS.
 *
 * Why a rebuild rather than a field-fill. The previous files were produced by
 * TrailTemps' build-points-nct.js, whose greedy nearest-endpoint chainer only
 * ever appended to the tail of the growing chain. Whichever feature happened to
 * sort first became the seed, and every run that belonged upstream of it was
 * stranded and appended afterwards instead. A post-hoc reorderToWesternTerminus
 * rescued only the last of them. The result:
 *
 *   1. Orphan runs mid-axis. trail.geojson carried 29 document-order joins over
 *      2 miles - 360mi (MI), 312mi (MN), 196mi (ND), 186 + 157mi (OH), 149mi
 *      (NY). About 37 miles of trail sat in stubs appended after the block they
 *      belonged to, so points teleported: old mile 4865 landed in southeast
 *      North Dakota and old mile 4877 jumped 197 miles back to Lake Sakakawea.
 *      SectionsHiked's _sliceTrailCoords draws the hiked overlay by walking the
 *      concatenated geojson, so every segment near those miles drew a
 *      cross-state zigzag.
 *   2. ~52 miles dropped. 25 NCTA features carry a null `state` attribute
 *      (37mi in Ohio, 8.7mi MN, 4.7mi PA, 1mi WI) and the old build grouped
 *      features strictly by that field. State is computed by polygon test here,
 *      never read from the attribute - the same rule the PCT and CDT builds
 *      follow.
 *   3. No structure at all. points.json was id/mile/state/lat/lon: no region,
 *      no section, no sec_mile, no route_id. Spacing was 5 miles, the coarsest
 *      of any trail, on the longest trail in the system.
 *
 * Sources (NCTA, ArcGIS Online org UfGVyqUm4GHa2zrj, fetched 2026-09-13):
 *   nct_public/2         - the centerline, 4,004 features. The old build
 *                          requested only seg_id,trail_stat,state; the layer
 *                          also carries seg_name, chapter, len_miles,
 *                          cert_stat, trail_type and trail_surf.
 *   agol_sht_public/1    - NCTA's OWN Superior Hiking Trail layer, 272
 *                          features. The NCTA centerline omits the SHT
 *                          entirely (not merely the Duluth-Silver Bay stretch
 *                          the old notes describe: MN in the centerline is
 *                          569mi of Mesabi/Chippewa/Kekekabic/Border Route and
 *                          contains no North Shore tread at all). This
 *                          replaces the old build's OpenStreetMap Overpass
 *                          injection of relation 1612587 - same corridor, but
 *                          from the trail's own administrator and with NCTA's
 *                          attributes on it.
 *   TIGERweb State_County - state polygons for the per-point state test.
 *   *_halfmile_points    - NCTA's official half-mile markers, used ONLY to
 *                          validate the measured axis (stage 9). See below.
 *
 * THE MILE AXIS IS MEASURED, NOT OFFICIAL. Unlike the PCT and CDT rebuilds
 * there is no official axis to adopt: NCTA publishes half-mile markers only as
 * a patchwork of per-state layers, each restarting at its own zero, and the
 * coverage has holes - Ohio's 1,073 miles carry about 136 miles of markers.
 * They are therefore used as a cross-check (stage 9) rather than as the axis.
 * Where they exist they agree with the measured axis to within a few percent.
 *
 * Do NOT sum the centerline's len_miles field. Split features keep the parent's
 * full length, so 31 features overstate by up to 5.9mi each and the naive total
 * (4,627.22) overshoots measured geometry (4,576.11) by ~51mi. Per feature the
 * measured/official ratio is otherwise 0.999 - the geometry is excellent, it is
 * only the attribute that double-counts.
 *
 * Ordering. Features are assembled into an endpoint graph (endpoints merged at
 * NODE_TOL), split into connected components, and each component's spine taken
 * as the diameter of its maximum spanning tree - the longest continuous run of
 * tread it contains. Components are then joined: each component endpoint is
 * matched to the nearest vertex of a feature in another component, and if that
 * is within JOIN_MI the target feature is SPLIT at that vertex and a bridge
 * edge added. Splitting is the point of the pass - without it a component whose
 * end meets another component mid-feature (a T-junction) can never connect, and
 * the two stay separate forever. This is the same failure the New England Trail
 * build hit at the Menunkatuck junction.
 *
 * That converges in one round to a single component whose spine runs terminus
 * to terminus - Lake Sakakawea ND to Vermont - carrying 4,832.6 miles of source
 * tread plus 0.91 miles of bridge connector. Only one bridge lands in the
 * spine: 0.91mi near Silver Bay MN, where the NCTA centerline and the SHT layer
 * describe two parallel alignments through Beaver Bay that never meet.
 *
 * What is left off the spine: 43.4 miles in 275 features, none longer than
 * 5.0mi. Spot-checking the largest confirms they are side material rather than
 * route - Powers Vista Trail (MI, 4.97mi), the Grand Rapids MN roadwalk
 * fragments that carry no state attribute, McClusky Canal Big Cut (ND, a
 * parallel canal-crossing routing), county road H58 (MI), Sheyenne State Forest
 * fragments (ND), Dolan Nature Preserve and Treblehorn Field. The build prints
 * the full list so it can be re-checked whenever NCTA republishes.
 *
 * Sparse rural roadwalks are real. The spine contains steps up to 6.9mi
 * (47.573,-98.969, ND, New Rockford to Lake Ashtabula) where the source
 * digitises a dead-straight county road with a vertex every few miles. These
 * are tread, not gaps, and are exactly what the old build's MAX_STEP_MI = 8.0
 * was raised to accommodate. No step filter is applied here: the graph walk
 * cannot teleport, so there is nothing to filter.
 *
 * Sections. NCT has no official trail-wide section scheme and none is invented
 * here. Searched and ruled out: agol_retail_maps (the only endpoint-to-endpoint
 * names - "MI-13 - Alberta to Cascade Falls" - but covering ~700 of 4,877
 * miles, the rest being numbered page sheets); the centerline's `chapter` (44
 * affiliate codes, BTA alone spanning 930mi of Ohio, values dirty); `seg_name`
 * (610 distinct, naming the host property rather than a section, 958mi blank);
 * trls_other layers 1 and 2 (nearby trails and campsite spurs, not spine);
 * Old_Route_of_NCT (21 attribute-less historical features). NCTA's own maps
 * page subdivides the trail by state, splitting MI into UP/LP and OH into
 * NW/East - map regions, not hiking sections.
 *
 * So section_id and section_name are emitted on every record as null. They are
 * present so a future official scheme can be filled in without a second
 * migration, and sec_mile is state-local - which is what both apps' UI already
 * asks the user for and what the half-mile markers actually measure.
 *
 * Regions are the 8 states, in trail order. There are no alternates and no
 * spurs: trail_stat carries only "NCT" and "NCT (on-road)", so route_id is
 * "main" throughout. On-road tread is designated and hiked (roughly half of
 * Ohio), so it is tagged route_type "roadwalk" - the hikeable, counted sense,
 * as on the Ice Age and Florida trails - never route_id "roadwalk", which is
 * the non-hikeable gap connector Natchez uses.
 *
 * No trail_elev: TrailTemps' NCT app.js never reads it. If it is wanted later,
 * add the OpenTopoData stage from build-cdt-data.js.
 *
 * Run: node scripts/build-nct-data.js
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const CACHE = path.join(__dirname, 'cache');
const DATA  = path.join(__dirname, '..', 'public', 'trails', 'north-country-trail', 'data');

const CENTERLINE_CACHE = path.join(CACHE, 'nct_centerline.json');
const SHT_CACHE        = path.join(CACHE, 'nct_sht.json');
const STATES_CACHE     = path.join(CACHE, 'census_states_nct.geojson');
const MARKERS_CACHE    = path.join(CACHE, 'nct_halfmile_markers.json');

const ORG = 'https://services2.arcgis.com/UfGVyqUm4GHa2zrj/arcgis/rest/services';

// Point spacing, miles. Matches CDT and PCT, and matches the resolution of
// NCTA's own half-mile markers so the stage 9 cross-check is like for like.
const SPACING = 0.5;

// Endpoint merge tolerance, miles (~79 ft). Swept 0.005 - 0.05 against the real
// data: below this the SHT's own segment joins around Silver Bay fall apart
// (their endpoints differ by up to 0.013mi), and above ~0.03 over-merging
// starts fusing genuinely distinct passages into shortcut nodes that cut the
// spine - total spine length peaks here and falls off on both sides.
const NODE_TOL = 0.015;

// Maximum component-to-component bridge. Every real join in the source is
// under 1.0mi; the nearest thing excluded is the Grand Rapids MN roadwalk
// cluster at 1.5 - 2.1mi, which is parallel routing rather than a missing link.
const JOIN_MI = 1.0;

// GeoJSON output thinning, metres. Same as the CDT build.
const THIN_M = 20;

// Trail order, east to west (WEBO), matching both apps' existing convention.
const REGIONS = [
  { id: 'vt', name: 'Vermont',      fips: '50' },
  { id: 'ny', name: 'New York',     fips: '36' },
  { id: 'pa', name: 'Pennsylvania', fips: '42' },
  { id: 'oh', name: 'Ohio',         fips: '39' },
  { id: 'mi', name: 'Michigan',     fips: '26' },
  { id: 'wi', name: 'Wisconsin',    fips: '55' },
  { id: 'mn', name: 'Minnesota',    fips: '27' },
  { id: 'nd', name: 'North Dakota', fips: '38' },
];
const ABBR = { vt: 'VT', ny: 'NY', pa: 'PA', oh: 'OH', mi: 'MI', wi: 'WI', mn: 'MN', nd: 'ND' };

// NCTA's half-mile marker layers, for validation only. Several states publish
// two overlapping copies and some layers cover only one chapter's territory, so
// these are grouped by the state they measure and compared in aggregate.
const MARKER_LAYERS = [
  { service: 'vt_halfmile_points',   state: 'VT' },
  { service: 'halfmile_ny',          state: 'NY' },
  { service: 'cny_halfmile_points',  state: 'NY' },
  { service: 'a100_halfmile_points', state: 'NY' },
  { service: 'pa_halfmile_points',   state: 'PA' },
  { service: 'anf_halfmile_points',  state: 'PA' },
  { service: 'oh_e_halfmile_points', state: 'OH' },
  { service: 'oh_nw_halfmile_points', state: 'OH' },
  { service: 'halfmile_mi_lp',       state: 'MI' },
  { service: 'halfmile_mi_up',       state: 'MI' },
  { service: 'wi_halfmile_points',   state: 'WI' },
  { service: 'mn_halfmile_points',   state: 'MN' },
  { service: 'nd_halfmile_points',   state: 'ND' },
];

// ── Geometry helpers ──────────────────────────────────────────────────────────

function haversine(la1, lo1, la2, lo2) {
  const R = 3958.8, t = Math.PI / 180;
  const dLa = (la2 - la1) * t, dLo = (lo2 - lo1) * t;
  const s = Math.sin(dLa / 2) ** 2
    + Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

// coords are [lon, lat] pairs throughout, matching GeoJSON order.
const dist = (a, b) => haversine(a[1], a[0], b[1], b[0]);

function pathLen(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += dist(coords[i - 1], coords[i]);
  return d;
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

function thinCoords(coords, minDistM) {
  if (coords.length <= 2) return coords;
  const minMi = minDistM / 1609.34;
  const kept = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    if (dist(kept[kept.length - 1], coords[i]) >= minMi) kept.push(coords[i]);
  }
  kept.push(coords[coords.length - 1]);
  return kept;
}

const r6 = n => Math.round(n * 1e6) / 1e6;
const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;

function pointId(mile) {
  return 'nct-main-mi' + String(Math.round(mile * 1000)).padStart(7, '0');
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

async function fetchLayer(service, layer, fields, withGeometry) {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const url = ORG + '/' + service + '/FeatureServer/' + layer + '/query?where=1%3D1'
      + '&outFields=' + encodeURIComponent(fields)
      + '&returnGeometry=' + (withGeometry ? 'true' : 'false')
      + '&outSR=4326&f=json&resultRecordCount=1000&resultOffset=' + offset;
    const j = await get(url);
    if (j.error) throw new Error(service + ': ' + JSON.stringify(j.error));
    const f = j.features || [];
    all.push(...f);
    if (f.length < 1000) break;
  }
  return all;
}

// ── Spine extraction ──────────────────────────────────────────────────────────

// Node ids for feature endpoints, merged within NODE_TOL via a coarse grid.
function buildGraph(feats) {
  const pts = [], grid = new Map();
  const nid = c => {
    const bx = Math.floor(c[0] / 0.005), by = Math.floor(c[1] / 0.005);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const a = grid.get((bx + dx) + ':' + (by + dy));
      if (!a) continue;
      for (const i of a) if (dist(pts[i], c) <= NODE_TOL) return i;
    }
    const i = pts.length;
    pts.push(c);
    const k = bx + ':' + by;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
    return i;
  };
  const adj = new Map();
  const link = (n, e) => { if (!adj.has(n)) adj.set(n, []); adj.get(n).push(e); };
  feats.forEach((f, i) => {
    f.u = nid(f.coords[0]);
    f.v = nid(f.coords[f.coords.length - 1]);
    if (f.u !== f.v) { link(f.u, [f.v, i]); link(f.v, [f.u, i]); }
  });
  return { pts, adj };
}

// Each component's spine = the diameter of its maximum spanning tree, i.e. the
// longest continuous run of tread it contains. A maximum spanning tree is used
// rather than the raw graph because longest-path on a graph with cycles is
// intractable, and the NCT graph is very nearly a tree already (of 4,063 nodes,
// 3,994 have degree 2 and only 39 have degree above 2).
function componentSpines(feats, graph) {
  const { pts, adj } = graph;
  const seen = new Set(), out = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const stack = [start], nodes = [];
    seen.add(start);
    while (stack.length) {
      const x = stack.pop();
      nodes.push(x);
      for (const [y] of adj.get(x) || []) if (!seen.has(y)) { seen.add(y); stack.push(y); }
    }

    const edges = new Set();
    for (const n of nodes) for (const [, i] of adj.get(n) || []) edges.add(i);

    // Kruskal, heaviest first.
    const parent = new Map(nodes.map(n => [n, n]));
    const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const tree = new Map();
    const tlink = (n, e) => { if (!tree.has(n)) tree.set(n, []); tree.get(n).push(e); };
    for (const i of [...edges].sort((a, b) => feats[b].len - feats[a].len)) {
      const a = find(feats[i].u), b = find(feats[i].v);
      if (a === b) continue;
      parent.set(a, b);
      tlink(feats[i].u, [feats[i].v, i]);
      tlink(feats[i].v, [feats[i].u, i]);
    }

    // Tree diameter by double DFS.
    const far = src => {
      const d = new Map([[src, 0]]), prev = new Map(), st = [src];
      while (st.length) {
        const x = st.pop();
        for (const [y, i] of tree.get(x) || []) {
          if (d.has(y)) continue;
          d.set(y, d.get(x) + feats[i].len);
          prev.set(y, [x, i]);
          st.push(y);
        }
      }
      let end = src;
      for (const [n, v] of d) if (v > d.get(end)) end = n;
      return { end, d, prev };
    };
    const a = far(nodes[0]).end;
    const { end: b, d, prev } = far(a);

    const order = [];
    for (let x = b; prev.has(x);) { const [p, i] = prev.get(x); order.push(i); x = p; }
    order.reverse();

    // Walk the path, emitting coords in travel order.
    const coords = [];
    let cur = a;
    for (const i of order) {
      const f = feats[i];
      const seg = f.u === cur ? f.coords : f.coords.slice().reverse();
      cur = f.u === cur ? f.v : f.u;
      for (let k = coords.length ? 1 : 0; k < seg.length; k++) coords.push(seg[k]);
    }
    out.push({ len: d.get(b), a, b, coords, edges, path: order, endA: pts[a], endB: pts[b] });
  }
  out.sort((x, y) => y.len - x.len);
  return out;
}

// Join components. For each non-primary component endpoint, find the nearest
// vertex of any feature belonging to a different component; if within JOIN_MI,
// SPLIT that feature there and add a bridge edge. Splitting is what makes a
// T-junction connectable at all - without it a component whose end meets
// another mid-feature can never join.
function joinComponents(feats, spines) {
  const compOf = new Map();
  spines.forEach((s, ci) => { for (const i of s.edges) compOf.set(i, ci); });

  const added = [];
  spines.forEach((s, ci) => {
    if (ci === 0) return;
    for (const end of [s.endA, s.endB]) {
      let best = { d: Infinity, fi: -1, vi: -1 };
      feats.forEach((f, fi) => {
        if (compOf.get(fi) === ci || compOf.get(fi) === undefined) return;
        for (let vi = 0; vi < f.coords.length; vi++) {
          const d = dist(end, f.coords[vi]);
          if (d < best.d) best = { d, fi, vi };
        }
      });
      if (best.d > JOIN_MI) continue;

      const target = feats[best.fi];
      const junction = target.coords[best.vi].slice();
      let split = false;
      if (best.vi > 0 && best.vi < target.coords.length - 1) {
        const tail = target.coords.slice(best.vi);
        target.coords = target.coords.slice(0, best.vi + 1);
        target.len = pathLen(target.coords);
        added.push({ coords: tail, attrs: target.attrs, src: target.src, len: pathLen(tail) });
        split = true;
      }
      added.push({
        coords: [end.slice(), junction], attrs: { seg_name: '__bridge__' },
        src: 'bridge', len: best.d,
      });
      console.log('    bridge ' + best.d.toFixed(3) + ' mi  '
        + end[1].toFixed(5) + ',' + end[0].toFixed(5) + ' -> '
        + junction[1].toFixed(5) + ',' + junction[0].toFixed(5)
        + (split ? '  (target feature split at the junction)' : ''));
    }
  });
  return added;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Stage 1: sources ───────────────────────────────────────────────────────
  console.log('=== Stage 1: sources ===');
  fs.mkdirSync(CACHE, { recursive: true });

  if (!fs.existsSync(CENTERLINE_CACHE)) {
    console.log('  centerline: fetching NCTA nct_public/2 ...');
    const f = await fetchLayer('nct_public', 2,
      'OBJECTID,seg_id,seg_name,chapter,state,trail_stat,trail_type,cert_stat,len_miles', true);
    fs.writeFileSync(CENTERLINE_CACHE, JSON.stringify(f));
  }
  if (!fs.existsSync(SHT_CACHE)) {
    console.log('  SHT: fetching NCTA agol_sht_public/1 ...');
    const f = await fetchLayer('agol_sht_public', 1,
      'OBJECTID,seg_name,state,chapter,ncta_region,trail_stat,trail_type,len_miles', true);
    fs.writeFileSync(SHT_CACHE, JSON.stringify(f));
  }
  if (!fs.existsSync(STATES_CACHE)) {
    console.log('  states: fetching Census TIGERweb boundaries ...');
    const where = "STATE IN ('" + REGIONS.map(r => r.fips).join("','") + "')";
    fs.writeFileSync(STATES_CACHE, JSON.stringify(await get(
      'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County'
      + '/MapServer/0/query?where=' + encodeURIComponent(where)
      + '&outFields=NAME,STATE&outSR=4326&f=geojson')));
  }
  if (!fs.existsSync(MARKERS_CACHE)) {
    console.log('  markers: fetching NCTA half-mile marker layers ...');
    const byState = {};
    for (const m of MARKER_LAYERS) {
      // Field names differ layer to layer (some have no `ident`), so take all of them.
      const f = await fetchLayer(m.service, 0, '*', true);
      (byState[m.state] ||= []).push({ service: m.service, features: f });
      console.log('    ' + m.service + ': ' + f.length);
    }
    fs.writeFileSync(MARKERS_CACHE, JSON.stringify(byState));
  }

  const centerline = JSON.parse(fs.readFileSync(CENTERLINE_CACHE, 'utf8'));
  const shtRaw     = JSON.parse(fs.readFileSync(SHT_CACHE, 'utf8'));
  const statesGeo  = JSON.parse(fs.readFileSync(STATES_CACHE, 'utf8'));
  const markers    = JSON.parse(fs.readFileSync(MARKERS_CACHE, 'utf8'));
  console.log('  centerline ' + centerline.length + ' features, SHT ' + shtRaw.length);

  // ── Stage 2: assemble features ─────────────────────────────────────────────
  console.log('\n=== Stage 2: assemble ===');
  const feats = [];
  const push = (coords, attrs, src) => {
    if (!coords || coords.length < 2) return;
    feats.push({ coords, attrs, src, len: pathLen(coords) });
  };
  for (const f of centerline) {
    if (!f.geometry) continue;
    for (const p of f.geometry.paths) push(p, f.attributes, 'nct');
  }
  for (const f of shtRaw) {
    if (!f.geometry) continue;
    for (const p of f.geometry.paths) push(p, f.attributes, 'sht');
  }
  const sourceMi = feats.reduce((s, f) => s + f.len, 0);
  console.log('  ' + feats.length + ' usable features, ' + r2(sourceMi) + ' mi of source tread');

  // ── Stage 3: chain into one spine ──────────────────────────────────────────
  console.log('\n=== Stage 3: chain ===');
  let spines = componentSpines(feats, buildGraph(feats));
  console.log('  ' + spines.length + ' components; longest spines '
    + spines.slice(0, 4).map(s => r2(s.len)).join(', '));

  for (let round = 0; round < 6; round++) {
    const added = joinComponents(feats, spines);
    if (!added.length) break;
    feats.push(...added);
    spines = componentSpines(feats, buildGraph(feats));
    console.log('  round ' + (round + 1) + ': ' + spines.length + ' components; longest '
      + r2(spines[0].len) + ' mi');
  }

  const main = spines[0];
  const bridgeMi = main.path.reduce((s, i) => feats[i].src === 'bridge' ? s + feats[i].len : s, 0);
  const onSpine = new Set(main.path);
  const off = feats.filter((f, i) => f.src !== 'bridge' && !onSpine.has(i));
  const offMi = off.reduce((s, f) => s + f.len, 0);

  console.log('  spine ' + r2(main.len) + ' mi ('
    + r2(main.len - bridgeMi) + ' mi tread + ' + bridgeMi.toFixed(3) + ' mi bridge)');
  console.log('  off-spine ' + r2(offMi) + ' mi in ' + off.length + ' features:');
  off.filter(f => f.len > 0.5).sort((a, b) => b.len - a.len).forEach(f => {
    const c = f.coords[Math.floor(f.coords.length / 2)];
    console.log('    ' + f.len.toFixed(2).padStart(6) + 'mi  '
      + String(f.attrs.state || '--').padEnd(4)
      + String(f.attrs.seg_name || '(unnamed)').slice(0, 32).padEnd(34)
      + c[1].toFixed(4) + ',' + c[0].toFixed(4));
  });

  // Orient east to west: Vermont end first, Lake Sakakawea last.
  let line = main.coords;
  const VT_TERMINUS = [-72.8392, 43.6748];
  if (dist(line[0], VT_TERMINUS) > dist(line[line.length - 1], VT_TERMINUS)) line = line.slice().reverse();
  console.log('  oriented ' + line[0][1].toFixed(4) + ',' + line[0][0].toFixed(4)
    + ' -> ' + line[line.length - 1][1].toFixed(4) + ',' + line[line.length - 1][0].toFixed(4));

  // Per-vertex roadwalk flag, carried from the feature each vertex came from.
  // Built by re-walking the spine path so a vertex is never guessed at.
  const roadwalkAt = new Array(line.length).fill(false);
  {
    const flags = [];
    let cur = main.a;
    for (const i of main.path) {
      const f = feats[i];
      const on = f.attrs && f.attrs.trail_stat === 'NCT (on-road)';
      const seg = f.u === cur ? f.coords : f.coords.slice().reverse();
      cur = f.u === cur ? f.v : f.u;
      for (let k = flags.length ? 1 : 0; k < seg.length; k++) flags.push(on);
    }
    const oriented = (line === main.coords) ? flags : flags.slice().reverse();
    for (let i = 0; i < roadwalkAt.length; i++) roadwalkAt[i] = oriented[i] || false;
  }
  const axisEnd = r2(pathLen(line));
  console.log('  axis 0 - ' + axisEnd + ' mi over ' + line.length + ' vertices');

  // ── Stage 4: cumulative distance and state ─────────────────────────────────
  console.log('\n=== Stage 4: state ===');
  const cum = new Array(line.length).fill(0);
  for (let i = 1; i < line.length; i++) cum[i] = cum[i - 1] + dist(line[i - 1], line[i]);

  const statePolys = REGIONS.map(r => ({
    id: r.id, abbr: ABBR[r.id],
    geometry: statesGeo.features.find(f => f.properties.STATE === r.fips).geometry,
  }));
  const stateAtVertex = i => {
    const c = line[i];
    const hit = statePolys.find(s => inFeature(c[0], c[1], s.geometry));
    return hit ? hit.id : null;
  };

  // ── Stage 5: interpolate points ────────────────────────────────────────────
  console.log('\n=== Stage 5: points ===');
  const raw = [];
  let vi = 1;
  for (let mile = 0; mile <= axisEnd + 1e-9; mile += SPACING) {
    while (vi < line.length - 1 && cum[vi] < mile) vi++;
    const lo = vi - 1, hi = vi;
    const span = cum[hi] - cum[lo];
    const t = span > 0 ? (mile - cum[lo]) / span : 0;
    raw.push({
      mile: r1(mile),
      lon: line[lo][0] + (line[hi][0] - line[lo][0]) * t,
      lat: line[lo][1] + (line[hi][1] - line[lo][1]) * t,
      roadwalk: roadwalkAt[t < 0.5 ? lo : hi],
      vertex: t < 0.5 ? lo : hi,
    });
  }
  // Always land the final point exactly on the terminus.
  const last = raw[raw.length - 1];
  if (Math.abs(last.mile - axisEnd) > 1e-6) {
    raw.push({
      mile: axisEnd, lon: line[line.length - 1][0], lat: line[line.length - 1][1],
      roadwalk: roadwalkAt[line.length - 1], vertex: line.length - 1,
    });
  }

  let unplaced = 0;
  const counts = {};
  for (const p of raw) {
    p.st = stateAtVertex(p.vertex);
    if (!p.st) unplaced++;
    else counts[p.st] = (counts[p.st] || 0) + 1;
  }
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].st) continue;
    // A point on a bridge or right on a border can fall outside every polygon;
    // inherit from the nearest neighbour rather than emit null.
    let back = i, fwd = i;
    while (back >= 0 && !raw[back].st) back--;
    while (fwd < raw.length && !raw[fwd].st) fwd++;
    raw[i].st = (back >= 0 ? raw[back].st : null) || (fwd < raw.length ? raw[fwd].st : null);
  }
  console.log('  ' + Object.entries(counts).map(([k, v]) => ABBR[k] + ' ' + v).join(', '));
  if (unplaced) console.log('  ' + unplaced + ' point(s) outside every state polygon, filled from neighbours');

  // Region is a trail-order construct; state is a geographic fact. They are not
  // the same field and must not be conflated - the CDT build makes the same
  // split along the Montana/Idaho divide.
  //
  // Below Jay Cooke State Park the state line IS the St. Louis River and the
  // trail weaves across it, so the raw polygon test yields WI ... MN ... WI ...
  // MN over about three miles. Left alone that makes region_id non-contiguous,
  // which breaks two things at once: regions no longer tile the axis, and
  // sec_mile stops being a usable state-local measure because each re-entry
  // either restarts it or inherits an offset that counts the other state's
  // miles. So any excursion shorter than REGION_MIN_MI is absorbed into the
  // region around it, while `state` keeps reporting the ground truth.
  const REGION_MIN_MI = 5;
  const runs = [];
  for (const p of raw) {
    if (!runs.length || runs[runs.length - 1].st !== p.st) runs.push({ st: p.st, pts: [] });
    runs[runs.length - 1].pts.push(p);
  }
  for (let i = 0; i < runs.length; i++) {
    const span = runs[i].pts[runs[i].pts.length - 1].mile - runs[i].pts[0].mile;
    if (i > 0 && i < runs.length - 1 && span < REGION_MIN_MI) {
      // Absorb into the previous run's REGION, not its raw state - back-to-back
      // excursions (the river crosses twice) would otherwise chain onto each
      // other and put the boundary in the middle of the weave.
      const into = runs[i - 1].absorbInto || runs[i - 1].st;
      console.log('  absorbing ' + ABBR[runs[i].st] + ' excursion of ' + r1(span)
        + ' mi at mile ' + runs[i].pts[0].mile + ' into ' + ABBR[into]
        + ' (state field keeps ' + ABBR[runs[i].st] + ')');
      runs[i].absorbInto = into;
    }
  }
  for (const run of runs) for (const p of run.pts) p.region = run.absorbInto || run.st;

  // Guard: after absorption each region must appear exactly once, in trail order.
  const regionSeq = [];
  for (const p of raw) if (regionSeq[regionSeq.length - 1] !== p.region) regionSeq.push(p.region);
  const expected = REGIONS.map(r => r.id).filter(id => raw.some(p => p.region === id));
  if (regionSeq.join(',') !== expected.join(',')) {
    throw new Error('regions are not contiguous in trail order: ' + regionSeq.join(','));
  }

  // State-local mileage. sec_mile restarts at 0 at each region boundary; with
  // no sections on this trail that is the only local axis there is.
  const regionStart = {};
  for (const p of raw) if (!(p.region in regionStart)) regionStart[p.region] = p.mile;

  const points = raw.map(p => {
    const rec = {
      id: pointId(p.mile),
      lat: r6(p.lat), lon: r6(p.lon),
      mile: p.mile,
      region_id: p.region,
      region_name: REGIONS.find(r => r.id === p.region).name,
      // NCT has no official section scheme. Held open deliberately - see header.
      section_id: null,
      section_name: null,
      sec_mile: r1(p.mile - regionStart[p.region]),
      route_id: 'main',
      state: ABBR[p.st],
    };
    if (p.roadwalk) rec.route_type = 'roadwalk';
    return rec;
  });

  const dupes = points.map(p => p.id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dupes.length) throw new Error('duplicate point ids: ' + [...new Set(dupes)].slice(0, 5).join(', '));
  for (let i = 1; i < points.length; i++) {
    if (points[i].mile <= points[i - 1].mile) throw new Error('mile not strictly increasing at ' + points[i].id);
  }
  for (const r of REGIONS) {
    const first = points.find(p => p.region_id === r.id);
    if (first && first.sec_mile !== 0) throw new Error(r.name + ' does not start at sec_mile 0');
  }

  fs.writeFileSync(path.join(DATA, 'points.json'), JSON.stringify(points, null, 2));
  console.log('  ' + points.length + ' points at ' + SPACING + ' mi, '
    + points.filter(p => p.route_type === 'roadwalk').length + ' on roadwalk');

  // ── Stage 6: trail.geojson ─────────────────────────────────────────────────
  console.log('\n=== Stage 6: trail.geojson ===');
  // One feature per contiguous run of the same region and the same roadwalk
  // state, emitted in axis order, so map.js concatenates them into the trail
  // with no teleports and dashes exactly the on-road stretches.
  const vertexRegion = new Array(line.length).fill(null);
  {
    let pi = 0;
    for (let i = 0; i < line.length; i++) {
      while (pi < raw.length - 1 && raw[pi].vertex < i) pi++;
      vertexRegion[i] = raw[pi].region;
    }
  }

  const features = [];
  let runStart = 0;
  const flush = (end) => {
    const coords = thinCoords(line.slice(runStart, end + 1), THIN_M);
    if (coords.length < 2) return;
    const rid = vertexRegion[runStart];
    const props = {
      segment_type: roadwalkAt[runStart] ? 'roadwalk' : 'trail',
      route_id: 'main',
      region_id: rid,
      region_name: REGIONS.find(r => r.id === rid).name,
      section_id: null,
      section_name: null,
      state: ABBR[rid],
    };
    // route_type "roadwalk" is the hikeable, counted sense (Ice Age, Florida) -
    // dashed on the map but part of the spine. Never route_id "roadwalk", which
    // map.js drops from the spine entirely.
    if (roadwalkAt[runStart]) props.route_type = 'roadwalk';
    features.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords.map(c => [r6(c[0]), r6(c[1])]) } });
  };
  for (let i = 1; i < line.length; i++) {
    if (roadwalkAt[i] !== roadwalkAt[runStart] || vertexRegion[i] !== vertexRegion[runStart]) {
      flush(i);
      runStart = i;
    }
  }
  flush(line.length - 1);

  fs.writeFileSync(path.join(DATA, 'trail.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features }));
  const bytes = fs.statSync(path.join(DATA, 'trail.geojson')).size;
  console.log('  ' + features.length + ' features, '
    + features.filter(f => f.properties.route_type === 'roadwalk').length + ' roadwalk, '
    + (bytes / 1048576).toFixed(1) + ' MB');

  // Ordering guard: this is the defect that motivated the rebuild.
  let worst = 0;
  for (let i = 1; i < features.length; i++) {
    const a = features[i - 1].geometry.coordinates;
    const b = features[i].geometry.coordinates;
    worst = Math.max(worst, dist(a[a.length - 1], b[0]));
  }
  console.log('  largest feature-to-feature join: ' + worst.toFixed(3) + ' mi');
  if (worst > JOIN_MI) throw new Error('geojson features are out of axis order (join ' + r2(worst) + ' mi)');

  // ── Stage 7: nct_meta.json ─────────────────────────────────────────────────
  console.log('\n=== Stage 7: nct_meta.json ===');
  const regionMeta = REGIONS.map(r => {
    const pts = points.filter(p => p.region_id === r.id);
    if (!pts.length) return null;
    return {
      id: r.id, name: r.name, state: ABBR[r.id],
      mile_start: pts[0].mile,
      mile_end: pts[pts.length - 1].mile,
      miles: r1(pts[pts.length - 1].mile - pts[0].mile),
      sections: 0,
    };
  }).filter(Boolean);
  // Each region runs to the start of the next, so the axis tiles with no gaps.
  for (let i = 0; i < regionMeta.length - 1; i++) regionMeta[i].mile_end = regionMeta[i + 1].mile_start;
  regionMeta[regionMeta.length - 1].mile_end = axisEnd;
  regionMeta.forEach(r => { r.miles = r1(r.mile_end - r.mile_start); });

  const meta = {
    trail: {
      name: 'North Country Trail',
      total_miles: axisEnd,
      point_spacing_miles: SPACING,
      map_center: [45.5, -87.0],
      map_zoom: 5,
      termini: {
        east: 'Vermont (Appalachian Trail junction, Maine Junction)',
        west: 'Lake Sakakawea State Park, ND',
      },
      source: {
        geometry: 'NCTA nct_public/FeatureServer/2',
        superior_hiking_trail: 'NCTA agol_sht_public/FeatureServer/1',
        states: 'US Census TIGERweb State_County',
        axis: 'measured from the source geometry; NCTA publishes no trail-wide mile axis',
        validation: 'NCTA per-state half-mile marker layers (partial coverage)',
        org: ORG,
        fetched: '2026-09-13',
      },
      notes: {
        sections: 'NCT has no official trail-wide section scheme. section_id and '
          + 'section_name are held open as null; sec_mile is state-local.',
        roadwalk: 'On-road tread is designated, hiked and counted toward mileage; '
          + 'tagged route_type "roadwalk" and drawn dashed.',
        off_spine_miles: r2(offMi),
        bridge_miles: r2(bridgeMi),
      },
    },
    regions: regionMeta,
    sections: [],
    alternates: [],
    direction_options: [
      { id: 'webo', label: 'Westbound - Vermont -> Lake Sakakawea, ND', total_miles: axisEnd, is_webo: true },
      { id: 'eabo', label: 'Eastbound - Lake Sakakawea, ND -> Vermont', total_miles: axisEnd, is_webo: false },
    ],
  };
  fs.writeFileSync(path.join(DATA, 'nct_meta.json'), JSON.stringify(meta, null, 2));
  console.log('  ' + regionMeta.length + ' regions, 0 sections, 0 alternates');

  // ── Stage 8: validate against NCTA half-mile markers ───────────────────────
  console.log('\n=== Stage 8: cross-check vs NCTA half-mile markers ===');
  // Each layer restarts at its own zero and several cover only part of a state,
  // so comparing a layer's length to the whole state's axis proves nothing.
  // Instead every marker is snapped to the axis, and the axis span the layer
  // actually covers is compared with the run length its own markers imply,
  // (count - 1) * 0.5. That is like for like even where coverage is partial.
  const snapGrid = new Map();
  for (let i = 0; i < line.length; i++) {
    const k = Math.floor(line[i][1] / 0.02) + ':' + Math.floor(line[i][0] / 0.02);
    if (!snapGrid.has(k)) snapGrid.set(k, []);
    snapGrid.get(k).push(i);
  }
  const snapMile = (lon, lat) => {
    let best = Infinity, bi = -1;
    for (let r = 1; r <= 12 && bi < 0 || r <= 2; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (r > 1 && Math.abs(dx) < r && Math.abs(dy) < r) continue;
        const a = snapGrid.get((Math.floor(lat / 0.02) + dy) + ':' + (Math.floor(lon / 0.02) + dx));
        if (!a) continue;
        for (const i of a) {
          const d = haversine(lat, lon, line[i][1], line[i][0]);
          if (d < best) { best = d; bi = i; }
        }
      }
      if (bi >= 0 && best < r * 0.02 * 60) break;
    }
    return bi < 0 ? null : { mile: cum[bi], off: best };
  };

  for (const m of MARKER_LAYERS) {
    const layer = (markers[m.state] || []).find(l => l.service === m.service);
    if (!layer) continue;
    const hits = [];
    let far = 0;
    for (const f of layer.features) {
      if (!f.geometry || f.geometry.x == null) continue;
      const s = snapMile(f.geometry.x, f.geometry.y);
      if (!s) continue;
      if (s.off > 0.25) { far++; continue; }
      hits.push(s.mile);
    }
    if (hits.length < 2) { console.log('  ' + m.service.padEnd(22) + ' no usable markers'); continue; }
    const axisSpan   = Math.max(...hits) - Math.min(...hits);
    const markerSpan = (layer.features.length - 1) * 0.5;
    const delta      = axisSpan - markerSpan;
    const pct        = markerSpan > 0 ? 100 * delta / markerSpan : 0;
    console.log('  ' + m.service.padEnd(22) + m.state
      + '  axis ' + axisSpan.toFixed(1).padStart(7) + ' mi over the stretch its '
      + layer.features.length + ' markers cover'
      + '  vs ' + markerSpan.toFixed(1) + ' mi implied'
      + '  (' + (delta >= 0 ? '+' : '') + delta.toFixed(1) + ' mi, '
      + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%)'
      + (far ? '  [' + far + ' markers >0.25mi off axis, ignored]' : ''));
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n=== Summary ===');
  console.log('  axis        0 - ' + axisEnd + ' mi   (was 4877.03)');
  console.log('  points      ' + points.length + ' at ' + SPACING + ' mi   (was 977 at 5 mi)');
  console.log('  regions     ' + regionMeta.map(r => r.state + ' ' + r.miles.toFixed(1)).join(', '));
  console.log('  sections    none - held open as null');
  console.log('  roadwalk    ' + r1(100 * points.filter(p => p.route_type === 'roadwalk').length / points.length) + '% of points');
}

main().catch(e => { console.error('\nFATAL: ' + e.message); process.exit(1); });
