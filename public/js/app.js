// Main app logic: dashboard, trail selection, view switching.
// Requires auth.js, db.js, trails.js, and map.js to be loaded first.

let _currentUser = null;
let _allSegments = [];

function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // miles
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function segmentMiles(seg) {
  if (seg.start_mile != null && seg.end_mile != null) {
    return Math.abs(seg.end_mile - seg.start_mile);
  }
  return haversine(seg.start_lat, seg.start_lng, seg.end_lat, seg.end_lng);
}

function renderDashboard() {
  const grid = document.getElementById('trail-grid');
  grid.innerHTML = TRAILS.map(trail => {
    const miles = _allSegments
      .filter(s => s.trail_id === trail.id)
      .reduce((sum, s) => sum + segmentMiles(s), 0);
    const pct = Math.min(100, (miles / trail.totalMiles) * 100);
    const statsText = miles > 0
      ? `${miles.toFixed(1)} of ${trail.totalMiles.toLocaleString()} mi &mdash; ${pct < 0.1 ? '<0.1' : pct.toFixed(1)}%`
      : `0 of ${trail.totalMiles.toLocaleString()} mi`;
    return `
      <button class="trail-card" data-trail-id="${trail.id}" type="button">
        <div class="trail-card-name">${trail.name}</div>
        <div class="trail-progress-bar">
          <div class="trail-progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="trail-stats">${statsText}</div>
      </button>`;
  }).join('');

  grid.querySelectorAll('.trail-card').forEach(card => {
    card.addEventListener('click', () => showTrail(card.dataset.trailId));
  });
}

function initTrailSelector() {
  const list = document.getElementById('trail-selector-list');
  list.innerHTML = TRAILS.map(t =>
    `<button class="trail-selector-item" data-trail-id="${t.id}" type="button">${t.name}</button>`
  ).join('');

  list.querySelectorAll('.trail-selector-item').forEach(btn => {
    btn.addEventListener('click', () => {
      closeTrailSelector();
      showTrail(btn.dataset.trailId);
    });
  });

  document.getElementById('trail-selector-btn').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('trail-selector-menu').classList.toggle('hidden');
  });

  document.getElementById('trail-selector-dashboard').addEventListener('click', () => {
    closeTrailSelector();
    showDashboard();
  });

  // Close dropdown when clicking outside it
  document.addEventListener('click', () => closeTrailSelector());
}

function closeTrailSelector() {
  document.getElementById('trail-selector-menu').classList.add('hidden');
}

async function showTrail(trailId) {
  const trail = TRAILS.find(t => t.id === trailId);
  if (!trail) return;

  document.getElementById('dashboard-view').classList.add('hidden');
  document.getElementById('map-view').classList.remove('hidden');
  document.getElementById('map-trail-name').textContent = trail.name;

  const segments = _allSegments.filter(s => s.trail_id === trailId);
  await loadTrail(trail, segments);
  requestAnimationFrame(() => { if (_map) _map.invalidateSize(); });
}

function showDashboard() {
  document.getElementById('map-view').classList.add('hidden');
  document.getElementById('dashboard-view').classList.remove('hidden');
}

async function initApp(user) {
  _currentUser = user;
  try {
    _allSegments = await getAllSegments(user.id);
  } catch (e) {
    console.error('Failed to load segments:', e);
    _allSegments = [];
  }
  renderDashboard();
  initTrailSelector();
}
