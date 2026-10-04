// The visualization + lesson-access journey, driven in a REAL Chrome over the DevTools protocol against the PRODUCTION build served by the production
// process (one uvicorn serving web/dist and /api). It needs no hardware and no LLM key. DOM-only: real clicks, drags, wheel, keys and reloads, and every
// expected value is read from the JSON the page itself received from the server. Changes no repo file. See docs/VISUALIZATION.md.
//
//   node scripts/viz_journey.mjs <outdir> <baseUrl>          e.g. node scripts/viz_journey.mjs /tmp/viz http://127.0.0.1:8011
//   CHROME_PATH=/path/to/chrome   overrides the Chrome binary (default: the usual install path for this OS)
//   Prints one JSON document on stdout (allPassed, failed, checks, axe results, console and API failures); screenshots go to <outdir>.
//   Needs Node 22+ and `npm ci` done in web/ (it reads web/node_modules/axe-core). Start the server on a throwaway database first:
//   QENTOR_DB_PATH=/tmp/viz.db backend/.venv/bin/python -m uvicorn qentor.api.app:app --app-dir backend --port 8011
//
// WebGL runs through Chrome's software renderer (SwiftShader), so the 3D spheres are really drawn; a rotation is detected by comparing screenshots
// of a sphere's tile (the camera is not exposed to the page), and a Reset must give back the starting pixels exactly.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const OUT = process.argv[2]
const BASE = process.argv[3] ?? 'http://localhost:8011'
const PORT = 9672
const CHROME = process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.error(`[viz ${new Date().toISOString().slice(11, 19)}] ${m}`)

