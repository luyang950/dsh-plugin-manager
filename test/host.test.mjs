// Host half: GitHub spec parsing, the lockfile scan, `git ls-remote` output, and the
// read-only /commits route. `git ls-remote` is faked; nothing touches the network.

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { API_PREFIX, apply, createApi, inject, name } from '../index.mjs'
import { commitStatus, githubRepo, lockedCommit, pickRemoteCommit } from '../lib/commits.mjs'

const OLD = '155b39fbe980de42e4281ee5a510e16328fe5489'
const NEW = '62fbe5878728bf9faac182d6578ba3c10e880fc2'

const LOCK_V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: false
  excludeLinksFromLockfile: false

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

test('module shape', () => {
  assert.equal(name, 'dsh-plugin-updater')
  assert.deepEqual(inject, [])
  assert.equal(API_PREFIX, '/dsh-plugin-updater/api')
})

test('githubRepo reads every GitHub form pnpm records', () => {
  const plain = { owner: 'luyang950', repo: 'dsh-chat-reader', ref: '' }
  assert.deepEqual(githubRepo('github:luyang950/dsh-chat-reader'), plain)
  assert.deepEqual(githubRepo('luyang950/dsh-chat-reader'), plain)
  assert.deepEqual(githubRepo('git+https://github.com/luyang950/dsh-chat-reader.git'), plain)
  assert.deepEqual(githubRepo('https://github.com/luyang950/dsh-chat-reader'), plain)
  assert.deepEqual(githubRepo('git+ssh://git@github.com/luyang950/dsh-chat-reader.git'), plain)
  assert.deepEqual(githubRepo('git@github.com:luyang950/dsh-chat-reader.git'), plain)
  assert.deepEqual(githubRepo('dsh-chat-reader@github:luyang950/dsh-chat-reader'), plain)
  assert.deepEqual(githubRepo('github:luyang950/dsh-chat-reader#dev'), { ...plain, ref: 'dev' })
  assert.deepEqual(githubRepo('github:o/r#semver:^1.0.0'), { owner: 'o', repo: 'r', ref: '', range: '^1.0.0' })
  assert.equal(githubRepo('gitlab:o/r'), null)
  assert.equal(githubRepo('file:/tmp/x.tgz'), null)
  assert.equal(githubRepo('^1.2.3'), null)
  assert.equal(githubRepo('github:o/r/extra'), null)
  assert.equal(githubRepo('github:o;rm -rf/r'), null, 'unsafe segments are refused')
})

test('lockedCommit finds the importer entry of a v9 lockfile', () => {
  assert.equal(lockedCommit(LOCK_V9, 'dsh-chat-reader'), OLD)
  assert.equal(lockedCommit(LOCK_V9, '@shimo/dsh-shimo-editors'), null, 'a tarball has no commit')
  assert.equal(lockedCommit(LOCK_V9, 'absent'), null)
  assert.equal(lockedCommit('', 'dsh-chat-reader'), null)
  assert.equal(lockedCommit(null, 'dsh-chat-reader'), null)
})

test('lockedCommit falls back to the package key of older lockfiles', () => {
  const v6 = `lockfileVersion: '6.0'\n\ndependencies:\n  dsh-chat-reader:\n    specifier: github:o/r\n    version: github.com/o/r/${OLD}\n\npackages:\n\n  github.com/o/r/${OLD}:\n    name: dsh-chat-reader\n`
  assert.equal(lockedCommit(v6.replace('  dsh-chat-reader:\n', `  dsh-chat-reader@github.com/o/r/${OLD}:\n`), 'dsh-chat-reader'), OLD)
})

test('pickRemoteCommit prefers HEAD, a branch, and a peeled tag', () => {
  const output = `${NEW}\tHEAD\n${NEW}\trefs/heads/main\n${'a'.repeat(40)}\trefs/tags/v1\n${'b'.repeat(40)}\trefs/tags/v1^{}\n`
  assert.equal(pickRemoteCommit(output, ''), NEW)
  assert.equal(pickRemoteCommit(output, 'main'), NEW)
  assert.equal(pickRemoteCommit(output, 'v1'), 'b'.repeat(40))
  assert.equal(pickRemoteCommit('', 'main'), null)
})

async function profile({ dependencies, lock }) {
  const dir = await mkdtemp(join(tmpdir(), 'dpu-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-test', private: true, dependencies }))
  if (lock !== undefined) await writeFile(join(dir, 'pnpm-lock.yaml'), lock)
  return dir
}

