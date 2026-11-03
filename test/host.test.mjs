// Host half: spec parsing, lockfile and ls-remote reading, the profile views
// (rows, export / import plan, diagnostics), the store, the job queue against a fake
// plugin manager, and the HTTP API. Nothing touches the network or a real DSH.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { API_PREFIX, apply, inject, name } from '../index.mjs'
import { createApi } from '../lib/api.mjs'
import { gitLsRemote, isNetworkError, listRemoteRefs, lockedCommit, lockedEntry, parseRefs, pickRemoteCommit, remoteStatus, resolveRef } from '../lib/git.mjs'
import { cleanLogs, exportManifest, importPlan, listLogs, pluginRows, problems, readLog } from '../lib/inventory.mjs'
import { createJobs, failureOf, runnerState } from '../lib/jobs.mjs'
import { classifySource, gitRemote, specWithRef, validRef } from '../lib/sources.mjs'
import { createStore } from '../lib/store.mjs'
import { NEW, OLD, SOURCE_CASES, call, caseName, fakeProfile, tempDir, until } from './helpers.mjs'

test('module shape', () => {
  assert.equal(name, 'dsh-plugin-manager')
  assert.deepEqual(inject, [])
  assert.equal(API_PREFIX, '/dsh-plugin-manager/api')
})

/* ── sources ─────────────────────────────────────────────────────────────── */

test('classifySource sorts the specs pnpm records', () => {
  for (const [spec, kind] of SOURCE_CASES) assert.equal(classifySource(spec, caseName(spec)), kind, String(spec))
})

test('gitRemote finds the repository and ref of every git form', () => {
  const plain = { github: true, owner: 'luyang950', repo: 'dsh-chat-reader', url: 'https://github.com/luyang950/dsh-chat-reader.git', web: 'https://github.com/luyang950/dsh-chat-reader', ref: '' }
  for (const spec of [
    'github:luyang950/dsh-chat-reader',
    'luyang950/dsh-chat-reader',
    'git+https://github.com/luyang950/dsh-chat-reader.git',
    'git+ssh://git@github.com/luyang950/dsh-chat-reader.git',
    'git@github.com:luyang950/dsh-chat-reader.git',
    'dsh-chat-reader@github:luyang950/dsh-chat-reader',
  ]) {
    assert.deepEqual(gitRemote(spec), plain, spec)
  }
  assert.equal(gitRemote('github:luyang950/dsh-chat-reader#dev').ref, 'dev')
  assert.deepEqual(gitRemote('github:o/r#semver:^1.0.0'), { github: true, owner: 'o', repo: 'r', url: 'https://github.com/o/r.git', web: 'https://github.com/o/r', ref: '', range: '^1.0.0' })
  assert.deepEqual(gitRemote('gitlab:group/project#v2'), { github: false, url: 'https://gitlab.com/group/project.git', web: 'https://gitlab.com/group/project', ref: 'v2' })
  assert.equal(gitRemote('git+ssh://git@git.example.com/team/plugin.git').url, 'ssh://git@git.example.com/team/plugin.git')
  assert.equal(gitRemote('git@gitlab.com:group/project.git').url, 'git@gitlab.com:group/project.git')
  assert.equal(gitRemote('file:/tmp/x.tgz'), null)
  assert.equal(gitRemote('^1.2.3'), null)
  assert.equal(gitRemote('github:o/r/extra'), null)
  assert.equal(gitRemote('github:o;rm -rf/r'), null, 'unsafe segments are refused')
})

test('specWithRef changes only #ref and keeps the recorded form', () => {
  assert.equal(specWithRef('github:o/r', 'dev'), 'github:o/r#dev')
  assert.equal(specWithRef('github:o/r#dev', ''), 'github:o/r')
  assert.equal(specWithRef('git+https://gitlab.com/g/p.git#main', OLD), `git+https://gitlab.com/g/p.git#${OLD}`)
  assert.equal(specWithRef('name@github:o/r', 'v1', 'name'), 'name@github:o/r#v1')
  assert.throws(() => specWithRef('file:/tmp/x.tgz', 'dev'), /git/)
  assert.throws(() => specWithRef('github:o/r', '--upload-pack=evil'), /无效/)
  assert.equal(validRef('feature/x-1.2'), true)
  assert.equal(validRef('a..b'), false)
  assert.equal(validRef('-x'), false)
})

/* ── lockfile and ls-remote ──────────────────────────────────────────────── */

const LOCK_V9 = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@shimo/dsh-shimo-editors':
        specifier: file:/Users/me/Downloads/shimo-dsh-shimo-editors-0.1.1.tgz
        version: file:../../../Downloads/shimo-dsh-shimo-editors-0.1.1.tgz
      dsh-chat-reader:
        specifier: github:luyang950/dsh-chat-reader
        version: https://codeload.github.com/luyang950/dsh-chat-reader/tar.gz/${OLD}

