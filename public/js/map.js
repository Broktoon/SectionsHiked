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
let _trailMeta = null;     // the trail's *_meta.json, when it has one
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
  _trailMeta = null;
  _pointsTrailId = null;
  try {
    const resp = await fetch(`/trails/${trail.id}/data/points.json`);
    if (!resp.ok) return;
    let pts = await resp.json();

    // A trail on the canonical 7-field schema stores only lat, lon, mile,
    // route_id, route_type and state. Everything else this file reads —
    // sec_mile, region_id, route_kind, junction_mile and the rest — is
    // rebuilt from its meta file, which holds each value once instead of
    // copying it onto every point.
    //
    // Gated on the meta carrying a `hydrate` block, so a trail that has not
    // been converted yet loads exactly as before. Two of the eleven are
    // converted today; the other nine take this path unchanged.
    if (trail.metaFile) {
      try {
        const mresp = await fetch(`/trails/${trail.id}/data/${trail.metaFile}`);
        if (mresp.ok) {
          const meta = await mresp.json();
          _trailMeta = meta;
          if (meta && meta.hydrate && typeof hydratePoints === 'function') {
            pts = hydratePoints(pts, meta);
          }
        }
      } catch (e) {
        console.warn('meta load failed:', trail.id, e);
      }
    }

    _points = pts;
    _pointsTrailId = trail.id;
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
// `routeId`, when given, is the route this span is KNOWN to lie on, and is
// used in place of guessing from proximity. A junction point sits within a few
// feet of two routes by definition, so _branchAt would return one route for the
// start and another for the end of a perfectly valid leg, and the whole leg
// would fall back to a straight line. That is what drew a hike from Fletcher's
// Cove to Georgetown straight across Georgetown University.
function _sliceTrailCoords(startLat, startLng, startMile, endLat, endLng, endMile, routeId) {
  if (!_trailCoords || _trailCoords.length === 0) return null;

  if (Object.keys(_altBranches).length > 0) {
    const startBranch = routeId ?? _branchAt(startLat, startLng);
    const endBranch = routeId ?? _branchAt(endLat, endLng);
    if (startBranch !== endBranch) return null;

    // An off-spine route with no branch geometry must NOT fall through to the
    // spine slice below: that would silently draw a span of the main trail in
    // place of the route the hiker actually walked. A straight line is wrong
    // but visibly wrong; spine geometry would be wrong and plausible.
    if (startBranch !== 'main' && !_altBranches[startBranch]) return null;

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
  _addGroupJoiners(segments);

  if (!_trailLayer && _segmentLayers.length > 0) {
    _map.fitBounds(L.featureGroup(_segmentLayers).getBounds(), { padding: [40, 40] });
  }
}

// One hike split across routes is stored as a row per route, and each row's
// line stops at its own route's edge. The routes themselves are digitised tens
// of feet apart, so the drawn hike came out with unpainted gaps at every
// junction — in Georgetown that read as a break across the canal, where the
// towpath and the river trail are linked 138 ft apart.
//
// The hiker crossed there, so the link is drawn. It is a short straight hop
// rather than the real connector (a footbridge, a ramp) because the source
// carries no geometry between the two routes at all; nothing is being invented
// beyond joining two endpoints the route graph already treats as adjacent.
// Pairs are matched by proximity rather than by leg order, since the rows
// carry no ordering of their own.
//
// Matching and drawing use DIFFERENT coordinates, deliberately. Adjacency is
// tested on the stored endpoints, which are points.json records and the basis
// on which ROUTE_LINK_TOL was chosen. The hop itself is drawn between the
// endpoints the legs were actually RENDERED at, which are nearest vertices in
// the thinned GeoJSON and sit up to a few tens of feet away. Drawing between
// the stored endpoints instead left the hop floating clear of both legs, so
// the canal crossing in Georgetown appeared twice and joined nothing.
function _addGroupJoiners(segments) {
  const groups = new Map();
  for (const s of segments) {
    if (!s.hike_group_id) continue;
    if (!groups.has(s.hike_group_id)) groups.set(s.hike_group_id, []);
    groups.get(s.hike_group_id).push(s);
  }
  for (const legs of groups.values()) {
    if (legs.length < 2) continue;
    const ends = [];
    legs.forEach((s, i) => {
      const path = _segmentPath(s);
      const head = path[0], tail = path[path.length - 1];
      // The slice comes back in trail order, which may be the reverse of the
      // row, so decide which drawn end belongs to which stored end by distance.
      const flip = haversine(s.start_lat, s.start_lng, tail[0], tail[1])
                 < haversine(s.start_lat, s.start_lng, head[0], head[1]);
      const drawnStart = flip ? tail : head;
      const drawnEnd   = flip ? head : tail;
      ends.push({ leg: i, lat: s.start_lat, lng: s.start_lng, draw: drawnStart });
      ends.push({ leg: i, lat: s.end_lat,   lng: s.end_lng,   draw: drawnEnd });
    });
    const joined = new Set();
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        if (ends[i].leg === ends[j].leg) continue;
        const d = haversine(ends[i].lat, ends[i].lng, ends[j].lat, ends[j].lng);
        if (d > ROUTE_LINK_TOL) continue;
        const key = Math.min(ends[i].leg, ends[j].leg) + ':' + Math.max(ends[i].leg, ends[j].leg);
        if (joined.has(key)) continue;
        joined.add(key);
        const line = L.polyline(
          [ends[i].draw, ends[j].draw],
          { color: '#2ecc71', weight: 5, opacity: 0.85, smoothFactor: 0 }
        ).addTo(_map);
        _segmentLayers.push(line);
      }
    }
  }
}

