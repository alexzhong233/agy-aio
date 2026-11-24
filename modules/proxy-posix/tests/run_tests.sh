#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

UNAME_S="$(uname -s)"
if [ "$UNAME_S" = "Darwin" ]; then
    LIB_NAME="libantigravity_proxy.dylib"
    PRELOAD_VAR="DYLD_INSERT_LIBRARIES"
    CXX_BIN="${CXX:-clang++}"
else
    LIB_NAME="libantigravity_proxy.so"
    PRELOAD_VAR="LD_PRELOAD"
    CXX_BIN="${CXX:-c++}"
fi

LIB_PATH="$ROOT_DIR/$LIB_NAME"
TEST_CLIENT="$SCRIPT_DIR/test_client"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agy-proxy-test.XXXXXX")"
MOCK_PY="$TMP_DIR/mock_proxy.py"
MOCK_INFO="$TMP_DIR/mock_ports.txt"
MOCK_LOG="$TMP_DIR/mock_proxy.log"
CONFIG_PATH="$TMP_DIR/config.json"
LOG_DIR="$TMP_DIR/logs"
MOCK_PID=""

cleanup() {
    if [ -n "$MOCK_PID" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
        kill "$MOCK_PID" 2>/dev/null || true
        wait "$MOCK_PID" 2>/dev/null || true
    fi
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if ! command -v python3 >/dev/null 2>&1; then
    echo "FAILED: 需要 python3 来运行本地 mock SOCKS5/HTTP 服务器"
    exit 1
fi

echo "=== 1. 编译 ${LIB_NAME} 与 test_client ==="
cd "$ROOT_DIR"
make

"$CXX_BIN" -std=c++17 "$SCRIPT_DIR/test_client.cpp" -o "$TEST_CLIENT"

echo ""
echo "=== 2. 启动本地 mock SOCKS5 + HTTP 服务器（临时端口，无需外网 / 7890） ==="
cat > "$MOCK_PY" <<'PY'
import socket
import socketserver
import threading

from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    from http.server import ThreadingHTTPServer as HTTPServerClass
except ImportError:  # Python < 3.7
    class HTTPServerClass(socketserver.ThreadingMixIn, HTTPServer):
        daemon_threads = True


class MockHttpHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        body = b"ok"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def recv_exact(conn, n):
    data = b""
    while len(data) < n:
        chunk = conn.recv(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def handle_socks_client(conn):
    try:
        conn.settimeout(10)
        header = recv_exact(conn, 2)
        if not header or header[0] != 0x05:
            return
        nmethods = header[1]
        if recv_exact(conn, nmethods) is None:
            return
        conn.sendall(b"\x05\x00")  # 无认证

        req = recv_exact(conn, 4)
        if not req or req[0] != 0x05:
            return
        atyp = req[3]
        if atyp == 0x01:
            if recv_exact(conn, 4) is None:
                return
        elif atyp == 0x03:
            length = recv_exact(conn, 1)
            if not length or recv_exact(conn, length[0]) is None:
                return
        elif atyp == 0x04:
            if recv_exact(conn, 16) is None:
                return
        else:
            return
        if recv_exact(conn, 2) is None:
            return

        # 成功响应：BND.ADDR = 0.0.0.0, BND.PORT = 0
        conn.sendall(b"\x05\x00\x00\x01" + b"\x00\x00\x00\x00" + b"\x00\x00")

        # 吞掉测试客户端的 HTTP 请求头
        data = b""
        while b"\r\n\r\n" not in data and len(data) < 65536:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk

        # 扮演 mock 上游，返回固定 200 响应
        conn.sendall(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: text/plain\r\n"
            b"Content-Length: 2\r\n"
            b"Connection: close\r\n"
            b"\r\n"
            b"ok"
        )
    except (OSError, socket.timeout):
        pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


def socks_server_loop(sock):
    while True:
        try:
            conn, _ = sock.accept()
        except OSError:
            return
        threading.Thread(target=handle_socks_client, args=(conn,), daemon=True).start()


def main():
    httpd = HTTPServerClass(("127.0.0.1", 0), MockHttpHandler)
    http_port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    socks = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    socks.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    socks.bind(("127.0.0.1", 0))
    socks.listen(16)
    socks_port = socks.getsockname()[1]
    threading.Thread(target=socks_server_loop, args=(socks,), daemon=True).start()

    print("SOCKS_PORT=%d" % socks_port, flush=True)
    print("HTTP_PORT=%d" % http_port, flush=True)

    threading.Event().wait()


if __name__ == "__main__":
    main()
PY

python3 "$MOCK_PY" > "$MOCK_INFO" 2> "$MOCK_LOG" &
MOCK_PID=$!

_attempt=0
while [ "$_attempt" -lt 100 ]; do
    if grep -q '^SOCKS_PORT=' "$MOCK_INFO" 2>/dev/null && grep -q '^HTTP_PORT=' "$MOCK_INFO" 2>/dev/null; then
        break
    fi
    sleep 0.1
    _attempt=$((_attempt + 1))
done

SOCKS_PORT="$(sed -n 's/^SOCKS_PORT=//p' "$MOCK_INFO" | head -n 1)"
HTTP_PORT="$(sed -n 's/^HTTP_PORT=//p' "$MOCK_INFO" | head -n 1)"

if [ -z "$SOCKS_PORT" ] || [ -z "$HTTP_PORT" ]; then
    echo "FAILED: mock 服务器未能启动"
    cat "$MOCK_LOG" || true
    exit 1
fi
echo "Mock SOCKS5 端口: $SOCKS_PORT, Mock HTTP 端口: $HTTP_PORT"

cat > "$CONFIG_PATH" <<EOF
{
  "proxy": { "host": "127.0.0.1", "port": $SOCKS_PORT, "type": "socks5" },
  "fake_ip": { "enabled": true, "cidr": "198.18.0.0/15" },
  "timeout": { "connect_ms": 5000, "send_ms": 5000, "recv_ms": 5000 },
  "child_injection": false
}
EOF

mkdir -p "$LOG_DIR"

run_injected() {
    env "$PRELOAD_VAR=$LIB_PATH" \
        ANTIGRAVITY_PROXY_CONFIG="$CONFIG_PATH" \
        ANTIGRAVITY_PROXY_LOG_DIR="$LOG_DIR" \
        "$@"
}

echo ""
echo "=== 3. FakeIP 分配 + SOCKS5 握手 + mock 上游 HTTP（离线可运行） ==="
set +e
FAKE_OUTPUT="$(run_injected "$TEST_CLIENT" "fakeip-test.invalid" 80 2>&1)"
FAKE_STATUS=$?
set -e
echo "$FAKE_OUTPUT"
if [ "$FAKE_STATUS" -ne 0 ]; then
    echo "FAILED: test_client 经代理访问 mock 上游失败 (exit $FAKE_STATUS)"
    exit 1
fi

if ! printf '%s\n' "$FAKE_OUTPUT" | grep -q '解析得到 IP: 198\.18\.'; then
    echo "FAILED: 未观察到 FakeIP 分配 (期望 解析得到 IP: 198.18.x.x)"
    exit 1
fi

if ! printf '%s\n' "$FAKE_OUTPUT" | grep -q 'SOCKS5: 隧道建立成功'; then
    echo "FAILED: 未观察到 SOCKS5 握手成功日志"
    exit 1
fi

if ! printf '%s\n' "$FAKE_OUTPUT" | grep -q 'HTTP/1\.1 200 OK'; then
    echo "FAILED: 未收到 mock SOCKS5 上游返回的 HTTP/1.1 200 OK"
    exit 1
fi

echo ""
echo "=== 4. 本地回环直连旁路（不应走代理） ==="
set +e
LOOP_OUTPUT="$(run_injected "$TEST_CLIENT" 127.0.0.1 "$HTTP_PORT" 2>&1)"
LOOP_STATUS=$?
set -e
echo "$LOOP_OUTPUT"
if [ "$LOOP_STATUS" -ne 0 ]; then
    echo "FAILED: test_client 直连本地回环 HTTP 服务失败 (exit $LOOP_STATUS)"
    exit 1
fi

if ! printf '%s\n' "$LOOP_OUTPUT" | grep -q '解析得到 IP: 127\.0\.0\.1'; then
    echo "FAILED: 回环地址未被直接解析"
    exit 1
fi

if printf '%s\n' "$LOOP_OUTPUT" | grep -q 'SOCKS5: 隧道建立成功'; then
    echo "FAILED: 回环流量不应经过 SOCKS5 代理"
    exit 1
fi

if ! printf '%s\n' "$LOOP_OUTPUT" | grep -q 'HTTP/1\.1 200 OK'; then
    echo "FAILED: 回环直连未收到 HTTP/1.1 200 OK"
    exit 1
fi

echo ""
echo "=== 所有测试均已通过！ ==="
