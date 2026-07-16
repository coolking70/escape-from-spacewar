import './style.css';
import './v071.css';
import './v081.css';
import './v09.css';
import './v10.css';
import './v10menu.css';
import './v10-sector.css';
import { App } from './App';
import { installCampaignRuntimeControls } from './campaign/fleet/campaignRuntimeControls';

// 浏览器调试钩子只在开发服务器中加载。生产构建和静态发布不应携带测试套件。
if (import.meta.env.DEV) {
  void import('./devTestHooks');
}

const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 容器');
const app = new App(root);
app.start();
installCampaignRuntimeControls(app);
(window as unknown as { render_game_to_text: () => string; advanceTime: (ms: number) => void }).render_game_to_text = () => JSON.stringify(app.campaignDebugState());
(window as unknown as { advanceTime: (ms: number) => void }).advanceTime = () => {};
