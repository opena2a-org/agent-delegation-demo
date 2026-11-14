// The page runners' teardown (support/teardown.mjs), with a view server and
// a browser that record their calls: the view server stops before the
// browser is asked to close; a close still pending at the bound is not
// awaited, writes its one diagnostic line and does not fail the hook; the
// browser's cell is ended in every case; a cell not seen to exit after
// SIGKILL fails the hook; and a stop or a close that throws still has the
// cell ended, and the hook fails with that error. No cell times anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSE_BOUND_MS, stopThenClose } from './support/teardown.mjs';

// The bound handed to the helper in place of CLOSE_BOUND_MS.
const BOUND = 20;
const never = () => new Promise(() => {});

function fakes({ stop = async () => {}, close = async () => {}, end = async () => true } = {}) {
  const calls = [];
  const notes = [];
  return {
    calls,
    notes,
    t: { diagnostic: (line) => notes.push(line) },
    view: { stop: async () => { calls.push('view.stop'); await stop(); calls.push('view.stop returned'); } },
    browser: {
      close: async () => { calls.push('browser.close'); await close(); calls.push('browser.close returned'); },
      end: async () => { calls.push('browser.end'); return end(); },
    },
  };
}

test('the page runners give the browser\'s close 30000 ms, and the line past it names that bound', () => {
  assert.equal(CLOSE_BOUND_MS, 30000);
  assert.equal(`teardown: browser.close() past ${CLOSE_BOUND_MS} ms, continuing`, 'teardown: browser.close() past 30000 ms, continuing');
});

test('the view server stops before the browser is asked to close, and the cell is ended after the close returns', async () => {
  const f = fakes();
  await stopThenClose(f.t, f, { closeMs: BOUND });
  assert.deepEqual(f.calls, ['view.stop', 'view.stop returned', 'browser.close', 'browser.close returned', 'browser.end']);
  assert.deepEqual(f.notes, []);
});

test('a close still pending at the bound is not awaited: one diagnostic line, the cell is ended, and the hook does not fail', { timeout: 10000 }, async () => {
  const f = fakes({ close: never });
  await stopThenClose(f.t, f, { closeMs: BOUND });
  assert.deepEqual(f.calls, ['view.stop', 'view.stop returned', 'browser.close', 'browser.end']);
  assert.deepEqual(f.notes, [`teardown: browser.close() past ${BOUND} ms, continuing`]);
});

test('a cell not seen to exit after SIGKILL fails the hook', async () => {
  const f = fakes({ end: async () => false });
  await assert.rejects(stopThenClose(f.t, f, { closeMs: BOUND }), /the browser's cell was sent SIGKILL and no exit was observed/);
  assert.deepEqual(f.calls, ['view.stop', 'view.stop returned', 'browser.close', 'browser.close returned', 'browser.end']);
});

test('a stop that throws: the browser is still closed and its cell ended, and the hook fails with the stop\'s error', async () => {
  const f = fakes({ stop: async () => { throw new Error('the stop failed'); } });
  await assert.rejects(stopThenClose(f.t, f, { closeMs: BOUND }), /the stop failed/);
  assert.deepEqual(f.calls, ['view.stop', 'browser.close', 'browser.close returned', 'browser.end']);
});

test('a close that throws: the cell is still ended, and the hook fails with the close\'s error', async () => {
  const f = fakes({ close: async () => { throw new Error('the close failed'); } });
  await assert.rejects(stopThenClose(f.t, f, { closeMs: BOUND }), /the close failed/);
  assert.deepEqual(f.calls, ['view.stop', 'view.stop returned', 'browser.close', 'browser.end']);
  assert.deepEqual(f.notes, []);
});

test('no browser: the view server stops and nothing else is called', async () => {
  const f = fakes();
  await stopThenClose(f.t, { view: f.view, browser: undefined }, { closeMs: BOUND });
  assert.deepEqual(f.calls, ['view.stop', 'view.stop returned']);
});
