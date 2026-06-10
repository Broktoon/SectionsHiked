-- Add states column to record which state(s) a logged segment passes through.
-- Stored as a formatted string (e.g. "VA", "NC-TN · VA") matching the state labels in points.json.
ALTER TABLE hike_segments ADD COLUMN IF NOT EXISTS states text;
