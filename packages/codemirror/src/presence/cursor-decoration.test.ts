/**
 * Remote cursor/selection decorations.
 *
 * The extension's seam is `getPresence()` — the demo binds it to
 * `client.presence.forEntity(docId, "cursor")`, which is what narrows the map
 * to one channel of one entity. So these tests feed a small presence-shaped
 * map and read the rendered DOM: what a peer produces, and what disappears
 * when its run stops resolving or the peer leaves.
 *
 * Run positions come from an injected resolver, so the decoration can be
 * tested without a TextDocument; the bridge's run-id mapping has its own
 * tests in `../bridge.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CursorPresence, PeerPresence, PresenceChange } from "@ebbjs/client";

import { createPresenceExtension } from "./cursor-decoration";

const DOC_ID = "doc_test";

/** Run ids mapped to their document start; offsets are added on top. */
const RUN_STARTS: Record<string, number> = { r_a: 0, r_b: 6 };

const cursorAt = (
  anchorId: string,
  anchorOffset: number,
  headId = anchorId,
  headOffset = anchorOffset,
): CursorPresence => ({
  anchorId,
  anchorOffset,
  headId,
  headOffset,
});

type ChangeListener = (change: PresenceChange) => void;

/**
 * The two methods the extension reads, plus a setter so a test can drive an
 * update the way `client.presence.onUpdate` would.
 */
interface FakePresence {
  forEntity(entityId: string, channel: string): ReadonlyMap<string, PeerPresence<CursorPresence>>;
  onUpdate(callback: ChangeListener): () => void;
  set(actorId: string, entityId: string, channel: string, value: CursorPresence | null): void;
  close(): void;
}

const presenceKey = (entityId: string, channel: string, actorId: string): string =>
  `${entityId}\u0000${channel}\u0000${actorId}`;

function createFakePresence(): FakePresence {
  const entries = new Map<string, PeerPresence<CursorPresence>>();
  const listeners = new Set<ChangeListener>();

  return {
    forEntity(entityId, channel) {
      const out = new Map<string, PeerPresence<CursorPresence>>();
      for (const entry of entries.values()) {
        if (entry.entityId === entityId && entry.channel === channel) {
          out.set(entry.actorId, entry);
        }
      }
      return out;
    },
    onUpdate(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    set(actorId, entityId, channel, value) {
      const key = presenceKey(entityId, channel, actorId);
      if (value === null) {
        entries.delete(key);
      } else {
        entries.set(key, { actorId, entityId, channel, data: value, updatedAt: Date.now() });
      }
      for (const listener of listeners) listener({ entityId, channel });
    },
    close() {
      listeners.clear();
      entries.clear();
    },
  };
}

interface Mounted {
  readonly presence: FakePresence;
  readonly view: EditorView;
  update: (
    actorId: string,
    entityId: string,
    channel: string,
    value: CursorPresence | null,
  ) => void;
}

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.view.destroy();
  mounted?.presence.close();
  mounted = null;
  document.body.innerHTML = "";
});

function mount(channel = "cursor", entityId = DOC_ID): Mounted {
  const presence = createFakePresence();
  const extension = createPresenceExtension({
    getPresence: () => presence.forEntity(entityId, channel),
    getPositionOfRun: (runId, offset) => {
      const start = RUN_STARTS[runId];
      return start === undefined ? undefined : start + offset;
    },
    getRunAtPosition: () => undefined,
  });
  const view = new EditorView({
    state: EditorState.create({ doc: "hello world", extensions: [extension] }),
    parent: document.body,
  });
  // The demo rebuilds on every presence change this way; decorations only
  // rebuild on a transaction.
  presence.onUpdate(() => view.dispatch({}));

  const result: Mounted = {
    presence,
    view,
    update: (actorId, targetEntity, targetChannel, value) => {
      presence.set(actorId, targetEntity, targetChannel, value);
    },
  };
  mounted = result;
  return result;
}

const labels = (view: EditorView): string[] =>
  [...view.dom.querySelectorAll(".cm-remote-cursor-label")].map((node) => node.textContent ?? "");

const selections = (view: EditorView): unknown[] => [
  ...view.dom.querySelectorAll(".cm-remote-selection"),
];

describe("createPresenceExtension", () => {
  it("renders a collapsed peer cursor as a labelled widget", () => {
    const { view, update } = mount();

    update("a_alice", DOC_ID, "cursor", cursorAt("r_b", 2));

    expect(labels(view)).toEqual(["a_alice"]);
    expect(selections(view)).toHaveLength(0);
    // The bar is labelled for assistive tech, not just coloured.
    const bar = view.dom.querySelector<HTMLElement>(".cm-remote-cursor");
    expect(bar?.getAttribute("aria-label")).toBe("a_alice's cursor");
    expect(bar?.style.borderLeft).not.toBe("");
  });

  it("renders a peer selection as a mark plus a cursor at the head", () => {
    const { view, update } = mount();

    update("a_alice", DOC_ID, "cursor", cursorAt("r_a", 0, "r_b", 3));

    expect(labels(view)).toEqual(["a_alice"]);
    expect(selections(view)).toHaveLength(1);
  });

  it("skips a peer whose run no longer resolves", () => {
    const { view, update } = mount();

    update("a_alice", DOC_ID, "cursor", cursorAt("r_deleted", 0));

    expect(labels(view)).toEqual([]);
    expect(selections(view)).toHaveLength(0);
  });

  it("drops a peer after its channel clears", () => {
    const { view, update } = mount();

    update("a_alice", DOC_ID, "cursor", cursorAt("r_a", 1));
    expect(labels(view)).toEqual(["a_alice"]);

    update("a_alice", DOC_ID, "cursor", null);
    expect(labels(view)).toEqual([]);
  });
});
