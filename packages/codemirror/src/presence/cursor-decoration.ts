/**
 * CodeMirror 6 ViewPlugin that renders remote peers' cursors and
 * selections as decorations.
 *
 * Reads from a `PresenceManager` (transport lives in
 * `@ebbjs/client/src/presence/presence`). Run IDs are stable across
 * edits so we resolve them to current document positions via the
 * bridge's `idMapField` (a StateField that mirrors the causal tree's
 * span index). If a run was deleted or split in a way the receiver
 * can't resolve, the position falls back to undefined and we skip
 * rendering for that peer.
 *
 * The plugin rebuilds decorations on every CM update. For a prototype
 * with a handful of peers, this is O(peers × spans) per update and
 * fine. For more peers, batching + dirty checking would be the
 * next move.
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet as DecorationSetType,
} from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { getPositionOfRun, getRunAtPosition } from "../bridge";
import type { PresenceEntry } from "@ebbjs/client";

/**
 * CM6 widget that renders a vertical cursor bar + actor label above.
 * CursorWidget is a class per CM6's API; the lone exception to the
 * "no classes" rule in this module.
 */
class CursorWidget extends WidgetType {
  constructor(
    readonly color: string,
    readonly label: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-remote-cursor";
    wrap.style.borderLeft = `2px solid ${this.color}`;
    wrap.style.height = "1.2em";
    wrap.style.display = "inline-block";
    wrap.style.width = "0";
    wrap.style.verticalAlign = "text-bottom";
    wrap.style.position = "relative";
    wrap.style.marginLeft = "-1px";
    wrap.style.marginRight = "-1px";
    wrap.setAttribute("aria-label", `${this.label}'s cursor`);

    const tag = document.createElement("span");
    tag.className = "cm-remote-cursor-label";
    tag.textContent = this.label;
    tag.style.position = "absolute";
    tag.style.bottom = "calc(100% + 1px)";
    tag.style.left = "-1px";
    tag.style.padding = "1px 4px";
    tag.style.fontSize = "10px";
    tag.style.lineHeight = "1.2";
    tag.style.backgroundColor = this.color;
    tag.style.color = "white";
    tag.style.borderRadius = "2px";
    tag.style.whiteSpace = "nowrap";
    tag.style.pointerEvents = "none";
    wrap.appendChild(tag);

    return wrap;
  }

  eq(other: CursorWidget): boolean {
    return this.color === other.color && this.label === other.label;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export interface PresenceDecorationConfig {
  /**
   * Called to get the current presence entries for this entity.
   * Returns a fresh map each call; the ViewPlugin caches results
   * between CM updates.
   */
  readonly getPresence: () => ReadonlyMap<string, PresenceEntry>;
  /** Called to look up a run's current document position. */
  readonly getPositionOfRun: (runId: string, offset: number) => number | undefined;
  /** Called to map a document position back to (runId, offset). */
  readonly getRunAtPosition: (position: number) => { runId: string; offset: number } | undefined;
}

/**
 * Build a CM6 Extension (ViewPlugin) that renders presence as
 * decorations. Decorations rebuild on every CM update.
 */
export function createPresenceExtension(config: PresenceDecorationConfig): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSetType;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view.state, config);
      }

      update(update: import("@codemirror/view").ViewUpdate): void {
        this.decorations = buildDecorations(update.state, config);
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}

function buildDecorations(state: EditorState, config: PresenceDecorationConfig): DecorationSetType {
  const entries = Array.from(config.getPresence().values());
  const docLen = state.doc.length;
  const items: { from: number; to: number; dec: import("@codemirror/view").Decoration }[] = [];

  for (const entry of entries) {
    const anchorPos = config.getPositionOfRun(entry.cursor.anchorId, entry.cursor.anchorOffset);
    const headPos = config.getPositionOfRun(entry.cursor.headId, entry.cursor.headOffset);
    if (anchorPos === undefined || headPos === undefined) continue;

    const a = Math.min(Math.max(0, anchorPos), docLen);
    const h = Math.min(Math.max(0, headPos), docLen);
    const color = colorForPeer(entry.actorId);

    if (a === h) {
      // Cursor (no selection): render a widget at the position.
      items.push({
        from: h,
        to: h,
        dec: Decoration.widget({
          widget: new CursorWidget(color, entry.actorId),
          side: 1,
        }),
      });
    } else {
      // Selection range: render a mark plus a cursor widget at the head.
      const from = Math.min(a, h);
      const to = Math.max(a, h);
      items.push({
        from,
        to,
        dec: Decoration.mark({
          class: "cm-remote-selection",
          attributes: {
            style: `background-color: ${color}33`,
          },
        }),
      });
      items.push({
        from: h,
        to: h,
        dec: Decoration.widget({
          widget: new CursorWidget(color, entry.actorId),
          side: 1,
        }),
      });
    }
  }

  // Sort by `from` then `to` — required by CM6's Decoration.set.
  items.sort((a, b) => a.from - b.from || a.to - b.to);

  const decos = items.map((i) =>
    i.from === i.to ? i.dec.range(i.from) : i.dec.range(i.from, i.to),
  );
  return Decoration.set(decos);
}

// ---------------------------------------------------------------------------
// Color assignment (mirrors the POC's palette)
// ---------------------------------------------------------------------------

const KNOWN_COLORS: Record<string, string> = {
  drew: "#60a5fa", // blue-400
  alice: "#fbbf24", // amber-400
  sarah: "#a78bfa", // violet-400
  bob: "#34d399", // emerald-400
  charlie: "#f472b6", // pink-400
};

const FALLBACK_PALETTE = [
  "#ef4444", // red-500
  "#10b981", // emerald-500
  "#8b5cf6", // violet-500
  "#ec4899", // pink-500
  "#14b8a6", // teal-500
  "#f59e0b", // amber-500
];

function colorForPeer(peerId: string): string {
  if (peerId in KNOWN_COLORS) return KNOWN_COLORS[peerId]!;
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) {
    hash = (hash * 31 + peerId.charCodeAt(i)) | 0;
  }
  return FALLBACK_PALETTE[Math.abs(hash) % FALLBACK_PALETTE.length]!;
}

// ---------------------------------------------------------------------------
// Re-exports for the bridge's existing position helpers
// ---------------------------------------------------------------------------

export { getPositionOfRun, getRunAtPosition };
