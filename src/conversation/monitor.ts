// 小米音箱插件 - 对话监听器
// 翻译自 Go 源码: plugins/mimusic-plugin-xiaomi/conversation/monitor.go
// 定时轮询设备对话记录，支持回调通知和 Webhook 推送

/// <reference types="@mimusic/plugin-sdk" />

import { AccountManager } from '../account/manager';
import { ConfigManager } from '../config/manager';
import type { ConversationMessage, WebhookConfig } from '../types';
import { MinaHTTPClient } from '../mina/client';

// ===== 类型定义 =====

/** 内部回调函数类型 */
export type ConversationCallback = (msg: ConversationMessage) => void;

/** 设备监听状态 */
interface DeviceMonitorState {
  accountId: string;
  deviceId: string;
  deviceName: string;
  hardware: string;
  lastTimestampMs: number;
  isRunning: boolean;
}

/** 监听器状态 */
export interface MonitorStatus {
  enabled: boolean;
  messageCount: number;
  monitoredDevices: number;
  webhookCount: number;
}

// ===== ConversationMonitor =====

/**
 * ConversationMonitor - 对话记录监听器
 * 定时轮询所有 managed 设备的对话记录，检测新消息并触发回调/Webhook
 */
export class ConversationMonitor {
  private accountManager: AccountManager;
  private configManager: ConfigManager;

  /** 环形消息缓冲区 */
  private messages: ConversationMessage[] = [];
  private maxMessages: number = 200;

  /** 轮询定时器 */
  private pollTimer: any = null;
  private pollInterval: number = 10000; // 10秒

  /** 设备监听状态: "accountId:deviceId" → DeviceMonitorState */
  private devices: Map<string, DeviceMonitorState> = new Map();

  /** 内部回调（观察者模式） */
  private callbacks: Map<string, ConversationCallback> = new Map();

  /** 是否启用 */
  private enabled: boolean = false;

  constructor(accountManager: AccountManager, configManager: ConfigManager) {
    this.accountManager = accountManager;
    this.configManager = configManager;
  }

  // ===== 公开方法 =====

  /**
   * 启动对话监听
   * 遍历所有 managed 设备，启动定时轮询
   * @param onNewMessage - 可选的新消息回调（语音口令引擎使用）
   */
  start(onNewMessage?: ConversationCallback): void {
    if (this.enabled) {
      mimusic.log.info('[ConversationMonitor] Already running, skip start');
      return;
    }

    this.enabled = true;

    // 注册回调
    if (onNewMessage) {
      this.callbacks.set('__default__', onNewMessage);
    }

    // 初始化设备监听状态
    this.refreshDevices();

    // 启动定时轮询
    this.pollTimer = setInterval(() => {
      this.pollAll();
    }, this.pollInterval);

    mimusic.log.info(`[ConversationMonitor] Started, devices=${this.devices.size} interval=${this.pollInterval}ms`);
  }

  /**
   * 停止对话监听
   */
  stop(): void {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;

    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // 标记所有设备为停止
    for (const dm of this.devices.values()) {
      dm.isRunning = false;
    }

    mimusic.log.info(`[ConversationMonitor] Stopped, devices=${this.devices.size}`);
  }

  /**
   * 刷新设备列表：停止已移除设备的监听，启动新增设备的监听
   */
  refresh(): void {
    if (!this.enabled) {
      return;
    }
    this.refreshDevices();
  }

  /**
   * 注册内部回调（观察者模式）
   */
  registerCallback(name: string, cb: ConversationCallback): void {
    this.callbacks.set(name, cb);
    mimusic.log.info(`[ConversationMonitor] Callback registered: ${name}`);
  }

  /**
   * 取消内部回调
   */
  unregisterCallback(name: string): void {
    this.callbacks.delete(name);
    mimusic.log.info(`[ConversationMonitor] Callback unregistered: ${name}`);
  }

  /**
   * 获取消息记录（最近N条）
   * @param limit - 返回条数限制（默认50）
   * @param sinceTimestampMs - 只返回此时间戳之后的消息（默认0=全部）
   */
  getMessages(limit: number = 50, sinceTimestampMs: number = 0): ConversationMessage[] {
    let result = this.messages;

    // 按时间戳过滤
    if (sinceTimestampMs > 0) {
      result = result.filter(msg => msg.timestamp > sinceTimestampMs);
    }

    // 限制返回条数（取最新的）
    if (limit > 0 && result.length > limit) {
      result = result.slice(result.length - limit);
    }

    return result;
  }

  /**
   * 获取监听器状态
   */
  getStatus(): MonitorStatus {
    const webhooks = this.configManager.getWebhooks();
    return {
      enabled: this.enabled,
      messageCount: this.messages.length,
      monitoredDevices: this.devices.size,
      webhookCount: webhooks.length,
    };
  }

