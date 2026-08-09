/**
 * Public surface of the Warrden design system.
 *
 * This is the entry the design-system export reads (see `.design-sync/`), and it
 * is deliberately a hand-written list rather than a glob: it declares which parts
 * are shared vocabulary that new screens should be built from, and leaves out the
 * pieces that only make sense inside this particular app (the sidebar/header
 * shell, the settings-only editors, anything bound to a specific route).
 *
 * The app itself imports from the individual modules as usual — nothing here
 * changes how `src/` consumes its own components.
 */

// Primitives (shadcn/ui, base-nova style)
export { Alert, AlertAction, AlertDescription, AlertTitle } from './components/ui/alert';
export * from './components/ui/alert-dialog';
export { Badge, badgeVariants } from './components/ui/badge';
export { Button, buttonVariants } from './components/ui/button';
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './components/ui/card';
export { Collapsible, CollapsibleContent, CollapsibleTrigger } from './components/ui/collapsible';
export * from './components/ui/dialog';
export * from './components/ui/dropdown-menu';
export {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './components/ui/empty';
export { Input } from './components/ui/input';
export { Label } from './components/ui/label';
export { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
export { Progress } from './components/ui/progress';
export { ScrollArea, ScrollBar } from './components/ui/scroll-area';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './components/ui/select';
export { Separator } from './components/ui/separator';
export { Skeleton } from './components/ui/skeleton';
export { Spinner } from './components/ui/spinner';
export { Switch } from './components/ui/switch';
export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow } from './components/ui/table';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
export { Textarea } from './components/ui/textarea';
export { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip';

// Warrden's own shared vocabulary — the parts that carry the product's meaning
// rather than generic interaction.
export { NumberField } from './components/NumberField';
export { PageHeader } from './components/PageHeader';
export { StatTile } from './components/StatTile';
export { AcquireOutcomeBadge, PipelineBadge, StatusBadge } from './components/StatusBadge';
export { StatusNotice } from './components/StatusNotice';
export { TagInput } from './components/TagInput';
export { TierBadge } from './components/TierBadge';
export { StatusDot, ToneBadge } from './components/ToneBadge';
