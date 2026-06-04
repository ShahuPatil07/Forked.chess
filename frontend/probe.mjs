import { chromium } from 'playwright'
const SEED = JSON.stringify({ state: { username: 'ShahuPatil27', platform: 'lichess', elo: 1800, activeJobId: null }, version: 0 })
const b = await chromium.launch({ channel: 'chromium' })
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript(s => { try { localStorage.setItem('forked-user', s) } catch {} }, SEED)
for (const [path, name] of [['/replay/loose_pieces', 'fix-replay'], ['/dna/ShahuPatil27', 'fix-dna']]) {
  const p = await ctx.newPage()
  await p.goto('http://localhost:5173' + path, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(4000)
  await p.screenshot({ path: `eval_shots/${name}.png` })  // viewport
  await p.close()
  console.log('shot', name)
}
await b.close()