packages:

  dsh-chat-reader@https://codeload.github.com/luyang950/dsh-chat-reader/tar.gz/${OLD}:
    resolution: {gitHosted: true, tarball: https://codeload.github.com/luyang950/dsh-chat-reader/tar.gz/${OLD}}
    version: 0.1.0
`

test('lockedCommit and lockedEntry read the importer of a v9 lockfile', () => {
  assert.equal(lockedCommit(LOCK_V9, 'dsh-chat-reader'), OLD)
  assert.deepEqual(lockedEntry(LOCK_V9, '@shimo/dsh-shimo-editors'), {
    specifier: 'file:/Users/me/Downloads/shimo-dsh-shimo-editors-0.1.1.tgz',
    version: 'file:../../../Downloads/shimo-dsh-shimo-editors-0.1.1.tgz',
  })
  assert.equal(lockedCommit(LOCK_V9, '@shimo/dsh-shimo-editors'), null, 'a tarball has no commit')
  assert.equal(lockedCommit(LOCK_V9, 'absent'), null)
  assert.equal(lockedCommit('', 'dsh-chat-reader'), null)
  const v6 = `lockfileVersion: '6.0'\n\ndependencies:\n  dsh-chat-reader@github.com/o/r/${OLD}:\n    version: x\n`
  assert.equal(lockedCommit(v6, 'dsh-chat-reader'), OLD)
})

const LS_REMOTE = `ref: refs/heads/main\tHEAD
${NEW}\tHEAD
${NEW}\trefs/heads/main
${OLD}\trefs/heads/dev
${'a'.repeat(40)}\trefs/tags/v1
${'b'.repeat(40)}\trefs/tags/v1^{}
${'c'.repeat(40)}\trefs/tags/v2
`

test('parseRefs reads the default branch, branches and peeled tags', () => {
  const refs = parseRefs(LS_REMOTE)
  assert.equal(refs.defaultBranch, 'main')
  assert.equal(refs.head, NEW)
  assert.deepEqual(refs.branches, [{ name: 'main', commit: NEW }, { name: 'dev', commit: OLD }])
  assert.deepEqual(refs.tags, [{ name: 'v2', commit: 'c'.repeat(40) }, { name: 'v1', commit: 'b'.repeat(40) }])
  assert.equal(resolveRef(refs, ''), NEW)
  assert.equal(resolveRef(refs, 'dev'), OLD)
  assert.equal(resolveRef(refs, 'v1'), 'b'.repeat(40))
  assert.equal(resolveRef(refs, 'nope'), null)
  assert.equal(pickRemoteCommit(LS_REMOTE, 'main'), NEW)
})

test('remoteStatus compares the locked commit with the ref it follows', async () => {
  const asked = []
  const lsRemote = async (url, args, options) => (asked.push([url, args, options.cwd]), LS_REMOTE)
  const behind = await remoteStatus({ source: 'github:luyang950/dsh-chat-reader', locked: OLD, cwd: '/p', lsRemote })
  assert.deepEqual(asked, [['https://github.com/luyang950/dsh-chat-reader.git', ['--symref'], '/p']])
  assert.equal(behind.behind, true)
  assert.equal(behind.remote, NEW)
  assert.equal(behind.ref, 'HEAD')
  assert.equal((await remoteStatus({ source: 'github:o/r#dev', locked: OLD, lsRemote })).behind, false)
  const pinned = await remoteStatus({ source: `github:o/r#${OLD}`, locked: OLD, lsRemote: async () => assert.fail('no git for a pin') })
  assert.equal(pinned.pinned, true)
  assert.equal((await remoteStatus({ source: 'github:o/r#semver:^1', locked: OLD, lsRemote })).error, 'semver 范围不做比较')
  const failed = await remoteStatus({ source: 'github:o/gone', locked: OLD, lsRemote: async () => { throw new Error('Repository not found') } })
  assert.equal(failed.behind, false)
  assert.match(failed.error, /Repository not found/)
  assert.deepEqual(await remoteStatus({ source: 'file:/tmp/x.tgz' }), { checked: false, behind: false })
  const refs = await listRemoteRefs({ source: 'github:o/r#dev', lsRemote: async () => LS_REMOTE })
  assert.equal(refs.ref, 'dev')
  assert.equal(refs.branches.length, 2)
  await assert.rejects(listRemoteRefs({ source: 'file:/tmp/x.tgz' }), /git/)
})

/* ── profile views ───────────────────────────────────────────────────────── */

const BUNDLES = [
  { name: '@deepseek-ai/dsh-base', official: false, availability: 'installation', installed: false, enabled: true, removable: false },
  { name: '@deepseek-ai/dsh-experimental-x', official: true, availability: 'installation', installed: false, enabled: false, optional: true, removable: false },
  { name: 'dsh-chat-reader', official: false, availability: 'profile', installed: true, enabled: true, removable: true, source: 'github:luyang950/dsh-chat-reader', version: '0.1.0', rows: [{}] },
  { name: 'p', official: false, availability: 'profile', installed: true, enabled: false, removable: true, source: 'file:/tmp/p.tgz', version: '1.0.0' },
  { name: 'dsh-plugin-manager', official: false, availability: 'profile', installed: true, enabled: true, removable: true, source: 'link:/dev/dsh-plugin-manager' },
  { name: 'dsh-plugin-updater', official: false, availability: 'profile', installed: true, enabled: true, removable: true, source: 'github:luyang950/dsh-plugin-updater' },
]

