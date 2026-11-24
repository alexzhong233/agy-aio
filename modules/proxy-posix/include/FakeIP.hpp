#pragma once

#include <string>
#include <unordered_map>
#include <mutex>
#include <cstdint>
#include <netinet/in.h>
#include <arpa/inet.h>

namespace Network {

class FakeIP {
public:
    static FakeIP& Instance();

    void Init(const std::string& cidr = "198.18.0.0/15");
    bool IsFakeIP(uint32_t ipNetworkOrder);
    uint32_t Alloc(const std::string& domain);
    std::string GetDomain(uint32_t ipNetworkOrder);
    static std::string IpToString(uint32_t ipNetworkOrder);

private:
    FakeIP();
    bool ParseCidr(const std::string& cidr, uint32_t& outBase, uint32_t& outMask);

    std::unordered_map<uint32_t, std::string> m_ipToDomain;
    std::unordered_map<std::string, uint32_t> m_domainToIp;
    std::mutex m_mutex;

    uint32_t m_baseIp = 0;      // Host order
    uint32_t m_mask = 0;        // Host order
    uint32_t m_networkSize = 0;
    uint32_t m_cursor = 1;
    bool m_initialized = false;
};

} // namespace Network
