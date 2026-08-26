import unittest

from forecast import forecast_rows


class ForecastRowsTests(unittest.TestCase):
    def test_explicit_zero_override_is_preserved(self) -> None:
        self.assertEqual(
            forecast_rows([{"row_id": "north", "revenue": 100, "growth_override": 0}], 0.2),
            [100.0],
        )

    def test_blank_override_uses_baseline(self) -> None:
        self.assertEqual(
            forecast_rows([{"row_id": "south", "revenue": 100, "growth_override": ""}], 0.2),
            [120.0],
        )

    def test_invalid_override_names_the_row(self) -> None:
        with self.assertRaisesRegex(ValueError, "west"):
            forecast_rows(
                [{"row_id": "west", "revenue": 100, "growth_override": "not-a-number"}],
                0.2,
            )


if __name__ == "__main__":
    unittest.main()
