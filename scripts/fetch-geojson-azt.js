#!/usr/bin/env node
/* =============================================================================
   fetch-geojson-azt.js
   Fetches the Arizona Trail polyline from the USFS ArcGIS Feature Service
   (Layer 3), generalized server-side via maxAllowableOffset so the output
   stays well under Cloudflare's asset size limit, and writes it to
   public/trails/arizona-trail/data/trail.geojson.

   The un-generalized source is ~58MB (adapted from TrailTemps'
   fetch-geojson-azt.js). maxAllowableOffset=0.00005 (~5.5m tolerance)
   brings the full 44-passage trail down to ~1.15MB while keeping the
   line visually smooth at all normal map zoom levels.

   Usage:  node scripts/fetch-geojson-azt.js
   ============================================================================= */

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dir    = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dir, "../public/trails/arizona-trail/data/trail.geojson");

const ARCGIS_BASE =
  "https://services3.arcgis.com/IKBBLZOXy58PXgpl/arcgis/rest/services/" +
  "Arizona_National_Scenic_Trail_Feature_Layers_view/FeatureServer";

const MAX_ALLOWABLE_OFFSET = 0.00005;
const PAGE_SIZE = 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllFeatures(layerId) {
  let allFeatures = [];
  let offset = 0;

  while (true) {
    const url =
      `${ARCGIS_BASE}/${layerId}/query` +
      `?where=1%3D1&f=geojson&outFields=Passage,Miles` +
      `&returnZ=true&maxAllowableOffset=${MAX_ALLOWABLE_OFFSET}` +
      `&resultOffset=${offset}&resultRecordCount=${PAGE_SIZE}`;

    console.log(`  Fetching records ${offset}-${offset + PAGE_SIZE - 1} …`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ArcGIS fetch failed: ${res.status} ${await res.text()}`);

    const gj    = await res.json();
    const feats = gj.features || [];
    allFeatures = allFeatures.concat(feats);

    if (feats.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(300);
  }

  return allFeatures;
}

async function main() {
  console.log(`Fetching AZT polyline (Layer 3) from ArcGIS, maxAllowableOffset=${MAX_ALLOWABLE_OFFSET} …`);
  const features = await fetchAllFeatures(3);
  console.log(`Fetched ${features.length} feature(s).`);

  // Sort south-to-north by passage number
  function passageNumericKey(s) {
    s = String(s ?? "").trim();
    if (/^\d+e$/i.test(s)) return parseInt(s) + 0.5;
    return parseFloat(s) || 0;
  }
  features.sort((a, b) =>
    passageNumericKey(a.properties?.passage ?? a.properties?.Passage) -
    passageNumericKey(b.properties?.passage ?? b.properties?.Passage)
  );

  const geojson = {
    type: "FeatureCollection",
    features: features.map(f => ({
      type: "Feature",
      properties: {
        passage: f.properties?.Passage ?? null,
        miles:   f.properties?.Miles   ?? null,
      },
      geometry: f.geometry,
    })),
  };

  writeFileSync(OUT_PATH, JSON.stringify(geojson), "utf8");
  console.log(`\nWrote trail.geojson to ${OUT_PATH}`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
