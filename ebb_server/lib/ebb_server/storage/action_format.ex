defmodule EbbServer.Storage.ActionFormat do
  @moduledoc """
  Owns the shape of the value stored in `cf_actions`.

  The Action payload is GSN-independent so it can be built and ETF-encoded
  before a GSN is claimed (#532). A new write is therefore two layers:

      :erlang.term_to_binary({payload_etf, update_scopes})

  where `payload_etf = encode(build(action))` holds only `id`, `actor_id`,
  `hlc`, and `updates`. The GSN lives in the `cf_actions` key and readers
  inject it after decode. `update_scopes` stay outside the payload because
  they are cache-dependent and only known at claim time.

  Actions committed before #532 are a plain map that carries `"gsn"` and
  `"update_scopes"`. `decode/2` accepts both shapes, trusts a `"gsn"` it
  finds in the decoded map, and otherwise uses the key's GSN, so a
  database holding a mix of old and new records reads uniformly and a
  rollback to a reader-only binary still works.

  Every decode uses `:erlang.binary_to_term/2` with `[:safe]`, so a
  corrupt or hostile record raises rather than constructing arbitrary
  terms.
  """

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
  Wraps an already-encoded payload with the Action's per-Update scopes.

  The wrapper is one ETF encode of a 2-tuple, so a claim pays no map
  traversal over the payload.
  """
  @spec wrap(binary(), [[String.t()]]) :: binary()
  def wrap(payload_etf, update_scopes), do: :erlang.term_to_binary({payload_etf, update_scopes})

  @doc """
  Decodes either stored shape into the full Action map readers expect.

  `"gsn"` comes from the decoded map when present, otherwise from `gsn`
  — the `cf_actions` key. `"update_scopes"` comes from the wrapper for a
  new record and from the map for a legacy one; a record committed
  before #473 has none and stays unscoped, which
  `EbbServer.Storage.ActionScope` treats as "deliver every Update".
  """

  @spec decode(binary(), non_neg_integer()) :: action()
  def decode(value, gsn) do
    value
    |> :erlang.binary_to_term([:safe])
    |> expand(gsn)
  end

  defp expand({payload_etf, update_scopes}, gsn) when is_binary(payload_etf) do
    payload_etf
    |> :erlang.binary_to_term([:safe])
    |> Map.put_new("gsn", gsn)
    |> Map.put_new("update_scopes", update_scopes)
  end

  defp expand(%{} = legacy, gsn) do
    # A pre-#473 record has no scopes at all; keeping the key absent is
    # what lets `ActionScope` fall back to delivering every Update.
    Map.put_new(legacy, "gsn", gsn)
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
