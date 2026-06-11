// Leaflet map setup and trail rendering.
// Requires Leaflet 1.9.4 (CDN) and trails.js to be loaded first.

let _map = null;
let _trailLayer = null;
let _trailCoords = null;   // LatLng[] for run 0 of trail.geojson; set after trail loads
let _segmentLayers = [];

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

// Find the index in _trailCoords nearest to (lat, lng).
// approxMile lets us start the search at the right part of the trail
// instead of scanning all 312K coords. Window covers ±10% of trail length.
function _nearestTrailIndex(lat, lng, approxMile) {
  if (!_trailCoords || _trailCoords.length === 0) return -1;
  const n = _trailCoords.length;
  const frac = Math.max(0, Math.min(1, (approxMile ?? 0) / 2190));
  const center = Math.round(frac * (n - 1));
  const radius = Math.round(n * 0.10); // ±10% ≈ ±219 AT miles — generous enough
  const lo = Math.max(0, center - radius);
  const hi = Math.min(n - 1, center + radius);
  let bestIdx = center, bestDist = Infinity;
  for (let i = lo; i <= hi; i++) {
    const d = haversine(lat, lng, _trailCoords[i].lat, _trailCoords[i].lng);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

// Return the slice of _trailCoords between two lat/lng points as [[lat,lng],...].
// This uses the same coordinates Leaflet already drew for the red trail —
// the resulting green overlay is geometrically identical to the trail itself.
function _sliceTrailCoords(startLat, startLng, startMile, endLat, endLng, endMile) {
  if (!_trailCoords || _trailCoords.length === 0) return null;
  const si = _nearestTrailIndex(startLat, startLng, startMile);
  const ei = _nearestTrailIndex(endLat, endLng, endMile);
  const lo = Math.min(si, ei);
  const hi = Math.max(si, ei);
  if (hi <= lo) return null;
  const result = [];
  for (let i = lo; i <= hi; i++) {
    result.push([_trailCoords[i].lat, _trailCoords[i].lng]);
  }
  return result;
}

async function loadTrail(trail, segments) {
  initMap();

  if (_trailLayer) { _map.removeLayer(_trailLayer); _trailLayer = null; }
  _trailCoords = null;
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
          style: { color: '#e06060', weight: 3, opacity: 0.75 },
        }).addTo(_map);

        // Cache run 0 coords so segments can reuse the exact same geometry.
        const layers = _trailLayer.getLayers();
        if (layers.length > 0) {
          const latlngs = layers[0].getLatLngs();
          // MultiLineString → latlngs is array of arrays; run 0 is the complete trail.
          _trailCoords = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
        }

        _map.fitBounds(_trailLayer.getBounds(), { padding: [20, 20] });
        _map.setZoom(_map.getZoom() + 0.5);
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
  if (!_selectActive) return;
  _selectActive = false;
  _map.off('click', _onMapClick);

  _map.doubleClickZoom.enable();

  if (_startMarker) { _map.removeLayer(_startMarker); _startMarker = null; }
  if (_endMarker)   { _map.removeLayer(_endMarker);   _endMarker = null;   }
  if (_previewLine) { _map.removeLayer(_previewLine); _previewLine = null; }

  document.getElementById('select-status-bar').classList.add('hidden');
  document.getElementById('track-segment-btn').classList.remove('hidden');

  _startSnap = null;
  _endSnap = null;
}

function _snapToNearest(lat, lng) {
  if (!_points || _points.length === 0) return { lat, lng, mile: null, state: null };
  let best = _points[0];
  let bestDist = haversine(lat, lng, best.lat, best.lon);
  for (let i = 1; i < _points.length; i++) {
    const d = haversine(lat, lng, _points[i].lat, _points[i].lon);
    if (d < bestDist) { bestDist = d; best = _points[i]; }
  }
  return { lat: best.lat, lng: best.lon, mile: best.mile ?? null, state: best.state ?? null };
}

function _getStatesForSegment(startMile, endMile) {
  if (!_points || startMile == null || endMile == null) return null;
  const lo = Math.min(startMile, endMile);
  const hi = Math.max(startMile, endMile);
  const seen = new Set();
  for (const p of _points) {
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
      const states = _getStatesForSegment(_startSnap.mile, _endSnap.mile);
      onSegmentChosen(_startSnap, _endSnap, states);
    }
  }
}

function _setStatusText(text) {
  document.getElementById('select-status-text').textContent = text;
}
