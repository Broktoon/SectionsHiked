-- How the hiker covered the segment on the ground: one-way, out and back, or a loop.
--
-- This is collected now and read by nothing yet; how it should affect mileage,
-- progress and badges is an open design question. Recording it from the start is
-- much cheaper than asking people to remember, months later, which of their past
-- outings doubled back.
--
-- Why it will matter: trail mileage and walked mileage are the same number only
-- for a one-way trip. An out-and-back covers the segment once but walks it
-- twice; a loop walks ground that is partly not on the trail at all. The
-- progress bar should keep counting trail miles covered either way -- a segment
-- is no more "hiked" for having been walked twice -- but a personal
-- distance-walked total, if one is ever added, cannot be derived without this.
--
-- This is a FLAG, not a model of the walking. It cannot express a yo-yo, or
-- different ground covered in each direction; that would need per-direction
-- mileage, which is a much larger change and is not on the near-term list.
-- Nothing reads this column yet, and nothing should until that design settles.
--
-- NULLABLE WITH NO DEFAULT, deliberately. Defaulting to 'one-way' would make
-- every row written before today, and every row where the user simply skipped
-- the field, indistinguishable from a trip the user actually declared one-way.
-- NULL means "not recorded", which is the truth. The field is optional in the
-- form for the same reason.
ALTER TABLE hike_segments ADD COLUMN IF NOT EXISTS trip_type text;

ALTER TABLE hike_segments DROP CONSTRAINT IF EXISTS hike_segments_trip_type_check;
ALTER TABLE hike_segments ADD CONSTRAINT hike_segments_trip_type_check
  CHECK (trip_type IS NULL OR trip_type IN ('one-way', 'out-and-back', 'loop'));

-- One outing is one trip type. A hike split across routes becomes several rows
-- sharing a hike_group_id, and every one of them carries the same value -- the
-- shape of the outing is a property of the outing, not of each leg. A leg of an
-- out-and-back is not itself an out-and-back.

-- RLS is unchanged: the existing "Users can manage own hike segments" policy is
-- FOR ALL on the table and covers new columns automatically.