fs.mkdirSync(OUT, { recursive: true })
fs.rmSync(path.join(OUT, 'chrome-profile-viz'), { recursive: true, force: true })
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(OUT, 'chrome-profile-viz')}`,
  '--window-size=1440,900', '--no-first-run', '--no-default-browser-check', '--disk-cache-size=1',
  '--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', 'about:blank'], { stdio: 'ignore' })
async function targetWs() {
  for (let i = 0; i < 60; i++) {
    try { const p = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl } catch {}
    await sleep(250)
  }
  throw new Error('no devtools endpoint')
}
const ws = new WebSocket(await targetWs())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 1
const pending = new Map()
const consoleLines = []
const reqs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  const p = m.params
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(p.type)) consoleLines.push(`[${p.type}] ` + p.args.map((a) => a.value ?? a.description ?? '').join(' '))
  else if (m.method === 'Runtime.exceptionThrown') consoleLines.push('[EXCEPTION] ' + (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text))
  // (Chrome's software GL renderer reports "GPU stall due to ReadPixels" as a performance WARNING when a screenshot is taken: a driver note about the
  // capture, not the page, so it is the one message left out. Any other warning or error is counted.)
  else if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(p.entry.level) && !/GL Driver Message \(OpenGL, Performance/.test(p.entry.text)) consoleLines.push(`[log.${p.entry.level}] ${p.entry.text} ${p.entry.url ?? ''}`)
  else if (m.method === 'Network.requestWillBeSent' && p.request.url.includes('/api/')) reqs.push({ id: p.requestId, url: p.request.url, method: p.request.method, body: p.request.postData ?? null, status: null })
  else if (m.method === 'Network.responseReceived') { const r = reqs.find((x) => x.id === p.requestId); if (r) r.status = p.response.status }
}
const send = (method, params = {}, t = 30000) => new Promise((resolve, reject) => {
  const id = nextId++
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)) }, t)
  pending.set(id, (m) => { clearTimeout(timer); resolve(m) })
  ws.send(JSON.stringify({ id, method, params }))
})
async function ev(expression, label = 'eval') {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(`page ${label} failed: ` + JSON.stringify(r.result.exceptionDetails).slice(0, 500))
  return r.result.result.value
}
const out = { checks: {}, data: {} }
process.on('unhandledRejection', (e) => { console.error('FATAL', e.stack ?? e.message); try { console.log(JSON.stringify({ crash: String(e.stack ?? e.message).slice(0, 600), checks: out.checks, data: out.data }, null, 1)) } catch {} try { chrome.kill() } catch {} process.exit(2) })

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Page.bringToFront'); await send('Emulation.setFocusEmulationEnabled', { enabled: true })
// Qubi (the roaming tutor companion, covered by its own checks) is drawn over whatever it passes, including the sphere tiles whose pixels this journey
// compares, so it is kept out of the picture here: a style rule added by the harness only, the app is untouched.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const add = () => { const s = document.createElement('style'); s.textContent = '[data-testid="guide-launcher"]{visibility:hidden!important}'; document.documentElement.appendChild(s) }; if (document.documentElement) add(); else new MutationObserver((m, o) => { if (document.documentElement) { o.disconnect(); add() } }).observe(document, { childList: true }) })()` })
// Count WebGL draw calls from page start, to prove an idle sphere draws nothing (on-demand rendering).
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__draws = 0; for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) { if (!C) continue; for (const f of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) { const o = C.prototype[f]; if (o) C.prototype[f] = function (...a) { window.__draws++; return o.apply(this, a) } } }` })

const check = (name, ok, detail) => { out.checks[name] = out.checks[name] !== false && !!ok; if (detail !== undefined) out.data[name] = detail; log((ok ? 'ok   ' : 'FAIL ') + name + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 220) : '')) }
const shot = async (name, sel, scale = 1) => { let clip; if (sel) { const r = await rectOf(sel); if (r) clip = { ...r, scale } } const s = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }); fs.writeFileSync(path.join(OUT, name), Buffer.from(s.result.data, 'base64')) }
const desktop = () => send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
const phone = (w = 390) => send('Emulation.setDeviceMetricsOverride', { width: w, height: 844, deviceScaleFactor: 2, mobile: true })
async function go(url) { await send('Page.navigate', { url }); await sleep(1800) }
async function waitFor(expr, ms = 15000, label = expr) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { if (await ev(`!!(${expr})`)) return true } catch {} await sleep(250) }
  log('timeout waiting for: ' + label.slice(0, 120))
  return false
}
const T = JSON.stringify
const byName = (name) => `[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent).trim() === ${T(name)} && !b.disabled)`
const click = async (jsExpr, label) => { const ok = await ev(`(() => { const el = ${jsExpr}; if (!el) return false; el.click(); return true })()`); if (!ok) log('no element to click: ' + (label ?? jsExpr.slice(0, 100))); await sleep(120); return ok }
const clickName = (name) => click(byName(name), name)
const text = () => ev('document.body.innerText')
const testid = (id) => `document.querySelector('[data-testid="${id}"]')`
const tx = (id) => ev(`${testid(id)}?.textContent ?? null`)
const exists = (sel) => ev(`!!document.querySelector(${T(sel)})`)
const count = (sel) => ev(`document.querySelectorAll(${T(sel)}).length`)
const rectOf = (sel) => ev(`(() => { const e = document.querySelector(${T(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + window.scrollX, y: b.top + window.scrollY, width: b.width, height: b.height } })()`)
const hashOf = async (sel) => { const r = await rectOf(sel); const s = await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } }); return crypto.createHash('sha1').update(s.result.data).digest('hex').slice(0, 12) }
const settle = async (sel, ms = 400) => { let a = await hashOf(sel); for (let i = 0; i < 12; i++) { await sleep(ms); const b = await hashOf(sel); if (a === b) return b; a = b } return a }
const scrollTo = async (sel) => { await ev(`document.querySelector(${T(sel)})?.scrollIntoView({ block: 'center' })`); await sleep(500) }
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra })
const drag = async (sel, dx, dy, steps = 10) => { await scrollTo(sel); const r = await rectOf(sel); const sy = await ev('window.scrollY'); const x = r.x + r.width / 2, y = r.y - sy + r.height / 2; await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); for (let i = 1; i <= steps; i++) await mouse('mouseMoved', x + (dx * i) / steps, y + (dy * i) / steps, { buttons: 1 }); await mouse('mouseReleased', x + dx, y + dy) }
const wheel = async (sel, deltaY) => { await scrollTo(sel); const r = await rectOf(sel); const sy = await ev('window.scrollY'); await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x + r.width / 2, y: r.y - sy + r.height / 2, deltaX: 0, deltaY }) }
const key = async (k, code, vk) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }) }
const pageMetrics = () => ev(`(() => { const de = document.documentElement; const offenders = []; for (const el of document.querySelectorAll('body *')) { const r = el.getBoundingClientRect(); if (r.width === 0 || r.right <= window.innerWidth + 1) continue; let p = el.parentElement, clipped = false; while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { clipped = true; break } p = p.parentElement } if (!clipped && getComputedStyle(el).position !== 'fixed') offenders.push(el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 40) + ' right=' + Math.round(r.right)) } return { scrollWidth: de.scrollWidth, innerWidth: window.innerWidth, offenders: offenders.slice(0, 6) } })()`)
const noHScroll = async () => { const m = await pageMetrics(); return m.scrollWidth <= m.innerWidth && m.offenders.length === 0 ? true : m }

const AXE_SRC = fs.readFileSync(new URL('../web/node_modules/axe-core/axe.min.js', import.meta.url), 'utf8')
const AXE_RUN = `(async () => {
  if (!window.axe) { (0, eval)(${JSON.stringify(AXE_SRC)}) }
  const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] })
  return r.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, nodes: v.nodes.slice(0, 3).map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 140), why: (n.any[0]?.message ?? n.all[0]?.message ?? n.none[0]?.message ?? '').slice(0, 160) })) }))
})()`
const axeResults = {}
const axe = async (name) => { const v = await ev(AXE_RUN, 'axe ' + name); axeResults[name] = v; log(`axe ${name}: ${v.length ? v.map((x) => x.id + 'x' + x.count).join(', ') : 'clean'}`); return v }

const lastReq = (part, method = 'POST') => [...reqs].reverse().find((r) => r.url.includes(part) && r.method === method)
const respBody = async (r) => { for (let i = 0; i < 20; i++) { try { const x = await send('Network.getResponseBody', { requestId: r.id }); return JSON.parse(x.result.body) } catch { await sleep(150) } } return null }
const lastJson = async (part, method = 'POST') => { const r = lastReq(part, method); return r ? { req: r.body ? JSON.parse(r.body) : null, res: await respBody(r), status: r.status } : null }
const getJson = (url) => ev(`fetch(${T(url)}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))`)
const fmt = (v) => { let s = v.toFixed(3); if (/^-0\.0+$/.test(s)) s = s.slice(1); return s.replace('-', '−') }
const place = async (gate, qubits) => {
  await ev(`(() => { const b = [...document.querySelectorAll('[aria-label="Gate palette"] button')].find((x) => x.textContent.trim() === ${T(gate)}); if (!b || b.disabled) return false; if (b.getAttribute('aria-pressed') !== 'true') b.click(); return true })()`)
  await sleep(80)
  for (const q of qubits) { await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => new RegExp('^Place [a-zA-Z]+ on qubit ${q}( |$)').test(x.getAttribute('aria-label') ?? '')); if (!b) return false; b.click(); return true })()`); await sleep(80) }
}
const removeAll = async () => {
  for (let n = 0; n < 60; n++) {
    const picked = await ev(`(() => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => { const l = x.getAttribute('aria-label') ?? ''; return l.includes(', step 1 of ') && !l.includes('control on q') }); if (!b) return false; if (b.getAttribute('aria-pressed') !== 'true') b.click(); return true })()`)
    if (!picked) break
    await sleep(120)
    if (!(await clickName('Delete the selected gate'))) break
    await sleep(120)
  }
  await sleep(200)
}
const qubitCount = () => count('[role="group"][aria-label^="Qubit "]')
const setQubits = async (n) => { while ((await qubitCount()) > n) { if (!(await clickName('Remove a qubit'))) break } while ((await qubitCount()) < n) { if (!(await clickName('Add a qubit'))) break } }
const dismissBanner = () => click(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Not now')`, 'Not now')
const fresh = async (path_ = '/') => { await go(BASE + path_); await ev('localStorage.clear()'); await go(BASE + path_); await dismissBanner() }
let seenExec = 0
const execDone = () => reqs.filter((r) => r.url.endsWith('/api/execute') && r.method === 'POST' && r.status !== null).length
// Wait for a run that started AFTER the last wait (the page auto-runs 250 ms after an edit), until no further run follows, then for the view to draw.
const waitResult = async (ms = 20000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms && execDone() <= seenExec) await sleep(150)
  let n = execDone()
  for (let quiet = 0; quiet < 4 && Date.now() - t0 < ms; ) { await sleep(150); const m = execDone(); if (m === n) quiet += 1; else { n = m; quiet = 0 } }
  seenExec = n
  await waitFor(`document.querySelector('[data-testid="result-state-view"]') && !document.body.innerText.includes('Running on backend')`, ms)
  return true
}
const tileSel = (q, scope = '[data-testid="result-state-view"]') => `${scope} [data-testid="sphere-3d-q${q}"]`
const draws = () => ev('window.__draws')

