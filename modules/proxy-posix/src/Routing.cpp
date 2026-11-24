#include "Routing.hpp"
#include <algorithm>
#include <cctype>

namespace Network {

void RoutingEngine::Clear() {
    m_rules.clear();
    m_defaultAction = "proxy";
}

void RoutingEngine::AddRule(const CompiledRule& rule) {
    if (rule.enabled) {
        m_rules.push_back(rule);
    }
}

void RoutingEngine::SetDefaultAction(const std::string& action) {
    m_defaultAction = action.empty() ? "proxy" : action;
}

static std::string ToLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
}

bool RoutingEngine::DomainMatches(const std::string& pattern, const std::string& host) {
    std::string p = ToLower(pattern);
    std::string h = ToLower(host);

    if (p == h) return true;

    // Wildcard: *.example.com matches sub.example.com
    if (p.rfind("*.", 0) == 0) {
        std::string suffix = p.substr(2); // example.com
        if (h == suffix) return true;
        if (h.size() > suffix.size() + 1 &&
            h.compare(h.size() - suffix.size(), suffix.size(), suffix) == 0 &&
            h[h.size() - suffix.size() - 1] == '.') {
            return true;
        }
    }

    // Suffix: .cn matches example.cn
    if (!p.empty() && p.front() == '.') {
        if (h.size() >= p.size() &&
            h.compare(h.size() - p.size(), p.size(), p) == 0) {
            return true;
        }
    }

    return false;
}

bool RoutingEngine::ParseCidrV4(const std::string& cidr, CidrV4* out) {
    if (!out) return false;
    size_t slash = cidr.find('/');
    if (slash == std::string::npos) {
        // Plain IP: /32
        struct in_addr addr{};
        if (inet_pton(AF_INET, cidr.c_str(), &addr) != 1) return false;
        out->network = ntohl(addr.s_addr);
        out->mask = 0xFFFFFFFF;
        return true;
    }

    std::string ipStr = cidr.substr(0, slash);
    std::string bitsStr = cidr.substr(slash + 1);
    int bits = 0;
    try {
        bits = std::stoi(bitsStr);
    } catch (...) {
        return false;
    }
    if (bits < 0 || bits > 32) return false;

    struct in_addr addr{};
    if (inet_pton(AF_INET, ipStr.c_str(), &addr) != 1) return false;

    out->mask = (bits == 0) ? 0 : (0xFFFFFFFF << (32 - bits));
    out->network = ntohl(addr.s_addr) & out->mask;
    return true;
}

bool RoutingEngine::ParsePortRange(const std::string& portStr, PortRange* out) {
    if (!out || portStr.empty()) return false;
    size_t dash = portStr.find('-');
    if (dash == std::string::npos) {
        try {
            int p = std::stoi(portStr);
            if (p > 0 && p <= 65535) {
                out->start = static_cast<uint16_t>(p);
                out->end = static_cast<uint16_t>(p);
                return true;
            }
        } catch (...) {}
        return false;
    }

    try {
        int s = std::stoi(portStr.substr(0, dash));
        int e = std::stoi(portStr.substr(dash + 1));
        if (s > 0 && e >= s && e <= 65535) {
            out->start = static_cast<uint16_t>(s);
            out->end = static_cast<uint16_t>(e);
            return true;
        }
    } catch (...) {}
    return false;
}

bool RoutingEngine::Match(const std::string& host, const std::string& ipStr, uint16_t port,
                          std::string* outAction, std::string* outRuleName) const {
    uint32_t ipHost = 0;
    bool hasIp = false;
    if (!ipStr.empty()) {
        struct in_addr addr{};
        if (inet_pton(AF_INET, ipStr.c_str(), &addr) == 1) {
            ipHost = ntohl(addr.s_addr);
            hasIp = true;
        }
    }

    for (const auto& rule : m_rules) {
        bool domainMatched = false;
        if (!host.empty() && !rule.domains.empty()) {
            for (const auto& pattern : rule.domains) {
                if (DomainMatches(pattern, host)) {
                    domainMatched = true;
                    break;
                }
            }
        }

        bool ipMatched = false;
        if (hasIp && !rule.cidrsV4.empty()) {
            for (const auto& cidr : rule.cidrsV4) {
                if ((ipHost & cidr.mask) == cidr.network) {
                    ipMatched = true;
                    break;
                }
            }
        }

        bool portMatched = true;
        if (port > 0 && !rule.portRanges.empty()) {
            portMatched = false;
            for (const auto& pr : rule.portRanges) {
                if (port >= pr.start && port <= pr.end) {
                    portMatched = true;
                    break;
                }
            }
        }

        // If rule specifies domains/IPs, at least one target criterion must match
        bool targetMatched = false;
        if (!rule.domains.empty() && !rule.cidrsV4.empty()) {
            targetMatched = domainMatched || ipMatched;
        } else if (!rule.domains.empty()) {
            targetMatched = domainMatched;
        } else if (!rule.cidrsV4.empty()) {
            targetMatched = ipMatched;
        } else {
            targetMatched = true; // Rule applies to all targets (port-only rule)
        }

        if (targetMatched && portMatched) {
            if (outAction) *outAction = rule.action;
            if (outRuleName) *outRuleName = rule.name;
            return true;
        }
    }

    if (outAction) *outAction = m_defaultAction;
    if (outRuleName) *outRuleName = "default";
    return false;
}

} // namespace Network
