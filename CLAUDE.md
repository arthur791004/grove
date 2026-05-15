# Grove project guidelines

## Component design

Grove uses **Chakra UI v3** as its component foundation. When introducing any
new piece of UI, follow this order:

1. **Check Chakra UI v3 first.** If Chakra ships the component (`Dialog`,
   `Menu`, `Tooltip`, `Select` / `NativeSelect`, `IconButton`, `CloseButton`,
   `Drawer`, etc.), use it — even if the compound API is verbose. Don't
   reinvent overlays, focus traps, ARIA wiring, or positioning logic that
   Chakra already handles.

2. **If Chakra doesn't have it, build on top of Chakra.** Custom components
   live in their own file (`frontend/src/<Name>.tsx`) and should wrap Chakra
   primitives where possible. Example: `Tooltip.tsx` wraps `ChakraTooltip.*`
   to give callers a one-prop `<Tooltip label="…">child</Tooltip>` shape.

3. **Icons** come from `lucide-react`. Only fall back to a hand-rolled SVG
   when Lucide doesn't have a fitting glyph (e.g. the four-square Warp-style
   `StopIcon`). Custom icons live in `frontend/src/icons.tsx`, accept an
   optional `size` prop, and use `currentColor` for stroke/fill.

4. **Display rules.**
   - **Paths**: never render an absolute path in UI. Use `shortPath()` from
     `frontend/src/paths.ts` so `/Users/<user>/code/grove` shows as
     `~/code/grove`. The absolute path stays in clipboard / IPC payloads.
   - **Tooltips**: prefer the `Tooltip` wrapper over the native `title`
     attribute — native `title` has a long delay before showing and looks
     system-default.

5. **Extensions (in progress).** See the Extensions handoff doc for the full
   plan. Built so far (Slice 1, 1.5, 3):
   - `frontend/src/extensions/registry.ts` — panel catalog. Files, Diff,
     Browser register at module load via `frontend/src/extensions/builtins.tsx`.
     New panels go through `panelRegistry.register({ id, title, icon,
component, source })`. App.tsx renders from `usePanels()`; no panel
     paths are hardcoded in the host anymore.
   - Panel open-state lives in zustand as `activePanelId: string | null` +
     `panelFullscreen: Record<string, boolean>`. Use `openPanel(id)`,
     `closePanel()`, `togglePanel(id)`, `togglePanelFullscreen(id)` — never
     reintroduce panel-flavored booleans.
   - `frontend/src/extensions/actions.ts` — cross-panel action bus.
     `dispatch('open-file', { path, kind })` / `dispatch('open-url', { url })`
     route through registered handlers. Use `useActionHandler(name, fn)` in
     React; `registerActionHandler` outside React. Handlers live where the
     work happens (built-ins register in `builtins.tsx`); a dispatch with no
     handler is a no-op + console warning.

   Locked decisions:
   - **Conflict resolution: first-registered wins.** Enforced in
     `PanelRegistry.register`; the same rule applies to actions and (later)
     commands. Second registration is rejected with a console warning.
   - Built-in panel ids are `files`, `diff`, `browser`. Extensions must
     namespace action names with their id (e.g. `linear.create-issue`);
     built-ins use unprefixed names (`open-file`, `open-url`).

6. **State and polling.**
   - Don't add polling loops without a good reason. The backend already
     pushes per-tab context over a WebSocket; piggyback on it via
     `subscribeAllTabContexts` (in `useTabContext.ts`) when you need a
     different view of the same data.
   - Selector-driven `useEffect` is cheaper than `useStore.subscribe` when
     each subscriber only cares about one slice — `subscribe` fires on
     every store mutation, multiplying work by the number of subscribers.
