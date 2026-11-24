#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif

#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <unistd.h>
#include <fcntl.h>
#include <dlfcn.h>
#include <spawn.h>
#include <cstring>
#include <string>
#include <vector>
#include <mutex>
#include <libgen.h>

#ifdef __APPLE__
#include <mach-o/dyld.h>
#elif defined(__linux__)
#include <limits.h>
#endif

#include "Config.hpp"
#include "Logger.hpp"
#include "FakeIP.hpp"
#include "Socks5.hpp"
#include "HttpConnect.hpp"
#include "LocalTargetPolicy.hpp"
#include "SocketIo.hpp"

#ifdef __APPLE__
#include "fishhook.h"
#endif

// glibc 将 freeaddrinfo/posix_spawn/posix_spawnp 声明为 noexcept，定义时需保持一致
#if defined(__linux__) && defined(__GLIBC__)
#define AGY_LIBC_NOTHROW noexcept(true)
#else
#define AGY_LIBC_NOTHROW
#endif

// ==================== 函数指针类型定义 ====================
typedef int (*connect_func_t)(int, const struct sockaddr*, socklen_t);
typedef int (*getaddrinfo_func_t)(const char*, const char*, const struct addrinfo*, struct addrinfo**);
typedef void (*freeaddrinfo_func_t)(struct addrinfo*);
typedef int (*close_func_t)(int);
typedef int (*posix_spawn_func_t)(pid_t*, const char*, const posix_spawn_file_actions_t*,
                                  const posix_spawnattr_t*, char* const[], char* const[]);
typedef int (*posix_spawnp_func_t)(pid_t*, const char*, const posix_spawn_file_actions_t*,
                                   const posix_spawnattr_t*, char* const[], char* const[]);

// 原始系统函数指针
static connect_func_t orig_connect = nullptr;
static getaddrinfo_func_t orig_getaddrinfo = nullptr;
static freeaddrinfo_func_t orig_freeaddrinfo = nullptr;
static close_func_t orig_close = nullptr;
static posix_spawn_func_t orig_posix_spawn = nullptr;
static posix_spawnp_func_t orig_posix_spawnp = nullptr;

static std::string g_dylibPath;

// 获取当前 dylib 路径
static std::string GetCurrentDylibPath() {
    Dl_info info;
    if (dladdr((const void*)&GetCurrentDylibPath, &info) && info.dli_fname) {
        return std::string(info.dli_fname);
    }
    return "";
}

// 提取路径中的文件名
static std::string GetBaseName(const std::string& path) {
    if (path.empty()) return "";
    size_t lastSlash = path.find_last_of('/');
    if (lastSlash != std::string::npos) {
        return path.substr(lastSlash + 1);
    }
    return path;
}

// 获取当前进程可执行文件名称
static std::string GetCurrentProcessName() {
#ifdef __APPLE__
    char path[1024] = {0};
    uint32_t size = sizeof(path);
    if (_NSGetExecutablePath(path, &size) == 0) {
        return GetBaseName(path);
    }
#elif defined(__linux__)
    char path[PATH_MAX] = {0};
    ssize_t len = readlink("/proc/self/exe", path, sizeof(path) - 1);
    if (len > 0) {
        path[len] = '\0';
        return GetBaseName(path);
    }
#endif
    return "Unknown";
}

// ==================== Hook 实现（内部 helper） ====================

