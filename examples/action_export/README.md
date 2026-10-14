# Action export (`onAction`) example

A copy-paste handler that ships every committed ebb Action to a sink — here,
the log. Swap the log line for an insert and the same shape backs an audit
log, a warehouse load, or a webhook fan-out. It is how an application derives
product analytics from the Action stream without instrumenting its own write
paths: every write is already a structured event.

`EbbServer.ActionExport` is the server side of the hook. It is opt-in and
reads the durable Action log off the write path, so a slow or failing sink
never affects a commit. The
[server README](../../ebb_server/README.md#action-export-the-onaction-hook)
documents the config, payload, and delivery semantics in full.

## Run it

1. Copy `action_sink.ex` into `ebb_server/lib/`.

2. Point the exporter at it in `ebb_server/config/dev.exs`:

   ```elixir
   config :ebb_server, on_action: {ActionSink, :handle}
   ```

3. Start the server and make a write:

   ```bash
   cd ebb_server
   mix dev
   ```

   From the repo root, `pnpm dev` starts the same server plus the
   collaborative-text demo, whose first load seeds a group and a document.
   Any client write — that demo, an HTTP `POST /sync/actions`, another
   client — then shows up as an `[action_sink]` log line on the server:

   ```text
   [action_sink] %{data: %{...}, action_id: "act_...", actor_id: "a_...", ...}
   ```

To watch the exporter's own health, attach to `[:ebb, :action_export, :lag]`
(or `:failed`); see the [event catalogue](../../ebb_server/README.md#event-catalogue).

## What the example shows

- The Action map the handler receives, with its string keys and `updates`
  list (see `EbbServer.ActionExport` for the exact shape).
- The return contract: `:ok` advances the cursor; `{:error, reason}` (or a
  raise/timeout) stalls it and the batch is retried.
- Idempotency: because delivery is at-least-once, the example comments the
  dedup key (`{action_id, update_id}`) a real sink should upsert on.

`groupMember` and `entityGroup` Updates are stripped by default, so the sink
sees domain Actions, not system membership bookkeeping.
