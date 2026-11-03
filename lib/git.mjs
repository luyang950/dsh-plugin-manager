// lib/git.mjs — the commit pnpm-lock.yaml locked for a git-sourced plugin, and what
// its repository's refs point at now (`git ls-remote`, never prompting).

import { execFile } from 'node:child_process'

import { gitRemote, isCommit } from './sources.mjs'

const SHA = /^[0-9a-f]{40}$/i

/** Unquote a YAML mapping key or scalar the way pnpm writes them (plain, '…' or "…"). */
function unquote(text) {
  const value = text.trim()
  if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0]) {
    return value[0] === "'" ? value.slice(1, -1).replace(/''/g, "'") : value.slice(1, -1)
  }
  return value
}

export function shaIn(text) {
  if (typeof text !== 'string') return null
  // codeload.github.com/o/r/tar.gz/<sha>, github.com/o/r/<sha>, git+https://…#<sha>
  const match = /(?:^|[/#])([0-9a-f]{40})(?:$|[/?#)'"\s])/i.exec(text)
  return match ? match[1].toLowerCase() : null
}

/**
 * What pnpm-lock.yaml records for a direct dependency of the profile (importer `.`):
 * `{ specifier, version }` or null. A small line scanner over pnpm's two-space YAML.
 */
export function lockedEntry(lockText, name) {
  if (typeof lockText !== 'string' || !name) return null
  let section = ''
  let importer = ''
  let group = ''
  let current = ''
  const entry = {}
  for (const line of lockText.split(/\r?\n/)) {
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
    } else if (section === 'importers' && importer === '.' && indent === 8 && current === name) {
      if (key === 'specifier' || key === 'version') entry[key] = value
    }
  }
  if (entry.version !== undefined) return entry
  // Older lockfiles (v6) keep `dependencies:` at the top level instead of under importers.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const fallback = new RegExp(`^\\s+'?${escaped}@([^\\s']+)'?:`, 'm').exec(lockText)
  return fallback ? { version: fallback[1] } : null
}

/** The commit the lockfile pins a git-sourced dependency to, or null. */
export function lockedCommit(lockText, name) {
  return shaIn(lockedEntry(lockText, name)?.version ?? null)
}

/** Run `git ls-remote` without ever prompting. Resolves to stdout. */
export function gitLsRemote(url, args = [], { cwd, timeoutMs = 15_000, patterns = [] } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.askPass=', 'ls-remote', ...args, '--', url, ...patterns],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
        },
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

/**
 * Parse `git ls-remote --symref <url>`: the default branch, HEAD, branches and tags
 * (a tag's commit is its peeled `^{}` row when there is one).
 */
export function parseRefs(output) {
  let defaultBranch = ''
  let head = null
  const branches = new Map()
  const tags = new Map()
  const peeled = new Map()
  for (const line of String(output).split('\n')) {
    const text = line.trim()
    if (!text) continue
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(text)
    if (symref) {
      defaultBranch = symref[1]
      continue
    }
    const [sha, ref] = text.split(/\s+/)
    if (!SHA.test(sha ?? '') || !ref) continue
    const commit = sha.toLowerCase()
    if (ref === 'HEAD') head = commit
    else if (ref.startsWith('refs/heads/')) branches.set(ref.slice(11), commit)
    else if (ref.startsWith('refs/tags/') && ref.endsWith('^{}')) peeled.set(ref.slice(10, -3), commit)
    else if (ref.startsWith('refs/tags/')) tags.set(ref.slice(10), commit)
  }
  for (const [tag, commit] of peeled) tags.set(tag, commit)
  if (!head && defaultBranch) head = branches.get(defaultBranch) ?? null
  const list = (map) => [...map].map(([name, commit]) => ({ name, commit }))
  return { defaultBranch, head, branches: list(branches), tags: list(tags).reverse() }
}

/** The commit `ref` (empty: HEAD) points at in parsed refs, or null. */
export function resolveRef(refs, ref) {
  if (!ref) return refs.head
  if (isCommit(ref)) return ref.toLowerCase()
  return refs.tags.find((tag) => tag.name === ref)?.commit ?? refs.branches.find((branch) => branch.name === ref)?.commit ?? null
}

/** Backwards-compatible helper: the commit a ref name points at in raw ls-remote output. */
export function pickRemoteCommit(output, ref) {
  return resolveRef(parseRefs(output), ref) ?? null
}

/**
 * Compare the locked commit of one git-sourced plugin with the ref it follows.
 * @returns `{ remote, behind, pinned?, ref, error? }`
 */
export async function remoteStatus({ source, name, locked, cwd, lsRemote = gitLsRemote, timeoutMs }) {
  const remote = gitRemote(source, name)
  if (!remote) return { checked: false, behind: false }
  const ref = remote.ref || ''
  const base = { checked: true, ref: ref || 'HEAD', url: remote.url }
  if (remote.range !== undefined) return { ...base, ref: `semver:${remote.range}`, behind: false, error: 'semver 范围不做比较' }
  if (isCommit(ref)) return { ...base, remote: ref.toLowerCase(), pinned: true, behind: false }
  try {
    const refs = parseRefs(await lsRemote(remote.url, ['--symref'], { cwd, timeoutMs }))
    const commit = resolveRef(refs, ref)
    if (!commit) return { ...base, behind: false, error: `远端没有 ${ref || 'HEAD'}` }
    return { ...base, remote: commit, defaultBranch: refs.defaultBranch, behind: Boolean(locked) && locked !== commit }
  } catch (error) {
    return { ...base, behind: false, error: error?.message ?? String(error) }
  }
}

/** All branches and tags of a git-sourced plugin's repository. */
export async function listRemoteRefs({ source, name, cwd, lsRemote = gitLsRemote, timeoutMs }) {
  const remote = gitRemote(source, name)
  if (!remote) throw Object.assign(new Error('只有 git 来源可以列出分支和 tag'), { status: 400 })
  const refs = parseRefs(await lsRemote(remote.url, ['--symref'], { cwd, timeoutMs }))
  return { url: remote.url, web: remote.web, ref: remote.ref, ...refs }
}

/**
 * Whether a git failure says the host could not be reached (as opposed to "not
 * found", "authentication failed" and the like, which a retry does not fix).
 */
export function isNetworkError(message) {
  return /Could not resolve host|Failed to connect|Connection (?:timed out|refused|reset|closed)|SSL_ERROR|SSL_connect|gnutls|TLS|timed out|超时|Operation timed out|early EOF|RPC failed|Empty reply|Network is unreachable|Recv failure|Send failure|unexpected disconnect|kex_exchange_identification/i.test(
    String(message ?? ''),
  )
}