static int impl_getaddrinfo(const char *node, const char *service,
                            const struct addrinfo *hints, struct addrinfo **res) {
    if (!orig_getaddrinfo) {
        orig_getaddrinfo = (getaddrinfo_func_t)dlsym(RTLD_NEXT, "getaddrinfo");
    }

    auto& config = Core::Config::Instance();

    // 检查是否有域名
    if (node && *node && config.fakeIp.enabled) {
        std::string host(node);

        // 如果是回环地址或纯 IP，直连不走 FakeIP
        if (!Network::IsLoopbackHost(host)) {
            struct in_addr a4;
            struct in6_addr a6;
            bool isIp = (inet_pton(AF_INET, node, &a4) == 1) || (inet_pton(AF_INET6, node, &a6) == 1);

            if (!isIp) {
                // 检查路由规则
                std::string action;
                std::string ruleName;
                uint16_t port = 0;
                if (service) {
                    try { port = static_cast<uint16_t>(std::stoi(service)); } catch (...) {}
                }

                config.rules.routing.Match(host, "", port, &action, &ruleName);

                if (action == "direct") {
                    if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                        Core::Logger::Debug("DNS: 规则 direct 旁路: " + host + " (rule: " + ruleName + ")");
                    }
                    return orig_getaddrinfo(node, service, hints, res);
                }

                // 分配 FakeIP
                uint32_t fakeIpNet = Network::FakeIP::Instance().Alloc(host);
                if (fakeIpNet != 0) {
                    std::string fakeIpStr = Network::FakeIP::IpToString(fakeIpNet);
                    if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
                        Core::Logger::Debug("DNS: 拦截域名 " + host + " -> FakeIP " + fakeIpStr);
                    }
                    // 调用原始 getaddrinfo 解析 FakeIP 字符串，以正确生成系统 struct addrinfo 链表
                    return orig_getaddrinfo(fakeIpStr.c_str(), service, hints, res);
                }
            }
        }
    }

    return orig_getaddrinfo(node, service, hints, res);
}

static void impl_freeaddrinfo(struct addrinfo *res) {
    if (!orig_freeaddrinfo) {
        orig_freeaddrinfo = (freeaddrinfo_func_t)dlsym(RTLD_NEXT, "freeaddrinfo");
    }
    if (orig_freeaddrinfo) {
        orig_freeaddrinfo(res);
    }
}

