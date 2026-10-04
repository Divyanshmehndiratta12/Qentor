// The canonical Qentor demo journey, driven in a REAL Chrome over the DevTools protocol against the PRODUCTION build served by the production
// process (one uvicorn serving web/dist and /api). It needs no hardware and no LLM key (it asserts that generation says "unavailable").
// DOM-only: real clicks / keys / reloads, and every expected value is read from the JSON the page itself received from the server.
// Changes no repo file. See docs/DEMO_JOURNEY.md for the steps and how to run it.
//
//   node scripts/demo_journey.mjs <outdir> <baseUrl>          e.g. node scripts/demo_journey.mjs /tmp/demo http://127.0.0.1:8011
//   CHROME_PATH=/path/to/chrome   overrides the Chrome binary (default: the usual install path for this OS)
//   Prints one JSON document on stdout (allPassed, failed, checks, axe results, console and API failures); screenshots go to <outdir>.
//   Needs Node 22+ and `npm ci` done in web/ (it reads web/node_modules/axe-core). Start the server on a throwaway database first:
//   QENTOR_DB_PATH=/tmp/demo.db backend/.venv/bin/python -m uvicorn qentor.api.app:app --app-dir backend --port 8011
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const OUT = process.argv[2]
const BASE = process.argv[3] ?? 'http://localhost:8011'
const PORT = 9671
const CHROME = process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.error(`[demo ${new Date().toISOString().slice(11, 19)}] ${m}`)

fs.rmSync(path.join(OUT, 'chrome-profile-demo'), { recursive: true, force: true })
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(OUT, 'chrome-profile-demo')}`,
  '--window-size=1440,900', '--no-first-run', '--no-default-browser-check', '--disk-cache-size=1',
  // WebGL through Chrome's software renderer, so the 3D Bloch spheres really run (set QENTOR_NO_WEBGL=1 to run the flat fallback instead).
  ...(process.env.QENTOR_NO_WEBGL ? ['--disable-gpu'] : ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']),
  'about:blank'], { stdio: 'ignore' })
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
const requests = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  const p = m.params
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(p.type)) consoleLines.push(`[${p.type}] ` + p.args.map((a) => a.value ?? a.description ?? '').join(' '))
  else if (m.method === 'Runtime.exceptionThrown') consoleLines.push('[EXCEPTION] ' + (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text))
  // (Chrome's software GL renderer reports "GPU stall due to ReadPixels" as a performance WARNING when a screenshot is taken: a driver note about
  // the capture, not the page, so it is the one message left out. Any other warning or error is counted.)
  else if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(p.entry.level) && !/GL Driver Message \(OpenGL, Performance/.test(p.entry.text)) consoleLines.push(`[log.${p.entry.level}] ${p.entry.text} ${p.entry.url ?? ''}`)
  else if (m.method === 'Network.requestWillBeSent') requests.push({ url: p.request.url, method: p.request.method })
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

const check = (name, ok, detail) => { out.checks[name] = out.checks[name] !== false && !!ok; if (detail !== undefined) out.data[name] = detail; log((ok ? 'ok   ' : 'FAIL ') + name + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 200) : '')) }
const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(s.result.data, 'base64')) }
const desktop = () => send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
const phone = () => send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
async function go(url) { await send('Page.navigate', { url }); await sleep(1800) }
async function reload() { await send('Page.reload', { ignoreCache: true }); await sleep(1800) }
async function waitFor(expr, ms = 15000, label = expr) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { if (await ev(`!!(${expr})`)) return true } catch {} await sleep(250) }
  log('timeout waiting for: ' + label.slice(0, 120))
  return false
}
const T = JSON.stringify
const byName = (name, root = 'document') => `[...${root}.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent).trim() === ${T(name)} && !b.disabled)`
const click = async (jsExpr, label) => { const ok = await ev(`(() => { const el = ${jsExpr}; if (!el) return false; el.click(); return true })()`); if (!ok) log('no element to click: ' + (label ?? jsExpr.slice(0, 100))); await sleep(120); return ok }
const clickName = (name) => click(byName(name), name)
const text = () => ev('document.body.innerText')
const nav = (label) => click(`[...document.querySelectorAll('nav[aria-label="Primary"] button')].find((b) => b.textContent.trim() === ${T(label)})`, 'nav ' + label)
const setSelect = (selector, value) => ev(`(() => { const el = document.querySelector(${T(selector)}); if (!el) return false; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, ${T(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
const key = async (k, code, vk) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: k === 'Enter' ? '\r' : undefined }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }) }
const pageMetrics = () => ev(`(() => { const de = document.documentElement; const offenders = []; for (const el of document.querySelectorAll('body *')) { const r = el.getBoundingClientRect(); if (r.width === 0 || r.right <= window.innerWidth + 1) continue; let p = el.parentElement, clipped = false; while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { clipped = true; break } p = p.parentElement } if (!clipped && getComputedStyle(el).position !== 'fixed') offenders.push(el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 40) + ' right=' + Math.round(r.right)) } return { scrollWidth: de.scrollWidth, innerWidth: window.innerWidth, offenders: offenders.slice(0, 6) } })()`)
const inViewport = (sel) => ev(`(() => { const el = ${sel}; if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), inside: r.left >= -1 && r.right <= window.innerWidth + 1 } })()`)

