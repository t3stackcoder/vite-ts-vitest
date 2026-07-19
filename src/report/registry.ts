import {
  createFilenameKeyResolver,
  factoryHarnessFor,
  type CatalogFactoryModule,
} from '../factory'
import {
  REPORT_FACTORY_CATALOG,
  REPORT_FACTORY_KEYS_BY_FILE,
  type ReportFactoryCatalog,
} from './catalog'

type ReportFactoryModule = CatalogFactoryModule<ReportFactoryCatalog>

const reportFactoryModules = import.meta.glob<ReportFactoryModule>(
  './factories/*.factory.ts',
)

const createHarness = factoryHarnessFor(REPORT_FACTORY_CATALOG)
const keyFromPath = createFilenameKeyResolver(REPORT_FACTORY_KEYS_BY_FILE)

export function createReportFactoryRegistry() {
  return createHarness({
    keyFromPath,
    modules: reportFactoryModules,
  })
}

export const reportFactoryRegistry = createReportFactoryRegistry()
