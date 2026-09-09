// Bounded production slice for CapturePack's native Windows replay.
//
// Identity-only mode preserves the bounded capability probe. --capture-ms adds
// real continuous Desktop Duplication acquisition, an owned D3D11 BGRA surface,
// GPU NV12 conversion, adapter-bound Media Foundation hardware H.264 samples,
// and a bounded native access-unit ring. It remains isolated from the shipping
// MediaRecorder and still-image paths. --self-test opens no desktop or codec.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <codecapi.h>
#include <d3d10_1.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>
#include <icodecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mftransform.h>
#include <fcntl.h>
#include <io.h>
#include <wrl/client.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cwchar>
#include <deque>
#include <future>
#include <iterator>
#include <limits>
#include <memory>
#include <numeric>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

constexpr std::uint16_t kProtocolVersion = 1;
constexpr std::uint32_t kMinimumCaptureMs = 100;
constexpr std::uint32_t kMaximumCaptureMs = 30'000;
constexpr std::uint32_t kMinimumRetentionMs = 1'000;
// The settings loader accepts legacy/manual values through 600 s, but the
// opt-in native candidate deliberately owns at most one UI-sized 60 s window
// per display. Larger requests are rejected before capture so the application
// keeps its shipping recorder instead of multiplying hundreds of MiB across
// a multi-display desktop.
constexpr std::uint32_t kMaximumRetentionMs = 60'000;
constexpr std::uint32_t kTargetFramesPerSecond = 15;
constexpr std::uint32_t kTargetBitsPerSecond = 6'000'000;
constexpr std::uint32_t kKeyframeIntervalFrames = kTargetFramesPerSecond;
constexpr std::uint64_t kRingBitrateHeadroomNumerator = 5;
constexpr std::uint64_t kRingBitrateHeadroomDenominator = 4;
constexpr std::size_t kRingContainerHeadroomBytes = 8U * 1024U * 1024U;
constexpr std::size_t kExportContainerHeadroomBytes = 8U * 1024U * 1024U;
constexpr std::uint32_t kAcquireTimeoutMs = 20;
constexpr std::uint32_t kMaximumReinitializations = 3;
constexpr std::size_t kMaximumServiceCommandBytes = 32U * 1024U;
constexpr UINT kMaximumPointerDimension = 1024;
constexpr std::size_t kMaximumPointerShapeBytes =
    static_cast<std::size_t>(kMaximumPointerDimension) *
    kMaximumPointerDimension * 4U;

constexpr std::size_t RingMaximumBytes(std::uint32_t retentionMs) {
  const std::uint64_t nominalBytes =
      static_cast<std::uint64_t>(retentionMs) * kTargetBitsPerSecond / 8'000U;
  return static_cast<std::size_t>(
      (nominalBytes * kRingBitrateHeadroomNumerator +
       kRingBitrateHeadroomDenominator - 1) /
          kRingBitrateHeadroomDenominator +
      kRingContainerHeadroomBytes);
}

constexpr std::size_t RingMaximumUnits(std::uint32_t retentionMs) {
  return static_cast<std::size_t>(
      (static_cast<std::uint64_t>(retentionMs) * kTargetFramesPerSecond + 999) /
          1'000 +
      kKeyframeIntervalFrames + 1);
}

constexpr std::size_t kMaximumRingBytes = RingMaximumBytes(kMaximumRetentionMs);
constexpr std::size_t kMaximumRingUnits = RingMaximumUnits(kMaximumRetentionMs);

enum class ProbeStatus : std::uint32_t {
  kAvailable = 0,
  kUnavailable = 1,
};

enum class ProbeReason : std::uint32_t {
  kNone = 0,
  kInvalidRequest = 1,
  kOutputNotFound = 2,
  kFactoryFailed = 3,
  kComInitializationFailed = 4,
  kDeviceFailed = 5,
  kDuplicateAccessDenied = 6,
  kDuplicateUnsupported = 7,
  kDuplicateLimitReached = 8,
  kSessionDisconnected = 9,
  kDuplicateFailed = 10,
  kVideoProcessorUnavailable = 11,
  kMediaFoundationFailed = 12,
  kDeviceManagerFailed = 13,
  kAdapterScopedEnumerationUnavailable = 14,
  kHardwareEncoderNotFound = 15,
  kEncoderActivationFailed = 16,
  kEncoderNotD3d11Aware = 17,
  kEncoderRejectedDeviceManager = 18,
  kInternalFailure = 19,
  kAcquireFailed = 20,
  kAccessLostExhausted = 21,
  kUnsupportedFrame = 22,
  kRotationUnsupported = 23,
  kGpuConversionFailed = 24,
  kEncoderTypeRejected = 25,
  kEncoderStreamFailed = 26,
  kEncoderOutputFailed = 27,
  kDeviceLostExhausted = 28,
  kReinitializeFailed = 29,
  kCaptureDeadlineFailed = 30,
  kRingRejected = 31,
  kNoSafeSnapshot = 32,
  kCodecConfigInvalid = 33,
  kCodecConfigChanged = 34,
  kExportCreateFailed = 35,
  kExportWriteFailed = 36,
  kExportFinalizeFailed = 37,
  kExportStructureInvalid = 38,
  kExportDecodeFailed = 39,
  kServiceProtocolInvalid = 40,
  kCursorCompositionUnavailable = 41,
};

enum ProbeFlag : std::uint32_t {
  kOutputSelected = 1U << 0,
  kD3d11DeviceCreated = 1U << 1,
  kDesktopDuplicationCreated = 1U << 2,
  kMediaFoundationStarted = 1U << 3,
  kDxgiDeviceManagerCreated = 1U << 4,
  kHardwareEncoderEnumerated = 1U << 5,
  kEncoderActivated = 1U << 6,
  kEncoderD3d11Aware = 1U << 7,
  kEncoderAcceptedDeviceManager = 1U << 8,
  kGpuBgraToNv12Supported = 1U << 9,
};

enum RunFlag : std::uint32_t {
  kRunOutputSelected = 1U << 0,
  kRunD3d11DeviceCreated = 1U << 1,
  kRunDesktopDuplicationCreated = 1U << 2,
  kRunVideoProcessorCreated = 1U << 3,
  kRunMediaFoundationStarted = 1U << 4,
  kRunDxgiManagerCreated = 1U << 5,
  kRunHardwareEncoderConfigured = 1U << 6,
  kRunEncoderStreaming = 1U << 7,
  kRunFrameAcquired = 1U << 8,
  kRunFrameConverted = 1U << 9,
  kRunH264Produced = 1U << 10,
  kRunRingRetained = 1U << 11,
  kRunPipelineReinitialized = 1U << 12,
  kRunCodecConfigValidated = 1U << 13,
  kRunMp4Muxed = 1U << 14,
  kRunMp4StructureValidated = 1U << 15,
  kRunMp4Decoded = 1U << 16,
  // Desktop Duplication can return the hardware pointer as a separate plane.
  // This bit may only be set after PointerPosition/PointerShape metadata has
  // been composited into every submitted BGRA texture on the GPU.
  kRunCursorComposited = 1U << 17,
};

constexpr std::uint32_t kRequiredServiceHealthFlags =
    ((1U << 12) - 1) | (0xFU << 13) | kRunCursorComposited;

constexpr bool ServiceHealthIncludesCursor(std::uint32_t flags) {
  return (flags & kRequiredServiceHealthFlags) == kRequiredServiceHealthFlags;
}

#pragma pack(push, 1)
struct ProbePacket {
  char magic[8];
  std::uint16_t version;
  std::uint16_t headerBytes;
  std::uint32_t status;
  std::uint32_t reason;
  std::uint32_t flags;
  std::uint32_t adapterIndex;
  std::uint32_t outputIndex;
  std::int32_t boundsLeft;
  std::int32_t boundsTop;
  std::int32_t boundsRight;
  std::int32_t boundsBottom;
  std::uint32_t vendorId;
  std::uint32_t deviceId;
  std::uint32_t deviceNameBytes;
  std::uint32_t encoderNameBytes;
  char deviceName[64];
  char encoderName[128];
};

struct RunSummaryPacket {
  char magic[8];
  std::uint16_t version;
  std::uint16_t headerBytes;
  std::uint32_t status;
  std::uint32_t reason;
  std::uint32_t flags;
  std::uint32_t adapterIndex;
  std::uint32_t outputIndex;
  std::int32_t boundsLeft;
  std::int32_t boundsTop;
  std::int32_t boundsRight;
  std::int32_t boundsBottom;
  std::uint32_t rotation;
  std::uint32_t targetFps;
  std::int64_t qpcFrequency;
  std::int64_t startedQpc;
  std::int64_t endedQpc;
  std::uint64_t capturedFrames;
  std::uint64_t pointerOnlyFrames;
  std::uint64_t acquireTimeouts;
  std::uint64_t convertedFrames;
  std::uint64_t submittedFrames;
  std::uint64_t encodedSamples;
  std::uint64_t encodedBytes;
  std::uint64_t keyframes;
  std::uint64_t ringUnits;
  std::uint64_t ringBytes;
  std::uint32_t reinitializations;
  std::uint32_t accessLosses;
  std::uint32_t deviceLosses;
  std::uint32_t encoderFailures;
  std::uint32_t droppedBackpressure;
  std::int32_t lastHresult;
  std::uint32_t encoderNameBytes;
  char encoderName[68];
};

struct ServicePacket {
  // CPNSRV01 v1 is a fixed little-endian record. Service stdout contains only
  // whole records so the application can reject truncation or extra output.
  char magic[8];
  std::uint16_t version;
  std::uint16_t headerBytes;
  std::uint32_t kind;
  std::uint32_t status;
  std::uint32_t reason;
  std::uint64_t requestId;
  std::uint32_t flags;
  std::uint32_t width;
  std::uint32_t height;
  std::uint32_t targetFps;
  std::int64_t qpcFrequency;
  std::int64_t firstQpc;
  std::int64_t lastQpc;
  std::int64_t durationHns;
  std::uint64_t sampleCount;
  std::uint64_t keyframes;
  std::uint64_t mp4Bytes;
  std::uint64_t ringUnits;
  std::uint64_t ringBytes;
  std::uint32_t generation;
  std::int32_t lastHresult;
  std::uint32_t encoderNameBytes;
  char encoderName[124];
};
#pragma pack(pop)

static_assert(sizeof(ProbePacket) == 256, "probe packet size changed");
static_assert(offsetof(ProbePacket, deviceName) == 64, "probe offsets changed");
static_assert(offsetof(ProbePacket, encoderName) == 128, "probe offsets changed");
static_assert(sizeof(RunSummaryPacket) == 256, "run packet size changed");
static_assert(offsetof(RunSummaryPacket, qpcFrequency) == 56,
              "run packet offsets changed");
static_assert(offsetof(RunSummaryPacket, encoderName) == 188,
              "run packet offsets changed");
static_assert(sizeof(ServicePacket) == 256, "service packet size changed");
static_assert(offsetof(ServicePacket, qpcFrequency) == 48,
              "service packet offsets changed");
static_assert(offsetof(ServicePacket, encoderName) == 132,
              "service packet offsets changed");

struct Request {
  bool selfTest = false;
  bool serve = false;
  std::uint32_t captureMs = 0;
  std::uint32_t retentionMs = 30'000;
  bool hasDeviceName = false;
  std::wstring deviceName;
  bool hasBounds = false;
  LONG left = 0;
  LONG top = 0;
  LONG width = 0;
  LONG height = 0;
};

struct OutputChoice {
  ComPtr<IDXGIAdapter1> adapter;
  ComPtr<IDXGIOutput> output;
  DXGI_ADAPTER_DESC1 adapterDesc{};
  DXGI_OUTPUT_DESC outputDesc{};
  std::uint32_t adapterIndex = 0;
  std::uint32_t outputIndex = 0;
};

struct EncodedAccessUnit {
  std::int64_t exposedQpc = 0;
  std::int64_t ptsHns = 0;
  std::int64_t durationHns = 0;
  std::uint32_t generation = 1;
  bool keyframe = false;
  std::vector<std::uint8_t> codecConfig;
  std::vector<std::uint8_t> bytes;
};

struct EncodedRingSnapshot {
  std::uint32_t generation = 0;
  std::int64_t firstQpc = 0;
  std::int64_t lastQpc = 0;
  std::int64_t durationHns = 0;
  std::vector<std::uint8_t> codecConfig;
  std::vector<EncodedAccessUnit> units;

  bool safe() const {
    return generation != 0 && firstQpc > 0 && lastQpc >= firstQpc &&
           durationHns > 0 && !codecConfig.empty() && !units.empty() &&
           units.front().keyframe && units.front().ptsHns == 0;
  }
};

// The production encoder will append complete access units. Retention can be
// shorter than requested when a byte/time cut crosses a GOP: the ring removes
// the undecodable prefix through the next keyframe instead of exporting it.
class EncodedAccessUnitRing {
 public:
  EncodedAccessUnitRing(std::size_t maximumBytes, std::int64_t retentionQpc,
                        std::size_t maximumUnits = kMaximumRingUnits)
      : maximumBytes_(maximumBytes), retentionQpc_(retentionQpc),
        maximumUnits_(maximumUnits) {}

  bool Append(EncodedAccessUnit unit) {
    const std::size_t unitBytes = unit.bytes.size() + unit.codecConfig.size();
    if (maximumBytes_ == 0 || maximumUnits_ == 0 || retentionQpc_ <= 0 ||
        unit.exposedQpc <= 0 || unit.ptsHns < 0 || unit.durationHns <= 0 ||
        unit.generation == 0 ||
        unit.bytes.empty() ||
        unit.keyframe != !unit.codecConfig.empty() ||
        unitBytes > maximumBytes_ ||
        bytes_ > std::numeric_limits<std::size_t>::max() - unitBytes ||
        (!units_.empty() && unit.exposedQpc <= units_.back().exposedQpc)) {
      return false;
    }
    // A retention cut can remove the last decodable GOP just before the
    // encoder emits its next clean point. Predictive output in that interval
    // is valid encoder output but cannot seed a replay, so discard it without
    // turning a short configured retention into a fatal service error.
    if (units_.empty() && !unit.keyframe) return true;
    if (!units_.empty() && unit.generation < units_.back().generation) return false;
    if (units_.empty() || unit.generation > units_.back().generation) {
      if (!unit.keyframe || unit.codecConfig.empty()) return false;
      Clear();
    } else if (unit.keyframe && unit.codecConfig.empty()) {
      return false;
    }
    bytes_ += unitBytes;
    units_.push_back(std::move(unit));
    Prune();
    return true;
  }

  bool Snapshot(std::int64_t cutQpc, EncodedRingSnapshot& snapshot) const {
    snapshot = {};
    if (cutQpc <= 0) return false;
    const std::int64_t earliest =
        cutQpc > retentionQpc_ ? cutQpc - retentionQpc_ : 0;
    auto first = std::find_if(
        units_.begin(), units_.end(), [earliest](const EncodedAccessUnit& unit) {
          return unit.exposedQpc >= earliest;
        });
    first = std::find_if(
        first, units_.end(), [](const EncodedAccessUnit& unit) {
          return unit.keyframe;
        });
    if (first == units_.end() || first->codecConfig.empty()) return false;
    const std::int64_t originPts = first->ptsHns;
    const std::uint32_t generation = first->generation;
    std::int64_t previousPts = -1;
    for (auto current = first;
         current != units_.end() && current->exposedQpc <= cutQpc;
         ++current) {
      if (current->generation != generation || current->ptsHns < originPts ||
          current->ptsHns <= previousPts || current->durationHns <= 0 ||
          (current->keyframe && current->codecConfig != first->codecConfig)) {
        return false;
      }
      if (current->ptsHns - originPts >
          std::numeric_limits<std::int64_t>::max() - current->durationHns) {
        return false;
      }
      EncodedAccessUnit rebased = *current;
      rebased.ptsHns -= originPts;
      snapshot.durationHns = rebased.ptsHns + rebased.durationHns;
      previousPts = current->ptsHns;
      snapshot.units.push_back(std::move(rebased));
    }
    if (snapshot.units.empty()) return false;
    snapshot.generation = generation;
    snapshot.firstQpc = snapshot.units.front().exposedQpc;
    snapshot.lastQpc = snapshot.units.back().exposedQpc;
    snapshot.codecConfig = snapshot.units.front().codecConfig;
    return snapshot.safe();
  }

  std::size_t bytes() const { return bytes_; }
  std::size_t size() const { return units_.size(); }
  void Reset() { Clear(); }

 private:
  void PopFront() {
    bytes_ -= units_.front().bytes.size() + units_.front().codecConfig.size();
    units_.pop_front();
  }

  void Clear() {
    units_.clear();
    bytes_ = 0;
  }

  void Prune() {
    while (!units_.empty() &&
           (bytes_ > maximumBytes_ || units_.size() > maximumUnits_ ||
            units_.back().exposedQpc - units_.front().exposedQpc >
                retentionQpc_)) {
      PopFront();
      while (!units_.empty() && !units_.front().keyframe) PopFront();
    }
  }

  const std::size_t maximumBytes_;
  const std::int64_t retentionQpc_;
  const std::size_t maximumUnits_;
  std::size_t bytes_ = 0;
  std::deque<EncodedAccessUnit> units_;
};

class ComLifetime {
 public:
  explicit ComLifetime(bool owns) : owns_(owns) {}
  ~ComLifetime() {
    if (owns_) CoUninitialize();
  }
 private:
  bool owns_;
};

class MediaFoundationLifetime {
 public:
  ~MediaFoundationLifetime() { MFShutdown(); }
};

bool ParseLong(const wchar_t* text, LONG& value) {
  if (text == nullptr || *text == L'\0') return false;
  wchar_t* end = nullptr;
  errno = 0;
  const long long parsed = std::wcstoll(text, &end, 10);
  if (errno != 0 || end == text || *end != L'\0' ||
      parsed < std::numeric_limits<LONG>::min() ||
      parsed > std::numeric_limits<LONG>::max()) {
    return false;
  }
  value = static_cast<LONG>(parsed);
  return true;
}

bool ParseCaptureMs(const wchar_t* text, std::uint32_t& value) {
  LONG parsed = 0;
  if (!ParseLong(text, parsed) || parsed < static_cast<LONG>(kMinimumCaptureMs) ||
      parsed > static_cast<LONG>(kMaximumCaptureMs)) {
    return false;
  }
  value = static_cast<std::uint32_t>(parsed);
  return true;
}

bool ParseRetentionMs(const wchar_t* text, std::uint32_t& value) {
  LONG parsed = 0;
  if (!ParseLong(text, parsed) ||
      parsed < static_cast<LONG>(kMinimumRetentionMs) ||
      parsed > static_cast<LONG>(kMaximumRetentionMs)) {
    return false;
  }
  value = static_cast<std::uint32_t>(parsed);
  return true;
}

bool ParseRequest(int argc, wchar_t** argv, Request& request) {
  if (argc == 2 && std::wstring(argv[1]) == L"--self-test") {
    request.selfTest = true;
    return true;
  }
  bool haveLeft = false;
  bool haveTop = false;
  bool haveWidth = false;
  bool haveHeight = false;
  for (int index = 1; index < argc; ++index) {
    const std::wstring option = argv[index];
    if (option == L"--serve") {
      if (request.serve) return false;
      request.serve = true;
      continue;
    }
    if (index + 1 >= argc) return false;
    const wchar_t* value = argv[++index];
    if (option == L"--device") {
      request.hasDeviceName = *value != L'\0';
      request.deviceName = value;
    } else if (option == L"--left") {
      haveLeft = ParseLong(value, request.left);
      if (!haveLeft) return false;
    } else if (option == L"--top") {
      haveTop = ParseLong(value, request.top);
      if (!haveTop) return false;
    } else if (option == L"--native-width") {
      haveWidth = ParseLong(value, request.width) && request.width > 0;
      if (!haveWidth) return false;
    } else if (option == L"--native-height") {
      haveHeight = ParseLong(value, request.height) && request.height > 0;
      if (!haveHeight) return false;
    } else if (option == L"--capture-ms") {
      if (!ParseCaptureMs(value, request.captureMs)) return false;
    } else if (option == L"--retention-ms") {
      if (!ParseRetentionMs(value, request.retentionMs)) return false;
    } else {
      return false;
    }
  }
  const int boundsParts = static_cast<int>(haveLeft) + static_cast<int>(haveTop) +
                          static_cast<int>(haveWidth) + static_cast<int>(haveHeight);
  if (boundsParts != 0 && boundsParts != 4) return false;
  request.hasBounds = boundsParts == 4;
  if (request.serve && request.captureMs != 0) return false;
  if (!request.serve && request.retentionMs != 30'000) return false;
  return request.hasDeviceName || request.hasBounds;
}

bool SameBounds(const RECT& bounds, const Request& request) {
  const long long right = static_cast<long long>(request.left) + request.width;
  const long long bottom = static_cast<long long>(request.top) + request.height;
  return right <= std::numeric_limits<LONG>::max() &&
         bottom <= std::numeric_limits<LONG>::max() &&
         bounds.left == request.left && bounds.top == request.top &&
         bounds.right == static_cast<LONG>(right) &&
         bounds.bottom == static_cast<LONG>(bottom);
}

bool MatchesOutput(const Request& request, const DXGI_OUTPUT_DESC& description) {
  if (request.hasDeviceName &&
      _wcsicmp(description.DeviceName, request.deviceName.c_str()) != 0) {
    return false;
  }
  return !request.hasBounds || SameBounds(description.DesktopCoordinates, request);
}

bool SelectOutput(const Request& request, OutputChoice& choice, HRESULT& failure) {
  ComPtr<IDXGIFactory1> factory;
  failure = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
  if (FAILED(failure)) return false;
  for (UINT adapterIndex = 0;; ++adapterIndex) {
    ComPtr<IDXGIAdapter1> adapter;
    const HRESULT adapterResult = factory->EnumAdapters1(adapterIndex, &adapter);
    if (adapterResult == DXGI_ERROR_NOT_FOUND) break;
    if (FAILED(adapterResult)) {
      failure = adapterResult;
      return false;
    }
    DXGI_ADAPTER_DESC1 adapterDesc{};
    if (FAILED(adapter->GetDesc1(&adapterDesc))) continue;
    for (UINT outputIndex = 0;; ++outputIndex) {
      ComPtr<IDXGIOutput> output;
      const HRESULT outputResult = adapter->EnumOutputs(outputIndex, &output);
      if (outputResult == DXGI_ERROR_NOT_FOUND) break;
      if (FAILED(outputResult)) {
        failure = outputResult;
        return false;
      }
      DXGI_OUTPUT_DESC outputDesc{};
      if (FAILED(output->GetDesc(&outputDesc)) || !outputDesc.AttachedToDesktop) continue;
      if (!MatchesOutput(request, outputDesc)) continue;
      choice.adapter = adapter;
      choice.output = output;
      choice.adapterDesc = adapterDesc;
      choice.outputDesc = outputDesc;
      choice.adapterIndex = adapterIndex;
      choice.outputIndex = outputIndex;
      failure = S_OK;
      return true;
    }
  }
  failure = DXGI_ERROR_NOT_FOUND;
  return false;
}

std::string Utf8(const wchar_t* value) {
  if (value == nullptr || *value == L'\0') return {};
  const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1,
                                        nullptr, 0, nullptr, nullptr);
  if (bytes <= 1) return {};
  std::string result(static_cast<std::size_t>(bytes), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1,
                          result.data(), bytes, nullptr, nullptr) == 0) {
    return {};
  }
  result.pop_back();
  return result;
}

