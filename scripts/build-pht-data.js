#!/usr/bin/env node
/**
 * build-pht-data.js
 *
 * Rebuilds the Potomac Heritage Trail data files on the canonical points.json
 * schema, from the NPS POHE Trail Centerline hosted layer.
 *
 * WHY A REBUILD
 *
 * The files this replaces are the last legacy pair alongside Florida's, and the
 * axis underneath them is not recoverable:
 *
 *   1. A THIRD OF THE POINTS HAVE NO MILE AT ALL. 3,063 of 8,888 carried
 *      `on_spine: false` and no `mile` - all of Virginia plus the Eastern
 *      Continental Divide loop - so they could not be placed, sliced or logged.
 *      `on_spine` was a PHT-only invention; nothing else in either app reads it.
 *
 *   2. THE AXIS ON THE OTHER TWO THIRDS DOUBLED BACK. Southern Maryland
 *      revisited itself (mile 23.5 and mile 210.5 are the same ground; 57.5 ~
 *      205.5; 95.5 ~ 204) and then made a 54.3-mile straight-line jump at mile
 *      216.586 to reach DC. That is the greedy-chainer orphan-run signature the
 *      NCT and CDT rebuilds fixed.
 *
 *   3. THE DC BRANCHES WERE BOTH TAGGED AS ALTERNATES, so the main axis had a
 *      12.3-mile hole there, and neither branch's endpoints landed where the
 *      metadata claimed - the DC River Trail's west end sat 5.9mi from the C&O
 *      start it was supposed to meet, and the City Park Trail's 18.8mi from
 *      anything, its nearest main point being in Pennsylvania. The City Park
 *      mile range was also its own 29mi length laid straight onto the shared
 *      axis rather than interpolated across branch->rejoin, which is the same
 *      defect the IAT migration hit with `alt_mile`.
 *
 *   4. Legacy schema throughout: `region` (a bare slug, no name), `section_mile`
 *      rather than `sec_mile`, `alt_id` where map.js looks for `alt_of`, and no
 *      `route_id` or `state` at all - though shared map.js reads `p.state`.
 *
 * THE SPINE. Agreed with the user, and it is not the shortest path:
 *
 *   Laurel Ridge PA -> Great Allegheny Passage -> C&O Canal Towpath ->
 *   Washington DC via the CITY PARK route (Civil War Defenses / Fort Circle) ->
 *   Southern Maryland -> Point Lookout MD.
 *
 * Choosing DC's City Park route over the River Trail is a deliberate change
 * from what TrailTemps shipped. Shortest path picks it anyway, so no forcing is
 * needed there - but shortest path gets Southern Maryland WRONG TWICE, and the
 * fix is to route through the waypoints NPS itself publishes. See VIA below.
 *
 * SIX AND A HALF MILES OF THE SOURCE ARE DIGITIZED TWICE, and the duplicates
 * have to go before anything is classified or measured. Stage 2 detects them
 * rather than trusting this list, but what it should find is:
 *
 *   OID 343 (Trail)   == OID 302 part 1    3.50mi
 *   OID 342 (Road)    == OID 302 part 2    1.59mi
 *   OID 256           inside OID 278       1.18mi
 *   OID 1471          inside OID 39        0.28mi   (Northern Virginia)
 *   OID 1615          == OID 1677          0.13mi   (DC)
 *
 * OID 302 is a multipart aggregate exactly equal to 343 + 342 (5.089 = 3.502 +
 * 1.588). The aggregate is dropped and the individuals kept, because THEY CARRY
 * THE BETTER SURFACE TAGS - 302 calls Road what 343 calls Trail, which is worth
 * 3.5mi of correctly-classified tread. Deduping also dissolves one of four
 * apparent "loops" outright (the Piscataway one was nothing but OID 256 lying on
 * OID 278) and collapses another's 3.51mi "stub" to 0.01mi.
 *
 * T-JUNCTIONS, 50 OF THEM, MOST AT EXACTLY 0.0000 MI OFFSET. Splitting parts
 * where another part's endpoint lands on their interior takes the source from 58
 * connected components to 32 and is what lets the spine assemble at all. 18 of
 * the 50 are other segments joining the middle of the Tidewater bicycle route.
 * This must happen BEFORE spine-vs-off-spine classification: classifying whole
 * source parts is exactly the bug that shipped on the NET.
 *
 * TWO CONNECTORS, DECLARED BY COORDINATE, NEVER BY TOLERANCE. Measured
 * perpendicular to the line (per the CDT lesson), the four spine joins are:
 *
 *   Laurel Highlands <-> GAP        0 ft     Ohiopyle
 *   GAP <-> C&O Canal             600 ft     Cumberland MD
 *   C&O <-> Washington DC           0 ft     Georgetown
 *   DC <-> Southern Maryland       53 ft     Oxon Hill MD
 *
 * The Oxon Hill join sits at EXACTLY the node tolerance, so a global tolerance
 * is balanced on a cliff - tighten it and Southern Maryland detaches from the
 * rest of the trail. Both gaps are therefore bridged explicitly by coordinate.
 *
 * ROUTING THROUGH NPS WAYPOINTS, BECAUSE SHORTEST PATH IS WRONG. NPS publishes
 * the Southern Maryland route as named legs with landmarks and mileages, and
 * plain shortest path takes the shortcut leg in two places where the discarded
 * material is the designated route:
 *
 *   Piney Point    - NPS routes via "Flat Iron, St. George's and Drayton roads;
 *                    Route 249/Piney Point Road" with a stop at Piney Point
 *                    Lighthouse. Every one of those names appears as a TRNAME on
 *                    the leg shortest path threw away. The leg it chose passes
 *                    4.00mi from the lighthouse; the discarded one 1.03mi, and
 *                    0.81mi from St. George Island.
 *   Colton's Point - the St. Clement's Island Museum is the published endpoint
 *                    of NPS's 38-mile leg to Port Tobacco. OID 307 passes 0.51mi
 *                    from it; the shortcut 3.02mi.
 *   Leonardtown    - here shortest path was already right (0.23mi from
 *                    Leonardtown Wharf, against 1.41mi for the alternative).
 *
 * THE CHECK THAT CONFIRMS IT: NPS publishes Point Lookout -> Leonardtown as
 * "approximately 45 miles ... with a stop at Piney Point Lighthouse". Routed
 * through the waypoints this build gets 46.05mi. Routed without the Piney Point
 * out-and-back it gets 36.17mi. So the published mileage includes walking out to
 * the lighthouse and back, which settles that those miles are route, not spur.
 * It is also the only external mileage available anywhere on this trail, and it
 * was not fitted to.
 *
 * DO NOT CHASE NPS's 38 MILES for Colton's Point -> Port Tobacco. This build
 * routes 51.92mi there and that is correct: 19 of 22 features are traversed
 * whole, only two nodes on the leg offer any choice at all, and the extra miles
 * are the corridor detouring inland to pick up the THREE NOTCH TRAIL rail-trail
 * (OID 334, TYPEOFROUTE Trail). Adventure Cycling's 38-mile ride goes direct
 * instead. Strip the material that makes no progress toward Port Tobacco and
 * this axis gives 37.54mi.
 *
 * TWO OUT-AND-BACKS STAY ON THE AXIS. Piney Point Rd (4.94mi each way) and
 * Colton Point Rd (3.06mi each way) are genuine dead ends - Piney Point Rd's
 * south end has no other feature within half a mile - and the user chose to keep
 * them on the mile axis rather than model them as spurs, because NPS's own
 * mileage includes them. The cost is that 7.99mi of tread carries two different
 * mile values (Piney Point Rd at 23.66 and 28.59, Colton Point Rd at 57.72 and
 * 60.78). Both passes reuse the same source vertices, so map.js's
 * _nearestTrailIndex keeps the first on a tie and clicks resolve to the OUTBOUND
 * pass, deterministically. Overlay drawing is unaffected - it is the same ground
 * either way - but mile attribution credits 4.94mi rather than the 9.88 walked.
 * This is reversible: see OUT_AND_BACK_ON_AXIS.
 *
 * ROUTE_KIND, and why Virginia is `side` rather than `alternate`. The test is
 * SUBSTITUTION, NOT TOPOLOGY:
 *
 *   spine      - the through-route.
 *   alternate  - may be walked INSTEAD OF part of the spine, including an
 *                alternate start or finish. PHT's is the DC River Trail leg and
 *                the loop legs not taken.
 *   side       - ADDITIONAL to the spine, never a substitute; hiking it replaces
 *                no spine mileage. Virginia's 25 disconnected components, the
 *                Mount Vernon Trail, the Eastern Continental Divide loop.
 *
 * "Leaves and rejoins the spine" is the wrong definition of alternate - an
 * alternate terminus never rejoins. There is deliberately no separate `spur`
 * kind: whether a route attaches to the spine depends entirely on snap
 * tolerance (54mi reads attached and 298mi detached at 53ft here, and a piece
 * 60ft away flips), and nothing downstream distinguishes them. A junction on the
 * spine is a PROPERTY - `junction_mile` - not a category, and it is what the
 * app's mixed-route auto-split needs.
 *
 * SECTIONS ARE NULL, deliberately, and deferred as a much-later expansion. The
 * fields stay present so a scheme drops in without a second migration.
 * `TRNAME` is not it: it names the host road (Piney Point Rd, Flat Iron Rd), the
 * same pattern rejected for the NCT's `seg_name` and the PNT's `RTE_NAME`. The
 * one real candidate for later is NPS's four named legs, whose boundaries this
 * build already knows because it routes through them - Point Lookout ->
 * Leonardtown, Colton's Point -> Port Tobacco, Port Tobacco -> Smallwood SP,
 * Smallwood SP -> Oxon Cove - but they cover only ~190 of 545 miles, and the C&O
 * (184mi), GAP (72mi) and Laurel Highlands (67mi) each have separate schemes
 * from NPS, the Allegheny Trail Alliance and PA DCNR. Mixing them would be
 * inconsistent. With sections null, `sec_mile` is REGION-LOCAL, the same choice
 * the NCT (state-local) and PNT (region-local) builds made.
 *
 * POINT SPACING IS 0.1 MI, not the 0.5 every other rebuild uses. PHT is short
 * enough that ~988mi of material is only ~10k points, and it is the trail that
 * most needs the precision - dense parallel paths in DC and Northern Virginia
 * would snap wrong at 0.5. Going finer was measured and rejected: 32% of trail
 * length sits on source vertex gaps coarser than 0.05mi (60% coarser than
 * 0.02mi), so finer spacing would manufacture points on straight-line
 * interpolation, concentrated in Southern Maryland (median vertex gap 124 ft)
 * and the GAP (125 ft). Where the source IS fine - DC 7 ft, Northern Virginia
 * 12 ft, Laurel Highlands 13 ft - a future targeted move to 0.05 is defensible.
 *
 * Run: node scripts/build-pht-data.js
 *
 * Source: NPS POHE Trail Centerline FTDS view, layer 0
 *   services1.arcgis.com/fBc8EJBxQRMcHlei/.../POHE_Trail_Centerline_FTDS_view
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const CACHE = path.join(__dirname, 'cache');
const DATA  = path.join(__dirname, '..', 'public', 'trails', 'potomac-heritage-trail', 'data');

const TRAIL_CACHE  = path.join(CACHE, 'pht_nps.json');
const STATES_CACHE = path.join(CACHE, 'census_states_pht.geojson');

const ORG     = 'https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services';
const SERVICE = 'POHE_Trail_Centerline_FTDS_view';
// TRSURFACE, TRUSE and TRTYPE are read because the PNT rebuild's lesson is that
// the fields a previous build never asked for are where the surprises live. The
// old PHT build requested only the first eight. TRTYPE is what identifies the
// one paddle route; TRUSE is what identifies the bicycle-designated roads.
const FIELDS  = 'OBJECTID,TRNAME,TRALTNAME,MAPLABEL,TRSTATUS,TYPEOFROUTE,STATE,REGION'
  + ',TRSURFACE,TRUSE,TRTYPE';

// Point spacing, miles. Deliberately finer than the 0.5 used by the CDT, PCT,
// NCT and PNT rebuilds - see the header.
const SPACING = 0.1;

// Endpoint merge tolerance, miles (~53 ft). Unlike the PNT, the value here is
// load-bearing: the DC <-> Southern Maryland join measures exactly 53 ft, so
// anything tighter detaches Southern Maryland from the rest of the trail. That
// is why both real gaps are bridged by declared coordinate instead, and why
// Stage 4 asserts rather than sweeps.
const NODE_TOL = 0.010;

// Duplicate detection: a part at least this covered by one other part's line,
// within DUP_TOL, is a duplicate of it.
const DUP_TOL   = 0.004;   // ~21 ft
const DUP_COVER = 0.90;

// GeoJSON output thinning, metres between retained vertices.
const THIN_M = 20;

// Largest tolerated gap between consecutive emitted geojson features.
const JOIN_MI = 1.0;

// Set false to model the two dead-end out-and-backs as `side` routes instead of
// keeping them on the mile axis. Keeping them is the user's choice (option A,
// 2026-10-15) because NPS's published Point Lookout -> Leonardtown mileage
// includes walking out to Piney Point Lighthouse and back. Flipping this drops
// the spine to ~529mi and breaks agreement with that figure.
const OUT_AND_BACK_ON_AXIS = true;

// The source's REGION values, in spine order first, then the off-spine regions.
const REGIONS = [
  { src: 'Laurel Highlands',          id: 'laurel-highlands',      name: 'Laurel Highlands' },
  { src: 'Great Allegheny Passage',   id: 'great-allegheny-passage', name: 'Great Allegheny Passage' },
  { src: 'Chesapeake and Ohio Canal National Historical Park',
    id: 'co-canal-nhp',               name: 'Chesapeake and Ohio Canal' },
  { src: 'Washington D.C.',           id: 'washington-dc',         name: 'Washington D.C.' },
  { src: 'Southern Maryland',         id: 'southern-maryland',     name: 'Southern Maryland' },
  { src: 'Northern Virginia',         id: 'northern-virginia',     name: 'Northern Virginia' },
  { src: 'Northern Neck of Virginia', id: 'northern-neck-virginia', name: 'Northern Neck of Virginia' },
  // Appeared in the 2026-10 republication, carved out of Northern Virginia
  // (-15.4mi) and Northern Neck (-28.9mi). Off-spine, like both its parents.
  { src: 'Greater Fredericksburg Area', id: 'greater-fredericksburg',
    name: 'Greater Fredericksburg Area' },
  { src: 'Eastern Continental Divide', id: 'eastern-continental-divide',
    name: 'Eastern Continental Divide' },
];
const REGION_BY_SRC = new Map(REGIONS.map(r => [r.src, r]));

const STATES = [
  { abbr: 'MD', fips: '24' },
  { abbr: 'DC', fips: '11' },
  { abbr: 'PA', fips: '42' },
  { abbr: 'VA', fips: '51' },
];

// The source's own surface classification, in TYPEOFROUTE. Both Road and
// Road/Trail become route_type "roadwalk" - the HIKEABLE, counted sense (Ice
// Age, Florida): dashed, but part of the spine and counted. Never route_id
// "roadwalk", which is the non-hikeable gap-connector sense.
const ROUTE_TYPE = { 'Road': 'roadwalk', 'Road/Trail': 'roadwalk', 'Trail': null };

// Bridged by coordinate, not by tolerance. Offsets are perpendicular to the
// line, measured on the 2026-10 source.
const CONNECTORS = [
  { at: [-77.01175, 38.81296], name: 'Oxon Hill (DC / Southern Maryland)',  expectMi: 0.010 },
  { at: [-78.76291, 39.64944], name: 'Cumberland (C&O Canal / GAP)',        expectMi: 0.114 },

];

// Declared joins, added as real (very short) tread rather than as graph edges.
//
// CONNECTORS above bridge two separate COMPONENTS, which is the right test for
// Cumberland. It is the wrong test here: the DC riverside groups are already in
// the same component as everything else, because each of them reaches the
// spine, and the way from one to the next runs along the spine. So a
// component-based bridge finds nothing to do, and the groups stay apart.
//
// These three are added before the node graph is built, so they join the groups
// for clustering, routing and emission alike. What they produce is the DC RIVER
// TRAIL: the riverside alternative through Washington, Georgetown to the
// Anacostia by way of the Potomac River Trail, the SW waterfront streets, the
// Francis Case bridge and the Frederick Douglass Memorial Bridge crossing of
// the Anacostia. TrailTemps models it as its "DC River Trail" branch; this
// source carries all 7.67mi of it but leaves it in four pieces:
//
//   3.90mi  no spine contact   Potomac River Trail, Buckeye Dr, Francis Case
//   2.48mi  spine at 352.2     SW waterfront streets, Anacostia Riverwalk
//   1.18mi  spine at 322.7     C&O towpath east from 34th St NW
//   0.11mi  no spine contact   L'Enfant Prom SW
//
// Joining them costs 753 ft of declared tread in total and yields a route that
// touches the spine at both 322.7 and 352.2 - so the substitution test can see
// it, and it becomes an alternate against 29.5mi of spine rather than a dozen
// unrelated side routes.
// Only two are needed, both at L'Enfant Promenade, and both confirmed by the
// user against the drawn map. The third gap - the river trail's west end up to
// the towpath - needs nothing declared at all: the source already carries it as
// OID 1421, "Key Bridge Connection To Capital Crescent Trail", 231 ft running
// from 2 ft off that west end directly north onto the towpath. An earlier
// version of this build never saw it, because MIN_ROUTE_MI dropped every route
// under 0.1 mi as a fragment and that is where the connectors live.
// Each join NAMES the two pieces it connects, rather than giving a coordinate.
// Picking the two nearest part ends to a point does not work here: splitting at
// junctions leaves several ends within a few feet of each other, so proximity
// alone kept joining a piece to its own neighbour instead of across the gap.
const JOINS = [
  // 69 ft, and the single thing that was keeping the DC river chain in two
  // halves - just over NODE_TOL. The west side is unnamed in the source, so it
  // is addressed by OBJECTID; it shares an endpoint with the Francis Case
  // bridge, and Buckeye Dr carries on west toward the Potomac River Trail.
  { aOid: 1604, b: 'Buckeye Dr SW Sidewalk', expectFt: 69 },
  { a: 'Francis Case Memorial Bridge', b: "L'Enfant Prom SW", expectFt: 267 },
  { a: "L'Enfant Prom SW",             b: 'Maine Ave SW',     expectFt: 235 },
];

// The spine is routed THROUGH these, in order, because shortest path alone
// takes the wrong leg in Southern Maryland twice. Coordinates are the named
// places; the build snaps each to the nearest graph node and reports how far it
// moved. Smallwood State Park and Oxon Cove Park are deliberately NOT via
// points: both sit at the end of short access roads, and forcing the route into
// them added 1.4mi of spurious out-and-back.
const VIA = [
  { name: 'Point Lookout SP',       at: [-76.32211, 38.03917] },
  // Drayden, on the St Mary's peninsula LOOP. The source makes the structure
  // plain: Flat Iron Rd -> St Georges Church Rd -> Drayden Rd reach the
  // peninsula, and Blake Creek Rd (0.56mi) -> Medleys Neck Rd (9.95mi) return
  // from it to Point Lookout Rd. Piney Point Rd (4.21mi) + Lighthouse Rd
  // (1.34mi) hang off that loop as a 5.55mi DEAD END to Piney Point
  // Lighthouse. An earlier version of this build used the lighthouse itself as
  // the via point, which forced the spine out to the tip and back and doubled
  // 5.55mi of tread onto the axis. The lighthouse is the end of a spur, not a
  // place the through-route passes, so the spur is left as a side route and the
  // spine takes the loop. Those are near enough the same length (10.51mi of
  // loop against 10.74mi of out-and-back) that NPS's published mileage still
  // reconciles either way - so the check below did not distinguish them, and
  // the geometry had to.
  { name: 'Drayden',                at: [-76.50820, 38.19030] },
  { name: 'Leonardtown Wharf',      at: [-76.63680, 38.29390] },
  // The St Clement's Island Museum is NOT a via point, for the same reason the
  // lighthouse is not: Colton Point Rd dead-ends there, with Maddox Rd and
  // Oakley Rd carrying the through-route past it. NPS publishes
  // "Colton's Point to Port Tobacco, 38 miles", but that is a day ride's
  // endpoint, not somewhere the spine passes. Routing through it doubled 3.06mi
  // of Colton Point Rd onto the axis.
  { name: 'Port Tobacco MD',        at: [-77.02330, 38.50730] },
  // Fort Circle, on the DC CITY PARK route. Needed only because the River
  // Trail joins above make the riverside chain routable: at ~7.7mi it would
  // otherwise beat the City Park route's ~29.5mi on shortest path and the spine
  // would silently switch. The user chose City Park as the spine, so it is
  // pinned here and the river route becomes the alternate.
  { name: 'Fort Circle DC',         at: [-76.97624, 38.90557] },
  { name: 'Laurel Ridge PA',        at: [-79.00486, 40.40839] },
];

// NPS's published leg mileage, reported as an external comparison.
//
// It is NOT a pass/fail gate, and the reason is worth recording. NPS describes
// Point Lookout -> Leonardtown as "approximately 45 miles ... with a stop at
// Piney Point Lighthouse" - a day ride that detours to the lighthouse and comes
// back. The through-route does not: the lighthouse is the end of a 5.55mi spur
// (Piney Point Rd + Lighthouse Rd) off the St Mary's peninsula loop, so the
// spine takes the loop and leaves the spur as a side route.
//
//   through-route only                        36.21 mi   (-8.8 against 45)
//   through-route + spur walked one way       41.76 mi   (-3.2)
//   through-route + spur out and back         47.31 mi   (+2.3)
//
// An earlier version of this build routed the spine out to the lighthouse
// because 46.94 sat closest to 45, and treated that as confirmation. It was
// not: the figure is consistent with the detour but says nothing about whether
// the through-route takes it, and the geometry says it does not. Reported so
// the discrepancy stays visible rather than being tuned away.
const NPS_CHECK = {
  from: 'Point Lookout SP', to: 'Leonardtown Wharf', miles: 45,
  spurRoundTrip: 11.10,
  note: "NPS's figure is a day ride including the lighthouse detour; the spine is the through-route",
};

// A region excursion shorter than this is absorbed into the region around it,
// so regions tile the axis and sec_mile stays a usable region-local measure.
// Same guard, and same reason, as the NCT build's state weave.
const REGION_MIN_MI = 3;

// ── Geometry helpers ──────────────────────────────────────────────────────────

function haversine(la1, lo1, la2, lo2) {
  const R = 3958.8, t = Math.PI / 180;
  const dLa = (la2 - la1) * t, dLo = (lo2 - lo1) * t;
  const s = Math.sin(dLa / 2) ** 2
    + Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

// coords are [lon, lat] pairs throughout, matching GeoJSON order.
const dist = (a, b) => haversine(a[1], a[0], b[1], b[0]);

function pathLen(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += dist(coords[i - 1], coords[i]);
  return d;
}

// Local planar projection, miles, for perpendicular distance work. Good enough
// over a trail this size and far cheaper than spherical cross-track.
const LAT0 = 38.9;
const KX = 69.172 * Math.cos(LAT0 * Math.PI / 180);
const KY = 69.0;
const xy = c => [c[0] * KX, c[1] * KY];

// Perpendicular distance from p to segment a-b, plus the parameter along it.
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const d2 = dx * dx + dy * dy;
  const t = d2 === 0 ? 0 : Math.max(0, Math.min(1,
    ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d2));
  return { d: Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)), t };
}

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat)
      && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inFeature(lon, lat, geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) {
    const [outer, ...holes] = poly;
    if (!inRing(lon, lat, outer)) continue;
    if (holes.some(h => inRing(lon, lat, h))) continue;
    return true;
  }
  return false;
}

function thinCoords(coords, minDistM) {
  if (coords.length <= 2) return coords;
  const minMi = minDistM / 1609.34;
  const kept = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    if (dist(kept[kept.length - 1], coords[i]) >= minMi) kept.push(coords[i]);
  }
  kept.push(coords[coords.length - 1]);
  return kept;
}

const r6 = n => Math.round(n * 1e6) / 1e6;
const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;
const r3 = n => Math.round(n * 1000) / 1000;

function pointId(routeId, mile) {
  return 'pht-' + routeId + '-mi' + String(Math.round(mile * 1000)).padStart(7, '0');
}

// A coarse spatial index over part segments, for endpoint-to-line queries.
function buildSegIndex(parts, cell = 0.25) {
  const grid = new Map();
  const proj = parts.map(p => p.coords.map(xy));
  for (let i = 0; i < parts.length; i++) {
    const P = proj[i];
    for (let s = 0; s < P.length - 1; s++) {
      for (const pt of [P[s], P[s + 1]]) {
        const k = Math.floor(pt[0] / cell) + ':' + Math.floor(pt[1] / cell);
        let b = grid.get(k);
        if (!b) grid.set(k, b = []);
        b.push([i, s]);
      }
    }
  }
  return {
    proj,
    near(pt, radius = cell) {
      const out = new Set();
      const n = Math.ceil(radius / cell);
      const ci = Math.floor(pt[0] / cell), cj = Math.floor(pt[1] / cell);
      for (let di = -n; di <= n; di++) {
        for (let dj = -n; dj <= n; dj++) {
          const b = grid.get((ci + di) + ':' + (cj + dj));
          if (b) for (const e of b) out.add(e);
        }
      }
      return out;
    },
  };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location));
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('bad JSON from ' + url + ': ' + e.message)); }
      });
    }).on('error', reject);
  });
}

async function fetchLayer(service, layer, fields) {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const url = ORG + '/' + service + '/FeatureServer/' + layer + '/query?where=1%3D1'
      + '&outFields=' + encodeURIComponent(fields)
      + '&returnGeometry=true&outSR=4326&f=json'
      + '&resultRecordCount=1000&resultOffset=' + offset;
    const j = await get(url);
    if (j.error) throw new Error(service + ': ' + JSON.stringify(j.error));
    const f = j.features || [];
    all.push(...f);
    if (f.length < 1000) break;
  }
  return all;
}

// The PNT rebuild found an official surface classification the old build had
// never asked for. Report anything this build is not reading, so the same
// omission cannot hide here.
async function reportUnusedFields(service, layer, requested) {
  try {
    const meta = await get(ORG + '/' + service + '/FeatureServer/' + layer + '?f=json');
    const have = (meta.fields || []).map(f => f.name);
    const want = new Set(requested.split(','));
    const unused = have.filter(n => !want.has(n)
      && !/^(Shape|OBJECTID|GlobalID|SHAPE)/i.test(n));
    if (unused.length) console.log('  source fields NOT read by this build: ' + unused.join(', '));
    else console.log('  reading every attribute field the layer offers');
  } catch (e) {
    console.log('  (could not read layer metadata: ' + e.message + ')');
  }
}

// ── Graph ─────────────────────────────────────────────────────────────────────

// Node ids for part endpoints, merged within tol via a coarse grid.
function buildNodes(parts, tol) {
  const nodes = [];
  const grid = new Map();
  const cellLat = tol / KY, cellLon = tol / KX;
  const key = (lon, lat) => Math.floor(lon / cellLon) + ':' + Math.floor(lat / cellLat);

  const nodeFor = (lon, lat) => {
    const ci = Math.floor(lon / cellLon), cj = Math.floor(lat / cellLat);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const b = grid.get((ci + di) + ':' + (cj + dj));
        if (!b) continue;
        for (const ni of b) {
          if (dist(nodes[ni], [lon, lat]) <= tol) return ni;
        }
      }
    }
    const ni = nodes.length;
    nodes.push([lon, lat]);
    const k = key(lon, lat);
    let b = grid.get(k);
    if (!b) grid.set(k, b = []);
    b.push(ni);
    return ni;
  };

  for (const p of parts) {
    p.n0 = nodeFor(p.coords[0][0], p.coords[0][1]);
    p.n1 = nodeFor(p.coords[p.coords.length - 1][0], p.coords[p.coords.length - 1][1]);
  }
  return nodes;
}

function adjacency(parts, extraEdges = []) {
  const adj = new Map();
  const push = (n, e) => {
    let b = adj.get(n);
    if (!b) adj.set(n, b = []);
    b.push(e);
  };
  parts.forEach((p, i) => {
    push(p.n0, { to: p.n1, len: p.len, part: i });
    push(p.n1, { to: p.n0, len: p.len, part: i });
  });
  for (const e of extraEdges) {
    push(e.a, { to: e.b, len: e.len, part: null, connector: e.name });
    push(e.b, { to: e.a, len: e.len, part: null, connector: e.name });
  }
  return adj;
}

function components(parts) {
  const parent = parts.map((_, i) => i);
  const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  const byNode = new Map();
  parts.forEach((p, i) => {
    for (const n of [p.n0, p.n1]) {
      if (byNode.has(n)) { const a = find(byNode.get(n)), b = find(i); if (a !== b) parent[a] = b; }
      else byNode.set(n, i);
    }
  });
  const groups = new Map();
  parts.forEach((_, i) => {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, g = []);
    g.push(i);
  });
  return [...groups.values()].sort((a, b) =>
    b.reduce((s, i) => s + parts[i].len, 0) - a.reduce((s, i) => s + parts[i].len, 0));
}

function dijkstra(adj, src) {
  const dist = new Map([[src, 0]]);
  const prev = new Map();
  // Simple binary heap keyed on distance.
  const heap = [[0, src]];
  const push = (d, n) => {
    heap.push([d, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (d > (dist.get(u) ?? Infinity) + 1e-12) continue;
    for (const e of adj.get(u) || []) {
      const nd = d + e.len;
      if (nd < (dist.get(e.to) ?? Infinity) - 1e-12) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: u, part: e.part, connector: e.connector });
        push(nd, e.to);
      }
    }
  }
  return { dist, prev };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });
  if (!fs.existsSync(DATA)) throw new Error('missing output directory: ' + DATA);

  // ── Stage 1: source ────────────────────────────────────────────────────────
  console.log('=== Stage 1: source ===');
  if (!fs.existsSync(TRAIL_CACHE)) {
    console.log('  fetching NPS POHE centerline ...');
    fs.writeFileSync(TRAIL_CACHE, JSON.stringify(await fetchLayer(SERVICE, 0, FIELDS)));
  }
  if (!fs.existsSync(STATES_CACHE)) {
    console.log('  states: fetching Census TIGERweb boundaries ...');
    const where = "STATE IN ('" + STATES.map(s => s.fips).join("','") + "')";
    fs.writeFileSync(STATES_CACHE, JSON.stringify(await get(
      'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County'
      + '/MapServer/0/query?where=' + encodeURIComponent(where)
      + '&outFields=NAME,STATE&outSR=4326&f=geojson')));
  }
  await reportUnusedFields(SERVICE, 0, FIELDS);

  const raw = JSON.parse(fs.readFileSync(TRAIL_CACHE, 'utf8'));
  const statesGeo = JSON.parse(fs.readFileSync(STATES_CACHE, 'utf8'));
  const noGeom = raw.filter(f => !f.geometry || !f.geometry.paths);
  console.log('  ' + raw.length + ' source features'
    + (noGeom.length ? ', ' + noGeom.length + ' with no geometry (dropped: OID '
      + noGeom.map(f => f.attributes.OBJECTID).join(', ') + ')' : ''));

  const unknownRegions = [...new Set(raw.map(f => f.attributes.REGION))]
    .filter(r => r !== null && !REGION_BY_SRC.has(r));
  if (unknownRegions.length) {
    throw new Error('source REGION values not in REGIONS: ' + unknownRegions.join(' | '));
  }

  // ── Stage 2: parts, then dedupe ────────────────────────────────────────────
  console.log('\n=== Stage 2: parts and duplicate geometry ===');
  let parts = [];
  let paddleMi = 0, paddleN = 0;
  const paddleParts = [];
  for (const f of raw) {
    if (!f.geometry || !f.geometry.paths) continue;
    // The one paddle route in the layer: TRTYPE "Water Trail", TRUSE
    // "Paddle|Kayak", TRSURFACE "Water" - the Youghiogheny River Trail, in the
    // Eastern Continental Divide region. Three attributes agree, and it runs
    // 5.8-18.8mi from the GAP, so it is the river itself rather than a
    // mis-tagged rail-trail despite "Trail" in its name.
    //
    // Handled exactly as the PNT handles its Puget Sound ferry: DRAWN so the
    // corridor reads completely, but carrying no mileage and no points.json
    // entries. It gets route_id "roadwalk" - the NON-hikeable sense of that tag
    // (Natchez's parkway, the NET's Connecticut River) - which map.js drops
    // from the spine, plus segment_type "paddle" because it is not a road. It
    // deliberately has NO route_kind: that vocabulary describes hikeable route,
    // and a paddle route is outside it, so it belongs to neither badge.
    if (f.attributes.TRTYPE === 'Water Trail' || /paddle|kayak/i.test(f.attributes.TRUSE || '')) {
      paddleN++;
      paddleMi += f.geometry.paths.reduce((s, p) => s + pathLen(p), 0);
      for (const coords of f.geometry.paths) {
        if (coords.length >= 2) paddleParts.push({ attrs: f.attributes, coords });
      }
      continue;
    }
    f.geometry.paths.forEach((coords, pi) => {
      if (coords.length < 2) return;
      const len = pathLen(coords);
      if (len <= 0) return;
      parts.push({ oid: f.attributes.OBJECTID, pi, attrs: f.attributes, coords, len });
    });
  }
  const srcTotal = parts.reduce((s, p) => s + p.len, 0);
  console.log('  ' + parts.length + ' parts, ' + r2(srcTotal) + ' mi'
    + (paddleN ? '  (excluded ' + paddleN + ' paddle route, ' + r2(paddleMi) + ' mi)' : ''));
  // Bicycle-designated roads are KEPT. 126 of the 600 features carry
  // TRUSE "Bicycle" with no Hiker/Pedestrian, almost all of them Southern
  // Maryland and Northern Neck county roads - Marshall Hall Rd, Livingston Rd,
  // Point Lookout Rd, Colton Point Rd and the like. None is a parkway, freeway
  // or bridge, so there is no documentation that walking is prohibited, and
  // walking a signed on-road bicycle route is legal. Reported for visibility.
  {
    const bike = parts.filter(p => (p.attrs.TRUSE || '') === 'Bicycle');
    console.log('  bicycle-designated (kept, no walking prohibition found): '
      + bike.length + ' parts, ' + r2(bike.reduce((s, p) => s + p.len, 0)) + ' mi');
  }

  // Detect: which single other part most covers this one?
  {
    const idx = buildSegIndex(parts);
    const dupPairs = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].len < 0.05) continue;
      const cover = new Map();
      const P = idx.proj[i];
      for (const q of P) {
        const hit = new Set();
        for (const [j, s] of idx.near(q, DUP_TOL + 0.01)) {
          if (j === i) continue;
          if (segDist(q, idx.proj[j][s], idx.proj[j][s + 1]).d <= DUP_TOL) hit.add(j);
        }
        for (const j of hit) cover.set(j, (cover.get(j) || 0) + 1);
      }
      let best = -1, bestN = 0;
      for (const [j, n] of cover) if (n > bestN) { bestN = n; best = j; }
      if (best >= 0 && bestN / P.length >= DUP_COVER) {
        dupPairs.push({ i, j: best, frac: bestN / P.length });
      }
    }
    // Drop the covered member of each pair. Where coverage is mutual (identical
    // geometry), drop whichever belongs to the multipart aggregate - it is the
    // redundant roll-up, and the individual features carry better surface tags.
    const drop = new Set();
    const partCount = new Map();
    for (const p of parts) partCount.set(p.oid, (partCount.get(p.oid) || 0) + 1);
    for (const { i, j } of dupPairs) {
      if (drop.has(i) || drop.has(j)) continue;
      const a = parts[i], b = parts[j];
      let victim;
      if (Math.abs(a.len - b.len) > 0.01) victim = a.len < b.len ? i : j;
      else victim = (partCount.get(a.oid) || 1) >= (partCount.get(b.oid) || 1) ? i : j;
      drop.add(victim);
    }
    const droppedMi = [...drop].reduce((s, i) => s + parts[i].len, 0);
    const droppedOids = [...new Set([...drop].map(i => parts[i].oid))].sort((x, y) => x - y);
    console.log('  duplicate relationships: ' + dupPairs.length
      + ', dropping ' + drop.size + ' parts (' + r2(droppedMi) + ' mi) from OID '
      + droppedOids.join(', '));
    // No hardcoded expectation: the 2026-10 republication already deleted OID
    // 343 upstream, which changed what is duplicated. Deduping at PART level
    // rather than feature level is what makes that safe - with 343 gone, OID
    // 302's first part is now the only copy of the Budds Creek Rd stretch, so
    // feature-level dedupe would delete 3.5mi of real trail. The list is
    // printed every run so a future republication is visible.
    parts = parts.filter((_, i) => !drop.has(i));
  }
  const dedupedTotal = parts.reduce((s, p) => s + p.len, 0);
  console.log('  ' + parts.length + ' parts after dedupe, ' + r2(dedupedTotal) + ' mi');

  // ── Stage 3: split at T-junctions ──────────────────────────────────────────
  console.log('\n=== Stage 3: split at T-junctions ===');
  {
    const idx = buildSegIndex(parts);
    const cuts = new Map();   // part index -> [{seg, t}]
    // A cut is only taken where it is at least NODE_TOL from both ends of the
    // part, measured as distance ALONG the part rather than by segment index. A
    // hit nearer than that is an end-to-end meeting that node merging already
    // handles, and cutting there would emit a sliver.
    const addCut = (j, seg, t) => {
      const tgt = parts[j].coords;
      let along = 0;
      for (let s = 0; s < seg; s++) along += dist(tgt[s], tgt[s + 1]);
      along += t * dist(tgt[seg], tgt[seg + 1]);
      if (along <= NODE_TOL || parts[j].len - along <= NODE_TOL) return false;
      let c = cuts.get(j);
      if (!c) cuts.set(j, c = []);
      c.push({ seg, t });
      return true;
    };

    // Pass 1: T-junctions - one part's ENDPOINT landing on another's interior.
    let junctions = 0;
    for (let i = 0; i < parts.length; i++) {
      const P = idx.proj[i];
      for (const ep of [P[0], P[P.length - 1]]) {
        let hit = null;
        for (const [j, s] of idx.near(ep, NODE_TOL + 0.01)) {
          if (j === i) continue;
          const { d, t } = segDist(ep, idx.proj[j][s], idx.proj[j][s + 1]);
          if (d > NODE_TOL) continue;
          const atStart = s === 0 && t < 1e-9;
          const atEnd   = s === idx.proj[j].length - 2 && t > 1 - 1e-9;
          if (atStart || atEnd) continue;
          if (!hit || d < hit.d) hit = { d, j, s, t };
        }
        if (hit && addCut(hit.j, hit.s, hit.t)) junctions++;
      }
    }

    // Pass 2: X-crossings - two parts crossing mid-line, neither ending there.
    // Node merging cannot see these at all, because no endpoint is involved, so
    // without this pass a route that crosses another mid-line reads as
    // unconnected. That is what split the DC River Trail alternate into three
    // pieces. These are genuine junctions on the ground in almost every case
    // (road meets road, trail meets road); the exception is a crossing on a
    // bridge, and stage 5's mileage checks are what catch a bad one.
    let crossings = 0;
    const properIntersect = (a1, a2, b1, b2) => {
      const d = (a2[0] - a1[0]) * (b2[1] - b1[1]) - (a2[1] - a1[1]) * (b2[0] - b1[0]);
      if (Math.abs(d) < 1e-12) return null;
      const t = ((b1[0] - a1[0]) * (b2[1] - b1[1]) - (b1[1] - a1[1]) * (b2[0] - b1[0])) / d;
      const u = ((b1[0] - a1[0]) * (a2[1] - a1[1]) - (b1[1] - a1[1]) * (a2[0] - a1[0])) / d;
      if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null;
      return { t, u };
    };
    for (let i = 0; i < parts.length; i++) {
      const P = idx.proj[i];
      for (let s = 0; s < P.length - 1; s++) {
        for (const [j, u] of idx.near(P[s], 0.25)) {
          if (j <= i) continue;
          const Q = idx.proj[j];
          const hit = properIntersect(P[s], P[s + 1], Q[u], Q[u + 1]);
          if (!hit) continue;
          const a = addCut(i, s, hit.t);
          const b = addCut(j, u, hit.u);
          if (a || b) crossings++;
        }
      }
    }
    const next = [];
    for (let i = 0; i < parts.length; i++) {
      const c = cuts.get(i);
      if (!c || !c.length) { next.push(parts[i]); continue; }
      // Cut parameters as absolute positions along the part, de-duplicated and
      // pulled away from the ends so no zero-length sliver is emitted.
      const seen = new Set();
      const at = [];
      for (const { seg, t } of c) {
        const pos = seg + Math.min(Math.max(t, 0), 1);
        const k = pos.toFixed(9);
        if (seen.has(k)) continue;
        seen.add(k);
        at.push(pos);
      }
      at.sort((a, b) => a - b);
      const coords = parts[i].coords;
      const bounds = [0, ...at.filter(p => p > 1e-6 && p < coords.length - 1 - 1e-6),
        coords.length - 1];
      const pieceOf = (from, to) => {
        const out = [];
        const interp = (pos) => {
          const s = Math.min(Math.floor(pos), coords.length - 2);
          const t = pos - s;
          return [coords[s][0] + t * (coords[s + 1][0] - coords[s][0]),
            coords[s][1] + t * (coords[s + 1][1] - coords[s][1])];
        };
        out.push(interp(from));
        for (let s = Math.ceil(from); s <= Math.floor(to); s++) {
          const v = coords[s];
          if (dist(out[out.length - 1], v) > 0) out.push(v);
        }
        const end = interp(to);
        if (dist(out[out.length - 1], end) > 0) out.push(end);
        return out;
      };
      for (let b = 0; b < bounds.length - 1; b++) {
        if (bounds[b + 1] - bounds[b] < 1e-9) continue;
        const pc = pieceOf(bounds[b], bounds[b + 1]);
        if (pc.length < 2) continue;
        const len = pathLen(pc);
        if (len <= 0) continue;
        next.push({ oid: parts[i].oid, pi: parts[i].pi, attrs: parts[i].attrs,
          coords: pc, len });
      }
    }
    const before = parts.length;
    parts = next;
    const after = parts.reduce((s, p) => s + p.len, 0);
    console.log('  ' + junctions + ' T-junctions, ' + crossings + ' X-crossings; '
      + before + ' parts -> ' + parts.length);
    console.log('  length preserved: ' + r3(after) + ' mi (was ' + r3(dedupedTotal) + ')');
    if (Math.abs(after - dedupedTotal) > 0.01) {
      throw new Error('splitting changed total length by ' + r3(after - dedupedTotal) + ' mi');
    }
  }

  // ── Stage 3b: declared joins, as real tread ────────────────────────────────
  console.log('\n=== Stage 3b: declared joins ===');
  let joinMi = 0;
  // A side of a join is addressed either by TRNAME or, where the source leaves
  // the piece unnamed, by OBJECTID.
  const endsOf = (spec) => {
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const n = parts[i].attrs.TRNAME || parts[i].attrs.MAPLABEL || '';
      const hit = spec.oid != null ? parts[i].oid === spec.oid : n === spec.name;
      if (!hit) continue;
      out.push({ i, v: parts[i].coords[0] });
      out.push({ i, v: parts[i].coords[parts[i].coords.length - 1] });
    }
    return out;
  };
  for (const j of JOINS) {
    const la = j.a || ('OID ' + j.aOid), lb = j.b || ('OID ' + j.bOid);
    const A = endsOf({ name: j.a, oid: j.aOid });
    const B = endsOf({ name: j.b, oid: j.bOid });
    if (!A.length || !B.length) {
      console.log('  ' + la + ' <-> ' + lb + ': one side not found in the source'
        + ' (' + A.length + ' / ' + B.length + ' ends) - NOT joined');
      continue;
    }
    let a = null, b = null, best = Infinity;
    for (const x of A) for (const y of B) {
      if (x.i === y.i) continue;
      const d = dist(x.v, y.v);
      if (d < best) { best = d; a = x; b = y; }
    }
    if (!a || !b) {
      console.log('  ' + la + ' <-> ' + lb + ': no distinct parts to join - NOT joined');
      continue;
    }
    const len = best;
    parts.push({
      oid: null, pi: 0, declaredJoin: la + ' / ' + lb,
      attrs: { OBJECTID: null, TRNAME: la + ' / ' + lb + ' connector',
        TRALTNAME: null, MAPLABEL: null, TRSTATUS: 'Existing',
        TYPEOFROUTE: 'Road/Trail', STATE: 'DC',
        REGION: parts[a.i].attrs.REGION, TRSURFACE: null, TRUSE: null, TRTYPE: null },
      coords: [a.v.slice(), b.v.slice()], len,
    });
    joinMi += len;
    console.log('  joined ' + la + ' <-> ' + lb + ': ' + Math.round(len * 5280) + ' ft'
      + (Math.abs(len * 5280 - j.expectFt) > 80 ? '  !! expected ~' + j.expectFt + ' ft' : ''));
  }
  console.log('  ' + r3(joinMi) + ' mi of declared tread added ('
    + Math.round(joinMi * 5280) + ' ft total)');

  // ── Stage 4: graph and declared connectors ─────────────────────────────────
  console.log('\n=== Stage 4: graph and connectors ===');
  const nodes = buildNodes(parts, NODE_TOL);
  const comps = components(parts);
  console.log('  ' + nodes.length + ' nodes, ' + comps.length + ' components'
    + ' (largest ' + r2(comps[0].reduce((s, i) => s + parts[i].len, 0)) + ' mi)');

  const nearestNode = (at) => {
    let best = -1, bd = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const d = dist(nodes[i], at);
      if (d < bd) { bd = d; best = i; }
    }
    return { node: best, d: bd };
  };

  const compOf = new Map();
  comps.forEach((g, ci) => g.forEach(pi => {
    compOf.set(parts[pi].n0, ci); compOf.set(parts[pi].n1, ci);
  }));

  // Both ends of a declared connector must lie close to the declared junction.
  // Searching for "nearest node in another component" without that radius picks
  // whatever is nearest in the whole graph and will happily bridge a mile.
  const CONNECTOR_RADIUS = 0.25;
  const extraEdges = [];
  for (const c of CONNECTORS) {
    const near = nodes
      .map((n, i) => ({ i, d: dist(n, c.at) }))
      .filter(r => r.d <= CONNECTOR_RADIUS)
      .sort((a, b) => a.d - b.d);
    let best = null;
    for (let x = 0; x < near.length && !best; x++) {
      for (let y = x + 1; y < near.length && !best; y++) {
        if (compOf.get(near[x].i) === compOf.get(near[y].i)) continue;
        best = { a: near[x].i, b: near[y].i, len: dist(nodes[near[x].i], nodes[near[y].i]) };
      }
    }
    if (!best) {
      console.log('  ' + c.name + ': nothing to bridge within '
        + CONNECTOR_RADIUS + ' mi (' + near.length + ' nodes in range, all one component)');
      continue;
    }
    extraEdges.push({ ...best, name: c.name });
    console.log('  bridged ' + c.name + ': ' + r3(best.len) + ' mi ('
      + Math.round(best.len * 5280) + ' ft)'
      + (Math.abs(best.len - c.expectMi) > 0.05 ? '  !! expected ~' + c.expectMi + ' mi' : ''));
  }
  const adj = adjacency(parts, extraEdges);

  // ── Stage 5: route the spine through the NPS waypoints ─────────────────────
  console.log('\n=== Stage 5: spine ===');
  const vias = VIA.map(v => {
    const { node, d } = nearestNode(v.at);
    console.log('  ' + v.name.padEnd(24) + ' node ' + String(node).padEnd(6)
      + r2(d) + ' mi from the named place');
    return { ...v, node };
  });

  const legs = [];
  const spineSteps = [];   // { part|null, from, to }
  for (let i = 0; i < vias.length - 1; i++) {
    const { dist: dd, prev } = dijkstra(adj, vias[i].node);
    const target = vias[i + 1].node;
    if (!dd.has(target)) {
      throw new Error('no route from ' + vias[i].name + ' to ' + vias[i + 1].name);
    }
    const back = [];
    for (let u = target; u !== vias[i].node;) {
      const p = prev.get(u);
      back.push({ part: p.part, from: p.from, to: u, connector: p.connector });
      u = p.from;
    }
    back.reverse();
    spineSteps.push(...back);
    legs.push({ from: vias[i].name, to: vias[i + 1].name, miles: dd.get(target) });
    console.log('  ' + vias[i].name.padEnd(24) + ' -> ' + vias[i + 1].name.padEnd(24)
      + r2(dd.get(target)).toFixed(2).padStart(8) + ' mi');
  }
  const spineMi = legs.reduce((s, l) => s + l.miles, 0);
  console.log('  spine total: ' + r2(spineMi) + ' mi over ' + spineSteps.length + ' steps');

  // External check, never fitted to.
  {
    let acc = 0, seen = false;
    for (const l of legs) {
      if (l.from === NPS_CHECK.from) seen = true;
      if (seen) acc += l.miles;
      if (l.to === NPS_CHECK.to) break;
    }
    const withSpur = acc + NPS_CHECK.spurRoundTrip;
    const d1 = acc - NPS_CHECK.miles, d2 = withSpur - NPS_CHECK.miles;
    console.log('  NPS comparison  ' + NPS_CHECK.from + ' -> ' + NPS_CHECK.to
      + '  (published ~' + NPS_CHECK.miles + ' mi)');
    console.log('    through-route            ' + r2(acc).toFixed(2).padStart(7) + ' mi  ('
      + (d1 >= 0 ? '+' : '') + r2(d1) + ')');
    console.log('    + lighthouse spur both ways ' + r2(withSpur).toFixed(2).padStart(4) + ' mi  ('
      + (d2 >= 0 ? '+' : '') + r2(d2) + ')');
    console.log('    ' + NPS_CHECK.note);
  }

  // Assemble the spine as one ordered coordinate run, oriented so that mile 0
  // is Laurel Ridge PA - the walk above runs east to west, so it is reversed.
  const spineLine = [];
  const spineOwner = [];       // owning part index per vertex (null on connectors)
  const stepStart = [];        // vertex index where each step begins
  for (const st of spineSteps) {
    stepStart.push(spineLine.length ? spineLine.length - 1 : 0);
    let seg;
    if (st.part === null) seg = [nodes[st.from], nodes[st.to]];
    else {
      const p = parts[st.part];
      const headFirst = dist(nodes[st.from], p.coords[0])
        <= dist(nodes[st.from], p.coords[p.coords.length - 1]);
      seg = headFirst ? p.coords : p.coords.slice().reverse();
    }
    for (let i = 0; i < seg.length; i++) {
      if (spineLine.length && dist(spineLine[spineLine.length - 1], seg[i]) === 0) continue;
      spineLine.push(seg[i]);
      spineOwner.push(st.part);
    }
  }
  // Mile at every node the spine passes through, before the line is flipped.
  const cumE = [0];
  for (let i = 1; i < spineLine.length; i++) {
    cumE[i] = cumE[i - 1] + dist(spineLine[i - 1], spineLine[i]);
  }
  const totalE = cumE[cumE.length - 1];
  const nodeMile = new Map();   // node -> mile on the final, west-oriented axis
  spineSteps.forEach((st, k) => {
    const m = totalE - cumE[stepStart[k]];
    if (!nodeMile.has(st.from) || m < nodeMile.get(st.from)) nodeMile.set(st.from, m);
  });
  {
    const last = spineSteps[spineSteps.length - 1];
    nodeMile.set(last.to, 0);
  }
  spineLine.reverse();
  spineOwner.reverse();
  const spineWalked = pathLen(spineLine);
  console.log('  assembled: ' + spineLine.length + ' vertices, ' + r2(spineWalked)
    + ' mi (mile 0 = Laurel Ridge PA)');

  const spinePartSet = new Set(spineSteps.map(s => s.part).filter(p => p !== null));
  const oabParts = (() => {
    const seen = new Map();
    const twice = new Set();
    for (const s of spineSteps) {
      if (s.part === null) continue;
      if (seen.has(s.part)) twice.add(s.part);
      seen.set(s.part, true);
    }
    return twice;
  })();
  const oabMi = [...oabParts].reduce((s, i) => s + parts[i].len, 0);
  console.log('  out-and-back tread walked twice: ' + r2(oabMi) + ' mi over '
    + oabParts.size + ' parts'
    + (OUT_AND_BACK_ON_AXIS ? ' (kept on the axis)' : ' (NOT on the axis)'));
  {
    const byName = new Map();
    for (const i of oabParts) {
      const n = parts[i].attrs.TRNAME || parts[i].attrs.MAPLABEL || '(unnamed)';
      byName.set(n, (byName.get(n) || 0) + parts[i].len);
    }
    for (const [n, mi] of [...byName].sort((a, b) => b[1] - a[1])) {
      console.log('    ' + r2(mi).toFixed(2).padStart(6) + ' mi each way  ' + n);
    }
  }

  // ── Stage 6: classify everything off the spine ─────────────────────────────
  console.log('\n=== Stage 6: classify off-spine routes ===');
  const offIdx = parts.map((_, i) => i).filter(i => !spinePartSet.has(i));
  console.log('  ' + offIdx.length + ' off-spine parts, '
    + r2(offIdx.reduce((s, i) => s + parts[i].len, 0)) + ' mi');
  {
    const touching = offIdx.filter(i => nodeMile.has(parts[i].n0) || nodeMile.has(parts[i].n1));
    console.log('  spine nodes recorded: ' + nodeMile.size
      + ';  off-spine parts sharing a spine node: ' + touching.length
      + ' (' + r2(touching.reduce((s, i) => s + parts[i].len, 0)) + ' mi)');
  }

  // Connected clusters among the off-spine parts only.
  const offClusters = (() => {
    const member = new Set(offIdx);
    const byNode = new Map();
    for (const i of offIdx) {
      for (const n of [parts[i].n0, parts[i].n1]) {
        let b = byNode.get(n);
        if (!b) byNode.set(n, b = []);
        b.push(i);
      }
    }
    const seen = new Set();
    const out = [];
    for (const start of offIdx) {
      if (seen.has(start)) continue;
      const stack = [start];
      seen.add(start);
      const g = [];
      while (stack.length) {
        const i = stack.pop();
        g.push(i);
        for (const n of [parts[i].n0, parts[i].n1]) {
          for (const j of byNode.get(n) || []) {
            if (member.has(j) && !seen.has(j)) { seen.add(j); stack.push(j); }
          }
        }
      }
      out.push(g);
    }
    return out.sort((a, b) => b.reduce((s, i) => s + parts[i].len, 0)
      - a.reduce((s, i) => s + parts[i].len, 0));
  })();
  console.log('  ' + offClusters.length + ' connected clusters');
  {
    // How many distinct spine miles each cluster touches. A cluster touching
    // two or more is a candidate alternate; one touching a single mile, or
    // none, can only be `side`. Printed because "why is there no alternate" is
    // otherwise invisible.
    const rows = [];
    for (const c of offClusters) {
      const miles = [...new Set(c.flatMap(i => [parts[i].n0, parts[i].n1])
        .filter(n => nodeMile.has(n)).map(n => r1(nodeMile.get(n))))].sort((a, b) => a - b);
      if (miles.length) rows.push({ mi: c.reduce((s, i) => s + parts[i].len, 0), miles, n: c.length });
    }
    rows.sort((a, b) => b.mi - a.mi);
    console.log('  clusters touching the spine: ' + rows.length
      + ' (' + rows.filter(r => r.miles.length > 1).length + ' touch 2+ distinct miles)');
    for (const r of rows.slice(0, 10)) {
      console.log('    ' + r2(r.mi).toFixed(2).padStart(7) + ' mi, ' + String(r.n).padStart(3)
        + ' parts  at spine mile ' + r.miles.slice(0, 6).join(', ')
        + (r.miles.length > 6 ? ' …' : ''));
    }
  }

  // A cluster is an arbitrary graph, not a line, so it is decomposed into
  // PATHS: repeatedly take the longest path through what remains and emit it as
  // its own route. That gives every route a well-defined local mile axis and a
  // junction into something already emitted, instead of trying to force a tree
  // into one ordered line. Virginia's largest cluster is 400+ parts, so this is
  // what makes it addressable at all.
  const localAdj = (partIdxs) => {
    const adjL = new Map();
    for (const i of partIdxs) {
      for (const [a, b] of [[parts[i].n0, parts[i].n1], [parts[i].n1, parts[i].n0]]) {
        let e = adjL.get(a);
        if (!e) adjL.set(a, e = []);
        e.push({ to: b, len: parts[i].len, part: i });
      }
    }
    return adjL;
  };

  const traceBack = (prev, from, to) => {
    const chain = [];
    for (let u = to; u !== from;) {
      const p = prev.get(u);
      if (!p) return [];
      chain.push({ part: p.part, from: p.from, to: u });
      u = p.from;
    }
    chain.reverse();
    return chain;
  };

  // The substitution test, done properly: before taking the longest path, look
  // for a path that runs from one point ON THE SPINE to a DIFFERENT point on the
  // spine. That is what makes a route an alternate - you could walk it instead
  // of the spine stretch between those two miles. Taking the longest path first
  // buries such a leg inside a path that happens to run between two dead ends.
  function spineToSpinePath(partIdxs) {
    const adjL = localAdj(partIdxs);
    const hubs = [...adjL.keys()].filter(n => nodeMile.has(n));
    if (hubs.length < 2) return null;
    let best = null;
    for (const a of hubs) {
      const { dist: dd, prev } = dijkstra(adjL, a);
      for (const b of hubs) {
        if (b === a || !dd.has(b)) continue;
        if (Math.abs(nodeMile.get(a) - nodeMile.get(b)) <= 0.2) continue;
        if (!best || dd.get(b) < best.len) {
          best = { len: dd.get(b), chain: traceBack(prev, a, b), a, b };
        }
      }
    }
    return best && best.chain.length ? best : null;
  }

  function longestPath(partIdxs) {
    const adjL = localAdj(partIdxs);
    const far = (src) => {
      const { dist: dd, prev } = dijkstra(adjL, src);
      let best = src, bd = -1;
      for (const [n, d] of dd) if (d > bd) { bd = d; best = n; }
      return { node: best, d: bd, prev };
    };
    const a = far(parts[partIdxs[0]].n0);
    const b = far(a.node);
    return traceBack(b.prev, a.node, b.node);
  }

  const slugify = s => String(s || 'route').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 44) || 'route';

  const routes = [];           // { id, kind, parts:[{part,from,to}], len, junctionMile, regionId }
  const usedIds = new Set(['main']);
  {
    // Any cluster reaching two or more spine miles is a candidate alternate.
    // When one of those does not become an alternate, say why - either no path
    // runs between its spine-touching nodes inside the cluster, or the two
    // miles are too close together to be substituting for anything.
    for (const c of offClusters) {
      const hubs = [...new Set(c.flatMap(i => [parts[i].n0, parts[i].n1])
        .filter(n => nodeMile.has(n)))];
      const miles = [...new Set(hubs.map(n => r1(nodeMile.get(n))))].sort((a, b) => a - b);
      if (miles.length < 2) continue;
      const s2s = spineToSpinePath(c);
      const names = [...new Set(c.map(i => parts[i].attrs.TRNAME || parts[i].attrs.MAPLABEL)
        .filter(Boolean))];
      console.log('    candidate: ' + r2(c.reduce((s, i) => s + parts[i].len, 0))
        + ' mi over ' + c.length + ' parts, spine miles ' + miles.join(', '));
      console.log('      ' + (s2s
        ? 'spine-to-spine path FOUND, ' + r2(s2s.len) + ' mi'
        : 'NO spine-to-spine path inside the cluster'
          + (Math.max(...miles) - Math.min(...miles) <= 0.2
            ? ' (and its spine miles are within 0.2 mi anyway)' : '')));
      console.log('      contains: ' + names.slice(0, 8).join(', ')
        + (names.length > 8 ? ' +' + (names.length - 8) + ' more' : ''));
    }
  }

  const nameKey = i => parts[i].attrs.TRNAME || parts[i].attrs.MAPLABEL || '(unnamed)';

  const emitRoute = (chain, kind, span) => {
    const len = chain.reduce((s, c) => s + parts[c.part].len, 0);
    // Any node of the route may touch the spine, not just its ends.
    let junctionMile = null, junctionNode = null;
    for (const c of chain) {
      for (const n of [c.from, c.to]) {
        if (nodeMile.has(n)) {
          const m = nodeMile.get(n);
          if (junctionMile === null || m < junctionMile) {
            junctionMile = m;
            junctionNode = n;
          }
        }
      }
    }
    const nameTally = new Map();
    for (const c of chain) {
      const nm = parts[c.part].attrs.TRNAME || parts[c.part].attrs.MAPLABEL || null;
      if (nm) nameTally.set(nm, (nameTally.get(nm) || 0) + parts[c.part].len);
    }
    const topName = [...nameTally].sort((a, b) => b[1] - a[1])[0];
    let id = (kind === 'alternate' ? 'alt-' : 'side-')
      + slugify(topName ? topName[0] : 'unnamed');
    let n = 1;
    while (usedIds.has(id)) id = id.replace(/-\d+$/, '') + '-' + (++n);
    usedIds.add(id);

    const regTally = new Map();
    for (const c of chain) {
      const r = parts[c.part].attrs.REGION;
      regTally.set(r, (regTally.get(r) || 0) + parts[c.part].len);
    }
    const regionSrc = [...regTally].sort((a, b) => b[1] - a[1])[0][0];

    routes.push({ id, kind, chain, len, junctionMile, junctionNode, span,
      region: REGION_BY_SRC.get(regionSrc), name: topName ? topName[0] : null });
  };

  // A part whose two endpoints merged to the same node is a closed ring, so no
  // path runs "through" it and the walk returns nothing. Emit it on its own
  // rather than breaking out and silently dropping whatever is left.
  const pathsOf = (idxs, kind) => {
    let rem = new Set(idxs);
    while (rem.size) {
      let chain = longestPath([...rem]);
      if (!chain.length) {
        const i = [...rem][0];
        chain = [{ part: i, from: parts[i].n0, to: parts[i].n1 }];
      }
      for (const c of chain) rem.delete(c.part);
      emitRoute(chain, kind, null);
    }
  };

  for (const cluster of offClusters) {
    const remaining = new Set(cluster);

    // Alternates come out first, by SUBSTITUTION rather than by name: a leg
    // that runs from one spine mile to a different spine mile is something you
    // could walk instead of that stretch, whatever it happens to be called
    // along the way. Taking named runs first would chop such a leg into pieces
    // and lose the fact that it substitutes at all.
    for (;;) {
      const s2s = spineToSpinePath([...remaining]);
      if (!s2s || !s2s.chain.length) break;
      for (const c of s2s.chain) remaining.delete(c.part);
      emitRoute(s2s.chain, 'alternate',
        { a: nodeMile.get(s2s.a), b: nodeMile.get(s2s.b) });
    }

    // Everything else is cut WHERE THE NAME CHANGES, so each side route is one
    // named trail rather than the longest geometric walk through the web. The
    // longest walk produced a 44-mile route named after the Mount Vernon Trail
    // that was mostly other trails. A name whose parts are disconnected simply
    // yields several routes, numbered.
    const byName = new Map();
    for (const i of remaining) {
      const k = nameKey(i);
      let b = byName.get(k);
      if (!b) byName.set(k, b = []);
      b.push(i);
    }
    for (const [, idxs] of [...byName].sort((a, b) =>
      b[1].reduce((s, i) => s + parts[i].len, 0) - a[1].reduce((s, i) => s + parts[i].len, 0))) {
      pathsOf(idxs, 'side');
    }
  }

  // A short route is dropped only when it is ISOLATED - sharing no node with
  // any other part. Length alone is the wrong test: the shortest routes on this
  // trail are the pieces that hold the network together, and dropping them by
  // length silently cut the DC river chain in half. OID 1421, the 231 ft Key
  // Bridge connection carrying the river trail up onto the towpath, is the case
  // that found this.
  const MIN_ROUTE_MI = 0.1;
  const nodeUse = new Map();
  for (const p of parts) {
    for (const n of [p.n0, p.n1]) nodeUse.set(n, (nodeUse.get(n) || 0) + 1);
  }
  const connects = r => r.chain.some(c =>
    (nodeUse.get(c.from) || 0) > 1 || (nodeUse.get(c.to) || 0) > 1);
  // Below NODE_TOL there is nothing to keep, connecting or not: buildNodes
  // merges endpoints within that distance, so a shorter part has BOTH ends on
  // the same node and is a self-loop that cannot join anything. Without this
  // floor the `connects` test above waves through degenerate slivers — it let
  // 24 routes of 0 to 23 ft into the output, twelve of them Fort Circle pieces
  // at identical coordinates, each emitting a spurious point.
  const tiny = routes.filter(r => r.len < NODE_TOL || (r.len < MIN_ROUTE_MI && !connects(r)));
  const tinySet = new Set(tiny);
  const kept = routes.filter(r => !tinySet.has(r));
  const shortKept = kept.filter(r => r.len < MIN_ROUTE_MI);
  if (shortKept.length) {
    console.log('  kept ' + shortKept.length + ' route(s) under ' + MIN_ROUTE_MI
      + ' mi because they connect other routes (' + r2(shortKept.reduce((s, r) => s + r.len, 0))
      + ' mi)');
  }
  const altMi  = kept.filter(r => r.kind === 'alternate').reduce((s, r) => s + r.len, 0);
  const sideMi = kept.filter(r => r.kind === 'side').reduce((s, r) => s + r.len, 0);
  console.log('  decomposed into ' + routes.length + ' paths: '
    + kept.filter(r => r.kind === 'alternate').length + ' alternate (' + r2(altMi) + ' mi), '
    + kept.filter(r => r.kind === 'side').length + ' side (' + r2(sideMi) + ' mi), '
    + tiny.length + ' under ' + MIN_ROUTE_MI + ' mi dropped ('
    + r2(tiny.reduce((s, r) => s + r.len, 0)) + ' mi)');

  console.log('\n  alternates:');
  for (const r of kept.filter(r => r.kind === 'alternate').sort((a, b) => b.len - a.len)) {
    console.log('    ' + r2(r.len).toFixed(2).padStart(7) + ' mi  junction mile '
      + (r.junctionMile === null ? '   -  ' : r1(r.junctionMile).toFixed(1).padStart(6))
      + '  ' + r.id);
  }
  console.log('\n  largest side routes:');
  for (const r of kept.filter(r => r.kind === 'side').sort((a, b) => b.len - a.len).slice(0, 15)) {
    console.log('    ' + r2(r.len).toFixed(2).padStart(7) + ' mi  junction mile '
      + (r.junctionMile === null ? '   -  ' : r1(r.junctionMile).toFixed(1).padStart(6))
      + '  ' + r.region.id.padEnd(26) + r.id);
  }

  // ── Stage 7: points.json ───────────────────────────────────────────────────
  console.log('\n=== Stage 7: points.json ===');
  const stateFor = (lon, lat) => {
    for (const f of statesGeo.features) {
      if (inFeature(lon, lat, f.geometry)) {
        const fips = f.properties.STATE;
        const s = STATES.find(x => x.fips === fips);
        if (s) return s.abbr;
      }
    }
    return null;
  };

  // Region per spine vertex, then short excursions absorbed so regions tile the
  // axis and sec_mile stays a usable region-local measure. Same guard, and the
  // same reason, as the NCT build's state weave.
  const spineRegion = spineOwner.map(pi =>
    pi === null ? null : REGION_BY_SRC.get(parts[pi].attrs.REGION).id);
  for (let i = 0; i < spineRegion.length; i++) {
    if (spineRegion[i] === null) spineRegion[i] = i > 0 ? spineRegion[i - 1] : spineRegion[1];
  }
  {
    const cum = [0];
    for (let i = 1; i < spineLine.length; i++) cum[i] = cum[i - 1] + dist(spineLine[i - 1], spineLine[i]);
    let runStart = 0, absorbed = 0, absorbedMi = 0;
    for (let i = 1; i <= spineRegion.length; i++) {
      if (i < spineRegion.length && spineRegion[i] === spineRegion[runStart]) continue;
      const runMi = (cum[Math.min(i, cum.length - 1)] || 0) - cum[runStart];
      const before = runStart > 0 ? spineRegion[runStart - 1] : null;
      const after = i < spineRegion.length ? spineRegion[i] : null;
      if (runMi < REGION_MIN_MI && before && (after === null || before === after)) {
        for (let k = runStart; k < i; k++) spineRegion[k] = before;
        absorbed++;
        absorbedMi += runMi;
      }
      runStart = i;
    }
    if (absorbed) console.log('  absorbed ' + absorbed + ' region excursions under '
      + REGION_MIN_MI + ' mi (' + r2(absorbedMi) + ' mi)');
  }

  const points = [];
  // Spine points, every SPACING along the assembled axis.
  {
    let acc = 0, next = 0;
    // The coordinate is INTERPOLATED to the sampled mile, not snapped to the
    // nearest vertex. Snapping put 287 spine points at duplicate coordinates:
    // wherever the source line has a segment longer than SPACING, two or more
    // samples fall inside it and both land on the same endpoint. At 0.1 mi
    // spacing that is common — Southern Maryland's road route has steps over a
    // mile. `idx` still names the vertex the sample sits on, which is what the
    // region and surface lookups need.
    const emit = (idx, mile, at) => {
      const [lon, lat] = at || spineLine[idx];
      const pi = spineOwner[idx];
      const rt = pi === null ? null : ROUTE_TYPE[parts[pi].attrs.TYPEOFROUTE];
      const rid = spineRegion[idx];
      const rec = {
        id: pointId('main', mile),
        lat: r6(lat), lon: r6(lon),
        mile: r3(mile),
        region_id: rid,
        region_name: REGIONS.find(r => r.id === rid).name,
        section_id: null,
        section_name: null,
        sec_mile: 0,
        route_id: 'main',
        route_kind: 'spine',
        state: stateFor(lon, lat),
      };
      if (rt) rec.route_type = rt;
      points.push(rec);
    };
    emit(0, 0);
    next = SPACING;
    for (let i = 1; i < spineLine.length; i++) {
      const a = spineLine[i - 1], b = spineLine[i];
      const seg = dist(a, b);
      while (next <= acc + seg + 1e-9) {
        const f = seg > 0 ? (next - acc) / seg : 0;
        emit(f < 0.5 ? i - 1 : i, next,
          [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
        next = r3(next + SPACING);
      }
      acc += seg;
    }
    if (points[points.length - 1].mile < acc - SPACING / 2) emit(spineLine.length - 1, r3(acc));
    const spineRegionStart = {};
    for (const p of points) if (!(p.region_id in spineRegionStart)) spineRegionStart[p.region_id] = p.mile;
    for (const p of points) p.sec_mile = r1(p.mile - spineRegionStart[p.region_id]);
  }
  const spinePoints = points.length;

  // Alternate and side route points. `mile` for an alternate is interpolated
  // across its branch -> rejoin span, the IAT pattern, so a lookup can map back
  // through it. For a side route `mile` is LOCAL, starting at 0, because 298
  // miles of disconnected trail has no position on the trail axis - the same
  // choice TrailTemps already makes for Florida's okee_east. junction_mile
  // carries the spine mile where the route meets the trail, which is what the
  // app's mixed-route auto-split needs.
  for (const r of kept) {
    const line = [];
    // Where the junction sits ALONG this route, in route-local miles. The
    // spine mile alone is not enough to split a mixed hike: the junction is at
    // route mile 0 on only 11 of the 19 routes that touch the spine, at the far
    // end on 3, and mid-route on 5. Orientation comes from the longest-path
    // walk, which has no reason to start at the junction.
    let runLen = 0;
    r.junctionSecMile = null;
    for (const c of r.chain) {
      const p = parts[c.part];
      const headFirst = dist(nodes[c.from], p.coords[0])
        <= dist(nodes[c.from], p.coords[p.coords.length - 1]);
      const seg = headFirst ? p.coords : p.coords.slice().reverse();
      if (r.junctionNode !== null && c.from === r.junctionNode && r.junctionSecMile === null) {
        r.junctionSecMile = runLen;
      }
      for (const v of seg) {
        if (line.length && dist(line[line.length - 1], v) === 0) continue;
        line.push(v);
      }
      runLen += p.len;
      if (r.junctionNode !== null && c.to === r.junctionNode) r.junctionSecMile = runLen;
    }
    r.line = line;
    const lineLen = pathLen(line);
    // An alternate's mile is interpolated across the branch -> rejoin span it
    // substitutes for, which is the IAT pattern: strictly increasing in
    // distance along the alternate, so a lookup can map back through it.
    const span = r.span;

    let acc = 0, next = 0;
    // Interpolated, for the same reason as the spine emitter above.
    const emit = (idx, along, at) => {
      const [lon, lat] = at || line[idx];
      const mile = span
        ? span.a + (span.b - span.a) * (lineLen ? along / lineLen : 0)
        : along;
      const rt = ROUTE_TYPE[parts[r.chain[0].part].attrs.TYPEOFROUTE];
      const rec = {
        id: pointId(r.id, along),
        lat: r6(lat), lon: r6(lon),
        mile: r3(mile),
        region_id: r.region.id,
        region_name: r.region.name,
        section_id: null,
        section_name: null,
        sec_mile: r1(along),
        route_id: r.id,
        route_kind: r.kind,
        state: stateFor(lon, lat),
      };
      if (r.kind === 'alternate') rec.alt_of = 'main';
      if (r.junctionMile !== null) rec.junction_mile = r1(r.junctionMile);
      if (r.junctionSecMile !== null) rec.junction_sec_mile = r1(r.junctionSecMile);
      if (rt) rec.route_type = rt;
      points.push(rec);
    };
    emit(0, 0);
    next = SPACING;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const seg = dist(a, b);
      while (next <= acc + seg + 1e-9) {
        const f = seg > 0 ? (next - acc) / seg : 0;
        emit(f < 0.5 ? i - 1 : i, next,
          [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
        next = r3(next + SPACING);
      }
      acc += seg;
    }
  }

  // Guards.
  {
    const dupes = points.map(p => p.id).filter((id, i, a) => a.indexOf(id) !== i);
    if (dupes.length) {
      throw new Error('duplicate point ids: ' + [...new Set(dupes)].slice(0, 5).join(', '));
    }
    const sp = points.filter(p => p.route_kind === 'spine');
    for (let i = 1; i < sp.length; i++) {
      if (sp[i].mile <= sp[i - 1].mile) {
        throw new Error('spine mile not strictly increasing at ' + sp[i].id);
      }
    }
    const seq = [];
    for (const p of sp) if (seq[seq.length - 1] !== p.region_id) seq.push(p.region_id);
    if (new Set(seq).size !== seq.length) {
      throw new Error('spine regions are not contiguous: ' + seq.join(','));
    }
    for (const rid of seq) {
      const first = sp.find(p => p.region_id === rid);
      if (first.sec_mile !== 0) throw new Error(rid + ' does not start at sec_mile 0');
    }
    const noState = points.filter(p => !p.state).length;
    if (noState) console.log('  !! ' + noState + ' points fell outside every state polygon');
  }

  fs.writeFileSync(path.join(DATA, 'points.json'), JSON.stringify(points, null, 2));
  const kindCount = {};
  for (const p of points) kindCount[p.route_kind] = (kindCount[p.route_kind] || 0) + 1;
  const stCount = {};
  for (const p of points) stCount[p.state || '?'] = (stCount[p.state || '?'] || 0) + 1;
  console.log('  ' + points.length + ' points at ' + SPACING + ' mi  ('
    + Object.entries(kindCount).map(([k, v]) => k + ' ' + v).join(', ') + ')');
  console.log('  spine regions: ' + [...new Set(points.filter(p => p.route_kind === 'spine')
    .map(p => p.region_id))].join(' -> '));
  console.log('  states: ' + Object.entries(stCount).map(([k, v]) => k + ' ' + v).join(', '));

  // ── Stage 8: trail.geojson ─────────────────────────────────────────────────
  console.log('\n=== Stage 8: trail.geojson ===');
  const features = [];
  // Spine: one feature per contiguous run of the same region and surface, in
  // axis order, so map.js concatenates them with no teleports.
  {
    const surfaceAt = i => spineOwner[i] === null
      ? null : ROUTE_TYPE[parts[spineOwner[i]].attrs.TYPEOFROUTE];
    let runStart = 0;
    const flush = (end) => {
      const coords = thinCoords(spineLine.slice(runStart, end + 1), THIN_M);
      if (coords.length < 2) return;
      const rid = spineRegion[runStart];
      const region = REGIONS.find(r => r.id === rid);
      const surf = surfaceAt(runStart);
      const props = {
        segment_type: surf === 'roadwalk' ? 'roadwalk' : 'trail',
        route_id: 'main',
        route_kind: 'spine',
        region_id: rid, region_name: region.name,
        section_id: null, section_name: null,
      };
      if (surf) props.route_type = surf;
      features.push({ type: 'Feature', properties: props,
        geometry: { type: 'LineString', coordinates: coords.map(c => [r6(c[0]), r6(c[1])]) } });
    };
    for (let i = 1; i < spineLine.length; i++) {
      if (surfaceAt(i) !== surfaceAt(runStart) || spineRegion[i] !== spineRegion[runStart]) {
        flush(i);
        runStart = i;
      }
    }
    flush(spineLine.length - 1);
  }
  const spineFeatures = features.length;

  // Ordering guard on the spine run only.
  {
    let worst = 0;
    for (let i = 1; i < spineFeatures; i++) {
      const a = features[i - 1].geometry.coordinates;
      const b = features[i].geometry.coordinates;
      worst = Math.max(worst, dist(a[a.length - 1], b[0]));
    }
    console.log('  largest spine feature-to-feature join: ' + r3(worst) + ' mi');
    if (worst > JOIN_MI) throw new Error('spine geojson out of axis order (join ' + r2(worst) + ' mi)');
  }

  // Alternates and side routes, one feature each. `alt_of` puts an alternate in
  // map.js's _altBranches; `route_kind: "side"` is the value the one new
  // map.js branch looks for.
  for (const r of kept) {
    const coords = thinCoords(r.line, THIN_M);
    if (coords.length < 2) continue;
    const surf = ROUTE_TYPE[parts[r.chain[0].part].attrs.TYPEOFROUTE];
    const props = {
      segment_type: surf === 'roadwalk' ? 'roadwalk' : 'trail',
      route_id: r.id,
      route_kind: r.kind,
      region_id: r.region.id, region_name: r.region.name,
      section_id: null, section_name: null,
    };
    if (r.kind === 'alternate') props.alt_of = 'main';
    if (r.name) props.name = r.name;
    if (r.junctionMile !== null) props.junction_mile = r1(r.junctionMile);
    if (r.junctionSecMile != null) props.junction_sec_mile = r1(r.junctionSecMile);
    if (surf) props.route_type = surf;
    features.push({ type: 'Feature', properties: props,
      geometry: { type: 'LineString', coordinates: coords.map(c => [r6(c[0]), r6(c[1])]) } });
  }

  // The paddle route: drawn for corridor completeness, carrying no mileage and
  // no points. route_id "roadwalk" is what makes map.js skip it entirely.
  for (const p of paddleParts) {
    const coords = thinCoords(p.coords, THIN_M);
    if (coords.length < 2) continue;
    const reg = REGION_BY_SRC.get(p.attrs.REGION);
    features.push({
      type: 'Feature',
      properties: {
        segment_type: 'paddle',
        route_id: 'roadwalk',
        name: p.attrs.TRNAME || p.attrs.MAPLABEL || 'Water trail',
        region_id: reg ? reg.id : null,
        region_name: reg ? reg.name : null,
        section_id: null, section_name: null,
        state: p.attrs.STATE || null,
      },
      geometry: { type: 'LineString', coordinates: coords.map(c => [r6(c[0]), r6(c[1])]) },
    });
  }

  fs.writeFileSync(path.join(DATA, 'trail.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features }));
  const bytes = fs.statSync(path.join(DATA, 'trail.geojson')).size;
  console.log('  ' + features.length + ' features (' + spineFeatures + ' spine, '
    + kept.filter(r => r.kind === 'alternate').length + ' alternate, '
    + kept.filter(r => r.kind === 'side').length + ' side), '
    + (bytes / 1048576).toFixed(2) + ' MB');

  // ── Stage 9: pht_meta.json and accounting ──────────────────────────────────
  console.log('\n=== Stage 9: pht_meta.json ===');
  const sp = points.filter(p => p.route_kind === 'spine');
  const regionMeta = [];
  for (const rid of [...new Set(sp.map(p => p.region_id))]) {
    const rp = sp.filter(p => p.region_id === rid);
    regionMeta.push({
      id: rid,
      name: REGIONS.find(r => r.id === rid).name,
      state: [...new Set(rp.map(p => p.state).filter(Boolean))].join('/'),
      on_spine: true,
      mile_start: rp[0].mile,
      mile_end: rp[rp.length - 1].mile,
      miles: r2(rp[rp.length - 1].mile - rp[0].mile),
      sections: 0,
    });
  }
  for (const r of REGIONS) {
    if (regionMeta.some(m => m.id === r.id)) continue;
    const rr = kept.filter(x => x.region.id === r.id);
    if (!rr.length) continue;
    regionMeta.push({ id: r.id, name: r.name,
      state: [...new Set(points.filter(p => p.region_id === r.id)
        .map(p => p.state).filter(Boolean))].join('/'),
      on_spine: false, mile_start: null, mile_end: null,
      miles: r2(rr.reduce((s, x) => s + x.len, 0)), sections: 0 });
  }

  const meta = {
    trail: {
      name: 'Potomac Heritage National Scenic Trail',
      spine_miles: r2(spineWalked),
      off_spine_miles: r2(altMi + sideMi),
      point_spacing_miles: SPACING,
      map_center: [39.22, -77.91],
      map_zoom: 7,
      termini: { west: 'Laurel Ridge, PA', east: 'Point Lookout, MD' },
      source: 'NPS POHE Trail Centerline FTDS view, layer 0',
      built: new Date().toISOString().slice(0, 10),
    },
    regions: regionMeta,
    sections: [],
    routes: kept.map(r => ({
      id: r.id, kind: r.kind, name: r.name,
      region_id: r.region.id,
      miles: r2(r.len),
      junction_mile: r.junctionMile === null ? null : r1(r.junctionMile),
      junction_sec_mile: r.junctionSecMile == null ? null : r1(r.junctionSecMile),
      alt_of: r.kind === 'alternate' ? 'main' : null,
    })),
    notes: {
      sections: 'Deliberately empty. TRNAME names the host road, not a hiking '
        + 'section - the pattern rejected for the NCT and PNT. The candidate for '
        + 'later is NPS\'s four named legs (Point Lookout-Leonardtown, Colton\'s '
        + 'Point-Port Tobacco, Port Tobacco-Smallwood, Smallwood-Oxon Cove), '
        + 'which cover only ~190 of the spine\'s miles. sec_mile is region-local.',
      out_and_back: 'Piney Point Rd, Lighthouse Rd and Colton Point Rd are walked '
        + 'twice and kept on the axis, because NPS\'s published Point Lookout to '
        + 'Leonardtown mileage includes the trip out to the lighthouse and back. '
        + 'That tread therefore carries two mile values.',
      side_route_mile: 'For route_kind "side", mile is LOCAL to the route and '
        + 'starts at 0 - disconnected trail has no position on the trail axis. '
        + 'junction_mile gives the spine mile where the route meets the trail.',
      paddle: 'The Youghiogheny River paddle route (TRTYPE "Water Trail", '
        + 'TRUSE "Paddle|Kayak", TRSURFACE "Water") is drawn for corridor '
        + 'completeness but carries no mileage and no points.json entries - '
        + 'route_id "roadwalk", the non-hikeable sense, exactly as the PNT '
        + 'treats its Puget Sound ferry. It has no route_kind, because that '
        + 'vocabulary describes hikeable route and a paddle route is outside it.',
    },
  };
  fs.writeFileSync(path.join(DATA, 'pht_meta.json'), JSON.stringify(meta, null, 2));
  console.log('  ' + regionMeta.length + ' regions ('
    + regionMeta.filter(r => r.on_spine).length + ' on spine), '
    + meta.routes.length + ' routes, 0 sections');

  const spineDistinct = parts.filter((_, i) => spinePartSet.has(i)).reduce((s, p) => s + p.len, 0);
  const connMi = extraEdges.reduce((s, e) => s + e.len, 0);
  console.log('\n=== Accounting ===');
  console.log('  ' + r2(srcTotal + paddleMi).toFixed(2).padStart(9)
    + '   all source geometry, ' + raw.length + ' features');
  console.log('  -' + r2(paddleMi).toFixed(2).padStart(8)
    + '   paddle route, drawn but not counted');
  console.log('  -' + r2(srcTotal - dedupedTotal).toFixed(2).padStart(8)
    + '   duplicate geometry');
  console.log('  =' + r2(dedupedTotal).toFixed(2).padStart(8) + '   usable tread');
  console.log('  +' + r2(joinMi).toFixed(2).padStart(8)
    + '   declared joins (DC river chain, ' + Math.round(joinMi * 5280) + ' ft)');
  console.log('  =' + r2(dedupedTotal + joinMi).toFixed(2).padStart(8) + '   total tread modelled');
  console.log('');
  console.log('  ' + r2(spineDistinct).toFixed(2).padStart(9) + '   spine tread (distinct)');
  console.log('  +' + r2(oabMi).toFixed(2).padStart(8) + '   out-and-back, walked twice');
  console.log('  +' + r2(connMi).toFixed(2).padStart(8) + '   declared connectors');
  console.log('  +' + r2(spineWalked - spineDistinct - oabMi - connMi).toFixed(2).padStart(8)
    + '   node-merge slack over ' + spineSteps.length + ' joins');
  console.log('  =' + r2(spineWalked).toFixed(2).padStart(8) + '   SPINE AXIS');
  console.log('');
  console.log('  ' + r2(altMi).toFixed(2).padStart(9) + '   alternates ('
    + kept.filter(r => r.kind === 'alternate').length + ' routes)');
  console.log('  ' + r2(sideMi).toFixed(2).padStart(9) + '   side routes ('
    + kept.filter(r => r.kind === 'side').length + ' routes)');
  console.log('  ' + r2(tiny.reduce((s, r) => s + r.len, 0)).toFixed(2).padStart(9)
    + '   dropped fragments under ' + MIN_ROUTE_MI + ' mi (' + tiny.length + ')');
  console.log('  ' + r2(dedupedTotal + joinMi - spineDistinct - altMi - sideMi
    - tiny.reduce((s, r) => s + r.len, 0)).toFixed(2).padStart(9) + '   unaccounted');
  console.log('\nWrote points.json, trail.geojson, pht_meta.json');
  console.log('If the spine total moved, update trails.js totalMiles (currently 529.14).');
}

main().catch(e => { console.error('\nFAILED: ' + e.message); process.exit(1); });
