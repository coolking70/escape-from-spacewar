import { runCampaignTests } from '../src/campaign/campaignTests';
const result = runCampaignTests();
console.log(result.messages.join('\n'));
(globalThis as any).process.exit(result.passed ? 0 : 1);
