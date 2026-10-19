// Leaflet map setup and trail rendering.
// Requires Leaflet 1.9.4 (CDN) and trails.js to be loaded first, and the global
// `haversine` from app.js — this file calls it in _nearestTrailIndex,
// _latLngClose and _distToSegmentMi but does not define it.

let _map = null;
let _trailLayer = null;
let _trailCoords = null;   // LatLng[] for run 0 of trail.geojson; set after trail loads
let _trailTotalMiles = null; // trail.totalMiles for the currently loaded trail
let _altBranches = {};     // passage id (e.g. "11e") -> { altOf, coords: LatLng[] }; alt-route passages only
let _segmentLayers = [];
let _trailFitBounds = null;  // bounds of the current trail's spine, for refitTrail()
let _fitObserver = null;     // waits for the map container to actually get a size

// Select mode state
let _points = null;        // points.json — used only for snapping and state lookup
let _pointsTrailId = null;
let _startSnap = null;
let _endSnap = null;
let _startMarker = null;
let _endMarker = null;
let _previewLine = null;
let _selectActive = false;

// Set by app.js; called with (startSnap, endSnap, states) once both points are chosen.
let onSegmentChosen = null;

// Set by app.js; called with (segmentId, layer) when user clicks Delete in a segment popup.
let onSegmentDelete = null;

