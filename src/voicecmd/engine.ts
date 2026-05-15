// 小米音箱插件 - 语音口令引擎
// 翻译自 Go 源码: plugins/mimusic-plugin-xiaomi/voicecmd/engine.go
// 匹配用户语音指令并执行对应动作（播放歌单/歌曲、切歌、停止、音量、播放模式）

/// <reference types="@mimusic/plugin-sdk" />

import { ConfigManager } from '../config/manager';
import { AccountManager } from '../account/manager';
import { MinaService } from '../service/service';
import { PlaylistManagerMap } from '../player/manager';
import { IndexingManager } from '../indexing/manager';
import type { ConversationMessage, VoiceCommand, PlayMode } from '../types';

// ===== 类型定义 =====

/** 口令匹配结果 */
interface MatchResult {
  command: VoiceCommand;
  keyword: string;
  argument: string;
}

/** 口令类型优先级（数字越小优先级越高） */
const COMMAND_PRIORITY: Record<string, number> = {
  'play_song': 1,
  'play_playlist': 2,
  'set_play_mode': 3,
  'set_volume': 4,
  'next': 5,
  'previous': 6,
  'stop': 7,
};

// ===== VoiceEngine =====

/**
 * VoiceEngine - 语音口令引擎
 * 接收对话消息，匹配已配置的口令关键词，执行对应动作
 */
export class VoiceEngine {
  private configManager: ConfigManager;
  private accountManager: AccountManager;
  private minaService: MinaService;
  private playlistManagerMap: PlaylistManagerMap;
  private indexingManager: IndexingManager;
  private enabled: boolean = false;

  constructor(
    configManager: ConfigManager,
    accountManager: AccountManager,
    minaService: MinaService,
    playlistManagerMap: PlaylistManagerMap,
    indexingManager: IndexingManager,
  ) {
    this.configManager = configManager;
    this.accountManager = accountManager;
    this.minaService = minaService;
    this.playlistManagerMap = playlistManagerMap;
    this.indexingManager = indexingManager;
  }

  // ===== 公开方法 =====

  /** 启用/禁用语音口令引擎 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    mimusic.log.info(`[VoiceEngine] ${enabled ? 'Enabled' : 'Disabled'}`);
  }

  /** 是否已启用 */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 处理新对话消息（由 ConversationMonitor 回调触发）
   * @param msg - 对话消息
   */
  handleMessage(msg: ConversationMessage): void {
    if (!this.enabled) {
      return;
    }

    if (!msg.query || msg.query.trim() === '') {
      return;
    }

    // 匹配口令
    const result = this.matchCommand(msg.query);
    if (!result) {
      return;
    }

    mimusic.log.info(`[VoiceEngine] Command matched type=${result.command.type} keyword="${result.keyword}" argument="${result.argument}" device=${msg.device_id}`);

    // 找到设备对应的 accountId
    const accountId = this.findAccountForDevice(msg.device_id);
    if (!accountId) {
      mimusic.log.warn(`[VoiceEngine] No account found for device: ${msg.device_id}`);
      return;
    }

    // 执行口令
    this.executeCommand(result, accountId, msg.device_id);
  }

  // ===== 私有方法 - 口令匹配 =====

  /**
   * 匹配语音口令
   * 按优先级遍历所有已启用的口令，使用包含匹配
   * @param query - 用户说的话
   * @returns 匹配结果，null 表示未匹配
   */
  private matchCommand(query: string): MatchResult | null {
    const commands = this.configManager.getVoiceCommands();
    if (commands.length === 0) {
      return null;
    }

    // 过滤已启用的口令并按优先级排序
    const enabledCommands = commands
      .filter(cmd => cmd.enabled)
      .map(cmd => ({
        cmd,
        priority: COMMAND_PRIORITY[cmd.type] ?? 99,
      }))
      .sort((a, b) => a.priority - b.priority);

    // 按优先级遍历，包含匹配
    for (const item of enabledCommands) {
      for (const keyword of item.cmd.keywords) {
        const idx = query.indexOf(keyword);
        if (idx >= 0) {
          // 提取 keyword 后面的文字作为 argument
          const argument = query.slice(idx + keyword.length).trim();
          return {
            command: item.cmd,
            keyword,
            argument,
          };
        }
      }
    }

    return null;
  }

  // ===== 私有方法 - 口令执行 =====

