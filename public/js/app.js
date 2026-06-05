// Main app logic: dashboard, trail selection, view switching.
// Requires auth.js, db.js, trails.js, and map.js to be loaded first.

let _currentUser = null;
let _allSegments = [];
let _currentTrail = null;
let _pendingStart = null;
let _pendingEnd = null;
let _drawerOpen = false;
let _floraEntries = [];

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

function formatDate(dateStr) {
  // dateStr is 'YYYY-MM-DD'
  const [y, m, d] = dateStr.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
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
        <div class="trail-card-img">
          <img src="/images/${trail.image}" alt="${trail.name} logo" loading="lazy">
        </div>
        <div class="trail-card-body">
          <div class="trail-card-name">${trail.name}</div>
          <div class="trail-progress-bar">
            <div class="trail-progress-fill" style="width:${pct}%"></div>
          </div>
          <div class="trail-stats">${statsText}</div>
        </div>
      </button>`;
  }).join('');

  grid.querySelectorAll('.trail-card').forEach(card => {
    card.addEventListener('click', () => showTrail(card.dataset.trailId));
  });
}

function renderTrailInfo(trail, segments) {
  // Trail facts
  const statesText = trail.states.length === 1
    ? trail.states[0]
    : `${trail.states.length} (${trail.states.join(' \xB7 ')})`;

  document.getElementById('info-total-miles').textContent = trail.totalMiles.toLocaleString() + ' mi';
  document.getElementById('info-states').textContent = statesText;
  document.getElementById('info-start').textContent = trail.termini[0];
  document.getElementById('info-end').textContent = trail.termini[1];

  // Progress facts
  const miles = segments.reduce((sum, s) => sum + segmentMiles(s), 0);
  const pct = Math.min(100, (miles / trail.totalMiles) * 100);

  document.getElementById('info-hiked').textContent =
    miles > 0 ? `${miles.toFixed(1)} mi` : '—';
  document.getElementById('info-pct').textContent =
    pct > 0 ? (pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`) : '—';
  document.getElementById('info-sessions').textContent =
    segments.length > 0 ? segments.length : '—';

  const dates = [...new Set(
    segments.filter(s => s.date_begun).map(s => s.date_begun)
  )].sort();
  document.getElementById('info-days').textContent =
    dates.length > 0 ? dates.length : '—';
  document.getElementById('info-first').textContent =
    dates.length > 0 ? formatDate(dates[0]) : '—';
  document.getElementById('info-last').textContent =
    dates.length > 1 ? formatDate(dates[dates.length - 1]) : '—';

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

  document.addEventListener('click', () => closeTrailSelector());
}

function closeTrailSelector() {
  document.getElementById('trail-selector-menu').classList.add('hidden');
}

async function showTrail(trailId) {
  const trail = TRAILS.find(t => t.id === trailId);
  if (!trail) return;

  exitSelectMode();
  closeSegmentDrawer();
  _currentTrail = trail;

  document.getElementById('dashboard-view').classList.add('hidden');
  document.getElementById('map-view').classList.remove('hidden');
  document.getElementById('map-trail-name').textContent = trail.name;

  const segments = _allSegments.filter(s => s.trail_id === trailId);
  renderTrailInfo(trail, segments);
  await loadTrail(trail, segments);
  requestAnimationFrame(() => { if (_map) _map.invalidateSize(); });
}

function showDashboard() {
  exitSelectMode();
  closeSegmentDrawer();
  _currentTrail = null;
  document.getElementById('map-view').classList.add('hidden');
  document.getElementById('dashboard-view').classList.remove('hidden');
}

function _renderFloraChips() {
  const list = document.getElementById('flora-tag-list');
  list.innerHTML = _floraEntries.map((entry, i) => `
    <span class="tag-chip">
      ${entry}
      <button type="button" class="tag-remove-btn" data-idx="${i}" aria-label="Remove">&#10005;</button>
    </span>`).join('');
  list.querySelectorAll('.tag-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _floraEntries.splice(parseInt(btn.dataset.idx, 10), 1);
      _renderFloraChips();
    });
  });
}

function _addFloraEntry() {
  const input = document.getElementById('drawer-flora-input');
  const val = input.value.trim();
  if (!val) return;
  _floraEntries.push(val);
  input.value = '';
  _renderFloraChips();
  input.focus();
}

