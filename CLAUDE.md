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
      trail.geojson
      points.json
      nct_meta.json              ← 8 regions (states); sections[] is empty by design
    pacific-crest-trail/data/
      trail.geojson
      points.json
      pct_meta.json                ← 6 PCTA regions + 29 letter sections
      Full_PCT_Simplified.geojson  ← PCTA shapefile export; gitignored, not deployed.
                                   ← Still the source of trail.geojson geometry and
                                   ← both terminus coordinates, so keep it locally.
    pacific-northwest-trail/data/
      trail.geojson
      points.json
      pnt_meta.json              ← 5 regions; sections[] is empty by design
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

## Canonical Trail Data Schema

SectionsHiked and TrailTemps keep this schema deliberately **similar**, and each
repo documents it in full — neither should have to read the other's docs to
understand its own data.

**Where the independence line sits:** served data files and executing code are
independent — each project owns its own `points.json`, `trail.geojson`,
`*_meta.json` and app code, and never loads the other's. **Build-time tooling may
be shared** — several trails' geometry is produced by `scripts/build-*-data.js`
here and copied into TrailTemps, which is fine.

Land schema changes here first, then port them to TrailTemps as a separate pass,
updating that repo's own copy of this section.

### `points.json` record

```
required:  id, lat, lon, mile, region_id, region_name,
           section_id, section_name, sec_mile, route_id
optional:  state, trail_elev, legacy_id, alt_of, route_type,
           route_kind, junction_mile
```

- **`mile`** — cumulative distance along the WHOLE trail. Monotonic across the
  main spine. Click-snapping, slicing and progress all key off this.
- **`sec_mile`** — distance from the start of THIS section. Restarts at ~0 for
  every section, **including alternate sections**. Never a cumulative value.
- `section_id` / `section_name` may be `null` where no honest scheme exists
  (NCT, PNT) — the fields stay present so a future scheme drops in without a
  second migration. Do not invent sections to fill them.

### `route_kind` — spine / alternate / side

Added 2026-10-15. The test is **substitution, not topology**:

| value | meaning | examples |
|---|---|---|
| `spine` | the through-route | every trail's main line |
| `alternate` | may be walked *instead of* part of the spine, **including an alternate start or finish** | CDT Gila/Anaconda/Spotted Bear/Tonahutu, IAT Baraboo, NET Middletown, FT Blackwater and both corridor groups, PHT's DC River Trail leg |
| `side` | *additional to* the spine, never a substitute; hiking it replaces no spine mileage | PHT's Virginia network, Mount Vernon Trail, Eastern Continental Divide loop |

**"Leaves and rejoins the spine" is the wrong definition of `alternate`** — an
alternate *terminus* never rejoins. Despite "spur" in their names, NET's
Middletown and FT's Blackwater are alternates, not side routes.

There is deliberately **no separate `spur` kind**. Whether a route "attaches" to
the spine depends entirely on snap tolerance, so the category is unstable — on
PHT, 54mi reads as attached and 298mi detached at 53ft, and a piece 60ft away
flips. Nothing downstream distinguishes them either. The one real difference, a
junction on the spine, is a **property**: optional `junction_mile`, which also
feeds the mixed-route auto-split described below.

**Why it exists:** SectionsHiked issues two accomplishments — main spine fully
hiked, and spine plus every alternate and side route hiked. Badges are predicates
over `route_kind`. The main progress bar counts **spine mileage only**.

### `route_id` vs `route_type` — two different roadwalks

- **`route_id: "roadwalk"`** → **not hikeable**. A gap connector rendered for map
  continuity only: no mileage, no `points.json` entries. Natchez's parkway, the
  NET's Connecticut River crossing, the PNT's Puget Sound ferry.
- **`route_type: "roadwalk"`** → **hikeable and counted**, merely styled dashed.
  IAT's connecting routes, Florida's roadwalks, NCT (~31%), PNT (~38%).

`route_type` also carries surface values such as `"cross-country"` (PNT, 17.7mi).

### Migration status

On the canonical schema: AT, AZT, Natchez, IAT, NET, PCT, CDT, NCT, PNT.
**Legacy, still to migrate: Florida** (uses `axis_mile`, no `route_id`) and
**Potomac Heritage** (uses `on_spine`/`section_mile`/`alt_id`, and 34% of its
points carry no `mile` at all).

