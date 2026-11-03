// Shared test helpers: a temporary profile directory and a fake plugin manager
// service that edits it the way DSH's would (package.json, pnpm-lock.yaml,
// node_modules/<name>/package.json), plus fake HTTP request / response objects.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

export const OLD = '155b39fbe980de42e4281ee5a510e16328fe5489'
export const NEW = '62fbe5878728bf9faac182d6578ba3c10e880fc2'

/** Specs pnpm records and the kind each one is; shared by the host and bundle tests. */
export const SOURCE_CASES = [
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

export function caseName(spec) {
  return spec && spec.startsWith('@acme/') ? '@acme/dsh-foo' : spec && spec.startsWith('dsh-foo@') ? 'dsh-foo' : undefined
}

export async function tempDir(prefix = 'dpm-') {
  return mkdtemp(join(tmpdir(), prefix))
}

function lockFor(deps) {
  const lines = ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:']
  for (const [name, entry] of Object.entries(deps)) {
    lines.push(`      ${name.startsWith('@') ? `'${name}'` : name}:`, `        specifier: ${entry.specifier}`, `        version: ${entry.version}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * A profile on disk and a fake `pluginManager` over it.
 * @param plugins - `{ name: { spec, commit?, version?, enabled? } }`.
 */
export async function fakeProfile(plugins = {}, { official = [] } = {}) {
  const dir = await tempDir()
  const state = new Map(Object.entries(plugins).map(([name, plugin]) => [name, { enabled: true, version: '0.1.0', ...plugin }]))
  const calls = []
  const hooks = {} // per-call overrides: hooks.install(spec, options) → result | undefined

  async function write() {
    const dependencies = {}
    const lock = {}
    for (const [name, plugin] of state) {
      dependencies[name] = plugin.spec
      lock[name] = {
        specifier: plugin.spec,
        version: plugin.commit ? `https://codeload.github.com/o/${name}/tar.gz/${plugin.commit}` : plugin.spec,
      }
      await mkdir(join(dir, 'node_modules', name), { recursive: true })
      await writeFile(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: plugin.version }))
    }
    const bundles = ['@deepseek-ai/dsh-base', ...[...state].filter(([, plugin]) => plugin.enabled).map(([name]) => name)]
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-test', private: true, dependencies, dsh: { profile: { bundles } } }, null, 2))
    await writeFile(join(dir, 'pnpm-lock.yaml'), lockFor(lock))
  }
  await write()

  const pluginManager = {
    calls,
    hooks,
    state,
    async listBundles() {
      calls.push(['listBundles'])
      return [
        ...official.map((name) => ({ name, official: true, availability: 'installation', installed: false, enabled: true, optional: false, removable: false, rows: [], overrides: [] })),
        ...[...state].map(([name, plugin]) => ({
          name,
          official: false,
          availability: 'profile',
          installed: true,
          enabled: plugin.enabled,
          optional: false,
          removable: true,
          source: plugin.spec,
          version: plugin.version,
          rows: [{ rowId: name }],
          overrides: [],
          ...(plugin.error ? { error: plugin.error } : {}),
        })),
      ]
    },
    async removeBundle(name) {
      calls.push(['removeBundle', name])
      if (hooks.remove) {
        const result = await hooks.remove(name)
        if (result) return result
      }
      if (!state.has(name)) return { changed: false, application: 'failed', stage: 'remove', target: name, error: { code: 'not-removable' } }
      state.delete(name)
      await rm(join(dir, 'node_modules', name), { recursive: true, force: true })
      await write()
      return { changed: true, application: 'applied', stage: 'remove', target: name }
    },
    async installBundle(spec, options = {}) {
      calls.push(['installBundle', spec, options])
      if (hooks.install) {
        const result = await hooks.install(spec, options)
        if (result) return result
      }
      const name = hooks.nameOf ? hooks.nameOf(spec) : spec.replace(/^.*\//, '').replace(/[#.].*$/, '')
      if (state.has(name)) return { changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'already-installed' } }
      const pinned = /#([0-9a-f]{40})$/.exec(spec)
      const commit = /^github:/.test(spec) ? (pinned ? pinned[1] : hooks.head ?? NEW) : undefined
      state.set(name, { spec, commit, version: hooks.version ?? '0.2.0', enabled: options.enabled !== false })
      await write()
      return { changed: true, application: 'applied', stage: 'enable', target: spec, bundle: name, version: hooks.version ?? '0.2.0', enabled: options.enabled !== false }
    },
  }
  return { dir, pluginManager, calls, hooks, state, write, read: async (file) => readFile(join(dir, file), 'utf8') }
}

/** Wait until `predicate()` (sync or async) is truthy. */
export async function until(predicate, label = 'condition', timeoutMs = 3000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export function fakeRequest(method, url, body, headers) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = headers ?? (body === undefined ? {} : { 'content-type': 'application/json' })
  return req
}

export function fakeResponse() {
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

export async function call(handler, method, url, body, headers) {
  const res = fakeResponse()
  await handler(fakeRequest(method, url, body, headers), res)
  return res
}
