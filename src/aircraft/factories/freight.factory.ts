import { factoryProductType } from '../../factory-core'
import { FREIGHT_AIRCRAFT_FACTORY, defineAircraftFactory } from '../catalog'

export const productType = factoryProductType('freighter')

export default defineAircraftFactory(FREIGHT_AIRCRAFT_FACTORY)({
  metadata: {
    capabilities: ['powered-cargo-deck', 'heavy-lift'],
    description: 'Creates a matched heavy-freight aircraft component family.',
    displayName: 'Freight Aircraft Factory',
    version: '1.0.0',
  },
  productType,
  create(order, options) {
    options?.signal?.throwIfAborted()

    return Object.freeze({
      airframe: Object.freeze({
        material: 'aluminum-lithium' as const,
        role: 'freight' as const,
      }),
      avionics: Object.freeze({
        autopilot: true as const,
        suite: 'cargo-integrated' as const,
      }),
      cargoDeck: Object.freeze({
        loadingSystem: 'powered-roller' as const,
        payloadKilograms: order.payloadKilograms,
      }),
      orderId: order.orderId,
      propulsion: Object.freeze({
        engineCount: 4 as const,
        engineType: 'high-thrust-turbofan' as const,
        rangeNauticalMiles: order.rangeNauticalMiles,
      }),
      type: productType,
    })
  },
})