`route_kind` is populated on **PHT only** so far. FT, NET and the other
alternate-bearing trails need a later pass to adopt it; their existing
`route_id`/`alt_of` tagging stays valid in the meantime.

### Planned `hike_segments` additions

Agreed, not yet migrated: a `route_kind` column (so a logged hike records which
route it was on, even though the progress bar ignores non-spine mileage) and a
nullable group id (so the mixed-route auto-split can stamp rows it creates
together, and a future `hikes` parent table needs no backfill).

**A hike crossing between routes must become one row per continuous span on one
route** — the app splits at the junction. One row spanning two routes makes
`end_mile - start_mile` meaningless and makes `_sliceTrailCoords` fall back to a
straight line. This is broken today on every alternate-bearing trail.

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
| North Country | `trail.geojson`, `points.json`, `nct_meta.json` | Rebuilt 2026-09 from NCTA's own GIS via `scripts/build-nct-data.js`. **4834.95mi**, 9671 points at **0.5mi**, 8 regions (the states), **0 sections**. Geometry is NCTA `nct_public/2` plus NCTA's own `agol_sht_public/1` for the Superior Hiking Trail, which the centerline omits entirely — that replaces the old build's OSM Overpass injection. Replaces a build whose greedy chainer stranded orphan runs mid-axis: the old geojson had 29 document-order joins over 2mi (worst 360mi), so **a 40mi segment drew as 713mi and a 30mi segment as 904mi**. Roadwalk is ~31% of the trail, hikeable and counted — `route_type: "roadwalk"`, dashed. GeoJSON dropped 19MB → 4.6MB. See "NCT has no sections" and "NCT mile axis" below |
| Pacific Crest | `trail.geojson`, `points.json`, `pct_meta.json` | Rebuilt 2026-09 from PCTA's own GIS via `scripts/build-pct-data.js`. **2655.66mi**, 5313 points at **0.5mi**, 6 regions, 29 letter sections. Mile axis is PCTA's *PCT Mile Markers 2026* layer — the old axis was a simplified line rescaled to an assumed 2653.0 and drifted up to 7mi (worst miles 250–750). **PCTA's letter sections do not follow state lines**: CA Section R runs ~27mi into Oregon, so `state` is computed independently, never from the section prefix. One spine, no alternates, no gaps |
| Pacific Northwest | `trail.geojson`, `points.json`, `pnt_meta.json` | Rebuilt 2026-09 from the USFS Region 6 centerline via `scripts/build-pnt-data.js`. **1210.95mi**, 2423 points at **0.5mi**, 5 regions, **0 sections**. The old axis was the one inherited axis that was *not* wrong — measured, never rescaled, and cleared to within 0.012mi. It was rebuilt because **the Puget Sound ferry was counted as hiking miles**: the old splitter cut the line at its largest coordinate jump, mid-channel, so 4.87mi was drawn as ferry and **0.93mi of open water stayed solid trail**, both on the axis. The ferry now comes from the source attribute, is drawn dashed with `route_id: "roadwalk"` (non-hikeable sense), and carries no mileage. Roadwalk is ~38% of the trail, hikeable and counted — `route_type: "roadwalk"`, dashed. 17.7mi of `route_type: "cross-country"`. GeoJSON 3.7MB → 0.8MB. See "PNT has no placeable sections" and "The PNT ferry" below |
| Potomac Heritage | `trail.geojson`, `points.json`, `pht_meta.json` | Rebuilt 2026-10 from the NPS POHE Trail Centerline via `scripts/build-pht-data.js`. **529.14mi** spine, 8486 points at **0.1mi**, 9 regions (5 on the spine), **0 sections**, 1 alternate, 202 side routes. Spine runs Laurel Ridge PA -> GAP -> C&O Canal -> Washington DC by the **City Park route** (Civil War Defenses / Fort Circle, a change from what TrailTemps shipped) -> Southern Maryland -> Point Lookout MD. First trail to carry **`route_kind`** - 299.81mi of disconnected Virginia network is `side`, the 7.24mi DC River Trail is `alternate`. Replaces a legacy pair whose axis was unusable: **34% of its points had no `mile` at all** (`on_spine: false`), Southern Maryland doubled back on itself (mile 23.5 and 210.5 were the same ground) and then jumped **54.3mi** in a straight line to reach DC, and both DC branches were tagged as alternates so the main axis had a 12.3mi hole. Point spacing is finer than every other rebuild **on purpose** - see the build header. Roadwalk is ~31% of the spine, hikeable and counted. The Youghiogheny paddle route (18.55mi) is drawn but carries no mileage, like the PNT ferry. See the PHT sections below |

