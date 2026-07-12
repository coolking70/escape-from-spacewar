import { createPRNG } from '../../sim/prng';
import type { CampaignCommander } from '../campaignTypes';
import type {
  CommanderAttributeKey,
  CommanderAttributes,
  CommanderDomain,
  CommanderDomainExperience,
  CommanderInjury,
  CommanderTraitId
} from './commanderTypes';

export type CompleteCampaignCommander = CampaignCommander & {
  attributes: CommanderAttributes;
  traits: CommanderTraitId[];
  domainExperience: CommanderDomainExperience;
  conditions: NonNullable<CampaignCommander['conditions']>;
  injuries: CommanderInjury[];
};

export const COMMANDER_ATTRIBUTE_LABEL: Record<CommanderAttributeKey, string> = {
  command: '指挥',
  tactics: '战术',
  logistics: '后勤',
  resolve: '意志'
};

export const COMMANDER_TRAIT_LABEL: Record<CommanderTraitId, string> = {
  cautious: '谨慎',
  bold: '果决',
  quartermaster: '军需官',
  survivor: '幸存者',
  scout: '侦察专家',
  inspiring: '鼓舞者'
};

export const COMMANDER_DOMAIN_LABEL: Record<CommanderDomain, string> = {
  combat: '战斗',
  exploration: '探索',
  logistics: '后勤',
  survival: '生存'
};

const ATTRIBUTE_KEYS: CommanderAttributeKey[] = ['command', 'tactics', 'logistics', 'resolve'];
const TRAITS: CommanderTraitId[] = ['cautious', 'bold', 'quartermaster', 'survivor', 'scout', 'inspiring'];

function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function profileSeed(seed: number, id: string): number {
  return (Math.imul(seed >>> 0, 2654435761) ^ hashText(id) ^ 0x80311a7) >>> 0;
}

function validAttributes(value: unknown): value is CommanderAttributes {
  const candidate = value as CommanderAttributes;
  return !!candidate && ATTRIBUTE_KEYS.every((key) => Number.isInteger(candidate[key]) && candidate[key] >= 1 && candidate[key] <= 10);
}

function validDomainExperience(value: unknown): value is CommanderDomainExperience {
  const candidate = value as CommanderDomainExperience;
  return !!candidate && (['combat', 'exploration', 'logistics', 'survival'] as CommanderDomain[]).every(
    (key) => Number.isFinite(candidate[key]) && candidate[key] >= 0
  );
}

export function createCommander(seed: number, name = '星域指挥官'): CompleteCampaignCommander {
  const id = `cmd-${seed >>> 0}`;
  const rng = createPRNG(profileSeed(seed, id));
  const attributes: CommanderAttributes = {
    command: 2 + rng.int(4),
    tactics: 2 + rng.int(4),
    logistics: 2 + rng.int(4),
    resolve: 2 + rng.int(4)
  };
  for (let point = 0; point < 4; point++) {
    const key = ATTRIBUTE_KEYS[rng.int(ATTRIBUTE_KEYS.length)];
    attributes[key] = Math.min(7, attributes[key] + 1);
  }
  const first = rng.int(TRAITS.length);
  let second = rng.int(TRAITS.length - 1);
  if (second >= first) second++;
  return {
    id,
    name: name.trim() || '星域指挥官',
    level: 1,
    experience: 0,
    alive: true,
    attributes,
    traits: [TRAITS[first], TRAITS[second]],
    domainExperience: { combat: 0, exploration: 0, logistics: 0, survival: 0 },
    conditions: [],
    injuries: []
  };
}

export function ensureCommanderProfile(commander: CampaignCommander, seed: number): CompleteCampaignCommander {
  const generated = createCommander(seed, commander?.name || '星域指挥官');
  const traits = Array.isArray(commander?.traits)
    ? commander.traits.filter((trait): trait is CommanderTraitId => TRAITS.includes(trait as CommanderTraitId)).slice(0, 2)
    : [];
  for (const trait of generated.traits) {
    if (traits.length >= 2) break;
    if (!traits.includes(trait)) traits.push(trait);
  }
  return {
    ...generated,
    ...commander,
    id: typeof commander?.id === 'string' && commander.id ? commander.id : generated.id,
    name: typeof commander?.name === 'string' && commander.name.trim() ? commander.name.trim() : generated.name,
    level: Number.isInteger(commander?.level) && commander.level >= 1 ? commander.level : generated.level,
    experience: Number.isFinite(commander?.experience) && commander.experience >= 0 ? commander.experience : 0,
    alive: typeof commander?.alive === 'boolean' ? commander.alive : true,
    attributes: validAttributes(commander?.attributes) ? { ...commander.attributes } : generated.attributes,
    traits,
    domainExperience: validDomainExperience(commander?.domainExperience)
      ? { ...commander.domainExperience }
      : generated.domainExperience,
    conditions: Array.isArray(commander?.conditions)
      ? commander.conditions.map((condition) => ({ ...condition }))
      : [],
    injuries: Array.isArray(commander?.injuries)
      ? commander.injuries.map((injury) => ({ ...injury }))
      : []
  };
}

export function gainCommanderDomainExperience(
  commander: CampaignCommander,
  seed: number,
  domain: CommanderDomain,
  amount: number
): CompleteCampaignCommander {
  const next = ensureCommanderProfile(commander, seed);
  const gained = Math.max(0, Math.floor(amount));
  next.domainExperience[domain] += gained;
  next.experience += gained;
  next.level = Math.max(next.level, 1 + Math.floor(next.experience / 100));
  return next;
}

export function killCommander(
  commander: CampaignCommander,
  seed: number,
  turn: number,
  cause: string
): CompleteCampaignCommander {
  const next = ensureCommanderProfile(commander, seed);
  next.alive = false;
  if (!next.injuries.some((injury) => injury.id === 'fatal')) {
    next.injuries.push({ id: 'fatal', severity: 3, acquiredTurn: Math.max(0, Math.floor(turn)), permanent: true, cause });
  }
  return next;
}

export function commanderProfileSignature(commander: CampaignCommander, seed: number): string {
  const profile = ensureCommanderProfile(commander, seed);
  return JSON.stringify({ attributes: profile.attributes, traits: profile.traits });
}
