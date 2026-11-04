// build-meta-from-points.js — Phase 1 of the canonical schema rollout.
//
// Four trails carry no *_meta.json at all: AT, AZT, Florida and Natchez. The
// 7-field schema requires one, because that is where the region and section
// range tables, the routes table and the id format live once instead of on
// every point.
//
// This script does not touch geometry. It reads a trail's existing
// points.json, works out the tables and the id format that reproduce it, and
// writes the meta file. Then it rehydrates the slim points through
// lib/hydrate-points.js and asserts the result is identical to what it read.
// If the assertion fails, nothing is written.
//
// Usage:
//     node scripts/build-meta-from-points.js <trail-dir> [--write]
//     node scripts/build-meta-from-points.js --all
//
// Without --write it reports and writes nothing (the default, so a dry run is
// the easy thing to do).
//
// What it refuses, and why that is the right answer:
//
//   AZT      44 route ids (p19, p28, p34 ...) and none of them marks a
//            through-route. route_id has no meaning until a spine is chosen,
//            so a routes table built now would encode a guess.
//   Florida  no `mile` field at all — it carries axis_mile. There is no axis
//            to hang a range table on until the trail is rebuilt.
//
// Both are Phase 5 work. This script exits non-zero naming the reason rather
// than emitting something plausible.

'use strict';

const fs = require('fs');
const path = require('path');
const { hydratePoints, slimPoint, SPINE_ROUTE } = require('../public/js/hydrate-points');

const TRAILS_DIR = path.join(__dirname, '..', 'public', 'trails');
const PHASE_1 = ['appalachian-trail', 'arizona-trail', 'florida-trail', 'natchez-trace-trail'];

const META_NAME = {
  'appalachian-trail': 'at_meta.json',
  'arizona-trail': 'azt_meta.json',
  'florida-trail': 'ft_meta.json',
  'natchez-trace-trail': 'ntt_meta.json',
};

const TRAIL_NAME = {
  'appalachian-trail': 'Appalachian National Scenic Trail',
  'arizona-trail': 'Arizona National Scenic Trail',
  'florida-trail': 'Florida National Scenic Trail',
  'natchez-trace-trail': 'Natchez Trace National Scenic Trail',
};

const r1 = v => Math.round(v * 10) / 10;
const r3 = v => Math.round(v * 1000) / 1000;

// ------------------------------------------------------------------ refusals

function blockers(points) {
  const out = [];
  if (!points.some(p => typeof p.mile === 'number')) {
    out.push('no `mile` field — the trail carries a legacy axis (axis_mile). '
      + 'A range table needs a mile axis; rebuild first (Phase 5).');
  }
  const routes = new Set(points.map(p => p.route_id ?? null));
  if (routes.has(null) && routes.size === 1) {
    out.push('no `route_id` on any point — nothing to build a routes table from (Phase 5).');
  } else if (routes.size > 1 && !routes.has('main') && !routes.has('main-spine')) {
    out.push('no spine route among ' + routes.size + ' route ids ('
      + [...routes].slice(0, 4).join(', ') + ' ...) — a through-route must be '
      + 'identified before route_id means anything (Phase 5).');
  }
  return out;
}

// ------------------------------------------------- contiguous run extraction

// Walk the axis in mile order and cut a new run wherever the key changes.
// A key that reappears later gets a second run; the caller decides whether
// that is acceptable for the table it is building.
function runsAlongAxis(points, keyFn) {
  const sorted = [...points].sort((a, b) => a.mile - b.mile);
  const runs = [];
  let cur = null;
  for (const p of sorted) {
    const k = keyFn(p);
    if (!cur || cur.key !== k) {
      cur = { key: k, mile_start: p.mile, mile_end: p.mile, n: 1 };
      runs.push(cur);
    } else {
      cur.mile_end = p.mile;
      cur.n++;
    }
  }
  return runs;
}

// ------------------------------------------------------- id format inference

