// The page tests' browser: the installed Google Chrome through
// playwright-core, headless, light, with every request that leaves
// 127.0.0.1 aborted and counted. Real input throughout: a control is
// pressed with locator.click() or the keyboard, never by a dispatched event.

import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

export const TERMINAL = ['done', 'mismatch', 'error'];

export async function launchChrome() {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch (err) {
    assert.fail(`precondition: Google Chrome installed where playwright-core finds the chrome channel; the page tests need a real browser (${String(err.message).split('\n')[0]})`);
  }
  return null;
}

export async function newContext(browser, { width = 1440, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
  ctx.outside = [];
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' && (u.protocol === 'http:' || u.protocol === 'ws:')) return route.continue();
    ctx.outside.push(u.origin);
    return route.abort();
  });
  return ctx;
}

export async function mainState(page) {
  return page.evaluate(() => document.querySelector('main').dataset.state);
}

export async function waitLoaded(page) {
  await page.waitForFunction(() => document.querySelector('main').dataset.state !== 'loading', null, { timeout: 30000 });
}

export async function waitTerminal(page, timeout = 240000) {
  await page.waitForFunction((t) => t.includes(document.querySelector('main').dataset.state), TERMINAL, { timeout });
}

// Open a route and, when its step has not run in the run on screen, press
// its run control and wait for a terminal state.
export async function openAndRun(page, base, route) {
  await page.goto(`${base}${route}`);
  await waitLoaded(page);
  if (await mainState(page) === 'idle') {
    await page.locator('main [data-action="run"]').nth(0).click();
    await waitTerminal(page);
  }
  await page.evaluate(() => document.fonts.ready);
}