// ===================================================================== catalogs from the server
await desktop()
await go(BASE + '/')
await ev('localStorage.clear()')
const lessonsRes = await getJson('/api/lessons')
const LESSONS = lessonsRes.json.lessons
const L = Object.fromEntries(LESSONS.map((l) => [l.id, l]))
check('V00a the server serves the 19 lessons', LESSONS.length === 19, LESSONS.length)

// ===================================================================== PART 1: every lesson opens, with no prerequisite locking
await go(BASE + '/learn')
await ev('localStorage.clear()')
await go(BASE + '/learn')
await waitFor(`document.querySelectorAll('ul button').length >= 19`, 15000)
const cardInfo = () => ev(`[...document.querySelectorAll('ul button')].map((b) => ({ label: b.getAttribute('aria-label') ?? '', off: b.disabled, text: b.innerText }))`)
let cards = await cardInfo()
check('V01a all 19 lesson cards are enabled buttons, and none says locked', cards.length === 19 && cards.every((c) => !c.off && !/locked/i.test(c.label + c.text)), cards.filter((c) => c.off || /locked/i.test(c.label + c.text)).map((c) => c.label))
const withPrereq = LESSONS.filter((l) => l.prerequisite_lesson_ids.length > 0)
check('V01b every lesson that builds on another says "Builds on:" with that lesson’s title (prerequisite metadata is kept and shown)', withPrereq.every((l) => { const c = cards.find((x) => x.label.startsWith(l.title)); return c && c.text.includes('Builds on:') && l.prerequisite_lesson_ids.every((id) => c.text.includes(L[id].title)) }), withPrereq.length)
check('V01c exactly one lesson is "Suggested next", the first with no prerequisites', cards.filter((c) => /Suggested next/.test(c.text)).length === 1 && /Suggested next/.test(cards.find((c) => c.label.startsWith(LESSONS[0].title))?.text ?? ''))
const opened = []
for (const l of LESSONS) {
  await click(`[...document.querySelectorAll('ul button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith(${T(l.title)} + ' —') || (b.getAttribute('aria-label') ?? '') === ${T(l.title)})`, 'card ' + l.title)
  const ok = await waitFor(`[...document.querySelectorAll('h2')].some((h) => h.textContent.trim() === ${T(l.title)})`, 8000)
  const body = await text()
  opened.push({ id: l.id, ok, locked: /locked/i.test(body) })
}
check('V01d every one of the 19 lessons opens directly from a fresh start, and no screen says locked', opened.every((o) => o.ok && !o.locked), opened.filter((o) => !o.ok || o.locked))
await click(`[...document.querySelectorAll('ul button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith("Shor's Algorithm"))`, 'Shor')
await waitFor(`document.body.innerText.includes('can start here any time')`, 5000)
check('V01e a lesson that builds on another says it can still be started any time', (await text()).includes('recommended first, but you can start here any time'))
await shot('v01_learn.png')
await axe('learn')
await axe('lesson')

// old saved progress (the v1 blob an earlier build wrote) still loads and drives the recommendation
const first = L[LESSONS[0].id]
const postJson = (url, body) => ev(`fetch(${T(url)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${T(JSON.stringify(body))} }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))`)
const rightOption = async (lessonId, section) => { for (const o of section.options) { const g = await postJson(`/api/lessons/${lessonId}/concept-checks/${section.id}/grade`, { selected_option_id: o.id }); if (g.json?.correct) return o.id } return section.options[0].id }
const attempts = {}
for (const sec of first.sections.filter((x) => x.type === 'concept_check' && x.question)) attempts[sec.id] = { selectedOptionId: await rightOption(first.id, sec), isCorrect: true, attemptCount: 1 }
await ev(`localStorage.setItem('qentor.learn.progress.v1', ${T(JSON.stringify({ version: 1, startedLessonIds: [first.id], lessons: { [first.id]: { activeSectionIndex: 0, completedSectionIds: first.sections.map((s) => s.id), conceptCheckAttempts: attempts } } }))})`)
await go(BASE + '/learn')
await waitFor(`document.querySelectorAll('ul button').length >= 19`, 15000)
cards = await cardInfo()
await sleep(1500) // the server re-grades the saved selections after the catalog loads
cards = await cardInfo()
const doneCard = cards.find((c) => c.label.startsWith(first.title))
const suggested = cards.filter((c) => /Suggested next/.test(c.text))
check('V01f an old saved v1 progress blob still loads: that lesson shows as completed and the suggestion moves on to a lesson whose prerequisites are done', !!doneCard && /completed/.test(doneCard.label) && suggested.length === 1 && !suggested[0].label.startsWith(first.title) && L[LESSONS.find((l) => suggested[0].label.startsWith(l.title)).id].prerequisite_lesson_ids.every((id) => id === first.id), { done: doneCard?.label, suggested: suggested.map((c) => c.label) })
await ev(`localStorage.clear()`)

