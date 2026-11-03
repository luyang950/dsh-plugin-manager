/* global window, document, fetch, console, setTimeout, clearTimeout */
// dsh-plugin-updater — browser half.
//
// Hand-written ModuleLoader bundle: no build step. The only hard dependency is
// `react`; DSH's own Button / Modal / Tag are borrowed when present (with plain
// fallbacks).
//
// What it adds to the Plugins page (ui-plugin-manager):
//   * `plugins.detail.actions` — an 更新 / Update button on the page of a third-party
//     bundle installed from GitHub, another git host, a local path or a tarball.
//     After a confirmation it calls the plugin manager's own `removeBundle(name)` and
//     then `installBundle(<original spec>, { enabled: <as before>, requestId })` —
//     the same two steps DSH's own Update runs for on-demand official plugins.
//   * `plugins.detail.badge` — 有新提交 / New commits, when the GitHub ref the plugin
//     was installed from has moved past the commit locked in the profile (the host
//     half answers that with `git ls-remote`).
//   * `shell.overlay` — the progress panel. Removing the bundle makes its page (and
//     the button on it) disappear, so the update runs in a store that outlives the
//     page and reports through a floating panel: steps, pnpm output, the failure
//     reason, and a retry when the plugin was left uninstalled.
//
// The original spec is the bundle's `source` from `pluginManager.listBundles()` —
// the same value the page shows as 代码来源: the profile dependency as `pnpm add`
// accepts it, local paths absolute, URL credentials stripped.

