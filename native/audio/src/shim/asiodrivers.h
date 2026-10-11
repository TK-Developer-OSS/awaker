// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
//
// The driver list / loader RtAudio's ASIO backend expects (`AsioDrivers`), written on top of cwASIO's
// enumeration and loading. Only the calls RtAudio makes are provided.
#pragma once

class AsioDrivers {
public:
  AsioDrivers();
  ~AsioDrivers();

  /** Number of installed ASIO drivers (re-read from the registry on every call). */
  long asioGetNumDev();
  /** Copies the name of driver `index` (0-based) into `name`; 0 = ok, otherwise an ASIO error. */
  long asioGetDriverName(long index, char *name, long size);
  /** Loads the driver with this name and makes it the one the ASIO* functions talk to. */
  bool loadDriver(char *name);
  /** Unloads the driver loaded by loadDriver(). */
  void removeCurrentDriver();

private:
  bool loaded_ = false;
};
