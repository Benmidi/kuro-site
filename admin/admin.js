// The admin page: sign in, give an authenticator code, look someone up, see every loop they have
// put in the feed. What the page may read is decided by the database (see session.js); this file
// is only the screen. Text from the backend is always set as text, never as markup.

import * as api from './session.js?v=2';
import { Player, bitmaps, frameSize, unpack } from './loops.js';

// Refuse to run inside someone else's page, where clicks could be steered.
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  throw new Error('KURO admin does not run in a frame.');
}

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const GATES = ['gate-loading', 'gate-sign-in', 'gate-stranger', 'gate-code', 'app'];
const show = id => GATES.forEach(g => { $(g).hidden = g !== id; });
const notice = text => { $('notice').textContent = text || ''; $('notice').hidden = !text; };
const explain = error => (error?.status === 403 || error?.code === '42501'
  ? 'The database refused that. Your code may be more than 12 hours old: sign out and in again.'
  : error?.message || 'Something went wrong.');
const date = iso => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const shortId = id => id.slice(0, 8);
const nameOf = person => person.handle ? '@' + person.handle : person.self ? 'My account' : shortId(person.user_id) + '…';

// MARK: Getting in

let factorId = null, screenRun = 0;

async function enter() {
  const run = ++screenRun;
  notice('');
  if (!api.signedIn()) {
    $('who').hidden = true;
    $('google').hidden = api.isLocal;
    $('local').hidden = !api.isLocal;
    return show('gate-sign-in');
  }
  const me = api.me();
  $('who-name').textContent = me.email || me.phone || shortId(me.sub || '');
  $('who').hidden = false;
  show('gate-loading');
  try {
    const listed = await api.listed();
    if (run !== screenRun) return;
    if (!listed) {
      $('stranger-id').textContent = me.sub || '';
      return show('gate-stranger');
    }
    if (api.hasSecondFactor()) return openApp();
    const { verified, unfinished } = await api.authenticator();
    if (run !== screenRun) return;
    $('code').value = '';
    $('enroll').hidden = Boolean(verified);
    if (verified) {
      factorId = verified.id;
      $('code-title').textContent = 'Authenticator code';
      $('code-lede').textContent = 'Enter the code your authenticator app shows for KURO admin.';
    } else {
      const made = await api.enroll(unfinished);
      if (run !== screenRun) return;
      factorId = made.id;
      $('qr').src = made.qr;
      $('secret').textContent = made.secret;
      $('code-title').textContent = 'Set up your authenticator';
      $('code-lede').textContent = 'Admin access needs a second step. Scan this with an authenticator app, then enter the code it shows. You do this once.';
    }
    show('gate-code');
    $('code').focus();
  } catch (error) {
    if (run !== screenRun || error instanceof api.SessionChanged) return;
    show('none');   // signed in, but nothing to show: the notice says why, and SIGN OUT is there
    notice(explain(error));
  }
}

async function leave(reason) {
  const run = ++screenRun;
  ++searchRun;
  clearTimeout(searchTimer);
  clearTimeout(idle);
  factorId = null;
  $('code').value = '';
  $('search').value = '';
  $('people-status').textContent = '';
  $('person-name').textContent = '';
  $('person-id').textContent = '';
  $('stranger-id').textContent = '';
  $('person-counts').textContent = '';
  $('viewer-facts').replaceChildren();
  $('viewer-canvas').width = 0;
  $('loops-status').textContent = 'Pick someone to see every loop they have put in the feed.';
  $('who-name').textContent = '';
  $('who').hidden = true;
  show('gate-sign-in');
  closeViewer();
  clearLoops();
  clearCampaigns();
  $('people').replaceChildren();
  $('person').hidden = true;
  $('qr').removeAttribute('src');
  $('secret').textContent = '';
  await api.signOut();
  if (run !== screenRun) return;
  await enter();
  notice(reason || '');
}