template <std::size_t Size>
std::uint32_t CopyBoundedUtf8(char (&destination)[Size], const std::string& value) {
  std::size_t bytes = std::min(Size, value.size());
  if (bytes < value.size()) {
    while (bytes > 0 &&
           (static_cast<unsigned char>(value[bytes]) & 0xC0U) == 0x80U) {
      --bytes;
    }
  }
  if (bytes > 0) std::copy_n(value.data(), bytes, destination);
  return static_cast<std::uint32_t>(bytes);
}

ProbePacket NewPacket() {
  ProbePacket packet{};
  std::copy_n("CPNRCP01", 8, packet.magic);
  packet.version = kProtocolVersion;
  packet.headerBytes = sizeof(ProbePacket);
  packet.status = static_cast<std::uint32_t>(ProbeStatus::kUnavailable);
  packet.reason = static_cast<std::uint32_t>(ProbeReason::kInternalFailure);
  return packet;
}

void AddOutputIdentity(ProbePacket& packet, const OutputChoice& choice) {
  packet.flags |= kOutputSelected;
  packet.adapterIndex = choice.adapterIndex;
  packet.outputIndex = choice.outputIndex;
  packet.boundsLeft = choice.outputDesc.DesktopCoordinates.left;
  packet.boundsTop = choice.outputDesc.DesktopCoordinates.top;
  packet.boundsRight = choice.outputDesc.DesktopCoordinates.right;
  packet.boundsBottom = choice.outputDesc.DesktopCoordinates.bottom;
  packet.vendorId = choice.adapterDesc.VendorId;
  packet.deviceId = choice.adapterDesc.DeviceId;
  packet.deviceNameBytes = CopyBoundedUtf8(packet.deviceName, Utf8(choice.outputDesc.DeviceName));
}

int WritePacket(ProbePacket& packet, ProbeStatus status, ProbeReason reason) {
  packet.status = static_cast<std::uint32_t>(status);
  packet.reason = static_cast<std::uint32_t>(reason);
  _setmode(_fileno(stdout), _O_BINARY);
  return std::fwrite(&packet, 1, sizeof(packet), stdout) == sizeof(packet) ? 0 : 1;
}

ProbeReason DuplicateReason(HRESULT result) {
  if (result == E_ACCESSDENIED) return ProbeReason::kDuplicateAccessDenied;
  if (result == DXGI_ERROR_UNSUPPORTED) return ProbeReason::kDuplicateUnsupported;
  if (result == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE) return ProbeReason::kDuplicateLimitReached;
  if (result == DXGI_ERROR_SESSION_DISCONNECTED) return ProbeReason::kSessionDisconnected;
  return ProbeReason::kDuplicateFailed;
}

HRESULT CreateVideoDevice(IDXGIAdapter1* adapter,
                          ComPtr<ID3D11Device>& device,
                          ComPtr<ID3D11DeviceContext>& context) {
  const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
  const D3D_FEATURE_LEVEL levels[] = {
      D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0,
      D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0};
  D3D_FEATURE_LEVEL selected{};
  HRESULT result = D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags,
                                     levels, ARRAYSIZE(levels), D3D11_SDK_VERSION,
                                     &device, &selected, &context);
  if (result != E_INVALIDARG) return result;
  return D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags,
                           levels + 1, ARRAYSIZE(levels) - 1, D3D11_SDK_VERSION,
                           &device, &selected, &context);
}

bool SupportsGpuColorConversion(const OutputChoice& choice,
                                ID3D11Device* device,
                                ID3D11DeviceContext* context) {
  ComPtr<ID3D11VideoDevice> videoDevice;
  ComPtr<ID3D11VideoContext> videoContext;
  if (FAILED(device->QueryInterface(IID_PPV_ARGS(&videoDevice))) ||
      FAILED(context->QueryInterface(IID_PPV_ARGS(&videoContext)))) {
    return false;
  }
  const LONG nativeWidth = choice.outputDesc.DesktopCoordinates.right -
                           choice.outputDesc.DesktopCoordinates.left;
  const LONG nativeHeight = choice.outputDesc.DesktopCoordinates.bottom -
                            choice.outputDesc.DesktopCoordinates.top;
  const UINT width = static_cast<UINT>(nativeWidth) & ~1U;
  const UINT height = static_cast<UINT>(nativeHeight) & ~1U;
  if (width < 2 || height < 2) return false;
  D3D11_VIDEO_PROCESSOR_CONTENT_DESC description{};
  description.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
  description.InputFrameRate = {15, 1};
  description.InputWidth = width;
  description.InputHeight = height;
  description.OutputFrameRate = {15, 1};
  description.OutputWidth = width;
  description.OutputHeight = height;
  description.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
  ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
  if (FAILED(videoDevice->CreateVideoProcessorEnumerator(
          &description, &enumerator))) {
    return false;
  }
  UINT bgraFlags = 0;
  UINT nv12Flags = 0;
  return SUCCEEDED(enumerator->CheckVideoProcessorFormat(
             DXGI_FORMAT_B8G8R8A8_UNORM, &bgraFlags)) &&
         SUCCEEDED(enumerator->CheckVideoProcessorFormat(
             DXGI_FORMAT_NV12, &nv12Flags)) &&
         (bgraFlags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT) != 0 &&
         (nv12Flags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT) != 0;
}

ProbeReason BindHardwareEncoder(const OutputChoice& choice,
                                IMFDXGIDeviceManager* manager,
                                ProbePacket& packet) {
  MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_NV12};
  MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_H264};
  ComPtr<IMFAttributes> enumAttributes;
  HRESULT result = MFCreateAttributes(&enumAttributes, 1);
  if (FAILED(result)) return ProbeReason::kHardwareEncoderNotFound;
  result = enumAttributes->SetBlob(
      MFT_ENUM_ADAPTER_LUID,
      reinterpret_cast<const UINT8*>(&choice.adapterDesc.AdapterLuid),
      sizeof(choice.adapterDesc.AdapterLuid));
  if (FAILED(result)) return ProbeReason::kHardwareEncoderNotFound;

  IMFActivate** activations = nullptr;
  UINT32 count = 0;
  using MftEnum2Function = HRESULT(WINAPI*)(
      GUID, UINT32, const MFT_REGISTER_TYPE_INFO*,
      const MFT_REGISTER_TYPE_INFO*, IMFAttributes*, IMFActivate***, UINT32*);
  const HMODULE mfplat = GetModuleHandleW(L"mfplat.dll");
  const auto enumerate = mfplat == nullptr
      ? nullptr
      : reinterpret_cast<MftEnum2Function>(GetProcAddress(mfplat, "MFTEnum2"));
  if (enumerate == nullptr) {
    return ProbeReason::kAdapterScopedEnumerationUnavailable;
  }
  result = enumerate(
      MFT_CATEGORY_VIDEO_ENCODER,
      MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
      &input, &output, enumAttributes.Get(), &activations, &count);
  if (FAILED(result) || count == 0 || activations == nullptr) {
    if (activations != nullptr) CoTaskMemFree(activations);
    return ProbeReason::kHardwareEncoderNotFound;
  }
  packet.flags |= kHardwareEncoderEnumerated;

  ProbeReason lastReason = ProbeReason::kEncoderActivationFailed;
  for (UINT32 index = 0; index < count; ++index) {
    IMFActivate* activation = activations[index];
    if (activation == nullptr) continue;
    wchar_t* allocatedName = nullptr;
    UINT32 nameLength = 0;
    std::string encoderName;
    if (SUCCEEDED(activation->GetAllocatedString(
            MFT_FRIENDLY_NAME_Attribute, &allocatedName, &nameLength))) {
      encoderName = Utf8(allocatedName);
      CoTaskMemFree(allocatedName);
    }
    if (encoderName.empty()) encoderName = "unnamed hardware H.264 MFT";
    ComPtr<IMFTransform> transform;
    result = activation->ActivateObject(IID_PPV_ARGS(&transform));
    if (FAILED(result)) {
      lastReason = ProbeReason::kEncoderActivationFailed;
      continue;
    }
    const auto shutdownActivatedObject = [&]() {
      transform.Reset();
      activation->ShutdownObject();
    };
    packet.flags |= kEncoderActivated;
    ComPtr<IMFAttributes> attributes;
    UINT32 d3d11Aware = FALSE;
    if (FAILED(transform->GetAttributes(&attributes)) ||
        FAILED(attributes->GetUINT32(MF_SA_D3D11_AWARE, &d3d11Aware)) ||
        d3d11Aware == FALSE) {
      lastReason = ProbeReason::kEncoderNotD3d11Aware;
      shutdownActivatedObject();
      continue;
    }
    packet.flags |= kEncoderD3d11Aware;
    UINT32 asynchronous = FALSE;
    if (SUCCEEDED(attributes->GetUINT32(MF_TRANSFORM_ASYNC, &asynchronous)) &&
        asynchronous != FALSE) {
      if (FAILED(attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE))) {
        lastReason = ProbeReason::kEncoderRejectedDeviceManager;
        shutdownActivatedObject();
        continue;
      }
    }
    result = transform->ProcessMessage(
        MFT_MESSAGE_SET_D3D_MANAGER, reinterpret_cast<ULONG_PTR>(manager));
    if (FAILED(result)) {
      lastReason = ProbeReason::kEncoderRejectedDeviceManager;
      shutdownActivatedObject();
      continue;
    }
    packet.flags |= kEncoderAcceptedDeviceManager;
    packet.encoderNameBytes = CopyBoundedUtf8(packet.encoderName, encoderName);
    shutdownActivatedObject();
    for (UINT32 releaseIndex = 0; releaseIndex < count; ++releaseIndex) {
      if (activations[releaseIndex] != nullptr) activations[releaseIndex]->Release();
    }
    CoTaskMemFree(activations);
    return ProbeReason::kNone;
  }
  for (UINT32 index = 0; index < count; ++index) {
    if (activations[index] != nullptr) activations[index]->Release();
  }
  CoTaskMemFree(activations);
  return lastReason;
}

RunSummaryPacket NewRunSummary() {
  RunSummaryPacket packet{};
  std::copy_n("CPNRUN01", 8, packet.magic);
  packet.version = kProtocolVersion;
  packet.headerBytes = sizeof(RunSummaryPacket);
  packet.status = static_cast<std::uint32_t>(ProbeStatus::kUnavailable);
  packet.reason = static_cast<std::uint32_t>(ProbeReason::kInternalFailure);
  packet.targetFps = kTargetFramesPerSecond;
  return packet;
}

int WriteRunSummary(RunSummaryPacket& packet, ProbeStatus status,
                    ProbeReason reason, HRESULT lastResult = S_OK) {
  packet.status = static_cast<std::uint32_t>(status);
  packet.reason = static_cast<std::uint32_t>(reason);
  packet.lastHresult = static_cast<std::int32_t>(lastResult);
  _setmode(_fileno(stdout), _O_BINARY);
  return std::fwrite(&packet, 1, sizeof(packet), stdout) == sizeof(packet) ? 0 : 1;
}

enum class ServicePacketKind : std::uint32_t {
  kReady = 1,
  kSnapshot = 2,
  kFatal = 3,
};

ServicePacket NewServicePacket(ServicePacketKind kind) {
  ServicePacket packet{};
  std::copy_n("CPNSRV01", 8, packet.magic);
  packet.version = kProtocolVersion;
  packet.headerBytes = sizeof(ServicePacket);
  packet.kind = static_cast<std::uint32_t>(kind);
  packet.status = static_cast<std::uint32_t>(ProbeStatus::kUnavailable);
  packet.reason = static_cast<std::uint32_t>(ProbeReason::kInternalFailure);
  packet.targetFps = kTargetFramesPerSecond;
  return packet;
}

bool WriteServicePacket(ServicePacket& packet, ProbeStatus status,
                        ProbeReason reason, HRESULT lastResult = S_OK) {
  packet.status = static_cast<std::uint32_t>(status);
  packet.reason = static_cast<std::uint32_t>(reason);
  packet.lastHresult = static_cast<std::int32_t>(lastResult);
  _setmode(_fileno(stdout), _O_BINARY);
  const bool written =
      std::fwrite(&packet, 1, sizeof(packet), stdout) == sizeof(packet);
  return written && std::fflush(stdout) == 0;
}

struct ExportEvidence {
  HRESULT result = E_FAIL;
  ProbeReason reason = ProbeReason::kExportCreateFailed;
  std::uint64_t bytes = 0;
  std::uint64_t decodedSamples = 0;
  std::int64_t declaredDurationHns = 0;
  std::uint32_t flags = 0;
};

struct AnnexBInspection {
  bool valid = false;
  bool hasSps = false;
  bool hasPps = false;
  bool hasIdr = false;
  bool hasVcl = false;
};

bool FindAnnexBStart(const std::uint8_t* bytes, std::size_t size,
                     std::size_t from, std::size_t& at,
                     std::size_t& prefixBytes) {
  for (std::size_t index = from; index + 3 <= size; ++index) {
    if (bytes[index] != 0 || bytes[index + 1] != 0) continue;
    if (bytes[index + 2] == 1) {
      at = index;
      prefixBytes = 3;
      return true;
    }
    if (index + 4 <= size && bytes[index + 2] == 0 &&
        bytes[index + 3] == 1) {
      at = index;
      prefixBytes = 4;
      return true;
    }
  }
  return false;
}

AnnexBInspection InspectAnnexB(const std::vector<std::uint8_t>& bytes) {
  AnnexBInspection inspected;
  if (bytes.empty()) return inspected;
  std::size_t start = 0;
  std::size_t prefix = 0;
  if (!FindAnnexBStart(bytes.data(), bytes.size(), 0, start, prefix) ||
      start != 0) {
    return inspected;
  }
  std::size_t nalCount = 0;
  for (;;) {
    const std::size_t header = start + prefix;
    if (header >= bytes.size()) return inspected;
    std::size_t next = bytes.size();
    std::size_t nextPrefix = 0;
    FindAnnexBStart(bytes.data(), bytes.size(), header + 1, next, nextPrefix);
    if (next <= header) return inspected;
    const std::uint8_t nalType = bytes[header] & 0x1fU;
    if (nalType == 0 || nalType >= 24) return inspected;
    inspected.hasSps |= nalType == 7;
    inspected.hasPps |= nalType == 8;
    inspected.hasIdr |= nalType == 5;
    inspected.hasVcl |= nalType >= 1 && nalType <= 5;
    if (++nalCount > 256) return inspected;
    if (next == bytes.size()) break;
    start = next;
    prefix = nextPrefix;
  }
  inspected.valid = nalCount > 0;
  return inspected;
}

HRESULT SnapshotMediaType(const EncodedRingSnapshot& snapshot, UINT width,
                          UINT height, ComPtr<IMFMediaType>& mediaType) {
  HRESULT result = MFCreateMediaType(&mediaType);
  if (SUCCEEDED(result)) result = mediaType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  if (SUCCEEDED(result)) result = mediaType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
  if (SUCCEEDED(result)) result = MFSetAttributeSize(mediaType.Get(), MF_MT_FRAME_SIZE,
                                                     width, height);
  if (SUCCEEDED(result)) result = MFSetAttributeRatio(
      mediaType.Get(), MF_MT_FRAME_RATE, kTargetFramesPerSecond, 1);
  if (SUCCEEDED(result)) result = MFSetAttributeRatio(
      mediaType.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  if (SUCCEEDED(result)) result = mediaType->SetUINT32(
      MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  if (SUCCEEDED(result)) result = mediaType->SetUINT32(
      MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main);
  if (SUCCEEDED(result)) {
    const std::uint64_t totalBits = std::accumulate(
        snapshot.units.begin(), snapshot.units.end(), std::uint64_t{0},
        [](std::uint64_t bytes, const EncodedAccessUnit& unit) {
          return bytes + static_cast<std::uint64_t>(unit.bytes.size());
        }) * 8U;
    const std::uint64_t bitrate = snapshot.durationHns <= 0
        ? 2'000'000
        : std::max<std::uint64_t>(1,
              totalBits * 10'000'000U /
                  static_cast<std::uint64_t>(snapshot.durationHns));
    result = mediaType->SetUINT32(
        MF_MT_AVG_BITRATE,
        static_cast<UINT32>(std::min<std::uint64_t>(
            bitrate, std::numeric_limits<UINT32>::max())));
  }
  if (SUCCEEDED(result)) result = mediaType->SetBlob(
      MF_MT_MPEG_SEQUENCE_HEADER, snapshot.codecConfig.data(),
      static_cast<UINT32>(snapshot.codecConfig.size()));
  return result;
}

HRESULT WriteSnapshotSamples(IMFSinkWriter* writer,
                             const EncodedRingSnapshot& snapshot) {
  for (std::size_t index = 0; index < snapshot.units.size(); ++index) {
    const EncodedAccessUnit& unit = snapshot.units[index];
    if (unit.bytes.size() > std::numeric_limits<DWORD>::max()) {
      return MF_E_BUFFERTOOSMALL;
    }
    ComPtr<IMFMediaBuffer> buffer;
    HRESULT result = MFCreateMemoryBuffer(
        static_cast<DWORD>(unit.bytes.size()), &buffer);
    BYTE* destination = nullptr;
    DWORD capacity = 0;
    if (SUCCEEDED(result)) result = buffer->Lock(&destination, &capacity, nullptr);
    if (SUCCEEDED(result)) {
      if (capacity < unit.bytes.size()) result = MF_E_BUFFERTOOSMALL;
      else std::copy(unit.bytes.begin(), unit.bytes.end(), destination);
      buffer->Unlock();
    }
    if (SUCCEEDED(result)) result = buffer->SetCurrentLength(
        static_cast<DWORD>(unit.bytes.size()));
    ComPtr<IMFSample> sample;
    if (SUCCEEDED(result)) result = MFCreateSample(&sample);
    if (SUCCEEDED(result)) result = sample->AddBuffer(buffer.Get());
    if (SUCCEEDED(result)) result = sample->SetSampleTime(unit.ptsHns);
    if (SUCCEEDED(result)) result = sample->SetSampleDuration(unit.durationHns);
    if (SUCCEEDED(result)) result = sample->SetUINT64(
        MFSampleExtension_DecodeTimestamp, static_cast<UINT64>(unit.ptsHns));
    if (SUCCEEDED(result) && unit.keyframe) {
      result = sample->SetUINT32(MFSampleExtension_CleanPoint, TRUE);
    }
    if (SUCCEEDED(result) && index == 0) {
      result = sample->SetUINT32(MFSampleExtension_Discontinuity, TRUE);
    }
    if (SUCCEEDED(result)) result = writer->WriteSample(0, sample.Get());
    if (FAILED(result)) return result;
  }
  return S_OK;
}

bool ReadBoundedFile(const std::wstring& path, std::size_t maximumBytes,
                     std::vector<std::uint8_t>& bytes) {
  bytes.clear();
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size{};
  const bool sizeOk = GetFileSizeEx(file, &size) != FALSE && size.QuadPart > 0 &&
      size.QuadPart <= static_cast<LONGLONG>(maximumBytes);
  if (!sizeOk) {
    CloseHandle(file);
    return false;
  }
  bytes.resize(static_cast<std::size_t>(size.QuadPart));
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const DWORD request = static_cast<DWORD>(std::min<std::size_t>(
        bytes.size() - offset, 1U * 1024U * 1024U));
    DWORD read = 0;
    if (!ReadFile(file, bytes.data() + offset, request, &read, nullptr) ||
        read == 0) {
      CloseHandle(file);
      bytes.clear();
      return false;
    }
    offset += read;
  }
  CloseHandle(file);
  return true;
}

std::uint32_t ReadBigEndian32(const std::uint8_t* bytes) {
  return (static_cast<std::uint32_t>(bytes[0]) << 24) |
         (static_cast<std::uint32_t>(bytes[1]) << 16) |
         (static_cast<std::uint32_t>(bytes[2]) << 8) |
         static_cast<std::uint32_t>(bytes[3]);
}

std::uint64_t ReadBigEndian64(const std::uint8_t* bytes) {
  return (static_cast<std::uint64_t>(ReadBigEndian32(bytes)) << 32) |
         ReadBigEndian32(bytes + 4);
}

bool ValidateFragmentedMp4Structure(const std::vector<std::uint8_t>& bytes) {
  bool ftyp = false;
  bool moov = false;
  bool moof = false;
  bool mdat = false;
  std::size_t boxes = 0;
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    if (bytes.size() - offset < 8 || ++boxes > 4096) return false;
    std::uint64_t boxBytes = ReadBigEndian32(bytes.data() + offset);
    std::size_t headerBytes = 8;
    if (boxBytes == 1) {
      if (bytes.size() - offset < 16) return false;
      boxBytes = ReadBigEndian64(bytes.data() + offset + 8);
      headerBytes = 16;
    } else if (boxBytes == 0) {
      return false;
    }
    if (boxBytes < headerBytes || boxBytes > bytes.size() - offset) return false;
    const char* type = reinterpret_cast<const char*>(bytes.data() + offset + 4);
    if (std::memcmp(type, "ftyp", 4) == 0) {
      if (offset != 0 || ftyp) return false;
      ftyp = true;
    } else if (std::memcmp(type, "moov", 4) == 0) {
      if (!ftyp || moof) return false;
      moov = true;
    } else if (std::memcmp(type, "moof", 4) == 0) {
      if (!moov) return false;
      moof = true;
    } else if (std::memcmp(type, "mdat", 4) == 0) {
      if (!moof || boxBytes == headerBytes) return false;
      mdat = true;
    }
    offset += static_cast<std::size_t>(boxBytes);
  }
  return offset == bytes.size() && ftyp && moov && moof && mdat;
}

