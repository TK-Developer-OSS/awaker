// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
//
// Not needed: cwASIO calls the driver through its own C vtable, so there is no `thiscall` problem to work
// around. Present only so RtAudio's `#include` finds a file.
#pragma once
