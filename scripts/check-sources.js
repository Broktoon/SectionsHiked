#!/usr/bin/env node
// check-sources.js: has any official trail data source changed since our maps were built?
//
// Usage:
//   node scripts/check-sources.js            compare live sources with the baseline, print a report
//   node scripts/check-sources.js --update   same, then overwrite the baseline with what it saw
//
// Report-only. It downloads no geometry and touches no trail data. For each
// upstream layer a build script reads, it records cheap fingerprints:
//
//   count         feature count (returnCountOnly)
//   lastEdit      the layer's editingInfo.lastEditDate / dataLastEditDate, where published
//   fields        sorted field names (a new or dropped attribute)
//   length        sum of Shape__Length where the layer carries it. Web Mercator
//                 units, so only the RELATIVE change means anything
//
// plus, for the CDT's three OpenStreetMap alternates, each relation's version
// and member count, and for the trail organisations' own ArcGIS orgs, the list
// of service names (PCTA and CDTC publish year-named layers such as
// PCT_Mile_Markers_2026, so a 2027 edition appears as a NEW service, not as an
// edit to the old one).
//
// The baseline stays as committed until someone re-runs with --update, so a
// change keeps being reported every week until it has been looked at.
//
// Florida and Natchez Trace have no official GIS source to watch.

'use strict';

const fs = require('fs');
const path = require('path');

const BASELINE = path.join(__dirname, 'source-baseline.json');
const UA = 'SectionsHiked-source-check/1.0 (+https://sections-hiked.davidcurren.workers.dev)';

const NPS  = 'https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services';
const CDTC = 'https://services8.arcgis.com/WyuHwdftppQLa5KO/arcgis/rest/services';
const PCTA = 'https://services5.arcgis.com/ZldHa25efPFpMmfB/arcgis/rest/services';
const NCTA = 'https://services2.arcgis.com/UfGVyqUm4GHa2zrj/arcgis/rest/services';
const IATA = 'https://services.arcgis.com/EeCmkqXss9GYEKIZ/arcgis/rest/services';
const AZTA = 'https://services3.arcgis.com/IKBBLZOXy58PXgpl/arcgis/rest/services';
const USFS = 'https://services1.arcgis.com/gGHDlz6USftL5Pau/arcgis/rest/services';

const NCT_MARKERS = [
  'vt_halfmile_points', 'halfmile_ny', 'cny_halfmile_points', 'a100_halfmile_points',
  'pa_halfmile_points', 'anf_halfmile_points', 'oh_e_halfmile_points', 'oh_nw_halfmile_points',
  'halfmile_mi_lp', 'halfmile_mi_up', 'wi_halfmile_points', 'mn_halfmile_points',
  'nd_halfmile_points',
];

