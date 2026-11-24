/*
 * agy-aio CDP launcher
 *
 * Native Mach-O / ELF shim that replaces the main Antigravity binary when
 * `--cdp-mode native` is used.  When the original Antigravity.app is launched
 * from the Dock, Finder or Spotlight, this wrapper transparently forwards the
 * launch to the real binary (`.orig`) while attaching local CDP flags.  This
 * keeps the Dock / Finder identity of the original app instead of producing an
 * extra Antigravity-CDP.app icon.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <limits.h>

#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

static const char CDP_LAUNCHER_MARKER[] = "agy-aio-cdp-launcher";

/*
 * Keep the marker string present in the binary regardless of optimizer level.
 * `used` prevents the compiler from discarding the symbol under -O2, and the
 * return value is consumed by the error paths below.
 */
__attribute__((used)) static const char *cdp_launcher_marker(void) {
    return CDP_LAUNCHER_MARKER;
}

int main(int argc, char *argv[]) {
    char exec_path[PATH_MAX];

#ifdef __APPLE__
    uint32_t size = (uint32_t)sizeof(exec_path);
    if (_NSGetExecutablePath(exec_path, &size) != 0) {
        /* Buffer too small: allocate the required size and retry. */
        char *big = (char *)malloc((size_t)size);
        if (big == NULL) {
            fprintf(stderr, "[%s] error: failed to allocate executable path buffer\n",
                    cdp_launcher_marker());
            return 1;
        }
        if (_NSGetExecutablePath(big, &size) != 0) {
            fprintf(stderr, "[%s] error: _NSGetExecutablePath failed\n",
                    cdp_launcher_marker());
            free(big);
            return 1;
        }
        strncpy(exec_path, big, sizeof(exec_path) - 1);
        exec_path[sizeof(exec_path) - 1] = '\0';
        free(big);
    }
#else
    ssize_t exec_len = readlink("/proc/self/exe", exec_path, sizeof(exec_path) - 1);
    if (exec_len <= 0) {
        fprintf(stderr, "[%s] error: readlink(/proc/self/exe) failed\n",
                cdp_launcher_marker());
        return 1;
    }
    exec_path[exec_len] = '\0';
#endif

    /* Resolve the real path of this launcher, falling back to the raw path. */
    char real_path[PATH_MAX];
    if (realpath(exec_path, real_path) == NULL) {
        strncpy(real_path, exec_path, sizeof(real_path) - 1);
        real_path[sizeof(real_path) - 1] = '\0';
    }

    /* The original binary lives next to the launcher with a ".orig" suffix. */
    char orig_path[PATH_MAX];
    int written = snprintf(orig_path, sizeof(orig_path), "%s.orig", real_path);
    if (written < 0 || (size_t)written >= sizeof(orig_path)) {
        fprintf(stderr, "[%s] error: original binary path too long: %s.orig\n",
                cdp_launcher_marker(), real_path);
        return 1;
    }

    if (access(orig_path, X_OK) != 0) {
        fprintf(stderr, "[%s] error: original binary not found: %s\n",
                cdp_launcher_marker(), orig_path);
        return 1;
    }

    /* Detect whether the caller already supplied debugging flags. */
    int has_port = 0;
    int has_addr = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--remote-debugging-port") == 0 ||
            strncmp(argv[i], "--remote-debugging-port=", 24) == 0) {
            has_port = 1;
        }
        if (strcmp(argv[i], "--remote-debugging-address") == 0 ||
            strncmp(argv[i], "--remote-debugging-address=", 27) == 0) {
            has_addr = 1;
        }
    }

    char **new_argv = (char **)calloc((size_t)argc + 3, sizeof(char *));
    if (new_argv == NULL) {
        fprintf(stderr, "[%s] error: out of memory building argument vector\n",
                cdp_launcher_marker());
        return 1;
    }

    int n = 0;
    new_argv[n++] = argv[0];
    if (!has_port) {
        new_argv[n++] = "--remote-debugging-port=0";
    }
    if (!has_addr) {
        new_argv[n++] = "--remote-debugging-address=127.0.0.1";
    }
    for (int i = 1; i < argc; i++) {
        new_argv[n++] = argv[i];
    }
    new_argv[n] = NULL;

    execv(orig_path, new_argv);

    /* execv only returns on failure. */
    perror("[agy-aio-cdp-launcher] execv failed");
    free(new_argv);
    return 1;
}
