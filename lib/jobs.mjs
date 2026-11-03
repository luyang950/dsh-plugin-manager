// lib/jobs.mjs — the job queue that changes plugins, one job at a time.
//
// Every change goes through DSH's own plugin manager service (`removeBundle`,
// `installBundle`), exactly as its Plugins page does; this module only sequences the
// calls, remembers what a plugin was before, and writes each step to the store.
//
// The queue lives on `globalThis` (per profile directory), not in this module: when
// this plugin updates itself, its own instance is unloaded halfway through the job.
// The running loop keeps the plugin-manager service it captured and finishes the job;
// the reinstalled instance finds the same queue, sees it busy, and reads the outcome
// from the job file.

import { lockedCommit, remoteStatus } from './git.mjs'
import { readProfile, SELF, snapshot } from './inventory.mjs'
import { specWithRef, validRef } from './sources.mjs'
import { newJobId } from './store.mjs'

const RUNNERS = Symbol.for('dsh-plugin-manager.runners')
const LOG_LIMIT = 48 * 1024
export const ACTIVE = Object.freeze(['queued', 'removing', 'installing'])
export const TYPES = Object.freeze(['update', 'switch', 'install', 'remove'])

/** The shared queue for one profile directory (survives this module being reloaded). */
export function runnerState(profileDir) {
  const all = (globalThis[RUNNERS] ??= new Map())
  let state = all.get(profileDir)
  if (!state) {
    state = { queue: [], busy: false, live: new Set(), logs: new Map(), requests: new Map(), details: new Map() }
    all.set(profileDir, state)
  }
  return state
}

function tail(text, limit = LOG_LIMIT) {
  const value = String(text ?? '')
  return value.length > limit ? value.slice(-limit) : value
}

function lastLines(text, count) {
  return String(text ?? '').replace(/\s+$/, '').split('\n').slice(-count).join('\n')
}

/** Why a plugin-manager result is not a success, or null when it is. */
export function failureOf(result) {
  if (!result || typeof result !== 'object') return { code: 'no-result' }
  const pkg = result.packageResult
  const base = {
    ...(result.error?.diagnostic ? { diagnostic: tail(result.error.diagnostic, 4000) } : {}),
    ...(pkg?.kind ? { kind: pkg.kind } : {}),
    ...(pkg && pkg.exitCode !== 0 ? { output: lastLines(pkg.output, 30) } : {}),
    ...(Array.isArray(result.pendingBuilds) && result.pendingBuilds.length ? { pendingBuilds: result.pendingBuilds } : {}),
    ...(Array.isArray(result.error?.incompatible) ? { incompatible: result.error.incompatible } : {}),
  }
  if (result.error) return { code: result.error.code, ...base }
  if (result.application === 'failed' || result.application === 'cancelled') return { code: result.application, ...base }
  return null
}

function thrown(error) {
  return { code: 'exception', diagnostic: String(error?.message ?? error) }
}

/**
 * @param deps - `{ profileDir, store, pluginManager: () => service, now? }`
 */
