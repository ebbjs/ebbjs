defmodule Mix.Tasks.Bench.Envelope do
  @shortdoc "Compare the stored `cf_actions` envelope shapes (#552)"

  @moduledoc """
  Reproducible benchmark for the stored-Action envelope shapes (#552).

      mix bench.envelope --shapes wrapper,versioned_wrapper,companion,frame \
        --flush-sizes 100,152 --reads 1000 --updates-per-action 2 --runs 3

  Boots one isolated storage tree (the `:ebb_server` application is not
  started) and measures every shape inside it, each in its own disjoint GSN
  window, so shape-to-shape differences are measured against identical DB
  state and never against a host measured at another moment. It reports
  these numbers.

    * `µs/Action` (encode) — the per-Action value construction alone:
      `cf_actions_value/2` plus `extra_ops/2` over 1,000 Actions, with no
      RocksDB call. This is the envelope's own write price.
    * `ms/flush` — one `RocksDB.write_batch(ops, sync: true)` holding a full
      flush in the shape under test: the `cf_actions` value plus the dedup,
      group-index, entity-index, and type-entity rows the Writer commits.
      Op assembly and ETF encoding are outside the timer, so the flush is
      bounded by op count and fsync, not by the envelope.
    * `µs/Action` (write) — the same sample divided by the flush size, so
      100- and 152-Action flushes are comparable.
    * `µs/Action` per read path — the gets and decode calls of one production
      reader, per Action it decodes: `materialize` (`multi_get` +
      `decode_payload`, which query and group listing also pay), `catch_up`
      (`multi_get` + full decode + the scope filter), and `export`
      (`range_iterator` + full decode).
    * bytes per Action — the stored `cf_actions` value, plus the companion's
      second record, plus durable puts per Action.

  Shapes are `:wrapper` (`term_to_binary({payload_etf, update_scopes})`, what
  `origin/main` stores), `:versioned_wrapper` (the same tuple plus a version
  integer, `{1, payload_etf, update_scopes}`), `:companion` (bare
  `payload_etf` with the scopes in a second record), and `:frame`
  (`ActionFormat.frame/2`, the shape this build stores). The version tag in
  `:versioned_wrapper` was priced and then dropped: with nothing to migrate
  it buys only a different error message. Writes a Markdown report
  to `bench/results/` and prints it. See
  `EbbServer.Bench.Envelope.Options` for the full option list and
  `EbbServer.Bench.Envelope.Shapes` for the shapes themselves.
  """

  use Mix.Task

  alias EbbServer.Bench.Envelope.{Options, Runner}

  @impl Mix.Task
  def run(args) do
    case Options.parse(args) do
      {:ok, config} -> Runner.run(config)
      {:error, message} -> Mix.raise(message)
    end
  end
end
