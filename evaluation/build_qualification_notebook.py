"""Generate a data-free, unexecuted Fabric SDK qualification notebook."""

import argparse
import ast
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REQUIRED_ASSIGNMENTS = {"SDK_DISTRIBUTION", "SDK_VERSION", "SDK_MODULE", "SDK_FUNCTIONS"}
REQUIRED_DEFINITIONS = {"QualificationError", "qualify"}


def build_notebook():
    source = (HERE / "worker.py").read_text(encoding="utf-8")
    module = ast.parse(source)
    segments = {}
    for node in module.body:
        if isinstance(node, ast.Assign):
            names = [target.id for target in node.targets if isinstance(target, ast.Name)]
        elif isinstance(node, (ast.ClassDef, ast.FunctionDef)):
            names = [node.name]
        else:
            continue
        for name in names:
            if name in REQUIRED_ASSIGNMENTS | REQUIRED_DEFINITIONS:
                if name in segments:
                    raise ValueError(f"Duplicate qualification definition: {name}")
                segment = ast.get_source_segment(source, node)
                if segment is None:
                    raise ValueError(f"Cannot extract qualification definition: {name}")
                segments[name] = segment
    expected = REQUIRED_ASSIGNMENTS | REQUIRED_DEFINITIONS
    if set(segments) != expected:
        raise ValueError("The qualification worker contract is incomplete.")

    ordered = ["SDK_DISTRIBUTION", "SDK_VERSION", "SDK_MODULE", "SDK_FUNCTIONS",
               "QualificationError", "qualify"]
    code = (
        "import importlib\nimport importlib.metadata\nimport inspect\nimport json\nimport sys\n\n"
        + "\n\n".join(segments[name] for name in ordered)
        + "\n\ntry:\n    report = qualify()\n"
          "except QualificationError as error:\n"
          "    report = {'status': 'BLOCKED', 'code': str(error), 'evaluation_ready': False}\n"
          "print(json.dumps(report, sort_keys=True))\n"
    )
    markdown = (
        "# AnswerNorth SDK qualification\n\n"
        "Checks only the installed Python and SDK version and function signatures. "
        "It does not evaluate an agent, obtain tokens, or establish execution readiness. "
        "Importing an installed SDK can execute that package's own import code.\n"
    )
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {"kernel_info": {"name": "synapse_pyspark"}, "language_info": {"name": "python"}},
        "cells": [
            {"id": "qualification-overview", "cell_type": "markdown", "metadata": {}, "source": markdown.splitlines(keepends=True)},
            {"id": "sdk-introspection", "cell_type": "code", "metadata": {}, "source": code.splitlines(keepends=True),
             "execution_count": None, "outputs": []},
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="New .ipynb path; existing files are not overwritten")
    args = parser.parse_args()
    destination = Path(args.output)
    if destination.suffix.lower() != ".ipynb":
        parser.error("--output must end in .ipynb")
    notebook = build_notebook()
    with destination.open("x", encoding="utf-8", newline="\n") as file:
        json.dump(notebook, file, ensure_ascii=False, indent=2)
        file.write("\n")


if __name__ == "__main__":
    main()
