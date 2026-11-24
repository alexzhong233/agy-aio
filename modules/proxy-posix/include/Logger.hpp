#pragma once

#include <string>
#include <string_view>
#include <mutex>
#include <fstream>
#include <iostream>
#include <sstream>
#include <chrono>
#include <iomanip>
#include <unistd.h>
#include <pthread.h>
#include <sys/stat.h>

namespace Core {

enum class LogLevel {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3
};

class Logger {
public:
    static void Init(const std::string& customLogDir = "");
    static void SetLogLevel(LogLevel level);
    static bool IsEnabled(LogLevel level);

    static void Debug(std::string_view msg);
    static void Info(std::string_view msg);
    static void Warn(std::string_view msg);
    static void Error(std::string_view msg);

    static std::string GetLogDirectoryPath();

private:
    static void Log(LogLevel level, std::string_view msg);
    static void EnsureFileOpen();
    static std::string CurrentDateString();
    static std::string CurrentTimestampString();

    static std::mutex s_mutex;
    static LogLevel s_level;
    static std::string s_logDir;
    static std::string s_currentDate;
    static std::ofstream s_fileStream;
    static bool s_initialized;
};

} // namespace Core
