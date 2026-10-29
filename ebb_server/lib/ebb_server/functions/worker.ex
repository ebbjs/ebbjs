defmodule EbbServer.Functions.Worker do
  @moduledoc """
  The transport contract between an invocation and one worker.

  An implementation owns a process (a Port to a real runner, or the in-process
  `EbbServer.Functions.Worker.Fake`) and delivers each decoded frame to the
  owner as `{:functions_worker_frame, frame}`. `close/1` is the only way to end
  a worker, so the fake and the eventual Port transport satisfy the same
  contract and the invocation does not know which one it holds.

  `monitor/1` is optional; a transport that can be monitored exposes it so the
  invocation notices a worker that dies without sending `result`. A transport
  that cannot be monitored is probed with `alive?/1` instead.
  """

  alias EbbServer.Functions.Protocol

  @type frame :: Protocol.frame()
  @type handle :: term()
  @type opts :: keyword()

  @callback start(opts()) :: {:ok, handle()} | {:error, term()}
  @callback send_frame(handle(), frame()) :: :ok | {:error, term()}
  @callback close(handle()) :: :ok
  @callback os_pid(handle()) :: non_neg_integer() | nil
  @callback alive?(handle()) :: boolean()
  @callback monitor(handle()) :: reference()

  @optional_callbacks monitor: 1

  @enforce_keys [:transport, :handle]
  defstruct [:transport, :handle]

  @type t :: %__MODULE__{transport: module(), handle: handle()}

  @spec start(module(), opts()) :: {:ok, t()} | {:error, term()}
  def start(transport, opts \\ []) do
    case transport.start(opts) do
      {:ok, handle} -> {:ok, %__MODULE__{transport: transport, handle: handle}}
      {:error, _reason} = error -> error
    end
  end

  @spec send_frame(t(), frame()) :: :ok | {:error, term()}
  def send_frame(%__MODULE__{transport: transport, handle: handle}, frame) do
    transport.send_frame(handle, frame)
  end

  @spec close(t()) :: :ok
  def close(%__MODULE__{transport: transport, handle: handle}) do
    transport.close(handle)
  end

  @spec os_pid(t()) :: non_neg_integer() | nil
  def os_pid(%__MODULE__{transport: transport, handle: handle}) do
    transport.os_pid(handle)
  end

  @spec alive?(t()) :: boolean()
  def alive?(%__MODULE__{transport: transport, handle: handle}) do
    transport.alive?(handle)
  end

  @spec monitor(t()) :: reference() | nil
  def monitor(%__MODULE__{transport: transport, handle: handle}) do
    if function_exported?(transport, :monitor, 1) do
      transport.monitor(handle)
    end
  end
end
