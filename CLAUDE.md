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
| Continental Divide | `trail.geojson`, `points.json`, `cdt_meta.json` | Rebuilt 2026-09 from CDTC's official GIS via `scripts/build-cdt-data.js`. **3039.98mi**, 6523 points at **0.5mi**, 5 regions, 126 sections. Mile axis is CDTC's *Half_Mile_Markers* layer; sections and regions come from its *2026_CDT_Trail_Sections_view*. Replaces a 2019 USFS snapshot whose only structure was four latitude bands — those put **260mi of Idaho/Montana border ridge under `state: "WY"`** and never emitted `ID` at all. The old build also inverted **RMNP**: its layer had only the western bypass connector, so the axis ran along the bypass and the real route through the park was a 40mi "alternate". CDTC's Primary Route goes through the park; the 4.4mi **Tonahutu Creek Route** is the alternate. 5 alternates, 2 official (`tonahutu`, `chief-mtn`) and 3 from OSM (`gila`, `anaconda`, `spotted-bear`, tagged `official: false`) — see the alternates section below |
| Florida | `trails.geojson`, `points.json` | Note: plural filename |
| Ice Age | `trail.geojson`, `points.json`, `iat_meta.json` | Rebuilt 2026-09 from IATA's official `IAT_Segments_CR` layer. **1153.1mi** (701.6 certified + 451.4 connecting), 126 sections. Main spine follows the **east bifurcation**; Baraboo is the alternate (`route_id: "west-alt"`, 80.6mi). Connecting routes are hikeable and count toward mileage — tagged `route_type: "roadwalk"`, rendered dashed. Opposite of Natchez. Full source and build notes in TrailTemps CLAUDE.md, "IAT Geometry Source" |
| Natchez Trace | `trail.geojson`, `points.json` | 5 disconnected sections |
| New England | `trail.geojson`, `points.json`, `net_meta.json` | Rebuilt 2026-09 from the NPS `NEEN_BND_NationalScenicTrailCenterline_ln` layer (CFPA + AMC survey data) via `scripts/build-net-data.js`. **235.65mi** = 206.81 spine + 28.84 spur; the official 235 total includes the spur. Middletown spur is a dead-end alternate southern terminus (`route_id: "middletown-spur"`, `alt_of: "main-spine"`) joining the spine at mile 16.41, where the Menunkatuck meets the Mattabesett — its mile axis is **appended** (206.81→235.65), not projected, because it substitutes for no stretch of spine (unlike IAT's bifurcation). **The build must split parts at T-junctions before routing**: the Menunkatuck's north end lands 17ft into the *middle* of the 34.97mi Mattabesett line, 6.13mi along it. Without that split the whole line reads as spur, which strands the 6.13mi carrying the main route and opens a phantom 2.98mi "gap" — that bug shipped once. One real gap: **Connecticut River (1.49mi after mile 133.2, Easthampton/South Hadley)**, no pedestrian crossing at all per newenglandtrail.org/thru-hiking — drawn as a dashed connector tagged `route_id: "roadwalk"` (the non-hikeable sense: rendered for continuity, no mileage, no points.json entries) |
| North Country | `trail.geojson`, `points.json` | OK (19MB GeoJSON, largest) |
| Pacific Crest | `trail.geojson`, `points.json`, `pct_meta.json` | Rebuilt 2026-09 from PCTA's own GIS via `scripts/build-pct-data.js`. **2655.66mi**, 5313 points at **0.5mi**, 6 regions, 29 letter sections. Mile axis is PCTA's *PCT Mile Markers 2026* layer — the old axis was a simplified line rescaled to an assumed 2653.0 and drifted up to 7mi (worst miles 250–750). **PCTA's letter sections do not follow state lines**: CA Section R runs ~27mi into Oregon, so `state` is computed independently, never from the section prefix. One spine, no alternates, no gaps |
| Pacific Northwest | `trail.geojson`, `points.json` | Includes ferry crossing segment |
| Potomac Heritage | `trail.geojson`, `points.json` | OK |

### CDT alternates — the three OSM ones, and how Spotted Bear was resolved

CDTC publishes only two alternates: the Tonahutu Creek Route (its section 068)
and the Chief Mountain Border Crossing (its section 128). The Gila River,
Anaconda Cutoff and Spotted Bear routes come from OpenStreetMap relations and
are tagged `official: false` in `cdt_meta.json`.

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
| Spotted Bear | 35.5mi | 27.8mi | 8.9mi was phantom; 1.2mi added back, see below |

**Spotted Bear: resolved, and the "too short" worry was unfounded.** The route
looked wrong because its rejoin endpoint snapped 1.21mi from the spine while
every other alternate's endpoints were under 0.15mi. The cause was a genuine
hole in OSM, found by querying paths around that endpoint:

- Relation 8034122 has exactly 5 member ways (verified against the OSM API —
  the cache was never truncated). Its last member, `Clack Creek`, ends at
  48.00220,-113.07510.
- That point is a **T-junction into the middle of** the `Big River` trail
  (Flathead NF #155, OSM way 891724062), and the relation simply does not
  include the rest of that trail.
- Big River continues 1.210mi to the Bowl Creek / Strawberry Creek junction at
  48.00095,-113.05296, which sits **37 feet off the CDT centerline** — that is
  where the CDT actually crosses. Bowl Creek and Strawberry Creek essentially
  *are* the CDT through there.

The builder now borrows that stretch via `connectorWays` in `OSM_ALTS`, taking
only the portion between where the way meets the chain and where it comes
nearest the spine. Both endpoints land within 0.001mi of the centerline.

### Measure offsets perpendicular to the line, not to the nearest point

Two false alarms on this trail came from the same mistake, so the builder now
reports every endpoint offset as perpendicular distance to the centerline
(`distToLine`) rather than distance to the nearest sampled point:

| reading | nearest point | perpendicular |
|---|---|---|
| section 018's mile markers | 1.003mi | **0.000mi** |
| Spotted Bear rejoin, after the gap was closed | 0.184mi | **0.001mi** |
| Anaconda branch | 4.20mi (pre-fix chain) | **0.018mi** |

The spine is sampled every 0.5mi, so a point sitting exactly on the trail can
read a quarter mile out; a sparsely digitised section line is worse. Branch and
rejoin **miles** still come from the nearest sampled point — that is what puts
them on the axis — but only the distance is measured against the line. With
that change all five alternates report offsets under 0.02mi at both ends.

The route is **27.8mi against the 43.5mi of spine it replaces — a real 15.7mi
saving**, not the "+20.5mi scenic detour" the old files claimed. Both old
numbers were artifacts: the 35.5mi included the phantom line, and the 15mi
"main" span came from branch/rejoin points derived from that same broken chain,
so there was never a trustworthy prior figure to contradict.

A shorter alternate is not suspicious in itself. Through this stretch the CDT
follows the divide while the alternate drops into the Spotted Bear River
drainage and cuts across; straight-line distance between the two junctions is
about 18mi, so 43.5mi of spine and 27.8mi of alternate are both plausible. What
was suspicious was the loose endpoint, and that is now explained.

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
