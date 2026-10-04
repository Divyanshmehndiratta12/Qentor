// The Noise Lab journey, driven in a REAL Chrome over the DevTools protocol against the PRODUCTION build served by the production process (one uvicorn serving
// web/dist and /api). DOM-only: real clicks, typing, key presses, reloads and network conditions, and every expected number is read from the JSON the page itself
// received from the server. It needs no hardware, no LLM key and changes no repo file. See docs/NOISE_LAB.md.
//
//   node scripts/noise_journey.mjs <outdir> <baseUrl>          e.g. node scripts/noise_journey.mjs /tmp/noise http://127.0.0.1:8011
//   CHROME_PATH=/path/to/chrome   overrides the Chrome binary (default: the usual install path for this OS)
//   Prints one JSON document on stdout (allPassed, failed, checks, axe results, console and API failures); screenshots go to <outdir>.
//   Needs Node 22+ and `npm ci` done in web/ (it reads web/node_modules/axe-core). Start the server on a throwaway database first:
//   QENTOR_DB_PATH=/tmp/noise.db backend/.venv/bin/python -m uvicorn qentor.api.app:app --app-dir backend --port 8011
//
// It covers: the entry and the address bar; an ideal-only run; an ideal-versus-noisy run (provenance of every number, the server's sentences, the request that
// was sent); a stronger noise and a seed; readout error and the other models; the loading state (a throttled network); the server's refusals (too many qubits,
// no measurement), an unreachable server and values the form refuses; the Lab's canvas shared with the Noise Lab; keyboard order; 900, 390 and 320 px; axe;
// the lesson's "Open in Noise Lab" and the challenge judged on the server's own noisy simulation.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const OUT = process.argv[2]
const BASE = process.argv[3] ?? 'http://localhost:8011'
const PORT = 9673
const CHROME = process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.error(`[noise ${new Date().toISOString().slice(11, 19)}] ${m}`)

fs.mkdirSync(OUT, { recursive: true })
fs.rmSync(path.join(OUT, 'chrome-profile-noise'), { recursive: true, force: true })
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(OUT, 'chrome-profile-noise')}`,
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

// ===================================================================== helpers specific to the Noise Lab
const NAV = (name) => click(`[...document.querySelectorAll('nav[aria-label="Primary"] button')].find((b) => b.textContent.trim() === ${T(name)})`, 'nav ' + name)
const noiseCalls = () => reqs.filter((r) => r.url.endsWith('/api/noise/compare') && r.method === 'POST')
const nCalls = () => noiseCalls().length
const noiseDone = () => noiseCalls().filter((r) => r.status !== null).length
const labelled = (text) => `(() => { const l = [...document.querySelectorAll('label')].find((x) => x.textContent.trim() === ${T(text)}); return l ? document.getElementById(l.htmlFor) : null })()`
const byAria = (name) => `document.querySelector('[aria-label=${T(name)}]')`
const setSelect = async (label, value) => { await ev(`(() => { const el = ${labelled(label)}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${T(value)}); el.dispatchEvent(new Event('change', { bubbles: true })) })()`); await sleep(150) }
const typeInto = async (target, value) => { await ev(`(() => { const el = ${target}; el.focus(); el.select() })()`); await send('Input.insertText', { text: String(value) }); await sleep(150) }
const runLabel = () => ev(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).find((t) => /^Run ideal/.test(t)) ?? null`)
const clickRun = async () => click(`[...document.querySelectorAll('button')].find((b) => /^Run ideal/.test(b.textContent.trim()) && !b.disabled)`, 'Run')
// Press Run and wait until the server answered AND the page shows a result or an error.
const runAndWait = async (ms = 30000) => {
  const before = noiseDone()
  await clickRun()
  const t0 = Date.now()
  while (Date.now() - t0 < ms && noiseDone() <= before) await sleep(100)
  await waitFor(`document.querySelector('[data-testid="noise-result"]') || document.querySelector('[role="alert"]')`, ms)
  await sleep(300)
}
const lastNoise = async () => { const j = await lastJson('/api/noise/compare'); return j }
const fmt4 = (v) => v.toFixed(4)
const signed = (v) => { const s = v.toFixed(4); return s.startsWith('-') ? '−' + s.slice(1) : '+' + s }
const domTable = () => ev(`[...document.querySelectorAll('[data-testid="noise-table"] tbody tr')].map((tr) => ({ outcome: tr.querySelector('th').textContent.trim(), cells: [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()), titles: [...tr.querySelectorAll('td')].map((td) => td.querySelector('[title]')?.getAttribute('title') ?? '') }))`)
const sortedKeys = (o) => Object.keys(o).sort()
const resultText = () => ev(`document.querySelector('[data-testid="noise-result"]')?.innerText ?? ''`)
const chooseExample = (title) => click(`[...document.querySelectorAll('[aria-label="Example circuits"] button')].find((b) => b.textContent.trim() === ${T(title)})`, 'example ' + title)
const opCount = () => ev(`new Set([...document.querySelectorAll('[role="group"][aria-label="Circuit editor"] button[data-op-index]')].map((b) => b.getAttribute('data-op-index'))).size`)
const opGates = () => ev(`(() => { const seen = new Map(); for (const b of document.querySelectorAll('[role="group"][aria-label="Circuit editor"] button[data-op-index]')) { const i = b.getAttribute('data-op-index'); if (!seen.has(i)) seen.set(i, (b.getAttribute('aria-label') ?? '').split(/[ (,]/)[0].toLowerCase()) } return [...seen.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]) })()`)
const allowedFailures = []

