// lib/store.mjs — the plugin's own state, kept next to the profile it manages:
//
//   <profile>/.dsh-plugin-manager/jobs/<id>.json   one file per job (queued → done)
//   <profile>/.dsh-plugin-manager/history.json     what each plugin was before an update
//   <profile>/.dsh-plugin-manager/checks.json      the last remote-commit check
//   <profile>/.dsh-plugin-manager/known.json       every third-party plugin seen, removed ones too
//
// Jobs live on disk because the job that updates this plugin outlives the plugin
// instance that started it: the reinstalled instance reads the outcome back from here.

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const STATE_DIR = '.dsh-plugin-manager'
const MAX_JOBS = 60
const MAX_HISTORY = 20
const ID = /^[a-z0-9]{6,16}-[a-f0-9]{6}$/

export function stateDir(profileDir) {
  return join(profileDir, STATE_DIR)
}

async function writeJson(path, value) {
  const temp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temp, path)
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

export function newJobId(now = Date.now()) {
  return `${now.toString(36)}-${randomBytes(3).toString('hex')}`
}

export function validJobId(id) {
  return typeof id === 'string' && ID.test(id)
}

export function createStore(profileDir) {
  const root = stateDir(profileDir)
  const jobsDir = join(root, 'jobs')
  const ready = mkdir(jobsDir, { recursive: true }).then(() => undefined)

  async function saveJob(job) {
    await ready
    await writeJson(join(jobsDir, `${job.id}.json`), job)
    return job
  }

  async function readJob(id) {
    if (!validJobId(id)) return null
    await ready
    return readJson(join(jobsDir, `${id}.json`), null)
  }

  /** Newest first. Old finished jobs beyond MAX_JOBS are deleted on the way. */
  async function listJobs() {
    await ready
    let names = []
    try {
      names = (await readdir(jobsDir)).filter((file) => file.endsWith('.json'))
    } catch {
      return []
    }
    const jobs = (await Promise.all(names.map((file) => readJson(join(jobsDir, file), null)))).filter(
      (job) => job && validJobId(job.id),
    )
    jobs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || String(b.id).localeCompare(String(a.id)))
    const stale = jobs.slice(MAX_JOBS).filter((job) => !['queued', 'checking', 'removing', 'installing', 'switching'].includes(job.phase))
    await Promise.all(stale.map((job) => rm(join(jobsDir, `${job.id}.json`), { force: true })))
    const dropped = new Set(stale.map((job) => job.id))
    return jobs.filter((job) => !dropped.has(job.id))
  }

  async function readHistory() {
    await ready
    const history = await readJson(join(root, 'history.json'), {})
    return history && typeof history === 'object' && !Array.isArray(history) ? history : {}
  }

  /** Remember what `name` was before a change (newest first, de-duplicated by spec + commit). */
  async function recordHistory(name, entry) {
    const history = await readHistory()
    const list = Array.isArray(history[name]) ? history[name] : []
    const same = (item) => item.spec === entry.spec && (item.commit ?? null) === (entry.commit ?? null)
    history[name] = [entry, ...list.filter((item) => !same(item))].slice(0, MAX_HISTORY)
    await writeJson(join(root, 'history.json'), history)
    return history[name]
  }

  async function readChecks() {
    await ready
    const checks = await readJson(join(root, 'checks.json'), {})
    return checks && typeof checks === 'object' ? checks : {}
  }

  async function writeChecks(checks) {
    await ready
    await writeJson(join(root, 'checks.json'), checks)
  }

  /** Every third-party plugin seen in this profile, removed ones included (`removedAt`). */
  async function readKnown() {
    await ready
    const known = await readJson(join(root, 'known.json'), {})
    return known && typeof known === 'object' && !Array.isArray(known) ? known : {}
  }

  async function writeKnown(known) {
    await ready
    await writeJson(join(root, 'known.json'), known)
  }

  /** Merge records into the known plugins, by name. */
  async function remember(records) {
    const known = await readKnown()
    for (const [name, record] of Object.entries(records)) known[name] = { ...known[name], ...record }
    await writeKnown(known)
    return known
  }

  /** Drop removed plugins from the record (installed ones are kept: they would come back). */
  async function forget(names) {
    const known = await readKnown()
    const dropped = []
    for (const name of names) {
      if (known[name]?.removedAt) {
        delete known[name]
        dropped.push(name)
      }
    }
    if (dropped.length) await writeKnown(known)
    return dropped
  }

  return { root, saveJob, readJob, listJobs, readHistory, recordHistory, readChecks, writeChecks, readKnown, writeKnown, remember, forget }
}
