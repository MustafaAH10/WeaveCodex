"""Tiny revenue forecast fixture with one deliberate regression."""


def forecast_rows(rows: list[dict[str, object]], baseline_growth: float) -> list[float]:
    results = []
    for row in rows:
        override = row.get("growth_override")
        if override in (None, ""):
            growth = baseline_growth
        else:
            try:
                growth = float(override)
            except (TypeError, ValueError) as error:
                raise ValueError(f"Invalid growth override for row {row.get('row_id')}") from error
        results.append(float(row["revenue"]) * (1 + float(growth)))
    return results