// ===================================================================== N00 the server's catalog
await desktop()
await go(BASE + '/')
await ev('localStorage.clear()')
const modelsRes = await getJson('/api/noise/models')
const MODELS = modelsRes.json
check('N00a the server serves six named noise models, an Aer-only scope, limits and a "not a real device" label', modelsRes.status === 200 && MODELS.models.map((m) => m.name).join() === 'none,depolarizing,bit_flip,phase_flip,amplitude_damping,readout_error' && MODELS.backend === 'qiskit-aer' && MODELS.limits.max_qubits === 8 && MODELS.limits.max_shots === 20000 && /Not a real device/.test(MODELS.label), MODELS.limits)
const lessonsRes = await getJson('/api/lessons')
const challengesRes = await getJson('/api/challenges')
check('N00b the catalog has the noise lesson (last) and the noise challenge (last), and no answer key or noise configuration leaks', lessonsRes.json.lessons.at(-1).id === 'quantum-noise' && challengesRes.json.challenges.at(-1).id === 'noise-shorten-circuit' && !JSON.stringify(lessonsRes.json).includes('correct_option_id') && !/min_share|noise_strength|noisy_outcome_share|reference_solution/.test(JSON.stringify(challengesRes.json)))
const NOISE_LESSON = lessonsRes.json.lessons.find((l) => l.id === 'quantum-noise')

