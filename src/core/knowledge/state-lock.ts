import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 跨进程状态锁。
 *
 * 锁顺序约定（避免死锁）：
 *   1. node-write  — 节点 markdown 写入（govern.ts 与 crystallize.ts 共用）
 *   2. user-memory — state/user-memory.json
 *   3. usage-index — state/usage-index.json
 *   4. runtime-state — state/runtime-state.json
 *
 * 任何模块持有多把锁时必须按上述顺序申请；释放顺序任意。
 */

const STATE_LOCK_RETRIES = 50;
const STATE_LOCK_RETRY_MS = 20;
const STATE_LOCK_STALE_MS = 30_000;

export async function withStateLock<T>(
  knowledgeRoot: string,
  lockName: string,
  callback: () => Promise<T>
): Promise<T> {
  const lockPath = path.join(knowledgeRoot, "state", `.${lockName}.lock`);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  let attempt = 0;
  while (attempt <= STATE_LOCK_RETRIES) {
    try {
      await fs.mkdir(lockPath);
      await writeLockMetadata(lockPath);
      try {
        return await callback();
      } finally {
        await fs.rm(lockPath, { recursive: true, force: true });
      }
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      // 每次失败都走 backoff，避免多 waiter 在 stale 清理后 tight loop。
      await removeStaleLockIfDead(lockPath);
      if (attempt === STATE_LOCK_RETRIES) {
        throw new Error(`状态写入锁等待超时: ${lockPath}`);
      }
      attempt += 1;
      await delay(STATE_LOCK_RETRY_MS);
    }
  }
  throw new Error(`状态写入锁循环退出（不应到达）: ${lockPath}`);
}

async function writeLockMetadata(lockPath: string) {
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      created_at: new Date().toISOString()
    }, null, 2)}\n`,
    "utf8"
  );
}

async function removeStaleLockIfDead(lockPath: string): Promise<boolean> {
  const owner = await readLockOwner(lockPath);

  if (owner) {
    const ownedByThisHost = !owner.host || owner.host === os.hostname();
    if (ownedByThisHost && typeof owner.pid === "number" && isProcessAlive(owner.pid)) {
      return false;
    }
    if (!ownedByThisHost) {
      // 跨机器无法确认进程存活，回退到 mtime 超时判定
      const stats = await fs.stat(lockPath).catch(() => null);
      if (!stats || Date.now() - stats.mtimeMs <= STATE_LOCK_STALE_MS) {
        return false;
      }
    }
  } else {
    // owner.json 不可读：可能是刚 mkdir 还没写完 metadata，也可能是崩溃留下的孤儿锁。
    // 用 mtime 兜底判断，避免新建锁被立刻清掉。
    const stats = await fs.stat(lockPath).catch(() => null);
    if (!stats || Date.now() - stats.mtimeMs <= STATE_LOCK_STALE_MS) {
      return false;
    }
  }

  // 通过 rename 抢占式清理：只有当目录仍是我们刚才看到的那一把锁时才会删成功。
  const tombstone = `${lockPath}.stale-${process.pid}-${Date.now()}`;
  try {
    await fs.rename(lockPath, tombstone);
  } catch (error: any) {
    if (error.code === "ENOENT" || error.code === "ENOTEMPTY") {
      return false;
    }
    throw error;
  }
  await fs.rm(tombstone, { recursive: true, force: true });
  return true;
}

async function readLockOwner(lockPath: string): Promise<{ pid?: number; host?: string } | null> {
  try {
    const raw = await fs.readFile(path.join(lockPath, "owner.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM 表示进程存在但不属于当前用户，仍视为存活
    return error.code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