// The coordinates one stored row is drawn along. Shared by the renderer and by
// the junction joiner, so the joiner cannot disagree with what is on screen.
function _segmentPath(seg) {
  return _sliceTrailCoords(
    seg.start_lat, seg.start_lng, seg.start_mile,
    seg.end_lat,   seg.end_lng,   seg.end_mile,
    seg.route_id ?? 'main'
  ) ?? [[seg.start_lat, seg.start_lng], [seg.end_lat, seg.end_lng]];
}

function _addSegmentLine(seg) {
  // Slice the trail's own GeoJSON coordinates between the two endpoints.
  // This is geometrically identical to the red trail — just recolored green.
  const path = _segmentPath(seg);

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
  if (_selectActive) {
    const el = typeof line.getElement === "function" ? line.getElement() : null;
    if (el && el.style) el.style.pointerEvents = "none";
  }
}

// Called from app.js after a segment is saved.
function addSegmentToMap(seg) {
  _addSegmentLine(seg);
}

// Called from app.js once, after a multi-leg save, so the junction links
// appear immediately rather than only on the next load.
function addSegmentJoiners(segs) {
  _addGroupJoiners(segs);
}

// Called from app.js after a segment is deleted.
// A saved segment is a clickable line carrying a delete popup, which is right
// in Navigate mode and wrong while the user is tapping out a new segment: the
// line swallows the tap, so the one point you most want to start from -- the
// end of the segment you are continuing -- is the one point you cannot pick.
// Clicking just beside it instead leaves a real gap of one point spacing (264ft
// on Potomac Heritage). Sharing the endpoint draws with no gap at all, so
// letting the tap through fixes the gap and the popup together.
//
// pointer-events is set on each path rather than on the pane, because Leaflet
// gives interactive paths their own pointer-events rule and a descendant can
// re-enable what an ancestor switched off.
function _setSegmentsClickable(on) {
  for (const layer of _segmentLayers) {
    const el = typeof layer.getElement === "function" ? layer.getElement() : null;
    if (el && el.style) el.style.pointerEvents = on ? "" : "none";
  }
}

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
  // A popup left open from Navigate mode would sit over the map during
  // selection, and its line would keep taking taps.
  _map.closePopup();
  _setSegmentsClickable(false);
  _map.on('click', _onMapClick);
}

