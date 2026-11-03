// The browser bundle: one ModuleLoader registration that requires only `react`,
// its slot registrations, the rules over the host's rows (kept in step with the
// host's own source parser), the hub's job polling against a fake host, and what
// the tab, the detail page and the progress panel render.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import { classifySource as hostClassify } from '../lib/sources.mjs'
import { caseName, SOURCE_CASES } from './helpers.mjs'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useSyncExternalStore: (subscribe, get) => get(),
}

function loadBundle() {
  const registrations = []
  const required = []
  const appended = []
  const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  const sandbox = {
    window,
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { append: (element) => appended.push(element) } },
    fetch: () => Promise.reject(new Error('network disabled in tests')),
    setTimeout,
    clearTimeout,
    console,
  }
  sandbox.globalThis = sandbox
  runInNewContext(SOURCE, sandbox, { filename: 'lib/client.js' })
  assert.equal(registrations.length, 1)
  const plugin = registrations[0].factory((id) => {
    required.push(id)
    if (id === 'react') return REACT_STUB
    throw new Error(`no module ${id}`)
  })
  return { registration: registrations[0], plugin, required, appended }
}

/** Flatten a rendered stub tree into its text. */
function text(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node.type === 'function') {
    const children = node.children.length === 0 ? undefined : node.children.length === 1 ? node.children[0] : node.children
    return text(node.type({ ...(node.props || {}), ...(children === undefined ? {} : { children }) }))
  }
  return text(node.children)
}

const OLD = '155b39fbe980de42e4281ee5a510e16328fe5489'
const NEW = '62fbe5878728bf9faac182d6578ba3c10e880fc2'

const READER = {
  name: 'dsh-chat-reader',
  version: '0.1.0',
  enabled: true,
  installed: true,
  availability: 'profile',
  removable: true,
  source: 'github:luyang950/dsh-chat-reader',
  kind: 'github',
  repo: { url: 'https://github.com/luyang950/dsh-chat-reader.git', ref: '', github: true },
  pinned: false,
  locked: OLD,
  check: { behind: true, remote: NEW, ref: 'HEAD', at: 1 },
  history: [{ spec: 'github:luyang950/dsh-chat-reader', commit: NEW, version: '0.0.9', at: 1 }],
  self: false,
  legacy: false,
}
const SELF_ROW = { ...READER, name: 'dsh-plugin-manager', source: 'link:/dev/dsh-plugin-manager', kind: 'path', repo: undefined, locked: null, check: undefined, history: [], self: true }
const TGZ = { ...READER, name: 'p', source: 'file:/tmp/p.tgz', kind: 'tarball', repo: undefined, locked: null, check: undefined, history: [], enabled: false }

function subjectOf(row, extra = {}) {
  return { kind: 'bundle', pkg: { name: row.name, installed: true, availability: 'profile', official: false, enabled: row.enabled, rows: [], ...extra } }
}

/* ── loader contract ─────────────────────────────────────────────────────── */

test('registers one ModuleLoader module that requires only react', () => {
  const { registration, plugin, required } = loadBundle()
  assert.equal(registration.id, 'dsh-plugin-manager')
  assert.equal(plugin.name, 'dsh-plugin-manager')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(required, ['react'])
  assert.deepEqual([...plugin.inject], ['slots', 'locale', 'remote'])
})

test('the bundle is plain script: no import / export, nothing but react and DSH primitives', () => {
  assert.doesNotMatch(SOURCE, /^\s*import\s/m)
  assert.doesNotMatch(SOURCE, /^\s*export\s/m)
  const requires = [...SOURCE.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)].sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react'])
})

test('both dictionaries carry the same keys', () => {
  const { plugin } = loadBundle()
  assert.deepEqual(Object.keys(plugin.EN).sort(), Object.keys(plugin.ZH).sort())
})

/* ── slot registration ───────────────────────────────────────────────────── */

