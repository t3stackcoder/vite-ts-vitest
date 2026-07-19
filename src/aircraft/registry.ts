import {
  createFilenameKeyResolver,
  factoryHarnessFor,
  type CatalogFactoryModule,
} from '../factory'
import {
  AIRCRAFT_FACTORY_ALIASES,
  AIRCRAFT_FACTORY_CATALOG,
  AIRCRAFT_FACTORY_KEYS_BY_FILE,
  type AircraftFactoryCatalog,
} from './catalog'

type AircraftFactoryModule = CatalogFactoryModule<AircraftFactoryCatalog>

// Vite requires this literal glob at the composition root so it can transform it.
const aircraftFactoryModules = import.meta.glob<AircraftFactoryModule>(
  './factories/*.factory.ts',
)

const createHarness = factoryHarnessFor(AIRCRAFT_FACTORY_CATALOG)
const keyFromPath = createFilenameKeyResolver(AIRCRAFT_FACTORY_KEYS_BY_FILE)

export function createAircraftFactoryRegistry() {
  return createHarness({
    aliases: AIRCRAFT_FACTORY_ALIASES,
    keyFromPath,
    modules: aircraftFactoryModules,
  })
}

export const aircraftFactoryRegistry = createAircraftFactoryRegistry()