function inferIdFormat(points, trailDir) {
  const withId = points.filter(p => typeof p.id === 'string');
  if (!withId.length) return null;

  const prefix = withId[0].id.split('-')[0];
  const tailOf = p => {
    const m = /mi(\d+)$/.exec(p.id);
    return m ? m[1] : null;
  };
  if (withId.some(p => tailOf(p) === null)) {
    throw new Error('not every id ends in mi<digits>; cannot infer a format');
  }
  const width = tailOf(withId[0]).length;
  if (withId.some(p => tailOf(p).length !== width)) {
    throw new Error('id numeric tails vary in width');
  }

  // Which number, at which scale, reproduces the tail on every point?
  let from = null, scale = null;
  for (const cand of ['mile', 'sec_mile']) {
    for (const s of [10, 100, 1000]) {
      const ok = withId.every(p => {
        const v = p[cand];
        if (typeof v !== 'number') return false;
        return String(Math.round(v * s)).padStart(width, '0') === tailOf(p);
      });
      if (ok) { from = cand; scale = s; break; }
    }
    if (from) break;
  }
  if (!from) throw new Error('no (field, scale) pair reproduces the id tails');

  // The middle token: route_id for most trails, section_id for Natchez.
  const middleOf = p => p.id.slice(prefix.length + 1, p.id.length - ('-mi' + tailOf(p)).length);
  let token_by = null;
  for (const cand of ['route', 'section']) {
    const keyFn = cand === 'section' ? (p => p.section_id) : (p => p.route_id ?? SPINE_ROUTE);
    const map = new Map();
    let consistent = true;
    for (const p of withId) {
      const k = keyFn(p);
      const tok = middleOf(p);
      if (map.has(k) && map.get(k) !== tok) { consistent = false; break; }
      map.set(k, tok);
    }
    if (consistent) { token_by = cand; break; }
  }
  if (!token_by) throw new Error('neither route_id nor section_id maps 1:1 onto the id middle token');

  const keyFn = token_by === 'section' ? (p => p.section_id) : (p => p.route_id ?? SPINE_ROUTE);
  const tokens = {};
  for (const p of withId) tokens[keyFn(p)] = middleOf(p);

  // Only record tokens that differ from the key itself — AT's route_id is
  // "main-spine" while its ids say "main", and that override has to survive
  // the rename to `main`.
  const overrides = {};
  for (const [k, v] of Object.entries(tokens)) if (k !== v) overrides[k] = v;

  return {
    prefix,
    token_by,
    from,
    scale,
    width,
    ...(Object.keys(overrides).length ? { tokens: overrides } : {}),
  };
}

// --------------------------------------------------------------- the builder