function openSegmentDrawer(start, end) {
  _pendingStart = start;
  _pendingEnd = end;
  _drawerOpen = true;
  _floraEntries = [];

  const miles = haversine(start.lat, start.lng, end.lat, end.lng);
  let summary;
  if (start.mile != null && end.mile != null) {
    const lo = Math.min(start.mile, end.mile).toFixed(1);
    const hi = Math.max(start.mile, end.mile).toFixed(1);
    summary = `~${miles.toFixed(1)} mi · Mile ${lo} → ${hi}`;
  } else {
    summary = `~${miles.toFixed(1)} mi`;
  }
  document.getElementById('drawer-segment-summary').textContent = summary;

  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('drawer-date-begun').value = today;
  document.getElementById('drawer-date-completed').value = '';
  document.getElementById('drawer-duration-val').value = '';
  document.getElementById('drawer-duration-unit').value = 'hours';
  document.getElementById('drawer-notes').value = '';
  document.getElementById('drawer-flora-input').value = '';
  document.getElementById('drawer-error').classList.add('hidden');
  _renderFloraChips();

  const saveBtn = document.getElementById('drawer-save-btn');
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save';

  const drawer = document.getElementById('segment-drawer');
  drawer.classList.remove('hidden');
  requestAnimationFrame(() => requestAnimationFrame(() => drawer.classList.add('open')));
}

function closeSegmentDrawer() {
  if (!_drawerOpen) return;
  _drawerOpen = false;
  const drawer = document.getElementById('segment-drawer');
  drawer.classList.remove('open');
  drawer.addEventListener('transitionend', () => drawer.classList.add('hidden'), { once: true });
}

function cancelSegment() {
  exitSelectMode();
  closeSegmentDrawer();
}

async function saveSegment() {
  const dateBegun = document.getElementById('drawer-date-begun').value;
  if (!dateBegun) {
    const errEl = document.getElementById('drawer-error');
    errEl.textContent = 'Please enter a start date.';
    errEl.classList.remove('hidden');
    return;
  }

  const durationVal = document.getElementById('drawer-duration-val').value;
  const durationUnit = document.getElementById('drawer-duration-unit').value;
  const unitMultiplier = { minutes: 1, hours: 60, days: 1440 };
  const durationMinutes = durationVal
    ? Math.round(parseFloat(durationVal) * unitMultiplier[durationUnit])
    : null;

  const seg = {
    user_id: _currentUser.id,
    trail_id: _currentTrail.id,
    start_lat: _pendingStart.lat,
    start_lng: _pendingStart.lng,
    end_lat: _pendingEnd.lat,
    end_lng: _pendingEnd.lng,
    start_mile: _pendingStart.mile,
    end_mile: _pendingEnd.mile,
    date_begun: dateBegun,
    date_completed: document.getElementById('drawer-date-completed').value || null,
    duration_minutes: durationMinutes,
    notes: document.getElementById('drawer-notes').value.trim() || null,
    flora_fauna: _floraEntries.length > 0 ? JSON.stringify(_floraEntries) : null,
  };

  const saveBtn = document.getElementById('drawer-save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const saved = await addSegment(seg);
    _allSegments.push(saved);
    addSegmentToMap(saved);
    renderTrailInfo(_currentTrail, _allSegments.filter(s => s.trail_id === _currentTrail.id));
    exitSelectMode();
    closeSegmentDrawer();
  } catch (e) {
    const errEl = document.getElementById('drawer-error');
    errEl.textContent = 'Save failed. Please try again.';
    errEl.classList.remove('hidden');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

function initSegmentTracking() {
  onSegmentChosen = function(start, end) {
    openSegmentDrawer(start, end);
  };

  document.getElementById('track-segment-btn').addEventListener('click', () => {
    if (_currentTrail) enterSelectMode(_currentTrail);
  });

  document.getElementById('select-cancel-btn').addEventListener('click', cancelSegment);
  document.getElementById('drawer-cancel-btn').addEventListener('click', cancelSegment);
  document.getElementById('drawer-close-btn').addEventListener('click', cancelSegment);

  document.getElementById('drawer-form').addEventListener('submit', e => {
    e.preventDefault();
    saveSegment();
  });

  document.getElementById('flora-add-btn').addEventListener('click', _addFloraEntry);
  document.getElementById('drawer-flora-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); _addFloraEntry(); }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') cancelSegment();
  });
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
  initSegmentTracking();
}
