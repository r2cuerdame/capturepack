// Entry point for scripts/provider-host-check.mjs — the ONE place the harness
// reaches into src/, so what it exercises is literally the shipping code.
export { ProviderHost } from '../src/main/context/providerHost'
export { SessionClock } from '../src/main/context/clock'
export { parseProviderManifest } from '../src/shared/context/manifest'