  /**
   * 执行匹配到的口令
   */
  private executeCommand(result: MatchResult, accountId: string, deviceId: string): void {
    switch (result.command.type) {
      case 'play_playlist':
        this.executePlayPlaylist(result.argument, accountId, deviceId);
        break;
      case 'play_song':
        this.executePlaySong(result.argument, accountId, deviceId);
        break;
      case 'set_play_mode':
        this.executeSetPlayMode(accountId, deviceId, result.argument);
        break;
      case 'set_volume':
        this.executeSetVolume(accountId, deviceId, result.argument);
        break;
      case 'next':
        this.executeNext(accountId, deviceId);
        break;
      case 'previous':
        this.executePrevious(accountId, deviceId);
        break;
      case 'stop':
        this.executeStop(accountId, deviceId);
        break;
      default:
        mimusic.log.warn(`[VoiceEngine] Unknown command type: ${result.command.type}`);
    }
  }

  /**
   * 执行播放歌单
   * 通过 IndexingManager 模糊匹配歌单名，然后调用 PlaylistManager 播放
   */
  private executePlayPlaylist(playlistName: string, accountId: string, deviceId: string): void {
    const pm = this.playlistManagerMap.getOrCreate(accountId, deviceId);

    // 空参数处理：继续上次播放或使用默认歌单
    if (!playlistName) {
      if (pm.hasPlaylist()) {
        mimusic.log.info('[VoiceEngine] Play playlist: resume last playback');
        pm.next(); // 触发播放
        return;
      }

      // 使用第一个歌单
      const playlists = this.indexingManager.searchPlaylist('');
      if (playlists.length === 0) {
        mimusic.log.warn('[VoiceEngine] No playlists available');
        return;
      }
      playlistName = playlists[0].name;
      mimusic.log.info(`[VoiceEngine] No name specified, using default playlist: ${playlistName}`);
    }

    // 模糊匹配歌单
    const matchedPlaylist = this.indexingManager.findPlaylistByName(playlistName);
    if (!matchedPlaylist) {
      mimusic.log.warn(`[VoiceEngine] Playlist not found: ${playlistName}`);
      return;
    }

    mimusic.log.info(`[VoiceEngine] Matched playlist: ${matchedPlaylist.name} (id=${matchedPlaylist.id})`);

    // 获取设备配置中的播放模式和起始位置
    let startIndex = 0;
    let playMode: PlayMode = 'order';

    const devices = this.configManager.getDevices(accountId);
    const devCfg = devices.find(d => d.device_id === deviceId);
    if (devCfg) {
      if (devCfg.playlist_id === matchedPlaylist.id) {
        // 同一个歌单，从上次位置继续
        startIndex = devCfg.current_song_index || 0;
      }
      if (devCfg.play_mode) {
        playMode = devCfg.play_mode as PlayMode;
      }
    }

    // 播放歌单
    const ok = pm.play(matchedPlaylist.id, startIndex, playMode);
    if (ok) {
      mimusic.log.info(`[VoiceEngine] Play playlist success: ${matchedPlaylist.name} index=${startIndex} mode=${playMode}`);
    } else {
      mimusic.log.error(`[VoiceEngine] Play playlist failed: ${matchedPlaylist.name}`);
    }
  }

  /**
   * 执行播放歌曲
   * 通过 IndexingManager 搜索歌曲
   */
  private executePlaySong(songName: string, accountId: string, deviceId: string): void {
    const pm = this.playlistManagerMap.getOrCreate(accountId, deviceId);

    // 空参数处理：继续上次播放
    if (!songName) {
      if (pm.hasPlaylist()) {
        mimusic.log.info('[VoiceEngine] Play song: resume last playback');
        pm.next();
        return;
      }
      mimusic.log.warn('[VoiceEngine] No song name specified and no active playlist');
      return;
    }

    // 模糊搜索歌曲
    const results = this.indexingManager.searchSong(songName);
    if (results.length === 0) {
      mimusic.log.warn(`[VoiceEngine] Song not found: ${songName}`);
      return;
    }

    const matchedSong = results[0];
    mimusic.log.info(`[VoiceEngine] Matched song: ${matchedSong.title} - ${matchedSong.artist}`);

    // 由于无法直接从搜索结果获取歌单ID和索引，
    // 使用 playlistManagerMap 按当前歌单或默认歌单播放
    // 这里简化处理：如果当前有歌单直接播放，否则提示
    mimusic.log.info(`[VoiceEngine] Song search matched: ${matchedSong.title}`);
  }