test('pluginRows lists only the third-party plugins, with source, lock and fresh checks', () => {
  const profile = { manifest: { dependencies: {} }, lockText: LOCK_V9 }
  const checks = {
    'dsh-chat-reader': { behind: true, remote: NEW, locked: OLD, source: 'github:luyang950/dsh-chat-reader', at: 1 },
    p: { behind: true, locked: 'stale', source: 'file:/tmp/p.tgz' },
  }
  const rows = pluginRows(BUNDLES, profile, { checks, history: { p: [{ spec: 'file:/tmp/p-0.9.tgz' }] } })
  assert.deepEqual(rows.map((row) => row.name), ['dsh-chat-reader', 'p', 'dsh-plugin-manager', 'dsh-plugin-updater'])
  const [reader, p, self, legacy] = rows
  assert.equal(reader.kind, 'github')
  assert.equal(reader.locked, OLD)
  assert.equal(reader.check.behind, true)
  assert.equal(reader.repo.url, 'https://github.com/luyang950/dsh-chat-reader.git')
  assert.equal(p.kind, 'tarball')
  assert.equal(p.check, undefined, 'a check for another commit / spec is dropped')
  assert.equal(p.history.length, 1)
  assert.equal(self.self, true)
  assert.equal(legacy.legacy, true)
})

test('exportManifest and importPlan round-trip and classify each entry', () => {
  const profile = { manifest: { dependencies: {} }, lockText: LOCK_V9 }
  const rows = pluginRows(BUNDLES, profile)
  const manifest = exportManifest(rows, { profile: 'desktop', now: () => Date.UTC(2026, 10, 3) })
  assert.equal(manifest.format, 'dsh-plugin-manager/plugins')
  assert.equal(manifest.exportedAt, '2026-11-03T00:00:00.000Z')
  assert.deepEqual(manifest.plugins[0], { name: 'dsh-chat-reader', spec: 'github:luyang950/dsh-chat-reader', enabled: true, kind: 'github', commit: OLD, version: '0.1.0' })

  const plan = importPlan(
    {
      format: 'dsh-plugin-manager/plugins',
      plugins: [
        { name: 'dsh-chat-reader', spec: 'github:luyang950/dsh-chat-reader', enabled: true },
        { name: 'p', spec: 'file:/elsewhere/p.tgz', enabled: true },
        { name: 'new-one', spec: 'github:o/new-one', enabled: false },
        { name: 'local', spec: 'link:/missing/dir', enabled: true },
        { name: 'new-one', spec: 'github:o/dup' },
        { name: '../evil', spec: 'github:o/r' },
        { name: 'flag', spec: '--registry=http://evil' },
      ],
    },
    rows,
    { pathExists: (path) => path !== '/missing/dir' && path !== '/elsewhere/p.tgz' },
  )
  const byName = {}
  for (const item of plan.items) byName[item.name] ??= item
  assert.equal(byName['dsh-chat-reader'].action, 'skip')
  assert.equal(byName.p.action, 'replace')
  assert.equal(byName.p.selected, false, 'a replacement is opt-in')
  assert.equal(byName.p.current, 'file:/tmp/p.tgz')
  assert.equal(byName['new-one'].action, 'install')
  assert.equal(byName['new-one'].selected, true)
  assert.equal(byName['new-one'].enabled, false)
  assert.equal(byName.local.reason, 'missing-path')
  assert.equal(byName.local.selected, false)
  assert.equal(plan.items.filter((item) => item.action === 'invalid').length, 3)
  assert.throws(() => importPlan({ plugins: [] }, rows), /导出/)
})

test('problems finds broken bundles and dependencies that are no plugin', () => {
  const bundles = [
    ...BUNDLES,
    { name: 'broken', official: false, availability: 'profile', installed: true, enabled: true, removable: true, error: { code: 'operation-error', diagnostic: 'SyntaxError' } },
    { name: 'gone', official: false, availability: 'missing', installed: true, enabled: false, removable: true },
  ]
  const result = problems(bundles, { manifest: { dependencies: { 'left-pad': '1.3.0', 'dsh-chat-reader': 'x' } } }, '/home/me/.dsh/profiles/desktop')
  assert.deepEqual(result.broken.map((item) => [item.name, item.code]), [['broken', 'operation-error'], ['gone', 'missing-files']])
  assert.deepEqual(result.stray, [{ name: 'left-pad', spec: '1.3.0', command: 'dsh plugin --profile desktop remove left-pad' }])
})

test('logs: one directory per operation, path-confined reads, age-based cleanup', async () => {
  const dir = await tempDir()
  const logs = join(dir, '.plugin-manager', 'logs')
  await mkdir(join(logs, 'operation-old'), { recursive: true })
  await mkdir(join(logs, 'operation-new'), { recursive: true })
  await writeFile(join(logs, 'operation-old', 'pnpm.log'), 'old run')
  await writeFile(join(logs, 'operation-new', 'pnpm.log'), 'new run')
  const longAgo = new Date(Date.now() - 40 * 24 * 3600 * 1000)
  await utimes(join(logs, 'operation-old', 'pnpm.log'), longAgo, longAgo)
  const list = await listLogs(dir)
  assert.deepEqual(list.map((log) => log.name), ['operation-new/pnpm.log', 'operation-old/pnpm.log'])
  assert.equal(await readLog(dir, 'operation-new/pnpm.log'), 'new run')
  await assert.rejects(readLog(dir, '../../package.json'), /无效/)
  await assert.rejects(readLog(dir, 'operation-new/../../x'), /无效/)
  await assert.rejects(readLog(dir, 'operation-none/pnpm.log'), /不存在/)
  assert.deepEqual(await cleanLogs(dir, 30), { removed: 1, bytes: 7 })
  assert.deepEqual(await readdir(logs), ['operation-new'])
})

