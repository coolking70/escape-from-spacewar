export const CAMPAIGN_VERSION = '0.2' as const;
export const STARTING_RESOURCES = { supplies: 12, fuel: 8, materials: 0 };
export const STARTING_CARGO_CAPACITY = 18;
export const MAX_SECTOR_INDEX = 3;
// Keep the existing key so V0.6 local saves can be migrated in place.
export const CAMPAIGN_STORAGE_KEY = 'spacewar.campaign.current.v1';
export const SIGNAL_TEMPLATES = ['废弃补给舱', '受损商船', '可疑求救信号', '古代探测器', '漂流舰船残骸'] as const;
