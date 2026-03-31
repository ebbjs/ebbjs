Goal: Create a React prototype of a collaborative editor using CodeMirror 6.
Strict Constraint: Do NOT use classes or CRDT libraries. Use a Functional Programming approach for state and logic.

1. Data & HLC Logic (Functional):

Define a CharNode type: { id: string, value: string, parentId: string, deleted: boolean }.

Implement HLC as a plain object { ts: number, count: number, node: string } with pure functions:

increment(localHlc): HLC

receive(localHlc, remoteHlc): HLC

toString(hlc): string (for unique, sortable IDs).

2. Causal Tree State (useReducer):

Use a useReducer to manage the document state as a Map<string, CharNode>.

Implement a pure reconstruct(nodesMap): string function that performs a DFS traversal of the causal tree to produce the final string for the editor.

Implement findInsertIndex(nodesMap, parentId, newHlc): number to determine the deterministic position of a new character based on the HLC tie-break rule (higher HLC wins).

3. CodeMirror 6 StateField (The Bridge):

Create a StateField<RangeSet<string>> that stores the CharNode.id for every character in the document.

Use the functional RangeSetBuilder and mapping.map(tr.changes) to ensure IDs shift correctly when text is inserted/deleted.

Capture local changes via an EditorView.updateListener:

If tr.docChanged, map the change back to the idMap to find the parentId, then dispatch a local INSERT or DELETE action.

4. Presence (Functional Hooks):

Use a useState hook to track others: Record<string, PresenceData>.

Presence must track anchorId and headId.

Use a viewPlugin to render remote cursors as WidgetDecoration by looking up the current index of the anchorId in the StateField.

5. Mock Network (Relay):

Implement a useRelay hook that uses BroadcastChannel to sync two side-by-side editor instances.

When a remote PATCH (Insert) or DELETE arrives:

Update the local HLC.

Update the nodesMap via the reducer.

Calculate the new index for the character.

Dispatch a transaction to CodeMirror: view.dispatch({ changes: { from: idx, insert: char } }).

Deliverable: Provide a single-file React component using Tailwind. Ensure the "Tie-break" logic is clearly commented, showing how it handles two users typing in the exact same spot simultaneously without a server.
