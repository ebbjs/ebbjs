defmodule EbbServer.Storage.ActionFormat do
  @moduledoc """
  Owns the shape and the version of the value stored in `cf_actions`.

  The Action payload is GSN-independent so it can be built and ETF-encoded
  before a GSN is claimed (#532). A new write is therefore a versioned
  frame around two independently encoded terms:

      <<1, payload_bytes::32, payload_etf::binary, scopes_etf::binary>>

  where `payload_etf = encode(build(action))` holds only `id`, `actor_id`,
  `hlc`, and `updates`. The GSN lives in the `cf_actions` key and readers
  inject it after decode. `scopes_etf` holds `update_scopes`, which stay
  outside the payload because they are cache-dependent and only known at
  claim time.

  The frame is *not* one ETF term. Storing the scopes beside the payload
  rather than inside the same term lets a reader slice out the payload
  and decode only that, which is what the materialization paths need; they
  never read the scopes. It also makes the claim-time write a binary copy
  plus one small `term_to_binary` of the scopes, with no traversal of the
  payload. Measured (#552, `docs/research/552-action-envelope.md`): 9%
  cheaper than the pre-#552 wrapper on the export read and 2–5% on
  catch-up, for 0.1 µs/Action more encode; the companion form that keeps
  the scopes in a second key costs a second durable put and is 53–72%
  dearer on every read that needs them.

  ## Version and the read-through

  Byte 0 is the format version. `1` is the frame above. Two older shapes
  have no version byte and no longer have a writer:

  - a 2-tuple `{payload_etf, update_scopes}`, the pre-#552 wrapper; and
  - a plain map, carrying its own `"gsn"` and `"update_scopes"`, which is
    how Actions committed before #532 were stored.

  `decode/2` accepts all three, trusts a `"gsn"` it finds in the decoded
  payload, and otherwise uses the key's GSN, so a database holding a mix
  of old and new records reads uniformly. An unknown version byte raises
  rather than falling through to `:erlang.binary_to_term/2`. This is
  forward migration only: a pre-#552 reader cannot read a v1 record, so
  rolling the server binary back after new writes requires the old records
  to still be the only ones read.

  Every decode uses `:erlang.binary_to_term/2` with `[:safe]`, so a
  corrupt or hostile record raises rather than constructing arbitrary
  terms.
  """

  @version 1
  @etf_magic 131

  @type payload :: map()
  @type action :: map()

  @doc """
  Builds the GSN-free, scopes-free storage map for an Action.

  Accepts anything with `id`, `actor_id`, `hlc`, and `updates` (a
  `PreparedAction` or a validated Action); an atom Update method is
  stringified to its wire form.
  """
  @spec build(map()) :: payload()
  def build(action) do
    %{
      "id" => action.id,
      "actor_id" => action.actor_id,
      "hlc" => action.hlc,
      "updates" => Enum.map(action.updates, &build_update/1)
    }
  end

  @spec encode(payload()) :: binary()
  def encode(payload), do: :erlang.term_to_binary(payload)

  @doc """
  Frames an already-encoded payload with the Action's per-Update scopes.

  The payload binary is copied, not traversed, so a claim pays one small
  `term_to_binary` of the scopes plus the copy.
  """
  @spec frame(binary(), [[String.t()]]) :: binary()
  def frame(<<@etf_magic, _rest::binary>> = payload_etf, update_scopes)
      when is_list(update_scopes) do
    scopes_etf = :erlang.term_to_binary(update_scopes)
    <<@version, byte_size(payload_etf)::32, payload_etf::binary, scopes_etf::binary>>
  end

  def frame(payload_etf, _update_scopes) do
    raise ArgumentError,
          "a cf_actions frame holds an ETF payload, got: #{inspect(payload_etf, limit: 4)}"
  end

  @doc """
  Decodes any stored shape into the full Action map readers expect.

  `"gsn"` comes from the decoded payload when present, otherwise from
  `gsn` — the `cf_actions` key. `"update_scopes"` comes from the frame or
  the wrapper for a new record and from the map for a legacy one; a
  record committed before #473 has none and stays unscoped, which
  `EbbServer.Storage.ActionScope` treats as "deliver every Update".
  """
  @spec decode(binary(), non_neg_integer()) :: action()
  def decode(value, gsn) do
    case value do
      <<@version, size::32, payload_etf::binary-size(size), scopes_etf::binary>> ->
        payload_etf
        |> decode_term()
        |> Map.put_new("gsn", gsn)
        |> Map.put("update_scopes", decode_term(scopes_etf))

      other ->
        decode_unversioned(other, gsn)
    end
  end

  @doc """
  Decodes the payload of any stored shape, leaving `"update_scopes"` out.

  This is the read for a path that only replays Updates — materialization,
  query, group listing, and the boot backfill. On a v1 record it skips the
  scopes term entirely; on an older shape it drops what the same decode
  already produced.
  """
  @spec decode_payload(binary(), non_neg_integer()) :: payload()
  def decode_payload(value, gsn) do
    case value do
      <<@version, size::32, payload_etf::binary-size(size), _scopes::binary>> ->
        payload_etf
        |> decode_term()
        |> Map.put_new("gsn", gsn)

      other ->
        other
        |> decode_unversioned(gsn)
        |> Map.delete("update_scopes")
    end
  end

  defp decode_unversioned(<<@etf_magic, _rest::binary>> = value, gsn) do
    case decode_term(value) do
      {payload_etf, update_scopes} when is_binary(payload_etf) ->
        payload_etf
        |> decode_term()
        |> Map.put_new("gsn", gsn)
        |> Map.put_new("update_scopes", update_scopes)

      %{} = legacy ->
        # A pre-#473 record has no scopes at all; keeping the key absent is
        # what lets `ActionScope` fall back to delivering every Update.
        Map.put_new(legacy, "gsn", gsn)

      other ->
        raise ArgumentError,
              "cf_actions record is not an Action, got: #{inspect(other, limit: 4)}"
    end
  end

  # A v1 record whose length prefix overruns the value is corrupt, not a
  # newer format: it must not report as an unsupported version of itself.
  defp decode_unversioned(<<@version, _rest::binary>>, _gsn) do
    raise ArgumentError, "cf_actions record is a truncated v1 frame"
  end

  defp decode_unversioned(<<>>, _gsn) do
    raise ArgumentError, "cf_actions record is empty"
  end

  defp decode_unversioned(<<version, _rest::binary>>, _gsn) do
    raise ArgumentError,
          "cf_actions record has unsupported format version #{version} (this build reads 1)"
  end

  defp decode_term(binary), do: :erlang.binary_to_term(binary, [:safe])

  defp build_update(update) do
    %{
      "id" => update.id,
      "subject_id" => update.subject_id,
      "subject_type" => update.subject_type,
      "method" => method_string(update.method),
      "data" => update.data
    }
  end

  defp method_string(method) when is_atom(method), do: Atom.to_string(method)
  defp method_string(method), do: method
end
