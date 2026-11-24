cmake_minimum_required(VERSION 3.16)
project(antigravity_proxy LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

include_directories(include include/nlohmann)

set(SOURCES
    src/Logger.cpp
    src/FakeIP.cpp
    src/Routing.cpp
    src/Config.cpp
    src/Hooks.cpp
)

if(APPLE)
    list(APPEND SOURCES src/fishhook.c)
elseif(UNIX)
    # Linux 使用 ELF 符号抢占，无需 fishhook
endif()

add_library(antigravity_proxy SHARED ${SOURCES})

if(APPLE)
    set_target_properties(antigravity_proxy PROPERTIES
        OUTPUT_NAME "antigravity_proxy"
        PREFIX "lib"
        SUFFIX ".dylib"
    )

    # Optional Universal Binary support
    if(BUILD_UNIVERSAL)
        set_target_properties(antigravity_proxy PROPERTIES
            OSX_ARCHITECTURES "arm64;x86_64"
        )
    endif()
elseif(UNIX)
    set_target_properties(antigravity_proxy PROPERTIES
        OUTPUT_NAME "antigravity_proxy"
        PREFIX "lib"
        SUFFIX ".so"
    )
    target_link_libraries(antigravity_proxy PRIVATE dl pthread)
endif()
