defmodule EbbServer.Storage.ActionLog do
  @moduledoc """
  Reads committed Actions out of `cf_actions` in GSN order.

  This is the shared read primitive over the durable Action log: Action
  export (#367) consumes it now, peer replication (#113) will consume it
  later. It is deliberately tiny and pure — no process, no cursor, no
  group enrichment. Consumers own their own cursor and decide how far
  behind the committed watermark they are willing to run.

  ## Holes are expected

  The log is gated by a **resolution frontier**, not a gap-free sequence:
  a claimed GSN range that is abandoned (a failed or raised commit) is
  marked resolved but has no durable Action. A hole is therefore a
  permanent, normal state, and a read over a hole returns the Actions
  that do exist — never an error, never a placeholder. Callers must not
  assume contiguity; they advance their cursor to the end of the range
  they asked for, not to the last Action they saw.

  ## Values

  Each value is decoded with `:erlang.binary_to_term/2` and `[:safe]`, so
  a corrupt or hostile record raises rather than constructing arbitrary
  terms. The stored shape is defined by `EbbServer.Storage.Writer`'s
  `to_storage_format/2`.
  """

  alias EbbServer.Storage.RocksDB

  @type action :: map()
  @type opts :: [rocks_name: GenServer.name()]

  @doc """
  Returns the stored Actions whose GSNs fall in the inclusive range
  `from_gsn..to_gsn`, in ascending GSN order.

  `from_gsn > to_gsn` returns `[]`. Missing GSNs (abandoned holes) are
  simply absent from the result.
  """
  @spec read(non_neg_integer(), non_neg_integer(), opts()) :: [action()]
  def read(from_gsn, to_gsn, opts \\ [])

  def read(from_gsn, to_gsn, _opts) when from_gsn > to_gsn, do: []

  def read(from_gsn, to_gsn, opts) do
    rocks_name = Keyword.get(opts, :rocks_name, RocksDB)

    rocks_name
    |> RocksDB.cf_actions()
    |> RocksDB.range_iterator(
      RocksDB.encode_gsn_key(from_gsn),
      RocksDB.encode_gsn_key(to_gsn + 1),
      name: rocks_name
    )
    |> Enum.map(fn {_key, value} -> :erlang.binary_to_term(value, [:safe]) end)
  end
end