function initMap() {
  if (_map) return;
  _map = L.map('map').setView([39.5, -98.35], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(_map);
}

async function _loadPoints(trail) {
  if (_pointsTrailId === trail.id) return;
  _points = null;
  _pointsTrailId = null;
  try {
    const resp = await fetch(`/trails/${trail.id}/data/points.json`);
    if (resp.ok) {
      _points = await resp.json();
      _pointsTrailId = trail.id;
    }
  } catch (e) {
    console.warn('points.json load failed:', trail.id, e);
  }
}

// How close the windowed guess has to land before we trust it. Beyond this the
// window was simply in the wrong place and we re-scan properly.
const _WINDOW_ACCEPT_MI = 0.25;

// Find the index in _trailCoords nearest to (lat, lng).
// approxMile lets us start the search at the right part of the trail
// instead of scanning all 312K coords. Window covers ±10% of trail length.
// Normalized against the current trail's own totalMiles — every trail has a
// different length, so a fixed mile constant here would misjudge the search
// window for anything that isn't that one trail.
function _nearestTrailIndex(lat, lng, approxMile) {
  if (!_trailCoords || _trailCoords.length === 0) return -1;
  const n = _trailCoords.length;
  const frac = Math.max(0, Math.min(1, (approxMile ?? 0) / (_trailTotalMiles || 1)));
  const center = Math.round(frac * (n - 1));
  const radius = Math.round(n * 0.10); // ±10% of trail length — generous enough
  const lo = Math.max(0, center - radius);
  const hi = Math.min(n - 1, center + radius);
  let bestIdx = center, bestDist = Infinity;
  for (let i = lo; i <= hi; i++) {
    const d = haversine(lat, lng, _trailCoords[i].lat, _trailCoords[i].lng);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }

  // The window above assumes array position tracks mileage, which only holds
  // when vertices are spread evenly. Where a trail mixes densely surveyed tread
  // with sparse connecting-route lines (Ice Age runs ~286 vertices/mi against
  // ~2), the guess can land tens of miles off. Falling back to a full scan only
  // when the windowed result is visibly bad keeps the fast path for every trail
  // it already suits.
  if (bestDist > _WINDOW_ACCEPT_MI) {
    for (let i = 0; i < n; i++) {
      const d = haversine(lat, lng, _trailCoords[i].lat, _trailCoords[i].lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
  }
  return bestIdx;
}

// Brute-force nearest-point search over a small coordinate array (an alt
// branch, not the full trail spine) — no windowing needed at this size.
function _nearestIndexInArray(coords, lat, lng) {
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversine(lat, lng, coords[i].lat, coords[i].lng);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return { idx: bestIdx, dist: bestDist };
}

// Perpendicular distance from a point to the segment AB, in miles. Distance to
// the nearest vertex is not a substitute: where a branch is digitised sparsely
// (road walks can run 0.04mi between vertices) a point sitting exactly on the
// line can still be 150ft from every vertex of it.
function _distToSegmentMi(lat, lng, A, B) {
  const kx = Math.cos(lat * Math.PI / 180);
  const ax = (A.lng - lng) * kx, ay = A.lat - lat;
  const bx = (B.lng - lng) * kx, by = B.lat - lat;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 ? ((-ax) * dx + (-ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.sqrt(cx * cx + cy * cy) * 69.0;
}

function _distToPathMi(coords, lat, lng) {
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const d = _distToSegmentMi(lat, lng, coords[i - 1], coords[i]);
    if (d < best) { best = d; if (best < 1e-4) break; }
  }
  return best;
}

// Which branch a lat/lng belongs to: 'main' spine, or an alt-route passage id
// (e.g. "11e"). Alt routes run physically separate from the main spine, so a
// point genuinely on one lands within _CHAIN_TOLERANCE_MI of its own line.
// Measured against the line, not its vertices, so sparsely drawn branches
// (IAT's road walks) classify the same as densely drawn ones.
function _branchAt(lat, lng) {
  // NEAREST branch, not the first one within tolerance. Returning the first
  // match was fine while a trail had two to five branches, but Potomac Heritage
  // has 172 side routes, many of them adjacent or crossing in Virginia — so the
  // two ends of one route could each match a different neighbour, _sliceTrail-
  // Coords would see two different branches, give up, and the segment drew as a
  // straight line instead of following the trail.
  let bestId = 'main';
  let bestDist = _CHAIN_TOLERANCE_MI;
  for (const [passageId, branch] of Object.entries(_altBranches)) {
    const d = _distToPathMi(branch.coords, lat, lng);
    if (d <= bestDist) { bestDist = d; bestId = passageId; }
  }
  return bestId;
}

function _sliceArrayByIndex(arr, si, ei) {
  const lo = Math.min(si, ei);
  const hi = Math.max(si, ei);
  if (hi <= lo) return null;
  const result = [];
  for (let i = lo; i <= hi; i++) {
    result.push([arr[i].lat, arr[i].lng]);
  }
  return result;
}

// Return the slice of trail coords between two lat/lng points as [[lat,lng],...].
// This uses the same coordinates Leaflet already drew for the red trail —
// the resulting green overlay is geometrically identical to the trail itself.
// When the trail has alt routes (e.g. AZT's 11e, 33), a segment that stays on
// one branch (all main, or both ends on the same alt route) slices from that
// branch's own coords; a segment that crosses between branches returns null
// so the caller falls back to a straight line between the two points.
function _sliceTrailCoords(startLat, startLng, startMile, endLat, endLng, endMile) {
  if (!_trailCoords || _trailCoords.length === 0) return null;

  if (Object.keys(_altBranches).length > 0) {
    const startBranch = _branchAt(startLat, startLng);
    const endBranch = _branchAt(endLat, endLng);
    if (startBranch !== endBranch) return null;

    if (startBranch !== 'main') {
      const coords = _altBranches[startBranch].coords;
      const si = _nearestIndexInArray(coords, startLat, startLng).idx;
      const ei = _nearestIndexInArray(coords, endLat, endLng).idx;
      return _sliceArrayByIndex(coords, si, ei);
    }
  }

  const si = _nearestTrailIndex(startLat, startLng, startMile);
  const ei = _nearestTrailIndex(endLat, endLng, endMile);
  return _sliceArrayByIndex(_trailCoords, si, ei);
}

// Some trails' source data splits one continuous trail into multiple
// MultiLineString parts (e.g. at digitizing boundaries); others have
// genuinely disconnected GPS survey artifacts mixed in as extra parts.
// Parts whose endpoints land within this distance of each other are
// treated as continuations of the same line; parts that never connect
// to anything are artifacts and get dropped. ~100ft.
const _CHAIN_TOLERANCE_MI = 100 / 5280;

function _latLngClose(a, b) {
  return haversine(a.lat, a.lng, b.lat, b.lng) <= _CHAIN_TOLERANCE_MI;
}

// Merges a MultiLineString's parts (array of LatLng[]) into one continuous
// LatLng[] by iteratively attaching any part whose start or end connects
// to either end of the growing chain (in either direction). Seeded from
// the longest part, since that's most likely to be real primary geometry
// rather than a stray fragment. Parts that never attach are left out.
function _chainParts(parts) {
  if (parts.length === 1) return parts[0];

  const remaining = parts.slice();
  let seedIdx = 0;
  for (let i = 1; i < remaining.length; i++) {
    if (remaining[i].length > remaining[seedIdx].length) seedIdx = i;
  }
  let chain = remaining.splice(seedIdx, 1)[0].slice();

  let attached = true;
  while (attached && remaining.length > 0) {
    attached = false;
    for (let i = 0; i < remaining.length; i++) {
      const part = remaining[i];
      const partStart = part[0], partEnd = part[part.length - 1];
      const chainStart = chain[0], chainEnd = chain[chain.length - 1];

      if (_latLngClose(chainEnd, partStart)) {
        chain = chain.concat(part);
      } else if (_latLngClose(chainEnd, partEnd)) {
        chain = chain.concat(part.slice().reverse());
      } else if (_latLngClose(chainStart, partEnd)) {
        chain = part.concat(chain);
      } else if (_latLngClose(chainStart, partStart)) {
        chain = part.slice().reverse().concat(chain);
      } else {
        continue;
      }
      remaining.splice(i, 1);
      attached = true;
      break;
    }
  }

  return chain;
}

// Frame the trail, and do not do it until the container has a real size.
//
// #map-view is hidden until a trail is opened, so Leaflet is created against a
// zero-size container. fitBounds then picks a near-minimum zoom — a world view —
// and invalidateSize() afterwards does NOT rescue it: it corrects the size but
// preserves zoom and centre, so the bad zoom survives and the trail shows as a
// speck. A single requestAnimationFrame was not enough to beat the layout
// either, which is why this waits on a ResizeObserver instead of a timing
// guess: the fit happens the first time the element reports real dimensions.
function _applyFit() {
  if (!_map || !_trailFitBounds) return;
  _map.invalidateSize();
  _map.fitBounds(_trailFitBounds, { padding: [20, 20] });
  _map.setZoom(_map.getZoom() + 0.5);
}

function _fitTrail() {
  if (!_map || !_trailFitBounds) return;
  const el = _map.getContainer();
  if (el && el.clientWidth > 0 && el.clientHeight > 0) {
    _applyFit();
    return;
  }
  if (_fitObserver || typeof ResizeObserver === 'undefined') return;
  _fitObserver = new ResizeObserver(() => {
    const c = _map && _map.getContainer();
    if (!c || !c.clientWidth || !c.clientHeight) return;
    _fitObserver.disconnect();
    _fitObserver = null;
    _applyFit();
  });
  _fitObserver.observe(el);
}

// Called by app.js once the map view is shown. Safe to call more than once.
function refitTrail() {
  _fitTrail();
}

async function loadTrail(trail, segments) {
  initMap();

  if (_trailLayer) { _map.removeLayer(_trailLayer); _trailLayer = null; }
  if (_fitObserver) { _fitObserver.disconnect(); _fitObserver = null; }
  _trailFitBounds = null;
  _trailCoords = null;
  _altBranches = {};
  _trailTotalMiles = trail.totalMiles;
  _segmentLayers.forEach(l => _map.removeLayer(l));
  _segmentLayers = [];

  // Load points.json for snapping and state lookup during segment selection.
  await _loadPoints(trail);

  // trail.geojsonFile === null means no file exists for this trail
  if (trail.geojsonFile !== null) {
    const filename = trail.geojsonFile ?? 'trail.geojson';
    try {
      const resp = await fetch(`/trails/${trail.id}/data/${filename}`);
      if (resp.ok) {
        const geojson = await resp.json();
        _trailLayer = L.geoJSON(geojson, {
          // Two kinds of roadwalk share this dashed style but not their
          // mileage treatment: route_id "roadwalk" is a non-hikeable gap
          // connector (Natchez's parkway), while route_type "roadwalk" is
          // designated trail that hikers really walk (Ice Age's connecting
          // routes) and stays part of the spine below.
          // `route_kind` deliberately does NOT affect styling: spine,
          // alternate and side all draw the same, so the whole trail reads as
          // one network. The distinction lives in the data and in what counts
          // toward progress, not in the rendering. (A side-route style was
          // tried and removed — revisit only if the map becomes hard to read.)
          style: (feature) => (feature?.properties?.route_id === 'roadwalk' ||
                               feature?.properties?.route_type === 'roadwalk')
            ? { color: '#8a7f6a', weight: 2.5, opacity: 0.7, dashArray: '2 8' }
            : { color: '#e06060', weight: 3, opacity: 0.75 },
        }).addTo(_map);

        // Cache trail coords so segments can reuse the exact same geometry.
        // Most trails' geojson has one feature per passage/section/state rather
        // than a single combined line, so every feature must be included —
        // concatenated in document order, which is already south-to-north (or
        // equivalent) in each trail's build script.
        // A feature tagged "alt_of" (e.g. AZT's 11e, 33) is a physically
        // separate alternate route, not a continuation of the spine — folding
        // its coords into the same concatenation would make mile values stop
        // mapping monotonically to array position. Keep it in its own branch.
        _trailCoords = [];
        for (const layer of _trailLayer.getLayers()) {
          const latlngs = layer.getLatLngs();
          // MultiLineString → latlngs is an array of parts; chain together
          // whichever parts form one continuous line and drop the rest.
          const part = Array.isArray(latlngs[0]) ? _chainParts(latlngs) : latlngs;
          const altOf = layer.feature?.properties?.alt_of;
          const routeId = layer.feature?.properties?.route_id;
          if (routeId === 'roadwalk') {
            // Roadwalk connectors (e.g. Natchez Trace's parkway gaps) are
            // rendered for map continuity but carry no points.json entries,
            // so they're never hikeable — skip them entirely rather than
            // folding them into either the spine or an alt branch.
            continue;
          } else if (altOf) {
            // route_id is the canonical branch key; passage is AZT's own
            // numbering, kept as a fallback for any geojson that predates
            // route_id.
            // A branch can span several features (Ice Age's East Alternate is
            // five tread segments plus its connecting roadwalk), so append
            // rather than replace — the geojson emits them in branch order.
            const altId = routeId ?? layer.feature.properties.passage;
            if (!_altBranches[altId]) {
              _altBranches[altId] = { altOf, kind: 'alternate', coords: [] };
            }
            for (const pt of part) _altBranches[altId].coords.push(pt);
          } else if (layer.feature?.properties?.route_kind === 'side') {
            // Side routes are hikeable and loggable but substitute for no part
            // of the spine, so they must not join _trailCoords — doing so is
            // what made Potomac Heritage's 300 miles of Virginia corrupt the
            // mile axis. They ride the same storage as an alternate because
            // _branchAt and _sliceTrailCoords then work on them unchanged;
            // `kind` is what tells a substitute from an addition, which is the
            // distinction the two completion badges turn on.
            const sideId = routeId ?? 'side';
            if (!_altBranches[sideId]) {
              _altBranches[sideId] = { altOf: null, kind: 'side', coords: [] };
            }
            for (const pt of part) _altBranches[sideId].coords.push(pt);
          } else {
            for (const pt of part) _trailCoords.push(pt);
          }
        }

        // Fit to the SPINE, not to every feature. _trailLayer.getBounds()
        // covers side routes too, and on Potomac Heritage those run 300 miles
        // across Virginia and out to the Eastern Continental Divide — enough to
        // shrink the actual trail to a thread. Side routes stay on the map;
        // they just do not get to decide the opening view. Falls back to the
        // layer bounds for any trail whose spine array came out empty.
        _trailFitBounds = (_trailCoords && _trailCoords.length)
          ? L.latLngBounds(_trailCoords)
          : _trailLayer.getBounds();
        _fitTrail();
      }
    } catch (e) {
      console.warn('Trail GeoJSON load failed:', trail.id, e);
    }
  }

  for (const seg of segments) {
    _addSegmentLine(seg);
  }

  if (!_trailLayer && _segmentLayers.length > 0) {
    _map.fitBounds(L.featureGroup(_segmentLayers).getBounds(), { padding: [40, 40] });
  }
}

function _addSegmentLine(seg) {
  // Slice the trail's own GeoJSON coordinates between the two endpoints.
  // This is geometrically identical to the red trail — just recolored green.
  const path = _sliceTrailCoords(
    seg.start_lat, seg.start_lng, seg.start_mile,
    seg.end_lat,   seg.end_lng,   seg.end_mile
  ) ?? [[seg.start_lat, seg.start_lng], [seg.end_lat, seg.end_lng]];

  const line = L.polyline(path, {
    color: '#2ecc71', weight: 5, opacity: 0.85, smoothFactor: 0,
  }).addTo(_map);

  const parts = [];
  if (seg.start_mile != null && seg.end_mile != null) {
    const lo   = Math.min(seg.start_mile, seg.end_mile).toFixed(1);
    const hi   = Math.max(seg.start_mile, seg.end_mile).toFixed(1);
    const dist = Math.abs(seg.end_mile - seg.start_mile).toFixed(1);
    parts.push(`<strong>Mile ${lo} → ${hi}</strong> &nbsp;(${dist} mi)`);
  }
  if (seg.states)     parts.push(seg.states);
  if (seg.date_begun) parts.push(seg.date_begun);
  parts.push(`<button class="popup-delete-btn" data-segid="${seg.id}">Delete segment</button>`);
  line.bindPopup(parts.join('<br>'));

  line.on('popupopen', () => {
    const btn = document.querySelector(`.popup-delete-btn[data-segid="${seg.id}"]`);
    if (btn) btn.addEventListener('click', () => {
      line.closePopup();
      if (onSegmentDelete) onSegmentDelete(seg.id, line);
    }, { once: true });
  });

  _segmentLayers.push(line);
}

// Called from app.js after a segment is saved.
function addSegmentToMap(seg) {
  _addSegmentLine(seg);
}

// Called from app.js after a segment is deleted.
function removeSegmentLayer(layer) {
  _map.removeLayer(layer);
  const idx = _segmentLayers.indexOf(layer);
  if (idx !== -1) _segmentLayers.splice(idx, 1);
}

async function enterSelectMode(trail) {
  if (_selectActive) exitSelectMode();
  _selectActive = true;
  _startSnap = null;
  _endSnap = null;

  document.getElementById('select-status-bar').classList.remove('hidden');
  document.getElementById('track-segment-btn').classList.add('hidden');
  _setStatusText('Loading trail data…');

  // Disable double-click zoom only — pan and pinch-zoom stay active so the
  // user can navigate between selecting the start and end points.
  _map.doubleClickZoom.disable();

  await _loadPoints(trail); // no-op if already cached

  _setStatusText('Tap your start point');
  _map.on('click', _onMapClick);
}

function exitSelectMode() {
  if (_map) {
    _map.off('click', _onMapClick);
    if (_selectActive) _map.doubleClickZoom.enable();
  }
  _selectActive = false;

  if (_startMarker) { _map.removeLayer(_startMarker); _startMarker = null; }
  if (_endMarker)   { _map.removeLayer(_endMarker);   _endMarker = null;   }
  if (_previewLine) { _map.removeLayer(_previewLine); _previewLine = null; }

  document.getElementById('select-status-bar').classList.add('hidden');
  document.getElementById('track-segment-btn').classList.remove('hidden');
  document.getElementById('track-mode-toggle').classList.add('hidden');

  _startSnap = null;
  _endSnap = null;
}

// One shape for every snap. The route fields travel with it: a side route's
// `mile` is LOCAL to that route, so without route_id a caller cannot tell
// whether two miles are even on the same axis.
function _snapRecord(p) {
  const kind = p.route_kind ?? 'spine';
  return {
    lat: p.lat, lng: p.lon,
    // `mile` locates the point on whatever axis it belongs to. `dist_mile` is
    // the one that may be SUBTRACTED to get a real distance, and they are not
    // always the same: an ALTERNATE's mile is interpolated across the spine
    // span it substitutes for (the IAT pattern — built for lookup), so
    // differencing it overstates length. The DC River Trail is 7.24mi but
    // spans spine miles 322.7 to 352.0, a four-fold error. sec_mile is the
    // route-local measure, so that is what an alternate differences on.
    mile: p.mile ?? null,
    dist_mile: kind === 'alternate' ? (p.sec_mile ?? null) : (p.mile ?? null),
    sec_mile: p.sec_mile ?? null,
    state: p.state ?? null,
    route_id: p.route_id ?? 'main',
    route_kind: kind,
    junction_mile: p.junction_mile ?? null,
    junction_sec_mile: p.junction_sec_mile ?? null,
  };
}

// Where a route meets the spine, as a pair of real points, so a split segment
// gets proper endpoints instead of an interpolated guess.
function junctionPointsFor(routeId) {
  if (!_points) return null;
  const onRoute = _points.find(p => (p.route_id ?? 'main') === routeId && p.junction_mile != null);
  if (!onRoute) return null;
  const spineMile = onRoute.junction_mile;
  const routeMile = onRoute.junction_sec_mile;
  if (routeMile == null) return null;
  let spinePt = null, routePt = null;
  for (const p of _points) {
    const rid = p.route_id ?? 'main';
    if (rid === 'main') {
      if (!spinePt || Math.abs(p.mile - spineMile) < Math.abs(spinePt.mile - spineMile)) spinePt = p;
    } else if (rid === routeId) {
      if (!routePt || Math.abs((p.sec_mile ?? 0) - routeMile) < Math.abs((routePt.sec_mile ?? 0) - routeMile)) routePt = p;
    }
  }
  if (!spinePt || !routePt) return null;
  return { spineMile, routeMile, spinePt, routePt };
}

// Split a hike whose ends are on different routes into one leg per route,
// meeting at the junction. Returns null where it cannot be done honestly —
// notably two different off-spine routes, which would need the path between
// them; the caller refuses those rather than guessing.
function splitAtJunction(a, b) {
  if ((a.route_id ?? 'main') === (b.route_id ?? 'main')) return null;
  const spineEnd = a.route_kind === 'spine' ? a : (b.route_kind === 'spine' ? b : null);
  const offEnd = a.route_kind === 'spine' ? b : (b.route_kind === 'spine' ? a : null);
  if (!spineEnd || !offEnd) return null;
  const j = junctionPointsFor(offEnd.route_id);
  if (!j) return null;
  return [
    { route_id: 'main', route_kind: 'spine',
      start: spineEnd, end: _snapRecord(j.spinePt) },
    { route_id: offEnd.route_id, route_kind: offEnd.route_kind,
      start: _snapRecord(j.routePt), end: offEnd },
  ];
}

function _snapToNearest(lat, lng) {
  if (!_points || _points.length === 0) return { lat, lng, mile: null, state: null };
  let best = _points[0];
  let bestDist = haversine(lat, lng, best.lat, best.lon);
  for (let i = 1; i < _points.length; i++) {
    const d = haversine(lat, lng, _points[i].lat, _points[i].lon);
    if (d < bestDist) { bestDist = d; best = _points[i]; }
  }
  return _snapRecord(best);
}

function _getStatesForSegment(startMile, endMile, routeId) {
  if (!_points || startMile == null || endMile == null) return null;
  const lo = Math.min(startMile, endMile);
  const hi = Math.max(startMile, endMile);
  const rid = routeId ?? 'main';
  const seen = new Set();
  for (const p of _points) {
    // Filtered to one route on purpose: a side route's mile restarts at 0, so
    // scanning every point mixes a 0-20 spine span with unrelated side-route
    // miles 0-20 hundreds of miles away.
    if ((p.route_id ?? 'main') !== rid) continue;
    if (p.mile >= lo - 0.05 && p.mile <= hi + 0.05 && p.state) seen.add(p.state);
  }
  return seen.size > 0 ? [...seen].join(' · ') : null;
}

function _onMapClick(e) {
  if (!_selectActive) return;
  const snap = _snapToNearest(e.latlng.lat, e.latlng.lng);

  if (!_startSnap) {
    _startSnap = snap;
    _startMarker = L.circleMarker([snap.lat, snap.lng], {
      radius: 8, fillColor: '#e06060', color: '#fff', weight: 2.5, fillOpacity: 1,
    }).addTo(_map);
    _setStatusText('Tap your end point');
  } else {
    _endSnap = snap;
    _endMarker = L.circleMarker([snap.lat, snap.lng], {
      radius: 8, fillColor: '#2ecc71', color: '#fff', weight: 2.5, fillOpacity: 1,
    }).addTo(_map);

    const previewPath = _sliceTrailCoords(
      _startSnap.lat, _startSnap.lng, _startSnap.mile,
      snap.lat, snap.lng, snap.mile
    ) ?? [[_startSnap.lat, _startSnap.lng], [snap.lat, snap.lng]];
    _previewLine = L.polyline(previewPath, {
      color: '#2ecc71', weight: 4, opacity: 0.7, dashArray: '8 6', smoothFactor: 0,
    }).addTo(_map);

    _setStatusText('Review your segment below');
    _map.off('click', _onMapClick);

    if (onSegmentChosen) {
      const states = _getStatesForSegment(_startSnap.mile, _endSnap.mile, _startSnap.route_id);
      onSegmentChosen(_startSnap, _endSnap, states);
    }
  }
}

function _setStatusText(text) {
  document.getElementById('select-status-text').textContent = text;
}

// Expose loaded points so app.js can build state dropdowns for form mode.
function getLoadedPoints() {
  return _points;
}

// Find the nearest point by mile value, optionally filtered to one state.
// Used by form mode to snap typed miles to real trail coordinates.
function snapByMile(targetMile, state) {
  if (!_points || _points.length === 0) return null;
  // Spine points only: form mode asks for a trail mile, and a side route's
  // mile restarts at 0, so an unfiltered search can snap a typed mile 10 onto
  // an unrelated side route hundreds of miles away.
  const spineOnly = _points.filter(p => (p.route_id ?? 'main') === 'main');
  const candidates = state ? spineOnly.filter(p => p.state === state) : spineOnly;
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestDist = Math.abs((best.mile ?? 0) - targetMile);
  for (const p of candidates) {
    const d = Math.abs((p.mile ?? 0) - targetMile);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return _snapRecord(best);
}

// Draw a preview segment from form-mode inputs, then fire onSegmentChosen.
// Mirrors the end of _onMapClick but without requiring select mode to be active.
function enterFormPreview(startSnap, endSnap) {
  if (_startMarker) { _map.removeLayer(_startMarker); _startMarker = null; }
  if (_endMarker)   { _map.removeLayer(_endMarker);   _endMarker = null;   }
  if (_previewLine) { _map.removeLayer(_previewLine); _previewLine = null; }

  _startMarker = L.circleMarker([startSnap.lat, startSnap.lng], {
    radius: 8, fillColor: '#e06060', color: '#fff', weight: 2.5, fillOpacity: 1,
  }).addTo(_map);
  _endMarker = L.circleMarker([endSnap.lat, endSnap.lng], {
    radius: 8, fillColor: '#2ecc71', color: '#fff', weight: 2.5, fillOpacity: 1,
  }).addTo(_map);

  const path = _sliceTrailCoords(
    startSnap.lat, startSnap.lng, startSnap.mile,
    endSnap.lat,   endSnap.lng,   endSnap.mile
  ) ?? [[startSnap.lat, startSnap.lng], [endSnap.lat, endSnap.lng]];

  _previewLine = L.polyline(path, {
    color: '#2ecc71', weight: 4, opacity: 0.7, dashArray: '8 6', smoothFactor: 0,
  }).addTo(_map);

  _map.fitBounds(
    L.featureGroup([_startMarker, _endMarker]).getBounds(),
    { padding: [60, 60] }
  );

  if (onSegmentChosen) {
    const states = _getStatesForSegment(startSnap.mile, endSnap.mile);
    onSegmentChosen(startSnap, endSnap, states);
  }
}
