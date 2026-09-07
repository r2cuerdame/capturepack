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
#include <dxgi1_2.h>
#include <icodecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <fcntl.h>
#include <io.h>
#include <wrl/client.h>

#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <deque>
#include <iterator>
#include <limits>
#include <memory>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

constexpr std::uint16_t kProtocolVersion = 1;
constexpr std::uint32_t kMinimumCaptureMs = 100;
constexpr std::uint32_t kMaximumCaptureMs = 30'000;
constexpr std::uint32_t kTargetFramesPerSecond = 15;
constexpr std::size_t kMaximumRingBytes = 64U * 1024U * 1024U;
constexpr std::size_t kMaximumRingUnits = 512;
constexpr std::uint32_t kAcquireTimeoutMs = 20;
constexpr std::uint32_t kMaximumReinitializations = 3;

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
};

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
#pragma pack(pop)

static_assert(sizeof(ProbePacket) == 256, "probe packet size changed");
static_assert(offsetof(ProbePacket, deviceName) == 64, "probe offsets changed");
static_assert(offsetof(ProbePacket, encoderName) == 128, "probe offsets changed");
static_assert(sizeof(RunSummaryPacket) == 256, "run packet size changed");
static_assert(offsetof(RunSummaryPacket, qpcFrequency) == 56,
              "run packet offsets changed");
static_assert(offsetof(RunSummaryPacket, encoderName) == 188,
              "run packet offsets changed");

