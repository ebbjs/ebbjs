defmodule EbbServer.Storage.ActionFormat do
  @moduledoc """
  Owns the shape of the value stored in `cf_actions`.

  The Action payload is GSN-independent so it can be built and ETF-encoded
  before a GSN is claimed (#532). A stored Action is therefore one frame
  around two independently encoded terms:

      <<payload_bytes::32, payload_etf::binary, scopes_etf::binary>>

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
  payload. Measured (#552, `docs/research/552-action-envelope.md`): 5–10%
  cheaper than the previous wrapper on the export read and 2–5% on
  catch-up, for 0.05–0.10 µs/Action more encode; the companion form that
  keeps the scopes in a second key costs a second durable put and is 53–72%
  dearer on every read that needs them.

  ## One shape, no compatibility layer

  Ebb is greenfield: there are no Actions written by another build to keep
  reading, so this reader accepts exactly the frame above and raises on
  anything else. No version byte, no read-through, no rollback story. A
  version tag was priced in the comparison that chose this shape and is
  free, and it was dropped anyway — with nothing to migrate it is a byte
  and a branch that buy only a different error message.

  Raising is still worth doing: a value in any other shape is corrupt or
  came from another database, and it must not decode as something
  plausible. Every decode uses `:erlang.binary_to_term/2` with `[:safe]`,
  so a corrupt or hostile record raises rather than constructing arbitrary
  terms.
  """

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
  def frame(payload_etf, update_scopes) when is_list(update_scopes) do
    case payload_etf do
      <<@etf_magic, _rest::binary>> ->
        scopes_etf = :erlang.term_to_binary(update_scopes)
        <<byte_size(payload_etf)::32, payload_etf::binary, scopes_etf::binary>>

      other ->
        raise ArgumentError,
              "a cf_actions frame holds an ETF payload, got: #{inspect(other, limit: 4)}"
    end
  end

  def frame(_payload_etf, update_scopes) do
    raise ArgumentError,
          "a cf_actions frame holds one group list per Update, got: #{inspect(update_scopes, limit: 4)}"
  end

  @doc """
  Decodes a stored Action into the full map readers expect.

  `"gsn"` comes from the `cf_actions` key; `"update_scopes"` comes from the
  frame and is the per-Update delivery contract.
  """
  @spec decode(binary(), non_neg_integer()) :: action()
  def decode(value, gsn) do
    {payload_etf, scopes_etf} = split(value)

    payload_etf
    |> decode_payload_term(gsn)
    |> Map.put("update_scopes", decode_term(scopes_etf))
  end

  @doc """
  Decodes the payload of a stored Action, leaving `"update_scopes"` out.

  This is the read for a path that only replays Updates — materialization,
  query, group listing, and the boot backfill — and it skips the scopes
  term entirely.
  """
  @spec decode_payload(binary(), non_neg_integer()) :: payload()
  def decode_payload(value, gsn) do
    {payload_etf, _scopes_etf} = split(value)
    decode_payload_term(payload_etf, gsn)
  end

  defp split(value) do
    case value do
      <<size::32, payload_etf::binary-size(size), scopes_etf::binary>> ->
        {payload_etf, scopes_etf}

      other ->
        raise ArgumentError,
              "cf_actions record is not a stored Action frame: #{head(other)}"
    end
  end

  defp decode_payload_term(payload_etf, gsn) do
    case decode_term(payload_etf) do
      %{} = payload ->
        Map.put_new(payload, "gsn", gsn)

      other ->
        raise ArgumentError,
              "cf_actions record does not hold an Action payload, got: #{inspect(other, limit: 4)}"
    end
  end

  defp decode_term(binary), do: :erlang.binary_to_term(binary, [:safe])

  # Enough of a rejected value to identify it, without dumping a whole
  # record into a log line.
  defp head(value) when is_binary(value) do
    value
    |> binary_part(0, min(byte_size(value), 16))
    |> inspect(printable_limit: 16)
  end

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