$('google').addEventListener('click', () => api.signInWithGoogle().catch(error => {
  if (!(error instanceof api.SessionChanged)) notice(explain(error));
}));
$('local').addEventListener('submit', async event => {
  event.preventDefault();
  const run = ++screenRun;
  try {
    await api.signInLocally($('local-key').value, $('local-email').value, $('local-password').value);
    if (run !== screenRun) return;
    $('local-password').value = '';
    await enter();
  } catch (error) { if (run === screenRun && !(error instanceof api.SessionChanged)) notice(explain(error)); }
});
$('code-form').addEventListener('submit', async event => {
  event.preventDefault();
  const run = ++screenRun;
  notice('');
  try {
    await api.verify(factorId, $('code').value.trim());
    if (run !== screenRun) return;
    $('qr').removeAttribute('src');
    $('secret').textContent = '';
    await enter();
  } catch (error) {
    if (run !== screenRun || error instanceof api.SessionChanged) return;
    $('code').value = '';
    $('code').focus();
    notice(error?.status === 403 || error?.status === 422 ? 'That code didn\'t match. Try the next one.' : explain(error));
  }
});
$('sign-out').addEventListener('click', () => leave());
api.onSessionEnd(reason => leave(reason));

// Walk away and the page signs itself out.
const IDLE = 15 * 60 * 1000;
let idle = 0;
const awake = () => {
  clearTimeout(idle);
  idle = setTimeout(() => { if (api.signedIn()) leave('Signed out after 15 minutes without use.'); }, IDLE);
};
['pointerdown', 'keydown', 'scroll'].forEach(type => addEventListener(type, awake, { passive: true, capture: true }));

// MARK: People

let searchTimer = 0, searchRun = 0, current = null;

async function openApp() {
  show('app');
  awake();
  void openCampaigns(screenRun);
  await search('');
}

async function search(query) {
  const run = ++searchRun;
  $('people-status').textContent = 'SEARCHING…';
  try {
    const people = await api.findPeople(query);
    if (run !== searchRun) return;
    $('people-status').textContent = people.length ? (people.length === 50 ? 'FIRST 50 · SEARCH TO NARROW' : '') : 'NOBODY BY THAT NAME HAS POSTED.';
    $('people').replaceChildren(...people.map(person => {
      const button = el('button', { type: 'button' },
        el('span', { className: 'p-name', textContent: nameOf(person) }),
        el('span', { className: 'p-count', textContent: counts(person) }));
      button.dataset.user = person.user_id;
      if (current?.user_id === person.user_id) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => openPerson(person));
      return el('li', {}, button);
    }));
  } catch (error) {
    if (run !== searchRun) return;
    $('people-status').textContent = '';
    notice(explain(error));
  }
}

const counts = person => `${person.posted} IN FEED · ${person.taken_down} TAKEN DOWN`;

$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  // Each search is written to the log, so wait for typing to stop.
  searchTimer = setTimeout(() => search($('search').value), 450);
});

// MARK: A person's loops

let tail = null, loopsRun = 0;
let pushRequest = null, pushTimer = 0;
const cards = new Map();   // card element → { row, player, abort, state }

function clearLoops() {
  loopsRun += 1;
  clearTimeout(pushTimer);
  pushRequest = null;
  $('push-test').disabled = false;
  $('push-test-status').textContent = '';
  for (const [card, entry] of cards) { watcher.unobserve(card); unload(entry); }
  cards.clear();
  queue.length = 0;
  $('grid').replaceChildren();
  $('more').hidden = true;
  tail = null;
  current = null;
}

async function openPerson(person) {
  clearLoops();
  current = person;
  notice('');
  for (const button of $('people').querySelectorAll('button')) {
    if (button.dataset.user === person.user_id) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
  }
  $('person-name').textContent = nameOf(person);
  $('person-id').textContent = person.user_id;
  $('person-counts').textContent = person.self ? '' : counts(person);
  $('person').hidden = false;
  await morePages();
}

$('my-account').addEventListener('click', () => {
  const user_id = api.me().sub;
  if (user_id) return openPerson({ user_id, self: true });
});

function showPushStatus(result, run) {
  const status = $('push-test-status');
  const button = $('push-test');
  if (!result) {
    status.textContent = 'This test is no longer available.';
  } else if (result.pending) {
    status.textContent = `Still processing ${result.pending} device${result.pending === 1 ? '' : 's'}.`;
    pushTimer = setTimeout(async () => {
      try {
        const latest = await api.pushTestStatus(pushRequest);
        if (run === loopsRun) showPushStatus(latest, run);
      } catch (error) {
        if (run === loopsRun) {
          status.textContent = explain(error);
          button.disabled = false;
        }
      }
    }, 5000);
    return;
  } else if (!(result.accepted + result.skipped + result.failed)) {
    status.textContent = 'No eligible devices are registered for this account.';
  } else {
    status.textContent = `Firebase accepted ${result.accepted}. Skipped ${result.skipped}, failed ${result.failed}.`;
  }
  pushRequest = null;
  button.disabled = false;
}

