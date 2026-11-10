// migrate-pht-to-canonical.js — Phase 2 of the canonical schema rollout.
//
// SUPERSEDED 2026-11-10: build-pht-data.js now does this itself (Stage 10)
// and writes canonical files directly. Kept as history only. Do NOT run it
// on the build's output: it expects the 17-field records and would fail.
//
// Transforms the Potomac Heritage files from the 17-field layout to the
// 7-field canonical schema, and verifies the result before writing anything.
//
//     node scripts/migrate-pht-to-canonical.js [--write]
//
// It transforms the shipped data rather than re-deriving it from the NPS GIS.
// That is deliberate: build-pht-data.js needs network access to a source that
// is actively republished (614 features in April 2026, 600 in October), so a
// rebuild would change geometry at the same time as the schema and make the
// diff unreadable. The build script's emitter is updated separately to produce
// this same shape on the next real rebuild.
//
// Four things change, and the verifier enumerates each one rather than
// accepting a blanket "close enough":
//
//  1. route_id is renumbered.   main stays; the alternate becomes alt-1; the
//     171 side routes become side-1..171 in their existing file order. Full
//     names move to the meta routes[] table. The id to name map is PINNED
//     there: route_id is a foreign key on every hike_segments row, so a later
//     rebuild must read these assignments and only append, never renumber.
//
//  2. The alternate's mile becomes route-local.   It was interpolated across
//     the spine span it substitutes for - 7.24mi of trail stretched over
//     spine miles 322.71 to 352.04 - which is why map.js carries dist_mile:
//     differencing that mile overstates a hike fourfold. Rescaling to the
//     route's own 7.24 reproduces all 145 stored sec_mile values exactly,
//     because the spine-axis spacing was a uniform 0.203mi interpolation.
//     app.js already writes dist_mile (the route-local figure) into
//     hike_segments, so this aligns the data with what was always stored.
//
//  3. route_type becomes universal.   10,792 points carried no value; they
//     become "trail". The three-value vocabulary is trail | roadwalk | water.
//     PHT's paddle route has no points.json entries at all - it is drawn and
//     uncounted - so "water" appears only in the GeoJSON.
//
//  4. Ten fields leave points.json.   id, sec_mile, region_id, region_name,
//     section_id, section_name, route_kind, alt_of, junction_mile and
//     junction_sec_mile are all rebuilt by lib/hydrate-points.js from the
//     meta tables. Nothing is lost; the verifier proves it.
//
// Consequence worth knowing: every off-spine point's id changes, because
// route_id is the id's middle token (pht-side-unnamed-mi... becomes
// pht-side-1-mi...). SectionsHiked does not use ids as keys, but TrailTemps
// joins historical_weather.json on them, so Phase 3 must re-key that file.

'use strict';

const fs = require('fs');
const path = require('path');
const { hydratePoints } = require('../public/js/hydrate-points');

const DATA = path.join(__dirname, '..', 'public', 'trails', 'potomac-heritage-trail', 'data');
const POINTS = path.join(DATA, 'points.json');
const META = path.join(DATA, 'pht_meta.json');

const SPINE = 'main';
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;

// Region bases for the spine's sec_mile, read from the meta file rather than
// hardcoded, so a region boundary change cannot silently desynchronise them.
function load() {
  return {
    points: JSON.parse(fs.readFileSync(POINTS, 'utf8')),
    meta: JSON.parse(fs.readFileSync(META, 'utf8')),
  };
}

function prettyName(routeId) {
  return routeId
    .replace(/^(side|alt)-/, '')
    .split('-')
    .map(w => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w.toUpperCase()))
    .join(' ');
}

