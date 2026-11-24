# Antigravity-Proxy (macOS 版)

> 🚀 **专为 macOS（Apple Silicon & Intel）上的 Antigravity 编辑器与 CLI 打造：无需 TUN 模式，稳定透明走代理**

本项目参考并对齐 [yuaotian/antigravity-proxy](https://github.com/yuaotian/antigravity-proxy) 的架构与核心原理，针对 macOS 系统的 Mach-O 架构、dyld 动态链接机制、Hardened Runtime 安全特性进行了专门的适配与实现。

---

## 📖 目录

- [🎯 解决的核心痛点](#-解决的核心痛点)
- [✨ 功能特性](#-功能特性)
- [🔧 工作原理](#-工作原理)
- [⚡ 快速开始](#-快速开始)
- [🛠️ CLI 工具使用指南 (`anti-proxy`)](#️-cli-工具使用指南-anti-proxy)
- [⚙️ 配置说明 (`config.json`)](#️-配置说明-configjson)
- [🌐 可视化配置工具 (`config-web.html`)](#-可视化配置工具-config-webhtml)
- [🔍 故障排查手册](#-故障排查手册)
- [🏗️ 架构与编译构建](#️-架构与编译构建)

---

## 🎯 解决的核心痛点

在 macOS 上使用 Google Antigravity 编辑器时，国内开发者普遍面临以下困境：

1. 🔴 **不走系统代理**：Antigravity 核心 Agent 语言服务器（`language_server_macos_arm` / `language_server`）为独立二进制程序，内部采用自建网络层，**完全忽略 macOS 系统网络代理设置**与通用环境变量。
2. 🔴 **被逼开启全局 TUN 模式**：以往为了让 Antigravity 连通，必须开启 Clash / Surge 的全局 TUN / 增强模式，导致大量本地流量、局域网调试和内网开发全部被接管，影响工作效率。
3. 🔴 **DNS 污染与连接阻断**：国内直连访问 Google 端点（`daily-cloudcode-pa.googleapis.com`、`oauth2.googleapis.com`）会被 GFW 干扰导致超时断连。

**Antigravity-Proxy (macOS 版) 彻底解决上述问题：**
- ✅ **免 TUN 模式**：只需本地代理软件开放常规 SOCKS5 或 HTTP 端口（如 `127.0.0.1:7890`）。
- ✅ **精准定向劫持**：仅代理 Antigravity 相关的进程与流量，绝不影响系统其他软件。
- ✅ **完全透明**：底层基于 Socket Hook 与 FakeIP 机制，上层编辑器与模型交互完全无感知。

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🌐 **FakeIP 虚拟 DNS 解析** | 拦截 `getaddrinfo`，为 Google 域名动态分配 `198.18.0.0/15` 虚拟 IP，彻底规避 DNS 污染与解析等待 |
| 🔀 **POSIX Socket 重定向** | 拦截 `connect()`，自动将目标流量引向本地 SOCKS5 或 HTTP CONNECT 代理服务器 |
| 🛡️ **绕过 Hardened Runtime** | 自动完成 Ad-hoc 签名与启动包装，彻底解决 macOS 限制动态库注入（`DYLD_INSERT_LIBRARIES` 剥离）的问题 |
| 👶 **多级子进程自动传播** | Hook `posix_spawn` / `posix_spawnp`，使 Antigravity 派生的子进程（如 node、工具链）自动继承代理能力 |
| 🎯 **智能分流与白名单** | 自动旁路回环地址（`127.0.0.1`、`localhost`）、Unix Domain Socket，支持域名通配符、CIDR 与端口过滤 |
| 🍎 **通用双架构支持** | 默认编译为 **Universal Binary (arm64 + x86_64)**，无论 Apple Silicon (M1/M2/M3/M4) 还是 Intel 芯片均可原生运行 |
| 💻 **全自动化 CLI 管理** | 内置 `anti-proxy` 命令行工具，一键检测、一键应用补丁、一键撤销、一键测试连通性 |

---

## 🔧 工作原理

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Antigravity (macOS 目标进程)                     │
│  ┌──────────────────────┐              ┌────────────────────────────┐  │
│  │  language_server /   │              │   libantigravity_proxy     │  │
│  │  Antigravity IDE /   │─── POSIX ───►│          .dylib            │  │
│  │  agy CLI             │   Socket     │  (fishhook + interposition)│  │
│  └──────────────────────┘              └─────────────┬──────────────┘  │
└──────────────────────────────────────────────────────┼─────────────────┘
                                                       │ 建立隧道 (SOCKS5 / HTTP)
                                                       ▼
                                             ┌──────────────────┐
                                             │    本地代理软件   │
                                             │  (127.0.0.1:7890)│
                                             └─────────┬────────┘
                                                       │ 远程代理节点
                                                       ▼
                                             ┌──────────────────┐
                                             │ Google Cloud API │
                                             │ (*.googleapis)   │
                                             └──────────────────┘
```

1. **动态库加载与符号重绑定**：
   - 动态库加载后，通过 `fishhook` 遍历 Mach-O 镜像符号表，将 `getaddrinfo`、`connect`、`close`、`posix_spawn` 重绑定至我们的 Detour 函数。
2. **FakeIP 拦截**：
   - 当调用 `getaddrinfo("daily-cloudcode-pa.googleapis.com", "443")` 时，FakeIP 环形缓冲池分配一个保留地址（如 `198.18.0.1`）并记录映射，立即返回虚拟地址。
3. **透明代理隧道建立**：
   - 当程序对 `198.18.0.1:443` 发起 `connect()` 时，Hook 层识别到 FakeIP，还原真实域名与端口；
   - 将该 Socket 重定向连接至本地代理端口（如 `127.0.0.1:7890`）；
   - 执行 SOCKS5 握手（发送目标域名与端口）或 HTTP CONNECT 握手；
   - 隧道建立成功后返回 `0`。上层 TLS 握手及后续数据交互直接在隧道内无缝透明传输。

---

## ⚡ 快速开始

### 第 1 步：准备本地代理
启动你的 Clash / Mihomo / Surge / V2Ray 等代理客户端，确保本机开放了 SOCKS5 或 HTTP 端口（默认 `127.0.0.1:7890`）。

### 第 2 步：构建通用动态库
在终端中进入项目目录，执行：
```bash
./build.sh -u -t
```
> 参数 `-u` 会同时编译 Apple Silicon (arm64) 和 Intel (x86_64) 双架构；`-t` 会自动运行本地回归测试。

### 第 3 步：一键检测与应用补丁
使用内置管理工具：
```bash
# 1. 检查当前环境与安装状态
./bin/anti-proxy status

# 2. 一键自动备份并应用代理补丁（建议使用 sudo，-r 参数会自动平滑重启旧进程）
sudo ./bin/anti-proxy patch -r

# 3. 验证连通性
./bin/anti-proxy test
```

> [!TIP]
> **关于运行权限与环境说明：**
> macOS 系统默认对 `/Applications` 系统应用目录启用了 TCC 严格保护，**推荐直接使用 sudo 管理员权限运行**：
> ```bash
> sudo ./bin/anti-proxy patch -r
> ```
> *(注：CLI 已内置用户身份回退映射，补丁文件的所有权会自动保持为你的普通账户，日常使用完全不受影响)*

> [!IMPORTANT]
> **原生 Mach-O Launcher 机制（免疫 macOS SIP 剥离）：**
> 在 macOS 上，若通过常规 shell 脚本 (`#!/bin/bash`) 作为 Wrapper 启动子进程，macOS 系统的 SIP (System Integrity Protection) 保护机制会**强制清除并剥离**所有的 `DYLD_*` 环境变量（包括 `DYLD_INSERT_LIBRARIES`），导致动态库无法注入。
> 本项目特别自研了原生的 **Mach-O C Launcher**（双架构 Universal Binary），完全替代 Shell 脚本，不受 SIP 环境变量剥离限制，实现 100% 稳定的动态库透明注入！

补丁完成后，正常打开 **Antigravity** 或 **Antigravity IDE**，所有对话、模型调用、Agent 执行均会自动稳定走代理！

---

## 🛠️ CLI 工具使用指南 (`anti-proxy`)

CLI 工具位于 `bin/anti-proxy`，可执行以下子命令：

```bash
# 查看系统安装情况、代理端口监听与补丁状态
./bin/anti-proxy status

# 一键为所有检测到的 Antigravity 组件安装代理补丁（建议使用 sudo，加 -r 可自动平滑重启旧语言服务器）
sudo ./bin/anti-proxy patch -r

# 撤销补丁，还原所有程序至 Google 官方初始状态
./bin/anti-proxy unpatch

# 测试代理网络连通性与 Google 接口（搜索、Cloud Code API、OAuth）响应
./bin/anti-proxy test

# 在默认浏览器中打开可视化配置网页
./bin/anti-proxy web

# 使用代理注入单次执行任意外部命令（如命令行工具 agy）
./bin/anti-proxy run agy --help
```

---

## ⚙️ 配置说明 (`config.json`)

默认配置文件位于项目根目录 `config.json`（应用补丁后会自动部署至各目标程序所在目录）。

```json
{
  "proxy": {
    "host": "127.0.0.1",
    "port": 7890,
    "type": "socks5"
  },
  "fake_ip": {
    "enabled": true,
    "cidr": "198.18.0.0/15"
  },
  "timeout": {
    "connect_ms": 5000,
    "send_ms": 5000,
    "recv_ms": 5000
  },
  "target_processes": [
    "language_server_macos_arm",
    "language_server_macos_x64",
    "language_server",
    "Antigravity",
    "Antigravity IDE",
    "Antigravity Helper",
    "node",
    "agy"
  ],
  "child_injection": true,
  "proxy_rules": {
    "allowed_ports": [80, 443],
    "dns_mode": "direct",
    "ipv6_mode": "proxy",
    "routing": {
      "default_action": "proxy",
      "rules": [
        {
          "name": "Bypass Localhost",
          "enabled": true,
          "action": "direct",
          "domains": ["localhost", "*.local", "local"],
          "ip_cidrs_v4": ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
        },
        {
          "name": "Bypass Apple & CN",
          "enabled": true,
          "action": "direct",
          "domains": ["*.apple.com", "*.icloud.com", "*.cn"]
        },
        {
          "name": "Proxy Google Services",
          "enabled": true,
          "action": "proxy",
          "domains": ["*.google.com", "*.googleapis.com", "*.gstatic.com", "*.googleusercontent.com"]
        }
      ]
    }
  }
}
```

### 关键配置项说明
- `proxy.type`：可选 `"socks5"`（推荐）或 `"http"`。
- `proxy.port`：请与你的代理客户端监听端口保持一致（如 Clash Verge 默认为 7890/7891，Surge 默认为 6152/6153）。
- `fake_ip.cidr`：FakeIP 网段，默认 `198.18.0.0/15`（容量超 13 万个地址）。
- `proxy_rules.routing.rules`：分流规则，满足条件的域名/CIDR 可设定为 `"direct"`（直连）或 `"proxy"`（走代理）。

---

## 🌐 可视化配置工具 (`config-web.html`)

本项目包含开箱即用的前端可视化配置页面 `config-web.html`。
只需运行：
```bash
./bin/anti-proxy web
```
或直接在 Finder 中双击 `config-web.html`，即可使用现代化 UI 调整代理端口、管理分流规则并导出新的 `config.json`。

---

## 🔍 故障排查手册

### 1. 对话报错：`User location is not supported for the API use` (code 400)
- **原因**：这说明代理与注入**完全生效了**，但你当前使用的**代理节点出口 IP** 属于机房/托管数据中心 ASN，被 Google 服务端策略判定为非合规区域。
- **解决**：在代理客户端中切换节点，优先选择**住宅 / 家宽 / 原生 ISP** 属性的海外节点重试。

### 2. 运行 patch 报错：`PermissionError: [Errno 1] Operation not permitted`
- **原因**：macOS (Ventura/Sonoma/Sequoia) 对系统级 `/Applications` 目录启用了 App 管理（TCC）安全保护，默认限制终端应用直接修改其中的文件。
- **推荐方案（最快捷，即刻生效）**：
  直接在终端中使用管理员权限运行补丁：
  ```bash
  sudo ./bin/anti-proxy patch
  ```
  > 💡 **说明**：`anti-proxy` 已内置权限保护机制（通过 `SUDO_USER`），生成的补丁文件所有权会自动保持为你的当前普通用户账户，日常使用完全不受影响。

- **其他可选方案**：
  - **方案 A（免系统授权）**：将应用移动到当前用户的应用程序目录 `~/Applications`（用户应用目录不受系统 App 管理限制）：
    ```bash
    mv "/Applications/Antigravity IDE.app" ~/Applications/
    ./bin/anti-proxy patch
    ```
    移动后 Spotlight 聚焦搜索、启动台 (Launchpad) 和程序坞 (Dock) 均正常使用。
  - **方案 B（系统设置授权）**：打开 macOS「系统设置」->「隐私与安全性」->「App 管理」（或「完全磁盘访问权限」），将正在使用的终端应用（Terminal / iTerm2）开启允许，然后重新执行 `./bin/anti-proxy patch`。

### 3. 日志位置与排查
组件运行时会自动输出结构化诊断日志，日志文件保存在：
- `~/.antigravity-proxy/logs/proxy-YYYYMMDD.log`

日志正常输出示例：
```
[INFO ] Antigravity-Proxy (macOS) 已加载到进程: language_server_macos_arm (PID: xxxxx)
[INFO ] 配置加载成功: 代理=127.0.0.1:7890 (socks5), FakeIP=198.18.0.0/15
[INFO ] Fishhook 符号重绑定成功 (getaddrinfo, connect, close, posix_spawn)
[INFO ] 正在重定向 daily-cloudcode-pa.googleapis.com:443 -> 代理 127.0.0.1:7890 (socks5)
[INFO ] SOCKS5: 隧道建立成功, fd=6, 目标=daily-cloudcode-pa.googleapis.com:443
```

### 4. Antigravity 升级后代理失效
Antigravity 版本更新会覆盖应用程序目录文件。更新后只需重新执行一次补丁命令：
```bash
./bin/anti-proxy patch
```

### 5. Agent / Generate commit message 报 `ECONNREFUSED 127.0.0.1:xxxxx`
- **原因**：language_server 被 macOS 内核以 `SIGKILL (Code Signature Invalid) - Invalid Page` 杀死——旧版 `patch` 曾用就地覆盖方式替换正在运行的二进制文件，内核在后续缺页校验代码签名失败时直接杀死进程。进程死亡后，IDE 主进程仍持有其失效的 gRPC 端口，所有 Agent 相关功能会持续报 `ECONNREFUSED`，且 IDE 不会自动恢复。
- **修复**：当前版本 `patch` / `unpatch` 已全部改为「同目录临时文件 + `os.replace` 原子替换」，并仅在首次备份时对 `.orig` 做 Ad-hoc 签名，彻底杜绝此类进程击杀。
- **恢复**：更新工具后重新执行 `sudo ./bin/anti-proxy patch -r`，然后**完全退出并重新打开 Antigravity / Antigravity IDE**（仅重开窗口无效，必须退出主进程，使其重新拉起 language_server 并获取新端口）。

---

## 🏗️ 架构与编译构建

项目包含完整的标准工程文件：
- `Makefile`：支持 `make all`、`make universal`、`make test`、`make clean`、`make install`。
- `CMakeLists.txt`：支持与标准 CMake 工作流及 IDE 协同构建。
- `build.sh`：自动化构建包装脚本。

```bash
# 编译当前机器架构
make

# 编译双架构通用包
make universal

# 执行测试套件
make test
```

---

## 📄 许可证

本项目基于 BSD-2-Clause 许可证开源。
内部包含的 `fishhook` 组件版权归 Facebook, Inc. 所有。
