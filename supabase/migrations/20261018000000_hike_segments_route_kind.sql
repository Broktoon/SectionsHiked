-- Record which route a logged segment was on, and which segments were one outing.
--
-- route_kind mirrors the canonical points.json field: 'spine' | 'alternate' | 'side'.
-- The test is substitution, not topology — an alternate may be walked instead of
-- part of the spine (including an alternate start or finish); a side route is
-- additional to the spine and replaces no spine mileage.
--
-- The main progress bar counts SPINE mileage only, so nothing reads this column
-- yet. It is stored anyway because the alternative is re-deriving every past
-- segment's route from its coordinates later, which would mean loading trail
-- geometry just to draw a progress bar. Defaulting to 'spine' is correct for
-- every row written before now: no trail offered a loggable side route until
-- Potomac Heritage.
ALTER TABLE hike_segments ADD COLUMN IF NOT EXISTS route_kind text NOT NULL DEFAULT 'spine';

ALTER TABLE hike_segments DROP CONSTRAINT IF EXISTS hike_segments_route_kind_check;
ALTER TABLE hike_segments ADD CONSTRAINT hike_segments_route_kind_check
  CHECK (route_kind IN ('spine', 'alternate', 'side'));

-- Which route, where the trail has more than one of a kind. Null on the spine.
-- Matches points.json's route_id (e.g. 'alt-potomac-river-trail',
-- 'side-mount-vernon-trail'), so a segment can be tied back to a named route
-- without geometry.
ALTER TABLE hike_segments ADD COLUMN IF NOT EXISTS route_id text;

-- Groups the rows of a single outing.
--
-- One row is one continuous span on ONE route. A hike that crosses between the
-- spine and a side route is therefore split at the junction into several rows,
-- which share this id, their date and their notes. Null for a single-row hike.
--
-- Deliberately a plain uuid with no foreign key: a `hikes` parent table is the
-- intended next step, and adding the column now means that upgrade needs no
-- backfill.
ALTER TABLE hike_segments ADD COLUMN IF NOT EXISTS hike_group_id uuid;

CREATE INDEX IF NOT EXISTS hike_segments_group_idx
  ON hike_segments (user_id, hike_group_id)
  WHERE hike_group_id IS NOT NULL;

-- RLS is unchanged: the existing "Users can manage own hike segments" policy is
-- FOR ALL on the table and covers new columns automatically.
