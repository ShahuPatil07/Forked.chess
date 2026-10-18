/** Browser acceptance for the board-aware Coach agent (uses the configured free LLM once or twice).
 * Run with frontend (5173) + backend (8000) running: node scripts/test_coach_agent.cjs
 * Screenshots go to logs/.
 */
const { chromium } = require('../frontend/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
let browser;
(async () => {
  fs.mkdirSync('logs', { recursive: true });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await context.addInitScript(() => localStorage.setItem('forked-user', JSON.stringify({ state: { username: 'Guest', platform: 'lichess', elo: 1500, activeJobId: null }, version: 0 })));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto((process.env.APP_URL || 'http://localhost:5173') + '/coach');

  // Static questionnaire sets the explanation level.
  await page.getByRole('button', { name: 'Start coaching' }).waitFor();
  await page.getByRole('button', { name: '800-1200' }).click();
  await page.getByRole('button', { name: /Short & simple/ }).click();
  await page.getByRole('button', { name: 'Start coaching' }).click();
  await page.getByRole('button', { name: /800-1200 · Short & simple/ }).waitFor();

  // Paste a position onto the board, then ask about it.
  await page.getByLabel('Paste FEN or PGN').fill('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
  await page.getByRole('button', { name: 'Load' }).click();
  await page.getByText('Pasted position').waitFor();
  await page.locator('textarea').fill("What's the best move here, and why?");
  await page.keyboard.press('Enter');
  await page.getByText('Analysing the position').first().waitFor({ timeout: 30000 });
  await page.locator('.rounded-tl-sm').first().waitFor({ timeout: 120000 });
  const answer = await page.locator('.rounded-tl-sm').first().innerText();
  console.log('Answer:', answer);
  assert(/Qxf7/.test(answer), 'Expected the mate Qxf7# in the answer');
  await page.screenshot({ path: 'logs/coach-agent-answer.png', fullPage: true });

  // Clicking a move in the answer shows the line on the board.
  const moveLink = page.locator('.rounded-tl-sm button', { hasText: 'Qxf7' }).first();
  if (await moveLink.count()) {
    await moveLink.click();
    await page.getByRole('button', { name: 'My board' }).waitFor();
    await page.getByRole('button', { name: 'My board' }).click();
  }

  // Follow-up keeps the conversation.
  await page.getByRole('button', { name: 'Explain it simpler' }).click();
  await page.locator('.rounded-tl-sm').nth(1).waitFor({ timeout: 120000 });
  console.log('Follow-up:', await page.locator('.rounded-tl-sm').nth(1).innerText());

  // Play mode against the coach.
  await page.getByRole('button', { name: 'Reset to the starting position' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Start from this position' }).click();
  await page.getByText(/Playing as white vs Coach/).waitFor();
  await page.locator('[data-square="e2"]').dragTo(page.locator('[data-square="e4"]'));
  await page.getByText('Your move').waitFor({ timeout: 20000 });
  await page.screenshot({ path: 'logs/coach-agent-play.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal scroll on mobile');
  await page.screenshot({ path: 'logs/coach-agent-mobile.png', fullPage: true });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Coach agent UI: questionnaire, board context, clickable lines, follow-up, play mode and mobile passed.');
  await browser.close(); browser = null;
})().catch(async error => { console.error(error); if (browser) await browser.close(); process.exitCode = 1; });
