/** Browser acceptance: real review API/Stockfish, no hosted model calls.
 * Run with frontend/backend on localhost: node scripts/test_game_review.cjs
 * Screenshots and exported analysis stay in ignored logs/.
 */
const { chromium } = require('../frontend/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
let browser;
(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:5173/');
  await page.getByRole('heading', { name: /Every move/ }).waitFor();
  await page.screenshot({ path: 'logs/home-desktop.png', fullPage: true });
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Follow the idea' }).click();
  await page.getByRole('heading', { name: 'You win the queen. You save a draw.' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'logs/home-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Review a game', exact: true }).click();
  await page.getByTestId('game-review').waitFor();
  assert.equal(new URL(page.url()).pathname, '/game-review');
  console.log('Homepage desktop/mobile, interactive demo, and guest entry passed.');

  await page.getByLabel('PGN', { exact: true }).fill('1. e4 e5 2. Ke3 *');
  await page.getByRole('button', { name: 'Game review', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /illegal/ }).waitFor();
  await page.getByLabel('Upload PGN').setInputFiles({ name: 'fools-mate.pgn', mimeType: 'text/plain', buffer: Buffer.from('[White "Test White"]\n[Black "Test Black"]\n\n1. f3 e5 2. g4 Qh4# 0-1') });
  await page.getByLabel('Review quality').selectOption('quick');
  await page.getByRole('button', { name: 'Game review', exact: true }).click();
  await page.getByText('Move breakdown', { exact: true }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Move 3: g4, Blunder', exact: true }).click();
  await page.getByRole('button', { name: 'Show best line', exact: true }).click();
  await page.getByRole('button', { name: 'Return to game', exact: true }).click();
  await page.keyboard.press('End');
  await page.getByText('4 / 4', { exact: true }).waitFor();
  assert((await page.locator('main').innerText()).includes('-M1'));
  await page.keyboard.press('ArrowLeft');
  await page.getByText('3 / 4', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Flip board', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export review', exact: true }).click();
  const download = await downloadPromise;
  const artifact = await download.path();
  const review = JSON.parse(fs.readFileSync(artifact, 'utf8'));
  assert(review.complete && review.moves.length === 4);
  assert(review.summary.white.accuracy < review.summary.black.accuracy);
  assert.equal(review.summary.white.rating, null);
  assert.equal(review.moves.at(-1).line.san[0], 'Qh4#');
  console.log('PGN validation/upload, blunder classification, mate polarity, navigation, branches and export passed.');

  await page.getByRole('button', { name: 'Import PGN', exact: true }).click();
  await page.getByRole('button', { name: 'Try the Opera game', exact: true }).click();
  await page.getByLabel('Review quality').selectOption('deep');
  await page.getByRole('button', { name: 'Game review', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'cancelled' }).waitFor();
  // A cancelled worker releases its dedicated engine after the current bounded move.
  await page.waitForTimeout(7000);
  await page.getByRole('button', { name: 'Import PGN', exact: true }).click();
  await page.getByLabel('Review quality').selectOption('quick');
  await page.getByRole('button', { name: 'Game review', exact: true }).click();
  await page.getByText('Move breakdown', { exact: true }).waitFor({ timeout: 120000 });
  await page.getByRole('button', { name: 'Last position', exact: true }).click();
  await page.getByText('33 / 33', { exact: true }).waitFor();
  await page.waitForTimeout(500); // Let the board's move animation finish.
  assert.equal(await page.locator('[data-square="d8"] [data-piece="wR"]').count(), 1);
  assert.equal(await page.locator('[data-piece="wQ"]').count(), 0);
  await page.screenshot({ path: 'logs/game-review-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'logs/game-review-mobile.png', fullPage: true });
  console.log('Cancellation releases the engine; complete Opera game and responsive review passed.');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://localhost:5173/coach');
  await page.getByRole('heading', { name: 'Coach', exact: true }).waitFor();
  const levelButton = page.getByRole('button', { name: 'Start coaching' });
  if (await levelButton.isVisible().catch(() => false)) { await page.getByRole('button', { name: '1200-1600' }).click(); await levelButton.click(); }
  await page.getByText('Your chess coach, with an engine behind every answer.').waitFor();
  const chatWidth = await page.locator('textarea').last().evaluate(el => el.getBoundingClientRect().width);
  assert(chatWidth > 500, `Expected a roomy chat beside the board; received ${chatWidth}`);
  assert.equal(await page.locator('#coach-workspace, [id^="coach-workspace"]').count() > 0, true);
  await page.screenshot({ path: 'logs/coach-wide.png', fullPage: true });
  await page.goto('http://localhost:5173/endgames');
  await page.getByRole('heading', { name: 'Endgames', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Coach$|Ask.*Coach/i }).count(), 0);
  await page.goto('http://localhost:5173/openings');
  await page.getByRole('heading', { name: /Opening/ }).first().waitFor();
  assert.equal(await page.locator('textarea').count(), 0);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Board + chat Coach workspace and removed section chats passed. No browser JavaScript errors.');
  await browser.close(); browser = null;
})().catch(async error => { console.error(error); if (browser) await browser.close(); process.exitCode = 1; });
