# Credo configuration.
#
# CI runs `mix credo --strict --files-excluded "test/**"`. The harness under
# `bench/` is compiled only in dev/default environments, so list it explicitly
# to keep it under the same lint gate as `lib/`.
%{
  configs: [
    %{
      name: "default",
      files: %{
        included: ["lib/", "bench/"],
        excluded: [~r"/_build/", ~r"/deps/", ~r"/node_modules/"]
      }
    }
  ]
}
