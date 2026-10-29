defmodule EbbServer.Functions.Protocol do
  @moduledoc """
  The frame codec shared by the host and function workers.

  A frame on the wire is `<<byte_size::32, json::binary>>`. `decode/1` returns
  every complete frame in the buffer plus the trailing partial bytes, so a
  transport appends the rest to the next chunk and calls again. It never blocks
  and never assumes a read boundary lines up with a frame.

  Payloads are built with the constructors here so the wire shape has exactly
  one definition. `commit` carries the core Action verbatim, `hlc` included as
  the string the Action validator already accepts.

  The frame bound is checked from the length prefix before the payload is
  buffered, so an oversize frame is refused without being held in memory.

  `protocol_version/0` is what a worker reports in `ready`. A mismatch is a
  compatibility failure, not a per-request error; the supervisor disables
  functions at boot when the configured runner does not speak this version.
  """

  @max_frame_bytes 1_048_576
  @protocol_version 1

  @type frame :: %{required(String.t()) => term()}
  @type reason ::
          :empty_frame
          | {:frame_too_large, non_neg_integer()}
          | {:invalid_json, term()}
          | {:invalid_frame, term()}

  @spec max_frame_bytes() :: pos_integer()
  def max_frame_bytes, do: @max_frame_bytes

  @spec protocol_version() :: pos_integer()
  def protocol_version, do: @protocol_version

  @spec compatible_version?(term()) :: boolean()
  def compatible_version?(version), do: version == @protocol_version

  @doc """
  Encodes one frame, prefixing its JSON payload with its byte length.
  """
  @spec encode_frame(frame()) :: binary()
  def encode_frame(%{} = frame) do
    json = Jason.encode_to_iodata!(frame)
    IO.iodata_to_binary([<<IO.iodata_length(json)::32>>, json])
  end

  @doc """
  Decodes every complete frame in `buffer`.

  Returns the frames in arrival order and the trailing bytes of an incomplete
  frame. An oversize length prefix is an error even when the rest of the frame
  has not arrived, because the caller must not keep buffering it.
  """
  @spec decode(binary()) :: {:ok, [frame()], binary()} | {:error, reason()}
  def decode(buffer) when is_binary(buffer), do: decode(buffer, [])

  defp decode(<<length::32, _rest::binary>>, _frames) when length > @max_frame_bytes do
    {:error, {:frame_too_large, length}}
  end

  defp decode(<<0::32, _rest::binary>>, _frames), do: {:error, :empty_frame}

  defp decode(<<length::32, payload::binary-size(length), rest::binary>>, frames) do
    with {:ok, frame} <- decode_json(payload) do
      decode(rest, [frame | frames])
    end
  end

  defp decode(buffer, frames), do: {:ok, Enum.reverse(frames), buffer}

  defp decode_json(payload) do
    case Jason.decode(payload) do
      {:ok, %{"type" => type} = frame} when is_binary(type) ->
        {:ok, frame}

      {:ok, other} ->
        {:error, {:invalid_frame, other}}

      {:error, reason} ->
        {:error, {:invalid_json, reason}}
    end
  end

  @doc """
  Builds an `invoke` frame. Fields the caller omits stay omitted; the worker
  reads the ones it understands.
  """
  @spec invoke(map() | keyword()) :: frame()
  def invoke(fields), do: frame("invoke", fields)

  @doc """
  Builds a `reply` frame for one host call.
  """
  @spec reply(String.t(), {:ok, term()} | {:error, term()}) :: frame()
  def reply(call_id, {:ok, value}) do
    frame("reply", %{"call_id" => call_id, "ok" => true, "value" => value})
  end

  def reply(call_id, {:error, error}) do
    frame("reply", %{"call_id" => call_id, "ok" => false, "error" => error})
  end

  @doc """
  Builds a `call` frame from a worker to the host.
  """
  @spec call(String.t(), String.t(), term()) :: frame()
  def call(call_id, op, payload) do
    frame("call", %{"call_id" => call_id, "op" => op, "payload" => payload})
  end

  @doc """
  Builds a `result` frame: either a value or a failure kind and message.
  """
  @spec result({:ok, term()} | {:error, String.t(), String.t()}) :: frame()
  def result({:ok, value}), do: frame("result", %{"ok" => true, "value" => value})

  def result({:error, kind, message}),
    do: frame("result", %{"ok" => false, "kind" => kind, "message" => message})

  @doc """
  Builds the worker's `ready` frame.
  """
  @spec ready(term(), String.t(), non_neg_integer()) :: frame()
  def ready(pid, runner_version, protocol_version \\ @protocol_version) do
    frame("ready", %{
      "pid" => pid,
      "runner_version" => runner_version,
      "protocol_version" => protocol_version
    })
  end

  defp frame(type, fields) do
    fields
    |> Enum.map(fn {key, value} -> {to_string(key), value} end)
    |> Map.new()
    |> Map.put("type", type)
  end
end