function buildMeta(trailDir, points) {
  const spineIds = new Set([SPINE_ROUTE, 'main-spine']);
  const isSpine = p => spineIds.has(p.route_id ?? SPINE_ROUTE);
  const spine = points.filter(p => isSpine(p) && typeof p.mile === 'number');

  // --- sections -----------------------------------------------------------
  const secRuns = runsAlongAxis(spine, p => p.section_id);
  const secKeys = new Set(secRuns.map(r => r.key));
  if (secRuns.length !== secKeys.size) {
    throw new Error('sections do not tile the axis: ' + secRuns.length
      + ' runs for ' + secKeys.size + ' sections');
  }
  // Every table row names the route it belongs to. The spine's route_id is
  // still `main-spine` on five trails, so defaulting it at read time would
  // mis-key exactly those.
  const spineRouteId = spine.length ? (spine[0].route_id ?? SPINE_ROUTE) : SPINE_ROUTE;

  const sections = secRuns
    .filter(r => r.key !== null && r.key !== undefined)
    .map(r => {
      const sample = spine.find(p => p.section_id === r.key);
      return {
        id: r.key,
        name: sample.section_name ?? null,
        region_id: sample.region_id ?? null,
        route_id: spineRouteId,
        mile_start: r1(r.mile_start),
        mile_end: r1(r.mile_end),
        miles: r1(r.mile_end - r.mile_start),
      };
    });

  // --- regions ------------------------------------------------------------
  // Three ways a region can be recovered, cheapest first. `state` is tried
  // before ranges because on the AT the two are the same value and the
  // regions interleave: 72 runs for 13 regions, so a range table would be
  // both longer and less honest than reading the field already on the point.
  const regionIds = [...new Set(spine.map(p => p.region_id))].filter(x => x != null);
  const regionMeta = regionIds.map(id => {
    const pts = spine.filter(p => p.region_id === id);
    const sample = pts[0];
    const mi = pts.map(p => p.mile);
    return {
      id,
      name: sample.region_name ?? null,
      ...(sample.state !== undefined ? { state: sample.state } : {}),
      route_id: spineRouteId,
      mile_start: r1(Math.min(...mi)),
      mile_end: r1(Math.max(...mi)),
      miles: r1(Math.max(...mi) - Math.min(...mi)),
      sections: sections.filter(s => s.region_id === id).length,
    };
  }).sort((a, b) => a.mile_start - b.mile_start);

  // Pick the cheapest recovery that is actually *correct*, verifying each
  // rather than assuming it. Each candidate is checked against every point.
  //
  //   state     the region IS the state field already on the point (AT)
  //   section   the region can be read off the containing section
  //   ranges    the region needs its own range table
  //
  // `section` has to be verified, not just offered: a section is only a valid
  // proxy if it nests entirely inside one region. PCTA's letter sections do
  // not — Section R runs about 27mi past the California line into Oregon — so
  // reading region from section there is wrong for 278 points. Choosing it
  // without this check produced exactly that, and the round trip caught it.
  let region_from;
  if (spine.every(p => p.region_id === p.state)) {
    region_from = 'state';
  } else {
    const sectionRegion = new Map(sections.map(s => [s.id, s.region_id]));
    const nests = sections.length
      && sections.every(s => s.region_id != null)
      && spine.every(p => sectionRegion.get(p.section_id) === p.region_id);
    if (nests) {
      region_from = 'section';
    } else {
      const regRuns = runsAlongAxis(spine, p => p.region_id);
      if (regRuns.length !== new Set(regRuns.map(r => r.key)).size) {
        throw new Error('regions match neither `state` nor their sections, and do not '
          + 'tile the axis (' + regRuns.length + ' runs for '
          + new Set(regRuns.map(r => r.key)).size + ' regions)');
      }
      region_from = 'ranges';
    }
  }

  // --- sec_mile basis -----------------------------------------------------
  const secMileFrom = (() => {
    for (const basis of ['section', 'region']) {
      const table = basis === 'section' ? sections : regionMeta;
      const byId = new Map(table.map(t => [t.id, t]));
      const keyOf = p => (basis === 'section' ? p.section_id : p.region_id);
      const ok = spine.every(p => {
        const t = byId.get(keyOf(p));
        if (!t) return false;
        return Math.abs(r1(p.mile - t.mile_start) - p.sec_mile) < 0.051;
      });
      if (ok) return basis;
    }
    throw new Error('sec_mile is neither section-local nor region-local');
  })();

  // --- routes -------------------------------------------------------------
  const routeIds = [...new Set(points.map(p => p.route_id ?? SPINE_ROUTE))];
  const routes = routeIds.map(id => {
    const pts = points.filter(p => (p.route_id ?? SPINE_ROUTE) === id);
    const sample = pts[0];
    const mi = pts.map(p => p.mile).filter(v => typeof v === 'number');
    const kind = spineIds.has(id) ? 'spine' : (sample.alt_of ? 'alternate' : 'side');
    return {
      id,
      name: null,
      kind,
      alt_of: sample.alt_of ?? null,
      junction_mile: sample.junction_mile ?? null,
      junction_sec_mile: sample.junction_sec_mile ?? null,
      hikeable: true,
      miles: mi.length ? r1(Math.max(...mi) - Math.min(...mi)) : 0,
    };
  });

  // --- id format ----------------------------------------------------------
  const idFormat = inferIdFormat(points, trailDir);

  // Scan every point, never a sample. PCT stores sec_mile at 1 decimal
  // throughout except its very last point, which carries the exact terminus
  // figure at 2 (61.16). Sampling the first 5000 missed it and rounded that
  // one point to 61.2. Rounding to the wider precision is harmless: a value
  // that needs only 1 decimal is unchanged by rounding to 2.
  const secDecimals = spine.reduce((max, p) => {
    const s = String(p.sec_mile);
    const i = s.indexOf('.');
    const dp = i < 0 ? 0 : s.length - i - 1;
    return dp > max ? dp : max;
  }, 0);

  const spacing = (() => {
    const mi = spine.map(p => p.mile).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < mi.length; i++) {
      const g = r3(mi[i] - mi[i - 1]);
      if (g > 0) gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    return gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  })();

  const total = spine.length ? r1(Math.max(...spine.map(p => p.mile))) : 0;

  return {
    trail: {
      name: TRAIL_NAME[trailDir] || trailDir,
      total_miles: total,
      point_spacing_miles: spacing,
      source: 'Extracted from the existing points.json by '
        + 'scripts/build-meta-from-points.js. Geometry untouched; this file '
        + 'records the tables that were previously copied onto every point.',
      built: new Date().toISOString().slice(0, 10),
    },
    regions: regionMeta,
    sections,
    routes,
    hydrate: {
      id: idFormat,
      sec_mile_from: secMileFrom,
      sec_mile_decimals: secDecimals,
      region_from,
      // Which route-level fields this trail's points actually carry. Recorded
      // rather than assumed, so hydrating cannot introduce a field the file
      // never had — route_kind is on PHT only today, and inventing it here
      // would have the round trip verify against the wrong target.
      emit: {
        route_kind: points.some(p => p.route_kind !== undefined),
        alt_of: points.some(p => p.alt_of !== undefined),
        junction_mile: points.some(p => p.junction_mile !== undefined),
        junction_sec_mile: points.some(p => p.junction_sec_mile !== undefined),
      },
    },
    notes: {},
  };
}