### PHT: the spine is routed through NPS's waypoints, not by shortest path

Shortest path takes the wrong leg in Southern Maryland, so the build routes
through places NPS itself publishes: Point Lookout SP, **Drayden**, Leonardtown
Wharf, Port Tobacco, **Fort Circle DC**, Laurel Ridge PA.

Two of those exist only to stop the router going somewhere wrong:

- **Drayden** pins the St Mary's peninsula loop. NPS's cue sheet names the roads
  — "Route 5; Flat Iron, St. George's and Drayton roads; Route 249/Piney Point
  Road; Route 244; and Route 5 into Leonardtown" — and every one appears as a
  `TRNAME` on the leg shortest path discarded. Without this the spine skips the
  peninsula entirely.
- **Fort Circle DC** pins the City Park route. Once the DC River Trail is joined
  (below) it is routable at 7.24mi against City Park's 29.5mi, so shortest path
  would silently switch the spine to the riverside.

**Piney Point Lighthouse and the St Clement's Island Museum are NOT waypoints.**
Both are the ends of spurs, and using them as waypoints forced the spine out to
each tip and back, doubling 5.55mi and 3.06mi of tread onto the axis. Colton
Point Rd dead-ends at the museum with Maddox Rd and Oakley Rd carrying the route
past it; Piney Point Rd + Lighthouse Rd dead-end at the lighthouse off a loop
closed by Blake Creek Rd and Medleys Neck Rd. Both are side routes. Point
Lookout SP remains the eastern terminus.

**Do not treat NPS's "approximately 45 miles" for Point Lookout → Leonardtown as
a gate.** That page says "with a stop at Piney Point Lighthouse" — it is a day
ride that detours and returns. An earlier build routed the spine out to the tip
because 46.94 sat closest to 45 and called that confirmation; it was not. The
three readings are printed every run (through-route 36.21, + spur one way 41.76,
+ spur both ways 47.31) so the discrepancy stays visible.

Likewise **do not chase NPS's 38 miles for Colton's Point → Port Tobacco.** The
build routes 50.88 and that is right: 19 of 22 features traverse whole, only two
nodes on the leg offer a choice, and the extra miles are the corridor detouring
inland to pick up the **Three Notch Trail** rail-trail.

### PHT: the DC River Trail, and why length is the wrong test for a fragment

The riverside route through Washington is 7.24mi and the source carries all of
it, but in four pieces. Three declared joins totalling **571 ft** make it one
alternate touching the spine at mile 322.7 and mile 352.2:

| join | ft |
|---|---|
| OID 1604 ↔ Buckeye Dr SW Sidewalk | 69 |
| Francis Case Memorial Bridge ↔ L'Enfant Prom SW | 267 |
| L'Enfant Prom SW ↔ Maine Ave SW | 235 |

Three things about this were learned the hard way:

1. **A short route is dropped only when it is isolated, never by length alone.**
   An earlier build discarded every route under 0.1mi as a fragment — 73 of
   them, 1.8mi. One was **OID 1421, "Key Bridge Connection To Capital Crescent
   Trail", 231 ft**, which carries the river trail up onto the towpath. The
   shortest pieces on this trail are the ones holding the network together.
2. **A join names the two pieces it connects** (by `TRNAME`, or by `OBJECTID`
   where the source leaves a piece unnamed). Choosing "the two nearest part ends
   to a coordinate" does not work: splitting at junctions leaves several ends
   within a few feet of each other, so proximity kept joining a piece to its own
   neighbour and the measured length looked right while nothing connected.
3. **`CONNECTORS` and `JOINS` are different mechanisms.** A connector bridges two
   separate components (Cumberland). The DC groups were already in one component
   — each reaches the spine, and the way between them runs along the spine — so a
   component test finds nothing to do. `JOINS` are added as real tread before the
   node graph is built.

The spine's own C&O towpath ends at mile 322.7, and the 1.18mi continuing east
through Georgetown from 34th St NW is a spur, not spine.

