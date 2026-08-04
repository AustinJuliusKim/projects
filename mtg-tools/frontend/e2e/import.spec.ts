import { expect, test } from '@playwright/test'

import { card, manabox, upload } from './helpers'

/**
 * Upload → review → commit, for both kinds of file.
 *
 * The sealed half of this is the reason the suite exists. Sealed rows imported
 * correctly and landed in the database; the review screen then navigated to the
 * singles collection regardless of kind, so you were sent to a screen where —
 * correctly — nothing had changed. Every unit test passed. It was only wrong
 * from the chair.
 */

const MANABOX = manabox([
  card('Aetherhub Rat', 'IMP', { n: 1, price: '12.50', quantity: 2 }),
  card('Playwright Pilgrim', 'IMP', { n: 2, price: '44.00', rarity: 'mythic' }),
  card('Headless Herald', 'IMP', { n: 3, price: '0.40', rarity: 'common', quantity: 3, foil: 1 }),
])

/** Two-column sealed list — the minimum the importer accepts. */
const SEALED = ['Name,Quantity', 'Sneak Attack,2', ''].join('\r\n')


test.describe('importing', () => {
  test('a ManaBox export commits and lands on the collection', async ({ page }) => {
    await upload(page, 'singles.csv', MANABOX)

    // The review screen's own summary line, which names the kind and dialect.
    // A bare getByText('singles') also matches the nav and the toast.
    await expect(
      page.getByText(/\d+ rows · singles · ManaBox/),
    ).toBeVisible()
    await expect(page.getByText(/your collection is unchanged so far/)).toBeVisible()

    await page.getByRole('button', { name: /Commit \d+ rows/ }).click()

    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText('Playwright Pilgrim')).toBeVisible()
  })

  test('a sealed list lands on Sealed, not on the collection', async ({ page }) => {
    // The regression this suite was written for. Asserting the URL alone would
    // pass on a redirect to a broken screen, so assert the row is on it too.
    await upload(page, 'decks.csv', SEALED)
    await expect(page.getByText(/\d+ rows · sealed · sealed\.csv/)).toBeVisible()

    await page.getByRole('button', { name: /Commit \d+ rows/ }).click()

    await expect(page).toHaveURL(/\/sealed$/)
    // The nickname resolves to the full product name on the way in.
    await expect(
      page.getByText('Zendikar Rising Commander Deck Sneak Attack'),
    ).toBeVisible()
  })

  test('a file that is neither is refused with a reason', async ({ page }) => {
    await page.goto('/imports')
    await page.setInputFiles('input[type=file]', {
      name: 'nonsense.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Foo,Bar\r\n1,2\r\n', 'utf-8'),
    })

    await expect(page.getByText(/Couldn't tell what this file is/)).toBeVisible()
    // And it stayed put rather than half-navigating somewhere.
    await expect(page).toHaveURL(/\/imports$/)
  })

  test('re-uploading the same bytes is refused, not silently doubled', async ({ page }) => {
    // Found by tripping it: the discard test below originally re-sent MANABOX
    // verbatim and was rejected. The guard is right and the test was wrong, so
    // the guard gets a test of its own — importing a file twice would double
    // every quantity in it, which is a quiet, expensive kind of wrong.
    await page.goto('/imports')
    await page.setInputFiles('input[type=file]', {
      name: 'again.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(MANABOX, 'utf-8'),
    })

    await expect(page.getByText(/This exact file was already imported/)).toBeVisible()
    await expect(page.getByText(/would double those quantities/)).toBeVisible()
    await expect(page).toHaveURL(/\/imports$/)
  })

  test('discarding leaves the collection untouched', async ({ page }) => {
    await page.goto('/')
    const hero = page.getByText(/\d+ cards across \d+ rows/)
    const before = await hero.textContent()

    // Distinct content, or the duplicate guard above refuses it before the
    // discard path is ever reached.
    await upload(
      page,
      'discarded.csv',
      MANABOX.replace('Aetherhub Rat', 'Discarded Drake'),
    )
    await page.getByRole('button', { name: 'Discard' }).click()

    await expect(page).toHaveURL(/\/imports$/)
    await expect(page.getByText('discarded').first()).toBeVisible()

    await page.goto('/')
    await expect(hero).toHaveText(before ?? '')
    await expect(page.getByText('Discarded Drake')).toHaveCount(0)
  })
})
