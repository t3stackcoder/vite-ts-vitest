import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  reportFactoryDefinitionSet,
  reportFactorySet,
  reportType,
  type CsvReport,
  type PdfReport,
  type Report,
} from './catalog'
import {
  createReportFactoryRegistry,
  getReportFactoryRegistry,
} from './registry'

describe('non-aircraft report proof domain', () => {
  it('preserves generated factory-to-product relationships', () => {
    expect(reportFactoryDefinitionSet.print).toEqual({
      key: reportFactorySet.print,
      productType: reportType.pdf,
    })
    expect(reportFactoryDefinitionSet.spreadsheet).toEqual({
      key: reportFactorySet.spreadsheet,
      productType: reportType.csv,
    })
  })

  it('memoizes the shared registry behind a lazy accessor', () => {
    expect(getReportFactoryRegistry()).toBe(getReportFactoryRegistry())
  })

  it('infers each report factory input and output independently', async () => {
    const registry = createReportFactoryRegistry()
    const pdf = await registry.create(reportFactorySet.print, {
      sections: ['Summary', 'Details'],
      title: 'Quarterly report',
    })
    const csv = await registry.create(reportFactorySet.spreadsheet, {
      columns: ['name', 'amount'],
      rows: [['North', '42']],
    })

    expect(pdf).toEqual({
      format: reportType.pdf,
      pageCount: 2,
      title: 'Quarterly report',
    })
    expect(csv).toEqual({
      columnCount: 2,
      format: reportType.csv,
      rowCount: 1,
    })
    expectTypeOf(pdf).toEqualTypeOf<PdfReport>()
    expectTypeOf(csv).toEqualTypeOf<CsvReport>()
  })

  it('narrows on a domain-selected discriminator named format', () => {
    const describeReport = (report: Report): string => {
      if (report.format === reportType.pdf) {
        expectTypeOf(report).toEqualTypeOf<PdfReport>()
        // @ts-expect-error - CSV dimensions do not exist on PDF reports
        void report.columnCount
        return `${report.title}: ${report.pageCount} pages`
      }

      expectTypeOf(report).toEqualTypeOf<CsvReport>()
      // @ts-expect-error - PDF pagination does not exist on CSV reports
      void report.pageCount
      return `${report.rowCount} rows x ${report.columnCount} columns`
    }

    expect(
      describeReport({
        format: reportType.pdf,
        pageCount: 2,
        title: 'Proof',
      }),
    ).toBe('Proof: 2 pages')
  })

  it('rejects fields from another factory input branch', async () => {
    const registry = createReportFactoryRegistry()

    await expect(
      registry.create(reportFactorySet.print, {
        sections: ['Summary'],
        title: 'Strict report',
        // @ts-expect-error - spreadsheet rows are not print-report input
        rows: [['unexpected']],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FACTORY_CONTEXT' })
  })
})
