import { expect, test } from '@playwright/test'

import { card, importAndCommit, manabox } from './helpers'

/**
 * The files the app hands you.
 *
 * `test_api.py` already asserts the CSV contents in detail, so this does not
 * re-check the columns. What it checks is the part only a browser can: that the
 * button is wired to the route, that the response arrives as a *download*
 * rather than rendering as text, and that the buylist reflects verdicts set
 * through the UI a moment earlier.
 */

const CARDS = manabox([
  card('Selling Sphinx', 'SEL', { n: 1, price: '30.00', rarity: 'mythic' }),
  card('Selling Scout', 'SEL', { n: 2, price: '22.00' }),
])

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await importAndCommit(page, 'sell.csv', CARDS)
  await page.close()
})

test.describe('exports', () => {
  test('the sealed template downloads and is re-importable', async ({ page }) => {
    await page.goto('/sealed')

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Download template' }).first().click(),
    ])
    expect(download.suggestedFilename()).toBe('sealed.csv')

    const stream = await download.createReadStream()
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      stream.on('data', (c) => chunks.push(Buffer.from(c)))
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      stream.on('error', reject)
    })

    // The header is the parser's contract; the rows are examples, not data.
    expect(text.split('\r\n')[0]).toBe(
      'Name,Set,Quantity,Condition,Price,Price date,Source,Cost basis,Notes',
    )
    expect(text).toContain('Sneak Attack')
  })

  test('the buylist reflects verdicts set in the UI', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('combobox', { name: 'Set', exact: true }).click()
    await page.getByRole('option', { name: 'SEL', exact: true }).click()
    await expect(page.getByText('2 cards across 2 rows')).toBeVisible()

    // Nothing is marked yet, so the panel should say so rather than offering a
    // download that would produce a lone header row.
    await page.goto('/sell')
    await expect(
      page.getByText(/Nothing to submit yet — mark rows sell/),
    ).toBeVisible()
    // Real <button>s when empty, not styled-inert <a>s that still navigate.
    await expect(page.getByRole('button', { name: 'Card Kingdom CSV' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Detailed CSV' })).toBeDisabled()

    // Mark both sell through the bulk bar. The action Select already defaults
    // to "Set verdict" — see the note in bulk.spec.ts about not touching it.
    await page.goto('/')
    await page.getByRole('combobox', { name: 'Set', exact: true }).click()
    await page.getByRole('option', { name: 'SEL', exact: true }).click()
    await expect(page.getByText('2 cards across 2 rows')).toBeVisible()

    await page.getByRole('table').getByRole('checkbox').first().check()
    await expect(page.getByText('2 selected')).toBeVisible()
    await page.getByLabel('Bulk action value').fill('sell')
    await page.getByRole('button', { name: 'Apply' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Set verdict' }).click()

    await page.goto('/sell')
    // $52.00 market → 60% cash on the $20+ band.
    await expect(page.getByText(/2 stacks · 2 cards/)).toBeVisible()
    await expect(page.getByText(/\$52\.00 at market/)).toBeVisible()
    await expect(page.getByText(/\$31\.20 cash/)).toBeVisible()

    // The CK file: exactly the four columns their importer accepts.
    const [ckDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Card Kingdom CSV' }).click(),
    ])
    expect(ckDownload.suggestedFilename()).toBe('card_kingdom_submission.csv')

    const stream = await ckDownload.createReadStream()
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      stream.on('data', (c) => chunks.push(Buffer.from(c)))
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      stream.on('error', reject)
    })
    expect(text.split('\r\n')[0]).toBe('Card Name,Edition,Foil,Quantity')
    expect(text).toContain('Selling Sphinx')

    // The detailed file keeps every column, for non-CK destinations.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Detailed CSV' }).click(),
    ])
    expect(download.suggestedFilename()).toBe('buylist.csv')
  })
})
