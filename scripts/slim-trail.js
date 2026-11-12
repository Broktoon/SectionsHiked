#!/usr/bin/env node
// slim-trail.js: convert one trail's shipped files to the 7-field canonical
// points.json (Phase 4 of the canonical schema rollout).
//
// Usage:
//   node scripts/slim-trail.js <trail data dir> [--write]
//
// Works on either repo's copy (public/trails/<trail>/data here,
// trails/<trail>/data in TrailTemps), because each repo owns its own meta
// file and the two are allowed to differ.
//
// It changes layout only, never geometry, and it never removes anything an
// app already reads from the meta file:
//
//   points.json  every point reduced to lat, lon, mile, route_id and whichever
//                of trail_elev, route_type, state it already carries
//   *_meta.json  the existing file, with these ADDED:
//                  - id, name and route_id on each region and section row
//                    (alongside whatever keys the row already uses)
//                  - routes[], if absent
//                  - the hydrate block, which tells the apps to rebuild the
//                    full records at load
//                  - notes.schema
//
// The tables and the hydrate settings come from build-meta-from-points.js,
// which derives them from the points themselves. Route ids are NOT renamed
// (PCT's spine stays "main-spine", as AT's did): route_id is stored on saved
// hikes, so renaming it would need a database migration.
//
// Before writing, the merged meta must rebuild every point exactly through
// the shared loader. Afterwards run verify-schema-roundtrip.js, which checks
// the files on disk independently against the committed originals.

'use strict';

const fs = require('fs');
const path = require('path');
const { slimPoint } = require('../public/js/hydrate-points');
const { buildMeta, roundTrip, fitOffSpineRoutes } = require('./build-meta-from-points');

const CANON = new Set(['lat', 'lon', 'mile', 'route_id', 'trail_elev', 'route_type', 'state']);

const args = process.argv.slice(2);
const write = args.includes('--write');
const dir = args.find(a => !a.startsWith('--'));
if (!dir) {
  console.error('usage: node scripts/slim-trail.js <trail data dir> [--write]');
  process.exit(2);
}

const pointsPath = path.join(dir, 'points.json');
const metaName = fs.readdirSync(dir).find(f => /_meta\.json$/.test(f) && !/backup/.test(f));
if (!metaName) { console.error('no *_meta.json in ' + dir); process.exit(2); }
const metaPath = path.join(dir, metaName);

const points = JSON.parse(fs.readFileSync(pointsPath, 'utf8'));
const existing = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const trailDir = path.basename(path.dirname(path.resolve(dir)));

console.log('trail  ' + trailDir + '  (' + points.length + ' points, ' + metaName + ')');

if (existing.hydrate) {
  console.log('already has a hydrate block; nothing to do');
  process.exit(0);
}

const derived = buildMeta(trailDir, points);
const fail = [];

// The one section each off-spine route sits in (NET's Middletown spur is
// "ct-middletown"). The table builder derives rows for the spine only, so an
// existing row for one of these is kept and tagged with its route instead of
// being reported as orphaned.
const spineIds = new Set(['main', 'main-spine']);
const offSpineSection = new Map();
for (const p of points) {
  const rid = p.route_id ?? 'main';
  if (spineIds.has(rid) || p.section_id == null) continue;
  offSpineSection.set(p.section_id, rid);
}

// Match each derived row to the existing row for the same id, whatever key
// the existing file uses for it, and add only the canonical keys it lacks.
function mergeRows(kind, existingRows, derivedRows, idKeys, nameKeys) {
  const idOf = r => idKeys.map(k => r[k]).find(v => v != null);
  const byId = new Map((existingRows || []).map(r => [idOf(r), r]));
  const derivedIds = new Set(derivedRows.map(r => r.id));
  for (const r of existingRows || []) {
    if (derivedIds.has(idOf(r))) continue;
    if (kind === 'section' && offSpineSection.has(idOf(r))) continue;
    fail.push(kind + ' "' + idOf(r) + '" is in the meta file but no point carries it');
  }
  const merged = new Map();
  for (const d of derivedRows) {
    const e = byId.get(d.id);
    if (!e) { fail.push(kind + ' "' + d.id + '" is on the points but missing from the meta file'); continue; }
    const name = nameKeys.map(k => e[k]).find(v => v != null) ?? d.name;
    const row = { id: d.id, name, ...e, route_id: d.route_id };
    if (row.mile_start === undefined) row.mile_start = d.mile_start;
    if (row.mile_end === undefined) row.mile_end = d.mile_end;
    if (kind === 'section' && row.region_id === undefined && d.region_id != null) row.region_id = d.region_id;
    merged.set(d.id, row);
  }
  // Keep the existing file's order. An off-spine route's own row keeps every
  // key it has and gains the route it belongs to.
  return (existingRows || []).map(r => {
    if (merged.has(idOf(r))) return merged.get(idOf(r));
    if (kind === 'section' && offSpineSection.has(idOf(r))) {
      return { id: idOf(r), ...r, route_id: offSpineSection.get(idOf(r)) };
    }
    return null;
  }).filter(Boolean);
}

