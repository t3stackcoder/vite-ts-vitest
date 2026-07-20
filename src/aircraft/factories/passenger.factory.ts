import { defineFactoryFor, factoryProductType } from '../../factory-core'
import {
  PASSENGER_AIRCRAFT_FACTORY,
  type AircraftFactoryCatalog,
} from '../catalog'

const defineAircraftFactory = defineFactoryFor<AircraftFactoryCatalog>()

export const productType = factoryProductType('airliner')

export default defineAircraftFactory(PASSENGER_AIRCRAFT_FACTORY)({
  metadata: {
    capabilities: ['pressurized-cabin', 'civil-avionics'],
    description: 'Creates a matched passenger aircraft component family.',
    displayName: 'Passenger Aircraft Factory',
    version: '1.0.0',
  },
  productType,
  create(order, options) {
    options?.signal?.throwIfAborted()

    return Object.freeze({
      airframe: Object.freeze({
        material: 'carbon-composite' as const,
        role: 'passenger' as const,
        seatCapacity: order.seats,
      }),
      avionics: Object.freeze({
        autopilot: true as const,
        suite: 'civil-integrated' as const,
      }),
      cabin: Object.freeze({
        emergencyExits: Math.max(4, Math.ceil(order.seats / 50)),
        pressureControlled: true as const,
      }),
      orderId: order.orderId,
      propulsion: Object.freeze({
        engineCount: 2 as const,
        engineType: 'high-bypass-turbofan' as const,
        rangeNauticalMiles: order.rangeNauticalMiles,
      }),
      type: productType,
    })
  },
})
