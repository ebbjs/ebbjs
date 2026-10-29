defmodule EbbServer.TestFunctions do
  @moduledoc """
  Fixture loading and transport doubles for the functions protocol tests.
  """

  alias EbbServer.Functions.Protocol

  @fixture_dir Path.expand("../../../fixtures/functions/frames", __DIR__)

  @spec fixture_dir() :: String.t()
  def fixture_dir, do: @fixture_dir

  @spec fixture_names() :: [String.t()]
  def fixture_names do
    @fixture_dir
    |> File.ls!()
    |> Enum.filter(&String.ends_with?(&1, ".json"))
    |> Enum.map(&Path.rootname/1)
    |> Enum.sort()
  end

  @spec load_fixture!(String.t()) :: map()
  def load_fixture!(name) do
    @fixture_dir
    |> Path.join(name <> ".json")
    |> File.read!()
    |> Jason.decode!()
  end

  @spec invoke(String.t(), String.t()) :: Protocol.frame()
  def invoke(name, actor_id \\ "a_test") do
    Protocol.invoke(%{
      "invocation_id" => "inv_#{System.unique_integer([:positive])}",
      "name" => name,
      "version" => "1.0.0",
      "digest" => "sha256:fixture",
      "bundle" => "export const #{name} = () => ({ ok: true });",
      "entry" => name,
      "input" => %{},
      "subject_actor_id" => actor_id,
      "env" => %{},
      "limits" => %{"timeout_ms" => 30_000, "max_host_calls" => 1_000}
    })
  end
end

defmodule EbbServer.TestFunctions.RecordingWorker do
  @moduledoc """
  A fake worker that reports every frame the invocation sends and every close.
  """

  @behaviour EbbServer.Functions.Worker

  alias EbbServer.Functions.Worker.Fake

  @impl true
  def start(opts) do
    notify = Keyword.get(opts, :notify, self())

    case Fake.start(opts) do
      {:ok, handle} -> {:ok, %{handle: handle, notify: notify}}
      error -> error
    end
  end

  @impl true
  def send_frame(%{handle: handle, notify: notify}, frame) do
    send(notify, {:functions_worker_sent, frame})
    Fake.send_frame(handle, frame)
  end

  @impl true
  def close(%{handle: handle, notify: notify}) do
    send(notify, :functions_worker_closed)
    Fake.close(handle)
  end

  @impl true
  def os_pid(%{handle: handle}), do: Fake.os_pid(handle)

  @impl true
  def alive?(%{handle: handle}), do: Fake.alive?(handle)

  @impl true
  def monitor(%{handle: handle}), do: Fake.monitor(handle)
end

defmodule EbbServer.TestFunctions.DelayedHost do
  @moduledoc """
  A host double whose reads take a scripted time, so replies can land out of
  order without depending on storage timing.
  """

  def dispatch("get", %{"id" => id}, _context, opts) do
    notify = Keyword.get(opts, :notify)
    delay = Map.get(Keyword.get(opts, :delays, %{}), id, 0)

    if notify, do: send(notify, {:host_started, id})
    if delay > 0, do: Process.sleep(delay)
    if notify, do: send(notify, {:host_finished, id})

    {:ok, %{"id" => id}}
  end

  def dispatch(op, _payload, _context, _opts) do
    {:error, %{"error" => "protocol_error", "status" => 500, "details" => "unsupported #{op}"}}
  end
end

defmodule EbbServer.TestFunctions.RaisingHost do
  @moduledoc false

  def dispatch(_op, _payload, _context, _opts), do: raise("host exploded")
end

defmodule EbbServer.TestFunctions.FailingWorker do
  @moduledoc false

  @behaviour EbbServer.Functions.Worker

  @impl true
  def start(_opts), do: {:error, :no_worker}

  @impl true
  def send_frame(_handle, _frame), do: {:error, :no_worker}

  @impl true
  def close(_handle), do: :ok

  @impl true
  def os_pid(_handle), do: nil

  @impl true
  def alive?(_handle), do: false
end

defmodule EbbServer.TestFunctions.ClosedWorker do
  @moduledoc false

  @behaviour EbbServer.Functions.Worker

  @impl true
  def start(_opts), do: {:ok, %{}}

  @impl true
  def send_frame(_handle, _frame), do: {:error, :closed}

  @impl true
  def close(_handle), do: :ok

  @impl true
  def os_pid(_handle), do: nil

  @impl true
  def alive?(_handle), do: true
end

defmodule EbbServer.TestFunctions.BadHost do
  @moduledoc false

  def dispatch(_op, _payload, _context, _opts), do: :not_a_result
end

defmodule EbbServer.TestFunctions.NoMonitorWorker do
  @moduledoc """
  A transport that cannot be monitored, so the invocation falls back to
  `alive?/1`.
  """

  @behaviour EbbServer.Functions.Worker

  @impl true
  def start(_opts), do: {:ok, %{pid: spawn(fn -> :ok end)}}

  @impl true
  def send_frame(_handle, _frame), do: :ok

  @impl true
  def close(_handle), do: :ok

  @impl true
  def os_pid(_handle), do: nil

  @impl true
  def alive?(%{pid: pid}), do: Process.alive?(pid)
end