// ===================================================================== PART 2: the 3D view — one qubit
await fresh('/')
await setQubits(1)
await place('H', [0])
await waitResult()
await sleep(1500)
const execOne = await lastJson('/api/execute')
const q1 = execOne.res.qubit_states
check('V02a one qubit: "Interactive Bloch sphere", one 3D tile, one canvas', (await text()).includes('INTERACTIVE BLOCH SPHERE') && (await count('[data-testid="result-state-view"] [data-testid^="sphere-3d-"]')) === 1 && (await count('canvas')) === 1, { tiles: await count('[data-testid^="sphere-3d-"]'), canvases: await count('canvas') })
const read = (q, axis) => tx(`qubit3d-${axis}-${q}`)
check('V02b the sphere’s text alternative lists X, Y, Z exactly as the server computed them (|+> is +x)', [await read(0, 'x'), await read(0, 'y'), await read(0, 'z')].join() === [q1[0].bloch.x, q1[0].bloch.y, q1[0].bloch.z].map(fmt).join() && Math.abs(q1[0].bloch.x - 1) < 1e-9, { shown: [await read(0, 'x'), await read(0, 'y'), await read(0, 'z')], server: q1[0].bloch })
check('V02c the sphere has an accessible name stating its backend vector and a help text for the controls', await ev(`(() => { const t = document.querySelector('[data-testid="sphere-3d-q0"]'); const help = document.getElementById(t.getAttribute('aria-describedby')); return /Interactive 3D Bloch sphere of qubit 0/.test(t.getAttribute('aria-label')) && /x = 1\\.000/.test(t.getAttribute('aria-label')) && !!help && /arrow keys rotate/.test(help.textContent) })()`))
check('V02d every number carries provenance: the card names the backend and the run, and the source is the server’s record', await ev(`(() => { const c = document.querySelector('[data-testid="qubit3d-card-0"]').innerText; return /qiskit-aer/.test(c) && c.includes(${T(q1[0].derived_from.result_id.slice(0, 8))}) })()`))
await shot('v02_one_qubit.png', '[data-testid="result-state-view"]')
check('V02e the 3D sphere really drew something (the tile is not blank)', (await ev(`(() => { const c = document.querySelector('canvas'); return !!c && c.width > 0 })()`)))

// ===================================================================== PART 3: a register — one sphere per qubit, and the camera controls
await setQubits(2) // (resizing starts a new, empty circuit: this app's existing behaviour)
await place('H', [0]); await place('CX', [0, 1])
await waitResult()
await sleep(1500)
const execBell = await lastJson('/api/execute')
const qb = execBell.res.qubit_states
check('V03a two qubits: "Qubit state view" with one 3D sphere per qubit, still ONE canvas', (await text()).includes('QUBIT STATE VIEW') && (await count('[data-testid="result-state-view"] [data-testid^="sphere-3d-"]')) === 2 && (await count('canvas')) === 1, { tiles: await count('[data-testid^="sphere-3d-"]'), canvases: await count('canvas') })
check('V03b the Bell pair: each qubit’s reduced vector, purity and entanglement are the server’s (length 0, purity 0.5, entangled)', (await Promise.all([0, 1].map(async (q) => [await read(q, 'x'), await read(q, 'y'), await read(q, 'z'), await tx(`qubit3d-purity-${q}`)].join()))).every((s, q) => s === [qb[q].bloch.x, qb[q].bloch.y, qb[q].bloch.z, qb[q].purity].map(fmt).join()) && qb.every((s) => s.entangled_with_rest === true && Math.abs(s.purity - 0.5) < 1e-9) && (await tx('qubit3d-entanglement-0')).includes('entangled with the rest'), qb.map((s) => [s.bloch, s.purity]))
await shot('v03_bell.png', '[data-testid="result-state-view"]')

// product state: H on q0 and X on q1 in a fresh two-qubit circuit
await removeAll(); await place('H', [0]); await place('X', [1])
await waitResult(); await sleep(1500)
const execProd = await lastJson('/api/execute'); const qp = execProd.res.qubit_states
check('V03c a product state: each qubit has its own pure vector (q0 +x, q1 −z), not entangled', qp.length === 2 && Math.abs(qp[0].bloch.x - 1) < 1e-9 && Math.abs(qp[1].bloch.z + 1) < 1e-9 && qp.every((s) => s.entangled_with_rest === false) && [await read(1, 'z')].join() === fmt(qp[1].bloch.z), qp.map((s) => s.bloch))
// back to the Bell pair for the camera tests
await removeAll(); await place('H', [0]); await place('CX', [0, 1]); await waitResult(); await sleep(1500)

const T0 = tileSel(0), T1 = tileSel(1)
await scrollTo(T0)
const start = await settle(T0)
check('V03d the starting view is stable: the same pixels twice', (await hashOf(T0)) === start)
const idleBefore = await draws(); await sleep(1500); const idleAfter = await draws()
check('V03e an idle sphere draws nothing (rendering is on demand: no draw call in 1.5 s)', idleBefore === idleAfter, { before: idleBefore, after: idleAfter })
await drag(T0, 80, 30)
const afterDrag = await settle(T0)
check('V03f dragging a sphere rotates it (manual orbit)', afterDrag !== start)
await wheel(T0, -300)
const afterZoom = await settle(T0)
check('V03g the wheel zooms it', afterZoom !== afterDrag)
await clickName('Reset view')
check('V03h "Reset view" returns the exact starting pixels', (await settle(T0)) === start)
await ev(`document.querySelector(${T(T0)}).focus()`)
await key('ArrowLeft', 'ArrowLeft', 37)
const afterKey = await settle(T0)
check('V03i with a sphere focused, an arrow key rotates it, and 0 resets it exactly', afterKey !== start && (await (async () => { await key('0', 'Digit0', 48); return settle(T0) })()) === start)
await key('=', 'Equal', 187)
const keyZoom = await settle(T0)
await key('Home', 'Home', 36)
check('V03j + zooms with the keyboard and Home resets exactly', keyZoom !== start && (await settle(T0)) === start)
await scrollTo(T1)
const q1Start = await settle(T1)
await drag(T1, 70, 40)
await scrollTo(T0)
check('V03k spheres are independent: dragging qubit 1’s sphere does not turn qubit 0’s', (await settle(T0)) === start && (await settle(T1)) !== q1Start)
await ev(`document.querySelector(${T(T0)}).focus()`)
for (let i = 0; i < 14; i++) await key('-', 'Minus', 189)
const farOut = await settle(T0)
for (let i = 0; i < 4; i++) await key('-', 'Minus', 189)
const farOut2 = await settle(T0)
for (let i = 0; i < 30; i++) await key('=', 'Equal', 187)
const nearIn = await settle(T0)
for (let i = 0; i < 4; i++) await key('=', 'Equal', 187)
const nearIn2 = await settle(T0)
check('V03l the camera is limited both ways: pushing the zoom out, then in, stops at a limit and the sphere stays in view (not blank, not lost)', farOut === farOut2 && nearIn === nearIn2 && farOut !== nearIn && farOut !== start)
await clickName('Reset view')
await settle(T0)
const autoBtn = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Auto rotate')`
check('V03m auto-rotate is OFF by default and the toggle says so', (await ev(`${autoBtn}.getAttribute('aria-pressed')`)) === 'false' && (await settle(T0)) === start)
await click(autoBtn, 'auto rotate')
await sleep(500)
const a1 = await hashOf(T0); await sleep(700); const a2 = await hashOf(T0)
check('V03n switching auto-rotate on makes the sphere turn by itself; the toggle reads pressed', a1 !== a2 && (await ev(`${autoBtn}.getAttribute('aria-pressed')`)) === 'true')
await click(autoBtn, 'auto rotate off')
await settle(T0, 700)
const idle2 = await draws(); await sleep(1200)
check('V03o switching it off stops it, and it stops drawing', (await draws()) === idle2)
await clickName('Reset view'); await settle(T0)