static int impl_connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
    if (!orig_connect) {
        orig_connect = (connect_func_t)dlsym(RTLD_NEXT, "connect");
    }

    if (!addr) {
        return orig_connect(sockfd, addr, addrlen);
    }

    // 1. 本地 Unix 域套接字一律直连
    if (addr->sa_family == AF_UNIX) {
        return orig_connect(sockfd, addr, addrlen);
    }

    // 2. 本地回环连接一律直连
    if (Network::IsLoopbackSockaddr(addr, addrlen)) {
        return orig_connect(sockfd, addr, addrlen);
    }

    auto& config = Core::Config::Instance();

    // 3. 提取目标 Host 与 Port
    std::string targetHost;
    std::string targetIpStr;
    uint16_t targetPort = 0;
    bool isFake = false;

    if (addr->sa_family == AF_INET) {
        const auto* in = reinterpret_cast<const struct sockaddr_in*>(addr);
        targetPort = ntohs(in->sin_port);
        targetIpStr = Network::FakeIP::IpToString(in->sin_addr.s_addr);

        if (Network::FakeIP::Instance().IsFakeIP(in->sin_addr.s_addr)) {
            targetHost = Network::FakeIP::Instance().GetDomain(in->sin_addr.s_addr);
            isFake = true;
        } else {
            targetHost = targetIpStr;
        }
    } else if (addr->sa_family == AF_INET6) {
        const auto* in6 = reinterpret_cast<const struct sockaddr_in6*>(addr);
        targetPort = ntohs(in6->sin6_port);
        char buf[INET6_ADDRSTRLEN];
        if (inet_ntop(AF_INET6, &(in6->sin6_addr), buf, sizeof(buf))) {
            targetIpStr = buf;
            targetHost = buf;
        }
    } else {
        // 非 IP 套接字直连
        return orig_connect(sockfd, addr, addrlen);
    }

    // 4. 防环：如果目标端口就是代理自身端口且位于本地，必须直连
    if (Network::IsProxySelfTarget(targetHost, targetPort, config.proxy.host, config.proxy.port)) {
        if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
            Core::Logger::Debug("BYPASS: 目标是代理自身 (" + targetHost + ":" + std::to_string(targetPort) + ")");
        }
        return orig_connect(sockfd, addr, addrlen);
    }

    // 5. 路由规则匹配
    std::string action;
    std::string ruleName;
    config.rules.routing.Match(targetHost, targetIpStr, targetPort, &action, &ruleName);

    if (action == "direct") {
        if (isFake) {
            Core::Logger::Warn("[路由] 目标为 FakeIP (" + targetHost + ") 但命中 direct 规则，直连可能失败");
        } else if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
            Core::Logger::Debug("[路由] 直连规则命中: " + targetHost + ":" + std::to_string(targetPort) + " (" + ruleName + ")");
        }
        return orig_connect(sockfd, addr, addrlen);
    }

    // 6. 端口白名单检查
    if (!config.rules.IsPortAllowed(targetPort)) {
        if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
            Core::Logger::Debug("端口 " + std::to_string(targetPort) + " 不在白名单，直连目标: " + targetHost);
        }
        return orig_connect(sockfd, addr, addrlen);
    }

    // 7. 进行代理重定向
    Core::Logger::Info("正在重定向 " + targetHost + ":" + std::to_string(targetPort) +
                       " -> 代理 " + config.proxy.host + ":" + std::to_string(config.proxy.port) +
                       " (" + config.proxy.type + "), fd=" + std::to_string(sockfd));

    // 保存原始 socket 状态 (如 O_NONBLOCK)
    int oldFlags = Network::SocketIo::GetFlags(sockfd);

    // 临时设为阻塞模式以便进行确定性的握手超时控制
    Network::SocketIo::SetNonBlocking(sockfd, false);

    // 构造代理服务器地址
    struct sockaddr_in proxyAddr{};
    proxyAddr.sin_family = AF_INET;
    proxyAddr.sin_port = htons(static_cast<uint16_t>(config.proxy.port));
    if (inet_pton(AF_INET, config.proxy.host.c_str(), &proxyAddr.sin_addr) != 1) {
        Core::Logger::Error("无效的代理主机地址: " + config.proxy.host);
        Network::SocketIo::SetFlags(sockfd, oldFlags);
        errno = EINVAL;
        return -1;
    }

    // 连接代理服务器
    if (orig_connect(sockfd, reinterpret_cast<struct sockaddr*>(&proxyAddr), sizeof(proxyAddr)) < 0) {
        int err = errno;
        Core::Logger::Error("连接代理服务器失败: " + config.proxy.host + ":" + std::to_string(config.proxy.port) +
                            ", errno=" + std::to_string(err) + " (" + strerror(err) + ")");
        Network::SocketIo::SetFlags(sockfd, oldFlags);
        errno = err;
        return -1;
    }

    // 执行代理协议握手
    bool handshakeSuccess = false;
    int timeoutMs = config.timeout.connect_ms + config.timeout.send_ms + config.timeout.recv_ms;
    if (timeoutMs <= 0) timeoutMs = 8000;

    if (config.proxy.type == "http") {
        handshakeSuccess = Network::HttpConnectClient::Handshake(sockfd, targetHost, targetPort, timeoutMs);
    } else {
        handshakeSuccess = Network::Socks5Client::Handshake(sockfd, targetHost, targetPort, timeoutMs);
    }

    if (!handshakeSuccess) {
        Core::Logger::Error("代理握手失败，目标: " + targetHost + ":" + std::to_string(targetPort));
        Network::SocketIo::SetFlags(sockfd, oldFlags);
        errno = ECONNREFUSED;
        return -1;
    }

    // 恢复原始 socket flags (保持原调用方非阻塞/阻塞语义)
    Network::SocketIo::SetFlags(sockfd, oldFlags);

    return 0; // 成功！
}

static int impl_close(int fd) {
    if (!orig_close) {
        orig_close = (close_func_t)dlsym(RTLD_NEXT, "close");
    }
    return orig_close(fd);
}

// 辅助函数：将动态库注入环境变量加入环境变量列表
static std::vector<std::string> InjectEnv(char* const envp[]) {
    std::vector<std::string> envs;
    bool foundPreload = false;
    std::string lib = g_dylibPath;

#ifdef __APPLE__
    const char* PRELOAD_ENV = "DYLD_INSERT_LIBRARIES";
#elif defined(__linux__)
    const char* PRELOAD_ENV = "LD_PRELOAD";
#else
    const char* PRELOAD_ENV = "LD_PRELOAD";
#endif
    const std::string preloadPrefix = std::string(PRELOAD_ENV) + "=";

    if (envp) {
        for (size_t i = 0; envp[i] != nullptr; ++i) {
            std::string entry(envp[i]);
            if (entry.rfind(preloadPrefix, 0) == 0) {
                foundPreload = true;
                if (!lib.empty() && entry.find(lib) == std::string::npos) {
                    entry += ":" + lib;
                }
            }
            envs.push_back(entry);
        }
    }

    if (!foundPreload && !lib.empty()) {
        envs.push_back(preloadPrefix + lib);
    }

    return envs;
}

