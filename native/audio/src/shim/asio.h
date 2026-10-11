// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
//
// RtAudio's ASIO backend does `#include "asio.h"`. Here that resolves to cwASIO's compatibility header
// (C declarations, so they are wrapped for C++).
#pragma once
extern "C" {
#include "../../vendor/cwasio/asio/asio.h"
}