HRESULT DecodeAndValidateMp4(const std::wstring& path,
                             const EncodedRingSnapshot& snapshot,
                             UINT expectedWidth, UINT expectedHeight,
                             std::uint64_t& decodedSamples,
                             std::int64_t& declaredDurationHns) {
  decodedSamples = 0;
  declaredDurationHns = 0;
  ComPtr<IMFSourceReader> reader;
  HRESULT result = MFCreateSourceReaderFromURL(path.c_str(), nullptr, &reader);
  if (FAILED(result)) return result;
  PROPVARIANT duration;
  PropVariantInit(&duration);
  result = reader->GetPresentationAttribute(
      static_cast<DWORD>(MF_SOURCE_READER_MEDIASOURCE), MF_PD_DURATION,
      &duration);
  if (SUCCEEDED(result)) {
    if (duration.vt == VT_UI8) {
      declaredDurationHns =
          static_cast<std::int64_t>(duration.uhVal.QuadPart);
    } else if (duration.vt == VT_I8) {
      declaredDurationHns = duration.hVal.QuadPart;
    } else {
      result = MF_E_INVALIDMEDIATYPE;
    }
  }
  PropVariantClear(&duration);
  if (FAILED(result) || declaredDurationHns <= 0) {
    return FAILED(result) ? result : E_FAIL;
  }
  const std::int64_t tolerance = 10'000'000 / kTargetFramesPerSecond;
  const std::int64_t difference = declaredDurationHns > snapshot.durationHns
      ? declaredDurationHns - snapshot.durationHns
      : snapshot.durationHns - declaredDurationHns;
  if (difference > tolerance) return MF_E_INVALID_TIMESTAMP;

  ComPtr<IMFMediaType> decodedType;
  result = MFCreateMediaType(&decodedType);
  if (SUCCEEDED(result)) result = decodedType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  if (SUCCEEDED(result)) result = decodedType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
  if (SUCCEEDED(result)) result = reader->SetCurrentMediaType(
      static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), nullptr,
      decodedType.Get());
  if (FAILED(result)) return result;
  ComPtr<IMFMediaType> currentType;
  result = reader->GetCurrentMediaType(
      static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), &currentType);
  UINT width = 0;
  UINT height = 0;
  if (SUCCEEDED(result)) result = MFGetAttributeSize(
      currentType.Get(), MF_MT_FRAME_SIZE, &width, &height);
  if (FAILED(result) || width != expectedWidth || height != expectedHeight) {
    return FAILED(result) ? result : MF_E_INVALIDMEDIATYPE;
  }
  std::int64_t previousTimestamp = -1;
  const std::uint64_t maximumReads = snapshot.units.size() * 2U + 32U;
  bool reachedEnd = false;
  for (std::uint64_t reads = 0; reads < maximumReads; ++reads) {
    DWORD stream = 0;
    DWORD flags = 0;
    LONGLONG timestamp = 0;
    ComPtr<IMFSample> sample;
    result = reader->ReadSample(
        static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), 0,
        &stream, &flags, &timestamp, &sample);
    if (FAILED(result)) return result;
    if ((flags & MF_SOURCE_READERF_ENDOFSTREAM) != 0) {
      reachedEnd = true;
      break;
    }
    if (sample) {
      if (timestamp < 0 || timestamp < previousTimestamp) {
        return MF_E_INVALID_TIMESTAMP;
      }
      ComPtr<IMFMediaBuffer> contiguous;
      result = sample->ConvertToContiguousBuffer(&contiguous);
      DWORD bytes = 0;
      if (SUCCEEDED(result)) result = contiguous->GetCurrentLength(&bytes);
      if (FAILED(result) || bytes == 0) return FAILED(result) ? result : E_FAIL;
      previousTimestamp = timestamp;
      ++decodedSamples;
    } else if ((flags & MF_SOURCE_READERF_STREAMTICK) == 0) {
      return E_FAIL;
    }
  }
  return reachedEnd && decodedSamples == snapshot.units.size() ? S_OK : E_FAIL;
}

ExportEvidence ExportSnapshot(const EncodedRingSnapshot& snapshot,
                              UINT width, UINT height,
                              const std::wstring& path,
                              std::size_t maximumBytes) {
  ExportEvidence evidence;
  if (!snapshot.safe()) {
    evidence.reason = ProbeReason::kNoSafeSnapshot;
    evidence.result = MF_E_INVALIDREQUEST;
    return evidence;
  }
  const AnnexBInspection config = InspectAnnexB(snapshot.codecConfig);
  if (!config.valid || !config.hasSps || !config.hasPps) {
    evidence.reason = ProbeReason::kCodecConfigInvalid;
    evidence.result = MF_E_INVALIDMEDIATYPE;
    return evidence;
  }
  ComPtr<IMFMediaType> mediaType;
  HRESULT result = SnapshotMediaType(snapshot, width, height, mediaType);
  ComPtr<IMFByteStream> byteStream;
  ComPtr<IMFMediaSink> sink;
  ComPtr<IMFSinkWriter> writer;
  bool created = false;
  if (SUCCEEDED(result)) result = MFCreateFile(
      MF_ACCESSMODE_WRITE, MF_OPENMODE_FAIL_IF_EXIST, MF_FILEFLAGS_NONE,
      path.c_str(), &byteStream);
  if (SUCCEEDED(result)) created = true;
  if (SUCCEEDED(result)) result = MFCreateFMPEG4MediaSink(
      byteStream.Get(), mediaType.Get(), nullptr, &sink);
  ComPtr<IMFAttributes> writerAttributes;
  if (SUCCEEDED(result)) result = MFCreateAttributes(&writerAttributes, 1);
  if (SUCCEEDED(result)) result = writerAttributes->SetUINT32(
      MF_READWRITE_DISABLE_CONVERTERS, TRUE);
  if (SUCCEEDED(result)) result = MFCreateSinkWriterFromMediaSink(
      sink.Get(), writerAttributes.Get(), &writer);
  if (SUCCEEDED(result)) result = writer->SetInputMediaType(0, mediaType.Get(), nullptr);
  if (SUCCEEDED(result)) result = writer->BeginWriting();
  if (FAILED(result)) {
    if (sink) sink->Shutdown();
    if (byteStream) byteStream->Close();
    if (created) DeleteFileW(path.c_str());
    evidence.result = result;
    evidence.reason = ProbeReason::kExportCreateFailed;
    return evidence;
  }
  result = WriteSnapshotSamples(writer.Get(), snapshot);
  if (FAILED(result)) evidence.reason = ProbeReason::kExportWriteFailed;
  if (SUCCEEDED(result)) {
    result = writer->Finalize();
    if (FAILED(result)) evidence.reason = ProbeReason::kExportFinalizeFailed;
  }
  writer.Reset();
  sink->Shutdown();
  sink.Reset();
  byteStream->Close();
  byteStream.Reset();
  if (FAILED(result)) {
    DeleteFileW(path.c_str());
    evidence.result = result;
    return evidence;
  }
  evidence.flags |= kRunCodecConfigValidated | kRunMp4Muxed;
  std::vector<std::uint8_t> fileBytes;
  if (!ReadBoundedFile(path, maximumBytes, fileBytes) ||
      !ValidateFragmentedMp4Structure(fileBytes)) {
    DeleteFileW(path.c_str());
    evidence.result = E_FAIL;
    evidence.reason = ProbeReason::kExportStructureInvalid;
    return evidence;
  }
  evidence.bytes = fileBytes.size();
  evidence.flags |= kRunMp4StructureValidated;
  result = DecodeAndValidateMp4(path, snapshot, width, height,
                                evidence.decodedSamples,
                                evidence.declaredDurationHns);
  if (FAILED(result)) {
    DeleteFileW(path.c_str());
    evidence.result = result;
    evidence.reason = ProbeReason::kExportDecodeFailed;
    return evidence;
  }
  evidence.flags |= kRunMp4Decoded;
  evidence.result = S_OK;
  evidence.reason = ProbeReason::kNone;
  return evidence;
}

enum class ServiceCommandKind { kNone, kSnapshot, kStop, kInvalid };

struct ServiceCommand {
  ServiceCommandKind kind = ServiceCommandKind::kNone;
  std::uint64_t requestId = 0;
  std::wstring path;
};

bool AbsoluteNormalizedPath(const std::wstring& path) {
  if (path.empty() || path.size() >= 32'767) return false;
  const bool driveAbsolute = path.size() >= 3 &&
      ((path[0] >= L'A' && path[0] <= L'Z') ||
       (path[0] >= L'a' && path[0] <= L'z')) &&
      path[1] == L':' && (path[2] == L'\\' || path[2] == L'/');
  const bool uncAbsolute = path.size() >= 3 && path[0] == L'\\' &&
                           path[1] == L'\\';
  if (!driveAbsolute && !uncAbsolute) return false;
  const DWORD needed = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
  if (needed == 0 || needed >= 32'767) return false;
  std::vector<wchar_t> normalized(needed);
  const DWORD written = GetFullPathNameW(path.c_str(), needed,
                                         normalized.data(), nullptr);
  if (written == 0 || written >= needed) return false;
  std::wstring normalizedPath(normalized.data(), written);
  std::replace(normalizedPath.begin(), normalizedPath.end(), L'/', L'\\');
  std::wstring comparable = path;
  std::replace(comparable.begin(), comparable.end(), L'/', L'\\');
  return _wcsicmp(normalizedPath.c_str(), comparable.c_str()) == 0;
}

bool Utf8ToWide(const std::string& utf8, std::wstring& wide) {
  wide.clear();
  if (utf8.empty() || utf8.size() > kMaximumServiceCommandBytes) return false;
  const int needed = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(),
      static_cast<int>(utf8.size()), nullptr, 0);
  if (needed <= 0 || needed >= 32'767) return false;
  wide.resize(static_cast<std::size_t>(needed));
  return MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(),
      static_cast<int>(utf8.size()), wide.data(), needed) == needed;
}

ServiceCommand ParseServiceCommand(const std::string& line,
                                   std::uint64_t lastRequestId) {
  // Stdin is bounded UTF-8, LF-delimited control text:
  // SNAPSHOT<TAB>uint64<TAB>absolute-normalized-path or STOP.
  ServiceCommand command;
  if (line == "STOP") {
    command.kind = ServiceCommandKind::kStop;
    return command;
  }
  constexpr char prefix[] = "SNAPSHOT\t";
  if (line.compare(0, sizeof(prefix) - 1, prefix) != 0 ||
      line.find('\0') != std::string::npos ||
      line.find('\r') != std::string::npos) {
    command.kind = ServiceCommandKind::kInvalid;
    return command;
  }
  const std::size_t idStart = sizeof(prefix) - 1;
  const std::size_t separator = line.find('\t', idStart);
  if (separator == std::string::npos ||
      line.find('\t', separator + 1) != std::string::npos) {
    command.kind = ServiceCommandKind::kInvalid;
    return command;
  }
  const char* first = line.data() + idStart;
  const char* last = line.data() + separator;
  const auto parsed = std::from_chars(first, last, command.requestId, 10);
  std::wstring path;
  if (parsed.ec != std::errc{} || parsed.ptr != last ||
      command.requestId == 0 || command.requestId <= lastRequestId ||
      !Utf8ToWide(line.substr(separator + 1), path) ||
      !AbsoluteNormalizedPath(path)) {
    command.kind = ServiceCommandKind::kInvalid;
    return command;
  }
  command.kind = ServiceCommandKind::kSnapshot;
  command.path = std::move(path);
  return command;
}

class ServiceCommandReader {
 public:
  ServiceCommand Poll(std::uint64_t lastRequestId) {
    if (closed_) return {ServiceCommandKind::kStop};
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    DWORD available = 0;
    if (input == nullptr || input == INVALID_HANDLE_VALUE ||
        !PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) {
      const DWORD error = GetLastError();
      if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) {
        closed_ = true;
        return {ServiceCommandKind::kStop};
      }
      return {ServiceCommandKind::kInvalid};
    }
    if (available > 0) {
      char chunk[4096];
      DWORD read = 0;
      const DWORD wanted = std::min<DWORD>(available, sizeof(chunk));
      if (!ReadFile(input, chunk, wanted, &read, nullptr)) {
        return {ServiceCommandKind::kInvalid};
      }
      buffered_.append(chunk, chunk + read);
      if (buffered_.size() > kMaximumServiceCommandBytes) {
        return {ServiceCommandKind::kInvalid};
      }
    }
    const std::size_t newline = buffered_.find('\n');
    if (newline == std::string::npos) return {};
    std::string line = buffered_.substr(0, newline);
    buffered_.erase(0, newline + 1);
    return ParseServiceCommand(line, lastRequestId);
  }

 private:
  bool closed_ = false;
  std::string buffered_;
};

bool QueryQpc(std::int64_t& value) {
  LARGE_INTEGER counter{};
  if (!QueryPerformanceCounter(&counter)) return false;
  value = counter.QuadPart;
  return true;
}

bool QueryQpcFrequency(std::int64_t& value) {
  LARGE_INTEGER frequency{};
  if (!QueryPerformanceFrequency(&frequency) || frequency.QuadPart <= 0) return false;
  value = frequency.QuadPart;
  return true;
}

bool AddMilliseconds(std::int64_t qpc, std::int64_t frequency,
                     std::uint32_t milliseconds, std::int64_t& result) {
  if (qpc < 0 || frequency <= 0) return false;
  const std::int64_t whole = frequency / 1000;
  const std::int64_t remainder = frequency % 1000;
  if (milliseconds > 0 &&
      whole > (std::numeric_limits<std::int64_t>::max() - qpc) /
                  static_cast<std::int64_t>(milliseconds)) {
    return false;
  }
  const std::int64_t base =
      qpc + whole * static_cast<std::int64_t>(milliseconds);
  const std::int64_t extra =
      (remainder * static_cast<std::int64_t>(milliseconds)) / 1000;
  if (base > std::numeric_limits<std::int64_t>::max() - extra) return false;
  result = base + extra;
  return true;
}

class ExposureTimeline {
 public:
  explicit ExposureTimeline(std::int64_t frequency) : frequency_(frequency) {}

  bool Map(std::int64_t qpc, std::int64_t& ptsHns) {
    if (frequency_ <= 0 || qpc <= 0 || (haveLast_ && qpc <= lastQpc_)) return false;
    if (!haveOrigin_) {
      originQpc_ = qpc;
      haveOrigin_ = true;
    }
    const std::int64_t delta = qpc - originQpc_;
    if (delta < 0) return false;
    const std::int64_t whole = delta / frequency_;
    const std::int64_t remainder = delta % frequency_;
    if (whole > std::numeric_limits<std::int64_t>::max() / 10'000'000) {
      return false;
    }
    ptsHns = whole * 10'000'000 +
             (remainder * 10'000'000) / frequency_;
    if (haveLast_ && ptsHns <= lastPtsHns_) return false;
    lastQpc_ = qpc;
    lastPtsHns_ = ptsHns;
    haveLast_ = true;
    return true;
  }

 private:
  const std::int64_t frequency_;
  bool haveOrigin_ = false;
  bool haveLast_ = false;
  std::int64_t originQpc_ = 0;
  std::int64_t lastQpc_ = 0;
  std::int64_t lastPtsHns_ = 0;
};

struct FrameGeometry {
  UINT sourceWidth = 0;
  UINT sourceHeight = 0;
  UINT outputWidth = 0;
  UINT outputHeight = 0;
  D3D11_VIDEO_PROCESSOR_ROTATION rotation =
      D3D11_VIDEO_PROCESSOR_ROTATION_IDENTITY;
  bool needsRotation = false;
};

bool ResolveFrameGeometry(const OutputChoice& choice,
                          const D3D11_TEXTURE2D_DESC& source,
                          FrameGeometry& geometry) {
  const LONG boundsWidth = choice.outputDesc.DesktopCoordinates.right -
                           choice.outputDesc.DesktopCoordinates.left;
  const LONG boundsHeight = choice.outputDesc.DesktopCoordinates.bottom -
                            choice.outputDesc.DesktopCoordinates.top;
  if (source.Format != DXGI_FORMAT_B8G8R8A8_UNORM || source.Width == 0 ||
      source.Height == 0 || boundsWidth < 2 || boundsHeight < 2 ||
      (boundsWidth & 1) != 0 || (boundsHeight & 1) != 0) {
    return false;
  }
  geometry.sourceWidth = source.Width;
  geometry.sourceHeight = source.Height;
  geometry.outputWidth = static_cast<UINT>(boundsWidth);
  geometry.outputHeight = static_cast<UINT>(boundsHeight);
  switch (choice.outputDesc.Rotation) {
    case DXGI_MODE_ROTATION_UNSPECIFIED:
    case DXGI_MODE_ROTATION_IDENTITY:
      geometry.rotation = D3D11_VIDEO_PROCESSOR_ROTATION_IDENTITY;
      break;
    case DXGI_MODE_ROTATION_ROTATE90:
      geometry.rotation = D3D11_VIDEO_PROCESSOR_ROTATION_90;
      geometry.needsRotation = true;
      break;
    case DXGI_MODE_ROTATION_ROTATE180:
      geometry.rotation = D3D11_VIDEO_PROCESSOR_ROTATION_180;
      geometry.needsRotation = true;
      break;
    case DXGI_MODE_ROTATION_ROTATE270:
      geometry.rotation = D3D11_VIDEO_PROCESSOR_ROTATION_270;
      geometry.needsRotation = true;
      break;
    default:
      return false;
  }
  const bool swapsAxes =
      choice.outputDesc.Rotation == DXGI_MODE_ROTATION_ROTATE90 ||
      choice.outputDesc.Rotation == DXGI_MODE_ROTATION_ROTATE270;
  const UINT orientedWidth = swapsAxes ? source.Height : source.Width;
  const UINT orientedHeight = swapsAxes ? source.Width : source.Height;
  return orientedWidth == geometry.outputWidth &&
         orientedHeight == geometry.outputHeight;
}

struct PointerState {
  bool hasPosition = false;
  bool visible = false;
  std::int64_t desktopX = 0;
  std::int64_t desktopY = 0;
  std::int64_t lastUpdateQpc = 0;
  bool hasShape = false;
  DXGI_OUTDUPL_POINTER_SHAPE_INFO shape{};
  std::vector<std::uint8_t> bytes;
};

UINT PointerShapeHeight(const DXGI_OUTDUPL_POINTER_SHAPE_INFO& shape) {
  return shape.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME
      ? shape.Height / 2U
      : shape.Height;
}

bool ValidatePointerShape(const DXGI_OUTDUPL_POINTER_SHAPE_INFO& shape,
                          std::size_t bytes) {
  if (shape.Type != DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR &&
      shape.Type != DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME &&
      shape.Type != DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR) {
    return false;
  }
  if (shape.Width == 0 || shape.Width > kMaximumPointerDimension ||
      shape.Height == 0 || shape.Pitch == 0) {
    return false;
  }
  if (shape.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME) {
    if ((shape.Height & 1U) != 0 ||
        shape.Height / 2U > kMaximumPointerDimension ||
        shape.Pitch < (shape.Width + 7U) / 8U) {
      return false;
    }
  } else if (shape.Height > kMaximumPointerDimension ||
             shape.Width > std::numeric_limits<UINT>::max() / 4U ||
             shape.Pitch < shape.Width * 4U) {
    return false;
  }
  const UINT height = PointerShapeHeight(shape);
  if (shape.HotSpot.x < 0 || shape.HotSpot.y < 0 ||
      static_cast<UINT>(shape.HotSpot.x) >= shape.Width ||
      static_cast<UINT>(shape.HotSpot.y) >= height ||
      shape.Height > std::numeric_limits<std::size_t>::max() / shape.Pitch) {
    return false;
  }
  const std::size_t expected =
      static_cast<std::size_t>(shape.Pitch) * shape.Height;
  return expected == bytes && expected <= kMaximumPointerShapeBytes;
}

bool UpdatePointerPosition(const DXGI_OUTDUPL_FRAME_INFO& frame,
                           const DXGI_OUTPUT_DESC& output,
                           PointerState& state) {
  if (frame.LastMouseUpdateTime.QuadPart == 0) return true;
  if (frame.LastMouseUpdateTime.QuadPart < 0 ||
      (state.lastUpdateQpc > 0 &&
       frame.LastMouseUpdateTime.QuadPart < state.lastUpdateQpc)) {
    return false;
  }
  // PointerPosition is output-local. Keep the persistent state in desktop
  // coordinates, as the Windows sample does, then subtract this output's
  // origin when drawing into its owned texture. This remains exact for
  // negative-origin and vertically offset outputs.
  state.desktopX = static_cast<std::int64_t>(
                       frame.PointerPosition.Position.x) +
                   output.DesktopCoordinates.left;
  state.desktopY = static_cast<std::int64_t>(
                       frame.PointerPosition.Position.y) +
                   output.DesktopCoordinates.top;
  state.lastUpdateQpc = frame.LastMouseUpdateTime.QuadPart;
  state.visible = frame.PointerPosition.Visible != FALSE;
  state.hasPosition = true;
  return true;
}

struct CursorDrawRegion {
  LONG logicalLeft = 0;
  LONG logicalTop = 0;
  UINT logicalWidth = 0;
  UINT logicalHeight = 0;
  UINT skipX = 0;
  UINT skipY = 0;
  UINT sourceLeft = 0;
  UINT sourceTop = 0;
  UINT sourceWidth = 0;
  UINT sourceHeight = 0;
  bool empty = true;
};

