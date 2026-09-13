# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

---

## Project Overview

**SectionsHiked** is a web app for tracking personal hiking progress on all 11 National Scenic Trails (NSTs). Users sign in, see their overall progress across trails, select a trail to view its map, log hiked segments by clicking points on the map or using a form, and earn badges at milestones.

**Live URL:** https://sections-hiked.davidcurren.workers.dev (development)
**Custom domain:** SectionsHiked.com — not yet purchased; connect via Cloudflare when ready

**This is a separate, standalone project from TrailTemps.** It shares trail geometry data and some UI patterns but has a completely different purpose (hike tracking vs. weather planning) and a different architecture (authenticated, database-backed vs. pure static).

---

## Tech Stack

- **Frontend:** Plain HTML + CSS + Vanilla JS + Leaflet.js (v1.9.4 via CDN, OpenStreetMap tiles)
- **Auth + Database:** Supabase (project ref: `cfezwxpsiorvizzlxkih`)
  - Auth: email/password with display username + Google OAuth
  - Database: PostgreSQL with Row Level Security (RLS enabled on all tables)
  - Publishable (anon) key: `sb_publishable_Tw_7FLr4f2eULLY4xOPvyg_rkV2XPN2` — safe to include in JS; RLS enforces security
- **Hosting:** Cloudflare Workers with Assets (`wrangler.toml` at repo root)
- **Deployment:** Auto-deploys on push to `main` via GitHub integration

**No build step, no framework, no bundler.** Plain files only.

---

## Deployment

- Push to `main` → Cloudflare auto-deploys from `public/` directory
- `wrangler.toml` at repo root configures the Worker; `directory = "public"` means only `public/` is served
- Supabase CLI is linked: `supabase link --project-ref cfezwxpsiorvizzlxkih`
- Database migrations live in `supabase/migrations/` and are pushed with `supabase db push`

**Never commit:**
- The Supabase database password (used only in CLI/tools, never in web code)
- Any Supabase service role key (bypasses RLS — dangerous)

---

## File Structure

```
public/                          ← everything served to users
  index.html                     ← main app (single page for now)
  css/
    styles.css                   ← shared styles
  js/
    app.js                       ← main app logic
    auth.js                      ← Supabase auth (sign in, sign up, sign out)
    db.js                        ← all Supabase database calls (isolated here)
    map.js                       ← Leaflet map setup and trail rendering
    trails.js                    ← trail metadata (slugs, names, colors)
  trails/
    appalachian-trail/data/
      trail.geojson              ← trail geometry for Leaflet rendering
      points.json                ← interpolated trail points (for click snapping)
    arizona-trail/data/
      points.json                ← trail.geojson MISSING — 56MB exceeds Cloudflare limit
                                 ← needs simplified version before AZT map works
    continental-divide-trail/data/
      trail.geojson
      points.json
      cdt_meta.json                ← 5 CDTC regions + 126 sections + 5 alternates
    florida-trail/data/
      trails.geojson             ← NOTE: plural "trails", not "trail"
    ice-age-trail/data/
      trail.geojson
      iat_meta.json              ← section/region names, certified_miles, alt-route branch
    natchez-trace-trail/data/
    new-england-trail/data/
    north-country-trail/data/
    pacific-crest-trail/data/
      trail.geojson
      points.json
      pct_meta.json                ← 6 PCTA regions + 29 letter sections
      Full_PCT_Simplified.geojson  ← PCTA shapefile export; gitignored, not deployed.
                                   ← Still the source of trail.geojson geometry and
                                   ← both terminus coordinates, so keep it locally.
    pacific-northwest-trail/data/
    potomac-heritage-trail/data/

supabase/                        ← never served; database config and migrations
  config.toml
  migrations/                    ← SQL migration files; commit these to git

wrangler.toml                    ← Cloudflare Worker config; never served
CLAUDE.md                        ← this file
.gitignore
```

---

## Database Schema

All tables have RLS enabled. Users can only read/write their own rows.

