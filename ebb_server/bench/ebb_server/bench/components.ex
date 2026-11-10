defmodule EbbServer.Bench.Components do
  @moduledoc """
  The payload cost of the component envelope (#797).

  A row edit that was one Update carrying N fields is now N Updates carrying
  one component each. This module builds both shapes for the *same* logical
  edit and reports their encoded size, so the growth the epic prices
  explicitly is a number rather than an adjective.

  The old shape is built by hand: it is a counterfactual for measurement, not
  a readable wire. Nothing here is decoded, stored, or written.

  Throughput is not measured here — the commit path is `mix bench.actions`
  (`--tier t0` is the real `Writer`, no HTTP), and the epic's record compares
  the same bench config before and after this envelope.
  """

  @model "todo"
  @fields ["title", "done", "priority", "due", "notes"]
  @hlc 1_116_900_000_000_000_000

  @doc "The components one measured edit writes, as `<model>/<field>`."
  @spec components() :: [String.t()]
  def components, do: Enum.map(@fields, &"#{@model}/#{&1}")

  @doc """
  The new envelope: one Update per component, each carrying that component's
  own value, exactly as an `update()` of all five fields is planned today.
  """
  @spec component_action() :: map()
  def component_action do
    updates =
      Enum.with_index(@fields, 1)
      |> Enum.map(fn {field, index} ->
        %{
          "id" => "u_#{field}",
          "subject_id" => "e_bench",
          "component" => "#{@model}/#{field}",
          "method" => "merge",
          "data" => %{
            "value" => value(field, index),
            "update_id" => "u_#{field}",
            "hlc" => Integer.to_string(@hlc)
          }
        }
      end)

    action(updates)
  end

  @doc """
  The shape this envelope replaces: one Update whose `data` is the row's field
  record. Built only to be measured; the server refuses to accept it.
  """
  @spec row_action() :: map()
  def row_action do
    fields =
      Enum.with_index(@fields, 1)
      |> Map.new(fn {field, index} ->
        {field,
         %{
           "value" => value(field, index),
           "update_id" => "u_row",
           "hlc" => Integer.to_string(@hlc)
         }}
      end)

    action([
      %{
        "id" => "u_row",
        "subject_id" => "e_bench",
        "subject_type" => @model,
        "method" => "patch",
        "data" => %{"fields" => fields}
      }
    ])
  end

  @doc """
  Encoded sizes for one measured edit, in bytes.

  `stored` is the `cf_actions` payload (`term_to_binary` of
  `ActionFormat.build/1`), which is what catch-up and fan-out carry; `json` is
  the request body an HTTP client sends.
  """
  @spec report() :: map()
  def report do
    old = row_action()
    new = component_action()

    %{
      edits: 1,
      old_updates: length(old["updates"]),
      new_updates: length(new["updates"]),
      old_stored_bytes: stored_bytes(old),
      new_stored_bytes: stored_bytes(new),
      old_json_bytes: json_bytes(old),
      new_json_bytes: json_bytes(new)
    }
  end

  defp stored_bytes(action) do
    action
    |> payload()
    |> :erlang.term_to_binary()
    |> byte_size()
  end

  # A stored Action is the GSN-free payload term; `ActionFormat.build/1`
  # produces exactly this map for the new shape, but it refuses the old one,
  # so both are built here for a like-for-like size.
  defp payload(action) do
    Map.take(action, ["id", "actor_id", "hlc", "updates"])
  end

  defp json_bytes(action), do: action |> Jason.encode!() |> byte_size()

  defp action(updates) do
    %{
      "id" => "act_bench",
      "actor_id" => "a_bench",
      "hlc" => Integer.to_string(@hlc),
      "updates" => updates
    }
  end

  # A representative mix: short text, a boolean, a number, a timestamp, and a
  # sentence, so the per-Update fixed cost is not measured against five
  # one-byte values.
  defp value("title", _index), do: "Ship the component envelope"
  defp value("done", _index), do: false
  defp value("priority", _index), do: 3
  defp value("due", _index), do: "1767225600000"

  defp value("notes", _index),
    do: "Measured through the real Writer pipeline, not a storage primitive."
end