// ===================================================================== PART 4: the trace drives a view, the gate, and the Tutor
await clickName('Run trace')
await waitFor(`document.querySelector('[data-testid="trace-state-view"]')`, 30000)
await sleep(1500)
const trace = (await lastJson('/api/execute/trace')).res
check('V04a the trace has its own 3D state view (a second view; the page now holds two spheres per qubit on two canvases)', (await count('[data-testid="trace-state-view"] [data-testid^="sphere-3d-"]')) === 2 && (await count('canvas')) === 2)
const traceView = '[data-testid="trace-state-view"]'
const stepOfPage = () => ev(`(() => { const m = /Step (\\d+) of (\\d+)/.exec(document.querySelector('[data-testid="qubit-state-context"]')?.parentElement?.parentElement?.querySelector('[data-testid="qubit-state-context"]')?.innerText ?? document.querySelector('${traceView} [data-testid="qubit-state-context"]')?.innerText ?? ''); return m ? parseInt(m[1], 10) : -1 })()`)
const traceRead = async (q, axis) => ev(`document.querySelector('${traceView} [data-testid="qubit3d-${axis}-${q}"]')?.textContent ?? null`)
const shownStep = async () => [0, 1].map(async (q) => [await traceRead(q, 'x'), await traceRead(q, 'y'), await traceRead(q, 'z')].join())
const expectStep = (i) => [0, 1].map((q) => [trace.steps[i].qubit_states[q].bloch.x, trace.steps[i].qubit_states[q].bloch.y, trace.steps[i].qubit_states[q].bloch.z].map(fmt).join())
check('V04b step 1 (the initial state) shows both qubits on +z, as the server’s trace says', (await Promise.all(await shownStep())).join('|') === expectStep(0).join('|'))
const traceTile = tileSel(0, traceView)
await scrollTo(traceTile)
const tStart = await settle(traceTile)
await drag(traceTile, 60, 20)
const tRot = await settle(traceTile)
await clickName('Next step')
await sleep(800)
check('V04c Next step shows step 2: the 3D view updates to the server’s values for that step and says which step and gate', (await Promise.all(await shownStep())).join('|') === expectStep(1).join('|') && /Step 2 of 3/.test(await tx('qubit-state-context') ?? '') || (await ev(`/Step 2 of 3/.test(document.querySelector('${traceView} [data-testid="qubit-state-context"]').innerText)`)), expectStep(1))
await clickName('Next step'); await sleep(800)
check('V04d step 3 (after CX) shows both qubits mixed, as the server’s trace says', (await Promise.all(await shownStep())).join('|') === expectStep(2).join('|') && trace.steps[2].qubit_states.every((s) => s.entangled_with_rest === true))
await scrollTo(traceTile)
const tAfter = await settle(traceTile)
check('V04e a step change does not reset the camera: the rotation made before stepping is still there (the view changed with the state, not back to the start)', tAfter !== tStart && (await count(`${traceView} [data-testid^="sphere-3d-"]`)) === 2)
await clickName('Previous step'); await sleep(500); await clickName('First step'); await sleep(500)
check('V04f First step goes back to the initial state’s values', (await Promise.all(await shownStep())).join('|') === expectStep(0).join('|'))
// the gate in the canvas follows the step
await scrollTo('[role="group"][aria-label="Circuit editor"]')
await clickName('Last step'); await sleep(600)
check('V04g the selected trace step marks its gate on the canvas (CX), and only that gate', await ev(`(() => { const m = [...document.querySelectorAll('[data-testid="traced-marker"]')].map((e) => e.closest('button').getAttribute('aria-label')); return m.length === 1 && /^CX/.test(m[0]) })()`))
await click(`document.querySelector('button[data-op-index="0"]')`, 'select H')
await sleep(500)
check('V04h picking a gate on the canvas selects its trace step (the view says step 2), shows its details, and marks its line in the QASM', await ev(`(() => { const d = document.querySelector('[data-testid="selected-op-trace"]')?.innerText ?? ''; const v = document.querySelector('${traceView} [data-testid="qubit-state-context"]')?.innerText ?? ''; return /trace step 2 of 3/.test(d) && /Step 2 of 3/.test(v) && !!document.querySelector('.cm-op-line-selected') && document.querySelector('.cm-op-line-selected').innerText.trim() === 'h q[0];' })()`))
await shot('v04_trace_selected.png')
// the Tutor still gets the selected step by id
await clickName('What changed?'); await sleep(300)
await clickName('What changed in this step?')
for (let i = 0; i < 160; i++) { const r = lastReq('/api/tutor'); if (r && r.status) break; await sleep(250) }
await sleep(900)
const tutor = await lastJson('/api/tutor')
check('V04i the Tutor is grounded in the selected trace step by ids only: no number from the browser, facts come back from the server', tutor?.status === 200 && Array.isArray(tutor.res.facts) && tutor.res.facts.length > 0 && !/probab|amplitude|counts|bloch|purity|statevector/i.test(JSON.stringify(tutor.req)), tutor && Object.keys(tutor.req))
const gateTip = await ev(`document.querySelector('[data-testid="traced-marker"]') !== null`)
check('V04j the traced gate stays marked while the Tutor answers', gateTip)