function mount() {
  const loaded = loadBundle()
  const effects = []
  const slots = []
  const listeners = {}
  const locales = []
  const ctx = {
    effect: (run, label) => effects.push({ run, label }),
    locale: {
      register: (ns, dictionaries) => (locales.push({ ns, dictionaries }), () => {}),
      bind: () => (key) => `t:${key}`,
    },
    remote: { $on: (event, fn) => ((listeners[event] = fn), () => delete listeners[event]) },
    on: (event, fn) => ((listeners[event] = fn), () => delete listeners[event]),
    slots: {
      inject: (key, run) => {
        const result = run()
        slots.push({ key, options: result.options, component: result.component })
      },
      register: (options, component) => ({ options, component }),
    },
  }
  loaded.plugin.apply(ctx)
  return Object.assign(loaded, { ctx, effects, slots, listeners, locales })
}

test('apply registers the Manage tab, the detail action and badge, and the overlay', () => {
  const { slots, plugin, locales, appended, effects } = mount()
  effects[1].run()
  assert.deepEqual(slots.map((slot) => slot.key), ['plugins.tab', 'plugins.detail.actions', 'plugins.detail.badge', 'shell.overlay'])
  for (const slot of slots) {
    assert.equal(slot.options.name, slot.key)
    assert.equal(slot.options.id, 'dsh-plugin-manager')
    assert.equal(slot.options.locale, 'dshPluginManagerTool')
    assert.equal(typeof slot.options.inject().hub.enqueue, 'function')
  }
  assert.equal(slots[0].options.label(), 't:tabLabel')
  assert.deepEqual(slots.map((slot) => slot.component), [plugin.ManageTab, plugin.UpdateAction, plugin.CommitBadge, plugin.JobsOverlay])
  assert.notEqual(locales[0].ns, 'pluginManager', 'never collides with DSH’s own page dictionary')
  assert.deepEqual(Object.keys(locales[0].dictionaries), ['zh', 'en'])
  assert.deepEqual(effects.map((effect) => effect.label), ['dsh-plugin-manager: styles', 'dsh-plugin-manager: dictionaries', 'dsh-plugin-manager: jobs'])
  effects[0].run()
  assert.equal(appended.length, 1, 'one stylesheet')
  assert.equal(locales.length, 1)
})

test('the jobs effect listens to plugin-manager/changed and lets go on dispose', () => {
  const { effects, listeners } = mount()
  const dispose = effects[2].run()
  assert.deepEqual(Object.keys(listeners).sort(), ['connection/reset', 'plugin-manager/changed'])
  dispose()
  assert.deepEqual(Object.keys(listeners), [])
})

/* ── rules ───────────────────────────────────────────────────────────────── */

test('the bundle’s classifySource agrees with lib/sources.mjs on every case', () => {
  const { plugin } = loadBundle()
  for (const [spec, kind] of SOURCE_CASES) {
    assert.equal(plugin.classifySource(spec, caseName(spec)), kind, String(spec))
    assert.equal(plugin.classifySource(spec, caseName(spec)), hostClassify(spec, caseName(spec)), String(spec))
  }
})

test('updateTarget: third-party, installed, removable, with a recorded source', () => {
  const { plugin } = loadBundle()
  const rows = [READER, TGZ, SELF_ROW, { ...READER, name: 'locked', removable: false }, { ...READER, name: 'nosrc', source: undefined, kind: null }]
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.updateTarget(subjectOf(READER), rows))), {
    name: 'dsh-chat-reader',
    spec: 'github:luyang950/dsh-chat-reader',
    enabled: true,
    kind: 'github',
    self: false,
  })
  assert.equal(plugin.updateTarget(subjectOf(TGZ), rows).enabled, false)
  assert.equal(plugin.updateTarget(subjectOf(SELF_ROW), rows).self, true, 'this plugin can update itself now')
  assert.equal(plugin.updateTarget(subjectOf({ name: 'locked' }), rows), null)
  assert.equal(plugin.updateTarget(subjectOf({ name: 'nosrc' }), rows), null)
  assert.equal(plugin.updateTarget(subjectOf({ name: '@deepseek-ai/dsh-base' }), rows), null, 'not a third-party row')
  assert.equal(plugin.updateTarget(subjectOf(READER, { official: true }), rows), null)
  assert.equal(plugin.updateTarget(subjectOf(READER, { installed: false }), rows), null)
  assert.equal(plugin.updateTarget({ kind: 'item', id: 'x' }, rows), null)
  assert.equal(plugin.updateTarget(subjectOf(READER), null), null, 'nothing before the overview answers')
})

