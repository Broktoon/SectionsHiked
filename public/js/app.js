// Main app logic: dashboard, trail selection, view switching.
// Requires auth.js, db.js, trails.js, and map.js to be loaded first.

let _currentUser = null;
let _allSegments = [];
let _currentTrail = null;
let _pendingStart = null;
let _pendingEnd = null;
let _pendingStates = null;
let _drawerOpen = false;
let _floraEntries = [];
let _formModeActive = false;

const STATE_NAMES = {
  AL:'Alabama', AZ:'Arizona', CA:'California', CO:'Colorado',
  CT:'Connecticut', DC:'District of Columbia', FL:'Florida',
  GA:'Georgia', ID:'Idaho', MA:'Massachusetts', MD:'Maryland',
  ME:'Maine', MI:'Michigan', MN:'Minnesota', MS:'Mississippi',
  MT:'Montana', NC:'North Carolina', ND:'North Dakota', NH:'New Hampshire',
  NJ:'New Jersey', NM:'New Mexico', NY:'New York', OH:'Ohio',
  OR:'Oregon', PA:'Pennsylvania', TN:'Tennessee', VA:'Virginia',
  VT:'Vermont', WA:'Washington', WI:'Wisconsin', WV:'West Virginia',
  WY:'Wyoming',
};

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
  exitFormMode();
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
  exitFormMode();
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

