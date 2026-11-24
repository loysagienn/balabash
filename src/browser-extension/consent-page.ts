// The page of the consent window (consent.ts): which session asks for which
// tab, and the user's answer. Closing the window declines.

import { ask, field } from './pages.ts';

const id = new URLSearchParams(location.search).get('id') ?? '';
const allow = field<HTMLButtonElement>('allow');
const decline = field<HTMLButtonElement>('decline');

function over(): void {
  field<HTMLParagraphElement>('gone').hidden = false;
  allow.disabled = true;
  decline.disabled = true;
}

const answer = (allowed: boolean) => void ask({ type: 'consent.answer', id, allow: allowed }).then(() => window.close());

allow.addEventListener('click', () => answer(true));
decline.addEventListener('click', () => answer(false));
void ask({ type: 'consent.get', id }).then(request => {
  if (!request) {
    over();

    return;
  }

  field<HTMLSpanElement>('label').textContent = request.label;
  field<HTMLDivElement>('title').textContent = request.title || '(untitled)';
  field<HTMLDivElement>('url').textContent = request.url;
});
