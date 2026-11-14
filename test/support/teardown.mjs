// The teardown of a page test file: the view server, then the browser.
//
// The view server stops before the browser closes. Its stop ends the demo's
// processes, closes its listening socket and ends its connections, so
// nothing of the demo waits on the browser. The browser's close is then
// given closeMs. A close still pending at that bound is not awaited: the
// hook writes one diagnostic line and goes on, because every page reading
// was taken before the hook ran. Either way the browser's cell is then
// ended, so the file's process holds no child and exits by itself. A cell
// that does not exit once it has been sent SIGKILL fails the hook.
//
// browser is page-remote.mjs's mirror (close() and end()); view is the
// ViewServer (stop()); t is the hook's context (diagnostic()).

import assert from 'node:assert/strict';

export const CLOSE_BOUND_MS = 30000;

const PAST = Symbol('past the bound');

export async function stopThenClose(t, { view, browser }, { closeMs = CLOSE_BOUND_MS } = {}) {
  try {
    if (view) await view.stop();
  } finally {
    if (browser) await closeWithin(t, browser, closeMs);
  }
}

async function closeWithin(t, browser, closeMs) {
  let timer;
  const bound = new Promise((resolve) => { timer = setTimeout(resolve, closeMs, PAST); });
  const closing = Promise.resolve().then(() => browser.close());
  try {
    if (await Promise.race([closing, bound]) === PAST) {
      // Not awaited past the bound; the end below settles it.
      closing.catch(() => {});
      t.diagnostic(`teardown: browser.close() past ${closeMs} ms, continuing`);
    }
  } finally {
    clearTimeout(timer);
    assert.ok(await browser.end(), 'the browser\'s cell was sent SIGKILL and no exit was observed');
  }
}
