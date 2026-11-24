#include "Logger.hpp"
#include <pwd.h>
#include <cerrno>
#include <cstdint>

#if defined(__linux__)
#include <sys/syscall.h>
#endif

namespace Core {

std::mutex Logger::s_mutex;
LogLevel Logger::s_level = LogLevel::Info;
std::string Logger::s_logDir = "";
std::string Logger::s_currentDate = "";
std::ofstream Logger::s_fileStream;
bool Logger::s_initialized = false;

static std::string GetHomeDirectory() {
    const char* home = getenv("HOME");
    if (home && *home) return std::string(home);
    struct passwd* pw = getpwuid(getuid());
    if (pw && pw->pw_dir) return std::string(pw->pw_dir);
    return "/tmp";
}

// 允许通过 ANTIGRAVITY_PROXY_LOG_DIR 覆盖日志目录，否则使用 ~/.antigravity-proxy/logs
static std::string GetDefaultLogDir() {
    const char* envDir = getenv("ANTIGRAVITY_PROXY_LOG_DIR");
    if (envDir && *envDir) return std::string(envDir);
    return GetHomeDirectory() + "/.antigravity-proxy/logs";
}

// 递归创建目录（类似 mkdir -p），失败时不阻断日志流程
static void EnsureDirectoryExists(const std::string& path) {
    if (path.empty()) return;

    std::string current;
    size_t pos = 0;
    if (path[0] == '/') {
        current = "/";
        pos = 1;
    }

    while (pos <= path.size()) {
        size_t next = path.find('/', pos);
        size_t length = (next == std::string::npos) ? std::string::npos : next - pos;
        std::string part = path.substr(pos, length);

        if (!part.empty()) {
            if (!current.empty() && current.back() != '/') current += "/";
            current += part;
            if (mkdir(current.c_str(), 0755) != 0 && errno != EEXIST) {
                // 忽略创建失败，日志系统不应因此崩溃
            }
        }

        if (next == std::string::npos) break;
        pos = next + 1;
    }
}

void Logger::Init(const std::string& customLogDir) {
    std::lock_guard<std::mutex> lock(s_mutex);
    if (s_initialized && customLogDir.empty()) return;

    if (!customLogDir.empty()) {
        s_logDir = customLogDir;
    } else {
        s_logDir = GetDefaultLogDir();
    }

    EnsureDirectoryExists(s_logDir);

    s_initialized = true;
    EnsureFileOpen();
}

std::string Logger::GetLogDirectoryPath() {
    std::lock_guard<std::mutex> lock(s_mutex);
    if (!s_initialized) {
        return GetDefaultLogDir();
    }
    return s_logDir;
}

void Logger::SetLogLevel(LogLevel level) {
    std::lock_guard<std::mutex> lock(s_mutex);
    s_level = level;
}

bool Logger::IsEnabled(LogLevel level) {
    return static_cast<int>(level) >= static_cast<int>(s_level);
}

std::string Logger::CurrentDateString() {
    auto now = std::chrono::system_clock::now();
    std::time_t t = std::chrono::system_clock::to_time_t(now);
    std::tm tm{};
    localtime_r(&t, &tm);
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y%m%d", &tm);
    return std::string(buf);
}

std::string Logger::CurrentTimestampString() {
    auto now = std::chrono::system_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()) % 1000;
    std::time_t t = std::chrono::system_clock::to_time_t(now);
    std::tm tm{};
    localtime_r(&t, &tm);
    char buf[64];
    std::strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &tm);
    std::ostringstream oss;
    oss << buf << '.' << std::setfill('0') << std::setw(3) << ms.count();
    return oss.str();
}

void Logger::EnsureFileOpen() {
    std::string today = CurrentDateString();
    if (s_fileStream.is_open() && s_currentDate == today) {
        return;
    }

    if (s_fileStream.is_open()) {
        s_fileStream.close();
    }

    s_currentDate = today;
    if (s_logDir.empty()) {
        s_logDir = GetDefaultLogDir();
    }
    EnsureDirectoryExists(s_logDir);

    std::string filePath = s_logDir + "/proxy-" + today + ".log";
    s_fileStream.open(filePath, std::ios::app);
}

void Logger::Log(LogLevel level, std::string_view msg) {
    if (!IsEnabled(level)) return;

    std::lock_guard<std::mutex> lock(s_mutex);
    if (!s_initialized) {
        s_logDir = GetDefaultLogDir();
        EnsureDirectoryExists(s_logDir);
        s_initialized = true;
    }
    EnsureFileOpen();

    const char* levelStr = "INFO";
    const char* colorCode = "\033[0m";
    switch (level) {
        case LogLevel::Debug: levelStr = "DEBUG"; colorCode = "\033[36m"; break; // Cyan
        case LogLevel::Info:  levelStr = "INFO "; colorCode = "\033[32m"; break; // Green
        case LogLevel::Warn:  levelStr = "WARN "; colorCode = "\033[33m"; break; // Yellow
        case LogLevel::Error: levelStr = "ERROR"; colorCode = "\033[31m"; break; // Red
    }

    std::string timestamp = CurrentTimestampString();
    pid_t pid = getpid();
    uint64_t tid = 0;
#ifdef __APPLE__
    pthread_threadid_np(NULL, &tid);
#elif defined(__linux__)
    tid = static_cast<uint64_t>(syscall(SYS_gettid));
#else
    tid = static_cast<uint64_t>(pthread_self());
#endif

    // Format: [2026-09-24 11:30:00.123] [PID:1234][TID:5678] [INFO ] message
    std::ostringstream prefix;
    prefix << "[" << timestamp << "] [PID:" << pid << "][TID:" << tid << "] [" << levelStr << "] ";

    std::string fullLine = prefix.str() + std::string(msg);

    // Write to file
    if (s_fileStream.is_open()) {
        s_fileStream << fullLine << "\n";
        s_fileStream.flush();
    }

    // Write to stderr
    std::cerr << colorCode << fullLine << "\033[0m\n";
}

void Logger::Debug(std::string_view msg) { Log(LogLevel::Debug, msg); }
void Logger::Info(std::string_view msg)  { Log(LogLevel::Info, msg); }
void Logger::Warn(std::string_view msg)  { Log(LogLevel::Warn, msg); }
void Logger::Error(std::string_view msg) { Log(LogLevel::Error, msg); }

} // namespace Core
