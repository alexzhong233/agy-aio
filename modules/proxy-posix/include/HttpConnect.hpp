#pragma once

#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <string>
#include <sstream>
#include "SocketIo.hpp"
#include "Logger.hpp"

namespace Network {

class HttpConnectClient {
public:
    static bool Handshake(int sock, const std::string& targetHost, uint16_t targetPort, int timeoutMs = 5000) {
        if (targetHost.empty()) {
            Core::Logger::Error("HTTP CONNECT: 目标主机为空");
            return false;
        }

        std::string hostForHeader = targetHost;
        struct in6_addr addr6{};
        if (inet_pton(AF_INET6, targetHost.c_str(), &addr6) == 1) {
            hostForHeader = "[" + targetHost + "]";
        }

        std::ostringstream req;
        req << "CONNECT " << hostForHeader << ":" << targetPort << " HTTP/1.1\r\n"
            << "Host: " << hostForHeader << ":" << targetPort << "\r\n"
            << "User-Agent: Antigravity-Proxy/Mac\r\n"
            << "Proxy-Connection: Keep-Alive\r\n\r\n";

        std::string reqStr = req.str();
        if (!SocketIo::SendAll(sock, reqStr.data(), reqStr.size(), timeoutMs)) {
            Core::Logger::Error("HTTP CONNECT: 发送请求失败, fd=" + std::to_string(sock));
            return false;
        }

        std::string response;
        if (!SocketIo::RecvUntil(sock, &response, "\r\n\r\n", timeoutMs, 2048)) {
            Core::Logger::Error("HTTP CONNECT: 接收响应超时或失败, fd=" + std::to_string(sock));
            return false;
        }

        // Parse status line: HTTP/1.x 200 ...
        size_t sp1 = response.find(' ');
        if (sp1 == std::string::npos || sp1 + 4 > response.size()) {
            Core::Logger::Error("HTTP CONNECT: 无效的 HTTP 响应: " + response.substr(0, 64));
            return false;
        }

        int statusCode = 0;
        try {
            statusCode = std::stoi(response.substr(sp1 + 1, 3));
        } catch (...) {
            statusCode = -1;
        }

        if (statusCode != 200) {
            Core::Logger::Error("HTTP CONNECT: 代理返回非 200 状态码: " + std::to_string(statusCode) +
                                ", 目标=" + targetHost + ":" + std::to_string(targetPort));
            return false;
        }

        Core::Logger::Info("HTTP CONNECT: 隧道建立成功, fd=" + std::to_string(sock) +
                           ", 目标=" + targetHost + ":" + std::to_string(targetPort));
        return true;
    }
};

} // namespace Network
