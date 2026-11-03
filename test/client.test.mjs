// The browser bundle: one ModuleLoader registration that requires only `react`,
// the three slot registrations, which sources get the button, and the order the
// update calls the plugin manager in (against a fake remote).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useSyncExternalStore: (subscribe, get) => get(),
}

function loadBundle({ fetch } = {}) {
  const registrations = []
  const required = []
  const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  const appended = []
  const sandbox = {
    window,
    document: {
      createElement: () => ({ dataset: {}, remove() {} }),
      head: { append: (element) => appended.push(element) },
    },
    fetch: fetch || (() => Promise.reject(new Error('network disabled in tests'))),
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

/** Fake `ctx.remote.pluginManager` that records every call in order. */
function fakeRemote(overrides = {}) {
  const calls = []
  const remote = {
    calls,
    listBundles: async () => (calls.push(['listBundles']), { ok: true, value: overrides.bundles ?? [] }),
    removeBundle: async (name) => {
      calls.push(['removeBundle', name])
      return overrides.remove ? overrides.remove(name) : { ok: true, value: { changed: true, application: 'applied', stage: 'remove', target: name } }
    },
    installBundle: async (spec, options) => {
      calls.push(['installBundle', spec, options])
      return overrides.install
        ? overrides.install(spec, options)
        : { ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: spec, bundle: 'dsh-chat-reader', version: '0.1.1', enabled: options.enabled } }
    },
    waitForInstall: async (requestId) => {
      calls.push(['waitForInstall', requestId])
      return overrides.wait ? overrides.wait(requestId) : { ok: true, value: null }
    },
  }
  return remote
}

const READER = {
  name: 'dsh-chat-reader',
  official: false,
  availability: 'profile',
  installed: true,
  enabled: true,
  optional: false,
  removable: true,
  source: 'github:luyang950/dsh-chat-reader',
  rows: [],
  overrides: [],
}

function subjectOf(bundle, extra = {}) {
  return {
    kind: 'bundle',
    pkg: {
      name: bundle.name,
      installed: bundle.installed,
      availability: bundle.availability,
      official: bundle.official,
      enabled: bundle.enabled,
      rows: [],
      ...extra,
    },
  }
}

/* ── loader contract ─────────────────────────────────────────────────────── */

test('registers one ModuleLoader module that requires only react', () => {
  const { registration, plugin, required } = loadBundle()
  assert.equal(registration.id, 'dsh-plugin-updater')
  assert.equal(plugin.name, 'dsh-plugin-updater')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(required, ['react'])
  assert.deepEqual([...plugin.inject], ['slots', 'locale', 'remote', 'remote.pluginManager'])
})

test('the bundle is plain script: no import / export / require of anything but react at load', () => {
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
  const remote = fakeRemote()
  const ctx = {
    effect: (run, label) => effects.push({ run, label }),
    locale: { register: (ns, dictionaries) => (locales.push({ ns, dictionaries }), () => {}) },
    remote: {
      pluginManager: remote,
      $on: (event, fn) => ((listeners[event] = fn), () => delete listeners[event]),
    },
    slots: {
      inject: (key, run) => slots.push({ key, ...captured(run) }),
      register: (options, component) => ({ options, component }),
    },
  }
  function captured(run) {
    const result = run()
    return { options: result.options, component: result.component }
  }
  loaded.plugin.apply(ctx)
  const disposers = effects.map((effect) => effect.run())
  return Object.assign(loaded, { effects, slots, listeners, locales, disposers, remote })
}

test('apply registers the detail action, the detail badge and the overlay', () => {
  const { slots, plugin, locales, listeners, appended } = mount()
  assert.deepEqual(
    slots.map((slot) => slot.key),
    ['plugins.detail.actions', 'plugins.detail.badge', 'shell.overlay'],
  )
  for (const slot of slots) {
    assert.equal(slot.options.name, slot.key, 'registers under the slot it injects')
    assert.equal(slot.options.id, 'dsh-plugin-updater')
    assert.equal(slot.options.locale, 'dshPluginUpdater')
    assert.equal(typeof slot.options.inject().updater.start, 'function')
  }
  assert.equal(slots[0].component, plugin.UpdateAction)
  assert.equal(slots[1].component, plugin.CommitBadge)
  assert.equal(slots[2].component, plugin.JobsOverlay)
  assert.equal(locales.length, 1)
  assert.equal(locales[0].ns, 'dshPluginUpdater')
  assert.deepEqual(Object.keys(locales[0].dictionaries), ['zh', 'en'])
  assert.deepEqual(Object.keys(listeners).sort(), ['plugin-manager/changed', 'plugin-manager/install-log', 'plugin-manager/install-state'])
  assert.equal(appended.length, 1, 'one stylesheet')
})

test('host-event listeners are released with the effect', () => {
  const { disposers, listeners } = mount()
  for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  assert.deepEqual(Object.keys(listeners), [])
})

/* ── which sources get the button ────────────────────────────────────────── */

test('classifySource sorts the specs pnpm records', () => {
  const { plugin } = loadBundle()
  const cases = [
    ['github:luyang950/dsh-chat-reader', 'github'],
    ['github:luyang950/dsh-chat-reader#main', 'github'],
    ['luyang950/dsh-chat-reader', 'github'],
    ['git+https://github.com/luyang950/dsh-chat-reader.git', 'github'],
    ['https://github.com/luyang950/dsh-chat-reader', 'github'],
    ['git+ssh://git@github.com/luyang950/dsh-chat-reader.git#v1', 'github'],
    ['git@github.com:luyang950/dsh-chat-reader.git', 'github'],
    ['dsh-chat-reader@github:luyang950/dsh-chat-reader', 'github'],
    ['https://github.com/o/r/archive/refs/heads/main.tar.gz', 'tarball'],
    ['gitlab:group/project', 'git'],
    ['git+https://gitlab.com/group/project.git', 'git'],
    ['git@gitlab.com:group/project.git', 'git'],
    ['https://git.example.com/team/plugin.git#main', 'git'],
    ['file:/Users/me/dev/plugin', 'path'],
    ['link:/Users/me/dev/plugin', 'path'],
    ['/Users/me/dev/plugin', 'path'],
    ['file:/Users/me/Downloads/plugin-0.1.1.tgz', 'tarball'],
    ['https://example.com/plugin-1.0.0.tgz', 'tarball'],
    ['dsh-foo@^1.2.0', 'registry'],
    ['@acme/dsh-foo@1.2.0', 'registry'],
    ['', null],
    [undefined, null],
  ]
  for (const [spec, kind] of cases) {
    const name = spec && spec.startsWith('@acme/') ? '@acme/dsh-foo' : spec && spec.startsWith('dsh-foo@') ? 'dsh-foo' : undefined
    assert.equal(plugin.classifySource(spec, name), kind, String(spec))
  }
})

test('updateTarget offers GitHub / git / path / tarball third-party bundles only', () => {
  const { plugin } = loadBundle()
  const offer = (bundle, pkgExtra) => plugin.updateTarget(subjectOf(bundle, pkgExtra), [bundle])

  assert.deepEqual(JSON.parse(JSON.stringify(offer(READER))), {
    name: 'dsh-chat-reader',
    spec: 'github:luyang950/dsh-chat-reader',
    enabled: true,
    kind: 'github',
  })
  assert.equal(offer({ ...READER, source: 'file:/tmp/p.tgz', name: 'p' }).kind, 'tarball')
  assert.equal(offer({ ...READER, source: 'link:/dev/p', name: 'p' }).kind, 'path')
  assert.equal(offer({ ...READER, source: 'git+https://gitlab.com/a/b.git', name: 'b' }).kind, 'git')
  assert.equal(offer({ ...READER, enabled: false }).enabled, false, 'keeps a disabled bundle disabled')

  // Registry packages: no button.
  assert.equal(offer({ ...READER, source: 'dsh-chat-reader@^0.1.0' }), null)
  // Shipped with the installation / official / optional / on-demand official.
  assert.equal(offer({ ...READER, availability: 'installation', source: undefined }), null)
  assert.equal(offer({ ...READER, official: true }), null)
  assert.equal(offer({ ...READER, optional: true }), null)
  assert.equal(offer({ ...READER, official: true, installTarget: { spec: 'x@1', version: '1' } }), null)
  // Not installed, not removable, protected.
  assert.equal(offer({ ...READER, installed: false }), null)
  assert.equal(offer({ ...READER, removable: false }), null)
  assert.equal(offer({ ...READER, readOnlyReason: 'management-required' }), null)
  // No recorded source.
  assert.equal(offer({ ...READER, source: undefined }), null)
  // The updater never offers to update itself.
  assert.equal(offer({ ...READER, name: 'dsh-plugin-updater', source: 'github:luyang950/dsh-plugin-updater' }), null)
  // Other subjects and missing data.
  assert.equal(plugin.updateTarget({ kind: 'row', pkg: subjectOf(READER).pkg, row: {} }, [READER]), null)
  assert.equal(plugin.updateTarget({ kind: 'item', id: 'subagent' }, [READER]), null)
  assert.equal(plugin.updateTarget(subjectOf(READER), null), null, 'nothing before listBundles answers')
  assert.equal(plugin.updateTarget(subjectOf(READER), [{ ...READER, name: 'other' }]), null)
})

test('UpdateAction renders a button only for an updatable bundle', () => {
  const { plugin } = loadBundle()
  const updater = { ensureBundles: () => {}, start: () => {} }
  plugin.shared.bundles = [READER, { ...READER, name: 'dsh-registry', source: 'dsh-registry@1.0.0' }]
  const rendered = plugin.UpdateAction({ subject: subjectOf(READER), updater })
  assert.ok(rendered, 'renders for the GitHub bundle')
  assert.equal(plugin.UpdateAction({ subject: subjectOf({ ...READER, name: 'dsh-registry' }), updater }), null)
  assert.equal(plugin.UpdateAction({ subject: { kind: 'item', id: 'x' }, updater }), null)
  assert.equal(plugin.UpdateAction({ subject: subjectOf(READER) }), null, 'no updater, no button')
})

/* ── update flow ─────────────────────────────────────────────────────────── */

test('runUpdate removes, then installs the original spec with the original enabled state', async () => {
  const { plugin } = loadBundle()
  const remote = fakeRemote()
  const steps = []
  const result = await plugin.runUpdate(
    remote,
    { name: 'dsh-chat-reader', spec: 'github:luyang950/dsh-chat-reader', enabled: true },
    { requestId: 'req-1', step: (phase) => steps.push(phase), removed: () => steps.push('removed!'), request: (id) => steps.push(`request:${id}`) },
  )
  assert.deepEqual(JSON.parse(JSON.stringify(remote.calls)), [
    ['removeBundle', 'dsh-chat-reader'],
    ['installBundle', 'github:luyang950/dsh-chat-reader', { enabled: true, requestId: 'req-1' }],
  ])
  assert.deepEqual(steps, ['removing', 'removed!', 'installing', 'request:req-1'])
  assert.equal(result.phase, 'done')
  assert.equal(result.version, '0.1.1')
  assert.equal(result.removed, true)
})

test('runUpdate keeps a disabled bundle disabled and generates a request id', async () => {
  const { plugin } = loadBundle()
  const remote = fakeRemote()
  await plugin.runUpdate(remote, { name: 'p', spec: 'file:/tmp/p.tgz', enabled: false })
  const install = remote.calls.find((call) => call[0] === 'installBundle')
  assert.equal(install[2].enabled, false)
  assert.match(install[2].requestId, /^dsh-plugin-updater-/)
})

test('a failed removal stops before installing', async () => {
  const { plugin } = loadBundle()
  const remote = fakeRemote({
    remove: () => ({ ok: true, value: { changed: false, application: 'failed', stage: 'remove', target: 'p', error: { code: 'operation-error', diagnostic: 'pnpm remove exploded' } } }),
  })
  const result = await plugin.runUpdate(remote, { name: 'p', spec: 'github:o/p', enabled: true })
  assert.deepEqual(remote.calls.map((call) => call[0]), ['removeBundle'])
  assert.equal(result.phase, 'failed')
  assert.equal(result.failedStage, 'remove')
  assert.equal(result.removed, false)
  assert.equal(result.failure.code, 'operation-error')
})

test('stop-profile (no HMR) still installs over the running bundle, like DSH’s own Update', async () => {
  const { plugin } = loadBundle()
  const remote = fakeRemote({
    remove: () => ({ ok: true, value: { changed: false, application: 'restart-required', stage: 'remove', target: 'p', error: { code: 'stop-profile' } } }),
  })
  const result = await plugin.runUpdate(remote, { name: 'p', spec: 'github:o/p', enabled: true })
  assert.deepEqual(remote.calls.map((call) => call[0]), ['removeBundle', 'installBundle'])
  assert.equal(result.phase, 'done')
  assert.equal(result.removed, false)
})

test('a failed install after the removal reports the plugin as removed', async () => {
  const { plugin } = loadBundle()
  const remote = fakeRemote({
    install: () => ({
      ok: true,
      value: {
        changed: false,
        application: 'failed',
        stage: 'install',
        target: 'github:o/p',
        error: { code: 'operation-error' },
        packageResult: { exitCode: 1, output: 'line1\nERR_PNPM_FETCH network down', truncated: false, logPath: '/x', kind: 'network' },
      },
    }),
  })
  const result = await plugin.runUpdate(remote, { name: 'p', spec: 'github:o/p', enabled: true })
  assert.equal(result.phase, 'failed')
  assert.equal(result.failedStage, 'install')
  assert.equal(result.removed, true)
  assert.equal(result.failure.kind, 'network')
  assert.match(result.failure.output, /network down/)
  assert.match(plugin.describeFailure(result.failure), /网络连不上/)
})

test('a lost install reply is recovered through waitForInstall', async () => {
  const { plugin } = loadBundle()
  const remote = fakeRemote({
    install: () => ({ ok: false, error: { message: 'connection reset' } }),
    wait: () => ({ ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: 'github:o/p', version: '2.0.0' } }),
  })
  const result = await plugin.runUpdate(remote, { name: 'p', spec: 'github:o/p', enabled: true }, { requestId: 'r' })
  assert.deepEqual(remote.calls.map((call) => call[0]), ['removeBundle', 'installBundle', 'waitForInstall'])
  assert.equal(result.phase, 'done')
  assert.equal(result.version, '2.0.0')
})

test('describeFailure names transport errors, codes and blocked builds', () => {
  const { plugin } = loadBundle()
  assert.match(plugin.describeFailure({ code: 'transport', message: 'socket closed' }), /socket closed/)
  assert.match(plugin.describeFailure({ code: 'incompatible-version' }), /不兼容/)
  assert.match(plugin.describeFailure({ code: 'weird-new-code' }), /weird-new-code/)
  assert.match(plugin.describeFailure({ code: 'failed', kind: 'build-blocked', pendingBuilds: ['esbuild'] }), /esbuild/)
  const en = (key, params) => plugin.format(plugin.EN[key] ?? key, params)
  assert.match(plugin.describeFailure({ code: 'cancelled' }, en), /cancelled/)
})

/* ── the long-lived updater (jobs survive the page) ──────────────────────── */

function waitFor(predicate, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > 2000) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 5)
    }
    tick()
  })
}