### PHT: the source is actively republished — check before trusting any figure

Between April and October 2026 the NPS layer went from 614 features / 879.04mi
to **600 / 857.63mi**: 17 features removed, 3 added, and a new region,
**Greater Fredericksburg Area** (41.24mi), carved out of Northern Virginia and
Northern Neck. Southern Maryland alone moved by 18mi, and every removed feature
was in the Piney Point / Colton's Point road network — NPS deleted the duplicate
loop legs an earlier analysis had spent a session resolving. GAP, Laurel
Highlands and the C&O were untouched.

Consequences worth knowing:

- **Dedupe at PART level, not feature level.** OID 343 was deleted upstream, so
  OID 302's first part is now the only copy of the Budds Creek Rd stretch;
  feature-level dedupe would delete 3.5mi of real trail.
- **Fields the old build never fetched.** `TRSURFACE`, `TRUSE` and `TRTYPE` are
  read now. `TRUSE` marks 126 features **Bicycle** with no Hiker/Pedestrian —
  kept, because they are ordinary county roads with no parkway, freeway or
  bridge among them and no documentation that walking is barred. `TRTYPE` is
  what identifies the one paddle route.
- Dead ends, so do not look again: `NHTCERTSTATUS` is "Not Certified" on all
  600; `NHTHIGHPOTENTIALSEGMENT`, `NHTPUBLICUSESEGMENT` and `TRNUMBER` are
  entirely null; `ADMINORG` is 413 POHE and no section scheme.

### PHT has no sections — deliberate, and deferred

Every point carries `section_id: null` and `section_name: null`; `sec_mile` is
**region-local**, as on the NCT and PNT. `TRNAME` is not a section scheme — it
names the host road (Piney Point Rd, Flat Iron Rd), the same pattern rejected
for the NCT's `seg_name` and the PNT's `RTE_NAME`.

The one real candidate for later is **NPS's four named legs**, whose boundaries
this build already knows because it routes through them: Point Lookout →
Leonardtown, Colton's Point → Port Tobacco, Port Tobacco → Smallwood SP,
Smallwood SP → Oxon Cove. They cover only ~190 of the spine's 529mi, and the C&O
(184mi), GAP (72mi) and Laurel Highlands (67mi) each have separate schemes from
NPS, the Allegheny Trail Alliance and PA DCNR. Mixing them would be inconsistent.

### PHT: route decomposition cuts at name changes

Virginia's largest group is 400+ connected parts — a web, not a line. It is
decomposed into routes by taking the longest path through what remains, but
**alternates are extracted first** (by substitution, regardless of name) and
everything else is **cut where the `TRNAME` changes**, so each side route is one
named trail.

Cutting by geometry alone produced a **43.98mi route named "Mount Vernon Trail"**
that was mostly other trails; name-aware cutting gives 17.44mi, against the real
trail's ~18. Dahlgren Railroad Heritage Trail went from 35.53 to 16.59 the same
way. The cost is more, shorter routes (202 rather than 59) and many
`side-unnamed-N`, which is unavoidable: 31% of Virginia carries no name in any
source field.

**Route boundaries and route names are the same decision**, and a route is also
what a user will "complete" for a badge — so this is worth revisiting when the
badges are built.

### PHT accounting

```
  857.63   all source geometry, 600 features
 - 18.55   paddle route, drawn but not counted
 -  3.17   duplicate geometry
 =835.91   usable tread
 +  0.11   declared joins (DC river chain, 571 ft)
 =836.02   total tread modelled

  528.98   spine tread (distinct)
 +  0.00   out-and-back, walked twice
 +  0.11   declared connectors (Cumberland, 600 ft)
 +  0.06   node-merge slack over 271 joins
 =529.14   SPINE AXIS

    7.24   alternate (1)
  299.81   side routes (202)
    0.00   unaccounted
```

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

### NCT has no sections — this is deliberate, do not fill them in

Every NCT point carries `section_id: null` and `section_name: null`. The fields
are present so a future official scheme drops in without a second migration.
`sec_mile` is **state-local** — which is what both apps' segment-entry UI already
asks the user for, and what NCTA's half-mile markers actually measure.

The search that settled it (2026-09-13), so it does not get redone:

