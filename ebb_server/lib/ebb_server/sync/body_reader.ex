defmodule EbbServer.Sync.BodyReader do
  @moduledoc """
  The one place `EbbServer.Sync.Router` reads a request body.

  Four routes accept a body (`POST /sync/actions`, `/entities/query`,
  `/sync/handshake`, `/sync/presence`), and `Plug.Conn.read_body/2` has three
  outcomes. Matching only `{:ok, body, conn}` — as each route did before
  ebbjs/ebbjs#725 — turns any body the adapter does not finish in one call
  into a `MatchError` and a `500`, which a client that treats `5xx` as
  retryable will re-upload. Reading through one function keeps that mapping
  identical everywhere: a body the adapter stopped reading is
  `{:error, :payload_too_large, conn}` (reported as `413`), and an adapter
  read failure is `{:error, :invalid_body, reason, conn}` (reported as
  `400`).

  The per-route limits live in `EbbServer.Sync.BodyLimits`.

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

  @doc """
  Reads the request body, up to `max_bytes`.

  A partial that reaches the ceiling is `:payload_too_large`; a shorter
  partial or an adapter read failure is `:invalid_body` with the reason.
  """
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
