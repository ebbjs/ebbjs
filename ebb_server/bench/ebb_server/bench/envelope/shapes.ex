defmodule EbbServer.Bench.Envelope.Shapes do
  @moduledoc """
  The four candidate shapes of the value stored in `cf_actions`, and the
  bench-only plumbing that reads each one.

  A stored Action is always the same payload minus the GSN: the ETF of
  `EbbServer.Storage.ActionFormat.build/1` (id, actor, hlc, updates), which
  is GSN-independent by design, plus the per-Update `update_scopes` that are
  only known at claim time. The shapes differ in where the scopes live and
  whether the value carries a format version.

  | shape | `cf_actions` value | scopes |
  | --- | --- | --- |
  | `:wrapper` | `term_to_binary({payload_etf, update_scopes})` | inside the term |
  | `:versioned_wrapper` | `term_to_binary({1, payload_etf, update_scopes})` | inside the term |
  | `:companion` | `payload_etf` | second key, second durable put |
  | `:frame` | `ActionFormat.frame/2` (v1: `<<1, size::32, payload_etf, scopes_etf>>`) | inside the frame |

  `:wrapper` is what `origin/main` stored before #552: no version byte and a
  `binary_to_term/2` of the outer tuple before a reader can reach the payload
  it wants, which is the second decode per read. `:versioned_wrapper` is the
  smallest possible fix to that format — a version integer in a 3-tuple,
  everything else unchanged — so the comparison shows whether a version byte
  alone is enough. `:frame` keeps the two terms independently encoded, so a
  reader can slice out the payload and never parse the scopes. `:companion`
  is the never-measured alternative: the `cf_actions` value is exactly the
  payload ETF, and the scopes are a second record.

  ## The companion's second key is bench-only

  A production companion form would store the scopes in its own column
  family, which means changing the RocksDB schema `EbbServer.Storage.RocksDB`
  opens. This benchmark must not change `lib/`, so it puts the scopes into
  `cf_actions` itself under a key namespace no reader scans:

      "bench:envelope:companion:" <> encode_gsn_key(gsn)

  Every GSN key is exactly 8 bytes and starts with `0x00` at the GSNs this
  bench uses, so a key that starts with `"b"` sorts after every GSN key and
  a `range_iterator` bounded by 8-byte GSN keys never reaches it. The three
  read paths modelled here (point `multi_get`, catch-up's page read, export's
  range scan) all use GSN keys or GSN-bounded ranges, so the extra records are
  invisible to them, as a separate column family would be. A full
  `cf_actions` iterator (and `RocksDB.get_max_gsn/1`, which decodes the last
  key as a GSN) would see them and break — another reason the companion form
  costs a schema change rather than a prefix trick.

  The measured price of the companion form is therefore exactly what the
  production form would pay: one extra durable put per Action on the write
  leg, and one extra point read per Action wherever a reader needs the scopes
  (catch-up and export; materialization only replays Updates and never asks
  for them). `:wrapper`, `:versioned_wrapper`, and `:frame` each store one
  record per Action.

  ## Decode parity

  `decode/2` performs the same decode work as `ActionFormat.decode/2` for
  the shape it is given, and `decode_payload/2` the same as
  `ActionFormat.decode_payload/2`. Neither goes through `ActionFormat`, so
  the benchmark keeps working if a future format change lands in `lib/`
  while the comparison is still being read.
  """

  alias EbbServer.Storage.{ActionFormat, RocksDB}

  @type shape :: :wrapper | :versioned_wrapper | :companion | :frame
  @type scopes :: [[String.t()]]

  @typedoc """
  What a read path hands the decoders: the `cf_actions` value plus, for the
  companion shape, the scopes its second read returned (`nil` for the other
  shapes and for a companion record whose scopes were not fetched).
  """
  @type stored :: {shape(), binary(), scopes() | nil}

  @typedoc """
  The pieces of one Action the shape functions turn into a stored value.
  """
  @type input :: %{
          payload_etf: binary(),
          update_scopes: scopes(),
          gsn: non_neg_integer()
        }

  @shapes [:wrapper, :versioned_wrapper, :companion, :frame]
  @by_name Map.new(@shapes, &{Atom.to_string(&1), &1})

  @companion_prefix "bench:envelope:companion:"

  @doc "Every shape, in report order."
  @spec shapes() :: [shape()]
  def shapes, do: @shapes

  @doc "Shape names accepted on the command line, mapped to their atoms."
  @spec by_name() :: %{String.t() => shape()}
  def by_name, do: @by_name

  @doc """
  The `cf_actions` value for one Action, encoded in `shape`.
  """
  @spec cf_actions_value(shape(), input()) :: binary()
  def cf_actions_value(:wrapper, %{payload_etf: payload, update_scopes: scopes}),
    do: :erlang.term_to_binary({payload, scopes})

  def cf_actions_value(:versioned_wrapper, %{payload_etf: payload, update_scopes: scopes}),
    do: :erlang.term_to_binary({1, payload, scopes})

  def cf_actions_value(:companion, %{payload_etf: payload}), do: payload

  def cf_actions_value(:frame, %{payload_etf: payload, update_scopes: scopes}),
    do: ActionFormat.frame(payload, scopes)

  @doc """
  The extra durable puts a shape needs per Action.

  Only the companion has one: the scopes record under `scopes_key/1`. The
  other three return `[]`, so the write leg's op count differs by shape
  exactly where the storage design does.
  """
  @spec extra_ops(shape(), input()) :: [{:put, term(), binary(), binary()}]
  def extra_ops(:wrapper, _input), do: []
  def extra_ops(:versioned_wrapper, _input), do: []
  def extra_ops(:frame, _input), do: []

  def extra_ops(:companion, %{gsn: gsn, update_scopes: scopes}) do
    [{:put, RocksDB.cf_actions(), scopes_key(gsn), scopes_value(scopes)}]
  end

  @doc """
  The companion shape's scopes key for `gsn` (see the moduledoc).
  """
  @spec scopes_key(non_neg_integer()) :: binary()
  def scopes_key(gsn), do: @companion_prefix <> RocksDB.encode_gsn_key(gsn)

  @doc """
  The ETF the companion shape stores under `scopes_key/1`.
  """
  @spec scopes_value(scopes()) :: binary()
  def scopes_value(scopes), do: :erlang.term_to_binary(scopes)

  @doc """
  Reads a companion record's scopes with the second point read the shape
  costs. Raises when the scopes record is missing, which is corruption in a
  production companion form and a bench bug here.
  """
  @spec read_scopes(non_neg_integer(), GenServer.name()) :: scopes()
  def read_scopes(gsn, rocks_name \\ RocksDB) do
    case RocksDB.get(RocksDB.cf_actions(rocks_name), scopes_key(gsn), name: rocks_name) do
      {:ok, value} -> :erlang.binary_to_term(value, [:safe])
      :not_found -> raise "companion scopes missing for gsn #{gsn}"
    end
  end

  @doc """
  Pairs a stored value with its shape and, for the companion, the scopes a
  second read returned.
  """
  @spec stored(shape(), binary(), scopes() | nil) :: stored()
  def stored(shape, value, scopes \\ nil), do: {shape, value, scopes}

  @doc """
  Decodes any shape into the full Action map readers expect.
  """
  @spec decode(stored(), non_neg_integer()) :: map()
  def decode({:wrapper, value, _scopes}, gsn) do
    {payload_etf, update_scopes} = :erlang.binary_to_term(value, [:safe])

    payload_etf
    |> decode_term()
    |> Map.put_new("gsn", gsn)
    |> Map.put("update_scopes", update_scopes)
  end

  def decode({:versioned_wrapper, value, _scopes}, gsn) do
    {1, payload_etf, update_scopes} = :erlang.binary_to_term(value, [:safe])

    payload_etf
    |> decode_term()
    |> Map.put_new("gsn", gsn)
    |> Map.put("update_scopes", update_scopes)
  end

  def decode({:frame, value, _scopes}, gsn), do: ActionFormat.decode(value, gsn)

  def decode({:companion, value, nil}, gsn) do
    value
    |> decode_term()
    |> Map.put_new("gsn", gsn)
  end

  def decode({:companion, value, scopes}, gsn) do
    value
    |> decode_term()
    |> Map.put_new("gsn", gsn)
    |> Map.put("update_scopes", scopes)
  end

  @doc """
  Decodes only the payload half, leaving `"update_scopes"` out.

  This is what materialization, query, and group listing read.
  """
  @spec decode_payload(stored(), non_neg_integer()) :: map()
  def decode_payload({:wrapper, value, _scopes}, gsn) do
    {payload_etf, _update_scopes} = :erlang.binary_to_term(value, [:safe])

    payload_etf
    |> decode_term()
    |> Map.put_new("gsn", gsn)
  end

  def decode_payload({:versioned_wrapper, value, _scopes}, gsn) do
    {1, payload_etf, _update_scopes} = :erlang.binary_to_term(value, [:safe])

    payload_etf
    |> decode_term()
    |> Map.put_new("gsn", gsn)
  end

  def decode_payload({:frame, value, _scopes}, gsn), do: ActionFormat.decode_payload(value, gsn)

  def decode_payload({:companion, value, _scopes}, gsn) do
    value
    |> decode_term()
    |> Map.put_new("gsn", gsn)
  end

  @doc """
  The bytes one Action occupies beyond its `cf_actions` value and the bytes
  of that value itself.
  """
  @spec stored_bytes(shape(), input()) :: %{value: non_neg_integer(), extra: non_neg_integer()}
  def stored_bytes(shape, input) do
    extra =
      shape
      |> extra_ops(input)
      |> Enum.map(fn {:put, _cf, key, value} -> byte_size(key) + byte_size(value) end)
      |> Enum.sum()

    %{value: byte_size(cf_actions_value(shape, input)), extra: extra}
  end

  defp decode_term(binary), do: :erlang.binary_to_term(binary, [:safe])
end