// key: stable id used in the baseline. use: which build reads it.
const LAYERS = [
  { trail: 'AT',  key: 'at-pasda',        use: 'build-at-data.js (geometry)',
    url: 'https://mapservices.pasda.psu.edu/server/rest/services/pasda/AppalachianTrail/MapServer/0' },
  { trail: 'AZT', key: 'azt-polyline',    use: 'fetch-geojson-azt.js (geometry)',
    url: AZTA + '/Arizona_National_Scenic_Trail_Feature_Layers_view/FeatureServer/3' },
  { trail: 'AZT', key: 'azt-passages',    use: 'not yet used (the 43 passages)',
    url: AZTA + '/Arizona_National_Scenic_Trail_Feature_Layers_view/FeatureServer/6' },
  { trail: 'CDT', key: 'cdt-centerline',  use: 'build-cdt-data.js (geometry)',
    url: CDTC + '/Continental_Divide_Trail_2/FeatureServer/0' },
  { trail: 'CDT', key: 'cdt-sections',    use: 'build-cdt-data.js (sections, regions)',
    url: CDTC + '/2026_CDT_Trail_Sections_view/FeatureServer/0' },
  { trail: 'CDT', key: 'cdt-mile-markers', use: 'build-cdt-data.js (mile axis)',
    url: CDTC + '/Mile_Markers/FeatureServer/0' },
  { trail: 'IAT', key: 'iat-segments',    use: 'IAT rebuild (geometry, sections)',
    url: IATA + '/IAT_Segments_CR/FeatureServer/0' },
  { trail: 'NET', key: 'net-centerline',  use: 'build-net-data.js (geometry)',
    url: NPS + '/NEEN_BND_NationalScenicTrailCenterline_ln/FeatureServer/0' },
  { trail: 'NCT', key: 'nct-centerline',  use: 'build-nct-data.js (geometry)',
    url: NCTA + '/nct_public/FeatureServer/2' },
  { trail: 'NCT', key: 'nct-sht',         use: 'build-nct-data.js (Superior Hiking Trail)',
    url: NCTA + '/agol_sht_public/FeatureServer/1' },
  ...NCT_MARKERS.map(s => ({ trail: 'NCT', key: 'nct-' + s, use: 'build-nct-data.js (axis check)',
    url: NCTA + '/' + s + '/FeatureServer/0' })),
  { trail: 'PCT', key: 'pct-mile-markers', use: 'build-pct-data.js (mile axis)',
    url: PCTA + '/PCT_Mile_Markers_2026/FeatureServer/0' },
  { trail: 'PCT', key: 'pct-sections',    use: 'build-pct-data.js (letter sections)',
    url: PCTA + '/PCT_Letter_Sections/FeatureServer/0' },
  { trail: 'PCT', key: 'pct-regions',     use: 'build-pct-data.js (regions)',
    url: PCTA + '/PCTA_Centerline_Regions/FeatureServer/0' },
  { trail: 'PHT', key: 'pht-centerline',  use: 'build-pht-data.js (geometry)',
    url: NPS + '/POHE_Trail_Centerline_FTDS_view/FeatureServer/0' },
  { trail: 'PNT', key: 'pnt-centerline',  use: 'build-pnt-data.js (geometry)',
    url: USFS + '/Pacific_Northwest_National_Scenic_Trail/FeatureServer/0' },
];

// The CDT's unofficial alternates come from OSM relations; Spotted Bear also
// borrows part of one way. A new version means someone edited the route.
const OSM = [
  { trail: 'CDT', key: 'osm-gila',         type: 'relation', id: 7917427,   name: 'Gila River Route' },
  { trail: 'CDT', key: 'osm-anaconda',     type: 'relation', id: 8107272,   name: 'Anaconda Cutoff' },
  { trail: 'CDT', key: 'osm-spotted-bear', type: 'relation', id: 8034122,   name: 'Spotted Bear Route' },
  { trail: 'CDT', key: 'osm-big-river',    type: 'way',      id: 891724062, name: 'Big River trail (Spotted Bear connector)' },
];

// Organisations that publish only their own trail, so a new service name is
// worth a look. The NPS and USFS orgs publish thousands of unrelated services.
const ORGS = [
  { trail: 'CDT', key: 'org-cdtc', url: CDTC, name: 'CDTC' },
  { trail: 'PCT', key: 'org-pcta', url: PCTA, name: 'PCTA' },
  { trail: 'NCT', key: 'org-ncta', url: NCTA, name: 'NCTA' },
  { trail: 'IAT', key: 'org-iata', url: IATA, name: 'IATA' },
  { trail: 'AZT', key: 'org-azta', url: AZTA, name: 'Arizona Trail' },
];

const NOT_MONITORED = [
  'Florida Trail: no official GIS source (geometry is OpenStreetMap)',
  'Natchez Trace Trail: no official GIS source',
];

// ── fetch ────────────────────────────────────────────────────────────────────

