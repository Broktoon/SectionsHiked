#!/usr/bin/env node
// verify-schema-roundtrip.js: prove a slimmed trail lost nothing.
//
// Usage:
//   node scripts/verify-schema-roundtrip.js <trail data dir> [--before <full points.json>]
//
// <trail data dir> is the folder holding points.json and its *_meta.json, in
// either repo (public/trails/<trail>/data here, trails/<trail>/data in
// TrailTemps). --before defaults to the points.json committed at git HEAD,
// which is the full-schema file the conversion started from.
//
// Read-only. It writes nothing and changes nothing on either site. It fails
// (exit 1) unless ALL of these hold:
//
//   1. points.json is canonical: every point has lat, lon, mile and route_id,
//      and no field outside the seven (lat, lon, mile, route_id, trail_elev,
//      route_type, state).
//   2. The meta file carries a `hydrate` block, which is what makes the apps
//      rebuild the points at load.
//   3. Rebuilding the slim points through the shared loader
//      (public/js/hydrate-points.js) gives back the "before" file exactly:
//      same number of points, same order, every field equal. The loader is
//      the same code both sites run, so this is what the apps will see.
//
// There are no allowed differences. A conversion that renames route ids or
// rescales miles on purpose (as Potomac Heritage's did) is checked by its own
// build instead; Phase 4 conversions change layout only, so they must round
// trip to the byte.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hydratePoints } = require('../public/js/hydrate-points');

const REQUIRED = ['lat', 'lon', 'mile', 'route_id'];
const OPTIONAL = ['trail_elev', 'route_type', 'state'];

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: node scripts/verify-schema-roundtrip.js <trail data dir> [--before <full points.json>]');
  process.exit(2);
}

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--before');
if (!dir) usage();
const beforeArg = args.includes('--before') ? args[args.indexOf('--before') + 1] : null;

const pointsPath = path.join(dir, 'points.json');
if (!fs.existsSync(pointsPath)) usage('no points.json in ' + dir);
const metaName = fs.readdirSync(dir).find(f => /_meta\.json$/.test(f) && !/backup/.test(f));
if (!metaName) usage('no *_meta.json in ' + dir);

const slim = JSON.parse(fs.readFileSync(pointsPath, 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(dir, metaName), 'utf8'));

let before, beforeLabel;
if (beforeArg) {
  before = JSON.parse(fs.readFileSync(beforeArg, 'utf8'));
  beforeLabel = beforeArg;
} else {
  // `git show HEAD:./points.json` run inside the data dir resolves the path
  // relative to it, so this works the same in either repo.
  try {
    before = JSON.parse(execFileSync('git', ['show', 'HEAD:./points.json'],
      { cwd: dir, maxBuffer: 1 << 30 }).toString('utf8'));
    beforeLabel = 'points.json at git HEAD';
  } catch (e) {
    usage('could not read points.json at git HEAD (' + e.message.split('\n')[0] + '); pass --before');
  }
}

const fail = [];
console.log('trail data : ' + dir);
console.log('meta       : ' + metaName);
console.log('before     : ' + beforeLabel + ' (' + before.length + ' points)');
console.log('after      : points.json on disk (' + slim.length + ' points)');
console.log('');

// 1. canonical record
const allowed = new Set([...REQUIRED, ...OPTIONAL]);
const extra = {}, missing = {};
for (const p of slim) {
  for (const k of Object.keys(p)) if (!allowed.has(k)) extra[k] = (extra[k] || 0) + 1;
  for (const k of REQUIRED) {
    const v = p[k];
    const ok = k === 'route_id' ? typeof v === 'string' && v.length > 0 : typeof v === 'number' && Number.isFinite(v);
    if (!ok) missing[k] = (missing[k] || 0) + 1;
  }
}
const fields = [...new Set(slim.flatMap(p => Object.keys(p)))];
console.log('1. fields  ' + fields.join(', '));
for (const [k, n] of Object.entries(extra)) fail.push('non-canonical field "' + k + '" on ' + n + ' points');
for (const [k, n] of Object.entries(missing)) fail.push(n + ' points lack a valid ' + k);

// 2. hydrate block
if (!meta.hydrate) fail.push(metaName + ' has no hydrate block, so the apps would not rebuild the points');
console.log('2. hydrate ' + (meta.hydrate ? 'present' : 'MISSING'));

// 3. round trip
if (meta.hydrate) {
  const back = hydratePoints(slim, meta);
  if (back.length !== before.length) {
    fail.push('point count differs: before ' + before.length + ', after ' + back.length);
  }
  const counts = {}, samples = [];
  const n = Math.min(back.length, before.length);
  for (let i = 0; i < n; i++) {
    const a = before[i], b = back[i];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const av = a[k] === undefined ? null : a[k];
      const bv = b[k] === undefined ? null : b[k];
      if (JSON.stringify(av) === JSON.stringify(bv)) continue;
      counts[k] = (counts[k] || 0) + 1;
      if (samples.length < 6) samples.push('[' + i + '] ' + (a.id || '') + ' ' + k + ': was ' + JSON.stringify(av) + ', now ' + JSON.stringify(bv));
    }
  }
  if (Object.keys(counts).length) {
    fail.push('round trip differs on ' + JSON.stringify(counts));
    for (const s of samples) console.log('     ' + s);
  }
  console.log('3. round trip ' + (Object.keys(counts).length || back.length !== before.length
    ? 'FAILED' : 'exact: all ' + n + ' points, every field'));
}

console.log('');
if (fail.length) {
  console.log('FAIL');
  for (const f of fail) console.log('  - ' + f);
  process.exit(1);
}
console.log('PASS');
