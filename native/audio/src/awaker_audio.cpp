// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)
//
// Awaker's native audio output / input module: RtAudio (WASAPI + ASIO through cwASIO) behind a small
// Node-API surface. It offers the subset of `audify`'s RtAudio class that the app uses, with the same
// semantics (a queue of output blocks written from JS, a "frame output" callback each time a block was
// consumed, an input callback per input block) — so the app's audio-out.ts needs no change.
//
// Built with MinGW (no MSVC). Node-API functions are looked up in the host executable at run time
// (GetProcAddress), so no import library is needed and the same binary loads in Node and in Electron.

#include <windows.h>

#include <cmath>
#include <cstdint>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#include "RtAudio.h"
#include "node_api.h"

// ---- Node-API, resolved from the host process ---------------------------------------------------------

#define NAPI_FUNCTIONS(X)                                                                                          \
  X(napi_create_function) X(napi_set_named_property) X(napi_get_cb_info) X(napi_typeof) X(napi_get_value_int32)    \
  X(napi_get_value_uint32) X(napi_get_value_double) X(napi_get_value_bool) X(napi_get_value_string_utf8)           \
  X(napi_create_int32) X(napi_create_uint32) X(napi_create_double) X(napi_create_string_utf8) X(napi_create_object) \
  X(napi_create_array_with_length) X(napi_set_element) X(napi_get_boolean) X(napi_get_undefined) X(napi_get_null)   \
  X(napi_get_named_property) X(napi_has_named_property) X(napi_get_buffer_info) X(napi_create_buffer_copy)         \
  X(napi_throw_error) X(napi_create_threadsafe_function) X(napi_call_threadsafe_function)                          \
  X(napi_release_threadsafe_function) X(napi_unref_threadsafe_function) X(napi_call_function)

