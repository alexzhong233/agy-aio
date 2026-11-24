#include "FakeIP.hpp"
#include "Logger.hpp"
#include <cstring>
#include <charconv>

namespace Network {

FakeIP& FakeIP::Instance() {
    static FakeIP instance;
    return instance;
}

FakeIP::FakeIP() {
    Init("198.18.0.0/15");
}

bool FakeIP::ParseCidr(const std::string& cidr, uint32_t& outBase, uint32_t& outMask) {
    size_t slashPos = cidr.find('/');
    if (slashPos == std::string::npos) return false;

    std::string ipPart = cidr.substr(0, slashPos);
    std::string bitsPart = cidr.substr(slashPos + 1);

    int bits = 0;
    try {
        bits = std::stoi(bitsPart);
    } catch (...) {
        return false;
    }
    if (bits < 0 || bits > 32) return false;

    struct in_addr addr{};
    if (inet_pton(AF_INET, ipPart.c_str(), &addr) != 1) return false;

    outBase = ntohl(addr.s_addr);
    if (bits == 0) outMask = 0;
    else outMask = 0xFFFFFFFF << (32 - bits);

    outBase &= outMask;
    return true;
}

void FakeIP::Init(const std::string& cidr) {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (m_initialized) return;

    if (ParseCidr(cidr, m_baseIp, m_mask)) {
        m_networkSize = ~m_mask + 1;
        Core::Logger::Info("FakeIP: 初始化成功, CIDR=" + cidr + ", 容量=" + std::to_string(m_networkSize));
    } else {
        Core::Logger::Error("FakeIP: CIDR 解析失败 (" + cidr + ")，回退到 198.18.0.0/15");
        ParseCidr("198.18.0.0/15", m_baseIp, m_mask);
        m_networkSize = ~m_mask + 1;
    }
    m_cursor = 1;
    m_initialized = true;
}

bool FakeIP::IsFakeIP(uint32_t ipNetworkOrder) {
    std::lock_guard<std::mutex> lock(m_mutex);
    uint32_t ipHost = ntohl(ipNetworkOrder);
    return (ipHost & m_mask) == m_baseIp;
}

uint32_t FakeIP::Alloc(const std::string& domain) {
    std::lock_guard<std::mutex> lock(m_mutex);

    // 1. 如果已存在映射，直接复用
    auto it = m_domainToIp.find(domain);
    if (it != m_domainToIp.end()) {
        return htonl(it->second);
    }

    if (m_networkSize <= 2) {
        Core::Logger::Warn("FakeIP: 地址池过小");
        return 0;
    }

    // 2. 游标移动 Ring Buffer
    uint32_t offset = m_cursor++;
    if (m_cursor >= m_networkSize - 1) {
        m_cursor = 1; // 回绕
    }

    uint32_t newIpHost = m_baseIp | offset;

    // 3. 释放旧的碰撞项
    auto oldIt = m_ipToDomain.find(newIpHost);
    if (oldIt != m_ipToDomain.end()) {
        m_domainToIp.erase(oldIt->second);
    }

    // 4. 记录新映射
    m_ipToDomain[newIpHost] = domain;
    m_domainToIp[domain] = newIpHost;

    if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
        Core::Logger::Debug("FakeIP: 分配 " + IpToString(htonl(newIpHost)) + " -> " + domain);
    }

    return htonl(newIpHost);
}

std::string FakeIP::GetDomain(uint32_t ipNetworkOrder) {
    std::lock_guard<std::mutex> lock(m_mutex);
    uint32_t ipHost = ntohl(ipNetworkOrder);

    auto it = m_ipToDomain.find(ipHost);
    if (it != m_ipToDomain.end()) {
        return it->second;
    }
    return "";
}

std::string FakeIP::IpToString(uint32_t ipNetworkOrder) {
    char buf[INET_ADDRSTRLEN];
    struct in_addr addr{};
    addr.s_addr = ipNetworkOrder;
    if (inet_ntop(AF_INET, &addr, buf, sizeof(buf))) {
        return std::string(buf);
    }
    return "";
}

} // namespace Network