// ---- SPRINT 5 JOURNEY. Real Chrome, production build served by FastAPI. DOM-only clicks/typing/reloads; expectations from the server's own JSON.
const apiFailures = []
const apiCalls = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/') && m.params.response.status >= 400)
    apiFailures.push(`${m.params.response.status} ${m.params.response.url}`)
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api/'))
    apiCalls.push({ url: m.params.request.url, method: m.params.request.method, body: m.params.request.postData ?? null, headers: m.params.request.headers })
})
const AXE_SRC = fs.readFileSync(new URL('../web/node_modules/axe-core/axe.min.js', import.meta.url), 'utf8')
const AXE_RUN = `(async () => {
  if (!window.axe) { (0, eval)(${JSON.stringify(AXE_SRC)}) }
  const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] })
  return r.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, nodes: v.nodes.slice(0, 3).map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 140), why: (n.any[0]?.message ?? n.all[0]?.message ?? n.none[0]?.message ?? '').slice(0, 160) })) }))
})()`
const axeResults = {}
const axe = async (name) => { const v = await ev(AXE_RUN, 'axe ' + name); axeResults[name] = v; log(`axe ${name}: ${v.length ? v.map((x) => x.id + 'x' + x.count).join(', ') : 'clean'}`); return v }

const typeInto = (selector, value) =>
  ev(`(() => { const el = document.querySelector(${T(selector)}); if (!el) return false; el.focus(); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement; Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, ${T(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
const testid = (id) => `document.querySelector('[data-testid="${id}"]')`
const tx = (id) => ev(`${testid(id)}?.textContent ?? null`)
const exists = (id) => ev(`!!${testid(id)}`)
const pagePath = () => ev('location.pathname')
const postJson = (url, body, headers = {}) => ev(`fetch(${T(url)}, { method: 'POST', headers: { 'Content-Type': 'application/json', ...${T(headers)} }, body: ${T(JSON.stringify(body))} }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))`)
const getJson = (url, headers = {}) => ev(`fetch(${T(url)}, { headers: ${T(headers)} }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))`)
const fetchStatus = (method, url, headers = {}, body = null) => ev(`fetch(${T(url)}, { method: ${T(method)}, headers: ${T(headers)}, ${body ? `body: ${T(JSON.stringify(body))}, ` : ''} }).then((r) => r.status)`)
const place = async (gate, qubits) => {
  await ev(`(() => { const b = [...document.querySelectorAll('[aria-label="Gate palette"] button')].find((x) => x.textContent.trim() === ${T(gate)}); if (!b || b.disabled) return false; if (b.getAttribute('aria-pressed') !== 'true') b.click(); return true })()`)
  await sleep(80)
  for (const q of qubits) {
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => new RegExp('^Place [a-zA-Z]+ on qubit ${q}( |$)').test(x.getAttribute('aria-label') ?? '')); if (!b) return false; b.click(); return true })()`)
    await sleep(80)
  }
}
const opButtons = () => ev(`(() => { const seen = new Map(); for (const b of document.querySelectorAll('button[aria-pressed]')) { const l = b.getAttribute('aria-label') ?? ''; if (!l.includes(', step ') || l.includes('control on q')) continue; const k = parseInt(l.split(', step ')[1]); if (!seen.has(k)) seen.set(k, l) } return [...seen.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]) })()`)
const removeAll = async () => {
  for (let n = 0; n < 60; n++) {
    const picked = await ev(`(() => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => { const l = x.getAttribute('aria-label') ?? ''; return l.includes(', step 1 of ') && !l.includes('control on q') }); if (!b) return false; b.click(); return true })()`)
    if (!picked) break
    await sleep(120)
    if (!(await clickName('Delete the selected gate'))) break
    await sleep(120)
  }
  await sleep(200)
}
const fmt = (v) => { let s = v.toFixed(6); if (/^-0\.0+$/.test(s)) s = s.slice(1); return s }
const labCanvas = async () => (await opButtons()).map((l) => l.replace(/, step \d+ of \d+.*$/, '')).sort()
const expectedLabels = (c) => c.ops.map((o) => { const q = o.targets[0]; if (o.gate === 'measure') return `Measure q${q} → c${o.clbits[0]}`; if (o.gate === 'cx' || o.gate === 'cz') return `${o.gate.toUpperCase()} — control q${o.controls[0]}, target q${q}`; return `${o.gate.toUpperCase()} on q${q}` }).sort()
const verdictPassed = () => ev(`document.querySelector('[data-testid="verdict"]')?.getAttribute('data-passed')`)
const submit = async () => { await clickName('Submit for checking'); return waitFor(`document.querySelector('[data-testid="verdict"]')`, 25000) }
const storedClassroom = () => ev(`JSON.parse(localStorage.getItem('qentor.classroom.v1') ?? 'null')`)


