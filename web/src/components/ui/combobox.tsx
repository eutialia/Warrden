import * as React from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"

import { chipBarClass, chipClass, cn } from "@/lib/utils"
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react"

/**
 * Base UI combobox in its "input inside the popup" arrangement: the trigger reads like a
 * `Select`, and the search field only exists while the list is open. Use it where the item
 * count is large enough that scrolling a `Select` stops being an option.
 */
function Combobox<Value, Multiple extends boolean | undefined = false>(
  props: ComboboxPrimitive.Root.Props<Value, Multiple>
) {
  return <ComboboxPrimitive.Root {...props} />
}

function ComboboxTrigger({
  className,
  children,
  ...props
}: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn(
        "flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-left text-sm transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.Icon
        render={
          <ChevronsUpDownIcon className="pointer-events-none size-4 text-muted-foreground" />
        }
      />
    </ComboboxPrimitive.Trigger>
  )
}

/** `Value` renders no element of its own, so the truncation lives on a wrapper here.
 * Function children (chip lists) need the wrapper gone, or they clip. */
function ComboboxValue({
  className,
  children,
  ...props
}: ComboboxPrimitive.Value.Props & { className?: string }) {
  if (typeof children === "function") {
    return <ComboboxPrimitive.Value {...props}>{children}</ComboboxPrimitive.Value>
  }
  return (
    <span data-slot="combobox-value" className={cn("min-w-0 flex-1 truncate", className)}>
      <ComboboxPrimitive.Value {...props}>{children}</ComboboxPrimitive.Value>
    </span>
  )
}

function ComboboxChips({ className, ...props }: ComboboxPrimitive.Chips.Props) {
  return (
    <ComboboxPrimitive.Chips
      data-slot="combobox-chips"
      className={cn(
        chipBarClass,
        className
      )}
      {...props}
    />
  )
}

function ComboboxChip({ className, ...props }: ComboboxPrimitive.Chip.Props) {
  return (
    <ComboboxPrimitive.Chip
      data-slot="combobox-chip"
      className={cn(
        chipClass,
        className
      )}
      {...props}
    />
  )
}

function ComboboxChipRemove({ className, ...props }: ComboboxPrimitive.ChipRemove.Props) {
  return (
    <ComboboxPrimitive.ChipRemove
      data-slot="combobox-chip-remove"
      className={cn("rounded-sm p-0.5 hover:bg-muted [&_svg]:size-3", className)}
      {...props}
    />
  )
}

/**
 * Portal, positioner and popup in one. The search input, list and any footer are the
 * caller's children so they can be ordered and labelled per call site.
 */
function ComboboxContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "relative isolate z-50 flex max-h-(--available-height) w-(--anchor-width) min-w-56 origin-(--transform-origin) flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function ComboboxInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-input"
      className={cn(
        "h-9 w-full shrink-0 border-b border-border bg-transparent px-2.5 text-base outline-none placeholder:text-muted-foreground md:text-sm",
        className
      )}
      {...props}
    />
  )
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn("min-h-0 flex-1 scroll-py-1 overflow-y-auto overscroll-contain p-1", className)}
      {...props}
    />
  )
}

function ComboboxItem({
  className,
  children,
  description,
  ...props
}: ComboboxPrimitive.Item.Props & {
  /** Secondary muted line under the label, for rows that need more than a name. */
  description?: React.ReactNode
}) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex w-full cursor-default items-start gap-1.5 rounded-md py-1.5 pr-8 pl-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{children}</span>
        {description !== undefined && (
          <span className="truncate text-xs text-muted-foreground">{description}</span>
        )}
      </span>
      <ComboboxPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute top-2 right-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  )
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn("px-2.5 py-6 text-center text-sm text-muted-foreground empty:p-0", className)}
      {...props}
    />
  )
}

/** Non-interactive note pinned under the list, for things like a truncated result count. */
function ComboboxFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="combobox-footer"
      className={cn(
        "shrink-0 border-t border-border px-2.5 py-1.5 text-xs text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Combobox,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxFooter,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
}
