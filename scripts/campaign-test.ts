import { runCampaignTests } from '../src/campaign/campaignTests';
import { runV07Tests } from '../src/campaign/v07Tests';

const suites = [runCampaignTests(), runV07Tests()];
for (const suite of suites) console.log(suite.messages.join('\n'));
(globalThis as any).process.exit(suites.every((suite) => suite.passed) ? 0 : 1);
