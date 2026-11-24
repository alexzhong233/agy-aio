# agy-aio 架构设计（PLAN）

> 状态：v1.0.0 设计基线
> 范围：macOS / Windows / Linux 上的 Antigravity 桌面端（Desktop / IDE）与命令行端（CLI）
> 原则：**零运行时依赖、可逆、幂等、失败即回滚**

---

## 1. 目标与非目标

### 目标

1. 用**一个 CLI** 完成三件事：插件能力（上下文/额度/指标胶囊）、界面汉化、免 TUN 透明代理。
2. 三层能力**彼此正交**：可任意组合安装，单独卸载任何一层都不影响其余两层。
3. 所有对 Antigravity 安装目录的修改都可**完整还原**（备份清单 + 校验和）。
4. 不引入任何外部 npm 依赖；仅使用 Node.js 内置模块与系统自带工具链。

### 非目标

- 不修改 Antigravity 的账户体系、不绕过其服务端区域策略（代理只负责链路，出口 IP 合规性由用户自行保证）。
- 不提供 TUN / 虚拟网卡 / 系统级全局代理；仅对目标进程做**进程级**流量接管。
- 不重新分发无法确认许可的上游二进制（见 `THIRD-PARTY-NOTICES.md` 第 3 节）。

---

## 2. 三层正交架构

三层分别作用于**不同的宿主资源**，互不依赖：

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          agy-aio CLI  (bin/agy-aio.mjs)                  │
│   status/doctor · install · uninstall · restore · proxy · launch · update │
│                    ── 统一编排 / 备份清单 / 事务回滚 ──                    │
└───────────────┬────────────────────┬─────────────────────┬───────────────┘
                │                    │                     │
    ┌───────────▼──────────┐ ┌───────▼───────────┐ ┌───────▼──────────────┐
    │ L1  插件层            │ │ L2  汉化层         │ │ L3  代理层            │
    │ agy-capsule + CDP    │ │ app.asar + DOM    │ │ POSIX / Windows      │
    ├──────────────────────┤ ├───────────────────┤ ├──────────────────────┤
    │ 宿主资源：            │ │ 宿主资源：         │ │ 宿主资源：             │
    │  用户插件目录          │ │  app.asar 文件     │ │  进程加载器 / DLL 目录 │
    │  + 渲染进程 (CDP)     │ │  + 渲染进程 DOM    │ │  / LD_PRELOAD 环境     │
    ├──────────────────────┤ ├───────────────────┤ ├──────────────────────┤
    │ 生效方式：            │ │ 生效方式：         │ │ 生效方式：             │
    │  sidecar 进程 +       │ │  asar 原子替换 +   │ │  dylib 注入 / DLL 劫持 │
    │  Runtime.evaluate     │ │  MutationObserver │ │  / 符号抢占            │
    ├──────────────────────┤ ├───────────────────┤ ├──────────────────────┤
    │ 失败影响：仅 UI 面板   │ │ 失败影响：界面语言  │ │ 失败影响：网络不通      │
    │ 可独立关闭             │ │ 可一键 restore     │ │ 可 proxy --off         │
    └──────────────────────┘ └───────────────────┘ └──────────────────────┘
              │                    │                     │
              └────────────┬───────┴─────────────────────┘
                           ▼
              ┌────────────────────────────────┐
              │  Antigravity Desktop / IDE / CLI │
              │  (Electron 渲染进程 + 原生 sidecar)│
              └────────────────────────────────┘