function exitSelectMode() {
  if (_map) {
    _map.off('click', _onMapClick);
    if (_selectActive) _map.doubleClickZoom.enable();
  }
  _selectActive = false;
  _setSegmentsClickable(true);

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
    // `mile` may now be subtracted directly on every route. It used to be
    // two different measures wearing one name: an alternate's mile was
    // interpolated across the spine span it substitutes for, so differencing
    // it overstated a hike fourfold (the DC River Trail is 7.24mi but spanned
    // spine miles 322.7 to 352.0). That is what `dist_mile` existed to work
    // around. Every off-spine route now carries its own route-local mile, so
    // the workaround is gone and the junction attachment lives in the meta
    // routes table instead.
    mile: p.mile ?? null,
    sec_mile: p.sec_mile ?? null,
    state: p.state ?? null,
    route_id: p.route_id ?? 'main',
    route_kind: kind,
    junction_mile: p.junction_mile ?? null,
    junction_sec_mile: p.junction_sec_mile ?? null,
  };
}

// junctionPointsFor() lived here. It found where ONE route met the spine,
// from the meta's junction_mile. The route graph below supersedes it: it
// derives every route-to-route contact from the geometry, so a route that
// reaches the spine only through another route is now routable too.

// How close two routes must come before a hiker can step between them.
// Chosen from the data, not by feel: on Potomac Heritage 169 route pairs sit
// within this distance and only 4 more fall in the next 86ft, so the cut lands
// in a gap rather than mid-cluster. The source digitises adjoining trails as
// separate features with slightly different endpoints, which is why touching
// routes still read tens of feet apart.
const ROUTE_LINK_TOL = 0.05;   // miles (264 ft)

// Adjacency between routes, built once per trail from the points themselves.
// `junction_mile` in the meta only ever recorded route-to-SPINE attachment, so
// a route reaching the spine THROUGH another route had no junction at all and
// any hike crossing it was stored with null miles and drawn as a straight line.
// On Potomac Heritage that stranded 33 routes and 40 miles, the Mount Vernon
// Trail among them.
let _routeGraph = null;
let _routeGraphTrailId = null;

function _buildRouteGraph() {
  if (_routeGraph && _routeGraphTrailId === _pointsTrailId) return _routeGraph;
  const edges = new Map();        // "a|b" -> { gap, aPt, bPt }
  if (!_points || !_points.length) {
    _routeGraph = { adj: new Map(), edges };
    _routeGraphTrailId = _pointsTrailId;
    return _routeGraph;
  }
  // Grid index, so this is a few thousand comparisons rather than every point
  // against every other point.
  const CELL = 0.01;
  const grid = new Map();
  for (const p of _points) {
    const k = Math.round(p.lat / CELL) + ':' + Math.round(p.lon / CELL);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }
  for (const p of _points) {
    const pid = p.route_id ?? 'main';
    const ci = Math.round(p.lat / CELL), cj = Math.round(p.lon / CELL);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const cell = grid.get((ci + di) + ':' + (cj + dj));
      if (!cell) continue;
      for (const q of cell) {
        const qid = q.route_id ?? 'main';
        if (pid === qid) continue;
        const d = haversine(p.lat, p.lon, q.lat, q.lon);
        if (d > ROUTE_LINK_TOL) continue;
        const k = pid < qid ? pid + '|' + qid : qid + '|' + pid;
        const cur = edges.get(k);
        if (cur === undefined || d < cur.gap) {
          edges.set(k, pid < qid ? { gap: d, aPt: p, bPt: q } : { gap: d, aPt: q, bPt: p });
        }
      }
    }
  }
  const adj = new Map();
  for (const k of edges.keys()) {
    const [a, b] = k.split('|');
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  _routeGraph = { adj, edges };
  _routeGraphTrailId = _pointsTrailId;
  return _routeGraph;
}

// The two real points where routes `a` and `b` meet, oriented for the caller.
function _linkPoints(g, a, b) {
  const k = a < b ? a + '|' + b : b + '|' + a;
  const e = g.edges.get(k);
  if (!e) return null;
  return a < b ? { exit: e.aPt, entry: e.bPt } : { exit: e.bPt, entry: e.aPt };
}

// Fewest routes crossed, which is what a hiker would actually walk.
function _routePath(fromId, toId) {
  const g = _buildRouteGraph();
  if (fromId === toId) return [fromId];
  if (!g.adj.has(fromId) || !g.adj.has(toId)) return null;
  const prev = new Map([[fromId, null]]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === toId) {
      const path = [];
      for (let n = toId; n != null; n = prev.get(n)) path.unshift(n);
      return path;
    }
    for (const nxt of (g.adj.get(cur) || [])) {
      if (!prev.has(nxt)) { prev.set(nxt, cur); queue.push(nxt); }
    }
  }
  return null;
}