struct Request {
  bool selfTest = false;
  std::uint32_t captureMs = 0;
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
        unitBytes > maximumBytes_ ||
        bytes_ > std::numeric_limits<std::size_t>::max() - unitBytes ||
        (!units_.empty() && unit.exposedQpc <= units_.back().exposedQpc)) {
      return false;
    }
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

  std::vector<EncodedAccessUnit> Snapshot(std::int64_t cutQpc) const {
    std::vector<EncodedAccessUnit> selected;
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
    for (auto current = first;
         current != units_.end() && current->exposedQpc <= cutQpc;
         ++current) {
      selected.push_back(*current);
    }
    return selected;
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
    } else {
      return false;
    }
  }
  const int boundsParts = static_cast<int>(haveLeft) + static_cast<int>(haveTop) +
                          static_cast<int>(haveWidth) + static_cast<int>(haveHeight);
  if (boundsParts != 0 && boundsParts != 4) return false;
  request.hasBounds = boundsParts == 4;
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
    SetCodecBool(codec.Get(), CODECAPI_AVLowLatencyMode, true);
    if (!SetCodecUint32(codec.Get(), CODECAPI_AVEncMPVDefaultBPictureCount, 0,
                        false) ||
        !SetCodecUint32(codec.Get(), CODECAPI_AVEncMPVGOPSize,
                        kTargetFramesPerSecond * 2, true)) {
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
    const std::uint64_t pixelRate = static_cast<std::uint64_t>(width) * height;
    const std::uint32_t bitrate = static_cast<std::uint32_t>(std::min<std::uint64_t>(
        50'000'000, std::max<std::uint64_t>(2'000'000, pixelRate * 4)));
    if (SUCCEEDED(result)) result = outputType_->SetUINT32(MF_MT_AVG_BITRATE, bitrate);
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
    ReadCodecConfig();
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
  void ReadCodecConfig() {
    ComPtr<IMFMediaType> currentType;
    IMFMediaType* type = outputType_.Get();
    if (SUCCEEDED(transform_->GetOutputCurrentType(0, &currentType)) &&
        currentType) {
      type = currentType.Get();
    }
    UINT32 bytes = 0;
    if (FAILED(type->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &bytes)) ||
        bytes == 0 || bytes > 64U * 1024U) {
      return;
    }
    codecConfig_.resize(bytes);
    UINT32 written = 0;
    if (FAILED(type->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER, codecConfig_.data(),
                             bytes, &written)) ||
        written != bytes) {
      codecConfig_.clear();
    }
  }

  HRESULT PullOutput(EncodedAccessUnitRing& ring, RunSummaryPacket& summary) {
    if (!transitions_.ConsumeOutput()) return MF_E_INVALIDREQUEST;
    ComPtr<IMFSample> callerSample;
    if ((outputInfo_.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES) == 0) {
      HRESULT result = MFCreateSample(&callerSample);
      ComPtr<IMFMediaBuffer> buffer;
      if (SUCCEEDED(result)) result = MFCreateMemoryBuffer(outputInfo_.cbSize, &buffer);
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
    if (keyframe && codecConfig_.empty()) ReadCodecConfig();
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
    context_->CopyResource(ownedBgra_.Get(), source.Get());
    if (!GpuCompletedWithin(device_.Get(), context_.Get(), kAcquireTimeoutMs,
                            result)) {
      failureReason = IsDeviceLoss(result) ? ProbeReason::kDeviceLostExhausted
                                           : ProbeReason::kGpuConversionFailed;
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

 private:
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
    sourceDescription_.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    sourceDescription_.ArraySize = 1;
    sourceDescription_.MipLevels = 1;
    sourceDescription_.SampleDesc.Count = 1;
    sourceDescription_.SampleDesc.Quality = 0;
    result = device_->CreateTexture2D(&sourceDescription_, nullptr, &ownedBgra_);
    if (FAILED(result)) {
      failureReason = ProbeReason::kGpuConversionFailed;
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

  EncodedAccessUnitRing bytesRing(80, 3'000, 16);
  const bool byteAppends =
      bytesRing.Append(TestUnit(1'000, true, 20)) &&
      bytesRing.Append(TestUnit(2'000, false, 20)) &&
      bytesRing.Append(TestUnit(3'000, false, 20)) &&
      bytesRing.Append(TestUnit(4'000, true, 20)) &&
      bytesRing.Append(TestUnit(5'000, false, 20));
  const auto byteSnapshot = bytesRing.Snapshot(5'000);
  passed &= NamedSelfTest(
      "bounded-bytes-keyframe-cut",
      byteAppends && bytesRing.bytes() <= 80 && bytesRing.size() == 2 &&
          byteSnapshot.size() == 2 && byteSnapshot.front().keyframe &&
          byteSnapshot.front().exposedQpc == 4'000);

  EncodedAccessUnitRing timeRing(1'000, 2'000, 16);
  const bool timeAppends =
      timeRing.Append(TestUnit(1'000, true, 10)) &&
      timeRing.Append(TestUnit(2'000, false, 10)) &&
      timeRing.Append(TestUnit(3'000, true, 10)) &&
      timeRing.Append(TestUnit(4'000, false, 10)) &&
      timeRing.Append(TestUnit(5'000, false, 10));
  passed &= NamedSelfTest(
      "bounded-time",
      timeAppends && timeRing.size() == 3 && timeRing.Snapshot(5'000).size() == 3);

  EncodedAccessUnitRing unitsRing(1'000, 10'000, 2);
  const bool unitsAppends = unitsRing.Append(TestUnit(1'000, true, 10)) &&
                            unitsRing.Append(TestUnit(2'000, false, 10)) &&
                            unitsRing.Append(TestUnit(3'000, true, 10));
  passed &= NamedSelfTest(
      "bounded-max-units",
      unitsAppends && unitsRing.size() == 1 &&
          unitsRing.Snapshot(3'000).size() == 1);

  EncodedAccessUnitRing generationRing(1'000, 10'000, 16);
  const bool firstGeneration =
      generationRing.Append(TestUnit(1'000, true, 10, 1)) &&
      generationRing.Append(TestUnit(2'000, false, 10, 1));
  const bool rejectsUnsafeGeneration =
      !generationRing.Append(TestUnit(3'000, false, 10, 2));
  const bool acceptsSafeGeneration =
      generationRing.Append(TestUnit(4'000, true, 10, 2));
  passed &= NamedSelfTest(
      "config-generation-keyframe-cut",
      firstGeneration && rejectsUnsafeGeneration && acceptsSafeGeneration &&
          generationRing.size() == 1 &&
          generationRing.Snapshot(4'000).front().generation == 2);

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
  EncodedAccessUnitRing ring(kMaximumRingBytes, retentionQpc,
                             kMaximumRingUnits);
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
    currentRequest = Request{};
    currentRequest.hasDeviceName = true;
    currentRequest.deviceName = selectedDevice;
    currentRequest.captureMs = request.captureMs;
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
      kRunRingRetained;
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

}  // namespace

int wmain(int argc, wchar_t** argv) {
  Request request;
  if (!ParseRequest(argc, argv, request)) {
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