// ---------------------------------------------------------- the round trip

// The gate. Rehydrating the slim points through the meta must reproduce the
// file that was read, field for field. Reports the first few differences so a
// failure is diagnosable rather than just red.
function roundTrip(original, meta) {
  const slim = original.map(slimPoint);
  const back = hydratePoints(slim, meta);

  const diffs = [];
  const seen = new Set();
  for (let i = 0; i < original.length && diffs.length < 8; i++) {
    const a = original[i], b = back[i];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const av = a[k] === undefined ? null : a[k];
      const bv = b[k] === undefined ? null : b[k];
      if (JSON.stringify(av) !== JSON.stringify(bv)) {
        diffs.push({ i, id: a.id, field: k, was: av, now: bv });
        seen.add(k);
      }
    }
  }

  // Count every mismatching field across the whole file, not just the sample.
  const fieldCounts = {};
  for (let i = 0; i < original.length; i++) {
    const a = original[i], b = back[i];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const av = a[k] === undefined ? null : a[k];
      const bv = b[k] === undefined ? null : b[k];
      if (JSON.stringify(av) !== JSON.stringify(bv)) {
        fieldCounts[k] = (fieldCounts[k] || 0) + 1;
      }
    }
  }

  return { ok: Object.keys(fieldCounts).length === 0, diffs, fieldCounts, n: original.length };
}

// ---------------------------------------------------------------------- main

