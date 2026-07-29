/**
 * One replay request crosses two independently scheduled processes:
 *
 *  1. renderer asks MediaRecorder to flush its final dataavailable event;
 *  2. renderer assembles the retained bytes and transfers them over IPC.
 *
 * Main must never abandon the request while the renderer is still inside its
 * legal stop window. Doing that pays the destructive stop/restart cost but
 * throws away the answer. Keep the deadlines in one importable contract so a
 * future renderer increase cannot silently recreate that race.
 */
export const RECORDER_STOP_TIMEOUT_MS = 8_000
export const REPLAY_ASSEMBLY_IPC_SLACK_MS = 4_000
export const REPLAY_TIMEOUT_MS =
  RECORDER_STOP_TIMEOUT_MS + REPLAY_ASSEMBLY_IPC_SLACK_MS
