import { runCampaignTests } from '../src/campaign/campaignTests';
import { runV07Tests } from '../src/campaign/v07Tests';
import { runV071Tests } from '../src/campaign/v071Tests';

const suites = [runCampaignTests(), runV07Tests(), runV071Tests()];
for (const suite of suites) console.log(suite.messages.join('\n'));
(globalThis as any).process.exit(suites.every((suite) => suite.passed) ? 0 : 1);
