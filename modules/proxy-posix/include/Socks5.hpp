#pragma once

#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include "SocketIo.hpp"
#include "Logger.hpp"

namespace Network {

namespace Socks5 {
    constexpr uint8_t VERSION = 0x05;
    constexpr uint8_t AUTH_NONE = 0x00;
    constexpr uint8_t CMD_CONNECT = 0x01;
    constexpr uint8_t ATYP_IPV4 = 0x01;
    constexpr uint8_t ATYP_DOMAIN = 0x03;
    constexpr uint8_t ATYP_IPV6 = 0x04;
    constexpr uint8_t REPLY_SUCCESS = 0x00;
}

class Socks5Client {
public:
    static const char* ReplyToText(uint8_t rep) {
        switch (rep) {
            case 0x00: return "成功";
            case 0x01: return "通用失败";
            case 0x02: return "连接不允许(规则集)";
            case 0x03: return "网络不可达";
            case 0x04: return "主机不可达";
            case 0x05: return "连接被拒绝";
            case 0x06: return "TTL 已过期";
            case 0x07: return "不支持的命令";
            case 0x08: return "不支持的地址类型";
            default:   return "未知错误";
        }
    }

    static bool Handshake(int sock, const std::string& targetHost, uint16_t targetPort, int timeoutMs = 5000) {
        if (targetHost.empty()) {
            Core::Logger::Error("SOCKS5: 目标主机为空");
            return false;
        }

        if (Core::Logger::IsEnabled(Core::LogLevel::Debug)) {
            Core::Logger::Debug("SOCKS5: 开始握手, fd=" + std::to_string(sock) +
                                ", 目标=" + targetHost + ":" + std::to_string(targetPort));
        }

        // 1. 发送认证协商: VER=5, NMETHODS=1, METHOD=0(NO AUTH)
        uint8_t authRequest[3] = { Socks5::VERSION, 0x01, Socks5::AUTH_NONE };
        if (!SocketIo::SendAll(sock, authRequest, 3, timeoutMs)) {
            Core::Logger::Error("SOCKS5: [1/3] 发送认证请求失败, fd=" + std::to_string(sock));
            return false;
        }

        // 读取认证响应: VER, METHOD
        uint8_t authResponse[2] = {0};
        if (!SocketIo::RecvExact(sock, authResponse, 2, timeoutMs)) {
            Core::Logger::Error("SOCKS5: [1/3] 读取认证响应失败, fd=" + std::to_string(sock));
            return false;
        }

        if (authResponse[0] != Socks5::VERSION || authResponse[1] != Socks5::AUTH_NONE) {
            Core::Logger::Error("SOCKS5: [1/3] 代理服务器不支持免密认证, VER=" +
                                std::to_string(authResponse[0]) + ", METHOD=" + std::to_string(authResponse[1]));
            return false;
        }

        // 2. 发送 CONNECT 请求
        // +----+-----+-------+------+----------+----------+
        // |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
        // +----+-----+-------+------+----------+----------+
        std::vector<uint8_t> req;
        req.push_back(Socks5::VERSION);
        req.push_back(Socks5::CMD_CONNECT);
        req.push_back(0x00); // RSV

        struct in_addr addr4{};
        struct in6_addr addr6{};
        if (inet_pton(AF_INET, targetHost.c_str(), &addr4) == 1) {
            req.push_back(Socks5::ATYP_IPV4);
            const uint8_t* p = reinterpret_cast<const uint8_t*>(&addr4.s_addr);
            for (int i = 0; i < 4; ++i) req.push_back(p[i]);
        } else if (inet_pton(AF_INET6, targetHost.c_str(), &addr6) == 1) {
            req.push_back(Socks5::ATYP_IPV6);
            const uint8_t* p = reinterpret_cast<const uint8_t*>(&addr6);
            for (int i = 0; i < 16; ++i) req.push_back(p[i]);
        } else {
            if (targetHost.size() > 255) {
                Core::Logger::Error("SOCKS5: 目标域名过长: " + targetHost);
                return false;
            }
            req.push_back(Socks5::ATYP_DOMAIN);
            req.push_back(static_cast<uint8_t>(targetHost.size()));
            for (char c : targetHost) req.push_back(static_cast<uint8_t>(c));
        }

        // Port (Network Byte Order)
        req.push_back(static_cast<uint8_t>((targetPort >> 8) & 0xFF));
        req.push_back(static_cast<uint8_t>(targetPort & 0xFF));

        if (!SocketIo::SendAll(sock, req.data(), req.size(), timeoutMs)) {
            Core::Logger::Error("SOCKS5: [2/3] 发送 CONNECT 请求失败, fd=" + std::to_string(sock));
            return false;
        }

        // 3. 读取响应头: VER, REP, RSV, ATYP
        uint8_t respHdr[4] = {0};
        if (!SocketIo::RecvExact(sock, respHdr, 4, timeoutMs)) {
            Core::Logger::Error("SOCKS5: [3/3] 读取响应头失败, fd=" + std::to_string(sock));
            return false;
        }

        if (respHdr[0] != Socks5::VERSION) {
            Core::Logger::Error("SOCKS5: [3/3] 响应版本错误: " + std::to_string(respHdr[0]));
            return false;
        }

        if (respHdr[1] != Socks5::REPLY_SUCCESS) {
            Core::Logger::Error("SOCKS5: [3/3] 代理服务器拒绝连接, 状态=" +
                                std::to_string(respHdr[1]) + " (" + ReplyToText(respHdr[1]) + ")" +
                                ", 目标=" + targetHost + ":" + std::to_string(targetPort));
            return false;
        }

        // 读取绑定地址与端口并丢弃
        uint8_t atyp = respHdr[3];
        size_t bndAddrLen = 0;
        if (atyp == Socks5::ATYP_IPV4) {
            bndAddrLen = 4;
        } else if (atyp == Socks5::ATYP_IPV6) {
            bndAddrLen = 16;
        } else if (atyp == Socks5::ATYP_DOMAIN) {
            uint8_t dlen = 0;
            if (!SocketIo::RecvExact(sock, &dlen, 1, timeoutMs)) return false;
            bndAddrLen = dlen;
        } else {
            Core::Logger::Error("SOCKS5: 未知的 ATYP=" + std::to_string(atyp));
            return false;
        }

        if (bndAddrLen > 0) {
            std::vector<uint8_t> trash(bndAddrLen);
            if (!SocketIo::RecvExact(sock, trash.data(), bndAddrLen, timeoutMs)) return false;
        }

        uint8_t bndPort[2];
        if (!SocketIo::RecvExact(sock, bndPort, 2, timeoutMs)) return false;

        Core::Logger::Info("SOCKS5: 隧道建立成功, fd=" + std::to_string(sock) +
                           ", 目标=" + targetHost + ":" + std::to_string(targetPort));
        return true;
    }
};

} // namespace Network