function openSegmentDrawer(start, end, states) {
  _pendingStart = start;
  _pendingEnd = end;
  _pendingStates = states ?? null;
  _drawerOpen = true;
  _floraEntries = [];

  const miles = (start.mile != null && end.mile != null)
    ? Math.abs(end.mile - start.mile)
    : haversine(start.lat, start.lng, end.lat, end.lng);
  let summary;
  if (start.mile != null && end.mile != null) {
    const lo = Math.min(start.mile, end.mile).toFixed(1);
    const hi = Math.max(start.mile, end.mile).toFixed(1);
    summary = `${miles.toFixed(1)} mi · Mile ${lo} → ${hi}`;
  } else {
    summary = `~${miles.toFixed(1)} mi`;
  }
  if (states) summary += ` · ${states}`;
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
  exitFormMode();
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
    states: _pendingStates,
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
    exitSelectMode();
    closeSegmentDrawer();
    addSegmentToMap(saved);
    renderTrailInfo(_currentTrail, _allSegments.filter(s => s.trail_id === _currentTrail.id));
  } catch (e) {
    const errEl = document.getElementById('drawer-error');
    errEl.textContent = 'Save failed. Please try again.';
    errEl.classList.remove('hidden');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

// Populate a state <select> from the currently loaded points.json.
// States appear in northbound (NOBO) order with their mile range shown.
function _buildStateOptions(selectEl) {
  const points = getLoadedPoints();
  selectEl.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = points ? '— select state —' : '(loading trail data…)';
  placeholder.disabled = true;
  placeholder.selected = true;
  selectEl.appendChild(placeholder);

  if (!points || points.length === 0) return;

  // Derive NOBO state order from mile-sorted points
  const sorted = [...points].sort((a, b) => (a.mile ?? 0) - (b.mile ?? 0));
  const stateOrder = [];
  const seen = new Set();
  for (const p of sorted) {
    if (p.state && !seen.has(p.state)) { seen.add(p.state); stateOrder.push(p.state); }
  }

  // Compute mile range per state
  const ranges = new Map();
  for (const p of points) {
    if (!p.state) continue;
    if (!ranges.has(p.state)) ranges.set(p.state, { min: p.mile, max: p.mile });
    const r = ranges.get(p.state);
    if (p.mile < r.min) r.min = p.mile;
    if (p.mile > r.max) r.max = p.mile;
  }

  for (const state of stateOrder) {
    const r = ranges.get(state);
    const opt = document.createElement('option');
    opt.value = state;
    const name = STATE_NAMES[state] || state;
    const range = r ? ` (Miles ${Math.round(r.min)}–${Math.round(r.max)})` : '';
    opt.textContent = name + range;
    selectEl.appendChild(opt);
  }
}

function _showModeToggle() {
  document.getElementById('track-segment-btn').classList.add('hidden');
  document.getElementById('track-mode-toggle').classList.remove('hidden');
}

function _hideModeToggle() {
  document.getElementById('track-mode-toggle').classList.add('hidden');
  document.getElementById('track-segment-btn').classList.remove('hidden');
}

function enterFormMode() {
  _formModeActive = true;
  _hideModeToggle();

  // Reset and populate the form
  document.getElementById('form-start-state').value = '';
  document.getElementById('form-start-mile').value = '';
  document.getElementById('form-end-state').value = '';
  document.getElementById('form-end-mile').value = '';
  document.getElementById('form-mode-error').classList.add('hidden');

  _buildStateOptions(document.getElementById('form-start-state'));
  _buildStateOptions(document.getElementById('form-end-state'));

  document.getElementById('form-mode-panel').classList.remove('hidden');
  document.getElementById('form-start-state').focus();
}

function exitFormMode() {
  if (!_formModeActive) return;
  _formModeActive = false;
  document.getElementById('form-mode-panel').classList.add('hidden');
  document.getElementById('track-segment-btn').classList.remove('hidden');
}

function _previewAndContinue() {
  const errEl = document.getElementById('form-mode-error');
  errEl.classList.add('hidden');

  const startState = document.getElementById('form-start-state').value;
  const endState   = document.getElementById('form-end-state').value;
  const startRaw   = document.getElementById('form-start-mile').value;
  const endRaw     = document.getElementById('form-end-mile').value;

  if (!startState || !endState) {
    errEl.textContent = 'Please select a state for both start and end.';
    errEl.classList.remove('hidden');
    return;
  }
  if (startRaw === '' || endRaw === '') {
    errEl.textContent = 'Please enter a northbound mile for both start and end.';
    errEl.classList.remove('hidden');
    return;
  }

  const startMile = parseFloat(startRaw);
  const endMile   = parseFloat(endRaw);
  if (!isFinite(startMile) || !isFinite(endMile)) {
    errEl.textContent = 'Please enter valid mile numbers.';
    errEl.classList.remove('hidden');
    return;
  }

  const startSnap = snapByMile(startMile, startState);
  const endSnap   = snapByMile(endMile, endState);

  if (!startSnap || !endSnap) {
    errEl.textContent = 'No trail data found for the selected state. Please choose a different trail.';
    errEl.classList.remove('hidden');
    return;
  }

  if (startSnap.mile === endSnap.mile) {
    errEl.textContent = 'Start and end resolve to the same point. Please enter a wider range.';
    errEl.classList.remove('hidden');
    return;
  }

  // Hide form panel, draw map preview, open metadata drawer (via onSegmentChosen callback)
  exitFormMode();
  enterFormPreview(startSnap, endSnap);
}

function initSegmentTracking() {
  onSegmentChosen = function(start, end, states) {
    openSegmentDrawer(start, end, states);
  };

  onSegmentDelete = async function(id, layer) {
    try {
      await deleteSegment(id);
      removeSegmentLayer(layer);
      _allSegments = _allSegments.filter(s => s.id !== id);
      if (_currentTrail) {
        renderTrailInfo(_currentTrail, _allSegments.filter(s => s.trail_id === _currentTrail.id));
      }
    } catch (e) {
      console.error('Delete failed:', e);
    }
  };

  document.getElementById('track-segment-btn').addEventListener('click', () => {
    if (_currentTrail) _showModeToggle();
  });

  document.getElementById('mode-map-btn').addEventListener('click', () => {
    _hideModeToggle();
    if (_currentTrail) enterSelectMode(_currentTrail);
  });

  document.getElementById('mode-form-btn').addEventListener('click', () => {
    enterFormMode();
  });

  document.getElementById('mode-cancel-btn').addEventListener('click', () => {
    _hideModeToggle();
  });

  document.getElementById('form-mode-cancel-btn').addEventListener('click', cancelSegment);
  document.getElementById('form-preview-btn').addEventListener('click', _previewAndContinue);

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
