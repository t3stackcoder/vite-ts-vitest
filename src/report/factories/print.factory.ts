import {
  defineFactoryFor,
  factoryProductType,
} from '../../factory-core'
import {
  PRINT_REPORT_FACTORY,
  type ReportFactoryCatalog,
} from '../catalog'

const defineReportFactory = defineFactoryFor<ReportFactoryCatalog>()

export const productType = factoryProductType('pdf')

export default defineReportFactory(PRINT_REPORT_FACTORY)({
  metadata: {
    description: 'Renders a sectioned report as a paginated document.',
    displayName: 'Print Report Factory',
    version: '1.0.0',
  },
  productType,
  create(request, options) {
    options?.signal?.throwIfAborted()

    return Object.freeze({
      format: productType,
      pageCount: Math.max(1, request.sections.length),
      title: request.title,
    })
  },
})