// ---- the journey: Welcome, Learn, a graded check, Open in Lab, build, run, trace, Tutor, backends, compare, Optimize, Challenge, Debug, Progress,
// classroom, share, shared page, fork, Hindi Tutor, generation unavailable, probability and what-if reasoning, the Guide, a long circuit; then phone
// widths (390 and 320 px), axe on every screen and a console / API audit. Production process, default AnyIO settings, no keepalive workaround.
const reqs = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api/')) reqs.push({ id: m.params.requestId, url: m.params.request.url, method: m.params.request.method, body: m.params.request.postData ?? null, status: null })
  if (m.method === 'Network.responseReceived') { const r = reqs.find((x) => x.id === m.params.requestId); if (r) r.status = m.params.response.status }
})
const lastReq = (part, method = 'POST') => [...reqs].reverse().find((r) => r.url.includes(part) && r.method === method)
const reqCount = (part) => reqs.filter((r) => r.url.includes(part)).length
const respBody = async (r) => { for (let i = 0; i < 20; i++) { try { const x = await send('Network.getResponseBody', { requestId: r.id }); return JSON.parse(x.result.body) } catch { await sleep(150) } } return null }
const lastJson = async (part, method = 'POST') => { const r = lastReq(part, method); return r ? { req: r.body ? JSON.parse(r.body) : null, res: await respBody(r), status: r.status } : null }
const f6 = (v) => { let s = v.toFixed(6); if (/^-0\.0+$/.test(s)) s = s.slice(1); return s }
const tutorText = () => ev(`document.querySelector('footer[aria-label="Tutor"]')?.innerText ?? ''`)
const cards = () => ev(`document.querySelectorAll('[data-testid="reasoning-card"]').length`)
const waitCards = async (n) => waitFor(`document.querySelectorAll('[data-testid="reasoning-card"]').length >= ${n}`, 40000)
const cardText = (i = -1) => ev(`(() => { const c = [...document.querySelectorAll('[data-testid="reasoning-card"]')]; const el = c.at(${i}); return el ? el.innerText : '' })()`)
const setLang = (v) => setSelect('select[aria-label="Tutor answer language"]', v)
const ask = async (q) => {
  const n = reqCount('/api/tutor')
  await typeInto('input[aria-label="Ask the tutor"]', q); await sleep(100); await clickName('Ask')
  for (let i = 0; i < 160; i++) { const r = lastReq('/api/tutor'); if (reqCount('/api/tutor') > n && r.status) break; await sleep(250) }
  await sleep(600)
}
const selectOp = (n) => click(`[...document.querySelectorAll('button[aria-pressed]')].find((b) => { const l = b.getAttribute('aria-label') ?? ''; return l.includes(', step ${n} of ') && !l.includes('control on q') })`, 'op ' + n)
const opLabels = () => ev(`(() => { const seen = new Map(); for (const b of document.querySelectorAll('button[aria-pressed]')) { const l = b.getAttribute('aria-label') ?? ''; if (!l.includes(', step ') || l.includes('control on q')) continue; const k = parseInt(l.split(', step ')[1]); if (!seen.has(k)) seen.set(k, l) } return [...seen.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]) })()`)
const opCount = async () => (await opLabels()).length
const qubitCount = () => ev(`document.querySelectorAll('[role="group"][aria-label^="Qubit "]').length`)
const buildBell = async () => {
  await removeAll()
  while ((await qubitCount()) > 2) { if (!(await clickName('Remove a qubit'))) break }
  while ((await qubitCount()) < 2) { if (!(await clickName('Add a qubit'))) break }
  await place('H', [0]); await place('CX', [0, 1]); await place('M', [0]); await place('M', [1])
  await sleep(400)
}
const plain = (t) => { const seg = t.split(/[^A-Za-z0-9 ,.:;()-]/)[0]; return (seg.length >= 12 ? seg : t.slice(0, 20)).slice(0, 50) }
const sectionText = (s) => (s.type === 'explanation' ? s.body : s.type === 'concept_check' ? s.question : s.type === 'interactive_lab' ? s.instructions : s.prompt)
const apiOk = () => apiFailures.length === 0
const expectedFailures = [] // statuses a step provokes ON PURPOSE are listed here by the step that provokes them
const noteExpected = (s) => expectedFailures.push(s)

await desktop()
const consoleBefore = consoleLines.length
await go(BASE + '/')
await ev(`localStorage.clear()`)
await go(BASE + '/')

// ===================================================================== catalogs from the server
const lessonsRes = await getJson('/api/lessons')
const challengesRes = await getJson('/api/challenges')
const L = Object.fromEntries(lessonsRes.json.lessons.map((l) => [l.id, l]))
const C = Object.fromEntries(challengesRes.json.challenges.map((c) => [c.id, c]))
check('J00a the server serves 19 lessons and 20 challenges, the noise lesson last, and no answer key anywhere', lessonsRes.json.lessons.length === 19 && challengesRes.json.challenges.length === 20 && lessonsRes.json.lessons.at(-1).id === 'quantum-noise' && !JSON.stringify(lessonsRes.json).includes('correct_option_id') && !/reference_solution|"target"/.test(JSON.stringify(challengesRes.json)))
const gradeAll = async (lessonId, checkId) => {
  const section = L[lessonId].sections.find((s) => s.id === checkId)
  const verdicts = {}
  for (const o of section.options) verdicts[o.id] = (await postJson(`/api/lessons/${lessonId}/concept-checks/${checkId}/grade`, { selected_option_id: o.id })).json
  return { right: section.options.find((o) => verdicts[o.id].correct), wrong: section.options.find((o) => !verdicts[o.id].correct), explanation: verdicts[section.options.find((o) => verdicts[o.id].correct).id].explanation }
}


const stepOf = () => ev(`(() => { const m = /Step (\\d+) of (\\d+)/.exec(document.body.innerText); return m ? parseInt(m[1], 10) - 1 : -1 })()`)
// Walk a lesson by the page's own "Step i of N" indicator (so a lesson that resumes where the learner left off is handled), answering open concept
// checks with `answer(section)`; `answer` returns 'stop' to end the walk at that check. Stops at the lab step.
async function walkLesson(lessonId, answer, { pastLab = false } = {}) {
  const sections = L[lessonId].sections
  for (let guard = 0; guard < 16; guard++) {
    const i = await stepOf()
    if (i < 0) return { ok: false, why: 'no step indicator' }
    const sec = sections[i]
    if (sec.type === 'interactive_lab' && !pastLab) return { ok: true, at: 'lab' }
    if (sec.type === 'concept_check' && sec.question && (await ev(`!!document.querySelector('input[type=radio]:not([disabled])')`))) {
      if ((await answer(sec)) === 'stop') return { ok: true, at: 'check ' + sec.id }
    }
    if (!(await clickName('Continue'))) return { ok: false, why: 'no Continue at step ' + (i + 1) }
    await sleep(250)
  }
  return { ok: false, why: 'too many steps' }
}
const pickOption = async (id) => { await ev(`(() => { const r = document.querySelector('input[type=radio][value=${T(id)}]'); if (!r) return false; r.click(); return true })()`); await sleep(120); await clickName('Submit') }

// ===================================================================== 1. Welcome
check('J01a the first visit shows the welcome with its three choices', (await exists('welcome')) && (await ev(`['Start learning', 'Try a challenge', 'Not now'].every((n) => !![...document.querySelectorAll('[data-testid="welcome"] button')].find((b) => b.textContent.trim() === n))`)))
check('J01b the welcome says every number is computed by a simulator on the server and that the tutor never decides', /real simulator on the server/.test(await tx('welcome')) && /never decides whether you are right/.test(await tx('welcome')))
await shot('f7_01_welcome.png')
await axe('1440/welcome')
await clickName('Start learning')
check('J01c Start learning opens the Learn screen', await waitFor(`location.pathname === '/learn'`, 8000) && (await text()).includes('Learn'), await pagePath())

