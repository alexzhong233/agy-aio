#pragma once

#include <string>
#include <vector>
#include <cstdint>
#include "Routing.hpp"

namespace Core {

struct ProxyConfig {
    std::string host = "127.0.0.1";
    int port = 7890;
    std::string type = "socks5"; // "socks5" or "http"
};

struct FakeIPConfig {
    bool enabled = true;
    std::string cidr = "198.18.0.0/15";
};

struct TimeoutConfig {
    int connect_ms = 5000;
    int send_ms = 5000;
    int recv_ms = 5000;
};

struct ProxyRules {
    std::vector<uint16_t> allowed_ports = {80, 443};
    std::string dns_mode = "direct"; // "direct" or "proxy"
    std::string ipv6_mode = "proxy";  // "proxy", "direct", "block"
    Network::RoutingEngine routing;

    bool IsPortAllowed(uint16_t port) const;
};

class Config {
public:
    static Config& Instance();

    bool Load(const std::string& path = "");
    bool IsTargetProcess(const std::string& processName) const;

    ProxyConfig proxy;
    FakeIPConfig fakeIp;
    TimeoutConfig timeout;
    ProxyRules rules;
    std::vector<std::string> targetProcesses;
    bool childInjection = true;

private:
    Config();
    std::string ResolveConfigPath(const std::string& specifiedPath);
    bool m_loaded = false;
};

} // namespace Core