test('updateRequests puts this plugin last; rowStatus reads the check', () => {
  const { plugin } = loadBundle()
  const rows = [SELF_ROW, READER, TGZ]
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.updateRequests(rows, ['dsh-plugin-manager', 'dsh-chat-reader', 'p', 'missing']))), [
    { type: 'update', name: 'dsh-chat-reader', enabled: true },
    { type: 'update', name: 'p', enabled: false },
    { type: 'update', name: 'dsh-plugin-manager', enabled: true },
  ])
  assert.equal(plugin.rowStatus(READER, false), 'behind')
  assert.equal(plugin.rowStatus(READER, true), 'busy')
  assert.equal(plugin.rowStatus({ ...READER, check: { behind: false } }, false), 'latest')
  assert.equal(plugin.rowStatus({ ...READER, check: { error: 'x' } }, false), 'failed')
  assert.equal(plugin.rowStatus({ ...READER, check: undefined }, false), 'unchecked')
  assert.equal(plugin.rowStatus({ ...READER, pinned: true }, false), 'pinned')
  assert.equal(plugin.rowStatus(TGZ, false), 'none')
  assert.equal(plugin.rowStatus({ ...TGZ, error: { code: 'x' } }, false), 'problem')
})

test('describeFailure names codes, pnpm kinds and the line that matters', () => {
  const { plugin } = loadBundle()
  assert.match(plugin.describeFailure({ code: 'transport', message: 'socket closed' }), /socket closed/)
  assert.match(plugin.describeFailure({ code: 'incompatible-version' }), /不兼容/)
  assert.match(plugin.describeFailure({ code: 'weird-new-code' }), /weird-new-code/)
  assert.match(plugin.describeFailure({ code: 'failed', kind: 'build-blocked', pendingBuilds: ['esbuild'] }), /esbuild/)
  const enoent = plugin.describeFailure({ code: 'operation-error', kind: 'unknown', diagnostic: "✓ Lockfile ok\nProgress: resolved 0\n[ENOENT] ENOENT: no such file, open '/tmp/gone.tgz'" })
  assert.match(enoent, /pnpm 执行失败/)
  assert.match(enoent, /\[ENOENT\]/)
  assert.doesNotMatch(enoent, /Progress:/)
  const en = (key, params) => plugin.format(plugin.EN[key] ?? key, params)
  assert.match(plugin.describeFailure({ code: 'cancelled' }, en), /cancelled/)
})

test('stepState follows each job type', () => {
  const { plugin } = loadBundle()
  assert.equal(plugin.stepState({ type: 'install', phase: 'installing' }, 'remove'), null)
  assert.equal(plugin.stepState({ type: 'remove', phase: 'done' }, 'install'), null)
  assert.equal(plugin.stepState({ type: 'remove', phase: 'done' }, 'remove'), 'done')
  assert.equal(plugin.stepState({ type: 'update', phase: 'queued' }, 'remove'), 'waiting')
  assert.equal(plugin.stepState({ type: 'update', phase: 'removing' }, 'remove'), 'running')
  assert.equal(plugin.stepState({ type: 'update', phase: 'installing', removed: true }, 'remove'), 'done')
  assert.equal(plugin.stepState({ type: 'update', phase: 'installing', removed: false }, 'remove'), 'skipped')
  assert.equal(plugin.stepState({ type: 'update', phase: 'failed', failedStage: 'install', removed: true }, 'install'), 'failed')
  assert.equal(plugin.stepState({ type: 'update', phase: 'failed', failedStage: 'remove' }, 'remove'), 'failed')
  assert.equal(plugin.stepState({ type: 'update', phase: 'interrupted', removed: true }, 'install'), 'failed')
})

/* ── hub: jobs are polled from the host ──────────────────────────────────── */

