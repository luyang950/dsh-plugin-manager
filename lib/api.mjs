// lib/api.mjs — the JSON API under /dsh-plugin-manager/api/* the browser half calls.
//
// Reads answer from the profile directory and the plugin manager service; every
// change is a job (lib/jobs.mjs). POST bodies must be JSON, so a cross-site form
// cannot reach a mutating route (DSH's web server already requires its token).

import { basename } from 'node:path'

import { listRemoteRefs, remoteStatus } from './git.mjs'
import {
  cleanLogs,
  exportManifest,
  importPlan,
  listLogs,
  mergeKnown,
  pluginRows,
  problems,
  readLog,
  readProfile,
  SELF,
} from './inventory.mjs'
import { createJobs } from './jobs.mjs'
import { createStore, validJobId } from './store.mjs'

export const API_PREFIX = '/dsh-plugin-manager/api'
const MAX_BODY_BYTES = 512 * 1024
const CHECK_TTL_MS = 10 * 60 * 1000
const CHECK_CONCURRENCY = 4
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i

export class HttpError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  const type = String(req.headers?.['content-type'] ?? '')
  if (!/^application\/json\b/i.test(type)) throw new HttpError('请求体必须是 JSON', 415)
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError('请求体太大', 413)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError('请求体不是合法 JSON')
  }
}

function nameParam(value) {
  if (typeof value !== 'string' || !NAME.test(value)) throw new HttpError('缺少或无效的参数 name')
  return value
}

async function pool(items, limit, run) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * @param options - `{ profileDir: () => string|undefined, pluginManager: () => service|undefined,
 *   runtimeVersion?: () => string|undefined, lsRemote?, now? }`
 */