// ===================================================================== PART 1: the entry
await fresh('/')
check('N01a the top bar has a "Noise Lab" item that is enabled and says nothing about being locked', await ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Primary"] button')].find((x) => x.textContent.trim() === 'Noise Lab'); return !!b && !b.disabled && !/lock/i.test(b.textContent + (b.getAttribute('aria-label') ?? '') + (b.title ?? '')) })()`))
await NAV('Noise Lab')
await waitFor(`document.querySelector('h1')?.textContent.trim() === 'Noise Lab'`, 10000)
await waitFor(`!!${labelled('Noise model')}`, 15000)
check('N01b clicking it opens /noise with one level-one heading, "Explore how noise affects quantum circuits." and the scope line (simulated, Aer only, not real hardware)', (await ev('location.pathname')) === '/noise' && (await count('h1')) === 1 && /Explore how noise affects quantum circuits\./.test(await text()) && /Simulated noise/.test(await tx('noise-scope')) && /Qiskit Aer simulation only/.test(await tx('noise-scope')) && /Not real hardware/.test(await tx('noise-scope')))
check('N01c the screen shows the Lab’s own circuit editor and palette, four example circuits and a "What should I expect?" section with the server’s notes for the chosen model', (await exists('[role="group"][aria-label="Circuit editor"]')) && (await exists('[aria-label="Gate palette"]')) && (await count('[aria-label="Example circuits"] button')) === 4 && (await exists('[data-testid="noise-expect"]')) && (await ev(`document.querySelector('[data-testid="expect-model"]').innerText`)).includes(MODELS.models[1].expect[0]))
check('N01d nothing runs and nothing is shown before Run: no result, no request to /api/noise/compare', !(await exists('[data-testid="noise-result"]')) && nCalls() === 0, nCalls())
await axe('noise-lab-empty')
await shot('n01_noise_lab_empty.png')
await go(BASE + '/noise')
await waitFor(`!!${labelled('Noise model')}`, 15000)
check('N01e a direct visit to /noise opens the Noise Lab, and Back returns to the previous screen', (await ev(`document.querySelector('h1')?.textContent.trim()`)) === 'Noise Lab')
await NAV('Learn'); await sleep(500)
await send('Runtime.evaluate', { expression: 'history.back()' }); await sleep(700)
check('N01f the address bar and the screen stay in step with Back', (await ev('location.pathname')) === '/noise' && (await ev(`document.querySelector('h1')?.textContent.trim()`)) === 'Noise Lab')

// ===================================================================== PART 2: ideal only
await chooseExample('Bell pair'); await sleep(300)
check('N02a loading an example puts that circuit on the Lab’s canvas (Bell pair: H, CX, M, M) and runs nothing', JSON.stringify(await opGates()) === JSON.stringify(['h', 'cx', 'measure', 'measure']) && nCalls() === 0, await opGates())
await setSelect('Noise model', 'none')
check('N02b with "None" the strength control is gone and the button says it runs the ideal simulation only', !(await ev(`!!${byAria('Noise strength, slider')}`)) && (await runLabel()) === 'Run ideal simulation')
await runAndWait()
const idealOnly = await lastNoise()
const idealReq = noiseCalls().at(-1)
check('N02c the ideal-only run sent the circuit, "none" and the shots, and no strength, no seed and no result field', idealReq && JSON.stringify(Object.keys(JSON.parse(idealReq.body)).sort()) === '["circuit","noise_model","shots"]' && JSON.parse(idealReq.body).noise_model === 'none', idealReq?.body?.slice(0, 160))
const idealRows = await domTable()
check('N02d the table lists exactly the outcomes the server returned (Bell pair: 00 and 11 only) with the server’s counts and frequencies, and the counts add up to the shots', idealOnly.status === 200 && JSON.stringify(idealRows.map((r) => r.outcome)) === JSON.stringify(sortedKeys(idealOnly.res.ideal.counts)) && idealRows.every((r) => r.cells[0] === String(idealOnly.res.ideal.counts[r.outcome]) && r.cells[1] === fmt4(idealOnly.res.ideal.probabilities[r.outcome])) && Object.values(idealOnly.res.ideal.counts).reduce((a, b) => a + b, 0) === 1024 && sortedKeys(idealOnly.res.ideal.counts).join() === '00,11', idealRows)
check('N02e only the ideal run is shown, labelled "Simulated", with no noisy card, metrics or explanation, and it says a noisy run needs a noise model', (await exists('[data-testid="run-ideal"]')) && !(await exists('[data-testid="run-noisy"]')) && !(await exists('[data-testid="noise-metrics"]')) && (await exists('[data-testid="ideal-only-note"]')) && /^Simulated/.test(await ev(`document.querySelector('[data-testid="run-ideal"] span.inline-flex')?.innerText ?? ''`)))
check('N02f the ideal run’s identity is the server’s: backend, mode "shots", noise "none (ideal)", shots, seed and result id', (await tx('ideal-backend')) === `${idealOnly.res.ideal.provenance.backend} ${idealOnly.res.ideal.provenance.backend_version}` && (await tx('ideal-mode')) === 'shots' && (await tx('ideal-noise')) === 'none (ideal)' && (await tx('ideal-shots')) === '1024' && (await tx('ideal-seed')) === String(idealOnly.res.noise.seed) && (await ev(`document.querySelector('[data-testid="ideal-result-id"]').title`)) === idealOnly.res.ideal.provenance.result_id)
await shot('n02_ideal_only.png')

// ===================================================================== PART 3: depolarizing noise, ideal vs noisy
await setSelect('Noise model', 'depolarizing')
check('N03a choosing depolarizing resets the strength to the server’s default and range', (await ev(`${byAria('Noise strength, slider')}.value`)) === '0.05' && (await ev(`${byAria('Noise strength, slider')}.max`)) === '0.3' && (await runLabel()) === 'Run ideal vs noisy')
await typeInto(labelled('Seed (optional)'), '4242')
await runAndWait()
const dep = await lastNoise()
const depReq = JSON.parse(noiseCalls().at(-1).body)
check('N03b the request carried the circuit and the learner’s four choices and nothing else', JSON.stringify(Object.keys(depReq).sort()) === '["circuit","noise_model","noise_strength","seed","shots"]' && depReq.noise_model === 'depolarizing' && depReq.noise_strength === 0.05 && depReq.seed === 4242 && depReq.shots === 1024, depReq)
const depRows = await domTable()
const expectedRows = dep.res.comparison.rows.map((r) => ({ outcome: r.outcome, cells: [String(r.ideal_count), fmt4(r.ideal_probability), String(r.noisy_count), fmt4(r.noisy_probability), signed(r.delta)] }))
check('N03c every number in the table is the server’s, cell by cell: counts, frequencies and the change', depRows.length === expectedRows.length && depRows.every((r, i) => r.outcome === expectedRows[i].outcome && JSON.stringify(r.cells) === JSON.stringify(expectedRows[i].cells)), depRows.slice(0, 2))
const prov = (id, backend = 'qiskit-aer', cls = 'SIMULATION') => `${cls} · ${backend} · ${id}`
check('N03d each number carries the provenance of ITS run: ideal cells the ideal run’s id, noisy cells the noisy run’s id, the change the comparison’s', depRows.every((r) => r.titles[0] === prov(dep.res.ideal.provenance.result_id) && r.titles[1] === prov(dep.res.ideal.provenance.result_id) && r.titles[2] === prov(dep.res.noisy.provenance.result_id) && r.titles[3] === prov(dep.res.noisy.provenance.result_id) && r.titles[4] === prov(dep.res.comparison.provenance.result_id, 'noise-comparison')) && new Set([dep.res.ideal.provenance.result_id, dep.res.noisy.provenance.result_id, dep.res.comparison.provenance.result_id]).size === 3)
check('N03e the ideal and noisy runs are different records: modes "shots" and "noisy_shots", the noisy badge reads "Simulated noise", and nothing says hardware', (await tx('ideal-mode')) === 'shots' && (await tx('noisy-mode')) === 'noisy_shots' && /Simulated noise/.test(await ev(`document.querySelector('[data-testid="run-noisy"] span.inline-flex').innerText`)) && !/Real hardware|Recorded hardware|REAL_HARDWARE|RECORDED_HARDWARE/.test(await text()) && !/\bIBM\b|\bQPU\b/.test(await text()) && /Not a real device/.test(await tx('noise-label')))
check('N03f the noisy run names its noise model, parameter, strength, simulator, shots and seed, equal to what the server stored', (await tx('noisy-noise')) === dep.res.noisy.noise.label && (await tx('noisy-strength')) === '0.05' && (await tx('noisy-shots')) === '1024' && (await tx('noisy-seed')) === '4242' && /density_matrix/.test(await ev(`document.querySelector('[data-testid="run-noisy"]').innerText`)) && dep.res.noisy.noise.seed === 4242)
check('N03g the noisy run really differs from the ideal one: it has outcomes the ideal run never produced (01 and 10 for a Bell pair), and the page lists them', dep.res.ideal.counts['01'] === undefined && (dep.res.noisy.counts['01'] ?? 0) + (dep.res.noisy.counts['10'] ?? 0) > 0 && (await tx('new-outcomes')).includes('01') )
check('N03h the metrics are the server’s: total variation distance, share on ideal outcomes and the noisy shots outside the ideal outcomes', (await tx('metric-tvd')) === fmt4(dep.res.comparison.metrics.total_variation_distance) && (await tx('metric-share')) === fmt4(dep.res.comparison.metrics.noisy_share_on_ideal_outcomes) && (await tx('metric-new-shots')) === String(dep.res.comparison.metrics.new_outcome_shots))
check('N03i the explanation lines are the server’s sentences, word for word, and the page says no model wrote them', JSON.stringify(await ev(`[...document.querySelectorAll('[data-testid="noise-explanation"] li')].map((l) => l.textContent)`)) === JSON.stringify(dep.res.comparison.explanation.map((l) => l.text)) && /No language model was involved/.test(await tx('noise-explanation')))
check('N03j the chart is one image with a text alternative that points at the table', await ev(`(() => { const c = document.querySelector('[data-testid="noise-chart"]'); return c.getAttribute('role') === 'img' && /Grouped bar chart/.test(c.getAttribute('aria-label')) && /table that follows/.test(c.getAttribute('aria-label')) && !!c.querySelector('svg') })()`))
await axe('noise-lab-result')
check('N03k the grouped bars are really drawn: the chart has one ideal and one noisy bar series with a bar per outcome, and a visible plot area', await ev(`(() => { const c = document.querySelector('[data-testid="noise-chart"]'); c.scrollIntoView({ block: 'center' }); const bars = c.querySelectorAll('.barlayer .trace'); const r = c.getBoundingClientRect(); return bars.length === 2 && [...bars].every((t) => t.querySelectorAll('.point').length >= 2) && r.height > 150 })()`))
await sleep(600)
await shot('n03_ideal_vs_noisy_chart.png')
await ev(`document.querySelector('[data-testid="noise-metrics"]').scrollIntoView({ block: 'center' })`)
await sleep(400)
await shot('n03_ideal_vs_noisy_metrics.png')
const tvd1 = dep.res.comparison.metrics.total_variation_distance

// ===================================================================== PART 4: change the strength and run again; seeds
await typeInto(byAria('Noise strength, value'), '0.2')
check('N04a changing a setting keeps the result and says the settings have moved on', (await exists('[data-testid="noise-settings-moved"]')) && (await exists('[data-testid="noise-result"]')) && (await ev(`${byAria('Noise strength, slider')}.value`)) === '0.2')
await runAndWait()
const dep2 = await lastNoise()
check('N04b the new run was asked for the new strength and the page shows the server’s new result (strength 0.2, new result ids, no "settings moved" note)', JSON.parse(noiseCalls().at(-1).body).noise_strength === 0.2 && (await tx('noisy-strength')) === '0.2' && dep2.res.noisy.provenance.result_id !== dep.res.noisy.provenance.result_id && !(await exists('[data-testid="noise-settings-moved"]')))
check('N04c a stronger depolarizing noise moves the noisy distribution further from the ideal one (the server’s distance rose), and the page shows that number', dep2.res.comparison.metrics.total_variation_distance > tvd1 && (await tx('metric-tvd')) === fmt4(dep2.res.comparison.metrics.total_variation_distance), [tvd1, dep2.res.comparison.metrics.total_variation_distance])
await runAndWait()
const dep3 = await lastNoise()
check('N04d the same seed reproduces both runs exactly (same counts), as new records with new ids', JSON.stringify(dep3.res.noisy.counts) === JSON.stringify(dep2.res.noisy.counts) && JSON.stringify(dep3.res.ideal.counts) === JSON.stringify(dep2.res.ideal.counts) && dep3.res.noisy.provenance.result_id !== dep2.res.noisy.provenance.result_id)
await typeInto(labelled('Seed (optional)'), '99')
await runAndWait()
const dep4 = await lastNoise()
check('N04e a different seed gives a different sample', JSON.stringify(dep4.res.noisy.counts) !== JSON.stringify(dep3.res.noisy.counts) && dep4.res.noise.seed === 99)
await ev(`${byAria('Noise strength, slider')}.focus()`)
const before = await ev(`${byAria('Noise strength, slider')}.value`)
await key('ArrowRight', 'ArrowRight', 39); await key('ArrowRight', 'ArrowRight', 39)
const afterKeys = await ev(`${byAria('Noise strength, slider')}.value`)
check('N04f the strength slider works from the keyboard: two ArrowRight presses move it two steps, and its value is exposed as text', Math.abs(Number(afterKeys) - Number(before) - 0.01) < 1e-9 && (await ev(`${byAria('Noise strength, slider')}.getAttribute('aria-valuetext')`)) === afterKeys, [before, afterKeys])
await setSelect('Noise model', 'depolarizing')
await typeInto(byAria('Noise strength, value'), '0.05')

// ===================================================================== PART 5: readout error and the other models
await chooseExample('No gates, just measure'); await sleep(300)
await setSelect('Noise model', 'readout_error')
await typeInto(byAria('Noise strength, value'), '0.2')
check('N05a readout error is drawn as acting at measurement', (await ev(`document.querySelector('[data-testid="noise-where"]').dataset.appliesTo`)) === 'measurement' && /noise acts on what is read out: noise here/.test(await tx('noise-where')))
await runAndWait()
const ro = await lastNoise()
check('N05b on a circuit with no gates the ideal run only ever reads 00 while the readout-error run also reads 01, 10 and 11 (the server’s counts, shown as sent)', sortedKeys(ro.res.ideal.counts).join() === '00' && ['01', '10', '11'].every((o) => (ro.res.noisy.counts[o] ?? 0) > 0) && ro.res.noisy.noise.applies_to === 'measurement' && (await domTable()).map((r) => r.outcome).join() === sortedKeys(ro.res.noisy.counts).join())
await setSelect('Noise model', 'depolarizing')
await typeInto(byAria('Noise strength, value'), '0.2')
await runAndWait()
const gateOnNothing = await lastNoise()
check('N05c gate noise cannot touch a circuit with no gates: the depolarizing run reads 00 only, exactly like the ideal one', sortedKeys(gateOnNothing.res.noisy.counts).join() === '00' && gateOnNothing.res.comparison.metrics.total_variation_distance === 0, gateOnNothing.res.noisy.counts)
await chooseExample('Bell pair'); await sleep(300)
await setSelect('Noise model', 'phase_flip')
await typeInto(byAria('Noise strength, value'), '0.4')
await runAndWait()
const pf = await lastNoise()
check('N05d a phase flip leaves a Bell pair’s counts on 00 and 11 (some noise cannot be seen by a 0/1 measurement), and the page still shows a noisy run honestly', sortedKeys(pf.res.noisy.counts).join() === '00,11' && pf.res.noisy.noise.model === 'phase_flip')
await setSelect('Noise model', 'amplitude_damping')
await runAndWait()
await setSelect('Noise model', 'bit_flip')
await runAndWait()
check('N05e amplitude damping and bit flip also run, each as a labelled, stored noisy run', JSON.stringify(noiseCalls().slice(-2).map((r) => JSON.parse(r.body).noise_model)) === '["amplitude_damping","bit_flip"]' && noiseCalls().slice(-2).every((r) => r.status === 200))
await setSelect('Noise model', 'depolarizing')

// ===================================================================== PART 6: loading and error states
await typeInto(byAria('Noise strength, value'), '0.1')
await send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 })
const sampleBefore = noiseDone()
await clickRun()
await sleep(500)
const loading = await ev(`(() => { const s = [...document.querySelectorAll('[role="status"]')].map((x) => x.textContent.trim()); const b = [...document.querySelectorAll('button')].find((x) => /^Running/.test(x.textContent.trim())); return { statuses: s, button: b ? { text: b.textContent.trim(), disabled: b.disabled, busy: b.getAttribute('aria-busy') } : null, hasResult: !!document.querySelector('[data-testid="noise-result"]') } })()`)
check('N06a while the server works the page shows a live "Running…" status, disables and marks busy the Run button, and shows no result', loading.statuses.some((s) => /Running the ideal and noisy simulations on the backend/.test(s)) && loading.button?.disabled === true && loading.button?.busy === 'true' && loading.hasResult === false, loading)
await shot('n06_running.png')
await waitFor(`document.querySelector('[data-testid="noise-result"]')`, 30000)
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
check('N06b when the answer arrives the result replaces the status', (await exists('[data-testid="noise-result"]')) && noiseDone() === sampleBefore + 1)

