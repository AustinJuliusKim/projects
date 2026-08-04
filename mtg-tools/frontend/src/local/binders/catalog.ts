/**
 * Port of `binders/catalog.py`'s read side: the vendored commander-deck
 * catalog, indexed for lookup. The JSON ships inside the worker bundle (the
 * same file the Python package vendors), so the SPA stays fully offline —
 * `refresh` remains a CLI concern and is deliberately not ported.
 */

import catalogJson from '../../../../binders/data/commander_decks.json'

const FILLER = ['commander deck', 'commander', 'deck']

function norm(text: string): string {
  const stripped = (text ?? '').normalize('NFKD').replace(/\p{M}/gu, '')
  return stripped
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}

export function nickname(productName: string, setName = ''): string {
  let text = norm(productName)
  for (const chunk of [norm(setName), ...FILLER]) {
    if (chunk) text = text.replaceAll(chunk, ' ')
  }
  return text.split(/\s+/).filter(Boolean).join(' ')
}

const DISPLAY_SUFFIX = /\s*\[\s*([A-Za-z0-9]{2,6})\s*\]\s*$/

/** Split a trailing `[SET]` off a product name: `("Deck", "M3C")`. */
export function splitDisplay(text: string): [string, string] {
  const match = DISPLAY_SUFFIX.exec(text ?? '')
  if (!match) return [(text ?? '').trim(), '']
  return [text.slice(0, match.index).trim(), match[1].toUpperCase()]
}

export interface Deck {
  uuid: string
  name: string
  setCode: string
  setName: string
  releaseDate: string
  ids: Record<string, string>
  tcgplayerUrl: string
}

export function deckYear(deck: Deck): string {
  return deck.releaseDate.slice(0, 4)
}

export function deckDisplay(deck: Deck): string {
  return `${deck.name} [${deck.setCode}]`
}

export function deckNickname(deck: Deck): string {
  return nickname(deck.name, deck.setName)
}

export function isCollectorsEdition(deck: Deck): boolean {
  return deck.name.toLowerCase().includes('collector')
}

export class Catalog {
  decks: Deck[]
  private byUuidMap = new Map<string, Deck>()
  private byNameMap = new Map<string, Deck[]>()
  private byNicknameMap = new Map<string, Deck[]>()
  private setCodes = new Set<string>()

  constructor(decks: Deck[]) {
    this.decks = decks
    for (const deck of decks) {
      this.byUuidMap.set(deck.uuid, deck)
      this.setCodes.add(deck.setCode.toLowerCase())
      const nameKey = norm(deck.name)
      this.byNameMap.set(nameKey, [...(this.byNameMap.get(nameKey) ?? []), deck])
      const nickKey = deckNickname(deck)
      this.byNicknameMap.set(nickKey, [...(this.byNicknameMap.get(nickKey) ?? []), deck])
    }
  }

  byUuid(uuid: string): Deck | undefined {
    return this.byUuidMap.get(uuid)
  }

  hasSet(code: string): boolean {
    return this.setCodes.has(code.trim().toLowerCase())
  }

  byName(text: string): Deck[] {
    return [...(this.byNameMap.get(norm(text)) ?? [])]
  }

  byNickname(text: string): Deck[] {
    return [...(this.byNicknameMap.get(nickname(text)) ?? [])]
  }

  byNicknameSuffix(text: string): Deck[] {
    const needle = nickname(text)
    if (!needle) return []
    return this.decks.filter((d) => {
      const nick = deckNickname(d)
      return nick === needle || nick.endsWith(` ${needle}`)
    })
  }

  byNicknameContains(text: string): Deck[] {
    const needle = nickname(text)
    if (!needle) return []
    return this.decks.filter((d) => {
      const nick = deckNickname(d)
      return nick === needle || ` ${nick} `.includes(` ${needle} `)
    })
  }
}

interface RawDeck {
  uuid: string
  name: string
  setCode?: string
  setName?: string
  releaseDate?: string
  ids?: Record<string, string>
  tcgplayerUrl?: string
}

export function loadCatalog(): Catalog {
  const blob = catalogJson as { decks: RawDeck[] }
  return new Catalog(
    blob.decks.map((d) => ({
      uuid: d.uuid,
      name: d.name,
      setCode: d.setCode ?? '',
      setName: d.setName ?? '',
      releaseDate: d.releaseDate ?? '',
      ids: d.ids ?? {},
      tcgplayerUrl: d.tcgplayerUrl ?? '',
    })),
  )
}

let cached: Catalog | null = null
export function catalog(): Catalog {
  if (!cached) cached = loadCatalog()
  return cached
}
