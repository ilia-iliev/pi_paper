import { CURSOR_MARKER, fuzzyFilter, getKeybindings, Input, isKeyRelease, SelectList, visibleWidth, type SelectItem } from "@earendil-works/pi-tui";

export type SelectionCommand = "/model" | "/thinking";

export interface SelectionOptions {
  items: SelectItem[];
  current?: string;
}

export function matchingItems(items: SelectItem[], query: string): SelectItem[] {
  if (!query.trim()) return items;
  const normalized = query.trim().toLowerCase();
  const exact = items.filter((item) => item.value.toLowerCase() === normalized);
  if (exact.length) return exact;
  const exactLabel = items.filter((item) => item.label.toLowerCase() === normalized);
  if (exactLabel.length) return exactLabel;
  return fuzzyFilter(items, query, (item) => `${item.value} ${item.label} ${item.description ?? ""}`);
}

export function renderInputLine(input: Input, width: number): { text: string; cursor: number } {
  const line = input.render(width)[0];
  const marker = line.indexOf(CURSOR_MARKER);
  return { text: line.replace(CURSOR_MARKER, ""), cursor: visibleWidth(line.slice(0, marker)) };
}

const accent = (text: string) => `\x1b[36m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

export class SelectionPicker {
  readonly input = new Input({ prompt: "", placeholder: "Type to filter…", placeholderStyle: dim });
  private list!: SelectList;
  private maxVisible = 10;

  constructor(
    private readonly options: SelectionOptions,
    query: string,
    private readonly onSelect: (value: string) => void,
    private readonly onCancel: () => void,
  ) {
    this.input.focused = true;
    this.input.setValue(query);
    this.buildList(query ? undefined : options.current);
  }

  private buildList(selected?: string): void {
    const items = matchingItems(this.options.items, this.input.getValue()).map((item) => ({
      ...item,
      label: `${item.value === this.options.current ? "✓ " : "  "}${item.label}`,
    }));
    this.list = new SelectList(items, this.maxVisible, {
      selectedPrefix: accent,
      selectedText: accent,
      description: dim,
      scrollInfo: dim,
      noMatch: () => dim("  No matching choices"),
    }, { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 40 });
    const index = items.findIndex((item) => item.value === selected);
    if (index >= 0) this.list.setSelectedIndex(index);
    this.list.onSelect = (item) => this.onSelect(item.value);
    this.list.onCancel = this.onCancel;
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    const kb = getKeybindings();
    if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const).some((key) => kb.matches(data, key))) {
      this.list.handleInput(data);
      return;
    }
    const previous = this.input.getValue();
    this.input.handleInput(data);
    const query = this.input.getValue();
    if (query !== previous) this.buildList(query ? undefined : this.options.current);
  }

  render(width: number, height: number): string[] {
    // Leave room for SelectList's scroll indicator, even in a short terminal.
    const maxVisible = Math.max(1, Math.min(10, height - 1));
    if (maxVisible !== this.maxVisible) {
      const selected = this.list.getSelectedItem()?.value;
      this.maxVisible = maxVisible;
      this.buildList(selected);
    }
    if (!this.options.items.length) return [dim("  No choices available")];
    return this.list.render(width).slice(0, height);
  }
}
