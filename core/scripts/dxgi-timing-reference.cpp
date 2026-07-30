// CapturePack's bounded, one-shot DXGI Output Duplication timing reference.
//
// The only available result pairs LastPresentTime with RGB pixels copied from
// the SAME acquired IDXGIResource. Pointer-only updates, timeouts, access loss,
// unsupported rotation, and every incomplete copy are explicit unavailable
// packets. No previous pixels or timestamps are ever reused.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <fcntl.h>
#include <io.h>
#include <wrl/client.h>

#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <limits>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

constexpr std::uint16_t kProtocolVersion = 1;
constexpr std::uint32_t kOutputWidth = 128;
constexpr std::uint32_t kOutputHeight = 72;
constexpr std::uint32_t kOutputChannels = 3;
constexpr std::uint32_t kDefaultAcquireTimeoutMs = 80;
constexpr std::uint32_t kMaximumAcquireTimeoutMs = 250;
constexpr std::uint32_t kDefaultCopyTimeoutMs = 80;
constexpr std::uint32_t kMaximumCopyTimeoutMs = 250;
constexpr std::uint64_t kWindowsToUnixEpoch100ns = 116444736000000000ULL;

enum class PacketStatus : std::uint32_t {
  kAvailable = 0,
  kUnavailable = 1,
};

enum class UnavailableReason : std::uint32_t {
  kNone = 0,
  kOutputNotFound = 1,
  kFactoryFailed = 2,
  kDeviceFailed = 3,
  kDuplicateFailed = 4,
  kTimeout = 5,
  kNoDesktopUpdate = 6,
  kAccessLost = 7,
  kResourceUnavailable = 8,
  kTextureUnavailable = 9,
  kUnsupportedFormat = 10,
  kCopyTimeout = 11,
  kMapFailed = 12,
  kUnsupportedRotation = 13,
  kInternalFailure = 14,
};

#pragma pack(push, 1)
struct PacketHeader {
  char magic[8];
  std::uint16_t version;
  std::uint16_t headerBytes;
  std::uint32_t status;
  std::uint32_t reason;
  std::uint32_t width;
  std::uint32_t height;
  std::uint32_t channels;
  std::uint32_t pixelBytes;
  std::uint32_t adapterIndex;
  std::uint32_t outputIndex;
  std::int32_t boundsLeft;
  std::int32_t boundsTop;
  std::int32_t boundsRight;
  std::int32_t boundsBottom;
  std::int64_t lastPresentQpc;
  std::int64_t qpcFrequency;
  std::int64_t anchorQpc;
  std::int64_t anchorUnixNs;
  std::uint64_t anchorSpanQpc;
  std::uint32_t accumulatedFrames;
  std::uint32_t deviceNameBytes;
  char deviceName[64];
  std::uint32_t reserved;
};
#pragma pack(pop)

static_assert(sizeof(PacketHeader) == 176, "wire header size changed");
static_assert(offsetof(PacketHeader, lastPresentQpc) == 60, "wire offsets changed");
static_assert(offsetof(PacketHeader, deviceName) == 108, "wire offsets changed");

struct Request {
  bool hasDeviceName = false;
  std::wstring deviceName;
  bool hasBounds = false;
  LONG left = 0;
  LONG top = 0;
  LONG width = 0;
  LONG height = 0;
  std::uint32_t acquireTimeoutMs = kDefaultAcquireTimeoutMs;
  std::uint32_t copyTimeoutMs = kDefaultCopyTimeoutMs;
};