| candidate | why not |
|---|---|
| `agol_retail_maps` | The only endpoint-to-endpoint names — "MI-13 – Alberta to Cascade Falls", "OH-101 – Pennsylvania/Ohio State Line to Minerva" — but covering ~700 of 4,835mi. The rest of the layer is numbered page sheets ("Wisconsin Map Series - WI-017", ninety `MI_###`) |
| `chapter` on the centerline | 44 affiliate codes, not sections. BTA alone spans 930mi of Ohio, FLTC 390mi. Values are dirty: `Central NY` vs `CNY`, one 60-char free-text value, a 0.1mi `GTR` |
| `seg_name` | Names the host property (`Manistee National Forest`, `Buckeye Trail (on-road)`), 610 distinct, 958mi blank, 202 under 0.5mi |
| northcountrytrail.org maps page | NCTA subdivides **by state only**, splitting MI into UP/LP and OH into NW/East. Ten map regions, not hiking sections — and exactly how the half-mile layers are cut |

Also ruled out while looking: `trls_other` layers 1 and 2 are nearby trails and
campsite spurs, not spine — **NCT has no NET-style spur to model**. And
`Old_Route_of_NCT` is 21 attribute-less historical features, not an alternate.
One spine, no alternates, no spurs, `route_id: "main"` throughout.

### NCT mile axis — measured, then validated against NCTA's markers