const meta = JSON.parse(JSON.stringify(existing));
// NET's meta has no region table at all; the points name two (ct, ma). The
// derived table is added as a new key rather than reported as missing rows.
// Neither app reads meta.regions on NET.
if (!existing.regions && derived.regions.length) {
  existing.regions = derived.regions.map(r => ({ ...r }));
  console.log('no regions table in the meta file; adding the ' + derived.regions.length + ' derived from the points');
}
meta.regions = mergeRows('region', existing.regions, derived.regions, ['id', 'region_id'], ['name', 'region_name']);
meta.sections = mergeRows('section', existing.sections, derived.sections, ['id', 'section_id'], ['name', 'section_name']);
if (!meta.routes) meta.routes = derived.routes;
meta.hydrate = derived.hydrate;
if (!fail.length && meta.routes.some(r => r.kind !== 'spine')) {
  for (const f of fitOffSpineRoutes(points, meta)) fail.push(f);
  for (const r of meta.routes.filter(r => r.kind !== 'spine')) {
    console.log('route  ' + r.id + ': region ' + r.region_id + ', section ' + (r.section_id ?? '(table row)')
      + ', sec_mile from route' + (r.sec_mile_scale ? ' / ' + r.sec_mile_scale.toFixed(6) : '')
      + (r.id_from ? ', id from ' + r.id_from : ''));
  }
}
meta.notes = {
  ...(existing.notes || {}),
  schema: 'points.json carries only lat, lon, mile, route_id and, where present, '
    + 'trail_elev, route_type and state. id, sec_mile, region_id, region_name, '
    + 'section_id and section_name are rebuilt at load by hydrate-points.js from '
    + 'the tables in this file. Converted by scripts/slim-trail.js.',
};

console.log('tables regions ' + meta.regions.length + ', sections ' + meta.sections.length
  + ', routes ' + meta.routes.length);
const h = meta.hydrate;
console.log('hydrate id ' + h.id.prefix + '-<' + h.id.token_by + '>-mi<' + h.id.from + ' x' + h.id.scale
  + ' w' + h.id.width + '>' + (h.id.tokens ? ' tokens ' + JSON.stringify(h.id.tokens) : '')
  + '; sec_mile from ' + h.sec_mile_from + ' (' + h.sec_mile_decimals + 'dp); region from ' + h.region_from);

const slim = points.map(slimPoint);
const extra = [...new Set(slim.flatMap(p => Object.keys(p)))].filter(k => !CANON.has(k));
if (extra.length) {
  fail.push('slim points would still carry ' + extra.join(', ')
    + ' (per-point data with no home in meta; decide where it goes, or drop it, first)');
}

if (!fail.length) {
  let rt = roundTrip(points, meta);
  // The existing rows may share boundary miles (NCT: Vermont 0-71, New York
  // 71-775.5) with the point at 71 belonging to New York. The rows are kept
  // as the apps read them; the loader is told the convention instead.
  if (!rt.ok) {
    const alt = { ...meta, hydrate: { ...meta.hydrate, boundary: 'next' } };
    const rt2 = roundTrip(points, alt);
    if (rt2.ok) {
      meta.hydrate = alt.hydrate;
      rt = rt2;
      console.log('rows share boundary miles; hydrate.boundary = "next"');
    }
  }
  if (!rt.ok) {
    fail.push('round trip differs: ' + JSON.stringify(rt.fieldCounts));
    for (const d of rt.diffs.slice(0, 6)) {
      console.log('   [' + d.i + '] ' + d.id + ' ' + d.field + ': was ' + JSON.stringify(d.was) + ', now ' + JSON.stringify(d.now));
    }
  } else {
    console.log('round trip exact: all ' + rt.n + ' points, every field');
  }
}

if (fail.length) {
  console.log('\nREFUSED, nothing written:');
  for (const f of fail) console.log('  - ' + f);
  process.exit(1);
}

const before = fs.statSync(pointsPath).size;
const after = JSON.stringify(slim).length;
console.log('points.json ' + (before / 1048576).toFixed(2) + 'MB -> ' + (after / 1048576).toFixed(2) + 'MB');

if (write) {
  fs.writeFileSync(pointsPath, JSON.stringify(slim));
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  console.log('WROTE points.json (minified) and ' + metaName + ' (pretty)');
  console.log('next: node scripts/verify-schema-roundtrip.js ' + dir);
} else {
  console.log('(dry run; pass --write to replace the files)');
}
