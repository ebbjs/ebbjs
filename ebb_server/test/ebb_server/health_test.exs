defmodule EbbServer.HealthTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  alias EbbServer.Health

  describe "status/0" do
    test "reports ready when the storage tree is serving" do
      assert Health.status() == :ok
    end

    test "reports unavailable when a storage child stops answering" do
      sqlite = Process.whereis(EbbServer.Storage.SQLite)
      assert is_pid(sqlite)

      :ok = :sys.suspend(sqlite)
      on_exit(fn -> if Process.alive?(sqlite), do: :sys.resume(sqlite) end)

      assert {:error, _reason} = Health.status()

      :ok = :sys.resume(sqlite)

      assert Health.status() == :ok
    end
  end
end