```

### L1 插件层（`modules/capsule/`）

- 上游：`Lumidarin/agy-capsule`，以 sidecar 形式运行（`sidecars/agy_capsule/server.mjs`）。
- 通过 **CDP** 连接到 Antigravity 渲染进程，注入侧边栏 UI、读取会话数据库、统计 token/额度。
- 与网络层零耦合：即使代理完全关闭，插件仍可工作（仅远端版本检查会失败并优雅降级）。

### L2 汉化层（`modules/localization/`）

- 上游：`antigravity-cn-community/Antigravity-Chinese-Localization`。
- 两级汉化：**静态**（替换 `app.asar`，覆盖菜单/关于/设置等原生字符串）+ **动态**（渲染进程内 `MutationObserver` + 词典翻译异步加载的文案）。
- 只触碰 `app.asar` 单文件与其备份，不修改可执行文件。

### L3 代理层（`modules/proxy-posix/`、Windows DLL）

- 上游：`xinayida/anti-proxy`（POSIX）、`yuaotian/antigravity-proxy`（Windows）。
- 核心机制：拦截 `getaddrinfo` 返回 FakeIP（`198.18.0.0/15`）→ 拦截 `connect()` 还原真实域名 → 与本地 SOCKS5 / HTTP CONNECT 代理建隧道。
- 只接管**目标进程及其子进程**，回环、局域网、Unix Socket 默认直连。

### 正交性约束

| 组合 | 是否允许 | 说明 |
| --- | --- | --- |
| L1 + L2 | ✅ | 常见组合，互不影响 |
| L1 + L3 | ✅ | 插件流量经代理，回环控制通道自动旁路 |
| L2 + L3 | ✅ | 互相独立 |
| L1 + L2 + L3 | ✅ | 全量安装，推荐路径 |
| 同层重复安装 | ✅（幂等） | 校验哈希后跳过，不重复备份 |

---

## 3. 跨平台实现矩阵

| 维度 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 目标进程 | `Antigravity`、`Antigravity IDE`、`language_server_*`、`agy` | 同名 `.exe` | 同名 ELF + `.desktop` 启动项 |
| 代理注入 | `DYLD_INSERT_LIBRARIES` + **Mach-O launcher**（绕过 SIP 对 shell wrapper 的 `DYLD_*` 剥离） | DLL 搜索顺序劫持（`version.dll` / `dbghelp.dll`） | `LD_PRELOAD` + ELF 符号抢占 |
| 符号劫持 | `fishhook` 重绑定 Mach-O 懒/非懒符号表 | IAT Hook / Detour（上游 DLL 内实现） | `dlsym(RTLD_NEXT, ...)` + 定义同名符号 |
| FakeIP | `libantigravity_proxy.dylib` 内环形地址池 | `antigravity_proxy.dll` | `libantigravity_proxy.so` |
| 安装位 | `Contents/MacOS/`（dylib + launcher 同名替换） | 程序所在目录（DLL 同级） | 用户目录 `~/.local/share/agy-aio/` + `.desktop` |
| 签名要求 | **必须** ad-hoc 重签（`codesign --force --deep --sign -`） | 无强制签名，但需保留原 PE 校验和语义 | 无签名机制 |
| 权限 | 写 `/Applications` 需 App Management 授权或 `sudo` | 写 `Program Files` 需管理员 | 用户级安装，无需 root |
| 还原方式 | `restore` 用 `.orig` 备份原子回写 | `restore` 删除注入 DLL、恢复原文件 | 删除 `.desktop` 覆盖项与预加载配置 |
| 关键风险 | 运行中改写导致内核缺页校验失败 → `SIGKILL` | DLL 混装导致加载顺序冲突/崩溃 | `LD_PRELOAD` 被 setuid / snap 沙箱忽略 |

---

## 4. macOS 补丁与重签时序（强约束）

macOS 的代码签名是**逐页校验**的：签名之后再改动文件内容，进程在缺页时会收到
`SIGKILL (Code Signature Invalid)`。因此写入与签名必须严格分阶段，且**签名永远是最后一步**。

```
① 停止目标进程
   osascript 优雅退出 Desktop/IDE → 轮询 → 兜底 SIGTERM → 确认 language_server 子进程全部退出
        │  （必须确认，否则旧进程持有失效页，重启后持续 ECONNREFUSED）
        ▼
② 首次备份（仅一次，幂等）
   cp -p 目标 → 目标.orig ；记录 sha256 + 权限 + 属主 到 backup manifest
   （.orig 只在此阶段做一次 ad-hoc 签名，之后不再触碰）
        │
        ▼
③ 应用汉化（L2）
   同目录写 app.asar.tmp → fsync → rename 原子替换 app.asar
        │
        ▼
④ 应用代理（L3）
   同目录写 launcher.tmp / dylib.tmp → chmod → rename 原子替换
   （禁止就地覆盖正在被 mmap 的文件）
        │
        ▼
⑤ 统一后处理（一次性、对整棵 .app）
   xattr -cr "/Applications/Antigravity.app"          # 清除隔离/来源扩展属性
   codesign --force --deep --sign - "/Applications/..." # ad-hoc 重签全部嵌套组件
   codesign --verify --deep --strict "/Applications/..." # 校验，失败即触发回滚
        │
        ▼
