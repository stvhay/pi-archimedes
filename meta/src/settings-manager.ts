/**
 * Settings manager TUI component.
 * Center-screen overlay with 2 modes: List and Prompt (free-input field edit).
 *
 * The list is pi-tui's own `SettingsList` — the component behind pi's
 * `/settings` — wrapped in the shared overlay chrome from
 * `@pi-archimedes/core/overlay` (`wrapWithBorder`, `renderHeader`,
 * `renderFooter`) so `/archimedes` and `/plugins` look like every other
 * archimedes panel while the rows, their alignment and the change hint come from
 * pi. The description area is the one block this panel draws itself, because pi
 * sizes it from the selected row alone (see `descriptionSlot`). The theme wiring
 * below is pi's `getSettingsListTheme()` (`pi-coding-agent`
 * `dist/modes/interactive/theme/theme.js:896`) re-anchored on the `Theme`
 * instance pi hands the overlay factory: accent for the selected label and the
 * cursor, accent/muted for the value, dim for description and hint. Every
 * coloured string asks `theme.fg` for its token — nothing here composes a
 * colour escape (the pi 1.x alignment rule: ask the theme for the token you
 * need, in the slot you need it). The only `\x1b` literals in this file are
 * bracketed-paste framing: `\x1b[200~`/`\x1b[201~` to seed the free-input field
 * and to refuse a paste into a number field.
 *
 * Three pieces stay ours because pi's component does not offer them:
 *
 * - **Search.** `SettingsList`'s `enableSearch` shows a fuzzy filter box
 *   permanently, which would (a) swallow the `s` keystroke the panel needs for
 *   save, and (b) remove the `/`-arm / esc-clear the overlay has always had. So
 *   the row is ours — pi-tui's `Input` drawing it, our substring filter feeding
 *   the list — and `enableSearch` is left off.
 * - **← / → stepping.** `SettingsList` cycles a value on Enter/Space only and
 *   exposes no way to read which row it has selected, so the cursor index is
 *   mirrored here (`move()` drives the list with `selectItem`) and the arrows
 *   step against it. The mirror is addressed by `item.id`, so the caller's ids
 *   have to be unique: with two rows sharing one, `selectItem` finds the first
 *   and the drawn cursor and the mirrored index part company. Everything else
 *   about a row is keyed by id as well (the label map, the description map,
 *   `prompts`, the write guard), so uniqueness is a precondition of the panel
 *   rather than of the mirror. The wrapper forwards every keystroke it does not
 *   consume itself and
 *   exposes no `handleMouse`, so nothing can move the list's own index behind
 *   the mirror's back — but `SettingsList` does implement `handleMouse`, and
 *   that silence is the wrapper's, not the component's.
 *   Enter/Space are forwarded untouched, which is what makes the free-input row
 *   work: an editable item carries a `submenu`, and pi's component opens
 *   whatever component that returns.
 * - **The description area.** `SettingsList` draws the description of the row it
 *   has selected, so the height of what it renders — and of the border this
 *   panel puts around it — moved every time the cursor landed on a row whose
 *   description wrapped further than the last one. The rows are handed over with
 *   no `description` (that block is the only thing the component reads the field
 *   for) and the area is drawn here instead, padded to the tallest description in
 *   the filtered set — `descriptionSlot`.
 *
 * The rows are copied out of `opts.items` once, at construction: the panel does
 * not notice rows added to or removed from the caller's array while it is open,
 * and `onChange` — not the array — is how a new value reaches the caller.
 * Neither call site touches its array after opening.
 *
 * What the swap changes on purpose, against the hand-rolled list it replaces:
 *
 * - Enter and Space now reach `SettingsList`, so they cycle a row's value and
 *   open a prompt row's field. They did nothing before.
 * - `ctrl+c` sits on `tui.select.cancel`, so it closes the panel from the list
 *   and drops an open field back to the list. It was swallowed before.
 * - The free-input field is pi-tui's `Input`, so the caret is live (←/→,
 *   ctrl+a/e, ctrl+b/f) and word-kill, yank, paste and undo work with it. What
 *   the field did before still does: a seeded value is appended to, Backspace
 *   removes one grapheme, esc discards, digits-only in a number field, and no
 *   paste into a number field.
 * - Selection movement goes through `tui.select.up` / `down`, so a binding in
 *   `keybindings.json` reaches this panel — it never did before — while value
 *   stepping stays on the arrow keys themselves.
 * - Ten rows are on screen instead of twenty, with pi's own `(n/total)` counter
 *   under them whenever some are off-screen, and pi's own hint line above the
 *   panel's key row.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  SettingsList,
  decodeKittyPrintable,
  getKeybindings,
  matchesKey,
  type Component,
  type SettingItem,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";
import {
  padEnd,
  renderHeader,
  renderFooter,
  wrapWithBorder,
  borderContentWidth,
  visibleWidth,
  wrapText,
} from "@pi-archimedes/core/overlay";

// ── Public types ────────────────────────────────────────────────────────────

export interface PromptDescriptor {
  kind: "text" | "number";
  label: string;
  min?: number;
  allowDecimal?: boolean;
}

export interface SettingsManagerOptions {
  items: SettingItem[];
  /** Free-input fields keyed by item.id — Enter on these opens prompt mode. */
  prompts: Record<string, PromptDescriptor>;
  theme: Theme;
  onChange: (id: string, newValue: string) => void;
  onSave: () => void;
  onClose: () => void;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Visible rows. pi's root `/settings` list shows ten (`settings-selector.js:628`). */