// the largest register the editor can build (8 qubits) is exactly the noisy limit: it runs
await setQubits(8)
await place('H', [0])
for (let q = 0; q < 7; q++) await place('CX', [q, q + 1])
for (let q = 0; q < 8; q++) await place('M', [q])
await sleep(400)
check('N06c an 8-qubit circuit (the editor’s largest, and the noisy limit) shows no limit warning', !(await exists('[data-testid="noise-circuit-hint"]')) && (await qubitCount()) === 8)
await runAndWait()
const eight = await lastNoise()
check('N06d the 8-qubit noisy run succeeds on the server (density matrix): 8-bit outcomes, a noisy record, and the result is on screen', eight.status === 200 && Object.keys(eight.res.noisy.counts).every((k) => k.length === 8) && eight.res.noisy.noise.simulation_method === 'density_matrix' && (await exists('[data-testid="noise-result"]')), Object.keys(eight.res.noisy.counts).slice(0, 3))

// a circuit with no measurement
await setQubits(2)
await removeAll()
await place('H', [0])
await sleep(300)
check('N06f the page warns that a circuit with no measurement will be refused', /no measurement/.test(await tx('noise-circuit-hint')))
await runAndWait()
const noMeasure = await lastNoise()
allowedFailures.push('NOISE_NEEDS_MEASUREMENT')
check('N06g the server’s refusal for a circuit with no measurement is shown in its own words with its code (NOISE_NEEDS_MEASUREMENT), no result is shown, and the page says nothing was substituted', noMeasure.status === 422 && noMeasure.res.detail.code === 'NOISE_NEEDS_MEASUREMENT' && (await ev(`(() => { const a = [...document.querySelectorAll('[role="alert"]')].map((x) => x.innerText).join(' | '); return a.includes('needs at least one measurement') && a.includes('(NOISE_NEEDS_MEASUREMENT)') && a.includes('Nothing was substituted') })()`)) && !(await exists('[data-testid="noise-result"]')), noMeasure.res?.detail)
const callsBefore = nCalls()
await click(`[...document.querySelectorAll('[role="alert"] button')].find((b) => b.textContent.trim() === 'Try again')`, 'Try again'); await sleep(1500)
allowedFailures.push('NOISE_NEEDS_MEASUREMENT')
check('N06g2 "Try again" asks the server again', nCalls() === callsBefore + 1)
await axe('noise-lab-error')
await shot('n06_error.png')

