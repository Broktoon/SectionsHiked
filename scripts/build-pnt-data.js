#!/usr/bin/env node
/**
 * build-pnt-data.js
 *
 * Rebuilds the Pacific Northwest Trail data files on the canonical points.json
 * schema, from the USFS Region 6 hosted centerline.
 *
 * WHY A REBUILD, GIVEN THE OLD AXIS WAS SOUND
 *
 * Unusually, the axis this replaces was NOT wrong. TrailTemps' build-pnt-data.js
 * measured it off the geometry rather than rescaling a simplified line to a
 * published total, so the PNT never had the defect that cost the PCT up to 7
 * miles of drift. Reconstructing distance along the old assembled line
 * reproduces every old point's `mile` to within 0.012mi at mile 1217 - a drift
 * that grows linearly from zero, which is haversine-radius rounding, not a
 * scale factor. Its greedy nearest-endpoint chainer also happened not to strand
 * anything here, unlike on the NCT and the CDT alternates. Those results are
 * recorded so the checks are not redone.
 *
 * What it is rebuilt for:
 *
 *   1. THE FERRY WAS COUNTED AS HIKING MILES, and by more than was visible.
 *      The source carries the Puget Sound crossing as its own feature (FID 322,
 *      RTE_NAME "Port Townsend/Keystone Ferry", COMMENT "Ferry", 5.792mi). The
 *      old fix-ferry-geometry.js split the Puget Sound line at its LARGEST
 *      COORDINATE JUMP, which lands mid-channel, so only 4.866mi became the
 *      dashed ferry feature and 0.926mi of open water stayed a solid trail
 *      line. Both halves sat on the mile axis, shifting every Olympic Peninsula
 *      mile by +5.79. pnt_meta.json's "no hiking miles added" was false, as was
 *      TrailTemps' PNT_TRAIL_MILES comment. This build takes the ferry from the
 *      attribute, never from a jump heuristic, and gives it zero axis length.
 *
 *   2. The legacy schema: `section` and `state` only, no region_id/section_id/
 *      sec_mile/route_id, and 5-mile point spacing.
 *
 *   3. Roadwalk was not distinguished at all, though the source classifies it.
 *
 * THE FERRY. Modelled on the NET build's Connecticut River crossing: the line
 * is drawn so the route reads as continuous, but it carries no mileage and no
 * points.json entries - route_id "roadwalk", the NON-hikeable sense of that tag
 * (Natchez's parkway), which map.js drops from the spine. It keeps segment_type
 * "ferry" as well, both because it is not a road and because TrailTemps' PNT
 * app.js styles on exactly that value. The ferry IS in the spine graph, so the
 * walk crosses it and the two land masses come out in one ordered line; it is
 * the cumulative-distance pass that gives it zero length. Consecutive points
 * straddling it are therefore 5.79mi apart on the ground but 0.5mi apart on the
 * axis. That is deliberate, and is the same discontinuity the NET build
 * documents at the Connecticut River.
 *
 * SURFACE. The source's `Layer` field is an official classification the old
 * build never fetched: PNT_TRAIL 738.44mi, PNT_ROAD 461.11mi (37.9%, comparable
 * to the NCT's ~31%), PNT_XC 17.73mi. PNT_ROAD becomes route_type "roadwalk" -
 * the hikeable, counted sense (Ice Age, Florida), dashed but part of the spine.
 * PNT_XC becomes route_type "cross-country": designated route with no
 * constructed tread, mostly the Olympic wilderness beach and two Selkirk
 * traverses. No consumer reads that value yet, so it renders as ordinary trail.
 *
 * SECTIONS ARE NULL. This is deliberate. PNTA does publish 10 named sections
 * with lengths - Rocky Mountain 151, Purcell Mountains 99, Selkirk Mountains
 * 152, Kettle River Range 128, Okanogan Highlands 99, Pasayten Wilderness 119,
 * North Cascades 196, Puget Sound 70, Olympic Mountains 170, Wilderness Coast
 * 64 - but publishes no boundary coordinates, and they cannot be placed on this
 * axis honestly:
 *
 *   - PNTA's sections total 1248mi against this axis's ~1212, because the USFS
 *     layer is the CONGRESSIONAL route as of 5/5/2016 and the hiking route has
 *     moved since. So absolute mileage cannot place a boundary.
 *   - Placing them proportionally and checking against the independent evidence
 *     in the source's COMMENT field (the land manager: Glacier NP, Kootenai NF,
 *     Idaho Panhandle NF, Okanogan-Wenatchee NF, North Cascades NP, Olympic NP)
 *     agrees for three boundaries - Pasayten/North Cascades within 8mi, Puget
 *     Sound/Olympic within 10mi, Olympic/Wilderness Coast within 6mi - and
 *     contradicts others by 30 to 65mi.
 *   - COMMENT is blank for ~400mi through miles 323-622, which is exactly where
 *     the Kettle River Range and Okanogan Highlands boundaries fall, so there
 *     is no evidence there at all.
 *
 * Inventing the other seven would be the mistake the NCT build's header warns
 * against. section_id and section_name are emitted as null on every record so
 * an official georeferenced scheme drops in without a second migration, and
 * sec_mile is region-local, which is what the segment-entry UI asks for anyway.
 *
 * REGIONS are the 5 geographic areas. Boundaries come from the source's
 * PNT_Sectio attribute; names come from PNTA. The two differ on one: USFS calls
 * area 2 "Northeast Washington" and PNTA calls it "Okanogan Highlands". The
 * name previously shipped, "Columbia Mountains", is neither.
 *
 * `state` is a polygon test, not the source's State attribute. That attribute
 * put the Montana/Idaho switch at mile 220 when the axis crosses the border
 * before mile 215 - the same class of error as the CDT's, at ~5mi not 260mi.
 *
 * Ordering uses the NCT build's endpoint graph and maximum-spanning-tree
 * diameter, not a greedy nearest-endpoint chain. The greedy chainer did not
 * strand anything on this trail, but it is the routine that produced the NCT's
 * 360mi joins and the CDT alternates' phantom straight lines, and there is no
 * reason to keep depending on it being lucky.
 *
 * The MILES attribute is ignored: it is populated for only ~764 of 1217 miles.
 *
 * Source (USFS Region 6, ArcGIS Online org gGHDlz6USftL5Pau):
 *   Pacific_Northwest_National_Scenic_Trail/FeatureServer/0 - 456 features.
 *   "displays the congressional route ... as of 5/5/2016". PNTA publishes no
 *   open GIS and no mile-marker layer, so unlike the PCT and CDT rebuilds there
 *   is no official axis to adopt and no per-mile reference to validate against.
 *
 * Run: node scripts/build-pnt-data.js
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const CACHE = path.join(__dirname, 'cache');
const DATA  = path.join(__dirname, '..', 'public', 'trails', 'pacific-northwest-trail', 'data');

const TRAIL_CACHE  = path.join(CACHE, 'pnt_usfs.json');
const STATES_CACHE = path.join(CACHE, 'census_states_pnt.geojson');

const ORG = 'https://services1.arcgis.com/gGHDlz6USftL5Pau/arcgis/rest/services';
const SERVICE = 'Pacific_Northwest_National_Scenic_Trail';

// Point spacing, miles. Matches the CDT, PCT and NCT rebuilds.
const SPACING = 0.5;

// Endpoint merge tolerance, miles (~53 ft). Stage 3 re-runs the whole assembly
// across a sweep of values every build and prints the result, rather than
// asserting a number in a comment. On this source the choice barely matters:
// the assembled spine stays within 0.07mi across 0.005 - 0.040 and converges to
// one component at every value. That is because the source parts very nearly
// share exact endpoints - node-merge slack is 0.1 ft per join, against the
// NCT's 2.1 ft - so the tolerance changes only how much work the bridging pass
// does afterwards, not what it converges on. 0.010 is chosen as the value that
// needs the fewest bridges while still splitting nothing that should not split.
const NODE_TOL = 0.010;

// Maximum component-to-component bridge, miles.
const JOIN_MI = 1.0;

// GeoJSON output thinning, metres. Same as the CDT and NCT builds.
const THIN_M = 20;

// Regions, east to west (WEBO), keyed by the PNT_Sectio value in the source.
// Names are PNTA's, boundaries are the source's.
const REGIONS = [
  { usfs: 'Rocky Mountains',      id: 'rocky-mountains',    name: 'Rocky Mountains' },
  { usfs: 'Northeast Washington', id: 'okanogan-highlands', name: 'Okanogan Highlands' },
  { usfs: 'North Cascades',       id: 'north-cascades',     name: 'North Cascades' },
  { usfs: 'Puget Sound',          id: 'puget-sound',        name: 'Puget Sound' },
  { usfs: 'Olympic Peninsula',    id: 'olympic-peninsula',  name: 'Olympic Peninsula' },
];

const STATES = [
  { abbr: 'MT', fips: '30' },
  { abbr: 'ID', fips: '16' },
  { abbr: 'WA', fips: '53' },
];

// The source's own surface classification, in the `Layer` field.
const ROUTE_TYPE = { PNT_ROAD: 'roadwalk', PNT_XC: 'cross-country', PNT_TRAIL: null };

// Orientation. Mile 0 is the eastern terminus, matching the WEBO convention
// already used by both apps.
const EAST_TERMINUS = [-113.65918, 48.996115];  // Chief Mountain, MT (Glacier NP)

// A region excursion shorter than this is absorbed into the region around it,
// so regions tile the axis and sec_mile stays a usable region-local measure.
// Same guard, and same reason, as the NCT build's state weave.
const REGION_MIN_MI = 5;

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
  return 'pnt-main-mi' + String(Math.round(mile * 1000)).padStart(7, '0');
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

// Paged, unlike the build this replaces, which asked for 500 records once and
// would have silently truncated had the layer ever grown past that.
async function fetchLayer(service, layer, fields) {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const url = ORG + '/' + service + '/FeatureServer/' + layer + '/query?where=1%3D1'
      + '&outFields=' + encodeURIComponent(fields)
      + '&returnGeometry=true&outSR=4326&f=json'
      + '&resultRecordCount=1000&resultOffset=' + offset;
    const j = await get(url);
    if (j.error) throw new Error(service + ': ' + JSON.stringify(j.error));
    const f = j.features || [];
    all.push(...f);
    if (f.length < 1000) break;
  }
  return all;
}

// ── Spine extraction ──────────────────────────────────────────────────────────

// Node ids for feature endpoints, merged within tol via a coarse grid.
function buildGraph(feats, tol) {
  const pts = [], grid = new Map();
  const nid = c => {
    const bx = Math.floor(c[0] / 0.005), by = Math.floor(c[1] / 0.005);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const a = grid.get((bx + dx) + ':' + (by + dy));
      if (!a) continue;
      for (const i of a) if (dist(pts[i], c) <= tol) return i;
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
// intractable, and this graph is very nearly a tree already.
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

    out.push({ len: d.get(b), a, b, edges, path: order, endA: pts[a], endB: pts[b] });
  }
  out.sort((x, y) => y.len - x.len);
  return out;
}

// Walk a spine's edge path, emitting one entry per vertex in travel order and
// carrying the source feature each vertex came from, so no per-vertex attribute
// is ever guessed at. Also returns the node-merge slack, so the axis total can
// be fully accounted for.
function walkSpine(feats, spine) {
  const coords = [], owner = [];
  let cur = spine.a, prevEnd = null, slack = 0, joins = 0;
  for (const i of spine.path) {
    const f = feats[i];
    const seg = f.u === cur ? f.coords : f.coords.slice().reverse();
    cur = f.u === cur ? f.v : f.u;
    if (prevEnd) { slack += dist(prevEnd, seg[0]); joins++; }
    prevEnd = seg[seg.length - 1];
    for (let k = coords.length ? 1 : 0; k < seg.length; k++) { coords.push(seg[k]); owner.push(f); }
  }
  return { coords, owner, slack, joins };
}

// Join components. For each non-primary component endpoint, find the nearest
// vertex of any feature belonging to a different component; if within JOIN_MI,
// SPLIT that feature there and add a bridge edge. Splitting is what makes a
// T-junction connectable at all, and its absence is what shipped a phantom
// 2.98mi gap on the NET.
function joinComponents(feats, spines, log) {
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
        added.push({ coords: tail, attrs: target.attrs, kind: target.kind, len: pathLen(tail) });
        split = true;
      }
      added.push({
        coords: [end.slice(), junction],
        attrs: target.attrs, kind: 'bridge', len: best.d,
      });
      if (log) console.log('    bridge ' + best.d.toFixed(3) + ' mi  '
        + end[1].toFixed(5) + ',' + end[0].toFixed(5) + ' -> '
        + junction[1].toFixed(5) + ',' + junction[0].toFixed(5)
        + (split ? '  (target part split at the junction)' : ''));
    }
  });
  return added;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Stage 1: sources ───────────────────────────────────────────────────────
  console.log('=== Stage 1: sources ===');
  fs.mkdirSync(CACHE, { recursive: true });

  if (!fs.existsSync(TRAIL_CACHE)) {
    console.log('  trail: fetching USFS ' + SERVICE + '/0 ...');
    const f = await fetchLayer(SERVICE, 0,
      'FID,Layer,RTE_NAME,SEGMENT,COMMENT,ROUTE_ID,MILES,PNT_Sectio,State');
    fs.writeFileSync(TRAIL_CACHE, JSON.stringify(f));
  }
  if (!fs.existsSync(STATES_CACHE)) {
    console.log('  states: fetching Census TIGERweb boundaries ...');
    const where = "STATE IN ('" + STATES.map(s => s.fips).join("','") + "')";
    fs.writeFileSync(STATES_CACHE, JSON.stringify(await get(
      'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County'
      + '/MapServer/0/query?where=' + encodeURIComponent(where)
      + '&outFields=NAME,STATE&outSR=4326&f=geojson')));
  }

  const raw       = JSON.parse(fs.readFileSync(TRAIL_CACHE, 'utf8'));
  const statesGeo = JSON.parse(fs.readFileSync(STATES_CACHE, 'utf8'));
  console.log('  ' + raw.length + ' source features');

  // ── Stage 2: assemble features, and pull out the ferry ─────────────────────
  console.log('\n=== Stage 2: assemble ===');
  const feats = [];
  let ferryMi = 0, ferryFeats = 0;
  for (const f of raw) {
    if (!f.geometry || !f.geometry.paths) continue;
    // The ferry comes from the attribute, never from a coordinate-jump
    // heuristic. That heuristic is exactly what left 0.926mi of open water
    // drawn and counted as trail in the files this replaces.
    const isFerry = (f.attributes.COMMENT || '').trim().toLowerCase() === 'ferry';
    for (const p of f.geometry.paths) {
      if (p.length < 2) continue;
      feats.push({ coords: p, attrs: f.attributes, kind: isFerry ? 'ferry' : 'tread', len: pathLen(p) });
      if (isFerry) { ferryMi += pathLen(p); ferryFeats++; }
    }
  }
  if (!ferryFeats) throw new Error('no ferry feature found (COMMENT = "Ferry")');
  const sourceMi = feats.reduce((s, f) => s + f.len, 0);
  console.log('  ' + feats.length + ' usable parts, ' + r2(sourceMi) + ' mi of source geometry');
  console.log('  ferry: ' + ferryFeats + ' part(s), ' + ferryMi.toFixed(3) + ' mi, '
    + 'carried in the line but given zero axis length');

  const byLayer = {};
  for (const f of feats) byLayer[f.attrs.Layer] = (byLayer[f.attrs.Layer] || 0) + f.len;
  console.log('  surface: ' + Object.entries(byLayer).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => k + ' ' + r2(v)).join(', '));

  // ── Stage 3: chain into one spine ──────────────────────────────────────────
  console.log('\n=== Stage 3: chain ===');

  // Assemble at a given tolerance: components, then bridge until one remains.
  // Mutates the feats array it is given, so the sweep works on copies.
  const assemble = (fs_, tol, log) => {
    let sp = componentSpines(fs_, buildGraph(fs_, tol));
    const startComponents = sp.length;
    for (let round = 0; round < 6; round++) {
      const added = joinComponents(fs_, sp, log);
      if (!added.length) break;
      fs_.push(...added);
      sp = componentSpines(fs_, buildGraph(fs_, tol));
      if (log) console.log('  round ' + (round + 1) + ': ' + sp.length
        + ' components; longest ' + r2(sp[0].len) + ' mi');
    }
    return { spines: sp, startComponents };
  };

  // Re-run the whole assembly across a sweep of tolerances and report what it
  // converges on, rather than asserting a chosen value in a comment.
  console.log('  NODE_TOL sweep (assembled spine after bridging, mi):');
  for (const tol of [0.005, 0.008, 0.010, 0.015, 0.025, 0.040]) {
    const probe = feats.map(f => ({ ...f, coords: f.coords.slice() }));
    const { spines: sp, startComponents } = assemble(probe, tol, false);
    console.log('    ' + tol.toFixed(3) + '  ' + r2(sp[0].len).toFixed(2).padStart(9)
      + '  (' + startComponents + ' components before bridging, '
      + sp.length + ' after)' + (tol === NODE_TOL ? '   <- chosen' : ''));
  }

  const { spines } = assemble(feats, NODE_TOL, true);
  const spine = spines[0];
  const onSpine = new Set(spine.path);
  const off = feats.filter((f, i) => f.kind !== 'bridge' && !onSpine.has(i));
  const offMi = off.reduce((s, f) => s + f.len, 0);
  const bridgeMi = spine.path.reduce((s, i) => feats[i].kind === 'bridge' ? s + feats[i].len : s, 0);

  console.log('  spine ' + r2(spine.len) + ' mi ('
    + r2(spine.len - bridgeMi) + ' mi source + ' + bridgeMi.toFixed(3) + ' mi bridge)');
  console.log('  off-spine ' + r2(offMi) + ' mi in ' + off.length + ' parts'
    + (off.length ? ':' : ''));
  off.sort((a, b) => b.len - a.len).forEach(f => {
    const c = f.coords[Math.floor(f.coords.length / 2)];
    console.log('    ' + f.len.toFixed(2).padStart(6) + 'mi  '
      + String(f.attrs.Layer || '--').padEnd(10)
      + String(f.attrs.RTE_NAME || '(unnamed)').trim().slice(0, 30).padEnd(32)
      + c[1].toFixed(4) + ',' + c[0].toFixed(4));
  });

  let walk = walkSpine(feats, spine);
  // Orient east to west: Chief Mountain first, Cape Alava last.
  if (dist(walk.coords[0], EAST_TERMINUS) > dist(walk.coords[walk.coords.length - 1], EAST_TERMINUS)) {
    walk = { ...walk, coords: walk.coords.slice().reverse(), owner: walk.owner.slice().reverse() };
  }
  const line = walk.coords, owner = walk.owner;
  console.log('  oriented ' + line[0][1].toFixed(4) + ',' + line[0][0].toFixed(4)
    + ' -> ' + line[line.length - 1][1].toFixed(4) + ',' + line[line.length - 1][0].toFixed(4));
  console.log('  node-merge slack ' + walk.slack.toFixed(2) + ' mi across ' + walk.joins
    + ' part joins (' + (walk.slack * 5280 / walk.joins).toFixed(1) + ' ft each on average)');

  // ── Stage 4: mile axis, with the ferry given zero length ───────────────────
  console.log('\n=== Stage 4: axis ===');
  // A step is ferry if either end belongs to a ferry part, so the axis is flat
  // across the whole crossing including its junction steps.
  const ferryAt = owner.map(o => o.kind === 'ferry');
  const cum = new Array(line.length).fill(0);
  let skipped = 0;
  for (let i = 1; i < line.length; i++) {
    const d = dist(line[i - 1], line[i]);
    const isFerryStep = ferryAt[i] || ferryAt[i - 1];
    if (isFerryStep) skipped += d;
    cum[i] = cum[i - 1] + (isFerryStep ? 0 : d);
  }
  const axisEnd = r2(cum[cum.length - 1]);
  console.log('  geometric length ' + r2(pathLen(line)) + ' mi over ' + line.length + ' vertices');
  console.log('  ferry excluded  ' + skipped.toFixed(3) + ' mi (zero axis length, no points)');
  console.log('  axis 0 - ' + axisEnd + ' mi');

  // ── Stage 5: interpolate points ────────────────────────────────────────────
  console.log('\n=== Stage 5: points ===');
  const pts = [];
  let vi = 1;
  for (let mile = 0; mile <= axisEnd + 1e-9; mile += SPACING) {
    while (vi < line.length - 1 && cum[vi] < mile) vi++;
    const lo = vi - 1, hi = vi;
    const span = cum[hi] - cum[lo];
    const t = span > 0 ? (mile - cum[lo]) / span : 0;
    const vertex = t < 0.5 ? lo : hi;
    pts.push({
      mile: r1(mile),
      lon: line[lo][0] + (line[hi][0] - line[lo][0]) * t,
      lat: line[lo][1] + (line[hi][1] - line[lo][1]) * t,
      vertex,
    });
  }
  // Always land the final point exactly on the terminus.
  const last = pts[pts.length - 1];
  if (Math.abs(last.mile - axisEnd) > 1e-6) {
    pts.push({
      mile: axisEnd,
      lon: line[line.length - 1][0], lat: line[line.length - 1][1],
      vertex: line.length - 1,
    });
  }
  // No point may land on the crossing itself.
  const onFerry = pts.filter(p => ferryAt[p.vertex]);
  if (onFerry.length) throw new Error(onFerry.length + ' point(s) placed on the ferry, e.g. mile ' + onFerry[0].mile);

  // ── Stage 6: state, region ─────────────────────────────────────────────────
  console.log('\n=== Stage 6: state and region ===');
  const statePolys = STATES.map(s => ({
    abbr: s.abbr,
    geometry: statesGeo.features.find(f => f.properties.STATE === s.fips).geometry,
  }));
  let unplaced = 0;
  const stateCounts = {};
  for (const p of pts) {
    const hit = statePolys.find(s => inFeature(p.lon, p.lat, s.geometry));
    p.st = hit ? hit.abbr : null;
    if (!p.st) unplaced++;
    else stateCounts[p.st] = (stateCounts[p.st] || 0) + 1;
  }
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].st) continue;
    // A point right on a border, or on a bridge, can fall outside every
    // polygon; inherit from the nearest neighbour rather than emit null.
    let back = i, fwd = i;
    while (back >= 0 && !pts[back].st) back--;
    while (fwd < pts.length && !pts[fwd].st) fwd++;
    pts[i].st = (back >= 0 ? pts[back].st : null) || (fwd < pts.length ? pts[fwd].st : null);
  }
  console.log('  state (polygon test): '
    + Object.entries(stateCounts).map(([k, v]) => k + ' ' + v).join(', ')
    + (unplaced ? '; ' + unplaced + ' filled from neighbours' : ''));
  for (const s of STATES) {
    const run = pts.filter(p => p.st === s.abbr);
    if (run.length) console.log('    ' + s.abbr + '  mile ' + run[0].mile + ' - ' + run[run.length - 1].mile);
  }

  // Region is a trail-order construct; state is a geographic fact. Regions come
  // from the source's own PNT_Sectio attribute, carried per vertex off the
  // spine walk so it is never guessed at.
  const regionOf = usfs => {
    const r = REGIONS.find(x => x.usfs === usfs);
    if (!r) throw new Error('unmapped PNT_Sectio value: ' + JSON.stringify(usfs));
    return r.id;
  };
  for (const p of pts) p.rawRegion = regionOf(owner[p.vertex].attrs.PNT_Sectio);

  const runs = [];
  for (const p of pts) {
    if (!runs.length || runs[runs.length - 1].rid !== p.rawRegion) runs.push({ rid: p.rawRegion, pts: [] });
    runs[runs.length - 1].pts.push(p);
  }
  for (let i = 0; i < runs.length; i++) {
    const span = runs[i].pts[runs[i].pts.length - 1].mile - runs[i].pts[0].mile;
    if (i > 0 && i < runs.length - 1 && span < REGION_MIN_MI) {
      const into = runs[i - 1].absorbInto || runs[i - 1].rid;
      console.log('  absorbing ' + runs[i].rid + ' excursion of ' + r1(span)
        + ' mi at mile ' + runs[i].pts[0].mile + ' into ' + into);
      runs[i].absorbInto = into;
    }
  }
  for (const run of runs) for (const p of run.pts) p.region = run.absorbInto || run.rid;

  // Guard: after absorption each region must appear exactly once, in trail order.
  const seq = [];
  for (const p of pts) if (seq[seq.length - 1] !== p.region) seq.push(p.region);
  const expected = REGIONS.map(r => r.id).filter(id => pts.some(p => p.region === id));
  if (seq.join(',') !== expected.join(',')) {
    throw new Error('regions are not contiguous in trail order: ' + seq.join(','));
  }

  // ── Stage 7: points.json ───────────────────────────────────────────────────
  console.log('\n=== Stage 7: points.json ===');
  const regionStart = {};
  for (const p of pts) if (!(p.region in regionStart)) regionStart[p.region] = p.mile;

  const points = pts.map(p => {
    const rt = ROUTE_TYPE[owner[p.vertex].attrs.Layer];
    const rec = {
      id: pointId(p.mile),
      lat: r6(p.lat), lon: r6(p.lon),
      mile: p.mile,
      region_id: p.region,
      region_name: REGIONS.find(r => r.id === p.region).name,
      // PNTA publishes 10 sections but no boundary coordinates, and they cannot
      // be placed on this axis honestly - see the header. Held open as null.
      section_id: null,
      section_name: null,
      sec_mile: r1(p.mile - regionStart[p.region]),
      route_id: 'main',
      state: p.st,
    };
    if (rt) rec.route_type = rt;
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
  const rtCount = {};
  for (const p of points) rtCount[p.route_type || 'trail'] = (rtCount[p.route_type || 'trail'] || 0) + 1;
  console.log('  ' + points.length + ' points at ' + SPACING + ' mi  ('
    + Object.entries(rtCount).map(([k, v]) => k + ' ' + v).join(', ') + ')');

  // ── Stage 8: trail.geojson ─────────────────────────────────────────────────
  console.log('\n=== Stage 8: trail.geojson ===');
  // One feature per contiguous run of the same region and the same surface,
  // emitted in axis order, so map.js concatenates them with no teleports and
  // dashes exactly the on-road stretches. The ferry is its own run.
  const vertexRegion = new Array(line.length).fill(null);
  {
    let pi = 0;
    for (let i = 0; i < line.length; i++) {
      while (pi < pts.length - 1 && pts[pi].vertex < i) pi++;
      vertexRegion[i] = pts[pi].region;
    }
  }
  const surfaceAt = i => ferryAt[i] ? 'ferry' : (ROUTE_TYPE[owner[i].attrs.Layer] || 'trail');

  const features = [];
  let runStart = 0;
  const flush = (end) => {
    const coords = thinCoords(line.slice(runStart, end + 1), THIN_M);
    if (coords.length < 2) return;
    const surf = surfaceAt(runStart);
    const rid = vertexRegion[runStart];
    const region = REGIONS.find(r => r.id === rid);
    const props = surf === 'ferry'
      // route_id "roadwalk" is the NON-hikeable sense of that tag: map.js draws
      // it dashed for continuity and drops it from the spine, so it carries no
      // mileage. segment_type "ferry" is kept because TrailTemps' PNT app.js
      // styles on exactly that value, and because it is not a road.
      ? {
        segment_type: 'ferry',
        route_id: 'roadwalk',
        name: 'Puget Sound Ferry (Keystone/Fort Casey to Port Townsend)',
        region_id: rid, region_name: region.name,
        section_id: null, section_name: null,
        state: 'WA',
      }
      : {
        segment_type: surf === 'roadwalk' ? 'roadwalk' : 'trail',
        route_id: 'main',
        region_id: rid, region_name: region.name,
        section_id: null, section_name: null,
      };
    // route_type "roadwalk" is the hikeable, counted sense (Ice Age, Florida):
    // dashed, but part of the spine. Never route_id "roadwalk" for those.
    if (surf === 'roadwalk' || surf === 'cross-country') props.route_type = surf;
    features.push({
      type: 'Feature', properties: props,
      geometry: { type: 'LineString', coordinates: coords.map(c => [r6(c[0]), r6(c[1])]) },
    });
  };
  for (let i = 1; i < line.length; i++) {
    if (surfaceAt(i) !== surfaceAt(runStart) || vertexRegion[i] !== vertexRegion[runStart]) {
      flush(i);
      runStart = i;
    }
  }
  flush(line.length - 1);

  fs.writeFileSync(path.join(DATA, 'trail.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features }));
  const bytes = fs.statSync(path.join(DATA, 'trail.geojson')).size;
  const fcount = k => features.filter(f => f.properties.segment_type === k).length;
  console.log('  ' + features.length + ' features (' + fcount('trail') + ' trail, '
    + fcount('roadwalk') + ' roadwalk, ' + fcount('ferry') + ' ferry), '
    + (bytes / 1048576).toFixed(1) + ' MB');

  // Ordering guard: features must run in axis order with no teleports.
  let worst = 0, worstAt = 0;
  for (let i = 1; i < features.length; i++) {
    const a = features[i - 1].geometry.coordinates;
    const b = features[i].geometry.coordinates;
    const d = dist(a[a.length - 1], b[0]);
    if (d > worst) { worst = d; worstAt = i; }
  }
  console.log('  largest feature-to-feature join: ' + worst.toFixed(3) + ' mi'
    + (worst > 0.01 ? ' (at feature ' + worstAt + ')' : ''));
  if (worst > JOIN_MI) throw new Error('geojson features are out of axis order (join ' + r2(worst) + ' mi)');

  // ── Stage 9: pnt_meta.json ─────────────────────────────────────────────────
  console.log('\n=== Stage 9: pnt_meta.json ===');
  const regionMeta = REGIONS.map(r => {
    const rp = points.filter(p => p.region_id === r.id);
    if (!rp.length) return null;
    const states = [...new Set(rp.map(p => p.state))];
    return {
      id: r.id, name: r.name, state: states.join('/'),
      usfs_name: r.usfs,
      mile_start: rp[0].mile,
      mile_end: rp[rp.length - 1].mile,
      miles: 0,
      sections: 0,
    };
  }).filter(Boolean);
  // Each region runs to the start of the next, so the axis tiles with no gaps.
  for (let i = 0; i < regionMeta.length - 1; i++) regionMeta[i].mile_end = regionMeta[i + 1].mile_start;
  regionMeta[regionMeta.length - 1].mile_end = axisEnd;
  regionMeta.forEach(r => { r.miles = r1(r.mile_end - r.mile_start); });

  const roadwalkMi = r2(points.filter(p => p.route_type === 'roadwalk').length * SPACING);
  const xcMi = r2(points.filter(p => p.route_type === 'cross-country').length * SPACING);

  const meta = {
    trail: {
      name: 'Pacific Northwest Trail',
      total_miles: axisEnd,
      point_spacing_miles: SPACING,
      map_center: [48.2, -119.5],
      map_zoom: 6,
      termini: {
        east: 'Chief Mountain, MT (Glacier NP)',
        west: 'Cape Alava, WA',
      },
      source: {
        geometry: SERVICE + '/FeatureServer/0',
        org: ORG,
        vintage: 'congressional route as of 2016-05-05, per the USFS item description',
        states: 'US Census TIGERweb State_County',
        axis: 'measured from the source geometry; neither USFS nor PNTA publishes a mile axis',
        validation: 'none available - PNTA publishes no open GIS and no mile-marker layer',
        fetched: '2026-09-13',
      },
      ferry: {
        name: 'Puget Sound Ferry',
        crossing: 'Keystone/Fort Casey to Port Townsend',
        miles: r2(ferryMi),
        counted: false,
        note: 'Saltwater crossing, the only one on any National Scenic Trail. Taken '
          + 'from the source attribute (COMMENT "Ferry"), not from a coordinate-jump '
          + 'heuristic - that heuristic left 0.93mi of open water drawn and counted '
          + 'as trail in the files this replaces. Drawn dashed for continuity and '
          + 'tagged route_id "roadwalk" (the non-hikeable sense) so it carries no '
          + 'mileage and no points.json entries. The mile axis is continuous across '
          + 'it: the two points either side are ' + SPACING + 'mi apart on the axis '
          + 'but separated by the whole crossing on the ground, which is the only '
          + 'consecutive-point gap on the trail over ' + SPACING + 'mi. '
          + r2(skipped) + 'mi is excluded in total - the ferry part plus the two '
          + 'steps joining it to land.',
      },
      notes: {
        sections: 'PNTA publishes 10 named sections with lengths but no boundary '
          + 'coordinates, and they cannot be placed on this axis: PNTA totals 1248mi '
          + 'against this axis, the source is the 2016 congressional route, and the '
          + 'land-manager attribute that would corroborate a placement is blank for '
          + '~400mi through the middle of Washington. section_id and section_name are '
          + 'held open as null; sec_mile is region-local.',
        pnta_sections: ['Rocky Mountain 151', 'Purcell Mountains 99', 'Selkirk Mountains 152',
          'Kettle River Range 128', 'Okanogan Highlands 99', 'Pasayten Wilderness 119',
          'North Cascades 196', 'Puget Sound 70', 'Olympic Mountains 170',
          'Wilderness Coast 64'],
        roadwalk: 'On-road tread is designated, hiked and counted toward mileage; '
          + 'tagged route_type "roadwalk" and drawn dashed. ' + roadwalkMi + ' mi.',
        cross_country: 'Designated route with no constructed tread, tagged route_type '
          + '"cross-country" and drawn as ordinary trail. ' + xcMi + ' mi.',
        regions: 'Boundaries from the source PNT_Sectio attribute, names from PNTA. '
          + 'USFS calls the second area "Northeast Washington"; the name previously '
          + 'shipped, "Columbia Mountains", came from neither.',
        off_spine_miles: r2(offMi),
        bridge_miles: r2(bridgeMi),
      },
    },
    regions: regionMeta,
    sections: [],
    alternates: [],
    direction_options: [
      { id: 'webo', label: 'Westbound - Chief Mountain, MT to Cape Alava, WA', total_miles: axisEnd, is_webo: true },
      { id: 'eabo', label: 'Eastbound - Cape Alava, WA to Chief Mountain, MT', total_miles: axisEnd, is_webo: false },
    ],
  };
  fs.writeFileSync(path.join(DATA, 'pnt_meta.json'), JSON.stringify(meta, null, 2));
  regionMeta.forEach(r => console.log('  ' + r.id.padEnd(20)
    + String(r.mile_start).padStart(8) + ' - ' + String(r.mile_end).padStart(8)
    + '  ' + String(r.miles).padStart(7) + ' mi  ' + r.state));
  console.log('  ' + regionMeta.length + ' regions, 0 sections, 0 alternates');

  // ── Stage 10: accounting ───────────────────────────────────────────────────
  console.log('\n=== Stage 10: the axis total, fully accounted for ===');
  const rows = [
    ['  ' + r2(sourceMi).toFixed(2).padStart(9), 'all source geometry, ' + raw.length + ' features'],
    [' -' + r2(offMi).toFixed(2).padStart(9), 'off-spine side material, ' + off.length + ' parts'],
    [' -' + skipped.toFixed(2).padStart(9), 'ferry crossing, drawn but not counted ('
      + ferryMi.toFixed(2) + ' mi of ferry part plus '
      + (skipped - ferryMi).toFixed(2) + ' mi for the two steps joining it to land)'],
    [' +' + bridgeMi.toFixed(2).padStart(9), 'bridge connectors'],
    [' +' + walk.slack.toFixed(2).padStart(9), 'node-merge slack, ' + walk.joins + ' part joins at '
      + (walk.slack * 5280 / walk.joins).toFixed(1) + ' ft each'],
  ];
  rows.forEach(([a, b]) => console.log(a + '   ' + b));
  const reconstructed = sourceMi - offMi - skipped + bridgeMi + walk.slack;
  console.log(' =' + r2(reconstructed).toFixed(2).padStart(9) + '   axis');
  console.log('  axis as measured: ' + axisEnd
    + '   (residual ' + (axisEnd - reconstructed).toFixed(3) + ' mi)');

  console.log('\nDone.');
}

main().catch(e => { console.error('\nFAILED: ' + e.message); process.exit(1); });
