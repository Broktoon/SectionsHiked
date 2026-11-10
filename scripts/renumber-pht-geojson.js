// Bring trail.geojson's route ids into line with points.json.
//
// SUPERSEDED 2026-11-10: build-pht-data.js now writes the GeoJSON with
// canonical route ids (Stage 10). Kept as history only.
//
// The canonical-schema migration renumbered points.json to main / alt-N /
// side-N but left trail.geojson on the old slug ids, so the two files shared
// no route vocabulary at all. map.js keys _altBranches off the GeoJSON and
// snaps points off points.json, so any code path that carried a route id from
// one to the other silently found nothing.
//
// The mapping is exact, not inferred: pht_meta.json pins legacy_route_id on
// every one of the 173 routes precisely so this stays reversible.
//
// `route_id: "roadwalk"` is deliberately left alone. It is the NON-HIKEABLE
// sense of the tag -- a gap connector drawn for continuity that carries no
// mileage and has no points.json entries -- so it is not a route and has no
// numeric id. See CLAUDE.md, "route_id vs route_type".
//
// Usage:  node scripts/renumber-pht-geojson.js [--write]

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'public', 'trails', 'potomac-heritage-trail', 'data');
const GEOJSON = path.join(DATA, 'trail.geojson');
const META = path.join(DATA, 'pht_meta.json');
const WRITE = process.argv.includes('--write');

const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
const gj = JSON.parse(fs.readFileSync(GEOJSON, 'utf8'));

const legacy2new = new Map();
for (const r of meta.routes || []) {
  if (r.legacy_route_id) legacy2new.set(r.legacy_route_id, r.id);
}
if (legacy2new.size === 0) {
  console.error('FAIL: pht_meta.json carries no legacy_route_id; nothing to map from.');
  process.exit(1);
}

const KEEP = new Set(['roadwalk']);
// Ids that are ALREADY canonical. Re-running on a migrated file must report
// "nothing to do", not fail: the legacy lookup naturally misses them, and a
// false alarm here would look exactly like real data corruption.
const canonical = new Set((meta.routes || []).map(r => r.id));
const counts = { route_id: 0, alt_of: 0, kept: 0, already: 0 };
const unmapped = new Set();

for (const f of gj.features || []) {
  const p = f.properties;
  if (!p) continue;
  for (const key of ['route_id', 'alt_of']) {
    const v = p[key];
    if (v == null) continue;
    if (KEEP.has(v)) { counts.kept++; continue; }
    if (canonical.has(v)) { counts.already++; continue; }
    const next = legacy2new.get(v);
    if (next === undefined) { unmapped.add(v); continue; }
    if (next !== v) { p[key] = next; counts[key]++; }
  }
}

console.log('features                : ' + (gj.features || []).length);
console.log('route_id remapped       : ' + counts.route_id);
console.log('alt_of remapped         : ' + counts.alt_of);
console.log('left as-is (roadwalk)   : ' + counts.kept);
console.log('already canonical       : ' + counts.already);
console.log('unmapped                : ' + unmapped.size
  + (unmapped.size ? '  -> ' + JSON.stringify([...unmapped]) : ''));

if (unmapped.size) {
  console.error('\nFAIL: unmapped route ids above. Not writing.');
  process.exit(1);
}

// Every route id in the file must now be one points.json also uses.
const pts = JSON.parse(fs.readFileSync(path.join(DATA, 'points.json'), 'utf8'));
const pointRoutes = new Set(pts.map(p => p.route_id || 'main'));
const gjRoutes = new Set();
for (const f of gj.features || []) {
  const v = (f.properties || {}).route_id;
  if (v && !KEEP.has(v)) gjRoutes.add(v);
}
const orphan = [...gjRoutes].filter(r => !pointRoutes.has(r));
console.log('geojson route ids       : ' + gjRoutes.size);
console.log('not present in points   : ' + orphan.length
  + (orphan.length ? '  -> ' + JSON.stringify(orphan.slice(0, 10)) : ''));
if (orphan.length) {
  console.error('\nFAIL: geojson references routes points.json does not have. Not writing.');
  process.exit(1);
}

if (!WRITE) {
  console.log('\nDRY RUN. Pass --write to apply.');
  process.exit(0);
}

// Minified, per the canonical file-format rule for trail.geojson.
fs.writeFileSync(GEOJSON, JSON.stringify(gj));
console.log('\nwritten: ' + GEOJSON);
