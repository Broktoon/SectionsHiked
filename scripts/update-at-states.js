#!/usr/bin/env node
/**
 * update-at-states.js
 *
 * Corrects the 'state' field on every point in points.json by testing whether
 * each lat/lon coordinate falls within US state boundary polygons (point-in-polygon).
 *
 * This replaces the previous approach of inheriting the state label from the
 * 5-mile anchor, which was geographically inaccurate near state borders.
 *
 * Data source: US state boundaries GeoJSON from the US Census Bureau simplified
 * cartographic boundaries (500k resolution), cached locally after first download.
 *
 * Run: node scripts/update-at-states.js
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const POINTS_PATH  = path.join(__dirname, '../public/trails/appalachian-trail/data/points.json');
const CACHE_DIR    = path.join(__dirname, 'cache');
const STATES_CACHE = path.join(CACHE_DIR, 'us_states.geojson');

// States the AT passes through (name as it appears in Census GeoJSON → abbreviation)
const AT_STATES = {
    'Georgia':        'GA',
    'North Carolina': 'NC',
    'Tennessee':      'TN',
    'Virginia':       'VA',
    'West Virginia':  'WV',
    'Maryland':       'MD',
    'Pennsylvania':   'PA',
    'New Jersey':     'NJ',
    'New York':       'NY',
    'Connecticut':    'CT',
    'Massachusetts':  'MA',
    'Vermont':        'VT',
    'New Hampshire':  'NH',
    'Maine':          'ME',
};

// ─── Geometry helpers ─────────────────────────────────────────────────────────

// Ray-casting point-in-polygon for a single ring (array of [lon, lat] pairs).
function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        if (((yi > lat) !== (yj > lat)) &&
            (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

// Test point against a GeoJSON geometry (Polygon or MultiPolygon).
// GeoJSON Polygon: coordinates = [outerRing, ...holes]
// GeoJSON MultiPolygon: coordinates = [[outerRing, ...holes], ...]
function pointInGeometry(lon, lat, geometry) {
    if (geometry.type === 'Polygon') {
        const [outer, ...holes] = geometry.coordinates;
        if (!pointInRing(lon, lat, outer)) return false;
        for (const hole of holes) {
            if (pointInRing(lon, lat, hole)) return false; // inside a hole
        }
        return true;
    }
    if (geometry.type === 'MultiPolygon') {
        for (const polygon of geometry.coordinates) {
            const [outer, ...holes] = polygon;
            if (!pointInRing(lon, lat, outer)) continue;
            let inHole = false;
            for (const hole of holes) {
                if (pointInRing(lon, lat, hole)) { inHole = true; break; }
            }
            if (!inHole) return true;
        }
        return false;
    }
    return false;
}

// Compute bounding box for a geometry — used for fast pre-rejection.
function getBBox(geometry) {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    const rings = geometry.type === 'Polygon'
        ? geometry.coordinates
        : geometry.coordinates.flat(1);
    for (const ring of rings) {
        for (const [lon, lat] of ring) {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        }
    }
    return { minLon, maxLon, minLat, maxLat };
}

// ─── State boundary download ──────────────────────────────────────────────────

function fetchRaw(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, res => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchRaw(res.headers.location).then(resolve, reject);
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.setTimeout(30000, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

async function loadStateBoundaries() {
    if (fs.existsSync(STATES_CACHE)) {
        console.log('  Using cached state boundaries');
        return JSON.parse(fs.readFileSync(STATES_CACHE, 'utf8'));
    }

    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    // Census Bureau cartographic boundary simplified (500k resolution), GeoJSON format.
    // This is the authoritative US government source.
    const url = 'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json';
    console.log('  Downloading US state boundaries...');
    const raw = await fetchRaw(url);
    const geojson = JSON.parse(raw);
    fs.writeFileSync(STATES_CACHE, raw);
    console.log(`  Downloaded ${geojson.features.length} state/territory features`);
    return geojson;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    // Load points
    const points = JSON.parse(fs.readFileSync(POINTS_PATH, 'utf8'));
    if (points.length < 1000) {
        console.error('ERROR: points.json appears to be the original 5-mile anchor file, not the high-res output.');
        process.exit(1);
    }
    console.log(`Loaded ${points.length.toLocaleString()} points from points.json\n`);

    // Load state boundaries
    console.log('Loading US state boundaries...');
    const statesGeojson = await loadStateBoundaries();

    // Filter to AT states only and pre-compute bounding boxes
    const atStates = statesGeojson.features
        .filter(f => {
            const name = f.properties.name || f.properties.NAME || f.properties.NAME_1;
            return name && AT_STATES[name];
        })
        .map(f => {
            const name = f.properties.name || f.properties.NAME || f.properties.NAME_1;
            return {
                abbrev: AT_STATES[name],
                name,
                geometry: f.geometry,
                bbox: getBBox(f.geometry),
            };
        });

    console.log(`  Using ${atStates.length} AT state boundaries: ${atStates.map(s => s.abbrev).join(', ')}\n`);

    if (atStates.length === 0) {
        console.error('ERROR: No AT states found in boundary data. Check property field names.');
        // Debug: show available property keys
        const sample = statesGeojson.features[0];
        console.error('Sample feature properties:', JSON.stringify(sample.properties));
        process.exit(1);
    }

    // Classify each point
    console.log('Classifying points by state...');
    const startTime = Date.now();
    let changed = 0;
    let unmatched = 0;
    const unmatchedExamples = [];

    for (let i = 0; i < points.length; i++) {
        const { lat, lon, state: oldState } = points[i];

        let newState = null;

        // Check bounding box first (fast rejection), then full polygon test
        for (const s of atStates) {
            if (lon < s.bbox.minLon || lon > s.bbox.maxLon ||
                lat < s.bbox.minLat || lat > s.bbox.maxLat) continue;
            if (pointInGeometry(lon, lat, s.geometry)) {
                newState = s.abbrev;
                break;
            }
        }

        // The AT travels back and forth across the NC/TN border for ~200 miles.
        // Combine them into a single indicator rather than assigning one or the other.
        if (newState === 'NC' || newState === 'TN') newState = 'NC-TN';

        if (newState === null) {
            // Point not matched — GPS noise or near state border.
            // Keep the old state rather than blanking it.
            unmatched++;
            if (unmatchedExamples.length < 5) {
                unmatchedExamples.push(`mile ${points[i].mile} (${lat}, ${lon})`);
            }
        } else if (newState !== oldState) {
            points[i].state = newState;
            changed++;
        }

        if ((i + 1) % 2000 === 0) {
            process.stdout.write(`\r  ${(i + 1).toLocaleString()}/${points.length.toLocaleString()} points...`);
        }
    }

    process.stdout.write('\r');
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  Done in ${elapsed}s`);
    console.log(`  Changed: ${changed.toLocaleString()} | Unmatched (kept old value): ${unmatched}\n`);

    if (unmatchedExamples.length > 0) {
        console.log('  Unmatched examples:');
        unmatchedExamples.forEach(e => console.log(`    ${e}`));
        console.log();
    }

    // Save updated points.json
    fs.writeFileSync(POINTS_PATH, JSON.stringify(points));
    console.log(`Saved updated points.json`);

    // Summary: points per state
    const stateCounts = {};
    points.forEach(p => { stateCounts[p.state] = (stateCounts[p.state] || 0) + 1; });
    console.log('\nPoints per state (geographic):');
    Object.entries(stateCounts)
        .sort((a, b) => b[1] - a[1])
        .forEach(([s, n]) => console.log(`  ${s}: ${n.toLocaleString()}`));
}

main().catch(e => {
    console.error('\nFATAL:', e.message);
    process.exit(1);
});