  /**
   * 是否已启用
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  // ===== 私有方法 =====

  /**
   * 刷新设备监听列表
   * 合并所有账号的 managed 设备
   */
  private refreshDevices(): void {
    const accounts = this.accountManager.getAccounts();

    // 构建当前 managed 设备的 key 集合
    const managedKeys = new Set<string>();
    const newDevices: Array<{ accountId: string; deviceId: string; deviceName: string; hardware: string }> = [];

    for (const acc of accounts) {
      const managed = this.accountManager.getManagedDevices(acc.id);
      for (const dev of managed) {
        const key = this.makeKey(acc.id, dev.device_id);
        managedKeys.add(key);
        if (!this.devices.has(key)) {
          newDevices.push({
            accountId: acc.id,
            deviceId: dev.device_id,
            deviceName: dev.device_name,
            hardware: dev.hardware,
          });
        }
      }
    }

    // 移除不再 managed 的设备
    for (const key of this.devices.keys()) {
      if (!managedKeys.has(key)) {
        this.devices.delete(key);
        mimusic.log.info(`[ConversationMonitor] Device removed from monitoring: ${key}`);
      }
    }

    // 添加新的 managed 设备
    for (const dev of newDevices) {
      const key = this.makeKey(dev.accountId, dev.deviceId);
      this.devices.set(key, {
        accountId: dev.accountId,
        deviceId: dev.deviceId,
        deviceName: dev.deviceName,
        hardware: dev.hardware,
        lastTimestampMs: Date.now(),
        isRunning: true,
      });
      mimusic.log.info(`[ConversationMonitor] Device added to monitoring: ${dev.deviceName} (${key})`);
    }
  }

  /**
   * 轮询所有设备的对话记录
   */
  private pollAll(): void {
    if (!this.enabled) {
      return;
    }

    for (const dm of this.devices.values()) {
      if (!dm.isRunning) continue;
      this.pollDevice(dm);
    }
  }

  /**
   * 轮询单个设备
   * 获取对话记录 → 时间戳去重 → 触发回调 → 推送 Webhook
   */
  private pollDevice(dm: DeviceMonitorState): void {
    // 获取 MinaHTTPClient
    const client = this.accountManager.getMinaClient(dm.accountId) as MinaHTTPClient | null;
    if (!client) {
      return;
    }

    // 获取对话记录
    let messages: ConversationMessage[];
    try {
      messages = client.getLatestAskFromXiaoai(dm.deviceId, dm.hardware, 5);
    } catch (e) {
      mimusic.log.warn(`[ConversationMonitor] Failed to get conversations: ${dm.deviceId} ${String(e)}`);
      return;
    }

    if (!messages || messages.length === 0) {
      return;
    }

    // 按时间戳去重：只保留比 lastTimestampMs 更新的消息
    const newMessages: ConversationMessage[] = [];
    let maxTimestamp = dm.lastTimestampMs;

    for (const msg of messages) {
      if (msg.timestamp > dm.lastTimestampMs) {
        newMessages.push(msg);
        if (msg.timestamp > maxTimestamp) {
          maxTimestamp = msg.timestamp;
        }
      }
    }

    if (newMessages.length === 0) {
      return;
    }

    // 更新最后时间戳
    dm.lastTimestampMs = maxTimestamp;

    // 追加到全局消息缓冲区
    for (const msg of newMessages) {
      this.addMessage(msg);
    }

    mimusic.log.info(`[ConversationMonitor] New messages account=${dm.accountId} device=${dm.deviceId} count=${newMessages.length}`);

    // 触发所有内部回调
    this.notifyCallbacks(newMessages);

    // 向所有 Webhook 推送
    this.triggerWebhooks(dm.accountId, dm.deviceId, dm.deviceName, newMessages);
  }

  /**
   * 添加消息到环形缓冲区
   */
  private addMessage(msg: ConversationMessage): void {
    this.messages.push(msg);
    // 超过容量时移除最旧的消息
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(this.messages.length - this.maxMessages);
    }
  }

  /**
   * 触发所有已注册的内部回调
   */
  private notifyCallbacks(messages: ConversationMessage[]): void {
    for (const [name, cb] of this.callbacks.entries()) {
      try {
        for (const msg of messages) {
          cb(msg);
        }
      } catch (e) {
        mimusic.log.error(`[ConversationMonitor] Callback error name=${name}: ${String(e)}`);
      }
    }
  }

  /**
   * 触发 Webhook 推送
   * 向所有已注册的 Webhook URL 发送 POST 请求
   */
  private triggerWebhooks(accountId: string, deviceId: string, deviceName: string, messages: ConversationMessage[]): void {
    const webhooks = this.configManager.getWebhooks();
    if (webhooks.length === 0) {
      return;
    }

    const payload = JSON.stringify({
      account_id: accountId,
      device_id: deviceId,
      device_name: deviceName,
      messages,
    });

    for (const wh of webhooks) {
      this.sendWebhook(wh, payload);
    }
  }

  /**
   * 向单个 Webhook URL 发送 POST 请求
   */
  private sendWebhook(wh: WebhookConfig, payload: string): void {
    try {
      const response = fetch(wh.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      // fetch 在 QuickJS 中是同步的，直接处理
      mimusic.log.info(`[ConversationMonitor] Webhook sent id=${wh.id} url=${wh.url}`);
    } catch (e) {
      mimusic.log.warn(`[ConversationMonitor] Webhook failed id=${wh.id} url=${wh.url}: ${String(e)}`);
    }
  }

  /**
   * 生成设备唯一键
   */
  private makeKey(accountId: string, deviceId: string): string {
    return accountId + ':' + deviceId;
  }
}
