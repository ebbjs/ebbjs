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
      if unquote(with_auth_mode) do
        setup do
          original_auth_mode = Application.get_env(:ebb_server, :auth_mode)
          Application.put_env(:ebb_server, :auth_mode, :bypass)

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

          case Registry.start_link(keys: :unique, name: EbbServer.Sync.GroupRegistry) do
            {:ok, _pid} -> :ok
            {:error, {:already_started, _pid}} -> :ok
          end

          case EbbServer.Storage.Supervisor.start_link(data_dir: tmp_dir) do
            {:ok, _pid} -> :ok
            {:error, {:already_started, _pid}} -> :ok
          end

          case EbbServer.Sync.Supervisor.start_link([]) do
            {:ok, _pid} -> :ok
            {:error, {:already_started, _pid}} -> :ok
          end

          case EbbServer.Sync.GroupDynamicSupervisor.start_link([]) do
            {:ok, _pid} -> :ok
            {:error, {:already_started, _pid}} -> :ok
          end

          case EbbServer.Storage.Writer.start_link(name: EbbServer.Storage.Writer) do
            {:ok, _pid} -> :ok
            {:error, {:already_started, _pid}} -> :ok
          end

          on_exit(fn ->
            try do
              if pid = Process.whereis(EbbServer.Storage.Writer) do
                GenServer.stop(pid, :normal, 5000)
              end
            catch
              _, _ -> :ok
            end

            try do
              if pid = Process.whereis(EbbServer.Sync.Supervisor) do
                GenServer.stop(pid, :normal, 5000)
              end
            catch
              _, _ -> :ok
            end

            try do
              if pid = Process.whereis(EbbServer.Sync.GroupRegistry) do
                GenServer.stop(pid, :normal, 5000)
              end
            catch
              _, _ -> :ok
            end

            try do
              if pid = Process.whereis(EbbServer.Storage.Supervisor) do
                :ok = GenServer.stop(pid, :normal, 5000)
              end
            catch
              _, _ -> :ok
            end

            Application.delete_env(:ebb_server, :data_dir)

            if original_auth_mode,
              do: Application.put_env(:ebb_server, :auth_mode, original_auth_mode),
              else: Application.delete_env(:ebb_server, :auth_mode)
          end)

          %{tmp_dir: tmp_dir}
        end
      else
        setup do
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

          case Registry.start_link(keys: :unique, name: EbbServer.Sync.GroupRegistry) do
            {:ok, _pid} -> :ok
            {:error, {:already_started, _pid}} -> :ok
          end

          case EbbServer.Storage.Supervisor.start_link(data_dir: tmp_dir) do
            {:ok, _pid} -> :ok
            {:error, {:already_started, _pid}} -> :ok
          end

          case EbbServer.Sync.Supervisor.start_link([]) do
            {:ok, _pid} -> :ok
            {:error, {:already_started, _pid}} -> :ok
          end

          case EbbServer.Sync.GroupDynamicSupervisor.start_link([]) do
            {:ok, _pid} -> :ok
            {:error, {:already_started, _pid}} -> :ok
          end

          case EbbServer.Storage.Writer.start_link(name: EbbServer.Storage.Writer) do
            {:ok, _pid} -> :ok
            {:error, {:already_started, _pid}} -> :ok
          end

          on_exit(fn ->
            try do
              if pid = Process.whereis(EbbServer.Storage.Writer) do
                GenServer.stop(pid, :normal, 5000)
              end
            catch
              _, _ -> :ok
            end

            try do
              if pid = Process.whereis(EbbServer.Sync.Supervisor) do
                GenServer.stop(pid, :normal, 5000)
              end
            catch
              _, _ -> :ok
            end

            try do
              if pid = Process.whereis(EbbServer.Sync.GroupRegistry) do
                GenServer.stop(pid, :normal, 5000)
              end
            catch
              _, _ -> :ok
            end

            try do
              if pid = Process.whereis(EbbServer.Storage.Supervisor) do
                :ok = GenServer.stop(pid, :normal, 5000)
              end
            catch
              _, _ -> :ok
            end

            Application.delete_env(:ebb_server, :data_dir)
          end)

          %{tmp_dir: tmp_dir}
        end
      end
    end
  end
end
