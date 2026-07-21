import { factoryDomainFor, type CatalogFactoryModule } from '../factory-core'
import { REPORT_FACTORY_CATALOG, type ReportFactoryCatalog } from './catalog'

type ReportFactoryModule = CatalogFactoryModule<ReportFactoryCatalog>

// Vite requires this literal glob at the composition root so it can transform it.
// The <ReportFactoryModule> type argument is an unchecked assertion — Vite
// cannot verify it — but factory-core's module boundary schema re-validates
// every loaded module at runtime, so a module that lies about this type is
// rejected at load rather than trusted.
const reportFactoryModules = import.meta.glob<ReportFactoryModule>(
  './factories/*.factory.ts',
)

const domain = factoryDomainFor(REPORT_FACTORY_CATALOG)

export function createReportFactoryRegistry() {
  return domain.createRegistry(reportFactoryModules)
}

/**
 * Lazily memoized shared registry. Nothing is constructed at import time, so
 * importing the barrel for a type or a request schema stays side-effect-free,
 * and a composition failure (empty glob, unmapped stem) surfaces at the
 * first call instead of during module evaluation.
 */
export const getReportFactoryRegistry = domain.lazyRegistry(
  reportFactoryModules,
)
