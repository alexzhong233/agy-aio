#pragma once

#include <sys/types.h>
#include <sys/socket.h>
#include <fcntl.h>
#include <unistd.h>
#include <poll.h>
#include <errno.h>
#include <cstring>
#include <string>

namespace Network {

class SocketIo {
public:
    static bool SetNonBlocking(int fd, bool nonBlocking) {
        int flags = fcntl(fd, F_GETFL, 0);
        if (flags < 0) return false;
        if (nonBlocking) {
            flags |= O_NONBLOCK;
        } else {
            flags &= ~O_NONBLOCK;
        }
        return fcntl(fd, F_SETFL, flags) >= 0;
    }

    static int GetFlags(int fd) {
        return fcntl(fd, F_GETFL, 0);
    }

    static bool SetFlags(int fd, int flags) {
        return fcntl(fd, F_SETFL, flags) >= 0;
    }

    static bool WaitConnect(int fd, int timeout_ms) {
        struct pollfd pfd{};
        pfd.fd = fd;
        pfd.events = POLLOUT;

        int ret = poll(&pfd, 1, timeout_ms > 0 ? timeout_ms : -1);
        if (ret <= 0) {
            return false;
        }

        if (pfd.revents & (POLLERR | POLLHUP | POLLNVAL)) {
            int err = 0;
            socklen_t len = sizeof(err);
            getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len);
            errno = err ? err : ECONNREFUSED;
            return false;
        }

        if (pfd.revents & POLLOUT) {
            int err = 0;
            socklen_t len = sizeof(err);
            if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) == 0) {
                if (err == 0) return true;
                errno = err;
            }
        }
        return false;
    }

    static bool SendAll(int fd, const void* buffer, size_t length, int timeout_ms) {
        const char* ptr = static_cast<const char*>(buffer);
        size_t remaining = length;

        while (remaining > 0) {
            struct pollfd pfd{};
            pfd.fd = fd;
            pfd.events = POLLOUT;

            int ret = poll(&pfd, 1, timeout_ms > 0 ? timeout_ms : -1);
            if (ret <= 0) return false;

#ifdef MSG_NOSIGNAL
            const int sendFlags = MSG_NOSIGNAL;
#else
            const int sendFlags = 0;
#endif
            ssize_t n = send(fd, ptr, remaining, sendFlags);
            if (n < 0) {
                if (errno == EINTR) continue;
                if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
                return false;
            }
            if (n == 0) return false;

            ptr += n;
            remaining -= static_cast<size_t>(n);
        }
        return true;
    }

    static bool RecvExact(int fd, void* buffer, size_t length, int timeout_ms) {
        char* ptr = static_cast<char*>(buffer);
        size_t remaining = length;

        while (remaining > 0) {
            struct pollfd pfd{};
            pfd.fd = fd;
            pfd.events = POLLIN;

            int ret = poll(&pfd, 1, timeout_ms > 0 ? timeout_ms : -1);
            if (ret <= 0) return false;

            ssize_t n = recv(fd, ptr, remaining, 0);
            if (n < 0) {
                if (errno == EINTR) continue;
                if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
                return false;
            }
            if (n == 0) return false; // Connection closed

            ptr += n;
            remaining -= static_cast<size_t>(n);
        }
        return true;
    }

    static bool RecvUntil(int fd, std::string* out, const std::string& delimiter, int timeout_ms, size_t max_bytes = 4096) {
        if (!out) return false;
        out->clear();

        while (out->size() < max_bytes) {
            char ch = 0;
            if (!RecvExact(fd, &ch, 1, timeout_ms)) {
                return false;
            }
            out->push_back(ch);

            if (out->size() >= delimiter.size() &&
                out->compare(out->size() - delimiter.size(), delimiter.size(), delimiter) == 0) {
                return true;
            }
        }
        return false;
    }
};

} // namespace Network
