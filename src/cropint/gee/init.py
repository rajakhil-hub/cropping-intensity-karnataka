"""Earth Engine authentication/initialization."""

import os
from pathlib import Path

import ee

_PROJECT_FILE = Path(__file__).resolve().parents[3] / "config" / "ee_project.txt"


def ee_init() -> None:
    """Initialize Earth Engine; project from EE_PROJECT env var or config/ee_project.txt."""
    project = os.environ.get("EE_PROJECT")
    if not project and _PROJECT_FILE.exists():
        project = _PROJECT_FILE.read_text().strip() or None
    try:
        if project:
            ee.Initialize(project=project)
        else:
            ee.Initialize()
    except Exception as exc:
        raise RuntimeError(
            "Failed to initialize Earth Engine. Run `earthengine authenticate` and put "
            "your GEE cloud project id in config/ee_project.txt (or set EE_PROJECT). "
            f"Original error: {exc}"
        ) from exc