// ===================================================================== 2. Learn -> Qubits & Measurement -> concept check -> Open in Lab
const LESSON = L['qubits-measurement']
await waitFor(`document.querySelector('[aria-label^="${LESSON.title}"]')`, 10000)
check('J02a Learn lists the lesson with its state, and Shor\'s lesson is OPEN (no lock) while saying it builds on phase estimation', await ev(`(() => { const t = [...document.querySelectorAll('button')].map((b) => ({ label: b.getAttribute('aria-label') ?? '', off: b.disabled })); return t.some((x) => x.label.startsWith(${T(LESSON.title)})) && t.some((x) => x.label.startsWith("Shor's Algorithm") && !x.off && !/locked/i.test(x.label) && /builds on/i.test(x.label)) })()`))
await axe('1440/learn')
await shot('f7_02_learn.png')
await click(`[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith(${T(LESSON.title)}))`, 'lesson card')
await waitFor(`document.querySelector('[aria-label*="lesson progress"]')`, 10000)
let sawWrong = false, sawRight = false, explanationShown = null
const walk2 = await walkLesson(LESSON.id, async (sec) => {
  if (sawRight) return 'continue'
  const g = await gradeAll(LESSON.id, sec.id)
  await pickOption(g.wrong.id); sawWrong = await waitFor(`/Not quite\\./.test(document.body.innerText)`, 10000)
  await clickName('Try again'); await sleep(150)
  await pickOption(g.right.id); sawRight = await waitFor(`/Correct\\./.test(document.body.innerText)`, 10000)
  explanationShown = (await tx('quiz-explanation')) ?? ''
  check('J02b a wrong answer is "Not quite", a right one is "Correct.", and the explanation shown is the server\'s', sawWrong && sawRight && explanationShown.includes(g.explanation.slice(0, 50)), explanationShown.slice(0, 80))
  return 'continue'
})
const reachedLab = walk2.ok && walk2.at === 'lab'
check('J02c the lesson reaches its lab step with an Open in Lab button', reachedLab && (await ev(`!![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open in Lab')`)))
await axe('1440/lesson-lab-step')
await shot('f7_03_lesson_lab_step.png')
await clickName('Open in Lab')
check('J02d Open in Lab shows the lesson\'s own circuit on the canvas, exactly the server\'s gates', (await waitFor(`location.pathname === '/'`, 10000)) && JSON.stringify(await labCanvas()) === JSON.stringify(expectedLabels(LESSON.linked_circuit)), await labCanvas())