test('updater.start runs remove → install, streams the log, and records commits', async () => {
  const { plugin } = loadBundle()
  const statuses = [
    { kind: 'github', locked: '155b39fbe980de42e4281ee5a510e16328fe5489', remote: '62fbe5878728bf9faac182d6578ba3c10e880fc2', behind: true },
    { kind: 'github', locked: '62fbe5878728bf9faac182d6578ba3c10e880fc2', remote: '62fbe5878728bf9faac182d6578ba3c10e880fc2', behind: false },
  ]
  const queries = []
  let updater
  const remote = fakeRemote({
    bundles: [READER],
    install: (spec, options) => {
      updater.onLog({ requestId: options.requestId, jobId: 'j1', argv: ['pnpm', 'add', spec], text: 'Progress: resolved 1\n' })
      updater.onState({ requestId: options.requestId, phase: 'applying' })
      return { ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: spec, version: '0.1.0', enabled: true } }
    },
  })
  updater = plugin.createUpdater({
    pluginManager: () => remote,
    fetchStatus: async (query) => (queries.push(query), statuses.shift()),
  })
  const job = updater.start({ name: 'dsh-chat-reader', spec: READER.source, enabled: true, kind: 'github' })
  assert.equal(updater.start({ name: 'dsh-chat-reader', spec: READER.source, enabled: true, kind: 'github' }).id, job.id, 'one job per plugin')
  await job.done
  const [finished] = plugin.shared.jobs
  assert.equal(finished.phase, 'done')
  assert.equal(finished.before, '155b39fbe980de42e4281ee5a510e16328fe5489')
  assert.equal(finished.after, '62fbe5878728bf9faac182d6578ba3c10e880fc2')
  assert.match(finished.log, /\$ pnpm add github:luyang950\/dsh-chat-reader\nProgress: resolved 1/)
  assert.deepEqual(queries, ['/commits?name=dsh-chat-reader', '/commits?name=dsh-chat-reader&refresh=1'])
  assert.deepEqual(remote.calls.map((call) => call[0]), ['removeBundle', 'installBundle', 'listBundles'])
  assert.equal(plugin.shared.commits['dsh-chat-reader'].behind, false, 'the badge clears')

  const panel = plugin.JobsOverlay({ updater, t: undefined })
  assert.ok(panel, 'the overlay shows the finished job')
  updater.dismiss(finished.id)
  assert.equal(plugin.shared.jobs.length, 0)
  assert.equal(plugin.JobsOverlay({ updater }), null)
})

