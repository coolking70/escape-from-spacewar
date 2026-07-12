// Replay 版本 / 规则集校验单元测试（纯 sim，无渲染 / DOM）。

import { ReplayConfig, FleetEntry } from './battleTypes';
import { encodeReplay, decodeReplay, KNOWN_RULESETS, REPLAY_VERSION_RULESET } from './replayCodec';
import { RULESET_V4, SIM_VERSION_V5 } from './battleConfig';
import { runSuite, Case, SuiteResult } from './testHarness';

function b64url(obj: unknown): string {
  const json = JSON.stringify(obj);
  // btoa/atob 在浏览器与 Node(>=16) 均为全局
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fleetEntry(cls: string, variant: string, n: number): FleetEntry[] {
  return [{ shipClass: cls as any, variant: variant as any, count: n }];
}
function rawReplay(v: string, ruleset?: string): string {
  const obj: any = {
    v,
    seed: 1,
    teamA: { fleet: fleetEntry('Fighter', 'standard', 1), formation: 'line', doctrine: 'balanced' },
    teamB: { fleet: fleetEntry('Fighter', 'standard', 1), formation: 'line', doctrine: 'balanced' }
  };
  if (ruleset) obj.ruleset = ruleset;
  return b64url(obj);
}

export function replayCompatibilityTests(): SuiteResult {
  return runSuite('replayCompatibility', (add) => {
    const c = new Case('version-ruleset-mapping');

    let threwUnsupported = false;
    try { decodeReplay(rawReplay('unsupported')); } catch { threwUnsupported = true; }
    c.true_(threwUnsupported, '非 v0.5 的录像版本被拒绝');

    // v0.5 默认 → core-v4
    c.eq(decodeReplay(rawReplay('0.5')).ruleset, RULESET_V4, 'v0.5 默认 → core-v4');

    // 未知 ruleset 必须报错，不能静默回退
    let threwUnknown = false;
    let unknownMsg = '';
    try {
      decodeReplay(rawReplay('0.5', 'spacewar-core-v99'));
    } catch (e) {
      threwUnknown = true;
      unknownMsg = String(e);
    }
    c.true_(threwUnknown, '未知 ruleset（core-v99）被拒绝');
    c.true_(unknownMsg.includes('不支持的战斗规则版本'), '未知 ruleset 错误信息明确');
    c.true_(unknownMsg.includes('spacewar-core-v99'), '错误信息包含具体未知 ruleset 标识');

    // 非支持版本即使携带当前规则集也必须拒绝。
    let threwMismatch = false;
    let mismatchMsg = '';
    try {
      decodeReplay(rawReplay('unsupported', RULESET_V4));
    } catch (e) {
      threwMismatch = true;
      mismatchMsg = String(e);
    }
    c.true_(threwMismatch, '非 v0.5 版本携带当前规则集仍被拒绝');
    c.true_(mismatchMsg.includes('不支持的录像版本'), '非支持版本错误信息明确');

    // 合法组合 v0.5+core-v4 不拒绝
    c.eq(decodeReplay(rawReplay('0.5', RULESET_V4)).ruleset, RULESET_V4, 'v0.5+core-v4 合法');

    // 往返一致
    const cfg: ReplayConfig = {
      v: SIM_VERSION_V5,
      ruleset: RULESET_V4,
      seed: 4242,
      budget: { mode: 'unlimited', limit: 999999 },
      teamA: { fleet: fleetEntry('Cruiser', 'fortress', 2), formation: 'wall', doctrine: 'defensive' },
      teamB: { fleet: fleetEntry('Fighter', 'interceptor', 4), formation: 'wedge', doctrine: 'aggressive' }
    };
    const code = encodeReplay(cfg);
    const dec = decodeReplay(code);
    c.eq(dec.ruleset, RULESET_V4, 'encode/decode 往返 ruleset 一致');
    c.eq(dec.seed, 4242, 'encode/decode 往返 seed 一致');
    c.eq(dec.v, SIM_VERSION_V5, 'encode/decode 往返 version 一致');
    c.eq(dec.teamA.fleet.length, 1, 'encode/decode 往返 fleet 保持');

    // 受支持集合仅 core-v4（唯一正式规则）
    c.eq(KNOWN_RULESETS.length, 1, '受支持 ruleset 仅 1 个（core-v4）');
    c.true_((KNOWN_RULESETS as string[]).includes(RULESET_V4), 'KNOWN_RULESETS 含 core-v4');
    c.eq(REPLAY_VERSION_RULESET['0.5'], RULESET_V4, '映射表 v0.5→core-v4');

    add(c);
  });
}
