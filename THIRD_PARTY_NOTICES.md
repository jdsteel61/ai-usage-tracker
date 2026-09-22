# Third-party notices

This project is a new implementation, but it builds on published, MIT-licensed
work from three open-source projects that were inspected during development.
Their licenses are preserved below as required. No code was copied verbatim
in significant quantity; where a specific mechanism was adapted, the source
file credits the origin.

## Adapted mechanisms

- **agent-usage-widget** (MIT, declared in its package.json, (c) chunnytechmate,
  https://github.com/chunnytechmate/agent-usage-widget): the Codex CLI
  `app-server` JSON-RPC handshake used in `src/main/providers/codex.js`
  (initialize -> initialized -> `account/rateLimits/read`) was adapted from
  its `src/gpt.js`. The idea of reading the Claude OAuth usage endpoint by
  reusing the Claude Code login (its `src/usage.js`) informed
  `src/main/providers/claude.js`. The Z.ai peak-hours schedule and
  Beijing-clock arithmetic in `src/main/peak.js` were adapted from its
  `src/peak.js` (schedule as published by Zhipu / BigModel).
- **UsageDeck** (MIT, (c) lamchun1110, deviffyy,
  https://github.com/lamchun1110/UsageDeck): the Z.ai Coding Plan quota
  schema classification (unit codes 3/4/5/6, session < 24h, web-search
  `TIME_LIMIT` entries) in `src/main/providers/zai.js` follows the mapping
  documented in its `src-tauri/src/providers/zai/mapper.rs`, and its
  normalized `QuotaWindow` model shaped our provider interface.
- **codex-usage-monitor** (MIT, (c) Craig Constable,
  https://github.com/upstream-ray/codex-usage-monitor): consulted as a native
  Windows/Rust reference for Codex/Claude quota collection and tray
  behavior. No code was reused.

The upstream repositories were cloned read-only into `.upstream/` during
development for inspection and are excluded from the packaged app.

---

## UsageDeck - MIT License

MIT License

Copyright (c) 2026 lamchun1110
Copyright (c) 2026 deviffyy

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

## agent-usage-widget - MIT License

MIT License

Copyright (c) 2026 chunnytechmate

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

## codex-usage-monitor - MIT License

MIT License

Copyright (c) 2025 Craig Constable (github.com/upstream-ray)

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
