// Signing in and talking to the backend, with no library: plain requests to Supabase Auth,
// PostgREST and Storage.
//
// Nothing here decides who is an admin. The database does, on every request, from the session's
// own token (supabase/migrations/*_admin.sql). This file only gets a session to the point where
// the database will say yes: signed in, then a code from an authenticator app.
//
// The session is kept in memory and nowhere else. Reloading the page signs you out. The site
// shares its origin with everything else on the same host, so nothing that opens the door is left
// in storage for another page there to read.

const LIVE = { url: 'https://rqirmprdejkkfvzhttco.supabase.co', key: 'sb_publishable_MPByWTiV8GOBMTfz3da23A_VPZdOwZh' };
const LOCAL_URL = 'http://127.0.0.1:55321';

/** Served from this machine: use the local stack (docs/development-environments.md), never production. */
export const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

let backend = isLocal ? { url: LOCAL_URL, key: '' } : LIVE;
let session = null;       // { access, refresh, expiresAt }
let refreshTimer = 0;
// In-flight requests belong to this login. Signing out or starting another login invalidates them.
let generation = 0;

export class SessionChanged extends Error {
  constructor() { super('The session changed.'); }
}
const current = run => { if (run !== generation) throw new SessionChanged(); };
function reset() {
  clearTimeout(refreshTimer);
  session = null;
  return ++generation;
}
let onEnd = () => {};

/** Called with a reason when the session ends other than by `signOut()`. */
export function onSessionEnd(fn) { onEnd = fn; }

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.msg || body?.message || body?.error_description || body?.error || `Request failed (${status})`);
    this.status = status;
    this.code = body?.code || body?.error_code || '';
  }
}

async function request(path, { method = 'GET', body, token = session?.access, raw = false, run = generation } = {}) {
  current(run);
  const headers = { apikey: backend.key, Authorization: 'Bearer ' + (token || backend.key) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(backend.url + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
  });
  current(run);
  if (!response.ok) {
    let detail = null;
    try { detail = await response.json(); } catch { /* not JSON */ }
    current(run);
    throw new ApiError(response.status, detail);
  }
  if (raw) return response;
  const text = await response.text();
  current(run);
  return text ? JSON.parse(text) : null;
}

function claims(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), c => c.charCodeAt(0))));
  } catch { return {}; }
}

function adopt(data, run) {
  current(run);
  if (!data?.access_token || !data?.refresh_token) throw new Error('Sign-in did not return a session.');
  session = { access: data.access_token, refresh: data.refresh_token };
  clearTimeout(refreshTimer);
  const seconds = Math.max(30, (Number(data.expires_in) || 3600) - 90);
  refreshTimer = setTimeout(refresh, seconds * 1000);
}

async function refresh() {
  if (!session) return;
  const run = generation, before = session;
  try {
    const data = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh }, token: null, run });
    if (session === before) adopt(data, run);
  } catch {
    if (run === generation && session === before) end('Your session ended. Sign in again.');
  }
}

function end(reason) {
  reset();
  onEnd(reason);
}

export const signedIn = () => session !== null;
/** Who this is, from the token. For display only: the database reads the token itself. */
export const me = () => (session ? claims(session.access) : {});
/** Whether this session has given an authenticator code. The database checks this again. */
export const hasSecondFactor = () => me().aal === 'aal2';

// MARK: Signing in

const VERIFIER = 'kuro-admin-pkce';
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** This page's address without query or fragment: where Google sends the browser back to. */
const here = () => location.origin + location.pathname.replace(/index\.html$/, '');

/** Leaves for Google. The page comes back with a one-time code that `finishRedirect()` trades in. */
export async function signInWithGoogle() {
  const run = reset();
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  current(run);
  // Only until the browser comes back; useless without the code Google's redirect carries.
  sessionStorage.setItem(VERIFIER, verifier);
  const query = new URLSearchParams({ provider: 'google', redirect_to: here(), code_challenge: challenge, code_challenge_method: 's256' });
  location.assign(`${backend.url}/auth/v1/authorize?${query}`);
}