// The drawn path between two snapped points, following the trail across as
// many routes as it takes. Used for the preview line so what the user sees
// while choosing matches what gets stored and redrawn afterwards; returns
// null when there is no walkable chain, and the caller draws a straight hint.
function _pathAcrossRoutes(a, b) {
  const aid = a.route_id ?? 'main';
  const bid = b.route_id ?? 'main';
  if (aid === bid) {
    return _sliceTrailCoords(a.lat, a.lng, a.mile, b.lat, b.lng, b.mile, aid);
  }
  const legs = splitAtJunction(a, b);
  if (!legs) return null;
  const out = [];
  for (const lg of legs) {
    const part = _sliceTrailCoords(
      lg.start.lat, lg.start.lng, lg.start.mile,
      lg.end.lat, lg.end.lng, lg.end.mile, lg.route_id
    );
    if (!part || !part.length) return null;
    // A slice comes back in the array's own order, which may run opposite to
    // the direction walked. Concatenating without checking makes the line
    // double back on itself at every junction -- the preview measured 5.26mi
    // for a 2.65mi hike before this.
    const head = part[0], tail = part[part.length - 1];
    const toStart = haversine(lg.start.lat, lg.start.lng, head[0], head[1]);
    const toEnd = haversine(lg.start.lat, lg.start.lng, tail[0], tail[1]);
    const ordered = toEnd < toStart ? part.slice().reverse() : part;
    for (const c of ordered) {
      const prev = out[out.length - 1];
      if (prev && prev[0] === c[0] && prev[1] === c[1]) continue;
      out.push(c);
    }
  }
  return out.length ? out : null;
}

// Split a hike whose ends are on different routes into one leg per route it
// crosses, each leg measured on its own axis and drawn from its own geometry.
// Returns null only where no walkable chain of routes connects the two ends;
// the caller then stores one unlinked row, as before.
function splitAtJunction(a, b) {
  const aid = a.route_id ?? 'main';
  const bid = b.route_id ?? 'main';
  if (aid === bid) return null;
  const path = _routePath(aid, bid);
  if (!path || path.length < 2) return null;
  const g = _buildRouteGraph();
  const kindOf = (rid, fallback) => {
    if (rid === 'main') return 'spine';
    const pt = _points.find(p => (p.route_id ?? 'main') === rid);
    return (pt && pt.route_kind) || fallback || 'side';
  };
  const legs = [];
  let legStart = a;
  for (let i = 0; i < path.length; i++) {
    const rid = path[i];
    const last = i === path.length - 1;
    let legEnd;
    if (last) {
      legEnd = b;
    } else {
      const link = _linkPoints(g, rid, path[i + 1]);
      if (!link) return null;
      legEnd = _snapRecord(link.exit);
    }
    legs.push({
      route_id: rid,
      route_kind: kindOf(rid, i === 0 ? a.route_kind : b.route_kind),
      start: legStart, end: legEnd,
    });
    if (!last) {
      const link = _linkPoints(g, rid, path[i + 1]);
      legStart = _snapRecord(link.entry);
    }
  }
  return legs;
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

    const previewPath = _pathAcrossRoutes(_startSnap, snap) ?? [[_startSnap.lat, _startSnap.lng], [snap.lat, snap.lng]];
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

  const path = _pathAcrossRoutes(startSnap, endSnap) ?? [[startSnap.lat, startSnap.lng], [endSnap.lat, endSnap.lng]];

  _previewLine = L.polyline(path, {
    color: '#2ecc71', weight: 4, opacity: 0.7, dashArray: '8 6', smoothFactor: 0,
  }).addTo(_map);

  _map.fitBounds(
    L.featureGroup([_startMarker, _endMarker]).getBounds(),
    { padding: [60, 60] }
  );

  if (onSegmentChosen) {
    // Pass the route: an off-spine route's mile restarts at 0, so defaulting
    // to the spine scans miles 0-N of the main axis and reports the states of
    // somewhere else entirely.
    const states = _getStatesForSegment(startSnap.mile, endSnap.mile, startSnap.route_id);
    onSegmentChosen(startSnap, endSnap, states);
  }
}