export function createJobs(deps) {
  const { profileDir, store } = deps
  const now = deps.now ?? Date.now
  const state = runnerState(profileDir)

  /** Normalise a request into a queued job, or throw a 400. */
  function makeJob(request, batch) {
    const type = request?.type
    if (!TYPES.includes(type)) throw Object.assign(new Error(`未知的任务类型：${type}`), { status: 400 })
    const name = typeof request.name === 'string' ? request.name : ''
    const spec = typeof request.spec === 'string' ? request.spec.trim() : ''
    const ref = type === 'switch' && typeof request.ref === 'string' ? request.ref.trim() : undefined
    if (ref !== undefined && ref !== '' && !validRef(ref)) throw Object.assign(new Error(`无效的 ref：${ref}`), { status: 400 })
    const needsSpec = (type === 'switch' && ref === undefined) || type === 'install'
    if ((type !== 'install' && !name) || (needsSpec && !spec) || spec.startsWith('-') || /[\r\n\0]/.test(spec)) {
      throw Object.assign(new Error('任务缺少 name 或 spec'), { status: 400 })
    }
    const at = now()
    return {
      id: newJobId(at),
      type,
      name: name || undefined,
      spec: spec || undefined,
      ref,
      previousSpec: typeof request.previousSpec === 'string' ? request.previousSpec : undefined,
      enabled: request.enabled !== false,
      // An import applies the list's enabled state; otherwise a change keeps the current one.
      setEnabled: request.setEnabled === true,
      reason: typeof request.reason === 'string' ? request.reason.slice(0, 40) : undefined,
      batch,
      self: name === SELF,
      phase: 'queued',
      removed: false,
      attempt: 0,
      createdAt: at,
      updatedAt: at,
    }
  }

  /** Queue one job or a batch; this plugin's own update always goes last. */
  async function enqueue(requests) {
    const list = Array.isArray(requests) ? requests : [requests]
    if (list.length === 0) throw Object.assign(new Error('没有任务'), { status: 400 })
    const batch = list.length > 1 ? newJobId(now()) : undefined
    const jobs = list.map((request) => makeJob(request, batch))
    jobs.sort((a, b) => Number(a.self) - Number(b.self))
    for (const job of jobs) {
      await store.saveJob({ ...job, pid: process.pid })
      state.queue.push(job.id)
    }
    kick()
    return jobs
  }

  function kick() {
    if (state.busy) return
    state.busy = true
    // Capture the service now: during a self-update this instance is unloaded mid-job.
    const pluginManager = deps.pluginManager()
    void (async () => {
      try {
        while (state.queue.length > 0) {
          const id = state.queue.shift()
          state.live.add(id)
          try {
            await run(id, pluginManager)
          } catch (error) {
            const job = await store.readJob(id)
            if (job) await store.saveJob({ ...job, phase: 'failed', failure: thrown(error), updatedAt: now() })
          } finally {
            state.live.delete(id)
            state.logs.delete(id)
            state.details.delete(id)
            state.details.delete(`${id}:run`)
          }
        }
      } finally {
        state.busy = false
      }
    })()
  }

  async function run(id, pluginManager) {
    let job = await store.readJob(id)
    if (!job || job.phase !== 'queued') return
    const save = async (patch) => {
      job = { ...job, ...patch, pid: process.pid, updatedAt: now() }
      await store.saveJob(job)
      return job
    }
    if (!pluginManager) return save({ phase: 'failed', failure: { code: 'no-plugin-manager' } })

    // What the plugin is now, for the history (rollback) and the before/after line.
    const bundles = job.type === 'install' ? [] : await pluginManager.listBundles()
    const current = bundles.find((bundle) => bundle.name === job.name)
    if (job.type !== 'install' && !job.removed) {
      if (!current) return save({ phase: 'failed', failedStage: 'remove', failure: { code: 'unknown-plugin' } })
      // An update reinstalls what the profile records, whatever the page sent, and an
      // update or switch keeps the plugin enabled or disabled as it is now.
      if ((job.type === 'update' || job.type === 'switch') && !job.before && !job.setEnabled) await save({ enabled: current.enabled === true })
      if (job.type === 'update' && !job.before) {
        if (!current.source) return save({ phase: 'failed', failedStage: 'remove', failure: { code: 'no-source' } })
        await save({ spec: current.source })
      }
      // A switch by ref keeps the recorded form of the source and changes only `#ref`.
      if (job.type === 'switch' && job.ref !== undefined && !job.before) {
        try {
          await save({ spec: specWithRef(current.source, job.ref, job.name) })
        } catch (error) {
          return save({ phase: 'failed', failedStage: 'remove', failure: { code: 'invalid-ref', diagnostic: error.message } })
        }
      }
      if (!job.before) {
        const before = await snapshot(profileDir, job.name, current.source)
        await save({ before, previousSpec: job.previousSpec ?? current.source })
        if (current.source && job.type !== 'remove') {
          await store.recordHistory(job.name, { ...before, at: now(), reason: job.type })
        }
      }
    }

    if ((job.type === 'update' || job.type === 'switch' || job.type === 'remove') && !job.removed) {
      await save({ phase: 'removing', failure: undefined, failedStage: undefined })
      let removed
      try {
        removed = await pluginManager.removeBundle(job.name)
      } catch (error) {
        return save({ phase: 'failed', failedStage: 'remove', failure: thrown(error) })
      }
      const failure = failureOf(removed)
      // Without HMR a running bundle cannot be removed; installing over it is what
      // DSH's own Update does, and it reports restart-required.
      if (failure && !(failure.code === 'stop-profile' && job.type !== 'remove')) {
        return save({ phase: 'failed', failedStage: 'remove', failure })
      }
      await save({ removed: !failure })
      if (job.type === 'remove') return save({ phase: 'done', application: removed.application, restartReason: removed.restartReason })
    }

    const requestId = `${SELF}-${job.id}-${job.attempt}`
    state.requests.set(requestId, id)
    state.logs.set(id, '')
    await save({ phase: 'installing', requestId, failure: undefined, failedStage: undefined })
    let installed
    try {
      installed = await pluginManager.installBundle(job.spec, { enabled: job.enabled, requestId })
    } catch (error) {
      installed = undefined
      await save({ phase: 'failed', failedStage: 'install', failure: thrown(error), log: tail(state.logs.get(id)) })
      state.requests.delete(requestId)
      return job
    }
    state.requests.delete(requestId)
    const log = tail(state.logs.get(id) || installed?.packageResult?.output || '')
    const failure = failureOf(installed)
    if (failure) return save({ phase: 'failed', failedStage: 'install', failure, log })
    const { lockText } = await readProfile(profileDir)
    const name = installed.bundle ?? job.name
    const commit = lockedCommit(lockText, name)
    await refreshCheck(name, job.spec, commit)
    return save({
      phase: 'done',
      log,
      name,
      after: { spec: job.spec, commit, version: installed.version },
      application: installed.application,
      restartReason: installed.restartReason,
    })
  }

  /** After a change, compare the new commit with its remote so the list is current at once. */
  async function refreshCheck(name, source, locked) {
    try {
      const status = await remoteStatus({ source, name, locked, cwd: profileDir, timeoutMs: 8000, ...(deps.lsRemote ? { lsRemote: deps.lsRemote } : {}) })
      if (!status.checked) return
      const checks = await store.readChecks()
      checks[name] = { ...status, locked, source, at: now() }
      await store.writeChecks(checks)
    } catch {
      // the next check will tell
    }
  }

  /** Put a failed (or interrupted) job back in the queue: install only when it was already removed. */
  async function retry(id, { restore = false } = {}) {
    const job = await store.readJob(id)
    if (!job || (job.phase !== 'failed' && job.phase !== 'interrupted')) {
      throw Object.assign(new Error('只有失败的任务可以重试'), { status: 409 })
    }
    const patch = { phase: 'queued', attempt: (job.attempt ?? 0) + 1, failure: undefined, failedStage: undefined, dismissed: false, updatedAt: now() }
    if (restore) {
      if (!job.previousSpec) throw Object.assign(new Error('没有原来的来源可以恢复'), { status: 409 })
      Object.assign(patch, { spec: job.previousSpec, restored: true })
    }
    const next = await store.saveJob({ ...job, ...patch, pid: process.pid })
    state.queue.push(id)
    kick()
    return next
  }

  async function dismiss(id) {
    const job = await store.readJob(id)
    if (!job) throw Object.assign(new Error('任务不存在'), { status: 404 })
    if (ACTIVE.includes(job.phase) && (state.live.has(id) || state.queue.includes(id))) {
      throw Object.assign(new Error('任务还在进行'), { status: 409 })
    }
    return store.saveJob({ ...job, dismissed: true, updatedAt: now() })
  }

  /**
   * Jobs newest first, with live logs folded in. An active job last written by another
   * process was cut off by a DSH restart: it is marked interrupted. (A job of this
   * process that is neither queued nor running has just finished: read it again.)
   */
  async function list() {
    const jobs = await store.listJobs()
    return Promise.all(
      jobs.map(async (job) => {
        if (ACTIVE.includes(job.phase) && !state.live.has(job.id) && !state.queue.includes(job.id)) {
          if (job.pid === undefined || job.pid !== process.pid) {
            return store.saveJob({ ...job, phase: 'interrupted', updatedAt: now() })
          }
          return (await store.readJob(job.id)) ?? job
        }
        if (state.live.has(job.id)) {
          const log = state.logs.get(job.id)
          return { ...job, ...(log ? { log: tail(log, 16 * 1024) } : {}), ...(state.details.get(job.id) ? { detail: state.details.get(job.id) } : {}) }
        }
        return job
      }),
    )
  }

  /** `plugin-manager/install-log`. */
  function onLog(chunk) {
    const id = chunk && state.requests.get(chunk.requestId)
    if (!id) return
    let text = state.logs.get(id) ?? ''
    if (chunk.jobId !== undefined && chunk.jobId !== state.details.get(`${id}:run`)) {
      state.details.set(`${id}:run`, chunk.jobId)
      if (Array.isArray(chunk.argv)) text += `${text ? '\n' : ''}$ ${chunk.argv.join(' ')}\n`
    }
    state.logs.set(id, tail(text + String(chunk.text ?? '')))
  }

  /** `plugin-manager/install-state`. */
  function onState(progress) {
    const id = progress && state.requests.get(progress.requestId)
    if (!id) return
    if (progress.phase === 'applying' || progress.phase === 'cancelling') state.details.set(id, progress.phase)
    else state.details.delete(id)
  }

  return { enqueue, retry, dismiss, list, onLog, onState, state }
}