async function getJson(url, attempt = 1) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j && j.error) throw new Error('ArcGIS error ' + (j.error.code || '') + ' ' + (j.error.message || ''));
    return j;
  } catch (e) {
    if (attempt < 3) {
      await new Promise(res => setTimeout(res, 2000 * attempt));
      return getJson(url, attempt + 1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function probeLayer(L) {
  const meta = await getJson(L.url + '?f=json');
  const ei = meta.editingInfo || {};
  const fields = (meta.fields || []).map(f => f.name).sort();
  const cnt = await getJson(L.url + '/query?where=1%3D1&returnCountOnly=true&f=json');
  const out = {
    name: meta.name || null,
    count: typeof cnt.count === 'number' ? cnt.count : null,
    lastEdit: ei.dataLastEditDate || ei.lastEditDate || null,
    fields,
    length: null,
  };
  const lenField = fields.find(f => /^shape__length$/i.test(f) || /^shape_length$/i.test(f) || /^shape\.len$/i.test(f));
  if (lenField) {
    try {
      const stats = encodeURIComponent(JSON.stringify([
        { statisticType: 'sum', onStatisticField: lenField, outStatisticFieldName: 'total_len' }]));
      const s = await getJson(L.url + '/query?where=1%3D1&outStatistics=' + stats + '&f=json');
      const a = s.features && s.features[0] && s.features[0].attributes;
      const v = a && (a.total_len ?? a.TOTAL_LEN);
      // 9 significant digits: some layers measure in degrees, where a whole
      // trail totals 4 or 13 and rounding to an integer would hide any edit.
      if (typeof v === 'number') out.length = Number(v.toPrecision(9));
    } catch (e) { /* statistics unsupported on this layer; leave null */ }
  }
  return out;
}

async function osmElement(type, id) {
  const j = await getJson('https://api.openstreetmap.org/api/0.6/' + type + '/' + id + '.json');
  const el = j.elements && j.elements[0];
  if (!el) throw new Error('no element returned for ' + type + ' ' + id);
  return el;
}

// Gila and Anaconda are relations OF relations, and editing a child does not
// bump the parent's version, so read one level down. `version` is a string
// listing every relation's version; `members` counts the ways (or a way's nodes).
async function probeOsm(O) {
  const el = await osmElement(O.type, O.id);
  if (O.type === 'way') {
    return { version: 'v' + el.version, timestamp: el.timestamp, members: (el.nodes || []).length };
  }
  const parts = ['v' + el.version];
  let ways = 0, latest = el.timestamp;
  for (const m of el.members || []) {
    if (m.type === 'way') { ways++; continue; }
    if (m.type !== 'relation') continue;
    const child = await osmElement('relation', m.ref);
    parts.push(m.ref + ':v' + child.version);
    ways += (child.members || []).filter(c => c.type === 'way').length;
    if (child.timestamp > latest) latest = child.timestamp;
  }
  return { version: parts.join(' '), timestamp: latest, members: ways };
}

async function probeOrg(G) {
  const j = await getJson(G.url + '?f=json');
  return { services: (j.services || []).map(s => s.name + ' (' + s.type + ')').sort() };
}

// ── compare ──────────────────────────────────────────────────────────────────

const fmtDate = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : 'unpublished');

function diffLayer(old, now) {
  const notes = [];
  if (old.count !== now.count) notes.push('features ' + old.count + ' -> ' + now.count);
  if (old.lastEdit !== now.lastEdit) notes.push('last edited ' + fmtDate(old.lastEdit) + ' -> ' + fmtDate(now.lastEdit));
  if (old.length != null && now.length != null && old.length !== now.length) {
    const pct = ((now.length - old.length) / old.length) * 100;
    notes.push('total length ' + (pct >= 0 ? '+' : '') + pct.toFixed(3) + '%');
  } else if ((old.length == null) !== (now.length == null)) {
    notes.push('length statistic ' + (now.length == null ? 'no longer available' : 'now available'));
  }
  const added = now.fields.filter(f => !old.fields.includes(f));
  const gone = old.fields.filter(f => !now.fields.includes(f));
  if (added.length) notes.push('new fields: ' + added.join(', '));
  if (gone.length) notes.push('dropped fields: ' + gone.join(', '));
  return notes;
}

function diffOsm(old, now) {
  const notes = [];
  if (old.version !== now.version) {
    notes.push('versions [' + old.version + '] -> [' + now.version + '] (latest edit ' + now.timestamp.slice(0, 10) + ')');
  }
  if (old.members !== now.members) notes.push('ways/nodes ' + old.members + ' -> ' + now.members);
  return notes;
}

function diffOrg(old, now) {
  const notes = [];
  const added = now.services.filter(s => !old.services.includes(s));
  const gone = old.services.filter(s => !now.services.includes(s));
  if (added.length) notes.push('new services: ' + added.join(', '));
  if (gone.length) notes.push('removed services: ' + gone.join(', '));
  return notes;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const update = process.argv.includes('--update');
  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
  const old = baseline ? baseline.sources : {};
  const now = {};
  const changed = [], fresh = [], failed = [];
  let unchanged = 0;

  const jobs = [
    ...LAYERS.map(L => ({ src: L, label: L.trail + ' ' + L.key, run: () => probeLayer(L), diff: diffLayer,
      where: L.url, use: L.use })),
    ...OSM.map(O => ({ src: O, label: O.trail + ' ' + O.name, run: () => probeOsm(O), diff: diffOsm,
      where: 'https://www.openstreetmap.org/' + O.type + '/' + O.id, use: 'build-cdt-data.js (OSM alternate)' })),
    ...ORGS.map(G => ({ src: G, label: G.trail + ' ' + G.name + ' service list', run: () => probeOrg(G), diff: diffOrg,
      where: G.url, use: 'new editions (e.g. a 2027 mile-marker layer)' })),
  ];

  for (const job of jobs) {
    const key = job.src.key;
    try {
      now[key] = await job.run();
    } catch (e) {
      failed.push({ job, error: e.message });
      if (old[key]) now[key] = old[key];   // keep the last good reading in the baseline
      continue;
    }
    if (!old[key]) { fresh.push(job); continue; }
    const notes = job.diff(old[key], now[key]);
    if (notes.length) changed.push({ job, notes });
    else unchanged++;
  }

  const total = jobs.length;
  const lines = [];
  lines.push('# Trail source check, ' + new Date().toISOString().slice(0, 10));
  lines.push('');
  if (baseline) lines.push('Baseline taken ' + baseline.taken + '.');
  else lines.push('No baseline file yet; every source below is a first reading.');
  lines.push('');

  if (failed.length > total / 2) {
    lines.push('**CHECK FAILED: ' + failed.length + ' of ' + total + ' sources could not be reached.** '
      + 'This says nothing about whether the data changed; it usually means the network was blocked.');
  } else if (changed.length) {
    lines.push('**' + changed.length + ' source' + (changed.length > 1 ? 's' : '') + ' changed** since the baseline. '
      + unchanged + ' unchanged, ' + failed.length + ' unreachable.');
  } else {
    lines.push('**No changes.** ' + unchanged + ' of ' + total + ' sources match the baseline'
      + (failed.length ? ', ' + failed.length + ' unreachable.' : '.'));
  }
  lines.push('');

  if (changed.length) {
    lines.push('## Changed');
    lines.push('');
    for (const { job, notes } of changed) {
      lines.push('- **' + job.label + '**: ' + notes.join('; '));
      lines.push('  - read by: ' + job.use);
      lines.push('  - source: ' + job.where);
    }
    lines.push('');
  }
  if (failed.length) {
    lines.push('## Unreachable');
    lines.push('');
    for (const { job, error } of failed) lines.push('- ' + job.label + ': ' + error + ' (' + job.where + ')');
    lines.push('');
  }
  if (fresh.length) {
    lines.push('## Not in the baseline yet');
    lines.push('');
    for (const job of fresh) lines.push('- ' + job.label);
    lines.push('');
  }
  lines.push('## Not monitored');
  lines.push('');
  for (const s of NOT_MONITORED) lines.push('- ' + s);
  lines.push('');

  console.log(lines.join('\n'));

  if (update) {
    const out = { taken: new Date().toISOString(), sources: now };
    fs.writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n');
    console.log('Baseline written: ' + Object.keys(now).length + ' sources.');
  }
  // Exit 0 for both "changed" and "unchanged": a change is news, not an error.
  process.exitCode = failed.length > total / 2 ? 2 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