test('retry after a failed install only installs again', async () => {
  const { plugin } = loadBundle()
  let attempt = 0
  const remote = fakeRemote({
    install: () => {
      attempt += 1
      return attempt === 1
        ? { ok: true, value: { changed: false, application: 'failed', stage: 'install', target: 'x', error: { code: 'operation-error' }, packageResult: { exitCode: 1, output: 'boom', truncated: false, logPath: '/l', kind: 'network' } } }
        : { ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: 'x', version: '1.0.1' } }
    },
  })
  const updater = plugin.createUpdater({ pluginManager: () => remote, fetchStatus: async () => ({ kind: 'other' }) })
  const job = updater.start({ name: 'p', spec: 'file:/tmp/p.tgz', enabled: true, kind: 'tarball' })
  await job.done
  let current = plugin.shared.jobs[0]
  assert.equal(current.phase, 'failed')
  assert.equal(current.removed, true)
  assert.equal(plugin.stepState(current, 'remove'), 'done')
  assert.equal(plugin.stepState(current, 'install'), 'failed')
  const rendered = JSON.stringify(plugin.JobPanel({ job: current, updater, t: undefined }))
  assert.match(rendered, /重试安装/)
  assert.match(rendered, /还没有装回来/)

  await updater.retry(current.id)
  current = plugin.shared.jobs[0]
  assert.equal(current.phase, 'done')
  assert.equal(current.version, '1.0.1')
  assert.deepEqual(remote.calls.map((call) => call[0]), ['removeBundle', 'installBundle', 'listBundles', 'installBundle', 'listBundles'])
})