function fakeHost() {
  const calls = []
  const timers = []
  const state = { jobs: [], overview: { profile: 'web', plugins: [READER] }, fail: 0 }
  const request = async (path, body) => {
    calls.push(body === undefined ? path : [path, body])
    if (state.fail > 0) {
      state.fail -= 1
      throw new Error('HTTP 404')
    }
    if (path === '/overview') return { ok: true, ...state.overview }
    if (path === '/jobs' && body === undefined) return { ok: true, jobs: state.jobs }
    if (path === '/jobs') {
      const jobs = body.jobs.map((item, index) => ({ id: `job${state.jobs.length + index}`, phase: 'queued', ...item }))
      state.jobs = [...jobs, ...state.jobs]
      return { ok: true, jobs }
    }
    if (path === '/jobs/retry' || path === '/jobs/dismiss' || path === '/check') return { ok: true }
    if (path.startsWith('/commits')) return { ok: true, status: null }
    throw new Error(`unexpected ${path}`)
  }
  return {
    calls,
    state,
    timers,
    deps: {
      request,
      schedule: (fn) => (timers.push(fn), timers.length),
      cancel: () => {},
      now: () => 0,
    },
    async tick() {
      const fn = timers.shift()
      if (fn) await fn()
    },
  }
}

test('enqueue posts the jobs, polls until they settle, then refreshes the overview', async () => {
  const { plugin } = loadBundle()
  const host = fakeHost()
  const hub = plugin.createHub(host.deps)
  await hub.refreshOverview()
  const [job] = await hub.enqueue([{ type: 'update', name: 'dsh-chat-reader', enabled: true }])
  assert.equal(job.phase, 'queued')
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.shared.jobs.map((item) => item.id))), ['job0'])
  assert.equal(host.timers.length, 1, 'polling started')
  host.state.jobs = [{ ...job, phase: 'installing' }]
  await host.tick()
  assert.equal(plugin.shared.jobs[0].phase, 'installing')
  assert.equal(host.timers.length, 1, 'still polling while active')
  host.state.jobs = [{ ...job, phase: 'done' }]
  const before = host.calls.filter((entry) => entry === '/overview').length
  await host.tick()
  assert.equal(plugin.shared.jobs[0].phase, 'done')
  assert.equal(host.timers.length, 0, 'polling stops when nothing is active')
  assert.equal(host.calls.filter((entry) => entry === '/overview').length, before + 1, 'the list is read again')
})

test('polling survives the API disappearing during this plugin’s own update', async () => {
  const { plugin } = loadBundle()
  const host = fakeHost()
  const hub = plugin.createHub(host.deps)
  host.state.jobs = [{ id: 'self', type: 'update', name: 'dsh-plugin-manager', self: true, phase: 'removing' }]
  await hub.start()
  assert.equal(host.timers.length, 1)
  host.state.fail = 2
  await host.tick()
  await host.tick()
  assert.equal(plugin.shared.jobs[0].phase, 'removing', 'last known state kept while the API is gone')
  assert.equal(host.timers.length, 1, 'still polling')
  host.state.jobs = [{ ...host.state.jobs[0], phase: 'done' }]
  await host.tick()
  assert.equal(plugin.shared.jobs[0].phase, 'done')
})

test('retry, dismiss, check and the detail page’s one-plugin check', async () => {
  const { plugin } = loadBundle()
  const host = fakeHost()
  const hub = plugin.createHub(host.deps)
  host.state.jobs = [{ id: 'j', phase: 'failed', type: 'update', name: 'x' }]
  await hub.refreshJobs()
  await hub.retry('j', true)
  await hub.dismiss('j')
  assert.equal(plugin.shared.jobs[0].dismissed, true, 'hidden at once')
  await hub.check(['dsh-chat-reader'], true)
  await hub.checkOne('dsh-chat-reader')
  await hub.checkOne('dsh-chat-reader')
  const posts = JSON.parse(JSON.stringify(host.calls.filter((entry) => Array.isArray(entry))))
  assert.deepEqual(posts, [
    ['/jobs/retry', { id: 'j', restore: true }],
    ['/jobs/dismiss', { id: 'j' }],
    ['/check', { force: true, names: ['dsh-chat-reader'] }],
  ])
  assert.equal(host.calls.filter((entry) => entry === '/commits?name=dsh-chat-reader').length, 1, 'one check per plugin per minute')
})

/* ── rendering ───────────────────────────────────────────────────────────── */

