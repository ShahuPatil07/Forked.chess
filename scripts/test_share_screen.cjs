/** Desktop browser integration smoke. Real board bridge/API; simulated capture and speech hardware.
 * Run from repo root: node scripts/test_share_screen.cjs (frontend/backend must be running).
 * --real-capture attempts the native tab picker, which may need an interactive environment.
 * No LLM calls. Artifacts go to ignored logs/. */
const { chromium } = require('../frontend/node_modules/playwright');
const assert = require('node:assert/strict');
let browser;
(async () => {
  const realCapture = process.argv.includes('--real-capture');
  // Use a dedicated test profile; never touch the user's browser profile.
  const context = await chromium.launchPersistentContext('logs/share-screen-browser', { channel: 'chrome', headless: true,
    viewport: { width: 1440, height: 1000 }, args: [
    '--enable-usermedia-screen-capturing',
    '--auto-select-tab-capture-source-by-title=Forked • Board for live coach',
    '--autoplay-policy=no-user-gesture-required',
  ] });
  browser = context;
  let board;
  await context.exposeBinding('__testGetCapture', () => board.evaluate(() => window.__captureConfig));
  await context.addInitScript(() => {
    localStorage.setItem('forked-user', JSON.stringify({ state: { username: 'ShahuPatil27', platform: 'lichess', elo: 1800 }, version: 0 }));
    window.__spoken = [];
    const originalConfig = navigator.mediaDevices.setCaptureHandleConfig?.bind(navigator.mediaDevices);
    navigator.mediaDevices.setCaptureHandleConfig = config => { window.__captureConfig = config; originalConfig?.(config); };
    window.__recognitions = [];
    class Recognition {
      start() { window.__recognition = this; window.__recognitions.push(this); this.active = true; queueMicrotask(() => this.onstart?.()); }
      abort() { if (this.active) { this.active = false; queueMicrotask(() => this.onend?.()); } }
      stop() { this.abort(); }
    }
    window.SpeechRecognition = Recognition;
    window.__ask = text => {
      const rec = window.__recognition;
      if (!rec?.active) throw new Error('Recognition not listening');
      const result = [{ transcript: text }]; result.isFinal = true;
      rec.onresult({ resultIndex: 0, results: [result] }); rec.abort();
    };
    window.speechSynthesis.speak = utterance => {
      window.__spoken.push(utterance.text);
      queueMicrotask(() => { utterance.onstart?.(); utterance.onend?.(); });
    };
    window.speechSynthesis.cancel = () => {};
  });
  if (!realCapture) await context.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const config = await window.__testGetCapture();
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#171425'; ctx.fillRect(0, 0, 960, 540);
      ctx.fillStyle = '#c4b5fd'; ctx.font = '24px sans-serif'; ctx.fillText('Simulated screen for automated session tests', 100, 270);
      const stream = canvas.captureStream(10);
      window.__captureTrack = stream.getVideoTracks()[0];
      window.__captureTrack.getCaptureHandle = () => ({ handle: window.__wrongTab ? 'unrelated' : config.handle, origin: location.origin });
      return stream;
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:5173/share-screen');
  await page.getByRole('heading', { name: /Play a move/ }).waitFor();
  const nav = await page.locator('nav a').allTextContents();
  assert(nav[0].includes('Share Screen') && nav[1].includes('Dashboard'));
  assert.equal(await page.getByLabel('Use AI wording (Groq)').isChecked(), false);
  await page.screenshot({ path: 'logs/share-screen-tutorial.png', fullPage: true });
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open Analysis Board', exact: true }).click();
  board = await popup;
  board.on('pageerror', e => errors.push(e.message));
  await board.getByText('Live coach board', { exact: true }).waitFor();
  await board.waitForFunction(() => document.title.includes('Board for live coach'));
  console.log('Tutorial and paired board ready:', await board.title());
  await page.bringToFront();
  if (!realCapture) {
    await page.evaluate(() => { window.__wrongTab = true; });
    await page.getByRole('button', { name: 'Start sharing', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Choose the' }).waitFor();
    assert.equal(await page.evaluate(() => window.__captureTrack.readyState), 'ended');
    await page.evaluate(() => { window.__wrongTab = false; });
    console.log('Wrong capture source rejected and released.');
  }
  await page.getByRole('button', { name: 'Start sharing', exact: true }).click();
  try { await page.getByTestId('live-call').waitFor({ timeout: 20000 }); }
  catch (e) { console.log('Capture failure:', await page.locator('main').innerText()); throw e; }
  await page.getByText('Exact board position connected').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => window.__recognition?.active);
  await page.screenshot({ path: 'logs/share-screen-call.png', fullPage: true });
  console.log(`${realCapture ? 'Real' : 'Simulated'} capture, real board link, and stable-position greeting passed.`);

  const square = name => board.locator(`[data-square="${name}"]`).first();
  await square('e2').click(); await square('e4').click();
  const request = page.waitForRequest(r => r.url().endsWith('/api/coach/live-turn'));
  await page.waitForFunction(() => window.__recognition?.active);
  await page.evaluate(() => window.__ask('Was that a good move?'));
  const sent = (await request).postDataJSON();
  assert.equal(sent.last_move, 'e2e4');
  assert(sent.before_fen.includes('PPPPPPPP/RNBQKBNR w'));
  assert.equal(sent.use_llm, false);
  await page.waitForFunction(() => window.__spoken.join(' ').includes('last move played'), null, { timeout: 35000 });
  const spoken = await page.evaluate(() => window.__spoken.join(' '));
  assert(spoken.includes('pawn to e 4'));
  assert(!(await page.locator('main').innerText()).includes('last move played'));
  console.log('Real Stockfish voice turn passed; correct pre-move root, audio-only answer.');

  await page.waitForFunction(() => window.__recognition?.active);
  const currentRequest = page.waitForRequest(r => r.url().endsWith('/api/coach/live-turn'));
  await page.evaluate(() => window.__ask('What should I play now?'));
  await currentRequest;
  // Moving while the engine thinks must cancel the old answer.
  const spokenCount = await page.evaluate(() => window.__spoken.length);
  await square('e7').click(); await square('e5').click();
  await page.waitForTimeout(7000);
  assert.equal(await page.evaluate(() => window.__spoken.length), spokenCount);
  console.log('Changing the board suppressed an outdated answer.');
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await page.waitForFunction(() => !window.__recognition?.active);
  if (!realCapture) assert.equal(await page.evaluate(() => window.__captureTrack.readyState), 'live');
  await page.getByRole('button', { name: 'Unmute', exact: true }).click();
  await page.waitForFunction(() => window.__recognition?.active);
  if (!realCapture) {
    await page.evaluate(() => { window.__wrongTab = true; window.__captureTrack.dispatchEvent(new Event('capturehandlechange')); });
    await page.getByText('Select the linked Analysis Board tab to continue').waitFor();
    await page.evaluate(() => { window.__wrongTab = false; window.__captureTrack.dispatchEvent(new Event('capturehandlechange')); });
    await page.getByText('Exact board position connected').waitFor();
    console.log('Source changes suspend the board and reconnect safely.');
  }
  await board.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByText('Exact board position connected').waitFor();
  await page.getByRole('button', { name: 'End call', exact: true }).click();
  await page.getByRole('button', { name: 'Start sharing', exact: true }).waitFor();
  await page.waitForFunction(() => !window.__recognition?.active);
  if (!realCapture) assert.equal(await page.evaluate(() => window.__captureTrack.readyState), 'ended');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Mute, unmute, undo, and call cleanup passed. No browser errors.');
  await browser.close(); browser = null;
})().catch(async error => { console.error(error); if (browser) await browser.close(); process.exitCode = 1; });
