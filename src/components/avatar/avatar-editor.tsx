"use client"

import { Plus } from "lucide-react"
import {
  Suspense,
  lazy,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"

import { ColorPicker } from "@/components/ui/color-picker"
import { Input } from "@/components/ui/input"
import { AVATAR_COLORS, isEmoji, normalizeAvatarColor } from "@/lib/avatar"
import { cn } from "@/lib/utils"

const LazyEmojiPicker = lazy(() =>
  import("@/components/ui/emoji-picker.client").then((module) => ({
    default: module.EmojiPicker,
  })),
)

export function AvatarEditor({
  shape,
  allowInitials,
  color,
  content,
  onColorChange,
  onContentChange,
  error,
}: {
  shape: "circle" | "rounded"
  allowInitials: boolean
  color: string
  content: string
  onColorChange: (color: string) => void
  onContentChange: (content: string) => void
  error?: string | null
}) {
  const initialsInputId = useId()
  const normalizedColor = normalizeAvatarColor(color) ?? AVATAR_COLORS[0]
  const isPresetColor = AVATAR_COLORS.includes(normalizedColor)
  const [customOpen, setCustomOpen] = useState(!isPresetColor)
  const previousColorRef = useRef(normalizedColor)
  const [emojiSearch, setEmojiSearch] = useState("")
  const selectedEmoji = isEmoji(content) ? content : ""
  const showCustomPicker = customOpen || !isPresetColor

  useEffect(() => {
    if (previousColorRef.current === normalizedColor) return
    previousColorRef.current = normalizedColor
    setCustomOpen(!AVATAR_COLORS.includes(normalizedColor))
  }, [normalizedColor])

  return (
    <div className="space-y-6" data-avatar-shape={shape}>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Color</p>
        <div className="flex flex-wrap gap-2">
          {AVATAR_COLORS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => {
                setCustomOpen(false)
                onColorChange(preset)
              }}
              className={cn(
                "size-7 rounded-full border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                !showCustomPicker &&
                  normalizedColor === preset &&
                  "ring-2 ring-foreground ring-offset-2 ring-offset-background"
              )}
              style={{ backgroundColor: preset }}
              aria-label={`Select color ${preset}`}
            />
          ))}
          <button
            type="button"
            onClick={() => setCustomOpen(true)}
            className={cn(
              "relative grid size-7 place-items-center overflow-hidden rounded-full shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              showCustomPicker &&
                "ring-2 ring-foreground ring-offset-2 ring-offset-background"
            )}
            aria-label="Custom color"
          >
            <span
              aria-hidden
              className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.85),transparent_45%),conic-gradient(from_90deg,#ef4444,#f59e0b,#10b981,#3b82f6,#8b5cf6,#ec4899,#ef4444)]"
            />
            <span className="relative grid size-4 place-items-center rounded-full bg-background text-foreground shadow">
              <Plus className="size-3" />
            </span>
          </button>
        </div>
        {showCustomPicker ? (
          <ColorPicker value={normalizedColor} onChange={onColorChange} />
        ) : null}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Emoji</p>
        <Suspense
          fallback={
            <div
              aria-hidden
              className="h-40 rounded-md border bg-muted/30"
            />
          }
        >
          <LazyEmojiPicker
            value={selectedEmoji}
            search={emojiSearch}
            onSearchChange={setEmojiSearch}
            onSelect={onContentChange}
          />
        </Suspense>
      </div>

      {allowInitials ? (
        <div className="space-y-2">
          <label
            className="text-xs font-medium text-muted-foreground"
            htmlFor={initialsInputId}
          >
            Or enter custom initials
          </label>
          <Input
            id={initialsInputId}
            value={content}
            onChange={(event) => onContentChange(event.target.value)}
            placeholder="JS"
            maxLength={isEmoji(content) ? undefined : 2}
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      ) : error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  )
}
