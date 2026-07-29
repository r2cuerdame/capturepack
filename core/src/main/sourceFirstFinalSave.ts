/**
 * Final-save ordering shared by every slow derived-media path.
 *
 * The returned promise means the authoritative pack sources are durable. The
 * derived job starts on the next event-loop turn and is deliberately not part
 * of that completion signal: rendering may take minutes or fail without ever
 * putting annotations, timeline, docs, or plugin payloads at risk.
 */
export interface SourceFirstFinalSaveJob<T> {
  persistSource: () => Promise<T>
  renderDerived: (source: T) => Promise<void>
  onDerivedFailure: (error: unknown, source: T) => Promise<void> | void
}

export async function startSourceFirstFinalSave<T>(
  job: SourceFirstFinalSaveJob<T>,
): Promise<T> {
  const source = await job.persistSource()
  setImmediate(() => {
    void Promise.resolve()
      .then(() => job.renderDerived(source))
      .catch(async (error: unknown) => {
        try {
          await job.onDerivedFailure(error, source)
        } catch {
          // A failure reporter/fallback is derived work too. Source persistence
          // already succeeded and must never turn into an unhandled rejection.
        }
      })
  })
  return source
}
