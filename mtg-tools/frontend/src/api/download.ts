/**
 * Download triggering that works on both backends without changing how the
 * buttons look. Against Flask the button stays a plain `<a href download>` —
 * the browser streams the response and the e2e suite's link-role assertions
 * hold. Against the local backend there is no URL to point at, so the button
 * gets an onClick that asks the worker for the bytes and clicks a Blob URL.
 */

import { api } from './client'
import type { DownloadName, DownloadOptions } from './types'

const useLocal = import.meta.env.VITE_BACKEND === 'local'

export async function saveDownload(name: DownloadName, opts?: DownloadOptions): Promise<void> {
  const { filename, blob } = await api.download(name, opts)
  if (name === 'bundle') {
    // The backup nudge keys off this — the bundle is the durable copy.
    localStorage.setItem('mtg-tools-last-bundle-export', new Date().toISOString())
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Give the click a beat to start before the URL dies.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function downloadProps(
  name: DownloadName,
  href: string,
  opts?: DownloadOptions,
): Record<string, unknown> {
  if (!useLocal) return { component: 'a', href, download: true }
  return { onClick: () => void saveDownload(name, opts) }
}