struct OutputChoice {
  ComPtr<IDXGIAdapter1> adapter;
  ComPtr<IDXGIOutput> output;
  DXGI_OUTPUT_DESC desc{};
  std::uint32_t adapterIndex = 0;
  std::uint32_t outputIndex = 0;
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

bool ParseTimeout(const wchar_t* text, std::uint32_t maximum, std::uint32_t& value) {
  LONG parsed = 0;
  if (!ParseLong(text, parsed) || parsed < 1 ||
      static_cast<std::uint32_t>(parsed) > maximum) {
    return false;
  }
  value = static_cast<std::uint32_t>(parsed);
  return true;
}

bool ParseRequest(int argc, wchar_t** argv, Request& request) {
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
    } else if (option == L"--timeout-ms") {
      if (!ParseTimeout(value, kMaximumAcquireTimeoutMs, request.acquireTimeoutMs)) {
        return false;
      }
    } else if (option == L"--copy-timeout-ms") {
      if (!ParseTimeout(value, kMaximumCopyTimeoutMs, request.copyTimeoutMs)) {
        return false;
      }
    } else {
      return false;
    }
  }
  const int boundsParts =
      static_cast<int>(haveLeft) + static_cast<int>(haveTop) +
      static_cast<int>(haveWidth) + static_cast<int>(haveHeight);
  if (boundsParts != 0 && boundsParts != 4) return false;
  request.hasBounds = boundsParts == 4;
  return request.hasDeviceName || request.hasBounds;
}

std::string Utf8(const wchar_t* text) {
  if (text == nullptr || *text == L'\0') return {};
  const int bytes = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, text, -1, nullptr, 0, nullptr, nullptr);
  if (bytes <= 1) return {};
  std::string output(static_cast<std::size_t>(bytes), '\0');
  if (WideCharToMultiByte(
          CP_UTF8,
          WC_ERR_INVALID_CHARS,
          text,
          -1,
          output.data(),
          bytes,
          nullptr,
          nullptr) == 0) {
    return {};
  }
  output.pop_back();
  return output;
}

bool SameDeviceName(const wchar_t* left, const std::wstring& right) {
  return _wcsicmp(left, right.c_str()) == 0;
}

bool SameBounds(const RECT& bounds, const Request& request) {
  const long long right =
      static_cast<long long>(request.left) + request.width;
  const long long bottom =
      static_cast<long long>(request.top) + request.height;
  return right <= std::numeric_limits<LONG>::max() &&
      bottom <= std::numeric_limits<LONG>::max() &&
      bounds.left == request.left &&
      bounds.top == request.top &&
      bounds.right == static_cast<LONG>(right) &&
      bounds.bottom == static_cast<LONG>(bottom);
}

bool ChooseOutput(const Request& request, OutputChoice& choice, HRESULT& failure) {
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
    for (UINT outputIndex = 0;; ++outputIndex) {
      ComPtr<IDXGIOutput> output;
      const HRESULT outputResult = adapter->EnumOutputs(outputIndex, &output);
      if (outputResult == DXGI_ERROR_NOT_FOUND) break;
      if (FAILED(outputResult)) {
        failure = outputResult;
        return false;
      }
      DXGI_OUTPUT_DESC desc{};
      if (FAILED(output->GetDesc(&desc)) || !desc.AttachedToDesktop) continue;
      if (request.hasDeviceName && !SameDeviceName(desc.DeviceName, request.deviceName)) {
        continue;
      }
      if (request.hasBounds && !SameBounds(desc.DesktopCoordinates, request)) {
        continue;
      }
      choice = {adapter, output, desc, adapterIndex, outputIndex};
      failure = S_OK;
      return true;
    }
  }
  failure = DXGI_ERROR_NOT_FOUND;
  return false;
}

void FillOutput(PacketHeader& header, const OutputChoice& choice) {
  header.adapterIndex = choice.adapterIndex;
  header.outputIndex = choice.outputIndex;
  header.boundsLeft = choice.desc.DesktopCoordinates.left;
  header.boundsTop = choice.desc.DesktopCoordinates.top;
  header.boundsRight = choice.desc.DesktopCoordinates.right;
  header.boundsBottom = choice.desc.DesktopCoordinates.bottom;
  const std::string device = Utf8(choice.desc.DeviceName);
  header.deviceNameBytes = static_cast<std::uint32_t>(
      std::min(device.size(), sizeof(header.deviceName)));
  std::copy_n(device.data(), header.deviceNameBytes, header.deviceName);
}

