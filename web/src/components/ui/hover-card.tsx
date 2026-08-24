"use client"

import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card"

import { cn } from "@/lib/utils"

function HoverCard({ ...props }: PreviewCardPrimitive.Root.Props) {
  return <PreviewCardPrimitive.Root data-slot="hover-card" {...props} />
}

/** Focusable on purpose. Base UI already opens the card on focus, but every caller here
 * renders the trigger as a `span` (a timeline row's own label, not a link), and a span is
 * not in the tab order — which left the detail reachable by pointer only. `tabIndex` puts
 * it back; the ring is the same one every other focusable in the app draws. */
function HoverCardTrigger({ className, ...props }: PreviewCardPrimitive.Trigger.Props) {
  return (
    <PreviewCardPrimitive.Trigger
      data-slot="hover-card-trigger"
      tabIndex={0}
      className={cn(
        "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className
      )}
      {...props}
    />
  )
}

function HoverCardContent({
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: PreviewCardPrimitive.Popup.Props &
  Pick<
    PreviewCardPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            "z-50 w-72 origin-(--transform-origin) rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardContent, HoverCardTrigger }