bool ResolveCursorDrawRegion(const PointerState& pointer,
                             const DXGI_OUTPUT_DESC& output,
                             const FrameGeometry& geometry,
                             CursorDrawRegion& region) {
  region = {};
  if (!pointer.hasPosition || !pointer.hasShape ||
      !ValidatePointerShape(pointer.shape, pointer.bytes.size())) {
    return false;
  }
  const std::int64_t localLeft =
      pointer.desktopX - output.DesktopCoordinates.left;
  const std::int64_t localTop =
      pointer.desktopY - output.DesktopCoordinates.top;
  const std::int64_t localRight = localLeft + pointer.shape.Width;
  const std::int64_t localBottom =
      localTop + PointerShapeHeight(pointer.shape);
  const std::int64_t clippedLeft = std::max<std::int64_t>(0, localLeft);
  const std::int64_t clippedTop = std::max<std::int64_t>(0, localTop);
  const std::int64_t clippedRight =
      std::min<std::int64_t>(geometry.outputWidth, localRight);
  const std::int64_t clippedBottom =
      std::min<std::int64_t>(geometry.outputHeight, localBottom);
  if (clippedLeft >= clippedRight || clippedTop >= clippedBottom) {
    region.empty = true;
    return true;
  }
  region.empty = false;
  region.logicalLeft = static_cast<LONG>(clippedLeft);
  region.logicalTop = static_cast<LONG>(clippedTop);
  region.logicalWidth = static_cast<UINT>(clippedRight - clippedLeft);
  region.logicalHeight = static_cast<UINT>(clippedBottom - clippedTop);
  region.skipX = static_cast<UINT>(clippedLeft - localLeft);
  region.skipY = static_cast<UINT>(clippedTop - localTop);
  switch (geometry.rotation) {
    case D3D11_VIDEO_PROCESSOR_ROTATION_IDENTITY:
      region.sourceLeft = static_cast<UINT>(clippedLeft);
      region.sourceTop = static_cast<UINT>(clippedTop);
      region.sourceWidth = region.logicalWidth;
      region.sourceHeight = region.logicalHeight;
      break;
    case D3D11_VIDEO_PROCESSOR_ROTATION_90:
      region.sourceLeft = static_cast<UINT>(clippedTop);
      region.sourceTop = static_cast<UINT>(geometry.outputWidth - clippedRight);
      region.sourceWidth = region.logicalHeight;
      region.sourceHeight = region.logicalWidth;
      break;
    case D3D11_VIDEO_PROCESSOR_ROTATION_180:
      region.sourceLeft = static_cast<UINT>(geometry.outputWidth - clippedRight);
      region.sourceTop = static_cast<UINT>(geometry.outputHeight - clippedBottom);
      region.sourceWidth = region.logicalWidth;
      region.sourceHeight = region.logicalHeight;
      break;
    case D3D11_VIDEO_PROCESSOR_ROTATION_270:
      region.sourceLeft = static_cast<UINT>(geometry.outputHeight - clippedBottom);
      region.sourceTop = static_cast<UINT>(clippedLeft);
      region.sourceWidth = region.logicalHeight;
      region.sourceHeight = region.logicalWidth;
      break;
    default:
      return false;
  }
  return region.sourceWidth > 0 && region.sourceHeight > 0 &&
         region.sourceWidth <= geometry.sourceWidth &&
         region.sourceHeight <= geometry.sourceHeight &&
         region.sourceLeft <= geometry.sourceWidth - region.sourceWidth &&
         region.sourceTop <= geometry.sourceHeight - region.sourceHeight;
}

bool SourcePixelToLogical(const FrameGeometry& geometry,
                          const CursorDrawRegion& region, UINT sourceX,
                          UINT sourceY, UINT& logicalX, UINT& logicalY) {
  if (sourceX >= region.sourceWidth || sourceY >= region.sourceHeight) {
    return false;
  }
  switch (geometry.rotation) {
    case D3D11_VIDEO_PROCESSOR_ROTATION_IDENTITY:
      logicalX = sourceX;
      logicalY = sourceY;
      break;
    case D3D11_VIDEO_PROCESSOR_ROTATION_90:
      logicalX = region.logicalWidth - 1U - sourceY;
      logicalY = sourceX;
      break;
    case D3D11_VIDEO_PROCESSOR_ROTATION_180:
      logicalX = region.logicalWidth - 1U - sourceX;
      logicalY = region.logicalHeight - 1U - sourceY;
      break;
    case D3D11_VIDEO_PROCESSOR_ROTATION_270:
      logicalX = sourceY;
      logicalY = region.logicalHeight - 1U - sourceX;
      break;
    default:
      return false;
  }
  return logicalX < region.logicalWidth && logicalY < region.logicalHeight;
}

std::uint32_t ReadPointerColor(const PointerState& pointer, UINT x, UINT y) {
  std::uint32_t pixel = 0;
  std::memcpy(&pixel,
              pointer.bytes.data() + static_cast<std::size_t>(y) *
                                         pointer.shape.Pitch +
                  static_cast<std::size_t>(x) * 4U,
              sizeof(pixel));
  return pixel;
}

bool PointerMaskBit(const PointerState& pointer, UINT x, UINT y) {
  const std::size_t offset = static_cast<std::size_t>(y) *
                                 pointer.shape.Pitch +
                             x / 8U;
  return (pointer.bytes[offset] & (0x80U >> (x % 8U))) != 0;
}

bool BuildCursorPixels(const PointerState& pointer,
                       const FrameGeometry& geometry,
                       const CursorDrawRegion& region,
                       const std::vector<std::uint32_t>* background,
                       std::vector<std::uint32_t>& pixels) {
  if (region.empty || !ValidatePointerShape(pointer.shape, pointer.bytes.size()) ||
      region.sourceWidth > kMaximumPointerDimension ||
      region.sourceHeight > kMaximumPointerDimension) {
    return false;
  }
  const std::size_t count = static_cast<std::size_t>(region.sourceWidth) *
                            region.sourceHeight;
  const bool needsBackground =
      pointer.shape.Type != DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR;
  if (needsBackground &&
      (background == nullptr || background->size() != count)) {
    return false;
  }
  pixels.resize(count);
  for (UINT sourceY = 0; sourceY < region.sourceHeight; ++sourceY) {
    for (UINT sourceX = 0; sourceX < region.sourceWidth; ++sourceX) {
      UINT logicalX = 0;
      UINT logicalY = 0;
      if (!SourcePixelToLogical(geometry, region, sourceX, sourceY,
                                logicalX, logicalY)) {
        return false;
      }
      const UINT shapeX = region.skipX + logicalX;
      const UINT shapeY = region.skipY + logicalY;
      const std::size_t destination =
          static_cast<std::size_t>(sourceY) * region.sourceWidth + sourceX;
      if (pointer.shape.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR) {
        pixels[destination] = ReadPointerColor(pointer, shapeX, shapeY);
      } else if (pointer.shape.Type ==
                 DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME) {
        const bool andMask = PointerMaskBit(pointer, shapeX, shapeY);
        const bool xorMask = PointerMaskBit(
            pointer, shapeX, shapeY + PointerShapeHeight(pointer.shape));
        const std::uint32_t andValue =
            andMask ? 0xffffffffU : 0xff000000U;
        const std::uint32_t xorValue =
            xorMask ? 0x00ffffffU : 0x00000000U;
        pixels[destination] =
            ((*background)[destination] & andValue) ^ xorValue;
      } else if (pointer.shape.Type ==
                 DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR) {
        const std::uint32_t shapePixel =
            ReadPointerColor(pointer, shapeX, shapeY);
        pixels[destination] = (shapePixel & 0xff000000U) != 0
            ? (((*background)[destination] ^ shapePixel) | 0xff000000U)
            : (shapePixel | 0xff000000U);
      } else {
        return false;
      }
    }
  }
  return true;
}

enum class EncoderTransition { kNeedInput, kHaveOutput, kDrainComplete, kError };

class EncoderTransitionState {
 public:
  bool Apply(EncoderTransition transition) {
    if (failed_) return false;
    switch (transition) {
      case EncoderTransition::kNeedInput:
        if (draining_) return true;
        ++inputCredits_;
        return true;
      case EncoderTransition::kHaveOutput:
        ++outputsReady_;
        return true;
      case EncoderTransition::kDrainComplete:
        if (!draining_) return false;
        drainComplete_ = true;
        return true;
      case EncoderTransition::kError:
        failed_ = true;
        return false;
    }
    return false;
  }
  bool ConsumeInputCredit() {
    if (failed_ || draining_ || inputCredits_ == 0) return false;
    --inputCredits_;
    return true;
  }
  bool ConsumeOutput() {
    if (failed_ || outputsReady_ == 0) return false;
    --outputsReady_;
    return true;
  }
  void BeginDrain() { draining_ = true; }
  std::uint32_t inputCredits() const { return inputCredits_; }
  bool drainComplete() const { return drainComplete_; }

 private:
  std::uint32_t inputCredits_ = 0;
  std::uint32_t outputsReady_ = 0;
  bool draining_ = false;
  bool drainComplete_ = false;
  bool failed_ = false;
};

bool IsDeviceLoss(HRESULT result) {
  return result == DXGI_ERROR_DEVICE_REMOVED ||
         result == DXGI_ERROR_DEVICE_RESET ||
         result == DXGI_ERROR_DEVICE_HUNG ||
         result == DXGI_ERROR_DRIVER_INTERNAL_ERROR;
}

enum class RecoveryDecision { kContinue, kReinitialize, kFail };

RecoveryDecision RecoveryFor(HRESULT result, std::uint32_t attempts) {
  if (result == DXGI_ERROR_WAIT_TIMEOUT) return RecoveryDecision::kContinue;
  if ((result == DXGI_ERROR_ACCESS_LOST || IsDeviceLoss(result)) &&
      attempts < kMaximumReinitializations) {
    return RecoveryDecision::kReinitialize;
  }
  return RecoveryDecision::kFail;
}

void ReleaseActivations(IMFActivate** activations, UINT32 count) {
  if (activations == nullptr) return;
  for (UINT32 index = 0; index < count; ++index) {
    if (activations[index] != nullptr) activations[index]->Release();
  }
  CoTaskMemFree(activations);
}

HRESULT ActivateHardwareEncoder(const OutputChoice& choice,
                                ComPtr<IMFActivate>& selectedActivation,
                                ComPtr<IMFTransform>& transform,
                                std::string& encoderName) {
  MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_NV12};
  MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_H264};
  ComPtr<IMFAttributes> attributes;
  HRESULT result = MFCreateAttributes(&attributes, 1);
  if (FAILED(result)) return result;
  result = attributes->SetBlob(
      MFT_ENUM_ADAPTER_LUID,
      reinterpret_cast<const UINT8*>(&choice.adapterDesc.AdapterLuid),
      sizeof(choice.adapterDesc.AdapterLuid));
  if (FAILED(result)) return result;
  IMFActivate** activations = nullptr;
  UINT32 count = 0;
  using MftEnum2Function = HRESULT(WINAPI*)(
      GUID, UINT32, const MFT_REGISTER_TYPE_INFO*,
      const MFT_REGISTER_TYPE_INFO*, IMFAttributes*, IMFActivate***, UINT32*);
  const HMODULE mfplat = GetModuleHandleW(L"mfplat.dll");
  const auto enumerate = mfplat == nullptr
      ? nullptr
      : reinterpret_cast<MftEnum2Function>(GetProcAddress(mfplat, "MFTEnum2"));
  if (enumerate == nullptr) return HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND);
  result = enumerate(MFT_CATEGORY_VIDEO_ENCODER,
                     MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                     &input, &output, attributes.Get(), &activations, &count);
  if (FAILED(result)) return result;
  result = MF_E_TOPO_CODEC_NOT_FOUND;
  for (UINT32 index = 0; index < count; ++index) {
    if (activations[index] == nullptr) continue;
    ComPtr<IMFTransform> candidate;
    const HRESULT activateResult =
        activations[index]->ActivateObject(IID_PPV_ARGS(&candidate));
    if (FAILED(activateResult)) {
      result = activateResult;
      continue;
    }
    ComPtr<IMFAttributes> candidateAttributes;
    UINT32 d3dAware = FALSE;
    UINT32 asynchronous = FALSE;
    if (FAILED(candidate->GetAttributes(&candidateAttributes)) ||
        FAILED(candidateAttributes->GetUINT32(MF_SA_D3D11_AWARE, &d3dAware)) ||
        d3dAware == FALSE ||
        FAILED(candidateAttributes->GetUINT32(MF_TRANSFORM_ASYNC, &asynchronous)) ||
        asynchronous == FALSE ||
        FAILED(candidateAttributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE))) {
      candidate.Reset();
      activations[index]->ShutdownObject();
      result = MF_E_UNSUPPORTED_D3D_TYPE;
      continue;
    }
    wchar_t* allocatedName = nullptr;
    UINT32 allocatedCharacters = 0;
    if (SUCCEEDED(activations[index]->GetAllocatedString(
            MFT_FRIENDLY_NAME_Attribute, &allocatedName, &allocatedCharacters))) {
      encoderName = Utf8(allocatedName);
      CoTaskMemFree(allocatedName);
    }
    if (encoderName.empty()) encoderName = "unnamed hardware H.264 MFT";
    selectedActivation.Attach(activations[index]);
    activations[index] = nullptr;
    transform = candidate;
    result = S_OK;
    break;
  }
  ReleaseActivations(activations, count);
  return result;
}

bool SetCodecUint32(ICodecAPI* codec, const GUID& property, ULONG value,
                    bool required) {
  if (codec == nullptr) return !required;
  VARIANT variant{};
  variant.vt = VT_UI4;
  variant.ulVal = value;
  const HRESULT result = codec->SetValue(&property, &variant);
  return SUCCEEDED(result) || !required;
}

bool SetCodecBool(ICodecAPI* codec, const GUID& property, bool value) {
  if (codec == nullptr) return false;
  VARIANT variant{};
  variant.vt = VT_BOOL;
  variant.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
  return SUCCEEDED(codec->SetValue(&property, &variant));
}

struct PendingInput {
  std::int64_t ptsHns = 0;
  std::int64_t durationHns = 0;
  std::int64_t exposedQpc = 0;
  std::uint32_t generation = 0;
};

class EncoderSession {
 public:
  ~EncoderSession() { Shutdown(); }