// the server unreachable (the request is blocked in the browser): an error, never a substituted result
await chooseExample('Bell pair'); await sleep(300)
await send('Network.setBlockedURLs', { urls: ['*/api/noise/compare'] })
await clickRun(); await sleep(1500)
await send('Network.setBlockedURLs', { urls: [] })
check('N06h when the server cannot be reached the page shows an error and no result', /could not reach the Qentor backend/.test(await ev(`[...document.querySelectorAll('[role="alert"]')].map((x) => x.innerText).join(' ')`)) && !(await exists('[data-testid="noise-result"]')))

// values the server would refuse are caught in the form
await typeInto(byAria('Noise strength, value'), '0.9')
check('N06i a strength outside the model’s range is flagged beside the field and Run is disabled (nothing is sent)', (await ev(`${byAria('Noise strength, value')}.getAttribute('aria-invalid')`)) === 'true' && (await ev(`[...document.querySelectorAll('[role="alert"]')].some((a) => /Use a value from 0 to 0.3/.test(a.textContent))`)) && (await ev(`[...document.querySelectorAll('button')].find((b) => /^Run ideal/.test(b.textContent.trim())).disabled`)))
await typeInto(byAria('Noise strength, value'), '0.1')

// ===================================================================== PART 7: the circuit editor is the Lab's
await removeAll()
await place('X', [0]); await place('CX', [0, 1]); await place('M', [0]); await place('M', [1])
await sleep(300)
await runAndWait()
const built = await lastNoise()
const builtReq = JSON.parse(noiseCalls().at(-1).body)
check('N07a a circuit built with the Lab’s canvas and palette on this screen is the circuit sent (X, CX, M, M)', JSON.stringify(builtReq.circuit.ops.map((o) => o.gate)) === '["x","cx","measure","measure"]' && built.status === 200 && Object.keys(built.res.ideal.counts).join() === '11', builtReq.circuit.ops.map((o) => o.gate))
await NAV('Lab'); await sleep(600)
check('N07b the Lab shows the same circuit: one circuit representation, edited from either screen', JSON.stringify(await opGates()) === JSON.stringify(['x', 'cx', 'measure', 'measure']), await opGates())
await NAV('Noise Lab'); await waitFor(`!!${labelled('Noise model')}`, 10000)
check('N07c after leaving and returning, the earlier result is still shown for this same circuit', await exists('[data-testid="noise-result"]'))
await place('H', [1]); await sleep(300)
check('N07d editing the circuit hides the result (it belongs to a different circuit) and says so', !(await exists('[data-testid="noise-result"]')) && /The circuit changed after this result was made/.test(await tx('noise-stale')))

