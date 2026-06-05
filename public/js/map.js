// Leaflet map setup and trail rendering.
// Requires Leaflet 1.9.4 (CDN) and trails.js to be loaded first.

let _map = null;
let _trailLayer = null;
let _segmentLayers = [];

// Select mode state
let _points = null;
let _pointsTrailId = null;
let _startSnap = null;
let _endSnap = null;
let _startMarker = null;
let _endMarker = null;
let _previewLine = null;
let _selectActive = false;

// Set by app.js; called with (startSnap, endSnap) once both points are chosen.
let onSegmentChosen = null;

function initMap() {
  if (_map) return;
  _map = L.map('map').setView([39.5, -98.35], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(_map);
}

async function loadTrail(trail, segments) {
  initMap();

  if (_trailLayer) { _map.removeLayer(_trailLayer); _trailLayer = null; }
  _segmentLayers.forEach(l => _map.removeLayer(l));
  _segmentLayers = [];

  // trail.geojsonFile === null means no file exists for this trail
  if (trail.geojsonFile !== null) {
    const filename = trail.geojsonFile ?? 'trail.geojson';
    try {
      const resp = await fetch(`/trails/${trail.id}/data/${filename}`);
      if (resp.ok) {
        const geojson = await resp.json();
        _trailLayer = L.geoJSON(geojson, {
          style: { color: '#4a7c59', weight: 3, opacity: 0.75 },
        }).addTo(_map);
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
  const line = L.polyline(
    [[seg.start_lat, seg.start_lng], [seg.end_lat, seg.end_lng]],
    { color: '#2ecc71', weight: 5, opacity: 0.85 },
  ).addTo(_map);
  _segmentLayers.push(line);
}

// Called from app.js after a segment is saved to add it to the map immediately.
function addSegmentToMap(seg) {
  _addSegmentLine(seg);
}

async function enterSelectMode(trail) {
  if (_selectActive) exitSelectMode();
  _selectActive = true;
  _startSnap = null;
  _endSnap = null;

  document.getElementById('select-status-bar').classList.remove('hidden');
  document.getElementById('track-segment-btn').classList.add('hidden');
  _setStatusText('Loading trail data…');

  _map.doubleClickZoom.disable();
  if (L.Browser.touch) {
    _map.dragging.disable();
    _map.touchZoom.disable();
    if (_map.tap) _map.tap.disable();
  }

  // Load points.json lazily; cache per trail
  if (_pointsTrailId !== trail.id) {
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

  _setStatusText('Tap your start point');
  _map.on('click', _onMapClick);
}

function exitSelectMode() {
  if (!_selectActive) return;
  _selectActive = false;
  _map.off('click', _onMapClick);

  _map.doubleClickZoom.enable();
  if (L.Browser.touch) {
    _map.dragging.enable();
    _map.touchZoom.enable();
    if (_map.tap) _map.tap.enable();
  }

  if (_startMarker) { _map.removeLayer(_startMarker); _startMarker = null; }
  if (_endMarker)   { _map.removeLayer(_endMarker);   _endMarker = null;   }
  if (_previewLine) { _map.removeLayer(_previewLine); _previewLine = null; }

  document.getElementById('select-status-bar').classList.add('hidden');
  document.getElementById('track-segment-btn').classList.remove('hidden');

  _startSnap = null;
  _endSnap = null;
}

function _snapToNearest(lat, lng) {
  if (!_points || _points.length === 0) return { lat, lng, mile: null };
  let best = _points[0];
  let bestDist = haversine(lat, lng, best.lat, best.lon);
  for (let i = 1; i < _points.length; i++) {
    const d = haversine(lat, lng, _points[i].lat, _points[i].lon);
    if (d < bestDist) { bestDist = d; best = _points[i]; }
  }
  return { lat: best.lat, lng: best.lon, mile: best.mile ?? null };
}

function _onMapClick(e) {
  if (!_selectActive) return;
  const snap = _snapToNearest(e.latlng.lat, e.latlng.lng);

  if (!_startSnap) {
    _startSnap = snap;
    _startMarker = L.circleMarker([snap.lat, snap.lng], {
      radius: 8, fillColor: '#4a7c59', color: '#fff', weight: 2.5, fillOpacity: 1,
    }).addTo(_map);
    _setStatusText('Tap your end point');
  } else {
    _endSnap = snap;
    _endMarker = L.circleMarker([snap.lat, snap.lng], {
      radius: 8, fillColor: '#2ecc71', color: '#fff', weight: 2.5, fillOpacity: 1,
    }).addTo(_map);
    _previewLine = L.polyline(
      [[_startSnap.lat, _startSnap.lng], [snap.lat, snap.lng]],
      { color: '#2ecc71', weight: 4, opacity: 0.7, dashArray: '8 6' },
    ).addTo(_map);
    _setStatusText('Review your segment below');
    _map.off('click', _onMapClick);

    if (onSegmentChosen) onSegmentChosen(_startSnap, _endSnap);
  }
}

function _setStatusText(text) {
  document.getElementById('select-status-text').textContent = text;
}
