#!/usr/bin/env node
/**
 * build-at-data.js
 *
 * Builds authoritative trail.geojson and points.json for the Appalachian Trail.
 *
 * Data sources:
 *   - Trail geometry: PASDA/ATC GPS survey data via Penn State ArcGIS FeatureServer
 *     (4,549 GPS-surveyed segments from the Appalachian Trail Conservancy)
 *   - Mile markers: existing points.json anchor points (5-mile intervals, official AT miles)
 *     — both datasets are from ATC GPS surveys so they align well
 *   - Elevation: USGS 3DEP via Elevation Point Query Service (lidar-derived where available)
 *
 * Outputs:
 *   - public/trails/appalachian-trail/data/trail.geojson   (replaces simplified/broken version)
 *   - public/trails/appalachian-trail/data/points.json     (0.1-mile intervals, with elevation)
 *
 * Intermediate files (safe to delete after success):
 *   - scripts/cache/at_pasda_raw.json      (cached PASDA download — skip re-download on re-run)
 *   - .../data/points_checkpoint.json      (elevation fetch progress — auto-deleted on success)
 *   - .../data/points_backup.json          (backup of original points.json)
 *   - .../data/trail_backup.geojson        (backup of original trail.geojson)
 *
 * Run:   node scripts/build-at-data.js
 * Resume: re-run after interruption — PASDA download and elevation checkpoint are preserved.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR     = path.join(__dirname, '../public/trails/appalachian-trail/data');
const CACHE_DIR    = path.join(__dirname, 'cache');
const PASDA_CACHE  = path.join(CACHE_DIR, 'at_pasda_raw.json');
const ELEV_CACHE   = path.join(CACHE_DIR, 'at_elevations.json');
const ANCHORS_PATH = path.join(DATA_DIR, 'points.json');
const GEOJSON_OUT  = path.join(DATA_DIR, 'trail.geojson');
const POINTS_OUT   = path.join(DATA_DIR, 'points.json');
const GEOJSON_BAK  = path.join(DATA_DIR, 'trail_backup.geojson');
const POINTS_BAK   = path.join(DATA_DIR, 'points_backup.json');
const CHECKPOINT   = path.join(DATA_DIR, 'points_checkpoint.json');

// ─── Config ───────────────────────────────────────────────────────────────────

const PASDA_URL    = 'https://mapservices.pasda.psu.edu/server/rest/services/pasda/AppalachianTrail/MapServer/0';
const BATCH_SIZE   = 1000;
const INTERVAL_MI  = 0.1;
const CONCURRENCY  = 20;
const MAX_RETRIES  = 5;
const RETRY_BASE   = 2000;   // ms; multiplied by attempt number
const REQ_TIMEOUT  = 15000;  // ms
const CHKPT_EVERY  = 500;    // save checkpoint every N elevations

// Anchor state boundaries derived from original points.json (midpoints between states)
const STATE_BOUNDS = [
    { state: 'GA', max:   77.5 },
    { state: 'NC', max:  177.5 },
    { state: 'TN', max:  457.5 },
    { state: 'VA', max: 1017.5 },
    { state: 'MD', max: 1057.5 },
    { state: 'PA', max: 1287.5 },
    { state: 'NJ', max: 1357.5 },
    { state: 'NY', max: 1447.5 },
    { state: 'CT', max: 1497.5 },
    { state: 'MA', max: 1587.5 },
    { state: 'VT', max: 1737.5 },
    { state: 'NH', max: 1897.5 },
    { state: 'ME', max: Infinity },
];

// ─── Utilities ────────────────────────────────────────────────────────────────

const R = 3958.8; // Earth radius in miles

function haversine(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function coordDist([lon1, lat1], [lon2, lat2]) {
    return haversine(lat1, lon1, lat2, lon2);
}

function getState(mile) {
    return STATE_BOUNDS.find(b => mile <= b.max).state;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function fmt(n) { return n.toLocaleString(); }

// ─── PASDA download ───────────────────────────────────────────────────────────

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
            });
        });
        req.setTimeout(60000, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

async function downloadPasdaSegments() {
    if (fs.existsSync(PASDA_CACHE)) {
        console.log(`  Using cached PASDA data: ${PASDA_CACHE}`);
        return JSON.parse(fs.readFileSync(PASDA_CACHE));
    }

    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    console.log('  Downloading PASDA/ATC GPS segments...');
    const allFeatures = [];
    let offset = 0;

    while (true) {
        const url = `${PASDA_URL}/query?where=1%3D1` +
            `&outFields=OBJECTID%2CLENGTH_MI` +
            `&returnGeometry=true&geometryPrecision=6` +
            `&f=geojson&orderByFields=OBJECTID` +
            `&resultRecordCount=${BATCH_SIZE}&resultOffset=${offset}`;

        process.stdout.write(`\r    Fetched ${fmt(allFeatures.length)} segments...`);
        const data = await fetchJson(url);

        if (!data.features || data.features.length === 0) break;
        allFeatures.push(...data.features);
        offset += data.features.length;

        if (data.features.length < BATCH_SIZE) break; // last page
    }

    console.log(`\r    Downloaded ${fmt(allFeatures.length)} segments          `);
    fs.writeFileSync(PASDA_CACHE, JSON.stringify(allFeatures));
    return allFeatures;
}

// ─── Stitch segments ──────────────────────────────────────────────────────────

// Join PASDA segments into an ordered coordinate array using greedy
// nearest-neighbor endpoint matching. OBJECTID order is NOT reliable —
// segments are organized per trail club submission, not geographic order.
//
// Algorithm:
//   1. Seed from the southernmost segment (Springer Mountain, GA).
//   2. Repeatedly find the unvisited segment whose nearest endpoint is closest
//      to the current trail end; flip if needed; append.
//   3. When no unvisited segment is within GAP_THRESHOLD_MI, start a new run.
//      (Genuine gaps exist between some trail club sections.)
function stitchSegments(features) {
    const GAP_THRESHOLD_MI = 2.0; // max gap to bridge before starting a new run

    // Normalize each feature to { start, end, coords } for fast lookup
    const segs = features.map(f => {
        const raw = f.geometry.coordinates;
        const coords = f.geometry.type === 'MultiLineString' ? raw.flat() : raw;
        return { coords, used: false };
    }).filter(s => s.coords && s.coords.length >= 2);

    // Seed: find the segment closest to Springer Mountain (AT southern terminus)
    const SPRINGER = [-84.19388, 34.62677]; // [lon, lat]
    let bestSeedDist = Infinity, seedIdx = 0;
    for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const d = Math.min(
            coordDist(SPRINGER, s.coords[0]),
            coordDist(SPRINGER, s.coords[s.coords.length - 1])
        );
        if (d < bestSeedDist) { bestSeedDist = d; seedIdx = i; }
    }

    const runs = [];
    let currentRun = [];
    let currentEnd = null;

    // Build a flat array of { seg, endpointCoord, isEnd } for fast scanning
    // We rebuild this view each step (fine for n=4549)
    function appendSeg(seg, flipped) {
        const c = flipped ? [...seg.coords].reverse() : seg.coords;
        const start = currentRun.length === 0 ? 0 : 1; // skip duplicate junction point
        for (let i = start; i < c.length; i++) {
            currentRun.push(c[i]);
        }
        currentEnd = currentRun[currentRun.length - 1];
        seg.used = true;
    }

    // Seed the first segment
    const seed = segs[seedIdx];
    const seedFlipped = coordDist(SPRINGER, seed.coords[seed.coords.length - 1]) <
                        coordDist(SPRINGER, seed.coords[0]);
    appendSeg(seed, seedFlipped);

    const total = segs.length;
    let placed = 1;

    while (placed < total) {
        // Find nearest unused segment endpoint to currentEnd
        let bestDist = Infinity, bestIdx = -1, bestFlip = false;

        for (let i = 0; i < segs.length; i++) {
            if (segs[i].used) continue;
            const s = segs[i].coords;
            const dStart = coordDist(currentEnd, s[0]);
            const dEnd   = coordDist(currentEnd, s[s.length - 1]);
            if (dStart < bestDist) { bestDist = dStart; bestIdx = i; bestFlip = false; }
            if (dEnd   < bestDist) { bestDist = dEnd;   bestIdx = i; bestFlip = true;  }
        }

        if (bestDist <= GAP_THRESHOLD_MI) {
            appendSeg(segs[bestIdx], bestFlip);
        } else {
            // Gap too large — save current run, start fresh
            if (currentRun.length >= 2) runs.push(currentRun);
            currentRun = [];
            currentEnd = null;
            // Seed next run from the nearest unused segment (global search)
            appendSeg(segs[bestIdx], bestFlip);
        }
        placed++;

        if (placed % 500 === 0) {
            process.stdout.write(`\r  Stitched ${placed}/${total} segments...`);
        }
    }

    if (currentRun.length >= 2) runs.push(currentRun);
    process.stdout.write('\r');
    return runs;
}

// ─── Write trail.geojson ──────────────────────────────────────────────────────

function writeTrailGeoJson(runs) {
    const totalCoords = runs.reduce((s, r) => s + r.length, 0);
    console.log(`  Runs: ${runs.length} | Total coordinates: ${fmt(totalCoords)}`);

    const geojson = {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: {
                name: 'Appalachian Trail',
                source: 'PASDA/ATC GPS Survey via Penn State ArcGIS FeatureServer',
            },
            geometry: {
                type: 'MultiLineString',
                coordinates: runs,
            },
        }],
    };

    if (fs.existsSync(GEOJSON_OUT)) {
        fs.copyFileSync(GEOJSON_OUT, GEOJSON_BAK);
        console.log('  Backed up original trail.geojson → trail_backup.geojson');
    }

    fs.writeFileSync(GEOJSON_OUT, JSON.stringify(geojson));
    const sizeMB = (fs.statSync(GEOJSON_OUT).size / 1024 / 1024).toFixed(2);
    console.log(`  Written: trail.geojson (${sizeMB} MB)`);
}

// ─── Point generation ─────────────────────────────────────────────────────────

// Flatten all runs into one coordinate array for distance-based operations.
// Uses a loop instead of spread to avoid V8's call stack limit when runs are large.
function flattenRuns(runs) {
    const coords = [];
    for (const run of runs) {
        if (coords.length > 0) {
            coords.push(null); // gap marker — prevents measuring distance across runs
        }
        for (let i = 0; i < run.length; i++) {
            coords.push(run[i]);
        }
    }
    return coords;
}

// Global nearest-coord search — scans all coords, no forward constraint.
// The constrained search failed because run 0 has local zigzags from the
// greedy stitcher, so some GPS coords appear at earlier array indices than
// expected for NOBO-ordered anchors.
function findNearestGlobal(coords, lat, lon) {
    let minDist = Infinity;
    let minIdx  = 0;
    for (let i = 0; i < coords.length; i++) {
        if (coords[i] === null) continue;
        const d = haversine(lat, lon, coords[i][1], coords[i][0]);
        if (d < minDist) { minDist = d; minIdx = i; }
    }
    return { idx: minIdx, dist: minDist };
}

function interpolateAlongPath(segCoords, cumDists, targetDist) {
    for (let i = 0; i < segCoords.length - 1; i++) {
        if (segCoords[i] === null || segCoords[i + 1] === null) continue;
        if (cumDists[i + 1] >= targetDist - 1e-9) {
            const span = cumDists[i + 1] - cumDists[i];
            const t = span > 0 ? (targetDist - cumDists[i]) / span : 0;
            return {
                lat: segCoords[i][1] + t * (segCoords[i + 1][1] - segCoords[i][1]),
                lon: segCoords[i][0] + t * (segCoords[i + 1][0] - segCoords[i][0]),
            };
        }
    }
    const last = segCoords.filter(Boolean).at(-1);
    return { lat: last[1], lon: last[0] };
}

function generateSamples(anchors, allCoords) {
    // Global search: find nearest GPS coord for every anchor independently.
    // This handles run 0's local zigzags that defeated the forward-constrained search.
    // 439 anchors × ~313K coords ≈ 137M ops — runs in ~5–10s.
    console.log('  Mapping anchors to GPS geometry (global search, ~5-10s)...');
    const anchorIdxs = [];
    let warnCount = 0;

    for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        const { idx, dist } = findNearestGlobal(allCoords, a.lat, a.lon);
        anchorIdxs.push(idx);
        if (dist > 1.0) {
            warnCount++;
            if (warnCount <= 5) console.warn(`  WARN: anchor mile ${a.mile} is ${dist.toFixed(2)} mi from GPS data`);
        }
        if ((i + 1) % 50 === 0) process.stdout.write(`\r    ${i + 1}/${anchors.length} anchors mapped...`);
    }
    process.stdout.write('\r');
    if (warnCount > 5) console.warn(`  WARN: ${warnCount} total anchors >1 mile from GPS data`);
    if (warnCount === 0) console.log('  All anchors within 1 mile of GPS data ✓');

    const samples = [];

    for (let ai = 0; ai < anchors.length - 1; ai++) {
        const A  = anchors[ai];
        const B  = anchors[ai + 1];
        const iA = anchorIdxs[ai];
        const iB = anchorIdxs[ai + 1];

        // Emit anchor A
        samples.push({ lat: A.lat, lon: A.lon, mile: A.mile, state: A.state });

        const officialLen = B.mile - A.mile;

        if (iB <= iA) {
            // No GPS coords for this interval — straight-line interpolation
            let m = parseFloat((A.mile + INTERVAL_MI).toFixed(1));
            while (m < B.mile - 1e-9) {
                const t = (m - A.mile) / officialLen;
                samples.push({
                    lat:   parseFloat((A.lat + t * (B.lat - A.lat)).toFixed(6)),
                    lon:   parseFloat((A.lon + t * (B.lon - A.lon)).toFixed(6)),
                    mile:  parseFloat(m.toFixed(1)),
                    state: A.state,
                });
                m = parseFloat((m + INTERVAL_MI).toFixed(1));
            }
            continue;
        }

        // Extract sub-path, skip null gap markers
        const segCoords = allCoords.slice(iA, iB + 1);
        const cumDists  = [0];
        for (let i = 0; i < segCoords.length - 1; i++) {
            const prev = segCoords[i];
            const next = segCoords[i + 1];
            const d = (prev && next)
                ? haversine(prev[1], prev[0], next[1], next[0])
                : 0; // gap — zero distance contribution
            cumDists.push(cumDists[i] + d);
        }
        const geoLen = cumDists[cumDists.length - 1];

        let m = parseFloat((A.mile + INTERVAL_MI).toFixed(1));
        while (m < B.mile - 1e-9) {
            const f = (m - A.mile) / officialLen;
            const { lat, lon } = interpolateAlongPath(segCoords, cumDists, f * geoLen);
            samples.push({
                lat:   parseFloat(lat.toFixed(6)),
                lon:   parseFloat(lon.toFixed(6)),
                mile:  parseFloat(m.toFixed(1)),
                state: A.state,
            });
            m = parseFloat((m + INTERVAL_MI).toFixed(1));
        }
    }

    // Final anchor
    const last = anchors[anchors.length - 1];
    samples.push({ lat: last.lat, lon: last.lon, mile: last.mile, state: last.state });

    return samples;
}

// ─── USGS elevation fetch ─────────────────────────────────────────────────────

function fetchElevation(lat, lon, attempt = 0) {
    return new Promise((resolve, reject) => {
        const url = `https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&wkid=4326&units=Feet&includeDate=false`;
        const req = https.get(url, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try {
                    const json = JSON.parse(Buffer.concat(chunks).toString());
                    if (json.value == null) throw new Error('null value');
                    resolve(Math.round(json.value));
                } catch (e) {
                    handleRetry(e, lat, lon, attempt, resolve, reject);
                }
            });
        });
        req.setTimeout(REQ_TIMEOUT, () => req.destroy(new Error('timeout')));
        req.on('error', e => handleRetry(e, lat, lon, attempt, resolve, reject));
    });
}

function handleRetry(err, lat, lon, attempt, resolve, reject) {
    if (attempt < MAX_RETRIES) {
        sleep(RETRY_BASE * (attempt + 1))
            .then(() => fetchElevation(lat, lon, attempt + 1))
            .then(resolve, reject);
    } else {
        reject(new Error(`Failed after ${MAX_RETRIES} retries for ${lat},${lon}: ${err.message}`));
    }
}

async function runWithConcurrency(tasks, concurrency, onProgress) {
    const results = new Array(tasks.length);
    let nextIdx = 0;
    let done = 0;

    async function worker() {
        while (nextIdx < tasks.length) {
            const i = nextIdx++;
            results[i] = await tasks[i]();
            onProgress(++done, tasks.length);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    // Load anchors FIRST (before we overwrite points.json later)
    const rawAnchors = JSON.parse(fs.readFileSync(ANCHORS_PATH));
    if (rawAnchors.length > 1000) {
        console.error('ERROR: points.json looks like high-res output (>1000 entries).');
        console.error('Restore points_backup.json as points.json before re-running.');
        process.exit(1);
    }
    const anchors = rawAnchors;
    console.log(`Anchors: ${anchors.length} points (mile ${anchors[0].mile}–${anchors[anchors.length-1].mile})\n`);

    // ── Phase 1: Download PASDA segments ──────────────────────────────────────
    console.log('Phase 1: Downloading PASDA/ATC GPS trail data');
    const features = await downloadPasdaSegments();
    const totalPasdaMiles = features.reduce((s, f) => s + (f.properties.LENGTH_MI || 0), 0);
    console.log(`  ${fmt(features.length)} segments | ${totalPasdaMiles.toFixed(1)} GPS miles\n`);

    // ── Phase 2: Stitch segments ──────────────────────────────────────────────
    console.log('Phase 2: Stitching segments into continuous trail');
    const runs = stitchSegments(features);
    const allCoords = flattenRuns(runs); // includes null gap markers
    const nonNull = allCoords.filter(Boolean);
    console.log(`  ${runs.length} connected run(s) | ${fmt(nonNull.length)} total coordinates\n`);

    // ── Phase 3: Write trail.geojson ──────────────────────────────────────────
    console.log('Phase 3: Writing trail.geojson');
    writeTrailGeoJson(runs);
    console.log();

    // ── Phase 4: Generate sample points ──────────────────────────────────────
    console.log('Phase 4: Generating 0.1-mile sample points');
    const samples = generateSamples(anchors, allCoords);
    console.log(`  ${fmt(samples.length)} points at ${INTERVAL_MI}-mile intervals\n`);

    // ── Phase 5: Elevations (cache-first, USGS fallback) ─────────────────────
    let points = samples.map(p => ({ ...p, elev_ft: null }));

    // Load persistent elevation cache keyed by mile marker.
    // Since every run produces the same mile values (0.0–2190.0 in 0.1 steps),
    // a fully-populated cache means zero USGS requests on re-runs.
    let elevCache = {};
    if (fs.existsSync(ELEV_CACHE)) {
        elevCache = JSON.parse(fs.readFileSync(ELEV_CACHE));
        console.log(`Phase 5: Loaded elevation cache (${fmt(Object.keys(elevCache).length)} entries)`);
    }

    // Apply cached elevations
    let cacheHits = 0;
    points.forEach(p => {
        const cached = elevCache[String(p.mile)];
        if (cached != null) { p.elev_ft = cached; cacheHits++; }
    });

    const toFetch = points.filter(p => p.elev_ft === null);

    if (toFetch.length === 0) {
        console.log(`  All ${fmt(points.length)} elevations from cache — skipping USGS fetch\n`);
    } else {
        console.log(`  ${fmt(cacheHits)} from cache | ${fmt(toFetch.length)} need USGS fetch`);

        // Resume checkpoint if interrupted mid-fetch
        let startIdx = 0;
        if (fs.existsSync(CHECKPOINT)) {
            const chk = JSON.parse(fs.readFileSync(CHECKPOINT));
            if (chk.length === points.length) {
                points = chk;
                startIdx = chk.findIndex(p => p.elev_ft === null);
                if (startIdx === -1) startIdx = points.length;
                else console.log(`  Resuming checkpoint at index ${startIdx}`);
            }
        }

        if (startIdx < points.length) {
            const remaining = points.slice(startIdx).filter(p => p.elev_ft === null).length;
            const estMin = Math.ceil(remaining / CONCURRENCY / 3 / 60);
            console.log(`  Fetching ${fmt(remaining)} from USGS 3DEP | concurrency ${CONCURRENCY} | ~${estMin} min\n`);

            const startTime = Date.now();
            let lastReport = 0;
            const fetchList = points.map((pt, i) => ({ pt, i })).filter(({ pt }) => pt.elev_ft === null);

            const tasks = fetchList.map(({ pt, i }) => async () => {
                const elev = await fetchElevation(pt.lat, pt.lon);
                points[i].elev_ft = elev;
                if ((i + 1) % CHKPT_EVERY === 0) fs.writeFileSync(CHECKPOINT, JSON.stringify(points));
                return elev;
            });

            await runWithConcurrency(tasks, CONCURRENCY, (done, total) => {
                if (done - lastReport >= 250 || done === total) {
                    const elapsed = (Date.now() - startTime) / 1000;
                    const rate    = (done / elapsed).toFixed(1);
                    const eta     = Math.round((total - done) / (done / elapsed));
                    process.stdout.write(`\r  ${fmt(done)}/${fmt(total)} | ${rate} pts/s | ETA ${eta}s       `);
                    lastReport = done;
                }
            });
            console.log('\n');
        }

        // Persist elevation cache for future re-runs
        points.forEach(p => { if (p.elev_ft != null) elevCache[String(p.mile)] = p.elev_ft; });
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(ELEV_CACHE, JSON.stringify(elevCache));
        console.log(`  Saved elevation cache (${fmt(Object.keys(elevCache).length)} entries)\n`);
    }

    // ── Phase 6: Write points.json ────────────────────────────────────────────
    console.log('Phase 6: Writing points.json');
    if (fs.existsSync(POINTS_OUT)) {
        fs.copyFileSync(POINTS_OUT, POINTS_BAK);
        console.log('  Backed up original → points_backup.json');
    }
    fs.writeFileSync(POINTS_OUT, JSON.stringify(points));
    const pSize = (fs.statSync(POINTS_OUT).size / 1024 / 1024).toFixed(2);
    console.log(`  Written: points.json (${pSize} MB, ${fmt(points.length)} points)`);

    if (fs.existsSync(CHECKPOINT)) fs.unlinkSync(CHECKPOINT);

    // ── Summary ───────────────────────────────────────────────────────────────
    const elevs = points.map(p => p.elev_ft).filter(Boolean);
    if (elevs.length) {
        console.log(`\nElevation range: ${fmt(Math.min(...elevs))} ft – ${fmt(Math.max(...elevs))} ft`);
    }
    const stateCounts = {};
    points.forEach(p => { stateCounts[p.state] = (stateCounts[p.state] || 0) + 1; });
    console.log('Points per state:');
    Object.entries(stateCounts).forEach(([s, n]) => console.log(`  ${s}: ${n}`));

    console.log('\nDone. Both trail.geojson and points.json have been updated.');
    console.log('Backups saved as trail_backup.geojson and points_backup.json.');
    console.log('Verify in the app before deleting scripts/cache/at_pasda_raw.json.');
}

main().catch(e => {
    console.error('\nFATAL:', e.message);
    process.exit(1);
});