// ===================================================================== PART 8: keyboard order and accessibility of the controls
await chooseExample('Bell pair'); await sleep(300)
await setSelect('Noise model', 'depolarizing')
await ev(`${labelled('Noise model')}.focus()`)
const order = []
for (let i = 0; i < 5; i++) { await key('Tab', 'Tab', 9); order.push(await ev(`(document.activeElement.getAttribute('aria-label') || (document.activeElement.labels?.[0]?.textContent) || document.activeElement.textContent).trim().slice(0, 26)`)) }
check('N08a Tab moves through the controls in reading order: strength slider, strength value, shots, seed, then Run', JSON.stringify(order) === JSON.stringify(['Noise strength, slider', 'Noise strength, value', 'Shots', 'Seed (optional)', 'Run ideal vs noisy']), order)
check('N08b every form control has a visible label and an accessible name (select, slider, number boxes, seed)', await ev(`['Noise model', 'Noise strength, slider', 'Noise strength, value', 'Shots', 'Seed (optional)'].every((n) => !![...document.querySelectorAll('select, input')].find((el) => (el.getAttribute('aria-label') === n) || (el.labels?.[0]?.textContent.trim() === n)))`))
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await sleep(1500)
check('N08c Enter on the focused Run button runs it', (await exists('[data-testid="noise-result"]')) || (await exists('[role="alert"]')))