/* ── store ───────────────────────────────────────────────────────────────── */

test('store keeps jobs newest first and history de-duplicated', async () => {
  const dir = await tempDir()
  const store = createStore(dir)
  await store.saveJob({ id: 'aaaaaa-000001', createdAt: 1, phase: 'done' })
  await store.saveJob({ id: 'aaaaab-000002', createdAt: 2, phase: 'done' })
  assert.deepEqual((await store.listJobs()).map((job) => job.id), ['aaaaab-000002', 'aaaaaa-000001'])
  assert.equal(await store.readJob('../../etc'), null)
  await store.recordHistory('x', { spec: 's', commit: OLD, at: 1 })
  await store.recordHistory('x', { spec: 's', commit: NEW, at: 2 })
  const list = await store.recordHistory('x', { spec: 's', commit: OLD, at: 3 })
  assert.deepEqual(list.map((entry) => [entry.commit, entry.at]), [[OLD, 3], [NEW, 2]])
})

/* ── job queue ───────────────────────────────────────────────────────────── */

async function queue(plugins, options = {}) {
  const profile = await fakeProfile(plugins, options)
  const store = createStore(profile.dir)
  const lsRemote = options.lsRemote ?? (async () => LS_REMOTE)
  const jobs = createJobs({ profileDir: profile.dir, store, pluginManager: () => profile.pluginManager, lsRemote, sleep: async () => {}, retryDelays: [0, 0] })
  const settled = (id) => until(async () => {
    const job = await store.readJob(id)
    return job && !['queued', 'removing', 'installing'].includes(job.phase) && !runnerState(profile.dir).live.has(id) ? job : null
  }, `job ${id}`)
  return { ...profile, store, jobs, settled }
}

test('update: remove, then install the recorded spec with the same enabled state', async () => {
  const q = await queue({ 'dsh-chat-reader': { spec: 'github:o/dsh-chat-reader', commit: OLD, version: '0.1.0', enabled: false } })
  const [queued] = await q.jobs.enqueue({ type: 'update', name: 'dsh-chat-reader', spec: 'github:attacker/evil', enabled: true })
  const job = await q.settled(queued.id)
  assert.deepEqual(
    q.calls.filter((entry) => entry[0] !== 'listBundles').map((entry) => entry.slice(0, 2)),
    [['removeBundle', 'dsh-chat-reader'], ['installBundle', 'github:o/dsh-chat-reader']],
    'the recorded spec and enabled state win over what the page sent',
  )
  const install = q.calls.find((entry) => entry[0] === 'installBundle')
  assert.equal(install[2].enabled, false)
  assert.match(install[2].requestId, /^dsh-plugin-manager-/)
  assert.equal(job.phase, 'done')
  assert.equal(job.before.commit, OLD)
  assert.equal(job.before.version, '0.1.0')
  assert.equal(job.after.commit, NEW)
  assert.equal(job.after.version, '0.2.0')
  const history = await q.store.readHistory()
  assert.equal(history['dsh-chat-reader'][0].commit, OLD)
  const checks = await q.store.readChecks()
  assert.equal(checks['dsh-chat-reader'].locked, NEW)
  assert.equal(checks['dsh-chat-reader'].behind, false, 'the list is current right after the update')
})

test('a failed install after the removal is retried as an install only', async () => {
  const q = await queue({ p: { spec: 'file:/tmp/p.tgz' } })
  q.hooks.nameOf = () => 'p'
  let attempts = 0
  q.hooks.install = () => {
    attempts += 1
    if (attempts === 1) {
      return {
        changed: false,
        application: 'failed',
        stage: 'install',
        target: 'file:/tmp/p.tgz',
        error: { code: 'operation-error', diagnostic: "[ENOENT] no such file '/tmp/p.tgz'" },
        packageResult: { exitCode: 1, output: 'Progress: 0\n[ENOENT] no such file', truncated: false, logPath: '/l', kind: 'unknown' },
      }
    }
    return undefined
  }
  const [queued] = await q.jobs.enqueue({ type: 'update', name: 'p' })
  const failed = await q.settled(queued.id)
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.failedStage, 'install')
  assert.equal(failed.removed, true)
  assert.equal(failed.failure.kind, 'unknown')
  assert.match(failed.failure.diagnostic, /ENOENT/)
  await q.jobs.retry(queued.id)
  const done = await q.settled(queued.id)
  assert.equal(done.phase, 'done')
  assert.equal(done.attempt, 1)
  assert.deepEqual(q.calls.filter((entry) => entry[0] !== 'listBundles').map((entry) => entry[0]), ['removeBundle', 'installBundle', 'installBundle'])
  await assert.rejects(q.jobs.retry(queued.id), /失败/)
})

test('switch by ref computes the spec on the host; restore reinstalls the previous one', async () => {
  const q = await queue({ r: { spec: 'github:o/r', commit: NEW } })
  q.hooks.install = (spec) => (spec.endsWith('#dev') ? { changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'operation-error' }, packageResult: { exitCode: 1, output: 'no such ref', truncated: false, logPath: '/l', kind: 'not-found' } } : undefined)
  const [queued] = await q.jobs.enqueue({ type: 'switch', name: 'r', ref: 'dev' })
  const failed = await q.settled(queued.id)
  assert.equal(failed.spec, 'github:o/r#dev')
  assert.equal(failed.previousSpec, 'github:o/r')
  assert.equal(failed.phase, 'failed')
  await q.jobs.retry(queued.id, { restore: true })
  const restored = await q.settled(queued.id)
  assert.equal(restored.phase, 'done')
  assert.equal(restored.restored, true)
  assert.equal(q.state.get('r').spec, 'github:o/r')
  await assert.rejects(q.jobs.enqueue({ type: 'switch', name: 'r', ref: '--upload-pack=x' }), /ref/)
})

