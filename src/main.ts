import { createRouter } from '@mimusic/plugin-sdk';
import type { HTTPRequest, HTTPResponse } from '@mimusic/plugin-sdk';
import { ConfigManager } from './config/manager';
import { AccountManager } from './account/manager';
import { AuthService } from './auth/service';
import { MinaService } from './service/service';
import { PlaylistManagerMap } from './player/manager';
import { Scheduler } from './schedule/scheduler';
import { TaskExecutor } from './schedule/executor';
import { ConversationMonitor } from './conversation/monitor';
import { VoiceEngine } from './voicecmd/engine';
import { IndexingManager } from './indexing/manager';

// 导入所有handler注册函数
import { registerAccountHandlers } from './handlers/account';
import { registerAuthHandlers } from './handlers/auth';
import { registerDeviceHandlers } from './handlers/device';
import { registerPlaylistHandlers } from './handlers/playlist';
import { registerConfigHandlers } from './handlers/config';
import { registerConversationHandlers } from './handlers/conversation';
import { registerScheduleHandlers } from './handlers/schedule';
import { registerVoiceCommandHandlers } from './handlers/voice_command';
import { registerIndexingHandlers } from './handlers/indexing';

const router = createRouter();

// 全局服务实例
let configManager: ConfigManager;
let accountManager: AccountManager;
let authService: AuthService;
let minaService: MinaService;
let playlistManagerMap: PlaylistManagerMap;
let scheduler: Scheduler;
let conversationMonitor: ConversationMonitor;
let voiceEngine: VoiceEngine;
let indexingManager: IndexingManager;

function onInit(): void {
  mimusic.log.info('小米音箱插件初始化...');

  // 初始化管理器
  configManager = new ConfigManager();
  accountManager = new AccountManager(configManager);
  accountManager.init();

  indexingManager = new IndexingManager();
  authService = new AuthService(configManager, accountManager);
  minaService = new MinaService(accountManager, configManager);
  playlistManagerMap = new PlaylistManagerMap(minaService, configManager);

  const executor = new TaskExecutor(configManager, accountManager, minaService, playlistManagerMap, indexingManager);
  scheduler = new Scheduler(configManager, executor);

  voiceEngine = new VoiceEngine(configManager, accountManager, minaService, playlistManagerMap, indexingManager);
  conversationMonitor = new ConversationMonitor(accountManager, configManager);

  // 注册所有路由
  registerAccountHandlers(router, accountManager, authService);
  registerAuthHandlers(router, authService, accountManager);
  registerDeviceHandlers(router, minaService, accountManager);
  registerPlaylistHandlers(router, playlistManagerMap, minaService, configManager);
  registerConfigHandlers(router, configManager, conversationMonitor, scheduler);
  registerConversationHandlers(router, conversationMonitor, configManager);
  registerScheduleHandlers(router, scheduler, configManager);
  registerVoiceCommandHandlers(router, configManager);
  registerIndexingHandlers(router, indexingManager);

  // 自动登录 + 启动后台服务
  authService.autoLoginAll();
  indexingManager.refresh();

  // 根据配置启动后台服务
  const config = configManager.getConfig();
  if (config.scheduled_tasks_enabled) {
    scheduler.start();
  }
  if (config.conversation_monitor_enabled) {
    conversationMonitor.start((msg) => {
      if (config.voice_command_enabled) {
        voiceEngine.handleMessage(msg);
      }
    });
  }
  if (config.voice_command_enabled) {
    voiceEngine.setEnabled(true);
  }

  mimusic.log.info('小米音箱插件初始化完成');
}

function onDeinit(): void {
  mimusic.log.info('小米音箱插件停止...');
  scheduler?.stop();
  conversationMonitor?.stop();
  playlistManagerMap?.cleanup();
  authService?.cleanup();
  mimusic.log.info('小米音箱插件已停止');
}

function onHTTPRequest(req: HTTPRequest): HTTPResponse {
  return router.handle(req);
}

// 暴露为全局（QuickJS 需要显式声明）
globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