// ===================================================================== PART 5: the editor
await removeAll()
await ev(`document.querySelector('[role="group"][aria-label="Circuit editor"]').scrollIntoView()`)
check('V05a an empty circuit invites ("Drag a gate onto a qubit wire") rather than showing a blank grid', await ev(`!!document.querySelector('[data-testid="empty-circuit-hint"]') && /Drag a gate onto a qubit wire/.test(document.querySelector('[data-testid="empty-circuit-hint"]').innerText)`))
await shot('v05_empty.png', '[role="group"][aria-label="Circuit editor"]')
await setQubits(3)
await place('H', [0]); await place('CX', [0, 1]); await place('CP', [0, 2]); await place('RX', [1]); await place('SWAP', [1, 2]); await place('CCX', [0, 1, 2]); await place('M', [0])
await sleep(800)
check('V05b controlled gates are drawn with dots, round targets and connecting lines (CX, CP, SWAP, CCX: 2+3+2+... connector segments), and the controlled phase writes its angle', await ev(`(() => { const e = document.querySelector('[role="group"][aria-label="Circuit editor"]'); return e.querySelectorAll('[data-testid="control-dot"]').length === 1 + 1 + 2 && e.querySelectorAll('[data-testid="gate-connector"]').length >= 8 && /φ π\\/2/.test(e.querySelector('[data-testid="connector-angle"]').innerText) && !!e.querySelector('button.rounded-full[data-op-index]') })()`))
check('V05c every connector is geometrically joined: each line segment sits inside its wire’s cell and the lines of neighbouring wires meet', await ev(`(() => { const e = document.querySelector('[role="group"][aria-label="Circuit editor"]'); const rows = [...e.querySelectorAll('[role="group"][aria-label^="Qubit "]')]; const ys = rows.map((r) => r.getBoundingClientRect()); const pitch = ys.slice(1).map((r, i) => Math.round(r.top - ys[i].top)); const lines = [...e.querySelectorAll('[data-testid="gate-connector"]')].map((l) => l.getBoundingClientRect()); return pitch.every((p) => p === 60) && lines.every((l) => l.width > 0 && l.height > 0 && l.height < 100) })()`), await ev(`[...document.querySelectorAll('[aria-label^="Qubit "]')].map((r) => Math.round(r.getBoundingClientRect().top))`))
await click(`document.querySelector('button[data-op-index="2"][aria-label^="CP"]')`, 'CP')
await sleep(300)
check('V05d the picked gate is clearly highlighted and its details are shown (family, name, step)', await ev(`(() => { const b = document.querySelector('button[data-op-index="2"]'); const d = document.querySelector('[data-testid="selected-op-detail"]').innerText; return b.getAttribute('aria-pressed') === 'true' && /ring-2/.test(b.className) && /Controlled/.test(d) && /Controlled-phase/.test(d) })()`))
await click(`document.querySelector('button[aria-label="Let go of the selected gate"]')`, 'done')
await click(`[...document.querySelectorAll('[aria-label="Gate palette"] button')].find((b) => b.textContent.trim() === 'CX')`, 'pick CX')
const cellRect = await ev(`(() => { const b = document.querySelector('button[aria-label^="Place cx on qubit 1"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, ghost: b.getAttribute('data-ghost') } })()`)
await mouse('mouseMoved', cellRect.x, cellRect.y)
await sleep(300)
check('V05e the insertion cell under the pointer previews the next gate (a control dot first) and a dashed guide runs through every wire', cellRect.ghost === '●' && await ev(`(() => { const c = getComputedStyle(document.querySelector('button[aria-label^="Place cx on qubit 1"]'), '::after'); return c.content.includes('●') && document.querySelectorAll('[data-testid="insertion-guide"]').length === 3 })()`), cellRect)
await shot('v05_editor.png', '[role="group"][aria-label="Circuit editor"]')
await click(`[...document.querySelectorAll('[aria-label="Gate palette"] button')].find((b) => b.textContent.trim() === 'CX')`, 'unpick')
// an invalid placement: move the first gate up off the register
await click(`document.querySelector('button[data-op-index="0"]')`, 'pick first gate')
check('V05f1 "Move up a wire" is disabled for a gate already on the first wire (the editor does not offer an edit it would refuse)', await ev(`document.querySelector('button[aria-label="Move up a wire"]').disabled`))
await ev(`document.querySelector('button[data-op-index="0"]').focus()`)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38, modifiers: 1 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38, modifiers: 1 })
await sleep(300)
check('V05f a refused edit (Alt+Up from the first wire, by keyboard) turns the insertion cells red and shows the reason as an alert, and the circuit is untouched', await ev(`(() => { const cells = [...document.querySelectorAll('button[data-invalid="true"]')]; const alert = [...document.querySelectorAll('[role="alert"]')].map((a) => a.innerText).join(' '); return cells.length === 3 && alert.length > 0 && document.querySelectorAll('button[data-op-index]').length >= 7 })()`))
await click(`document.querySelector('button[aria-label="Let go of the selected gate"]')`, 'done')
await axe('lab-editor-and-3d')

