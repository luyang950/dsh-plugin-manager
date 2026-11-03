// lib/sources.mjs — what kind of `pnpm add` spec a plugin was installed from, and
// for git sources, where its repository lives and which ref it follows.
//
// The browser half (lib/client.js) carries its own copy of classifySource; the test
// suite runs both copies over the same table so they cannot drift apart.

const TARBALL = /\.(?:tgz|tar\.gz|tar)(?:[?#].*)?$/i
const SHA = /^[0-9a-f]{40}$/i
const SEGMENT = /^[A-Za-z0-9_.-]+$/
const ALIAS = /^((?:@[^/@\s]+\/)?[^@/:\s]+)@(?=(?:github|gh|gitlab|bitbucket|git|git\+[a-z]+|https?|file|link):)/i

export const KINDS = Object.freeze(['github', 'git', 'path', 'tarball', 'registry'])

/** Split a leading `<name>@` (alias form) from a non-registry spec. */
export function splitAlias(spec, name) {
  const text = String(spec ?? '').trim()
  if (name && text.startsWith(`${name}@`)) {
    const rest = text.slice(name.length + 1)
    // `name@^1.0.0` is a registry range, not an alias prefix.
    return /^(?:github|gh|gitlab|bitbucket|git|git\+[a-z]+|https?|file|link):|^git@|^[\w.-]+\/[\w.-]+(?:#.*)?$/i.test(rest)
      ? { alias: name, spec: rest }
      : { alias: '', spec: text }
  }
  const match = ALIAS.exec(text)
  return match ? { alias: match[1], spec: text.slice(match[0].length) } : { alias: '', spec: text }
}

/**
 * 'github' | 'git' | 'path' | 'tarball' | 'registry', or null for nothing.
 * @param source - the spec (`listBundles()[].source` or the recorded dependency).
 * @param name - the package name, to look through a `<name>@` prefix.
 */
export function classifySource(source, name) {
  if (typeof source !== 'string') return null
  const { spec } = splitAlias(source, name)
  if (!spec) return null
  if (/^(?:github|gh):/i.test(spec)) return 'github'
  if (/^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?(?:www\.)?github\.com[/:]/i.test(spec)) {
    return /^https?:/i.test(spec) && TARBALL.test(spec) ? 'tarball' : 'github'
  }
  if (/^git@github\.com:/i.test(spec)) return 'github'
  if (/^(?:gitlab|bitbucket|git):/i.test(spec) || /^git\+[a-z]+:/i.test(spec) || /^[\w.-]+@[\w.-]+:/.test(spec)) return 'git'
  if (/^(?:file|link):/i.test(spec)) return /^link:/i.test(spec) || !TARBALL.test(spec) ? 'path' : 'tarball'
  if (/^https?:\/\//i.test(spec)) return /\.git(?:#.*)?$/i.test(spec) ? 'git' : 'tarball'
  if (/^(?:\/|~\/|\.\.?\/|[A-Za-z]:[\\/])/.test(spec)) return TARBALL.test(spec) ? 'tarball' : 'path'
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(spec)) return 'github' // pnpm's owner/repo shorthand
  return 'registry'
}

function safeUrl(url) {
  return typeof url === 'string' && url.length < 2048 && !/\s/.test(url) && !url.startsWith('-') ? url : null
}

/**
 * Where a git-sourced spec's repository lives.
 * @returns `{ url, ref, range?, web?, owner?, repo?, github }` or null for non-git specs.
 *   `url` is what `git ls-remote` is given; `ref` is the `#ref` (empty: default branch).
 */
export function gitRemote(source, name) {
  const kind = classifySource(source, name)
  if (kind !== 'github' && kind !== 'git') return null
  let { spec } = splitAlias(source, name)
  let ref = ''
  const hash = spec.indexOf('#')
  if (hash >= 0) {
    ref = spec.slice(hash + 1)
    spec = spec.slice(0, hash)
  }
  let range
  if (ref.startsWith('semver:')) {
    range = ref.slice(7)
    ref = ''
  }
  const extra = range === undefined ? {} : { range }
  if (kind === 'github') {
    let path
    let match
    if ((match = /^(?:github|gh):(.+)$/i.exec(spec))) path = match[1]
    else if ((match = /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?(?:www\.)?github\.com[/:](.+)$/i.exec(spec))) path = match[1]
    else if ((match = /^git@github\.com:(.+)$/i.exec(spec))) path = match[1]
    else path = spec
    const [owner, rawRepo, ...rest] = path.replace(/\/+$/, '').split('/')
    if (rest.length > 0 || !owner || !rawRepo) return null
    const repo = rawRepo.replace(/\.git$/i, '')
    if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return null
    return { github: true, owner, repo, url: `https://github.com/${owner}/${repo}.git`, web: `https://github.com/${owner}/${repo}`, ref, ...extra }
  }
  let match
  if ((match = /^(gitlab|bitbucket):(.+)$/i.exec(spec))) {
    const host = match[1].toLowerCase() === 'gitlab' ? 'gitlab.com' : 'bitbucket.org'
    const path = match[2].replace(/\.git$/i, '')
    if (!path.split('/').every((part) => SEGMENT.test(part))) return null
    return { github: false, url: `https://${host}/${path}.git`, web: `https://${host}/${path}`, ref, ...extra }
  }
  const url = safeUrl(spec.replace(/^git\+/i, ''))
  if (!url) return null
  const web = /^https?:\/\//i.test(url) ? url.replace(/\.git$/i, '') : undefined
  return { github: false, url, ...(web ? { web } : {}), ref, ...extra }
}

const REF = /^(?!-)[A-Za-z0-9._/@+-]{1,200}$/

/** Whether `ref` is acceptable after `#` in a git spec. */
export function validRef(ref) {
  return typeof ref === 'string' && (SHA.test(ref) || (REF.test(ref) && !ref.includes('..')))
}

export function isCommit(ref) {
  return typeof ref === 'string' && SHA.test(ref)
}

/** The same git spec following `ref` (empty: the default branch). Keeps the original form. */
export function specWithRef(source, ref, name) {
  const kind = classifySource(source, name)
  if (kind !== 'github' && kind !== 'git') throw new Error('只有 git 来源可以切换版本')
  if (ref && !validRef(ref)) throw new Error(`无效的 ref：${ref}`)
  const { alias, spec } = splitAlias(source, name)
  const base = spec.replace(/#.*$/, '')
  return `${alias ? `${alias}@` : ''}${base}${ref ? `#${ref}` : ''}`
}
