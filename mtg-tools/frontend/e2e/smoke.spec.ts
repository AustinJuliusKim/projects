import { expect, test } from '@playwright/test'

/**
 * Every screen loads, against a real server, in a real browser.
 *
 * This is the cheapest test here and the one with the clearest pedigree: a
 * single shared SQLite connection once made the server 500 on *every* page
 * while 53 unit tests passed, because a Flask test client runs in the calling
 * thread and never provokes the thread-affinity error. Anything that walks the
 * routes through an actual HTTP server catches it on the first click.
 */

const SCREENS = [
  { path: '/', nav: 'Collection' },
  { path: '/sealed', nav: 'Sealed' },
  { path: '/imports', nav: 'Import' },
  { path: '/sell', nav: 'Sell' },
  { path: '/history', nav: 'History' },
]

test.describe('every screen loads', () => {
  for (const screen of SCREENS) {
    test(`${screen.nav} renders without an error`, async ({ page }) => {
      const failures: string[] = []
      // A 500 on an API call leaves the chrome rendered and the content empty,
      // which reads as "no data yet" rather than as a failure. Watch the
      // network, not just the DOM.
      page.on('response', (response) => {
        if (response.url().includes('/api/') && response.status() >= 500) {
          failures.push(`${response.status()} ${response.url()}`)
        }
      })

      await page.goto(screen.path)
      await expect(page.getByRole('link', { name: screen.nav })).toBeVisible()
      // The shell renders before the session resolves; wait for the app proper.
      await expect(page.getByText('mtg-tools').first()).toBeVisible()
      expect(failures, 'server errors during load').toEqual([])
    })
  }

  test('an unknown client route still gets the app, not a 404 page', async ({ page }) => {
    await page.goto('/no-such-screen')
    await expect(page.getByRole('link', { name: 'Collection' })).toBeVisible()
  })

  test('an unknown API path answers JSON, not the SPA shell', async ({ request }) => {
    // If this fell through to the HTML shell, a client typo would fail on
    // parsing rather than on the actual mistake.
    const response = await request.get('/api/nope')
    expect(response.status()).toBe(404)
    expect(response.headers()['content-type']).toContain('application/json')
    expect(await response.json()).toMatchObject({ code: 'not-found' })
  })
})
