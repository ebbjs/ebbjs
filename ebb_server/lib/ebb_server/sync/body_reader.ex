defmodule EbbServer.Sync.BodyReader do
  @moduledoc """
  ## What `{:more}` does and does not mean

  `{:more, partial, conn}` means "the body was not fully read", not strictly
  "the body is too large". Under Bandit:

    * HTTP/1 with `Content-Length` stops at `:length`, so a full-size partial
      is the oversized case.
    * HTTP/2 returns `{:more}` once it has read past `:length` **and on a
      read timeout regardless of size**. A partial at the ceiling is the
      oversized case; a shorter partial is an incomplete read and is reported
      as `:invalid_body`, not mislabelled as too large.
    * HTTP/1 with `Transfer-Encoding: chunked` ignores `:length` and drains
      the whole body in one `{:ok, body, conn}` call. The app-level limit
      cannot bound a chunked body, so a deployment that needs that bound must
      enforce it at the reverse proxy; see "Request body limits" in
      `docs/self-hosting.md`.
  """

  # Read the body in bounded socket chunks rather than letting one large
  # `:length` ceiling decide how much Bandit pulls in per recv.
  @read_chunk_bytes 64 * 1024

  @type error ::
          {:error, :payload_too_large, Plug.Conn.t()}
          | {:error, :invalid_body, term(), Plug.Conn.t()}

  @spec read(Plug.Conn.t(), pos_integer()) ::
          {:ok, binary(), Plug.Conn.t()} | error()
  def read(conn, max_bytes) when is_integer(max_bytes) and max_bytes > 0 do
    case Plug.Conn.read_body(conn, length: max_bytes, read_length: @read_chunk_bytes) do
      {:ok, body, conn} ->
        {:ok, body, conn}

      {:more, partial, conn} when byte_size(partial) >= max_bytes ->
        {:error, :payload_too_large, conn}

      {:more, _partial, conn} ->
        {:error, :invalid_body, :incomplete_read, conn}

      {:error, reason} ->
        {:error, :invalid_body, reason, conn}
    end
  end
end
