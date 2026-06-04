// Headless walkthrough of the Forked app for visual evaluation.
// Seeds the username (Zustand persist) so authed routes load, visits every
// route at desktop + mobile, full-page screenshots into eval_shots/, and logs
// any console / page errors per route to eval_shots/_errors.json.
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = 'http://localhost:5173'
const SEED = JSON.stringify({
  state: { username: 'ShahuPatil27', platform: 'lichess', elo: 1800, activeJobId: null },
  version: 0,
})
const OUT = 'eval_shots'
fs.mkdirSync(OUT, { recursive: true })

// wait: ms to settle after load (SSE/animation/engine). mobile: also shoot mobile.
const ROUTES = [
  { path: '/',                       name: 'home',      wait: 2500, mobile: true },
  { path: '/dashboard',              name: 'dashboard', wait: 3500, mobile: true },
  { path: '/coach',                  name: 'coach',     wait: 4000, mobile: true },
  { path: '/session',                name: 'session',   wait: 4000 },
  { path: '/openings',               name: 'openings',  wait: 4000, mobile: true },
  { path: '/endgames',               name: 'endgames',  wait: 3500, mobile: true },
  { path: '/analysis',               name: 'analysis',  wait: 3000 },
  { path: '/history',                name: 'history',   wait: 3000 },
  { path: '/settings',               name: 'settings',  wait: 2000 },
  { path: '/bot-game',               name: 'botgame',   wait: 4000 },
  { path: '/blindspot/loose_pieces', name: 'blindspot', wait: 3000 },
  { path: '/replay/loose_pieces',    name: 'replay',    wait: 4000 },
  { path: '/dna/ShahuPatil27',       name: 'dna',       wait: 3500 },
]

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile',  width: 390,  height: 844 },
]

const errors = {}

const browser = await chromium.launch({ channel: 'chromium' })
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  await ctx.addInitScript(seed => {
    try { localStorage.setItem('forked-user', seed); sessionStorage.setItem('forked_intro_seen', '1') } catch {}
  }, SEED)

  const list = vp.name === 'mobile' ? ROUTES.filter(r => r.mobile) : ROUTES
  for (const r of list) {
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', e => errs.push('pageerror: ' + e.message))
    page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)) })
    try {
      await page.goto(BASE + r.path, { waitUntil: 'domcontentloaded', timeout: 20000 })
    } catch (e) { errs.push('goto: ' + e.message) }
    await page.waitForTimeout(r.wait)
    const file = `${OUT}/${vp.name}-${r.name}.png`
    try { await page.screenshot({ path: file, fullPage: true }) }
    catch (e) { errs.push('shot: ' + e.message) }
    if (errs.length) errors[`${vp.name}-${r.name}`] = errs
    console.log(`shot ${file}${errs.length ? '  (' + errs.length + ' errs)' : ''}`)
    await page.close()
  }
  await ctx.close()
}
await browser.close()
fs.writeFileSync(`${OUT}/_errors.json`, JSON.stringify(errors, null, 2))
console.log('\nDONE — pages with errors:', Object.keys(errors).length)