const MAX_VISIBLE = 10;

const TITLE = " Settings ";
/**
 * The keys pi's own hint line under the list does not mention. It says
 * "Enter/Space to change · Esc to cancel", so those are not repeated here.
 */
const LIST_KEYS = " [↑↓] move  [←→] value  [/] search  [s] save ";
const PROMPT_KEYS = " [enter] confirm  [esc] cancel ";
/** Affordance for a row that takes typed text rather than cycling values. */
const EDITABLE_HINT = "Enter to type a value";
/** Shown when the search filters everything out (the wording the panel has always used). */
const NO_MATCHES = "No matching settings";
/**
 * The description block is drawn two columns in, and wrapped `DESCRIPTION_INSET`
 * columns narrower than the content area — both exactly what `SettingsList` did
 * with it (`pi-tui@1.2.0 dist/components/settings-list.js:107-109`), so the text
 * still lands where it used to.
 */
const DESCRIPTION_INDENT = 2;
const DESCRIPTION_INSET = 4;
/**
 * The blank line plus the hint line `SettingsList` appends to a non-empty list
 * (`settings-list.js:113` → `addHintLine`, `:245-250`). The description area is
 * inserted above that pair, which is where the area has always sat.
 */
const HINT_BLOCK_LINES = 2;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * ASCII printable — the list SEARCH input, as it has always been: a wide
 * search query is not reachable from the keyboard (the free-input field is, and
 * pi-tui's `Input` accepts the whole range there).
 */
function isAsciiPrintable(data: string): boolean {
  return data.length === 1 && data >= " " && data <= "~";
}

/**
 * Single non-control code point — a keystroke that would *insert* text, so a
 * number field can reject it. Accented/Cyrillic/CJK count; DEL and C1 do not.
 */
function isInsertChar(data: string): boolean {
  if (data.length !== 1) return false;
  const cp = data.codePointAt(0);
  if (cp === undefined || cp < 0x20 || cp === 0x7f) return false;
  if (cp >= 0x80 && cp <= 0x9f) return false;
  return true;
}

// ── Component ───────────────────────────────────────────────────────────────

export function createSettingsManager(opts: SettingsManagerOptions): {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
} {
  const theme = opts.theme;
  const kb = getKeybindings();

  // pi's getSettingsListTheme(), token for token.
  const listTheme: SettingsListTheme = {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text),
  };

  /**
   * Label column, in drawn cells. `SettingsList` sizes it from the rows it is
   * handed (`min(36, widest label)`) and this panel hands it a filtered subset,
   * so labels are padded to the width the whole set implies — otherwise the
   * value column slides left every time the search narrows.
   */
  const labelColumn = Math.max(
    1,
    Math.min(
      36,
      opts.items.reduce((max, item) => Math.max(max, visibleWidth(item.label)), 0),
    ),
  );

  /** The caller's own label per row, so the search matches what the item is called. */
  const labels = new Map<string, string>();

  /**
   * The text the description area shows, per row id — the caller's description,
   * with the editable affordance composed in. It lives here and NOT on the row
   * because `SettingsList` draws the description of the selected row and nothing
   * else, which makes its output (and this panel's border) as tall as whichever
   * row the cursor happens to be on: see `descriptionSlot`. Keyed by id exactly
   * like `labels`, so nothing about how per-row state is tracked changes shape.
   */
  const descriptions = new Map<string, string>();

  /**
   * Rows as the list sees them: one per caller item, kept here so a write
   * survives a filter rebuild and the caller's own item objects are never
   * touched. No row carries a `description`; editable rows gain the submenu that
   * opens the field.
   */
  const rows: SettingItem[] = opts.items.map((item) => {
    const descriptor = opts.prompts[item.id];
    labels.set(item.id, item.label);
    const row: SettingItem = {
      id: item.id,
      label: padEnd(item.label, labelColumn),
      currentValue: item.currentValue,
    };
    // Falsy descriptions are not stored: that is the case `SettingsList` drew
    // nothing for, and the area must not start reserving a line over it.
    if (item.description) descriptions.set(item.id, item.description);
    if (item.values !== undefined) row.values = item.values;
    if (!descriptor) return row;
    const base = descriptions.get(item.id);
    descriptions.set(item.id, base ? `${base} · ${EDITABLE_HINT}` : EDITABLE_HINT);
    row.submenu = (currentValue, done) => openField(descriptor, currentValue, done);
    return row;
  });

  const searchInput = new Input({ prompt: "Search: " });
  // This overlay is the focused component whenever it is drawn, so the field it
  // shows owns the hardware cursor marker.
  searchInput.focused = true;

  let list = buildList("");
  let searchArmed = false;
  /** Index into the rows the list is showing; kept in step with `list`. */
  let cursor = 0;
  /** True while a free-input field is open (the list's submenu). */
  let promptOpen = false;

  function visibleRows(query: string): SettingItem[] {
    if (!query) return rows;
    const q = query.toLowerCase();
    // Matched on the caller's own label, never on the padded copy.
    return rows.filter((row) => (labels.get(row.id) ?? row.label).toLowerCase().includes(q));
  }

  function buildList(query: string): SettingsList {
    return new SettingsList(
      visibleRows(query),
      MAX_VISIBLE,
      listTheme,
      // `SettingsList` has already written `currentValue` on the row object.
      (id, newValue) => writeValue(id, newValue),
      () => opts.onClose(),
      { enableSearch: false },
    );
  }

  /** The one write path: never report a change for an item the caller dropped. */
  function writeValue(id: string, newValue: string): void {
    if (!opts.items.some((item) => item.id === id)) return;
    opts.onChange(id, newValue);
  }

  function shownRows(): SettingItem[] {
    return visibleRows(searchInput.getValue());
  }

  // ── Prompt mode (a `SettingsList` submenu) ────────────────────────────────

  function openField(
    descriptor: PromptDescriptor,
    seed: string,
    done: (selectedValue?: string) => void,
  ): Component {
    const field = new Input({ prompt: "" });
    field.focused = true;
    // Seed through pi-tui's own paste path: `setValue` parks the caret at 0 (so
    // the first Backspace would eat nothing and the first character land in
    // front of the value), and pasting cannot split a grapheme.
    field.handleInput(`\x1b[200~${seed}\x1b[201~`);
    let error: string | null = null;
    promptOpen = true;

    const close = (selectedValue?: string): void => {
      promptOpen = false;
      done(selectedValue);
    };

    const commit = (): void => {
      const typed = field.getValue();
      if (descriptor.kind === "number") {
        const n = descriptor.allowDecimal ? Number(typed) : parseInt(typed, 10);
        if (!typed.trim() || !Number.isFinite(n) || n < (descriptor.min ?? 0)) {
          error = `must be >= ${descriptor.min ?? 0}`;
          return; // stay in the field, exactly as before
        }
        close(String(n));
        return;
      }
      close(typed);
    };

    return {
      render(width: number): string[] {
        const lines: string[] = [];
        lines.push(theme.fg("dim", `  ${descriptor.label}`));
        const inner = Math.max(1, width - 2);
        lines.push(padEnd(`  ${field.render(inner)[0] ?? ""}`, width));
        lines.push(padEnd("", width));
        if (error) lines.push(theme.fg("error", `  ${error}`));
        return lines;
      },

      handleInput(data: string): void {
        if (kb.matches(data, "tui.input.submit") || data === "\n") {
          commit();
          return;
        }
        if (kb.matches(data, "tui.select.cancel")) {
          // Discard the typed value: nothing is written, the row keeps its own.
          close();
          return;
        }
        if (descriptor.kind === "number") {
          // Digits only, as the field has always been: a keystroke that would
          // insert something else is swallowed before it reaches the field.
          const kitty = decodeKittyPrintable(data);
          const printable = kitty ?? data;
          const decimalPoint = descriptor.allowDecimal && printable === "." && !field.getValue().includes(".");
          if (!decimalPoint && (kitty !== undefined ? !/^\d$/.test(kitty) : isInsertChar(data) && !/\d/.test(data))) return;
          // …and no paste.
          if (data.includes("\x1b[200~")) return;
        }
        field.handleInput(data);
        error = null;
      },

      invalidate(): void {
        field.invalidate();
      },
    };
  }

  // ── List-mode input ───────────────────────────────────────────────────────

  function refilter(): void {
    cursor = 0;
    list = buildList(searchInput.getValue());
  }

  function move(delta: number): void {
    const items = shownRows();
    if (items.length === 0) return;
    cursor = (cursor + delta + items.length) % items.length;
    const target = items[cursor];
    // The list owns the visible window, so the mirror is pushed into it.
    if (target) list.selectItem(target.id);
  }

  function stepValue(direction: 1 | -1): void {
    const item = shownRows()[cursor];
    if (!item || !item.values || item.values.length <= 1) return;
    const values = item.values;
    const currentIdx = Math.max(0, values.indexOf(item.currentValue));
    const nextIndex = (currentIdx + direction + values.length) % values.length;
    const next = values[nextIndex];
    if (next === undefined) return;
    item.currentValue = next;
    writeValue(item.id, next);
  }

  function handleListInput(data: string): void {
    if (kb.matches(data, "tui.select.cancel") && searchArmed) {
      // esc clears an armed search before it means "close".
      searchInput.setValue("");
      searchArmed = false;
      refilter();
      return;
    }
    if (kb.matches(data, "tui.select.up")) {
      move(-1);
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      move(1);
      return;
    }
    // Value stepping is the arrow keys and only the arrow keys. The editor
    // actions `tui.editor.cursorLeft` / `cursorRight` also carry ctrl+b and
    // ctrl+f, and a keystroke typed out of editor habit must not change a
    // setting — in `/plugins` that write reaches the disk immediately. The
    // footer advertises `[←→] value` and `SettingsList` has no left/right of its
    // own to inherit, so the arrows are the whole contract; matching them by
    // name keeps a Kitty CSI-u terminal's arrows working.
    if (matchesKey(data, Key.left)) {
      stepValue(-1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      stepValue(1);
      return;
    }
    // `matchesKey`, not `data === "/"`: a terminal with the Kitty keyboard
    // protocol enabled sends printable keys as CSI-u (`/` arrives as `\x1b[47u`).
    if (matchesKey(data, "/")) {
      // Re-pressing while active is a no-op, not a character.
      searchArmed = true;
      return;
    }
    if (searchArmed) {
      if (kb.matches(data, "tui.editor.deleteCharBackward")) {
        const before = searchInput.getValue();
        searchInput.handleInput(data);
        // Only a query that actually changed is worth rebuilding for: a backspace
        // against the empty query must leave the cursor where it is (rebuilding
        // resets it to the first row). Every other edit path changes the query,
        // so the reset-on-narrowing still happens.
        if (searchInput.getValue() !== before) refilter();
        return;
      }
      // Decoded first, so the query is typeable on a CSI-u terminal too (a bare
      // comparison saw `\x1b[115u` as nothing at all, so nothing could be typed).
      const typed = decodeKittyPrintable(data) ?? data;
      if (isAsciiPrintable(typed)) {
        searchInput.handleInput(typed);
        refilter();
        return;
      }
    }
    if (matchesKey(data, "s") && !searchArmed) {
      opts.onSave();
      return;
    }
    // Enter / Space belong to pi's component: cycle the value, or open the
    // field an editable row carries. esc arrives here too, as onCancel.
    list.handleInput(data);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  /**
   * Lines the description area occupies at this width: the tallest description
   * among every row the current filter is showing, wrapped the way the area
   * wraps.
   *
   * Over the whole filtered set, deliberately — never the visible scroll window.
   * Sized by the window, the frame would start growing again the moment the
   * window scrolled past a longer description than anything in it.
   */
  function descriptionAreaHeight(contentWidth: number): number {
    const wrapAt = contentWidth - DESCRIPTION_INSET;
    let height = 0;
    for (const row of shownRows()) {
      const text = descriptions.get(row.id);
      if (!text) continue;
      height = Math.max(height, wrapText(text, wrapAt).length);
    }
    return height;
  }

  /**
   * The description area, drawn here rather than by `SettingsList`.
   *
   * pi's component draws the description of the row it has selected and no
   * other's, wrapped to `width - 4` (`pi-tui@1.2.0
   * dist/components/settings-list.js:103-111`), so its output grew by a row every
   * time the cursor landed on a row whose description wrapped further than the
   * last one's — and because this panel frames `list.render()` in a border, the
   * whole list shifted up. The rows it is handed carry no `description` at all
   * (that block is the only thing the component reads the field for), and this
   * takes its place: the selected row's text, wrapped and indented exactly as pi
   * did it, then padded with blank lines to the tallest description in the set.
   * Moving the cursor can no longer change the frame height, and no description
   * is ever cut short to achieve that.
   *
   * Height changes that are NOT cursor-driven are left as they are, on purpose:
   * arming the `/` search adds the search row, and opening a free-input field
   * replaces the list with the field. Both are a different panel the user asked
   * for, not the same panel moving under the cursor — do not "fix" those too.
   */
  function descriptionSlot(contentWidth: number): string[] {
    const height = descriptionAreaHeight(contentWidth);
    // Nothing in the set has a description: the area contributes nothing, not
    // even a reserved blank row.
    if (height === 0) return [];
    const text = descriptions.get(shownRows()[cursor]?.id ?? "");
    const wrapped = text ? wrapText(text, contentWidth - DESCRIPTION_INSET) : [];
    const indent = " ".repeat(DESCRIPTION_INDENT);
    // The gap above the block is the one `SettingsList` used to put there.
    const lines: string[] = [padEnd("", contentWidth)];
    for (let line = 0; line < height; line++) {
      const drawn = wrapped[line] ?? "";
      // Colour through the list theme's `description` token, so the colour
      // decision stays in one place (`listTheme`).
      lines.push(drawn ? listTheme.description(`${indent}${drawn}`) : padEnd("", contentWidth));
    }
    return lines;
  }

  /**
   * The list, or the empty-filter message. The filter is ours, so an empty
   * result is ours to report — handed an empty item set `SettingsList` would
   * say "No settings available", which is about a panel with no settings at all.
   */
  function listBody(contentWidth: number): string[] {
    if (searchInput.getValue() && shownRows().length === 0) {
      return [theme.fg("dim", `  ${NO_MATCHES}`)];
    }
    const body = list.render(contentWidth);
    // While a field is open the list renders the field in place of the rows, and
    // the description area is part of the list, not of the field.
    if (promptOpen) return body;
    const slot = descriptionSlot(contentWidth);
    if (slot.length === 0) return body;
    // Spliced in where pi used to draw the block: above the blank line and the
    // hint line `addHintLine` appends. A body that does not end that way (the
    // zero-row message stops before the hint) gets the slot after it.
    const hintStart = body.length - HINT_BLOCK_LINES;
    const aboveHint = hintStart >= 0 && body[hintStart] === "";
    const at = aboveHint ? hintStart : body.length;
    return [...body.slice(0, at), ...slot, ...body.slice(at)];
  }

  function render(width: number): string[] {
    const contentWidth = borderContentWidth(width);
    const lines: string[] = [renderHeader(TITLE, contentWidth, theme), padEnd("", contentWidth)];

    if (searchArmed && !promptOpen) {
      lines.push(padEnd(searchInput.render(contentWidth)[0] ?? "", contentWidth));
    }
    lines.push(padEnd("", contentWidth));

    lines.push(...listBody(contentWidth));

    // The list ends on its own hint line; the field needs a gap before the keys.
    if (promptOpen) lines.push(padEnd("", contentWidth));
    lines.push(renderFooter(promptOpen ? PROMPT_KEYS : LIST_KEYS, contentWidth, theme));

    return wrapWithBorder(lines, width, theme);
  }

  return {
    render,
    handleInput(data: string): void {
      // While a field is open the list forwards every keystroke to it.
      if (promptOpen) {
        list.handleInput(data);
      } else {
        handleListInput(data);
      }
    },

    invalidate(): void {
      list.invalidate();
      searchInput.invalidate();
    },

    dispose(): void {
      // No timers or subscriptions to clean up.
    },
  };
}