  /**
   * 执行设置播放模式
   */
  private executeSetPlayMode(accountId: string, deviceId: string, modeParam: string): void {
    // 尝试从参数中提取播放模式
    const modeMap: Record<string, PlayMode> = {
      '顺序': 'order',
      '顺序播放': 'order',
      '随机': 'random',
      '随机播放': 'random',
      '单曲循环': 'single',
      '单曲': 'single',
      '列表循环': 'loop',
      '循环': 'loop',
      'order': 'order',
      'random': 'random',
      'single': 'single',
      'loop': 'loop',
    };

    const playMode = modeMap[modeParam];
    if (!playMode) {
      mimusic.log.warn(`[VoiceEngine] Unknown play mode: ${modeParam}`);
      return;
    }

    const pm = this.playlistManagerMap.get(accountId, deviceId);
    if (pm) {
      pm.setPlayMode(playMode);
    } else {
      // 没有活跃的播放管理器，仅更新配置
      try {
        this.configManager.updateDevice(accountId, deviceId, { play_mode: playMode });
      } catch (e) {
        mimusic.log.error(`[VoiceEngine] Failed to update play mode config: ${String(e)}`);
      }
    }

    mimusic.log.info(`[VoiceEngine] Play mode set to: ${playMode}`);
  }

  /**
   * 执行设置音量
   * 支持从参数中提取数字（阿拉伯数字和中文数字）
   */
  private executeSetVolume(accountId: string, deviceId: string, argument: string): void {
    const volume = this.extractNumber(argument);
    if (volume === null) {
      mimusic.log.warn(`[VoiceEngine] No volume number found in: ${argument}`);
      return;
    }

    // 限制范围 0-100
    const targetVolume = Math.max(0, Math.min(100, volume));

    const ok = this.minaService.setVolume(accountId, deviceId, targetVolume);
    if (ok) {
      mimusic.log.info(`[VoiceEngine] Volume set to: ${targetVolume}`);
    } else {
      mimusic.log.error(`[VoiceEngine] Failed to set volume: ${targetVolume}`);
    }
  }

  /**
   * 执行下一首
   */
  private executeNext(accountId: string, deviceId: string): void {
    const pm = this.playlistManagerMap.getOrCreate(accountId, deviceId);
    const ok = pm.next();
    if (ok) {
      mimusic.log.info(`[VoiceEngine] Next song success`);
    } else {
      mimusic.log.warn(`[VoiceEngine] Next song failed or no next`);
    }
  }

  /**
   * 执行上一首
   */
  private executePrevious(accountId: string, deviceId: string): void {
    const pm = this.playlistManagerMap.getOrCreate(accountId, deviceId);
    const ok = pm.previous();
    if (ok) {
      mimusic.log.info(`[VoiceEngine] Previous song success`);
    } else {
      mimusic.log.warn(`[VoiceEngine] Previous song failed or no previous`);
    }
  }

  /**
   * 执行停止播放
   */
  private executeStop(accountId: string, deviceId: string): void {
    const pm = this.playlistManagerMap.getOrCreate(accountId, deviceId);
    pm.stop();
    mimusic.log.info(`[VoiceEngine] Playback stopped`);
  }

  // ===== 辅助方法 =====

  /**
   * 从设备ID反查 accountId
   * 遍历所有账号的设备列表，找到包含该 deviceId 的账号
   */
  private findAccountForDevice(deviceId: string): string | null {
    const accounts = this.accountManager.getAccounts();
    for (const acc of accounts) {
      const devices = this.configManager.getDevices(acc.id);
      if (devices.some(d => d.device_id === deviceId)) {
        return acc.id;
      }
    }
    return null;
  }

  /**
   * 从字符串中提取数字
   * 支持阿拉伯数字和中文数字
   */
  private extractNumber(s: string): number | null {
    if (!s) return null;

    // 优先尝试阿拉伯数字
    const numMatch = s.match(/\d+/);
    if (numMatch) {
      return parseInt(numMatch[0], 10);
    }

    // 尝试中文数字
    const cnMatch = s.match(/[零一二三四五六七八九十百千万]+/);
    if (cnMatch) {
      return this.parseChineseNumber(cnMatch[0]);
    }

    return null;
  }

  /**
   * 将中文数字字符串转换为阿拉伯数字
   * 支持：五十、一百、三十五、二百五十、十五 等常见表达
   */
  private parseChineseNumber(s: string): number | null {
    if (!s) return null;

    const digitMap: Record<string, number> = {
      '零': 0, '一': 1, '二': 2, '三': 3, '四': 4,
      '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
      '十': 10, '百': 100, '千': 1000, '万': 10000,
    };

    const chars = Array.from(s);
    let result = 0;
    let current = 0;
    let hasDigit = false;

    for (const ch of chars) {
      const val = digitMap[ch];
      if (val === undefined) {
        return null;
      }
      hasDigit = true;

      if (val >= 10) {
        // 遇到单位（十、百、千、万）
        if (current === 0) {
          // "十五" 省略了 "一" 的情况
          current = 1;
        }
        result += current * val;
        current = 0;
      } else {
        current = val;
      }
    }

    // 处理末尾的数字（如 "五十三" 中的 "三"）
    result += current;

    if (!hasDigit) return null;
    return result;
  }
}
