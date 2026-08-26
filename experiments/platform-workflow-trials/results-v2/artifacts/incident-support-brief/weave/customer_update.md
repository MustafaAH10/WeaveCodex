# INC-42 customer update

The incident began at 2026-08-26T09:10:00Z. We are investigating an issue affecting the `media-rendering` service in `ap-southeast-1`. Render jobs remain queued for longer than 15 minutes. [incident_log.json#INC-42]

At 09:30Z, our on-call team confirmed elevated queue depth in `ap-southeast-1`. Existing jobs are retained, and no data loss has been observed. [status_history.md#09-30Z]

Root cause is unknown, and the investigation remains active. Inference: the elevated queue depth is consistent with the prolonged render-job queuing, but this does not confirm a cause. [incident_log.json#INC-42] [status_history.md#09-30Z]

The next update will be provided by 10:00Z. [status_history.md#09-30Z] [runbook.md#customer-update-runbook]
