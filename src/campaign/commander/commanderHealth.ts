import type { CampaignCommander } from '../campaignTypes';
import type { CommanderConditionId, CommanderInjuryId } from './commanderTypes';
import { ensureCommanderProfile, type CompleteCampaignCommander } from './commanderSystem';

export const COMMANDER_CONDITION_LABEL: Record<CommanderConditionId, string> = {
  fatigued: '疲劳',
  shaken: '动摇',
  wounded: '负伤',
  scarred: '创伤后遗症'
};

export const COMMANDER_INJURY_LABEL: Record<CommanderInjuryId, string> = {
  wound: '伤口',
  burn: '烧伤',
  fracture: '骨折',
  trauma: '严重创伤',
  fatal: '致命伤'
};

export function isCommanderIncapacitated(commander: CampaignCommander, seed: number): boolean {
  const profile = ensureCommanderProfile(commander, seed);
  return profile.alive && profile.injuries.some((injury) => injury.id !== 'fatal' && injury.severity >= 3);
}

export function isCommanderAvailable(commander: CampaignCommander, seed: number): boolean {
  const profile = ensureCommanderProfile(commander, seed);
  return profile.alive && !isCommanderIncapacitated(profile, seed);
}

export function commanderSupplyUpkeepModifier(commander: CampaignCommander, seed: number): number {
  const profile = ensureCommanderProfile(commander, seed);
  const fatigue = profile.conditions.find((condition) => condition.id === 'fatigued')?.severity ?? 0;
  const quartermaster = profile.traits.includes('quartermaster') ? 1 : 0;
  const logistics = profile.attributes.logistics >= 6 ? 1 : 0;
  return Math.max(-1, fatigue - quartermaster - logistics);
}

export function commanderEvadeModifier(commander: CampaignCommander, seed: number): number {
  const profile = ensureCommanderProfile(commander, seed);
  let value = (profile.attributes.tactics - 4) * 2 + (profile.attributes.resolve - 4);
  if (profile.traits.includes('scout')) value += 10;
  if (profile.traits.includes('cautious')) value += 5;
  if (profile.traits.includes('bold')) value -= 5;
  if (profile.traits.includes('inspiring')) value += 3;
  for (const condition of profile.conditions) {
    if (condition.id === 'shaken') value -= condition.severity * 10;
    if (condition.id === 'fatigued') value -= condition.severity * 3;
    if (condition.id === 'wounded') value -= condition.severity * 5;
  }
  for (const injury of profile.injuries) {
    if (injury.id !== 'fatal') value -= injury.severity * 4;
  }
  return value;
}

export function tickCommanderConditions(
  commander: CampaignCommander,
  seed: number,
  turns = 1
): CompleteCampaignCommander {
  const next = ensureCommanderProfile(commander, seed);
  next.conditions = next.conditions
    .map((condition) => ({ ...condition, remainingTurns: Math.max(0, condition.remainingTurns - Math.max(0, turns)) }))
    .filter((condition) => condition.remainingTurns > 0 || condition.id === 'scarred');
  return next;
}

export function addCommanderCondition(
  commander: CampaignCommander,
  seed: number,
  id: CommanderConditionId,
  severity: 1 | 2 | 3,
  remainingTurns: number
): CompleteCampaignCommander {
  const next = ensureCommanderProfile(commander, seed);
  const existing = next.conditions.find((condition) => condition.id === id);
  if (existing) {
    existing.severity = Math.max(existing.severity, severity) as 1 | 2 | 3;
    existing.remainingTurns = Math.max(existing.remainingTurns, remainingTurns);
  } else {
    next.conditions.push({ id, severity, remainingTurns: Math.max(1, Math.floor(remainingTurns)) });
  }
  return next;
}

export function addCommanderInjury(
  commander: CampaignCommander,
  seed: number,
  id: Exclude<CommanderInjuryId, 'fatal'>,
  severity: 1 | 2 | 3,
  turn: number,
  cause: string
): CompleteCampaignCommander {
  const next = ensureCommanderProfile(commander, seed);
  const existing = next.injuries.find((injury) => injury.id === id);
  if (existing) {
    existing.severity = Math.max(existing.severity, severity) as 1 | 2 | 3;
    existing.cause = cause;
  } else {
    next.injuries.push({ id, severity, acquiredTurn: Math.max(0, Math.floor(turn)), permanent: severity >= 3, cause });
  }
  return next;
}

export function applyBattleCommanderConsequences(
  commander: CampaignCommander,
  seed: number,
  turn: number,
  shipsLost: number,
  victory: boolean
): CompleteCampaignCommander {
  let next = ensureCommanderProfile(commander, seed);
  if (!victory) next = addCommanderCondition(next, seed, 'shaken', shipsLost >= 2 ? 2 : 1, 5);
  if (shipsLost > 0) next = addCommanderCondition(next, seed, 'fatigued', shipsLost >= 2 ? 2 : 1, 4);
  if (shipsLost >= 2) {
    next = addCommanderInjury(next, seed, 'trauma', victory ? 2 : 3, turn, victory ? '惨烈胜利' : '战斗失利');
  }
  return next;
}

export interface CommanderTreatmentResult {
  commander: CompleteCampaignCommander;
  text: string;
}

export function treatCommander(commander: CampaignCommander, seed: number): CommanderTreatmentResult | null {
  const next = ensureCommanderProfile(commander, seed);
  const injury = [...next.injuries]
    .filter((item) => item.id !== 'fatal')
    .sort((left, right) => right.severity - left.severity)[0];
  if (injury) {
    if (injury.severity > 1) injury.severity = (injury.severity - 1) as 1 | 2;
    else next.injuries = next.injuries.filter((item) => item !== injury || item.permanent);
    injury.permanent = injury.severity >= 3;
    return { commander: next, text: `治疗${COMMANDER_INJURY_LABEL[injury.id]}，严重度降至 ${injury.severity}。` };
  }
  const condition = [...next.conditions]
    .filter((item) => item.id !== 'scarred')
    .sort((left, right) => right.severity - left.severity)[0];
  if (!condition) return null;
  if (condition.severity > 1) condition.severity = (condition.severity - 1) as 1 | 2;
  else next.conditions = next.conditions.filter((item) => item !== condition);
  return { commander: next, text: `缓解${COMMANDER_CONDITION_LABEL[condition.id]}状态。` };
}
