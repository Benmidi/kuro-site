import { requestWaitlist } from '../waitlist-api.js';

const token = location.hash.slice(1);
const button = document.querySelector('button');
const status = document.querySelector('#status');
if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(token)) {
  button.disabled = false;
} else {
  button.hidden = true;
  document.querySelector('h1').textContent = 'This link is incomplete.';
  document.querySelector('#details').textContent = 'Open the unsubscribe link in your invitation, or choose Privacy & removal on the KURO homepage.';
}
button.addEventListener('click', async () => {
  if (button.disabled) return;
  button.disabled = true;
  status.textContent = 'Unsubscribing…';
  try {
    await requestWaitlist({ action: 'unsubscribe', token });
    button.hidden = true;
    document.querySelector('h1').textContent = 'You’re unsubscribed.';
    document.querySelector('#details').textContent = 'This subscription is closed. You can sign up again on the KURO homepage.';
    status.textContent = 'Unsubscribe complete.';
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});
