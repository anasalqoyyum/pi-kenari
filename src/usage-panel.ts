import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export type UsageReport =
  | { ok: true; render: (now: number, width: number) => string }
  | { ok: false; text: string };

type PanelOptions = {
  range: string;
  theme: Pick<Theme, "fg" | "bold">;
  load: (signal: AbortSignal) => Promise<UsageReport[]>;
  requestRender: () => void;
  height: () => number;
  done: () => void;
};

export class UsagePanel implements Component {
  private state: { kind: "loading" } | { kind: "ready"; reports: UsageReport[]; updatedAt: number } = { kind: "loading" };
  private scroll = 0;
  private maxScroll = 0;
  private pageSize = 1;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: PanelOptions) {
    this.timer = setInterval(() => options.requestRender(), 1_000);
    this.timer.unref();
    void this.load();
  }

  private async load(): Promise<void> {
    const reports = await this.options.load(this.controller.signal);
    if (this.controller.signal.aborted) return;
    this.state = { kind: "ready", reports, updatedAt: Date.now() };
    this.options.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
      this.dispose();
      this.options.done();
      return;
    }
    if (data === "r" && this.state.kind !== "loading") {
      this.state = { kind: "loading" };
      this.scroll = 0;
      void this.load();
    } else if (matchesKey(data, "down")) this.scroll += 1;
    else if (matchesKey(data, "up")) this.scroll -= 1;
    else if (matchesKey(data, "pageDown")) this.scroll += this.pageSize;
    else if (matchesKey(data, "pageUp")) this.scroll -= this.pageSize;
    else if (matchesKey(data, "home")) this.scroll = 0;
    else if (matchesKey(data, "end")) this.scroll = this.maxScroll;
    this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll));
    this.options.requestRender();
  }

  render(width: number): string[] {
    const { theme } = this.options;
    const innerWidth = Math.max(1, width - 2);
    const now = Date.now();
    const body: string[] = [];
    if (this.state.kind === "loading") body.push(theme.fg("muted", "Loading usage and quota..."));
    else {
      for (const report of this.state.reports) {
        const text = report.ok ? report.render(now, innerWidth) : report.text;
        for (const line of stripTerminalSequences(text).split("\n")) {
          const color = !report.ok || line.startsWith("🔴") ? "error"
            : line.startsWith("🟡") ? "warning"
            : line.startsWith("🟢") ? "success"
            : line.startsWith("Kenari ") ? "accent" : "text";
          body.push(...wrapTextWithAnsi(theme.fg(color, line), innerWidth));
        }
        body.push("");
      }
    }
    this.pageSize = Math.max(1, this.options.height() - 6);
    this.maxScroll = Math.max(0, body.length - this.pageSize);
    this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll));
    const lastLine = Math.min(body.length, this.scroll + this.pageSize);
    const status = this.state.kind === "loading" ? "Fetching from Kenari"
      : `Updated ${new Date(this.state.updatedAt).toLocaleTimeString()}  |  ${this.scroll + 1}-${lastLine} of ${body.length}`;
    const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
    return [
      border,
      ` ${theme.fg("accent", theme.bold(`Kenari usage  [${this.options.range}]`))}`,
      ` ${theme.fg("dim", status)}`,
      "",
      ...body.slice(this.scroll, lastLine).map((line) => ` ${line}`),
      ` ${theme.fg("muted", "Esc close  |  r refresh  |  ↑↓ scroll  |  PgUp/PgDn")}`,
      border,
    ].map((line) => truncateToWidth(line, Math.max(0, width)));
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
    this.controller.abort();
  }
}
