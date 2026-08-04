import { expect, type Page } from '@playwright/test'

/**
 * Shared fixtures and actions. Deliberately not a `.spec.ts` — Playwright
 * refuses to let one test file import another, and rightly: the imported file's
 * tests would run twice under two names.
 */

export const MANABOX_HEADER =
  'Title,Edition,Foil,Quantity,Set name,Collector number,Rarity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency,Added'

/**
 * One ManaBox row. The columns are positional; keep them in header order.
 *
 * `edition` is required, and each spec must use its own — the Scryfall and
 * ManaBox IDs are derived from it.
 *
 * That matters more than it looks. `Card.identity` is `(scryfall_id, finish)`,
 * so two specs that both number their rows from 1 are describing *the same
 * cards*: the second import merges into the first and its rows vanish. It
 * presented as "the row I just imported isn't on the page", which is a long way
 * from the cause.
 */
export function card(
  title: string,
  edition: string,
  {
    n = 1,
    price = '10.00',
    setName = 'End To End',
    rarity = 'rare',
    quantity = 1,
    foil = 0,
  }: Partial<{
    n: number
    price: string
    setName: string
    rarity: string
    quantity: number
    foil: number
  }> = {},
) {
  return [
    title, edition, foil, quantity, setName, n, rarity,
    `${edition}${n}`, `${edition.toLowerCase()}-${n}`, price,
    'false', 'false', 'near_mint', 'en', 'USD', '2026-07-28T00:00:00.000Z',
  ].join(',')
}

export function manabox(rows: string[]) {
  return [MANABOX_HEADER, ...rows, ''].join('\r\n')
}

/**
 * Upload a CSV and land on its review screen.
 *
 * Note the app refuses a byte-identical re-upload — importing the same file
 * twice would double every quantity in it — so each caller needs distinct
 * content, not just a distinct filename.
 */
export async function upload(page: Page, name: string, body: string) {
  await page.goto('/imports')
  await page.setInputFiles('input[type=file]', {
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(body, 'utf-8'),
  })
  await expect(page).toHaveURL(/\/imports\/\d+$/)
}

/** Upload, then commit. Returns once the app has navigated onward. */
export async function importAndCommit(page: Page, name: string, body: string) {
  await upload(page, name, body)
  await page.getByRole('button', { name: /Commit \d+ rows/ }).click()
  await expect(page).not.toHaveURL(/\/imports\/\d+$/)
}