test('retry after a failed removal runs the whole update again', async () => {
  const { plugin } = loadBundle()
  let attempt = 0
  const remote = fakeRemote({
    remove: (name) => {
      attempt += 1
      return attempt === 1
        ? { ok: false, error: { message: 'offline' } }
        : { ok: true, value: { changed: true, application: 'applied', stage: 'remove', target: name } }
    },
  })
  const updater = plugin.createUpdater({ pluginManager: () => remote, fetchStatus: async () => ({ kind: 'other' }) })
  await updater.start({ name: 'p', spec: 'link:/dev/p', enabled: false, kind: 'path' }).done
  const failed = plugin.shared.jobs[0]
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.removed, false)
  assert.match(JSON.stringify(plugin.JobPanel({ job: failed, updater })), /插件保持原样/)
  await updater.retry(failed.id)
  assert.deepEqual(remote.calls.map((call) => call[0]), ['removeBundle', 'listBundles', 'removeBundle', 'installBundle', 'listBundles'])
  assert.equal(plugin.shared.jobs[0].phase, 'done')
})

test('a running job cannot be dismissed and logs of other requests are ignored', async () => {
  const { plugin } = loadBundle()
  let release
  const remote = fakeRemote({ remove: () => new Promise((resolve) => (release = () => resolve({ ok: true, value: { changed: true, application: 'applied', stage: 'remove', target: 'p' } }))) })
  const updater = plugin.createUpdater({ pluginManager: () => remote, fetchStatus: async () => ({ kind: 'other' }) })
  const job = updater.start({ name: 'p', spec: 'link:/dev/p', enabled: true, kind: 'path' })
  await waitFor(() => typeof release === 'function', 'removeBundle')
  updater.dismiss(job.id)
  assert.equal(plugin.shared.jobs.length, 1)
  updater.onLog({ requestId: 'someone-else', jobId: 'x', argv: ['pnpm'], text: 'nope' })
  assert.equal(plugin.shared.jobs[0].log, '')
  release()
  await job.done
  assert.equal(plugin.shared.jobs[0].phase, 'done')
})

