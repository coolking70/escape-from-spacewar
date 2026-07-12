export type OrganizationArchetype = 'expedition' | 'military' | 'commerce' | 'exile';

export type GovernmentType =
  | 'militaryCouncil'
  | 'captainsAssembly'
  | 'corporateBoard'
  | 'technocracy'
  | 'emergencyDirectorate';

export type OrganizationValue = 'order' | 'freedom' | 'survival' | 'expansion' | 'knowledge' | 'profit' | 'unity';

export interface OrganizationReputation {
  civilian: number;
  military: number;
  frontier: number;
}

export type ResearchResourceKey = 'navigation' | 'engineering' | 'tactical' | 'social';

export interface ResearchResources {
  navigation: number;
  engineering: number;
  tactical: number;
  social: number;
}

export type TechnologyId =
  | 'jumpCalibration'
  | 'modularCargo'
  | 'fieldRepairProtocol'
  | 'deepSensorArray'
  | 'retreatCoordination'
  | 'traumaCare';

export interface ResearchState {
  resources: ResearchResources;
  unlocked: TechnologyId[];
  installed: TechnologyId[];
  slots: number;
}

export interface CampaignOrganization {
  id: string;
  name: string;
  archetype: OrganizationArchetype;
  government: GovernmentType;
  values: OrganizationValue[];
  stability: number;
  reputation: OrganizationReputation;
  research: ResearchState;
}

export interface OrganizationCreationOptions {
  name: string;
  archetype: OrganizationArchetype;
  government: GovernmentType;
  values: OrganizationValue[];
}

export interface OrganizationEventEffect {
  stability?: number;
  reputation?: Partial<OrganizationReputation>;
  research?: Partial<ResearchResources>;
  supplies?: number;
  fuel?: number;
  materials?: number;
  threat?: number;
}

export interface OrganizationEventOption {
  id: string;
  label: string;
  description: string;
  requiredValue?: OrganizationValue;
  effect: OrganizationEventEffect;
}

export interface PendingOrganizationEvent {
  id: string;
  title: string;
  description: string;
  options: OrganizationEventOption[];
}