test('the Manage tab lists the rows and counts what can be updated', () => {
  const { plugin } = loadBundle()
  const hub = { refreshOverview() {}, refreshJobs() {} }
  plugin.shared.overview = null
  assert.match(text(plugin.ManageTab({ hub })), /正在读取/)
  plugin.shared.overview = { profile: 'web', plugins: [READER, TGZ, SELF_ROW, { ...READER, name: 'dsh-plugin-updater', legacy: true, check: undefined }] }
  plugin.shared.jobs = []
  const rendered = text(plugin.ManageTab({ hub }))
  assert.match(rendered, /全部更新（1）/)
  assert.match(rendered, /更新所选（0）/)
  assert.match(rendered, /dsh-chat-reader/)
  assert.match(rendered, /155b39f → 62fbe58（HEAD）/)
  assert.match(rendered, /有新提交/)
  assert.match(rendered, /本插件/)
  assert.match(rendered, /检测到旧插件 dsh-plugin-updater/)
  plugin.shared.jobs = [{ id: 'j', type: 'update', name: 'dsh-chat-reader', phase: 'installing' }]
  assert.match(text(plugin.ManageTab({ hub })), /全部更新（0）/, 'a plugin with a running job is not offered again')
  plugin.shared.overview = { profile: 'web', plugins: [] }
  assert.match(text(plugin.ManageTab({ hub })), /还没有安装第三方插件/)
})

test('the version dialog offers branches, tags, rollback and a custom source', () => {
  const { plugin } = loadBundle()
  const hub = { refs: () => new Promise(() => {}) }
  const rendered = text(plugin.VersionDialog({ row: READER, hub, onClose() {} }))
  assert.match(rendered, /正在读取分支和 tag/)
  assert.match(rendered, /回滚到更新前/)
  assert.match(rendered, /0\.0\.9 · 62fbe58/)
  assert.match(rendered, /自定义安装来源/)
  const tarball = text(plugin.VersionDialog({ row: TGZ, hub, onClose() {} }))
  assert.match(tarball, /不是 git 来源/)
})

test('the detail page: an Update button and a New commits badge', () => {
  const { plugin } = loadBundle()
  const hub = { ensureOverview() {}, checkOne() {}, enqueue() {} }
  plugin.shared.overview = { profile: 'web', plugins: [READER, TGZ] }
  plugin.shared.jobs = []
  assert.match(text(plugin.UpdateAction({ subject: subjectOf(READER), hub })), /更新/)
  assert.equal(plugin.UpdateAction({ subject: subjectOf({ name: 'unknown' }), hub }), null)
  assert.equal(plugin.UpdateAction({ subject: subjectOf(READER) }), null, 'no hub, no button')
  plugin.shared.jobs = [{ id: 'j', type: 'update', name: 'dsh-chat-reader', phase: 'removing' }]
  assert.match(text(plugin.UpdateAction({ subject: subjectOf(READER), hub })), /更新中/)
  const badge = plugin.CommitBadge({ subject: subjectOf(READER), hub })
  assert.match(text(badge), /有新提交/)
  assert.match(badge.props.title, /155b39f.*62fbe58/)
  assert.equal(plugin.CommitBadge({ subject: subjectOf(TGZ), hub }), null, 'not for tarballs')
  plugin.shared.overview = { profile: 'web', plugins: [{ ...READER, check: { behind: false } }] }
  assert.equal(plugin.CommitBadge({ subject: subjectOf(READER), hub }), null)
})