test('CommitBadge shows only when the GitHub ref moved past the locked commit', () => {
  const { plugin } = loadBundle()
  const checked = []
  const updater = { ensureBundles: () => {}, checkCommits: (name) => checked.push(name) }
  plugin.shared.bundles = [READER, { ...READER, name: 'tgz', source: 'file:/tmp/t.tgz' }]
  assert.equal(plugin.CommitBadge({ subject: subjectOf(READER), updater }), null, 'nothing known yet')
  plugin.shared.commits = { 'dsh-chat-reader': { kind: 'github', locked: 'a'.repeat(40), remote: 'b'.repeat(40), ref: 'HEAD', behind: true } }
  const badge = plugin.CommitBadge({ subject: subjectOf(READER), updater })
  assert.ok(badge)
  assert.match(JSON.stringify(badge), /有新提交/)
  assert.match(badge.props.title, /aaaaaaa.*bbbbbbb/)
  plugin.shared.commits = { 'dsh-chat-reader': { kind: 'github', behind: false } }
  assert.equal(plugin.CommitBadge({ subject: subjectOf(READER), updater }), null)
  plugin.shared.commits = { tgz: { behind: true } }
  assert.equal(plugin.CommitBadge({ subject: subjectOf({ ...READER, name: 'tgz' }), updater }), null, 'not for tarballs')
})