  HRESULT Initialize(const OutputChoice& choice, IMFDXGIDeviceManager* manager,
                     UINT width, UINT height, std::uint32_t generation,
                     std::string& encoderName) {
    generation_ = generation;
    HRESULT result = ActivateHardwareEncoder(
        choice, activation_, transform_, encoderName);
    if (FAILED(result)) return result;
    result = transform_.As(&events_);
    if (FAILED(result)) return result;
    result = transform_->ProcessMessage(
        MFT_MESSAGE_SET_D3D_MANAGER, reinterpret_cast<ULONG_PTR>(manager));
    if (FAILED(result)) return result;

    ComPtr<ICodecAPI> codec;
    transform_.As(&codec);
    // Main-profile snapshots are only independently decodable when the ring
    // can use presentation order as decode order. Microsoft requires this
    // property to be set before SetOutputType; an encoder that cannot prove
    // zero B pictures must not reach READY.
    if (!SetCodecUint32(codec.Get(), CODECAPI_AVEncMPVDefaultBPictureCount,
                        0, true)) {
      return MF_E_INVALIDREQUEST;
    }

    result = MFCreateMediaType(&outputType_);
    if (SUCCEEDED(result)) result = outputType_->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    if (SUCCEEDED(result)) result = outputType_->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
    if (SUCCEEDED(result)) result = MFSetAttributeSize(outputType_.Get(), MF_MT_FRAME_SIZE,
                                                       width, height);
    if (SUCCEEDED(result)) result = MFSetAttributeRatio(
        outputType_.Get(), MF_MT_FRAME_RATE, kTargetFramesPerSecond, 1);
    if (SUCCEEDED(result)) result = outputType_->SetUINT32(
        MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    if (SUCCEEDED(result)) result = outputType_->SetUINT32(
        MF_MT_AVG_BITRATE, kTargetBitsPerSecond);
    if (SUCCEEDED(result)) result = outputType_->SetUINT32(
        MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main);
    if (SUCCEEDED(result)) result = MFSetAttributeRatio(
        outputType_.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    if (SUCCEEDED(result)) result = transform_->SetOutputType(0, outputType_.Get(), 0);
    if (FAILED(result)) return result;

    result = MFCreateMediaType(&inputType_);
    if (SUCCEEDED(result)) result = inputType_->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    if (SUCCEEDED(result)) result = inputType_->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    if (SUCCEEDED(result)) result = MFSetAttributeSize(inputType_.Get(), MF_MT_FRAME_SIZE,
                                                       width, height);
    if (SUCCEEDED(result)) result = MFSetAttributeRatio(
        inputType_.Get(), MF_MT_FRAME_RATE, kTargetFramesPerSecond, 1);
    if (SUCCEEDED(result)) result = inputType_->SetUINT32(
        MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    if (SUCCEEDED(result)) result = MFSetAttributeRatio(
        inputType_.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    if (SUCCEEDED(result)) result = transform_->SetInputType(0, inputType_.Get(), 0);
    if (FAILED(result)) return result;

    if (!SetCodecBool(codec.Get(), CODECAPI_AVLowLatencyMode, true)) {
      return MF_E_INVALIDREQUEST;
    }
    if (!SetCodecUint32(codec.Get(), CODECAPI_AVEncMPVGOPSize,
                        kKeyframeIntervalFrames, true)) {
      return MF_E_INVALIDREQUEST;
    }

    result = transform_->GetOutputStreamInfo(0, &outputInfo_);
    if (FAILED(result)) return result;
    if ((outputInfo_.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES) == 0 &&
        (outputInfo_.cbSize == 0 || outputInfo_.cbSize > 16U * 1024U * 1024U)) {
      return MF_E_INVALIDMEDIATYPE;
    }
    result = MFCreateVideoSampleAllocatorEx(IID_PPV_ARGS(&allocator_));
    if (SUCCEEDED(result)) result = allocator_->SetDirectXManager(manager);
    ComPtr<IMFAttributes> allocatorAttributes;
    if (SUCCEEDED(result)) result = MFCreateAttributes(&allocatorAttributes, 2);
    if (SUCCEEDED(result)) result = allocatorAttributes->SetUINT32(
        MF_SA_D3D11_USAGE, D3D11_USAGE_DEFAULT);
    if (SUCCEEDED(result)) result = allocatorAttributes->SetUINT32(
        MF_SA_D3D11_BINDFLAGS,
        D3D11_BIND_RENDER_TARGET | D3D11_BIND_VIDEO_ENCODER);
    if (SUCCEEDED(result)) result = allocator_->InitializeSampleAllocatorEx(
        4, 4, allocatorAttributes.Get(), inputType_.Get());
    if (FAILED(result)) return result;
    std::vector<std::uint8_t> initialConfig;
    if (SUCCEEDED(ReadCodecConfig(initialConfig))) {
      const AnnexBInspection inspected = InspectAnnexB(initialConfig);
      if (!inspected.valid || !inspected.hasSps || !inspected.hasPps) {
        return MF_E_INVALIDMEDIATYPE;
      }
      codecConfig_ = std::move(initialConfig);
    }
    result = transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    if (SUCCEEDED(result)) {
      result = transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
    }
    if (FAILED(result)) return result;
    streaming_ = true;
    if (!SetCodecUint32(codec.Get(), CODECAPI_AVEncVideoForceKeyFrame, 1, true)) {
      return MF_E_INVALIDREQUEST;
    }
    return S_OK;
  }

  HRESULT AllocateInput(ComPtr<IMFSample>& sample,
                        ComPtr<ID3D11Texture2D>& texture,
                        UINT& subresourceIndex) {
    HRESULT result = allocator_->AllocateSample(&sample);
    if (FAILED(result)) return result;
    ComPtr<IMFMediaBuffer> buffer;
    result = sample->GetBufferByIndex(0, &buffer);
    ComPtr<IMFDXGIBuffer> dxgiBuffer;
    if (SUCCEEDED(result)) result = buffer.As(&dxgiBuffer);
    if (SUCCEEDED(result)) {
      result = dxgiBuffer->GetResource(IID_PPV_ARGS(&texture));
    }
    if (SUCCEEDED(result)) result = dxgiBuffer->GetSubresourceIndex(&subresourceIndex);
    return result;
  }

  HRESULT Pump(EncodedAccessUnitRing& ring, RunSummaryPacket& summary) {
    for (;;) {
      ComPtr<IMFMediaEvent> event;
      HRESULT result = events_->GetEvent(MF_EVENT_FLAG_NO_WAIT, &event);
      if (result == MF_E_NO_EVENTS_AVAILABLE) return S_OK;
      if (FAILED(result)) return result;
      HRESULT eventStatus = S_OK;
      MediaEventType eventType = MEUnknown;
      if (FAILED(event->GetStatus(&eventStatus)) || FAILED(eventStatus) ||
          FAILED(event->GetType(&eventType))) {
        return FAILED(eventStatus) ? eventStatus : E_FAIL;
      }
      if (eventType == METransformNeedInput) {
        if (!transitions_.Apply(EncoderTransition::kNeedInput)) return MF_E_INVALIDREQUEST;
      } else if (eventType == METransformHaveOutput) {
        if (!transitions_.Apply(EncoderTransition::kHaveOutput)) return MF_E_INVALIDREQUEST;
        result = PullOutput(ring, summary);
        if (FAILED(result)) return result;
      } else if (eventType == METransformDrainComplete) {
        if (!transitions_.Apply(EncoderTransition::kDrainComplete)) {
          return MF_E_INVALIDREQUEST;
        }
      } else if (eventType == MEError) {
        transitions_.Apply(EncoderTransition::kError);
        return FAILED(eventStatus) ? eventStatus : E_FAIL;
      }
    }
  }

  HRESULT Submit(IMFSample* sample, std::int64_t exposedQpc,
                 std::int64_t ptsHns, std::int64_t durationHns) {
    if (!transitions_.ConsumeInputCredit()) return MF_E_NOTACCEPTING;
    HRESULT result = sample->SetSampleTime(ptsHns);
    if (SUCCEEDED(result)) result = sample->SetSampleDuration(durationHns);
    if (SUCCEEDED(result) && firstInput_) {
      result = sample->SetUINT32(MFSampleExtension_Discontinuity, TRUE);
    }
    if (SUCCEEDED(result)) result = transform_->ProcessInput(0, sample, 0);
    if (FAILED(result)) return result;
    firstInput_ = false;
    pending_.push_back({ptsHns, durationHns, exposedQpc, generation_});
    return S_OK;
  }

  std::uint32_t inputCredits() const { return transitions_.inputCredits(); }

  HRESULT WaitForInput(std::uint32_t timeoutMs, EncodedAccessUnitRing& ring,
                       RunSummaryPacket& summary) {
    std::int64_t frequency = 0;
    std::int64_t start = 0;
    std::int64_t deadline = 0;
    if (!QueryQpcFrequency(frequency) || !QueryQpc(start) ||
        !AddMilliseconds(start, frequency, timeoutMs, deadline)) {
      return E_FAIL;
    }
    while (transitions_.inputCredits() == 0) {
      const HRESULT result = Pump(ring, summary);
      if (FAILED(result)) return result;
      std::int64_t now = 0;
      if (!QueryQpc(now)) return E_FAIL;
      if (now >= deadline) return HRESULT_FROM_WIN32(WAIT_TIMEOUT);
      SwitchToThread();
    }
    return S_OK;
  }

  HRESULT Drain(std::int64_t deadlineQpc, EncodedAccessUnitRing& ring,
                RunSummaryPacket& summary) {
    if (!streaming_) return S_OK;
    HRESULT result = transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    if (FAILED(result)) return result;
    transitions_.BeginDrain();
    result = transform_->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
    if (FAILED(result)) return result;
    while (!transitions_.drainComplete()) {
      result = Pump(ring, summary);
      if (FAILED(result)) return result;
      std::int64_t now = 0;
      if (!QueryQpc(now) || now >= deadlineQpc) return HRESULT_FROM_WIN32(WAIT_TIMEOUT);
      SwitchToThread();
    }
    return S_OK;
  }

 private:
  HRESULT ReadCodecConfig(std::vector<std::uint8_t>& config) const {
    config.clear();
    ComPtr<IMFMediaType> currentType;
    IMFMediaType* type = outputType_.Get();
    if (SUCCEEDED(transform_->GetOutputCurrentType(0, &currentType)) &&
        currentType) {
      type = currentType.Get();
    }
    UINT32 bytes = 0;
    if (FAILED(type->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &bytes)) ||
        bytes == 0 || bytes > 64U * 1024U) {
      return MF_E_INVALIDMEDIATYPE;
    }
    config.resize(bytes);
    UINT32 written = 0;
    if (FAILED(type->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER, config.data(), bytes,
                             &written)) ||
        written != bytes) {
      config.clear();
      return MF_E_INVALIDMEDIATYPE;
    }
    return S_OK;
  }

  HRESULT PullOutput(EncodedAccessUnitRing& ring, RunSummaryPacket& summary) {
    if (!transitions_.ConsumeOutput()) return MF_E_INVALIDREQUEST;
    ComPtr<IMFSample> callerSample;
    if ((outputInfo_.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES) == 0) {
      HRESULT result = MFCreateSample(&callerSample);
      ComPtr<IMFMediaBuffer> buffer;
      if (SUCCEEDED(result)) result = MFCreateAlignedMemoryBuffer(
          outputInfo_.cbSize, outputInfo_.cbAlignment, &buffer);
      if (SUCCEEDED(result)) result = callerSample->AddBuffer(buffer.Get());
      if (FAILED(result)) return result;
    }
    MFT_OUTPUT_DATA_BUFFER output{};
    output.dwStreamID = 0;
    output.pSample = callerSample.Get();
    DWORD status = 0;
    HRESULT result = transform_->ProcessOutput(0, 1, &output, &status);
    if (output.pEvents != nullptr) output.pEvents->Release();
    if (FAILED(result)) return result;
    ComPtr<IMFSample> produced;
    if (callerSample) {
      produced = callerSample;
    } else if (output.pSample != nullptr) {
      produced.Attach(output.pSample);
    } else {
      return MF_E_TRANSFORM_NEED_MORE_INPUT;
    }
    std::int64_t ptsHns = 0;
    if (FAILED(produced->GetSampleTime(&ptsHns)) || pending_.empty()) return E_FAIL;
    auto pending = std::find_if(
        pending_.begin(), pending_.end(), [ptsHns](const PendingInput& input) {
          return input.ptsHns == ptsHns;
        });
    if (pending == pending_.end()) return E_FAIL;
    if (pending != pending_.begin()) return E_FAIL;
    PendingInput timing = *pending;
    pending_.erase(pending);
    std::int64_t durationHns = timing.durationHns;
    produced->GetSampleDuration(&durationHns);
    if (durationHns <= 0) return E_FAIL;
    const bool keyframe =
        MFGetAttributeUINT32(produced.Get(), MFSampleExtension_CleanPoint, FALSE) != FALSE;
    if (keyframe) {
      std::vector<std::uint8_t> currentConfig;
      if (FAILED(ReadCodecConfig(currentConfig))) return MF_E_INVALIDMEDIATYPE;
      const AnnexBInspection config = InspectAnnexB(currentConfig);
      if (!config.valid || !config.hasSps || !config.hasPps) {
        return MF_E_INVALIDMEDIATYPE;
      }
      if (!codecConfig_.empty() && currentConfig != codecConfig_) {
        return MF_E_TRANSFORM_STREAM_CHANGE;
      }
      codecConfig_ = std::move(currentConfig);
    }
    if (keyframe && codecConfig_.empty()) return MF_E_INVALIDMEDIATYPE;
    ComPtr<IMFMediaBuffer> contiguous;
    result = produced->ConvertToContiguousBuffer(&contiguous);
    if (FAILED(result)) return result;
    BYTE* bytes = nullptr;
    DWORD maximum = 0;
    DWORD current = 0;
    result = contiguous->Lock(&bytes, &maximum, &current);
    if (FAILED(result)) return result;
    if (current == 0 || current > kMaximumRingBytes) {
      contiguous->Unlock();
      return MF_E_BUFFERTOOSMALL;
    }
    EncodedAccessUnit unit;
    unit.exposedQpc = timing.exposedQpc;
    unit.ptsHns = ptsHns;
    unit.durationHns = durationHns;
    unit.generation = timing.generation;
    unit.keyframe = keyframe;
    if (keyframe) unit.codecConfig = codecConfig_;
    unit.bytes.assign(bytes, bytes + current);
    contiguous->Unlock();
    const AnnexBInspection accessUnit = InspectAnnexB(unit.bytes);
    if (!accessUnit.valid || !accessUnit.hasVcl ||
        accessUnit.hasIdr != keyframe ||
        ((accessUnit.hasSps || accessUnit.hasPps) &&
         (!keyframe || !accessUnit.hasSps || !accessUnit.hasPps))) {
      return MF_E_INVALIDMEDIATYPE;
    }
    summary.encodedSamples += 1;
    summary.encodedBytes += current;
    if (keyframe) summary.keyframes += 1;
    if (!ring.Append(std::move(unit))) return MF_E_INVALIDREQUEST;
    summary.flags |= kRunH264Produced | kRunRingRetained;
    return S_OK;
  }

  void Shutdown() {
    if (transform_ && streaming_) {
      transform_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
      transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    }
    allocator_.Reset();
    events_.Reset();
    transform_.Reset();
    if (activation_) activation_->ShutdownObject();
    activation_.Reset();
    streaming_ = false;
  }

  std::uint32_t generation_ = 0;
  bool streaming_ = false;
  bool firstInput_ = true;
  MFT_OUTPUT_STREAM_INFO outputInfo_{};
  EncoderTransitionState transitions_;
  std::deque<PendingInput> pending_;
  std::vector<std::uint8_t> codecConfig_;
  ComPtr<IMFActivate> activation_;
  ComPtr<IMFTransform> transform_;
  ComPtr<IMFMediaEventGenerator> events_;
  ComPtr<IMFMediaType> inputType_;
  ComPtr<IMFMediaType> outputType_;
  ComPtr<IMFVideoSampleAllocatorEx> allocator_;
};

bool GpuCompletedWithin(ID3D11Device* device, ID3D11DeviceContext* context,
                        std::uint32_t timeoutMs, HRESULT& failure) {
  D3D11_QUERY_DESC description{};
  description.Query = D3D11_QUERY_EVENT;
  ComPtr<ID3D11Query> completion;
  failure = device->CreateQuery(&description, &completion);
  if (FAILED(failure)) return false;
  context->End(completion.Get());
  context->Flush();
  std::int64_t frequency = 0;
  std::int64_t start = 0;
  std::int64_t deadline = 0;
  if (!QueryQpcFrequency(frequency) || !QueryQpc(start) ||
      !AddMilliseconds(start, frequency, timeoutMs, deadline)) {
    failure = E_FAIL;
    return false;
  }
  for (;;) {
    const HRESULT result = context->GetData(
        completion.Get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
    if (result == S_OK) {
      failure = S_OK;
      return true;
    }
    if (result != S_FALSE) {
      failure = result;
      return false;
    }
    std::int64_t now = 0;
    if (!QueryQpc(now)) {
      failure = E_FAIL;
      return false;
    }
    if (now >= deadline) {
      failure = DXGI_ERROR_WAIT_TIMEOUT;
      return false;
    }
    SwitchToThread();
  }
}

struct CursorVertex {
  float x;
  float y;
  float u;
  float v;
};

class CursorCompositor {
 public:
  HRESULT Initialize(ID3D11Device* device, ID3D11DeviceContext* context,
                     ID3D11Texture2D* target, UINT width, UINT height) {
    if (device == nullptr || context == nullptr || target == nullptr ||
        width == 0 || height == 0) {
      return E_INVALIDARG;
    }
    device_ = device;
    context_ = context;
    width_ = width;
    height_ = height;
    HRESULT result = device_->CreateRenderTargetView(target, nullptr, &targetView_);
    if (FAILED(result)) return result;

    static constexpr char kVertexShader[] =
        "struct I{float2 p:POSITION;float2 t:TEXCOORD0;};"
        "struct O{float4 p:SV_POSITION;float2 t:TEXCOORD0;};"
        "O main(I i){O o;o.p=float4(i.p,0,1);o.t=i.t;return o;}";
    static constexpr char kPixelShader[] =
        "Texture2D c:register(t0);SamplerState s:register(s0);"
        "float4 main(float4 p:SV_POSITION,float2 t:TEXCOORD0):SV_TARGET"
        "{return c.Sample(s,t);}";
    ComPtr<ID3DBlob> vertexBytecode;
    ComPtr<ID3DBlob> pixelBytecode;
    ComPtr<ID3DBlob> errors;
    result = D3DCompile(kVertexShader, sizeof(kVertexShader) - 1,
                        "CapturePackCursorVS", nullptr, nullptr, "main",
                        "vs_4_0", D3DCOMPILE_ENABLE_STRICTNESS, 0,
                        &vertexBytecode, &errors);
    if (FAILED(result)) return result;
    errors.Reset();
    result = D3DCompile(kPixelShader, sizeof(kPixelShader) - 1,
                        "CapturePackCursorPS", nullptr, nullptr, "main",
                        "ps_4_0", D3DCOMPILE_ENABLE_STRICTNESS, 0,
                        &pixelBytecode, &errors);
    if (FAILED(result)) return result;
    result = device_->CreateVertexShader(
        vertexBytecode->GetBufferPointer(), vertexBytecode->GetBufferSize(),
        nullptr, &vertexShader_);
    if (FAILED(result)) return result;
    result = device_->CreatePixelShader(
        pixelBytecode->GetBufferPointer(), pixelBytecode->GetBufferSize(),
        nullptr, &pixelShader_);
    if (FAILED(result)) return result;
    const D3D11_INPUT_ELEMENT_DESC elements[] = {
        {"POSITION", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 0,
         D3D11_INPUT_PER_VERTEX_DATA, 0},
        {"TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 8,
         D3D11_INPUT_PER_VERTEX_DATA, 0},
    };
    result = device_->CreateInputLayout(
        elements, ARRAYSIZE(elements), vertexBytecode->GetBufferPointer(),
        vertexBytecode->GetBufferSize(), &inputLayout_);
    if (FAILED(result)) return result;
    D3D11_SAMPLER_DESC sampler{};
    sampler.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;
    sampler.AddressU = D3D11_TEXTURE_ADDRESS_CLAMP;
    sampler.AddressV = D3D11_TEXTURE_ADDRESS_CLAMP;
    sampler.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sampler.ComparisonFunc = D3D11_COMPARISON_NEVER;
    sampler.MaxLOD = D3D11_FLOAT32_MAX;
    result = device_->CreateSamplerState(&sampler, &sampler_);
    if (FAILED(result)) return result;
    D3D11_BLEND_DESC blend{};
    blend.RenderTarget[0].BlendEnable = TRUE;
    blend.RenderTarget[0].SrcBlend = D3D11_BLEND_SRC_ALPHA;
    blend.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
    blend.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
    blend.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE;
    blend.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_ZERO;
    blend.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
    blend.RenderTarget[0].RenderTargetWriteMask =
        D3D11_COLOR_WRITE_ENABLE_ALL;
    return device_->CreateBlendState(&blend, &blendState_);
  }

  HRESULT Composite(const PointerState& pointer,
                    const DXGI_OUTPUT_DESC& output,
                    const FrameGeometry& geometry,
                    ID3D11Texture2D* target) {
    if (!pointer.hasPosition) return S_FALSE;
    if (!pointer.visible) return S_OK;
    if (!pointer.hasShape || target == nullptr) return S_FALSE;
    CursorDrawRegion region;
    if (!ResolveCursorDrawRegion(pointer, output, geometry, region)) {
      return E_INVALIDARG;
    }
    if (region.empty) return S_OK;

    std::vector<std::uint32_t> background;
    HRESULT result = S_OK;
    if (pointer.shape.Type != DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR) {
      result = ReadBackgroundRegion(target, region, background);
      if (FAILED(result)) return result;
    }
    std::vector<std::uint32_t> pixels;
    if (!BuildCursorPixels(
            pointer, geometry, region,
            pointer.shape.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR
                ? nullptr
                : &background,
            pixels)) {
      return E_INVALIDARG;
    }
    return Draw(region, pixels);
  }

 private:
  HRESULT ReadBackgroundRegion(
      ID3D11Texture2D* target, const CursorDrawRegion& region,
      std::vector<std::uint32_t>& background) {
    D3D11_TEXTURE2D_DESC stagingDescription{};
    stagingDescription.Width = region.sourceWidth;
    stagingDescription.Height = region.sourceHeight;
    stagingDescription.MipLevels = 1;
    stagingDescription.ArraySize = 1;
    stagingDescription.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    stagingDescription.SampleDesc.Count = 1;
    stagingDescription.Usage = D3D11_USAGE_STAGING;
    stagingDescription.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging;
    HRESULT result = device_->CreateTexture2D(
        &stagingDescription, nullptr, &staging);
    if (FAILED(result)) return result;
    D3D11_BOX source{};
    source.left = region.sourceLeft;
    source.top = region.sourceTop;
    source.front = 0;
    source.right = region.sourceLeft + region.sourceWidth;
    source.bottom = region.sourceTop + region.sourceHeight;
    source.back = 1;
    context_->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, target, 0,
                                    &source);
    if (!GpuCompletedWithin(device_.Get(), context_.Get(),
                            kAcquireTimeoutMs, result)) {
      return result;
    }
    D3D11_MAPPED_SUBRESOURCE mapped{};
    result = context_->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(result)) return result;
    const std::size_t count = static_cast<std::size_t>(region.sourceWidth) *
                              region.sourceHeight;
    background.resize(count);
    for (UINT row = 0; row < region.sourceHeight; ++row) {
      std::memcpy(
          background.data() + static_cast<std::size_t>(row) *
                                  region.sourceWidth,
          static_cast<const std::uint8_t*>(mapped.pData) +
              static_cast<std::size_t>(row) * mapped.RowPitch,
          static_cast<std::size_t>(region.sourceWidth) * sizeof(std::uint32_t));
    }
    context_->Unmap(staging.Get(), 0);
    return S_OK;
  }

  HRESULT Draw(const CursorDrawRegion& region,
               const std::vector<std::uint32_t>& pixels) {
    D3D11_TEXTURE2D_DESC textureDescription{};
    textureDescription.Width = region.sourceWidth;
    textureDescription.Height = region.sourceHeight;
    textureDescription.MipLevels = 1;
    textureDescription.ArraySize = 1;
    textureDescription.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    textureDescription.SampleDesc.Count = 1;
    textureDescription.Usage = D3D11_USAGE_IMMUTABLE;
    textureDescription.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA textureData{};
    textureData.pSysMem = pixels.data();
    textureData.SysMemPitch = region.sourceWidth * sizeof(std::uint32_t);
    ComPtr<ID3D11Texture2D> texture;
    HRESULT result = device_->CreateTexture2D(
        &textureDescription, &textureData, &texture);
    if (FAILED(result)) return result;
    ComPtr<ID3D11ShaderResourceView> shaderView;
    result = device_->CreateShaderResourceView(
        texture.Get(), nullptr, &shaderView);
    if (FAILED(result)) return result;

    const float left = static_cast<float>(region.sourceLeft) /
                           static_cast<float>(width_) * 2.0f -
                       1.0f;
    const float right = static_cast<float>(region.sourceLeft +
                                           region.sourceWidth) /
                            static_cast<float>(width_) * 2.0f -
                        1.0f;
    const float top = 1.0f -
                      static_cast<float>(region.sourceTop) /
                          static_cast<float>(height_) * 2.0f;
    const float bottom = 1.0f -
                         static_cast<float>(region.sourceTop +
                                            region.sourceHeight) /
                             static_cast<float>(height_) * 2.0f;
    const CursorVertex vertices[] = {
        {left, bottom, 0.0f, 1.0f}, {left, top, 0.0f, 0.0f},
        {right, bottom, 1.0f, 1.0f}, {right, bottom, 1.0f, 1.0f},
        {left, top, 0.0f, 0.0f}, {right, top, 1.0f, 0.0f},
    };
    D3D11_BUFFER_DESC vertexDescription{};
    vertexDescription.ByteWidth = sizeof(vertices);
    vertexDescription.Usage = D3D11_USAGE_IMMUTABLE;
    vertexDescription.BindFlags = D3D11_BIND_VERTEX_BUFFER;
    D3D11_SUBRESOURCE_DATA vertexData{};
    vertexData.pSysMem = vertices;
    ComPtr<ID3D11Buffer> vertexBuffer;
    result = device_->CreateBuffer(
        &vertexDescription, &vertexData, &vertexBuffer);
    if (FAILED(result)) return result;

    D3D11_VIEWPORT viewport{};
    viewport.Width = static_cast<float>(width_);
    viewport.Height = static_cast<float>(height_);
    viewport.MaxDepth = 1.0f;
    const UINT stride = sizeof(CursorVertex);
    const UINT offset = 0;
    const float blendFactor[4]{};
    ID3D11Buffer* buffers[] = {vertexBuffer.Get()};
    ID3D11RenderTargetView* targets[] = {targetView_.Get()};
    ID3D11ShaderResourceView* resources[] = {shaderView.Get()};
    ID3D11SamplerState* samplers[] = {sampler_.Get()};
    context_->RSSetViewports(1, &viewport);
    context_->IASetInputLayout(inputLayout_.Get());
    context_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context_->IASetVertexBuffers(0, 1, buffers, &stride, &offset);
    context_->VSSetShader(vertexShader_.Get(), nullptr, 0);
    context_->PSSetShader(pixelShader_.Get(), nullptr, 0);
    context_->PSSetShaderResources(0, 1, resources);
    context_->PSSetSamplers(0, 1, samplers);
    context_->OMSetBlendState(blendState_.Get(), blendFactor, 0xffffffffU);
    context_->OMSetRenderTargets(1, targets, nullptr);
    context_->Draw(ARRAYSIZE(vertices), 0);
    ID3D11ShaderResourceView* noResources[] = {nullptr};
    ID3D11RenderTargetView* noTargets[] = {nullptr};
    context_->PSSetShaderResources(0, 1, noResources);
    context_->OMSetRenderTargets(1, noTargets, nullptr);
    return S_OK;
  }

  UINT width_ = 0;
  UINT height_ = 0;
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<ID3D11RenderTargetView> targetView_;
  ComPtr<ID3D11VertexShader> vertexShader_;
  ComPtr<ID3D11PixelShader> pixelShader_;
  ComPtr<ID3D11InputLayout> inputLayout_;
  ComPtr<ID3D11SamplerState> sampler_;
  ComPtr<ID3D11BlendState> blendState_;
};

class DuplicationFrameLease {
 public:
  explicit DuplicationFrameLease(IDXGIOutputDuplication* duplication)
      : duplication_(duplication) {}
  ~DuplicationFrameLease() {
    if (acquired_) duplication_->ReleaseFrame();
  }
  void Acquired() { acquired_ = true; }

 private:
  IDXGIOutputDuplication* duplication_;
  bool acquired_ = false;
};

class CapturePipeline {
 public:
  HRESULT Initialize(const Request& request, std::uint32_t generation,
                     RunSummaryPacket& summary) {
    generation_ = generation;
    HRESULT result = S_OK;
    if (!SelectOutput(request, choice_, result)) return result;
    AddRunIdentity(summary);
    summary.flags |= kRunOutputSelected;
    result = CreateVideoDevice(choice_.adapter.Get(), device_, context_);
    if (FAILED(result)) return result;
    ComPtr<ID3D10Multithread> multithread;
    if (SUCCEEDED(device_.As(&multithread))) {
      multithread->SetMultithreadProtected(TRUE);
    }
    summary.flags |= kRunD3d11DeviceCreated;
    ComPtr<IDXGIOutput1> output;
    result = choice_.output.As(&output);
    if (SUCCEEDED(result)) result = output->DuplicateOutput(device_.Get(), &duplication_);
    if (FAILED(result)) return result;
    summary.flags |= kRunDesktopDuplicationCreated;
    result = MFCreateDXGIDeviceManager(&managerToken_, &manager_);
    if (SUCCEEDED(result)) result = manager_->ResetDevice(device_.Get(), managerToken_);
    if (FAILED(result)) return result;
    summary.flags |= kRunDxgiManagerCreated;
    return S_OK;
  }

