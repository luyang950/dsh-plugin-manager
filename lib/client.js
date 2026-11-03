/* global window, document, fetch, console, setTimeout, clearTimeout, Blob, URL, navigator, FileReader */
// dsh-plugin-manager — browser half.
//
// Hand-written ModuleLoader bundle: no build step. The only hard dependency is
// `react`; DSH's own Button / Modal / Tag are borrowed when present (with plain
// fallbacks).
//
// What it adds to the Plugins page (ui-plugin-manager):
//   * `plugins.tab` — a 管理 / Manage tab: every third-party plugin with its source,
//     locked commit and whether the repository moved on; check / update all /
//     update selected; switch branch or tag, roll back; export / import the plugin
//     list; diagnostics (broken bundles, stray dependencies, pnpm logs).
//   * `plugins.detail.actions` / `plugins.detail.badge` — 更新 on a third-party
//     plugin's page and 有新提交 next to its title.
//   * `shell.overlay` — the progress of running and failed jobs, with retry.
//
// Every change is a job the host half runs (lib/jobs.mjs) through DSH's own plugin
// manager service; this half only asks for jobs and polls them. Jobs survive a page
// reload, and this plugin's own update, which reloads this very bundle midway.

window.__ModuleLoader__.load({
  id: 'dsh-plugin-manager',
  factory: (require) => {
    var module = { exports: {} }

    const React = require('react')
    const h = React.createElement

    const SELF = 'dsh-plugin-manager'
    const NS = 'dshPluginManagerTool'
    const API = '/dsh-plugin-manager/api'
    const POLL_MS = 1000
    const POLL_GIVE_UP_MS = 120 * 1000
    const OVERLAY_MAX = 4
    const ACTIVE = ['queued', 'checking', 'removing', 'installing']

    /* ── text ────────────────────────────────────────────────────────────── */

    const ZH = {
      lang: 'zh',
      tabLabel: '管理',
      tabTitle: '插件管理',
      tabIntro: '你安装的插件：来源、锁定的提交、是否有新版本，以及批量更新、切换版本、导入导出和诊断。',
      check: '检查更新',
      checking: '检查中…',
      updateAll: '全部更新（{count}）',
      updateSelected: '更新所选（{count}）',
      exportList: '导出清单',
      importList: '导入清单',
      refresh: '刷新',
      lastChecked: '上次检查 {time}',
      neverChecked: '还没有检查过远端更新',
      empty: '这个 profile 还没有安装第三方插件。',
      loading: '正在读取…',
      loadFailed: '读取失败：{error}',
      legacyNotice: '检测到旧插件 {name}，它的功能已经包含在 dsh-plugin-manager 里，建议卸载以免出现两个「更新」按钮。',
      uninstallLegacy: '卸载 {name}',
      kind_github: 'GitHub',
      kind_git: 'git',
      kind_path: '本地',
      kind_tarball: '压缩包',
      kind_registry: 'npm',
      stateEnabled: '已启用',
      stateDisabled: '已停用',
      statusLatest: '最新',
      statusBehind: '有新提交',
      statusPinned: '固定在 {commit}',
      statusUnchecked: '未检查',
      statusCheckFailed: '检查失败',
      statusProblem: '异常',
      statusBusy: '任务进行中',
      commitLine: '提交 {commit}',
      behindLine: '{locked} → {remote}（{ref}）',
      selfTag: '本插件',
      update: '更新',
      updateLabel: '从原来的安装来源更新「{name}」',
      updating: '更新中…',
      versions: '版本…',
      details: '详情',
      newCommits: '有新提交',
      newCommitsTitle: '已安装 {locked}，{ref} 上最新是 {remote}',
      confirmTitle: '更新「{name}」？',
      confirmBody: '会先卸载这个插件，再从下面的来源重新安装最新代码，并保持{state}。',
      confirmBatchTitle: '更新 {count} 个插件？',
      confirmBatchBody: '会依次卸载并从原来源重新安装下面的插件，保持各自的启用状态。',
      confirmSelf: '其中包括 dsh-plugin-manager 自己：它会放在最后，更新期间这个页面会短暂刷新。',
      confirmSelfOnly: '这是 dsh-plugin-manager 自己：更新由后台完成，期间这个页面会短暂刷新。',
      keepEnabled: '启用状态',
      keepDisabled: '停用状态',
      confirmRisk: '卸载之后如果安装失败，插件会处于未安装状态（可在进度面板里重试）。重装后它会排到组合包列表的末尾。',
      sourceLabel: '安装来源',
      cancel: '取消',
      confirm: '确定',
      close: '关闭',
      versionTitle: '「{name}」的版本',
      versionCurrent: '当前',
      versionBranches: '跟随分支',
      versionDefault: '默认分支',
      versionTags: 'Tag',
      versionHistory: '回滚到更新前',
      versionCustom: '自定义安装来源',
      versionCustomHint: '任意 pnpm add 能接受的 spec，例如 github:owner/repo#dev',
      versionLoading: '正在读取分支和 tag…',
      versionNoRefs: '不是 git 来源，只能回滚或填写自定义来源。',
      versionApply: '切换',
      versionPinNote: '选中 tag 或提交会把插件固定在那个版本，「检查更新」不再提示新提交；选分支可恢复跟随。',
      historyItem: '{when} · {version} · {commit}',
      exportTitle: '导出插件清单',
      exportBody: '包含每个插件的安装来源和启用状态，可在另一个 profile 或另一台机器上导入。本地路径在别的机器上可能不存在。',
      download: '下载 JSON',
      copy: '复制',
      copied: '已复制',
      importTitle: '导入插件清单',
      importBody: '粘贴导出的 JSON，或选择文件。',
      importFile: '选择文件',
      importParse: '解析',
      importStart: '开始导入（{count}）',
      importNothing: '没有需要导入的插件。',
      action_install: '安装',
      action_replace: '替换为此来源',
      action_skip: '已安装，相同来源',
      action_invalid: '无效条目',
      reason_missing_path: '本机找不到这个路径',
      reason_duplicate: '重复条目',
      currentSource: '当前：{source}',
      diagnostics: '诊断与清理',
      diagnosticsBroken: '异常的插件',
      diagnosticsBrokenNone: '没有加载异常的插件。',
      diagnosticsStray: '不是插件的依赖',
      diagnosticsStrayHint: 'profile 依赖里有这些包，但它们不是组合包。插件管理不能删除它们，可以在终端运行：',
      diagnosticsLogs: 'pnpm 日志',
      diagnosticsLogsNone: '没有日志。',
      cleanLogs: '清理 {days} 天前的日志',
      cleanedLogs: '已删除 {count} 个日志（{size}）',
      viewLog: '查看',
      remove: '卸载',
      logTitle: '日志 {name}',
      jobsTitle: '最近任务',
      jobsNone: '还没有任务。',
      type_update: '更新',
      type_switch: '切换版本',
      type_install: '安装',
      type_remove: '卸载',
      titleRunning: '正在{type}「{name}」',
      titleQueued: '等待{type}「{name}」',
      titleDone: '「{name}」已{type}',
      titleFailed: '「{name}」{type}失败',
      titleInterrupted: '「{name}」{type}被中断',
      stepCheck: '检查能否访问安装来源',
      stepCheckRetry: '检查能否访问安装来源（第 {tries} 次）',
      stepRemove: '卸载当前版本',
      stepInstall: '安装 {spec}',
      stepWaiting: '等待中',
      stepRunning: '进行中',
      stepDone: '完成',
      stepFailed: '失败',
      stepSkipped: '跳过',
      applying: '正在加载新代码…',
      cancelling: '正在取消…',
      doneVersion: '版本 {version}',
      doneCommit: '提交 {before} → {after}',
      doneSameCommit: '提交 {after}（未变化）',
      doneCommitOnly: '提交 {after}',
      doneEnabled: '插件保持启用。',
      doneDisabled: '插件保持停用。',
      doneInstalledEnabled: '已安装并启用。',
      doneInstalledDisabled: '已安装，按清单保持停用。',
      restartRequired: '需要重启 DSH 后生效。',
      removedWarning: '插件已经卸载，但还没有装回来。可以重试，或在插件页「添加插件」里用下面的来源手动安装。',
      removeFailedNote: '卸载没有完成，插件保持原样。',
      unchangedNote: '还没有卸载，插件保持原样。网络恢复后可以重试。',
      installRetried: '安装时连不上来源主机，已自动重试 {count} 次。',
      failure_unreachable: '连不上 {url}（已试 {attempts} 次）。',
      interruptedNote: 'DSH 在任务进行中重启了。插件可能已被卸载，可以重试。',
      selfNote: '这是 dsh-plugin-manager 自己的更新，完成后页面会重新加载它。',
      retry: '重试',
      retryInstall: '重试安装',
      restore: '恢复原来的版本',
      showLog: '输出',
      hideLog: '收起',
      moreJobs: '还有 {count} 个任务',
      failure_transport: '没有连上 DSH：{message}',
      failure_cancelled: '安装被取消。',
      failure_failed: '操作没有成功。',
      'failure_incompatible-version': '新版本与当前 DSH 版本不兼容。',
      'failure_already-installed': 'DSH 认为它仍处于已安装状态。',
      'failure_not-bundle': '新代码里没有组合包声明（dsh.bundle.patch）。',
      'failure_invalid-spec': '安装来源无效。',
      'failure_invalid-ref': '无效的分支、tag 或提交。',
      'failure_not-removable': '这个插件不能卸载。',
      'failure_management-required': '插件管理需要这个包，不能卸载。',
      'failure_bundle-in-use': '组合包正在使用中。',
      'failure_unknown-plugin': 'DSH 找不到这个插件。',
      'failure_no-source': '这个插件没有记录安装来源。',
      'failure_no-plugin-manager': 'DSH 的插件管理服务不可用。',
      'failure_operation-error': '操作出错。',
      failure_exception: '执行出错。',
      failure_other: '操作失败（{code}）。',
      'kind_fail_network': '网络连不上。',
      'kind_fail_timeout': 'pnpm 长时间没有输出，已被终止。',
      'kind_fail_integrity': '下载内容校验失败。',
      'kind_fail_pnpm-missing': '找不到 pnpm。',
      'kind_fail_not-found': '找不到这个包或仓库。',
      'kind_fail_no-matching-version': '没有匹配的版本。',
      'kind_fail_disk-full': '磁盘已满。',
      'kind_fail_permission': 'profile 目录不可写。',
      'kind_fail_build-blocked': 'pnpm 拦下了依赖的构建脚本：{names}。请在插件页「添加插件」里用同一来源安装，并允许这些脚本。',
      'kind_fail_unknown': 'pnpm 执行失败。',
    }

    const EN = {
      lang: 'en',
      tabLabel: 'Manage',
      tabTitle: 'Plugin management',
      tabIntro: 'The plugins you installed: where they came from, the locked commit, whether there is something newer — and batch updates, version switching, import / export and diagnostics.',
      check: 'Check for updates',
      checking: 'Checking…',
      updateAll: 'Update all ({count})',
      updateSelected: 'Update selected ({count})',
      exportList: 'Export list',
      importList: 'Import list',
      refresh: 'Refresh',
      lastChecked: 'Last checked {time}',
      neverChecked: 'Remote updates have not been checked yet',
      empty: 'This profile has no third-party plugins yet.',
      loading: 'Loading…',
      loadFailed: 'Could not load: {error}',
      legacyNotice: 'The older plugin {name} is installed. dsh-plugin-manager already does what it did; uninstall it to avoid two Update buttons.',
      uninstallLegacy: 'Uninstall {name}',
      kind_github: 'GitHub',
      kind_git: 'git',
      kind_path: 'local',
      kind_tarball: 'tarball',
      kind_registry: 'npm',
      stateEnabled: 'Enabled',
      stateDisabled: 'Disabled',
      statusLatest: 'Up to date',
      statusBehind: 'New commits',
      statusPinned: 'Pinned to {commit}',
      statusUnchecked: 'Not checked',
      statusCheckFailed: 'Check failed',
      statusProblem: 'Problem',
      statusBusy: 'Job running',
      commitLine: 'Commit {commit}',
      behindLine: '{locked} → {remote} ({ref})',
      selfTag: 'this plugin',
      update: 'Update',
      updateLabel: 'Update "{name}" from where it was installed',
      updating: 'Updating…',
      versions: 'Versions…',
      details: 'Details',
      newCommits: 'New commits',
      newCommitsTitle: 'Installed {locked}; {ref} is now at {remote}',
      confirmTitle: 'Update "{name}"?',
      confirmBody: 'The plugin is uninstalled first, then reinstalled with the latest code from the source below, keeping its {state}.',
      confirmBatchTitle: 'Update {count} plugins?',
      confirmBatchBody: 'Each plugin below is uninstalled and reinstalled from its original source, one at a time, keeping its enabled state.',
      confirmSelf: 'This includes dsh-plugin-manager itself: it goes last, and this page reloads briefly while it updates.',
      confirmSelfOnly: 'This is dsh-plugin-manager itself: the host finishes the update, and this page reloads briefly meanwhile.',
      keepEnabled: 'enabled state',
      keepDisabled: 'disabled state',
      confirmRisk: 'If an installation fails after the removal, that plugin stays uninstalled (retry from the progress panel). A reinstalled plugin moves to the end of the bundle list.',
      sourceLabel: 'Source',
      cancel: 'Cancel',
      confirm: 'Confirm',
      close: 'Close',
      versionTitle: 'Versions of "{name}"',
      versionCurrent: 'Current',
      versionBranches: 'Follow a branch',
      versionDefault: 'default branch',
      versionTags: 'Tags',
      versionHistory: 'Roll back to before an update',
      versionCustom: 'Custom source',
      versionCustomHint: 'Any spec pnpm add accepts, e.g. github:owner/repo#dev',
      versionLoading: 'Reading branches and tags…',
      versionNoRefs: 'Not a git source: roll back or enter a custom source.',
      versionApply: 'Switch',
      versionPinNote: 'A tag or commit pins the plugin there, and Check for updates stops reporting new commits; pick a branch to follow it again.',
      historyItem: '{when} · {version} · {commit}',
      exportTitle: 'Export the plugin list',
      exportBody: 'Each plugin’s source and enabled state, to import into another profile or on another machine. Local paths may not exist elsewhere.',
      download: 'Download JSON',
      copy: 'Copy',
      copied: 'Copied',
      importTitle: 'Import a plugin list',
      importBody: 'Paste an exported JSON, or choose the file.',
      importFile: 'Choose file',
      importParse: 'Read',
      importStart: 'Import ({count})',
      importNothing: 'Nothing to import.',
      action_install: 'Install',
      action_replace: 'Replace with this source',
      action_skip: 'Installed, same source',
      action_invalid: 'Invalid entry',
      reason_missing_path: 'This path does not exist here',
      reason_duplicate: 'Duplicate entry',
      currentSource: 'Now: {source}',
      diagnostics: 'Diagnostics and cleanup',
      diagnosticsBroken: 'Plugins with problems',
      diagnosticsBrokenNone: 'No plugin failed to load.',
      diagnosticsStray: 'Dependencies that are not plugins',
      diagnosticsStrayHint: 'The profile depends on these packages, but they are not bundles. The plugin manager cannot remove them; in a terminal run:',
      diagnosticsLogs: 'pnpm logs',
      diagnosticsLogsNone: 'No logs.',
      cleanLogs: 'Delete logs older than {days} days',
      cleanedLogs: 'Deleted {count} logs ({size})',
      viewLog: 'View',
      remove: 'Uninstall',
      logTitle: 'Log {name}',
      jobsTitle: 'Recent jobs',
      jobsNone: 'No jobs yet.',
      type_update: 'update',
      type_switch: 'version switch',
      type_install: 'install',
      type_remove: 'uninstall',
      titleRunning: 'Running {type} of "{name}"',
      titleQueued: 'Queued {type} of "{name}"',
      titleDone: '"{name}": {type} done',
      titleFailed: '"{name}": {type} failed',
      titleInterrupted: '"{name}": {type} interrupted',
      stepCheck: 'Check the source is reachable',
      stepCheckRetry: 'Check the source is reachable (try {tries})',
      stepRemove: 'Uninstall the current version',
      stepInstall: 'Install {spec}',
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
      doneInstalledEnabled: 'Installed and enabled.',
      doneInstalledDisabled: 'Installed; left disabled as the list says.',
      restartRequired: 'Restart DSH for the change to take effect.',
      removedWarning: 'The plugin was uninstalled but not reinstalled. Retry, or install the source below from Add plugin on the Plugins page.',
      removeFailedNote: 'The removal did not finish; the plugin is unchanged.',
      unchangedNote: 'Nothing was uninstalled; the plugin is unchanged. Retry once the network is back.',
      installRetried: 'The source host could not be reached during the install; retried {count} times.',
      failure_unreachable: 'Could not reach {url} (tried {attempts} times).',
      interruptedNote: 'DSH restarted during the job. The plugin may have been uninstalled; you can retry.',
      selfNote: 'This is dsh-plugin-manager updating itself; the page reloads it when done.',
      retry: 'Retry',
      retryInstall: 'Retry install',
      restore: 'Restore the previous version',
      showLog: 'Output',
      hideLog: 'Hide',
      moreJobs: '{count} more jobs',
      failure_transport: 'Could not reach DSH: {message}',
      failure_cancelled: 'The installation was cancelled.',
      failure_failed: 'The operation did not succeed.',
      'failure_incompatible-version': 'The new version is not compatible with this DSH version.',
      'failure_already-installed': 'DSH still considers it installed.',
      'failure_not-bundle': 'The new code declares no bundle (dsh.bundle.patch).',
      'failure_invalid-spec': 'The source is not a valid spec.',
      'failure_invalid-ref': 'Not a valid branch, tag or commit.',
      'failure_not-removable': 'This plugin cannot be uninstalled.',
      'failure_management-required': 'Plugin management needs this package; it cannot be uninstalled.',
      'failure_bundle-in-use': 'The bundle is in use.',
      'failure_unknown-plugin': 'DSH does not know this plugin.',
      'failure_no-source': 'No installation source is recorded for this plugin.',
      'failure_no-plugin-manager': 'DSH’s plugin manager service is not available.',
      'failure_operation-error': 'The operation failed.',
      failure_exception: 'The job threw an error.',
      failure_other: 'The operation failed ({code}).',
      'kind_fail_network': 'The network is unreachable.',
      'kind_fail_timeout': 'pnpm printed nothing for too long and was stopped.',
      'kind_fail_integrity': 'The download failed its integrity check.',
      'kind_fail_pnpm-missing': 'pnpm was not found.',
      'kind_fail_not-found': 'The package or repository was not found.',
      'kind_fail_no-matching-version': 'No matching version.',
      'kind_fail_disk-full': 'The disk is full.',
      'kind_fail_permission': 'The profile directory is not writable.',
      'kind_fail_build-blocked': 'pnpm blocked dependency build scripts: {names}. Install the same source from Add plugin on the Plugins page and allow them.',
      'kind_fail_unknown': 'pnpm failed.',
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

    /** A display field that is either a string or `{ en, zh, … }`. */
    function pickText(value, t) {
      if (typeof value === 'string') return value
      if (!value || typeof value !== 'object') return ''
      const lang = (t && t('lang')) || 'zh'
      return value[lang] || value[lang === 'zh' ? 'zh-CN' : 'en'] || value.en || Object.values(value).find((item) => typeof item === 'string') || ''
    }

    function short(sha) {
      return typeof sha === 'string' ? sha.slice(0, 7) : ''
    }

    function bytes(size) {
      const value = Number(size) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / 1024 / 1024).toFixed(1)} MB`
    }

    function when(ms) {
      if (!ms) return ''
      try {
        return new Date(ms).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      } catch {
        return String(ms)
      }
    }

    function tail(text, lines) {
      return String(text || '').replace(/\s+$/, '').split('\n').slice(-lines).join('\n')
    }

    /* ── sources (kept in step with lib/sources.mjs by the test suite) ───── */

    const TARBALL = /\.(?:tgz|tar\.gz|tar)(?:[?#].*)?$/i
    const ALIAS = /^((?:@[^/@\s]+\/)?[^@/:\s]+)@(?=(?:github|gh|gitlab|bitbucket|git|git\+[a-z]+|https?|file|link):)/i

    function classifySource(source, name) {
      if (typeof source !== 'string') return null
      let spec = source.trim()
      if (name && spec.startsWith(`${name}@`)) {
        const rest = spec.slice(name.length + 1)
        if (/^(?:github|gh|gitlab|bitbucket|git|git\+[a-z]+|https?|file|link):|^git@|^[\w.-]+\/[\w.-]+(?:#.*)?$/i.test(rest)) spec = rest
      } else {
        const match = ALIAS.exec(spec)
        if (match) spec = spec.slice(match[0].length)
      }
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
      if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(spec)) return 'github'
      return 'registry'
    }

    /* ── rules over the host's rows ─────────────────────────────────────── */

    function rowOf(plugins, name) {
      return Array.isArray(plugins) ? plugins.find((row) => row && row.name === name) : undefined
    }

    /** Can this row be updated (reinstalled from its recorded source)? */
    function updatable(row) {
      return Boolean(row && row.installed && row.removable !== false && typeof row.source === 'string' && row.kind)
    }

    /**
     * What the detail page's button would update, or null: an installed, profile-owned,
     * third-party bundle with a recorded source. The host lists only third-party rows.
     */
    function updateTarget(subject, plugins) {
      if (!subject || subject.kind !== 'bundle' || !subject.pkg) return null
      const pkg = subject.pkg
      if (!pkg.installed || pkg.official || pkg.availability === 'installation') return null
      const row = rowOf(plugins, pkg.name)
      if (!updatable(row)) return null
      return { name: row.name, spec: row.source, enabled: pkg.enabled === true, kind: row.kind, self: row.self === true }
    }

    function isBehind(row) {
      return Boolean(row && row.check && row.check.behind === true)
    }

    function isActive(job) {
      return Boolean(job) && ACTIVE.includes(job.phase)
    }

    /** The plugins a running or queued job is changing. */
    function busyNames(jobs) {
      return new Set((jobs || []).filter(isActive).map((job) => job.name).filter(Boolean))
    }

    /** Update requests for `names`, this plugin last (the host sorts too). */
    function updateRequests(plugins, names) {
      const rows = names.map((name) => rowOf(plugins, name)).filter(updatable)
      rows.sort((a, b) => Number(a.self === true) - Number(b.self === true))
      return rows.map((row) => ({ type: 'update', name: row.name, enabled: row.enabled }))
    }

    function rowStatus(row, busy) {
      if (busy) return 'busy'
      if (row.error || row.availability === 'missing') return 'problem'
      if (!row.repo) return 'none'
      if (row.pinned) return 'pinned'
      if (!row.check) return 'unchecked'
      if (row.check.error) return 'failed'
      return row.check.behind ? 'behind' : 'latest'
    }

    /* ── failures ────────────────────────────────────────────────────────── */

    function errorLine(failure) {
      const text = [failure.diagnostic, failure.output].filter((item) => typeof item === 'string').join('\n')
      const lines = text.split('\n').map((item) => item.trim()).filter(Boolean)
      const hit = lines.find((item) => /\bERR_[A-Z_]+|^\[E[A-Z]+\]|^(?:error|fatal)\b|\berror:/i.test(item))
      const chosen = hit || (!failure.kind || failure.kind === 'unknown' ? lines.find((item) => !/^(?:Progress:|✓|Packages:|\+$)/.test(item)) : undefined)
      if (!chosen) return ''
      return chosen.length > 300 ? `${chosen.slice(0, 297)}…` : chosen
    }

    /** One or two sentences for a job failure, in the page's language. */
    function describeFailure(failure, t) {
      if (!failure) return ''
      const translate = t || fallbackT
      const parts = []
      const key = `failure_${failure.code}`
      if (failure.code === 'transport') parts.push(translate(key, { message: failure.message }))
      else if (has(translate, key)) parts.push(translate(key, failure))
      else parts.push(translate('failure_other', { code: failure.code }))
      if (failure.kind) {
        const kindKey = `kind_fail_${failure.kind}`
        if (has(translate, kindKey)) parts.push(translate(kindKey, { names: (failure.pendingBuilds || []).join(', ') }))
      }
      const line = errorLine(failure)
      if (line) parts.push(line)
      return parts.join(' ')
    }

    /* ── shared state (survives hot replacement via a fixed global slot) ──── */

    const SLOT = '__dshPluginManagerTool_v1__'
    const shared = (globalThis[SLOT] = globalThis[SLOT] || {
      overview: null, // { profile, plugins }
      overviewError: '',
      jobs: [],
      checking: false,
      listeners: new Set(),
    })

    function emit() {
      for (const listener of Array.from(shared.listeners)) listener()
    }

    function patchShared(patch) {
      Object.assign(shared, patch)
      emit()
    }

    function subscribe(listener) {
      shared.listeners.add(listener)
      return () => shared.listeners.delete(listener)
    }

    function useShared(selector) {
      const read = () => selector(shared)
      return React.useSyncExternalStore(subscribe, read, read)
    }

    /* ── api ─────────────────────────────────────────────────────────────── */

    async function defaultRequest(path, body) {
      const response = await fetch(API + path, body === undefined ? undefined : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => null)
      if (!payload) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status })
      if (payload.ok !== true) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status })
      return payload
    }

    /**
     * The long-lived side: overview, jobs and polling, and every call to the host.
     * @param deps - `{ request?: (path, body?) => payload, schedule?, cancel?, now? }`.
     */
    function createHub(deps) {
      const options = deps || {}
      const request = options.request || defaultRequest
      const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms))
      const cancel = options.cancel || ((handle) => clearTimeout(handle))
      const now = options.now || Date.now
      let timer
      let failingSince = 0
      let overviewInFlight
      let jobsInFlight

      function refreshOverview() {
        if (overviewInFlight) return overviewInFlight
        overviewInFlight = request('/overview')
          .then(
            (payload) => {
              patchShared({ overview: { profile: payload.profile, plugins: payload.plugins || [] }, overviewError: '' })
              return shared.overview
            },
            (error) => {
              patchShared({ overviewError: error.message || String(error) })
              return shared.overview
            },
          )
          .finally(() => {
            overviewInFlight = undefined
          })
        return overviewInFlight
      }

      function ensureOverview(name) {
        const known = shared.overview && (!name || rowOf(shared.overview.plugins, name))
        return known ? Promise.resolve(shared.overview) : refreshOverview()
      }

      function refreshJobs() {
        if (jobsInFlight) return jobsInFlight
        const before = new Map((shared.jobs || []).map((job) => [job.id, job.phase]))
        jobsInFlight = request('/jobs')
          .then(
            (payload) => {
              failingSince = 0
              const jobs = payload.jobs || []
              const settled = jobs.some((job) => before.has(job.id) && ACTIVE.includes(before.get(job.id)) && !isActive(job))
              patchShared({ jobs })
              if (settled) void refreshOverview()
              return jobs
            },
            () => {
              // During this plugin's own update its API is briefly gone: keep polling.
              if (!failingSince) failingSince = now()
              return shared.jobs
            },
          )
          .finally(() => {
            jobsInFlight = undefined
          })
        return jobsInFlight
      }

      function poll() {
        if (timer !== undefined) return
        timer = schedule(async () => {
          timer = undefined
          await refreshJobs()
          const giveUp = failingSince && now() - failingSince > POLL_GIVE_UP_MS
          if ((shared.jobs || []).some(isActive) && !giveUp) poll()
        }, POLL_MS)
      }

      function stop() {
        if (timer !== undefined) cancel(timer)
        timer = undefined
      }

      async function start() {
        await refreshJobs()
        if ((shared.jobs || []).some(isActive)) poll()
      }

      async function enqueue(requests) {
        const payload = await request('/jobs', { jobs: requests })
        const jobs = payload.jobs || []
        const ids = new Set(jobs.map((job) => job.id))
        patchShared({ jobs: [...jobs, ...(shared.jobs || []).filter((job) => !ids.has(job.id))] })
        poll()
        return jobs
      }

      async function retry(id, restore) {
        await request('/jobs/retry', { id, restore: restore === true })
        await refreshJobs()
        poll()
      }

      async function dismiss(id) {
        patchShared({ jobs: (shared.jobs || []).map((job) => (job.id === id ? Object.assign({}, job, { dismissed: true }) : job)) })
        try {
          await request('/jobs/dismiss', { id })
        } catch {
          // a job still running stays visible on the next poll
        }
      }

      async function check(names, force) {
        patchShared({ checking: true })
        try {
          await request('/check', Object.assign({ force: force === true }, names ? { names } : {}))
          await refreshOverview()
        } finally {
          patchShared({ checking: false })
        }
      }

      /** The detail badge: one plugin's remote state, at most once per ten minutes on the host. */
      const commitChecks = new Map()
      function checkOne(name) {
        if (commitChecks.has(name)) return commitChecks.get(name)
        const promise = request(`/commits?name=${encodeURIComponent(name)}`)
          .then(() => refreshOverview(), () => undefined)
          .finally(() => schedule(() => commitChecks.delete(name), 60 * 1000))
        commitChecks.set(name, promise)
        return promise
      }

      return {
        request,
        refreshOverview,
        ensureOverview,
        refreshJobs,
        start,
        stop,
        poll,
        enqueue,
        retry,
        dismiss,
        check,
        checkOne,
        refs: (name) => request(`/refs?name=${encodeURIComponent(name)}`),
        exportManifest: () => request('/export').then((payload) => payload.manifest),
        planImport: (manifest) => request('/import/plan', { manifest }),
        diagnostics: () => request('/diagnostics'),
        readLog: (name) => request(`/log?name=${encodeURIComponent(name)}`).then((payload) => payload.text),
        cleanLogs: (days) => request('/logs/clean', { days }),
      }
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

    function Btn({ variant, icon, label, disabled, onClick, children, autoFocus, size }) {
      const kit = ui()
      if (kit && kit.Button) {
        return h(kit.Button, { variant: variant || 'outline', size: size || 'sm', icon, disabled, autoFocus, 'aria-label': label, onClick }, children)
      }
      return h(
        'button',
        { type: 'button', className: `dpmButton${variant === 'primary' ? ' dpmPrimary' : ''}`, disabled, autoFocus, 'aria-label': label, onClick },
        children,
      )
    }

    function Tag({ tone, title, children }) {
      const kit = ui()
      if (kit && kit.Tag) return h('span', { title, className: 'dpmTagWrap' }, h(kit.Tag, { tone }, children))
      return h('span', { className: `dpmTag dpmTone-${tone || 'neutral'}`, title }, children)
    }

    function Dialog({ title, onClose, footer, wide, children, t }) {
      const kit = ui()
      if (kit && kit.Modal) {
        return h(kit.Modal, { open: true, onClose, title, closeLabel: t('close'), footer, className: wide ? 'dpmWideModal' : undefined }, h('div', { className: 'dpmDialogBody' }, children))
      }
      return h(
        'div',
        { className: 'dpmBackdrop', role: 'presentation', onClick: onClose },
        h(
          'div',
          { className: `dpmDialog${wide ? ' dpmWide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onClick: (event) => event.stopPropagation() },
          h('h3', null, title),
          h('div', { className: 'dpmDialogBody' }, children),
          footer ? h('div', { className: 'dpmActions' }, footer) : null,
        ),
      )
    }

    function refreshIcon() {
      const kit = ui()
      return kit && kit.IconRefreshOutlineRegular ? h(kit.IconRefreshOutlineRegular, { size: 13 }) : undefined
    }

    /* ── confirmations ───────────────────────────────────────────────────── */

    function ConfirmUpdate({ targets, t: translate, onConfirm, onCancel }) {
      const t = translate || fallbackT
      const single = targets.length === 1 ? targets[0] : null
      const title = single ? t('confirmTitle', { name: single.name }) : t('confirmBatchTitle', { count: targets.length })
      const self = targets.some((target) => target.self || target.name === SELF)
      const body = single
        ? [
            h('p', { key: 'body' }, t('confirmBody', { state: t(single.enabled ? 'keepEnabled' : 'keepDisabled') })),
            h('div', { key: 'src', className: 'dpmSource' }, h('span', null, t('sourceLabel')), h('code', null, single.spec)),
          ]
        : [
            h('p', { key: 'body' }, t('confirmBatchBody')),
            h('ul', { key: 'list', className: 'dpmPlainList' }, targets.map((target) => h('li', { key: target.name }, h('b', null, target.name), ' ', h('code', null, target.spec)))),
          ]
      return h(
        Dialog,
        {
          t,
          title,
          onClose: onCancel,
          footer: h(
            React.Fragment,
            null,
            h(Btn, { variant: 'outline', onClick: onCancel }, t('cancel')),
            h(Btn, { variant: 'primary', autoFocus: true, onClick: onConfirm }, single ? t('update') : t('confirm')),
          ),
        },
        body,
        self ? h('p', { className: 'dpmWarn' }, t(single ? 'confirmSelfOnly' : 'confirmSelf')) : null,
        h('p', { className: 'dpmMuted' }, t('confirmRisk')),
      )
    }

    /* ── page header: 更新, title: 有新提交 ──────────────────────────────── */

    function UpdateAction(props) {
      const { subject, hub } = props
      const t = props.t || fallbackT
      const isBundle = Boolean(subject && subject.kind === 'bundle' && subject.pkg)
      const name = isBundle ? subject.pkg.name : undefined
      const plugins = useShared((state) => (state.overview ? state.overview.plugins : null))
      const jobs = useShared((state) => state.jobs)
      const [confirming, setConfirming] = React.useState(false)
      React.useEffect(() => {
        if (isBundle && hub) hub.ensureOverview(name)
      }, [isBundle, name, hub])
      const target = updateTarget(subject, plugins)
      if (!target || !hub) return null
      const running = busyNames(jobs).has(target.name)
      return h(
        React.Fragment,
        null,
        h(Btn, { variant: 'outline', icon: refreshIcon(), label: t('updateLabel', { name: target.name }), disabled: running, onClick: () => setConfirming(true) }, running ? t('updating') : t('update')),
        confirming
          ? h(ConfirmUpdate, {
              targets: [target],
              t,
              onCancel: () => setConfirming(false),
              onConfirm: () => {
                setConfirming(false)
                void hub.enqueue(updateRequests(plugins, [target.name]))
              },
            })
          : null,
      )
    }

    function CommitBadge(props) {
      const { subject, hub } = props
      const t = props.t || fallbackT
      const isBundle = Boolean(subject && subject.kind === 'bundle' && subject.pkg)
      const name = isBundle ? subject.pkg.name : undefined
      const row = useShared((state) => (state.overview && name ? rowOf(state.overview.plugins, name) : undefined))
      const git = Boolean(row && row.repo && !row.pinned)
      React.useEffect(() => {
        if (isBundle && hub) hub.ensureOverview(name)
      }, [isBundle, name, hub])
      React.useEffect(() => {
        if (git && hub) hub.checkOne(name)
      }, [git, name, hub])
      if (!git || !isBehind(row)) return null
      const title = t('newCommitsTitle', { locked: short(row.locked), remote: short(row.check.remote), ref: row.check.ref || 'HEAD' })
      return h(Tag, { tone: 'info', title }, t('newCommits'))
    }

    /* ── version dialog ──────────────────────────────────────────────────── */

    function VersionDialog({ row, hub, t: translate, onClose }) {
      const t = translate || fallbackT
      const [refs, setRefs] = React.useState(null)
      const [error, setError] = React.useState('')
      const [choice, setChoice] = React.useState(null) // { ref } | { spec }
      const [custom, setCustom] = React.useState('')
      React.useEffect(() => {
        let live = true
        if (row.repo) {
          hub.refs(row.name).then(
            (payload) => live && setRefs(payload.refs),
            (failure) => live && setError(failure.message || String(failure)),
          )
        }
        return () => {
          live = false
        }
      }, [row.name])
      const currentRef = row.repo ? row.repo.ref || '' : undefined
      const option = (key, label, value, extra) =>
        h(
          'label',
          { key, className: 'dpmOption' },
          h('input', {
            type: 'radio',
            name: 'dpm-version',
            checked: Boolean(choice && JSON.stringify(choice) === JSON.stringify(value)),
            onChange: () => setChoice(value),
          }),
          h('span', null, label),
          extra ? h('span', { className: 'dpmMuted' }, extra) : null,
        )
      const sections = []
      if (row.repo) {
        if (!refs && !error) sections.push(h('p', { key: 'loading', className: 'dpmMuted' }, t('versionLoading')))
        if (error) sections.push(h('p', { key: 'error', className: 'dpmError' }, error))
        if (refs) {
          const branches = refs.branches.slice().sort((a, b) => Number(b.name === refs.defaultBranch) - Number(a.name === refs.defaultBranch))
          sections.push(
            h(
              'fieldset',
              { key: 'branches', className: 'dpmFieldset' },
              h('legend', null, t('versionBranches')),
              option('default', t('versionDefault'), { ref: '' }, refs.defaultBranch ? `${refs.defaultBranch} · ${short(refs.head)}${currentRef === '' ? ` · ${t('versionCurrent')}` : ''}` : short(refs.head)),
              branches.slice(0, 30).map((branch) => option(`b:${branch.name}`, branch.name, { ref: branch.name }, `${short(branch.commit)}${currentRef === branch.name ? ` · ${t('versionCurrent')}` : ''}`)),
            ),
          )
          if (refs.tags.length) {
            sections.push(
              h(
                'fieldset',
                { key: 'tags', className: 'dpmFieldset' },
                h('legend', null, t('versionTags')),
                refs.tags.slice(0, 30).map((tag) => option(`t:${tag.name}`, tag.name, { ref: tag.name }, `${short(tag.commit)}${currentRef === tag.name ? ` · ${t('versionCurrent')}` : ''}`)),
              ),
            )
          }
        }
      } else sections.push(h('p', { key: 'norefs', className: 'dpmMuted' }, t('versionNoRefs')))
      const history = (row.history || []).filter((entry) => entry && (entry.commit ? entry.commit !== row.locked : entry.spec !== row.source))
      if (history.length) {
        sections.push(
          h(
            'fieldset',
            { key: 'history', className: 'dpmFieldset' },
            h('legend', null, t('versionHistory')),
            history.slice(0, 10).map((entry, index) =>
              option(
                `h:${index}`,
                t('historyItem', { when: when(entry.at), version: entry.version || '?', commit: entry.commit ? short(entry.commit) : entry.spec }),
                row.repo && entry.commit ? { ref: entry.commit } : { spec: entry.spec },
              ),
            ),
          ),
        )
      }
      sections.push(
        h(
          'fieldset',
          { key: 'custom', className: 'dpmFieldset' },
          h('legend', null, t('versionCustom')),
          h('input', {
            className: 'dpmInput',
            value: custom,
            placeholder: t('versionCustomHint'),
            onChange: (event) => {
              setCustom(event.target.value)
              setChoice(event.target.value.trim() ? { spec: event.target.value.trim() } : null)
            },
          }),
        ),
      )
      const apply = () => {
        if (!choice) return
        const base = { type: 'switch', name: row.name, enabled: row.enabled, previousSpec: row.source }
        void hub.enqueue([choice.spec !== undefined ? Object.assign(base, { spec: choice.spec }) : Object.assign(base, { ref: choice.ref })])
        onClose()
      }
      return h(
        Dialog,
        {
          t,
          wide: true,
          title: t('versionTitle', { name: row.name }),
          onClose,
          footer: h(
            React.Fragment,
            null,
            h(Btn, { variant: 'outline', onClick: onClose }, t('cancel')),
            h(Btn, { variant: 'primary', disabled: !choice, onClick: apply }, t('versionApply')),
          ),
        },
        h('div', { className: 'dpmSource' }, h('span', null, t('versionCurrent')), h('code', null, row.source), row.locked ? h('code', null, short(row.locked)) : null),
        sections,
        row.repo ? h('p', { className: 'dpmMuted' }, t('versionPinNote')) : null,
        h('p', { className: 'dpmMuted' }, t('confirmRisk')),
      )
    }

    /* ── export / import ─────────────────────────────────────────────────── */

    function downloadJson(filename, value) {
      if (typeof document === 'undefined' || typeof Blob === 'undefined') return
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    function ExportDialog({ hub, t: translate, onClose }) {
      const t = translate || fallbackT
      const [manifest, setManifest] = React.useState(null)
      const [error, setError] = React.useState('')
      const [copied, setCopied] = React.useState(false)
      React.useEffect(() => {
        hub.exportManifest().then(setManifest, (failure) => setError(failure.message || String(failure)))
      }, [])
      const text = manifest ? JSON.stringify(manifest, null, 2) : ''
      const filename = manifest ? `dsh-plugins-${manifest.profile || 'profile'}-${String(manifest.exportedAt || '').slice(0, 10)}.json` : 'dsh-plugins.json'
      return h(
        Dialog,
        {
          t,
          wide: true,
          title: t('exportTitle'),
          onClose,
          footer: h(
            React.Fragment,
            null,
            h(
              Btn,
              {
                variant: 'outline',
                disabled: !manifest,
                onClick: () => {
                  if (typeof navigator !== 'undefined' && navigator.clipboard) {
                    navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})
                  }
                },
              },
              copied ? t('copied') : t('copy'),
            ),
            h(Btn, { variant: 'primary', disabled: !manifest, onClick: () => downloadJson(filename, manifest) }, t('download')),
          ),
        },
        h('p', { className: 'dpmMuted' }, t('exportBody')),
        error ? h('p', { className: 'dpmError' }, error) : null,
        manifest ? h('pre', { className: 'dpmLog dpmTall' }, text) : h('p', { className: 'dpmMuted' }, t('loading')),
      )
    }

    function ImportDialog({ hub, t: translate, onClose }) {
      const t = translate || fallbackT
      const [text, setText] = React.useState('')
      const [plan, setPlan] = React.useState(null)
      const [picked, setPicked] = React.useState({})
      const [error, setError] = React.useState('')
      const parse = (raw) => {
        setError('')
        let manifest
        try {
          manifest = JSON.parse(raw)
        } catch (failure) {
          setError(failure.message)
          return
        }
        hub.planImport(manifest).then(
          (result) => {
            setPlan(result.items)
            setPicked(Object.fromEntries(result.items.map((item) => [item.name, item.selected === true])))
          },
          (failure) => setError(failure.message || String(failure)),
        )
      }
      const readFile = (event) => {
        const file = event.target.files && event.target.files[0]
        if (!file || typeof FileReader === 'undefined') return
        const reader = new FileReader()
        reader.onload = () => {
          setText(String(reader.result || ''))
          parse(String(reader.result || ''))
        }
        reader.readAsText(file)
      }
      const chosen = (plan || []).filter((item) => picked[item.name] && (item.action === 'install' || item.action === 'replace'))
      const start = () => {
        const requests = chosen.map((item) =>
          item.action === 'replace'
            ? { type: 'switch', name: item.name, spec: item.spec, enabled: item.enabled, setEnabled: true, previousSpec: item.current }
            : { type: 'install', name: item.name, spec: item.spec, enabled: item.enabled },
        )
        if (requests.length) void hub.enqueue(requests)
        onClose()
      }
      const rows = (plan || []).map((item) =>
        h(
          'tr',
          { key: item.name || item.spec },
          h(
            'td',
            null,
            h('input', {
              type: 'checkbox',
              disabled: item.action === 'skip' || item.action === 'invalid',
              checked: Boolean(picked[item.name]),
              onChange: (event) => setPicked(Object.assign({}, picked, { [item.name]: event.target.checked })),
            }),
          ),
          h('td', null, h('b', null, item.name), h('div', null, h('code', null, item.spec)), item.current && item.action === 'replace' ? h('div', { className: 'dpmMuted' }, t('currentSource', { source: item.current })) : null),
          h('td', null, t(`action_${item.action}`), item.reason && item.reason !== 'same' ? h('div', { className: 'dpmWarn' }, t(`reason_${String(item.reason).replace(/-/g, '_')}`)) : null),
          h('td', null, t(item.enabled ? 'stateEnabled' : 'stateDisabled')),
        ),
      )
      return h(
        Dialog,
        {
          t,
          wide: true,
          title: t('importTitle'),
          onClose,
          footer: h(
            React.Fragment,
            null,
            h(Btn, { variant: 'outline', onClick: onClose }, t('cancel')),
            plan
              ? h(Btn, { variant: 'primary', disabled: chosen.length === 0, onClick: start }, t('importStart', { count: chosen.length }))
              : h(Btn, { variant: 'primary', disabled: !text.trim(), onClick: () => parse(text) }, t('importParse')),
          ),
        },
        plan
          ? rows.length
            ? h('table', { className: 'dpmTable' }, h('tbody', null, rows))
            : h('p', { className: 'dpmMuted' }, t('importNothing'))
          : [
              h('p', { key: 'hint', className: 'dpmMuted' }, t('importBody')),
              h('textarea', { key: 'text', className: 'dpmTextarea', value: text, onChange: (event) => setText(event.target.value), spellCheck: false }),
              h('label', { key: 'file', className: 'dpmFile' }, h('input', { type: 'file', accept: 'application/json,.json', onChange: readFile }), t('importFile')),
            ],
        error ? h('p', { className: 'dpmError' }, error) : null,
      )
    }

    /* ── diagnostics ─────────────────────────────────────────────────────── */

    function Diagnostics({ hub, t: translate, jobsBusy }) {
      const t = translate || fallbackT
      const [open, setOpen] = React.useState(false)
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [log, setLog] = React.useState(null) // { name, text }
      const [note, setNote] = React.useState('')
      const load = () => hub.diagnostics().then(setData, (failure) => setError(failure.message || String(failure)))
      React.useEffect(() => {
        if (open) void load()
      }, [open, jobsBusy])
      const view = (name) => hub.readLog(name).then((text) => setLog({ name, text }), (failure) => setError(failure.message || String(failure)))
      const clean = () =>
        hub.cleanLogs(30).then((result) => {
          setNote(t('cleanedLogs', { count: result.removed, size: bytes(result.bytes) }))
          return load()
        }, (failure) => setError(failure.message || String(failure)))
      const body = !open
        ? null
        : !data
          ? h('p', { className: 'dpmMuted' }, error || t('loading'))
          : h(
              'div',
              { className: 'dpmDiag' },
              h('h5', null, t('diagnosticsBroken')),
              data.broken.length === 0
                ? h('p', { className: 'dpmMuted' }, t('diagnosticsBrokenNone'))
                : h(
                    'ul',
                    { className: 'dpmPlainList' },
                    data.broken.map((item) =>
                      h(
                        'li',
                        { key: item.name, className: 'dpmDiagItem' },
                        h('div', null, h('b', null, item.name), ' ', h(Tag, { tone: 'danger' }, item.code), item.diagnostic ? h('pre', { className: 'dpmLog' }, tail(item.diagnostic, 8)) : null),
                        item.removable ? h(Btn, { variant: 'outline', onClick: () => hub.enqueue([{ type: 'remove', name: item.name }]) }, t('remove')) : null,
                      ),
                    ),
                  ),
              data.stray.length
                ? h(
                    React.Fragment,
                    null,
                    h('h5', null, t('diagnosticsStray')),
                    h('p', { className: 'dpmMuted' }, t('diagnosticsStrayHint')),
                    h('pre', { className: 'dpmLog' }, data.stray.map((item) => item.command).join('\n')),
                  )
                : null,
              h('h5', null, t('diagnosticsLogs')),
              data.logs.length === 0
                ? h('p', { className: 'dpmMuted' }, t('diagnosticsLogsNone'))
                : h(
                    'table',
                    { className: 'dpmTable' },
                    h(
                      'tbody',
                      null,
                      data.logs.slice(0, 15).map((item) =>
                        h('tr', { key: item.name }, h('td', null, h('code', null, item.name)), h('td', null, bytes(item.size)), h('td', null, when(item.mtime)), h('td', null, h(Btn, { variant: 'outline', onClick: () => view(item.name) }, t('viewLog')))),
                      ),
                    ),
                  ),
              h('div', { className: 'dpmActions dpmLeft' }, h(Btn, { variant: 'outline', onClick: clean }, t('cleanLogs', { days: 30 })), note ? h('span', { className: 'dpmMuted' }, note) : null),
            )
      return h(
        'section',
        { className: 'dpmSection' },
        h('button', { type: 'button', className: 'dpmDisclosure', 'aria-expanded': open, onClick: () => setOpen(!open) }, `${open ? '▾' : '▸'} ${t('diagnostics')}`),
        body,
        log ? h(Dialog, { t, wide: true, title: t('logTitle', { name: log.name }), onClose: () => setLog(null) }, h('pre', { className: 'dpmLog dpmTall' }, log.text)) : null,
      )
    }

    /* ── the Manage tab ──────────────────────────────────────────────────── */

    function PluginRow({ row, t: translate, busy, selected, onSelect, onUpdate, onVersions, onOpen }) {
      const t = translate || fallbackT
      const status = rowStatus(row, busy)
      const title = pickText(row.meta && row.meta.title, t) || row.name
      const statusTag =
        status === 'behind'
          ? h(Tag, { tone: 'info', title: t('newCommitsTitle', { locked: short(row.locked), remote: short(row.check.remote), ref: row.check.ref }) }, t('statusBehind'))
          : status === 'latest'
            ? h(Tag, { tone: 'success' }, t('statusLatest'))
            : status === 'pinned'
              ? h(Tag, null, t('statusPinned', { commit: short(row.repo.ref) }))
              : status === 'failed'
                ? h(Tag, { tone: 'warning', title: row.check.error }, t('statusCheckFailed'))
                : status === 'problem'
                  ? h(Tag, { tone: 'danger', title: row.error && row.error.code }, t('statusProblem'))
                  : status === 'busy'
                    ? h(Tag, { tone: 'info' }, t('statusBusy'))
                    : status === 'unchecked'
                      ? h(Tag, null, t('statusUnchecked'))
                      : null
      const facts = []
      if (row.version) facts.push(`v${row.version}`)
      if (row.locked) facts.push(t('commitLine', { commit: short(row.locked) }))
      if (status === 'behind') facts.push(t('behindLine', { locked: short(row.locked), remote: short(row.check.remote), ref: row.check.ref }))
      facts.push(t(row.enabled ? 'stateEnabled' : 'stateDisabled'))
      return h(
        'li',
        { className: 'dpmRow', 'data-dpm-plugin': row.name, 'data-dpm-status': status },
        h('input', { type: 'checkbox', className: 'dpmCheck', 'aria-label': row.name, checked: selected, disabled: !updatable(row) || busy, onChange: (event) => onSelect(event.target.checked) }),
        h(
          'div',
          { className: 'dpmRowMain' },
          h(
            'div',
            { className: 'dpmRowHead' },
            h('button', { type: 'button', className: 'dpmLink', onClick: onOpen }, title),
            title !== row.name ? h('span', { className: 'dpmMuted dpmMono' }, row.name) : null,
            row.kind ? h(Tag, null, t(`kind_${row.kind}`)) : null,
            row.self ? h(Tag, null, t('selfTag')) : null,
            statusTag,
          ),
          h('div', { className: 'dpmRowSource' }, h('code', null, row.source || '—')),
          h('div', { className: 'dpmMuted' }, facts.join(' · ')),
        ),
        h(
          'div',
          { className: 'dpmRowActions' },
          h(Btn, { variant: status === 'behind' ? 'primary' : 'outline', icon: refreshIcon(), disabled: busy || !updatable(row), label: t('updateLabel', { name: row.name }), onClick: onUpdate }, busy ? t('updating') : t('update')),
          h(Btn, { variant: 'outline', disabled: busy || !updatable(row), onClick: onVersions }, t('versions')),
        ),
      )
    }

    function JobHistory({ jobs, t: translate }) {
      const t = translate || fallbackT
      const recent = (jobs || []).slice(0, 10)
      return h(
        'section',
        { className: 'dpmSection' },
        h('h4', null, t('jobsTitle')),
        recent.length === 0
          ? h('p', { className: 'dpmMuted' }, t('jobsNone'))
          : h(
              'table',
              { className: 'dpmTable' },
              h(
                'tbody',
                null,
                recent.map((job) =>
                  h(
                    'tr',
                    { key: job.id },
                    h('td', null, when(job.createdAt)),
                    h('td', null, t(`type_${job.type}`)),
                    h('td', null, h('b', null, job.name || job.spec)),
                    h('td', null, h(Tag, { tone: job.phase === 'done' ? 'success' : job.phase === 'failed' || job.phase === 'interrupted' ? 'danger' : 'info' }, t(phaseKey(job.phase)))),
                    h('td', { className: 'dpmMuted' }, job.after && job.after.commit ? `${short(job.before && job.before.commit)} → ${short(job.after.commit)}` : job.after && job.after.version ? `v${job.after.version}` : ''),
                  ),
                ),
              ),
            ),
      )
    }

    function phaseKey(phase) {
      return phase === 'done' ? 'stepDone' : phase === 'failed' ? 'stepFailed' : phase === 'interrupted' ? 'stepFailed' : phase === 'queued' ? 'stepWaiting' : 'stepRunning'
    }

    function ManageTab(props) {
      const { hub, openPackage } = props
      const t = props.t || fallbackT
      const overview = useShared((state) => state.overview)
      const loadError = useShared((state) => state.overviewError)
      const jobs = useShared((state) => state.jobs)
      const checking = useShared((state) => state.checking)
      const [selected, setSelected] = React.useState({})
      const [dialog, setDialog] = React.useState(null) // { kind, ... }
      React.useEffect(() => {
        if (hub) {
          void hub.refreshOverview()
          void hub.refreshJobs()
        }
      }, [hub])
      if (!hub) return null
      const plugins = overview ? overview.plugins : []
      const busy = busyNames(jobs)
      const behind = plugins.filter((row) => isBehind(row) && updatable(row) && !busy.has(row.name))
      const picked = plugins.filter((row) => selected[row.name] && updatable(row) && !busy.has(row.name))
      const checkedAt = plugins.map((row) => row.check && row.check.at).filter(Boolean).sort().pop()
      const legacy = plugins.filter((row) => row.legacy)
      const confirm = (rows) =>
        setDialog({ kind: 'confirm', targets: rows.map((row) => ({ name: row.name, spec: row.source, enabled: row.enabled, self: row.self })) })
      const toolbar = h(
        'div',
        { className: 'dpmToolbar' },
        h(Btn, { variant: 'outline', icon: refreshIcon(), disabled: checking || plugins.length === 0, onClick: () => hub.check(undefined, true) }, checking ? t('checking') : t('check')),
        h(Btn, { variant: 'primary', disabled: behind.length === 0, onClick: () => confirm(behind) }, t('updateAll', { count: behind.length })),
        h(Btn, { variant: 'outline', disabled: picked.length === 0, onClick: () => confirm(picked) }, t('updateSelected', { count: picked.length })),
        h('span', { className: 'dpmSpacer' }),
        h(Btn, { variant: 'outline', disabled: plugins.length === 0, onClick: () => setDialog({ kind: 'export' }) }, t('exportList')),
        h(Btn, { variant: 'outline', onClick: () => setDialog({ kind: 'import' }) }, t('importList')),
      )
      let list
      if (!overview) list = h('p', { className: 'dpmMuted' }, loadError ? t('loadFailed', { error: loadError }) : t('loading'))
      else if (plugins.length === 0) list = h('p', { className: 'dpmMuted' }, t('empty'))
      else {
        list = h(
          'ul',
          { className: 'dpmRows' },
          plugins.map((row) =>
            h(PluginRow, {
              key: row.name,
              row,
              t,
              busy: busy.has(row.name),
              selected: Boolean(selected[row.name]),
              onSelect: (value) => setSelected(Object.assign({}, selected, { [row.name]: value })),
              onUpdate: () => confirm([row]),
              onVersions: () => setDialog({ kind: 'versions', name: row.name }),
              onOpen: () => typeof openPackage === 'function' && openPackage(row.name),
            }),
          ),
        )
      }
      let modal = null
      if (dialog && dialog.kind === 'confirm') {
        modal = h(ConfirmUpdate, {
          targets: dialog.targets,
          t,
          onCancel: () => setDialog(null),
          onConfirm: () => {
            void hub.enqueue(updateRequests(plugins, dialog.targets.map((target) => target.name)))
            setSelected({})
            setDialog(null)
          },
        })
      } else if (dialog && dialog.kind === 'versions' && rowOf(plugins, dialog.name)) {
        modal = h(VersionDialog, { row: rowOf(plugins, dialog.name), hub, t, onClose: () => setDialog(null) })
      } else if (dialog && dialog.kind === 'export') modal = h(ExportDialog, { hub, t, onClose: () => setDialog(null) })
      else if (dialog && dialog.kind === 'import') modal = h(ImportDialog, { hub, t, onClose: () => setDialog(null) })
      return h(
        'div',
        { className: 'dpmTab', 'data-dpm-tab': '' },
        h('div', { className: 'dpmIntro' }, h('h3', null, t('tabTitle')), h('p', { className: 'dpmMuted' }, t('tabIntro'))),
        toolbar,
        h('p', { className: 'dpmMuted dpmSmall' }, checkedAt ? t('lastChecked', { time: when(checkedAt) }) : t('neverChecked')),
        legacy.map((row) =>
          h(
            'div',
            { key: row.name, className: 'dpmNotice' },
            h('span', null, t('legacyNotice', { name: row.name })),
            h(Btn, { variant: 'outline', disabled: busy.has(row.name), onClick: () => hub.enqueue([{ type: 'remove', name: row.name }]) }, t('uninstallLegacy', { name: row.name })),
          ),
        ),
        list,
        h(JobHistory, { jobs, t }),
        h(Diagnostics, { hub, t, jobsBusy: busy.size }),
        modal,
      )
    }

    /* ── progress panel ──────────────────────────────────────────────────── */

    function stepState(job, step) {
      const removes = job.type === 'update' || job.type === 'switch' || job.type === 'remove'
      const installs = job.type !== 'remove'
      const unreachable = job.phase === 'failed' && job.failedStage === 'preflight'
      if (step === 'check') {
        if (!job.preflight) return null
        if (job.phase === 'checking') return 'running'
        if (unreachable) return 'failed'
        return job.phase === 'queued' ? 'waiting' : 'done'
      }
      if (unreachable) return step === 'remove' && !removes ? null : step === 'install' && !installs ? null : 'skipped'
      if (step === 'remove') {
        if (!removes) return null
        if (job.phase === 'removing') return 'running'
        if ((job.phase === 'failed' || job.phase === 'interrupted') && job.failedStage === 'remove') return 'failed'
        if (job.removed) return 'done'
        if (job.phase === 'done' && job.type === 'remove') return 'done'
        return job.phase === 'queued' ? 'waiting' : job.phase === 'interrupted' ? 'waiting' : 'skipped'
      }
      if (!installs) return null
      if (job.phase === 'installing') return 'running'
      if (job.phase === 'done') return 'done'
      if ((job.phase === 'failed' && job.failedStage === 'install') || (job.phase === 'interrupted' && job.removed)) return 'failed'
      return 'waiting'
    }

    const STEP_LABEL = { waiting: 'stepWaiting', running: 'stepRunning', done: 'stepDone', failed: 'stepFailed', skipped: 'stepSkipped' }
    const STEP_GLYPH = { waiting: '○', running: '◌', done: '✓', failed: '✕', skipped: '–' }

    function Step({ state, label, t }) {
      return h(
        'li',
        { className: `dpmStep dpm-${state}` },
        h('span', { className: 'dpmGlyph', 'aria-hidden': 'true' }, STEP_GLYPH[state]),
        h('span', { className: 'dpmStepText' }, label),
        h('span', { className: 'dpmStepState' }, t(STEP_LABEL[state])),
      )
    }

    function jobTitle(job, t) {
      const params = { name: job.name || job.spec, type: t(`type_${job.type}`) }
      if (job.phase === 'queued') return t('titleQueued', params)
      if (isActive(job)) return t('titleRunning', params)
      if (job.phase === 'done') return t('titleDone', params)
      if (job.phase === 'interrupted') return t('titleInterrupted', params)
      return t('titleFailed', params)
    }

    function JobPanel({ job, hub, t: translate }) {
      const t = translate || fallbackT
      const [showLog, setShowLog] = React.useState(false)
      const running = isActive(job)
      const checkState = stepState(job, 'check')
      const removeState = stepState(job, 'remove')
      const installState = stepState(job, 'install')
      const lines = []
      if (job.self && running) lines.push(h('p', { key: 'self', className: 'dpmMuted' }, t('selfNote')))
      if (running && job.detail) lines.push(h('p', { key: 'detail', className: 'dpmMuted' }, t(job.detail)))
      if (job.phase === 'done' && job.type !== 'remove') {
        const facts = []
        const after = job.after || {}
        const before = job.before || {}
        if (after.version) facts.push(t('doneVersion', { version: after.version }))
        if (after.commit) {
          if (before.commit && before.commit !== after.commit) facts.push(t('doneCommit', { before: short(before.commit), after: short(after.commit) }))
          else if (before.commit) facts.push(t('doneSameCommit', { after: short(after.commit) }))
          else facts.push(t('doneCommitOnly', { after: short(after.commit) }))
        }
        if (facts.length) lines.push(h('p', { key: 'facts' }, facts.join(' · ')))
        lines.push(h('p', { key: 'state', className: 'dpmMuted' }, t(job.type === 'install' ? (job.enabled ? 'doneInstalledEnabled' : 'doneInstalledDisabled') : job.enabled ? 'doneEnabled' : 'doneDisabled')))
      }
      if (job.phase === 'done' && job.application === 'restart-required') lines.push(h('p', { key: 'restart', className: 'dpmWarn' }, t('restartRequired')))
      if (job.phase === 'failed') {
        lines.push(h('p', { key: 'why', className: 'dpmError', role: 'alert' }, describeFailure(job.failure, t)))
        if (job.removed) lines.push(h('p', { key: 'warn', className: 'dpmWarn' }, t('removedWarning')))
        else if (job.failedStage === 'remove') lines.push(h('p', { key: 'kept', className: 'dpmMuted' }, t('removeFailedNote')))
        else if (job.failedStage === 'preflight') lines.push(h('p', { key: 'kept', className: 'dpmMuted' }, t('unchangedNote')))
      }
      if (job.phase === 'interrupted') lines.push(h('p', { key: 'int', className: 'dpmWarn' }, t('interruptedNote')))
      if ((job.installTries || 1) > 1) lines.push(h('p', { key: 'tries', className: 'dpmMuted' }, t('installRetried', { count: job.installTries - 1 })))
      if ((job.phase === 'failed' || job.phase === 'interrupted') && job.removed && job.spec) {
        lines.push(h('div', { key: 'src', className: 'dpmSource' }, h('span', null, t('sourceLabel')), h('code', null, job.spec)))
      }
      const log = job.log || (job.failure && job.failure.output) || ''
      const buttons = []
      if (log) buttons.push(h(Btn, { key: 'log', variant: 'outline', onClick: () => setShowLog(!showLog) }, t(showLog ? 'hideLog' : 'showLog')))
      if (job.phase === 'failed' || job.phase === 'interrupted') {
        if (job.type === 'switch' && job.removed && job.previousSpec && job.previousSpec !== job.spec) {
          buttons.push(h(Btn, { key: 'restore', variant: 'outline', onClick: () => hub.retry(job.id, true) }, t('restore')))
        }
        buttons.push(h(Btn, { key: 'retry', variant: 'primary', onClick: () => hub.retry(job.id, false) }, t(job.removed ? 'retryInstall' : 'retry')))
      }
      if (!running) buttons.push(h(Btn, { key: 'close', variant: 'outline', onClick: () => hub.dismiss(job.id) }, t('close')))
      return h(
        'section',
        { className: `dpmPanel dpm-${job.phase}`, 'data-dpm-job': job.name || job.spec, 'aria-live': 'polite' },
        h('h4', { className: 'dpmTitle' }, jobTitle(job, t)),
        h(
          'ol',
          { className: 'dpmSteps' },
          checkState ? h(Step, { state: checkState, label: t((job.checkTries || 1) > 1 ? 'stepCheckRetry' : 'stepCheck', { tries: job.checkTries }), t }) : null,
          removeState ? h(Step, { state: removeState, label: t('stepRemove'), t }) : null,
          installState ? h(Step, { state: installState, label: t('stepInstall', { spec: job.spec || '' }), t }) : null,
        ),
        lines,
        showLog && log ? h('pre', { className: 'dpmLog' }, tail(log, 60)) : running && log ? h('pre', { className: 'dpmLog dpmLogTail' }, tail(log, 3)) : null,
        buttons.length ? h('div', { className: 'dpmActions' }, buttons) : null,
      )
    }

    function JobsOverlay(props) {
      const t = props.t || fallbackT
      const jobs = useShared((state) => state.jobs)
      if (!props.hub) return null
      const visible = (jobs || []).filter((job) => !job.dismissed)
      if (visible.length === 0) return null
      // Active first (oldest first, the order they run), then finished ones.
      const ordered = visible.filter(isActive).reverse().concat(visible.filter((job) => !isActive(job)))
      const shown = ordered.slice(0, OVERLAY_MAX)
      return h(
        'div',
        { className: 'dpmStack' },
        shown.map((job) => h(JobPanel, { key: job.id, job, hub: props.hub, t })),
        ordered.length > shown.length ? h('div', { className: 'dpmPanel dpmMore' }, t('moreJobs', { count: ordered.length - shown.length })) : null,
      )
    }

    /* ── styles ──────────────────────────────────────────────────────────── */

    const CSS = `
.dpmTab{display:flex;flex-direction:column;gap:12px;padding:4px 0 24px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#1f2328)}
.dpmIntro h3{margin:0 0 2px;font-size:15px;font-weight:600}
.dpmIntro p{margin:0}
.dpmToolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dpmSpacer{flex:1}
.dpmSmall{font-size:12px;margin:-6px 0 0}
.dpmRows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:12px;overflow:hidden}
.dpmRow{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.dpmRow:first-child{border-top:0}
.dpmCheck{margin-top:4px}
.dpmRowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.dpmRowHead{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.dpmRowSource code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all;color:var(--dsw-alias-label-secondary,#57606a)}
.dpmRowActions{display:flex;gap:6px;flex:none;align-items:center}
.dpmLink{background:none;border:0;padding:0;font:inherit;font-weight:600;color:inherit;cursor:pointer;text-align:left}
.dpmLink:hover{text-decoration:underline}
.dpmMono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.dpmSection h4{margin:8px 0 6px;font-size:13px;font-weight:600}
.dpmSection h5{margin:12px 0 4px;font-size:12px;font-weight:600}
.dpmDisclosure{background:none;border:0;padding:4px 0;font:inherit;font-weight:600;color:inherit;cursor:pointer}
.dpmDiagItem{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;margin-bottom:6px}
.dpmNotice{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f6f8fa)}
.dpmTable{width:100%;border-collapse:collapse;font-size:12px}
.dpmTable td{padding:5px 6px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));vertical-align:top}
.dpmTable code{word-break:break-all}
.dpmPlainList{margin:4px 0;padding-left:18px}
.dpmTag{display:inline-block;padding:0 6px;border-radius:6px;font-size:11px;line-height:18px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#57606a)}
.dpmTone-info{background:var(--dsw-alias-bg-multi-select,rgba(77,107,254,.12));color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dpmTone-success{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.dpmTone-danger{color:var(--dsw-alias-state-error-primary,#cf222e)}
.dpmTone-warning{color:var(--dsw-alias-state-warning-primary,#9a6700)}
.dpmTagWrap{display:inline-flex}
.dpmStack{position:fixed;right:16px;bottom:16px;z-index:1000;display:flex;flex-direction:column;gap:10px;width:400px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;pointer-events:none}
.dpmPanel{pointer-events:auto;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:14px 16px;font-size:13px;line-height:1.5}
.dpmPanel p{margin:6px 0 0}
.dpmMore{padding:8px 16px;color:var(--dsw-alias-label-secondary,#57606a)}
.dpmTitle{margin:0 0 8px;font-size:14px;font-weight:600;word-break:break-all}
.dpmSteps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.dpmStep{display:flex;align-items:flex-start;gap:8px}
.dpmGlyph{width:14px;text-align:center;flex:none;color:var(--dsw-alias-label-tertiary,#8b949e)}
.dpmStepText{flex:1;word-break:break-all}
.dpmStepState{flex:none;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px}
.dpm-running .dpmGlyph{color:var(--dsw-alias-brand-primary,#4d6bfe);animation:dpmSpin 1s linear infinite}
.dpm-done .dpmGlyph{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.dpm-failed .dpmGlyph,.dpm-failed .dpmStepState{color:var(--dsw-alias-state-error-primary,#cf222e)}
@keyframes dpmSpin{to{transform:rotate(360deg)}}
.dpmMuted{color:var(--dsw-alias-label-secondary,#57606a)}
.dpmError{color:var(--dsw-alias-state-error-primary,#cf222e);word-break:break-word}
.dpmWarn{color:var(--dsw-alias-state-warning-primary,#9a6700)}
.dpmSource{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin:8px 0;font-size:12px}
.dpmSource span{flex:none;color:var(--dsw-alias-label-secondary,#57606a)}
.dpmSource code{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dpmLog{margin:8px 0 0;max-height:240px;overflow:auto;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f8fa);font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
.dpmTall{max-height:50vh}
.dpmLogTail{max-height:64px;overflow:hidden;color:var(--dsw-alias-label-secondary,#57606a)}
.dpmActions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:center}
.dpmLeft{justify-content:flex-start}
.dpmDialogBody{font-size:13px;line-height:1.5}
.dpmDialogBody p{margin:0 0 8px}
.dpmFieldset{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:10px;padding:6px 10px 8px;margin:0 0 10px;max-height:220px;overflow:auto}
.dpmFieldset legend{font-size:12px;font-weight:600;padding:0 4px}
.dpmOption{display:flex;gap:8px;align-items:center;padding:3px 0;cursor:pointer}
.dpmOption span:nth-child(2){font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.dpmOption .dpmMuted{font-size:12px}
.dpmInput,.dpmTextarea{width:100%;box-sizing:border-box;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));background:transparent;color:inherit}
.dpmTextarea{min-height:180px;resize:vertical}
.dpmFile{display:inline-flex;gap:8px;align-items:center;margin-top:8px;font-size:12px;cursor:pointer;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2))}
.dpmFile input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.dpmButton{font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));background:transparent;color:inherit;cursor:pointer}
.dpmButton:disabled{opacity:.5;cursor:default}
.dpmPrimary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff}
.dpmBackdrop{position:fixed;inset:0;z-index:1001;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}
.dpmDialog{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border-radius:12px;padding:18px 20px;width:460px;max-width:calc(100vw - 32px);max-height:calc(100vh - 64px);overflow:auto}
.dpmWide{width:640px}
.dpmWideModal{width:min(640px,calc(100vw - 32px))!important;max-width:calc(100vw - 32px)!important}
.dpmDialog h3{margin:0 0 10px;font-size:15px}
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
    const inject = ['slots', 'locale', 'remote']

    function apply(ctx) {
      ctx.effect(() => installStyles(), 'dsh-plugin-manager: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-plugin-manager: dictionaries')
      const t = ctx.locale.bind(NS)

      const hub = createHub()
      ctx.effect(() => {
        void hub.start()
        const refresh = () => {
          if (shared.overview) void hub.refreshOverview()
          void hub.refreshJobs().then(() => {
            if ((shared.jobs || []).some(isActive)) hub.poll()
          })
        }
        const disposers = [ctx.remote.$on('plugin-manager/changed', refresh)]
        if (typeof ctx.on === 'function') disposers.push(ctx.on('connection/reset', refresh))
        return () => {
          hub.stop()
          for (const dispose of disposers) if (typeof dispose === 'function') dispose()
        }
      }, 'dsh-plugin-manager: jobs')

      const share = () => ({ hub })
      ctx.slots.inject('plugins.tab', () =>
        ctx.slots.register({ name: 'plugins.tab', id: SELF, label: () => t('tabLabel'), locale: NS, inject: share }, ManageTab),
      )
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
      pickText,
      classifySource,
      updatable,
      updateTarget,
      updateRequests,
      rowStatus,
      busyNames,
      describeFailure,
      stepState,
      createHub,
      shared,
      ManageTab,
      PluginRow,
      VersionDialog,
      ImportDialog,
      ExportDialog,
      Diagnostics,
      UpdateAction,
      CommitBadge,
      JobsOverlay,
      JobPanel,
    }
    return module.exports
  },
})
