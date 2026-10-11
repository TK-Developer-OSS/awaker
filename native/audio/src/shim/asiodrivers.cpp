// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0

#include "asiodrivers.h"

#include <cstring>
#include <string>
#include <vector>

extern "C" {
#include "../../vendor/cwasio/cwASIO.h"
#include "../../vendor/cwasio/asio/asio.h"
}

namespace {

struct Entry {
  std::string name;
  std::string id;
};

bool collect(void *context, char const *name, char const *id, char const *) {
  auto *list = static_cast<std::vector<Entry> *>(context);
  if (name && *name && id && *id) list->push_back({name, id});
  return true;
}

std::vector<Entry> installed() {
  std::vector<Entry> list;
  cwASIOenumerate(&collect, &list);
  return list;
}

}  // namespace

AsioDrivers::AsioDrivers() = default;

AsioDrivers::~AsioDrivers() = default;

long AsioDrivers::asioGetNumDev() {
  return static_cast<long>(installed().size());
}

long AsioDrivers::asioGetDriverName(long index, char *name, long size) {
  const auto list = installed();
  if (index < 0 || index >= static_cast<long>(list.size()) || !name || size <= 0) return ASE_NotPresent;
  std::strncpy(name, list[static_cast<size_t>(index)].name.c_str(), static_cast<size_t>(size) - 1);
  name[size - 1] = '\0';
  return 0;
}

bool AsioDrivers::loadDriver(char *name) {
  if (!name) return false;
  if (loaded_) removeCurrentDriver();
  for (const auto &e : installed()) {
    if (e.name == name) {
      if (ASIOLoad(e.id.c_str(), e.name.c_str()) == ASE_OK) {
        loaded_ = true;
        return true;
      }
      return false;
    }
  }
  return false;
}

void AsioDrivers::removeCurrentDriver() {
  if (loaded_) {
    ASIOUnload();
    loaded_ = false;
  }
}
