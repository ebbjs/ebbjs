defmodule EbbServer.Sync.BodyReaderTest do
  @moduledoc """
  The shared body reader's three outcomes, and the per-route limits it is
  handed. The route tests for oversized and unreadable bodies live in
  `RouterTest`, `HandshakeTest`, and `EntityQueryTest`, next to the setup they
  need.
  """

  # Async false: the BodyLimits tests change application env that other
  # modules' routes read.
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers, only: [put_config: 2]

  alias EbbServer.Sync.BodyLimits
  alias EbbServer.Sync.BodyReader

  defmodule FailingAdapter do
    def read_req_body(_state, _opts), do: {:error, :timeout}
  end

  defmodule ShortPartialAdapter do
    def read_req_body(_state, _opts), do: {:more, "partial", %{}}
  end

  defp conn_with_body(body), do: Plug.Test.conn(:post, "/", body)

  describe "read/2" do
    test "reads a body under the limit in one call" do
      assert {:ok, "hello", %Plug.Conn{}} = BodyReader.read(conn_with_body("hello"), 1_024)
    end

    test "reads a body exactly at the limit" do
      body = String.duplicate("x", 1_024)

      assert {:ok, ^body, %Plug.Conn{}} = BodyReader.read(conn_with_body(body), 1_024)
    end

    test "reports a body the adapter could not finish as payload_too_large" do
      conn = conn_with_body(String.duplicate("x", 2_048))

      assert {:error, :payload_too_large, %Plug.Conn{}} = BodyReader.read(conn, 1_024)
    end

    test "reports an adapter read failure as invalid_body with its reason" do
      conn = %{conn_with_body("") | adapter: {FailingAdapter, :timeout}}

      assert {:error, :invalid_body, :timeout, %Plug.Conn{}} = BodyReader.read(conn, 1_024)
    end

    test "reports a partial shorter than the ceiling as an incomplete read" do
      conn = %{conn_with_body("") | adapter: {ShortPartialAdapter, %{}}}

      assert {:error, :invalid_body, :incomplete_read, %Plug.Conn{}} =
               BodyReader.read(conn, 1_024)
    end
  end

  describe "BodyLimits" do
    test "defaults cap actions at Plug's own ceiling and the rest below it" do
      assert BodyLimits.actions() == 8_000_000
      assert BodyLimits.handshake() == 1_048_576
      assert BodyLimits.query() == 1_048_576
      assert BodyLimits.presence() == 32_768
    end

    test "each limit is configurable" do
      put_config(:sync_actions_max_body_bytes, 2_000_000)
      put_config(:sync_handshake_max_body_bytes, 2_048)
      put_config(:entities_query_max_body_bytes, 4_096)
      put_config(:presence_max_body_bytes, 1_024)

      assert BodyLimits.actions() == 2_000_000
      assert BodyLimits.handshake() == 2_048
      assert BodyLimits.query() == 4_096
      assert BodyLimits.presence() == 1_024
    end

    test "a non-positive or non-integer value raises with the key name" do
      for {limit, key} <- [
            {&BodyLimits.actions/0, :sync_actions_max_body_bytes},
            {&BodyLimits.handshake/0, :sync_handshake_max_body_bytes},
            {&BodyLimits.query/0, :entities_query_max_body_bytes},
            {&BodyLimits.presence/0, :presence_max_body_bytes}
          ] do
        for value <- [0, -1, "1024", nil] do
          put_config(key, value)

          error = assert_raise ArgumentError, fn -> limit.() end
          assert error.message =~ ":#{key}"
        end
      end
    end
  end
end
