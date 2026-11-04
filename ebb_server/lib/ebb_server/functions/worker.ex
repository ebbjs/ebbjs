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

  `release/1` is optional and is how a pooled transport takes a healthy worker
  back instead of killing it. An invocation calls it after a successful
  result; every failure path still calls `close/1`, because a worker that
  timed out, crashed, or failed a host call must not serve another caller.
  `set_owner/2` is optional and lets a pool hand a warm worker to the
  process that will call it.
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
  @callback release(handle()) :: :ok
  @callback set_owner(handle(), pid()) :: :ok

  @optional_callbacks monitor: 1, release: 1, set_owner: 2

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

  @doc """
  Returns a healthy worker to its transport for reuse.

  Falls back to `close/1` when the transport has no pooling seam, so a caller
  can release unconditionally after a successful invocation.
  """
  @spec release(t()) :: :ok
  def release(%__MODULE__{transport: transport, handle: handle} = worker) do
    if function_exported?(transport, :release, 1) do
      transport.release(handle)
    else
      close(worker)
    end
  end

  @doc "Hands a worker to the process that will own its frames."
  @spec set_owner(t(), pid()) :: :ok
  def set_owner(%__MODULE__{transport: transport, handle: handle} = worker, owner) do
    if function_exported?(transport, :set_owner, 2) do
      transport.set_owner(handle, owner)
    else
      close(worker)
    end
  end
end
