// 小米音箱插件 - 索引管理 Handler
// 翻译自 Go 源码: plugins/mimusic-plugin-xiaomi/handlers/indexing_handler.go

import { jsonResponse } from '@mimusic/plugin-sdk';
import type { Router, HTTPRequest } from '@mimusic/plugin-sdk';
import { IndexingManager } from '../indexing/manager';

/**
 * 注册索引管理相关路由
 * GET  /indexing/status  → 获取索引状态
 * POST /indexing/refresh → 刷新索引
 */
export function registerIndexingHandlers(
  router: Router,
  indexingManager: IndexingManager,
): void {

  // GET /indexing/status - 获取索引状态
  router.get('/indexing/status', (req: HTTPRequest) => {
    try {
      const status = indexingManager.getStatus();
      return jsonResponse({ success: true, data: status });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /indexing/refresh - 刷新索引
  router.post('/indexing/refresh', (req: HTTPRequest) => {
    try {
      indexingManager.refresh();
      return jsonResponse({ success: true, data: { message: 'index refresh started' } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });
}
