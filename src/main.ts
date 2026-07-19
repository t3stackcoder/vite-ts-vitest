import {
  AIRLINER_FACTORY_ALIAS,
  aircraftFactoryRegistry,
  aircraftOrderId,
} from './aircraft'

async function demonstrateDynamicFactoryLoading(): Promise<void> {
  const aircraft = await aircraftFactoryRegistry.create(
    AIRLINER_FACTORY_ALIAS,
    {
      orderId: aircraftOrderId('AO-000001'),
      rangeNauticalMiles: 5_200,
      seats: 180,
    },
    { correlationId: 'vite-demo' },
  )

  console.info('Dynamically created aircraft product family:', aircraft)
}

void demonstrateDynamicFactoryLoading().catch((error: unknown) => {
  console.error('Factory harness demonstration failed:', error)
})
