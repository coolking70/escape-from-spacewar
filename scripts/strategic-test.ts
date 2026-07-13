import { runStrategicTests } from '../src/strategy/strategicTests';

const suite = runStrategicTests();
console.log(suite.messages.join('\n'));
(globalThis as any).process.exit(suite.passed ? 0 : 1);