Unlike PCT and CDT there is no official axis to adopt. NCTA publishes half-mile
markers only as a patchwork of per-state layers, each restarting at its own zero,
with holes (Ohio's 1,071mi carries ~136mi of markers). So the axis is measured
from the geometry, and stage 8 of the build cross-checks it: every marker is
snapped to the axis and the axis span that layer covers is compared with the run
its own marker count implies. **All 13 layers agree within 0.7%, most within
0.3%** — VT −0.6%, NY −0.1/+0.7/+0.2%, PA +0.3/−0.1%, OH −0.2/−0.3%, MI
−0.1/−0.2%, WI +0.6%, MN −0.2%, ND −0.2%. That is an independent check on every
state, Ohio included.

**Do not sum the centerline's `len_miles`.** Split features keep the parent's
full length, so 31 features overstate by up to 5.9mi each and the naive total
(4,627.22) overshoots measured geometry (4,576.11) by ~51mi. Per feature the
ratio is otherwise 0.999 — the geometry is excellent, only the attribute
double-counts.

**Region is a trail-order construct; `state` is a geographic fact.** Below Jay
Cooke State Park the state line *is* the St. Louis River and the trail weaves
across it, so the polygon test yields WI…MN…WI…MN over about three miles. The
build absorbs any excursion under 5mi into the surrounding region — so the 8
regions tile the axis exactly and each starts at `sec_mile` 0 — while `state`
keeps reporting the ground truth (4 points read `MN` inside region `wi`). Same
split the CDT build makes on the Montana/Idaho divide.

**43.4mi in 275 features is left off the spine**, none longer than 5.0mi: Powers
Vista Trail (MI), the Grand Rapids MN roadwalk fragments that carry no state
attribute, McClusky Canal Big Cut (ND), county road H58 (MI), Sheyenne State
Forest fragments (ND). The build prints the full list every run, so it can be
re-checked whenever NCTA republishes.

**The axis total is fully accounted for**, and the build prints every term:

```
  4876.03   all source tread (NCTA centerline + NCTA SHT layer)
 -  43.42   off-spine side material, 275 features, none over 5.0mi
 = 4832.61   spine tread
 +   0.91   bridge connector (the one at Silver Bay)
 +   1.56   node-merge slack: 4,012 feature joins at 2.1 ft each
 = 4834.95   axis
```

That last term is why two printed numbers differ. Consecutive features meet at
endpoints merged within `NODE_TOL` rather than being identical, and the walk
steps across each one, so the assembled line is slightly longer than the sum of
the feature lengths composing it. 2.1 ft per join is the real gap in the source.

**Sparse rural roadwalks are real, not gaps.** The spine contains steps up to
6.9mi (47.573,-98.969, ND, New Rockford to Lake Ashtabula) where the source
digitises a dead-straight county road with a vertex every few miles. No step
filter is applied — the graph walk cannot teleport, so there is nothing to
filter.

### The PNT ferry — drawn, not counted, and taken from the attribute

The Puget Sound crossing (Keystone/Fort Casey to Port Townsend) is the only
saltwater ferry on any National Scenic Trail. **It was counted as hiking miles,
and by more than was visible.**

The source carries it as its own feature — FID 322, `RTE_NAME`
"Port Townsend/Keystone Ferry", `COMMENT` "Ferry", **5.792mi**. The old
`fix-ferry-geometry.js` ignored that and split the Puget Sound line at its
*largest coordinate jump*, which lands mid-channel. So only 4.866mi became the
dashed ferry feature and **0.926mi of open water stayed a solid trail line** —
and both halves sat on the mile axis, shifting every Olympic Peninsula mile by
+5.79. `pnt_meta.json` claimed "no hiking miles added" and TrailTemps' constant
was commented "ferry not counted". Both were false.

The rebuild takes the ferry from the attribute, never from a jump heuristic.
Modelled on the NET's Connecticut River crossing:

- `route_id: "roadwalk"` — the **non-hikeable** sense of that tag. `map.js`
  draws it dashed *and* drops it from `_trailCoords`, so it carries no mileage.
- `segment_type: "ferry"` is kept as well, because it is not a road and because
  TrailTemps' PNT `app.js` styles on exactly that value.
- No `points.json` entries. The axis is continuous across it: the points at
  mile 993.5 and 994 are **5.51mi apart on the ground, 0.5mi apart on the
  axis**. That is the only consecutive-point gap on the trail over 0.5mi.

The ferry is in the spine *graph*, so the walk crosses it and both land masses
come out in one ordered line; it is the cumulative-distance pass that gives it
zero length. 5.902mi is excluded in total — the 5.792mi ferry part plus 0.110mi
for the two steps joining it to land.

**Consequence to know:** because `map.js` drops `route_id: "roadwalk"` from
`_trailCoords`, that array has a 5.4mi straight-line jump across the water. A
logged segment spanning the ferry therefore draws its overlay straight across
rather than along the ferry's own track. The two differ by 0.4mi over a nearly
straight crossing, so this is left alone rather than special-casing shared
`map.js` for one trail.

### PNT has no placeable sections — deliberate, and not for the NCT's reason

Every PNT point carries `section_id: null` and `section_name: null`, and
`sec_mile` is **region-local**. But unlike the NCT, where no official scheme
exists at all, **PNTA does publish 10 named sections with lengths**:

| # | section | mi | # | section | mi |
|---|---|---|---|---|---|
| 1 | Rocky Mountain | 151 | 6 | Pasayten Wilderness | 119 |
| 2 | Purcell Mountains | 99 | 7 | North Cascades | 196 |
| 3 | Selkirk Mountains | 152 | 8 | Puget Sound | 70 |
| 4 | Kettle River Range | 128 | 9 | Olympic Mountains | 170 |
| 5 | Okanogan Highlands | 99 | 10 | Wilderness Coast | 64 |

They are omitted because they **cannot be placed on this axis honestly**, not
because they do not exist:

- PNTA publishes no boundary coordinates and no open GIS — its downloads sit
  behind a form, and there is no mile-marker layer anywhere. ArcGIS Online was
  searched thoroughly (2026-09-13): USFSRegion06 publishes only the centerline,
  `r06_PNT_RoadType` and `r6_pnnst_Ownership`.
- PNTA's sections total **1248mi against our 1210.95**, because the USFS layer
  is the **congressional route as of 5/5/2016** (the item says so outright) and
  the hiking route has moved since. So absolute mileage cannot place a boundary.
- Placing them proportionally and checking against independent evidence — the
  source's `COMMENT` field, which names the land manager (Glacier NP, Kootenai
  NF, Idaho Panhandle NF, Okanogan-Wenatchee NF, North Cascades NP, Olympic NP)
  — **agrees for three boundaries and contradicts others by 30 to 65mi**:

  | boundary | proportional | land-manager evidence | |
  |---|---|---|---|
  | Pasayten / North Cascades | 727 | 718.6 (NP boundary) | agrees |
  | Puget Sound / Olympic | 985 | 994.7 (the ferry) | agrees |
  | Olympic / Wilderness Coast | 1150 | 1143.9 (NP interior ends) | agrees |
  | Purcell / Selkirk | 243 | 210.2 (Idaho Panhandle NF) | **off 33** |
  | N Cascades / Puget Sound | 917 | 852.1 (Mt Baker-Snoqualmie ends) | **off 65** |

