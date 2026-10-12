import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { createOfficeApi } from './http';
import { OfficeError } from './state';
import type { OfficeStore } from './state';
import type { OfficeStagingRuntime } from './staging';
import type { MondayRuntime } from './monday-runtime';
import type { OfficeProvenanceOptions } from './provenance';

// Injectable store and clock are for isolated synthetic verification; the
// executable entry below always uses the authenticated internal PostgreSQL DB.
export function createStagingOfficeApp(runtime: OfficeStagingRuntime, store: OfficeStore, options: { staticRoot?: string; clock?: () => number; monday?: MondayRuntime; provenance?: OfficeProvenanceOptions } = {}) {
  const staticRoot = resolve(options.staticRoot ?? resolve(process.cwd(), 'dist-office'));
  try { if (!statSync(resolve(staticRoot, 'index.html')).isFile()) throw new Error(); }
  catch { throw new OfficeError('STAGING_BUILD_REQUIRED', 503); }
  return createOfficeApi(store, { clock: options.clock, staging: runtime.access, staticRoot, monday: options.monday, provenance: options.provenance });
}
