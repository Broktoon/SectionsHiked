-- Split single hiked_date into date_begun + date_completed, add duration_minutes.
alter table hike_segments rename column hiked_date to date_begun;
alter table hike_segments add column date_completed   date;
alter table hike_segments add column duration_minutes integer;