⑥ 恢复文件属主（若以 sudo 运行，按 SUDO_USER 回填）→ 写审计日志 → 可选重启应用
```

**硬性规则**

1. `③`、`④` 必须在 `①` 完成之后；任何写入期间目标进程不得存活。
2. `xattr -cr` 与 `codesign` 必须对**整个 bundle** 执行一次，而不是对单个文件反复执行；
   分次签名会因嵌套组件摘要变化而失效。
3. `codesign --deep` 会重签 Frameworks / Helpers / XPCServices，顺序不可拆。
4. 任一步失败：按 manifest 逆序原子回写，并重新执行 `⑤`，保证回到可运行状态。
5. 应用自动更新会覆盖 bundle → `doctor` 检测签名/哈希漂移，提示重新 `install`。

---

## 5. Windows 严格 DLL 隔离（强约束）

Windows 侧只有两个注入点，且**宿主加载器不同、ABI 期望不同**，混装会导致
`antigravity_proxy.dll` 被重复加载或版本错配，表现为启动崩溃或代理静默失效。

| 宿主 | 注入 DLL | 目录 | 说明 |
| --- | --- | --- | --- |
| Antigravity Desktop / IDE | **`version.dll`** | Electron 主程序目录 | 依赖 Electron 的 DLL 搜索顺序，仅此一个代理 DLL |
| Antigravity CLI | **`dbghelp.dll`** + **`antigravity_proxy.dll`** | CLI 可执行文件同目录 | CLI 为原生二进制，需要 `dbghelp` 作为加载器 + 共享核心 |

**规则**

1. Desktop/IDE 目录**只允许**出现 `version.dll`，不得放 `dbghelp.dll`；
   CLI 目录**只允许**出现 `dbghelp.dll` + `antigravity_proxy.dll`，不得放 `version.dll`。
2. 两个目录的 DLL 来源同一 Release tag，哈希必须一致；`doctor` 逐目录校验。
3. 安装前校验目标目录可写与现有同名文件来源（非本工具管理则拒绝覆盖）。
4. 卸载/还原只删除清单中记录的注入文件，不触碰同目录其他 DLL。
5. 安装后写入 `install-manifest.json`（路径、SHA256、上游 tag、时间戳），供 `restore` 精确回滚。

---

## 6. Linux：`LD_PRELOAD` + ELF 符号抢占 + `.desktop` CDP 注入

### 6.1 符号抢占

- `libantigravity_proxy.so` 导出与 libc 同名符号（`getaddrinfo`、`connect`、`close`、`posix_spawn`）。
- 实现内部用 `dlsym(RTLD_NEXT, "connect")` 取真实符号，避免递归。
- 由于 ELF 的全局符号解析顺序，**先加载者优先**，无需 `fishhook` 式的符号表改写。
- 构造函数 `__attribute__((constructor))` 中完成配置加载与 DNS 映射表初始化。

### 6.2 启动注入

优先用包装脚本 + 环境变量，避免修改系统级配置：

```
~/.local/share/agy-aio/
├── lib/libantigravity_proxy.so
├── config.json
└── bin/antigravity          # 包装脚本：export LD_PRELOAD=...; exec /opt/Antigravity/antigravity "$@"
```

`.desktop` 覆盖（`~/.local/share/applications/`）把 `Exec=` 指向包装脚本，同时追加
`--remote-debugging-port=<port>` 供 L1 的 CDP 连接：

```ini
[Desktop Entry]
Name=Antigravity
Exec=/home/<user>/.local/share/agy-aio/bin/antigravity --remote-debugging-port=9222 %U
```

**注意**

- `sudo` / setuid 程序会丢弃 `LD_PRELOAD`；此类场景改用 `agy-aio launch` 主动注入。
- Snap / Flatpak 沙箱内无法加载外部 `.so`；`doctor` 检测到后给出明确提示而非静默失败。
- 不写 `/etc/ld.so.preload`（全局生效、风险过高）。

---

## 7. 混合更新模型

**内置核心源码 + 远端 Release 资产 + 本地回退**，保证离线可用与可审计。

```
modules/upstream-versions.json
  ├── capsule / localization / proxyPosix / proxyWindows 的 repo + commit + license
  ▼
agy-aio update
  ├── 1. 读取内置版本清单（仓库内，随包发布）
  ├── 2. 请求 GitHub Releases 的 SHA256SUMS（可配置镜像 / 代理）
  ├── 3. 下载资产到 .cache/downloads/<name>-<sha256>.part
  ├── 4. 校验 SHA256（不匹配 → 删除并报错，绝不降级信任）
  ├── 5. 解压/落盘到 .cache/store/<version>/，原子切换 current 指针
  └── 6. 网络不可用 / 校验失败 → 使用内置源码与本地缓存（本地回退）
