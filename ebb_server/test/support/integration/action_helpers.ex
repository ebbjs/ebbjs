defmodule EbbServer.Integration.ActionHelpers do
  @moduledoc """
  Shared helper functions for integration tests that interact with actions.

  Provides:
  - `post_actions/2` - POST action(s) to /sync/actions endpoint
  - `get_entity/2` - GET an entity by ID
  - `bootstrap_group/3` - Create a test group with permissions
  - `add_group_member/4` - Grant an actor permissions in an existing group
  - `write_entity_in_group/5` - Write an entity to a group
  - `entity_group_update/3` - Build a same-Action `entityGroup` create
  - `msgpack_encode!/1` - Encode data as MessagePack binary
  """

  import Plug.Test
  import Plug.Conn

  alias EbbServer.Sync.Router
  alias EbbServer.TestHelpers

  # The platform's four components are atomic and all commit under `ebb`; the
  # helpers keep the pre-#805 call shape (`"entityGroup"`) and build the folded
  # row the wire now carries.
  @system_components %{
    "group" => "ebb/group",
    "groupMember" => "ebb/grant",
    "entityGroup" => "ebb/membership",
    "relationship" => "ebb/link"
  }

  def post_actions(body, actor_id \\ "a_test") do
    owner = self()
    ref = make_ref()

    state = %{
      method: "POST",
      params: %{},
      req_body: body,
      chunks: nil,
      ref: ref,
      owner: owner,
      http_protocol: :"HTTP/1.1",
      peer_data: %{address: {127, 0, 0, 1}, port: 111_317, ssl_cert: nil},
      sock_data: %{address: {127, 0, 0, 1}, port: 111_318},
      ssl_data: nil
    }

    conn =
      %Plug.Conn{}
      |> Map.put(:method, "POST")
      |> Map.put(:path_info, ["sync", "actions"])
      |> Map.put(:request_path, "/sync/actions")
      |> Map.put(:query_string, "")
      |> Map.put(:query_params, %Plug.Conn.Unfetched{aspect: :query_params})
      |> Map.put(:body_params, %Plug.Conn.Unfetched{aspect: :body_params})
      |> Map.put(:params, %Plug.Conn.Unfetched{aspect: :params})
      |> Map.put(:req_headers, [
        {"content-type", "application/msgpack"},
        {"x-ebb-actor-id", actor_id}
      ])
      |> Map.put(:host, "www.example.com")
      |> Map.put(:port, 80)
      |> Map.put(:remote_ip, {127, 0, 0, 1})
      |> Map.put(:scheme, :http)
      |> Map.put(:adapter, {Plug.Adapters.Test.Conn, state})

    Router.call(conn, [])
  end

  # The production pipeline fetches query params before the router sees them
  # (`GET /entities/:id` reads an optional `components` filter), so a direct
  # router call has to do the same.
  def get_entity(id, actor_id \\ "a_test") do
    conn(:get, "/entities/#{id}")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> fetch_query_params()
    |> Router.call([])
  end

  def msgpack_encode!(data), do: data |> Msgpax.pack!() |> IO.iodata_to_binary()

  def bootstrap_group(actor_id, group_id, permissions, apps \\ nil) do
    action = bootstrap_group_action(actor_id, group_id, permissions, apps)
    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  end

  @doc """
  The membership row id for an `(entity, group)` pair.

  One row per pair (#623): the id is derived, as the client derives it, so
  writing the same entity into the same group again re-puts its row instead of
  minting a duplicate. A test that wants a second row for a live pair has to
  name one.
  """
  def membership_row_id(entity_id, group_id), do: "eg_" <> entity_id <> "_" <> group_id

  @doc """
  Builds the same-Action group + owner `groupMember` bootstrap that
  `bootstrap_group/4` posts, without sending it. Callers that need the wire
  body (for example to drive the real Router over HTTP) encode it themselves.
  """
  def bootstrap_group_action(actor_id, group_id, permissions, apps \\ nil) do
    hlc = TestHelpers.generate_hlc()
    gm_id = "gm_" <> Nanoid.generate()
    group_update_id = "upd_group_" <> Nanoid.generate()

    group_updates = [group_update(group_update_id, group_id, apps, hlc)]

    %{
      "id" => "act_bootstrap_" <> Nanoid.generate(),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" =>
        group_updates ++ group_member_updates(gm_id, actor_id, group_id, permissions, hlc)
    }
  end

  @doc """
  Builds one `ebb/group` Update whose value carries `name` and the app scope.

  `apps` is the list of app ids the group is in scope for, or `nil` for a
  group in scope for every app.
  """
  def group_update(update_id, group_id, apps, hlc) do
    value = %{"name" => "Test Group"}

    # `apps` arrives as `%{app_id => in_scope?}`; the stored value is the list
    # of app ids the group is in scope for, so a `false` entry is an omission.
    value =
      case apps do
        nil -> value
        apps -> Map.put(value, "apps", for({id, true} <- apps, do: id))
      end

    component_update(update_id, group_id, "ebb/group", "replace", %{
      "value" => value,
      "hlc" => hlc
    })
  end

  @doc """
  Builds one component Update with the wire's string keys.
  """
  def component_update(id, subject_id, component, method, data) do
    %{
      "id" => id,
      "subject_id" => subject_id,
      "component" => component,
      "method" => method,
      "data" => data
    }
  end

  @doc """
  Builds one Update per row field.

  A create writes one `replace` per leaf component and one `merge` per keyed
  component, because `replace` is refused for a keyed value.
  """
  def component_updates(id_prefix, subject_id, model, fields) do
    case Map.fetch(@system_components, model) do
      {:ok, component} ->
        # A platform row is one atomic component whose value is the whole
        # object, so its fields collapse into a single Update. The call shape
        # stays `%{field => leaf}`; a leaf with `"value"` is unwrapped into the
        # value object.
        value = Map.new(fields, fn {field, leaf} -> {field, unwrap_leaf(leaf)} end)

        [
          component_update("#{id_prefix}_0", subject_id, component, "replace", %{"value" => value})
        ]

      :error ->
        fields
        |> Enum.with_index()
        |> Enum.map(fn {{field, value}, index} ->
          method = if keyed?(value), do: "merge", else: "replace"

          component_update(
            "#{id_prefix}_#{index}",
            subject_id,
            "#{model}/#{field}",
            method,
            value
          )
        end)
    end
  end

  defp unwrap_leaf(%{"value" => value} = leaf) do
    case Map.keys(leaf) -- ["value", "hlc", "type", "update_id"] do
      [] -> value
      _other -> leaf
    end
  end

  defp unwrap_leaf(leaf), do: leaf

  defp keyed?(%{"map" => entries}) when is_map(entries), do: true
  defp keyed?(_value), do: false

  @doc """
  Builds a `group.apps` map field for the given app ids.

  `apps` maps app id to the boolean scope value; `false` is a removal that
  keeps the key, matching the wire's per-key merge.
  """
  def group_apps_field(apps, hlc, update_id) do
    %{
      "map" =>
        Map.new(apps, fn {app_id, value} ->
          {app_id,
           %{
             "type" => "lww",
             "value" => value,
             "hlc" => hlc,
             "update_id" => update_id
           }}
        end)
    }
  end

  @doc """
  Adds `member_actor_id` to an existing `group_id` with `permissions`.

  The row goes through the permission table, not the bootstrap exemption,
  so `actor_id` must already hold `groupMember.create` there.
  """
  def add_group_member(actor_id, group_id, member_actor_id, permissions) do
    hlc = TestHelpers.generate_hlc()
    gm_id = "gm_" <> Nanoid.generate()

    action = %{
      "id" => "act_gm_" <> Nanoid.generate(),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => group_member_updates(gm_id, member_actor_id, group_id, permissions, hlc)
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  end

  defp group_member_updates(gm_id, member_actor_id, group_id, permissions, hlc) do
    component_updates("upd_#{gm_id}", gm_id, "groupMember", %{
      "actor_id" => %{"value" => member_actor_id, "hlc" => hlc},
      "group_id" => %{"value" => group_id, "hlc" => hlc},
      "permissions" => %{"value" => permissions, "hlc" => hlc}
    })
  end

  def write_entity_in_group(actor_id, entity_id, entity_type, group_id, fields) do
    hlc = TestHelpers.generate_hlc()

    action = %{
      "id" => "act_write_" <> Nanoid.generate(),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" =>
        component_updates("upd_entity_" <> Nanoid.generate(), entity_id, entity_type, fields) ++
          entity_group_update(entity_id, group_id, hlc)
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
  end

  def entity_group_update(entity_id, group_id, hlc, eg_id \\ nil) do
    eg_id = eg_id || membership_row_id(entity_id, group_id)

    component_updates("upd_#{eg_id}", eg_id, "entityGroup", %{
      "entity_id" => %{"value" => entity_id, "hlc" => hlc},
      "group_id" => %{"value" => group_id, "hlc" => hlc}
    })
  end

  @doc """
  Builds a component-less `entityGroup` delete for an existing membership row.

  The wire form names only the membership row id; the server recovers the
  entity and group from its by-id cache.
  """
  def entity_group_delete(membership_id) do
    %{
      "id" => "upd_eg_delete_" <> Nanoid.generate(),
      "subject_id" => membership_id,
      "method" => "delete",
      "data" => nil
    }
  end
end