window.__ModuleLoader__.load({
  id: 'dsh-plugin-updater',
  factory: (require) => {
    var module = { exports: {} }

    const React = require('react')
    const h = React.createElement

    const SELF = 'dsh-plugin-updater'
    const NS = 'dshPluginUpdater'
    const API = '/dsh-plugin-updater/api'
    const LOG_LIMIT = 64 * 1024
    const LOG_LINES = 14
    const COMMIT_WAIT_MS = 4000

    /* ── text ────────────────────────────────────────────────────────────── */

    const ZH = {
      update: '更新',
      updateLabel: '从原来的安装来源更新「{name}」',
      updating: '更新中…',
      confirmTitle: '更新「{name}」？',
      confirmBody: '会先卸载这个插件，再从下面的来源重新安装最新代码，并保持{state}。',
      stateEnabled: '启用状态',
      stateDisabled: '停用状态',
      confirmRisk: '卸载之后如果安装失败，插件会处于未安装状态（可在进度面板里重试）。重装后它会排到组合包列表的末尾。',
      sourceLabel: '安装来源',
      cancel: '取消',
      confirm: '更新',
      close: '关闭',
      titleRunning: '正在更新「{name}」',
      titleDone: '「{name}」已更新',
      titleFailed: '「{name}」更新失败',
      stepRemove: '卸载当前版本',
      stepInstall: '从原来源重新安装',
      stepWaiting: '等待中',
      stepRunning: '进行中',
      stepDone: '完成',
      stepFailed: '失败',
      stepSkipped: '跳过',
      applying: '正在加载新代码…',
      cancelling: '正在取消…',
      doneVersion: '当前版本 {version}',
      doneCommit: '提交 {before} → {after}',
      doneSameCommit: '提交 {after}（与更新前相同）',
      doneCommitOnly: '提交 {after}',
      doneEnabled: '插件保持启用。',
      doneDisabled: '插件保持停用。',
      restartRequired: '需要重启 DSH 后生效。',
      removedWarning: '插件已经卸载，但还没有装回来。可以重试安装，或在插件页「添加插件」里用下面的来源手动安装。',
      removeFailedNote: '卸载没有完成，插件保持原样。',
      retry: '重试',
      retryInstall: '重试安装',
      showLog: 'pnpm 输出',
      hideLog: '收起输出',
      newCommits: '有新提交',
      newCommitsTitle: '已安装 {locked}，{ref} 上最新是 {remote}',
      'failure_transport': '没有连上 DSH：{message}',
      'failure_cancelled': '安装被取消。',
      'failure_failed': '操作没有成功。',
      'failure_incompatible-version': '新版本与当前 DSH 版本不兼容。',
      'failure_already-installed': 'DSH 认为它仍处于已安装状态。',
      'failure_not-bundle': '新代码里没有组合包声明（dsh.bundle.patch）。',
      'failure_invalid-spec': '安装来源无效。',
      'failure_not-removable': '这个插件不能卸载。',
      'failure_management-required': '插件管理需要这个包，不能卸载。',
      'failure_bundle-in-use': '组合包正在使用中。',
      'failure_unknown-plugin': 'DSH 找不到这个插件。',
      'failure_operation-error': '操作出错。',
      'failure_other': '操作失败（{code}）。',
      'kind_network': '网络连不上。',
      'kind_timeout': 'pnpm 长时间没有输出，已被终止。',
      'kind_integrity': '下载内容校验失败。',
      'kind_pnpm-missing': '找不到 pnpm。',
      'kind_not-found': '找不到这个包或仓库。',
      'kind_no-matching-version': '没有匹配的版本。',
      'kind_disk-full': '磁盘已满。',
      'kind_permission': 'profile 目录不可写。',
      'kind_build-blocked': 'pnpm 拦下了依赖的构建脚本：{names}。请在插件页「添加插件」里用同一来源安装，并允许这些脚本。',
      'kind_unknown': 'pnpm 执行失败。',
    }

    const EN = {
      update: 'Update',
      updateLabel: 'Update "{name}" from where it was installed',
      updating: 'Updating…',
      confirmTitle: 'Update "{name}"?',
      confirmBody: 'The plugin is uninstalled first, then reinstalled with the latest code from the source below, keeping it {state}.',
      stateEnabled: 'enabled',
      stateDisabled: 'disabled',
      confirmRisk: 'If the installation fails after the removal, the plugin stays uninstalled (you can retry from the progress panel). Once reinstalled it moves to the end of the bundle list.',
      sourceLabel: 'Source',
      cancel: 'Cancel',
      confirm: 'Update',
      close: 'Close',
      titleRunning: 'Updating "{name}"',
      titleDone: '"{name}" updated',
      titleFailed: 'Updating "{name}" failed',
      stepRemove: 'Uninstall the current version',
      stepInstall: 'Reinstall from the original source',
      stepWaiting: 'waiting',
      stepRunning: 'running',
      stepDone: 'done',
      stepFailed: 'failed',
      stepSkipped: 'skipped',
      applying: 'Loading the new code…',
      cancelling: 'Cancelling…',
      doneVersion: 'Version {version}',
      doneCommit: 'Commit {before} → {after}',
      doneSameCommit: 'Commit {after} (unchanged)',
      doneCommitOnly: 'Commit {after}',
      doneEnabled: 'The plugin stays enabled.',
      doneDisabled: 'The plugin stays disabled.',
      restartRequired: 'Restart DSH for the change to take effect.',
      removedWarning: 'The plugin was uninstalled but not reinstalled. Retry the installation, or install the source below from Add plugin on the Plugins page.',
      removeFailedNote: 'The removal did not finish; the plugin is unchanged.',
      retry: 'Retry',
      retryInstall: 'Retry install',
      showLog: 'pnpm output',
      hideLog: 'Hide output',
      newCommits: 'New commits',
      newCommitsTitle: 'Installed {locked}; {ref} is now at {remote}',
      'failure_transport': 'Could not reach DSH: {message}',
      'failure_cancelled': 'The installation was cancelled.',
      'failure_failed': 'The operation did not succeed.',
      'failure_incompatible-version': 'The new version is not compatible with this DSH version.',
      'failure_already-installed': 'DSH still considers it installed.',
      'failure_not-bundle': 'The new code declares no bundle (dsh.bundle.patch).',
      'failure_invalid-spec': 'The source is not a valid spec.',
      'failure_not-removable': 'This plugin cannot be uninstalled.',
      'failure_management-required': 'Plugin management needs this package; it cannot be uninstalled.',
      'failure_bundle-in-use': 'The bundle is in use.',
      'failure_unknown-plugin': 'DSH does not know this plugin.',
      'failure_operation-error': 'The operation failed.',
      'failure_other': 'The operation failed ({code}).',
      'kind_network': 'The network is unreachable.',
      'kind_timeout': 'pnpm printed nothing for too long and was stopped.',
      'kind_integrity': 'The download failed its integrity check.',
      'kind_pnpm-missing': 'pnpm was not found.',
      'kind_not-found': 'The package or repository was not found.',
      'kind_no-matching-version': 'No matching version.',
      'kind_disk-full': 'The disk is full.',
      'kind_permission': 'The profile directory is not writable.',
      'kind_build-blocked': 'pnpm blocked dependency build scripts: {names}. Install the same source from Add plugin on the Plugins page and allow them.',
      'kind_unknown': 'pnpm failed.',
    }

    function format(template, params) {
      if (typeof template !== 'string') return ''
      return template.replace(/\{(\w+)\}/g, (whole, key) =>
        params && params[key] !== undefined && params[key] !== null ? String(params[key]) : whole,
      )
    }

    /** Used when the page gives no translator (tests, older hosts). */
    function fallbackT(key, params) {
      return format(Object.hasOwn(ZH, key) ? ZH[key] : key, params)
    }

    function has(t, key) {
      const text = t(key)
      return typeof text === 'string' && text !== '' && text !== key && !text.endsWith(`.${key}`)
    }

    /* ── which plugins get the button ────────────────────────────────────── */

    const UPDATABLE = new Set(['github', 'git', 'path', 'tarball'])
    const TARBALL = /\.(?:tgz|tar\.gz|tar)(?:[?#].*)?$/i

    /**
     * Classify a `pnpm add` spec: 'github' | 'git' | 'path' | 'tarball' | 'registry',
     * or null for nothing. A leading `<name>@` (an alias, or the form the plugin
     * manager uses when the package's own name differs) is looked through.
     */
    function classifySource(source, name) {
      if (typeof source !== 'string') return null
      let spec = source.trim()
      if (!spec) return null
      if (name && spec.startsWith(`${name}@`)) spec = spec.slice(name.length + 1)
      else spec = spec.replace(/^(?:@[^/@\s]+\/)?[^@/:\s]+@(?=(?:github|gh|gitlab|bitbucket|git|git\+[a-z]+|https?|file|link):)/i, '')
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

    /**
     * What the button would do for this page subject, or null when it has nothing
     * to offer: only an installed, profile-owned, third-party bundle whose recorded
     * source is GitHub / git / a local path / a tarball — and never this plugin.
     * @param subject - the page's `{ kind, pkg }`.
     * @param bundles - `pluginManager.listBundles()` (for `source` and ownership).
     */
    function updateTarget(subject, bundles) {
      if (!subject || subject.kind !== 'bundle' || !subject.pkg) return null
      const pkg = subject.pkg
      if (typeof pkg.name !== 'string' || pkg.name === SELF) return null
      if (!pkg.installed || pkg.official || pkg.availability === 'installation') return null
      const bundle = Array.isArray(bundles) ? bundles.find((item) => item && item.name === pkg.name) : undefined
      if (!bundle || bundle.official || bundle.optional || !bundle.installed) return null
      if (bundle.availability === 'installation' || bundle.removable === false || bundle.readOnlyReason) return null
      const kind = classifySource(bundle.source, pkg.name)
      if (!UPDATABLE.has(kind)) return null
      return { name: pkg.name, spec: bundle.source, enabled: pkg.enabled === true, kind }
    }

    /* ── the update itself ───────────────────────────────────────────────── */

    function newRequestId() {
      const random = Math.random().toString(36).slice(2, 10)
      return `${SELF}-${Date.now().toString(36)}-${random}`
    }

    function tail(text, lines) {
      const all = String(text || '').replace(/\s+$/, '').split('\n')
      return all.slice(-lines).join('\n')
    }

    /**
     * Why a plugin-manager answer is not a success, or null when it is.
     * Answers are `{ ok: true, value }` or `{ ok: false, error }` (a lost reply).
     */
    function operationFailure(answer) {
      if (!answer) return { code: 'transport', message: 'no reply' }
      if (answer.ok === false) {
        const error = answer.error
        return { code: 'transport', message: (error && error.message) || String(error || 'no reply') }
      }
      const value = answer.ok === true ? answer.value : answer
      if (!value || typeof value !== 'object') return { code: 'transport', message: 'empty reply' }
      const result = value.packageResult
      const base = {
        diagnostic: value.error && value.error.diagnostic,
        kind: result && result.kind,
        output: result && result.exitCode !== 0 ? tail(result.output, 20) : undefined,
        pendingBuilds: Array.isArray(value.pendingBuilds) ? value.pendingBuilds : undefined,
      }
      if (value.error) return Object.assign({ code: value.error.code }, base)
      if (value.application === 'failed' || value.application === 'cancelled') return Object.assign({ code: value.application }, base)
      return null
    }

    /** One or two sentences for a failure, in the page's language. */
    function describeFailure(failure, t) {
      if (!failure) return ''
      const translate = t || fallbackT
      const parts = []
      const key = `failure_${failure.code}`
      if (failure.code === 'transport') parts.push(translate(key, { message: failure.message }))
      else if (has(translate, key)) parts.push(translate(key))
      else parts.push(translate('failure_other', { code: failure.code }))
      if (failure.kind) {
        const kindKey = `kind_${failure.kind}`
        if (has(translate, kindKey)) parts.push(translate(kindKey, { names: (failure.pendingBuilds || []).join(', ') }))
      }
      const line = errorLine(failure)
      if (line) parts.push(line)
      return parts.join(' ')
    }

    /** The line of pnpm / Host output that says what went wrong (`[ENOENT] …`, `ERR_PNPM_…`). */
    function errorLine(failure) {
      const text = [failure.diagnostic, failure.output].filter((item) => typeof item === 'string').join('\n')
      const lines = text.split('\n').map((item) => item.trim()).filter(Boolean)
      const hit = lines.find((item) => /\bERR_[A-Z_]+|^\[E[A-Z]+\]|^(?:error|fatal)\b|\berror:/i.test(item))
      const chosen = hit || (!failure.kind || failure.kind === 'unknown' ? lines.find((item) => !/^(?:Progress:|✓|Packages:|\+$)/.test(item)) : undefined)
      if (!chosen) return ''
      return chosen.length > 300 ? `${chosen.slice(0, 297)}…` : chosen
    }

    /**
     * Remove, then reinstall from the original spec. Pure apart from `remote`.
     * @param remote - `ctx.remote.pluginManager` (removeBundle / installBundle / waitForInstall).
     * @param target - `{ name, spec, enabled }`.
     * @param hooks - `skipRemove`, `requestId`, and callbacks `step(phase)`, `removed()`, `request(id)`.
     * @returns `{ phase: 'done', version?, application, restartReason? }` or
     *   `{ phase: 'failed', failedStage: 'remove' | 'install', removed, failure }`.
     */
    async function runUpdate(remote, target, hooks) {
      const options = hooks || {}
      const note = (name, value) => {
        if (typeof options[name] === 'function') options[name](value)
      }
      let removedNow = Boolean(options.skipRemove)
      if (!options.skipRemove) {
        note('step', 'removing')
        let removed
        try {
          removed = await remote.removeBundle(target.name)
        } catch (error) {
          removed = { ok: false, error }
        }
        const failure = operationFailure(removed)
        // Without HMR a bundle that ran since start cannot be removed; installing over
        // it is what DSH's own Update does, and it reports restart-required.
        if (failure && failure.code !== 'stop-profile') return { phase: 'failed', failedStage: 'remove', removed: false, failure }
        removedNow = !failure
        if (removedNow) note('removed')
      }
      note('step', 'installing')
      const requestId = options.requestId || newRequestId()
      note('request', requestId)
      let installed
      try {
        installed = await remote.installBundle(target.spec, { enabled: target.enabled === true, requestId })
      } catch (error) {
        installed = { ok: false, error }
      }
      if (installed && installed.ok === false && typeof remote.waitForInstall === 'function') {
        // The reply was lost; the Host may still be running (or have finished) it.
        try {
          const waited = await remote.waitForInstall(requestId)
          if (waited && waited.ok === true && waited.value) installed = waited
        } catch {
          // keep the original failure
        }
      }
      const failure = operationFailure(installed)
      if (failure) return { phase: 'failed', failedStage: 'install', removed: removedNow, failure }
      const value = installed.ok === true ? installed.value : installed
      return {
        phase: 'done',
        removed: removedNow,
        version: value.version,
        application: value.application,
        restartReason: value.restartReason,
        enabled: value.enabled,
      }
    }

    /* ── shared state (survives hot replacement via a fixed global slot) ──── */

    const SLOT = '__dshPluginUpdater_v1__'
    const shared = (globalThis[SLOT] = globalThis[SLOT] || {
      jobs: [], // newest last; one per plugin name
      bundles: null, // listBundles() value once read
      commits: {}, // name → host commit status
      listeners: new Set(),
      seq: 0,
    })

    function emit() {
      for (const listener of Array.from(shared.listeners)) listener()
    }

    function subscribe(listener) {
      shared.listeners.add(listener)
      return () => shared.listeners.delete(listener)
    }

    function useShared(selector) {
      const read = () => selector(shared)
      return React.useSyncExternalStore(subscribe, read, read)
    }

    function isRunning(job) {
      return Boolean(job) && (job.phase === 'removing' || job.phase === 'installing')
    }

    async function fetchStatus(path) {
      const response = await fetch(API + path)
      const payload = await response.json().catch(() => null)
      if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
      return payload.status
    }

    /** `promise`, or undefined once `ms` pass — without leaving the timer behind. */
    function within(promise, ms) {
      let timer
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, ms)
      })
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
    }

    /**
     * The long-lived side: bundle list, commit checks, and update jobs.
     * @param deps - `{ pluginManager: () => remote namespace, fetchStatus? }`.
     */
    function createUpdater(deps) {
      const pluginManager = () => deps.pluginManager()
      const getStatus = deps.fetchStatus || fetchStatus
      let bundlesInFlight
      const commitsInFlight = new Map()

      function patchJob(id, patch) {
        let changed = false
        shared.jobs = shared.jobs.map((job) => {
          if (job.id !== id) return job
          changed = true
          return Object.assign({}, job, patch)
        })
        if (changed) emit()
      }

      function jobById(id) {
        return shared.jobs.find((job) => job.id === id)
      }

      function loadBundles() {
        if (bundlesInFlight) return bundlesInFlight
        const remote = pluginManager()
        if (!remote || typeof remote.listBundles !== 'function') return Promise.resolve(shared.bundles)
        bundlesInFlight = Promise.resolve()
          .then(() => remote.listBundles())
          .then(
            (answer) => {
              if (answer && answer.ok === true && Array.isArray(answer.value)) {
                shared.bundles = answer.value
                emit()
              }
              return shared.bundles
            },
            () => shared.bundles,
          )
          .finally(() => {
            bundlesInFlight = undefined
          })
        return bundlesInFlight
      }

      /**
       * Read listBundles() once, and again whenever a page asks about a package the
       * cached list does not know: an install from the `dsh plugin` CLI sends no
       * `plugin-manager/changed`, while the page's own refresh button does show it.
       */
      function ensureBundles(name) {
        const known = Array.isArray(shared.bundles) && (!name || shared.bundles.some((bundle) => bundle && bundle.name === name))
        return known ? Promise.resolve(shared.bundles) : loadBundles()
      }

      /** Ask the host whether the GitHub ref moved; cached in `shared.commits`. */
      function checkCommits(name, refresh) {
        if (!name) return Promise.resolve(undefined)
        if (!refresh && shared.commits[name]) return Promise.resolve(shared.commits[name])
        if (commitsInFlight.has(name) && !refresh) return commitsInFlight.get(name)
        const query = `/commits?name=${encodeURIComponent(name)}${refresh ? '&refresh=1' : ''}`
        const promise = getStatus(query)
          .then(
            (status) => {
              shared.commits = Object.assign({}, shared.commits, { [name]: status })
              emit()
              return status
            },
            () => undefined,
          )
          .finally(() => {
            if (commitsInFlight.get(name) === promise) commitsInFlight.delete(name)
          })
        commitsInFlight.set(name, promise)
        return promise
      }

      async function drive(id, skipRemove) {
        const job = jobById(id)
        if (!job) return
        if (!skipRemove && (job.kind === 'github' || job.kind === 'git') && !job.before) {
          // The locked commit has to be read before the removal drops it from the lockfile.
          const known = shared.commits[job.name]
          const status = known && known.locked ? known : await within(checkCommits(job.name), COMMIT_WAIT_MS)
          if (status && status.locked) patchJob(id, { before: status.locked })
        }
        const remote = pluginManager()
        const result = await runUpdate(remote, job, {
          skipRemove,
          step: (phase) => patchJob(id, { phase, detail: '' }),
          removed: () => patchJob(id, { removed: true }),
          request: (requestId) => patchJob(id, { requestId }),
        })
        patchJob(id, Object.assign({ detail: '' }, result, { removed: Boolean(jobById(id)?.removed || result.removed) }))
        await loadBundles()
        if (result.phase === 'done' && (job.kind === 'github' || job.kind === 'git')) {
          const status = await checkCommits(job.name, true)
          if (status && status.locked) patchJob(id, { after: status.locked })
        }
      }

      /** Start an update for `target`; a running one for the same plugin is returned as is. */
      function start(target) {
        const running = shared.jobs.find((job) => job.name === target.name && isRunning(job))
        if (running) return running
        shared.seq += 1
        const job = {
          id: shared.seq,
          name: target.name,
          spec: target.spec,
          enabled: target.enabled === true,
          kind: target.kind,
          phase: 'removing',
          removed: false,
          requestId: undefined,
          log: '',
          lastRun: undefined,
          detail: '',
          failure: undefined,
          failedStage: undefined,
          version: undefined,
          before: undefined,
          after: undefined,
        }
        shared.jobs = shared.jobs.filter((item) => item.name !== target.name).concat(job)
        emit()
        const done = drive(job.id, false).catch((error) => {
          patchJob(job.id, { phase: 'failed', failedStage: 'install', failure: { code: 'transport', message: String(error && error.message ? error.message : error) } })
        })
        return Object.assign({}, job, { done })
      }

      /** Retry a failed job: only the install when the plugin was already removed. */
      function retry(id) {
        const job = jobById(id)
        if (!job || job.phase !== 'failed') return undefined
        const skipRemove = job.removed === true
        patchJob(id, {
          phase: skipRemove ? 'installing' : 'removing',
          failure: undefined,
          failedStage: undefined,
          log: '',
          lastRun: undefined,
          requestId: undefined,
        })
        return drive(id, skipRemove).catch((error) => {
          patchJob(id, { phase: 'failed', failedStage: 'install', failure: { code: 'transport', message: String(error && error.message ? error.message : error) } })
        })
      }

      function dismiss(id) {
        const job = jobById(id)
        if (!job || isRunning(job)) return
        shared.jobs = shared.jobs.filter((item) => item.id !== id)
        emit()
      }

      /** `plugin-manager/install-log`: pnpm output of one of our installs. */
      function onLog(chunk) {
        if (!chunk || !chunk.requestId) return
        const job = shared.jobs.find((item) => item.requestId === chunk.requestId)
        if (!job) return
        let text = ''
        if (chunk.jobId !== undefined && chunk.jobId !== job.lastRun) {
          const argv = Array.isArray(chunk.argv) ? chunk.argv.join(' ') : ''
          text += `${job.log ? '\n' : ''}${argv ? `$ ${argv}\n` : ''}`
        }
        text += String(chunk.text || '')
        let log = job.log + text
        if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT)
        patchJob(job.id, { log, lastRun: chunk.jobId === undefined ? job.lastRun : chunk.jobId })
      }

      /** `plugin-manager/install-state`: installing / cancelling / applying. */
      function onState(progress) {
        if (!progress || !progress.requestId) return
        const job = shared.jobs.find((item) => item.requestId === progress.requestId)
        if (!job || !isRunning(job)) return
        patchJob(job.id, { detail: progress.phase === 'applying' || progress.phase === 'cancelling' ? progress.phase : '' })
      }

      return { loadBundles, ensureBundles, checkCommits, start, retry, dismiss, onLog, onState }
    }

    /* ── DSH primitives (borrowed when present) ──────────────────────────── */

    let primitives
    function ui() {
      if (primitives === undefined) {
        try {
          primitives = require('@deepseek-ai/dsh-client-ui-primitives') || null
        } catch {
          primitives = null
        }
      }
      return primitives
    }

    function Btn({ variant, icon, label, disabled, onClick, children, autoFocus }) {
      const kit = ui()
      if (kit && kit.Button) {
        return h(kit.Button, { variant: variant || 'outline', size: 'sm', icon, disabled, autoFocus, 'aria-label': label, onClick }, children)
      }
      return h(
        'button',
        { type: 'button', className: `dpuButton${variant === 'primary' ? ' dpuPrimary' : ''}`, disabled, autoFocus, 'aria-label': label, onClick },
        children,
      )
    }

    function short(sha) {
      return typeof sha === 'string' ? sha.slice(0, 7) : ''
    }

    /* ── page header: the Update button ──────────────────────────────────── */

    function ConfirmUpdate({ target, t, onConfirm, onCancel }) {
      const title = t('confirmTitle', { name: target.name })
      const body = h(
        'div',
        { className: 'dpuConfirm' },
        h('p', null, t('confirmBody', { state: t(target.enabled ? 'stateEnabled' : 'stateDisabled') })),
        h('div', { className: 'dpuSource' }, h('span', null, t('sourceLabel')), h('code', null, target.spec)),
        h('p', { className: 'dpuMuted' }, t('confirmRisk')),
      )
      const footer = h(
        React.Fragment,
        null,
        h(Btn, { variant: 'outline', onClick: onCancel }, t('cancel')),
        h(Btn, { variant: 'primary', autoFocus: true, onClick: onConfirm }, t('confirm')),
      )
      const kit = ui()
      if (kit && kit.Modal) {
        return h(kit.Modal, { open: true, onClose: onCancel, title, closeLabel: t('close'), footer }, body)
      }
      return h(
        'div',
        { className: 'dpuBackdrop', role: 'presentation', onClick: onCancel },
        h(
          'div',
          { className: 'dpuDialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onClick: (event) => event.stopPropagation() },
          h('h3', null, title),
          body,
          h('div', { className: 'dpuActions' }, footer),
        ),
      )
    }

    function UpdateAction(props) {
      const { subject, updater } = props
      const t = props.t || fallbackT
      const isBundle = Boolean(subject && subject.kind === 'bundle' && subject.pkg)
      const name = isBundle ? subject.pkg.name : undefined
      const bundles = useShared((state) => state.bundles)
      const job = useShared((state) => (name ? state.jobs.find((item) => item.name === name) : undefined))
      const [confirming, setConfirming] = React.useState(false)
      React.useEffect(() => {
        if (isBundle && updater) updater.ensureBundles(name)
      }, [isBundle, name, updater])
      const target = updateTarget(subject, bundles)
      if (!target || !updater) return null
      const running = isRunning(job)
      const kit = ui()
      const icon = kit && kit.IconRefreshOutlineRegular ? h(kit.IconRefreshOutlineRegular, { size: 13 }) : undefined
      return h(
        React.Fragment,
        null,
        h(
          Btn,
          {
            variant: 'outline',
            icon,
            label: t('updateLabel', { name: target.name }),
            disabled: running,
            onClick: () => setConfirming(true),
          },
          running ? t('updating') : t('update'),
        ),
        confirming
          ? h(ConfirmUpdate, {
              target,
              t,
              onCancel: () => setConfirming(false),
              onConfirm: () => {
                setConfirming(false)
                updater.start(target)
              },
            })
          : null,
      )
    }

    /* ── page title: 有新提交 ─────────────────────────────────────────────── */

    function CommitBadge(props) {
      const { subject, updater } = props
      const t = props.t || fallbackT
      const isBundle = Boolean(subject && subject.kind === 'bundle' && subject.pkg)
      const name = isBundle ? subject.pkg.name : undefined
      const bundles = useShared((state) => state.bundles)
      const status = useShared((state) => (name ? state.commits[name] : undefined))
      const target = updateTarget(subject, bundles)
      const github = Boolean(target && target.kind === 'github')
      React.useEffect(() => {
        if (isBundle && updater) updater.ensureBundles(name)
      }, [isBundle, name, updater])
      React.useEffect(() => {
        if (github && updater) updater.checkCommits(name)
      }, [github, name, updater])
      if (!github || !status || status.behind !== true) return null
      const title = t('newCommitsTitle', { locked: short(status.locked), remote: short(status.remote), ref: status.ref || 'HEAD' })
      const kit = ui()
      if (kit && kit.Tag) return h('span', { title }, h(kit.Tag, { tone: 'info' }, t('newCommits')))
      return h('span', { className: 'dpuBadge', title }, t('newCommits'))
    }

    /* ── progress panel ──────────────────────────────────────────────────── */

    function stepState(job, step) {
      if (step === 'remove') {
        if (job.phase === 'removing') return 'running'
        if (job.phase === 'failed' && job.failedStage === 'remove') return 'failed'
        if (job.removed) return 'done'
        return job.phase === 'installing' || job.phase === 'done' || job.phase === 'failed' ? 'skipped' : 'waiting'
      }
      if (job.phase === 'installing') return 'running'
      if (job.phase === 'done') return 'done'
      if (job.phase === 'failed' && job.failedStage === 'install') return 'failed'
      return 'waiting'
    }

    const STEP_LABEL = { waiting: 'stepWaiting', running: 'stepRunning', done: 'stepDone', failed: 'stepFailed', skipped: 'stepSkipped' }
    const STEP_GLYPH = { waiting: '○', running: '◌', done: '✓', failed: '✕', skipped: '–' }

    function Step({ job, step, t }) {
      const state = stepState(job, step)
      return h(
        'li',
        { className: `dpuStep dpu-${state}` },
        h('span', { className: 'dpuGlyph', 'aria-hidden': 'true' }, STEP_GLYPH[state]),
        h('span', { className: 'dpuStepText' }, t(step === 'remove' ? 'stepRemove' : 'stepInstall')),
        h('span', { className: 'dpuStepState' }, t(STEP_LABEL[state])),
      )
    }

    function JobPanel({ job, updater, t: translate }) {
      const t = translate || fallbackT
      const [showLog, setShowLog] = React.useState(false)
      const running = isRunning(job)
      const title = t(running ? 'titleRunning' : job.phase === 'done' ? 'titleDone' : 'titleFailed', { name: job.name })
      const lines = []
      if (running && job.detail) lines.push(h('p', { key: 'detail', className: 'dpuMuted' }, t(job.detail)))
      if (job.phase === 'done') {
        const facts = []
        if (job.version) facts.push(t('doneVersion', { version: job.version }))
        if (job.after) {
          if (job.before && job.before !== job.after) facts.push(t('doneCommit', { before: short(job.before), after: short(job.after) }))
          else if (job.before) facts.push(t('doneSameCommit', { after: short(job.after) }))
          else facts.push(t('doneCommitOnly', { after: short(job.after) }))
        }
        if (facts.length) lines.push(h('p', { key: 'facts' }, facts.join(' · ')))
        lines.push(h('p', { key: 'state', className: 'dpuMuted' }, t(job.enabled ? 'doneEnabled' : 'doneDisabled')))
        if (job.application === 'restart-required') lines.push(h('p', { key: 'restart', className: 'dpuWarn' }, t('restartRequired')))
      }
      if (job.phase === 'failed') {
        lines.push(h('p', { key: 'why', className: 'dpuError', role: 'alert' }, describeFailure(job.failure, t)))
        if (job.removed) {
          lines.push(h('p', { key: 'warn', className: 'dpuWarn' }, t('removedWarning')))
          lines.push(h('div', { key: 'src', className: 'dpuSource' }, h('span', null, t('sourceLabel')), h('code', null, job.spec)))
        } else lines.push(h('p', { key: 'kept', className: 'dpuMuted' }, t('removeFailedNote')))
      }
      const log = job.log || (job.failure && job.failure.output) || ''
      const buttons = []
      if (log) buttons.push(h(Btn, { key: 'log', variant: 'outline', onClick: () => setShowLog(!showLog) }, t(showLog ? 'hideLog' : 'showLog')))
      if (job.phase === 'failed') {
        buttons.push(h(Btn, { key: 'retry', variant: 'primary', onClick: () => updater.retry(job.id) }, t(job.removed ? 'retryInstall' : 'retry')))
      }
      if (!running) buttons.push(h(Btn, { key: 'close', variant: 'outline', onClick: () => updater.dismiss(job.id) }, t('close')))
      return h(
        'section',
        { className: `dpuPanel dpu-${job.phase}`, 'data-dpu-job': job.name, 'aria-live': 'polite' },
        h('h4', { className: 'dpuTitle' }, title),
        h('ol', { className: 'dpuSteps' }, h(Step, { job, step: 'remove', t }), h(Step, { job, step: 'install', t })),
        lines,
        showLog && log ? h('pre', { className: 'dpuLog' }, tail(log, LOG_LINES * 3)) : running && log ? h('pre', { className: 'dpuLog dpuLogTail' }, tail(log, 3)) : null,
        buttons.length ? h('div', { className: 'dpuActions' }, buttons) : null,
      )
    }

    function JobsOverlay(props) {
      const t = props.t || fallbackT
      const jobs = useShared((state) => state.jobs)
      if (!props.updater || jobs.length === 0) return null
      return h(
        'div',
        { className: 'dpuStack' },
        jobs.map((job) => h(JobPanel, { key: job.id, job, updater: props.updater, t })),
      )
    }

    /* ── styles ──────────────────────────────────────────────────────────── */

    const CSS = `
.dpuStack{position:fixed;right:16px;bottom:16px;z-index:1000;display:flex;flex-direction:column;gap:10px;width:380px;max-width:calc(100vw - 32px);pointer-events:none}
.dpuPanel{pointer-events:auto;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:14px 16px;font-size:13px;line-height:1.5}
.dpuPanel p{margin:6px 0 0}
.dpuTitle{margin:0 0 8px;font-size:14px;font-weight:600;word-break:break-all}
.dpuSteps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.dpuStep{display:flex;align-items:center;gap:8px}
.dpuGlyph{width:14px;text-align:center;color:var(--dsw-alias-label-tertiary,#8b949e)}
.dpuStepText{flex:1}
.dpuStepState{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px}
.dpu-running .dpuGlyph{color:var(--dsw-alias-brand-primary,#4d6bfe);animation:dpuSpin 1s linear infinite}
.dpu-done .dpuGlyph{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.dpu-failed .dpuGlyph,.dpu-failed .dpuStepState{color:var(--dsw-alias-state-error-primary,#cf222e)}
@keyframes dpuSpin{to{transform:rotate(360deg)}}
.dpuMuted{color:var(--dsw-alias-label-secondary,#57606a)}
.dpuError{color:var(--dsw-alias-state-error-primary,#cf222e)}
.dpuWarn{color:var(--dsw-alias-state-warning-primary,#9a6700)}
.dpuSource{display:flex;gap:8px;align-items:baseline;margin-top:8px;font-size:12px}
.dpuSource span{flex:none;color:var(--dsw-alias-label-secondary,#57606a)}
.dpuSource code{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dpuLog{margin:8px 0 0;max-height:220px;overflow:auto;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f8fa);font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
.dpuLogTail{max-height:64px;overflow:hidden;color:var(--dsw-alias-label-secondary,#57606a)}
.dpuActions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.dpuConfirm p{margin:0 0 8px}
.dpuButton{font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));background:transparent;color:inherit;cursor:pointer}
.dpuButton:disabled{opacity:.5;cursor:default}
.dpuPrimary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff}
.dpuBadge{display:inline-block;padding:0 6px;border-radius:6px;font-size:11px;line-height:18px;background:var(--dsw-alias-bg-multi-select,rgba(77,107,254,.12));color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dpuBackdrop{position:fixed;inset:0;z-index:1001;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}
.dpuDialog{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border-radius:12px;padding:18px 20px;width:440px;max-width:calc(100vw - 32px);font-size:13px}
.dpuDialog h3{margin:0 0 10px;font-size:15px}
`

    function installStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      const element = document.createElement('style')
      element.dataset.plugin = SELF
      element.textContent = CSS
      document.head.append(element)
      return () => element.remove()
    }

    /* ── plugin ──────────────────────────────────────────────────────────── */

    const name = SELF
    const inject = ['slots', 'locale', 'remote', 'remote.pluginManager']

    function apply(ctx) {
      ctx.effect(() => installStyles(), 'dsh-plugin-updater: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-plugin-updater: dictionaries')

      const updater = createUpdater({ pluginManager: () => ctx.remote.pluginManager })

      ctx.effect(() => {
        const disposers = [
          ctx.remote.$on('plugin-manager/changed', () => {
            if (shared.bundles !== null) void updater.loadBundles()
          }),
          ctx.remote.$on('plugin-manager/install-log', (chunk) => updater.onLog(chunk)),
          ctx.remote.$on('plugin-manager/install-state', (progress) => updater.onState(progress)),
        ]
        return () => {
          for (const dispose of disposers) if (typeof dispose === 'function') dispose()
        }
      }, 'dsh-plugin-updater: host events')

      const share = () => ({ updater })
      ctx.slots.inject('plugins.detail.actions', () =>
        ctx.slots.register({ name: 'plugins.detail.actions', id: SELF, locale: NS, order: -10, inject: share }, UpdateAction),
      )
      ctx.slots.inject('plugins.detail.badge', () =>
        ctx.slots.register({ name: 'plugins.detail.badge', id: SELF, locale: NS, inject: share }, CommitBadge),
      )
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: SELF, locale: NS, inject: share }, JobsOverlay),
      )
    }

    // Extra keys are for the test suite; the loader reads name / inject / apply.
    module.exports = {
      name,
      inject,
      apply,
      ZH,
      EN,
      format,
      classifySource,
      updateTarget,
      operationFailure,
      describeFailure,
      runUpdate,
      createUpdater,
      shared,
      UpdateAction,
      CommitBadge,
      JobsOverlay,
      JobPanel,
      stepState,
    }
    return module.exports
  },
})
