export type CommanderAttributeKey = 'command' | 'tactics' | 'logistics' | 'resolve';

export interface CommanderAttributes {
  command: number;
  tactics: number;
  logistics: number;
  resolve: number;
}

export type CommanderTraitId =
  | 'cautious'
  | 'bold'
  | 'quartermaster'
  | 'survivor'
  | 'scout'
  | 'inspiring';

export type CommanderDomain = 'combat' | 'exploration' | 'logistics' | 'survival';

export interface CommanderDomainExperience {
  combat: number;
  exploration: number;
  logistics: number;
  survival: number;
}

export type CommanderConditionId = 'fatigued' | 'shaken' | 'wounded' | 'scarred';

export interface CommanderCondition {
  id: CommanderConditionId;
  severity: 1 | 2 | 3;
  remainingTurns: number;
}

export type CommanderInjuryId = 'wound' | 'burn' | 'fracture' | 'trauma' | 'fatal';

export interface CommanderInjury {
  id: CommanderInjuryId;
  severity: 1 | 2 | 3;
  acquiredTurn: number;
  permanent: boolean;
  cause?: string;
}
