import { expect, test } from '@playwright/test'
import { card, importAndCommit, manabox } from './helpers'

/**
 * Select → escalate → apply → undo, through the real bulk bar.
 *
 * `useSelection` is unit-tested and the server-side resolution is covered in
 * `test_api.py`. What neither can see is the wiring between them: that the
 * escalation link really escalates, that the confirm dialog reports the count
 * the *server* resolved rather than the one the page happened to show, and that
 * Undo in the header reverses what the bar just did. Those seams are where a UI
 * bug turns into a data bug.
 *
 * Two things this fixture has to get right, both found by getting them wrong:
 *
 * - **Filters are driven through their inputs, not the query string.**
 *   Collection holds filter state in React, so `/?price_min=20` filters
 *   nothing and a URL-driven test would "pass" against an unfiltered table.
 *   The Set dropdown is used rather than the Name box because Name is
 *   debounced 250ms, and a filter change clears the selection — so a late
 *   debounce would wipe a selection made just before it landed.
 * - **Escalation needs a full page with more behind it** — `canEscalate` is
 *   `pageFull && totalMatching > pageRows.length`. With three rows the link
 *   never renders, because escalating would be a no-op. So the fixture is 60
 *   matching rows against a page size of 50: the exact shape the distinction
 *   exists for.
 */

const CARDS = manabox([
  // 60 matching rows — more than one page of 50.
  ...Array.from({ length: 60 }, (_, i) =>
    card(`Escalation Test ${String(i + 1).padStart(3, '0')}`, 'ESC', {
      n: i + 1,
      price: '25.00',
    }),
  ),
  // One that must never be touched: it fails the price filter.
  card('Escalation Bystander', 'ESC', { n: 999, price: '1.00' }),
])

/**
 * Narrow to the 60 $20+ rows this spec owns, leaving other specs' data out.
 *
 * The wait at the end is load-bearing. The name input is debounced, and
 * Collection clears the selection whenever the filter identity changes — which
 * is right: a selection made under one filter must not survive into another.
 * Selecting before the debounce lands means a late filter change wipes the
 * selection and the bulk bar disappears mid-test.
 *
 * Waiting on a *row* wouldn't help, because these rows are present unfiltered
 * too. The hero count is the signal that only the settled filter produces.
 */
async function filterToTheSixty(page: import('@playwright/test').Page) {
  await page.goto('/')
  await setFilter(page, 'Set', 'ESC')
  await page.getByLabel('Price ≥').fill('20')
  await expect(page.getByText('60 cards across 60 rows')).toBeVisible()
}

/** Pick a value in one of the filter dropdowns. */
async function setFilter(
  page: import('@playwright/test').Page,
  label: string,
  option: string,
) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await importAndCommit(page, 'escalation.csv', CARDS)
  await page.close()
})

test.describe('bulk editing', () => {
  test('escalating past the page honours the filter, and undo reverses it', async ({
    page,
  }) => {
    await filterToTheSixty(page)
    await expect(page.getByText('Escalation Bystander')).toHaveCount(0)

    // Select the page (50), then escalate to everything matching (60). The two
    // are kept visibly distinct precisely because they differ.
    // Scoped to the table: the first checkbox on the *page* is the Foil
    // filter, and checking that silently changes the query instead of
    // selecting anything.
    await page.getByRole('table').getByRole('checkbox').first().check()
    await expect(page.getByText('50 selected')).toBeVisible()

    await page.getByText('select all 60 matching this filter').click()
    await expect(page.getByText('All 60 matching rows selected')).toBeVisible()

    // By role, and exact: Mantine renders a visible combobox plus a hidden
    // input carrying the value, and the label substring-matches "Bulk action
    // value" as well.
    // The action Select is deliberately *not* touched. BulkBar initialises to
    // `useState('verdict')`, so "Set verdict" is already chosen on mount — and
    // Mantine toggles an option off when you pick the one already selected, so
    // every attempt to "choose" it here cleared it instead. Cost an hour;
    // worth the four lines.
    await expect(
      page.getByRole('combobox', { name: 'Bulk action', exact: true }),
    ).toHaveValue('Set verdict')
    await page.getByLabel('Bulk action value').fill('sell')

    await page.getByRole('button', { name: 'Apply' }).click()

    // 60, not 50: the dialog reports what the server resolved from the filter,
    // which is the whole reason selections aren't a client-side id list.
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('60 row(s)')
    // The confirm button is labelled with the action itself, not "Confirm" —
    // so the dialog says what it will do rather than asking a generic question.
    await dialog.getByRole('button', { name: 'Set verdict' }).click()

    // Everything matching changed — including the ten never rendered.
    await page.goto('/')
    await setFilter(page, 'Set', 'ESC')
    await setFilter(page, 'Verdict', 'sell')
    await expect(page.getByText('60 cards across 60 rows')).toBeVisible()
    // …and the row outside the filter did not.
    await expect(page.getByText('Escalation Bystander')).toHaveCount(0)

    await page.getByRole('button', { name: /Undo/ }).click()
    await expect(page.getByText(/Undone/)).toBeVisible()

    await page.goto('/')
    await setFilter(page, 'Set', 'ESC')
    await setFilter(page, 'Verdict', 'sell')
    await expect(page.getByText('Escalation Test 001')).toHaveCount(0)
  })
})