$('push-test').addEventListener('click', async () => {
  const run = loopsRun, person = current;
  const button = $('push-test'), status = $('push-test-status');
  if (!person || button.disabled || !window.confirm(`Send a KURO test notification to devices registered to ${nameOf(person)}?`)) return;
  pushRequest ||= crypto.randomUUID();
  button.disabled = true;
  status.textContent = 'Queuing test…';
  try {
    const result = await api.enqueuePushTest(person.user_id, pushRequest);
    if (run === loopsRun) showPushStatus(result, run);
  } catch (error) {
    if (run === loopsRun) {
      status.textContent = explain(error);
      button.disabled = false;
    }
  }
});

async function morePages() {
  const run = loopsRun, person = current;
  $('more').disabled = true;
  $('loops-status').textContent = 'LOADING…';
  try {
    const page = await api.personLoops(person.user_id, tail);
    if (run !== loopsRun) return;
    for (const row of page) addCard(row);
    tail = page.length ? page[page.length - 1] : tail;
    $('more').hidden = page.length < 24;
    $('loops-status').textContent = cards.size ? `${cards.size} SHOWN, NEWEST FIRST` : 'NOTHING IN THE FEED FROM THIS ACCOUNT.';
  } catch (error) {
    if (run !== loopsRun) return;
    $('loops-status').textContent = '';
    notice(explain(error));
  } finally {
    if (run === loopsRun) $('more').disabled = false;
  }
}
$('more').addEventListener('click', morePages);

function addCard(row) {
  const canvas = el('canvas', { width: 3, height: 4 });
  const note = el('span', { className: 'l-note', textContent: '' });
  const card = el('button', { type: 'button', className: 'loop' }, canvas,
    el('span', { className: 'l-state' + (row.posted ? '' : ' down'), textContent: row.posted ? 'IN FEED' : 'TAKEN DOWN' }),
    el('span', { className: 'l-date', textContent: new Date(row.published_at).toLocaleDateString(undefined, { dateStyle: 'medium' }) }),
    note);
  card.setAttribute('aria-label', `Loop posted ${date(row.published_at)}, ${row.posted ? 'in the feed' : 'taken down'}`);
  card.addEventListener('click', () => openViewer(row));
  cards.set(card, { row, note, player: new Player(canvas, row), abort: null, state: 'idle' });
  $('grid').append(card);
  watcher.observe(card);
}

// Loops are fetched as they come near the screen, two at a time, and let go when they leave, so a
// long history doesn't hold every frame of every loop in memory.
const queue = [];
let loading = 0;
const watcher = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    const entry = cards.get(target);
    if (!entry) continue;
    if (isIntersecting && entry.state === 'idle') { entry.state = 'queued'; queue.push(entry); pump(); }
    else if (!isIntersecting) unload(entry);
  }
}, { rootMargin: '60% 0px' });

function unload(entry) {
  entry.abort?.abort();
  entry.abort = null;
  entry.player.stop();
  if (entry.state !== 'failed') entry.state = 'idle';
}

function pump() {
  while (loading < 2 && queue.length) {
    const entry = queue.shift();
    if (entry.state !== 'queued') continue;
    loading += 1;
    load(entry).finally(() => { loading -= 1; pump(); });
  }
}

async function load(entry) {
  const abort = entry.abort = new AbortController();
  entry.state = 'loading';
  try {
    const bytes = await unpack(await api.loopFile(entry.row, abort.signal), entry.row);
    const frames = await bitmaps(bytes, entry.row, Math.min(entry.row.width, 300));
    if (abort.signal.aborted) return frames.forEach(b => b.close());
    entry.player.play(frames);
    entry.note.textContent = '';
    entry.state = 'playing';
  } catch (error) {
    if (abort.signal.aborted) return;
    entry.state = 'failed';
    entry.note.textContent = (error?.message || 'Could not load').toUpperCase();
  }
}

// MARK: One loop, full size

let viewer = null;