void FillClock(PacketHeader& header) {
  LARGE_INTEGER frequency{};
  LARGE_INTEGER before{};
  LARGE_INTEGER after{};
  FILETIME fileTime{};
  if (!QueryPerformanceFrequency(&frequency) ||
      !QueryPerformanceCounter(&before)) {
    return;
  }
  GetSystemTimePreciseAsFileTime(&fileTime);
  if (!QueryPerformanceCounter(&after)) return;
  ULARGE_INTEGER ticks{};
  ticks.LowPart = fileTime.dwLowDateTime;
  ticks.HighPart = fileTime.dwHighDateTime;
  if (ticks.QuadPart < kWindowsToUnixEpoch100ns) return;
  const std::uint64_t unix100ns = ticks.QuadPart - kWindowsToUnixEpoch100ns;
  if (unix100ns >
      static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()) / 100) {
    return;
  }
  header.qpcFrequency = frequency.QuadPart;
  header.anchorQpc =
      before.QuadPart + (after.QuadPart - before.QuadPart) / 2;
  header.anchorUnixNs = static_cast<std::int64_t>(unix100ns * 100);
  header.anchorSpanQpc = static_cast<std::uint64_t>(
      std::max<LONGLONG>(0, after.QuadPart - before.QuadPart));
}

PacketHeader NewHeader() {
  PacketHeader header{};
  std::copy_n("CPDXGI01", 8, header.magic);
  header.version = kProtocolVersion;
  header.headerBytes = sizeof(PacketHeader);
  header.status = static_cast<std::uint32_t>(PacketStatus::kUnavailable);
  header.reason = static_cast<std::uint32_t>(UnavailableReason::kInternalFailure);
  FillClock(header);
  return header;
}

int Emit(const PacketHeader& header, const std::vector<std::uint8_t>& pixels = {}) {
  if (std::fwrite(&header, 1, sizeof(header), stdout) != sizeof(header)) return 74;
  if (!pixels.empty() &&
      std::fwrite(pixels.data(), 1, pixels.size(), stdout) != pixels.size()) {
    return 74;
  }
  return std::fflush(stdout) == 0 ? 0 : 74;
}

int EmitUnavailable(
    PacketHeader header,
    UnavailableReason reason,
    const char* stage,
    HRESULT hr = S_OK) {
  header.status = static_cast<std::uint32_t>(PacketStatus::kUnavailable);
  header.reason = static_cast<std::uint32_t>(reason);
  header.width = 0;
  header.height = 0;
  header.channels = 0;
  header.pixelBytes = 0;
  if (stage != nullptr) {
    if (hr == S_OK) {
      std::fprintf(stderr, "dxgi timing reference unavailable: %s\n", stage);
    } else {
      std::fprintf(
          stderr,
          "dxgi timing reference unavailable: %s hr=0x%08lx\n",
          stage,
          static_cast<unsigned long>(hr));
    }
  }
  return Emit(header);
}

bool CopyCompletedWithin(
    ID3D11Device* device,
    ID3D11DeviceContext* context,
    ID3D11Texture2D* staging,
    ID3D11Texture2D* source,
    std::uint32_t timeoutMs,
    HRESULT& failure) {
  D3D11_QUERY_DESC queryDescription{};
  queryDescription.Query = D3D11_QUERY_EVENT;
  ComPtr<ID3D11Query> completion;
  failure = device->CreateQuery(&queryDescription, &completion);
  if (FAILED(failure)) return false;

  LARGE_INTEGER frequency{};
  LARGE_INTEGER start{};
  if (!QueryPerformanceFrequency(&frequency) || !QueryPerformanceCounter(&start)) {
    failure = E_FAIL;
    return false;
  }
  context->CopyResource(staging, source);
  context->End(completion.Get());
  context->Flush();
  for (;;) {
    const HRESULT result =
        context->GetData(completion.Get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
    if (result == S_OK) {
      failure = S_OK;
      return true;
    }
    if (result != S_FALSE) {
      failure = result;
      return false;
    }
    LARGE_INTEGER now{};
    if (!QueryPerformanceCounter(&now)) {
      failure = E_FAIL;
      return false;
    }
    const LONGLONG elapsed = now.QuadPart - start.QuadPart;
    const LONGLONG budget =
        (frequency.QuadPart * static_cast<LONGLONG>(timeoutMs)) / 1000;
    if (elapsed >= budget) {
      failure = DXGI_ERROR_WAIT_TIMEOUT;
      return false;
    }
    SwitchToThread();
  }
}

class FrameLease {
 public:
  explicit FrameLease(IDXGIOutputDuplication* duplication)
      : duplication_(duplication) {}
  ~FrameLease() {
    if (acquired_) duplication_->ReleaseFrame();
  }
  void Acquired() { acquired_ = true; }

 private:
  IDXGIOutputDuplication* duplication_;
  bool acquired_ = false;
};

}  // namespace

