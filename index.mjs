// dsh-plugin-updater — host half (cordis plugin).
//
// The Update button itself lives entirely in the browser half: it calls the
// plugin manager's own `removeBundle` / `installBundle` over the Remote. The host
// half only answers one read-only question the browser cannot: "does the GitHub
// repository a plugin was installed from have commits newer than the one locked in
// this profile?" It reads the profile's package.json and pnpm-lock.yaml and runs
// `git ls-remote`; it never writes.
//
// `webServer` is NOT in `inject`: it is published late and is absent in headless
// profiles, so it is attached with ctx.inject() and the plugin settles without it.

import { commitStatus } from './lib/commits.mjs'

export const name = 'dsh-plugin-updater'
export const inject = []

export const API_PREFIX = '/dsh-plugin-updater/api'
const CACHE_MS = 10 * 60 * 1000
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i

class HttpError extends Error {
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

/**
 * Build the API handler for one profile directory.
 * @param {{ profileDir: () => string | undefined, lsRemote?: Function, now?: () => number }} options
 */
export function createApi({ profileDir, lsRemote, now = Date.now }) {
  const cache = new Map() // name → { at, promise }

  async function commits(params) {
    const pkg = params.get('name') ?? ''
    if (!NAME.test(pkg)) throw new HttpError('缺少或无效的参数 name')
    const dir = profileDir()
    if (!dir) throw new HttpError('当前 DSH 没有受管 profile', 503)
    const key = `${dir}\0${pkg}`
    const cached = cache.get(key)
    if (params.get('refresh') !== '1' && cached && now() - cached.at < CACHE_MS) return cached.promise
    const promise = commitStatus({ profileDir: dir, name: pkg, ...(lsRemote ? { lsRemote } : {}) })
    cache.set(key, { at: now(), promise })
    promise.then(
      (status) => {
        // A failed check is not worth keeping for ten minutes.
        if (status.error && cache.get(key)?.promise === promise) cache.delete(key)
      },
      () => cache.delete(key),
    )
    return promise
  }

  const routes = { commits }

  return async function handleApi(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(`${API_PREFIX}/`)) throw new HttpError('未知接口', 404)
      const route = url.pathname.slice(API_PREFIX.length + 1)
      if (!Object.hasOwn(routes, route)) throw new HttpError('未知接口', 404)
      if ((req.method ?? 'GET') !== 'GET') {
        res.setHeader?.('allow', 'GET')
        throw new HttpError('不支持的请求方法', 405)
      }
      const status = await routes[route](url.searchParams)
      sendJson(res, 200, { ok: true, status })
    } catch (error) {
      if (res.writableEnded) return
      const status = Number.isInteger(error?.status) ? error.status : 500
      const message = status === 500 ? `内部错误：${error?.message ?? error}` : error.message
      sendJson(res, status, { ok: false, error: message })
    }
  }
}

export function apply(ctx) {
  const handleApi = createApi({ profileDir: () => ctx.get('profileContext')?.dir })
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handleApi }),
      'dsh-plugin-updater: api',
    )
  })
}
