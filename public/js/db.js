// All Supabase database calls live here.
// Requires auth.js to be loaded first (provides window.sb).

async function getAllSegments(userId) {
  const { data, error } = await sb.from('hike_segments')
    // route_kind is selected because progress counts SPINE mileage only — a
    // Mount Vernon Trail hike must not land in the same total as a C&O mile.
    // This list is explicit, so a new column has to be added here or it never
    // reaches the caller.
    .select('id, trail_id, start_lat, start_lng, end_lat, end_lng, start_mile, end_mile, '
      + 'states, date_begun, route_kind, route_id, hike_group_id')
    .eq('user_id', userId);
  if (error) throw error;
  return data ?? [];
}

async function getSegments(userId, trailId) {
  const { data, error } = await sb.from('hike_segments')
    .select('*')
    .eq('user_id', userId)
    .eq('trail_id', trailId)
    .order('hiked_date', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

async function addSegment(seg) {
  const { data, error } = await sb.from('hike_segments')
    .insert(seg)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteSegment(id) {
  const { error } = await sb.from('hike_segments')
    .delete()
    .eq('id', id);
  if (error) throw error;
}
