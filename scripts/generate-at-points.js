#!/usr/bin/env node
/**
 * generate-at-points.js
 *
 * Generates a high-resolution points.json for the Appalachian Trail.
 *
 * Strategy (anchor-based official mileage):
 *   - The existing points.json has 439 anchor points at 5-mile official AT intervals.
 *   - Each anchor is mapped to a GeoJSON coordinate index using a constrained
 *     forward search — each anchor searches from the previous one's index, so
 *     GeoJSON indices are always monotonically increasing (no out-of-order matches).
 *   - For each anchor interval, the GeoJSON sub-path is walked and intermediate
 *     points at every 0.1 official miles are placed using proportional interpolation.
 *   - Elevation is fetched from USGS 3DEP (lidar-derived where available).
 *
 * Output fields per point: lat, lon, mile, state, elev_ft
 *
 * Run:   node scripts/generate-at-points.js
 * Resume: re-run after interruption — checkpoint file saves progress.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR        = path.join(__dirname, '../public/trails/appalachian-trail/data');
const GEOJSON_PATH    = path.join(DATA_DIR, 'trail.geojson');
const ANCHORS_PATH    = path.join(DATA_DIR, 'points.json');
const OUTPUT_PATH     = path.join(DATA_DIR, 'points.json');
const BACKUP_PATH     = path.join(DATA_DIR, 'points_backup.json');
const CHECKPOINT_PATH = path.join(DATA_DIR, 'points_checkpoint.json');

const INTERVAL_MILES      = 0.1;
const CONCURRENCY         = 20;
const MAX_RETRIES         = 5;
const RETRY_DELAY_BASE_MS = 2000;
const REQUEST_TIMEOUT_MS  = 15000;
const CHECKPOINT_INTERVAL = 500;

// ─── Geometry helpers ─────────────────────────────────────────────────────────

const EARTH_RADIUS_MI = 3958.8;

function haversine(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return EARTH_RADIUS_MI * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Find nearest GeoJSON coord to (lat, lon) searching only from fromIdx onward.
// This constrained search guarantees monotonically increasing indices across anchors.
function findNearestFrom(allCoords, lat, lon, fromIdx) {
    let minDist = Infinity;
    let minIdx = fromIdx;
    for (let i = fromIdx; i < allCoords.length; i++) {
        const d = haversine(lat, lon, allCoords[i][1], allCoords[i][0]);
        if (d < minDist) { minDist = d; minIdx = i; }
        // Stop early once we're clearly moving away (heuristic: 3x growing distance)
        else if (d > minDist * 3 && minDist < 0.1) break;
    }
    return { idx: minIdx, dist: minDist };
}

// Interpolate lat/lon along a sub-path at targetDist from the start.
function interpolateAlongPath(segCoords, cumDists, targetDist) {
    for (let i = 0; i < segCoords.length - 1; i++) {
        if (cumDists[i + 1] >= targetDist - 1e-9) {
            const span = cumDists[i + 1] - cumDists[i];
            const t = span > 0 ? (targetDist - cumDists[i]) / span : 0;
            return {
                lat: segCoords[i][1] + t * (segCoords[i + 1][1] - segCoords[i][1]),
                lon: segCoords[i][0] + t * (segCoords[i + 1][0] - segCoords[i][0]),
            };
        }
    }
    const last = segCoords[segCoords.length - 1];
    return { lat: last[1], lon: last[0] };
}

// ─── Point generation ─────────────────────────────────────────────────────────

function generateSamples(anchors, allCoords) {
    // Pre-compute each anchor's GeoJSON index using constrained forward search.
    // Each anchor searches from the previous anchor's index, so indices are monotonic.
    console.log('  Mapping anchors to GeoJSON coordinates...');
    const anchorIdxs = [];
    let searchFrom = 0;
    for (let ai = 0; ai < anchors.length; ai++) {
        const a = anchors[ai];
        const { idx, dist } = findNearestFrom(allCoords, a.lat, a.lon, searchFrom);
        anchorIdxs.push(idx);
        if (dist > 0.5) {
            console.warn(`  WARN: anchor mile ${a.mile} is ${dist.toFixed(3)} mi from nearest GeoJSON coord`);
        }
        searchFrom = idx; // next anchor must be at same or later index
    }

    const samples = [];

    for (let ai = 0; ai < anchors.length - 1; ai++) {
        const A  = anchors[ai];
        const B  = anchors[ai + 1];
        const iA = anchorIdxs[ai];
        const iB = anchorIdxs[ai + 1];

        // Emit anchor A
        samples.push({ lat: A.lat, lon: A.lon, mile: A.mile, state: A.state });

        if (iB <= iA) {
            // GeoJSON has no distinct coordinates for this interval — interpolate directly
            const officialLen = B.mile - A.mile;
            let m = parseFloat((A.mile + INTERVAL_MILES).toFixed(1));
            while (m < B.mile - 1e-9) {
                const t = (m - A.mile) / officialLen;
                samples.push({
                    lat: parseFloat((A.lat + t * (B.lat - A.lat)).toFixed(6)),
                    lon: parseFloat((A.lon + t * (B.lon - A.lon)).toFixed(6)),
                    mile: parseFloat(m.toFixed(1)),
                    state: A.state,
                });
                m = parseFloat((m + INTERVAL_MILES).toFixed(1));
            }
            continue;
        }

        // Build cumulative distances along the GeoJSON sub-path iA → iB
        const segCoords = allCoords.slice(iA, iB + 1);
        const cumDists = [0];
        for (let i = 0; i < segCoords.length - 1; i++) {
            cumDists.push(cumDists[i] + haversine(
                segCoords[i][1],     segCoords[i][0],
                segCoords[i + 1][1], segCoords[i + 1][0]
            ));
        }
        const geoLen    = cumDists[cumDists.length - 1];
        const officialLen = B.mile - A.mile;

        // Emit intermediate points at 0.1-mile official intervals
        let m = parseFloat((A.mile + INTERVAL_MILES).toFixed(1));
        while (m < B.mile - 1e-9) {
            const f = (m - A.mile) / officialLen;       // fraction of official segment
            const { lat, lon } = interpolateAlongPath(segCoords, cumDists, f * geoLen);
            samples.push({
                lat:   parseFloat(lat.toFixed(6)),
                lon:   parseFloat(lon.toFixed(6)),
                mile:  parseFloat(m.toFixed(1)),
                state: A.state,
            });
            m = parseFloat((m + INTERVAL_MILES).toFixed(1));
        }
    }

    // Emit the final anchor
    const last = anchors[anchors.length - 1];
    samples.push({ lat: last.lat, lon: last.lon, mile: last.mile, state: last.state });

    return samples;
}

// ─── USGS elevation fetch ─────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchElevation(lat, lon, attempt = 0) {
    return new Promise((resolve, reject) => {
        const url = `https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&wkid=4326&units=Feet&includeDate=false`;

        const req = https.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.value == null) throw new Error('null value');
                    resolve(Math.round(json.value));
                } catch (e) {
                    retry(e, lat, lon, attempt, resolve, reject);
                }
            });
        });

        req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
        req.on('error', e => retry(e, lat, lon, attempt, resolve, reject));
    });
}

function retry(err, lat, lon, attempt, resolve, reject) {
    if (attempt < MAX_RETRIES) {
        sleep(RETRY_DELAY_BASE_MS * (attempt + 1))
            .then(() => fetchElevation(lat, lon, attempt + 1))
            .then(resolve, reject);
    } else {
        reject(new Error(`Failed after ${MAX_RETRIES} retries for ${lat},${lon}: ${err.message}`));
    }
}

// ─── Concurrency runner ───────────────────────────────────────────────────────

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
    // Load GeoJSON trail geometry
    const geojson = JSON.parse(fs.readFileSync(GEOJSON_PATH, 'utf8'));
    const segments = geojson.features[0].geometry.coordinates;

    // Segments 0, 1, 4 are the main trail; 2 and 3 are tiny junction connectors.
    // Each segment starts where the previous ended — skip duplicate junction point.
    const allCoords = [];
    for (const segIdx of [0, 1, 4]) {
        const seg = segments[segIdx];
        const start = allCoords.length === 0 ? 0 : 1;
        for (let i = start; i < seg.length; i++) allCoords.push(seg[i]); // [lon, lat]
    }
    console.log(`GeoJSON: ${allCoords.length} coordinates (segments 0, 1, 4)`);

    // Load anchor points (existing points.json — official AT miles at 5-mile intervals)
    const raw = JSON.parse(fs.readFileSync(ANCHORS_PATH, 'utf8'));
    // Guard: if this is already the high-res output (no 'state' at top level doesn't apply;
    // detect by checking if we accidentally loaded a checkpoint or output instead of the anchors)
    if (raw.length > 1000) {
        console.error('ERROR: points.json already appears to be high-res output (>1000 points).');
        console.error('Restore points_backup.json as points.json before re-running.');
        process.exit(1);
    }
    const anchors = raw;
    console.log(`Anchors: ${anchors.length} points (mile ${anchors[0].mile}–${anchors[anchors.length-1].mile})`);

    // Generate high-res sample points
    console.log('\nGenerating sample points...');
    const samples = generateSamples(anchors, allCoords);
    console.log(`Sampled ${samples.length} points at ${INTERVAL_MILES}-mile intervals`);

    // Load checkpoint if resuming after interruption
    let points = samples.map(p => ({ ...p, elev_ft: null }));
    let startIdx = 0;

    if (fs.existsSync(CHECKPOINT_PATH)) {
        const checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
        if (checkpoint.length === samples.length) {
            points = checkpoint;
            startIdx = checkpoint.findIndex(p => p.elev_ft === null);
            if (startIdx === -1) {
                console.log('Checkpoint complete — skipping elevation fetch');
                startIdx = samples.length;
            } else {
                console.log(`Resuming checkpoint at index ${startIdx} (${startIdx} already done)`);
            }
        } else {
            console.log(`Checkpoint size mismatch (${checkpoint.length} vs ${samples.length}) — starting fresh`);
        }
    }

    // Fetch elevations from USGS 3DEP
    if (startIdx < samples.length) {
        const remaining = samples.length - startIdx;
        const estMin = Math.ceil(remaining / CONCURRENCY / 3 / 60);
        console.log(`\nFetching ${remaining} elevations from USGS 3DEP`);
        console.log(`Concurrency: ${CONCURRENCY} | Est. time: ~${estMin} min\n`);

        const startTime = Date.now();
        let lastReport = 0;

        const tasks = points.slice(startIdx).map((pt, localIdx) => async () => {
            const elev = await fetchElevation(pt.lat, pt.lon);
            points[startIdx + localIdx].elev_ft = elev;

            if ((startIdx + localIdx + 1) % CHECKPOINT_INTERVAL === 0) {
                fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(points));
            }
            return elev;
        });

        await runWithConcurrency(tasks, CONCURRENCY, (done, total) => {
            if (done - lastReport >= 250 || done === total) {
                const elapsed = (Date.now() - startTime) / 1000;
                const rate    = (done / elapsed).toFixed(1);
                const etaSec  = Math.round((total - done) / (done / elapsed));
                process.stdout.write(`\r  ${done}/${total} | ${rate} pts/s | ETA ${etaSec}s       `);
                lastReport = done;
            }
        });

        console.log('\n');
    }

    // Back up the original points.json before overwriting
    if (fs.existsSync(OUTPUT_PATH)) {
        fs.copyFileSync(OUTPUT_PATH, BACKUP_PATH);
        console.log(`Backed up original → points_backup.json`);
    }

    // Write compact JSON (minimizes file size for browser loading)
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(points));
    const sizeMB = (fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(2);
    console.log(`Written: points.json (${sizeMB} MB, ${points.length} points)`);

    // Clean up checkpoint
    if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);

    // Summary stats
    const elevs = points.map(p => p.elev_ft).filter(Boolean);
    if (elevs.length) {
        console.log(`\nElevation range: ${Math.min(...elevs).toLocaleString()} ft – ${Math.max(...elevs).toLocaleString()} ft`);
    }

    const stateCounts = {};
    points.forEach(p => { stateCounts[p.state] = (stateCounts[p.state] || 0) + 1; });
    console.log('Points per state:');
    Object.entries(stateCounts).forEach(([s, n]) => console.log(`  ${s}: ${n}`));
}

main().catch(e => {
    console.error('\nFATAL:', e.message);
    process.exit(1);
});
