# dsh-plugin-updater

[中文](#中文) · [English](#english)

---

## 中文

给 DeepSeek Harness（DSH）插件页里的**第三方插件**加一个「更新」按钮：点一下，就按它原来的安装来源（GitHub / 其他 git 仓库 / 本地路径 / tgz 压缩包）重新安装最新代码，并保持原来的启用状态。

DSH 自己只给「按需安装的官方插件」提供更新；其他插件的提示是「先卸载再安装新版」。这个插件把这两步替你做完——走的正是 DSH 官方「更新」的同一条路：`pluginManager.removeBundle(名字)`，然后 `pluginManager.installBundle(原来的 spec, { enabled: 原来的状态 })`。

适配 DSH `>=0.2.1-0 <0.3.0-0`（已在桌面版 0.2.1-rc.5 运行时、开启 HMR 的 profile 上实测）。

### 它加了什么

- **「更新」按钮**（插件详情页页头，`plugins.detail.actions`）。只出现在满足下面全部条件的组合包上：
  - 由当前 profile 安装（不是随 DSH 安装附带的，也不是官方 / 实验性插件）；
  - 记录的来源（详情页里的「代码来源」）是 GitHub、其他 git 地址、本地路径或 tgz；从 npm 注册表装的包不显示；
  - 不是 dsh-plugin-updater 自己（卸载自己时执行更新的代码也会被卸掉）。
- **确认框**：写明安装来源、会保持启用还是停用，以及失败时的后果。
- **进度面板**（右下角浮层，`shell.overlay`）：卸载 → 重新安装两个步骤的状态、pnpm 输出、失败原因（会摘出 `[ENOENT] …` / `ERR_PNPM_…` 这样的关键行）。更新成功后显示版本和提交变化，例如 `提交 155b39f → 62fbe58`。卸载后详情页会暂时消失，面板不受影响；装回来后页面自动回到该插件。
- **失败后重试**：卸载之后如果安装失败，插件会处于未安装状态，面板会明确提示并给出「重试安装」（只重做安装这一步）；卸载本身失败时插件保持原样，「重试」会重做整个流程。
- **「有新提交」标签**（标题旁，`plugins.detail.badge`）：GitHub 来源的插件，如果仓库上对应的分支 / tag（没写就是 HEAD）已经不是 `pnpm-lock.yaml` 里锁定的那个提交，就显示这个标签，悬停可看两个提交号。这一步由插件的 host 半边执行 `git ls-remote`，结果缓存 10 分钟。

### 安装

```bash
dsh plugin --profile desktop add github:luyang950/dsh-plugin-updater
```

（Web 版把 `desktop` 换成 `web`。）开启了 HMR（`patchReload: live`）的 profile 会立刻生效，否则重启 DSH。也可以在 DSH 插件页「添加插件」里填 `github:luyang950/dsh-plugin-updater`。

### 用法

插件页 → 点开一个从 GitHub / git / 本地 / tgz 装的插件 → 页头「更新」→ 确认。

### 已知限制

- **不能更新自己。** 要更新 dsh-plugin-updater，请在插件页卸载后重新安装。
- 卸载后安装失败时，插件保持未安装状态，直到「重试安装」成功或你手动重装（面板里会给出原来的来源）。刷新页面会丢掉面板，但插件页「添加插件」里用同一来源安装效果相同。
- 重装后，插件在 profile 的组合包选择列表里会排到末尾（DSH 的行为），配置层优先级可能随之变化。
- pnpm 拦下依赖的构建脚本时，本插件不代替你批准；请在插件页「添加插件」里用同一来源安装并允许这些脚本。
- 「有新提交」只检查 GitHub 来源，且用 `https://github.com/<owner>/<repo>.git` 访问；私有仓库需要本机 git 的凭据助手能直接给出凭据（不会弹出输入提示）。`#semver:` 范围和固定提交号不做比较。
- 用 `dsh plugin` 命令行改了插件之后，插件页需要点一下刷新。

### 开发

没有构建步骤：host 半边是 cordis ESM `index.mjs`（只用 Node 内置模块），浏览器半边 `lib/client.js` 是手写的 `window.__ModuleLoader__.load({ id, factory })` 模块，只依赖 `react`，DSH 自带的 Button / Modal / Tag 存在时借用，否则用自带的简单样式。

```bash
npm test   # node --test：loader 契约、slot 注册、来源判断、更新流程调用顺序、lockfile 与 ls-remote 解析、HTTP 接口
```

本地联调可以用 `link:` 装进一个隔离的 `DSH_HOME`：

```bash
dsh plugin --profile web add link:/path/to/dsh-plugin-updater
```

### 许可

MIT

---

## English

Adds an **Update** button to the page of a **third-party plugin** on DeepSeek Harness's (DSH) Plugins page. One click reinstalls the latest code from wherever the plugin came from — GitHub, another git host, a local path or a tarball — and keeps it enabled (or disabled) as it was.

DSH itself only offers Update for on-demand official plugins; for everything else it says "uninstall, then install the new version". This plugin does both steps for you, the same way DSH's own Update does: `pluginManager.removeBundle(name)`, then `pluginManager.installBundle(<original spec>, { enabled: <as before> })`.

Works with DSH `>=0.2.1-0 <0.3.0-0` (tested on the desktop 0.2.1-rc.5 runtime with an HMR profile).

### What it adds

- **Update button** in the plugin page header (`plugins.detail.actions`), only on a bundle that is:
  - installed by the current profile (not shipped with DSH, not an official / experimental plugin);
  - recorded with a GitHub, git, local-path or tarball source (the page's *Code source*); registry packages get no button;
  - not dsh-plugin-updater itself (uninstalling itself would unload the code doing the update).
- **A confirmation** naming the source, whether the plugin stays enabled, and what a failure means.
- **A progress panel** (bottom-right overlay, `shell.overlay`): the uninstall and reinstall steps, the pnpm output, and the failure reason with the line that matters (`[ENOENT] …`, `ERR_PNPM_…`). A success shows the version and the commit change, e.g. `Commit 155b39f → 62fbe58`. The plugin's page disappears while it is uninstalled; the panel does not, and the page comes back once it is reinstalled.
- **Retry**: if the install fails after the uninstall, the plugin is left uninstalled — the panel says so and offers *Retry install* (install only). If the uninstall itself fails, nothing changed and *Retry* runs the whole update again.
- **New commits** tag next to the title (`plugins.detail.badge`) for GitHub-sourced plugins whose branch / tag (HEAD when none) has moved past the commit locked in `pnpm-lock.yaml`; hover for both commits. The host half answers this with `git ls-remote` and caches it for 10 minutes.

### Install

```bash
dsh plugin --profile desktop add github:luyang950/dsh-plugin-updater
```

(Use `web` for the web profile.) A profile with HMR (`patchReload: live`) picks it up immediately; otherwise restart DSH. You can also enter `github:luyang950/dsh-plugin-updater` under *Add plugin* on the Plugins page.

### Use

Plugins → open a plugin installed from GitHub / git / a path / a tarball → **Update** in the header → confirm.

### Known limitations

- **It cannot update itself.** Uninstall and reinstall dsh-plugin-updater from the Plugins page instead.
- When the install fails after the uninstall, the plugin stays uninstalled until *Retry install* succeeds or you reinstall it (the panel shows the original source). Reloading the page drops the panel; installing the same source from *Add plugin* does the same thing.
- After reinstalling, the plugin moves to the end of the profile's bundle selection (DSH's behaviour), which can change layer precedence.
- When pnpm blocks dependency build scripts, this plugin does not approve them for you; install the same source from *Add plugin* and allow them there.
- *New commits* checks GitHub sources only, over `https://github.com/<owner>/<repo>.git`; private repositories need a git credential helper that answers without prompting. `#semver:` ranges and pinned commits are not compared.
- After changing plugins with the `dsh plugin` CLI, press refresh on the Plugins page.

### Development

No build step: the host half is the cordis ESM `index.mjs` (Node built-ins only); the browser half `lib/client.js` is a hand-written `window.__ModuleLoader__.load({ id, factory })` module that depends only on `react` and borrows DSH's Button / Modal / Tag when present.

```bash
npm test   # node --test: loader contract, slot registration, source rules, update call order, lockfile / ls-remote parsing, HTTP route
```

For local work, install it with `link:` into an isolated `DSH_HOME`:

```bash
dsh plugin --profile web add link:/path/to/dsh-plugin-updater
```

### License

MIT
