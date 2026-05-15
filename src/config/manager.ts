// 小米音箱插件 - 配置管理器
// 基于 mimusic.storage API 实现配置持久化

/// <reference types="@mimusic/plugin-sdk" />

import type {
  PluginConfig,
  AccountConfig,
  DeviceConfig,
  WebhookConfig,
  VoiceCommand,
  ScheduledTask,
  TaskLog,
} from '../types';

// ===== 存储键常量 =====
const STORAGE_KEY_CONFIG = 'config';
const STORAGE_KEY_ACCOUNTS = 'accounts';
const STORAGE_KEY_WEBHOOKS = 'webhooks';
const STORAGE_KEY_VOICE_COMMANDS = 'voice_commands';
const STORAGE_KEY_SCHEDULED_TASKS = 'scheduled_tasks';
const STORAGE_KEY_SCHEDULE_LOGS = 'schedule_logs';

/** 日志最大条数（环形缓冲） */
const MAX_SCHEDULE_LOGS = 200;

/** 默认插件配置 */
function defaultPluginConfig(): PluginConfig {
  return {
    version: '1.0',
    server_host: '',
    timezone: 'Asia/Shanghai',
    conversation_monitor_enabled: false,
    voice_command_enabled: false,
    scheduled_tasks_enabled: false,
  };
}

/**
 * 配置管理器
 * 使用 mimusic.storage API 实现分键持久化存储
 */
export class ConfigManager {

  // ===== 通用存储读写 =====

  /** 从storage读取JSON数据，不存在则返回默认值 */
  private load<T>(key: string, defaultValue: T): T {
    const raw = mimusic.storage.get(key);
    if (raw === null || raw === undefined || raw === '') {
      return defaultValue;
    }
    try {
      return JSON.parse(raw as string) as T;
    } catch {
      return defaultValue;
    }
  }

  /** 将JSON数据写入storage */
  private save<T>(key: string, value: T): void {
    mimusic.storage.set(key, JSON.stringify(value));
  }

  // ===== 全局配置 =====

  /** 获取插件全局配置 */
  getConfig(): PluginConfig {
    return this.load<PluginConfig>(STORAGE_KEY_CONFIG, defaultPluginConfig());
  }

  /** 保存插件全局配置 */
  saveConfig(config: PluginConfig): void {
    this.save(STORAGE_KEY_CONFIG, config);
  }

  // ===== 账号管理（存储层） =====

  /** 获取所有账号配置 */
  getAccounts(): AccountConfig[] {
    return this.load<AccountConfig[]>(STORAGE_KEY_ACCOUNTS, []);
  }

  /** 保存所有账号配置 */
  saveAccounts(accounts: AccountConfig[]): void {
    this.save(STORAGE_KEY_ACCOUNTS, accounts);
  }

  /** 按ID获取单个账号配置 */
  getAccount(accountId: string): AccountConfig | null {
    const accounts = this.getAccounts();
    return accounts.find(a => a.id === accountId) ?? null;
  }

  /** 添加账号配置（追加） */
  addAccount(account: AccountConfig): void {
    const accounts = this.getAccounts();
    // 检查是否已存在
    if (accounts.some(a => a.id === account.id)) {
      throw new Error(`Account already exists: ${account.id}`);
    }
    accounts.push(account);
    this.saveAccounts(accounts);
  }

  /** 更新账号配置（按ID匹配并合并字段） */
  updateAccount(accountId: string, updates: Partial<AccountConfig>): void {
    const accounts = this.getAccounts();
    const idx = accounts.findIndex(a => a.id === accountId);
    if (idx === -1) {
      throw new Error(`Account not found: ${accountId}`);
    }
    accounts[idx] = { ...accounts[idx], ...updates, updated_at: new Date().toISOString() };
    this.saveAccounts(accounts);
  }

  /** 删除账号配置 */
  removeAccount(accountId: string): void {
    const accounts = this.getAccounts();
    const filtered = accounts.filter(a => a.id !== accountId);
    if (filtered.length === accounts.length) {
      throw new Error(`Account not found: ${accountId}`);
    }
    this.saveAccounts(filtered);
  }

  // ===== 设备管理（存储层） =====

  /** 获取某账号的设备列表 */
  getDevices(accountId: string): DeviceConfig[] {
    const account = this.getAccount(accountId);
    return account?.devices ?? [];
  }

