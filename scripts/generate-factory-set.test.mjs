import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  generateFactorySet,
  isFactoryModulePath,
  parseFactoryProductType,
} from './generate-factory-set.mjs'

const temporaryRoots = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        force: true,
        recursive: true,
      }),
    ),
  )
})

function factorySource(productType) {
  return [
    "import { factoryProductType } from '../../factory'",
    '',
    `export const productType = factoryProductType('${productType}')`,
    '',
  ].join('\n')
}

async function createWorkspace(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-codegen-'))
  temporaryRoots.push(root)

  for (const [relativePath, contents] of Object.entries(files)) {
    const targetPath = path.join(root, relativePath)
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, contents, 'utf8')
  }

  return root
}

describe('factory vocabulary generator', () => {
  it('generates deterministic keys, product types, and factory definitions', async () => {
    const root = await createWorkspace({
      'src/report/factories/spreadsheet.factory.ts': factorySource('csv'),
      'src/aircraft/factories/passenger.factory.ts': factorySource('airliner'),
      'src/report/factories/print.factory.ts': factorySource('pdf'),
    })

    const first = await generateFactorySet({ repositoryRoot: root })
    const output = await readFile(
      path.join(root, 'src', 'factory-set.generated.ts'),
      'utf8',
    )
    const second = await generateFactorySet({
      check: true,
      repositoryRoot: root,
    })

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(output.indexOf('aircraft: factoryKeySet')).toBeLessThan(
      output.indexOf('report: factoryKeySet'),
    )
    expect(output).toContain(
      "report: factoryKeySet('report', ['print', 'spreadsheet'])",
    )
    expect(output).toContain(
      "report: factoryProductTypeSet(['csv', 'pdf'])",
    )
    expect(output).toContain('key: factorySet.report.print')
    expect(output).toContain('productType: productTypeSet.report.pdf')
  })

  it('deduplicates shared product types and detects stale output', async () => {
    const root = await createWorkspace({
      'src/report/factories/primary.factory.ts': factorySource('pdf'),
      'src/report/factories/secondary.factory.ts': factorySource('pdf'),
    })
    const addedFactoryPath = path.join(
      root,
      'src',
      'report',
      'factories',
      'table.factory.ts',
    )

    await generateFactorySet({ repositoryRoot: root })
    let output = await readFile(
      path.join(root, 'src', 'factory-set.generated.ts'),
      'utf8',
    )
    expect(output).toContain("factoryProductTypeSet(['pdf'])")

    await writeFile(addedFactoryPath, factorySource('csv'), 'utf8')
    await expect(
      generateFactorySet({ check: true, repositoryRoot: root }),
    ).rejects.toThrowError(/is stale/)

    await generateFactorySet({ repositoryRoot: root })
    output = await readFile(
      path.join(root, 'src', 'factory-set.generated.ts'),
      'utf8',
    )
    expect(output).toContain("factoryProductTypeSet(['csv', 'pdf'])")

    await rm(addedFactoryPath)
    const removal = await generateFactorySet({ repositoryRoot: root })
    output = await readFile(
      path.join(root, 'src', 'factory-set.generated.ts'),
      'utf8',
    )
    expect(removal.changed).toBe(true)
    expect(output).not.toContain('factorySet.report.table')
  })

  it('rejects missing, repeated, and malformed product declarations', () => {
    expect(() => parseFactoryProductType('', 'missing.factory.ts')).toThrowError(
      /must export const productType/,
    )
    expect(() =>
      parseFactoryProductType(
        `${factorySource('pdf')}${factorySource('csv')}`,
        'duplicate.factory.ts',
      ),
    ).toThrowError(/must export const productType/)
    expect(() =>
      parseFactoryProductType(
        "export const productType = factoryProductType('Bad Type')",
        'invalid.factory.ts',
      ),
    ).toThrowError(/lowercase kebab-case/)
  })

  it('recognizes only convention-matching factory module paths', () => {
    expect(
      isFactoryModulePath('C:\\repo\\src\\report\\factories\\print.factory.ts'),
    ).toBe(true)
    expect(isFactoryModulePath('/repo/src/report/print.factory.ts')).toBe(false)
    expect(
      isFactoryModulePath('/repo/src/report/factories/print.test.ts'),
    ).toBe(false)
  })

  it('rejects namespace and filename convention violations', async () => {
    const invalidNamespaceRoot = await createWorkspace({
      'src/BadDomain/factories/valid.factory.ts': factorySource('valid'),
    })
    const invalidFilenameRoot = await createWorkspace({
      'src/report/factories/bad_name.factory.ts': factorySource('valid'),
    })

    await expect(
      generateFactorySet({ repositoryRoot: invalidNamespaceRoot }),
    ).rejects.toThrowError(/namespace directory/)
    await expect(
      generateFactorySet({ repositoryRoot: invalidFilenameRoot }),
    ).rejects.toThrowError(/Factory filename/)
  })
})
