#include <iostream>
#include <string>
#include <cstring>
#include <unistd.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>

int main(int argc, char* argv[]) {
    const char* targetHost = (argc > 1) ? argv[1] : "www.google.com";
    const char* targetPort = (argc > 2) ? argv[2] : "80";

    std::cout << "[TestClient] 正在解析目标: " << targetHost << ":" << targetPort << "...\n";

    struct addrinfo hints{}, *res = nullptr;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    int rc = getaddrinfo(targetHost, targetPort, &hints, &res);
    if (rc != 0) {
        std::cerr << "[TestClient] 解析失败: " << gai_strerror(rc) << "\n";
        return 1;
    }

    struct sockaddr_in* addr = reinterpret_cast<struct sockaddr_in*>(res->ai_addr);
    char ipBuf[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &(addr->sin_addr), ipBuf, sizeof(ipBuf));
    std::cout << "[TestClient] 解析得到 IP: " << ipBuf << " (端口 " << ntohs(addr->sin_port) << ")\n";

    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) {
        perror("[TestClient] 创建 socket 失败");
        freeaddrinfo(res);
        return 1;
    }

    std::cout << "[TestClient] 正在连接目标...\n";
    if (connect(sock, res->ai_addr, res->ai_addrlen) < 0) {
        perror("[TestClient] 连接目标失败");
        close(sock);
        freeaddrinfo(res);
        return 1;
    }
    std::cout << "[TestClient] 连接成功！发送 HTTP HEAD 请求...\n";

    std::string req = "HEAD / HTTP/1.1\r\nHost: " + std::string(targetHost) + "\r\nUser-Agent: AntigravityTest/1.0\r\nConnection: close\r\n\r\n";
    send(sock, req.data(), req.size(), 0);

    char buf[1024] = {0};
    ssize_t n = recv(sock, buf, sizeof(buf) - 1, 0);
    if (n > 0) {
        std::cout << "[TestClient] 收到响应 (" << n << " 字节):\n" << buf << "\n";
    }

    close(sock);
    freeaddrinfo(res);
    std::cout << "[TestClient] 测试通过！\n";
    return 0;
}