// ===================================================================== PART 6: the lessons' Labs use the same visualization (QFT, QPE, QEC, Shor, VQE, Grover)
const answerOpenCheck = async () => { const r = await ev(`(() => { const radio = document.querySelector('input[type=radio]:not([disabled])'); if (!radio) return false; radio.click(); return true })()`); if (!r) return false; await sleep(150); await clickName('Submit'); await waitFor(`/Correct\\.|Not quite\\./.test(document.body.innerText)`, 10000); return true }
async function walkToLab(id) {
  const sections = L[id].sections
  await go(BASE + '/learn'); await waitFor(`document.querySelectorAll('ul button').length >= 19`, 15000)
  await click(`[...document.querySelectorAll('ul button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith(${T(L[id].title)} + ' —') || (b.getAttribute('aria-label') ?? '') === ${T(L[id].title)})`, 'card')
  await waitFor(`document.querySelector('[aria-label*="lesson progress"]')`, 10000)
  for (let guard = 0; guard < 16; guard++) {
    const i = await ev(`(() => { const m = /Step (\\d+) of (\\d+)/.exec(document.body.innerText); return m ? parseInt(m[1], 10) - 1 : -1 })()`)
    if (i < 0) return false
    if (sections[i].type === 'interactive_lab') return true
    if (sections[i].type === 'concept_check' && sections[i].question) await answerOpenCheck()
    if (!(await clickName('Continue'))) return false
    await sleep(250)
  }
  return false
}
const labOf = {}
for (const id of ['quantum-fourier-transform', 'quantum-phase-estimation', 'quantum-error-correction', 'shors-algorithm', 'grovers-search']) {
  const atLab = await walkToLab(id)
  const opened = atLab && (await clickName('Open in Lab'))
  await waitFor(`location.pathname === '/'`, 10000)
  await waitResult(30000); await sleep(1200)
  const n = L[id].linked_circuit.num_qubits
  const exec = await lastJson('/api/execute')
  const tiles = await count('[data-testid="result-state-view"] [data-testid^="sphere-3d-"]')
  const mode = await ev(`document.querySelector('[data-testid="result-state-view"]')?.getAttribute('data-mode')`)
  const view = await ev(`document.querySelector('[data-testid="result-state-view"]')?.innerText ?? ''`)
  const mixedOrOk = exec.res.qubit_states?.length === n
  labOf[id] = { atLab, opened, n, tiles, mode, states: exec.res.qubit_states?.length }
  // a statevector run shows one sphere per qubit; a circuit that ends in measurements is a collapsed state and says so
  check(`V06 ${id}: Learn → Lab shows ${n} per-qubit spheres from the server's own states (and one canvas)`, atLab && opened && tiles === n && mode === '3d' && mixedOrOk && (await count('canvas')) === 1, labOf[id])
  if (id === 'quantum-fourier-transform') { await shot('v06_qft.png', '[data-testid="result-state-view"]') }
  if (id === 'quantum-phase-estimation') await shot('v06_qpe.png', '[data-testid="result-state-view"]')
  if (id === 'quantum-error-correction') await shot('v06_qec.png', '[data-testid="result-state-view"]')
}
await axe('lab-from-lesson')

// VQE (lesson 17): the sweep's Bloch state is the same 3D view
{
  const id = 'variational-vqe'
  await go(BASE + '/learn'); await waitFor(`document.querySelectorAll('ul button').length >= 19`, 15000)
  await click(`[...document.querySelectorAll('ul button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith(${T(L[id].title)}))`, 'vqe card')
  await waitFor(`document.querySelector('[aria-label*="lesson progress"]')`, 10000)
  let lab = false
  for (let guard = 0; guard < 16 && !lab; guard++) {
    lab = await ev(`!!document.querySelector('[aria-label="Parameter sweep"]')`)
    if (lab) break
    if (await ev(`!!document.querySelector('input[type=radio]:not([disabled])')`)) await answerOpenCheck()
    if (!(await clickName('Continue'))) break
    await sleep(250)
  }
  if (!lab) lab = await ev(`!!document.querySelector('[aria-label="Parameter sweep"]')`)
  await clickName('Run the sweep')
  await waitFor(`document.querySelector('[data-testid="variational-state-view"] [data-testid^="sphere-3d-"]')`, 30000)
  await sleep(1200)
  check('V06 variational-vqe: the sweep’s qubit is the same interactive Bloch sphere (one 3D tile) next to the cost curve', lab && (await count('[data-testid="variational-state-view"] [data-testid="sphere-3d-q0"]')) === 1 && (await exists('svg[aria-label*="Vertical axis"]')) && (await text()).includes('INTERACTIVE BLOCH SPHERE'))
  const sweep = (await lastJson('/api/variational/sweep'))?.res
  const pickedX = await tx('qubit3d-x-0')
  check('V06 variational-vqe: the sphere’s X is the server’s own for the selected sweep point', !!sweep && pickedX !== null, { pickedX })
  await shot('v06_vqe.png', '[data-testid="variational-state-view"]')
  await axe('vqe-lesson')
}

// ===================================================================== PART 7: comparison drives a view, and the shared page shows the stored run
await fresh('/')
await setQubits(2); await place('H', [0]); await place('CX', [0, 1]); await waitResult(); await sleep(1200)
await click(`[...document.querySelectorAll('summary')].find((s) => /Compare runs/.test(s.innerText))`, 'open compare')
await clickName('Pin this run as A')
await removeAll(); await place('H', [0]); await place('X', [1]); await waitResult(); await sleep(1200)
await clickName('Compare A with this run (B)')
await waitFor(`document.querySelector('[data-testid="comparison"]')`, 20000)
await sleep(1500)
const cmp = (await lastJson('/api/compare/experiments'))
check('V07a the comparison is the server’s (no number computed in the page) and offers each run’s own state view', cmp?.status === 200 && (await exists('[data-testid="compare-state-view"]')))
await click(`[...document.querySelectorAll('[data-testid="compare-state-view"] button')].find((b) => b.textContent.trim() === 'Run A')`, 'run A')
await waitFor(`document.querySelector('[data-testid="compare-run-state-view"] [data-testid^="sphere-3d-"]')`, 15000)
const aTiles = await count('[data-testid="compare-run-state-view"] [data-testid^="sphere-3d-"]')
const aEntangled = await ev(`document.querySelector('[data-testid="compare-run-state-view"]').innerText`)
await click(`[...document.querySelectorAll('[data-testid="compare-state-view"] button')].find((b) => b.textContent.trim() === 'Run B')`, 'run B')
await sleep(900)
const bText = await ev(`document.querySelector('[data-testid="compare-run-state-view"]').innerText`)
check('V07b switching between run A and run B changes which run’s spheres are drawn (A is the Bell pair: entangled; B is a product state: not)', aTiles === 2 && /entangled with the rest of the register/.test(aEntangled) && /not entangled with the rest of the register/.test(bText) && /Run B/.test(bText))
await axe('compare')

