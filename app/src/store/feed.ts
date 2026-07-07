import { create } from 'zustand'
import { repo } from '../db'
import { refreshFromSources } from '../lib/ingest'
import type { Card } from '../types'

interface FeedState {
  cards: Card[]
  currentIndex: number
  isLoading: boolean
  exhaustedUntil: number | null
  atEnd: boolean
  /** Contador: al incrementarse, la vista del feed hace scroll al inicio. */
  scrollToken: number
  init: () => Promise<void>
  onPageChange: (index: number) => void
  refresh: (manual?: boolean) => Promise<void>
}

const END_COOLDOWN_MS = 10 * 60 * 1000

export const useFeed = create<FeedState>((set, get) => ({
  cards: [],
  currentIndex: 0,
  isLoading: false,
  exhaustedUntil: null,
  atEnd: false,
  scrollToken: 0,

  async init() {
    const cards = await repo.loadFeed() // orden: más nuevo primero
    set({ cards })
  },

  onPageChange(index) {
    set({ currentIndex: index })
    const { cards, isLoading } = get()
    const remaining = cards.length - 1 - index
    // Al llegar al final del feed, intentar traer lo nuevo y volver al inicio.
    if (remaining <= 0 && !isLoading) void get().refresh(false)
  },

  /**
   * Actualiza el feed: trae contenido nuevo, recarga con lo más reciente arriba
   * y (si hay algo nuevo, o si fue manual) salta al inicio.
   * `manual` = disparado por el botón / pull-to-refresh; ignora el cooldown.
   */
  async refresh(manual = true) {
    const s = get()
    if (s.isLoading) return
    // El cooldown solo frena el disparo automático (llegar al final sin novedades).
    if (!manual && s.exhaustedUntil && Date.now() < s.exhaustedUntil) {
      set({ atEnd: true })
      return
    }

    const before = new Set(s.cards.map((c) => c.contentHash))
    set({ isLoading: true })

    try {
      await refreshFromSources() // RSS → webhook → SQLite
    } catch {
      // Sin red u otro error: seguimos y mostramos lo que ya está en local.
    }

    const all = await repo.loadFeed() // más nuevo primero
    const hasNew = all.some((c) => !before.has(c.contentHash))

    if (hasNew || manual) {
      // Reemplaza la lista, lleva al inicio (lo más nuevo queda arriba).
      set({
        cards: all,
        currentIndex: 0,
        isLoading: false,
        atEnd: !hasNew,
        exhaustedUntil: hasNew ? null : Date.now() + END_COOLDOWN_MS,
        scrollToken: get().scrollToken + 1,
      })
    } else {
      // Nada nuevo tras llegar al final: marca "al día" y enfría reintentos.
      set({
        cards: all,
        isLoading: false,
        atEnd: true,
        exhaustedUntil: Date.now() + END_COOLDOWN_MS,
      })
    }
  },
}))