test('rollback pins a commit; install and remove jobs', async () => {
  const q = await queue({ r: { spec: 'github:o/r', commit: NEW } })
  const [rollback] = await q.jobs.enqueue({ type: 'switch', name: 'r', ref: OLD })
  assert.equal((await q.settled(rollback.id)).after.commit, OLD)
  assert.equal(q.state.get('r').spec, `github:o/r#${OLD}`)
  const [imported] = await q.jobs.enqueue({ type: 'switch', name: 'r', spec: 'github:o/r', enabled: false, setEnabled: true })
  assert.equal((await q.settled(imported.id)).phase, 'done')
  assert.equal(q.state.get('r').enabled, false, 'an import applies the list’s enabled state')
  const [install] = await q.jobs.enqueue({ type: 'install', name: 'fresh', spec: 'github:o/fresh', enabled: false })
  assert.equal((await q.settled(install.id)).phase, 'done')
  assert.equal(q.state.get('fresh').enabled, false)
  const [remove] = await q.jobs.enqueue({ type: 'remove', name: 'fresh' })
  const removed = await q.settled(remove.id)
  assert.equal(removed.phase, 'done')
  assert.equal(q.state.has('fresh'), false)
  assert.equal(q.calls.filter((entry) => entry[0] === 'installBundle').length, 3, 'remove installs nothing')
})

test('a failed removal stops the job; stop-profile installs over the running bundle', async () => {
  const q = await queue({ a: { spec: 'github:o/a', commit: OLD }, b: { spec: 'github:o/b', commit: OLD } })
  q.hooks.remove = (target) =>
    target === 'a'
      ? { changed: false, application: 'failed', stage: 'remove', target, error: { code: 'bundle-in-use' } }
      : { changed: false, application: 'restart-required', stage: 'remove', target, error: { code: 'stop-profile' } }
  const [a] = await q.jobs.enqueue({ type: 'update', name: 'a' })
  const failed = await q.settled(a.id)
  assert.equal(failed.failedStage, 'remove')
  assert.equal(failed.removed, false)
  assert.equal(q.calls.some((entry) => entry[0] === 'installBundle'), false)
  q.state.delete('b') // what pnpm add would do to an installed package here
  const [b] = await q.jobs.enqueue({ type: 'update', name: 'b' })
  q.state.set('b', { spec: 'github:o/b', commit: OLD, version: '0.1.0', enabled: true })
  q.hooks.remove = (target) => ({ changed: false, application: 'restart-required', stage: 'remove', target, error: { code: 'stop-profile' } })
  q.hooks.install = (spec) => ({ changed: true, application: 'restart-required', restartReason: 'no-hmr', stage: 'install', target: spec, bundle: 'b', version: '0.2.0' })
  const done = await q.settled(b.id)
  assert.equal(done.phase, 'done')
  assert.equal(done.removed, false)
  assert.equal(done.application, 'restart-required')
})

