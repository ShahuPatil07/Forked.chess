/** Browser acceptance for Coach v3 (paid DeepSeek model; ~$0.01 per run).
 * Run with frontend (5173) + backend (8000) running: node scripts/test_coach_v3.cjs
 * Covers: 7-question profile, general question (board untouched, streamed), hidden board coming back for a
 * position question, arrows, puzzle in a new tab, position editor → equal position → play vs Maia,
 * and the user's own board surviving in the "My board" tab. Screenshots go to logs/.
 */
const { chromium } = require('../frontend/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SCHOLAR = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
let browser;

async function ask(page, text) {
  const before = await page.locator('.rounded-tl-sm').count();
  await page.locator('textarea').fill(text);
  await page.keyboard.press('Enter');
  // The Stop button shows while the answer streams; wait for it to come and go.
  const stop = page.locator('button[title="Stop"]')
  await stop.waitFor({ timeout: 10000 }).catch(() => {})
  await stop.waitFor({ state: 'detached', timeout: 120000 });
  const answers = page.locator('.rounded-tl-sm');
  const count = await answers.count();
  return count > before ? (await answers.nth(count - 1).innerText()) : '';
}

(async () => {
  fs.mkdirSync('logs', { recursive: true });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await context.addInitScript(() => {
    localStorage.setItem('forked-user', JSON.stringify({ state: { username: 'Guest', platform: 'lichess', elo: 1500, activeJobId: null }, version: 0 }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const t0 = Date.now();
  const lap = label => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);
  await page.goto((process.env.APP_URL || 'http://localhost:5173') + '/coach');

  // 1. Seven-question profile.
  await page.getByRole('button', { name: 'Start coaching' }).waitFor();
  assert.equal(await page.locator('.card p.text-xs.font-medium').count(), 7, 'seven questions');
  await page.getByRole('button', { name: '1200-1600' }).click();
  await page.getByRole('button', { name: /Concrete lines/ }).click();
  await page.getByRole('button', { name: /Straight to the point/ }).click();
  await page.getByRole('button', { name: 'Understand chess better' }).click();
  await page.getByRole('button', { name: 'Start coaching' }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('forked-coach-level')));
  assert.equal(saved.learning, 'lines'); assert.equal(saved.tone, 'direct'); assert.equal(saved.notation, 'san');
  lap('profile saved');

  // 2. A position on the board, then a GENERAL question: no board analysis, answer about the question.
  await page.getByLabel('Paste FEN or PGN').fill(SCHOLAR);
  await page.getByRole('button', { name: 'Load' }).click();
  await page.getByText('Pasted position').first().waitFor();
  const general = await ask(page, 'Who was the first official world chess champion?');
  lap('general answered');
  console.log('GENERAL:', general.slice(0, 220).replace(/\n/g, ' '));
  assert(/Steinitz/i.test(general), 'general answer names Steinitz');
  assert(!/Qxf7|Analysing the position/.test(await page.locator('.rounded-tl-sm').last().innerText()), 'no board talk');
  assert.equal(await page.getByText('Analysing the position').count(), 0, 'general question did not analyse the board');

  // 3. Hide the board; a position question brings it back, with arrows for the named moves.
  await page.getByRole('button', { name: 'Hide board' }).click();
  assert(!(await page.locator('[data-boardid="coach-workspace"]').first().isVisible()), 'board hidden');
  const pos = await ask(page, "What's the best move here, and why?");
  lap('position answered');
  console.log('POSITION:', pos.slice(0, 260).replace(/\n/g, ' '));
  assert(/Qxf7/.test(pos), 'finds Qxf7#');
  assert(await page.locator('[data-boardid="coach-workspace"]').first().isVisible(), 'board came back');
  const arrowCount = await page.locator('svg line, svg polygon').count();
  assert(arrowCount > 0, 'an arrow is drawn');
  await page.screenshot({ path: 'logs/v3-position-arrows.png' });

  // 4. A puzzle opens in a NEW tab; "My board" keeps the pasted position.
  await ask(page, 'Give me a fork puzzle');
  lap('puzzle loaded');
  await page.getByRole('tab', { name: /Puzzle/ }).waitFor();
  await page.getByText(/Find the best move for (White|Black)/).waitFor();
  await page.screenshot({ path: 'logs/v3-puzzle-tab.png' });
  await page.getByRole('tab', { name: /My board/ }).click();
  await page.getByText('Pasted position').first().waitFor();

  // 5. Material request → editor → generate an equal position → Play vs Maia.
  const setupAnswer = await ask(page, 'Set up a rook endgame for me to practise');
  lap('editor shown');
  console.log('SETUP:', setupAnswer.slice(0, 200).replace(/\n/g, ' '));
  // "A rook endgame" may be read as balanced (→ equal position) or as R+P vs R (→ practice position).
  const balanced = await page.getByText('Balanced → an equal position').count()
  await page.getByRole('button', { name: /Generate position/ }).click();
  await page.getByText(/On the board:/).first().waitFor({ timeout: 60000 });
  if (balanced) await page.getByText(/On the board: .*equal position/).first().waitFor();
  lap(`${balanced ? 'equal' : 'practice'} position generated`);
  await page.getByRole('button', { name: /Play vs Maia/ }).click();
  await page.getByRole('tab', { name: /vs Maia/ }).waitFor();
  await page.getByText(/You \((white|black)\) vs Maia/).waitFor();
  assert.equal(await page.getByLabel('Maia strength').inputValue(), '1900', 'Maia defaults to its strongest');
  await page.screenshot({ path: 'logs/v3-play-maia.png' });
  lap('playing vs Maia');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS: Coach v3 browser acceptance');
  await browser.close();
})().catch(async err => {
  console.error('FAIL:', err.message);
  try { const pages = browser?.contexts()[0]?.pages(); if (pages?.length) await pages[0].screenshot({ path: 'logs/v3-failure.png', fullPage: true }) } catch { /* ignore */ }
  await browser?.close();
  process.exit(1);
});