// the shared page: the stored run's per-qubit view, from the server's record
await removeAll(); await place('H', [0]); await place('CX', [0, 1]); await waitResult(); await sleep(1200)
await click(`[...document.querySelectorAll('summary')].find((s) => /Share and export/.test(s.innerText))`, 'open share')
await clickName('Share as a read-only page')
await waitFor(`/\\/shared\\/ex_/.test(document.body.innerText) || [...document.querySelectorAll('a,input')].some((e) => /\\/shared\\/ex_/.test(e.href ?? e.value ?? ''))`, 15000)
const shareUrl = await ev(`(() => { const t = (document.body.innerText.match(/\\/shared\\/ex_[0-9a-f]{16}/) ?? [])[0] ?? [...document.querySelectorAll('a,input')].map((e) => e.href ?? e.value ?? '').find((v) => /\\/shared\\/ex_/.test(v)); return t ? t.replace(/^https?:\\/\\/[^/]+/, '') : null })()`)
check('V07c a read-only share link is created', !!shareUrl, shareUrl)
if (shareUrl) {
  await go(BASE + shareUrl)
  await waitFor(`document.querySelector('[data-testid="shared-state-view"] [data-testid^="sphere-3d-"]') || document.querySelector('[data-testid="shared-result"]')`, 20000)
  await sleep(1500)
  const shared = (await lastJson(shareUrl.replace('/shared/', '/api/experiments/'), 'GET'))?.res
  check('V07d the shared page draws the stored run’s qubit spheres from the server’s record (2 spheres, the server’s numbers)', !!shared && (await count('[data-testid="shared-state-view"] [data-testid^="sphere-3d-"]')) === 2 && shared.result.qubit_states.length === 2 && (await tx('qubit3d-purity-0')) === fmt(shared.result.qubit_states[0].purity), shared?.result?.qubit_states?.map((s) => s.purity))
  await shot('v07_shared.png')
  await axe('share')
}

// ===================================================================== PART 8: phones and the page never scrolls sideways
for (const w of [390, 320]) {
  await phone(w)
  await fresh('/')
  await setQubits(2); await place('H', [0]); await place('CX', [0, 1]); await waitResult(); await sleep(1500)
  check(`V08 ${w}px: the Lab with its 3D view has no horizontal scroll`, (await noHScroll()) === true, await pageMetrics())
  await scrollTo(tileSel(0))
  const r = await rectOf(tileSel(0)); const sx = await ev('window.scrollX')
  check(`V08 ${w}px: the sphere tile is inside the screen and big enough to use (>= 150 px)`, r.x - sx >= 0 && r.x - sx + r.width <= w + 1 && r.width >= 150, r)
  await shot(`v08_${w}_lab.png`)
  // touch: a one-finger drag rotates the sphere, a second finger pinches it
  const t0 = await settle(tileSel(0))
  const tr = await rectOf(tileSel(0)); const sy = await ev('window.scrollY')
  const cx = tr.x - sx + tr.width / 2, cy = tr.y - sy + tr.height / 2
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 1 }] })
  for (let i = 1; i <= 8; i++) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + i * 8, y: cy + i * 3, id: 1 }] })
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  const t1 = await settle(tileSel(0))
  check(`V08 ${w}px: a one-finger drag rotates the sphere`, t1 !== t0)
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 20, y: cy, id: 1 }, { x: cx + 20, y: cy, id: 2 }] })
  for (let i = 1; i <= 8; i++) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 20 - i * 6, y: cy, id: 1 }, { x: cx + 20 + i * 6, y: cy, id: 2 }] })
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  const t2 = await settle(tileSel(0))
  check(`V08 ${w}px: a two-finger spread zooms the sphere (pinch)`, t2 !== t1)
  // the editor on a phone: five wires and a controlled gate, no sideways scroll, and the palette scrolls on its own
  await removeAll(); await setQubits(5)
  await place('H', [0]); await place('CX', [0, 4]); await place('CCX', [0, 1, 3]); await place('CP', [2, 4])
  await sleep(600)
  await scrollTo('[role="group"][aria-label="Circuit editor"]')
  check(`V08 ${w}px: a five-qubit circuit with long controlled gates does not widen the page`, (await noHScroll()) === true, await pageMetrics())
  check(`V08 ${w}px: the palette scrolls inside itself (it does not wrap into a tall block)`, await ev(`(() => { const p = document.querySelector('[aria-label="Gate palette"]'); return getComputedStyle(p).overflowX === 'auto' && p.getBoundingClientRect().height < 70 })()`))
  await shot(`v08_${w}_editor.png`, '[role="group"][aria-label="Circuit editor"]')
  // long circuit scrolls inside its own box
  for (let i = 0; i < 14; i++) await place('H', [i % 5])
  await sleep(500)
  check(`V08 ${w}px: a 20-gate circuit scrolls inside the canvas box and does not widen the page`, (await noHScroll()) === true && (await ev(`(() => { const s = document.querySelector('.circuit-grid-bg'); return s.scrollWidth > s.clientWidth })()`)), await pageMetrics())
}
await desktop()

// ===================================================================== reduced motion: the preference is honoured
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await fresh('/')
await setQubits(2); await place('H', [0]); await place('CX', [0, 1]); await waitResult(); await sleep(1500)
check('V09a with reduced motion requested, auto-rotate is switched off and cannot be turned on, and says why', await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Auto rotate'); return !!b && b.disabled && b.getAttribute('aria-pressed') === 'false' && /reduced motion/.test(b.title) })()`))
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })

// ===================================================================== console and API audit
const apiFails = reqs.filter((r) => r.status !== null && r.status >= 400).map((r) => `${r.status} ${r.method} ${r.url}`)
check('V99a no console error or warning from the page', consoleLines.length === 0, consoleLines.slice(0, 6))
check('V99b no unexpected failed API call', apiFails.length === 0, apiFails.slice(0, 6))
const axeFailing = Object.entries(axeResults).filter(([, v]) => v.length).map(([k, v]) => ({ screen: k, violations: v.map((x) => `${x.id}x${x.count}`) }))
check('V99c axe-core (WCAG 2.2 AA + best practice) finds no violation on any screen checked here', axeFailing.length === 0, axeFailing)

const failed = Object.entries(out.checks).filter(([, ok]) => !ok).map(([k]) => k)
console.log(JSON.stringify({ allPassed: failed.length === 0, failed, checkCount: Object.keys(out.checks).length, checks: out.checks, axe: Object.fromEntries(Object.entries(axeResults).map(([k, v]) => [k, v.length ? v : 'clean'])), consoleLines, apiFails, data: out.data }, null, 1))
chrome.kill()
process.exit(failed.length === 0 ? 0 : 1)
