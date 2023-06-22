/**
 * Tests the client and worker functionality for the worker versioning feature.
 *
 * @module
 */
import test from "ava";
import { v4 as uuid4 } from "uuid";
import { WorkflowClient } from "@temporalio/client";
import { DefaultLogger, Runtime } from "@temporalio/worker";
import { RUN_INTEGRATION_TESTS } from "./helpers";
import assert from "assert";

if (RUN_INTEGRATION_TESTS) {
  test.before(async () => {
    Runtime.install({ logger: new DefaultLogger("DEBUG") });
  });

  test("Worker versioning client updates", async (t) => {
    const taskQueue = "worker-versioning-client-updates-" + uuid4();
    const conn = new WorkflowClient();

    await conn.updateWorkerBuildIdCompatability(taskQueue, {
      operation: "NEW_ID_IN_NEW_DEFAULT_SET",
      buildId: "1.0"
    });
    let resp = await conn.getWorkerBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId(), "1.0");

    await conn.updateWorkerBuildIdCompatability(taskQueue, {
      operation: "NEW_COMPATIBLE_VERSION",
      buildId: "1.1",
      existingCompatibleBuildId: "1.0"
    });
    resp = await conn.getWorkerBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId(), "1.1");

    // Target nonexistent build ID
    await t.throwsAsync(
      conn.updateWorkerBuildIdCompatability(taskQueue, {
      operation: "NEW_COMPATIBLE_VERSION",
      buildId: "1.2",
      existingCompatibleBuildId: "amnotreal"
    }),
      { message: /amnotreal not found/ }
    );

    await conn.updateWorkerBuildIdCompatability(taskQueue, {
      operation: "PROMOTE_BUILD_ID_WITHIN_SET",
      buildId: "1.0"
    });
    resp = await conn.getWorkerBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId(), "1.0");

    await conn.updateWorkerBuildIdCompatability(taskQueue, {
      operation: "NEW_ID_IN_NEW_DEFAULT_SET",
      buildId: "2.0"
    });
    resp = await conn.getWorkerBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId(), "2.0");

    await conn.updateWorkerBuildIdCompatability(taskQueue, {
      operation: "PROMOTE_SET_BY_BUILD_ID",
      buildId: "1.0"
    });
    resp = await conn.getWorkerBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId(), "1.0");

    await conn.updateWorkerBuildIdCompatability(taskQueue, {
      operation: "MERGE_SETS",
      primaryBuildId: "2.0",
      secondaryBuildId: "1.0"
    });
    resp = await conn.getWorkerBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId(), "2.0");

    t.pass();
  });
}
