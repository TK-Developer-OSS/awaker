// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { isSoftwareAdapter } from '../src/renderer/src/gpu/software-adapter'

let fails = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', name, extra)
}

check('SwiftShader (vendor google) is software', isSoftwareAdapter({ vendor: 'google', architecture: 'swiftshader' }))
check('SwiftShader named in the description is software', isSoftwareAdapter({ vendor: '', description: 'Google SwiftShader Device (LLVM)' }))
check('Microsoft WARP is software', isSoftwareAdapter({ vendor: 'microsoft', architecture: 'warp' }))
check('the fallback flag on the info is software', isSoftwareAdapter({ vendor: 'x', isFallbackAdapter: true }))
check('the fallback flag on the adapter is software', isSoftwareAdapter({ vendor: 'x' }, true))
check('NVIDIA is a GPU', !isSoftwareAdapter({ vendor: 'nvidia', architecture: 'ampere' }))
check('Intel (even an old one) is a GPU', !isSoftwareAdapter({ vendor: 'intel', architecture: 'gen-7' }))
check('AMD is a GPU', !isSoftwareAdapter({ vendor: 'amd', architecture: 'rdna-2' }))
check('no info at all is not called software', !isSoftwareAdapter(undefined))

if (fails) {
  console.log(`${fails} check(s) FAILED`)
  process.exit(1)
}