async function openViewer(row) {
  closeViewer();
  const stock = row.spec && typeof row.spec === 'object' ? row.spec : {};
  const facts = [
    ['STATE', row.posted ? 'In the feed' : 'Taken down'],
    ['POSTED', date(row.published_at)],
    ['SHOT', date(row.shot_at)],
    ['STOCK', `${typeof stock.name === 'string' ? stock.name : stock.id || '?'} v${Number(stock.version) || '?'}`],
    ['ROLL', row.roll],
    ['SIZE', `${row.width}×${row.height}, ${row.frames} exposures`],
    ['SOUND', row.tone_frames ? 'Has room tone (not played here)' : 'None'],
    ['LOOP ID', row.id],
    ['OWNER ID', row.owner_id],
  ];
  $('viewer-facts').replaceChildren(...facts.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: String(v) })]));
  const canvas = $('viewer-canvas');
  canvas.width = row.width;
  canvas.height = row.height;
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  const mine = viewer = { player: new Player(canvas, row), abort: new AbortController() };
  $('viewer').showModal();
  try {
    if (frameSize(row) === null) throw new Error('Not a loop the apps would open');
    const frames = await bitmaps(await unpack(await api.loopFile(row, mine.abort.signal), row), row);
    if (viewer !== mine) return frames.forEach(b => b.close());
    mine.player.play(frames);
  } catch (error) {
    if (viewer === mine) notice(explain(error));
  }
}

function closeViewer() {
  viewer?.abort.abort();
  viewer?.player.stop();
  viewer = null;
  if ($('viewer').open) $('viewer').close();
}
$('viewer-close').addEventListener('click', closeViewer);
$('viewer').addEventListener('close', closeViewer);
$('viewer').addEventListener('click', event => { if (event.target === $('viewer')) closeViewer(); });

// MARK: Push campaigns

let campaignRun = 0, historyRun = 0, campaignPreview = null, previewRequest = null, testRequest = null;

function clearCampaigns() {
  ++historyRun;
  $('compose-notification').hidden = true;
  $('campaigns').hidden = true;
  $('campaign-history').replaceChildren();
  $('campaign-history-status').textContent = '';
  $('campaign-form').reset();
  campaignChanged();
}

async function openCampaigns(run) {
  try {
    const enabled = await api.pushCampaignEnabled();
    if (run !== screenRun || !enabled) return;
    $('campaigns').hidden = false;
    $('compose-notification').hidden = false;
    await campaignHistory();
  } catch (error) {
    // The same page supports servers that still have only the generic test send.
    if (run === screenRun && error?.status !== 404 && !(error instanceof api.SessionChanged)) {
      notice(explain(error));
    }
  }
}

