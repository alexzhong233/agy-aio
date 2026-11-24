#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <libgen.h>
#include <limits.h>
#include <sys/stat.h>

#ifdef __APPLE__
#include <mach-o/dyld.h>
#define PROXY_LIB_NAME "libantigravity_proxy.dylib"
#define PRELOAD_ENV_NAME "DYLD_INSERT_LIBRARIES"
#else
#define PROXY_LIB_NAME "libantigravity_proxy.so"
#define PRELOAD_ENV_NAME "LD_PRELOAD"
#endif

int main(int argc, char *argv[]) {
    char exec_path[PATH_MAX];
#ifdef __APPLE__
    uint32_t size = sizeof(exec_path);
    if (_NSGetExecutablePath(exec_path, &size) != 0) {
        perror("[anti-proxy-launcher] _NSGetExecutablePath failed");
        return 1;
    }
#else
    ssize_t exec_len = readlink("/proc/self/exe", exec_path, sizeof(exec_path) - 1);
    if (exec_len <= 0) {
        perror("[anti-proxy-launcher] readlink(/proc/self/exe) failed");
        return 1;
    }
    exec_path[exec_len] = '\0';
#endif

    char real_path[PATH_MAX];
    if (realpath(exec_path, real_path) == NULL) {
        strncpy(real_path, exec_path, sizeof(real_path) - 1);
        real_path[sizeof(real_path) - 1] = '\0';
    }

    // 获取所在目录
    char dir_buf[PATH_MAX];
    strncpy(dir_buf, real_path, sizeof(dir_buf) - 1);
    dir_buf[sizeof(dir_buf) - 1] = '\0';
    char *dir = dirname(dir_buf);

    // 目标原始程序路径: <real_path>.orig
    char orig_path[PATH_MAX];
    snprintf(orig_path, sizeof(orig_path), "%s.orig", real_path);

    // 检查 .orig 是否存在且可执行
    if (access(orig_path, X_OK) != 0) {
        fprintf(stderr, "[anti-proxy-launcher] 错误: 未找到原始程序备份: %s\n", orig_path);
        return 1;
    }

    // 动态库路径: 同目录下的 libantigravity_proxy.dylib / libantigravity_proxy.so
    char lib_path[PATH_MAX];
    snprintf(lib_path, sizeof(lib_path), "%s/%s", dir, PROXY_LIB_NAME);

    // 配置文件路径: 优先同目录 config.json，其次 ~/.agy-aio/config.json，最后 ~/.antigravity-proxy/config.json
    char config_path[PATH_MAX];
    snprintf(config_path, sizeof(config_path), "%s/config.json", dir);
    if (access(config_path, R_OK) != 0) {
        const char *home = getenv("HOME");
        if (home) {
            snprintf(config_path, sizeof(config_path), "%s/.agy-aio/config.json", home);
            if (access(config_path, R_OK) != 0) {
                snprintf(config_path, sizeof(config_path), "%s/.antigravity-proxy/config.json", home);
            }
        }
    }

    // 设置环境变量注入
    if (access(lib_path, R_OK) == 0) {
        setenv(PRELOAD_ENV_NAME, lib_path, 1);
    }
    if (access(config_path, R_OK) == 0) {
        setenv("ANTIGRAVITY_PROXY_CONFIG", config_path, 1);
    }

    // 原生 execv 替换当前进程
    execv(orig_path, argv);

    perror("[anti-proxy-launcher] execv failed");
    return 1;
}
