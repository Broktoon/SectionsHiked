// Trail metadata: slugs, display names, colors, total mileage, and GeoJSON filenames.
// geojsonFile: null  → no GeoJSON available for this trail (AZT — file too large)
// geojsonFile: omitted → defaults to 'trail.geojson' in map.js
// geojsonFile: string → use that filename instead of the default

const TRAILS = [
  { id: 'appalachian-trail',        name: 'Appalachian Trail',        color: '#4a7c59', totalMiles: 2198  },
  { id: 'arizona-trail',            name: 'Arizona Trail',            color: '#4a7c59', totalMiles: 800,  geojsonFile: null },
  { id: 'continental-divide-trail', name: 'Continental Divide Trail', color: '#4a7c59', totalMiles: 3100  },
  { id: 'florida-trail',            name: 'Florida Trail',            color: '#4a7c59', totalMiles: 1500, geojsonFile: 'trails.geojson' },
  { id: 'ice-age-trail',            name: 'Ice Age Trail',            color: '#4a7c59', totalMiles: 1200  },
  { id: 'natchez-trace-trail',      name: 'Natchez Trace Trail',      color: '#4a7c59', totalMiles: 444   },
  { id: 'new-england-trail',        name: 'New England Trail',        color: '#4a7c59', totalMiles: 215   },
  { id: 'north-country-trail',      name: 'North Country Trail',      color: '#4a7c59', totalMiles: 4800  },
  { id: 'pacific-crest-trail',      name: 'Pacific Crest Trail',      color: '#4a7c59', totalMiles: 2650  },
  { id: 'pacific-northwest-trail',  name: 'Pacific Northwest Trail',  color: '#4a7c59', totalMiles: 1200  },
  { id: 'potomac-heritage-trail',   name: 'Potomac Heritage Trail',   color: '#4a7c59', totalMiles: 830   },
];
