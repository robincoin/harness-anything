// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleFixture } from "../store/task-lifecycle-fixture.ts";
import { reduceTaskEvent } from "../../src/domain/task-lifecycle-replay.ts";
import { emptyTaskLifecycleSnapshot } from "../../src/domain/task-lifecycle.contract.ts";
import { submissionDigest } from "../../src/domain/execution.ts";
import { reviewDigest } from "../../src/domain/review.ts";
import { closeoutReadiness } from "../../src/domain/closeout-readiness.ts";
import type { TaskEventV1 } from "../../src/domain/task-lifecycle-event.ts";

// A cut whose changes_requested verdict the owner disposed (review-consent override) completes
// through the command path; replay must accept the same completion or projection rebuild stalls.
function overriddenCut(withDisposition: boolean) {
  const { events } = lifecycleFixture();
  const completed = events.at(-1)! as TaskEventV1;
  assert.equal(completed.type, "task_completed");
  const reviewEvent = events.at(-3)! as Extract<TaskEventV1, { type: "review_recorded" }>;
  const consentEvent = events.at(-2)! as Extract<TaskEventV1, { type: "review_consent_recorded" }>;
  const review = { ...reviewEvent.payload.review, verdict: "changes_requested" as const };
  const current = reviewEvent.payload.execution;
  const digest = submissionDigest(current.submission!);
  const disposition = {
    schema: "review-disposition/v1" as const,
    dispositionId: "disposition-override",
    taskId: current.taskId,
    executionId: current.executionId,
    iteration: current.iteration,
    submissionDigest: digest,
    disposedReviewIds: [review.reviewId],
    rationale: "Owner accepts the cut over the requested changes.",
    actor: completed.actor,
    source: completed.source,
    disposedAt: consentEvent.occurredAt,
  };
  const stream = [
    ...events.slice(0, -3),
    { ...reviewEvent, payload: { ...reviewEvent.payload, review } },
    ...(withDisposition
      ? [
          {
            ...consentEvent,
            type: "review_consent_overridden" as const,
            payload: {
              ...consentEvent.payload,
              review,
              consent: { ...consentEvent.payload.consent, reviewDigest: reviewDigest(review) },
              disposition,
            },
          },
        ]
      : [
          {
            ...consentEvent,
            payload: {
              ...consentEvent.payload,
              review,
              consent: { ...consentEvent.payload.consent, reviewDigest: reviewDigest(review) },
            },
          },
        ]),
  ] as TaskEventV1[];
  const snapshot = stream.reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
  assert.equal(
    closeoutReadiness(snapshot, undefined, completed.payload.closeoutGates).readiness,
    withDisposition ? "ready" : "incomplete",
  );
  return { snapshot, completed };
}

test("replay accepts a completion whose changes_requested review the owner disposed on this cut", () => {
  const { snapshot, completed } = overriddenCut(true);
  const replayed = reduceTaskEvent(snapshot, completed);
  assert.equal(replayed.task?.status, "done");
  assert.equal(replayed.executions.at(-1)?.state, "accepted");
});

test("replay still rejects a completion over an undisposed changes_requested review", () => {
  const { snapshot, completed } = overriddenCut(false);
  assert.throws(() => reduceTaskEvent(snapshot, completed), /accepted task and execution state/);
});
