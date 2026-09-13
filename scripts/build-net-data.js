#!/usr/bin/env node
/**
 * build-net-data.js
 *
 * Rebuilds New England Trail points.json / trail.geojson from the NPS
 * authoritative centerline, replacing the decimated geometry inherited from
 * TrailTemps (6,918 vertices, measured 184mi against an official 235.67mi).
 *
 * Source: NEEN_BND_NationalScenicTrailCenterline_ln, published by NPS
 * (owner JEFARRELL@nps.gov_nps, updated 2023-04-07). Combines Connecticut
 * Forest & Park Association and Appalachian Mountain Club survey data.
 * One MultiLineString, 14 parts, 103,732 vertices, 235.67mi total.
 *
 * What the source actually contains, and why this script is shaped the way it is:
 *
 *   - The trail is NOT one continuous line. Two real gaps separate it:
 *     ~2.98mi between the Guilford/Menunkatuck section and the Mattabesett,
 *     and ~1.49mi at the Connecticut River, which cannot be crossed on foot.
 *     Gaps are NOT added to mileage (the official 235.67 is the sum of the
 *     drawn parts), and no line is drawn across them — a gap ends one
 *     trail.geojson feature and the next one starts after it.
 *
 *   - The Middletown spur is part of the official 235.67mi total. It attaches
 *     to the spine at a single point (8ft) and dead-ends at Middletown; it does
 *     not rejoin. Spine is 200.69mi, spur 34.97mi.
 *
 *   - The spine is identified as the minimum-gap route between the two extreme
 *     termini (Guilford, min latitude; Royalston Falls, max latitude). Anything
 *     left over is the spur. Nothing is keyed off part index — the service can
 *     reorder parts on republish.
 *
 * Mile axis: spine runs 0 -> 200.69. The spur is appended, 200.69 -> 235.66, so
 * the axis covers every official mile exactly once with no overlap. This differs
 * from IAT's east/west bifurcation, whose alternate IS interpolated across its
 * branch->rejoin span because it substitutes for a specific stretch of spine.
 * A dead-end spur substitutes for nothing, so there is no stretch to project
 * onto. sec_mile stays section-local on both routes, per the canonical schema.
 *
 * Run: node scripts/build-net-data.js [--refresh] [--tt-points]
 *   --refresh    re-download the source instead of using scripts/cache
 *   --tt-points  also rebuild TrailTemps' points.json (see the warning it prints —
 *                TT's historical_weather.json is keyed to the current point ids)
 */

const fs   = require('fs');
const path = require('path');

const SERVICE = 'https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/' +
                'NEEN_BND_NationalScenicTrailCenterline_ln/FeatureServer/0';
const QUERY   = '/query?where=1%3D1&outFields=*&outSR=4326&f=geojson';

const SH_DIR    = path.join(__dirname, '../public/trails/new-england-trail/data');
const TT_DIR    = path.join(__dirname, '../../TrailTemps/TrailTemps Version - Git/trails/new-england-trail/data');
const CACHE     = path.join(__dirname, 'cache/neen_official.geojson');

const STEP_MI   = 0.1;    // point spacing; matches AT/PHT, replaces the old 1-mile sampling
const SLIVER_MI = 0.05;   // parts shorter than this are digitising slivers, not trail
const FREE_END_MI = 5;    // an endpoint this far from every other part's is a terminus
const JUMP_MAX_MI = 15;   // furthest gap the spine router will consider bridging
const GAP_MI    = 100 / 5280; // a jump longer than ~100ft is a break, not a join
const GAP_REPORT_MI = 0.25;   // ...but only breaks this long are real trail gaps
const CT_MA_BORDER_LAT = 42.0500;
const GAP_MATCH_MI = 1.0;     // how close a detected gap's ends must sit to a known one

