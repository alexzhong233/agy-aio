#include "Config.hpp"
#include "Logger.hpp"
#include "nlohmann/json.hpp"
#include <fstream>
#include <unistd.h>
#include <pwd.h>
#include <libgen.h>

#ifdef __APPLE__
#include <mach-o/dyld.h>
#elif defined(__linux__)
#include <limits.h>
#endif

using json = nlohmann::json;

namespace Core {

bool ProxyRules::IsPortAllowed(uint16_t port) const {
    if (allowed_ports.empty()) return true; // 空白名单 = 允许所有端口
    for (uint16_t p : allowed_ports) {
        if (p == port) return true;
    }
    return false;
}

Config& Config::Instance() {
    static Config instance;
    return instance;
}

Config::Config() {
    targetProcesses = {
        "language_server_macos_arm",
        "language_server_macos_x64",
        "language_server_linux_x64",
        "language_server_linux_arm64",
        "language_server",
        "Antigravity",
        "Antigravity IDE",
        "Antigravity Helper",
        "node",
        "agy"
    };
}

static std::string GetExecutableDir() {
#ifdef __APPLE__
    char path[1024] = {0};
    uint32_t size = sizeof(path);
    if (_NSGetExecutablePath(path, &size) == 0) {
        char* dir = dirname(path);
        if (dir) return std::string(dir);
    }
#elif defined(__linux__)
    char path[PATH_MAX] = {0};
    ssize_t len = readlink("/proc/self/exe", path, sizeof(path) - 1);
    if (len > 0) {
        path[len] = '\0';
        // dirname 可能修改传入缓冲区，这里传入可写的 path 副本
        char* dir = dirname(path);
        if (dir) return std::string(dir);
    }
#endif
    return "";
}

static std::string GetHomeDir() {
    const char* home = getenv("HOME");
    if (home && *home) return std::string(home);
    struct passwd* pw = getpwuid(getuid());
    if (pw && pw->pw_dir) return std::string(pw->pw_dir);
    return "/tmp";
}

std::string Config::ResolveConfigPath(const std::string& specifiedPath) {
    if (!specifiedPath.empty() && access(specifiedPath.c_str(), R_OK) == 0) {
        return specifiedPath;
    }

    const char* envPath = getenv("ANTIGRAVITY_PROXY_CONFIG");
    if (envPath && *envPath && access(envPath, R_OK) == 0) {
        return std::string(envPath);
    }

    std::string exeDir = GetExecutableDir();
    if (!exeDir.empty()) {
        std::string cand = exeDir + "/config.json";
        if (access(cand.c_str(), R_OK) == 0) return cand;
    }

    char cwd[1024];
    if (getcwd(cwd, sizeof(cwd))) {
        std::string cand = std::string(cwd) + "/config.json";
        if (access(cand.c_str(), R_OK) == 0) return cand;
    }

    std::string agyCand = GetHomeDir() + "/.agy-aio/config.json";
    if (access(agyCand.c_str(), R_OK) == 0) return agyCand;

    std::string homeCand = GetHomeDir() + "/.antigravity-proxy/config.json";
    if (access(homeCand.c_str(), R_OK) == 0) return homeCand;

    std::string etcCand = "/etc/antigravity-proxy/config.json";
    if (access(etcCand.c_str(), R_OK) == 0) return etcCand;

    return "";
}

bool Config::Load(const std::string& path) {
    std::string resolvedPath = ResolveConfigPath(path);
    if (resolvedPath.empty()) {
        Logger::Warn("未找到 config.json，将使用默认配置 (127.0.0.1:7890 socks5)");
        m_loaded = true;
        return true;
    }

    Logger::Info("正在加载配置文件: " + resolvedPath);
    std::ifstream file(resolvedPath);
    if (!file.is_open()) {
        Logger::Error("无法打开配置文件: " + resolvedPath);
        return false;
    }

    try {
        json j = json::parse(file, nullptr, true, true); // ignore comments

        if (j.contains("proxy") && j["proxy"].is_object()) {
            auto& p = j["proxy"];
            if (p.contains("host") && p["host"].is_string()) proxy.host = p["host"];
            if (p.contains("port") && p["port"].is_number()) proxy.port = p["port"];
            if (p.contains("type") && p["type"].is_string()) proxy.type = p["type"];
        }

        if (j.contains("fake_ip") && j["fake_ip"].is_object()) {
            auto& f = j["fake_ip"];
            if (f.contains("enabled") && f["enabled"].is_boolean()) fakeIp.enabled = f["enabled"];
            if (f.contains("cidr") && f["cidr"].is_string()) fakeIp.cidr = f["cidr"];
        }

        if (j.contains("timeout") && j["timeout"].is_object()) {
            auto& t = j["timeout"];
            if (t.contains("connect_ms") && t["connect_ms"].is_number()) timeout.connect_ms = t["connect_ms"];
            if (t.contains("send_ms") && t["send_ms"].is_number()) timeout.send_ms = t["send_ms"];
            if (t.contains("recv_ms") && t["recv_ms"].is_number()) timeout.recv_ms = t["recv_ms"];
        }

        if (j.contains("target_processes") && j["target_processes"].is_array()) {
            targetProcesses.clear();
            for (const auto& item : j["target_processes"]) {
                if (item.is_string()) targetProcesses.push_back(item);
            }
        }

        if (j.contains("child_injection") && j["child_injection"].is_boolean()) {
            childInjection = j["child_injection"];
        }

        if (j.contains("proxy_rules") && j["proxy_rules"].is_object()) {
            auto& pr = j["proxy_rules"];
            if (pr.contains("allowed_ports") && pr["allowed_ports"].is_array()) {
                rules.allowed_ports.clear();
                for (const auto& portItem : pr["allowed_ports"]) {
                    if (portItem.is_number()) rules.allowed_ports.push_back(portItem);
                }
            }
            if (pr.contains("dns_mode") && pr["dns_mode"].is_string()) rules.dns_mode = pr["dns_mode"];
            if (pr.contains("ipv6_mode") && pr["ipv6_mode"].is_string()) rules.ipv6_mode = pr["ipv6_mode"];

            if (pr.contains("routing") && pr["routing"].is_object()) {
                auto& r = pr["routing"];
                rules.routing.Clear();
                if (r.contains("default_action") && r["default_action"].is_string()) {
                    rules.routing.SetDefaultAction(r["default_action"]);
                }

                if (r.contains("rules") && r["rules"].is_array()) {
                    for (const auto& ruleItem : r["rules"]) {
                        if (!ruleItem.is_object()) continue;
                        Network::CompiledRule rule;
                        if (ruleItem.contains("name") && ruleItem["name"].is_string()) rule.name = ruleItem["name"];
                        if (ruleItem.contains("enabled") && ruleItem["enabled"].is_boolean()) rule.enabled = ruleItem["enabled"];
                        if (ruleItem.contains("action") && ruleItem["action"].is_string()) rule.action = ruleItem["action"];

                        if (ruleItem.contains("domains") && ruleItem["domains"].is_array()) {
                            for (const auto& d : ruleItem["domains"]) {
                                if (d.is_string()) rule.domains.push_back(d);
                            }
                        }

                        if (ruleItem.contains("ip_cidrs_v4") && ruleItem["ip_cidrs_v4"].is_array()) {
                            for (const auto& c : ruleItem["ip_cidrs_v4"]) {
                                if (c.is_string()) {
                                    Network::CidrV4 cv4;
                                    if (Network::RoutingEngine::ParseCidrV4(c, &cv4)) {
                                        rule.cidrsV4.push_back(cv4);
                                    }
                                }
                            }
                        }

                        if (ruleItem.contains("ports") && ruleItem["ports"].is_array()) {
                            for (const auto& p : ruleItem["ports"]) {
                                if (p.is_string()) {
                                    Network::PortRange prange;
                                    if (Network::RoutingEngine::ParsePortRange(p, &prange)) {
                                        rule.portRanges.push_back(prange);
                                    }
                                } else if (p.is_number()) {
                                    Network::PortRange prange;
                                    prange.start = static_cast<uint16_t>(p);
                                    prange.end = static_cast<uint16_t>(p);
                                    rule.portRanges.push_back(prange);
                                }
                            }
                        }

                        rules.routing.AddRule(rule);
                    }
                }
            }
        }

        m_loaded = true;
        Logger::Info("配置加载成功: 代理=" + proxy.host + ":" + std::to_string(proxy.port) +
                    " (" + proxy.type + "), FakeIP=" + (fakeIp.enabled ? fakeIp.cidr : "禁用"));
        return true;
    } catch (const std::exception& e) {
        Logger::Error("解析配置文件失败: " + std::string(e.what()));
        return false;
    }
}

bool Config::IsTargetProcess(const std::string& processName) const {
    if (targetProcesses.empty()) return true;
    for (const auto& target : targetProcesses) {
        if (processName.find(target) != std::string::npos) {
            return true;
        }
    }
    return false;
}

} // namespace Core
