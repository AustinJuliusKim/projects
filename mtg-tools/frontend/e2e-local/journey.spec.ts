import { expect, test } from '@playwright/test'

import { card, importAndCommit, manabox } from '../e2e/helpers'

/**
 * The whole app against real browser storage: first run, a full import
 * through the UI, OPFS persistence across a reload, undo from the header,
 * and a Blob-path download. One test, one context — OPFS is per-context, so
 * this is one continuous session like a real user's.
 */
test('the app runs end to end against OPFS', async ({ page }) => {
  await page.goto('/')
  await expect(
    page.getByText('Your collection lives in this browser now'),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Start empty' }).click()

  await importAndCommit(
    page,
    'opfs.csv',
    manabox([
      card('Storage Sphinx', 'OPF', { n: 1, price: '30.00', rarity: 'mythic' }),
      card('Storage Scout', 'OPF', { n: 2, price: '22.00', quantity: 2 }),
    ]),
  )
  await page.goto('/')
  await expect(page.getByText('3 cards across 2 rows')).toBeVisible()
  await expect(page.getByText('$74.00')).toBeVisible()

  // The OPFS promise: a full reload finds the data, not a blank database.
  await page.reload()
  await expect(page.getByText('3 cards across 2 rows')).toBeVisible()

  // A Blob-path download — no server route behind this button.
  await page.goto('/sealed')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download template' }).first().click(),
  ])
  expect(download.suggestedFilename()).toBe('sealed.csv')

  // Undo from the header reverses the whole import.
  await page.goto('/')
  await page.getByRole('button', { name: /Undo/ }).click()
  await expect(page.getByText('3 cards across 2 rows')).not.toBeVisible()
})
