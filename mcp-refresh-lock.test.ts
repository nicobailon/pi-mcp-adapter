import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"

import { acquireRefreshLock, withRefreshLock } from "./mcp-refresh-lock.ts"

function worker(baseDir: string) {
  const child = fork(new URL("./__tests__/fixtures/refresh-lock-worker.mjs", import.meta.url), [baseDir], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  return child
}

async function message(child: ReturnType<typeof worker>, expected: string) {
  const [result] = await once(child, "message") as [{ event: string; message?: string }]
  assert.equal(result.event, expected, result.message)
}

describe("mcp-refresh-lock", () => {
  it("cancels a waiter without cancelling the owner", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "mcp-refresh-lock-cancel-"))
    const owner = await acquireRefreshLock("server", baseDir)
    const controller = new AbortController()
    const reason = new Error("caller cancelled")
    try {
      const waiting = acquireRefreshLock("server", baseDir, controller.signal)
      controller.abort(reason)
      await assert.rejects(waiting, error => error === reason)
      const secondController = new AbortController()
      const second = acquireRefreshLock("server", baseDir, secondController.signal)
      secondController.abort(reason)
      await assert.rejects(second, error => error === reason)
    } finally {
      owner.release()
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it("releases on a transaction exception and permits a retry", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "mcp-refresh-lock-failure-"))
    try {
      const error = new Error("persistence failed")
      await assert.rejects(withRefreshLock("server", baseDir, async () => { throw error }), e => e === error)
      assert.equal(await withRefreshLock("server", baseDir, async () => "retried"), "retried")
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it("does not release an active transaction when its caller aborts", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "mcp-refresh-lock-owner-"))
    const controller = new AbortController()
    let finish!: () => void
    let started!: () => void
    const begun = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { finish = resolve })
    const owning = withRefreshLock("server", baseDir, async () => { started(); await gate }, controller.signal)
    await begun
    controller.abort()
    let entered = false
    const waiting = withRefreshLock("server", baseDir, async () => { entered = true })
    try {
      await delay(150)
      assert.equal(entered, false)
    } finally {
      finish()
      await owning
      await waiting
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it("serializes simultaneous processes through a shared critical-section sentinel", { timeout: 15000 }, async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "mcp-refresh-lock-processes-"))
    const children = Array.from({ length: 6 }, () => worker(baseDir))
    try {
      await Promise.all(children.map(child => message(child, "ready")))
      let active = 0
      let maximum = 0
      const completed = children.map(child => new Promise<void>((resolve, reject) => {
        child.on("message", (result: { event: string; message?: string }) => {
          if (result.event === "error") { reject(new Error(result.message)); return }
          if (result.event === "acquired") {
            maximum = Math.max(maximum, ++active)
            setTimeout(() => { active--; child.send("release") }, 40)
          } else if (result.event === "released") resolve()
        })
        child.on("error", reject)
      }))
      for (const child of children) child.send("acquire")
      await Promise.all(completed)
      assert.equal(maximum, 1)
    } finally {
      await Promise.all(children.map(async child => { const exited = once(child, "exit"); child.kill(); await exited }))
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it("releases kernel ownership after SIGKILL and preserves descriptor exclusion", { timeout: 15000 }, async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "mcp-refresh-lock-crash-"))
    const owner = worker(baseDir)
    try {
      await message(owner, "ready")
      const acquired = message(owner, "acquired")
      owner.send("acquire")
      await acquired
      const exited = once(owner, "exit")
      owner.kill("SIGKILL")
      await exited
      rmSync(join(baseDir, "critical-section"))
      // Two independent file descriptors must still exclude each other after owner death.
      const first = await acquireRefreshLock("shared", baseDir)
      let entered = false
      const next = withRefreshLock("shared", baseDir, async () => { entered = true })
      await delay(150)
      assert.equal(entered, false)
      first.release()
      await next
      assert.equal(entered, true)
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
      rmSync(baseDir, { recursive: true, force: true })
    }
  })
})
