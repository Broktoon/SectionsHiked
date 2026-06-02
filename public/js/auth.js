// Supabase client — initialized once, referenced by all scripts.
// Load this script before db.js, map.js, or app.js on every page.
const SUPABASE_URL = 'https://cfezwxpsiorvizzlxkih.supabase.co'
const SUPABASE_KEY = 'sb_publishable_Tw_7FLr4f2eULLY4xOPvyg_rkV2XPN2'

// window.supabase is the library from the CDN; sb is our client instance.
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
window.sb = sb

// Sign in with email + password.
async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}

// Sign up with email + password + username.
// Checks availability first, then passes username in user metadata so the
// on_auth_user_created trigger can write it directly to profiles.
async function signUp(email, password, username) {
  const available = await isUsernameAvailable(username)
  if (!available) throw new Error('Username is already taken.')
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { username } }
  })
  if (error) throw error
  return data
}

// Redirect to Google for OAuth sign-in.
// After Google auth, Supabase redirects back to /auth.html with a code param.
async function signInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + '/auth.html' }
  })
  if (error) throw error
}

// Sign out and return to the landing page.
async function signOut() {
  const { error } = await sb.auth.signOut()
  if (error) throw error
  window.location.href = '/'
}

// Set or update username for a user (used by the post-OAuth username prompt).
async function setUsername(userId, username) {
  const available = await isUsernameAvailable(username)
  if (!available) throw new Error('Username is already taken.')
  const { error } = await sb.from('profiles').update({ username }).eq('id', userId)
  if (error) throw error
}

// Returns true if the username is not yet claimed (calls an RPC callable by anon).
async function isUsernameAvailable(username) {
  const { data, error } = await sb.rpc('is_username_available', { p_username: username })
  if (error) throw error
  return data
}

// Returns the current user's profile row, or null if not signed in.
async function getProfile() {
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return null
  const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).single()
  if (error) throw error
  return data
}
