# agy-aio — Antigravity 三合一跨平台增强套件

**一个 CLI，三层增强，全部可逆。** 为 Antigravity 桌面端（Desktop / IDE）与命令行端（`agy`）提供上下文监控、界面汉化和免 TUN 透明代理。

> 本项目是非官方社区项目，与 Google 无隶属关系。所有对 Antigravity 安装目录的修改都会先备份，并支持一键还原。

## 三合一能力

| 组件 | 你能得到什么 | 实现方式 |
| --- | --- | --- |
| **agy-capsule** | 在输入框底栏显示上下文占用、多模型配额、缓存状态和生成速度；侧栏提供用量统计、模型设置与插件设置 | 作为 Antigravity 插件安装到 `~/.gemini/config/plugins/agy-capsule`，通过 CDP 连接渲染进程并注入 sidecar |
| **Antigravity-Chinese-Localization** | 菜单、设置、关于等原生字符串，以及异步加载的界面文案的深度汉化 | 原子替换 `app.asar` 完成静态汉化；渲染进程内用 `MutationObserver` + 词典完成动态汉化 |
| **免 TUN 透明代理** | 让 Antigravity 的 Agent、语言服务器和 `agy` CLI 流量走本地 SOCKS5 / HTTP 代理，不接管系统全局流量 | macOS 使用 `.dylib` + Mach-O launcher；Windows 使用 `version.dll` / `dbghelp.dll`；Linux 使用 `.so` + `LD_PRELOAD` |

### 1. agy-capsule（上下文 / 配额 / 缓存 / 生成速度胶囊）