static int impl_posix_spawn(pid_t *pid, const char *path,
                            const posix_spawn_file_actions_t *file_actions,
                            const posix_spawnattr_t *attrp,
                            char *const argv[], char *const envp[]) {
    if (!orig_posix_spawn) {
        orig_posix_spawn = (posix_spawn_func_t)dlsym(RTLD_NEXT, "posix_spawn");
    }

    auto& config = Core::Config::Instance();
    if (!config.childInjection || g_dylibPath.empty()) {
        return orig_posix_spawn(pid, path, file_actions, attrp, argv, envp);
    }

    std::string prog = path ? GetBaseName(path) : "";
    if (config.IsTargetProcess(prog)) {
        Core::Logger::Info("子进程传播: 注入 " + prog + " (posix_spawn)");
        auto newEnvs = InjectEnv(envp);
        std::vector<char*> envPointers;
        for (auto& s : newEnvs) envPointers.push_back(&s[0]);
        envPointers.push_back(nullptr);

        return orig_posix_spawn(pid, path, file_actions, attrp, argv, envPointers.data());
    }

    return orig_posix_spawn(pid, path, file_actions, attrp, argv, envp);
}

static int impl_posix_spawnp(pid_t *pid, const char *file,
                             const posix_spawn_file_actions_t *file_actions,
                             const posix_spawnattr_t *attrp,
                             char *const argv[], char *const envp[]) {
    if (!orig_posix_spawnp) {
        orig_posix_spawnp = (posix_spawnp_func_t)dlsym(RTLD_NEXT, "posix_spawnp");
    }

    auto& config = Core::Config::Instance();
    if (!config.childInjection || g_dylibPath.empty()) {
        return orig_posix_spawnp(pid, file, file_actions, attrp, argv, envp);
    }

    std::string prog = file ? GetBaseName(file) : "";
    if (config.IsTargetProcess(prog)) {
        Core::Logger::Info("子进程传播: 注入 " + prog + " (posix_spawnp)");
        auto newEnvs = InjectEnv(envp);
        std::vector<char*> envPointers;
        for (auto& s : newEnvs) envPointers.push_back(&s[0]);
        envPointers.push_back(nullptr);

        return orig_posix_spawnp(pid, file, file_actions, attrp, argv, envPointers.data());
    }

    return orig_posix_spawnp(pid, file, file_actions, attrp, argv, envp);
}

// ==================== 导出符号 ====================

#ifdef __APPLE__
extern "C" {

int hook_getaddrinfo(const char *node, const char *service,
                     const struct addrinfo *hints, struct addrinfo **res) {
    return impl_getaddrinfo(node, service, hints, res);
}

void hook_freeaddrinfo(struct addrinfo *res) {
    impl_freeaddrinfo(res);
}

int hook_connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
    return impl_connect(sockfd, addr, addrlen);
}

int hook_close(int fd) {
    return impl_close(fd);
}

int hook_posix_spawn(pid_t *pid, const char *path,
                     const posix_spawn_file_actions_t *file_actions,
                     const posix_spawnattr_t *attrp,
                     char *const argv[], char *const envp[]) {
    return impl_posix_spawn(pid, path, file_actions, attrp, argv, envp);
}

int hook_posix_spawnp(pid_t *pid, const char *file,
                      const posix_spawn_file_actions_t *file_actions,
                      const posix_spawnattr_t *attrp,
                      char *const argv[], char *const envp[]) {
    return impl_posix_spawnp(pid, file, file_actions, attrp, argv, envp);
}

} // extern "C"
#elif defined(__linux__)
// Linux: 直接导出标准 ELF interposition 符号，由 LD_PRELOAD 完成符号抢占
extern "C" {

int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **res) {
    return impl_getaddrinfo(node, service, hints, res);
}

void freeaddrinfo(struct addrinfo *res) AGY_LIBC_NOTHROW {
    impl_freeaddrinfo(res);
}

