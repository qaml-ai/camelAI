"use client"

import { Search } from "lucide-react"
import emojiData from "emojibase-data/en/compact.json"
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"

import { Input } from "@/components/ui/input"
import { isEmoji } from "@/lib/avatar"
import { cn } from "@/lib/utils"

type EmojibaseEmoji = {
  emoji?: string
  unicode?: string
  label?: string
  hexcode?: string
  tags?: string[]
  group?: number
  order?: number
}

type EmojiPickerItem = {
  emoji: string
  label: string
  tags: string[]
  group: number
  order: number
  key: string
}

const COMPONENT_GROUP_ID = 2
const MAX_SEARCH_RESULTS = 160
const POPULAR_EMOJI = [
  "💬",
  "😀",
  "😎",
  "🤔",
  "🥳",
  "🔥",
  "✨",
  "⭐",
  "⚡",
  "🎯",
  "🚀",
  "💡",
  "🧠",
  "📊",
  "📈",
  "✅",
  "📝",
  "🐛",
  "🔧",
  "📅",
  "🎉",
  "❤️",
  "💜",
  "🌊",
  "🌿",
  "🐼",
  "🦊",
  "🎨",
  "🎵",
  "☕",
  "🍕",
  "🌙",
].filter(isEmoji)

function toPickerItem(entry: EmojibaseEmoji): EmojiPickerItem | null {
  const emoji = (entry.emoji ?? entry.unicode)?.trim()
  if (!emoji || !isEmoji(emoji)) return null
  if (typeof entry.group !== "number" || entry.group === COMPONENT_GROUP_ID) {
    return null
  }
  const label = entry.label?.trim() || emoji
  const order = typeof entry.order === "number" ? entry.order : 0
  return {
    emoji,
    label,
    tags: entry.tags ?? [],
    group: entry.group,
    order,
    key: entry.hexcode || `${entry.group}:${order}:${emoji}`,
  }
}

const ALL_EMOJI = (emojiData as EmojibaseEmoji[])
  .map((entry) => toPickerItem(entry))
  .filter((item): item is EmojiPickerItem => item !== null)
  .sort((a, b) => a.group - b.group || a.order - b.order || a.label.localeCompare(b.label))

const ALL_EMOJI_BY_VALUE = new Map(
  ALL_EMOJI.map((item) => [item.emoji, item] as const),
)

const POPULAR_ITEMS = POPULAR_EMOJI.map((emoji, index) => {
  const item = ALL_EMOJI_BY_VALUE.get(emoji)
  return item ?? {
    emoji,
    label: emoji,
    tags: [],
    group: 0,
    order: index,
    key: emoji,
  }
})

function matchesQuery(item: EmojiPickerItem, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return (
    item.emoji.includes(normalized) ||
    item.label.toLocaleLowerCase().includes(normalized) ||
    item.tags.some((tag) => tag.toLocaleLowerCase().includes(normalized))
  )
}

export interface EmojiPickerProps {
  value?: string
  search: string
  onSearchChange: (search: string) => void
  onSelect: (emoji: string) => void
  className?: string
}

export function EmojiPicker({
  value,
  search,
  onSearchChange,
  onSelect,
  className,
}: EmojiPickerProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showFade, setShowFade] = useState(false)
  const items = useMemo(() => {
    if (!search.trim()) return POPULAR_ITEMS
    return ALL_EMOJI
      .filter((item) => matchesQuery(item, search))
      .slice(0, MAX_SEARCH_RESULTS)
  }, [search])
  const updateFade = useCallback(() => {
    const element = scrollRef.current
    if (!element) {
      setShowFade(false)
      return
    }
    setShowFade(element.scrollHeight - element.scrollTop - element.clientHeight > 4)
  }, [])

  useLayoutEffect(() => {
    updateFade()
  }, [items, updateFade])

  return (
    <div className={cn("space-y-2", className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search all emoji"
          aria-label="Search emoji"
          className="pl-8"
        />
      </div>
      <div className="relative rounded-md border bg-popover">
        <div
          ref={scrollRef}
          onScroll={updateFade}
          className="max-h-[13.5rem] overflow-y-auto p-2"
        >
          {items.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground">No emoji found.</div>
          ) : (
            <div className="grid grid-cols-8 gap-1">
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={cn(
                    "grid size-8 place-items-center rounded-md text-lg leading-none hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    value === item.emoji && "bg-accent ring-2 ring-ring",
                  )}
                  onClick={() => onSelect(item.emoji)}
                  aria-label={`Select ${item.label}`}
                  title={item.label}
                >
                  {item.emoji}
                </button>
              ))}
            </div>
          )}
        </div>
        {showFade ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-md bg-gradient-to-t from-popover to-transparent"
          />
        ) : null}
      </div>
    </div>
  )
}
