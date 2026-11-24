#pragma once

#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/un.h>
#include <string>
#include <string_view>
#include <cctype>
#include <cstring>

namespace Network {

inline bool IsIpv4LoopbackAddress(const struct in_addr& address) {
    return (ntohl(address.s_addr) >> 24) == 127;
}

inline bool IsIpv6LoopbackAddress(const struct in6_addr& address) {
    if (IN6_IS_ADDR_LOOPBACK(&address)) return true;
    if (!IN6_IS_ADDR_V4MAPPED(&address)) return false;

    struct in_addr mapped{};
    const auto* raw = reinterpret_cast<const unsigned char*>(&address);
    std::memcpy(&mapped, raw + 12, sizeof(mapped));
    return IsIpv4LoopbackAddress(mapped);
}

inline std::string NormalizeLoopbackHost(std::string_view host) {
    std::string normalized(host);
    for (char& ch : normalized) {
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
    while (!normalized.empty() && normalized.back() == '.') {
        normalized.pop_back();
    }
    if (normalized.size() >= 2 && normalized.front() == '[' && normalized.back() == ']') {
        normalized = normalized.substr(1, normalized.size() - 2);
    }
    return normalized;
}

inline bool IsLoopbackHost(std::string_view host) {
    const std::string normalized = NormalizeLoopbackHost(host);
    if (normalized == "localhost" || normalized == "localhost.localdomain") return true;

    struct in_addr address4{};
    if (inet_pton(AF_INET, normalized.c_str(), &address4) == 1) {
        return IsIpv4LoopbackAddress(address4);
    }

    struct in6_addr address6{};
    if (inet_pton(AF_INET6, normalized.c_str(), &address6) == 1) {
        return IsIpv6LoopbackAddress(address6);
    }
    return false;
}

inline bool IsLoopbackSockaddr(const struct sockaddr* address, socklen_t addressLength) {
    if (!address || addressLength < sizeof(sa_family_t)) return false;

    if (address->sa_family == AF_INET) {
        if (addressLength < sizeof(struct sockaddr_in)) return false;
        return IsIpv4LoopbackAddress(reinterpret_cast<const struct sockaddr_in*>(address)->sin_addr);
    }
    if (address->sa_family == AF_INET6) {
        if (addressLength < sizeof(struct sockaddr_in6)) return false;
        return IsIpv6LoopbackAddress(reinterpret_cast<const struct sockaddr_in6*>(address)->sin6_addr);
    }
    return false;
}

inline bool IsProxySelfTarget(std::string_view host, uint16_t port, std::string_view proxyHost, uint16_t proxyPort) {
    if (port != proxyPort) return false;
    if (host == proxyHost) return true;
    if (IsLoopbackHost(host) && IsLoopbackHost(proxyHost)) return true;
    return false;
}

} // namespace Network
