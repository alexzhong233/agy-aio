#pragma once

#include <string>
#include <vector>
#include <cstdint>
#include <netinet/in.h>
#include <arpa/inet.h>

namespace Network {

struct PortRange {
    uint16_t start = 0;
    uint16_t end = 0;
};

struct CidrV4 {
    uint32_t network = 0; // host order
    uint32_t mask = 0;    // host order
};

struct CompiledRule {
    std::string name;
    bool enabled = true;
    std::string action = "proxy"; // "direct" or "proxy"
    std::vector<std::string> domains;
    std::vector<CidrV4> cidrsV4;
    std::vector<PortRange> portRanges;
};

class RoutingEngine {
public:
    void Clear();
    void AddRule(const CompiledRule& rule);
    void SetDefaultAction(const std::string& action);

    bool Match(const std::string& host, const std::string& ipStr, uint16_t port,
               std::string* outAction, std::string* outRuleName) const;

    static bool ParseCidrV4(const std::string& cidr, CidrV4* out);
    static bool ParsePortRange(const std::string& portStr, PortRange* out);
    static bool DomainMatches(const std::string& pattern, const std::string& host);

private:
    std::vector<CompiledRule> m_rules;
    std::string m_defaultAction = "proxy";
};

} // namespace Network
