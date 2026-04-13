defmodule EbbServer.Sync.SSEConnectionSupervisorTest do
  @moduledoc """
  Tests for SSEConnectionSupervisor.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Sync.SSEConnectionSupervisor

  describe "child spec" do
    test "child spec uses unique id per child (not hardcoded atom)" do
      code =
        File.read!(
          Path.expand("../../../lib/ebb_server/sync/sup/sse_connection_supervisor.ex", __DIR__)
        )

      refute code =~ ~r/id:\s*SSEConnection/,
             "Child spec id should NOT use SSEConnection atom (causes duplicate id bug)"
    end
  end
end
