/**
 * Remote cursor/selection decorations.
 *
 * The extension's seam is `getPresence()` — the demo binds it to
 * `client.presence.forEntity(docId, "cursor")`. So these tests mount a real
 * presence runtime, feed it packets, and read the rendered DOM: what a peer
 * on the declared `cursor` channel produces, and that a peer on another
 * channel or another entity produces nothing.
 *
 * Run positions come from an injected resolver, so the decoration can be
 * tested without a TextDocument; the bridge's run-id mapping has its own
 * tests in `__tests__/bridge.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createPresence,
  type CursorPresence,
  type Presence,
  type PresenceChange,
} from "@ebbjs/client";

import { createPresenceExtension } from "./cursor-decoration";

const DOC_ID = "doc_test";
const LOCAL_ACTOR = "a_local";

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

interface Mounted {
  readonly presence: Presence;
  readonly view: EditorView;
  dispatchPresence: (payload: unknown) => void;
}

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.view.destroy();
  mounted?.presence.close();
  mounted = null;
  document.body.innerHTML = "";
});

function mount(channel = "cursor", entityId = DOC_ID): Mounted {
  const presence = createPresence({
    serverUrl: "http://localhost:4000",
    actorId: LOCAL_ACTOR,
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  const extension = createPresenceExtension({
    getPresence: () => presence.forEntity<CursorPresence>(entityId, channel),
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
    dispatchPresence: (payload) => {
      presence.ingest(payload);
    },
  };
  mounted = result;
  return result;
}

const packet = (actorId: string, entityId: string, channel: string, value: unknown): unknown => ({
  actor_id: actorId,
  entity_id: entityId,
  data: { channel, value },
});

const labels = (view: EditorView): string[] =>
  [...view.dom.querySelectorAll(".cm-remote-cursor-label")].map((node) => node.textContent ?? "");

const selections = (view: EditorView): unknown[] => [
  ...view.dom.querySelectorAll(".cm-remote-selection"),
];

describe("createPresenceExtension", () => {
  it("renders a collapsed peer cursor as a labelled widget", () => {
    const { view, dispatchPresence } = mount();

    dispatchPresence(packet("a_alice", DOC_ID, "cursor", cursorAt("r_b", 2)));

    expect(labels(view)).toEqual(["a_alice"]);
    expect(selections(view)).toHaveLength(0);
    // The bar is labelled for assistive tech, not just coloured.
    const bar = view.dom.querySelector<HTMLElement>(".cm-remote-cursor");
    expect(bar?.getAttribute("aria-label")).toBe("a_alice's cursor");
    expect(bar?.style.borderLeft).not.toBe("");
  });

  it("renders a peer selection as a mark plus a cursor at the head", () => {
    const { view, dispatchPresence } = mount();

    dispatchPresence(packet("a_alice", DOC_ID, "cursor", cursorAt("r_a", 0, "r_b", 3)));

    expect(labels(view)).toEqual(["a_alice"]);
    expect(selections(view)).toHaveLength(1);
  });

  it("keeps peers on different channels and entities out of the decorations", () => {
    const { view, dispatchPresence } = mount("cursor", DOC_ID);

    dispatchPresence(packet("a_bob", DOC_ID, "camera", cursorAt("r_a", 0)));
    expect(labels(view)).toEqual([]);

    dispatchPresence(packet("a_carol", "other_doc", "cursor", cursorAt("r_a", 0)));
    expect(labels(view)).toEqual([]);

    dispatchPresence(packet("a_alice", DOC_ID, "cursor", cursorAt("r_a", 1)));
    expect(labels(view)).toEqual(["a_alice"]);
  });

  it("skips a peer whose run no longer resolves", () => {
    const { view, dispatchPresence } = mount();

    dispatchPresence(packet("a_alice", DOC_ID, "cursor", cursorAt("r_deleted", 0)));

    expect(labels(view)).toEqual([]);
    expect(selections(view)).toHaveLength(0);
  });

  it("drops a peer after its channel clears", () => {
    const { view, dispatchPresence } = mount();

    dispatchPresence(packet("a_alice", DOC_ID, "cursor", cursorAt("r_a", 1)));
    expect(labels(view)).toEqual(["a_alice"]);

    dispatchPresence(packet("a_alice", DOC_ID, "cursor", null));
    expect(labels(view)).toEqual([]);
  });
});

/** The change payload a consumer receives; used to document the filter seam. */
const cursorChanges = (presence: Presence): PresenceChange[] => {
  const changes: PresenceChange[] = [];
  presence.onUpdate((change) => {
    if (change.channel === "cursor") changes.push(change);
  });
  return changes;
};

describe("presence change filtering", () => {
  it("reports only the changed channel", () => {
    const { presence, dispatchPresence } = mount();
    const changes = cursorChanges(presence);

    dispatchPresence(packet("a_alice", DOC_ID, "camera", cursorAt("r_a", 0)));
    dispatchPresence(packet("a_alice", DOC_ID, "cursor", cursorAt("r_a", 0)));

    expect(changes).toEqual([{ entityId: DOC_ID, channel: "cursor" }]);
  });
});
