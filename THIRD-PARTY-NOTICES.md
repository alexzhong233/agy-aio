# Third-Party Notices

`agy-aio` is an orchestration layer. It vendors, adapts, or integrates source code and
prebuilt binaries from the following upstream open-source projects. Each entry records the
exact upstream commit that this repository is synchronized against (also machine-readable in
[`modules/upstream-versions.json`](modules/upstream-versions.json)).

Copyright in all third-party material remains with the respective authors. The notices below
are provided to satisfy the attribution requirements of the applicable licenses.

| Project | Commit | License | Material used in `agy-aio` |
| --- | --- | --- | --- |
| [Lumidarin/agy-capsule](https://github.com/Lumidarin/agy-capsule) | `0aa1ba4085f0bbf21871968c7c4bca30b4e78790` | MIT | Context/quota/metrics capsule plugin and CDP scripts (`modules/capsule/`) |
| [antigravity-cn-community/Antigravity-Chinese-Localization](https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization) | `409aea1d630150ce756153215b52c12f22e40446` | MIT | `app.asar` localization payload and DOM localization engine (`modules/localization/`) |
| [xinayida/anti-proxy](https://github.com/xinayida/anti-proxy) | `abdd2ac89f0e8ff732a6e739da0db383a52f3304` | **Unspecified upstream** (see note) | POSIX socket hook, FakeIP resolver, and Mach-O launcher concepts and code (`modules/proxy-posix/`); embeds `fishhook` (BSD-3-Clause) and `nlohmann/json` (MIT) |
| [yuaotian/antigravity-proxy](https://github.com/yuaotian/antigravity-proxy) | `ae910aa37beb85681ed8c485137c965b05cf25b1` | BSD-2-Clause | Windows prebuilt `version.dll` / `dbghelp.dll` + `antigravity_proxy.dll` release integration (`modules/proxy-win/` at install time) |

---

## 1. Lumidarin/agy-capsule

- Repository: https://github.com/Lumidarin/agy-capsule
- Commit: `0aa1ba4085f0bbf21871968c7c4bca30b4e78790`
- License: MIT
- Used for: Antigravity context-window / quota / turn-metrics capsule plugin, sidebar UI
  sidecars, and the CDP (Chrome DevTools Protocol) helper scripts that attach to the
  Antigravity renderer.
- Vendored at: `modules/capsule/` (see `modules/capsule/LICENSE`).

### MIT License

Copyright (c) the agy-capsule authors and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## 2. antigravity-cn-community/Antigravity-Chinese-Localization

- Repository: https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization
- Commit: `409aea1d630150ce756153215b52c12f22e40446`
- License: MIT
- Used for: the prebuilt localized `app.asar` payload (fetched or bundled at install time) and
  the DOM localization engine (dictionary, mutation-observer translator, injection builder,
  backup/restore utilities) under `modules/localization/`.
- Vendored at: `modules/localization/` (see `modules/localization/LICENSE`).

### MIT License

Copyright (c) the Antigravity Chinese Localization community contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## 3. xinayida/anti-proxy

- Repository: https://github.com/xinayida/anti-proxy
- Commit: `abdd2ac89f0e8ff732a6e739da0db383a52f3304`
- License: **No license is declared in the upstream repository at this commit.**
- Used for: the POSIX interception design and implementation — `getaddrinfo` / `connect` /
  `close` / `posix_spawn` hooks, FakeIP address-pool resolution, SOCKS5 and HTTP CONNECT
  tunneling, routing rules, and the Mach-O launcher that survives `DYLD_*` stripping. Adapted
  in `modules/proxy-posix/`.

> **License note:** upstream provides no explicit license file or grant, which means no rights
> are granted by default under copyright law. `agy-aio` therefore treats this module as an
> *external, user-supplied component*: the build step compiles it locally from source, the
> CLI never redistributes a compiled binary, and the module can be disabled or replaced via
> `agy-aio proxy --backend none`. Users who require a clear redistribution license for the
> POSIX proxy should obtain permission from the upstream author. If upstream later publishes a
> license, this notice will be updated to match.

### Embedded components

The upstream tree (and this adaptation) embeds the following separately licensed pieces:

#### fishhook — BSD-3-Clause

- Upstream: https://github.com/facebook/fishhook (via `xinayida/anti-proxy`)
- Files: `modules/proxy-posix/src/fishhook.c`, `modules/proxy-posix/include/fishhook.h`
- Copyright (c) 2013, Facebook, Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are
permitted provided that the following conditions are met:

- Redistributions of source code must retain the above copyright notice, this list of
  conditions and the following disclaimer.
- Redistributions in binary form must reproduce the above copyright notice, this list of
  conditions and the following disclaimer in the documentation and/or other materials provided
  with the distribution.
- Neither the name Facebook nor the names of its contributors may be used to endorse or promote
  products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

#### nlohmann/json — MIT

- Upstream: https://github.com/nlohmann/json
- File: `modules/proxy-posix/include/nlohmann/json.hpp`
- Copyright (c) 2013-2022 Niels Lohmann

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

## 4. yuaotian/antigravity-proxy

- Repository: https://github.com/yuaotian/antigravity-proxy
- Commit: `ae910aa37beb85681ed8c485137c965b05cf25b1`
- License: BSD-2-Clause
- Used for: the Windows side of the transparent proxy — prebuilt `version.dll` (Desktop/IDE
  proxy DLL), `dbghelp.dll` (CLI proxy DLL), and `antigravity_proxy.dll` (shared hook core),
  downloaded from the upstream GitHub Release and deployed by `agy-aio` at install time.
- Vendored at: downloaded into the user's Antigravity install prefix; not compiled from source
  by this repository.

### BSD 2-Clause License

Copyright (c) the antigravity-proxy authors

Redistribution and use in source and binary forms, with or without modification, are permitted
provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of
   conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of
   conditions and the following disclaimer in the documentation and/or other materials provided
   with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

---

## Trademarks

Antigravity, Google Cloud Code, and related marks are trademarks of Google LLC. `agy-aio` is an
independent community project and is not affiliated with, endorsed by, or sponsored by Google.
All other product names are trademarks or registered trademarks of their respective owners.