```sql
-- Managed by Supabase Auth; do not create manually
-- auth.users

-- Created on signup via database trigger
profiles (
  id          uuid references auth.users primary key,
  username    text unique not null,
  created_at  timestamptz default now()
)

hike_segments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users not null,
  trail_id        text not null,          -- e.g. "appalachian-trail"
  start_lat       float not null,
  start_lng       float not null,
  end_lat         float not null,
  end_lng         float not null,
  start_mile      float,                  -- optional; from points.json snapping
  end_mile        float,                  -- optional; from points.json snapping
  hiked_date      date,
  temp_f          integer,
  notes           text,
  flora_fauna     text,
  created_at      timestamptz default now()
)

badges (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users not null,
  badge_key   text not null,             -- e.g. "at_25pct", "all_trails_started"
  earned_at   timestamptz default now()
)
```

---

## Key Design Decisions

### Auth
- Supabase Auth handles both Google OAuth and email/password
- Display username is stored in `profiles` table (Supabase Auth doesn't store it)
- A database trigger auto-creates a `profiles` row on every new signup

### Device Priority
Mobile and desktop are equal priority. All UI must be fully responsive and touch-friendly. Touch targets minimum 44px. Map controls must be usable with one thumb.

### Hike Entry — Dual Mode
Two ways to log a hiked segment, both saving to the same `hike_segments` table:

1. **Form mode** (better for mobile): user selects trail section/region and start/end mile from dropdowns → map highlights the selection
2. **Map click mode** (primary for desktop): user taps/clicks two points on the map → segment snaps to nearest `points.json` entry → segment drawn between them

**Mobile map conflict:** Leaflet tap-to-select and pinch-to-zoom conflict on mobile. Resolve with an explicit mode toggle ("Navigate" vs. "Select") that disables map pan/zoom while in selection mode.

### Click-to-Trail Snapping
When a user clicks the map, find the nearest point in `points.json` (haversine distance). The snapping resolution varies by trail (AT 5mi, IAT 0.5mi, PHT 0.1mi). Coarser trails may need UX affordance for users to pick nearby segments.

### Trail Colors
Use `#4a7c59` (forest green) as the primary trail color — distinct from TrailTemps' `#e06060` (red). Hiked sections: `#2ecc71` (bright green). Unhiked: `#4a7c59` at reduced opacity.

---

## Trail Data Notes

| Trail | File | Notes |
|-------|------|-------|
| Appalachian | `trail.geojson`, `points.json` | OK |
| Arizona | `points.json` only | **trail.geojson missing** — original 56MB, needs simplified version |
| Continental Divide | `trail.geojson`, `points.json`, `cdt_meta.json` | Rebuilt 2026-09 from CDTC's official GIS via `scripts/build-cdt-data.js`. **3039.98mi**, 6523 points at **0.5mi**, 5 regions, 126 sections. Mile axis is CDTC's *Half_Mile_Markers* layer; sections and regions come from its *2026_CDT_Trail_Sections_view*. Replaces a 2019 USFS snapshot whose only structure was four latitude bands — those put **260mi of Idaho/Montana border ridge under `state: "WY"`** and never emitted `ID` at all. The old build also inverted **RMNP**: its layer had only the western bypass connector, so the axis ran along the bypass and the real route through the park was a 40mi "alternate". CDTC's Primary Route goes through the park; the 4.4mi **Tonahutu Creek Route** is the alternate. 5 alternates, 2 official (`tonahutu`, `chief-mtn`) and 3 from OSM (`gila`, `anaconda`, `spotted-bear`, tagged `official: false`) — see the Spotted Bear caveat below |
| Florida | `trails.geojson`, `points.json` | Note: plural filename |
| Ice Age | `trail.geojson`, `points.json`, `iat_meta.json` | Rebuilt 2026-09 from IATA's official `IAT_Segments_CR` layer. **1153.1mi** (701.6 certified + 451.4 connecting), 126 sections. Main spine follows the **east bifurcation**; Baraboo is the alternate (`route_id: "west-alt"`, 80.6mi). Connecting routes are hikeable and count toward mileage — tagged `route_type: "roadwalk"`, rendered dashed. Opposite of Natchez. Full source and build notes in TrailTemps CLAUDE.md, "IAT Geometry Source" |
| Natchez Trace | `trail.geojson`, `points.json` | 5 disconnected sections |
| New England | `trail.geojson`, `points.json`, `net_meta.json` | Rebuilt 2026-09 from the NPS `NEEN_BND_NationalScenicTrailCenterline_ln` layer (CFPA + AMC survey data) via `scripts/build-net-data.js`. **235.65mi** = 200.68 spine + 34.97 spur; the official 235 total includes the spur. Middletown spur is a dead-end alternate southern terminus (`route_id: "middletown-spur"`, `alt_of: "main-spine"`) joining the spine at mile 16.41 — its mile axis is **appended** (200.68→235.65), not projected, because it substitutes for no stretch of spine (unlike IAT's bifurcation). Two gaps in the source, both excluded from mileage. **Connecticut River (1.49mi after mile 127.07, Easthampton/South Hadley)** has no pedestrian crossing at all per newenglandtrail.org/thru-hiking — drawn as a dashed connector tagged `route_id: "roadwalk"` (the non-hikeable sense: rendered for continuity, no mileage, no points.json entries). The **2.98mi break after mile 16.41** is left undrawn: the Menunkatuck connector was reported complete in 2013, so it reads more like a hole in the NPS layer than a gap on the ground, and the build doesn't assert either way |
| North Country | `trail.geojson`, `points.json` | OK (19MB GeoJSON, largest) |
| Pacific Crest | `trail.geojson`, `points.json`, `pct_meta.json` | Rebuilt 2026-09 from PCTA's own GIS via `scripts/build-pct-data.js`. **2655.66mi**, 5313 points at **0.5mi**, 6 regions, 29 letter sections. Mile axis is PCTA's *PCT Mile Markers 2026* layer — the old axis was a simplified line rescaled to an assumed 2653.0 and drifted up to 7mi (worst miles 250–750). **PCTA's letter sections do not follow state lines**: CA Section R runs ~27mi into Oregon, so `state` is computed independently, never from the section prefix. One spine, no alternates, no gaps |
| Pacific Northwest | `trail.geojson`, `points.json` | Includes ferry crossing segment |
| Potomac Heritage | `trail.geojson`, `points.json` | OK |

### CDT alternates — the three OSM ones are not verified

CDTC publishes only two alternates: the Tonahutu Creek Route (its section 068)
and the Chief Mountain Border Crossing (its section 128). The Gila River,
Anaconda Cutoff and Spotted Bear routes are carried forward from the previous
build's cached OpenStreetMap relations and are tagged `official: false` in
`cdt_meta.json`.

Their lengths moved when `scripts/build-cdt-data.js` fixed the chainer. The old
one only ever appended to the tail of the growing chain, so whichever OSM way
sorted first became the seed and everything upstream of it was stranded —
Anaconda and Spotted Bear each came out as two pieces joined by a straight line
across open country, and that line was counted as tread. Chaining from both ends
now yields one continuous chain per route with no step over 0.9mi.

| route | old | now | note |
|---|---|---|---|
| Gila River | 104.9mi | 106.7mi | 8 of 61 ways still unstitched (5.1mi of side paths); reported at build time |
| Anaconda Cutoff | 57.6mi | 53.1mi | 4.5mi of the old figure was the phantom straight line |
| Spotted Bear | 35.5mi | 26.6mi | 8.9mi was phantom |

**Spotted Bear is the one to distrust.** It now computes as 16.9mi *shorter*
than the spine stretch it replaces, but it is normally described as a longer,
scenic detour through the Bob Marshall. Either OSM relation 8034122 covers only
part of the route, or its branch point (spine mile 2833.5) is wrong — its rejoin
end snaps 1.21mi from the spine, far looser than every other alternate's
endpoints (all under 0.15mi). TrailTemps' page deliberately quotes no mileage
delta for it. Resolve it against a real CDT guide or CDTC's reroute layer before
relying on that number.

Trail geometry was copied from the TrailTemps project. If higher-resolution data or corrections are needed, refer to the original TrailTemps data sources (see TrailTemps CLAUDE.md for source URLs and build scripts).

---

## Conventions

- **No framework, no build step** — plain HTML/CSS/JS only
- **All Supabase calls go through `js/db.js`** — never scatter `supabase.from()` calls throughout app code; this makes migration to a different backend manageable
- **All auth calls go through `js/auth.js`** — same isolation principle
- **Leaflet 1.9.4 via CDN** — same version as TrailTemps
- **Mobile-first CSS** — base styles for mobile, media queries for wider screens
- **RLS is the security layer** — never rely on frontend JS to enforce data access rules; always write RLS policies for every table
- **Do not go live (custom domain) without explicit user approval**
- **Do not start coding during a design/planning discussion** — wait for explicit go-ahead