// Breaks in the centerline we have an authoritative account of. Anchored to the
// endpoint coordinates rather than a part index, so if the NPS layer is
// republished with different geometry this simply stops matching instead of
// silently labelling the wrong break.
//
// `connector: true` draws a dashed line across the gap tagged route_id
// "roadwalk" — the non-hikeable sense of that tag (Natchez's parkway), meaning
// rendered for continuity, carries no mileage, no points.json entries. That is
// the honest reading here: per newenglandtrail.org/thru-hiking there is no
// pedestrian crossing of the Connecticut River at all, so it is not trail and
// not walkable, it just needs to be visible as a break rather than a blank.
const KNOWN_GAPS = [{
    id: 'connecticut-river',
    name: 'Connecticut River crossing',
    ends: [[42.2830, -72.6263], [42.2909, -72.5999]], // Easthampton side / Skinner State Park side
    connector: true,
    passable_on_foot: false,
    note: 'No pedestrian crossing exists. Northbound the trail resumes on Old Mountain Road ' +
          'near Skinner State Park; southbound at 2-98 Underwood Ave, Easthampton MA. Hikers ' +
          'arrange a boat or car ride across; the road detour via US-5N and MA-47N is 10.2mi ' +
          'and not recommended (high traffic).',
    source: 'https://newenglandtrail.org/thru-hiking/',
}];

const args      = process.argv.slice(2);
const REFRESH   = args.includes('--refresh');
const TT_POINTS = args.includes('--tt-points');

function hav(lat1, lon1, lat2, lon2) {
    const R = 3958.8, t = x => x * Math.PI / 180;
    const dLat = t(lat2 - lat1), dLon = t(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}
const dEnd = (a, b) => hav(a[1], a[0], b[1], b[0]);
const r6 = n => Math.round(n * 1e6) / 1e6;
const r2 = n => Math.round(n * 100) / 100;
const r3 = n => Math.round(n * 1000) / 1000;

// ------------------------------------------------------------------ source
async function loadSource() {
    if (!REFRESH && fs.existsSync(CACHE)) {
        console.log('source: cache', path.relative(process.cwd(), CACHE));
        return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    }
    console.log('source: fetching', SERVICE);
    const resp = await fetch(SERVICE + QUERY);
    if (!resp.ok) throw new Error(`source fetch failed: ${resp.status} ${resp.statusText}`);
    const json = await resp.json();
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(json));
    return json;
}

function partLength(coords) {
    let L = 0;
    for (let i = 1; i < coords.length; i++) L += dEnd(coords[i - 1], coords[i]);
    return L;
}

// ------------------------------------------------------- spine / spur split
// The spine is the minimum-gap route between the two extreme termini. Traversing
// a part is free and jumping between parts costs its gap distance, so the router
// prefers connected trail and only crosses a gap when there is no alternative.
// A dead-end branch can never lie on that route, which is what separates the spur
// from the spine without hardcoding any part index.
function routeSpine(parts, startKey, goalKey) {
    const nodes = [];
    parts.forEach((p, i) => { nodes.push(`${i}:A`, `${i}:B`); });
    const endpointOf = key => {
        const [i, e] = key.split(':');
        const c = parts[+i].coords;
        return e === 'A' ? c[0] : c[c.length - 1];
    };
    const edges = new Map(nodes.map(n => [n, []]));
    parts.forEach((p, i) => {
        edges.get(`${i}:A`).push({ to: `${i}:B`, cost: 0, kind: 'traverse' });
        edges.get(`${i}:B`).push({ to: `${i}:A`, cost: 0, kind: 'traverse' });
    });
    for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
            for (const ea of ['A', 'B']) for (const eb of ['A', 'B']) {
                const d = dEnd(endpointOf(`${i}:${ea}`), endpointOf(`${j}:${eb}`));
                if (d > JUMP_MAX_MI) continue;
                edges.get(`${i}:${ea}`).push({ to: `${j}:${eb}`, cost: d, kind: 'jump' });
                edges.get(`${j}:${eb}`).push({ to: `${i}:${ea}`, cost: d, kind: 'jump' });
            }
        }
    }
    const dist = new Map(nodes.map(n => [n, Infinity]));
    const prev = new Map();
    dist.set(startKey, 0);
    const unvisited = new Set(nodes);
    while (unvisited.size) {
        let cur = null, best = Infinity;
        for (const n of unvisited) if (dist.get(n) < best) { best = dist.get(n); cur = n; }
        if (cur === null) break;
        unvisited.delete(cur);
        if (cur === goalKey) break;
        for (const e of edges.get(cur)) {
            if (!unvisited.has(e.to)) continue;
            const alt = dist.get(cur) + e.cost;
            if (alt < dist.get(e.to)) { dist.set(e.to, alt); prev.set(e.to, { from: cur, ...e }); }
        }
    }
    if (!prev.has(goalKey) && startKey !== goalKey) throw new Error('no route between termini');
    const walk = [];
    for (let n = goalKey; n !== startKey; n = prev.get(n).from) walk.unshift({ node: n, via: prev.get(n) });
    return { walk, totalGap: dist.get(goalKey) };
}