  /** 更新某账号下特定设备的配置 */
  updateDevice(accountId: string, deviceId: string, updates: Partial<DeviceConfig>): void {
    const accounts = this.getAccounts();
    const accIdx = accounts.findIndex(a => a.id === accountId);
    if (accIdx === -1) {
      throw new Error(`Account not found: ${accountId}`);
    }
    const devIdx = accounts[accIdx].devices.findIndex(d => d.device_id === deviceId);
    if (devIdx === -1) {
      throw new Error(`Device not found: ${deviceId}`);
    }
    accounts[accIdx].devices[devIdx] = { ...accounts[accIdx].devices[devIdx], ...updates };
    accounts[accIdx].updated_at = new Date().toISOString();
    this.saveAccounts(accounts);
  }

  /** 设置账号最后选中的设备 */
  setLastSelectedDevice(accountId: string, deviceId: string): void {
    this.updateAccount(accountId, { last_selected_device_id: deviceId });
  }

  // ===== Webhook管理 =====

  /** 获取所有Webhook配置 */
  getWebhooks(): WebhookConfig[] {
    return this.load<WebhookConfig[]>(STORAGE_KEY_WEBHOOKS, []);
  }

  /** 保存所有Webhook配置 */
  saveWebhooks(webhooks: WebhookConfig[]): void {
    this.save(STORAGE_KEY_WEBHOOKS, webhooks);
  }

  /** 添加Webhook */
  addWebhook(webhook: WebhookConfig): void {
    const webhooks = this.getWebhooks();
    if (webhooks.some(w => w.id === webhook.id)) {
      throw new Error(`Webhook already exists: ${webhook.id}`);
    }
    webhooks.push(webhook);
    this.saveWebhooks(webhooks);
  }

  /** 删除Webhook */
  removeWebhook(webhookId: string): void {
    const webhooks = this.getWebhooks();
    const filtered = webhooks.filter(w => w.id !== webhookId);
    if (filtered.length === webhooks.length) {
      throw new Error(`Webhook not found: ${webhookId}`);
    }
    this.saveWebhooks(filtered);
  }

  // ===== 语音口令 =====

  /** 获取语音口令配置 */
  getVoiceCommands(): VoiceCommand[] {
    return this.load<VoiceCommand[]>(STORAGE_KEY_VOICE_COMMANDS, []);
  }

  /** 保存语音口令配置 */
  saveVoiceCommands(commands: VoiceCommand[]): void {
    this.save(STORAGE_KEY_VOICE_COMMANDS, commands);
  }

  // ===== 定时任务 =====

  /** 获取所有定时任务 */
  getScheduledTasks(): ScheduledTask[] {
    return this.load<ScheduledTask[]>(STORAGE_KEY_SCHEDULED_TASKS, []);
  }

  /** 保存所有定时任务 */
  saveScheduledTasks(tasks: ScheduledTask[]): void {
    this.save(STORAGE_KEY_SCHEDULED_TASKS, tasks);
  }

  /** 添加定时任务 */
  addScheduledTask(task: ScheduledTask): void {
    const tasks = this.getScheduledTasks();
    if (tasks.some(t => t.id === task.id)) {
      throw new Error(`Scheduled task already exists: ${task.id}`);
    }
    tasks.push(task);
    this.saveScheduledTasks(tasks);
  }

  /** 更新定时任务（按ID匹配并合并字段） */
  updateScheduledTask(taskId: string, updates: Partial<ScheduledTask>): void {
    const tasks = this.getScheduledTasks();
    const idx = tasks.findIndex(t => t.id === taskId);
    if (idx === -1) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    tasks[idx] = { ...tasks[idx], ...updates, updated_at: new Date().toISOString() };
    this.saveScheduledTasks(tasks);
  }

  /** 删除定时任务 */
  removeScheduledTask(taskId: string): void {
    const tasks = this.getScheduledTasks();
    const filtered = tasks.filter(t => t.id !== taskId);
    if (filtered.length === tasks.length) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    this.saveScheduledTasks(filtered);
  }

  // ===== 执行日志 =====

  /** 获取所有执行日志 */
  getScheduleLogs(): TaskLog[] {
    return this.load<TaskLog[]>(STORAGE_KEY_SCHEDULE_LOGS, []);
  }

  /** 添加执行日志（环形缓冲，最多200条，超出删除最旧的） */
  addScheduleLog(log: TaskLog): void {
    const logs = this.getScheduleLogs();
    logs.push(log);
    // 超过上限时移除最旧的条目
    while (logs.length > MAX_SCHEDULE_LOGS) {
      logs.shift();
    }
    this.save(STORAGE_KEY_SCHEDULE_LOGS, logs);
  }
}