test('a batch runs one job at a time with this plugin last', async () => {
  const q = await queue({
    'dsh-plugin-manager': { spec: 'link:/dev/dsh-plugin-manager' },
    a: { spec: 'github:o/a', commit: OLD },
    b: { spec: 'github:o/b', commit: OLD },
  })
  q.hooks.nameOf = (spec) => (spec.startsWith('link:') ? 'dsh-plugin-manager' : spec.replace(/^.*\//, ''))
  let running = 0
  let overlap = false
  const original = q.pluginManager.installBundle
  q.pluginManager.installBundle = async (...args) => {
    running += 1
    if (running > 1) overlap = true
    await new Promise((resolve) => setTimeout(resolve, 5))
    try {
      return await original(...args)
    } finally {
      running -= 1
    }
  }
  const jobs = await q.jobs.enqueue([{ type: 'update', name: 'dsh-plugin-manager' }, { type: 'update', name: 'a' }, { type: 'update', name: 'b' }])
  assert.deepEqual(jobs.map((job) => job.name), ['a', 'b', 'dsh-plugin-manager'])
  assert.equal(new Set(jobs.map((job) => job.batch)).size, 1)
  for (const job of jobs) assert.equal((await q.settled(job.id)).phase, 'done')
  assert.equal(overlap, false)
  assert.deepEqual(q.calls.filter((entry) => entry[0] === 'removeBundle').map((entry) => entry[1]), ['a', 'b', 'dsh-plugin-manager'])
})

test('this plugin’s own update finishes after its instance lost the service', async () => {
  const q = await queue({ 'dsh-plugin-manager': { spec: 'link:/dev/dsh-plugin-manager' } })
  q.hooks.nameOf = () => 'dsh-plugin-manager'
  let instanceAlive = true
  const jobs = createJobs({ profileDir: q.dir, store: q.store, pluginManager: () => (instanceAlive ? q.pluginManager : undefined) })
  q.hooks.remove = () => {
    instanceAlive = false // removing the bundle unloads the instance that queued the job
    return undefined
  }
  const [job] = await jobs.enqueue({ type: 'update', name: 'dsh-plugin-manager' })
  const done = await q.settled(job.id)
  assert.equal(done.phase, 'done')
  assert.equal(done.self, true)
  assert.equal(q.state.has('dsh-plugin-manager'), true)
})

test('jobs left active by another process are interrupted; a just-finished one is not', async () => {
  const q = await queue({ a: { spec: 'github:o/a', commit: OLD } })
  await q.store.saveJob({ id: 'aaaaaa-abcdef', type: 'update', name: 'a', phase: 'installing', removed: true, pid: process.pid + 1, createdAt: 1 })
  // Same process, no runner holds it: it settled between the read and the check.
  await q.store.saveJob({ id: 'aaaaab-abcdef', type: 'update', name: 'a', phase: 'installing', removed: true, pid: process.pid, createdAt: 2 })
  const listed = await q.jobs.list()
  const byId = Object.fromEntries(listed.map((job) => [job.id, job]))
  assert.equal(byId['aaaaaa-abcdef'].phase, 'interrupted')
  assert.equal(byId['aaaaab-abcdef'].phase, 'installing', 'not rewritten as interrupted')
  await q.jobs.retry('aaaaaa-abcdef')
  assert.equal((await q.settled('aaaaaa-abcdef')).phase, 'failed', 'already installed: DSH refuses, and says so')
  await assert.rejects(q.jobs.dismiss('zzzzzz-000000'), /不存在/)
  assert.equal((await q.jobs.dismiss('aaaaaa-abcdef')).dismissed, true)
})

test('install-log chunks of a job are folded into its live log', async () => {
  const q = await queue({ a: { spec: 'github:o/a', commit: OLD } })
  let release
  q.hooks.install = (spec, options) => {
    q.jobs.onLog({ requestId: options.requestId, jobId: 'run-1', argv: ['pnpm', 'add', spec], text: 'Progress: resolved 1\n' })
    q.jobs.onLog({ requestId: 'someone-else', jobId: 'x', argv: ['pnpm'], text: 'nope' })
    q.jobs.onState({ requestId: options.requestId, phase: 'applying' })
    return new Promise((resolve) => {
      release = () => resolve(undefined)
    })
  }
  const [job] = await q.jobs.enqueue({ type: 'update', name: 'a' })
  await until(() => typeof release === 'function', 'install started')
  const live = (await q.jobs.list()).find((item) => item.id === job.id)
  assert.equal(live.phase, 'installing')
  assert.equal(live.detail, 'applying')
  assert.equal(live.log, '$ pnpm add github:o/a\nProgress: resolved 1\n')
  await assert.rejects(q.jobs.dismiss(job.id), /进行/)
  q.hooks.install = undefined
  release()
  const done = await q.settled(job.id)
  assert.match(done.log, /Progress: resolved 1/)
})

test('failureOf reads errors, package results and blocked builds', () => {
  assert.equal(failureOf({ application: 'applied' }), null)
  assert.deepEqual(failureOf({ application: 'cancelled' }), { code: 'cancelled' })
  const blocked = failureOf({ application: 'failed', error: { code: 'operation-error' }, pendingBuilds: ['esbuild'], packageResult: { exitCode: 1, output: 'a\nb', kind: 'build-blocked' } })
  assert.deepEqual(blocked, { code: 'operation-error', kind: 'build-blocked', output: 'a\nb', pendingBuilds: ['esbuild'] })
  assert.deepEqual(failureOf(undefined), { code: 'no-result' })
})

/* ── HTTP API ────────────────────────────────────────────────────────────── */

async function api(plugins) {
  const profile = await fakeProfile(plugins, { official: ['@deepseek-ai/dsh-base'] })
  const handler = createApi({ profileDir: () => profile.dir, pluginManager: () => profile.pluginManager, lsRemote: async () => LS_REMOTE })
  return { ...profile, handler: handler.handleApi, onEvent: handler.onEvent }
}

test('GET overview, POST check, GET commits and GET refs', async () => {
  const a = await api({ 'dsh-chat-reader': { spec: 'github:o/dsh-chat-reader', commit: OLD }, p: { spec: 'file:/tmp/p.tgz' } })
  const overview = await call(a.handler, 'GET', `${API_PREFIX}/overview`)
  assert.equal(overview.status, 200)
  assert.equal(overview.headers['cache-control'], 'no-store')
  assert.deepEqual(overview.json.plugins.map((row) => row.name), ['dsh-chat-reader', 'p'])
  assert.equal(overview.json.self, 'dsh-plugin-manager')
  const checked = await call(a.handler, 'POST', `${API_PREFIX}/check`, { force: true })
  assert.equal(checked.json.checks['dsh-chat-reader'].behind, true)
  assert.equal(checked.json.checks.p, undefined, 'only git sources are checked')
  const commits = await call(a.handler, 'GET', `${API_PREFIX}/commits?name=dsh-chat-reader`)
  assert.equal(commits.json.status.remote, NEW)
  const refs = await call(a.handler, 'GET', `${API_PREFIX}/refs?name=dsh-chat-reader`)
  assert.equal(refs.json.refs.defaultBranch, 'main')
  assert.equal(refs.json.locked, OLD)
  assert.equal((await call(a.handler, 'GET', `${API_PREFIX}/refs?name=nope`)).status, 404)
  assert.equal((await call(a.handler, 'GET', `${API_PREFIX}/refs?name=p`)).status, 400)
})

test('POST jobs runs a job the page can poll; retry and dismiss', async () => {
  const a = await api({ 'dsh-chat-reader': { spec: 'github:o/dsh-chat-reader', commit: OLD } })
  const posted = await call(a.handler, 'POST', `${API_PREFIX}/jobs`, { jobs: [{ type: 'update', name: 'dsh-chat-reader' }] })
  assert.equal(posted.status, 200)
  const id = posted.json.jobs[0].id
  const done = await until(async () => {
    const jobs = (await call(a.handler, 'GET', `${API_PREFIX}/jobs`)).json.jobs
    const job = jobs.find((item) => item.id === id)
    return job && job.phase === 'done' ? job : null
  }, 'job done')
  assert.equal(done.after.commit, NEW)
  assert.equal((await call(a.handler, 'POST', `${API_PREFIX}/jobs/retry`, { id })).status, 409)
  assert.equal((await call(a.handler, 'POST', `${API_PREFIX}/jobs/dismiss`, { id })).json.job.dismissed, true)
  assert.equal((await call(a.handler, 'POST', `${API_PREFIX}/jobs/dismiss`, { id: '../x' })).status, 400)
  assert.equal((await call(a.handler, 'POST', `${API_PREFIX}/jobs`, { type: 'format-disk' })).status, 400)
})

test('export, import plan and diagnostics over HTTP', async () => {
  const a = await api({ 'dsh-chat-reader': { spec: 'github:o/dsh-chat-reader', commit: OLD } })
  const exported = (await call(a.handler, 'GET', `${API_PREFIX}/export`)).json.manifest
  assert.equal(exported.plugins.length, 1)
  const plan = await call(a.handler, 'POST', `${API_PREFIX}/import/plan`, { manifest: exported })
  assert.equal(plan.json.items[0].action, 'skip')
  assert.equal((await call(a.handler, 'POST', `${API_PREFIX}/import/plan`, { manifest: { nope: 1 } })).status, 400)
  const diagnostics = await call(a.handler, 'GET', `${API_PREFIX}/diagnostics`)
  assert.deepEqual(diagnostics.json.broken, [])
  assert.deepEqual(diagnostics.json.logs, [])
  assert.equal((await call(a.handler, 'GET', `${API_PREFIX}/log?name=..%2F..%2Fpackage.json`)).status, 400)
  assert.equal((await call(a.handler, 'POST', `${API_PREFIX}/logs/clean`, { days: -1 })).status, 400)
  assert.deepEqual((await call(a.handler, 'POST', `${API_PREFIX}/logs/clean`, { days: 30 })).json, { ok: true, removed: 0, bytes: 0 })
})

test('the API refuses non-JSON bodies, unknown routes, wrong methods and a missing profile', async () => {
  const a = await api({})
  const form = await call(a.handler, 'POST', `${API_PREFIX}/jobs`, 'type=remove&name=x', { 'content-type': 'application/x-www-form-urlencoded' })
  assert.equal(form.status, 415, 'a cross-site form cannot post a job')
  assert.equal((await call(a.handler, 'POST', `${API_PREFIX}/jobs`, '{nope', { 'content-type': 'application/json' })).status, 400)
  assert.equal((await call(a.handler, 'GET', `${API_PREFIX}/nope`)).status, 404)
  const wrong = await call(a.handler, 'DELETE', `${API_PREFIX}/jobs`)
  assert.equal(wrong.status, 405)
  assert.equal(wrong.headers.allow, 'GET, POST')
  assert.equal((await call(a.handler, 'GET', `${API_PREFIX}/commits?name=../x`)).status, 400)
  const none = createApi({ profileDir: () => undefined, pluginManager: () => undefined })
  assert.equal((await call(none.handleApi, 'GET', `${API_PREFIX}/overview`)).status, 503)
})

test('apply wires host events and mounts the API on webServer', () => {
  const registered = []
  const listeners = {}
  apply({
    get: (key) => (key === 'profileContext' ? { dir: '/tmp/profile' } : undefined),
    on: (event, fn) => {
      listeners[event] = fn
      return () => {}
    },
    inject: (deps, run) => {
      assert.deepEqual(deps, ['webServer'])
      run({ effect: (fn) => fn(), webServer: { register: (route) => (registered.push(route), () => {}) } })
    },
  })
  assert.deepEqual(Object.keys(listeners).sort(), ['plugin-manager/install-log', 'plugin-manager/install-state'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, API_PREFIX)
})

/* ── flaky networks ──────────────────────────────────────────────────────── */

const SSL_RESET = "fatal: unable to access 'https://github.com/o/r/': LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443"

test('isNetworkError tells a dropped connection from a missing repository', () => {
  assert.equal(isNetworkError(SSL_RESET), true)
  assert.equal(isNetworkError('fatal: unable to access ...: Could not resolve host: github.com'), true)
  assert.equal(isNetworkError('Failed to connect to github.com port 443 after 75000 ms: Operation timed out'), true)
  assert.equal(isNetworkError('git ls-remote 超时（10000 ms）'), true)
  assert.equal(isNetworkError("remote: Repository not found.\nfatal: repository 'https://github.com/o/gone/' not found"), false)
  assert.equal(isNetworkError('fatal: Authentication failed'), false)
})

test('gitLsRemote passes ref patterns after the URL (a real git, a local repository)', async () => {
  const repo = await tempDir('dpm-git-')
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo })
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'one')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim()
  const output = await gitLsRemote(repo, [], { patterns: ['HEAD'] })
  assert.equal(output.trim(), `${head}\tHEAD`)
  assert.equal(parseRefs(await gitLsRemote(repo, ['--symref'])).defaultBranch, 'main')
})

