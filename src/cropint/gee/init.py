"""Earth Engine authentication/initialization."""

import os

import ee


def ee_init() -> None:
    """Initialize Earth Engine; use EE_PROJECT env var as the cloud project if set."""
    try:
        project = os.environ.get("EE_PROJECT")
        if project:
            ee.Initialize(project=project)
        else:
            ee.Initialize()
    except Exception as exc:
        raise RuntimeError(
            "Failed to initialize Earth Engine. Run `earthengine authenticate` and/or "
            "set the EE_PROJECT environment variable to your GEE cloud project. "
            f"Original error: {exc}"
        ) from exc
