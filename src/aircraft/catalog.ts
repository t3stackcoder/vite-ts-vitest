import { z } from 'zod'
import {
  defineFactoryCatalog,
  factoryAliasSet,
  factoryCatalogEntry,
  factoryContract,
  factoryKeySet,
  type Brand,
  type FactoryAliasMap,
} from '../factory'

// The aircraft vocabulary, declared exactly once. Every other mention is a
// compiler-checked property access — an undeclared name cannot compile.
const aircraft = factoryKeySet('aircraft', ['passenger', 'freight'])
const aircraftAlias = factoryAliasSet('aircraft', ['airliner'])

export const PASSENGER_AIRCRAFT_FACTORY = aircraft.passenger
export const FREIGHT_AIRCRAFT_FACTORY = aircraft.freight
export const AIRLINER_FACTORY_ALIAS = aircraftAlias.airliner

export type AircraftOrderId = Brand<string, 'AircraftOrderId'>

const aircraftOrderIdPattern = /^AO-[0-9]{6}$/

export const AIRCRAFT_ORDER_ID_SCHEMA = z.custom<AircraftOrderId>(
  (value) =>
    typeof value === 'string' && aircraftOrderIdPattern.test(value),
  { error: 'Aircraft order id must use the form "AO-000000".' },
)

export function aircraftOrderId(value: string): AircraftOrderId {
  return AIRCRAFT_ORDER_ID_SCHEMA.parse(value)
}

export const PASSENGER_BUILD_ORDER_SCHEMA = z
  .strictObject({
    orderId: AIRCRAFT_ORDER_ID_SCHEMA,
    rangeNauticalMiles: z.number().finite().positive(),
    seats: z.number().int().positive(),
  })
  .readonly()

export const FREIGHT_BUILD_ORDER_SCHEMA = z
  .strictObject({
    orderId: AIRCRAFT_ORDER_ID_SCHEMA,
    payloadKilograms: z.number().finite().positive(),
    rangeNauticalMiles: z.number().finite().positive(),
  })
  .readonly()

export const PASSENGER_AIRCRAFT_FAMILY_SCHEMA = z
  .strictObject({
    airframe: z
      .strictObject({
        material: z.literal('carbon-composite'),
        role: z.literal('passenger'),
        seatCapacity: z.number().int().positive(),
      })
      .readonly(),
    avionics: z
      .strictObject({
        autopilot: z.literal(true),
        suite: z.literal('civil-integrated'),
      })
      .readonly(),
    cabin: z
      .strictObject({
        emergencyExits: z.number().int().positive(),
        pressureControlled: z.literal(true),
      })
      .readonly(),
    kind: z.literal('passenger-aircraft-family'),
    orderId: AIRCRAFT_ORDER_ID_SCHEMA,
    propulsion: z
      .strictObject({
        engineCount: z.literal(2),
        engineType: z.literal('high-bypass-turbofan'),
        rangeNauticalMiles: z.number().finite().positive(),
      })
      .readonly(),
  })
  .readonly()

export const FREIGHT_AIRCRAFT_FAMILY_SCHEMA = z
  .strictObject({
    airframe: z
      .strictObject({
        material: z.literal('aluminum-lithium'),
        role: z.literal('freight'),
      })
      .readonly(),
    avionics: z
      .strictObject({
        autopilot: z.literal(true),
        suite: z.literal('cargo-integrated'),
      })
      .readonly(),
    cargoDeck: z
      .strictObject({
        loadingSystem: z.literal('powered-roller'),
        payloadKilograms: z.number().finite().positive(),
      })
      .readonly(),
    kind: z.literal('freight-aircraft-family'),
    orderId: AIRCRAFT_ORDER_ID_SCHEMA,
    propulsion: z
      .strictObject({
        engineCount: z.literal(4),
        engineType: z.literal('high-thrust-turbofan'),
        rangeNauticalMiles: z.number().finite().positive(),
      })
      .readonly(),
  })
  .readonly()

export type PassengerBuildOrder = z.output<
  typeof PASSENGER_BUILD_ORDER_SCHEMA
>
export type FreightBuildOrder = z.output<typeof FREIGHT_BUILD_ORDER_SCHEMA>
export type PassengerAircraftFamily = z.output<
  typeof PASSENGER_AIRCRAFT_FAMILY_SCHEMA
>
export type FreightAircraftFamily = z.output<
  typeof FREIGHT_AIRCRAFT_FAMILY_SCHEMA
>

export const AIRCRAFT_FACTORY_CATALOG = defineFactoryCatalog({
  ...factoryCatalogEntry(
    PASSENGER_AIRCRAFT_FACTORY,
    factoryContract(
      PASSENGER_BUILD_ORDER_SCHEMA,
      PASSENGER_AIRCRAFT_FAMILY_SCHEMA,
    ),
  ),
  ...factoryCatalogEntry(
    FREIGHT_AIRCRAFT_FACTORY,
    factoryContract(
      FREIGHT_BUILD_ORDER_SCHEMA,
      FREIGHT_AIRCRAFT_FAMILY_SCHEMA,
    ),
  ),
})

export type AircraftFactoryCatalog = typeof AIRCRAFT_FACTORY_CATALOG

export const AIRCRAFT_FACTORY_ALIASES = {
  [AIRLINER_FACTORY_ALIAS]: PASSENGER_AIRCRAFT_FACTORY,
} as const satisfies FactoryAliasMap<AircraftFactoryCatalog>

export const AIRCRAFT_FACTORY_KEYS_BY_FILE = {
  freight: FREIGHT_AIRCRAFT_FACTORY,
  passenger: PASSENGER_AIRCRAFT_FACTORY,
} as const
