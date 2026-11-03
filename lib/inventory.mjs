// lib/inventory.mjs — read-only views of the profile: the third-party plugins with
// where they came from and what is locked, the export manifest and an import plan,
// and diagnostics (broken bundles, stray dependencies, pnpm logs).

import { existsSync } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { lockedCommit, lockedEntry } from './git.mjs'
import { classifySource, gitRemote, isCommit, splitAlias } from './sources.mjs'

export const SELF = 'dsh-plugin-manager'
export const LEGACY = Object.freeze(['dsh-plugin-updater'])
export const EXPORT_FORMAT = 'dsh-plugin-manager/plugins'
const LOG_NAME = /^[\w.-]{1,200}$/

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

export async function readProfile(profileDir) {
  let manifest = null
  try {
    manifest = JSON.parse((await readText(join(profileDir, 'package.json'))) ?? '')
  } catch {
    manifest = null
  }
  const lockText = (await readText(join(profileDir, 'pnpm-lock.yaml'))) ?? ''
  return { manifest: manifest ?? {}, lockText }
}

function installedVersion(profileDir, name) {
  // The manifest pnpm linked into node_modules; read lazily by callers that need it.
  return readText(join(profileDir, 'node_modules', ...name.split('/'), 'package.json')).then((text) => {
    try {
      return JSON.parse(text ?? '').version
    } catch {
      return undefined
    }
  })
}

/** Is this bundle one the person installed (as opposed to DSH's own)? */
export function isThirdParty(bundle) {
  if (!bundle || bundle.official || bundle.optional || bundle.availability === 'installation') return false
  return Boolean(bundle.installed || bundle.source)
}

/**
 * The third-party plugins of the profile.
 * @param bundles - `pluginManager.listBundles()`.
 * @param profile - `readProfile()`.
 * @param extra - `{ history, checks }` from the store.
 */
export function pluginRows(bundles, { manifest, lockText }, { history = {}, checks = {} } = {}) {
  const deps = manifest.dependencies ?? {}
  return (Array.isArray(bundles) ? bundles : []).filter(isThirdParty).map((bundle) => {
    const source = bundle.source ?? (deps[bundle.name] !== undefined ? deps[bundle.name] : undefined)
    const kind = classifySource(source, bundle.name)
    const remote = gitRemote(source, bundle.name)
    const locked = remote ? lockedCommit(lockText, bundle.name) : null
    const check = checks[bundle.name]
    // A check is only valid for the commit and spec it compared.
    const fresh = check && check.locked === locked && check.source === source ? check : undefined
    return {
      name: bundle.name,
      version: bundle.version,
      description: bundle.description,
      meta: bundle.meta,
      enabled: bundle.enabled === true,
      installed: bundle.installed === true,
      availability: bundle.availability,
      removable: bundle.removable !== false && !bundle.readOnlyReason,
      error: bundle.error,
      rows: Array.isArray(bundle.rows) ? bundle.rows.length : 0,
      source,
      kind,
      repo: remote ? { url: remote.url, web: remote.web, ref: remote.ref, github: remote.github } : undefined,
      pinned: remote ? isCommit(remote.ref) : false,
      locked,
      check: fresh,
      history: Array.isArray(history[bundle.name]) ? history[bundle.name] : [],
      self: bundle.name === SELF,
      legacy: LEGACY.includes(bundle.name),
    }
  })
}

/** What a plugin is right now — recorded in history before it is changed. */
export async function snapshot(profileDir, name, source) {
  const { lockText } = await readProfile(profileDir)
  return {
    spec: source,
    commit: lockedCommit(lockText, name),
    version: await installedVersion(profileDir, name),
    locked: lockedEntry(lockText, name)?.version,
  }
}

/* ── export / import ─────────────────────────────────────────────────────── */

export function exportManifest(rows, { profile, runtime, now = Date.now } = {}) {
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date(now()).toISOString(),
    ...(profile ? { profile } : {}),
    ...(runtime ? { dsh: runtime } : {}),
    plugins: rows
      .filter((row) => row.installed && typeof row.source === 'string')
      .map((row) => ({
        name: row.name,
        spec: row.source,
        enabled: row.enabled,
        kind: row.kind,
        ...(row.locked ? { commit: row.locked } : {}),
        ...(row.version ? { version: row.version } : {}),
      })),
  }
}

function localPath(spec) {
  const { spec: bare } = splitAlias(spec)
  const match = /^(?:file|link):(.*)$/is.exec(bare)
  const path = match ? match[1] : /^(?:\/|~\/)/.test(bare) ? bare : null
  if (path === null) return null
  return path.replace(/^~(?=$|\/)/, () => homedir())
}

const SPEC_OK = (spec) => typeof spec === 'string' && spec.trim() !== '' && spec.length < 2048 && !spec.trim().startsWith('-') && !/[\r\n\0]/.test(spec)
const NAME_OK = (name) => typeof name === 'string' && /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i.test(name)

/**
 * Compare an exported manifest with this profile.
 * @returns `{ items: [{ name, spec, enabled, kind, action, selected, reason?, current? }] }`,
 *   action: 'install' | 'replace' | 'skip' | 'invalid'.
 */