int wmain(int argc, wchar_t** argv) {
  // fwrite to a Windows console/pipe is text-mode by default. A 0x0A anywhere
  // in the fixed header or RGB would otherwise expand to CRLF and destroy the
  // one-packet length invariant.
  if (_setmode(_fileno(stdout), _O_BINARY) == -1) {
    std::fprintf(stderr, "could not put DXGI timing stdout in binary mode\n");
    return 74;
  }
  Request request;
  if (!ParseRequest(argc, argv, request)) {
    std::fprintf(
        stderr,
        "usage: dxgi-timing-reference.exe "
        "(--device NAME | --left X --top Y --native-width W --native-height H) "
        "[--timeout-ms 1..250] [--copy-timeout-ms 1..250]\n");
    return 64;
  }

  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  PacketHeader header = NewHeader();
  OutputChoice choice;
  HRESULT hr = S_OK;
  if (!ChooseOutput(request, choice, hr)) {
    return EmitUnavailable(
        header,
        hr == DXGI_ERROR_NOT_FOUND
            ? UnavailableReason::kOutputNotFound
            : UnavailableReason::kFactoryFailed,
        "requested physical output was not found",
        hr);
  }
  FillOutput(header, choice);
  if (choice.desc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED &&
      choice.desc.Rotation != DXGI_MODE_ROTATION_IDENTITY &&
      choice.desc.Rotation != DXGI_MODE_ROTATION_ROTATE90 &&
      choice.desc.Rotation != DXGI_MODE_ROTATION_ROTATE180 &&
      choice.desc.Rotation != DXGI_MODE_ROTATION_ROTATE270) {
    return EmitUnavailable(
        header,
        UnavailableReason::kUnsupportedRotation,
        "unknown DXGI output rotation");
  }

  const D3D_FEATURE_LEVEL levels[] = {
      D3D_FEATURE_LEVEL_11_1,
      D3D_FEATURE_LEVEL_11_0,
      D3D_FEATURE_LEVEL_10_1,
      D3D_FEATURE_LEVEL_10_0,
  };
  D3D_FEATURE_LEVEL selected{};
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  hr = D3D11CreateDevice(
      choice.adapter.Get(),
      D3D_DRIVER_TYPE_UNKNOWN,
      nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      levels,
      ARRAYSIZE(levels),
      D3D11_SDK_VERSION,
      &device,
      &selected,
      &context);
  if (hr == E_INVALIDARG) {
    hr = D3D11CreateDevice(
        choice.adapter.Get(),
        D3D_DRIVER_TYPE_UNKNOWN,
        nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        levels + 1,
        ARRAYSIZE(levels) - 1,
        D3D11_SDK_VERSION,
        &device,
        &selected,
        &context);
  }
  if (FAILED(hr)) {
    return EmitUnavailable(
        header, UnavailableReason::kDeviceFailed, "D3D11CreateDevice", hr);
  }

  ComPtr<IDXGIOutput1> output;
  hr = choice.output.As(&output);
  if (FAILED(hr)) {
    return EmitUnavailable(
        header, UnavailableReason::kDuplicateFailed, "IDXGIOutput1", hr);
  }
  ComPtr<IDXGIOutputDuplication> duplication;
  hr = output->DuplicateOutput(device.Get(), &duplication);
  if (FAILED(hr)) {
    return EmitUnavailable(
        header,
        hr == DXGI_ERROR_ACCESS_LOST
            ? UnavailableReason::kAccessLost
            : UnavailableReason::kDuplicateFailed,
        "DuplicateOutput",
        hr);
  }

  DXGI_OUTDUPL_FRAME_INFO frameInfo{};
  ComPtr<IDXGIResource> resource;
  FrameLease lease(duplication.Get());
  hr = duplication->AcquireNextFrame(
      request.acquireTimeoutMs, &frameInfo, &resource);
  if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
    return EmitUnavailable(
        header, UnavailableReason::kTimeout, "AcquireNextFrame timeout");
  }
  if (hr == DXGI_ERROR_ACCESS_LOST) {
    return EmitUnavailable(
        header, UnavailableReason::kAccessLost, "AcquireNextFrame access lost", hr);
  }
  if (FAILED(hr)) {
    return EmitUnavailable(
        header, UnavailableReason::kResourceUnavailable, "AcquireNextFrame", hr);
  }
  lease.Acquired();

  // A pointer-only update can carry a resource while LastPresentTime is zero.
  // Treating that resource as a desktop presentation would invent timing.
  if (frameInfo.LastPresentTime.QuadPart <= 0) {
    return EmitUnavailable(
        header,
        UnavailableReason::kNoDesktopUpdate,
        "acquired frame had no desktop-image LastPresentTime");
  }
  if (!resource) {
    return EmitUnavailable(
        header, UnavailableReason::kResourceUnavailable, "missing IDXGIResource");
  }

  ComPtr<ID3D11Texture2D> source;
  hr = resource.As(&source);
  if (FAILED(hr)) {
    return EmitUnavailable(
        header, UnavailableReason::kTextureUnavailable, "IDXGIResource texture", hr);
  }
  D3D11_TEXTURE2D_DESC sourceDescription{};
  source->GetDesc(&sourceDescription);
  if (sourceDescription.Format != DXGI_FORMAT_B8G8R8A8_UNORM ||
      sourceDescription.Width == 0 || sourceDescription.Height == 0) {
    return EmitUnavailable(
        header,
        UnavailableReason::kUnsupportedFormat,
        "desktop duplication texture format");
  }

  D3D11_TEXTURE2D_DESC stagingDescription = sourceDescription;
  stagingDescription.BindFlags = 0;
  stagingDescription.MiscFlags = 0;
  stagingDescription.Usage = D3D11_USAGE_STAGING;
  stagingDescription.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  stagingDescription.ArraySize = 1;
  stagingDescription.MipLevels = 1;
  stagingDescription.SampleDesc.Count = 1;
  stagingDescription.SampleDesc.Quality = 0;
  ComPtr<ID3D11Texture2D> staging;
  hr = device->CreateTexture2D(&stagingDescription, nullptr, &staging);
  if (FAILED(hr)) {
    return EmitUnavailable(
        header, UnavailableReason::kTextureUnavailable, "CreateTexture2D", hr);
  }
  if (!CopyCompletedWithin(
          device.Get(),
          context.Get(),
          staging.Get(),
          source.Get(),
          request.copyTimeoutMs,
          hr)) {
    return EmitUnavailable(
        header, UnavailableReason::kCopyTimeout, "bounded GPU copy", hr);
  }

  D3D11_MAPPED_SUBRESOURCE mapped{};
  hr = context->Map(
      staging.Get(),
      0,
      D3D11_MAP_READ,
      D3D11_MAP_FLAG_DO_NOT_WAIT,
      &mapped);
  if (hr == DXGI_ERROR_WAS_STILL_DRAWING) {
    return EmitUnavailable(
        header, UnavailableReason::kCopyTimeout, "nonblocking staging map", hr);
  }
  if (FAILED(hr)) {
    return EmitUnavailable(
        header, UnavailableReason::kMapFailed, "staging map", hr);
  }

  std::vector<std::uint8_t> pixels(
      kOutputWidth * kOutputHeight * kOutputChannels);
  const auto* bytes = static_cast<const std::uint8_t*>(mapped.pData);
  const bool swapsAxes =
      choice.desc.Rotation == DXGI_MODE_ROTATION_ROTATE90 ||
      choice.desc.Rotation == DXGI_MODE_ROTATION_ROTATE270;
  const std::uint32_t orientedWidth =
      swapsAxes ? sourceDescription.Height : sourceDescription.Width;
  const std::uint32_t orientedHeight =
      swapsAxes ? sourceDescription.Width : sourceDescription.Height;
  const auto& bounds = choice.desc.DesktopCoordinates;
  if (
      orientedWidth != static_cast<std::uint32_t>(bounds.right - bounds.left) ||
      orientedHeight != static_cast<std::uint32_t>(bounds.bottom - bounds.top)) {
    context->Unmap(staging.Get(), 0);
    return EmitUnavailable(
        header,
        UnavailableReason::kUnsupportedRotation,
        "rotated texture dimensions did not match output bounds");
  }
  for (std::uint32_t y = 0; y < kOutputHeight; ++y) {
    // Match Canvas2D nearest-neighbour scaling: sample the source coordinate
    // under each destination pixel centre. Sampling the destination edge
    // (y * source / destination) shifts a 4K source by up to 15 physical
    // pixels relative to Chromium's decoded frame and destroys the temporal
    // fingerprint trough even though both inputs are the same desktop frame.
    const std::uint32_t orientedY = std::min(
        orientedHeight - 1,
        static_cast<std::uint32_t>(
            (static_cast<std::uint64_t>(2 * y + 1) * orientedHeight) /
            (2 * kOutputHeight)));
    for (std::uint32_t x = 0; x < kOutputWidth; ++x) {
      const std::uint32_t orientedX = std::min(
          orientedWidth - 1,
          static_cast<std::uint32_t>(
              (static_cast<std::uint64_t>(2 * x + 1) * orientedWidth) /
              (2 * kOutputWidth)));
      std::uint32_t sourceX = orientedX;
      std::uint32_t sourceY = orientedY;
      if (choice.desc.Rotation == DXGI_MODE_ROTATION_ROTATE90) {
        sourceX = orientedY;
        sourceY = sourceDescription.Height - 1 - orientedX;
      } else if (choice.desc.Rotation == DXGI_MODE_ROTATION_ROTATE180) {
        sourceX = sourceDescription.Width - 1 - orientedX;
        sourceY = sourceDescription.Height - 1 - orientedY;
      } else if (choice.desc.Rotation == DXGI_MODE_ROTATION_ROTATE270) {
        sourceX = sourceDescription.Width - 1 - orientedY;
        sourceY = orientedX;
      }
      const auto* row =
          bytes + static_cast<std::size_t>(sourceY) * mapped.RowPitch;
      const auto* bgra = row + static_cast<std::size_t>(sourceX) * 4;
      const std::size_t destination =
          (static_cast<std::size_t>(y) * kOutputWidth + x) * kOutputChannels;
      pixels[destination] = bgra[2];
      pixels[destination + 1] = bgra[1];
      pixels[destination + 2] = bgra[0];
    }
  }
  context->Unmap(staging.Get(), 0);

  header.status = static_cast<std::uint32_t>(PacketStatus::kAvailable);
  header.reason = static_cast<std::uint32_t>(UnavailableReason::kNone);
  header.width = kOutputWidth;
  header.height = kOutputHeight;
  header.channels = kOutputChannels;
  header.pixelBytes = static_cast<std::uint32_t>(pixels.size());
  header.lastPresentQpc = frameInfo.LastPresentTime.QuadPart;
  header.accumulatedFrames = frameInfo.AccumulatedFrames;
  return Emit(header, pixels);
}