(async function main() {
    const src = await loadSource();
    const feat = src.features[0];
    const raw = feat.geometry.type === 'MultiLineString'
        ? feat.geometry.coordinates
        : [feat.geometry.coordinates];

    const parts = [];
    let sliverCount = 0, sliverMi = 0;
    for (const c of raw) {
        const L = partLength(c);
        if (L < SLIVER_MI) { sliverCount++; sliverMi += L; continue; }
        parts.push({ coords: c, len: L });
    }
    console.log(`parts: ${parts.length} substantive (dropped ${sliverCount} slivers totalling ${sliverMi.toFixed(3)}mi)`);
    console.log(`source total: ${(parts.reduce((s, p) => s + p.len, 0) + sliverMi).toFixed(2)}mi`);

    // Termini: endpoints far from every other part's endpoints.
    const free = [];
    parts.forEach((p, i) => {
        for (const e of ['A', 'B']) {
            const c = e === 'A' ? p.coords[0] : p.coords[p.coords.length - 1];
            let min = Infinity;
            parts.forEach((q, j) => {
                if (i === j) return;
                min = Math.min(min, dEnd(c, q.coords[0]), dEnd(c, q.coords[q.coords.length - 1]));
            });
            if (min > FREE_END_MI) free.push({ key: `${i}:${e}`, coord: c, isolation: min });
        }
    });
    if (free.length !== 3) {
        throw new Error(`expected 3 free endpoints (2 main termini + spur terminus), found ${free.length}: ` +
                        free.map(f => f.key).join(', '));
    }
    const byLat = [...free].sort((a, b) => a.coord[1] - b.coord[1]);
    const south = byLat[0], north = byLat[byLat.length - 1];
    const spurEnd = free.find(f => f !== south && f !== north);
    console.log(`termini: south ${south.coord.map(r6)} | north ${north.coord.map(r6)} | spur end ${spurEnd.coord.map(r6)}`);

    const { walk, totalGap } = routeSpine(parts, south.key, north.key);

    // Replay the route: traversals build the ordered spine, jumps record gaps.
    const endpointOf = key => {
        const [i, e] = key.split(':');
        const c = parts[+i].coords;
        return e === 'A' ? c[0] : c[c.length - 1];
    };
    const spineParts = [], gaps = [];
    let curKey = south.key;
    for (const step of walk) {
        if (step.via.kind === 'traverse') {
            const i = +curKey.split(':')[0];
            const enteredAt = curKey.split(':')[1];
            spineParts.push({ i, coords: enteredAt === 'A' ? parts[i].coords : parts[i].coords.slice().reverse() });
        } else if (step.via.cost > GAP_MI) {
            gaps.push({
                afterPart: +curKey.split(':')[0],
                miles: step.via.cost,
                from: endpointOf(curKey),
                to: endpointOf(step.node),
            });
        }
        curKey = step.node;
    }
    // Match each break against the known-gap table by where its ends sit.
    for (const g of gaps) {
        g.known = KNOWN_GAPS.find(k => {
            const [a, b] = k.ends;
            const near = (c, t) => hav(c[1], c[0], t[0], t[1]) <= GAP_MATCH_MI;
            return (near(g.from, a) && near(g.to, b)) || (near(g.from, b) && near(g.to, a));
        });
    }
    const spineIdx = new Set(spineParts.map(s => s.i));
    const spurPartIdx = parts.map((_, i) => i).filter(i => !spineIdx.has(i));
    if (spurPartIdx.length !== 1) {
        throw new Error(`expected exactly 1 leftover spur part, got ${spurPartIdx.length}`);
    }
    const spurRaw = parts[spurPartIdx[0]];
    // Orient the spur so sec_mile 0 is the junction and it runs out to Middletown.
    const spurCoords = dEnd(spurRaw.coords[0], spurEnd.coord) < dEnd(spurRaw.coords[spurRaw.coords.length - 1], spurEnd.coord)
        ? spurRaw.coords.slice().reverse()
        : spurRaw.coords.slice();

    // -------------------------------------------------------- mile axis
    // Gaps contribute no mileage: the official total is the sum of drawn parts,
    // and the trail's own guidance treats the breaks as if they were closed.
    const spine = [];       // { coord, mile, partI, firstOfPart }
    let mile = 0;
    spineParts.forEach((sp, n) => {
        sp.coords.forEach((c, k) => {
            if (k > 0) mile += dEnd(sp.coords[k - 1], c);
            spine.push({ coord: c, mile, partI: sp.i, firstOfPart: k === 0 && n > 0 });
        });
    });
    const spineMiles = mile;

    const spur = [];
    let sMile = 0;
    spurCoords.forEach((c, k) => {
        if (k > 0) sMile += dEnd(spurCoords[k - 1], c);
        spur.push({ coord: c, mile: sMile });
    });
    const spurMiles = sMile;

    // Junction: where the spur's inner end meets the spine.
    let junction = { d: Infinity, mile: null };
    const jc = spurCoords[0];
    for (const v of spine) {
        const d = dEnd(jc, v.coord);
        if (d < junction.d) junction = { d, mile: v.mile };
    }

    // ------------------------------------------------------ interpolation
    function sample(chain, step) {
        const out = [];
        let target = 0, i = 1;
        const total = chain[chain.length - 1].mile;
        while (target <= total + 1e-9) {
            while (i < chain.length && chain[i].mile < target) i++;
            if (i >= chain.length) { out.push({ coord: chain[chain.length - 1].coord, mile: total }); break; }
            const a = chain[i - 1], b = chain[i];
            const span = b.mile - a.mile;
            const t = span > 0 ? (target - a.mile) / span : 0;
            out.push({
                coord: [a.coord[0] + (b.coord[0] - a.coord[0]) * t,
                        a.coord[1] + (b.coord[1] - a.coord[1]) * t],
                mile: target,
            });
            target = r3(target + step);
        }
        return out;
    }
    const mainSamples = sample(spine, STEP_MI);
    const spurSamples = sample(spur, STEP_MI);

    // CT/MA boundary: the first mile past which the spine never returns to CT.
    let boundaryMile = null;
    for (let k = mainSamples.length - 1; k >= 0; k--) {
        if (mainSamples[k].coord[1] < CT_MA_BORDER_LAT) { boundaryMile = mainSamples[k + 1]?.mile ?? null; break; }
    }
    if (boundaryMile == null) throw new Error('could not locate CT/MA boundary on the spine');

    const SECTIONS = {
        ct:   { id: 'ct-guilford',   name: 'Connecticut — Guilford Terminus',   region_id: 'ct', region_name: 'Connecticut',   state: 'CT' },
        ma:   { id: 'ma',            name: 'Massachusetts',                     region_id: 'ma', region_name: 'Massachusetts', state: 'MA' },
        spur: { id: 'ct-middletown', name: 'Connecticut — Middletown Terminus', region_id: 'ct', region_name: 'Connecticut',   state: 'CT' },
    };
    const secForMile = m => (m < boundaryMile ? SECTIONS.ct : SECTIONS.ma);
    const pad = n => String(Math.round(n * 1000)).padStart(7, '0');

    const points = [];
    for (const s of mainSamples) {
        const sec = secForMile(s.mile);
        points.push({
            id: `net-main-mi${pad(s.mile)}`,
            lat: r6(s.coord[1]), lon: r6(s.coord[0]),
            mile: r3(s.mile),
            region_id: sec.region_id, region_name: sec.region_name,
            section_id: sec.id, section_name: sec.name,
            sec_mile: r3(sec === SECTIONS.ct ? s.mile : s.mile - boundaryMile),
            route_id: 'main-spine',
            state: sec.state,
        });
    }
    for (const s of spurSamples) {
        const sec = SECTIONS.spur;
        points.push({
            id: `net-spur-mi${pad(s.mile)}`,
            lat: r6(s.coord[1]), lon: r6(s.coord[0]),
            mile: r3(spineMiles + s.mile),
            region_id: sec.region_id, region_name: sec.region_name,
            section_id: sec.id, section_name: sec.name,
            sec_mile: r3(s.mile),
            route_id: 'middletown-spur',
            alt_of: 'main-spine',
            state: sec.state,
        });
    }

    // ------------------------------------------------------ trail.geojson
    const lastMileOfPart = new Map();
    for (const v of spine) lastMileOfPart.set(v.partI, v.mile);
    // Break features at gaps and at the state line, so no line is ever drawn
    // across a gap and every feature carries one honest section.
    const features = [];
    let run = [];
    const flushRun = (sec) => {
        if (run.length < 2) { run = []; return; }
        features.push({
            type: 'Feature',
            properties: {
                section_id: sec.id, section_name: sec.name,
                region_id: sec.region_id, region_name: sec.region_name,
                route_id: 'main-spine',
            },
            geometry: { type: 'LineString', coordinates: run.map(v => [r6(v.coord[0]), r6(v.coord[1])]) },
        });
        run = [];
    };
    let runSec = secForMile(0);
    for (const v of spine) {
        const sec = secForMile(v.mile);
        if (v.firstOfPart || sec !== runSec) {
            const carry = (!v.firstOfPart && run.length) ? run[run.length - 1] : null;
            flushRun(runSec);
            if (carry) run.push(carry); // section change: keep the line continuous
            runSec = sec;
        }
        run.push(v);
    }
    flushRun(runSec);
    features.push({
        type: 'Feature',
        properties: {
            section_id: SECTIONS.spur.id, section_name: SECTIONS.spur.name,
            region_id: SECTIONS.spur.region_id, region_name: SECTIONS.spur.region_name,
            route_id: 'middletown-spur', alt_of: 'main-spine',
        },
        geometry: { type: 'LineString', coordinates: spurCoords.map(c => [r6(c[0]), r6(c[1])]) },
    });

    // Dashed connectors across documented gaps. route_id "roadwalk" is the
    // non-hikeable sense: map.js styles it dashed and skips it when building the
    // hikeable spine, so this makes the break visible without adding mileage or
    // becoming something a segment can be logged against.
    let connectorCount = 0;
    for (const g of gaps) {
        if (!g.known?.connector) continue;
        const sec = secForMile(lastMileOfPart.get(g.afterPart) ?? 0);
        features.push({
            type: 'Feature',
            properties: {
                section_id: sec.id, section_name: sec.name,
                region_id: sec.region_id, region_name: sec.region_name,
                route_id: 'roadwalk',
                gap_id: g.known.id,
                gap_name: g.known.name,
                passable_on_foot: g.known.passable_on_foot,
            },
            geometry: { type: 'LineString', coordinates: [
                [r6(g.from[0]), r6(g.from[1])], [r6(g.to[0]), r6(g.to[1])],
            ] },
        });
        connectorCount++;
    }
    const trailGeojson = { type: 'FeatureCollection', features };

    // ----------------------------------------------------- net_meta.json
    // Every part boundary breaks a trail.geojson feature, so no straight line is
    // ever drawn across one. Only the substantial breaks are reported as gaps
    // though — a sub-quarter-mile join is a seam between the Connecticut and
    // Massachusetts source datasets, not a hole in the trail.
    const gapDetail = gaps
        .filter(g => g.miles >= GAP_REPORT_MI)
        .map(g => {
            const after_mile = r2(lastMileOfPart.get(g.afterPart));
            const base = { after_mile, miles: r2(g.miles),
                           from: [r6(g.from[1]), r6(g.from[0])], to: [r6(g.to[1]), r6(g.to[0])] };
            if (g.known) {
                return { id: g.known.id, name: g.known.name, ...base,
                         passable_on_foot: g.known.passable_on_foot,
                         note: g.known.note, source: g.known.source };
            }
            // Unmatched breaks are reported but not characterised. This one sits
            // between the Menunkatuck and the Mattabesett, which reporting says
            // were connected in 2013 — so it reads more like a hole in the source
            // layer than a gap on the ground. Not asserting either way here.
            return { id: null, name: null, ...base, passable_on_foot: null,
                     note: 'Break in the NPS centerline; cause not established. Not drawn as a connector.' };
        });
    // Starting from Middletown replaces only the spine below the junction, so the
    // alt route is the spur plus everything north of it. With the junction at
    // mile 16.41 that makes the alt LONGER than the main route, not shorter.
    const altMiles = spurMiles + (spineMiles - junction.mile);
    const meta = {
        trail: {
            name: 'New England Trail',
            total_miles: r2(spineMiles + spurMiles),
            spine_miles: r2(spineMiles),
            map_center: [41.9, -72.5],
            map_zoom: 8,
            termini: { south: 'Guilford, CT', north: 'Royalston Falls, MA', alt_south: 'Middletown, CT' },
            source: {
                name: 'NEEN_BND_NationalScenicTrailCenterline_ln',
                publisher: 'National Park Service (CFPA + AMC survey data)',
                url: SERVICE,
                retrieved: new Date().toISOString().slice(0, 10),
            },
        },
        sections: [
            { id: SECTIONS.ct.id,   name: SECTIONS.ct.name,   mile_type: 'spine', mile_start: 0, mile_end: r2(boundaryMile) },
            { id: SECTIONS.ma.id,   name: SECTIONS.ma.name,   mile_type: 'spine', mile_start: r2(boundaryMile), mile_end: r2(spineMiles) },
            { id: SECTIONS.spur.id, name: SECTIONS.spur.name, mile_type: 'spur',  mile_start: 0, mile_end: r2(spurMiles) },
        ],
        spur: {
            name: 'Middletown Connector',
            start_terminus: 'Middletown, CT',
            length_miles: r2(spurMiles),
            junction_spine_mile: r2(junction.mile),
            axis_mile_start: r2(spineMiles),
            axis_mile_end: r2(spineMiles + spurMiles),
        },
        // Real breaks in the official centerline. Mileage is continuous across
        // them (they add no distance) but they are not walkable as drawn.
        gaps: gapDetail,
        // Consumed by TrailTemps' app.js (calcTotalMiles / the direction dropdown).
        direction_options: [
            { id: 'nobo_main', label: 'Northbound — Guilford, CT → Royalston Falls, MA (Main)',  total_miles: r2(spineMiles), uses_spur: false, is_nobo: true  },
            { id: 'nobo_alt',  label: 'Northbound — Middletown, CT → Royalston Falls, MA (Alt.)', total_miles: r2(altMiles),   uses_spur: true,  is_nobo: true  },
            { id: 'sobo_main', label: 'Southbound — Royalston Falls, MA → Guilford, CT (Main)',  total_miles: r2(spineMiles), uses_spur: false, is_nobo: false },
            { id: 'sobo_alt',  label: 'Southbound — Royalston Falls, MA → Middletown, CT (Alt.)', total_miles: r2(altMiles),   uses_spur: true,  is_nobo: false },
        ],
    };

    // ----------------------------------------------------------- writing
    const write = (p, obj) => { fs.writeFileSync(p, JSON.stringify(obj)); return path.relative(process.cwd(), p); };
    const shPoints = path.join(SH_DIR, 'points.json');
    const shTrail  = path.join(SH_DIR, 'trail.geojson');
    for (const [live, bak] of [[shPoints, 'points_backup.json'], [shTrail, 'trail_backup.geojson']]) {
        const b = path.join(SH_DIR, bak);
        if (!fs.existsSync(b) && fs.existsSync(live)) fs.copyFileSync(live, b);
    }
    console.log('\nwrote ' + write(shPoints, points));
    console.log('wrote ' + write(shTrail, trailGeojson));
    console.log('wrote ' + write(path.join(SH_DIR, 'net_meta.json'), meta));

    if (fs.existsSync(TT_DIR)) {
        const ttTrailPath = path.join(TT_DIR, 'trail.geojson');
        const ttBak = path.join(TT_DIR, 'trail_backup.geojson');
        if (!fs.existsSync(ttBak) && fs.existsSync(ttTrailPath)) fs.copyFileSync(ttTrailPath, ttBak);
        // TrailTemps' app.js styles off its own `type`/`section` properties, so
        // carry those alongside the canonical ones rather than replacing them.
        const ttFeatures = trailGeojson.features.map(f => ({
            ...f,
            properties: {
                name: f.properties.route_id === 'middletown-spur'
                    ? 'NET Alternate Southern Terminus Spur'
                    : `NET Main Spine (${f.properties.region_id === 'ma' ? 'North' : 'South'})`,
                type: f.properties.route_id === 'middletown-spur' ? 'spur' : 'main_spine',
                section: f.properties.route_id === 'middletown-spur'
                    ? 'spur'
                    : (f.properties.region_id === 'ma' ? 'north' : 'south'),
                ...f.properties,
            },
        }));
        console.log('wrote ' + write(ttTrailPath, { type: 'FeatureCollection', features: ttFeatures }));

        if (TT_POINTS) {
            const ttPointsPath = path.join(TT_DIR, 'points.json');
            const oldPts = JSON.parse(fs.readFileSync(ttPointsPath, 'utf8'));
            const ttBakP = path.join(TT_DIR, 'points_backup.json');
            if (!fs.existsSync(ttBakP)) fs.copyFileSync(ttPointsPath, ttBakP);
            const ttPts = points.map(p => {
                const isSpur = p.route_id === 'middletown-spur';
                return isSpur
                    ? { ...p, spur: true, spur_mile: p.sec_mile }
                    : { ...p };
            });
            console.log('wrote ' + write(ttPointsPath, ttPts));
            console.log('wrote ' + write(path.join(TT_DIR, 'net_meta.json'), meta));

            // historical_weather.json is keyed by point id, and the ids change
            // because the mile axis did. The normals are a property of a location,
            // not of an id, so re-key each one onto the nearest new point rather
            // than re-fetching seven years of ERA5-Land.
            const oldById = new Map(oldPts.map(o => [String(o.id), o]));
            const histPath = path.join(TT_DIR, 'historical_weather.json');
            const histBak  = path.join(TT_DIR, 'historical_weather_backup.json');
            if (fs.existsSync(histPath)) {
                if (!fs.existsSync(histBak)) fs.copyFileSync(histPath, histBak);
                const hist = JSON.parse(fs.readFileSync(histBak, 'utf8'));
                const remap = [];
                let unmatched = 0;
                for (const entry of hist.points || []) {
                    const src = oldById.get(String(entry.id)) ||
                                (isFinite(entry.lat) ? { lat: entry.lat, lon: entry.lon } : null);
                    if (!src) { unmatched++; continue; }
                    let best = { d: Infinity, p: null };
                    for (const n of ttPts) {
                        const d = hav(src.lat, src.lon, n.lat, n.lon);
                        if (d < best.d) best = { d, p: n };
                    }
                    remap.push({ old_id: String(entry.id), new_id: best.p.id, moved_mi: r3(best.d),
                                 route_id: best.p.route_id, mile: best.p.mile, entry });
                }
                // Two old ids can land on the same new point. normalsByPointId is a
                // Map, so a duplicate would silently overwrite — keep the closer one.
                const winner = new Map();
                for (const r of remap) {
                    const held = winner.get(r.new_id);
                    if (!held || r.moved_mi < held.moved_mi) winner.set(r.new_id, r);
                }
                for (const r of remap) r.dropped = winner.get(r.new_id) !== r;
                hist.points = [...winner.values()].map(r => ({
                    ...r.entry, id: r.new_id,
                    lat: ttPts.find(p => p.id === r.new_id).lat,
                    lon: ttPts.find(p => p.id === r.new_id).lon,
                }));
                const dropped = remap.filter(r => r.dropped);
                hist.meta = { ...(hist.meta || {}), rekeyed: new Date().toISOString().slice(0, 10),
                              rekeyed_from: 'pre-NEEN-rebuild point ids' };
                for (const r of remap) delete r.entry;
                fs.writeFileSync(histPath, JSON.stringify(hist));
                console.log('wrote ' + path.relative(process.cwd(), histPath) + ' (re-keyed)');
                console.log('wrote ' + write(path.join(TT_DIR, 'weather_id_remap.json'), remap));
                const worst = Math.max(...remap.map(r => r.moved_mi));
                console.log(`  normals: ${remap.length} re-keyed, ${hist.points.length} kept, ` +
                            `${dropped.length} collapsed as duplicates, ${unmatched} unmatched, ` +
                            `worst displacement ${worst}mi`);
            }
        }
    } else {
        console.log('\nTrailTemps dir not found; skipped TT outputs');
    }

    // ----------------------------------------------------------- summary
    console.log('\n--- summary ---');
    console.log(`spine        : ${r2(spineMiles)}mi over ${spineParts.length} parts, ${mainSamples.length} points`);
    console.log(`spur         : ${r2(spurMiles)}mi, ${spurSamples.length} points, junction at spine mile ${r2(junction.mile)} (${(junction.d * 5280).toFixed(0)}ft)`);
    console.log(`total        : ${r2(spineMiles + spurMiles)}mi   (trails.js totalMiles is 235)`);
    console.log(`spur axis    : mile ${r2(spineMiles)} -> ${r2(spineMiles + spurMiles)}  (appended; no overlap with spine)`);
    console.log(`CT/MA border : spine mile ${r2(boundaryMile)}`);
    console.log(`gaps         : ${gapDetail.length} real (${gapDetail.map(g => `${g.miles}mi after mile ${g.after_mile}`).join('; ')})`);
    console.log(`               ${gaps.length - gapDetail.length} sub-${GAP_REPORT_MI}mi dataset seams also break features but aren't reported as gaps`);
    console.log(`connectors   : ${connectorCount} dashed non-hikeable (` +
                `${gapDetail.filter(g => g.id).map(g => g.name).join(', ') || 'none'})`);
    console.log(`route gap sum: ${r2(totalGap)}mi — excluded from mileage`);
    console.log(`geojson      : ${features.length} features, ${features.reduce((s, f) => s + f.geometry.coordinates.length, 0)} vertices`);
    console.log(`points       : ${points.length} total @ ${STEP_MI}mi spacing`);
    if (TT_POINTS) {
        console.log('\nTrailTemps: points.json, net_meta.json and re-keyed normals written.');
        console.log('Its app.js reads these values, so they must agree:');
        console.log(`  NET_SPINE_MIN 0 | NET_SPINE_MAX/NET_SPINE_FULL ${r2(spineMiles)} | NET_SPUR_LEN ${r2(spurMiles)} | NET_JUNCTION ${r2(junction.mile)}`);
        console.log('  spur sec_mile 0 is the JUNCTION and runs out to Middletown (alt directions walk it in reverse)');
        console.log(`  section ids are hyphenated: ${SECTIONS.ct.id} / ${SECTIONS.ma.id} / ${SECTIONS.spur.id}`);
    }
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
