defmodule EbbServer.Telemetry do
  @moduledoc """
  Server-side telemetry: the single place that fixes event names and payload
  conventions for every `:telemetry` event Ebb emits.

  Every subsystem routes emissions through `execute/3` or `span/3` so that the
  `[:ebb, ...]` root and the measurement/metadata split are defined once here
  instead of being re-invented per call site.

  ## Event catalogue

  Event names are `[:ebb, subsystem, event]`, written `ebb.<subsystem>.<event>`.
  The reserved catalogue is:

  | Event                                     | Measurements                          | Metadata                                            |
  | ----------------------------------------- | ------------------------------------- | --------------------------------------------------- |
  | `ebb.writer.batch_size`                   | `count`                               | `gsn_start`, `gsn_end`, `callers`                   |
  | `ebb.writer.batch_latency_ms`             | `duration` (native)                   | `gsn_start`, `gsn_end`                              |
  | `ebb.writer.actions_per_sec`              | `count`                               | —                                                   |
  | `ebb.writer.range_resolved`               | `count`                               | `gsn_start`, `gsn_end`, `reason`                    |
  | `ebb.writer.commit_failed`                | `count`                               | `gsn_start`, `gsn_end`, `reason`                    |
  | `ebb.watermark.lag`                       | `lag` (max GSN − committed watermark) | —                                                   |
  | `ebb.dirty_set.size`                      | `size`                                | —                                                   |
  | `ebb.entity_store.materialize_latency_ms` | `duration` (native)                   | `subject_id`, `subject_type`                        |
  | `ebb.entity_store.cache_hit_rate`         | `count`                               | `result` (`:hit` / `:miss`)                         |
  | `ebb.fanout.push_latency_ms`              | `duration` (native)                   | `group_id`                                          |
  | `ebb.fanout.active_connections`           | `count`                               | —                                                   |
  | `ebb.fanout.active_groups`                | `count`                               | —                                                   |
  | `ebb.http.request_latency_ms`             | `duration` (native)                   | `method`, `route`, `status`                         |
  | `ebb.sync.catch_up`                       | `count`                               | `group_id`, `from_offset`, `returned`, `up_to_date` |

  Start/stop pairs use `span/3`; they emit `<event>.start` and `<event>.stop`
  (and `<event>.exception` on failure) with the measurements `:telemetry.span/3`
  adds (`monotonic_time`, `system_time`, `duration`).

  ## Conventions

  - **Names** are `ebb.<subsystem>.<event>`, lower snake case, past tense for
    things that happened (`range_resolved`, `commit_failed`) and a noun for
    gauges (`lag`, `size`).
  - **Measurements carry numbers only** — counts, durations, sizes, ratios.
    Durations are native time units (`System.monotonic_time/0` deltas, as
    `span/3` emits them); the `_ms` in a latency event name marks it as a
    latency metric, and reporters convert with `unit: {:native, :millisecond}`.
  - **Metadata carries identifiers and status** — `gsn`, `group_id`,
    `actor_id`, `subject_id`, `status`, `reason`. It never carries Action
    payloads or entity field values: telemetry is not a second data plane and
    must not leak user content to reporters.
  """

  @prefix :ebb

  @doc """
  Emits `[:ebb | event]` with `measurements` and `metadata`.

  `event` is the subsystem-qualified suffix, for example
  `execute([:writer, :batch_size], %{count: 10}, %{gsn_start: 1, gsn_end: 10})`
  emits `[:ebb, :writer, :batch_size]`. It must not repeat the `:ebb` root.

  Safe to call with no handlers attached: it returns `:ok` and does nothing.
  """
  @spec execute([atom()], map(), map()) :: :ok
  def execute([head | _] = event, measurements, metadata) when head != :ebb do
    :telemetry.execute([@prefix | event], measurements, metadata)
  end

  @doc """
  Wraps `:telemetry.span/3` for start/stop (and exception) pairs.

  `fun` must return `{result, stop_metadata}` (or
  `{result, extra_measurements, stop_metadata}`); the result is passed through.
  `start_metadata` is attached to the `.start` event (and to `.exception`
  metadata on failure); `stop_metadata` is attached to the `.stop` event.

  ## Example

      EbbServer.Telemetry.span([:entity_store, :materialize], %{subject_id: id}, fn ->
        result = do_materialize(id)
        {result, %{subject_type: "todo"}}
      end)
  """
  @spec span([atom()], map(), (-> {term(), map()} | {term(), map(), map()})) :: term()
  def span([head | _] = event, start_metadata, fun)
      when head != :ebb and is_function(fun, 0) do
    :telemetry.span([@prefix | event], start_metadata, fun)
  end
end
