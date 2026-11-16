defmodule EbbServer.Storage.ActionFormat do
  @moduledoc """
  Owns the shape of the value stored in `cf_actions`.

  The Action payload is GSN-independent so it can be built and ETF-encoded
  before a GSN is claimed (#532). A stored Action is therefore one frame
  around two independently encoded terms:

      <<payload_bytes::32, payload_etf::binary, scopes_etf::binary>>

  where `payload_etf = encode(build(action))` holds only `id`, `actor_id`,
  `hlc`, and `updates`. The GSN lives in the `cf_actions` key and readers
  inject it after decode. `scopes_etf` holds `subject_scopes`: one
  `{subject_id, [group_id]}` entry per folded subject, in first-appearance
  order. They stay outside the payload because they are cache-dependent and
  only known at claim time.

  ## One shape, no compatibility layer

  Raising is still worth doing: a value in any other shape is corrupt or
  came from another database, and it must not decode as something
  plausible. Every decode uses `:erlang.binary_to_term/2` with `[:safe]`,
  so a corrupt or hostile record raises rather than constructing arbitrary
  terms.

  ## The stored Update

  A component Update is stored as `id`, `subject_id`, `method`, `data`, and
  `component`; a `delete` names the row and stores no component. A
  `create` stores the row fact instead — `id`, `subject_id`, `model`,
  `method`, `hlc`, `data` — with no component. `data` is the component's own
  value; the pre-component wire's row record is never read. A payload with
  any other Update shape raises, so an old-shape Action is unreadable rather
  than half-understood.
  """

  alias EbbServer.Storage.Component

  @etf_magic 131

  @type payload :: map()
  @type action :: map()
  @typedoc """
  One folded subject's delivery scope, in first-appearance order. The empty
  group list means "deliver to nobody", which is different from an absent
  entry (an unscoped or corrupt record).
  """
  @type subject_scope :: {subject_id :: String.t(), [group_id :: String.t()]}

  @type carried_payload :: {payload_etf :: binary(), subject_scopes :: [subject_scope()]}

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

  @spec frame(binary(), [subject_scope()]) :: binary()
  def frame(payload_etf, subject_scopes) do
    subject_scopes = validate_subject_scopes!(subject_scopes)

    case payload_etf do
      <<@etf_magic, _rest::binary>> ->
        scopes_etf = :erlang.term_to_binary(subject_scopes)
        <<byte_size(payload_etf)::32, payload_etf::binary, scopes_etf::binary>>

      other ->
        raise ArgumentError,
              "a cf_actions frame holds an ETF payload, got: #{inspect(other, limit: 4)}"
    end
  end

  @spec decode(binary(), non_neg_integer()) :: action()
  def decode(value, gsn) do
    {payload_etf, scopes_etf} = split(value)
    decode_carried(payload_etf, decode_term(scopes_etf), gsn)
  end

  @spec decode_carried(binary(), [subject_scope()], non_neg_integer()) :: action()
  def decode_carried(payload_etf, subject_scopes, gsn) do
    payload_etf
    |> decode_payload_term(gsn)
    |> Map.put("subject_scopes", validate_subject_scopes!(subject_scopes))
  end

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

  # The scopes half is exactly one `{subject_id, [group_id]}` entry per folded
  # subject. Anything else — including the pre-#814 per-Update list — is
  # corrupt or from another build, and must not decode as unscoped. This is the
  # one gate on that shape (`ActionScope` reads a decoded Action, not a raw
  # record), so there is no second predicate to keep in step.
  defp validate_subject_scopes!(scopes) do
    if subject_scopes?(scopes), do: scopes, else: reject_subject_scopes(scopes)
  end

  defp subject_scopes?(scopes) when is_list(scopes), do: Enum.all?(scopes, &subject_scope?/1)
  defp subject_scopes?(_scopes), do: false

  defp subject_scope?({subject_id, group_ids}) when is_binary(subject_id) and is_list(group_ids),
    do: Enum.all?(group_ids, &is_binary/1)

  defp subject_scope?(_scope), do: false

  defp reject_subject_scopes(scopes) do
    raise ArgumentError,
          "a cf_actions frame holds one group list per subject, got: " <>
            inspect(scopes, limit: 8)
  end

  # Enough of a rejected value to identify it, without dumping a whole
  # record into a log line.
  defp head(value) when is_binary(value) do
    value
    |> binary_part(0, min(byte_size(value), 16))
    |> inspect(printable_limit: 16)
  end

  defp build_update(%{method: :create} = update) do
    %{
      "id" => update.id,
      "subject_id" => update.subject_id,
      "model" => update.model,
      "method" => "create",
      "hlc" => update.hlc,
      "data" => nil
    }
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
  # (a create or a delete) carries no component; every other method names one
  # `<model>/<field>` component and its value. Each method also has its exact
  # key set, so a `model` or `hlc` on a component Update is corrupt.
  defp validate_update!(update) when is_map(update) do
    method = update["method"]

    cond do
      not Component.method?(method) ->
        reject_update(update, "unknown method")

      Map.keys(update) -- Component.update_keys_for(method) != [] ->
        reject_update(update, "unknown keys")

      not is_binary(update["id"]) or not is_binary(update["subject_id"]) ->
        reject_update(update, "missing id or subject_id")

      true ->
        validate_method_shape!(update, method)
    end
  end

  defp validate_update!(update) do
    raise ArgumentError, "cf_actions Update is not a map: #{inspect(update, limit: 4)}"
  end

  # A create names the row's model and creation time, and carries no value.
  defp validate_method_shape!(update, "create") do
    model = update["model"]

    cond do
      not is_binary(model) or model == "" or :binary.match(model, "/") != :nomatch ->
        reject_update(update, "a create's model is not a model name")

      not is_integer(update["hlc"]) or update["hlc"] <= 0 ->
        reject_update(update, "a create carries its creation hlc")

      not is_nil(update["data"]) ->
        reject_update(update, "a create carries no value")

      true ->
        :ok
    end
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