  HRESULT AcquireAndProcess(std::uint32_t timeoutMs, ExposureTimeline& timeline,
                            EncodedAccessUnitRing& ring,
                            RunSummaryPacket& summary,
                            ProbeReason& failureReason) {
    failureReason = ProbeReason::kNone;
    HRESULT result = prepared_ ? encoder_.Pump(ring, summary) : S_OK;
    if (FAILED(result)) {
      failureReason = ProbeReason::kEncoderOutputFailed;
      return result;
    }
    DXGI_OUTDUPL_FRAME_INFO frameInfo{};
    ComPtr<IDXGIResource> resource;
    DuplicationFrameLease lease(duplication_.Get());
    result = duplication_->AcquireNextFrame(timeoutMs, &frameInfo, &resource);
    if (FAILED(result)) {
      failureReason = result == DXGI_ERROR_ACCESS_LOST
          ? ProbeReason::kAccessLostExhausted
          : (IsDeviceLoss(result) ? ProbeReason::kDeviceLostExhausted
                                  : ProbeReason::kAcquireFailed);
      return result;
    }
    lease.Acquired();
    result = UpdatePointer(frameInfo);
    if (FAILED(result)) {
      failureReason = ProbeReason::kCursorCompositionUnavailable;
      return result;
    }
    if (frameInfo.LastPresentTime.QuadPart <= 0) {
      summary.pointerOnlyFrames += 1;
      return S_FALSE;
    }
    if (!resource) {
      failureReason = ProbeReason::kUnsupportedFrame;
      return E_NOINTERFACE;
    }
    ComPtr<ID3D11Texture2D> source;
    result = resource.As(&source);
    if (FAILED(result)) {
      failureReason = ProbeReason::kUnsupportedFrame;
      return result;
    }
    D3D11_TEXTURE2D_DESC sourceDescription{};
    source->GetDesc(&sourceDescription);
    if (!prepared_) {
      result = Prepare(sourceDescription, summary, failureReason);
      if (FAILED(result)) {
        return result;
      }
    } else if (sourceDescription.Format != sourceDescription_.Format ||
               sourceDescription.Width != sourceDescription_.Width ||
               sourceDescription.Height != sourceDescription_.Height) {
      failureReason = ProbeReason::kAccessLostExhausted;
      return DXGI_ERROR_ACCESS_LOST;
    }
    summary.capturedFrames += 1;
    summary.flags |= kRunFrameAcquired;
    const std::int64_t minimumFrameDelta =
        std::max<std::int64_t>(1, summary.qpcFrequency / kTargetFramesPerSecond);
    if (lastSubmittedQpc_ > 0 &&
        frameInfo.LastPresentTime.QuadPart - lastSubmittedQpc_ < minimumFrameDelta) {
      return S_FALSE;
    }
    std::int64_t ptsHns = 0;
    if (!timeline.Map(frameInfo.LastPresentTime.QuadPart, ptsHns)) {
      failureReason = ProbeReason::kUnsupportedFrame;
      return E_INVALIDARG;
    }
    const std::int64_t durationHns = 10'000'000 / kTargetFramesPerSecond;

    result = encoder_.Pump(ring, summary);
    if (FAILED(result)) {
      failureReason = ProbeReason::kEncoderOutputFailed;
      return result;
    }
    if (encoder_.inputCredits() == 0 && lastSubmittedQpc_ == 0) {
      result = encoder_.WaitForInput(100, ring, summary);
      if (FAILED(result) && result != HRESULT_FROM_WIN32(WAIT_TIMEOUT)) {
        failureReason = ProbeReason::kEncoderStreamFailed;
        return result;
      }
    }
    if (encoder_.inputCredits() == 0) {
      summary.droppedBackpressure += 1;
      return S_FALSE;
    }
    if (!pointer_.hasPosition ||
        (pointer_.visible && !pointer_.hasShape)) {
      // Never submit an image until the Desktop Duplication pointer plane is
      // fully known. A later pointer-only frame can complete this state.
      return S_FALSE;
    }
    context_->CopyResource(ownedBgra_.Get(), source.Get());
    result = cursorCompositor_.Composite(pointer_, choice_.outputDesc,
                                         geometry_, ownedBgra_.Get());
    if (result == S_FALSE) return S_FALSE;
    if (FAILED(result)) {
      failureReason = ProbeReason::kCursorCompositionUnavailable;
      return result;
    }
    if (!GpuCompletedWithin(device_.Get(), context_.Get(), kAcquireTimeoutMs,
                            result)) {
      failureReason = IsDeviceLoss(result)
          ? ProbeReason::kDeviceLostExhausted
          : ProbeReason::kCursorCompositionUnavailable;
      return result;
    }
    ComPtr<IMFSample> inputSample;
    ComPtr<ID3D11Texture2D> nv12;
    UINT nv12Subresource = 0;
    result = encoder_.AllocateInput(inputSample, nv12, nv12Subresource);
    if (result == MF_E_SAMPLEALLOCATOR_EMPTY) {
      summary.droppedBackpressure += 1;
      return S_FALSE;
    }
    if (FAILED(result)) {
      failureReason = ProbeReason::kEncoderStreamFailed;
      return result;
    }
    D3D11_TEXTURE2D_DESC nv12Description{};
    nv12->GetDesc(&nv12Description);
    if (nv12Description.Format != DXGI_FORMAT_NV12 ||
        nv12Description.Width != geometry_.outputWidth ||
        nv12Description.Height != geometry_.outputHeight ||
        nv12Description.MipLevels != 1 || nv12Description.ArraySize == 0 ||
        nv12Subresource >= nv12Description.ArraySize) {
      failureReason = ProbeReason::kEncoderTypeRejected;
      return MF_E_INVALIDMEDIATYPE;
    }
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC viewDescription{};
    if (nv12Description.ArraySize > 1) {
      viewDescription.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2DARRAY;
      viewDescription.Texture2DArray.MipSlice = 0;
      viewDescription.Texture2DArray.FirstArraySlice = nv12Subresource;
      viewDescription.Texture2DArray.ArraySize = 1;
    } else {
      if (nv12Subresource != 0) {
        failureReason = ProbeReason::kEncoderTypeRejected;
        return MF_E_INVALIDMEDIATYPE;
      }
      viewDescription.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
      viewDescription.Texture2D.MipSlice = 0;
    }
    ComPtr<ID3D11VideoProcessorOutputView> outputView;
    result = videoDevice_->CreateVideoProcessorOutputView(
        nv12.Get(), enumerator_.Get(), &viewDescription, &outputView);
    if (FAILED(result)) {
      failureReason = ProbeReason::kGpuConversionFailed;
      return result;
    }
    D3D11_VIDEO_PROCESSOR_STREAM stream{};
    stream.Enable = TRUE;
    stream.pInputSurface = inputView_.Get();
    result = videoContext_->VideoProcessorBlt(
        processor_.Get(), outputView.Get(), 0, 1, &stream);
    if (FAILED(result)) {
      failureReason = IsDeviceLoss(result) ? ProbeReason::kDeviceLostExhausted
                                           : ProbeReason::kGpuConversionFailed;
      return result;
    }
    if (!GpuCompletedWithin(device_.Get(), context_.Get(), kAcquireTimeoutMs, result)) {
      failureReason = IsDeviceLoss(result) ? ProbeReason::kDeviceLostExhausted
                                           : ProbeReason::kGpuConversionFailed;
      return result;
    }
    summary.convertedFrames += 1;
    summary.flags |= kRunFrameConverted;
    result = encoder_.Submit(inputSample.Get(), frameInfo.LastPresentTime.QuadPart,
                             ptsHns, durationHns);
    if (FAILED(result)) {
      failureReason = ProbeReason::kEncoderStreamFailed;
      return result;
    }
    summary.submittedFrames += 1;
    // Set this proof only after the BGRA image has been composited, completed
    // on the GPU, converted, and accepted by the encoder. Every submitted
    // frame passes through that sequence, and Initialize clears stale proof
    // after a pipeline rebuild.
    summary.flags |= kRunCursorComposited;
    lastSubmittedQpc_ = frameInfo.LastPresentTime.QuadPart;
    return S_OK;
  }

  HRESULT Pump(EncodedAccessUnitRing& ring, RunSummaryPacket& summary) {
    return prepared_ ? encoder_.Pump(ring, summary) : S_OK;
  }

  HRESULT Drain(std::int64_t deadlineQpc, EncodedAccessUnitRing& ring,
                RunSummaryPacket& summary) {
    return prepared_ ? encoder_.Drain(deadlineQpc, ring, summary) : S_OK;
  }

  const OutputChoice& choice() const { return choice_; }
  bool prepared() const { return prepared_; }
  UINT outputWidth() const { return geometry_.outputWidth; }
  UINT outputHeight() const { return geometry_.outputHeight; }
  std::uint32_t generation() const { return generation_; }

 private:
  HRESULT UpdatePointer(const DXGI_OUTDUPL_FRAME_INFO& frame) {
    if (!UpdatePointerPosition(frame, choice_.outputDesc, pointer_)) {
      return E_INVALIDARG;
    }
    if (frame.PointerShapeBufferSize == 0) return S_OK;
    if (frame.PointerShapeBufferSize > kMaximumPointerShapeBytes) {
      return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
    }
    std::vector<std::uint8_t> bytes;
    try {
      bytes.resize(frame.PointerShapeBufferSize);
    } catch (...) {
      return E_OUTOFMEMORY;
    }
    UINT required = 0;
    DXGI_OUTDUPL_POINTER_SHAPE_INFO shape{};
    HRESULT result = duplication_->GetFramePointerShape(
        frame.PointerShapeBufferSize, bytes.data(), &required, &shape);
    if (FAILED(result)) return result;
    if (required == 0 || required > bytes.size()) return E_INVALIDARG;
    bytes.resize(required);
    if (!ValidatePointerShape(shape, bytes.size())) return E_INVALIDARG;
    pointer_.shape = shape;
    pointer_.bytes = std::move(bytes);
    pointer_.hasShape = true;
    return S_OK;
  }

  void AddRunIdentity(RunSummaryPacket& summary) const {
    summary.adapterIndex = choice_.adapterIndex;
    summary.outputIndex = choice_.outputIndex;
    summary.boundsLeft = choice_.outputDesc.DesktopCoordinates.left;
    summary.boundsTop = choice_.outputDesc.DesktopCoordinates.top;
    summary.boundsRight = choice_.outputDesc.DesktopCoordinates.right;
    summary.boundsBottom = choice_.outputDesc.DesktopCoordinates.bottom;
    summary.rotation = static_cast<std::uint32_t>(choice_.outputDesc.Rotation);
  }

