/// <reference lib="webworker" />
// 平衡实验室 Web Worker：在独立线程中纯 sim 批量跑（无渲染），汇报进度与结果。
// 与主线程共享 balanceRunner，因此 Worker 与主线程产出的统计完全一致。

import { runBalance, BalanceRunConfig, BalanceResult } from './balanceRunner';

export interface BalanceWorkerRunMsg {
  type: 'run';
  config: BalanceRunConfig;
}
export interface BalanceWorkerProgressMsg {
  type: 'progress';
  done: number;
  total: number;
}
export interface BalanceWorkerDoneMsg {
  type: 'done';
  result: BalanceResult;
}
export type BalanceWorkerOutMsg = BalanceWorkerProgressMsg | BalanceWorkerDoneMsg;

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<BalanceWorkerRunMsg>) => {
  const msg = e.data;
  if (msg.type === 'run') {
    const result = runBalance(msg.config, (done, total) => {
      ctx.postMessage({ type: 'progress', done, total } as BalanceWorkerProgressMsg);
    });
    ctx.postMessage({ type: 'done', result } as BalanceWorkerDoneMsg);
  }
};