export function createApi(options) {
  const now = options.now ?? Date.now
  const contexts = new Map() // profileDir → { store, jobs }

  function context() {
    const profileDir = options.profileDir()
    if (!profileDir) throw new HttpError('当前 DSH 没有受管 profile', 503)
    let entry = contexts.get(profileDir)
    if (!entry) {
      const store = createStore(profileDir)
      const jobs = createJobs({ profileDir, store, pluginManager: options.pluginManager, now, ...(options.lsRemote ? { lsRemote: options.lsRemote } : {}) })
      entry = { profileDir, store, jobs }
      contexts.set(profileDir, entry)
    }
    return entry
  }

  function manager() {
    const service = options.pluginManager()
    if (!service) throw new HttpError('插件管理服务不可用', 503)
    return service
  }

  async function rows({ profileDir, store }) {
    const [bundles, profile, history, checks] = await Promise.all([
      manager().listBundles(),
      readProfile(profileDir),
      store.readHistory(),
      store.readChecks(),
    ])
    return { bundles, profile, plugins: pluginRows(bundles, profile, { history, checks }) }
  }

  async function check(ctx, names, { force = false } = {}) {
    const { plugins } = await rows(ctx)
    const checks = await ctx.store.readChecks()
    const wanted = plugins.filter((row) => row.repo && (!names || names.includes(row.name)))
    const at = now()
    await pool(wanted, CHECK_CONCURRENCY, async (row) => {
      const previous = row.check
      if (!force && previous && at - (previous.at ?? 0) < CHECK_TTL_MS && !previous.error) return
      const status = await remoteStatus({
        source: row.source,
        name: row.name,
        locked: row.locked,
        cwd: ctx.profileDir,
        ...(options.lsRemote ? { lsRemote: options.lsRemote } : {}),
      })
      checks[row.name] = { ...status, locked: row.locked, source: row.source, at }
    })
    await ctx.store.writeChecks(checks)
    const fresh = await rows(ctx)
    return Object.fromEntries(fresh.plugins.filter((row) => row.check).map((row) => [row.name, row.check]))
  }

  const routes = {
    'GET overview': async () => {
      const ctx = context()
      const { plugins } = await rows(ctx)
      const merged = mergeKnown(await ctx.store.readKnown(), plugins, now())
      if (merged.changed) await ctx.store.writeKnown(merged.known)
      return {
        profile: basename(ctx.profileDir),
        self: SELF,
        runtime: options.runtimeVersion?.(),
        plugins,
        removed: merged.removed,
      }
    },
    // Forget removed plugins (the 已卸载 list); installed ones cannot be forgotten.
    'POST history/forget': async (_params, body) => {
      const names = Array.isArray(body.names) ? body.names.filter((name) => typeof name === 'string' && NAME.test(name)) : []
      if (names.length === 0) throw new HttpError('缺少 names')
      return { forgotten: await context().store.forget(names) }
    },
    'POST check': async (_params, body) => {
      const names = Array.isArray(body.names) ? body.names.filter((name) => typeof name === 'string' && NAME.test(name)) : undefined
      return { checks: await check(context(), names, { force: body.force === true }) }
    },
    // The detail page's 有新提交 badge: one plugin, cached for ten minutes.
    'GET commits': async (params) => {
      const name = nameParam(params.get('name'))
      const checks = await check(context(), [name], { force: params.get('refresh') === '1' })
      return { status: checks[name] ?? null }
    },
    'GET refs': async (params) => {
      const name = nameParam(params.get('name'))
      const ctx = context()
      const { plugins } = await rows(ctx)
      const row = plugins.find((item) => item.name === name)
      if (!row) throw new HttpError('没有这个插件', 404)
      try {
        const refs = await listRemoteRefs({ source: row.source, name, cwd: ctx.profileDir, ...(options.lsRemote ? { lsRemote: options.lsRemote } : {}) })
        return { refs, history: row.history, locked: row.locked, source: row.source }
      } catch (error) {
        if (error.status) throw error
        throw new HttpError(`读取分支和 tag 失败：${error.message}`, 502)
      }
    },
    'GET jobs': async () => ({ jobs: await context().jobs.list() }),
    'POST jobs': async (_params, body) => {
      const requests = Array.isArray(body.jobs) ? body.jobs : [body]
      if (requests.length > 100) throw new HttpError('一次最多 100 个任务')
      manager()
      return { jobs: await context().jobs.enqueue(requests) }
    },
    'POST jobs/retry': async (_params, body) => {
      if (!validJobId(body.id)) throw new HttpError('无效的任务 id')
      return { job: await context().jobs.retry(body.id, { restore: body.restore === true }) }
    },
    'POST jobs/dismiss': async (_params, body) => {
      if (!validJobId(body.id)) throw new HttpError('无效的任务 id')
      return { job: await context().jobs.dismiss(body.id) }
    },
    'GET export': async () => {
      const ctx = context()
      const { plugins } = await rows(ctx)
      return { manifest: exportManifest(plugins, { profile: basename(ctx.profileDir), runtime: options.runtimeVersion?.(), now }) }
    },
    'POST import/plan': async (_params, body) => {
      const { plugins } = await rows(context())
      return importPlan(body.manifest, plugins)
    },
    'GET diagnostics': async () => {
      const ctx = context()
      const { bundles, profile } = await rows(ctx)
      return { ...problems(bundles, profile, ctx.profileDir), logs: await listLogs(ctx.profileDir) }
    },
    'GET log': async (params) => ({ text: await readLog(context().profileDir, params.get('name')) }),
    'POST logs/clean': async (_params, body) => {
      const days = Number(body.days)
      if (!Number.isFinite(days) || days < 0 || days > 3650) throw new HttpError('无效的天数')
      return cleanLogs(context().profileDir, days, now())
    },
  }

  async function handleApi(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(`${API_PREFIX}/`)) throw new HttpError('未知接口', 404)
      const route = url.pathname.slice(API_PREFIX.length + 1)
      const method = req.method ?? 'GET'
      const key = `${method} ${route}`
      if (!Object.hasOwn(routes, key)) {
        const allowed = ['GET', 'POST'].filter((verb) => Object.hasOwn(routes, `${verb} ${route}`))
        if (allowed.length === 0) throw new HttpError('未知接口', 404)
        res.setHeader?.('allow', allowed.join(', '))
        throw new HttpError('不支持的请求方法', 405)
      }
      const body = method === 'POST' ? await readBody(req) : undefined
      const payload = await routes[key](url.searchParams, body ?? {})
      sendJson(res, 200, { ok: true, ...payload })
    } catch (error) {
      if (res.writableEnded) return
      const status = Number.isInteger(error?.status) ? error.status : 500
      const message = status === 500 ? `内部错误：${error?.message ?? error}` : error.message
      sendJson(res, status, { ok: false, error: message })
    }
  }

  /** Host events from the plugin manager, routed to the job of the matching request. */
  function onEvent(kind, payload) {
    let ctx
    try {
      ctx = context()
    } catch {
      return
    }
    if (kind === 'log') ctx.jobs.onLog(payload)
    else ctx.jobs.onState(payload)
  }

  return { handleApi, onEvent, routes }
}