// ===================================================================== 3. Lab: build/edit, run, measurement result with provenance
await waitFor(`document.querySelector('[aria-label="Gate palette"]')`)
await buildBell()
check('J03a the learner builds a Bell circuit with measurements by clicking (H, CX, M, M)', JSON.stringify(await labCanvas()) === JSON.stringify(['CX — control q0, target q1', 'H on q0', 'Measure q0 → c0', 'Measure q1 → c1'].sort()), await labCanvas())
await clickName('shots'); await sleep(500)
const execBefore = reqCount('/api/execute')
await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Run/.test((x.getAttribute('aria-label') ?? x.textContent).trim()) && !x.disabled); if (b) b.click(); return !!b })()`)
for (let i = 0; i < 80 && !(reqCount('/api/execute') > execBefore && lastReq('/api/execute').status); i++) await sleep(250)
await sleep(800)
const shotsRun = await lastJson('/api/execute')
const counts = shotsRun.res.payload.counts
const pageT = await text()
check('J03b Run sends the canonical circuit and the mode only; the server\'s answer carries a result id, circuit hash, backend, version and SIMULATION', shotsRun.status === 200 && shotsRun.req.mode === 'shots' && !('counts' in shotsRun.req) && /^res_/.test(shotsRun.res.result_id) && shotsRun.res.provenance_class === 'SIMULATION' && shotsRun.res.backend === 'qiskit-aer', Object.keys(shotsRun.req))
check('J03c the measurement result on screen is the server\'s: every outcome and its count, labelled sampled, with bit order stated', Object.entries(counts).every(([k, v]) => pageT.includes(k) && pageT.includes(String(v))) && /sampled/i.test(pageT) && /q\[n-1\]|q\[1\]/.test(pageT), counts)
check('J03d the result carries its provenance on screen (a Simulated badge naming qiskit-aer)', await ev(`/Simulated/.test(document.body.innerText) && /qiskit-aer/.test(document.body.innerText)`))
await shot('f7_04_lab_shots.png')
await axe('1440/lab-results')
await clickName('statevector'); await sleep(600)

// ===================================================================== 4. Trace, select a step, Tutor "What changed?"
await clickName('Run trace'); await waitFor(`document.querySelectorAll('[aria-label*="Trace step"], [data-testid="trace-viewer"], [data-testid="qubit-states"]').length > 0 || /Step 1 of/.test(document.body.innerText)`, 40000)
await sleep(1200)
const trace = await lastJson('/api/execute/trace')
check('J04a the trace is the server\'s: one record per operation plus the start, terminal measurements listed not run', trace.status === 200 && trace.res.steps.length === 3 && trace.res.terminal_measurements.length === 2 && trace.res.steps.every((s) => /^res_/.test(s.provenance.result_id)) && /^res_/.test(trace.res.final_result_id), { steps: trace.res.steps.length, term: trace.res.terminal_measurements?.length })
await selectOp(1); await sleep(600)
const stepText = await text()
check('J04b selecting step 1 shows the server\'s per-qubit Bloch view for that step with its provenance (the 3D spheres where WebGL exists, the flat cards where it does not)', /(PER-QUBIT BLOCH SPHERES|QUBIT STATE VIEW)/i.test(stepText) && /(from trace step \d|Step \d of 3)/.test(stepText), null)
await axe('1440/trace')
await clickName('What changed?'); await sleep(300)
await clickName('What changed in this step?')
for (let i = 0; i < 160; i++) { const r = lastReq('/api/tutor'); if (r && r.status && reqCount('/api/tutor') >= 1) break; await sleep(250) }
await sleep(900)
const stepAnswer = await lastJson('/api/tutor')
check('J04c the Tutor\'s "What changed?" answer is grounded in the server\'s trace step (facts with a result id, no number from the browser)', stepAnswer.status === 200 && Array.isArray(stepAnswer.res.facts) && stepAnswer.res.facts.length > 0 && !/probab|amplitude|counts/.test(Object.keys(stepAnswer.req).join(',')), Object.keys(stepAnswer.req))
await axe('1440/tutor-what-changed')
await clickName('Explain'); await sleep(200)

// ===================================================================== 5. Switch backend, compare
const cirqSet = await ev(`(() => { const s = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'cirq')); if (!s) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'cirq'); s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
const execBefore2 = reqCount('/api/execute')
await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Run/.test((x.getAttribute('aria-label') ?? x.textContent).trim()) && !x.disabled); if (b) b.click(); return !!b })()`)
for (let i = 0; i < 80 && !(reqCount('/api/execute') > execBefore2 && lastReq('/api/execute').status); i++) await sleep(250)
await sleep(800)
const cirqRun = await lastJson('/api/execute')
check('J05a switching to Cirq runs the same circuit on Cirq and the result says so (backend and version from the server)', cirqSet && cirqRun.req.backend === 'cirq' && cirqRun.res.backend === 'cirq' && (await text()).includes(cirqRun.res.backend_version), cirqRun.res.backend)
await ev(`(() => { const d = document.querySelector('[data-testid="results-group-compare"]'); if (d && !d.open) d.querySelector('summary').click() })()`); await sleep(300)
await clickName('Compare backends'); await waitFor(`/agree/i.test(document.querySelector('[data-testid="results-group-compare"]')?.innerText ?? '') && !/Comparing…/.test(document.body.innerText)`, 60000)
const agree = await lastJson('/api/compare/backends')
check('J05b Compare backends is the server\'s verdict over three simulators: agreement computed server-side, threshold 1e-6, nothing compared in the browser', agree.status === 200 && JSON.stringify(agree.res).includes('agrees') && Object.keys(agree.req).sort().join() === 'circuit', Object.keys(agree.req))
await shot('f7_05_compare.png')
await axe('1440/compare')
await ev(`(() => { const s = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'cirq')); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'qiskit-aer'); s.dispatchEvent(new Event('change', { bubbles: true })) })()`); await sleep(500)

// ===================================================================== 6. Optimize: original -> candidate -> equivalence -> accepted/rejected
await ev(`(() => { const d = document.querySelector('[data-testid="results-group-verify"]'); if (d && !d.open) d.querySelector('summary').click(); document.querySelector('[data-testid="optimize-panel"]')?.scrollIntoView() })()`); await sleep(300)
check('J06a the Optimize panel offers three examples and says what the optimizer is and is not (the Qiskit transpiler is context, not a claim)', (await ev(`document.querySelectorAll('[data-testid="optimize-examples"] li button').length`)) === 3 && /does not implement the Qiskit transpiler and does not claim to match it/.test(await tx('optimize-context')))
await clickName('Two Hadamards in a row'); await sleep(400)
check('J06b loading an example puts its circuit in the Lab (H, H, CX) and says what to expect, without running anything', JSON.stringify(await labCanvas()) === JSON.stringify(['CX — control q0, target q1', 'H on q0', 'H on q0'].sort()) && /should match/.test(await tx('optimize-example-summary')), await labCanvas())
const optBefore = reqCount('/api/optimize')
await clickName('Optimize'); await waitFor(testid('optimization-steps'), 30000); await sleep(500)
const opt = await lastJson('/api/optimize')
const steps = await tx('optimization-steps')
check('J06c the four stages are the server\'s: original 3 operations, candidate 1, equivalence check Equivalent, decision Accepted - from VERIFIED_SHORTER', opt.status === 200 && opt.res.status === 'VERIFIED_SHORTER' && opt.res.original_op_count === 3 && opt.res.candidate_op_count === 1 && /Original: 3 operations/.test(steps) && /Candidate: 1 operation/.test(steps) && /Equivalence check: Equivalent/.test(steps) && /Decision: Accepted/.test(steps) && reqCount('/api/optimize') === optBefore + 1, steps)
check('J06d the optimization is stored as evidence: the candidate has a result id and its provenance is shown', /^res_/.test(opt.res.result_id ?? '') && (await exists('optimization-provenance')))
check('J06e the Lab circuit is unchanged until Apply is pressed', (await opCount()) === 3)
await shot('f7_06_optimize.png')
await axe('1440/optimize-report')
await clickName('Apply optimized circuit'); await sleep(500)
check('J06f Apply replaces the circuit with the server\'s candidate (one CX) as one undo step, and Undo brings the original back', JSON.stringify(await labCanvas()) === JSON.stringify(['CX — control q0, target q1']) && (await clickName('Undo')) && (await opCount()) === 3, await labCanvas())
await clickName('Reducible, but no rule for it'); await sleep(400)
await clickName('Optimize'); await waitFor(`/No rewrite rule matched/.test(document.body.innerText) && ![...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Optimizing…')`, 30000); await sleep(400)
const optNone = await lastJson('/api/optimize')
check('J06g the no-rule example is honest: NO_OPTIMIZATION_FOUND, no candidate, no Apply button, decision "Nothing to propose"', optNone.res.status === 'NO_OPTIMIZATION_FOUND' && optNone.res.candidate_circuit === null && /Decision: Nothing to propose/.test(await tx('optimization-steps')) && !(await ev(`!![...document.querySelectorAll('button')].find((b) => /Apply optimized circuit/.test(b.textContent))`)))

// ===================================================================== 7. Challenge
await nav('Challenges'); await waitFor(`document.body.innerText.includes('0 of 20 solved')`, 10000)
await axe('1440/challenges-list')
await shot('f7_07_challenges.png')
await click(`[...document.querySelectorAll('button')].find((b) => /Create \\|1/.test(b.textContent))`, 'challenge create-one'); await sleep(900)
await waitFor(`document.querySelector('[aria-label="Gate palette"]')`, 10000)
await removeAll()
await place('X', [0]); await sleep(500)
check('J07a the challenge asks only for a circuit; submitting sends the circuit and nothing about the verdict', true)
await clickName('Submit for checking'); await waitFor(`document.querySelector('[data-testid="verdict"]')`, 30000)
const chSub = await lastJson('/api/challenges/create-one/submit')
check('J07b the verdict is the server\'s: passed, with its checks and a result id, and the page agrees', chSub.status === 200 && chSub.res.passed === true && (await verdictPassed()) === 'true' && JSON.stringify(Object.keys(chSub.req).sort()) === '["circuit"]', chSub.res.passed)
await axe('1440/challenge-passed')
await shot('f7_08_challenge_passed.png')

// ===================================================================== 8. Debug
await nav('Lab'); await waitFor(`document.querySelector('[aria-label="Gate palette"]')`, 10000)
await buildBell(); await sleep(1500)
await clickName('Debug'); await sleep(300)
await clickName('Debug my circuit'); await waitFor(`document.querySelector('[data-testid="debug-report"]')`, 40000)
const dbg = await lastJson('/api/debug')
check('J08a Debug my circuit shows the server\'s report: sections computed from backend runs, no model required', dbg.status === 200 && (await exists('debug-report')), Object.keys(dbg.res).slice(0, 6))
await axe('1440/debug')
await clickName('Explain'); await sleep(200)

// ===================================================================== 9. Progress
await nav('Progress'); await waitFor(`document.body.innerText.includes('Progress')`, 10000); await sleep(800)
const progText = await text()
check('J09a Progress shows this learner\'s real record: one concept check answered and one challenge solved of 20', /1 of 20 solved/.test(progText) && /concept check/i.test(progText), progText.slice(0, 200))
await axe('1440/progress')
await shot('f7_09_progress.png')

// ===================================================================== 10. Instructor / classroom
await click(`document.querySelector('[data-testid="class-chip"]')`, 'class chip')
check('J10a the class indicator opens the Classroom screen, which has no name, e-mail or password field', (await waitFor(`location.pathname === '/classroom'`, 8000)) && (await ev(`document.querySelectorAll('input[type=email], input[type=password], input[type=tel], input[autocomplete*=name]').length`)) === 0)
await typeInto('#class-title', 'Final demo class')
await clickName('Create class')
const freshOk = await waitFor(testid('fresh-class'), 10000)
const CODE = await tx('fresh-code'), KEY = await tx('fresh-key')
check('J10b a class is created: a short code and a one-time instructor key shown once', freshOk && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(CODE ?? '') && /^qi_/.test(KEY ?? '') && /shown once/.test(await tx('fresh-class')))
await clickName('I have saved the key')
await typeInto('#class-code', CODE); await clickName('Join class')
const joined = await waitFor(testid('membership'), 10000)
check('J10c the learner joins by the code and is shown only an anonymous alias', joined && /Learner [0-9A-F]{4}/.test((await tx('membership')) ?? ''))
// the joined learner learns: a graded check and a challenge, so the dashboard has real, server-derived events
await nav('Learn'); await sleep(500)
await click(`[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith(${T(LESSON.title)}))`, 'lesson again')
await waitFor(`document.querySelector('[aria-label*="lesson progress"]')`, 10000)
const walk10 = await walkLesson(LESSON.id, async (sec) => {
  const g = await gradeAll(LESSON.id, sec.id)
  await pickOption(g.wrong.id); await waitFor(`/Not quite\\./.test(document.body.innerText)`, 10000)
  return 'stop'
}, { pastLab: true })
check('J10x the joined learner answers a still-open concept check wrongly, so the class has a server-derived misconception event', walk10.ok && /check/.test(walk10.at ?? ''), walk10)
await nav('Challenges'); await sleep(600)
await click(`[...document.querySelectorAll('button')].find((b) => /Create \\|1/.test(b.textContent))`, 'challenge'); await sleep(800)
await removeAll(); await place('X', [0]); await sleep(400)
await clickName('Submit for checking'); await waitFor(`document.querySelector('[data-testid="verdict"]')`, 30000)
await go(BASE + '/classroom'); await sleep(900)
await clickName('Open dashboard'); const dashOk = await waitFor(testid('lessons-table'), 20000)
const dash = await lastJson('/api/classes/' + CODE.replace(/[^A-Z0-9]/g, '') + '/dashboard', 'GET') ?? (await lastJson('/dashboard', 'GET'))
check('J10d the instructor dashboard shows this anonymous class with sample sizes, from events the SERVER derived (a wrong check, a challenge)', dashOk && (await tx('stat-learners')) === '1' && /Anonymous classroom data/.test((await tx('dashboard-data-note')) ?? ''), await tx('stat-learners'))
check('J10e the dashboard tables have captions and column headers, and no name or e-mail appears', (await ev(`[...document.querySelectorAll('[data-testid="lessons-table"], [data-testid="challenges-table"]')].every((t) => !!t.querySelector('caption') && t.querySelectorAll('th').length >= 2)`)) && !/@|password/i.test(await text()))
await shot('f7_10_dashboard.png')
await axe('1440/classroom-dashboard')

// ===================================================================== 11. Share an experiment, open it, fork it
await nav('Lab'); await waitFor(`document.querySelector('[aria-label="Gate palette"]')`, 10000)
await buildBell(); await sleep(1500)
await ev(`(() => { const d = document.querySelector('[data-testid="results-group-share"]'); if (d && !d.open) d.querySelector('summary').click() })()`); await sleep(300)
const apiBeforeShare = reqs.length
await clickName('Share as a read-only page'); await waitFor(testid('share-page-result'), 15000)
const LINK = await ev(`document.querySelector('input[aria-label="Read-only page link"]')?.value ?? null`)
const SHARE_ID = /\/shared\/(ex_[0-9a-f]{16})$/.exec(LINK ?? '')?.[1]
const shareReq = reqs.slice(apiBeforeShare).find((r) => /\/api\/experiments$/.test(r.url))
check('J11a Share as a read-only page sends the circuit and the run id only; the page has an address of the form /shared/ex_…', !!SHARE_ID && JSON.stringify(Object.keys(JSON.parse(shareReq.body)).sort()) === '["circuit","result_id"]', LINK)
const API_SHARE = (await getJson('/api/experiments/' + SHARE_ID)).json
check('J11b the stored share has no owner, class, token, key or path anywhere in it', !/ql_|qi_|learner|class_code|Final demo|\/home\/|qentor\.db|api_key/i.test(JSON.stringify(API_SHARE)) && API_SHARE.read_only === true)
await go(LINK); await waitFor(testid('shared-title'), 15000)
const sharedText = await ev(`document.getElementById('main-content').innerText`)
check('J11c the shared page shows the circuit, its code and the stored run with its provenance, from stored data, and nothing to edit', (await exists('readonly-circuit')) && /Read-only snapshot/.test(await tx('readonly-badge')) && /Simulated/.test(sharedText) && (await ev(`document.getElementById('main-content').querySelectorAll('input, textarea, select, [contenteditable]:not([contenteditable=false])').length`)) === 0)
await shot('f7_11_shared.png')
await axe('1440/shared-page')
const callsBeforeFork = reqs.length
await clickName('Fork into my Lab'); await waitFor(`location.pathname === '/'`, 10000); await sleep(1500)
check('J11d Fork into my Lab: the Lab holds a copy of the shared circuit, and nothing was created or changed on the server', JSON.stringify(await labCanvas()) === JSON.stringify(expectedLabels(API_SHARE.circuit)) && !reqs.slice(callsBeforeFork).some((r) => /experiments/.test(r.url) && r.method !== 'GET'), await labCanvas())

// ===================================================================== 12. Multilingual Tutor, AI generation unavailable, probability, what-if
await waitFor(`document.querySelectorAll('[data-testid="reasoning-actions"] button').length > 0`, 30000)
await setLang('hi'); await sleep(200)
await ask('1 आने की संभावना कितनी है?')
const hi = await lastJson('/api/tutor')
check('J12a a Hindi question is answered in a Hindi wrapper around the backend\'s facts (language hi sent, facts from the run)', hi.status === 200 && hi.req.language === 'hi' && /बैकएंड/.test(hi.res.answer) && hi.res.facts.length > 0, hi.res.answer.slice(0, 80))
await axe('1440/tutor-hindi')
await setLang('en'); await sleep(200)
await clickName('Generate code'); await sleep(500)
const gen = await getJson('/api/generate/status')
check('J12b with no model key the Generate tab says unavailable and offers no request form; the server says so too', gen.json.available === false && (await exists('generate-unavailable')) && !(await ev(`!![...document.querySelectorAll('button')].find((b) => /^Generate$/.test(b.textContent.trim()))`)), gen.json)
await axe('1440/generate-unavailable')
await clickName('Explain'); await sleep(300)
await clickName('Analyze probability'); await sleep(250); await clickName('Analyze'); await waitCards(1)
const prob = await lastJson('/api/reasoning/analyze')
const probCard = await cardText()
check('J12c Analyze probability: a structured request (no number from the browser); the card shows the server\'s outcomes with their provenance and the bit order', prob.res.intent === 'PROBABILITY' && !JSON.stringify(prob.req).match(/probabilit(y|ies)"\s*:\s*\d/) && prob.res.data.items.every((i) => probCard.includes(f6(i.theoretical_probability))) && /q\[1\]…q\[0\]/.test(probCard) && probCard.includes(prob.res.analysis_id))
await axe('1440/reasoning-probability')
await selectOp(2).catch(() => {})
await clickName('What if…'); await sleep(300)
await clickName('Show the new circuit'); await waitFor(`document.querySelector('[data-testid="whatif-preview"]')`, 20000)
const analyzeCountBeforeRun = reqCount('/api/reasoning/analyze')
check('J12d the what-if shows the SERVER\'s counterfactual circuit before anything runs', /nothing has run yet/.test(await tx('whatif-preview')) && reqCount('/api/reasoning/analyze') === analyzeCountBeforeRun)
await clickName('Run both and compare'); await waitCards(2)
const wi = await lastJson('/api/reasoning/analyze')
check('J12e running the what-if compares two recorded runs: the server\'s total variation distance and equivalence verdict are on the card', wi.res.intent === 'WHAT_IF' && (await cardText()).includes(f6(wi.res.data.comparison.measurement.total_variation_distance)) && new Set(wi.res.sources.map((s) => s.role)).size === 2)
await axe('1440/reasoning-whatif')
await shot('f7_12_whatif.png')

// ===================================================================== 13. Guide, keyboard, focus
await click(`[...document.querySelectorAll('button')].find((b) => /Open Qubi AI Tutor/.test(b.getAttribute('aria-label') ?? ''))`, 'guide'); await sleep(900)
check('J13a the Guide opens as a named dialog-like panel with a Close control', (await ev(`!![...document.querySelectorAll('button')].find((b) => /Close guide panel/.test(b.getAttribute('aria-label') ?? ''))`)))
await axe('1440/guide')
await shot('f7_13_guide.png')
await key('Escape', 'Escape', 27); await sleep(400)
check('J13b Escape closes the Guide', !(await ev(`!![...document.querySelectorAll('button')].find((b) => /Close guide panel/.test(b.getAttribute('aria-label') ?? ''))`)))
await clickName('Open Qubi AI Tutor').catch(() => {})
await key('Escape', 'Escape', 27)

// ===================================================================== 14. Shor lesson in the browser, and a long circuit in the Lab (the page-width fix)
const seededAll = {}
for (const l of lessonsRes.json.lessons.slice(0, 17)) {
  const attempts = {}
  for (const s of l.sections) { if (s.type !== 'concept_check' || !s.question) continue; const g = await gradeAll(l.id, s.id); attempts[s.id] = { selectedOptionId: g.right.id, isCorrect: true, attemptCount: 1 } }
  seededAll[l.id] = { activeSectionIndex: l.sections.length - 1, completedSectionIds: l.sections.map((s) => s.id).sort(), conceptCheckAttempts: attempts }
}
await ev(`localStorage.setItem('qentor.learn.progress.v1', ${T(JSON.stringify({ version: 1, startedLessonIds: Object.keys(seededAll).sort(), lessons: seededAll }))})`)
const openShor = async () => {
  await go(BASE + '/learn')
  await click(`[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith("Shor's Algorithm"))`, 'shor')
  await waitFor(`document.querySelector('[aria-label*="lesson progress"]')`, 10000)
  const walked = await walkLesson('shors-algorithm', async (sec) => {
    const g = await gradeAll('shors-algorithm', sec.id)
    await pickOption(g.right.id); await waitFor(`/Correct\\./.test(document.body.innerText)`, 10000)
    return 'continue'
  })
  check('J14w the Shor lesson is walked to its lab step through its two graded checks (every time it is opened)', walked.ok && walked.at === 'lab', walked)
}
await openShor()
const shorL = L['shors-algorithm']
check('J14a Shor\'s lesson text, as the server serves it, says it is one fixed educational instance and not a general factoring implementation, and its lab step is on screen', shorL.sections[0].body.includes('ONE fixed small educational instance') && shorL.sections[0].body.includes('not a general factoring implementation') && shorL.sections[8].body.includes('not simulated here as a production factoring system') && (await text()).includes(shorL.sections[5].instructions.slice(0, 50)))
await axe('1440/shor-lab-step')
await clickName('Open in Lab'); await waitFor(`location.pathname === '/'`, 10000); await sleep(2500)
const pmShor = await pageMetrics()
check('J14b the 7-qubit, 29-operation Shor circuit in the Lab does not widen the page (no horizontal page scroll)', pmShor.scrollWidth <= pmShor.innerWidth + 1 && (await qubitCount()) === 7, pmShor)
await shot('f7_14_shor_in_lab.png')
await axe('1440/shor-in-lab')

// ===================================================================== 15. Phone widths: the main screens at 390 and 320 px
for (const [w, h] of [[390, 844], [320, 640]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true })
  const screens = [
    ['lab', async () => { await go(BASE + '/'); await waitFor(`document.querySelector('[aria-label="Gate palette"]')`); await buildBell(); await sleep(2000); await clickName('Two Hadamards in a row'); await sleep(300); await clickName('Optimize'); await waitFor(testid('optimization-steps'), 30000) }],
    ['lab-shor', async () => { await openShor(); await clickName('Open in Lab'); await waitFor(`location.pathname === '/'`, 10000); await sleep(2500) }],
    ['learn', async () => { await go(BASE + '/learn'); await sleep(900) }],
    ['challenges', async () => { await go(BASE + '/challenges'); await sleep(900) }],
    ['progress', async () => { await go(BASE + '/progress'); await sleep(900) }],
    ['classroom', async () => { await go(BASE + '/classroom'); await sleep(700); await clickName('Open dashboard'); await waitFor(testid('lessons-table'), 15000) }],
    ['shared', async () => { await go(LINK); await waitFor(testid('shared-title'), 15000) }],
  ]
  for (const [name, setup] of screens) {
    await setup()
    const pm = await pageMetrics()
    check(`J15 ${w}px ${name}: no horizontal page scroll`, pm.scrollWidth <= pm.innerWidth + 1 && pm.offenders.length === 0, pm)
    await shot(`f7_15_${w}_${name}.png`)
    await axe(`${w}/${name}`)
  }
}

// ===================================================================== 16. audit
const axeTotal = Object.values(axeResults).reduce((n, v) => n + v.length, 0)
check('J16a axe (WCAG 2.2 AA and best practice) found no violation on any screen at 1440, 390 and 320 px', axeTotal === 0, Object.fromEntries(Object.entries(axeResults).filter(([, v]) => v.length)))
const newConsole = consoleLines.slice(consoleBefore)
check('J16b no console error, warning or exception during the whole journey', newConsole.length === 0, newConsole.slice(0, 5))
const unexpected = apiFailures.filter((f) => !expectedFailures.some((e) => f.includes(e)))
check('J16c no unexpected failed API response (status 400 or above) during the whole journey', unexpected.length === 0, unexpected)
const noThirdParty = reqs.every((r) => r.url.startsWith(BASE) || !r.url.includes('/api/'))
check('J16d every API call went to the one origin serving the page (no other host)', noThirdParty)
const health = await getJson('/api/health')
check('J16e the production process is still healthy after the journey', health.status === 200 && health.json.status === 'ok')

const failed = Object.entries(out.checks).filter(([, ok]) => !ok).map(([k]) => k)
console.log(JSON.stringify({ allPassed: failed.length === 0, failed, checks: out.checks, data: out.data, axe: Object.fromEntries(Object.entries(axeResults).map(([k, v]) => [k, v.length])), axeViolations: Object.fromEntries(Object.entries(axeResults).filter(([, v]) => v.length)), console: newConsole.slice(0, 10), apiFailures }, null, 1))
try { chrome.kill() } catch {}
process.exit(0)
