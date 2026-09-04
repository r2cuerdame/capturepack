// The update-ready announcement policy (#147), alone in a module on purpose.
//
// updater.ts imports electron and electron-updater, so anything living there is
// unreachable from a check without a stub. This rule decides when a user is told
// that an update is waiting, which is exactly the kind of rule that has to be
// held by the gate rather than read and trusted, so it is kept where a check can
// import it with no stub at all.

/**
 * How long a downloaded update may sit unannounced before it is announced again.
 */
export const UPDATE_RENOTICE_MS = 24 * 60 * 60 * 1000

/**
 * Whether the update-ready notice should be shown right now (#147).
 *
 * ONE ANNOUNCEMENT IS NOT ENOUGH FOR AN APP THAT RUNS FOR WEEKS, AND EVERY
 * CHECK IS TOO MANY.
 *
 * The notice used to fire once per version per process run. That is correct for
 * the moment an update arrives and useless for everything after it: this
 * machine ran one process for twenty hours with 0.4.5 downloaded and waiting,
 * reported "downloaded" six times to the log, showed exactly one toast at the
 * moment the user was away from the desk, and was then killed rather than quit
 * — so autoInstallOnAppQuit never fired and the release sat on disk unused.
 *
 * Re-announcing on every check would be the routine update noise #103 removed,
 * which a locked screen reduces to an app name and a red badge that reads as a
 * failed capture. This is deliberately not that. It fires ONLY while an update
 * is genuinely downloaded and waiting to be installed, and at most once a day —
 * not on a schedule, and never to say "you are up to date".
 *
 * Pure so the policy can be held by a check: the caller owns the clock and the
 * remembered announcement, and this decides nothing else.
 */
export function shouldAnnounceUpdate(input: {
  /** Version waiting to be installed, or null when none is. */
  readyVersion: string | null
  /** Version of the last announcement made, or null when none has been. */
  announcedVersion: string | null
  /** When that announcement was made, in ms on the same clock as nowMs. */
  announcedAtMs: number
  nowMs: number
  renoticeMs?: number
}): boolean {
  const { readyVersion, announcedVersion, announcedAtMs, nowMs } = input
  const renoticeMs = input.renoticeMs ?? UPDATE_RENOTICE_MS
  // Nothing is waiting, so there is nothing to say.
  if (readyVersion === null) return false
  // A version nobody has been told about is announced immediately, whatever the
  // clock says — including a NEWER update arriving while an older one waits.
  if (readyVersion !== announcedVersion) return true
  // The same version, already announced: only once the day has passed. A clock
  // that went backwards (a manual change, a resume) must not be read as a day
  // having elapsed, so the elapsed span is taken as at least zero.
  return Math.max(0, nowMs - announcedAtMs) >= renoticeMs
}
