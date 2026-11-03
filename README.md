# dsh-plugin-manager

[中文](#中文) · [English](#english)

---

## 中文

DeepSeek Harness（DSH）第三方插件的管理工具。在 DSH 插件页加一个**管理**标签页，集中查看和维护你自己安装的插件：从哪里装的、锁定在哪个提交、远端有没有更新；可以批量更新、切换分支或 tag、回滚、导入导出插件清单、排查异常。每个插件的详情页也会多一个**更新**按钮。

所有改动都交给 DSH 自己的插件管理服务完成，用的就是插件页「卸载」和「安装」背后的 `removeBundle` / `installBundle`。本插件只负责安排先后顺序，记录每一步，并在出错时告诉你插件现在处于什么状态。

适配 DSH `>=0.2.1-0 <0.3.0-0`（已在桌面版 0.2.1-rc.5 运行时、开启 HMR 的 profile 上实测）。

### 管理标签页

插件页 → **管理**。

- **总览**：列出当前 profile 里你安装的每个插件（DSH 自带的和官方插件不列），包括版本、来源类型（GitHub / git / 本地 / 压缩包 / npm）、安装 spec、锁定的提交、启用状态。
- **检查更新**：对 GitHub 和其他 git 来源执行 `git ls-remote`，比较远端分支（没写就是默认分支）最新的提交和 `pnpm-lock.yaml` 里锁定的提交。落后的插件标「有新提交」并显示 `155b39f → 62fbe58`；固定在某个提交的显示「固定在 …」。结果缓存 10 分钟，按钮会强制重查。
- **全部更新 / 更新所选**：按顺序逐个卸载，再从原来源重新安装，每个插件保持原来的启用状态。dsh-plugin-manager 自己总是排在最后。
- **版本…**：
  - git 来源可以选「跟随默认分支」、任一分支、任一 tag；
  - 也可以「回滚到更新前」：每次更新或切换前，插件会记下当时的提交、版本和 spec；
  - 或者填任意自定义 spec。
  - 选 tag 或提交会把插件固定在那个版本，「检查更新」不再提示；选分支即恢复跟随。
- **导出清单**：生成 JSON，包含每个插件的名称、安装来源、启用状态、版本和提交。可以复制或下载。
- **导入清单**：粘贴 JSON 或选择文件，先给出导入计划再执行：
  - 未安装的 → 安装（默认勾选）；
  - 已装、来源相同 → 跳过；
  - 已装、来源不同 → 可选「替换为此来源」（默认不勾）；
  - 本机找不到的本地路径 → 标出警告，默认不勾。
  - 导入时按清单里的启用状态安装。
- **最近任务**：最近 10 个任务及结果。
- **诊断与清理**：
  - 加载失败或文件缺失的插件，可以一键卸载；
  - profile 里「不是插件的依赖」，附上 `dsh plugin --profile <名称> remove <包>` 命令（DSH 的插件管理服务删不了这类依赖）；
  - pnpm 日志列表，可以查看内容，可以清理 30 天前的日志。

### 详情页

- **更新**按钮（`plugins.detail.actions`）：出现在当前 profile 安装、并记录了安装来源的第三方插件上，包括 dsh-plugin-manager 自己。点击后先确认，再走和「管理」页相同的更新任务。
- **有新提交**标签（`plugins.detail.badge`）：GitHub / git 来源的插件远端有更新时显示，悬停可看到两个提交号。

### 进度和失败

任务由插件的 host 半边在后台执行，状态写在 profile 目录下的 `.dsh-plugin-manager/`。所以：
- 刷新页面不会丢失进度；
- 卸载期间插件详情页会暂时消失，右下角的进度面板（`shell.overlay`）不受影响。

进度面板显示两个步骤（卸载、安装）、pnpm 输出和失败原因。失败原因会带上关键的那行报错，比如 `[ENOENT] …`、`ERR_PNPM_…`。失败后：
- **卸载之后安装失败**：插件处于未安装状态。面板会明确提示，并提供**重试安装**（只重做安装）。如果是切换版本失败，还提供**恢复原来的版本**。
- **卸载本身失败**：插件保持原样，**重试**会重做整个任务。
- **DSH 在任务中途重启**：任务标为「被中断」，可以重试。

### 更新自己

dsh-plugin-manager 也可以在「管理」页或自己的详情页上更新自己。卸载会把正在运行的插件实例停掉，但后台任务继续执行，用的是事先拿到的插件管理服务引用，直到重新安装完成。重装后的新实例从任务文件里读回结果，页面会短暂刷新一下。

批量更新时它总是排在最后。万一自更新的安装失败，插件管理页就没有这个工具了，可以在终端执行下面的命令重装：

```bash
dsh plugin --profile desktop add github:luyang950/dsh-plugin-manager
```

### 安装

```bash
dsh plugin --profile desktop add github:luyang950/dsh-plugin-manager
```

（Web 版把 `desktop` 换成 `web`。）开启了 HMR（`patchReload: live`）的 profile 会立刻生效，否则重启 DSH。也可以在 DSH 插件页「添加插件」里填 `github:luyang950/dsh-plugin-manager`。

装过早期版本 `dsh-plugin-updater` 的话，「管理」页会提示，并提供一键卸载（两者功能重复，同时装会出现两个「更新」按钮）。

### 已知限制

- 卸载后安装失败时，插件保持未安装，直到重试成功，或你手动用原来源重装。面板里会显示原来的来源。
- 重装后，插件在 profile 组合包选择列表里会排到末尾（DSH 的行为），配置层优先级可能随之变化。
- pnpm 拦下依赖的构建脚本时，本插件不代替你批准。请在插件页「添加插件」里用同一来源安装，并允许这些脚本。
- 远端检查使用 git 的非交互模式：不弹密码框，ssh 用 `BatchMode=yes`。私有仓库需要本机 git 的凭据助手或 ssh-agent 能直接提供凭据。`#semver:` 范围不做比较。
- npm 来源的插件可以「更新」（按记录的版本范围重新安装），但不检查注册表上的新版本。
- 用 `dsh plugin` 命令行或手工改了 profile 之后，插件页需要点一下刷新。
- 无 HMR 的 profile 中，运行中的插件无法卸载。此时会直接在原插件上覆盖安装（与 DSH 官方「更新」一致），并提示需要重启。

### 开发

没有构建步骤。

- **host 半边**：cordis ESM `index.mjs` + `lib/*.mjs`，只用 Node 内置模块。
  - `sources`：spec 解析
  - `git`：lockfile 与 `ls-remote`
  - `inventory`：总览、导入导出、诊断
  - `store`：任务和历史文件
  - `jobs`：任务队列
  - `api`：HTTP 接口
- **浏览器半边**：`lib/client.js` 是手写的 `window.__ModuleLoader__.load({ id, factory })` 模块，只依赖 `react`。DSH 自带的 Button / Modal / Tag 存在时借用，否则用自带的简单样式。

```bash
npm test   # node --test：来源解析、lockfile / ls-remote、清单与导入计划、日志、任务队列（假的插件管理服务）、HTTP 接口、bundle 加载约定、slot 注册、轮询、渲染
```

本地联调可以用 `link:` 装进一个隔离的 `DSH_HOME`，开启 HMR 后改文件会自动热重载：

```bash
dsh plugin --profile web add link:/path/to/dsh-plugin-manager
```

### 许可

MIT

---

## English

A manager for the third-party plugins of DeepSeek Harness (DSH). It adds a **Manage** tab to DSH's Plugins page for the plugins you installed yourself: where each came from, which commit is locked, whether the repository has moved on. From there you can batch-update, switch branches or tags, roll back, export / import the plugin list, and diagnose problems. Every plugin page also gets an **Update** button.

Every change goes through DSH's own plugin manager service: the same `removeBundle` / `installBundle` behind the page's Uninstall and Install. This plugin only orders the calls, records each step, and tells you what state a plugin was left in when something fails.

Works with DSH `>=0.2.1-0 <0.3.0-0` (tested on the desktop 0.2.1-rc.5 runtime with an HMR profile).

### The Manage tab

Plugins → **Manage**.

- **Overview**: every plugin you installed in this profile (DSH's own and official plugins are not listed), with its version, kind of source (GitHub / git / local / tarball / npm), install spec, locked commit and enabled state.
- **Check for updates**: `git ls-remote` for GitHub and other git sources compares the branch's latest commit (the default branch when none is given) with the one locked in `pnpm-lock.yaml`.
  - A plugin that is behind shows *New commits* and `155b39f → 62fbe58`.
  - A pinned one shows *Pinned to …*.
  - Results are cached for 10 minutes; the button always checks again.
- **Update all / Update selected**: uninstall and reinstall from the original source, one plugin at a time, each keeping its enabled state. dsh-plugin-manager itself always goes last.
- **Versions…**:
  - For git sources: follow the default branch, any branch, or any tag.
  - *Roll back to before an update*: every update or switch first records the plugin's commit, version and spec.
  - Or enter any custom spec.
  - A tag or commit pins the plugin, and *Check for updates* stops reporting it; pick a branch to follow it again.
- **Export list**: JSON with each plugin's name, source, enabled state, version and commit. Copy or download it.
- **Import list**: paste the JSON or choose the file. You get a plan before anything runs:
  - not installed → install (preselected);
  - installed from the same source → skip;
  - installed from another source → *Replace with this source* (opt-in);
  - local paths that do not exist here are flagged and left unselected.
  - Imported plugins get the enabled state from the list.
- **Recent jobs**: the last 10 jobs and how they ended.
- **Diagnostics and cleanup**:
  - plugins that failed to load or lost their files, with Uninstall;
  - profile dependencies that are no plugin, with the `dsh plugin --profile <name> remove <package>` command (DSH's plugin manager service cannot remove those);
  - the pnpm logs, which you can view, and deleting logs older than 30 days.

### Plugin pages

- **Update** (`plugins.detail.actions`) on a third-party plugin installed by this profile with a recorded source, dsh-plugin-manager included. It asks first, then runs the same job as the Manage tab.
- **New commits** (`plugins.detail.badge`) when a GitHub / git source has moved on; hover for both commits.

### Progress and failures

Jobs run in the host half and are written to `.dsh-plugin-manager/` in the profile directory, so:
- a page reload loses nothing;
- the plugin's page disappears while it is uninstalled, but the bottom-right panel (`shell.overlay`) stays.

The panel shows both steps (uninstall, install), the pnpm output, and the reason for a failure with the line that matters (`[ENOENT] …`, `ERR_PNPM_…`).

- **Install fails after the uninstall**: the plugin is left uninstalled. The panel says so and offers *Retry install* (install only), plus *Restore the previous version* for a failed switch.
- **The uninstall itself fails**: nothing changed; *Retry* runs the whole job again.
- **DSH restarts mid-job**: the job is marked interrupted and can be retried.

### Updating itself

dsh-plugin-manager can update itself from the Manage tab or its own page. The uninstall stops its running instance, but the job keeps going on the plugin manager service it captured beforehand and finishes the reinstall. The new instance reads the outcome back from the job file, and the page reloads briefly.

In a batch it always goes last. If its own reinstall fails, the tool is gone from the Plugins page; reinstall it from a terminal:

```bash
dsh plugin --profile desktop add github:luyang950/dsh-plugin-manager
```

### Install

```bash
dsh plugin --profile desktop add github:luyang950/dsh-plugin-manager
```

(Use `web` for the web profile.) A profile with HMR (`patchReload: live`) picks it up immediately; otherwise restart DSH. You can also enter `github:luyang950/dsh-plugin-manager` under *Add plugin* on the Plugins page.

If the earlier `dsh-plugin-updater` is installed, the Manage tab says so and offers to uninstall it. It does the same job, and having both means two Update buttons.

### Known limitations

- When the install fails after the uninstall, the plugin stays uninstalled until a retry succeeds or you reinstall it; the panel shows the original source.
- A reinstalled plugin moves to the end of the profile's bundle selection (DSH's behaviour), which can change layer precedence.
- When pnpm blocks dependency build scripts, this plugin does not approve them for you; install the same source from *Add plugin* and allow them there.
- Remote checks run git non-interactively: no password prompt, and ssh with `BatchMode=yes`. Private repositories need a credential helper or ssh-agent that answers on its own. `#semver:` ranges are not compared.
- npm-sourced plugins can be updated (reinstalled within their recorded range), but the registry is not checked for newer versions.
- After changing the profile with the `dsh plugin` CLI or by hand, press refresh on the Plugins page.
- Without HMR a running plugin cannot be uninstalled; the job installs over it (as DSH's own Update does) and reports that a restart is needed.

### Development

No build step.

- **Host half**: the cordis ESM `index.mjs` plus `lib/*.mjs`, Node built-ins only.
  - `sources`: spec parsing
  - `git`: lockfile and `ls-remote`
  - `inventory`: overview, import / export, diagnostics
  - `store`: job and history files
  - `jobs`: the queue
  - `api`: HTTP routes
- **Browser half**: `lib/client.js` is a hand-written `window.__ModuleLoader__.load({ id, factory })` module that depends only on `react` and borrows DSH's Button / Modal / Tag when present.

```bash
npm test   # node --test: source parsing, lockfile / ls-remote, list and import plan, logs, the job queue (fake plugin manager), HTTP routes, bundle loader contract, slots, polling, rendering
```

For local work, install it with `link:` into an isolated `DSH_HOME`; with HMR on, edits reload live:

```bash
dsh plugin --profile web add link:/path/to/dsh-plugin-manager
```

### License

MIT