export function importPlan(input, rows, { pathExists = existsSync } = {}) {
  if (!input || typeof input !== 'object' || input.format !== EXPORT_FORMAT || !Array.isArray(input.plugins)) {
    throw Object.assign(new Error('不是 dsh-plugin-manager 导出的插件清单'), { status: 400 })
  }
  const byName = new Map(rows.map((row) => [row.name, row]))
  const seen = new Set()
  const items = input.plugins.slice(0, 200).map((plugin) => {
    const name = plugin?.name
    const spec = typeof plugin?.spec === 'string' ? plugin.spec.trim() : plugin?.spec
    const enabled = plugin?.enabled !== false
    if (!NAME_OK(name) || !SPEC_OK(spec) || seen.has(name)) {
      return { name: String(name ?? ''), spec: String(spec ?? ''), enabled, action: 'invalid', selected: false, reason: seen.has(name) ? 'duplicate' : 'invalid' }
    }
    seen.add(name)
    const kind = classifySource(spec, name)
    const current = byName.get(name)
    const base = { name, spec, enabled, kind }
    const path = kind === 'path' || kind === 'tarball' ? localPath(spec) : null
    const missingPath = path !== null && !pathExists(path)
    if (current && current.installed) {
      if (current.source === spec) return { ...base, action: 'skip', selected: false, reason: 'same', current: current.source }
      return { ...base, action: 'replace', selected: false, current: current.source, ...(missingPath ? { reason: 'missing-path' } : {}) }
    }
    return { ...base, action: 'install', selected: !missingPath, ...(missingPath ? { reason: 'missing-path' } : {}) }
  })
  return { items }
}

/* ── diagnostics ─────────────────────────────────────────────────────────── */

export function logsDir(profileDir) {
  return join(profileDir, '.plugin-manager', 'logs')
}

/**
 * The plugin manager writes one directory per operation (`operation-xxxx/pnpm.log`,
 * `github-connection-xxxx/…`); loose files are listed too. Newest first.
 */
export async function listLogs(profileDir) {
  const dir = logsDir(profileDir)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const entries = await Promise.all(
    names
      .filter((name) => LOG_NAME.test(name))
      .map(async (name) => {
        try {
          const info = await stat(join(dir, name))
          if (info.isFile()) return [{ name, size: info.size, mtime: info.mtimeMs }]
          if (!info.isDirectory()) return []
          const files = await Promise.all(
            (await readdir(join(dir, name)))
              .filter((file) => LOG_NAME.test(file))
              .map(async (file) => {
                const inner = await stat(join(dir, name, file))
                return inner.isFile() ? { name: `${name}/${file}`, size: inner.size, mtime: inner.mtimeMs } : null
              }),
          )
          return files.filter(Boolean)
        } catch {
          return []
        }
      }),
  )
  return entries.flat().sort((a, b) => b.mtime - a.mtime)
}

function logPath(profileDir, name) {
  const parts = String(name).split('/')
  if (parts.length > 2 || !parts.every((part) => LOG_NAME.test(part) && part !== '..' && part !== '.')) {
    throw Object.assign(new Error('无效的日志名'), { status: 400 })
  }
  return join(logsDir(profileDir), ...parts)
}

export async function readLog(profileDir, name, maxBytes = 64 * 1024) {
  const text = await readText(logPath(profileDir, name))
  if (text === null) throw Object.assign(new Error('日志不存在'), { status: 404 })
  return text.length > maxBytes ? text.slice(-maxBytes) : text
}

/** Delete pnpm logs older than `days` days (a whole operation directory at a time). */
export async function cleanLogs(profileDir, days, now = Date.now()) {
  const cutoff = now - Math.max(0, Number(days) || 0) * 24 * 3600 * 1000
  const logs = await listLogs(profileDir)
  const groups = new Map()
  for (const log of logs) {
    const top = log.name.split('/')[0]
    const group = groups.get(top) ?? { newest: 0, size: 0, count: 0 }
    group.newest = Math.max(group.newest, log.mtime)
    group.size += log.size
    group.count += 1
    groups.set(top, group)
  }
  const old = [...groups].filter(([, group]) => group.newest < cutoff)
  await Promise.all(old.map(([top]) => rm(logPath(profileDir, top), { recursive: true, force: true })))
  return { removed: old.reduce((sum, [, group]) => sum + group.count, 0), bytes: old.reduce((sum, [, group]) => sum + group.size, 0) }
}

/**
 * Broken bundles, selected names nothing provides, and profile dependencies that are
 * no plugin at all (the plugin manager cannot remove those; the CLI can).
 */
export function problems(bundles, { manifest }, profileDir) {
  const list = Array.isArray(bundles) ? bundles : []
  const listed = new Set(list.map((bundle) => bundle.name))
  const profile = basename(profileDir)
  const broken = list
    .filter((bundle) => !bundle.official || bundle.installed || bundle.enabled)
    .filter((bundle) => bundle.error || (bundle.installed && bundle.availability === 'missing'))
    .map((bundle) => ({
      name: bundle.name,
      code: bundle.error?.code ?? 'missing-files',
      diagnostic: bundle.error?.diagnostic,
      enabled: bundle.enabled === true,
      installed: bundle.installed === true,
      removable: bundle.removable !== false && !bundle.readOnlyReason,
      source: bundle.source,
    }))
  const stray = Object.entries(manifest.dependencies ?? {})
    .filter(([name]) => !listed.has(name))
    .map(([name, spec]) => ({ name, spec, command: `dsh plugin --profile ${profile} remove ${name}` }))
  return { broken, stray }
}