上游：[Lumidarin/agy-capsule](https://github.com/Lumidarin/agy-capsule)（MIT）。

- 底栏胶囊实时显示上下文占用、缓存命中与过期状态、当前模型配额、最近请求耗时和生成速度。
- 悬停查看详情，点击固定面板；侧栏提供 Token 活动、按模型用量统计和完整设置项。
- 通过 CDP 附着到 Antigravity 渲染进程，不修改网络层，也不依赖代理是否开启。

### 2. Antigravity-Chinese-Localization（`app.asar` + DOM 深度汉化）

上游：[antigravity-cn-community/Antigravity-Chinese-Localization](https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization)（MIT）。

- 静态层：替换 Antigravity Desktop 的 `app.asar`，覆盖菜单、设置、关于等原生字符串。
- 动态层：渲染进程内的 `MutationObserver` 监听新出现的 DOM 文案，用词典即时翻译。
- 只触碰 `app.asar` 及其备份，不修改可执行文件；升级客户端后可一键还原再重新安装。

### 3. 免 TUN 透明代理

- **macOS**：基于 [xinayida/anti-proxy](https://github.com/xinayida/anti-proxy) 的 `getaddrinfo` / `connect` / `posix_spawn` Hook、FakeIP 与 Mach-O launcher，编译为 `libantigravity_proxy.dylib`。
- **Windows**：基于 [yuaotian/antigravity-proxy](https://github.com/yuaotian/antigravity-proxy) 的 DLL 搜索顺序劫持，Desktop / IDE 使用 `version.dll`，CLI 使用 `dbghelp.dll` + `antigravity_proxy.dll`。
- **Linux**：编译 `libantigravity_proxy.so`，通过 `LD_PRELOAD` 做 ELF 符号抢占，并用用户级 `.desktop` 覆盖追加 CDP 参数。

代理只接管目标进程及其子进程；回环地址、局域网和 Unix Socket 默认直连。它不创建 TUN 虚拟网卡，也不修改系统全局代理。

## 平台支持矩阵

| 能力 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 支持级别 | 优先支持 | 完整支持 | 尽力支持 |
| Antigravity Desktop / IDE | 支持 | 支持 | 支持 |
| Antigravity CLI（`agy`） | 支持 | 支持 | 支持 |
| 胶囊与 CDP 入口 | 原生注入（`--cdp-mode native`）或 `Antigravity-CDP.app` | 带调试参数的快捷方式 | 用户级 `.desktop` 覆盖 |
| 汉化 | 支持（Desktop） | 支持（Desktop） | 支持（Desktop） |
| 免 TUN 代理 | `.dylib` + Mach-O launcher | DLL 搜索顺序隔离 | `.so` + `LD_PRELOAD` |
| 安装写入权限 | `/Applications` 受 TCC 保护 | `Program Files` 需管理员 | 默认用户级；`/opt` 等目录可能需要 `sudo` |
| 主要限制 | 代码签名逐页校验，改写后必须重签 | Desktop/IDE 与 CLI 的 DLL 不可混装 | setuid、Snap、Flatpak 会忽略预加载 |

**优先支持策略：** macOS 是主要开发与验证平台，完整链路（包括停止进程、原子替换、统一重签的时序）优先修复；Windows 提供完整的一键安装、DLL 隔离与 Release 资产校验；Linux 采用用户级 `LD_PRELOAD` + `.desktop` 方案，受发行版沙箱和 setuid 机制影响，属于尽力支持。

## 前置要求

- **Node.js >= 18.18.0**。入口脚本会自动在 `PATH`、Homebrew、nvm、fnm、asdf、Volta 中查找可用版本。
- **macOS**：需要 Xcode Command Line Tools，用于本地编译 `.dylib`：
  ```sh
  xcode-select --install
  ```
- **Linux**：需要 `make` 和 C++ 工具链（`g++`，Debian/Ubuntu 可安装 `build-essential`），用于本地编译 `.so`。
- **本地代理软件**：Clash、Mihomo、Surge、V2Ray 等，并开放 SOCKS5 或 HTTP 端口。默认按 `127.0.0.1:7890` 配置。
- **Antigravity**：Desktop / IDE / CLI 至少启动过一次，便于自动发现安装位置。

## 快速开始

下载或克隆本仓库，进入项目根目录：

```sh
cd agy-aio
```

`install.sh` / `install.bat` 只负责检查 Node.js 版本，然后调用 `bin/agy-aio.mjs install`；`uninstall.sh` / `uninstall.bat` 同理调用 `uninstall`，参数会原样传递。

### macOS

```sh
chmod +x install.sh
./install.sh
```

没有可执行权限时也可以直接运行：

```sh
sh install.sh
```

> 写入 `/Applications` 时，macOS 可能要求「App 管理」授权。可以在「系统设置 → 隐私与安全性 → App 管理」中允许当前终端，或使用 `sudo ./install.sh`。如果使用 `sudo` 后提示找不到 Node.js（常见于 nvm / fnm 用户），请改用「App 管理」授权，或把 Antigravity 移到 `~/Applications` 后再安装。CLI 在 `sudo` 下会通过 `SUDO_USER` 尽量把文件属主还原为你的账户。

### Windows

在资源管理器中双击 `install.bat`，或在命令提示符中运行：

```bat
install.bat
```

如果 Antigravity 安装在 `Program Files` 等受保护目录，请右键选择「以管理员身份运行」。

`install.bat` 只在**双击运行**（即没有传入任何参数）时暂停；通过命令行传入参数时不会暂停，方便脚本和自动化调用：

```bat
install.bat --only capsule,localization
```

### Linux

```sh
chmod +x install.sh
./install.sh
```

如果 Antigravity 位于 `/opt/Antigravity` 等当前用户不可写的目录，代理层的文件替换可能需要 `sudo`：

```sh
sudo ./install.sh
```

安装完成后请用普通用户身份启动图形界面，不要用 `sudo` 运行 Antigravity 本身。

### 选择部分组件

默认安装全部三层。使用 `--only` 只安装指定组件，多个组件用逗号分隔：

| `--only` 取值 | 安装内容 |
| --- | --- |
| `capsule` | agy-capsule 插件与 CDP 启动入口 |
| `localization` | `app.asar` 静态汉化 + DOM 动态汉化 |
| `proxy` | 免 TUN 透明代理 |

```sh
./install.sh --only capsule
./install.sh --only localization,proxy
./install.sh --only proxy --proxy-port 7890
./install.sh --dry-run
```

`--dry-run` 只打印将要执行的操作，不写入任何文件。

### 启用插件与使用 CDP 启动入口

1. 运行 `agy-aio status`，确认插件、汉化和代理的状态。
2. 使用带 CDP 参数的入口启动 Antigravity：
   - macOS：推荐 `--cdp-mode native`，直接点击原版图标即可；选择 `wrapper` 时使用 `Antigravity-CDP.app`（位于 `/Applications` 或 `~/Applications`）。
   - Windows：安装时写入 `--remote-debugging-port=0` 的开始菜单或桌面快捷方式。
   - Linux：`~/.local/share/applications/` 下的 Antigravity `.desktop` 入口。
   - 任意平台也可以直接运行 `agy-aio launch`。
3. 在 Antigravity 中打开 `… → Extensions → agy-capsule` 显示侧栏，底栏胶囊会在输入框下方出现。
4. 汉化与代理在完全退出并重新启动 Antigravity 后生效。

> 胶囊依赖 CDP。如果从普通快捷方式启动，侧栏统计通常仍可用，但底栏胶囊可能不显示。完全退出 Antigravity，再从 CDP 入口重新打开即可。

#### macOS 免壳启动模式（`--cdp-mode native`，推荐）

macOS 不再需要单独的启动器图标：`native` 模式会把 CDP 启动参数写入原版 `Antigravity.app` 的可执行文件，直接点击原版图标即可启动并显示底栏胶囊。

```sh
./install.sh --only capsule --cdp-mode native
agy-aio install --only capsule --cdp-mode native
agy-aio restore --cdp-mode native
```

- `native`：免壳原版 App（推荐）。直接点原版图标，无需额外图标。
- `wrapper`：保留独立的 `Antigravity-CDP.app` 启动器（默认的回退方案）。
- `none`：只安装侧栏插件，不配置 CDP 入口。

原生注入会修改应用可执行文件：首次写入前会备份为 `.orig`，完成后自动执行 ad-hoc 重签。切换回 `wrapper`、选择 `none` 或执行 `agy-aio uninstall --undo-cdp` 时，会从备份还原原版可执行文件。Web 控制面板中的「CDP 启动模式」下拉框等同于该参数。

### 可视化配置面板（`agy-aio ui` / `./ui.sh` / `ui.bat`）

不想记命令行参数时，可以启动本地 Web 控制面板：

```sh
./ui.sh                 # macOS / Linux
agy-aio ui              # 已安装全局命令时
node bin/agy-aio.mjs ui
```

Windows 可双击 `ui.bat`，或在命令提示符中运行 `ui.bat`。面板只监听本机，启动后默认自动打开浏览器；加 `--no-open` 不自动打开，`--port <port>` 指定端口（默认自动选择空闲端口）。

面板采用系统自适应的浅色 / 深色主题（也可在右上角手动切换「跟随系统 / 浅色 / 深色」），在面板里可以：

- 只改代理协议、地址和端口（默认 `7890`，Clash Verge 常见 `7897`），保存后自动同步到已安装的 Antigravity 目录。
- 高级网络参数与分流 / 直连规则默认折叠在「高级代理与分流设置」中，日常只需改端口，无需展开。
- 选择胶囊的 CDP 启动模式（免壳原版 App / 独立启动器 / 关闭底栏胶囊），随一键安装或恢复一起生效。
- 测试代理连通性，查看胶囊、汉化和代理各层状态。
- 检查汉化包与当前客户端版本是否匹配，并按需触发一键维护。

## 全部 CLI 命令速查

未创建全局命令时，把下表中的 `agy-aio` 替换为 `node bin/agy-aio.mjs`。也可以按照 `install.sh` 结束时的提示，把入口链接到 `~/.local/bin/agy-aio`。

| 命令 | 作用 | 常用示例 |
| --- | --- | --- |
| `agy-aio status` | 汇总胶囊、汉化、代理三层状态，以及代理端口、CDP 端口和版本 | `agy-aio status --json` |
| `agy-aio doctor` | `status` 的别名，用于快速体检（哈希漂移、签名有效性、DLL 隔离、`LD_PRELOAD` 可达性、出口连通性） | `agy-aio doctor --json` |
| `agy-aio install` | 安装指定组件，默认安装全部 | `agy-aio install --only capsule,localization,proxy --proxy-port 7890` / `agy-aio install --only capsule --cdp-mode native` |
| `agy-aio uninstall` | 从 `app.asar.bak` 与 `.orig` 备份还原官方文件、移除 `agy-capsule`，同时保留 `app.asar.bak` 与 `settings.json` | `agy-aio uninstall --only proxy` |
| `agy-aio restore` | Antigravity 客户端更新后一键恢复汉化、代理与 CDP 启动器 | `agy-aio restore --yes` |
| `agy-aio proxy config` | 查看或修改本地代理地址、端口和类型 | `agy-aio proxy config --host 127.0.0.1 --port 7890 --type socks5` |
| `agy-aio proxy test` | 测试本地代理到 Google 端点的 TCP / 握手连通性 | `agy-aio proxy test` |
| `agy-aio proxy build` | 编译 macOS / Linux 的 `.dylib` 或 `.so` | `agy-aio proxy build` |
| `agy-aio proxy run` | 在代理注入环境中单次运行命令 | `agy-aio proxy run -- agy --help` |
| `agy-aio launch` | 以 CDP 调试参数启动 Antigravity，不落盘修改 | `agy-aio launch` |
| `agy-aio update` | 检查上游 Release 版本；加 `--apply` 时拉取并应用更新 | `agy-aio update`（仅检查）/ `agy-aio update --apply`（拉取并应用） |
| `agy-aio ui` | 启动本地 Web 控制面板，可视化修改代理、分流规则并执行一键维护 | `agy-aio ui --port 8787 --no-open` |

涉及写入的命令通常支持 `--dry-run` 预览。远程下载的汉化包和 Windows DLL 会强制校验 SHA256，校验失败即拒绝安装。

## 客户端更新后一键恢复

Antigravity 自动更新会覆盖 `app.asar`，也可能替换被代理注入的语言服务器或 DLL。更新后如果界面、胶囊或网络异常，先查看状态，再一键恢复：

```sh
agy-aio status
agy-aio restore
```

Windows 用户同样运行：

```bat
node bin\agy-aio.mjs restore
```

或重新执行 `install.bat`。

`restore` 会在关闭 Antigravity 后重新应用各层补丁：

- **汉化**：重新应用 `app.asar` 汉化，自动拉取与当前客户端匹配的 Release，失败时回退到本地重新构建。
- **代理**：重新注入代理二进制，保留已有的 `config.json`（不强制覆盖）。
- **CDP 启动器**：确保 `agy-capsule` 所需的 CDP 启动入口就绪；默认沿用当前检测到的模式，也可以用 `agy-aio restore --cdp-mode native` 重新注入免壳原版 App。
- **macOS 重签**：写入完成后对受影响的 `.app` 统一执行 ad-hoc 重签。

`restore` 会在客户端更新后用新的官方文件刷新汉化备份；`uninstall` 在备份版本与当前客户端不匹配时会拒绝回写以避免白屏。遇到这种情况，请先安装与备份版本匹配的官方客户端，再恢复或重新安装。

## 仓库维护：同步上游代码

胶囊、汉化和代理能力来自上游仓库，维护者可以用 `scripts/sync-upstream.mjs` 检查并同步：

```sh
node scripts/sync-upstream.mjs            # 检查上游是否有更新
node scripts/sync-upstream.mjs --check    # 仅检查，不写入
node scripts/sync-upstream.mjs --apply    # 拉取并应用更新
node scripts/sync-upstream.mjs --only capsule,localization
```

`--only` 指定要处理的上游模块（逗号分隔），默认处理全部模块。`--apply` 会修改 `modules/` 下的上游代码并更新锁定的 commit，执行前请确保工作区干净并已备份未提交的改动。

## 常见问题

### Node.js 找不到或版本过低

先检查：

```sh
node -v
```

需要 `18.18.0` 或更高版本。macOS 可以运行 `brew install node`，Windows 请从 <https://nodejs.org/> 下载安装包。安装后重新打开终端，让入口脚本重新读取 `PATH`。脚本也会自动搜索 nvm、fnm、asdf 和 Volta 的安装目录。

### macOS 提示 `Operation not permitted`

这是 macOS 对 `/Applications` 的 TCC / App 管理保护。可以：

- 在「系统设置 → 隐私与安全性 → App 管理」中授权当前终端，然后重新安装。
- 使用 `sudo ./install.sh`，CLI 会通过 `SUDO_USER` 尽量把属主还原为你的账户。
- 把 Antigravity 移到 `~/Applications` 后再安装，用户目录不受同样的系统级限制。

### 胶囊不显示，或侧栏没有 agy-capsule

确认三件事：

1. 插件目录存在：`~/.gemini/config/plugins/agy-capsule`。
2. Antigravity 是通过 CDP 入口启动的，而不是普通快捷方式。
3. 完全退出 Antigravity 后重新打开，而不是只关闭窗口。

仍然不显示时运行 `agy-aio status` 和 `agy-aio doctor`，检查 CDP 状态与插件版本。

### 汉化后白屏，或客户端更新后界面异常

先执行 `agy-aio restore`。如果提示备份版本与当前客户端不匹配，说明旧备份不能安全回写；请安装匹配版本的官方客户端后再恢复，或直接重新安装官方客户端后重新执行 `install.sh` / `install.bat`。

如果确认当前汉化包与客户端兼容（例如仅小版本差异），可以在 `install` / `restore` 时加 `--allow-version-mismatch` 跳过版本校验，例如 `agy-aio install --only localization --allow-version-mismatch`。不确定兼容性时不要加这个参数，版本错配是白屏的常见原因。

### Windows 启动崩溃或代理静默失效

检查 DLL 是否混装：

- Desktop / IDE 目录只应该有 `version.dll`。
- CLI 目录只应该有 `dbghelp.dll` 和 `antigravity_proxy.dll`。
- 不要把 `dbghelp.dll` 放进 Desktop / IDE，也不要把 `version.dll` 放进 CLI 目录。

运行 `agy-aio doctor` 逐目录检查，必要时执行 `agy-aio restore` 后重新安装。

### Linux 代理不生效

`LD_PRELOAD` 会被以下场景忽略：

- setuid / setgid 程序。
- Snap、Flatpak 等沙箱应用。
- 以 `sudo` 启动的图形界面。

请使用非沙箱安装，或以普通用户身份通过 `.desktop` / `agy-aio launch` 启动。`agy-aio doctor` 会报告预加载库是否可达。

### 代理连通，但对话报 `User location is not supported`

这说明代理链路已经生效，但出口 IP 被 Google 服务端判定为不合规区域。请在代理软件中切换到住宅或原生 ISP 节点，而不是机房节点。`agy-aio proxy test` 只检查链路握手，不判断出口 IP 的地区合规性。

### 如何完全卸载

```sh
./uninstall.sh        # Windows: uninstall.bat
# 或直接调用 CLI，并一并移除 CDP 启动器
agy-aio uninstall --undo-cdp
```

`uninstall` 会直接从 `app.asar.bak` 与 `.orig` 备份把 `app.asar` 和代理二进制还原成官方文件，移除 `agy-capsule` 插件，同时保留 `app.asar.bak` 和 `agy-capsule/settings.json`（`--undo-cdp` 会一并移除 CDP 启动器）。`./uninstall.sh`（Windows 为 `uninstall.bat`）等同于 `agy-aio uninstall`，参数会原样传递。确认不再需要后，可以删除配置与缓存目录 `~/.agy-aio/`。

## 安全设计

### macOS：TCC 与统一 Ad-hoc 重签

macOS 会逐页校验代码签名。签名之后再修改文件内容，进程在缺页时可能收到 `SIGKILL (Code Signature Invalid)`。因此安装时序严格遵循：

1. 先停止 Antigravity Desktop / IDE 及其语言服务器子进程。
2. 首次安装时备份原文件到 `.orig` / `app.asar.bak`，记录哈希和权限。
3. 用同目录临时文件 + 原子 `rename` 替换目标文件，避免就地覆盖正在被 `mmap` 的文件。
4. 所有文件写入完成后，对整棵 `.app` 执行一次 `xattr -cr`，再执行一次统一重签：
   ```sh
   codesign --force --deep --sign - "/Applications/Antigravity.app"
   codesign --verify --deep --strict "/Applications/Antigravity.app"
   ```
5. 任一步失败按备份逆序回滚，保证应用回到可运行状态。

签名永远是最后一步，且必须对整个 bundle 一次完成。分次签名会因嵌套组件摘要变化而失效。

### Windows：严格 DLL 隔离

Windows 侧只有两个注入点，宿主加载器和 ABI 期望不同，混装会导致启动崩溃或代理静默失效。

| 目标 | 允许的注入文件 | 禁止出现 |
| --- | --- | --- |
| Antigravity Desktop / IDE | `version.dll` | `dbghelp.dll`、`antigravity_proxy.dll` |
| Antigravity CLI | `dbghelp.dll`、`antigravity_proxy.dll` | `version.dll` |

安装前会校验目标目录可写和同名文件来源；`doctor` 逐目录检查隔离规则与哈希；卸载和还原只删除清单中记录的注入文件，不触碰同目录的其他 DLL。Windows DLL 从上游 Release 下载后会强制校验 SHA256。

### Linux：`LD_PRELOAD` 与 `.desktop`

- 代理库和包装脚本位于用户级目录（具体路径以 `agy-aio status` 输出为准），安装时不需要 root 权限。
- 用户级 `.desktop` 覆盖位于 `~/.local/share/applications/`，保留原有的 Antigravity 可执行文件路径，并在 `Exec=` 中追加 `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`，供 `agy-capsule` 通过 CDP 连接。
- 代理注入不改写 `.desktop`，而是用原生 ELF 启动器 `anti-proxy-launcher` 替换 `language_server` 二进制，并在同目录放置 `libantigravity_proxy.so`，运行时通过 `LD_PRELOAD` 生效。
- 不写入 `/etc/ld.so.preload`，避免全局影响所有进程。
- `sudo`、setuid 程序和 Snap / Flatpak 沙箱会丢弃或忽略 `LD_PRELOAD`；这类场景改用 `agy-aio launch` 主动注入，或使用非沙箱安装。

### 通用安全设计

- **零 npm 依赖**：只使用 Node.js 内置模块和系统自带工具链。
- **可逆与幂等**：重复安装会校验后跳过，不重复备份；所有变更都有对应的 `uninstall` / `restore` 路径。
- **原子写入**：临时文件 + `rename`，避免写入中断留下半成品。
- **供应链校验**：远程汉化包和 Windows DLL 必须提供 SHA256；校验失败即删除并拒绝安装。
- **进程级代理**：只接管 Antigravity 及其子进程，不开启 TUN，不修改系统全局代理，回环和局域网默认直连。
- **失败即回滚**：任一步失败按备份清单逆序恢复，`restore` 是最终兜底。

## 数据与备份位置

| 内容 | 默认位置 |
| --- | --- |
| CLI 配置与缓存 | `~/.agy-aio/` |
| 胶囊插件 | `~/.gemini/config/plugins/agy-capsule/` |
| 胶囊个人设置 | `~/.gemini/config/agy-capsule/settings.json` |
| 汉化备份 | `app.asar.bak`，与 `app.asar` 同目录 |
| 代理原始文件备份 | `language_server*.orig`、原始 DLL 等，位于安装目标目录 |

Windows 上对应的用户目录为 `%USERPROFILE%`。备份文件是 `restore` 的依据，确认不再需要还原前请不要手动删除。

## 开源致谢

`agy-aio` 只做编排，核心能力来自以下上游项目。完整版权声明、锁定的上游 commit 与许可证全文见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)；架构、时序与安全约束见 [`PLAN.md`](PLAN.md)。

| 项目 | 用途 | 许可证 |
| --- | --- | --- |
| [Lumidarin/agy-capsule](https://github.com/Lumidarin/agy-capsule) | 上下文、配额、缓存、生成速度胶囊与 CDP sidecar | MIT |
| [antigravity-cn-community/Antigravity-Chinese-Localization](https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization) | `app.asar` 汉化包与 DOM 翻译引擎 | MIT |
| [xinayida/anti-proxy](https://github.com/xinayida/anti-proxy) | POSIX Socket Hook、FakeIP、Mach-O launcher | 上游未声明许可证；本项目仅本地编译，不分发二进制 |
| [yuaotian/antigravity-proxy](https://github.com/yuaotian/antigravity-proxy) | Windows `version.dll` / `dbghelp.dll` / `antigravity_proxy.dll` | BSD-2-Clause |

POSIX 代理内嵌的 `fishhook` 使用 BSD-3-Clause，`nlohmann/json` 使用 MIT。感谢所有上游作者和贡献者。

## 商标声明

Antigravity、Google Cloud Code 及相关标识是 Google LLC 的商标。`agy-aio` 是独立的社区项目，与 Google 无隶属、认可或赞助关系。其他产品名称是其各自所有者的商标或注册商标。
