defmodule EbbServer.Bench.GuardrailsTest do
  @moduledoc """
  Pins the run guardrails: the three correctness invariants, the matched-config
  baseline budgets, the opt-out, and the report/machine-block round trip.

  The failing shapes are the ones recorded in #570: lost claimed ranges end a
  run at 3,000 GSN holes and a final watermark lag equal to every accepted GSN.
  """

  use ExUnit.Case, async: true

  import EbbServer.TestHelpers, only: [tmp_dir: 1]
  import ExUnit.CaptureIO

  alias EbbServer.Bench.{Baseline, Guardrails, Options, Report, Runner}

  describe "correctness invariants" do
    test "a clean run has no violations" do
      {:ok, config} = Options.parse([])
      run = run(config)

      assert %{violations: [], comparisons: [], enforced?: true} =
               Guardrails.evaluate([run], config)
    end

    test "any GSN hole fails and names the count and first missing GSN" do
      {:ok, config} = Options.parse([])
      run = run(config, correctness: %{gsn_holes: 3_000, gsn_first_hole: 1})

      assert %{violations: [violation]} = Guardrails.evaluate([run], config)
      assert violation.invariant == :gsn_holes
      assert violation.run == "pipeline depth 1"
      assert violation.detail =~ "3000 GSN holes"
      assert violation.detail =~ "first missing GSN 1"
    end

    test "a final lag at the accepted GSN count fails; one GSN below passes" do
      {:ok, config} = Options.parse([])

      violated =
        run(config, correctness: %{accepted: 1_000, watermark_lag_final: 1_000})

      assert %{violations: [%{invariant: :watermark_lag}]} =
               Guardrails.evaluate([violated], config)

      drained = run(config, correctness: %{accepted: 1_000, watermark_lag_final: 999})

      assert %{violations: []} = Guardrails.evaluate([drained], config)
    end

    test "a frozen frontier with a stuck accept counter fails on 0 >= 0" do
      {:ok, config} = Options.parse([])
      run = run(config, correctness: %{accepted: 0, watermark_lag_final: 0})

      assert %{violations: [%{invariant: :watermark_lag}]} =
               Guardrails.evaluate([run], config)
    end

    test "rejected Actions and write/transport errors are separate violations" do
      {:ok, config} = Options.parse([])
      run = run(config, correctness: %{rejected: 4, errors: 2})

      assert %{violations: violations} = Guardrails.evaluate([run], config)

      assert Enum.map(violations, & &1.invariant) ==
               [:rejected_actions, :write_transport_errors]
    end

    test "an injected commit stall tolerates its 503s but not holes or rejections" do
      {:ok, config} =
        Options.parse(["--stall-commits", "1", "--concurrency", "8", "--batch-size", "100"])

      assert %{violations: []} =
               Guardrails.evaluate([run(config, correctness: %{errors: 400})], config)

      assert %{violations: [%{invariant: :stalled_commit_errors}]} =
               Guardrails.evaluate([run(config)], config)

      assert %{violations: [%{invariant: :gsn_holes}]} =
               Guardrails.evaluate(
                 [run(config, correctness: %{errors: 400, gsn_holes: 1})],
                 config
               )

      assert %{violations: [%{invariant: :rejected_actions}]} =
               Guardrails.evaluate(
                 [run(config, correctness: %{errors: 400, rejected: 1})],
                 config
               )
    end

    test "an unmeasured frontier is not a hole or lag violation" do
      {:ok, config} = Options.parse(["--tier", "t5", "--concurrency", "2"])

      run =
        run(config, correctness: %{gsn_holes: nil, gsn_first_hole: nil, watermark_lag_final: nil})

      assert %{violations: []} = Guardrails.evaluate([run], config)
    end
  end

  describe "baseline budgets" do
    test "an Actions/sec drop of exactly 10% passes; more fails" do
      {:ok, config} = Options.parse([])
      baseline = baseline(config, rate: 1_000.0)

      at_band = run(config, rate: 900.0)
      assert %{violations: []} = Guardrails.evaluate([at_band], config, baseline)

      past_band = run(config, rate: 899.0)

      assert %{violations: [%{invariant: :baseline_throughput}]} =
               Guardrails.evaluate([past_band], config, baseline)
    end

    test "a p50 rise of exactly 25% passes; more fails" do
      {:ok, config} = Options.parse([])
      baseline = baseline(config, p50: 100)

      at_band = run(config, p50: 125)
      assert %{violations: []} = Guardrails.evaluate([at_band], config, baseline)

      past_band = run(config, p50: 126)

      assert %{violations: [%{invariant: :baseline_latency}]} =
               Guardrails.evaluate([past_band], config, baseline)
    end

    test "a measured pass with no matching baseline config fails loudly" do
      {:ok, config} = Options.parse([])
      {:ok, other} = Options.parse(["--batch-size", "10"])

      assert %{violations: [%{invariant: :baseline_no_match}], comparisons: [_comparison]} =
               Guardrails.evaluate([run(config)], config, baseline(other))
    end

    test "a matched baseline records every compared metric" do
      {:ok, config} = Options.parse([])
      baseline = baseline(config, rate: 1_000.0, p50: 100, p95: 150, p99: 200)

      assert %{comparisons: [comparison]} =
               Guardrails.evaluate([run(config, rate: 950.0, p50: 110)], config, baseline)

      assert comparison.rate == %{current: 950.0, baseline: 1_000.0, delta: -0.05}
      assert comparison.p50 == %{current: 110, baseline: 100, delta: 0.1}
      assert comparison.p95 == %{current: 160, baseline: 150, delta: 1 / 15}
      assert comparison.p99 == %{current: 210, baseline: 200, delta: 0.05}
    end
  end

  describe "enforcement and the opt-out" do
    test "enforce! raises with the invariant name" do
      {:ok, config} = Options.parse([])
      result = Guardrails.evaluate([run(config, correctness: %{gsn_holes: 1})], config)

      assert_raise RuntimeError, ~r/gsn_holes.*1 GSN holes/s, fn ->
        Guardrails.enforce!(result, config)
      end
    end

    test "--no-guardrails records violations without failing" do
      {:ok, config} = Options.parse(["--no-guardrails"])
      result = Guardrails.evaluate([run(config, correctness: %{errors: 1})], config)

      assert result.enforced? == false

      assert capture_io(fn -> assert :ok = Guardrails.enforce!(result, config) end) =~
               "--no-guardrails"
    end
  end

  describe "report and baseline round trip" do
    test "the machine block is parseable and preserves the matched workload" do
      {:ok, config} = Options.parse(["--tier", "t0", "--duration", "20"])

      report =
        Report.render(config, %{
          runs: [%{depth: 1, label: "pipeline", config: config, metrics: metrics(config)}],
          sweep?: false
        })

      assert {:ok, baseline} = Baseline.decode(report)
      assert [%{"depth" => 1, "label" => "pipeline"} = run] = Baseline.runs(baseline)
      assert run["config"] == Options.workload(config)
      assert run["latency"]["p50"] == 100
      assert run["correctness"]["gsn_holes"] == 0
    end

    test "the report renders the baseline deltas, including p95" do
      {:ok, config} = Options.parse([])
      baseline = baseline(config, rate: 1_000.0, p50: 100)
      current = run(config, rate: 850.0, p50: 130)

      guardrails = Guardrails.evaluate([current], config, baseline)

      report =
        Report.render(config, %{
          runs: [current],
          sweep?: false,
          guardrails: guardrails
        })

      assert report =~ "### Baseline comparison"
      assert report =~ "p95 µs (Δ)"
      assert report =~ "850.0 (-15.0%)"
    end

    test "decode rejects a report without the machine block" do
      assert {:error, message} = Baseline.decode("# not a bench report")
      assert message =~ "no ebb-bench-results:v1 block"
    end

    test "decode rejects malformed machine JSON" do
      assert {:error, message} =
               Baseline.decode("<!-- ebb-bench-results:v1\nnot json\n-->")

      assert message =~ "invalid baseline machine block"
    end

    test "decode rejects a newer machine-block version" do
      payload =
        Jason.encode!(%{"schema" => "ebb-bench-results", "version" => 2, "runs" => []})

      assert {:error, message} =
               Baseline.decode("<!-- ebb-bench-results:v1\n#{payload}\n-->")

      assert message =~ "unsupported baseline version 2"
    end

    test "load reports an unreadable baseline path" do
      assert {:error, message} = Baseline.load("/definitely/not/a/baseline.md")
      assert message =~ "cannot read baseline"
    end
  end

  describe "Runner integration" do
    setup context do
      %{tmp_dir: tmp_dir(context)}
    end

    test "a passing run writes the report and exits zero", %{tmp_dir: tmp_dir} do
      out = Path.join(tmp_dir, "passing.md")
      {:ok, config} = Options.parse(["--tier", "t0", "--duration", "20", "--out", out])

      capture_io(fn ->
        assert {:ok, ^out} = Runner.run(config, fn pass -> metrics(pass) end)
      end)

      report = File.read!(out)

      assert report =~ "## Guardrails"
      assert report =~ "All guardrails passed."
      assert report =~ "<!-- ebb-bench-results:v1"
    end

    test "the #553 shape fails and names the lost GSNs", %{tmp_dir: tmp_dir} do
      out = Path.join(tmp_dir, "failing.md")

      {:ok, config} =
        Options.parse([
          "--tier",
          "t2",
          "--concurrency",
          "8",
          "--in-flight",
          "4",
          "--duration",
          "20",
          "--out",
          out
        ])

      run_fun = fn pass ->
        metrics(pass,
          correctness: %{
            accepted: 409_500,
            gsn_holes: 3_000,
            gsn_first_hole: 1,
            watermark_lag_final: 409_500
          }
        )
      end

      assert_raise RuntimeError, ~r/gsn_holes.*3000 GSN holes.*watermark_lag/s, fn ->
        capture_io(fn -> Runner.run(config, run_fun) end)
      end

      report = File.read!(out)
      assert report =~ "### Violations"
      assert report =~ "| gsn_holes | pipeline depth 4 | 3000 GSN holes"
    end

    test "--baseline fails on a matched Actions/sec regression", %{tmp_dir: tmp_dir} do
      baseline_path = Path.join(tmp_dir, "baseline.md")
      {:ok, baseline_config} = Options.parse(["--tier", "t0", "--duration", "20"])

      File.write!(
        baseline_path,
        Report.render(baseline_config, %{
          runs: [
            %{
              depth: 1,
              label: "pipeline",
              config: baseline_config,
              metrics: metrics(baseline_config, rate: 1_000.0)
            }
          ],
          sweep?: false
        })
      )

      out = Path.join(tmp_dir, "regressed.md")

      {:ok, config} =
        Options.parse([
          "--tier",
          "t0",
          "--duration",
          "20",
          "--baseline",
          baseline_path,
          "--out",
          out
        ])

      assert_raise RuntimeError, ~r/baseline_throughput.*more than 10%/s, fn ->
        capture_io(fn ->
          Runner.run(config, fn pass -> metrics(pass, rate: 850.0) end)
        end)
      end
    end
  end

  defp baseline(config, opts \\ []) do
    report =
      Report.render(config, %{
        runs: [
          %{
            depth: 1,
            label: "pipeline",
            config: config,
            metrics: metrics(config, Keyword.put_new(opts, :lag, 0))
          }
        ],
        sweep?: false
      })

    {:ok, baseline} = Baseline.decode(report)
    baseline
  end

  defp run(config, opts \\ []) do
    depth = Keyword.get(opts, :depth, 1)
    correctness = Keyword.get(opts, :correctness, %{})

    %{
      depth: depth,
      label: Keyword.get(opts, :label, "pipeline"),
      config: %{config | in_flight: [depth]},
      metrics: metrics(config, Keyword.put(opts, :correctness, correctness))
    }
  end

  defp metrics(config, opts \\ []) do
    rate = Keyword.get(opts, :rate, 100.0)
    p50 = Keyword.get(opts, :p50, 100)
    p95 = Keyword.get(opts, :p95, p50 + 50)
    p99 = Keyword.get(opts, :p99, p50 + 100)

    base_correctness = %{
      accepted: 1_000,
      rejected: 0,
      errors: 0,
      gsn_holes: 0,
      gsn_first_hole: nil,
      watermark_lag_high: 50,
      watermark_lag_final: Keyword.get(opts, :lag, 50)
    }

    %{
      tier: config.tier,
      throughput: [
        %{
          window: "overall",
          seconds: config.duration,
          accepted: 1_000,
          rejected: 0,
          rate: rate
        }
      ],
      latency: [%{window: "overall", count: 100, p50: p50, p95: p95, p99: p99}],
      correctness: Map.merge(base_correctness, Keyword.get(opts, :correctness, %{})),
      resources: %{
        sample_count: 1,
        peak_rss_kb: nil,
        peak_memory_bytes: nil,
        peak_dirty: nil,
        scheduler_utilization: nil
      },
      fanout: nil,
      fanout_metrics: nil,
      fanout_series: [],
      server: %{writer_batch: [], writer_commit: [], http_request: [], fanout_push: []},
      in_flight: %{peak: 1, mean: 1.0},
      context: %{
        preloaded_entities: 0,
        distribution: config.distribution,
        concurrency: config.concurrency,
        seeded_actions: 1
      }
    }
  end
end
