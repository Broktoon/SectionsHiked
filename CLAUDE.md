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
    florida-trail/data/
      trails.geojson             ← NOTE: plural "trails", not "trail"
    ice-age-trail/data/
      trail.geojson
      trail_roadwalk.geojson     ← roadwalk connectors (dotted line display)
    natchez-trace-trail/data/
    new-england-trail/data/
    north-country-trail/data/
    pacific-crest-trail/data/
      trail.geojson
      Full_PCT_Simplified.geojson  ← extra simplified version, keep for reference
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
| Continental Divide | `trail.geojson`, `points.json` | OK (8MB GeoJSON) |
| Florida | `trails.geojson`, `points.json` | Note: plural filename |
| Ice Age | `trail.geojson`, `trail_roadwalk.geojson`, `points.json` | Roadwalk is display-only |
| Natchez Trace | `trail.geojson`, `points.json` | 5 disconnected sections |
| New England | `trail.geojson`, `points.json` | OK |
| North Country | `trail.geojson`, `points.json` | OK (19MB GeoJSON, largest) |
| Pacific Crest | `trail.geojson`, `points.json` | Extra `Full_PCT_Simplified.geojson` present |
| Pacific Northwest | `trail.geojson`, `points.json` | Includes ferry crossing segment |
| Potomac Heritage | `trail.geojson`, `points.json` | OK |

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
