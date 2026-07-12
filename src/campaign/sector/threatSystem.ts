import { SectorThreat } from './sectorTypes';
export function threatLevel(value: number): SectorThreat['level'] { return Math.min(5, Math.floor(Math.max(0, value) / 5)) as SectorThreat['level']; }
export function addThreat(threat: SectorThreat, amount: number): SectorThreat { const value = Math.max(0, threat.value + amount); return { value, level: threatLevel(value) }; }