// ===================================================================== PART 9: responsive
for (const w of [900, 390, 320]) {
  if (w === 900) await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false })
  else await phone(w)
  await go(BASE + '/noise'); await waitFor(`!!${labelled('Noise model')}`, 15000)
  await chooseExample('Bell pair'); await sleep(300)
  await runAndWait()
  const m = await ev(`({ iw: innerWidth, sw: document.documentElement.scrollWidth })`)
  check(`N09 ${w}px: the Noise Lab with a result is as wide as the screen (no horizontal page scroll; the layout viewport is ${w})`, m.sw <= m.iw && m.iw === w, m)
  check(`N09 ${w}px: the controls and Run button are inside the screen and reachable`, await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Run ideal/.test(x.textContent.trim())); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width >= 100 && r.height >= 30 })()`))
  check(`N09 ${w}px: the table and chart do not widen the page (the results scroll inside their own box if wide)`, await ev(`(() => { const t = document.querySelector('[data-testid="noise-table"]'); const c = document.querySelector('[data-testid="noise-chart"]'); return t.getBoundingClientRect().right <= innerWidth + 1 && c.getBoundingClientRect().right <= innerWidth + 1 })()`))
  check(`N09 ${w}px: the top bar, with the Noise Lab item, does not overflow`, await ev(`(() => { const nav = document.querySelector('nav[aria-label="Primary"]'); return nav.getBoundingClientRect().right <= innerWidth + 1 && [...nav.querySelectorAll('button')].every((b) => b.getBoundingClientRect().right <= innerWidth + 1 && b.getBoundingClientRect().left >= -1) })()`))
  await axe(`noise-lab-${w}`)
  await shot(`n09_${w}.png`)
}
await desktop()

// ===================================================================== PART 10: the lesson and the challenge
const answerOpenCheck = async () => { const r = await ev(`(() => { const radio = document.querySelector('input[type=radio]:not([disabled])'); if (!radio) return false; radio.click(); return true })()`); if (!r) return false; await sleep(150); await clickName('Submit'); await waitFor(`/Correct\\.|Not quite\\./.test(document.body.innerText)`, 10000); return true }
await fresh('/learn'); await waitFor(`document.querySelectorAll('ul button').length >= 19`, 15000)
await click(`[...document.querySelectorAll('ul button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith(${T(NOISE_LESSON.title)} + ' —') || (b.getAttribute('aria-label') ?? '') === ${T(NOISE_LESSON.title)})`, 'noise lesson card')
await waitFor(`document.querySelector('[aria-label*="lesson progress"]')`, 10000)
let atLab = false
for (let guard = 0; guard < 16; guard++) {
  const i = await ev(`(() => { const m = /Step (\\d+) of (\\d+)/.exec(document.body.innerText); return m ? parseInt(m[1], 10) - 1 : -1 })()`)
  if (i < 0) break
  if (NOISE_LESSON.sections[i].type === 'interactive_lab') { atLab = true; break }
  if (NOISE_LESSON.sections[i].type === 'concept_check' && NOISE_LESSON.sections[i].question) await answerOpenCheck()
  if (!(await clickName('Continue'))) break
  await sleep(250)
}
check('N10a the lesson (open with nothing completed) is walked through its two server-graded checks to its lab step', atLab)
check('N10b the lab step offers "Open in Noise Lab" and says the noise is simulated and nothing is computed in the browser', await ev(`(() => { const t = document.body.innerText; return !![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open in Noise Lab') && /the noise is simulated — nothing is computed here/.test(t) })()`))
await clickName('Open in Noise Lab')
await waitFor(`location.pathname === '/noise'`, 10000)
await waitFor(`!!${labelled('Noise model')}`, 10000)
check('N10c "Open in Noise Lab" opens the Noise Lab with the lesson’s circuit (H, CX, M, M) on the Lab’s canvas', JSON.stringify(await opGates()) === JSON.stringify(['h', 'cx', 'measure', 'measure']), await opGates())
await runAndWait()
const lessonRun = await lastNoise()
check('N10d running it gives the Bell pair’s ideal outcomes and a noisy comparison, from the server', lessonRun.status === 200 && sortedKeys(lessonRun.res.ideal.counts).join() === '00,11' && !!lessonRun.res.comparison)

await go(BASE + '/challenges/noise-shorten-circuit'); await sleep(1500)
await waitFor(`document.querySelector('[role="group"][aria-label="Circuit editor"]')`, 15000)
check('N10e the challenge opens with its starter on the canvas (six X gates and two measurements) and says the noise is simulated', (await opCount()) === 8 && /simulat/i.test(await text()), await opGates())
await clickName('Submit for checking')
await waitFor(`document.querySelector('[data-testid="verdict"]')`, 60000)
const sub1 = await lastJson('/api/challenges/noise-shorten-circuit/submit')
const states1 = await ev(`Object.fromEntries([...document.querySelectorAll('[data-testid^="check-"]')].map((e) => [e.dataset.testid.replace('check-', ''), e.dataset.state]))`)
const noisyOut = sub1.res.checks.find((c) => c.id === 'noisy.share')
check('N10f the starter is right in an ideal run and fails under the server’s noise: not passed, ideal check passes, noisy check fails with the simulator’s share as evidence', sub1.status === 200 && sub1.res.passed === false && sub1.res.checks.find((c) => c.id === 'ideal.outcome').passed === true && noisyOut.passed === false && noisyOut.evidence.some((e) => e.name === 'noisy_share_of_required_outcome' && e.value < 0.9), states1)
check('N10g the noisy check names a stored record whose mode is noisy_shots (provenance, "Simulated noise")', sub1.res.provenance[noisyOut.result_id]?.execution_mode === 'noisy_shots' && sub1.res.provenance[noisyOut.result_id]?.provenance_class === 'SIMULATION')
check('N10h the request carried only a circuit', JSON.stringify(Object.keys(sub1.req)) === '["circuit"]')
// delete four of the six X gates: indices 0,0,1,1 leaves X on q0, X on q1 and the two measurements
for (const index of [0, 0, 1, 1]) {
  await click(`document.querySelector('[role="group"][aria-label="Circuit editor"] button[data-op-index="${index}"]')`, 'pick gate ' + index)
  await clickName('Delete the selected gate'); await sleep(200)
}
check('N10i the learner shortened the circuit to X, X, M, M on the canvas', JSON.stringify(await opGates()) === '["x","x","measure","measure"]', await opGates())
await clickName('Submit for checking')
await waitFor(`document.querySelector('[data-testid="verdict"][data-current="true"]')`, 60000)
await sleep(500)
const sub2 = await lastJson('/api/challenges/noise-shorten-circuit/submit')
check('N10j the shortened circuit passes both checks, judged by the server’s noisy simulation (share of 11 at least nine in ten), and the page shows the verdict as passed', sub2.res.passed === true && sub2.res.checks.every((c) => c.passed) && sub2.res.checks.find((c) => c.id === 'noisy.share').evidence.find((e) => e.name === 'noisy_share_of_required_outcome').value >= 0.9 && (await ev(`document.querySelector('[data-testid="verdict"]').dataset.passed`)) === 'true')
await axe('noise-challenge')
await shot('n10_challenge_passed.png')

// ===================================================================== FINAL
const consoleUnexpected = consoleLines.filter((l) => !/ERR_BLOCKED_BY_CLIENT|status of 422|Failed to load resource: the server responded with a status of 422/.test(l))
const failedApi = reqs.filter((r) => r.status !== null && r.status >= 400)
const expectedFailures = failedApi.filter((r) => r.url.endsWith('/api/noise/compare') && r.status === 422)
check('N99a no console error or warning other than the deliberate refusals and the blocked request', consoleUnexpected.length === 0, consoleUnexpected.slice(0, 5))
check('N99b no failed API call other than the server’s deliberate refusals (the no-measurement refusal, asked twice)', failedApi.length === expectedFailures.length && expectedFailures.length === allowedFailures.length, failedApi.map((r) => `${r.method} ${r.url} ${r.status}`))
check('N99c axe-core (WCAG 2.2 AA + best practice) finds no violation on any Noise Lab screen checked here', Object.values(axeResults).every((v) => v.length === 0), Object.fromEntries(Object.entries(axeResults).filter(([, v]) => v.length)))
out.axe = Object.fromEntries(Object.entries(axeResults).map(([k, v]) => [k, v.length]))
out.console = consoleLines
out.failedApi = failedApi.map((r) => `${r.method} ${r.url} ${r.status}`)
out.failed = Object.entries(out.checks).filter(([, v]) => !v).map(([k]) => k)
out.allPassed = out.failed.length === 0
console.log(JSON.stringify(out, null, 1))
try { chrome.kill() } catch {}
process.exit(out.allPassed ? 0 : 1)
