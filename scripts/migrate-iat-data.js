#!/usr/bin/env node
/**
 * migrate-iat-data.js
 *
 * Migrates Ice Age Trail points.json and trail.geojson to the canonical schema
 * already used by AT, AZT and Natchez Trace.
 *
 * points.json changes:
 *   - axis_mile (the true cumulative trail mile) is promoted to `mile`
 *   - the old section-local `mile` becomes `sec_mile`, which means the same
 *     thing on every trail: distance from the start of THIS section. The East
 *     Alternate's alt_mile is cumulative across the whole alternate, so its
 *     section's alt_mile_start is subtracted to make it section-local too.
 *   - section/region ids gain display names from iat_meta.json
 *   - route_id is added ("main-spine", or "east-alt" + alt_of for the alternate)
 *   - points that fall off the certified tread are tagged route_type "roadwalk"
 *
 * The East Alternate's points carry alt_mile (0-86.9, local to the alternate).
 * Canonical schema wants a global `mile`, so it's interpolated across the
 * branch/rejoin anchors that iat_meta.json's alt_groups declares.
 *
 * trail.geojson changes:
 *   - canonical properties on every feature
 *   - the 5 East Alternate features get route_id/alt_of (replacing the bespoke
 *     alt_id), which is what keeps map.js from splicing them into the spine
 *   - roadwalk LineStrings are generated from runs of roadwalk points, so the
 *     connecting routes render as dashed line rather than not at all
 *   - features are ordered by mile, so map.js's document-order concatenation of
 *     the spine stays monotonic
 *
 * Run: node scripts/migrate-iat-data.js
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, '../public/trails/ice-age-trail/data');
const POINTS_PATH = path.join(DATA_DIR, 'points.json');
const TRAIL_PATH  = path.join(DATA_DIR, 'trail.geojson');
const META_PATH   = path.join(DATA_DIR, 'iat_meta.json');
const POINTS_BAK  = path.join(DATA_DIR, 'points_backup.json');
const TRAIL_BAK   = path.join(DATA_DIR, 'trail_backup.geojson');

// A point this far from the nearest certified-tread vertex is on a connecting
// route, not on trail. Certified geometry averages a vertex every ~18ft, so
// anything genuinely on tread lands far inside this.
const TREAD_TOLERANCE_MI = 0.06;

function haversine(lat1, lon1, lat2, lon2) {
    const R = 3958.8, toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// Coarse grid so nearest-vertex lookups don't go quadratic over 200k vertices.
const CELL = 50; // ~0.02 degrees per cell
const cellKey = (lat, lon) => `${Math.round(lat * CELL)}:${Math.round(lon * CELL)}`;

function buildIndex(coords) {
    const idx = new Map();
    for (const c of coords) {
        const k = cellKey(c[1], c[0]);
        if (!idx.has(k)) idx.set(k, []);
        idx.get(k).push(c);
    }
    return idx;
}

function nearestDist(idx, lat, lon) {
    let best = Infinity;
    const la = Math.round(lat * CELL), lo = Math.round(lon * CELL);
    for (let dla = -1; dla <= 1; dla++) {
        for (let dlo = -1; dlo <= 1; dlo++) {
            const arr = idx.get(`${la + dla}:${lo + dlo}`);
            if (!arr) continue;
            for (const c of arr) {
                const d = haversine(lat, lon, c[1], c[0]);
                if (d < best) best = d;
            }
        }
    }
    return best;
}

const points = JSON.parse(fs.readFileSync(POINTS_PATH, 'utf8'));
const trail  = JSON.parse(fs.readFileSync(TRAIL_PATH, 'utf8'));
const meta   = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));

if (!fs.existsSync(POINTS_BAK)) fs.copyFileSync(POINTS_PATH, POINTS_BAK);
if (!fs.existsSync(TRAIL_BAK))  fs.copyFileSync(TRAIL_PATH, TRAIL_BAK);

const regionName  = new Map(meta.regions.map(r => [r.id, r.name]));
const sectionMeta = new Map(meta.sections.map(s => [s.id, s]));
const altMeta     = new Map(meta.east_alt_sections.map(s => [s.id, s]));

const altGroup   = meta.alt_groups[0];
const BRANCH_MI  = altGroup.branch_axis_mile;
const REJOIN_MI  = altGroup.rejoin_axis_mile;
// The alternate's own mile axis runs 0 -> its last section's alt_mile_end.
const ALT_LENGTH = Math.max(...meta.east_alt_sections.map(s => s.alt_mile_end));

// ---------------------------------------------------------------- roadwalk
// Certified tread is exactly what trail.geojson's non-alt features draw.
const treadCoords = [], altTreadCoords = [];
for (const f of trail.features) {
    const into = f.properties.alt_id ? altTreadCoords : treadCoords;
    for (const c of f.geometry.coordinates) into.push(c);
}
const treadIndex    = buildIndex(treadCoords);
const altTreadIndex = buildIndex(altTreadCoords);

// ------------------------------------------------------------------ points
const mainPoints = [], altPoints = [];

for (const p of points) {
    const isAlt = Boolean(p.alt_id);
    // The east route's first 3.9mi run up the Devil's Lake segment before it
    // branches, so an alt point can legitimately name a main-list section.
    const sec   = (isAlt ? altMeta.get(p.section) : null) || sectionMeta.get(p.section);
    if (!sec) throw new Error(`No iat_meta.json entry for section "${p.section}"`);

    const out = {
        id:           p.id,
        lat:          p.lat,
        lon:          p.lon,
        // The alternate is interpolated onto the 23.3mi branch-to-rejoin span,
        // compressing its 0.5mi point spacing to ~0.13 mile-units. Keep more decimals
        // than the spine so lookups that map back through this interpolation land on
        // the same point rather than jittering to a neighbour.
        mile:         isAlt
            ? round3(BRANCH_MI + (p.alt_mile / ALT_LENGTH) * (REJOIN_MI - BRANCH_MI))
            : p.axis_mile,
        region_id:    p.region,
        region_name:  regionName.get(p.region),
        section_id:   p.section,
        section_name: sec.name,
        sec_mile:     isAlt ? round1(p.alt_mile - (sec.alt_mile_start ?? 0)) : p.mile,
        route_id:     isAlt ? 'east-alt' : 'main-spine',
    };
    if (isAlt) out.alt_of = 'main-spine';

    if (nearestDist(isAlt ? altTreadIndex : treadIndex, p.lat, p.lon) > TREAD_TOLERANCE_MI) {
        out.route_type = 'roadwalk';
    }
    out.state = p.state;

    (isAlt ? altPoints : mainPoints).push(out);
}

mainPoints.sort((a, b) => a.mile - b.mile);
altPoints.sort((a, b) => a.mile - b.mile);

function round1(n) { return Math.round(n * 10) / 10; }
function round3(n) { return Math.round(n * 1000) / 1000; }

// Resolve the tread/roadwalk split from each certified LineString's own ends
// rather than per-point proximity. A section's tread is a single continuous
// feature, so the points nearest its two endpoints bracket exactly one span;
// everything inside is tread, everything outside is a connecting route.
// Per-point proximity alone speckles badly, because points.json samples a
// slightly different path than the simplified geometry — a lone point a few
// hundred feet off a rail-trail would otherwise read as its own roadwalk.
const treadSpanWarnings = [];

function classifyByTreadSpan(routePoints, featureFor, mileOf) {
    const order = [], bySection = new Map();
    for (const p of routePoints) {
        if (!bySection.has(p.section_id)) { bySection.set(p.section_id, []); order.push(p.section_id); }
        bySection.get(p.section_id).push(p);
    }
    for (const id of order) {
        const sp = bySection.get(id);
        const f = featureFor(id);
        if (!f) continue; // no geometry for this section: leave points as roadwalk
        const coords = f.geometry.coordinates;
        const mileNearest = (co) => {
            let best = Infinity, mile = null;
            for (const p of sp) {
                const d = haversine(co[1], co[0], p.lat, p.lon);
                if (d < best) { best = d; mile = mileOf(p); }
            }
            return mile;
        };
        const a = mileNearest(coords[0]);
        const b = mileNearest(coords[coords.length - 1]);
        if (a == null || b == null) continue;
        const from = Math.min(a, b), to = Math.max(a, b);
        const tread = [];
        for (const p of sp) {
            if (mileOf(p) >= from && mileOf(p) <= to) { delete p.route_type; tread.push(p); }
            else p.route_type = 'roadwalk';
        }
        // Measure the warning in real miles via sec_mile. The ordering axis can be
        // the alternate's interpolated `mile`, which is compressed onto the 23.3mi
        // branch-to-rejoin span and would make every alt section look far too short.
        const meta = sectionMeta.get(id) || altMeta.get(id);
        if (meta && tread.length) {
            const span = Math.max(...tread.map(t => t.sec_mile)) - Math.min(...tread.map(t => t.sec_mile));
            if (Math.abs(span - meta.certified_miles) > 1.5) {
                treadSpanWarnings.push(`${id}: tread span ${span.toFixed(1)}mi vs certified_miles ${meta.certified_miles}`);
            }
        }
    }
}

const treadFeature = new Map(), altFeature = new Map();
for (const f of trail.features) {
    (f.properties.alt_id ? altFeature : treadFeature).set(f.properties.section, f);
}

classifyByTreadSpan(mainPoints, id => treadFeature.get(id), p => p.mile);
// Only ~13 of the alternate's 87 miles have mapped tread; the rest is
// connecting route. Ordered by the interpolated `mile`, since sec_mile now
// restarts at each alt section.
classifyByTreadSpan(altPoints, id => altFeature.get(id), p => p.mile);

// ------------------------------------------------------------- trail.geojson
// Points give a clean mile-ordered path, so use them to (a) orient each
// certified feature forward and (b) place it in the output ordering. Scope the
// lookup to the feature's own section — the trail doubles back near itself in
// places, so a purely geometric nearest-point search picks up a neighbour's
// mile and lands the feature in the wrong spot.
const treadBySection = new Map();
for (const p of mainPoints) {
    if (p.route_type) continue;
    if (!treadBySection.has(p.section_id)) treadBySection.set(p.section_id, []);
    treadBySection.get(p.section_id).push(p);
}

function nearestSectionMile(sectionId, lon, lat) {
    const arr = treadBySection.get(sectionId);
    if (!arr || arr.length === 0) return null;
    let best = Infinity, bestMile = null;
    for (const p of arr) {
        const d = haversine(lat, lon, p.lat, p.lon);
        if (d < best) { best = d; bestMile = p.mile; }
    }
    return bestMile;
}

const outFeatures = [];
let reversedCount = 0;

for (const f of trail.features) {
    if (f.properties.alt_id) continue;
    const sec = sectionMeta.get(f.properties.section);
    if (!sec) throw new Error(`No iat_meta.json entry for feature "${f.properties.section}"`);

    let coords = f.geometry.coordinates;
    const headMile = nearestSectionMile(sec.id, coords[0][0], coords[0][1]);
    const tailMile = nearestSectionMile(sec.id, coords[coords.length - 1][0], coords[coords.length - 1][1]);
    if (headMile != null && tailMile != null && headMile > tailMile) {
        coords = coords.slice().reverse();
        reversedCount++;
    }

    outFeatures.push({
        sortMile: Math.min(headMile ?? sec.ui_mile_start, tailMile ?? sec.ui_mile_start),
        feature: {
            type: 'Feature',
            properties: {
                section_id:   sec.id,
                section_name: sec.name,
                region_id:    sec.region,
                region_name:  regionName.get(sec.region),
                route_id:     'main-spine',
            },
            geometry: { type: 'LineString', coordinates: coords },
        },
    });
}

// Roadwalk lines: each run of consecutive roadwalk points, extended one point
// into the tread on either side so the dashed line meets the solid one.
function addRoadwalkRuns(routePoints, mileOf, extraProps, sink) {
    let runs = 0;
    for (let i = 0; i < routePoints.length; i++) {
        if (!routePoints[i].route_type) continue;
        let j = i;
        while (j + 1 < routePoints.length && routePoints[j + 1].route_type) j++;

        const run = routePoints.slice(Math.max(0, i - 1), Math.min(routePoints.length - 1, j + 1) + 1);
        if (run.length >= 2) {
            const anchor = routePoints[i];
            sink.push({
                sortMile: mileOf(run[0]),
                feature: {
                    type: 'Feature',
                    properties: {
                        section_id:   anchor.section_id,
                        section_name: anchor.section_name,
                        region_id:    anchor.region_id,
                        region_name:  anchor.region_name,
                        route_type:   'roadwalk',
                        ...extraProps,
                    },
                    geometry: { type: 'LineString', coordinates: run.map(p => [p.lon, p.lat]) },
                },
            });
            runs++;
        }
        i = j;
    }
    return runs;
}

const runs = addRoadwalkRuns(mainPoints, p => p.mile, { route_id: 'main-spine' }, outFeatures);

outFeatures.sort((a, b) => a.sortMile - b.sortMile);
const features = outFeatures.map(x => x.feature);

// The alternate gets the same treatment on its own axis. map.js keys alt
// branches off route_id and concatenates them in document order, so these are
// emitted sorted by the interpolated `mile`.
const altOut = [];
for (const f of trail.features) {
    if (!f.properties.alt_id) continue;
    const sec = altMeta.get(f.properties.section) || sectionMeta.get(f.properties.section);
    if (!sec) throw new Error(`No iat_meta.json entry for alt feature "${f.properties.section}"`);

    const sp = altPoints.filter(p => p.section_id === sec.id && !p.route_type);
    const nearestAltMile = (co) => {
        let best = Infinity, mile = null;
        for (const p of sp) {
            const d = haversine(co[1], co[0], p.lat, p.lon);
            if (d < best) { best = d; mile = p.mile; }
        }
        return mile;
    };
    let coords = f.geometry.coordinates;
    const head = nearestAltMile(coords[0]);
    const tail = nearestAltMile(coords[coords.length - 1]);
    if (head != null && tail != null && head > tail) coords = coords.slice().reverse();

    altOut.push({
        sortMile: Math.min(head ?? 0, tail ?? 0),
        feature: {
            type: 'Feature',
            properties: {
                section_id:   sec.id,
                section_name: sec.name,
                region_id:    sec.region,
                region_name:  regionName.get(sec.region),
                route_id:     'east-alt',
                alt_of:       'main-spine',
            },
            geometry: { type: 'LineString', coordinates: coords },
        },
    });
}
const altRuns = addRoadwalkRuns(altPoints, p => p.mile,
    { route_id: 'east-alt', alt_of: 'main-spine' }, altOut);

altOut.sort((a, b) => a.sortMile - b.sortMile);
for (const x of altOut) features.push(x.feature);

const outPoints = mainPoints.concat(altPoints);
fs.writeFileSync(POINTS_PATH, JSON.stringify(outPoints));
fs.writeFileSync(TRAIL_PATH, JSON.stringify({ type: 'FeatureCollection', features }));

// ----------------------------------------------------------------- summary
const roadwalkPts = mainPoints.filter(p => p.route_type).length;
console.log('points.json');
console.log(`  main-spine points : ${mainPoints.length} (${roadwalkPts} roadwalk, ${mainPoints.length - roadwalkPts} tread)`);
console.log(`  east-alt points   : ${altPoints.length}`);
console.log(`  mile range        : ${mainPoints[0].mile} -> ${mainPoints[mainPoints.length - 1].mile}`);
console.log(`  alt mile range    : ${altPoints[0].mile} -> ${altPoints[altPoints.length - 1].mile} (branch ${BRANCH_MI}, rejoin ${REJOIN_MI})`);
console.log('trail.geojson');
console.log(`  certified features: ${trail.features.filter(f => !f.properties.alt_id).length} (${reversedCount} reversed to run forward)`);
console.log(`  roadwalk features : ${runs}`);
console.log(`  east-alt features : ${features.filter(f => f.properties.route_id === 'east-alt').length} (${altRuns} of them roadwalk)`);
if (treadSpanWarnings.length) {
    console.log(`\ntread span disagrees with certified_miles by >1.5mi in ${treadSpanWarnings.length} section(s):`);
    for (const w of treadSpanWarnings) console.log(`  ${w}`);
}
console.log(`\ntrails.js totalMiles should be ${meta.trail.total_trail_miles}`);