function run(trailDir, write) {
  const pointsPath = path.join(TRAILS_DIR, trailDir, 'data', 'points.json');
  if (!fs.existsSync(pointsPath)) {
    console.log('  ' + trailDir + ': no points.json, skipped');
    return null;
  }
  const points = JSON.parse(fs.readFileSync(pointsPath, 'utf8'));

  console.log('');
  console.log('=== ' + trailDir + ' (' + points.length + ' points) ===');

  const stop = blockers(points);
  if (stop.length) {
    for (const s of stop) console.log('  REFUSED: ' + s);
    return { trailDir, refused: true, reasons: stop };
  }

  let meta;
  try {
    meta = buildMeta(trailDir, points);
  } catch (e) {
    console.log('  FAILED to build meta: ' + e.message);
    return { trailDir, failed: true, error: e.message };
  }

  console.log('  regions  ' + meta.regions.length
    + '   sections ' + meta.sections.length
    + '   routes ' + meta.routes.length);
  console.log('  hydrate  id = ' + meta.hydrate.id.prefix + '-<'
    + meta.hydrate.id.token_by + '>-mi<' + meta.hydrate.id.from + ' x '
    + meta.hydrate.id.scale + ', w' + meta.hydrate.id.width + '>'
    + (meta.hydrate.id.tokens ? '  tokens ' + JSON.stringify(meta.hydrate.id.tokens) : ''));
  console.log('           sec_mile from ' + meta.hydrate.sec_mile_from
    + ' (' + meta.hydrate.sec_mile_decimals + 'dp)'
    + ',  region from ' + meta.hydrate.region_from);

  const rt = roundTrip(points, meta);
  const slimBytes = JSON.stringify(points.map(slimPoint)).length;
  const fullBytes = JSON.stringify(points).length;
  const metaBytes = JSON.stringify(meta, null, 2).length;

  if (!rt.ok) {
    console.log('  ROUND TRIP FAILED — nothing written');
    console.log('  mismatching fields: ' + JSON.stringify(rt.fieldCounts));
    for (const d of rt.diffs.slice(0, 6)) {
      console.log('    [' + d.i + '] ' + d.id + '  ' + d.field
        + ': was ' + JSON.stringify(d.was) + '  now ' + JSON.stringify(d.now));
    }
    return { trailDir, meta, roundTrip: rt };
  }

  console.log('  ROUND TRIP OK — all ' + rt.n + ' points identical on every field');
  console.log('  size     points ' + (fullBytes / 1048576).toFixed(2) + 'MB -> '
    + (slimBytes / 1048576).toFixed(2) + 'MB slim  +  meta '
    + (metaBytes / 1024).toFixed(0) + 'KB'
    + '   (' + ((1 - (slimBytes + metaBytes) / fullBytes) * 100).toFixed(0) + '% smaller)');

  if (write) {
    const metaPath = path.join(TRAILS_DIR, trailDir, 'data', META_NAME[trailDir] || (trailDir + '_meta.json'));
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    console.log('  WROTE ' + path.relative(path.join(__dirname, '..'), metaPath));
  } else {
    console.log('  (dry run — pass --write to emit the meta file)');
  }

  return { trailDir, meta, roundTrip: rt };
}

const args = process.argv.slice(2);
const write = args.includes('--write');
const targets = args.includes('--all')
  ? PHASE_1
  : args.filter(a => !a.startsWith('--'));

if (!targets.length) {
  console.log('usage: node scripts/build-meta-from-points.js <trail-dir> [--write]');
  console.log('       node scripts/build-meta-from-points.js --all [--write]');
  process.exit(1);
}

console.log('Phase 1 — meta extraction for trails with no meta file');
console.log('Reads points.json, derives the tables, verifies the round trip.');

const results = targets.map(t => run(t, write));

console.log('');
console.log('--- summary ---');
let bad = 0;
for (const r of results) {
  if (!r) continue;
  if (r.refused) { console.log('  ' + r.trailDir.padEnd(24) + 'refused (Phase 5)'); continue; }
  if (r.failed) { console.log('  ' + r.trailDir.padEnd(24) + 'build failed'); bad++; continue; }
  console.log('  ' + r.trailDir.padEnd(24) + (r.roundTrip.ok ? 'verified' : 'ROUND TRIP FAILED'));
  if (!r.roundTrip.ok) bad++;
}
process.exit(bad ? 1 : 0);