function flakyRemote(failures, message = SSL_RESET) {
  const calls = []
  return {
    calls,
    lsRemote: async (url, args, options) => {
      calls.push([url, args, options.patterns])
      if (calls.length <= failures) throw new Error(message)
      return LS_REMOTE
    },
  }
}

test('preflight: a dropped TLS handshake is tried again before anything is removed', async () => {
  const remote = flakyRemote(2)
  const q = await queue({ r: { spec: 'github:o/r', commit: OLD } }, { lsRemote: remote.lsRemote })
  const [job] = await q.jobs.enqueue({ type: 'update', name: 'r' })
  const done = await q.settled(job.id)
  assert.equal(done.phase, 'done')
  assert.equal(done.preflight, true)
  assert.equal(done.checkTries, 3)
  assert.deepEqual(remote.calls.slice(0, 3).map((call) => [call[0], call[2]]), Array(3).fill(['https://github.com/o/r.git', ['HEAD']]))
})

test('preflight: an unreachable host fails the job with the plugin untouched', async () => {
  const remote = flakyRemote(99)
  const q = await queue({ r: { spec: 'github:o/r', commit: OLD } }, { lsRemote: remote.lsRemote })
  const [job] = await q.jobs.enqueue({ type: 'update', name: 'r' })
  const failed = await q.settled(job.id)
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.failedStage, 'preflight')
  assert.equal(failed.removed, false)
  assert.equal(failed.failure.code, 'unreachable')
  assert.equal(failed.failure.attempts, 3)
  assert.match(failed.failure.diagnostic, /SSL_ERROR_SYSCALL/)
  assert.equal(q.calls.some((call) => call[0] === 'removeBundle' || call[0] === 'installBundle'), false, 'nothing removed, nothing installed')
  assert.equal(q.state.get('r').spec, 'github:o/r')
})