/**
 * Finishes a Google sign-in if this page load is the return from one. Takes the one-time code out
 * of the address bar and the history before doing anything else. Returns whether it signed in.
 */
export async function finishRedirect() {
  const query = new URLSearchParams(location.search);
  const code = query.get('code'), failure = query.get('error_description') || query.get('error');
  let verifier = null;
  try { verifier = sessionStorage.getItem(VERIFIER); sessionStorage.removeItem(VERIFIER); } catch { /* storage is off */ }
  if (location.search || location.hash) history.replaceState(null, '', here());
  if (failure) throw new Error(failure);
  if (!code) return false;
  if (!verifier) throw new Error('That sign-in was started somewhere else. Start again here.');
  const run = reset();
  adopt(await request('/auth/v1/token?grant_type=pkce', { method: 'POST', body: { auth_code: code, code_verifier: verifier }, token: null, run }), run);
  return true;
}

/** Local stack only: its test accounts sign in with a password, and its public key is typed in. */
export async function signInLocally(key, email, password) {
  if (!isLocal) throw new Error('Password sign-in is for the local stack.');
  const run = reset();
  backend = { url: LOCAL_URL, key: key.trim() };
  adopt(await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password }, token: null, run }), run);
}

export async function signOut() {
  const token = session?.access;
  reset();
  // This session only: the same account on a phone stays signed in.
  if (token) await request('/auth/v1/logout?scope=local', { method: 'POST', token }).catch(() => {});
}

// MARK: The authenticator code

/** The account's authenticator, if it has finished setting one up. */
export async function authenticator() {
  const user = await request('/auth/v1/user');
  const factors = (user.factors || []).filter(f => f.factor_type === 'totp');
  return { verified: factors.find(f => f.status === 'verified') || null, unfinished: factors.filter(f => f.status !== 'verified') };
}

/** Starts setting up an authenticator. Returns its id, the secret, and a QR code as an image address. */
export async function enroll(unfinished = []) {
  const run = generation;
  // An earlier attempt that never gave a code would block a new one of the same name.
  for (const factor of unfinished) await request('/auth/v1/factors/' + factor.id, { method: 'DELETE', run }).catch(() => {});
  const made = await request('/auth/v1/factors', { method: 'POST', body: { factor_type: 'totp', friendly_name: 'KURO admin', issuer: 'KURO admin' }, run });
  const svg = made.totp?.qr_code || '';
  return { id: made.id, secret: made.totp?.secret || '', qr: svg.startsWith('data:') ? svg : 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) };
}

/** Gives a code. On success this session is one the database treats as an admin's, if the account is one. */
export async function verify(factorId, code) {
  const run = generation, token = session?.access;
  if (!token) throw new SessionChanged();
  const challenge = await request(`/auth/v1/factors/${factorId}/challenge`, { method: 'POST', body: {}, token, run });
  adopt(await request(`/auth/v1/factors/${factorId}/verify`, { method: 'POST', body: { challenge_id: challenge.id, code }, token, run }), run);
  if (!hasSecondFactor()) throw new Error('The code was accepted but the session was not upgraded.');
}

// MARK: What an admin can ask for

const rpc = (name, args = {}) => request('/rest/v1/rpc/' + name, { method: 'POST', body: args });

export const listed = () => rpc('admin_listed');
export const findPeople = query => rpc('admin_find_people', { p_query: query });
export const personLoops = (user, after) => rpc('admin_person_loops', {
  p_user: user, p_limit: 24, ...(after ? { p_after: after.published_at, p_after_id: after.id } : {}),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A loop's frames file, as a response to read from. The ids come from the database, but check anyway. */
export function loopFile(row, signal) {
  if (!UUID.test(row.owner_id) || !UUID.test(row.id)) throw new Error('Not a loop');
  return fetch(`${backend.url}/storage/v1/object/authenticated/loops/${row.owner_id}/${row.id}.z`, {
    headers: { apikey: backend.key, Authorization: 'Bearer ' + session?.access },
    credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
  });
}
