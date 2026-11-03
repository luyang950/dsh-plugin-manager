// dsh-plugin-manager — host half (cordis plugin).
//
// Owns the job queue that updates, switches, installs and removes plugins through
// DSH's own plugin manager service, and a JSON API under /dsh-plugin-manager/api/*
// for the browser half (see lib/api.mjs). Jobs are written to
// <profile>/.dsh-plugin-manager/ so they outlive a page reload — and this plugin's
// own update, which unloads this very instance halfway through.
//
// Services are read lazily with ctx.get(): `pluginManager` and `profileContext`
// exist only in a managed profile, and `webServer` is published late (absent in
// headless profiles), so it is attached with ctx.inject().

import { API_PREFIX, createApi } from './lib/api.mjs'

export { API_PREFIX }
export const name = 'dsh-plugin-manager'
export const inject = []

export function apply(ctx) {
  const api = createApi({
    profileDir: () => ctx.get('profileContext')?.dir,
    pluginManager: () => ctx.get('pluginManager'),
  })

  ctx.on('plugin-manager/install-log', (chunk) => api.onEvent('log', chunk))
  ctx.on('plugin-manager/install-state', (progress) => api.onEvent('state', progress))

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: api.handleApi }),
      'dsh-plugin-manager: api',
    )
  })
}
