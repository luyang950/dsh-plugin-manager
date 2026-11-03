// lib/commits.mjs — "is there a newer commit?" for a GitHub-sourced profile dependency.
//
// The profile's package.json records how a plugin was installed (`github:owner/repo`,
// `git+https://github.com/owner/repo.git#main`, …) and pnpm-lock.yaml records which
// commit that resolved to. `git ls-remote` tells what the same ref points at now.
// Nothing here writes anything; every input comes from the profile directory.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const SHA = /^[0-9a-f]{40}$/i
const SEGMENT = /^[A-Za-z0-9_.-]+$/

/**
 * The GitHub repository a recorded dependency value points at, or null.
 * Accepts the forms pnpm records: `github:o/r`, `o/r`, `git+https://github.com/o/r.git`,
 * `https://github.com/o/r`, `git+ssh://git@github.com/o/r.git`, `git@github.com:o/r.git`,
 * each with an optional `#ref`. A `#semver:` range is reported but not resolved.
 */
export function githubRepo(recorded) {
  if (typeof recorded !== 'string') return null
  let text = recorded.trim()
  // `name@github:o/r` — an alias prefix in front of a non-registry form.
  text = text.replace(/^(?:@[^/@\s]+\/)?[^@/:\s]+@(?=(?:github|gh|gitlab|bitbucket|git|git\+[a-z]+|https?|file|link):)/i, '')
  let ref = ''
  const hash = text.indexOf('#')
  if (hash >= 0) {
    ref = text.slice(hash + 1)
    text = text.slice(0, hash)
  }
  let path
  let match
  if ((match = /^(?:github|gh):(.+)$/i.exec(text))) path = match[1]
  else if ((match = /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?(?:www\.)?github\.com[/:](.+)$/i.exec(text))) path = match[1]
  else if ((match = /^git@github\.com:(.+)$/i.exec(text))) path = match[1]
  else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) path = text
  else return null
  const [owner, rawRepo, ...rest] = path.replace(/\/+$/, '').split('/')
  if (rest.length > 0 || !owner || !rawRepo) return null
  const repo = rawRepo.replace(/\.git$/i, '')
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return null
  if (ref.startsWith('semver:')) return { owner, repo, ref: '', range: ref.slice(7) }
  return { owner, repo, ref }
}

/** Unquote a YAML mapping key or scalar the way pnpm writes them (plain, '…' or "…"). */
function unquote(text) {
  const value = text.trim()
  if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0]) {
    return value[0] === "'" ? value.slice(1, -1).replace(/''/g, "'") : value.slice(1, -1)
  }
  return value
}

function shaIn(text) {
  if (typeof text !== 'string') return null
  // codeload.github.com/o/r/tar.gz/<sha>, github.com/o/r/<sha>, …#<sha>
  const match = /(?:^|[/#])([0-9a-f]{40})(?:$|[/?#)'"\s])/i.exec(text)
  return match ? match[1].toLowerCase() : null
}

/**
 * The commit pnpm-lock.yaml records for a direct dependency of the profile (importer `.`),
 * or null. A small line scanner: the lockfile is pnpm's own, two-space indented YAML.
 */
export function lockedCommit(lockText, name) {
  if (typeof lockText !== 'string' || !name) return null
  const lines = lockText.split(/\r?\n/)
  let section = '' // top-level key
  let importer = '' // second-level key under importers
  let group = '' // dependencies / optionalDependencies / devDependencies
  let current = '' // dependency name under the group
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const keyMatch = /^\s*((?:'[^']*'|"[^"]*"|[^:\s][^:]*?)):(?:\s+(.*))?$/.exec(line)
    if (!keyMatch) continue
    const key = unquote(keyMatch[1])
    const value = keyMatch[2] === undefined ? '' : unquote(keyMatch[2])
    if (indent === 0) {
      section = key
      importer = group = current = ''
    } else if (section === 'importers' && indent === 2) {
      importer = key
      group = current = ''
    } else if (section === 'importers' && importer === '.' && indent === 4) {
      group = key
      current = ''
    } else if (section === 'importers' && importer === '.' && indent === 6) {
      current = /dependencies$/i.test(group) ? key : ''
    } else if (section === 'importers' && importer === '.' && indent === 8 && current === name && key === 'version') {
      const sha = shaIn(value)
      if (sha) return sha
    }
  }
  // Older lockfiles (v6) keep `dependencies:` at the top level instead of under importers.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const fallback = new RegExp(`^\\s+'?${escaped}@([^\\s']+)'?:`, 'm').exec(lockText)
  return fallback ? shaIn(fallback[1]) : null
}

/** Run `git ls-remote` without ever prompting. Resolves to stdout. */
export function gitLsRemote(url, ref, { cwd, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.askPass=', 'ls-remote', url, ...(ref ? [ref] : ['HEAD'])],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const reason = String(stderr || error.message || error).trim().split('\n').slice(-3).join(' ')
          reject(new Error(error.killed ? `git ls-remote 超时（${timeoutMs} ms）` : reason || 'git ls-remote 失败'))
        } else resolve(String(stdout))
      },
    )
  })
}

