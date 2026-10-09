// Candidate upstream regression for Chromium 150.0.7871.129, issue #243.
// Append to media/muxers/output_position_tracker_unittest.cc in an isolated
// Chromium/Electron SOURCE build. Not linked into CapturePack or run by npm.
// Expected RED on that revision: the native CHECK terminates at 4 GiB.
// A source build is required; this fixture has NOT been executed here.
#include <cstdint>
#include <vector>

#include "base/containers/span.h"
#include "base/test/bind.h"
#include "base/test/task_environment.h"
#include "media/muxers/output_position_tracker.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace media {

TEST(OutputPositionTrackerIssue243Test, CrossFourGiBWithoutRetainingOutput) {
  base::test::SingleThreadTaskEnvironment task_environment;
  // One reusable MiB, no encoder, disk output, desktop, or 4 GiB allocation.
  std::vector<uint8_t> bytes(1024 * 1024);
  uint64_t delivered = 0;
  OutputPositionTracker tracker(base::BindLambdaForTesting(
      [&delivered](base::span<const uint8_t> data) {
        delivered += data.size();
      }));
  for (int i = 0; i < 4097; ++i) {
    tracker.WriteSpan(base::span<const uint8_t>(bytes));
  }
  EXPECT_EQ(delivered, 4097ull * bytes.size());
  EXPECT_EQ(tracker.GetCurrentPos(), delivered);
}

namespace {
void CheckInstalledDumpOperands(uint64_t prior, size_t incoming) {
  base::test::SingleThreadTaskEnvironment task_environment;
  std::vector<uint8_t> bytes(1024 * 1024);
  uint64_t delivered = 0;
  OutputPositionTracker tracker(base::BindLambdaForTesting(
      [&delivered](base::span<const uint8_t> data) {
        delivered += data.size();
      }));
  while (delivered < prior) {
    const uint64_t remaining = prior - delivered;
    const size_t count = remaining < bytes.size() ? remaining : bytes.size();
    tracker.WriteSpan(base::span<const uint8_t>(bytes).first(count));
  }
  ASSERT_EQ(tracker.GetCurrentPos(), prior);
  tracker.WriteSpan(base::span<const uint8_t>(bytes).first(incoming));
  EXPECT_EQ(tracker.GetCurrentPos(), prior + incoming);
  EXPECT_EQ(delivered, prior + incoming);
}
}  // namespace

TEST(OutputPositionTrackerIssue243Test, InstalledDumpOneOperands) {
  CheckInstalledDumpOperands(4294935597ull, 153170);
}

TEST(OutputPositionTrackerIssue243Test, InstalledDumpTwoOperands) {
  CheckInstalledDumpOperands(4294898286ull, 168199);
}

}  // namespace media
