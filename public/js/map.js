// Leaflet map setup and trail rendering.
// Requires Leaflet 1.9.4 (CDN) and trails.js to be loaded first.

let _map = null;
let _trailLayer = null;
let _segmentLayers = [];

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
          style: { color: trail.color, weight: 3, opacity: 0.5 },
        }).addTo(_map);
        _map.fitBounds(_trailLayer.getBounds(), { padding: [20, 20] });
      }
    } catch (e) {
      console.warn('Trail GeoJSON load failed:', trail.id, e);
    }
  }

  for (const seg of segments) {
    const line = L.polyline(
      [[seg.start_lat, seg.start_lng], [seg.end_lat, seg.end_lng]],
      { color: '#2ecc71', weight: 5, opacity: 0.85 },
    ).addTo(_map);
    _segmentLayers.push(line);
  }

  // If no trail line but segments exist, fit to segments
  if (!_trailLayer && _segmentLayers.length > 0) {
    _map.fitBounds(L.featureGroup(_segmentLayers).getBounds(), { padding: [40, 40] });
  }
}