function migrate(points, oldMeta) {
  // ---- 1. renumber routes, in file order so the mapping is reproducible ---
  const order = [];
  for (const p of points) {
    const rid = p.route_id ?? SPINE;
    if (!order.includes(rid)) order.push(rid);
  }

  const oldRouteRow = new Map((oldMeta.routes || []).map(r => [r.id, r]));
  const kindOf = new Map();
  for (const p of points) {
    const rid = p.route_id ?? SPINE;
    if (!kindOf.has(rid)) kindOf.set(rid, p.route_kind ?? 'spine');
  }

  const rename = new Map();
  let nAlt = 0, nSide = 0;
  for (const rid of order) {
    const kind = kindOf.get(rid);
    if (kind === 'spine') rename.set(rid, SPINE);
    else if (kind === 'alternate') rename.set(rid, 'alt-' + (++nAlt));
    else rename.set(rid, 'side-' + (++nSide));
  }

  // ---- 2. the alternate's route-local mile --------------------------------
  // Rescale the interpolated spine-axis mile onto the route's own length.
  const altNewMile = new Map();
  for (const [oldId, newId] of rename) {
    if (kindOf.get(oldId) !== 'alternate') continue;
    const pts = points.filter(p => (p.route_id ?? SPINE) === oldId);
    const row = oldRouteRow.get(oldId);
    const len = row && typeof row.miles === 'number' ? row.miles : null;
    if (len === null) throw new Error('no length in meta for alternate ' + oldId);
    const n = pts.length;
    pts.forEach((p, i) => altNewMile.set(p, n > 1 ? r3(len * i / (n - 1)) : 0));
  }

  // ---- 3. the slim points -------------------------------------------------
  const slim = points.map(p => {
    const oldId = p.route_id ?? SPINE;
    const out = {
      lat: p.lat,
      lon: p.lon,
      mile: altNewMile.has(p) ? altNewMile.get(p) : p.mile,
      route_id: rename.get(oldId),
      route_type: p.route_type ?? 'trail',
    };
    if (p.state !== undefined && p.state !== null) out.state = p.state;
    return out;
  });

  // ---- 4. the meta tables -------------------------------------------------
  const regions = (oldMeta.regions || []).map(r => ({
    ...r,
    route_id: SPINE,
  }));

  const routes = order.map(oldId => {
    const newId = rename.get(oldId);
    const kind = kindOf.get(oldId);
    const row = oldRouteRow.get(oldId) || {};
    const pts = points.filter(p => (p.route_id ?? SPINE) === oldId);
    // Full precision on the spine: trails.js computes progress against
    // 529.14, so rounding this to 1dp would quietly shift every percentage.
    const miles = kind === 'spine'
      ? r3(Math.max(...pts.map(p => p.mile)))
      : (typeof row.miles === 'number' ? row.miles : r1(Math.max(...pts.map(p => p.mile))));

    return {
      id: newId,
      // The pinned mapping. Both halves matter: `name` is what a person reads
      // and `legacy_route_id` is what proves this id still means the same
      // trail after a rebuild.
      name: row.name || (kind === 'spine' ? 'Main spine' : prettyName(oldId)),
      legacy_route_id: oldId,
      kind,
      alt_of: kind === 'spine' ? null : (pts[0].alt_of ?? (kind === 'alternate' ? SPINE : null)),
      region_id: row.region_id ?? null,
      miles,
      junction_mile: pts[0].junction_mile ?? null,
      junction_sec_mile: pts[0].junction_sec_mile ?? null,
      hikeable: true,
      // The spine measures sec_mile from the region start; every off-spine
      // route's own mile already starts at zero.
      sec_mile_from: kind === 'spine' ? 'region' : 'route',
      region_from: kind === 'spine' ? 'ranges' : 'route',
    };
  });

  const meta = {
    trail: { ...oldMeta.trail, schema: 'canonical-7' },
    regions,
    sections: oldMeta.sections || [],
    routes,
    hydrate: {
      id: { prefix: 'pht', token_by: 'route', from: 'mile', scale: 1000, width: 7 },
      sec_mile_from: 'region',
      sec_mile_decimals: 1,
      region_from: 'ranges',
      emit: {
        route_kind: true,
        alt_of: true,
        junction_mile: true,
        junction_sec_mile: true,
      },
    },
    notes: {
      ...(oldMeta.notes || {}),
      schema: 'points.json carries lat, lon, mile, route_id, route_type and '
        + 'state. id, sec_mile, region_id, region_name, section_id, '
        + 'section_name, route_kind, alt_of, junction_mile and '
        + 'junction_sec_mile are rebuilt at load by lib/hydrate-points.js.',
      route_ids: 'Numeric ids are PINNED. legacy_route_id on each row records '
        + 'the descriptive id they replaced. route_id is a foreign key on '
        + 'hike_segments, so a rebuild must reuse these assignments and only '
        + 'append new ones.',
      alternate_mile: 'alt-1 (the DC River Trail) carries its own route-local '
        + 'mile. It previously held a mile interpolated across spine miles '
        + '322.71-352.04, which is why map.js needed dist_mile to avoid '
        + 'overstating a hike fourfold.',
    },
  };

  return { slim, meta, rename, altNewMile };
}

