"""Tiny revenue forecast fixture with one deliberate regression."""


def forecast_rows(rows: list[dict[str, object]], baseline_growth: float) -> list[float]:
    results = []
    for row in rows:
        # Regression: an explicit 0 is falsy, so this silently substitutes the baseline.
        growth = row.get("growth_override") or baseline_growth
        results.append(float(row["revenue"]) * (1 + float(growth)))
    return results