```

| 组件 | 内置形态 | 远端形态 | 回退策略 |
| --- | --- | --- | --- |
| agy-capsule | 完整源码 | Release 压缩包（可选） | 直接用内置源码 |
| 汉化 `app.asar` | 不内置二进制 | Release 资产 + SHA256 | 使用上次缓存；无缓存则跳过 L2 |
| POSIX 代理 | 完整源码（本地编译） | 预编译 dylib/so（可选） | 本地 `make` 编译 |
| Windows DLL | 不内置二进制 | Release 资产 + SHA256 | 使用上次缓存；无缓存则拒绝安装并提示 |

**约束**

- 任何远端资产都必须有 SHA256；清单缺失即视为不可信。
- `--offline` 强制只用本地资源；`--channel stable|beta` 控制 Release 通道。
- 升级不改变已安装状态：`update` 只刷新缓存，需再次 `install` 才落到应用目录。

---

## 8. CLI 命令矩阵

| 命令 | 作用 | 关键参数 | 幂等 | 需要提权 |
| --- | --- | --- | --- | --- |
| `agy-aio status` | 汇总三层安装状态、代理端口、CDP 端口、版本 | `--json` | ✅ 只读 | 否 |
| `agy-aio doctor` | 深度体检：哈希漂移、签名有效性、DLL 隔离、`LD_PRELOAD` 可达性、出口连通性 | `--fix`（仅修可安全修复项） | ✅ 只读（`--fix` 除外） | 视平台 |
| `agy-aio install` | 安装指定层（默认全部） | `--layers capsule,localization,proxy`、`--proxy-port`、`--force` | ✅ | macOS/Windows 常需 |
| `agy-aio uninstall` | 移除注入但不恢复原文件（保留备份） | `--layers ...`、`--keep-backup` | ✅ | 视平台 |
| `agy-aio restore` | 按 manifest 完整还原到官方状态 | `--layers ...`、`--all` | ✅ | 视平台 |
| `agy-aio proxy` | 代理子命令：启停、测试、改端口、查看规则 | `on` / `off` / `test` / `config` | ✅ | 否 |
| `agy-aio launch` | 以注入环境启动目标（不落盘修改） | `--target desktop\|ide\|cli`、`--` 透传参数 | ✅ | 否 |
| `agy-aio update` | 刷新上游资产缓存 | `--check`、`--offline`、`--channel` | ✅ | 否 |

### 状态机

```
        install                uninstall
clean ──────────► installed ──────────────► injected-removed
  ▲                   │                          │
  │                   │ restore                  │ restore
  └───────────────────┴──────────────────────────┘
```

- 所有变更先写 `install-manifest.json`（含每文件 SHA256、备份路径、上游 tag），再执行。
- 任一步失败按 manifest 逆序回滚；`restore` 是最终兜底，必须能在任意中间态收敛到 `clean`。

---

## 9. 目录布局

```
agy-aio/
├── bin/agy-aio.mjs              # CLI 入口（零依赖）
├── modules/
│   ├── capsule/                 # L1：agy-capsule 源码 + 管理脚本
│   ├── localization/            # L2：asar 替换 + DOM 翻译引擎
│   ├── proxy-posix/             # L3：macOS/Linux 代理源码（Makefile/CMake）
│   └── upstream-versions.json   # 上游 repo / commit / license 锁定
├── test/*.test.mjs              # node:test 用例
├── PLAN.md
└── THIRD-PARTY-NOTICES.md
```

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Antigravity 自动更新覆盖补丁 | 三层同时失效 | `doctor` 检测哈希/签名漂移，提示重装；manifest 记录基线版本 |
| macOS 运行中改写导致进程被杀 | Agent 持续 `ECONNREFUSED` | 强制「先停进程再写」，原子替换，统一重签 |
| Windows DLL 混装 | 启动崩溃 | 严格目录隔离 + `doctor` 逐目录校验 |
| 上游 anti-proxy 无明确许可证 | 再分发风险 | 本地编译、不分发二进制、可 `--backend none` 关闭 |
| 代理出口 IP 不合规 | 服务端 400 区域限制 | 明确属用户侧配置问题，`proxy test` 只报链路状态 |
| 远端资产被篡改 | 供应链风险 | SHA256 强制校验，缺失即拒绝 |

---

## 11. 里程碑

1. **M1**：CLI 骨架 + `status` / `doctor` + manifest 与回滚框架。
2. **M2**：macOS 全链路（L1+L2+L3）安装/还原与重签时序落地。
3. **M3**：Linux `LD_PRELOAD` + `.desktop` 注入。
4. **M4**：Windows DLL 隔离部署与 Release 集成。
5. **M5**：混合更新模型 + 离线回退 + 端到端回归（`node --test`）。
