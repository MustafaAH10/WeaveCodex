# INC-42 customer update

**Status:** Investigating. [incident_log.json#INC-42]

We are investigating elevated queue depth affecting the `media-rendering` service in `ap-southeast-1`. Render jobs in the affected region are remaining queued longer than 15 minutes. [incident_log.json#INC-42]

Existing jobs are retained, and no data loss has been observed. [status_history.md#09-30Z]

Root cause is unknown. [incident_log.json#INC-42]

The latest published update was at 09:30Z. The next update is due at 10:00Z, following the required 30-minute update cadence. [status_history.md#09-30Z] [runbook.md#customer-update-runbook]

We do not have a confirmed recovery estimate to share. [runbook.md#customer-update-runbook]

## Remaining uncertainty

The cause of the queueing and the time to recovery remain unknown. The latter is an inference from the absence of a confirmed recovery estimate in the incident record; it is not a recovery prediction. [incident_log.json#INC-42] [runbook.md#customer-update-runbook]
