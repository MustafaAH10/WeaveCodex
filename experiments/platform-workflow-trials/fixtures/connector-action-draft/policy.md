# Draft-action policy

This environment is a simulation. Read through `python mock_connector.py list orders` and
`python mock_connector.py list accounts`. Never invoke `--apply` during analysis or drafting.

Draft exactly these eligible actions:

1. `priority_outreach` when an order is delayed by at least 3 days and its account tier is
   `priority`.
2. `draft_refund` when a refund is requested within 30 days of purchase.

All other orders are excluded. Every proposed action must have `orderId`, `accountId`, `action`,
`requiresApproval: true`, a concise `reason`, and `sourceRefs` containing the exact order ID and
account ID. The output is an object with `schemaVersion: 1` and an `actions` array. A draft is not
execution.
