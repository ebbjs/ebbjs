defmodule EbbServer.Sync.BootstrapExistenceIntegrationTest do
  @moduledoc """
  Wire-level coverage for #289.

  The self-bootstrap exemption applies only to a group the Action is
  creating. Committing a group and then re-submitting the same group id
  with a self-granting `groupMember` must be rejected against the
  permission table (the committed group is no longer a bootstrap).
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  alias EbbServer.Integration.ActionHelpers

  test "re-bootstrapping a committed group id is rejected" do
    group_id = "g_289_#{:erlang.unique_integer([:positive])}"
    actor_id = "a_289_#{:erlang.unique_integer([:positive])}"

    first = ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.*"])
    assert first.status == 200
    assert first.resp_body == ~s({"rejected":[]})

    # The first Action committed, so the entity-type index now knows the
    # group. Re-putting it with a fresh self-granting membership is no
    # longer a bootstrap.
    replay = ActionHelpers.bootstrap_group(actor_id, group_id, ["*"])
    assert replay.status == 200

    assert [%{"reason" => "not_authorized"}] = Jason.decode!(replay.resp_body)["rejected"]
  end
end
