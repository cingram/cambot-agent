#!/usr/bin/env python3
"""Grade save-context eval outputs against assertions."""

import json
import os
import sys

WORKSPACE = os.path.dirname(os.path.abspath(__file__))
ITERATION = os.path.join(WORKSPACE, "iteration-1")

EVALS = {
    "verbatim-save-context": {
        "eval_id": 1,
        "assertions": [
            {
                "text": "The output contains the literal string '# Andy' from the identity file",
                "check": lambda content: "# Andy" in content,
            },
            {
                "text": "The output contains the literal string '# Soul' from the soul file",
                "check": lambda content: "# Soul" in content,
            },
            {
                "text": "The output contains verbatim JSON from the snapshots directory",
                "check": lambda content: "email-agent" in content and '"agents"' in content,
            },
            {
                "text": "The output is longer than 100 lines (not a short summary)",
                "check": lambda content: len(content.strip().split("\n")) > 100,
            },
            {
                "text": "The output does NOT contain summarizing language like 'The agent is configured to' or 'Here is a summary'",
                "check": lambda content: (
                    "the agent is configured to" not in content.lower()
                    and "here is a summary" not in content.lower()
                    and "here is an overview" not in content.lower()
                ),
            },
        ],
    },
    "verbatim-dump-context": {
        "eval_id": 2,
        "assertions": [
            {
                "text": "The output contains literal text from the 00-IDENTITY.md file (multi-line block, not a one-line description)",
                "check": lambda content: (
                    "# Andy" in content
                    and "You are Andy, a personal assistant" in content
                ),
            },
            {
                "text": "The output contains literal text from the 01-SOUL.md file",
                "check": lambda content: "# Soul" in content,
            },
            {
                "text": "The output is longer than 100 lines",
                "check": lambda content: len(content.strip().split("\n")) > 100,
            },
            {
                "text": "The output contains verbatim JSON from snapshots",
                "check": lambda content: "email-agent" in content,
            },
        ],
    },
    "verbatim-export-context": {
        "eval_id": 3,
        "assertions": [
            {
                "text": "The output contains exact section headers from context files (like '## Tools & Skills' or '## Agent Registry')",
                "check": lambda content: (
                    "## What You Can Do" in content
                    or "## Google Workspace" in content
                    or "## Communication" in content
                    or "## Tools & Skills" in content
                ),
            },
            {
                "text": "The output contains multi-line verbatim blocks, not single-sentence descriptions",
                "check": lambda content: (
                    "You are Andy, a personal assistant" in content
                    and len(content.strip().split("\n")) > 100
                ),
            },
            {
                "text": "The output is longer than 100 lines",
                "check": lambda content: len(content.strip().split("\n")) > 100,
            },
            {
                "text": "The output does NOT rewrite or reorganize the source content into a new structure",
                "check": lambda content: (
                    "the agent is configured to" not in content.lower()
                    and "here is a summary" not in content.lower()
                    and "this document contains" not in content.lower()
                ),
            },
        ],
    },
}


def grade_output(eval_name, config_name, content):
    """Grade a single output against its assertions."""
    eval_def = EVALS[eval_name]
    results = []
    for assertion in eval_def["assertions"]:
        passed = assertion["check"](content)
        line_count = len(content.strip().split("\n"))
        results.append(
            {
                "text": assertion["text"],
                "passed": passed,
                "evidence": f"Line count: {line_count}"
                if "100 lines" in assertion["text"]
                else (
                    f"Found in output"
                    if passed
                    else f"NOT found in output (checked {len(content)} chars)"
                ),
            }
        )
    return {
        "eval_id": eval_def["eval_id"],
        "eval_name": eval_name,
        "config": config_name,
        "line_count": len(content.strip().split("\n")),
        "char_count": len(content),
        "expectations": results,
        "pass_rate": sum(1 for r in results if r["passed"]) / len(results),
    }


def main():
    all_results = []
    for eval_name in EVALS:
        eval_dir = os.path.join(ITERATION, eval_name)
        for config in ["with_skill", "without_skill"]:
            output_path = os.path.join(
                eval_dir, config, "outputs", "context-snapshot.md"
            )
            if not os.path.exists(output_path):
                print(f"SKIP: {eval_name}/{config} — no output file")
                continue

            with open(output_path, "r", encoding="utf-8") as f:
                content = f.read()

            result = grade_output(eval_name, config, content)
            all_results.append(result)

            # Save individual grading.json
            grading_dir = os.path.join(eval_dir, config)
            with open(
                os.path.join(grading_dir, "grading.json"), "w", encoding="utf-8"
            ) as f:
                json.dump(result, f, indent=2)

            # Print summary
            status = "PASS" if result["pass_rate"] == 1.0 else "PARTIAL"
            print(
                f"{status}: {eval_name}/{config} — {result['line_count']} lines, "
                f"{result['pass_rate']:.0%} assertions passed"
            )
            for exp in result["expectations"]:
                mark = "PASS" if exp["passed"] else "FAIL"
                print(f"  [{mark}] {exp['text']}")

    # Write aggregate
    aggregate_path = os.path.join(ITERATION, "benchmark.json")
    benchmark = {
        "skill_name": "save-context",
        "iteration": 1,
        "results": all_results,
        "summary": {},
    }
    for config in ["with_skill", "without_skill"]:
        config_results = [r for r in all_results if r["config"] == config]
        if config_results:
            benchmark["summary"][config] = {
                "avg_pass_rate": sum(r["pass_rate"] for r in config_results)
                / len(config_results),
                "avg_line_count": sum(r["line_count"] for r in config_results)
                / len(config_results),
                "total_evals": len(config_results),
            }

    with open(aggregate_path, "w", encoding="utf-8") as f:
        json.dump(benchmark, f, indent=2)
    print(f"\nBenchmark written to {aggregate_path}")


if __name__ == "__main__":
    main()