function campaignChanged() {
  ++campaignRun;
  campaignPreview = null;
  previewRequest = null;
  testRequest = null;
  $('campaign-preview-button').disabled = false;
  $('campaign-actions').hidden = true;
  $('campaign-action-status').textContent = '';
  $('campaign-status').textContent = '';
  $('campaign-confirm').value = '';
  $('campaign-preview-title').textContent = $('campaign-title').value.trim();
  $('campaign-preview-body').textContent = $('campaign-body').value.trim();
  const mode = $('campaign-delivery').value;
  $('campaign-time-label').hidden = mode === 'now';
  $('campaign-time').disabled = mode === 'now';
  $('campaign-time').required = mode !== 'now';
  $('campaign-time-zone').textContent = mode === 'recipient' ? 'RECIPIENT LOCAL DATE AND TIME'
    : `DATE AND TIME · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
}

$('campaign-form').addEventListener('input', campaignChanged);
$('campaign-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('campaigns').hidden) return;
  const run = ++campaignRun;
  const request = previewRequest ||= crypto.randomUUID();
  const mode = $('campaign-delivery').value, dateTime = $('campaign-time').value;
  $('campaign-preview-button').disabled = true;
  $('campaign-actions').hidden = true;
  $('campaign-status').textContent = 'Checking eligible accounts…';
  try {
    const summary = await api.previewPushCampaign({
      p_request: request, p_title: $('campaign-title').value, p_body: $('campaign-body').value,
      p_audience: $('campaign-audience').value, p_platform: $('campaign-platform').value,
      p_category: $('campaign-category').value,
      p_send_at: mode === 'scheduled' ? new Date(dateTime).toISOString() : null,
      p_local_at: mode === 'recipient' ? dateTime : null,
    });
    if (run !== campaignRun) return;
    campaignPreview = { ...summary, request };
    $('campaign-status').textContent = `Up to ${summary.users} eligible accounts · ${summary.devices} devices. Excluded: ${summary.inactive} inactive, ${summary.opted_out} opted out, ${summary.no_eligible_device} without an eligible device.`;
    $('campaign-confirm-label').hidden = !summary.confirmation;
    $('campaign-confirm-prompt').textContent = summary.confirmation ? `Type ${summary.confirmation} to confirm` : '';
    $('campaign-confirm').value = '';
    $('campaign-schedule').disabled = !summary.users;
    $('campaign-test').disabled = false;
    $('campaign-actions').hidden = false;
  } catch (error) {
    if (run === campaignRun) {
      $('campaign-status').textContent = explain(error);
      if (error?.code === '22023') previewRequest = null;
    }
  } finally {
    if (run === campaignRun) $('campaign-preview-button').disabled = false;
  }
});

$('campaign-test').addEventListener('click', async () => {
  if (!campaignPreview || !window.confirm('Send the test message to your own eligible devices?')) return;
  const run = campaignRun, button = $('campaign-test'), status = $('campaign-action-status');
  button.disabled = true;
  try {
    const result = await api.testPushCampaign(campaignPreview.request, testRequest ||= crypto.randomUUID());
    if (run !== campaignRun) return;
    testRequest = null;
    status.textContent = `Test queued for ${result.devices} devices.`;
    await campaignHistory();
  } catch (error) {
    if (run === campaignRun) status.textContent = explain(error);
  } finally {
    if (run === campaignRun) button.disabled = false;
  }
});

$('campaign-schedule').addEventListener('click', async () => {
  if (!campaignPreview?.users) return;
  const run = campaignRun, button = $('campaign-schedule'), status = $('campaign-action-status');
  const confirmation = $('campaign-confirm').value.trim();
  if (campaignPreview.confirmation && campaignPreview.confirmation !== confirmation) {
    status.textContent = 'Enter the confirmation phrase shown above.';
    $('campaign-confirm').focus();
    return;
  }
  if (!window.confirm(`Queue this campaign for up to ${campaignPreview.users} accounts?`)) return;
  button.disabled = true;
  try {
    await api.schedulePushCampaign(campaignPreview.request, confirmation || null);
    if (run !== campaignRun) return;
    campaignChanged();
    $('campaign-status').textContent = 'Campaign queued.';
    await campaignHistory();
  } catch (error) {
    if (run === campaignRun) {
      button.disabled = false;
      status.textContent = explain(error);
      if (error?.code === '22023') previewRequest = null;
    }
  }
});

async function campaignHistory() {
  const run = ++historyRun, screen = screenRun, status = $('campaign-history-status');
  try {
    const rows = await api.pushCampaignHistory();
    if (run !== historyRun || screen !== screenRun) return;
    status.textContent = rows.length ? '' : 'No campaigns or tests yet.';
    $('campaign-history').replaceChildren(...rows.map(row => {
      const state = row.cancelled_at ? 'Cancelled' : row.pending ? 'Pending' : 'Finished';
      const node = el('li', {}, el('strong', { textContent: row.title }), el('p', {
        className: 'quiet', textContent: `${date(row.created_at)} · ${state} · ${row.pending} pending · ${row.accepted} accepted by FCM · ${row.skipped} skipped · ${row.failed} failed`,
      }));
      if (row.kind === 'campaign') node.append(el('p', {
        className: 'quiet', textContent: [row.audience, row.category, row.platform,
          row.local_at ? `${row.local_at.replace('T', ' ')} recipient local` : row.send_at ? date(row.send_at) : 'As soon as allowed'].join(' · '),
      }));
      if (row.kind === 'campaign' && row.pending && !row.cancelled_at) {
        const cancel = el('button', { className: 'key', type: 'button', textContent: 'CANCEL PENDING SENDS' });
        cancel.addEventListener('click', async () => {
          if (screen !== screenRun || !window.confirm('Cancel pending delivery? Messages already in flight may still arrive.')) return;
          cancel.disabled = true;
          try {
            await api.cancelPushCampaign(row.id);
            if (screen === screenRun) await campaignHistory();
          } catch (error) {
            if (screen === screenRun) { status.textContent = explain(error); cancel.disabled = false; }
          }
        });
        node.append(cancel);
      }
      return node;
    }));
  } catch (error) {
    if (run === historyRun && screen === screenRun) status.textContent = explain(error);
  }
}
$('campaign-refresh').addEventListener('click', campaignHistory);

// MARK: Start

api.finishRedirect().catch(error => error).then(async result => {
  await enter();
  if (result instanceof Error) notice(result.message);
});
