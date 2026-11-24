UNAME_S := $(shell uname -s)

CXX ?= clang++
CC ?= clang
CXXFLAGS ?= -std=c++17 -O2 -Wall -fPIC -Iinclude -Iinclude/nlohmann
CFLAGS ?= -O2 -Wall -fPIC -Iinclude

LAUNCHER = bin/anti-proxy-launcher
CDP_LAUNCHER = bin/agy-cdp-launcher

SRCS_CXX = src/Logger.cpp src/FakeIP.cpp src/Routing.cpp src/Config.cpp src/Hooks.cpp

ifeq ($(UNAME_S),Darwin)
TARGET = libantigravity_proxy.dylib
SRCS_C = src/fishhook.c
LIB_LDFLAGS = -dynamiclib
LDLIBS =
CODESIGN_BIN = codesign -f -s -
LAUNCHER_SIGN = $(CODESIGN_BIN) $(LAUNCHER)
else
TARGET = libantigravity_proxy.so
SRCS_C =
LIB_LDFLAGS = -shared
LDLIBS = -ldl -lpthread
CODESIGN_BIN = @:
LAUNCHER_SIGN = @:
endif

OBJS = $(SRCS_CXX:.cpp=.o) $(SRCS_C:.c=.o)

.PHONY: all clean universal test install cdp-launcher cdp-universal

all: $(TARGET) $(LAUNCHER) $(CDP_LAUNCHER)

$(TARGET): $(OBJS)
	$(CXX) $(LIB_LDFLAGS) -o $@ $^ $(LDLIBS) $(LDFLAGS)
	@echo "==> 成功生成 $(TARGET)"

$(LAUNCHER): src/launcher.c
	@mkdir -p bin
	$(CC) -O2 -Wall $< -o $@
	$(LAUNCHER_SIGN)
	@echo "==> 成功生成 $(LAUNCHER)"

$(CDP_LAUNCHER): src/cdp_launcher.c
	@mkdir -p bin
	$(CC) -O2 -Wall $< -o $@
	$(CODESIGN_BIN) $@
	@echo "==> 成功生成 $(CDP_LAUNCHER)"

cdp-launcher: $(CDP_LAUNCHER)

cdp-universal:
ifeq ($(UNAME_S),Darwin)
	@echo "==> 开始构建 CDP Launcher Universal Binary (arm64 + x86_64)..."
	@mkdir -p bin
	$(CC) -O2 -Wall -arch arm64 -arch x86_64 src/cdp_launcher.c -o $(CDP_LAUNCHER)
	$(CODESIGN_BIN) $(CDP_LAUNCHER)
	@file $(CDP_LAUNCHER)
else
	$(MAKE) $(CDP_LAUNCHER)
endif

%.o: %.cpp
	$(CXX) $(CXXFLAGS) -c $< -o $@

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

# 构建 Apple Silicon 与 Intel 架构通用二进制 (Universal Binary)
universal:
	@echo "==> 开始构建 Universal Binary (arm64 + x86_64)..."
	$(CC) -O2 -fPIC -Iinclude -arch arm64 -arch x86_64 -c src/fishhook.c -o src/fishhook.universal.o
	$(CXX) -std=c++17 -O2 -fPIC -Iinclude -Iinclude/nlohmann -arch arm64 -arch x86_64 -c src/Logger.cpp -o src/Logger.universal.o
	$(CXX) -std=c++17 -O2 -fPIC -Iinclude -Iinclude/nlohmann -arch arm64 -arch x86_64 -c src/FakeIP.cpp -o src/FakeIP.universal.o
	$(CXX) -std=c++17 -O2 -fPIC -Iinclude -Iinclude/nlohmann -arch arm64 -arch x86_64 -c src/Routing.cpp -o src/Routing.universal.o
	$(CXX) -std=c++17 -O2 -fPIC -Iinclude -Iinclude/nlohmann -arch arm64 -arch x86_64 -c src/Config.cpp -o src/Config.universal.o
	$(CXX) -std=c++17 -O2 -fPIC -Iinclude -Iinclude/nlohmann -arch arm64 -arch x86_64 -c src/Hooks.cpp -o src/Hooks.universal.o
	$(CXX) -dynamiclib -arch arm64 -arch x86_64 -o $(TARGET) \
		src/fishhook.universal.o src/Logger.universal.o src/FakeIP.universal.o \
		src/Routing.universal.o src/Config.universal.o src/Hooks.universal.o
	@rm -f src/*.universal.o
	@mkdir -p bin
	$(CC) -O2 -Wall -arch arm64 -arch x86_64 src/launcher.c -o $(LAUNCHER)
	codesign -f -s - $(LAUNCHER)
	$(CC) -O2 -Wall -arch arm64 -arch x86_64 src/cdp_launcher.c -o $(CDP_LAUNCHER)
	codesign -f -s - $(CDP_LAUNCHER)
	@echo "==> Universal Binary 构建完成:"
	@file $(TARGET)
	@file $(LAUNCHER)
	@file $(CDP_LAUNCHER)

test: all
	@bash tests/run_tests.sh

clean:
	rm -f src/*.o tests/test_client $(LAUNCHER) $(CDP_LAUNCHER) libantigravity_proxy.dylib libantigravity_proxy.so

install: all
	@mkdir -p ~/.antigravity-proxy
	@cp -f $(TARGET) ~/.antigravity-proxy/
	@cp -f $(LAUNCHER) ~/.antigravity-proxy/
	@if [ ! -f ~/.antigravity-proxy/config.json ]; then cp -n config.json ~/.antigravity-proxy/; fi
	@mkdir -p ~/.local/bin
	@cp -f bin/anti-proxy ~/.local/bin/
	@chmod +x ~/.local/bin/anti-proxy
	@echo "==> 安装完成至 ~/.antigravity-proxy 与 ~/.local/bin/anti-proxy"
