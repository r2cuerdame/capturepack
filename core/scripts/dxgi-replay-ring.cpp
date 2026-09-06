// Capability and retention scaffold for CapturePack's native Windows replay.
//
// Normal mode performs a bounded, one-shot probe of the exact capture adapter:
// DXGI output -> D3D11 video device -> Desktop Duplication -> adapter-bound
// Media Foundation hardware H.264 MFT -> IMFDXGIDeviceManager acceptance.
// It does not capture a frame and cannot disturb the shipping MediaRecorder
// path. --self-test exercises the native encoded-access-unit ring without
// opening the desktop or a codec.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <mfapi.h>
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
#include <limits>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

constexpr std::uint16_t kProtocolVersion = 1;

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
#pragma pack(pop)

static_assert(sizeof(ProbePacket) == 256, "probe packet size changed");
static_assert(offsetof(ProbePacket, deviceName) == 64, "probe offsets changed");
static_assert(offsetof(ProbePacket, encoderName) == 128, "probe offsets changed");

struct Request {
  bool selfTest = false;
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
  bool keyframe = false;
  std::vector<std::uint8_t> bytes;
};

// The production encoder will append complete access units. Retention can be
// shorter than requested when a byte/time cut crosses a GOP: the ring removes
// the undecodable prefix through the next keyframe instead of exporting it.
class EncodedAccessUnitRing {
 public:
  EncodedAccessUnitRing(std::size_t maximumBytes, std::int64_t retentionQpc)
      : maximumBytes_(maximumBytes), retentionQpc_(retentionQpc) {}

  bool Append(EncodedAccessUnit unit) {
    if (maximumBytes_ == 0 || retentionQpc_ <= 0 || unit.exposedQpc < 0 ||
        unit.bytes.empty() ||
        unit.bytes.size() > maximumBytes_ ||
        bytes_ > std::numeric_limits<std::size_t>::max() - unit.bytes.size() ||
        (!units_.empty() && unit.exposedQpc <= units_.back().exposedQpc)) {
      return false;
    }
    bytes_ += unit.bytes.size();
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

 private:
  void PopFront() {
    bytes_ -= units_.front().bytes.size();
    units_.pop_front();
  }

  void Prune() {
    while (!units_.empty() &&
           (bytes_ > maximumBytes_ ||
            units_.back().exposedQpc - units_.front().exposedQpc >
                retentionQpc_)) {
      PopFront();
      while (!units_.empty() && !units_.front().keyframe) PopFront();
    }
  }

  const std::size_t maximumBytes_;
  const std::int64_t retentionQpc_;
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

bool RingSelfTest() {
  EncodedAccessUnitRing ring(80, 3'000);
  const auto unit = [](std::int64_t qpc, bool keyframe, std::size_t bytes) {
    return EncodedAccessUnit{qpc, keyframe, std::vector<std::uint8_t>(bytes, 0x5a)};
  };
  if (!ring.Append(unit(1'000, true, 20)) ||
      !ring.Append(unit(2'000, false, 20)) ||
      !ring.Append(unit(3'000, false, 20)) ||
      !ring.Append(unit(4'000, true, 20)) ||
      !ring.Append(unit(5'000, false, 20))) {
    return false;
  }
  const auto snapshot = ring.Snapshot(5'000);
  if (ring.bytes() > 80 || ring.size() != 2 || snapshot.size() != 2 ||
      !snapshot.front().keyframe || snapshot.front().exposedQpc != 4'000 ||
      snapshot.back().exposedQpc != 5'000) {
    return false;
  }
  if (ring.Append(unit(4'500, true, 10)) || ring.Append(unit(6'000, true, 81))) {
    return false;
  }
  EncodedAccessUnitRing timeOnly(1'000, 2'000);
  if (!timeOnly.Append(unit(1'000, true, 10)) ||
      !timeOnly.Append(unit(2'000, false, 10)) ||
      !timeOnly.Append(unit(3'000, true, 10)) ||
      !timeOnly.Append(unit(4'000, false, 10)) ||
      !timeOnly.Append(unit(5'000, false, 10)) ||
      timeOnly.size() != 3 || timeOnly.Snapshot(5'000).size() != 3) {
    return false;
  }
  EncodedAccessUnitRing gopCuts(1'000, 1'500);
  if (!gopCuts.Append(unit(1'000, true, 10)) ||
      !gopCuts.Append(unit(2'000, false, 10)) ||
      !gopCuts.Append(unit(3'000, false, 10)) ||
      !gopCuts.Snapshot(3'000).empty()) {
    return false;
  }
  EncodedAccessUnitRing prefix(1'000, 10'000);
  if (!prefix.Append(unit(1'000, false, 10)) ||
      !prefix.Append(unit(2'000, false, 10)) ||
      !prefix.Append(unit(3'000, true, 10)) ||
      !prefix.Append(unit(4'000, false, 10)) ||
      !prefix.Snapshot(2'000).empty() || prefix.Snapshot(4'000).size() != 2) {
    return false;
  }
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
  if (!MatchesOutput(selector, description)) return false;
  description.DesktopCoordinates = {0, 0, 1920, 1080};
  if (MatchesOutput(selector, description)) return false;
  description.DesktopCoordinates = {-1920, 0, 0, 1080};
  wcscpy_s(description.DeviceName, L"\\\\.\\DISPLAY1");
  if (MatchesOutput(selector, description)) return false;
  return true;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  Request request;
  if (!ParseRequest(argc, argv, request)) {
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