test('commitStatus compares the locked commit with git ls-remote', async () => {
  const dir = await profile({ dependencies: { 'dsh-chat-reader': 'github:luyang950/dsh-chat-reader' }, lock: LOCK_V9 })
  const asked = []
  const lsRemote = async (url, ref, options) => (asked.push([url, ref, options.cwd]), `${NEW}\tHEAD\n`)
  const status = await commitStatus({ profileDir: dir, name: 'dsh-chat-reader', lsRemote })
  assert.deepEqual(asked, [['https://github.com/luyang950/dsh-chat-reader.git', '', dir]])
  assert.equal(status.kind, 'github')
  assert.equal(status.locked, OLD)
  assert.equal(status.remote, NEW)
  assert.equal(status.ref, 'HEAD')
  assert.equal(status.behind, true)

  const same = await commitStatus({ profileDir: dir, name: 'dsh-chat-reader', lsRemote: async () => `${OLD}\tHEAD\n` })
  assert.equal(same.behind, false)
})

test('commitStatus reports other sources, pins, missing deps and git failures without throwing', async () => {
  const dir = await profile({
    dependencies: { tgz: 'file:/tmp/t.tgz', pinned: `github:o/r#${NEW}`, broken: 'github:o/gone' },
    lock: LOCK_V9,
  })
  const never = async () => assert.fail('must not run git')
  assert.equal((await commitStatus({ profileDir: dir, name: 'tgz', lsRemote: never })).kind, 'other')
  assert.equal((await commitStatus({ profileDir: dir, name: 'nope', lsRemote: never })).kind, 'missing')
  const pinned = await commitStatus({ profileDir: dir, name: 'pinned', lsRemote: never })
  assert.equal(pinned.pinned, true)
  assert.equal(pinned.behind, false)
  const broken = await commitStatus({ profileDir: dir, name: 'broken', lsRemote: async () => { throw new Error('Repository not found') } })
  assert.equal(broken.behind, false)
  assert.match(broken.error, /Repository not found/)
})

function fakeRequest(method, url) {
  const req = Readable.from([])
  req.method = method
  req.url = url
  req.headers = {}
  return req
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    writeHead(status, headers = {}) {
      this.status = status
      for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value
    },
    end(body = '') {
      this.body = String(body)
      this.writableEnded = true
    },
    get json() {
      return JSON.parse(this.body)
    },
  }
}

async function call(handler, method, url) {
  const res = fakeResponse()
  await handler(fakeRequest(method, url), res)
  return res
}

test('GET /commits answers, caches, and refreshes on request', async () => {
  const dir = await profile({ dependencies: { 'dsh-chat-reader': 'github:luyang950/dsh-chat-reader' }, lock: LOCK_V9 })
  let runs = 0
  const handler = createApi({ profileDir: () => dir, lsRemote: async () => ((runs += 1), `${NEW}\tHEAD\n`) })
  const first = await call(handler, 'GET', `${API_PREFIX}/commits?name=dsh-chat-reader`)
  assert.equal(first.status, 200)
  assert.equal(first.headers['cache-control'], 'no-store')
  assert.equal(first.json.ok, true)
  assert.equal(first.json.status.behind, true)
  await call(handler, 'GET', `${API_PREFIX}/commits?name=dsh-chat-reader`)
  assert.equal(runs, 1, 'second read is cached')
  await call(handler, 'GET', `${API_PREFIX}/commits?name=dsh-chat-reader&refresh=1`)
  assert.equal(runs, 2)
})

test('the API refuses bad names, unknown routes, other methods and a missing profile', async () => {
  const dir = await profile({ dependencies: {} })
  const handler = createApi({ profileDir: () => dir, lsRemote: async () => '' })
  assert.equal((await call(handler, 'GET', `${API_PREFIX}/commits?name=../../etc`)).status, 400)
  assert.equal((await call(handler, 'GET', `${API_PREFIX}/commits`)).status, 400)
  assert.equal((await call(handler, 'GET', `${API_PREFIX}/nope`)).status, 404)
  const post = await call(handler, 'POST', `${API_PREFIX}/commits?name=x`)
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET')
  const none = createApi({ profileDir: () => undefined })
  assert.equal((await call(none, 'GET', `${API_PREFIX}/commits?name=x`)).status, 503)
})

test('apply mounts the API on webServer when it appears', () => {
  const registered = []
  const ctx = {
    get: (key) => (key === 'profileContext' ? { dir: '/tmp/profile' } : undefined),
    inject: (deps, run) => {
      assert.deepEqual(deps, ['webServer'])
      run({
        effect: (fn) => fn(),
        webServer: { register: (route) => (registered.push(route), () => {}) },
      })
    },
  }
  apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, API_PREFIX)
  assert.equal(typeof registered[0].handler, 'function')
})