int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
    return impl_connect(sockfd, addr, addrlen);
}

int close(int fd) {
    return impl_close(fd);
}

int posix_spawn(pid_t *pid, const char *path,
                const posix_spawn_file_actions_t *file_actions,
                const posix_spawnattr_t *attrp,
                char *const argv[], char *const envp[]) AGY_LIBC_NOTHROW {
    return impl_posix_spawn(pid, path, file_actions, attrp, argv, envp);
}

int posix_spawnp(pid_t *pid, const char *file,
                 const posix_spawn_file_actions_t *file_actions,
                 const posix_spawnattr_t *attrp,
                 char *const argv[], char *const envp[]) AGY_LIBC_NOTHROW {
    return impl_posix_spawnp(pid, file, file_actions, attrp, argv, envp);
}

} // extern "C"
#endif

// fishhook 负责对所有 Mach-O 镜像进行符号重绑定，避免与 DYLD_INTERPOSE 重叠导致的递归
/*
DYLD_INTERPOSE(hook_getaddrinfo, getaddrinfo)
DYLD_INTERPOSE(hook_freeaddrinfo, freeaddrinfo)
DYLD_INTERPOSE(hook_connect, connect)
DYLD_INTERPOSE(hook_close, close)
DYLD_INTERPOSE(hook_posix_spawn, posix_spawn)
DYLD_INTERPOSE(hook_posix_spawnp, posix_spawnp)
*/

// ==================== 模块构造函数 (Constructor) ====================
__attribute__((constructor))
static void AntigravityProxyInit(void) {
#ifdef __APPLE__
    const char* platformName = "macOS";
#elif defined(__linux__)
    const char* platformName = "Linux";
#else
    const char* platformName = "POSIX";
#endif

    g_dylibPath = GetCurrentDylibPath();
    std::string procName = GetCurrentProcessName();

    Core::Logger::Init();
    Core::Logger::Info("==================================================");
    Core::Logger::Info(std::string("Antigravity-Proxy (") + platformName + ") 已加载到进程: " +
                       procName + " (PID: " + std::to_string(getpid()) + ")");

    // 加载配置
    Core::Config::Instance().Load();

    // 解析系统符号指针
    orig_connect = (connect_func_t)dlsym(RTLD_NEXT, "connect");
    orig_getaddrinfo = (getaddrinfo_func_t)dlsym(RTLD_NEXT, "getaddrinfo");
    orig_freeaddrinfo = (freeaddrinfo_func_t)dlsym(RTLD_NEXT, "freeaddrinfo");
    orig_close = (close_func_t)dlsym(RTLD_NEXT, "close");
    orig_posix_spawn = (posix_spawn_func_t)dlsym(RTLD_NEXT, "posix_spawn");
    orig_posix_spawnp = (posix_spawnp_func_t)dlsym(RTLD_NEXT, "posix_spawnp");

#ifdef __APPLE__
    // 同时使用 fishhook 对 Mach-O 镜像执行符号重绑定（确保动态链接/懒绑定完全覆盖）
    struct rebinding rebs[] = {
        {"getaddrinfo", (void*)hook_getaddrinfo, (void**)&orig_getaddrinfo},
        {"freeaddrinfo", (void*)hook_freeaddrinfo, (void**)&orig_freeaddrinfo},
        {"connect", (void*)hook_connect, (void**)&orig_connect},
        {"close", (void*)hook_close, (void**)&orig_close},
        {"posix_spawn", (void*)hook_posix_spawn, (void**)&orig_posix_spawn},
        {"posix_spawnp", (void*)hook_posix_spawnp, (void**)&orig_posix_spawnp}
    };
    int rc = rebind_symbols(rebs, sizeof(rebs) / sizeof(rebs[0]));
    if (rc == 0) {
        Core::Logger::Info("Fishhook 符号重绑定成功 (getaddrinfo, connect, close, posix_spawn)");
    } else {
        Core::Logger::Warn("Fishhook 符号重绑定返回: " + std::to_string(rc));
    }
#endif

    Core::Logger::Info(std::string("Antigravity-Proxy (") + platformName + ") 初始化完成");
    Core::Logger::Info("==================================================");
}