/** Pick the commit a ref name points at from `git ls-remote` output (peeled tags win). */
export function pickRemoteCommit(output, ref) {
  const rows = String(output)
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((row) => row.length === 2 && SHA.test(row[0]))
  if (rows.length === 0) return null
  if (!ref) {
    const head = rows.find((row) => row[1] === 'HEAD')
    return (head ?? rows[0])[0].toLowerCase()
  }
  const wanted = [`refs/tags/${ref}^{}`, `refs/heads/${ref}`, `refs/tags/${ref}`, ref]
  for (const name of wanted) {
    const row = rows.find((candidate) => candidate[1] === name)
    if (row) return row[0].toLowerCase()
  }
  return rows[0][0].toLowerCase()
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Compare the locked commit of one profile dependency with the remote ref it tracks.
 * @returns {{name, kind, spec?, locked?, remote?, ref?, pinned?, behind, error?}}
 *   kind: 'github' when it was checked, 'other' for any other source, 'missing' when
 *   the profile does not depend on `name`.
 */
export async function commitStatus({ profileDir, name, lsRemote = gitLsRemote, timeoutMs }) {
  const manifestText = await readText(join(profileDir, 'package.json'))
  let manifest
  try {
    manifest = JSON.parse(manifestText ?? '')
  } catch {
    manifest = null
  }
  const recorded = manifest?.dependencies?.[name] ?? manifest?.optionalDependencies?.[name]
  if (typeof recorded !== 'string') return { name, kind: 'missing', behind: false }
  const repo = githubRepo(recorded)
  if (!repo) return { name, kind: 'other', spec: recorded, behind: false }
  const locked = lockedCommit(await readText(join(profileDir, 'pnpm-lock.yaml')), name)
  const base = { name, kind: 'github', spec: recorded, repo: `${repo.owner}/${repo.repo}`, ref: repo.ref || 'HEAD', locked }
  if (repo.range !== undefined) return { ...base, behind: false, error: 'semver 范围不做比较' }
  if (SHA.test(repo.ref)) return { ...base, remote: repo.ref.toLowerCase(), pinned: true, behind: false }
  try {
    const output = await lsRemote(`https://github.com/${repo.owner}/${repo.repo}.git`, repo.ref, { cwd: profileDir, timeoutMs })
    const remote = pickRemoteCommit(output, repo.ref)
    if (!remote) return { ...base, behind: false, error: `远端没有 ${repo.ref || 'HEAD'}` }
    return { ...base, remote, behind: Boolean(locked) && locked !== remote }
  } catch (error) {
    return { ...base, behind: false, error: error?.message ?? String(error) }
  }
}