namespace {

struct NapiTable {
#define DECL(n) decltype(&n) n;
  NAPI_FUNCTIONS(DECL)
#undef DECL
} N;

bool loadNapi() {
  HMODULE host = GetModuleHandleW(nullptr);
  bool ok = true;
#define LOAD(n)                                                   \
  N.n = reinterpret_cast<decltype(&n)>(GetProcAddress(host, #n)); \
  ok = ok && N.n != nullptr;
  NAPI_FUNCTIONS(LOAD)
#undef LOAD
  return ok;
}

// ---- helpers --------------------------------------------------------------------------------------------

struct Args {
  napi_env env;
  napi_value v[12];
  size_t n = 0;

  Args(napi_env e, napi_callback_info info) : env(e) {
    n = 12;
    N.napi_get_cb_info(env, info, &n, v, nullptr, nullptr);
  }
  bool isNullish(size_t i) const {
    if (i >= n) return true;
    napi_valuetype t;
    N.napi_typeof(env, v[i], &t);
    return t == napi_undefined || t == napi_null;
  }
  bool isFunction(size_t i) const {
    if (i >= n) return false;
    napi_valuetype t;
    N.napi_typeof(env, v[i], &t);
    return t == napi_function;
  }
  double num(size_t i, double def = 0) const {
    if (i >= n) return def;
    double d = def;
    if (N.napi_get_value_double(env, v[i], &d) != napi_ok) return def;
    return d;
  }
  std::string str(size_t i) const {
    if (i >= n) return {};
    size_t len = 0;
    N.napi_get_value_string_utf8(env, v[i], nullptr, 0, &len);
    std::string s(len, '\0');
    size_t got = 0;
    N.napi_get_value_string_utf8(env, v[i], s.data(), len + 1, &got);
    s.resize(got);
    return s;
  }
};

napi_value undef(napi_env env) {
  napi_value r = nullptr;
  N.napi_get_undefined(env, &r);
  return r;
}
napi_value num(napi_env env, double d) {
  napi_value r = nullptr;
  N.napi_create_double(env, d, &r);
  return r;
}
napi_value boolean(napi_env env, bool b) {
  napi_value r = nullptr;
  N.napi_get_boolean(env, b, &r);
  return r;
}
napi_value text(napi_env env, const std::string &s) {
  napi_value r = nullptr;
  N.napi_create_string_utf8(env, s.c_str(), s.size(), &r);
  return r;
}
void setProp(napi_env env, napi_value obj, const char *name, napi_value value) {
  N.napi_set_named_property(env, obj, name, value);
}
napi_value fail(napi_env env, const std::string &msg) {
  N.napi_throw_error(env, nullptr, msg.c_str());
  return nullptr;
}

// ---- one RtAudio instance ---------------------------------------------------------------------------

struct InputBlock {
  std::vector<uint8_t> data;
};
struct ErrorMsg {
  int type;
  std::string msg;
};

struct Wrap {
  std::unique_ptr<RtAudio> rt;
  unsigned int frameSize = 0;
  unsigned int inChannels = 0;
  unsigned int outChannels = 0;
  unsigned int sampleSize = 0;
  RtAudioFormat format = RTAUDIO_FLOAT32;

  std::mutex tsfnMutex;
  napi_threadsafe_function inputTsfn = nullptr;
  napi_threadsafe_function frameTsfn = nullptr;
  napi_threadsafe_function errorTsfn = nullptr;

  std::mutex outMutex;
  std::deque<std::vector<uint8_t>> outq;
  double volume = 1.0;
  double mult = 1.0;
};

std::mutex g_tableMutex;
std::vector<std::unique_ptr<Wrap>> g_wraps;  // handle = index + 1; nullptr = destroyed

Wrap *get(napi_env env, const Args &a, size_t i = 0) {
  const int h = static_cast<int>(a.num(i, 0));
  std::lock_guard<std::mutex> lk(g_tableMutex);
  if (h < 1 || h > static_cast<int>(g_wraps.size()) || !g_wraps[h - 1]) {
    fail(env, "invalid or destroyed audio handle");
    return nullptr;
  }
  return g_wraps[h - 1].get();
}

unsigned int sampleSizeFor(RtAudioFormat f) {
  switch (f) {
    case RTAUDIO_SINT8: return 1;
    case RTAUDIO_SINT16: return 2;
    case RTAUDIO_SINT24: return 3;
    case RTAUDIO_SINT32:
    case RTAUDIO_FLOAT32: return 4;
    case RTAUDIO_FLOAT64: return 8;
    default: return 0;
  }
}

// ---- thread-safe calls into JS ---------------------------------------------------------------------

void callFrame(napi_env env, napi_value cb, void *, void *) {
  if (!env || !cb) return;
  napi_value recv = undef(env);
  N.napi_call_function(env, recv, cb, 0, nullptr, nullptr);
}

void callInput(napi_env env, napi_value cb, void *, void *data) {
  auto *blk = static_cast<InputBlock *>(data);
  if (env && cb && blk) {
    napi_value buf = nullptr;
    void *copy = nullptr;
    if (N.napi_create_buffer_copy(env, blk->data.size(), blk->data.data(), &copy, &buf) == napi_ok) {
      napi_value recv = undef(env);
      N.napi_call_function(env, recv, cb, 1, &buf, nullptr);
    }
  }
  delete blk;
}

void callError(napi_env env, napi_value cb, void *, void *data) {
  auto *e = static_cast<ErrorMsg *>(data);
  if (env && cb && e) {
    napi_value argv[2];
    N.napi_create_int32(env, e->type, &argv[0]);
    argv[1] = text(env, e->msg);
    napi_value recv = undef(env);
    N.napi_call_function(env, recv, cb, 2, argv, nullptr);
  }
  delete e;
}

napi_threadsafe_function makeTsfn(napi_env env, napi_value fn, const char *name, napi_threadsafe_function_call_js js) {
  napi_threadsafe_function t = nullptr;
  napi_value res = text(env, name);
  if (N.napi_create_threadsafe_function(env, fn, nullptr, res, 0, 1, nullptr, nullptr, nullptr, js, &t) != napi_ok) {
    return nullptr;
  }
  N.napi_unref_threadsafe_function(env, t);  // an open stream must not keep the process alive by itself
  return t;
}

void releaseTsfn(napi_threadsafe_function &t) {
  if (t) {
    N.napi_release_threadsafe_function(t, napi_tsfn_release);
    t = nullptr;
  }
}

void releaseAll(Wrap *w) {
  std::lock_guard<std::mutex> lk(w->tsfnMutex);
  releaseTsfn(w->inputTsfn);
  releaseTsfn(w->frameTsfn);
  releaseTsfn(w->errorTsfn);
}

// ---- the RtAudio callback (device thread) ----------------------------------------------------------

int rtCallback(void *outputBuffer, void *inputBuffer, unsigned int nFrames, double, RtAudioStreamStatus, void *user) {
  auto *w = static_cast<Wrap *>(user);
  if (nFrames != w->frameSize) return 0;
  const size_t outBytes = static_cast<size_t>(w->frameSize) * w->outChannels * w->sampleSize;
  bool popped = false;

  if (w->outChannels && outputBuffer) {
    std::lock_guard<std::mutex> lk(w->outMutex);
    if (!w->outq.empty()) {
      const std::vector<uint8_t> &front = w->outq.front();
      if (w->mult == 1.0 || w->format != RTAUDIO_FLOAT32) {
        std::memcpy(outputBuffer, front.data(), outBytes);
      } else {
        const float *src = reinterpret_cast<const float *>(front.data());
        float *dst = static_cast<float *>(outputBuffer);
        const size_t count = outBytes / sizeof(float);
        const float m = static_cast<float>(w->mult);
        for (size_t i = 0; i < count; i++) dst[i] = src[i] * m;
      }
      w->outq.pop_front();
      popped = true;
    } else {
      std::memset(outputBuffer, 0, outBytes);
    }
  }
  if (popped) {
    std::lock_guard<std::mutex> lk(w->tsfnMutex);
    if (w->frameTsfn) N.napi_call_threadsafe_function(w->frameTsfn, nullptr, napi_tsfn_nonblocking);
  }
  if (w->inChannels && inputBuffer) {
    std::lock_guard<std::mutex> lk(w->tsfnMutex);
    if (w->inputTsfn) {
      auto *blk = new InputBlock;
      const size_t inBytes = static_cast<size_t>(w->frameSize) * w->inChannels * w->sampleSize;
      blk->data.assign(static_cast<const uint8_t *>(inputBuffer), static_cast<const uint8_t *>(inputBuffer) + inBytes);
      if (N.napi_call_threadsafe_function(w->inputTsfn, blk, napi_tsfn_nonblocking) != napi_ok) delete blk;
    }
  }
  return 0;
}

std::string rtErrorText(Wrap *w, RtAudioErrorType e) {
  std::ostringstream ss;
  ss << "RtAudio Error: Code: " << static_cast<uint32_t>(e) << ", Message: '" << w->rt->getErrorText() << "'";
  return ss.str();
}

bool rtOk(RtAudioErrorType e) {
  return e == RTAUDIO_NO_ERROR || e == RTAUDIO_WARNING;
}

// ---- JS-facing functions: every one takes the handle first -------------------------------------------

napi_value fnCreate(napi_env env, napi_callback_info info) {
  Args a(env, info);
  const auto api = static_cast<RtAudio::Api>(static_cast<int>(a.num(0, 0)));
  auto w = std::make_unique<Wrap>();
  Wrap *raw = w.get();
  try {
    w->rt = std::make_unique<RtAudio>(api, [raw](RtAudioErrorType type, const std::string &msg) {
      std::lock_guard<std::mutex> lk(raw->tsfnMutex);
      if (raw->errorTsfn) {
        auto *e = new ErrorMsg{static_cast<int>(type), msg};
        if (N.napi_call_threadsafe_function(raw->errorTsfn, e, napi_tsfn_nonblocking) != napi_ok) delete e;
      }
    });
  } catch (const std::exception &ex) {
    return fail(env, ex.what());
  }
  std::lock_guard<std::mutex> lk(g_tableMutex);
  g_wraps.push_back(std::move(w));
  napi_value r = nullptr;
  N.napi_create_int32(env, static_cast<int32_t>(g_wraps.size()), &r);
  return r;
}

napi_value fnDestroy(napi_env env, napi_callback_info info) {
  Args a(env, info);
  std::unique_ptr<Wrap> victim;
  {
    const int h = static_cast<int>(a.num(0, 0));
    std::lock_guard<std::mutex> lk(g_tableMutex);
    if (h >= 1 && h <= static_cast<int>(g_wraps.size())) victim = std::move(g_wraps[h - 1]);
  }
  if (victim) {
    try {
      if (victim->rt && victim->rt->isStreamOpen()) victim->rt->closeStream();
    } catch (...) {
    }
    releaseAll(victim.get());
  }
  return undef(env);
}

napi_value deviceObject(napi_env env, const RtAudio::DeviceInfo &d) {
  napi_value o = nullptr;
  N.napi_create_object(env, &o);
  setProp(env, o, "id", num(env, d.ID));
  setProp(env, o, "name", text(env, d.name));
  setProp(env, o, "outputChannels", num(env, d.outputChannels));
  setProp(env, o, "inputChannels", num(env, d.inputChannels));
  setProp(env, o, "duplexChannels", num(env, d.duplexChannels));
  setProp(env, o, "isDefaultOutput", num(env, d.isDefaultOutput));
  setProp(env, o, "isDefaultInput", num(env, d.isDefaultInput));
  napi_value rates = nullptr;
  N.napi_create_array_with_length(env, d.sampleRates.size(), &rates);
  for (size_t i = 0; i < d.sampleRates.size(); i++) N.napi_set_element(env, rates, static_cast<uint32_t>(i), num(env, d.sampleRates[i]));
  setProp(env, o, "sampleRates", rates);
  setProp(env, o, "preferredSampleRate", num(env, d.preferredSampleRate));
  setProp(env, o, "nativeFormats", num(env, d.nativeFormats));
  return o;
}

napi_value fnGetDevices(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  if (!w) return nullptr;
  const std::vector<unsigned int> ids = w->rt->getDeviceIds();
  napi_value arr = nullptr;
  N.napi_create_array_with_length(env, ids.size(), &arr);
  for (size_t i = 0; i < ids.size(); i++) {
    N.napi_set_element(env, arr, static_cast<uint32_t>(i), deviceObject(env, w->rt->getDeviceInfo(ids[i])));
  }
  return arr;
}

napi_value fnDefaultInput(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  return w ? num(env, w->rt->getDefaultInputDevice()) : nullptr;
}

napi_value fnDefaultOutput(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  return w ? num(env, w->rt->getDefaultOutputDevice()) : nullptr;
}

/** { deviceId?, firstChannel?, nChannels } as in audify, with the same "old index vs unique id" rule. */
bool readParams(napi_env env, napi_value obj, bool isInput, RtAudio &rt, RtAudio::StreamParameters &out, std::string &err) {
  auto getNum = [&](const char *key, bool &has, double &val) {
    bool h = false;
    N.napi_has_named_property(env, obj, key, &h);
    has = h;
    val = 0;
    if (h) {
      napi_value v = nullptr;
      N.napi_get_named_property(env, obj, key, &v);
      napi_valuetype t;
      N.napi_typeof(env, v, &t);
      if (t != napi_number) {
        has = false;
        return false;
      }
      N.napi_get_value_double(env, v, &val);
    }
    return true;
  };
  bool has = false;
  double val = 0;
  if (!getNum("deviceId", has, val)) {
    err = "The 'device id' stream parameter is missing or invalid!";
    return false;
  }
  if (!has) {
    out.deviceId = isInput ? rt.getDefaultInputDevice() : rt.getDefaultOutputDevice();
  } else {
    out.deviceId = static_cast<unsigned int>(val);
    if (out.deviceId < 129) {  // an old-style index rather than RtAudio 6's unique id
      const auto ids = rt.getDeviceIds();
      if (out.deviceId >= ids.size()) {
        err = "The 'device id' stream parameter is invalid!";
        return false;
      }
      out.deviceId = ids[out.deviceId];
    }
  }
  if (!getNum("firstChannel", has, val)) {
    err = "The 'first channel' stream parameter is missing or invalid!";
    return false;
  }
  out.firstChannel = has ? static_cast<unsigned int>(val) : 0;
  bool hasN = false;
  double n = 0;
  getNum("nChannels", hasN, n);
  if (!hasN) {
    err = "The 'no. of channels' stream parameter is missing or invalid!";
    return false;
  }
  out.nChannels = static_cast<unsigned int>(n);
  return true;
}

// openStream(h, out|null, in|null, format, sampleRate, frameSize, streamName, inputCb|null, frameOutCb|null, flags, errorCb|null)
napi_value fnOpenStream(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  if (!w) return nullptr;
  const bool hasOut = !a.isNullish(1);
  const bool hasIn = !a.isNullish(2);
  RtAudio::StreamParameters outP, inP;
  std::string err;
  if (hasOut && !readParams(env, a.v[1], false, *w->rt, outP, err)) return fail(env, err);
  if (hasIn && !readParams(env, a.v[2], true, *w->rt, inP, err)) return fail(env, err);

  const auto format = static_cast<RtAudioFormat>(static_cast<unsigned long>(a.num(3, 0)));
  const auto sampleRate = static_cast<unsigned int>(a.num(4, 0));
  unsigned int frameSize = static_cast<unsigned int>(a.num(5, 0));
  const std::string streamName = a.str(6);
  const unsigned int flags = a.n > 9 && !a.isNullish(9) ? static_cast<unsigned int>(a.num(9, 0)) : 0;
  if (format == RTAUDIO_SINT24) return fail(env, "24-bit signed integer is not available!");

  releaseAll(w);  // callbacks of a previous open
  w->inChannels = hasIn ? inP.nChannels : 0;
  w->outChannels = hasOut ? outP.nChannels : 0;
  w->sampleSize = sampleSizeFor(format);
  w->format = format;

  if (a.isFunction(10)) {
    std::lock_guard<std::mutex> lk(w->tsfnMutex);
    w->errorTsfn = makeTsfn(env, a.v[10], "awakerAudioError", callError);
  }

  RtAudio::StreamOptions options;
  options.flags = flags;
  options.streamName = streamName;
  const RtAudioErrorType e = w->rt->openStream(hasOut ? &outP : nullptr, hasIn ? &inP : nullptr, format, sampleRate,
                                               &frameSize, rtCallback, w, &options);
  if (!rtOk(e)) return fail(env, rtErrorText(w, e));
  w->frameSize = frameSize;  // may have been changed by the driver / 0 for "default"

  {
    std::lock_guard<std::mutex> lk(w->tsfnMutex);
    if (hasIn && a.isFunction(7)) w->inputTsfn = makeTsfn(env, a.v[7], "awakerAudioInput", callInput);
    if (hasOut && a.isFunction(8)) w->frameTsfn = makeTsfn(env, a.v[8], "awakerAudioFrame", callFrame);
  }
  return num(env, w->frameSize);
}

napi_value fnCloseStream(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  if (!w) return nullptr;
  w->rt->closeStream();
  return undef(env);
}

napi_value fnIsStreamOpen(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  return w ? boolean(env, w->rt->isStreamOpen()) : nullptr;
}

napi_value fnIsStreamRunning(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  return w ? boolean(env, w->rt->isStreamRunning()) : nullptr;
}

napi_value fnStart(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  if (!w) return nullptr;
  const RtAudioErrorType e = w->rt->startStream();
  if (!rtOk(e)) return fail(env, rtErrorText(w, e));
  return undef(env);
}

napi_value fnStop(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  if (!w) return nullptr;
  const RtAudioErrorType e = w->rt->stopStream();
  if (!rtOk(e)) return fail(env, rtErrorText(w, e));
  return undef(env);
}

napi_value fnWrite(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  if (!w) return nullptr;
  void *data = nullptr;
  size_t len = 0;
  if (a.n < 2 || N.napi_get_buffer_info(env, a.v[1], &data, &len) != napi_ok) return fail(env, "write() needs a Buffer");
  const size_t want = static_cast<size_t>(w->frameSize) * w->outChannels * w->sampleSize;
  if (len != want) return fail(env, "Invalid size of the PCM data!");
  std::vector<uint8_t> copy(static_cast<uint8_t *>(data), static_cast<uint8_t *>(data) + len);
  std::lock_guard<std::mutex> lk(w->outMutex);
  w->outq.push_back(std::move(copy));
  return undef(env);
}

napi_value fnClearOutputQueue(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  if (!w) return nullptr;
  std::lock_guard<std::mutex> lk(w->outMutex);
  w->outq.clear();
  return undef(env);
}

napi_value fnGetApi(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  return w ? text(env, RtAudio::getApiDisplayName(w->rt->getCurrentApi())) : nullptr;
}

napi_value fnGetStreamLatency(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  return w ? num(env, w->rt->getStreamLatency()) : nullptr;
}

napi_value fnGetStreamSampleRate(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  return w ? num(env, w->rt->getStreamSampleRate()) : nullptr;
}

napi_value fnGetStreamTime(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  return w ? num(env, w->rt->getStreamTime()) : nullptr;
}

napi_value fnSetStreamTime(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  if (!w) return nullptr;
  w->rt->setStreamTime(a.num(1, 0));
  return undef(env);
}

napi_value fnGetOutputVolume(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  if (!w) return nullptr;
  std::lock_guard<std::mutex> lk(w->outMutex);
  return num(env, w->volume);
}

napi_value fnSetOutputVolume(napi_env env, napi_callback_info info) {
  Args a(env, info);
  Wrap *w = get(env, a);
  if (!w) return nullptr;
  const double v = a.num(1, 1);
  if (v < 0 || v > 1) return fail(env, "Invalid volume value!");
  std::lock_guard<std::mutex> lk(w->outMutex);
  w->volume = v;
  w->mult = (std::pow(10.0, v) - 1.0) / 9.0;  // same curve as audify
  return undef(env);
}

napi_value setCallback(napi_env env, napi_callback_info info, bool input) {
  Args a(env, info);
  Wrap *w = get(env, a);
  if (!w) return nullptr;
  std::lock_guard<std::mutex> lk(w->tsfnMutex);
  napi_threadsafe_function &slot = input ? w->inputTsfn : w->frameTsfn;
  releaseTsfn(slot);
  if (a.isFunction(1)) slot = input ? makeTsfn(env, a.v[1], "awakerAudioInput", callInput) : makeTsfn(env, a.v[1], "awakerAudioFrame", callFrame);
  return undef(env);
}
napi_value fnSetInputCallback(napi_env env, napi_callback_info info) { return setCallback(env, info, true); }
napi_value fnSetFrameOutputCallback(napi_env env, napi_callback_info info) { return setCallback(env, info, false); }

napi_value fnCompiledApis(napi_env env, napi_callback_info) {
  std::vector<RtAudio::Api> apis;
  RtAudio::getCompiledApi(apis);
  napi_value arr = nullptr;
  N.napi_create_array_with_length(env, apis.size(), &arr);
  for (size_t i = 0; i < apis.size(); i++) {
    N.napi_set_element(env, arr, static_cast<uint32_t>(i), text(env, RtAudio::getApiName(apis[i])));
  }
  return arr;
}

void define(napi_env env, napi_value exports, const char *name, napi_callback cb) {
  napi_value f = nullptr;
  N.napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, nullptr, &f);
  setProp(env, exports, name, f);
}

}  // namespace

extern "C" {

__declspec(dllexport) int32_t node_api_module_get_api_version_v1(void) {
  return 8;
}

__declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  if (!loadNapi()) return exports;
  define(env, exports, "create", fnCreate);
  define(env, exports, "destroy", fnDestroy);
  define(env, exports, "getDevices", fnGetDevices);
  define(env, exports, "getDefaultInputDevice", fnDefaultInput);
  define(env, exports, "getDefaultOutputDevice", fnDefaultOutput);
  define(env, exports, "openStream", fnOpenStream);
  define(env, exports, "closeStream", fnCloseStream);
  define(env, exports, "isStreamOpen", fnIsStreamOpen);
  define(env, exports, "isStreamRunning", fnIsStreamRunning);
  define(env, exports, "start", fnStart);
  define(env, exports, "stop", fnStop);
  define(env, exports, "write", fnWrite);
  define(env, exports, "clearOutputQueue", fnClearOutputQueue);
  define(env, exports, "getApi", fnGetApi);
  define(env, exports, "getStreamLatency", fnGetStreamLatency);
  define(env, exports, "getStreamSampleRate", fnGetStreamSampleRate);
  define(env, exports, "getStreamTime", fnGetStreamTime);
  define(env, exports, "setStreamTime", fnSetStreamTime);
  define(env, exports, "getOutputVolume", fnGetOutputVolume);
  define(env, exports, "setOutputVolume", fnSetOutputVolume);
  define(env, exports, "setInputCallback", fnSetInputCallback);
  define(env, exports, "setFrameOutputCallback", fnSetFrameOutputCallback);
  define(env, exports, "compiledApis", fnCompiledApis);
  return exports;
}

}  // extern "C"