// --------------------------------------------------------------- the verifier

// Everything the apps read must come back identical, EXCEPT the four changes
// this migration makes on purpose. Each exception is counted and checked
// against what was expected; an unexplained difference fails the run.
function verify(original, slim, meta, rename) {
  const back = hydratePoints(slim, meta);
  const expected = {
    route_id: 0,     // every point: renumbered
    id: 0,           // off-spine only: route_id is the id token
    mile: 0,         // the alternate only: rescaled
    route_type: 0,   // previously absent: now "trail"
  };
  const unexplained = [];

  for (let i = 0; i < original.length; i++) {
    const a = original[i], b = back[i];
    const oldRoute = a.route_id ?? SPINE;
    const newRoute = rename.get(oldRoute);
    const isOffSpine = newRoute !== SPINE;
    const isAlt = (a.route_kind ?? 'spine') === 'alternate';

    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const av = a[k] === undefined ? null : a[k];
      const bv = b[k] === undefined ? null : b[k];
      if (JSON.stringify(av) === JSON.stringify(bv)) continue;

      if (k === 'route_id' && bv === newRoute) { expected.route_id++; continue; }
      if (k === 'id' && isOffSpine) { expected.id++; continue; }
      if (k === 'mile' && isAlt) { expected.mile++; continue; }
      if (k === 'route_type' && av === null && bv === 'trail') { expected.route_type++; continue; }

      if (unexplained.length < 10) {
        unexplained.push({ i, id: a.id, field: k, was: av, now: bv });
      }
    }
  }

  // Count unexplained by field across the whole file, not just the sample.
  const unexplainedByField = {};
  for (let i = 0; i < original.length; i++) {
    const a = original[i], b = back[i];
    const oldRoute = a.route_id ?? SPINE;
    const newRoute = rename.get(oldRoute);
    const isOffSpine = newRoute !== SPINE;
    const isAlt = (a.route_kind ?? 'spine') === 'alternate';
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const av = a[k] === undefined ? null : a[k];
      const bv = b[k] === undefined ? null : b[k];
      if (JSON.stringify(av) === JSON.stringify(bv)) continue;
      if (k === 'route_id' && bv === newRoute) continue;
      if (k === 'id' && isOffSpine) continue;
      if (k === 'mile' && isAlt) continue;
      if (k === 'route_type' && av === null && bv === 'trail') continue;
      unexplainedByField[k] = (unexplainedByField[k] || 0) + 1;
    }
  }

  return { ok: Object.keys(unexplainedByField).length === 0, expected, unexplained, unexplainedByField };
}

// Independent checks that do not depend on the round trip at all.
function invariants(original, slim, meta) {
  const out = [];
  const spineOld = original.filter(p => (p.route_id ?? SPINE) === SPINE);
  const spineNew = slim.filter(p => p.route_id === SPINE);

  const oldMax = Math.max(...spineOld.map(p => p.mile));
  const newMax = Math.max(...spineNew.map(p => p.mile));
  out.push(['spine axis length', oldMax.toFixed(3), newMax.toFixed(3), Math.abs(oldMax - newMax) < 1e-9]);
  const spineRow = meta.routes.find(r => r.kind === 'spine');
  // The axis max is 529.145; the 529.14 in CLAUDE.md and trails.js is the
  // build's own accounting total (528.98 tread + 0.11 connectors + 0.06
  // node-merge slack). They are two measures of the same trail, so this
  // checks they agree to a hundredth rather than pretending one is the other.
  out.push(['spine miles in meta', '~529.14', String(spineRow.miles),
    Math.abs(spineRow.miles - 529.14) < 0.01]);

  const altRow = meta.routes.find(r => r.kind === 'alternate');
  const altPts = slim.filter(p => p.route_id === altRow.id);
  const altMax = Math.max(...altPts.map(p => p.mile));
  out.push(['alternate length', String(altRow.miles), altMax.toFixed(2), Math.abs(altMax - altRow.miles) < 0.005]);

  const sideMiles = meta.routes.filter(r => r.kind === 'side')
    .reduce((s, r) => s + r.miles, 0);
  out.push(['side route total', '299.81', sideMiles.toFixed(2), Math.abs(sideMiles - 299.81) < 0.5]);

  const kinds = {};
  for (const r of meta.routes) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  out.push(['routes by kind', 'spine 1 / alt 1 / side 171',
    'spine ' + kinds.spine + ' / alt ' + kinds.alternate + ' / side ' + kinds.side,
    kinds.spine === 1 && kinds.alternate === 1 && kinds.side === 171]);

  const ids = new Set(meta.routes.map(r => r.id));
  out.push(['route ids unique', String(meta.routes.length), String(ids.size), ids.size === meta.routes.length]);

  const legacy = new Set(meta.routes.map(r => r.legacy_route_id));
  out.push(['legacy ids pinned', String(meta.routes.length), String(legacy.size),
    legacy.size === meta.routes.length]);

  const types = new Set(slim.map(p => p.route_type));
  const allowed = ['trail', 'roadwalk', 'water'];
  out.push(['route_type vocabulary', allowed.join(' | '), [...types].sort().join(' | '),
    [...types].every(t => allowed.includes(t))]);

  const fields = new Set();
  for (const p of slim) for (const k of Object.keys(p)) fields.add(k);
  const want = ['lat', 'lon', 'mile', 'route_id', 'route_type', 'state'];
  out.push(['points.json fields', want.join(', '), [...fields].sort().join(', '),
    [...fields].every(f => want.includes(f))]);

  return out;
}