- `COMMENT` is **blank for ~400mi through miles 323–622**, which is exactly
  where the Kettle River Range and Okanogan Highlands boundaries fall. There is
  no evidence there at all.

Inventing the other seven is the mistake the NCT note warns against. The fields
are held open so an official georeferenced scheme drops in without a second
migration, and `pnt_meta.json` records PNTA's list verbatim in
`notes.pnta_sections`.

**Also ruled out as section schemes while looking:** `RTE_NAME` names the host
trail or road (343 distinct, 57 under 0.5mi — "TR 533", "Bayview Edison Rd"),
the same shape as the NCT's `seg_name`. `SEGMENT` is populated on only 43 of
456 features. `ROUTE_ID` is the constant "PNT". `COMMENT` is the land manager.

### PNT: what the source carries that the old build never fetched

The old build requested only `FID,PNT_Sectio,State,MILES,RTE_NAME`. Two fields
it skipped matter:

- **`Layer`** is an official surface classification: `PNT_TRAIL` 738.44mi,
  `PNT_ROAD` 461.11mi (**37.9%**, against the NCT's ~31%), `PNT_XC` 17.73mi.
  `PNT_ROAD` becomes `route_type: "roadwalk"` — hikeable and counted, dashed.
  `PNT_XC` becomes `route_type: "cross-country"`: designated route with no
  constructed tread, mostly the Olympic wilderness beach and two Selkirk
  traverses. Nothing reads that value yet, so it renders as ordinary trail.
- **`SEGMENT`** labels two stretches `"Hurricane Alt"` (12.54mi) and
  `"S Olympics Alt"` (6.09mi). **These are not modelled as alternates, because
  they are the only geometry there** — each occupies a contiguous axis span
  exactly equal to its own length. The axis runs through routes USFS itself
  labels alternates. Nothing to fix without better data; one spine, no
  alternates, no spurs, `route_id: "main"` throughout.

`MILES` is ignored: populated for only ~764 of 1217 miles.

**Regions are the 5 geographic areas** — boundaries from `PNT_Sectio`, names
from PNTA. The two disagree on one: USFS calls area 2 "Northeast Washington"
and PNTA calls it **"Okanogan Highlands"**. The name previously shipped,
"Columbia Mountains", came from neither, and the id changed accordingly.

**`state` is a polygon test, not the source attribute.** That attribute put the
Montana/Idaho switch at mile 220 when the axis crosses the border before mile
215 — same class of error as the CDT's, at ~5mi rather than 260mi. Now MT
0–213, ID 213.5–310, WA 310.5–1210.95.

**The axis total is fully accounted for**, and the build prints every term:

```
  1217.28   all source geometry, 456 features
 -   0.87   off-spine side material, 7 parts (largest 0.31mi, SR 21)
 -   5.90   ferry crossing, drawn but not counted (5.79 ferry + 0.11 junction)
 +   0.45   bridge connectors
 +   0.01   node-merge slack, 462 part joins at 0.1 ft each
 = 1210.96   axis   (measured 1210.95)
```

Node-merge slack is **0.1 ft per join against the NCT's 2.1 ft** — this source's
parts very nearly share exact endpoints. Consequently `NODE_TOL` barely matters:
stage 3 re-runs the whole assembly across 0.005–0.040 every build and the result
stays within 0.07mi, converging to one component at every value.

**What was checked and found clean, so it is not redone:** the old axis was
measured off the geometry, never rescaled — it reproduced the old points to
within 0.012mi at mile 1217, a drift growing linearly from zero, which is
haversine-radius rounding rather than a scale factor. No orphan runs, no
doubling back (zero self-revisit pairs), no T-junction exposure. The new files
pass the same tests, plus: every point sits within **59 ft perpendicular** of
the drawn line (that is the 20m GeoJSON thinning), and the nearest-vertex index
into `_trailCoords` is **strictly monotonic in mile**, so slicing between any
two miles yields the right span.

Trail geometry for the trails not yet rebuilt was copied from the TrailTemps project. If higher-resolution data or corrections are needed, refer to the original TrailTemps data sources (see TrailTemps CLAUDE.md for source URLs and build scripts).

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