  HRESULT Prepare(const D3D11_TEXTURE2D_DESC& sourceDescription,
                  RunSummaryPacket& summary, ProbeReason& failureReason) {
    if (!ResolveFrameGeometry(choice_, sourceDescription, geometry_)) {
      failureReason = choice_.outputDesc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED &&
                              choice_.outputDesc.Rotation != DXGI_MODE_ROTATION_IDENTITY
          ? ProbeReason::kRotationUnsupported
          : ProbeReason::kUnsupportedFrame;
      return DXGI_ERROR_UNSUPPORTED;
    }
    HRESULT result = device_.As(&videoDevice_);
    if (SUCCEEDED(result)) result = context_.As(&videoContext_);
    if (FAILED(result)) {
      failureReason = ProbeReason::kGpuConversionFailed;
      return result;
    }
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
    content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    content.InputFrameRate = {kTargetFramesPerSecond, 1};
    content.InputWidth = geometry_.sourceWidth;
    content.InputHeight = geometry_.sourceHeight;
    content.OutputFrameRate = {kTargetFramesPerSecond, 1};
    content.OutputWidth = geometry_.outputWidth;
    content.OutputHeight = geometry_.outputHeight;
    content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
    result = videoDevice_->CreateVideoProcessorEnumerator(&content, &enumerator_);
    if (FAILED(result)) {
      failureReason = ProbeReason::kGpuConversionFailed;
      return result;
    }
    UINT inputFlags = 0;
    UINT outputFlags = 0;
    result = enumerator_->CheckVideoProcessorFormat(
        DXGI_FORMAT_B8G8R8A8_UNORM, &inputFlags);
    if (SUCCEEDED(result)) result = enumerator_->CheckVideoProcessorFormat(
        DXGI_FORMAT_NV12, &outputFlags);
    if (FAILED(result) ||
        (inputFlags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT) == 0 ||
        (outputFlags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT) == 0) {
      failureReason = ProbeReason::kGpuConversionFailed;
      return DXGI_ERROR_UNSUPPORTED;
    }
    D3D11_VIDEO_PROCESSOR_CAPS caps{};
    result = enumerator_->GetVideoProcessorCaps(&caps);
    if (FAILED(result) ||
        (geometry_.needsRotation &&
         (caps.FeatureCaps & D3D11_VIDEO_PROCESSOR_FEATURE_CAPS_ROTATION) == 0)) {
      failureReason = geometry_.needsRotation
          ? ProbeReason::kRotationUnsupported
          : ProbeReason::kGpuConversionFailed;
      return DXGI_ERROR_UNSUPPORTED;
    }
    result = videoDevice_->CreateVideoProcessor(enumerator_.Get(), 0, &processor_);
    if (FAILED(result)) {
      failureReason = ProbeReason::kGpuConversionFailed;
      return result;
    }
    sourceDescription_ = sourceDescription;
    sourceDescription_.Usage = D3D11_USAGE_DEFAULT;
    sourceDescription_.CPUAccessFlags = 0;
    sourceDescription_.MiscFlags = 0;
    // The VideoProcessor input view accepts a render-target-capable texture on
    // the validated field path. Cursor composition needs this exact owned BGRA
    // surface as a GPU render target before NV12 conversion.
    sourceDescription_.BindFlags = D3D11_BIND_RENDER_TARGET;
    sourceDescription_.ArraySize = 1;
    sourceDescription_.MipLevels = 1;
    sourceDescription_.SampleDesc.Count = 1;
    sourceDescription_.SampleDesc.Quality = 0;
    result = device_->CreateTexture2D(&sourceDescription_, nullptr, &ownedBgra_);
    if (FAILED(result)) {
      failureReason = ProbeReason::kGpuConversionFailed;
      return result;
    }
    result = cursorCompositor_.Initialize(
        device_.Get(), context_.Get(), ownedBgra_.Get(),
        geometry_.sourceWidth, geometry_.sourceHeight);
    if (FAILED(result)) {
      failureReason = ProbeReason::kCursorCompositionUnavailable;
      return result;
    }
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC inputViewDescription{};
    inputViewDescription.FourCC = 0;
    inputViewDescription.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    inputViewDescription.Texture2D.MipSlice = 0;
    inputViewDescription.Texture2D.ArraySlice = 0;
    result = videoDevice_->CreateVideoProcessorInputView(
        ownedBgra_.Get(), enumerator_.Get(), &inputViewDescription, &inputView_);
    if (FAILED(result)) {
      failureReason = ProbeReason::kGpuConversionFailed;
      return result;
    }
    RECT sourceRect{0, 0, static_cast<LONG>(geometry_.sourceWidth),
                    static_cast<LONG>(geometry_.sourceHeight)};
    RECT destinationRect{0, 0, static_cast<LONG>(geometry_.outputWidth),
                         static_cast<LONG>(geometry_.outputHeight)};
    videoContext_->VideoProcessorSetStreamFrameFormat(
        processor_.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
    videoContext_->VideoProcessorSetStreamSourceRect(
        processor_.Get(), 0, TRUE, &sourceRect);
    videoContext_->VideoProcessorSetStreamDestRect(
        processor_.Get(), 0, TRUE, &destinationRect);
    videoContext_->VideoProcessorSetOutputTargetRect(
        processor_.Get(), TRUE, &destinationRect);
    videoContext_->VideoProcessorSetStreamRotation(
        processor_.Get(), 0, geometry_.needsRotation ? TRUE : FALSE,
        geometry_.rotation);
    videoContext_->VideoProcessorSetStreamAutoProcessingMode(
        processor_.Get(), 0, FALSE);
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE inputColor{};
    inputColor.RGB_Range = 0;
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE outputColor{};
    outputColor.YCbCr_Matrix = geometry_.outputHeight >= 720 ? 1 : 0;
    outputColor.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
    videoContext_->VideoProcessorSetStreamColorSpace(
        processor_.Get(), 0, &inputColor);
    videoContext_->VideoProcessorSetOutputColorSpace(
        processor_.Get(), &outputColor);
    summary.flags |= kRunVideoProcessorCreated;
    std::string encoderName;
    result = encoder_.Initialize(choice_, manager_.Get(), geometry_.outputWidth,
                                 geometry_.outputHeight, generation_, encoderName);
    if (FAILED(result)) {
      failureReason = result == MF_E_TOPO_CODEC_NOT_FOUND
          ? ProbeReason::kHardwareEncoderNotFound
          : (result == MF_E_UNSUPPORTED_D3D_TYPE
                 ? ProbeReason::kEncoderNotD3d11Aware
                 : ProbeReason::kEncoderTypeRejected);
      return result;
    }
    std::fill(std::begin(summary.encoderName), std::end(summary.encoderName), 0);
    summary.encoderNameBytes = CopyBoundedUtf8(summary.encoderName, encoderName);
    summary.flags |= kRunHardwareEncoderConfigured | kRunEncoderStreaming;
    summary.flags &= ~static_cast<std::uint32_t>(kRunCursorComposited);
    prepared_ = true;
    return S_OK;
  }

  bool prepared_ = false;
  std::uint32_t generation_ = 0;
  std::int64_t lastSubmittedQpc_ = 0;
  UINT managerToken_ = 0;
  OutputChoice choice_;
  FrameGeometry geometry_;
  D3D11_TEXTURE2D_DESC sourceDescription_{};
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<IDXGIOutputDuplication> duplication_;
  ComPtr<IMFDXGIDeviceManager> manager_;
  ComPtr<ID3D11VideoDevice> videoDevice_;
  ComPtr<ID3D11VideoContext> videoContext_;
  ComPtr<ID3D11VideoProcessorEnumerator> enumerator_;
  ComPtr<ID3D11VideoProcessor> processor_;
  ComPtr<ID3D11Texture2D> ownedBgra_;
  ComPtr<ID3D11VideoProcessorInputView> inputView_;
  PointerState pointer_;
  CursorCompositor cursorCompositor_;
  EncoderSession encoder_;
};

EncodedAccessUnit TestUnit(std::int64_t qpc, bool keyframe, std::size_t bytes,
                           std::uint32_t generation = 1) {
  EncodedAccessUnit unit;
  unit.exposedQpc = qpc;
  unit.ptsHns = qpc;
  unit.durationHns = 1;
  unit.generation = generation;
  unit.keyframe = keyframe;
  if (keyframe) unit.codecConfig.assign(4, 0x01);
  unit.bytes.assign(bytes, 0x5a);
  return unit;
}

bool NamedSelfTest(const char* name, bool passed) {
  std::fprintf(passed ? stdout : stderr, "SELFTEST %s %s\n",
               passed ? "PASS" : "FAIL", name);
  return passed;
}

bool RingSelfTest() {
  bool passed = true;
  ExposureTimeline timeline(10'000'000);
  ExposureTimeline rejectsZero(10'000'000);
  std::int64_t firstPts = -1;
  std::int64_t secondPts = -1;
  const std::int64_t largeOrigin =
      std::numeric_limits<std::int64_t>::max() - 20'000'000;
  passed &= NamedSelfTest(
      "timestamps",
      timeline.Map(largeOrigin, firstPts) && firstPts == 0 &&
          timeline.Map(largeOrigin + 333'333, secondPts) &&
          secondPts == 333'333 &&
          !timeline.Map(largeOrigin + 333'333, secondPts) &&
          !timeline.Map(largeOrigin + 1, secondPts) &&
          !rejectsZero.Map(0, firstPts));

  OutputChoice rotatedChoice;
  rotatedChoice.outputDesc.DesktopCoordinates = {0, 0, 1080, 1920};
  rotatedChoice.outputDesc.Rotation = DXGI_MODE_ROTATION_ROTATE90;
  D3D11_TEXTURE2D_DESC rotatedSource{};
  rotatedSource.Width = 1920;
  rotatedSource.Height = 1080;
  rotatedSource.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  FrameGeometry rotatedGeometry;
  const bool validRotation = ResolveFrameGeometry(
      rotatedChoice, rotatedSource, rotatedGeometry);
  rotatedSource.Width = 1918;
  FrameGeometry invalidGeometry;
  passed &= NamedSelfTest(
      "rotation-topology",
      validRotation && rotatedGeometry.outputWidth == 1080 &&
          rotatedGeometry.outputHeight == 1920 &&
          rotatedGeometry.rotation == D3D11_VIDEO_PROCESSOR_ROTATION_90 &&
          !ResolveFrameGeometry(rotatedChoice, rotatedSource, invalidGeometry));

  DXGI_OUTPUT_DESC offsetOutput{};
  offsetOutput.DesktopCoordinates = {-1920, 100, -840, 2020};
  DXGI_OUTDUPL_FRAME_INFO pointerOnly{};
  pointerOnly.LastMouseUpdateTime.QuadPart = 123;
  pointerOnly.PointerPosition.Position = {10, -1};
  pointerOnly.PointerPosition.Visible = TRUE;
  PointerState clippedPointer;
  clippedPointer.shape.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR;
  clippedPointer.shape.Width = 4;
  clippedPointer.shape.Height = 3;
  clippedPointer.shape.Pitch = 16;
  clippedPointer.shape.HotSpot = {1, 1};
  clippedPointer.bytes.resize(48);
  clippedPointer.hasShape = true;
  FrameGeometry offsetGeometry;
  offsetGeometry.sourceWidth = 1080;
  offsetGeometry.sourceHeight = 1920;
  offsetGeometry.outputWidth = 1080;
  offsetGeometry.outputHeight = 1920;
  CursorDrawRegion clippedRegion;
  const bool pointerOnlyUpdated =
      pointerOnly.LastPresentTime.QuadPart == 0 &&
      UpdatePointerPosition(pointerOnly, offsetOutput, clippedPointer);
  const bool pointerClipped = ResolveCursorDrawRegion(
      clippedPointer, offsetOutput, offsetGeometry, clippedRegion);
  passed &= NamedSelfTest(
      "cursor-position-pointer-only-clipping",
      pointerOnlyUpdated && clippedPointer.hasPosition &&
          clippedPointer.visible && clippedPointer.desktopX == -1910 &&
          clippedPointer.desktopY == 99 && pointerClipped &&
          !clippedRegion.empty && clippedRegion.logicalLeft == 10 &&
          clippedRegion.logicalTop == 0 && clippedRegion.logicalWidth == 4 &&
          clippedRegion.logicalHeight == 2 && clippedRegion.skipX == 0 &&
          clippedRegion.skipY == 1 && clippedRegion.sourceLeft == 10 &&
          clippedRegion.sourceTop == 0);

  DXGI_OUTPUT_DESC rotatedOutput{};
  rotatedOutput.DesktopCoordinates = {500, -200, 1580, 1720};
  PointerState rotatedPointer;
  rotatedPointer.hasPosition = true;
  rotatedPointer.visible = true;
  rotatedPointer.desktopX = 498;
  rotatedPointer.desktopY = -190;
  rotatedPointer.hasShape = true;
  rotatedPointer.shape.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR;
  rotatedPointer.shape.Width = 4;
  rotatedPointer.shape.Height = 3;
  rotatedPointer.shape.Pitch = 16;
  rotatedPointer.bytes.resize(48);
  CursorDrawRegion rotatedRegion;
  const bool rotatedClip = ResolveCursorDrawRegion(
      rotatedPointer, rotatedOutput, rotatedGeometry, rotatedRegion);
  UINT logicalX = 0;
  UINT logicalY = 0;
  const bool rotate90Mapping =
      SourcePixelToLogical(rotatedGeometry, rotatedRegion, 0, 0,
                           logicalX, logicalY) &&
      logicalX == 1 && logicalY == 0 &&
      SourcePixelToLogical(rotatedGeometry, rotatedRegion, 2, 1,
                           logicalX, logicalY) &&
      logicalX == 0 && logicalY == 2;
  CursorDrawRegion matrixRegion;
  matrixRegion.empty = false;
  matrixRegion.logicalWidth = 2;
  matrixRegion.logicalHeight = 3;
  matrixRegion.sourceWidth = 2;
  matrixRegion.sourceHeight = 3;
  FrameGeometry matrixGeometry;
  matrixGeometry.rotation = D3D11_VIDEO_PROCESSOR_ROTATION_180;
  const bool rotate180Mapping =
      SourcePixelToLogical(matrixGeometry, matrixRegion, 0, 0,
                           logicalX, logicalY) &&
      logicalX == 1 && logicalY == 2 &&
      SourcePixelToLogical(matrixGeometry, matrixRegion, 1, 2,
                           logicalX, logicalY) &&
      logicalX == 0 && logicalY == 0;
  matrixRegion.sourceWidth = 3;
  matrixRegion.sourceHeight = 2;
  matrixGeometry.rotation = D3D11_VIDEO_PROCESSOR_ROTATION_270;
  const bool rotate270Mapping =
      SourcePixelToLogical(matrixGeometry, matrixRegion, 0, 0,
                           logicalX, logicalY) &&
      logicalX == 0 && logicalY == 2 &&
      SourcePixelToLogical(matrixGeometry, matrixRegion, 2, 1,
                           logicalX, logicalY) &&
      logicalX == 1 && logicalY == 0;
  passed &= NamedSelfTest(
      "cursor-rotation-multi-output-coordinates",
      rotatedClip && !rotatedRegion.empty && rotatedRegion.logicalLeft == 0 &&
          rotatedRegion.logicalTop == 10 && rotatedRegion.logicalWidth == 2 &&
          rotatedRegion.logicalHeight == 3 && rotatedRegion.skipX == 2 &&
          rotatedRegion.skipY == 0 && rotatedRegion.sourceLeft == 10 &&
          rotatedRegion.sourceTop == 1078 && rotatedRegion.sourceWidth == 3 &&
          rotatedRegion.sourceHeight == 2 && rotate90Mapping &&
          rotate180Mapping && rotate270Mapping);

  DXGI_OUTPUT_DESC semanticOutput{};
  semanticOutput.DesktopCoordinates = {0, 0, 4, 2};
  FrameGeometry semanticGeometry;
  semanticGeometry.sourceWidth = 4;
  semanticGeometry.sourceHeight = 2;
  semanticGeometry.outputWidth = 4;
  semanticGeometry.outputHeight = 2;
  PointerState mono;
  mono.hasPosition = true;
  mono.visible = true;
  mono.hasShape = true;
  mono.shape.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME;
  mono.shape.Width = 4;
  mono.shape.Height = 2;
  mono.shape.Pitch = 1;
  mono.bytes = {0x30, 0x50};
  CursorDrawRegion monoRegion;
  std::vector<std::uint32_t> monoPixels;
  const std::vector<std::uint32_t> monoBackground(
      4, 0xff123456U);
  const bool monoBuilt =
      ResolveCursorDrawRegion(mono, semanticOutput, semanticGeometry,
                              monoRegion) &&
      BuildCursorPixels(mono, semanticGeometry, monoRegion, &monoBackground,
                        monoPixels);
  passed &= NamedSelfTest(
      "cursor-monochrome-and-xor-semantics",
      monoBuilt && monoPixels == std::vector<std::uint32_t>({
          0xff000000U, 0xffffffffU, 0xff123456U, 0xffedcba9U}));

  PointerState masked;
  masked.hasPosition = true;
  masked.visible = true;
  masked.hasShape = true;
  masked.shape.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR;
  masked.shape.Width = 2;
  masked.shape.Height = 1;
  masked.shape.Pitch = 8;
  masked.bytes.resize(8);
  const std::uint32_t maskedShape[] = {0x00112233U, 0xff0000ffU};
  std::memcpy(masked.bytes.data(), maskedShape, sizeof(maskedShape));
  CursorDrawRegion maskedRegion;
  std::vector<std::uint32_t> maskedPixels;
  const std::vector<std::uint32_t> maskedBackground = {
      0xffabcdefU, 0xff102030U};
  const bool maskedBuilt =
      ResolveCursorDrawRegion(masked, semanticOutput, semanticGeometry,
                              maskedRegion) &&
      BuildCursorPixels(masked, semanticGeometry, maskedRegion,
                        &maskedBackground, maskedPixels);
  passed &= NamedSelfTest(
      "cursor-masked-color-copy-xor-semantics",
      maskedBuilt && maskedPixels == std::vector<std::uint32_t>({
          0xff112233U, 0xff1020cfU}));

  PointerState colorRotation;
  colorRotation.hasPosition = true;
  colorRotation.visible = true;
  colorRotation.hasShape = true;
  colorRotation.desktopX = 1;
  colorRotation.desktopY = 0;
  colorRotation.shape.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR;
  colorRotation.shape.Width = 2;
  colorRotation.shape.Height = 1;
  colorRotation.shape.Pitch = 8;
  colorRotation.bytes.resize(8);
  const std::uint32_t colorShape[] = {0xff010203U, 0xffa0b0c0U};
  std::memcpy(colorRotation.bytes.data(), colorShape, sizeof(colorShape));
  DXGI_OUTPUT_DESC colorOutput{};
  colorOutput.DesktopCoordinates = {0, 0, 4, 2};
  FrameGeometry colorGeometry;
  colorGeometry.sourceWidth = 2;
  colorGeometry.sourceHeight = 4;
  colorGeometry.outputWidth = 4;
  colorGeometry.outputHeight = 2;
  colorGeometry.rotation = D3D11_VIDEO_PROCESSOR_ROTATION_90;
  colorGeometry.needsRotation = true;
  CursorDrawRegion colorRegion;
  std::vector<std::uint32_t> colorPixels;
  const bool colorBuilt = ResolveCursorDrawRegion(
                              colorRotation, colorOutput, colorGeometry,
                              colorRegion) &&
                          BuildCursorPixels(colorRotation, colorGeometry,
                                            colorRegion, nullptr, colorPixels);
  passed &= NamedSelfTest(
      "cursor-color-shape-rotation-semantics",
      colorBuilt && colorRegion.sourceLeft == 0 &&
          colorRegion.sourceTop == 1 && colorRegion.sourceWidth == 1 &&
          colorRegion.sourceHeight == 2 &&
          colorPixels == std::vector<std::uint32_t>({
              0xffa0b0c0U, 0xff010203U}));

  DXGI_OUTDUPL_POINTER_SHAPE_INFO invalidMono = mono.shape;
  invalidMono.Height = 3;
  DXGI_OUTDUPL_POINTER_SHAPE_INFO invalidColor = masked.shape;
  invalidColor.Pitch = 7;
  DXGI_OUTDUPL_POINTER_SHAPE_INFO unsupported = masked.shape;
  unsupported.Type = 99;
  passed &= NamedSelfTest(
      "cursor-shape-validation-fails-closed",
      ValidatePointerShape(mono.shape, mono.bytes.size()) &&
          ValidatePointerShape(masked.shape, masked.bytes.size()) &&
          !ValidatePointerShape(invalidMono, 3) &&
          !ValidatePointerShape(invalidColor, 7) &&
          !ValidatePointerShape(unsupported, masked.bytes.size()));

  EncodedAccessUnitRing bytesRing(80, 3'000, 16);
  const bool byteAppends =
      bytesRing.Append(TestUnit(1'000, true, 20)) &&
      bytesRing.Append(TestUnit(2'000, false, 20)) &&
      bytesRing.Append(TestUnit(3'000, false, 20)) &&
      bytesRing.Append(TestUnit(4'000, true, 20)) &&
      bytesRing.Append(TestUnit(5'000, false, 20));
  EncodedRingSnapshot byteSnapshot;
  const bool byteSnapshotOk = bytesRing.Snapshot(5'000, byteSnapshot);
  passed &= NamedSelfTest(
      "bounded-bytes-keyframe-cut",
      byteAppends && bytesRing.bytes() <= 80 && bytesRing.size() == 2 &&
          byteSnapshotOk && byteSnapshot.units.size() == 2 &&
          byteSnapshot.units.front().keyframe &&
          byteSnapshot.units.front().exposedQpc == 4'000);

  EncodedAccessUnitRing timeRing(1'000, 2'000, 16);
  const bool timeAppends =
      timeRing.Append(TestUnit(1'000, true, 10)) &&
      timeRing.Append(TestUnit(2'000, false, 10)) &&
      timeRing.Append(TestUnit(3'000, true, 10)) &&
      timeRing.Append(TestUnit(4'000, false, 10)) &&
      timeRing.Append(TestUnit(5'000, false, 10));
  EncodedRingSnapshot timeSnapshot;
  passed &= NamedSelfTest(
      "bounded-time",
      timeAppends && timeRing.size() == 3 &&
          timeRing.Snapshot(5'000, timeSnapshot) &&
          timeSnapshot.units.size() == 3);

  EncodedAccessUnitRing unitsRing(1'000, 10'000, 2);
  const bool unitsAppends = unitsRing.Append(TestUnit(1'000, true, 10)) &&
                            unitsRing.Append(TestUnit(2'000, false, 10)) &&
                            unitsRing.Append(TestUnit(3'000, true, 10));
  EncodedRingSnapshot unitsSnapshot;
  passed &= NamedSelfTest(
      "bounded-max-units",
      unitsAppends && unitsRing.size() == 1 &&
          unitsRing.Snapshot(3'000, unitsSnapshot) &&
          unitsSnapshot.units.size() == 1);

  EncodedAccessUnitRing shortRetentionRing(1'000, 1'000, 31);
  const bool waitsForCleanPointWithoutFailure =
      shortRetentionRing.Append(TestUnit(1'000, true, 10)) &&
      shortRetentionRing.Append(TestUnit(2'100, false, 10)) &&
      shortRetentionRing.size() == 0 &&
      shortRetentionRing.Append(TestUnit(2'200, false, 10)) &&
      shortRetentionRing.size() == 0 &&
      shortRetentionRing.Append(TestUnit(2'300, true, 10));
  EncodedRingSnapshot shortRetentionSnapshot;
  passed &= NamedSelfTest(
      "short-retention-awaits-keyframe",
      waitsForCleanPointWithoutFailure && shortRetentionRing.size() == 1 &&
          shortRetentionRing.Snapshot(2'300, shortRetentionSnapshot) &&
          shortRetentionSnapshot.units.front().keyframe);

  std::uint32_t parsedMaximumRetention = 0;
  passed &= NamedSelfTest(
      "retention-sized-bounds",
      ParseRetentionMs(L"60000", parsedMaximumRetention) &&
          parsedMaximumRetention == kMaximumRetentionMs &&
          !ParseRetentionMs(L"60001", parsedMaximumRetention) &&
          RingMaximumBytes(1'000) == 9'326'108 &&
          RingMaximumBytes(kMaximumRetentionMs) == 64'638'608 &&
          RingMaximumUnits(1'000) == 31 &&
          RingMaximumUnits(kMaximumRetentionMs) == 916 &&
          kMaximumRingBytes == RingMaximumBytes(kMaximumRetentionMs) &&
          kMaximumRingUnits == RingMaximumUnits(kMaximumRetentionMs));

  const std::uint32_t priorHealthFlags = kRequiredServiceHealthFlags &
      ~static_cast<std::uint32_t>(kRunCursorComposited);
  passed &= NamedSelfTest(
      "cursor-contract-fails-closed",
      !ServiceHealthIncludesCursor(priorHealthFlags) &&
          ServiceHealthIncludesCursor(priorHealthFlags |
                                      kRunCursorComposited));

  EncodedAccessUnitRing generationRing(1'000, 10'000, 16);
  const bool firstGeneration =
      generationRing.Append(TestUnit(1'000, true, 10, 1)) &&
      generationRing.Append(TestUnit(2'000, false, 10, 1));
  const bool rejectsUnsafeGeneration =
      !generationRing.Append(TestUnit(3'000, false, 10, 2));
  const bool acceptsSafeGeneration =
      generationRing.Append(TestUnit(4'000, true, 10, 2));
  EncodedRingSnapshot generationSnapshot;
  const bool generationBoundarySafe =
      firstGeneration && rejectsUnsafeGeneration && acceptsSafeGeneration &&
      generationRing.size() == 1 &&
      generationRing.Snapshot(4'000, generationSnapshot) &&
      generationSnapshot.generation == 2;

  EncodedAccessUnitRing rebasedRing(1'000, 10'000, 16);
  EncodedAccessUnit rebasedFirst = TestUnit(1'000, true, 10);
  rebasedFirst.ptsHns = 50'000;
  rebasedFirst.durationHns = 10'000;
  EncodedAccessUnit rebasedSecond = TestUnit(2'000, false, 10);
  rebasedSecond.ptsHns = 80'000;
  rebasedSecond.durationHns = 20'000;
  EncodedRingSnapshot rebasedSnapshot;
  const bool snapshotTimestampsSafe =
      rebasedRing.Append(std::move(rebasedFirst)) &&
      rebasedRing.Append(std::move(rebasedSecond)) &&
      rebasedRing.Snapshot(2'000, rebasedSnapshot) &&
      rebasedSnapshot.units.front().ptsHns == 0 &&
      rebasedSnapshot.units.back().ptsHns == 30'000 &&
      rebasedSnapshot.durationHns == 50'000;

  EncodedAccessUnitRing changedConfigRing(1'000, 10'000, 16);
  EncodedAccessUnit changedConfig = TestUnit(3'000, true, 10);
  changedConfig.codecConfig.assign(4, 0x02);
  EncodedRingSnapshot changedConfigSnapshot;
  const bool configChangeRejected =
      changedConfigRing.Append(TestUnit(1'000, true, 10)) &&
      changedConfigRing.Append(TestUnit(2'000, false, 10)) &&
      changedConfigRing.Append(std::move(changedConfig)) &&
      !changedConfigRing.Snapshot(3'000, changedConfigSnapshot);

  const AnnexBInspection codecConfig = InspectAnnexB({
      0x00, 0x00, 0x01, 0x67, 0x64, 0xaa,
      0x00, 0x00, 0x01, 0x68, 0xee, 0xbb});
  const AnnexBInspection idrAccessUnit = InspectAnnexB(
      {0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84});
  const AnnexBInspection lengthPrefixed = InspectAnnexB(
      {0x00, 0x00, 0x00, 0x03, 0x65, 0x88, 0x84});
  const bool annexBValidated =
      codecConfig.valid && codecConfig.hasSps && codecConfig.hasPps &&
      !codecConfig.hasVcl && idrAccessUnit.valid && idrAccessUnit.hasIdr &&
      idrAccessUnit.hasVcl && !lengthPrefixed.valid;

  const std::vector<std::uint8_t> validFragmentedMp4 = {
      0x00, 0x00, 0x00, 0x08, 'f', 't', 'y', 'p',
      0x00, 0x00, 0x00, 0x08, 'm', 'o', 'o', 'v',
      0x00, 0x00, 0x00, 0x08, 'm', 'o', 'o', 'f',
      0x00, 0x00, 0x00, 0x09, 'm', 'd', 'a', 't', 0x01};
  std::vector<std::uint8_t> truncatedFragmentedMp4 = validFragmentedMp4;
  truncatedFragmentedMp4.pop_back();
  const std::vector<std::uint8_t> emptyMdat = {
      0x00, 0x00, 0x00, 0x08, 'f', 't', 'y', 'p',
      0x00, 0x00, 0x00, 0x08, 'm', 'o', 'o', 'v',
      0x00, 0x00, 0x00, 0x08, 'm', 'o', 'o', 'f',
      0x00, 0x00, 0x00, 0x08, 'm', 'd', 'a', 't'};
  const bool fragmentedMp4StructureValidated =
      ValidateFragmentedMp4Structure(validFragmentedMp4) &&
      !ValidateFragmentedMp4Structure(truncatedFragmentedMp4) &&
      !ValidateFragmentedMp4Structure(emptyMdat);

  const ServiceCommand validCommand = ParseServiceCommand(
      "SNAPSHOT\t7\tC:\\capturepack-recent.mp4", 6);
  const bool serviceProtocolBounded =
      validCommand.kind == ServiceCommandKind::kSnapshot &&
      validCommand.requestId == 7 &&
      ParseServiceCommand("STOP", 7).kind == ServiceCommandKind::kStop &&
      ParseServiceCommand(
          "SNAPSHOT\t7\tC:\\capturepack-recent.mp4", 7).kind ==
          ServiceCommandKind::kInvalid &&
      ParseServiceCommand(
          "SNAPSHOT\t8\tC:\\temp\\..\\capturepack-recent.mp4", 7).kind ==
          ServiceCommandKind::kInvalid;

  passed &= NamedSelfTest(
      "config-generation-keyframe-cut",
      generationBoundarySafe && snapshotTimestampsSafe &&
          configChangeRejected && annexBValidated &&
          fragmentedMp4StructureValidated && serviceProtocolBounded);

  EncoderTransitionState transitions;
  const bool transitionSequence =
      transitions.Apply(EncoderTransition::kNeedInput) &&
      transitions.ConsumeInputCredit() &&
      transitions.Apply(EncoderTransition::kHaveOutput) &&
      transitions.ConsumeOutput();
  transitions.BeginDrain();
  const bool ignoresInputDuringDrain =
      transitions.Apply(EncoderTransition::kNeedInput) &&
      transitions.inputCredits() == 0;
  const bool drainCompletes =
      transitions.Apply(EncoderTransition::kDrainComplete) &&
      transitions.drainComplete();
  EncoderTransitionState failedTransitions;
  const bool encoderFailureIsTerminal =
      !failedTransitions.Apply(EncoderTransition::kError) &&
      !failedTransitions.Apply(EncoderTransition::kNeedInput) &&
      !failedTransitions.ConsumeInputCredit();
  passed &= NamedSelfTest(
      "encoder-transition-semantics",
      transitionSequence && ignoresInputDuringDrain && drainCompletes &&
          encoderFailureIsTerminal);

  passed &= NamedSelfTest(
      "device-loss-retry-boundaries",
      RecoveryFor(DXGI_ERROR_WAIT_TIMEOUT, 0) == RecoveryDecision::kContinue &&
          RecoveryFor(DXGI_ERROR_ACCESS_LOST, 0) ==
              RecoveryDecision::kReinitialize &&
          RecoveryFor(DXGI_ERROR_DEVICE_REMOVED, 2) ==
              RecoveryDecision::kReinitialize &&
          RecoveryFor(DXGI_ERROR_DEVICE_RESET, 3) == RecoveryDecision::kFail &&
          RecoveryFor(E_FAIL, 0) == RecoveryDecision::kFail);

  Request selector;
  selector.hasDeviceName = true;
  selector.deviceName = L"\\\\.\\DISPLAY2";
  selector.hasBounds = true;
  selector.left = -1920;
  selector.top = 0;
  selector.width = 1920;
  selector.height = 1080;
  DXGI_OUTPUT_DESC description{};
  wcscpy_s(description.DeviceName, L"\\\\.\\DISPLAY2");
  description.DesktopCoordinates = {-1920, 0, 0, 1080};
  const bool matchesExactOutput = MatchesOutput(selector, description);
  description.DesktopCoordinates = {0, 0, 1920, 1080};
  const bool rejectsWrongBounds = !MatchesOutput(selector, description);
  description.DesktopCoordinates = {-1920, 0, 0, 1080};
  wcscpy_s(description.DeviceName, L"\\\\.\\DISPLAY1");
  const bool rejectsWrongDevice = !MatchesOutput(selector, description);
  passed &= NamedSelfTest("output-identity-topology",
                          matchesExactOutput && rejectsWrongBounds &&
                              rejectsWrongDevice);
  return passed;
}

bool HasCaptureArgument(int argc, wchar_t** argv) {
  for (int index = 1; index < argc; ++index) {
    if (std::wstring(argv[index]) == L"--capture-ms") return true;
  }
  return false;
}

bool HasServiceArgument(int argc, wchar_t** argv) {
  for (int index = 1; index < argc; ++index) {
    if (std::wstring(argv[index]) == L"--serve") return true;
  }
  return false;
}

int RunCapture(const Request& request) {
  RunSummaryPacket summary = NewRunSummary();
  std::int64_t frequency = 0;
  if (!QueryQpcFrequency(frequency) || !QueryQpc(summary.startedQpc)) {
    return WriteRunSummary(summary, ProbeStatus::kUnavailable,
                           ProbeReason::kCaptureDeadlineFailed, E_FAIL);
  }
  summary.qpcFrequency = frequency;
  std::int64_t deadline = 0;
  if (!AddMilliseconds(summary.startedQpc, frequency, request.captureMs, deadline)) {
    return WriteRunSummary(summary, ProbeStatus::kUnavailable,
                           ProbeReason::kCaptureDeadlineFailed, E_INVALIDARG);
  }
  const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(comResult)) {
    return WriteRunSummary(summary, ProbeStatus::kUnavailable,
                           ProbeReason::kComInitializationFailed, comResult);
  }
  ComLifetime comLifetime(true);
  HRESULT result = MFStartup(MF_VERSION, MFSTARTUP_FULL);
  if (FAILED(result)) {
    return WriteRunSummary(summary, ProbeStatus::kUnavailable,
                           ProbeReason::kMediaFoundationFailed, result);
  }
  MediaFoundationLifetime mediaFoundationLifetime;
  summary.flags |= kRunMediaFoundationStarted;
  ExposureTimeline timeline(frequency);
  const std::int64_t retentionQpc = frequency <=
          std::numeric_limits<std::int64_t>::max() / 30
      ? frequency * 30
      : std::numeric_limits<std::int64_t>::max();
  EncodedAccessUnitRing ring(RingMaximumBytes(30'000), retentionQpc,
                             RingMaximumUnits(30'000));
  std::uint32_t generation = 1;
  std::uint32_t recoveryAttempts = 0;
  Request currentRequest = request;
  auto pipeline = std::make_unique<CapturePipeline>();
  result = pipeline->Initialize(currentRequest, generation, summary);
  if (FAILED(result)) {
    const ProbeReason reason = result == DXGI_ERROR_NOT_FOUND
        ? ProbeReason::kOutputNotFound
        : ProbeReason::kReinitializeFailed;
    return WriteRunSummary(summary, ProbeStatus::kUnavailable, reason, result);
  }
  const std::wstring selectedDevice = pipeline->choice().outputDesc.DeviceName;

  for (;;) {
    std::int64_t now = 0;
    if (!QueryQpc(now)) {
      return WriteRunSummary(summary, ProbeStatus::kUnavailable,
                             ProbeReason::kCaptureDeadlineFailed, E_FAIL);
    }
    if (now >= deadline) break;
    ProbeReason failureReason = ProbeReason::kNone;
    result = pipeline->AcquireAndProcess(kAcquireTimeoutMs, timeline, ring,
                                         summary, failureReason);
    if (result == DXGI_ERROR_WAIT_TIMEOUT &&
        failureReason == ProbeReason::kAcquireFailed) {
      summary.acquireTimeouts += 1;
      continue;
    }
    if (SUCCEEDED(result)) continue;
    if (failureReason == ProbeReason::kEncoderOutputFailed ||
        failureReason == ProbeReason::kEncoderStreamFailed ||
        failureReason == ProbeReason::kEncoderTypeRejected ||
        failureReason == ProbeReason::kRingRejected) {
      summary.encoderFailures += 1;
    }
    const RecoveryDecision recovery = RecoveryFor(result, recoveryAttempts);
    if (recovery != RecoveryDecision::kReinitialize) {
      if (IsDeviceLoss(result)) summary.deviceLosses += 1;
      if (result == DXGI_ERROR_ACCESS_LOST) summary.accessLosses += 1;
      return WriteRunSummary(summary, ProbeStatus::kUnavailable,
                             failureReason, result);
    }
    if (IsDeviceLoss(result)) summary.deviceLosses += 1;
    if (result == DXGI_ERROR_ACCESS_LOST) summary.accessLosses += 1;
    ++recoveryAttempts;
    ++summary.reinitializations;
    ++generation;
    summary.flags |= kRunPipelineReinitialized;
    ring.Reset();
    pipeline.reset();
    currentRequest = request;
    currentRequest.hasDeviceName = true;
    currentRequest.deviceName = selectedDevice;
    pipeline = std::make_unique<CapturePipeline>();
    result = pipeline->Initialize(currentRequest, generation, summary);
    if (FAILED(result)) {
      return WriteRunSummary(summary, ProbeStatus::kUnavailable,
                             ProbeReason::kReinitializeFailed, result);
    }
  }

  result = pipeline->Pump(ring, summary);
  if (FAILED(result)) {
    summary.encoderFailures += 1;
    return WriteRunSummary(summary, ProbeStatus::kUnavailable,
                           ProbeReason::kEncoderOutputFailed, result);
  }
  std::int64_t drainDeadline = deadline;
  std::int64_t now = 0;
  if (!QueryQpc(now) || !AddMilliseconds(now, frequency, 500, drainDeadline)) {
    return WriteRunSummary(summary, ProbeStatus::kUnavailable,
                           ProbeReason::kCaptureDeadlineFailed, E_FAIL);
  }
  result = pipeline->Drain(drainDeadline, ring, summary);
  if (FAILED(result)) {
    summary.encoderFailures += 1;
    return WriteRunSummary(summary, ProbeStatus::kUnavailable,
                           ProbeReason::kEncoderOutputFailed, result);
  }
  QueryQpc(summary.endedQpc);
  summary.ringUnits = ring.size();
  summary.ringBytes = ring.bytes();
  const std::uint32_t requiredEvidence =
      kRunFrameAcquired | kRunFrameConverted | kRunH264Produced |
      kRunRingRetained | kRunCursorComposited;
  if ((summary.flags & requiredEvidence) != requiredEvidence ||
      summary.capturedFrames == 0 || summary.convertedFrames == 0 ||
      summary.submittedFrames == 0 || summary.encodedSamples == 0 ||
      summary.ringUnits == 0 || summary.ringBytes == 0) {
    return WriteRunSummary(summary, ProbeStatus::kUnavailable,
                           ProbeReason::kEncoderOutputFailed, E_FAIL);
  }
  return WriteRunSummary(summary, ProbeStatus::kAvailable,
                         ProbeReason::kNone, S_OK);
}

ProbeReason InitialPipelineReason(HRESULT result) {
  if (result == DXGI_ERROR_NOT_FOUND) return ProbeReason::kOutputNotFound;
  if (result == E_ACCESSDENIED) return ProbeReason::kDuplicateAccessDenied;
  if (result == DXGI_ERROR_UNSUPPORTED) return ProbeReason::kDuplicateUnsupported;
  if (result == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE) {
    return ProbeReason::kDuplicateLimitReached;
  }
  if (result == DXGI_ERROR_SESSION_DISCONNECTED) {
    return ProbeReason::kSessionDisconnected;
  }
  return ProbeReason::kReinitializeFailed;
}

bool TemporaryExportPath(std::wstring& path) {
  wchar_t directory[MAX_PATH + 1]{};
  const DWORD directoryChars = GetTempPathW(MAX_PATH, directory);
  if (directoryChars == 0 || directoryChars > MAX_PATH) return false;
  wchar_t file[MAX_PATH + 1]{};
  if (GetTempFileNameW(directory, L"cpr", 0, file) == 0) return false;
  if (!DeleteFileW(file)) return false;
  path = file;
  path += L".mp4";
  if (GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES) return false;
  return true;
}

void FillServiceEvidence(ServicePacket& packet,
                         const EncodedRingSnapshot& snapshot,
                         const ExportEvidence& exportEvidence,
                         const EncodedAccessUnitRing& ring,
                         const CapturePipeline& pipeline,
                         const RunSummaryPacket& summary) {
  packet.flags = summary.flags | exportEvidence.flags;
  packet.width = pipeline.outputWidth();
  packet.height = pipeline.outputHeight();
  packet.targetFps = kTargetFramesPerSecond;
  packet.qpcFrequency = summary.qpcFrequency;
  packet.firstQpc = snapshot.firstQpc;
  packet.lastQpc = snapshot.lastQpc;
  packet.durationHns = snapshot.durationHns;
  packet.sampleCount = snapshot.units.size();
  packet.keyframes = static_cast<std::uint64_t>(std::count_if(
      snapshot.units.begin(), snapshot.units.end(),
      [](const EncodedAccessUnit& unit) { return unit.keyframe; }));
  packet.mp4Bytes = exportEvidence.bytes;
  packet.ringUnits = ring.size();
  packet.ringBytes = ring.bytes();
  packet.generation = snapshot.generation;
  const std::size_t nameBytes = std::min<std::size_t>(
      summary.encoderNameBytes, sizeof(packet.encoderName));
  std::copy_n(summary.encoderName, nameBytes, packet.encoderName);
  packet.encoderNameBytes = static_cast<std::uint32_t>(nameBytes);
}

struct PendingServiceExport {
  ServicePacket response{};
  std::future<ExportEvidence> future;
};

int RunService(const Request& request) {
  RunSummaryPacket summary = NewRunSummary();
  if (!QueryQpcFrequency(summary.qpcFrequency) ||
      !QueryQpc(summary.startedQpc)) {
    ServicePacket fatal = NewServicePacket(ServicePacketKind::kFatal);
    WriteServicePacket(fatal, ProbeStatus::kUnavailable,
                       ProbeReason::kCaptureDeadlineFailed, E_FAIL);
    return 1;
  }
  const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(comResult)) {
    ServicePacket fatal = NewServicePacket(ServicePacketKind::kFatal);
    WriteServicePacket(fatal, ProbeStatus::kUnavailable,
                       ProbeReason::kComInitializationFailed, comResult);
    return 1;
  }
  ComLifetime comLifetime(true);
  HRESULT result = MFStartup(MF_VERSION, MFSTARTUP_FULL);
  if (FAILED(result)) {
    ServicePacket fatal = NewServicePacket(ServicePacketKind::kFatal);
    WriteServicePacket(fatal, ProbeStatus::kUnavailable,
                       ProbeReason::kMediaFoundationFailed, result);
    return 1;
  }
  MediaFoundationLifetime mediaFoundationLifetime;
  summary.flags |= kRunMediaFoundationStarted;
  const std::int64_t whole = summary.qpcFrequency / 1000;
  const std::int64_t remainder = summary.qpcFrequency % 1000;
  const std::int64_t retentionQpc =
      whole * request.retentionMs +
      (remainder * request.retentionMs) / 1000;
  const std::size_t ringMaximumBytes = RingMaximumBytes(request.retentionMs);
  const std::size_t exportMaximumBytes =
      ringMaximumBytes + kExportContainerHeadroomBytes;
  EncodedAccessUnitRing ring(ringMaximumBytes, retentionQpc,
                             RingMaximumUnits(request.retentionMs));
  ExposureTimeline timeline(summary.qpcFrequency);
  auto pipeline = std::make_unique<CapturePipeline>();
  std::uint32_t generation = 1;
  std::uint32_t recoveryAttempts = 0;
  Request currentRequest = request;
  result = pipeline->Initialize(currentRequest, generation, summary);
  if (FAILED(result)) {
    ServicePacket fatal = NewServicePacket(ServicePacketKind::kFatal);
    WriteServicePacket(fatal, ProbeStatus::kUnavailable,
                       InitialPipelineReason(result), result);
    return 1;
  }
  const std::wstring selectedDevice = pipeline->choice().outputDesc.DeviceName;
  ServiceCommandReader commands;
  std::uint64_t lastRequestId = 0;
  bool ready = false;
  std::unique_ptr<PendingServiceExport> pendingExport;

  for (;;) {
    if (pendingExport &&
        pendingExport->future.wait_for(std::chrono::milliseconds(0)) ==
            std::future_status::ready) {
      ExportEvidence exported;
      try {
        exported = pendingExport->future.get();
      } catch (...) {
        exported.result = E_FAIL;
        exported.reason = ProbeReason::kExportWriteFailed;
      }
      pendingExport->response.flags |= exported.flags;
      pendingExport->response.mp4Bytes = exported.bytes;
      if (!WriteServicePacket(
              pendingExport->response,
              SUCCEEDED(exported.result) ? ProbeStatus::kAvailable
                                         : ProbeStatus::kUnavailable,
              exported.reason, exported.result)) {
        return 1;
      }
      pendingExport.reset();
    }
    const ServiceCommand command = commands.Poll(lastRequestId);
    if (command.kind == ServiceCommandKind::kInvalid) {
      ServicePacket fatal = NewServicePacket(ServicePacketKind::kFatal);
      WriteServicePacket(fatal, ProbeStatus::kUnavailable,
                         ProbeReason::kServiceProtocolInvalid, E_INVALIDARG);
      return 1;
    }
    if (command.kind == ServiceCommandKind::kStop) return 0;
    if (command.kind == ServiceCommandKind::kSnapshot) {
      lastRequestId = command.requestId;
      ServicePacket response = NewServicePacket(ServicePacketKind::kSnapshot);
      response.requestId = command.requestId;
      if (pendingExport) {
        response.ringUnits = ring.size();
        response.ringBytes = ring.bytes();
        WriteServicePacket(response, ProbeStatus::kUnavailable,
                           ProbeReason::kNoSafeSnapshot, E_PENDING);
        continue;
      }
      std::int64_t cutQpc = 0;
      EncodedRingSnapshot snapshot;
      if (!QueryQpc(cutQpc) || !ring.Snapshot(cutQpc, snapshot)) {
        response.ringUnits = ring.size();
        response.ringBytes = ring.bytes();
        WriteServicePacket(response, ProbeStatus::kUnavailable,
                           ProbeReason::kNoSafeSnapshot, E_PENDING);
      } else {
        const UINT width = pipeline->outputWidth();
        const UINT height = pipeline->outputHeight();
        const std::wstring outputPath = command.path;
        const ExportEvidence pendingEvidence;
        FillServiceEvidence(response, snapshot, pendingEvidence, ring,
                            *pipeline, summary);
        try {
          auto future = std::async(
              std::launch::async,
              [snapshot = std::move(snapshot), width, height, outputPath,
               exportMaximumBytes]() mutable {
                ExportEvidence exported;
                const HRESULT comResult =
                    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
                if (FAILED(comResult)) {
                  exported.result = comResult;
                  exported.reason = ProbeReason::kExportCreateFailed;
                  return exported;
                }
                ComLifetime comLifetime(true);
                return ExportSnapshot(snapshot, width, height, outputPath,
                                      exportMaximumBytes);
              });
          pendingExport = std::make_unique<PendingServiceExport>(
              PendingServiceExport{response, std::move(future)});
        } catch (...) {
          DeleteFileW(outputPath.c_str());
          WriteServicePacket(response, ProbeStatus::kUnavailable,
                             ProbeReason::kExportCreateFailed, E_FAIL);
        }
      }
    }

    ProbeReason failureReason = ProbeReason::kNone;
    result = pipeline->AcquireAndProcess(kAcquireTimeoutMs, timeline, ring,
                                         summary, failureReason);
    if (result == DXGI_ERROR_WAIT_TIMEOUT &&
        failureReason == ProbeReason::kAcquireFailed) {
      ++summary.acquireTimeouts;
      continue;
    }
    if (FAILED(result)) {
      if (result == MF_E_TRANSFORM_STREAM_CHANGE) {
        failureReason = ProbeReason::kCodecConfigChanged;
      } else if (result == MF_E_INVALIDMEDIATYPE &&
                 failureReason == ProbeReason::kEncoderOutputFailed) {
        failureReason = ProbeReason::kCodecConfigInvalid;
      }
      const RecoveryDecision recovery = RecoveryFor(result, recoveryAttempts);
      if (recovery != RecoveryDecision::kReinitialize) {
        ServicePacket fatal = NewServicePacket(ServicePacketKind::kFatal);
        fatal.flags = summary.flags;
        fatal.qpcFrequency = summary.qpcFrequency;
        fatal.ringUnits = ring.size();
        fatal.ringBytes = ring.bytes();
        WriteServicePacket(fatal, ProbeStatus::kUnavailable,
                           failureReason, result);
        return 1;
      }
      ++recoveryAttempts;
      ++summary.reinitializations;
      ++generation;
      summary.flags |= kRunPipelineReinitialized;
      ring.Reset();
      pipeline.reset();
      currentRequest = request;
      currentRequest.hasDeviceName = true;
      currentRequest.deviceName = selectedDevice;
      pipeline = std::make_unique<CapturePipeline>();
      result = pipeline->Initialize(currentRequest, generation, summary);
      if (FAILED(result)) {
        ServicePacket fatal = NewServicePacket(ServicePacketKind::kFatal);
        WriteServicePacket(fatal, ProbeStatus::kUnavailable,
                           ProbeReason::kReinitializeFailed, result);
        return 1;
      }
      // Before the first READY, the rebuilt pipeline must pass the full health
      // export. After READY, keep the protocol selected while the empty ring
      // warms back to a safe keyframe; emitting a second READY would violate
      // the one-shot handshake and make the application tear down a recovery
      // that actually succeeded.
      continue;
    }
    if (ready) continue;
    std::int64_t cutQpc = 0;
    EncodedRingSnapshot healthSnapshot;
    if (!QueryQpc(cutQpc) || !ring.Snapshot(cutQpc, healthSnapshot)) continue;
    std::wstring healthPath;
    if (!TemporaryExportPath(healthPath)) {
      ServicePacket fatal = NewServicePacket(ServicePacketKind::kFatal);
      WriteServicePacket(fatal, ProbeStatus::kUnavailable,
                         ProbeReason::kExportCreateFailed,
                         HRESULT_FROM_WIN32(GetLastError()));
      return 1;
    }
    const ExportEvidence health = ExportSnapshot(
        healthSnapshot, pipeline->outputWidth(), pipeline->outputHeight(),
        healthPath, exportMaximumBytes);
    DeleteFileW(healthPath.c_str());
    if (FAILED(health.result)) {
      ServicePacket fatal = NewServicePacket(ServicePacketKind::kFatal);
      FillServiceEvidence(fatal, healthSnapshot, health, ring, *pipeline,
                          summary);
      WriteServicePacket(fatal, ProbeStatus::kUnavailable,
                         health.reason, health.result);
      return 1;
    }
    ServicePacket readyPacket = NewServicePacket(ServicePacketKind::kReady);
    FillServiceEvidence(readyPacket, healthSnapshot, health, ring, *pipeline,
                        summary);
    if (!ServiceHealthIncludesCursor(readyPacket.flags)) {
      WriteServicePacket(readyPacket, ProbeStatus::kUnavailable,
                         ProbeReason::kCursorCompositionUnavailable,
                         DXGI_ERROR_UNSUPPORTED);
      return 1;
    }
    if (!WriteServicePacket(readyPacket, ProbeStatus::kAvailable,
                            ProbeReason::kNone, S_OK)) {
      return 1;
    }
    ready = true;
  }
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  Request request;
  if (!ParseRequest(argc, argv, request)) {
    if (HasServiceArgument(argc, argv)) {
      ServicePacket packet = NewServicePacket(ServicePacketKind::kFatal);
      WriteServicePacket(packet, ProbeStatus::kUnavailable,
                         ProbeReason::kInvalidRequest, E_INVALIDARG);
      return 1;
    }
    if (HasCaptureArgument(argc, argv)) {
      RunSummaryPacket packet = NewRunSummary();
      return WriteRunSummary(packet, ProbeStatus::kUnavailable,
                             ProbeReason::kInvalidRequest, E_INVALIDARG);
    }
    ProbePacket packet = NewPacket();
    return WritePacket(packet, ProbeStatus::kUnavailable, ProbeReason::kInvalidRequest);
  }
  if (request.selfTest) {
    if (!RingSelfTest()) {
      std::fputs("dxgi replay ring self-test: FAIL\n", stderr);
      return 1;
    }
    std::fputs("dxgi replay ring self-test: OK\n", stdout);
    return 0;
  }
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (request.serve) return RunService(request);
  if (request.captureMs != 0) return RunCapture(request);

  ProbePacket packet = NewPacket();
  OutputChoice choice;
  HRESULT result = S_OK;
  if (!SelectOutput(request, choice, result)) {
    return WritePacket(
        packet, ProbeStatus::kUnavailable,
        result == DXGI_ERROR_NOT_FOUND ? ProbeReason::kOutputNotFound
                                       : ProbeReason::kFactoryFailed);
  }
  AddOutputIdentity(packet, choice);

  const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(comResult)) {
    return WritePacket(packet, ProbeStatus::kUnavailable,
                       ProbeReason::kComInitializationFailed);
  }
  ComLifetime comLifetime(true);
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  result = CreateVideoDevice(choice.adapter.Get(), device, context);
  if (FAILED(result)) {
    return WritePacket(packet, ProbeStatus::kUnavailable, ProbeReason::kDeviceFailed);
  }
  packet.flags |= kD3d11DeviceCreated;

  ComPtr<IDXGIOutput1> output1;
  ComPtr<IDXGIOutputDuplication> duplication;
  result = choice.output.As(&output1);
  if (SUCCEEDED(result)) result = output1->DuplicateOutput(device.Get(), &duplication);
  if (FAILED(result)) {
    return WritePacket(packet, ProbeStatus::kUnavailable, DuplicateReason(result));
  }
  packet.flags |= kDesktopDuplicationCreated;

  if (!SupportsGpuColorConversion(choice, device.Get(), context.Get())) {
    return WritePacket(packet, ProbeStatus::kUnavailable,
                       ProbeReason::kVideoProcessorUnavailable);
  }
  packet.flags |= kGpuBgraToNv12Supported;

  result = MFStartup(MF_VERSION, MFSTARTUP_FULL);
  if (FAILED(result)) {
    return WritePacket(packet, ProbeStatus::kUnavailable,
                       ProbeReason::kMediaFoundationFailed);
  }
  MediaFoundationLifetime mediaFoundationLifetime;
  packet.flags |= kMediaFoundationStarted;

  UINT resetToken = 0;
  ComPtr<IMFDXGIDeviceManager> manager;
  result = MFCreateDXGIDeviceManager(&resetToken, &manager);
  if (SUCCEEDED(result)) result = manager->ResetDevice(device.Get(), resetToken);
  if (FAILED(result)) {
    return WritePacket(packet, ProbeStatus::kUnavailable,
                       ProbeReason::kDeviceManagerFailed);
  }
  packet.flags |= kDxgiDeviceManagerCreated;

  const ProbeReason encoderReason = BindHardwareEncoder(choice, manager.Get(), packet);
  if (encoderReason != ProbeReason::kNone) {
    return WritePacket(packet, ProbeStatus::kUnavailable, encoderReason);
  }
  return WritePacket(packet, ProbeStatus::kAvailable, ProbeReason::kNone);
}
