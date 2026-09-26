// src/cli/utils/format.ts — presentation helpers for the yggdrasil CLI.
//
// Why a single module: color, glyph and box-drawing decisions must stay
// coherent across commands, and every writer here shares one concern —
// turning installer state into terminal output. It MUST never import @/env
// (see install.ts): the CLI runs before APP_SECRET exists.

const ANSI = /\x1b\[[0-9;]*m/g;

const S = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m" };
const FG = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
};

/**
 * Color and the live spinner require a TTY. When output is redirected
 * (`curl | bash` logging, systemd journal capture, CI, `yggdrasil install > f`)
 * we emit plain lines so the file stays readable. Tests run without a TTY, so
 * the renderers degrade to text and assertions read stable output.
 */
export function colorEnabled(): boolean {
  return Boolean(process.stdout?.isTTY) && !process.env.NO_COLOR;
}

function color(text: string, fg: keyof typeof FG | "bold" | "dim"): string {
  const code = fg === "bold" ? S.bold : fg === "dim" ? S.dim : FG[fg];
  if (!colorEnabled()) return text;
  return `${code}${text}${S.reset}`;
}

// Visible width excludes escape codes, so padded columns stay aligned in color.
function visibleWidth(str: string): number {
  return str.replace(ANSI, "").length;
}

function padEndVisible(str: string, width: number): string {
  return str + " ".repeat(Math.max(0, width - visibleWidth(str)));
}

export function formatDuration(ms: number): string {
  const sec = ms / 1000;
  if (sec < 1) return `${ms}ms`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const minutes = Math.floor(sec / 60);
  return `${minutes}m ${Math.round(sec % 60)}s`;
}

/** A completed step line: `✔ Preparing files  4 dirs (0.2s)`. */
export function step(label: string, detail?: string, elapsedMs?: number): void {
  let line = `${color("✔", "green")} ${label}`;
  if (detail) line += color(`  ${detail}`, "dim");
  if (elapsedMs !== undefined) line += color(` (${formatDuration(elapsedMs)})`, "dim");
  console.log(line);
}

export function success(message: string): void {
  console.log(`${color("✔", "green")} ${message}`);
}

export function warn(message: string): void {
  console.warn(`${color("▲", "yellow")} ${message}`);
}

/** Opening line of the installer banner. */
export function heading(text: string): void {
  console.log(`${color("⟢ ", "blue")}${color(text, "bold")}`);
}

export type PanelRow = string | readonly [label: string, value: string];

/** A titled key/value panel; pair rows align their values one space apart. */
export function panel(title: string, rows: PanelRow[]): void {
  const inner = rows.map((row) =>
    typeof row === "string" ? row : `${row[0].padEnd(labelWidth(rows))} ${row[1]}`
  );
  const width = Math.max(visibleWidth(title), ...inner.map(visibleWidth), 0);
  // Border interior must match content interior: " " + width + " ".
  const rule = "─".repeat(width + 1);
  console.log(`${color(`┌ ${rule}┐`, "blue")}`);
  console.log(`${color("│", "blue")} ${padEndVisible(color(title, "bold"), width)} ${color("│", "blue")}`);
  if (rows.length > 0) console.log(`${color(`├ ${rule}┤`, "blue")}`);
  for (const line of inner) {
    console.log(`${color("│", "blue")} ${padEndVisible(line, width)} ${color("│", "blue")}`);
  }
  console.log(`${color(`└ ${rule}┘`, "blue")}`);
}

function labelWidth(rows: PanelRow[]): number {
  return rows.reduce((max, row) => (typeof row === "string" ? max : Math.max(max, row[0].length)), 0);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Runs `work` behind a single-line spinner, clearing the line on completion.
 * Falls back to one static line when there is no TTY. The interval is always
 * cleared so a resolved/rejected promise never leaves a live timer (Rule 02).
 */
export async function withSpinner<T>(label: string, work: Promise<T>): Promise<T> {
  if (!colorEnabled()) {
    console.log(`… ${label}`);
    return work;
  }
  let frame = 0;
  const render = () => process.stdout.write(`\r${color(SPINNER_FRAMES[frame], "cyan")} ${label}\x1b[K`);
  render();
  const timer = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    render();
  }, 80);
  try {
    return await work;
  } finally {
    clearInterval(timer);
    process.stdout.write("\r\x1b[K");
  }
}