test('ensureBundles re-reads listBundles for a package the cached list does not know', async () => {
  const { plugin } = loadBundle()
  const remote = fakeRemote({ bundles: [READER] })
  const updater = plugin.createUpdater({ pluginManager: () => remote, fetchStatus: async () => ({ kind: 'other' }) })
  await updater.ensureBundles('dsh-chat-reader')
  await updater.ensureBundles('dsh-chat-reader')
  assert.equal(remote.calls.length, 1, 'a known package uses the cache')
  await updater.ensureBundles('installed-from-the-cli')
  assert.equal(remote.calls.length, 2, 'an unknown one reads again')
})

test('describeFailure quotes the line of pnpm output that names the error', () => {
  const { plugin } = loadBundle()
  const failure = plugin.operationFailure({
    ok: true,
    value: {
      changed: false,
      application: 'failed',
      stage: 'install',
      target: 'file:/tmp/gone.tgz',
      error: { code: 'operation-error', diagnostic: '✓ Lockfile passes supply-chain policies\nProgress: resolved 0\n[ENOENT] ENOENT: no such file or directory, open \'/tmp/gone.tgz\'\n' },
      packageResult: { exitCode: 1, output: 'Progress: resolved 0\n[ENOENT] ENOENT: no such file', truncated: false, logPath: '/l', kind: 'unknown' },
    },
  })
  const text = plugin.describeFailure(failure)
  assert.match(text, /pnpm 执行失败/)
  assert.match(text, /\[ENOENT\] ENOENT: no such file or directory, open '\/tmp\/gone\.tgz'/)
  assert.doesNotMatch(text, /Progress:/)
})
