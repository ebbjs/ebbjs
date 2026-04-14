defmodule EbbServer.Integration.StorageCase do
  @moduledoc """
  ExUnit.CaseTemplate providing shared storage setup for integration tests.

  Handles:
  - Stopping any existing Storage.Supervisor
  - Creating isolated temporary directories
  - Starting fresh Storage.Supervisor
  - Cleanup on test exit

  ## Usage

      defmodule MyIntegrationTest do
        use ExUnit.Case, async: false
        use EbbServer.Integration.StorageCase
        # ...
      end

  ## Options

  - `:with_auth_mode` - When true, saves and restores the application's auth_mode
    setting. Useful for tests that bypass auth but need to restore original state.
  """

  import ExUnit.Callbacks

  alias EbbServer.TestHelpers

  defmacro __using__(opts \\ []) do
    with_auth_mode = Keyword.get(opts, :with_auth_mode, false)

    quote do
      setup do
        if unquote(with_auth_mode) do
          EbbServer.Integration.StorageCase.setup_with_auth()
        else
          EbbServer.Integration.StorageCase.setup_without_auth()
        end
      end
    end
  end

  def setup_with_auth do
    original_auth_mode = Application.get_env(:ebb_server, :auth_mode)
    Application.put_env(:ebb_server, :auth_mode, :bypass)
    storage_result = setup_storage()

    on_exit(fn ->
      cleanup_storage()
      restore_auth_mode(original_auth_mode)
    end)

    storage_result
  end

  def setup_without_auth do
    storage_result = setup_storage()

    on_exit(fn ->
      cleanup_storage()
    end)

    storage_result
  end

  def setup_storage do
    if pid = Process.whereis(EbbServer.Storage.Supervisor) do
      GenServer.stop(pid, :normal, 5000)
      :timer.sleep(50)
    end

    if pid = Process.whereis(EbbServer.Sync.GroupRegistry) do
      GenServer.stop(pid, :normal, 5000)
      :timer.sleep(100)
    end

    tmp_dir =
      TestHelpers.tmp_dir(%{
        module: __MODULE__,
        test: "integration_#{:erlang.unique_integer([:positive])}"
      })

    Application.put_env(:ebb_server, :data_dir, tmp_dir)

    ensure_started(Registry, keys: :unique, name: EbbServer.Sync.GroupRegistry)
    ensure_started(EbbServer.Storage.Supervisor, data_dir: tmp_dir)
    ensure_started(EbbServer.Sync.Supervisor, [])
    ensure_started(EbbServer.Sync.GroupDynamicSupervisor, [])
    ensure_started(EbbServer.Storage.Writer, name: EbbServer.Storage.Writer)

    %{tmp_dir: tmp_dir}
  end

  def ensure_started(module, opts) do
    case module.start_link(opts) do
      {:ok, _pid} -> :ok
      {:error, {:already_started, _pid}} -> :ok
    end
  end

  def cleanup_storage do
    stop_if_running(EbbServer.Storage.Writer)
    stop_if_running(EbbServer.Sync.Supervisor)
    stop_if_running(EbbServer.Sync.GroupRegistry)
    stop_if_running(EbbServer.Storage.Supervisor)
    Application.delete_env(:ebb_server, :data_dir)
  end

  def stop_if_running(name) do
    try do
      if pid = Process.whereis(name) do
        GenServer.stop(pid, :normal, 5000)
      end
    catch
      _, _ -> :ok
    end
  end

  def restore_auth_mode(nil), do: Application.delete_env(:ebb_server, :auth_mode)
  def restore_auth_mode(original), do: Application.put_env(:ebb_server, :auth_mode, original)
end