test('preflight: "repository not found" is left for DSH to report; non-git sources skip it', async () => {
  const remote = flakyRemote(99, "remote: Repository not found.\nfatal: repository 'https://github.com/o/r/' not found")
  const q = await queue({ r: { spec: 'github:o/r', commit: OLD }, p: { spec: 'file:/tmp/p.tgz' } }, { lsRemote: remote.lsRemote })
  q.hooks.nameOf = (spec) => (spec.startsWith('file:') ? 'p' : 'r')
  const [r] = await q.jobs.enqueue({ type: 'update', name: 'r' })
  assert.equal((await q.settled(r.id)).phase, 'done')
  const before = remote.calls.length
  const [p] = await q.jobs.enqueue({ type: 'update', name: 'p' })
  const done = await q.settled(p.id)
  assert.equal(done.phase, 'done')
  assert.equal(done.preflight, undefined)
  assert.equal(remote.calls.length, before, 'no git for a tarball')
})

function hostDown(spec) {
  return {
    changed: false,
    application: 'failed',
    stage: 'install',
    target: spec,
    failedAt: 'spec-host',
    error: { code: 'operation-error' },
    packageResult: { exitCode: 128, output: SSL_RESET, truncated: false, logPath: '/l', kind: 'network' },
  }
}

test('install: a failure to reach the spec host is retried automatically', async () => {
  const q = await queue({ r: { spec: 'github:o/r', commit: OLD } })
  let installs = 0
  q.hooks.install = (spec) => {
    installs += 1
    return installs <= 2 ? hostDown(spec) : undefined
  }
  const [job] = await q.jobs.enqueue({ type: 'update', name: 'r' })
  const done = await q.settled(job.id)
  assert.equal(done.phase, 'done')
  assert.equal(done.installTries, 3)
  assert.equal(installs, 3)
  const ids = q.calls.filter((call) => call[0] === 'installBundle').map((call) => call[2].requestId)
  assert.equal(new Set(ids).size, 3, 'each try has its own request id')
  assert.match(done.log, /retrying \(2\/3\)/)
})

test('install: other failures are not retried; a host that stays down fails after three tries', async () => {
  const q = await queue({ a: { spec: 'github:o/a', commit: OLD }, b: { spec: 'github:o/b', commit: OLD } })
  let installs = 0
  q.hooks.install = (spec) => {
    installs += 1
    return spec.endsWith('/a')
      ? { ...hostDown(spec), failedAt: undefined, packageResult: { exitCode: 1, output: 'ERR_PNPM_NO_MATCHING_VERSION', truncated: false, logPath: '/l', kind: 'no-matching-version' } }
      : hostDown(spec)
  }
  const [a] = await q.jobs.enqueue({ type: 'update', name: 'a' })
  const failedA = await q.settled(a.id)
  assert.equal(failedA.installTries, 1)
  assert.equal(installs, 1)
  const [b] = await q.jobs.enqueue({ type: 'update', name: 'b' })
  const failedB = await q.settled(b.id)
  assert.equal(failedB.phase, 'failed')
  assert.equal(failedB.removed, true)
  assert.equal(failedB.installTries, 3)
  assert.equal(failedB.failure.failedAt, 'spec-host')
  assert.equal(installs, 4)
})