// ---------------------------------------------------------------------- main

const write = process.argv.includes('--write');
const { points, meta: oldMeta } = load();

console.log('Phase 2 — Potomac Heritage to the canonical 7-field schema');
console.log('');
console.log('read  ' + points.length + ' points, ' + (oldMeta.routes || []).length + ' routes in meta');

const { slim, meta, rename } = migrate(points, oldMeta);

console.log('');
console.log('--- route renumbering (first 6 of ' + rename.size + ') ---');
let shown = 0;
for (const [oldId, newId] of rename) {
  if (shown++ >= 6) break;
  console.log('  ' + newId.padEnd(10) + ' <- ' + oldId);
}

console.log('');
console.log('--- invariants ---');
let invOk = true;
for (const [name, want, got, pass] of invariants(points, slim, meta)) {
  if (!pass) invOk = false;
  console.log('  ' + (pass ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(22)
    + ' expected ' + String(want).padEnd(28) + ' got ' + got);
}

console.log('');
console.log('--- round trip ---');
const v = verify(points, slim, meta, rename);
console.log('  intended differences:');
console.log('    route_id   ' + String(v.expected.route_id).padStart(6) + '  (every point, renumbered)');
console.log('    id         ' + String(v.expected.id).padStart(6) + '  (off-spine, route_id is the id token)');
console.log('    mile       ' + String(v.expected.mile).padStart(6) + '  (the alternate, rescaled route-local)');
console.log('    route_type ' + String(v.expected.route_type).padStart(6) + '  (was absent, now "trail")');

if (!v.ok) {
  console.log('');
  console.log('  UNEXPLAINED DIFFERENCES — nothing written');
  console.log('  ' + JSON.stringify(v.unexplainedByField));
  for (const d of v.unexplained.slice(0, 8)) {
    console.log('    [' + d.i + '] ' + d.id + '  ' + d.field
      + ': was ' + JSON.stringify(d.was) + '  now ' + JSON.stringify(d.now));
  }
  process.exit(1);
}
console.log('  every other field on all ' + points.length + ' points is identical');

if (!invOk) {
  console.log('');
  console.log('INVARIANT FAILED — nothing written');
  process.exit(1);
}

const before = JSON.stringify(points).length;
const after = JSON.stringify(slim).length;
const metaBytes = JSON.stringify(meta, null, 2).length;
console.log('');
console.log('--- size ---');
console.log('  points.json  ' + (before / 1048576).toFixed(2) + 'MB -> '
  + (after / 1048576).toFixed(2) + 'MB');
console.log('  pht_meta     ' + (JSON.stringify(oldMeta, null, 2).length / 1024).toFixed(0)
  + 'KB -> ' + (metaBytes / 1024).toFixed(0) + 'KB');
console.log('  together     ' + ((1 - (after + metaBytes) / before) * 100).toFixed(0) + '% smaller');

if (write) {
  fs.writeFileSync(POINTS, JSON.stringify(slim));
  fs.writeFileSync(META, JSON.stringify(meta, null, 2) + '\n');
  console.log('');
  console.log('WROTE points.json (minified) and pht_meta.json (pretty)');
} else {
  console.log('');
  console.log('(dry run — pass --write to replace the files)');
}
