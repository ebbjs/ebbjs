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

  ## The stored Update

  An Update is stored as `id`, `subject_id`, `method`, `data`, and — for
  every method but `delete` — `component`. `data` is the component's own
  value; the pre-component wire's row record is never read. A payload with
  any other Update shape raises, so an old-shape Action is unreadable rather
  than half-understood.

  ## Two readers, one decode

  Log readers (`decode/2`, catch-up, materialization, export) join the two
  halves out of the stored frame. Live fan-out does not read the frame: the
  Writer hands the Router `payload_etf` and `update_scopes` beside the
  commit notification, and `decode_carried/3` rejoins them from there. Both
  readers share the same payload decode, so the live path and the log path
  cannot drift.
  """

  alias EbbServer.Storage.Component

  @etf_magic 131

  @type payload :: map()
  @type action :: map()
  @type carried_payload :: {payload_etf :: binary(), update_scopes :: [[String.t()]]}

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
    decode_carried(payload_etf, decode_term(scopes_etf), gsn)
  end

  @doc """
  Decodes an Action from the two halves live fan-out carries.

  The Writer sends the already-encoded payload and its pre-resolved scopes
  with the commit notification; the GSN comes from the range position.
  This is the same map `decode/2` returns for the stored frame, without the
  frame split or the scopes decode.
  """
  @spec decode_carried(binary(), [[String.t()]], non_neg_integer()) :: action()
  def decode_carried(payload_etf, update_scopes, gsn) when is_list(update_scopes) do
    payload_etf
    |> decode_payload_term(gsn)
    |> Map.put("update_scopes", update_scopes)
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
        payload |> validate_payload!() |> Map.put_new("gsn", gsn)

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
      "method" => Component.method_string(update.method),
      "data" => update.data
    }
    |> put_component(update.component)
  end

  defp put_component(stored, nil), do: stored
  defp put_component(stored, component), do: Map.put(stored, "component", component)

  defp validate_payload!(%{"updates" => updates} = payload) when is_list(updates) do
    Enum.each(updates, &validate_update!/1)
    payload
  end

  defp validate_payload!(payload) do
    raise ArgumentError,
          "cf_actions payload does not hold an Update list: #{inspect(payload, limit: 4)}"
  end

  # The reader accepts exactly the component envelope. An Update naming a row
  # (a delete) carries no component; every other method names one
  # `<model>/<field>` component and its value.
  defp validate_update!(update) when is_map(update) do
    method = update["method"]

    cond do
      Map.keys(update) -- Component.update_keys() != [] ->
        reject_update(update, "unknown keys")

      not is_binary(update["id"]) or not is_binary(update["subject_id"]) ->
        reject_update(update, "missing id or subject_id")

      not Component.method?(method) ->
        reject_update(update, "unknown method")

      true ->
        validate_method_shape!(update, method)
    end
  end

  defp validate_update!(update) do
    raise ArgumentError, "cf_actions Update is not a map: #{inspect(update, limit: 4)}"
  end

  # A delete names the row; every value method names one `<model>/<field>`
  # component, and a drop carries no value.
  defp validate_method_shape!(update, "delete") do
    if Map.has_key?(update, "component") or not is_nil(update["data"]) do
      reject_update(update, "a delete names the row and carries no component")
    else
      :ok
    end
  end

  defp validate_method_shape!(update, "drop") do
    cond do
      not Component.valid?(update["component"]) ->
        reject_update(update, "component is not <model>/<field>")

      not is_nil(update["data"]) ->
        reject_update(update, "drop carries no value")

      true ->
        :ok
    end
  end

  defp validate_method_shape!(update, _method) do
    if Component.valid?(update["component"]) do
      :ok
    else
      reject_update(update, "component is not <model>/<field>")
    end
  end

  defp reject_update(update, reason) do
    raise ArgumentError,
          "cf_actions Update is not a component envelope (#{reason}): " <>
            inspect(update, limit: 8)
  end
end