test('the progress panel: before / after, retry install, restore, interrupted', () => {
  const { plugin } = loadBundle()
  const hub = { retry() {}, dismiss() {} }
  const done = text(plugin.JobPanel({ job: { id: 'a', type: 'update', name: 'dsh-chat-reader', spec: READER.source, phase: 'done', removed: true, enabled: true, before: { commit: OLD }, after: { commit: NEW, version: '0.1.0' } }, hub }))
  assert.match(done, /「dsh-chat-reader」已更新/)
  assert.match(done, /提交 155b39f → 62fbe58/)
  assert.match(done, /插件保持启用/)
  const failedSwitch = text(
    plugin.JobPanel({
      job: { id: 'b', type: 'switch', name: 'r', spec: 'github:o/r#dev', previousSpec: 'github:o/r', phase: 'failed', failedStage: 'install', removed: true, failure: { code: 'operation-error', kind: 'not-found' } },
      hub,
    }),
  )
  assert.match(failedSwitch, /找不到这个包或仓库/)
  assert.match(failedSwitch, /还没有装回来/)
  assert.match(failedSwitch, /恢复原来的版本/)
  assert.match(failedSwitch, /重试安装/)
  const removeFailed = text(plugin.JobPanel({ job: { id: 'c', type: 'update', name: 'x', spec: 's', phase: 'failed', failedStage: 'remove', removed: false, failure: { code: 'bundle-in-use' } }, hub }))
  assert.match(removeFailed, /插件保持原样/)
  assert.match(removeFailed, /重试/)
  assert.doesNotMatch(removeFailed, /重试安装/)
  const interrupted = text(plugin.JobPanel({ job: { id: 'd', type: 'update', name: 'x', spec: 's', phase: 'interrupted', removed: true }, hub }))
  assert.match(interrupted, /被中断/)
  assert.match(interrupted, /DSH 在任务进行中重启了/)
  const self = text(plugin.JobPanel({ job: { id: 'e', type: 'update', name: 'dsh-plugin-manager', spec: 's', phase: 'installing', removed: true, self: true }, hub }))
  assert.match(self, /dsh-plugin-manager 自己的更新/)
})

test('the overlay shows active jobs first and hides dismissed ones', () => {
  const { plugin } = loadBundle()
  const hub = { retry() {}, dismiss() {} }
  plugin.shared.jobs = [
    { id: 'new', type: 'update', name: 'b', spec: 's', phase: 'queued' },
    { id: 'old', type: 'update', name: 'a', spec: 's', phase: 'installing', removed: true },
    { id: 'gone', type: 'update', name: 'c', spec: 's', phase: 'done', dismissed: true },
    { id: 'fin', type: 'update', name: 'd', spec: 's', phase: 'done', removed: true },
  ]
  const overlay = plugin.JobsOverlay({ hub })
  assert.deepEqual(overlay.children[0].map((panel) => panel.props.job.id), ['old', 'new', 'fin'])
  plugin.shared.jobs = [{ id: 'gone', phase: 'done', dismissed: true }]
  assert.equal(plugin.JobsOverlay({ hub }), null)
  assert.equal(plugin.JobsOverlay({}), null)
})

test('flaky networks: the check step, an unreachable host, automatic install retries', () => {
  const { plugin } = loadBundle()
  const hub = { retry() {}, dismiss() {} }
  assert.equal(plugin.stepState({ type: 'update', phase: 'checking', preflight: true }, 'check'), 'running')
  assert.equal(plugin.stepState({ type: 'update', phase: 'removing', preflight: true }, 'check'), 'done')
  assert.equal(plugin.stepState({ type: 'update', phase: 'installing' }, 'check'), null, 'no check for non-git sources')
  const unreachable = { id: 'u', type: 'update', name: 'r', spec: 'github:o/r', phase: 'failed', failedStage: 'preflight', preflight: true, checkTries: 3, removed: false, failure: { code: 'unreachable', url: 'https://github.com/o/r.git', attempts: 3, diagnostic: 'LibreSSL SSL_connect: SSL_ERROR_SYSCALL' } }
  assert.equal(plugin.stepState(unreachable, 'check'), 'failed')
  assert.equal(plugin.stepState(unreachable, 'remove'), 'skipped')
  assert.equal(plugin.stepState(unreachable, 'install'), 'skipped')
  const panel = text(plugin.JobPanel({ job: unreachable, hub }))
  assert.match(panel, /检查能否访问安装来源（第 3 次）/)
  assert.match(panel, /连不上 https:\/\/github\.com\/o\/r\.git（已试 3 次）/)
  assert.match(panel, /还没有卸载，插件保持原样/)
  assert.match(panel, /重试/)
  assert.doesNotMatch(panel, /重试安装/)
  const retried = text(plugin.JobPanel({ job: { id: 'v', type: 'update', name: 'r', spec: 's', phase: 'done', removed: true, preflight: true, installTries: 2, enabled: true }, hub }))
  assert.match(retried, /已自动重试 1 次/)
})
